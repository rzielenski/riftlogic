// Rift Logic live pro games (mounted by server.js under /api/live).
//   GET /api/live          → {updated, live: [...], next, recent: [...], source}   the tier-1 matches live now (LCK, LPL, LEC, LCS,
//                            Worlds, MSI, First Stand), the next one when none is, and series that ended in the last 36 h
//   GET /api/live/stream   → Server-Sent Events: "live" events carrying the same payload whenever it changes, ": hb" heartbeats
//                            (capped: LIVE_MAX_CLIENTS in all, 20 per IP: households and campus networks share one address)
// One poller for every visitor, server-side, cached; nobody's browser talks to lolesports.
//
// Sources (unofficial, public, no account):
//   lolesports.com/api/gql  the GraphQL endpoint lolesports.com's own pages call. It takes Apollo persisted queries only: the
//        operation id comes from the site's public persisted-query manifest (a _next/static chunk, "apollo-persisted-query-manifest";
//        tools/live_ids.py finds the current one), plus the client-name/version headers the site's Apollo client sends. We use
//        one operation, homeEvents (events by state and league: live + upcoming in one call, completed for final scores).
//        The older esports-api.lolesports.com/persisted/gw endpoints (getLive, getSchedule, getEventDetails) now answer 403
//        without an x-api-key, and lolesports.com's bundle no longer contains one (it reads process.env.ESPORTS_API_KEY
//        server-side only), so they are not used.
//   feed.lolesports.com/livestats/v1/window/<gameId>[?startingTime=ISO, a multiple of 10 s]   no key. ~1 frame/s: per team
//        total gold, kills, towers, inhibitors, barons, dragons (by type); per player gold, level, K/D/A, CS. Without
//        startingTime it returns the game's first frames (its start); before the start 204; after the end the last frames.
// Politeness: the events query runs every LIVE_IDLE_S (default 600 s) when no tier-1 match is live or due within 20 minutes,
// every 60 s when one is; the livestats window every 12 s for a live game while someone is watching (a stream client, or
// /api/live in the last 90 s), every 30 s while nobody is; nothing else. Errors back off exponentially (x2 per failure up to
// 15 min, Retry-After honoured). Requests carry a descriptive User-Agent.
// Env: LIVE_OFF=1 (no polling; /api/live answers with an empty payload: tests set it), LIVE_GQL_EVENTS_ID (the homeEvents
//      persisted-query id, when lolesports changes it), LIVE_GQL_CLIENT_VERSION, LIVE_MAX_CLIENTS (default 300), LIVE_IDLE_S.
//
// Win probability: web/live-model.json (src/live_model.py): the PRO in-game model (never the solo-queue one) on the features the
// feed gives (gold per role, kills, CS, pre-game Elo); coefficients interpolated between its 10/15/20/25-minute fits. None
// before 10:00; after 25:00 the 25:00 value is held and marked held (no pro snapshot data past 25 minutes to validate on).
"use strict";
const fs = require("fs"), path = require("path");

const GQL_URL = "https://lolesports.com/api/gql", FEED = "https://feed.lolesports.com/livestats/v1";
// homeEvents in https://lolesports.com/_next/static/chunks/3-lni1dtvfkzz.js (the persisted-query manifest, 2026-09-28)
const EVENTS_ID = "7246add6f577cf30b304e651bf9e25fc6a41fe49aeafb0754c16b5778060fc0a";
const CLIENT_NAME = "Esports Web", CLIENT_VERSION = "3c12316";   // the site's Apollo clientAwareness (getAppVersion())
const UA = "RiftLogic/1.0 (+https://www.riftlogic.dev; live scores for the Pro page)";
// tier-1 leagues: lolesports league id → slug (ids from the site's league list)
const TIER1 = {"98767991310872058": "lck", "98767991314006698": "lpl", "98767991302996019": "lec", "98767991299243165": "lcs",
  "98767975604431411": "worlds", "98767991325878492": "msi", "113464388705111224": "first_stand"};
const SCHEDULE_KEY = {lck: "LCK", lpl: "LPL", lec: "LEC", lcs: "LCS", worlds: "INTL", msi: "INTL", first_stand: "INTL"};
const ROLES = ["top", "jungle", "mid", "bottom", "support"];

const DEFAULTS = {
  idleMs: 600e3,          // events check when nothing is live or near
  nearMs: 60e3,           // events check while a match is live or due within soonMs
  soonMs: 20 * 60e3,      // "about to start"
  lateMs: 3 * 3600e3,     // a scheduled match that hasn't gone live yet counts as near this long after its start time
  frameMs: 12e3,          // livestats while watched
  frameIdleMs: 30e3,      // livestats while live but unwatched (keeps the clock, pauses and the gold series)
  watchMs: 90e3,          // a /api/live request counts as watching this long
  lagMs: 30e3,            // ask the feed for frames this far behind now (it trails real time)
  backfillPerTick: 3,     // missing minutes of the gold series fetched per frames tick (a viewer joining mid-game)
  maxBackoffMs: 15 * 60e3,
  timeoutMs: 10e3,
  recentMs: 36 * 3600e3,
  maxClients: 300, maxClientsPerIp: 20, heartbeatMs: 25e3,
};

module.exports = function liveApi(opts = {}){
  const env = opts.env || process.env;
  const ROOT = opts.ROOT || __dirname;
  const C = {...DEFAULTS, ...(opts.config || {})};
  if (+env.LIVE_MAX_CLIENTS > 0) C.maxClients = +env.LIVE_MAX_CLIENTS;
  if (+env.LIVE_IDLE_S > 0) C.idleMs = +env.LIVE_IDLE_S * 1000;
  let fetchImpl = opts.fetch || globalThis.fetch;
  let now = opts.now || (() => Date.now());
  // LIVE_FIXTURE=<dir> (local development only): replay recorded responses (tools/fixtures/live/) instead of lolesports, on a
  // clock that starts LIVE_FIXTURE_MIN (default 15.5) minutes into the recorded game and runs in real time. Refused in production.
  if (env.LIVE_FIXTURE && !opts.fetch){
    if (env.RAILWAY_ENVIRONMENT || env.NODE_ENV === "production") (opts.log || console).warn("LIVE_FIXTURE ignored in production");
    else { const fx = fixtureReplay(env.LIVE_FIXTURE, +env.LIVE_FIXTURE_MIN || 15.5); fetchImpl = fx.fetch; now = fx.now; }
  }
  const T = opts.timers || {setTimeout, clearTimeout};
  const later = (fn, ms) => { const t = T.setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const log = opts.log || console;
  const clientIp = opts.clientIp || (req => String(req.socket && req.socket.remoteAddress || "?"));
  const send = opts.send || ((res, code, obj) => { res.writeHead(code, {"content-type": "application/json", "cache-control": "no-store"}); res.end(JSON.stringify(obj)); });
  const eventsId = env.LIVE_GQL_EVENTS_ID || EVENTS_ID, clientVersion = env.LIVE_GQL_CLIENT_VERSION || CLIENT_VERSION;
  const off = env.LIVE_OFF === "1";

  /* ---------------- site data: team names, logos, ratings, the live model, streams ---------------- */
  const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
  const model = opts.model !== undefined ? opts.model : readJson("live-model.json");
  let logos = null, logosAt = 0;
  function logoIndex(){   // re-read at most every 10 minutes (tools/refresh_pro.sh adds logos)
    if (logos && now() - logosAt < 600e3) return logos;
    const d = readJson("logos/index.json") || {lookup: {}, teams: {}};
    const byFile = {};
    for (const [k, v] of Object.entries(d.teams || {})) if (!byFile[v.file]) byFile[v.file] = k;
    const keys = Object.keys(d.lookup || {}).filter(k => k.length >= 4).sort((a, b) => b.length - a.length);
    logos = {lookup: d.lookup || {}, teams: d.teams || {}, byFile, keys}; logosAt = now();
    return logos;
  }
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // a lolesports team (code, name) → the site's team: exact code, exact name, else the longest site name that starts the
  // lolesports name ("Team Liquid Alienware" → Team Liquid); {site, logo, oe} or nulls
  function siteTeam(code, name){
    const L = logoIndex();
    let file = L.lookup[code] || L.lookup[name];
    if (!file){ const n = norm(name); const k = L.keys.find(k => n === norm(k) || n.startsWith(norm(k) + " ")); if (k) file = L.lookup[k]; }
    if (!file) return {site: null, logo: null, oe: null};
    const site = L.byFile[file] || null;
    return {site, logo: "logos/" + file, oe: site && L.teams[site] ? L.teams[site].oe : null};
  }
  function rating(t){
    const R = model && model.ratings || {};
    for (const k of [t.oe, t.site, t.name]) if (k && R[k] != null) return R[k];
    return null;
  }
  let sched = null, schedAt = 0;
  function scheduleStream(slug){
    if (!sched || now() - schedAt > 600e3){ sched = readJson("pro-schedule.json"); schedAt = now(); }
    const L = sched && sched.leagues && sched.leagues[SCHEDULE_KEY[slug]];
    if (!L) return null;
    for (const m of [...(L.upcoming || []), ...(L.recent || [])]) if (m.stream) return m.stream;
    return null;
  }
  function streamUrl(ev, slug){
    const ss = (ev.streams || []).filter(s => s && s.parameter);
    const en = s => /^en/i.test(s.mediaLocale && s.mediaLocale.locale || "");
    const pick = ss.find(s => s.provider === "twitch" && en(s)) || ss.find(s => s.provider === "youtube" && en(s)) || ss.find(s => s.provider === "twitch") || ss[0];
    if (pick && /^[\w-]{2,64}$/.test(pick.parameter)){
      if (pick.provider === "twitch") return "https://www.twitch.tv/" + pick.parameter;
      if (pick.provider === "youtube") return "https://www.youtube.com/watch?v=" + pick.parameter;
    }
    return scheduleStream(slug);
  }

  /* ---------------- win probability (the pro live model) ---------------- */
  function winProb(minute, x, variant){
    if (!model || !model.variants || !model.variants[variant]) return null;
    const ts = model.times, m = Math.min(Math.max(minute, ts[0]), ts[ts.length - 1]);
    let hi = ts.findIndex(t => t >= m); const lo = Math.max(hi - 1, 0);
    const a = ts[hi] === ts[lo] ? 0 : (m - ts[lo]) / (ts[hi] - ts[lo]);
    const cl = model.variants[variant].t[ts[lo]], ch = model.variants[variant].t[ts[hi]];
    let z = (1 - a) * cl.b0 + a * ch.b0;
    for (let i = 0; i < x.length; i++) z += ((1 - a) * cl.w[i] + a * ch.w[i]) * x[i];
    return 1 / (1 + Math.exp(-z));
  }
  // features from blue's view: gold per role (thousands), kills, CS (hundreds)[, rating]
  function features(frame, roles){
    const b = frame.blueTeam, r = frame.redTeam;
    const gold = role => { const g = side => { const p = side.participants.find(p => roles[p.participantId] === role); return p ? p.totalGold : 0; };
      return (g(b) - g(r)) / 1000; };
    const cs = side => side.participants.reduce((s, p) => s + (p.creepScore || 0), 0);
    return [...ROLES.map(gold), (b.totalKills - r.totalKills), (cs(b) - cs(r)) / 100];
  }

  /* ---------------- fetching ---------------- */
  const stats = {gql: 0, feed: 0, errors: 0};
  async function get(url, headers){
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ac ? later(() => ac.abort(), C.timeoutMs) : null;
    try {
      const r = await fetchImpl(url, {headers: {"user-agent": UA, ...headers}, signal: ac ? ac.signal : undefined});
      const text = r.status === 204 ? "" : await r.text();
      return {status: r.status, text, retryAfter: r.headers && r.headers.get ? r.headers.get("retry-after") : null};
    } finally { if (timer) T.clearTimeout(timer); }
  }
  class HttpError extends Error { constructor(msg, retryAfter){ super(msg); this.retryAfter = retryAfter; } }
  async function gql(variables){
    stats.gql++;
    const q = new URLSearchParams({operationName: "homeEvents", variables: JSON.stringify({hl: "en-US", sport: "lol", eventType: "match", leagues: Object.keys(TIER1), ...variables}),
      extensions: JSON.stringify({persistedQuery: {version: 1, sha256Hash: eventsId}})});
    const r = await get(`${GQL_URL}?${q}`, {"accept": "application/graphql-response+json,application/json;q=0.9", "content-type": "application/json",
      "apollographql-client-name": CLIENT_NAME, "apollographql-client-version": clientVersion});
    let body = null; try { body = JSON.parse(r.text); } catch (e) {}
    if (r.status !== 200 || !body || !body.data || !body.data.esports){
      const why = body && body.errors && body.errors[0] ? (body.errors[0].extensions && body.errors[0].extensions.code || body.errors[0].message) : `HTTP ${r.status}`;
      throw new HttpError(`lolesports events: ${String(why).slice(0, 120)}`, r.retryAfter);
    }
    return body.data.esports.events || [];
  }
  const iso10 = t => new Date(Math.floor(t / 10000) * 10000).toISOString();
  async function windowFrames(gameId, startingTime){
    stats.feed++;
    const r = await get(`${FEED}/window/${gameId}` + (startingTime != null ? `?startingTime=${iso10(startingTime)}` : ""), {"accept": "application/json"});
    if (r.status === 204 || r.status === 404) return null;           // not started / not in the feed (yet)
    if (r.status !== 200) throw new HttpError(`livestats: HTTP ${r.status}`, r.retryAfter);
    try { return JSON.parse(r.text); } catch (e) { throw new HttpError("livestats: bad JSON"); }
  }
  const backoff = (base, n, retryAfter) => {
    const ra = +retryAfter > 0 ? +retryAfter * 1000 : 0;
    return Math.max(ra, n ? Math.min(C.maxBackoffMs, base * 2 ** Math.min(n, 10)) : base);
  };

  /* ---------------- state ---------------- */
  const matches = new Map();    // match id → {ev, slug, teams: [...]}  (live)
  const games = new Map();      // game id → game state (see pollGame)
  const recent = new Map();     // match id → recent result
  let next = null, source = {ok: null, error: null, checkedAt: null};
  let evErrors = 0, frErrors = 0, evTimer = null, frTimer = null, stopped = false, lastWatch = -Infinity, firstCheck = true;
  let evRunning = null, frRunning = null;

  const ptime = s => Date.parse(s);
  function teamOf(mt){
    const s = siteTeam(mt.code, mt.name);
    return {id: String(mt.id || "").split(":").pop(), code: mt.code || null, name: mt.name || null, site: s.site, logo: s.logo, oe: s.oe,
            wins: mt.result && mt.result.gameWins != null ? mt.result.gameWins : 0};
  }
  const publicTeam = t => ({code: t.code, name: t.name, site: t.site, oe: t.oe, logo: t.logo, wins: t.wins});

  async function checkEvents(){
    const evs = await gql({eventState: ["inProgress", "unstarted"], pageSize: 20});
    const t = now();
    const liveNow = new Map();
    let nx = null;
    for (const ev of evs){
      const slug = TIER1[ev.league && ev.league.id] || null;
      if (!slug || ev.type && ev.type !== "match" || !ev.match) continue;
      if (ev.state === "inProgress") liveNow.set(ev.id, {ev, slug, teams: (ev.matchTeams || []).slice(0, 2).map(teamOf)});
      else if (ev.state === "unstarted" && ptime(ev.startTime) > t - C.lateMs && (!nx || ptime(ev.startTime) < ptime(nx.ev.startTime))) nx = {ev, slug};
    }
    const ended = [...matches.keys()].filter(id => !liveNow.has(id));
    matches.clear(); for (const [k, v] of liveNow) matches.set(k, v);
    next = nx ? {id: nx.ev.id, startTime: nx.ev.startTime, league: {name: nx.ev.league.name, slug: nx.slug}, block: nx.ev.blockName || null,
                 bestOf: nx.ev.match.strategy && nx.ev.match.strategy.count || null, teams: (nx.ev.matchTeams || []).slice(0, 2).map(teamOf).map(publicTeam)} : null;
    // drop the frame state of games no longer live
    const liveGames = new Set([...matches.values()].flatMap(m => (m.ev.match.games || []).map(g => g.id)));
    for (const id of games.keys()) if (!liveGames.has(id)) games.delete(id);
    if (ended.length || firstCheck) await checkCompleted(new Set(ended));
    firstCheck = false;
  }
  async function checkCompleted(ended = new Set()){   // ended: matches just seen leaving inProgress (their end is now)
    const evs = await gql({eventState: ["completed"], pageSize: 10});
    const t = now();
    for (const ev of evs){
      const slug = TIER1[ev.league && ev.league.id];
      if (!slug || !ev.match || t - ptime(ev.startTime) > C.recentMs) continue;
      const teams = (ev.matchTeams || []).slice(0, 2).map(teamOf);
      const out = (ev.matchTeams || []).map(m => m.result && m.result.outcome);
      const winner = out[0] === "win" ? 0 : out[1] === "win" ? 1 : teams[0].wins > teams[1].wins ? 0 : teams[1].wins > teams[0].wins ? 1 : null;
      const prev = recent.get(ev.id);
      recent.set(ev.id, {id: ev.id, league: {name: ev.league.name, slug}, block: ev.blockName || null, startTime: ev.startTime, endedAt: ended.has(ev.id) ? new Date(t).toISOString() : prev ? prev.endedAt : null,
        bestOf: ev.match.strategy && ev.match.strategy.count || null, teams: teams.map(publicTeam), winner});
    }
    for (const [id, r] of recent) if (t - ptime(r.startTime) > C.recentMs) recent.delete(id);
  }

  /* ---------------- livestats for one game ---------------- */
  // G: {id, meta, roles {participantId: role}, blueTeamId, start (ms of the first frame with gold), lastTs, lastState, paused (ms),
  //     frame (latest), series: Map(quarter-minute → {m, x, gd}), p25 (features at 25:00), done, approx}
  function clockOf(G, ts){ return G.start == null ? null : Math.max(0, (ts - G.start - G.paused) / 1000); }
  function absorb(G, frames){   // frames in time order: pause accounting, latest frame
    for (const f of frames){
      const ts = ptime(f.rfc460Timestamp);
      if (!(ts > (G.lastTs || -Infinity))) continue;
      if (G.start == null && f.blueTeam && f.blueTeam.totalGold > 0) G.start = ts;
      if (G.lastState === "paused" && G.lastTs != null && G.start != null) G.paused += ts - G.lastTs;
      G.lastTs = ts; G.lastState = f.gameState; G.frame = f;
      if (f.gameState === "finished") G.done = true;
      const c = clockOf(G, ts);
      if (c != null && f.gameState !== "paused") point(G, c / 60, f);
    }
  }
  function point(G, minute, f){
    const x = features(f, G.roles), key = Math.round(minute * 4) / 4;
    G.series.set(key, {m: key, x, gd: (f.blueTeam.totalGold - f.redTeam.totalGold)});
    if (G.p25 == null && minute >= 25 && minute < 26.5) G.p25 = x;
    if (G.series.size > 400){ const k = [...G.series.keys()].sort((a, b) => a - b); G.series.delete(k[1]); }
  }
  async function pollGame(G, watched){
    if (!G.meta){
      const w = await windowFrames(G.id, null);
      if (!w || !w.gameMetadata) return;
      G.meta = w.gameMetadata;
      G.blueTeamId = String(w.gameMetadata.blueTeamMetadata.esportsTeamId);
      for (const side of ["blueTeamMetadata", "redTeamMetadata"]) for (const p of w.gameMetadata[side].participantMetadata) G.roles[p.participantId] = p.role;
      absorb(G, w.frames || []);
      G.searchTs = w.frames && w.frames.length ? ptime(w.frames[w.frames.length - 1].rfc460Timestamp) : null;
    }
    if (G.start == null && G.searchTs != null){   // the first frames had no gold yet: step forward to the spawn
      const w = await windowFrames(G.id, G.searchTs + 10e3);
      if (w && w.frames && w.frames.length){ absorb(G, w.frames); G.searchTs = ptime(w.frames[w.frames.length - 1].rfc460Timestamp); }
      if (G.start == null) return;
    }
    if (G.done) return;
    const w = await windowFrames(G.id, now() - C.lagMs);
    if (w && w.frames) absorb(G, w.frames);
    // joined after the first minute and a half (a viewer or the server arrived mid-game): pauses before that went unseen, so
    // the clock and the backfilled minutes may run ahead of the game clock
    if (G.seenFrom == null && G.start != null && G.lastTs != null){ G.seenFrom = clockOf(G, G.lastTs); G.approx = G.seenFrom > 90; }
    // backfill: a point per game minute we haven't seen (a viewer joined mid-game or the server restarted); no pause data there
    if (watched && G.start != null && G.lastTs != null){
      const upto = Math.floor(clockOf(G, G.lastTs) / 60);
      let n = 0;
      for (let m = 1; m <= Math.min(upto, 60) && n < C.backfillPerTick; m++){
        if ([...G.series.keys()].some(k => Math.abs(k - m) < 0.5) || G.tried.has(m)) continue;
        G.tried.add(m); n++;
        const wb = await windowFrames(G.id, G.start + m * 60e3);
        if (!wb || !wb.frames || !wb.frames.length) continue;
        const target = G.start + m * 60e3;
        const f = wb.frames.reduce((a, b) => Math.abs(ptime(b.rfc460Timestamp) - target) < Math.abs(ptime(a.rfc460Timestamp) - target) ? b : a);
        if (f.gameState === "paused" || f.gameState === "finished") continue;
        point(G, m, f);
      }
    }
  }

  /* ---------------- payload ---------------- */
  function gamePayload(G, teams){
    const f = G.frame;
    if (!f) return null;
    const blueIdx = teams[1] && teams[1].id === G.blueTeamId ? 1 : 0;   // teams[blueIdx] plays blue
    const side = i => i === blueIdx ? f.blueTeam : f.redTeam;
    const pick = k => [side(0)[k], side(1)[k]];
    const sgn = blueIdx === 0 ? 1 : -1;
    const clock = clockOf(G, G.lastTs);
    const series = [...G.series.values()].sort((a, b) => a.m - b.m).map(p => [p.m, sgn * p.gd]);
    let wp = null;
    const ra = rating(teams[blueIdx]), rb = rating(teams[1 - blueIdx]);
    const variant = ra != null && rb != null ? "live" : "liveNoRating";
    const withR = x => variant === "live" ? [...x, (ra - rb) / 400] : x;
    const minute = clock == null ? null : clock / 60;
    if (minute != null && minute >= 10 && minute <= 25 && f.gameState !== "finished"){
      const p = winProb(minute, withR(features(f, G.roles)), variant);
      if (p != null) wp = {p: +(blueIdx === 0 ? p : 1 - p).toFixed(4), minute: +minute.toFixed(2), held: false, variant};
    } else if (minute != null && minute > 25 && G.p25){
      const p = winProb(25, withR(G.p25), variant);
      if (p != null) wp = {p: +(blueIdx === 0 ? p : 1 - p).toFixed(4), minute: 25, held: true, variant};
    }
    return {id: G.id, number: G.number, state: f.gameState, clock: clock == null ? null : Math.round(clock), approx: !!G.approx,
      sides: blueIdx === 0 ? ["blue", "red"] : ["red", "blue"],
      gold: pick("totalGold"), kills: pick("totalKills"), towers: pick("towers"), inhibitors: pick("inhibitors"), barons: pick("barons"),
      dragons: [side(0).dragons || [], side(1).dragons || []], goldDiff: side(0).totalGold - side(1).totalGold, series, wp};
  }
  function payload(){
    const live = [...matches.values()].map(({ev, slug, teams}) => {
      const gs = ev.match.games || [];
      const cur = gs.find(g => g.state === "inProgress");
      const G = cur && games.get(cur.id);
      return {id: ev.id, league: {name: ev.league.name, slug}, block: ev.blockName || null, bestOf: ev.match.strategy && ev.match.strategy.count || null,
        startTime: ev.startTime, stream: streamUrl(ev, slug), teams: teams.map(publicTeam),
        gameNumber: cur ? cur.number : Math.min(gs.filter(g => g.state === "completed").length + 1, gs.length || 1),
        game: G ? gamePayload(G, teams) : null};
    });
    const rec = [...recent.values()].filter(r => !matches.has(r.id)).sort((a, b) => ptime(b.startTime) - ptime(a.startTime)).slice(0, 10);
    return {live, next, recent: rec, source: {ok: source.ok, error: source.error}};
  }

  /* ---------------- loops ---------------- */
  const watching = () => clients.size > 0 || now() - lastWatch < C.watchMs;
  const liveGamesList = () => [...matches.values()].flatMap(m => (m.ev.match.games || []).filter(g => g.state === "inProgress").map(g => ({g, m})));
  function near(){
    if (matches.size) return true;
    return !!next && ptime(next.startTime) - now() < C.soonMs;   // due soon, or past its start and not live yet (up to lateMs)
  }
  async function eventsTick(){
    evTimer = null;
    if (stopped) return;
    let retryAfter = null;
    try { await checkEvents(); evErrors = 0; source = {ok: true, error: null, checkedAt: now()}; }
    catch (e) { evErrors++; stats.errors++; retryAfter = e.retryAfter; source = {ok: false, error: String(e.message || e).slice(0, 160), checkedAt: now()};
      if (evErrors === 1 || evErrors % 10 === 0) log.warn(`live: ${source.error} (failure ${evErrors})`); }
    publish();
    if (stopped) return;
    evTimer = later(() => { evRunning = eventsTick().finally(() => { evRunning = null; }); }, backoff(near() ? C.nearMs : C.idleMs, evErrors, retryAfter));
    if (liveGamesList().length && !frTimer && !frRunning) scheduleFrames(0);
  }
  function scheduleFrames(ms){
    if (stopped || frTimer) return;
    frTimer = later(() => { frTimer = null; frRunning = framesTick().finally(() => { frRunning = null; }); }, ms);
  }
  async function framesTick(){
    const list = liveGamesList();
    if (!list.length) return;            // resumes when the events check finds a live game
    const w = watching();
    let retryAfter = null;
    try {
      for (const {g, m} of list){
        let G = games.get(g.id);
        if (!G){ G = {id: g.id, number: g.number, matchId: m.ev.id, meta: null, roles: {}, blueTeamId: null, start: null, lastTs: null, lastState: null,
                      paused: 0, frame: null, series: new Map(), p25: null, done: false, approx: false, tried: new Set(), searchTs: null}; games.set(g.id, G); }
        await pollGame(G, w);
      }
      frErrors = 0;
    } catch (e) { frErrors++; stats.errors++; retryAfter = e.retryAfter; if (frErrors === 1 || frErrors % 10 === 0) log.warn(`live: ${e.message} (failure ${frErrors})`); }
    publish();
    scheduleFrames(backoff(w ? C.frameMs : C.frameIdleMs, frErrors, retryAfter));
  }
  function wake(){   // a viewer arrived: frames at the watched cadence now instead of at the next idle tick
    if (stopped || !liveGamesList().length || frRunning || frErrors) return;
    if (frTimer){ T.clearTimeout(frTimer); frTimer = null; }
    scheduleFrames(0);
  }

  /* ---------------- SSE ---------------- */
  const clients = new Set();     // {res, ip}
  let lastBody = null, sentBody = null, updated = null, hbTimer = null;
  function snapshot(){
    const p = payload();
    const body = JSON.stringify(p);
    if (body !== lastBody){ lastBody = body; updated = new Date(now()).toISOString(); }
    return {updated, ...p};
  }
  function publish(){   // to the stream clients, when the payload changed since the last broadcast
    const snap = snapshot();
    if (lastBody === sentBody) return;
    sentBody = lastBody;
    const msg = `event: live\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const c of clients) c.res.write(msg);
  }
  function heartbeat(){
    hbTimer = null;
    if (!clients.size) return;
    for (const c of clients) c.res.write(": hb\n\n");
    hbTimer = later(heartbeat, C.heartbeatMs);
  }
  function stream(req, res){
    const ip = clientIp(req);
    if (clients.size >= C.maxClients) return send(res, 503, {error: "Too many live viewers right now: the page polls instead."});
    if ([...clients].filter(c => c.ip === ip).length >= C.maxClientsPerIp) return send(res, 429, {error: "Too many live streams from here."});
    res.writeHead(200, {"content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "connection": "keep-alive",
      "x-accel-buffering": "no", "x-content-type-options": "nosniff"});
    const c = {res, ip};
    clients.add(c);
    res.write(`retry: 20000\n\nevent: live\ndata: ${JSON.stringify(snapshot())}\n\n`);
    if (!hbTimer) hbTimer = later(heartbeat, C.heartbeatMs);
    const bye = () => { clients.delete(c); };
    req.on("close", bye); res.on("close", bye); res.on("error", bye);
    wake();
  }

  /* ---------------- HTTP ---------------- */
  function handler(req, res, url){
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, {error: "GET only"});
    if (url.pathname === "/api/live"){ lastWatch = now(); wake(); return send(res, 200, snapshot()); }
    if (url.pathname === "/api/live/stream") return off ? send(res, 503, {error: "Live updates are off."}) : stream(req, res);
    return send(res, 404, {error: "Not found"});
  }
  handler.stop = () => {
    stopped = true;
    for (const t of [evTimer, frTimer, hbTimer]) if (t) T.clearTimeout(t);
    evTimer = frTimer = hbTimer = null;
    for (const c of clients) try { c.res.end(); } catch (e) {}
    clients.clear();
  };
  handler.state = () => ({matches: matches.size, games: games.size, recent: recent.size, next, clients: clients.size, evErrors, frErrors,
    evTimer: !!evTimer, frTimer: !!frTimer, watching: watching(), stats: {...stats}, source});
  handler.idle = () => Promise.all([evRunning, frRunning].filter(Boolean));   // tests: wait for the ticks in flight
  handler._test = {siteTeam, winProb, features, payload, snapshot, absorb, clockOf,
    newGame: id => ({id, meta: null, roles: {}, start: null, lastTs: null, lastState: null, paused: 0, frame: null, series: new Map(), p25: null, done: false, tried: new Set()})};
  handler.start = () => { if (!off && !stopped && !evTimer && !evRunning) evRunning = eventsTick().finally(() => { evRunning = null; }); };
  if (off) source = {ok: false, error: "off"};
  else if (opts.autostart !== false) handler.start();
  return handler;
};
module.exports.TIER1 = TIER1;

// the LIVE_FIXTURE replay: gql_live.json for the events (the recorded game in progress), gql_completed.json for results, and the
// window_<game>_*.json files for the feed (the latest recorded window at or before the requested time; the end after it)
function fixtureReplay(dir, minute){
  const rd = f => fs.readFileSync(path.join(dir, f), "utf8");
  const wins = fs.readdirSync(dir).filter(f => /^window_\d+_t\d{4}\.json$/.test(f)).sort();
  if (!wins.length) throw new Error(`LIVE_FIXTURE: no window_<game>_tMMSS.json files in ${dir}`);
  const game = wins[0].split("_")[1];
  const W = wins.map(f => ({f, t0: Date.parse(JSON.parse(rd(f)).frames[0].rfc460Timestamp)}));
  const first = JSON.parse(rd(wins[0])).frames.find(f => f.blueTeam.totalGold > 0);
  const t0 = Date.parse(first.rfc460Timestamp) + minute * 60e3, boot = Date.now();
  const end = fs.existsSync(path.join(dir, `window_${game}_end.json`)) ? Date.parse(JSON.parse(rd(`window_${game}_end.json`)).frames[0].rfc460Timestamp) : Infinity;
  const res = (status, text) => ({status, text: async () => text, headers: {get: () => null}});
  return {now: () => t0 + (Date.now() - boot), fetch: async url => {
    const u = new URL(url);
    if (u.host === "lolesports.com") return res(200, rd(JSON.parse(u.searchParams.get("variables")).eventState.includes("completed") ? "gql_completed.json" : "gql_live.json"));
    if (!u.pathname.endsWith("/" + game)) return res(404, "");
    const st = u.searchParams.get("startingTime");
    if (!st) return res(200, rd(`window_${game}_first.json`));
    const at = Date.parse(st);
    if (at < W[0].t0 - 60e3) return res(204, "");
    if (at >= end - 10e3) return res(200, rd(`window_${game}_end.json`));
    return res(200, rd((W.filter(w => w.t0 <= at + 10e3).pop() || W[0]).f));
  }};
}
