// Rift Logic player lookup (mounted by server.js under /api/lookup, plus the /lookup page routes). OFF unless LOOKUP_ENABLED=1
// AND RIOT_API_KEY are set: then /api/lookup/* answers 404 and /lookup, /lookup.html, /lookup/... are 404 pages. Riot's policy:
// a development key must not power a public feature, so production turns this on only with a production key.
//
//   GET  /api/lookup/profile?region=na1&name=X&tag=Y   → {puuid, region, gameName, tagLine, level, icon, ranks, fetchedAt}
//   GET  /api/lookup/matches?puuid=…&start=0&count=20[&queue=420|440]   → {games: [match cards], summary (start 0), more, names}
//   GET  /api/lookup/match/<matchId>?puuid=…            → one game for that player: card + curve, WPA, deaths, plays, lane, build, runes
//   POST /api/lookup/refresh {puuid}                    → drop the player's cached account / rank / match list (throttled)
//   GET  /api/lookup/icon/profile/<id>.png, /icon/item/<id>.png   → Data Dragon images, cached (the page's CSP allows only 'self')
//   GET  /api/lookup/demo/profile | matches | match/<id>  → the DEMO (/lookup/demo): one recorded player's responses from
//        web/lookup-demo.json (tools/lookup_demo.js), served whether or not the live lookup is on, with no outbound request
// Riot endpoints (documented ones only): ACCOUNT-V1 accounts/by-riot-id (regional: americas / asia / europe), SUMMONER-V4
// summoners/by-puuid and LEAGUE-V4 entries/by-puuid (platform), MATCH-V5 matches/by-puuid/ids, matches/{id}, matches/{id}/timeline
// (regional: americas / asia / europe / sea); Data Dragon for images. Calls per cold lookup: 4 (account, summoner, league, match
// ids) + 2 per game not in the cache (match + timeline): a first 20-game view is 44, a repeat within the refresh window 0.
//
// Key: RIOT_API_KEY, server-side only: sent as the X-Riot-Token header, never in a URL, a response or a log line.
// Rate limits: one queue per routing host; the app and method limits are read from X-App-Rate-Limit / X-Method-Rate-Limit (and
// their -Count headers) on every response (a development key's 20/1 s + 100/2 min until the first response says otherwise); a 429
// blocks the host (application) or the method for Retry-After seconds and the request is retried (3 tries); a queue wait over
// maxWaitMs answers "API limit, try again" (503 + retryAfter) instead of hanging.
// Caches (LOOKUP_DIR; default "lookup" next to REPORT_DIR, else .lookup here, hidden by serve.json): match and timeline JSON are
// immutable (gzipped, kept until LOOKUP_MAX_MB, default 1024, then least recently used first); account / summoner / rank / match
// ids refresh at most every playerTtlMs (4 min) per player. In memory: the analysed games (LRU) and the players.
// Visitors: per-IP limits per endpoint, and at most `concurrency` lookups being built at once (503 busy beyond).
// Analysis: web/lookup-analysis.js on web/lookup-model.json (SOLO-queue models only; src/lookup_model.py).
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");

const PLATFORMS = {na1: "americas", br1: "americas", la1: "americas", la2: "americas", euw1: "europe", eun1: "europe", tr1: "europe",
  ru: "europe", kr: "asia", jp1: "asia", oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea"};
const ACCOUNT_ROUTE = {americas: "americas", europe: "europe", asia: "asia", sea: "asia"};   // ACCOUNT-V1 serves americas/asia/europe
const REGION_LABEL = {na1: "NA", br1: "BR", la1: "LAN", la2: "LAS", euw1: "EUW", eun1: "EUNE", tr1: "TR", ru: "RU", kr: "KR", jp1: "JP",
  oc1: "OCE", ph2: "PH", sg2: "SG", th2: "TH", tw2: "TW", vn2: "VN"};
const QUEUES = {420: "solo", 440: "flex"};
const DEFAULTS = {
  playerTtlMs: 4 * 60e3,           // account / summoner / rank / match ids: refetched at most this often per player
  refreshMinMs: 60e3,              // POST refresh: once a minute per player
  maxWaitMs: 20e3,                 // a request that would wait longer than this in the rate-limit queue is refused (503)
  timeoutMs: 10e3, tries: 3,
  appLimits: "20:1,100:120",       // assumed until the first response's X-App-Rate-Limit (a development key's limits)
  maxQueue: 300, concurrency: 4,
  cacheMaxBytes: 1024 * 1024 * 1024, iconMaxBytes: 50 * 1024 * 1024, analysisCache: 400, idsCount: 100,
  // per IP: [requests, window ms] per endpoint
  visitor: {profile: [[20, 60e3], [200, 3600e3]], matches: [[30, 60e3], [400, 3600e3]], match: [[60, 60e3], [1000, 3600e3]],
    refresh: [[6, 60e3], [60, 3600e3]], icon: [[300, 60e3]], demo: [[120, 60e3]]},
};
class ApiError extends Error { constructor(status, code, msg, extra){ super(msg); this.status = status; this.code = code; this.extra = extra || {}; } }
const notFound = msg => new ApiError(404, "not_found", msg);
const busy = (s, msg) => new ApiError(503, "rate_limited", msg || "The Riot API limit is reached right now: try again in a moment.", {retryAfter: Math.max(1, Math.ceil(s))});

/* ---------------- rate limiter: one per routing host ---------------- */
const parseLimits = h => String(h || "").split(",").map(x => x.trim().split(":").map(Number)).filter(a => a.length === 2 && a[0] > 0 && a[1] > 0).map(([n, s]) => ({n, ms: s * 1000}));
// we stay 10% under each stated limit (Riot's windows don't line up with ours to the millisecond; a burst at the edge draws 429s)
const margin = L => L.map(x => ({...x, n: x.n >= 10 ? Math.floor(x.n * 0.9) : x.n}));
function windowCounts(list, now){ return list.map(L => { L.log = L.log.filter(t => now - t < L.ms); return L; }); }
class HostQueue {
  constructor(host, api){ this.host = host; this.api = api; this.app = margin(parseLimits(api.C.appLimits)).map(L => ({...L, log: []})); this.methods = new Map(); this.q = []; this.blocked = 0; this.mblocked = new Map(); this.timer = null; }
  method(m){ if (!this.methods.has(m)) this.methods.set(m, []); return this.methods.get(m); }
  wait(m, now){
    let w = Math.max(0, this.blocked - now, (this.mblocked.get(m) || 0) - now);
    for (const L of [...windowCounts(this.app, now), ...windowCounts(this.method(m), now)]) if (L.log.length >= L.n) w = Math.max(w, L.log[L.log.length - L.n] + L.ms - now + 5);
    return w;
  }
  // estimated wait for a new job behind the queue: per limit, its position p among the calls in the window (logged + queued);
  // within the first n: no wait; else the slot frees when the (p - n)-th logged call leaves the window, or whole windows later
  estimate(m, now){
    let w = Math.max(0, this.blocked - now, (this.mblocked.get(m) || 0) - now);
    const ahead = this.q.length, aheadM = this.q.filter(j => j.method === m).length;
    for (const [L, k] of [...windowCounts(this.app, now).map(L => [L, ahead]), ...windowCounts(this.method(m), now).map(L => [L, aheadM])]){
      const p = L.log.length + k;
      if (p < L.n) continue;
      const i = p - L.n;
      w = Math.max(w, i < L.log.length ? L.log[i] + L.ms - now : Math.floor(p / L.n) * L.ms);
    }
    return w;
  }
  push(job){
    const now = this.api.now();
    if (this.q.length >= this.api.C.maxQueue) return job.reject(busy(5));
    const est = this.estimate(job.method, now);
    if (est > this.api.C.maxWaitMs) return job.reject(busy(est / 1000));
    job.queued = now; this.q.push(job); this.pump();
  }
  pump(){
    if (this.timer) return;
    const now = this.api.now();
    while (this.q.length){
      const job = this.q[0], w = this.wait(job.method, now);
      if (now - job.queued > this.api.C.maxWaitMs + 5e3){ this.q.shift(); job.reject(busy(10)); continue; }
      if (w > 0){ this.timer = this.api.later(() => { this.timer = null; this.pump(); }, w); return; }
      this.q.shift();
      for (const L of this.app) L.log.push(now);
      for (const L of this.method(job.method)) L.log.push(now);
      job.run();
    }
  }
  sync(method, headers, now){   // limits and counts from a response
    const app = margin(parseLimits(headers.get("x-app-rate-limit"))), meth = margin(parseLimits(headers.get("x-method-rate-limit")));
    const fit = (cur, lim, counts) => {
      const out = lim.map(L => { const old = cur.find(c => c.ms === L.ms); return {n: L.n, ms: L.ms, log: old ? old.log : []}; });
      for (const c of parseLimits(counts)){ const L = out.find(x => x.ms === c.ms); if (L) while (L.log.length < c.n) L.log.push(now); }
      return out;
    };
    if (app.length) this.app = fit(this.app, app, headers.get("x-app-rate-limit-count"));
    if (meth.length) this.methods.set(method, fit(this.method(method), meth, headers.get("x-method-rate-limit-count")));
  }
}

module.exports = function lookupApi(opts = {}){
  const env = opts.env || process.env, ROOT = opts.ROOT || __dirname;
  const C = {...DEFAULTS, ...(opts.config || {}), visitor: {...DEFAULTS.visitor, ...((opts.config || {}).visitor || {})}};
  if (+env.LOOKUP_MAX_MB > 0) C.cacheMaxBytes = +env.LOOKUP_MAX_MB * 1024 * 1024;
  const KEY = String(env.RIOT_API_KEY || "").trim();
  const enabled = env.LOOKUP_ENABLED === "1" && KEY.length > 0;
  const log = opts.log || console, now = opts.now || (() => Date.now()), fetchImpl = opts.fetch || globalThis.fetch;
  const T = opts.timers || {setTimeout, clearTimeout};
  const later = (fn, ms) => { const t = T.setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };
  const host = opts.hosts || (route => `https://${route}.api.riotgames.com`);
  const ddragon = opts.ddragon || "https://ddragon.leagueoflegends.com";
  const clientIp = opts.clientIp || (req => String(req.socket && req.socket.remoteAddress || "?"));
  const send = opts.send || ((res, code, obj) => { res.writeHead(code, {"content-type": "application/json", "cache-control": "no-store"}); res.end(JSON.stringify(obj)); });
  const readBody = opts.readBody || (req => new Promise((ok, fail) => { let b = ""; req.on("data", c => { b += c; if (b.length > 4096) req.destroy(); }); req.on("end", () => ok(b)); req.on("error", fail); }));
  const DIR = opts.dir || env.LOOKUP_DIR || (env.REPORT_DIR ? path.join(path.dirname(env.REPORT_DIR), "lookup") : path.join(ROOT, ".lookup"));
  const stats = {riot: 0, byMethod: {}, cacheHits: 0, r429: 0};
  const safe = s => KEY.length >= 8 ? String(s).split(KEY).join("[key]") : String(s);   // belt and braces: a key never leaves in a log line
  const warn = m => { try { log.warn(safe(m)); } catch (e) {} };

  /* ---------------- Riot client ---------------- */
  const api = {C, now: opts.limiterNow || (() => Date.now()), later};   // the rate limiter runs on real time (its waits are real timers)
  const queues = new Map();
  const qOf = route => { if (!queues.has(route)) queues.set(route, new HostQueue(route, api)); return queues.get(route); };
  function riot(route, method, p){
    return new Promise((ok, fail) => {
      let tries = 0;
      const job = {method, reject: fail, run: async () => {
        tries++; stats.riot++; stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
        const Q = qOf(route);
        let r;
        try {
          const ac = typeof AbortController === "function" ? new AbortController() : null;
          const to = ac ? later(() => ac.abort(), C.timeoutMs) : null;
          r = await fetchImpl(host(route) + p, {headers: {"X-Riot-Token": KEY, "Accept": "application/json", "User-Agent": "RiftLogic/1.0 (+https://www.riftlogic.dev)"}, signal: ac ? ac.signal : undefined});
          if (to) T.clearTimeout(to);
        } catch (e) {
          warn(`lookup: ${method} network error`);
          if (tries < C.tries){ later(() => Q.push(job), 1000 * tries); return; }
          return fail(new ApiError(502, "unavailable", "Riot's servers didn't answer: try again in a moment."));
        }
        const h = r.headers && typeof r.headers.get === "function" ? r.headers : {get: () => null};
        Q.sync(method, h, api.now());
        if (r.status === 200){ try { return ok(JSON.parse(await r.text())); } catch (e) { return fail(new ApiError(502, "unavailable", "Riot sent an unreadable answer.")); } }
        if (r.status === 404) return ok(null);
        if (r.status === 429){
          stats.r429++;
          const ra = Math.max(1, +h.get("retry-after") || 2), type = String(h.get("x-rate-limit-type") || "").toLowerCase();
          if (type === "application") Q.blocked = api.now() + ra * 1000;
          else if (type === "method") Q.mblocked.set(method, api.now() + ra * 1000);
          warn(`lookup: ${method} 429 (${type || "service"}, retry after ${ra} s)`);
          if (tries < C.tries && ra * 1000 <= C.maxWaitMs){ later(() => Q.push(job), type === "application" || type === "method" ? 0 : ra * 1000); return; }
          return fail(busy(ra));
        }
        if (r.status === 401 || r.status === 403){ warn(`lookup: ${method} ${r.status}: the Riot API key was refused (expired or not allowed)`); return fail(new ApiError(503, "unavailable", "Player lookup is unavailable right now.")); }
        if (r.status >= 500 && tries < C.tries){ warn(`lookup: ${method} ${r.status}, retrying`); later(() => Q.push(job), 1000 * tries); return; }
        warn(`lookup: ${method} ${r.status}`);
        return fail(new ApiError(502, "unavailable", "Riot's servers didn't answer: try again in a moment."));
      }};
      qOf(route).push(job);
    });
  }

  /* ---------------- disk cache: immutable match + timeline JSON, LRU by size ---------------- */
  const files = new Map(); let bytes = 0, diskReady = false;
  function disk(){
    if (diskReady) return; diskReady = true;
    for (const sub of ["match", "timeline", "icons"]) fs.mkdirSync(path.join(DIR, sub), {recursive: true});
    for (const sub of ["match", "timeline"]) for (const f of fs.readdirSync(path.join(DIR, sub))){
      try { const st = fs.statSync(path.join(DIR, sub, f)); files.set(sub + "/" + f, {size: st.size, t: st.mtimeMs}); bytes += st.size; } catch (e) {}
    }
  }
  function evict(){
    if (bytes <= C.cacheMaxBytes) return;
    const order = [...files.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [k, v] of order){ if (bytes <= C.cacheMaxBytes * 0.9) break; try { fs.unlinkSync(path.join(DIR, k)); } catch (e) {} files.delete(k); bytes -= v.size; }
  }
  function readCache(sub, id){
    disk();
    const k = `${sub}/${id}.json.gz`, e = files.get(k);
    if (!e) return null;
    try { const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, k)))); e.t = now(); try { fs.utimesSync(path.join(DIR, k), new Date(), new Date(e.t)); } catch (x) {} stats.cacheHits++; return v; }
    catch (x) { files.delete(k); bytes -= e.size; return null; }
  }
  function writeCache(sub, id, obj){
    disk();
    const k = `${sub}/${id}.json.gz`, buf = zlib.gzipSync(JSON.stringify(obj));
    const tmp = path.join(DIR, k + ".tmp" + process.pid);
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, path.join(DIR, k));
    const old = files.get(k); if (old) bytes -= old.size;
    files.set(k, {size: buf.length, t: now()}); bytes += buf.length; evict();
  }
  // a timeline keeps what the analysis reads: per-minute gold / XP / level / CS and the game events (no positions, no stat dumps)
  // the fields web/lookup-analysis.js reads (kill damage recaps, positions and the rest are dropped)
  const EVENT_FIELDS = ["type", "timestamp", "participantId", "itemId", "beforeId", "afterId", "killerId", "victimId", "assistingParticipantIds",
    "bounty", "shutdownBounty", "teamId", "killerTeamId", "buildingType", "towerType", "laneType", "monsterType", "monsterSubType", "winningTeam"];
  const KEEP = new Set(["ITEM_PURCHASED", "ITEM_SOLD", "ITEM_UNDO", "CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL", "TURRET_PLATE_DESTROYED", "DRAGON_SOUL_GIVEN", "GAME_END"]);
  const slimTimeline = tl => ({metadata: tl.metadata, info: {frameInterval: tl.info.frameInterval, participants: tl.info.participants,
    frames: tl.info.frames.map(f => ({timestamp: f.timestamp, participantFrames: Object.fromEntries(Object.entries(f.participantFrames || {}).map(([k, v]) =>
      [k, {participantId: v.participantId, totalGold: v.totalGold, xp: v.xp, level: v.level, minionsKilled: v.minionsKilled, jungleMinionsKilled: v.jungleMinionsKilled}])),
      events: (f.events || []).filter(e => KEEP.has(e.type)).map(e => { const o = {}; for (const k of EVENT_FIELDS) if (e[k] !== undefined) o[k] = e[k]; return o; })}))}});
  const pending = new Map();
  const once = (k, fn) => { if (pending.has(k)) return pending.get(k); const p = fn().finally(() => pending.delete(k)); pending.set(k, p); return p; };
  const routeOfMatch = id => PLATFORMS[id.split("_")[0].toLowerCase()];
  const getMatch = id => { const c = readCache("match", id); if (c) return Promise.resolve(c);
    return once("m:" + id, async () => { const m = await riot(routeOfMatch(id), "match", `/lol/match/v5/matches/${encodeURIComponent(id)}`); if (!m) throw notFound("That game wasn't found."); writeCache("match", id, m); return m; }); };
  const getTimeline = id => { const c = readCache("timeline", id); if (c) return Promise.resolve(c);
    return once("t:" + id, async () => { const t = await riot(routeOfMatch(id), "timeline", `/lol/match/v5/matches/${encodeURIComponent(id)}/timeline`); if (!t) return null; const s = slimTimeline(t); writeCache("timeline", id, s); return s; }); };

  /* ---------------- model + analysis (lazy) ---------------- */
  const AN = require("./lookup-analysis.js");
  let X = null;
  const model = () => { if (!X) X = AN.prepare(opts.model || JSON.parse(fs.readFileSync(path.join(ROOT, "lookup-model.json"), "utf8"))); return X; };
  const analyses = new Map();
  async function analysed(id){
    if (analyses.has(id)){ const v = analyses.get(id); analyses.delete(id); analyses.set(id, v); return v; }
    const m = await getMatch(id);
    let A = null;
    if (!AN.remake(m) && QUEUES[m.info.queueId]){
      const t = await getTimeline(id);
      if (t) { try { A = AN.analyze(model(), m, t); } catch (e) { warn(`lookup: analysis failed for a game (${e && e.message})`); } }
    }
    const v = {m, A};
    analyses.set(id, v); while (analyses.size > C.analysisCache) analyses.delete(analyses.keys().next().value);
    return v;
  }

  /* ---------------- players (account / summoner / rank / ids), refreshed at most every playerTtlMs ---------------- */
  const players = new Map(), riotIds = new Map();
  const idKey = (region, name, tag) => `${region}/${name.toLowerCase()}#${tag.toLowerCase()}`;
  async function profile(region, name, tag){
    const k = idKey(region, name, tag), hit = riotIds.get(k);
    const P0 = hit && players.get(hit.puuid);
    if (P0 && now() - P0.at < C.playerTtlMs) return P0;
    return once("p:" + k, async () => {
      const route = PLATFORMS[region];
      const acc = await riot(ACCOUNT_ROUTE[route], "account", `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
      if (!acc || !acc.puuid) throw notFound(`No player ${name}#${tag} on ${REGION_LABEL[region]}.`);
      const [sum, league] = await Promise.all([
        riot(region, "summoner", `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(acc.puuid)}`),
        riot(region, "league", `/lol/league/v4/entries/by-puuid/${encodeURIComponent(acc.puuid)}`)]);
      if (!sum) throw notFound(`${acc.gameName}#${acc.tagLine} has no League of Legends profile on ${REGION_LABEL[region]}.`);
      const P = {puuid: acc.puuid, region, gameName: acc.gameName, tagLine: acc.tagLine, level: sum.summonerLevel, icon: sum.profileIconId,
        ranks: (Array.isArray(league) ? league : []).filter(e => e.queueType === "RANKED_SOLO_5x5" || e.queueType === "RANKED_FLEX_SR").map(e => ({
          queue: e.queueType === "RANKED_SOLO_5x5" ? "solo" : "flex", tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses})),
        at: now(), ids: {}};
      const old = players.get(acc.puuid); if (old && old.region === region && now() - old.at < C.playerTtlMs) P.ids = old.ids;   // match history is per region
      players.set(acc.puuid, P); riotIds.set(k, {puuid: acc.puuid});
      if (players.size > 5000) players.delete(players.keys().next().value);
      if (riotIds.size > 10000) riotIds.delete(riotIds.keys().next().value);
      return P;
    });
  }
  async function ids(P, queue){
    const e = P.ids[queue];
    if (e && now() - e.at < C.playerTtlMs) return e.list;
    return once(`i:${P.puuid}:${queue}`, async () => {
      const list = await riot(PLATFORMS[P.region], "ids", `/lol/match/v5/matches/by-puuid/${encodeURIComponent(P.puuid)}/ids?queue=${queue}&start=0&count=${C.idsCount}`) || [];
      P.ids[queue] = {at: now(), list: list.filter(x => /^[A-Z0-9]+_\d+$/.test(x))};
      return P.ids[queue].list;
    });
  }

  /* ---------------- visitors ---------------- */
  const hits = new Map();
  function allowed(ip, bucket){
    const lim = C.visitor[bucket], t = now(), k = bucket + ":" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
    const list = (hits.get(k) || []).filter(x => t - x < Math.max(...lim.map(l => l[1])));
    for (const [n, ms] of lim){ const c = list.filter(x => t - x < ms); if (c.length >= n) { hits.set(k, list); return Math.ceil((c[0] + ms - t) / 1000); } }
    list.push(t); hits.set(k, list);
    if (hits.size > 20000) for (const [kk, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(kk);
    return 0;
  }
  let active = 0;
  async function slot(fn){
    if (active >= C.concurrency) throw new ApiError(503, "busy", "Lots of lookups right now: try again in a few seconds.", {retryAfter: 5});
    active++; try { return await fn(); } finally { active--; }
  }

  /* ---------------- helpers ---------------- */
  const NAME_RE = /^[^#/\\?&<>"]{3,16}$/u, TAG_RE = /^[\p{L}\p{N}]{2,5}$/u, PUUID_RE = /^[A-Za-z0-9_-]{60,90}$/, MATCH_RE = /^([A-Z0-9]{2,5})_(\d{6,14})$/;
  function known(puuid){ const P = PUUID_RE.test(puuid || "") && players.get(puuid); if (!P) throw notFound("Look the player up first."); return P; }
  function namesFor(cards){
    const N = model().M.names, items = {}, perks = {}, spells = {}, trees = N.trees;
    for (const c of cards){ if (!c) continue; for (const i of c.items || []) if (i && N.items[i]) items[i] = N.items[i];
      if (c.keystone && N.perks[c.keystone]) perks[c.keystone] = N.perks[c.keystone];
      for (const s of c.spells || []) if (N.spells[s]) spells[s] = N.spells[s];
      for (const b of c.build || []) if (N.items[b.item]) items[b.item] = N.items[b.item];
      for (const p of (c.runes && c.runes.perks) || []) if (N.perks[p]) perks[p] = N.perks[p]; }
    return {items, perks, spells, trees};
  }
  const pub = P => ({puuid: P.puuid, region: P.region, regionLabel: REGION_LABEL[P.region], gameName: P.gameName, tagLine: P.tagLine, level: P.level, icon: P.icon, ranks: P.ranks, fetchedAt: P.at});

  /* ---------------- icons (Data Dragon), cached on disk ---------------- */
  let iconBytes = null;
  async function icon(kind, id){
    disk();
    const f = path.join(DIR, "icons", `${kind}-${id}.png`);
    if (fs.existsSync(f)) return fs.readFileSync(f);
    return once(`icon:${kind}:${id}`, async () => {
      const ver = (model().M.source && model().M.source.patch) || "16.19.1";
      const r = await fetchImpl(`${ddragon}/cdn/${ver}/img/${kind === "profile" ? "profileicon" : "item"}/${id}.png`, {headers: {"User-Agent": "RiftLogic/1.0 (+https://www.riftlogic.dev)"}});
      if (r.status !== 200) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 256 * 1024 || buf.slice(1, 4).toString() !== "PNG") return null;
      if (iconBytes == null){ iconBytes = 0; for (const x of fs.readdirSync(path.join(DIR, "icons"))) try { iconBytes += fs.statSync(path.join(DIR, "icons", x)).size; } catch (e) {} }
      if (iconBytes + buf.length <= C.iconMaxBytes){ fs.writeFileSync(f, buf); iconBytes += buf.length; }
      return buf;
    });
  }

  /* ---------------- the handler ---------------- */
  async function handle(req, res, url){
    const ip = clientIp(req), p = url.pathname, q = url.searchParams;
    const limit = b => { const wait = allowed(ip, b); if (wait) throw new ApiError(429, "rate_limited", "Too many lookups from here: try again shortly.", {retryAfter: wait}); };
    if (p === "/api/lookup/status" && req.method === "GET") return send(res, 200, {on: true, regions: Object.keys(PLATFORMS).map(r => ({id: r, label: REGION_LABEL[r]}))});
    if (p === "/api/lookup/profile" && req.method === "GET"){
      const region = String(q.get("region") || "").toLowerCase(), name = String(q.get("name") || "").trim(), tag = String(q.get("tag") || "").trim().replace(/^#/, "");
      if (!PLATFORMS[region]) throw new ApiError(400, "bad_request", "Pick a region.");
      if (!NAME_RE.test(name) || !TAG_RE.test(tag)) throw new ApiError(400, "bad_request", "Enter a Riot ID as Name#TAG.");
      limit("profile");
      const P = await slot(() => profile(region, name, tag));
      return send(res, 200, pub(P));
    }
    if (p === "/api/lookup/matches" && req.method === "GET"){
      const P = known(q.get("puuid")), queue = q.get("queue") === "440" ? 440 : 420;
      const start = Math.max(0, Math.min(C.idsCount - 1, parseInt(q.get("start") || "0", 10) || 0)), count = Math.max(1, Math.min(20, parseInt(q.get("count") || "20", 10) || 20));
      limit("matches");
      return send(res, 200, await slot(async () => {
        const list = await ids(P, queue), page = list.slice(start, start + count);
        const rows = await Promise.all(page.map(id => analysed(id).then(v => ({card: AN.card(model(), v.m, P.puuid, v.A), A: v.A}), e => { if (e instanceof ApiError && e.status !== 404) throw e; return {card: null, A: null}; })));
        const games = rows.map(r => r.card).filter(Boolean);
        const out = {queue: QUEUES[queue], start, games, more: start + count < list.length, total: list.length, names: namesFor(games)};
        if (start === 0) out.summary = AN.summary(model(), rows.filter(r => r.card));
        return out;
      }));
    }
    const mm = p.match(/^\/api\/lookup\/match\/([A-Za-z0-9_]+)$/);
    if (mm && req.method === "GET"){
      const P = known(q.get("puuid")), id = mm[1].toUpperCase(), g = id.match(MATCH_RE);
      if (!g || PLATFORMS[g[1].toLowerCase()] !== PLATFORMS[P.region]) throw new ApiError(400, "bad_request", "That isn't a game id from this region.");
      limit("match");
      const v = await slot(() => analysed(id));
      const d = AN.detail(model(), v.m, P.puuid, v.A);
      if (!d) throw notFound("This player isn't in that game.");
      return send(res, 200, {...d, names: namesFor([d])});
    }
    if (p === "/api/lookup/refresh" && req.method === "POST"){
      let body = {}; try { body = JSON.parse(await readBody(req) || "{}"); } catch (e) { throw new ApiError(400, "bad_request", "That request couldn't be read."); }
      const P = known(body.puuid);
      limit("refresh");
      const age = now() - P.at;
      if (age < C.refreshMinMs) throw new ApiError(429, "rate_limited", "Updated a moment ago: try again shortly.", {retryAfter: Math.ceil((C.refreshMinMs - age) / 1000)});
      P.at = 0; P.ids = {};
      const R = await slot(() => profile(P.region, P.gameName, P.tagLine));
      return send(res, 200, pub(R));
    }
    const ic = p.match(/^\/api\/lookup\/icon\/(profile|item)\/(\d{1,6})\.png$/);
    if (ic && req.method === "GET"){
      limit("icon");
      const buf = await icon(ic[1], ic[2]);
      if (!buf) throw notFound("No such icon.");
      res.writeHead(200, {"content-type": "image/png", "cache-control": "public, max-age=604800", "x-content-type-options": "nosniff", "content-length": buf.length});
      return res.end(buf);
    }
    throw notFound("Not found");
  }

  /* ---------------- demo: one recorded player (web/lookup-demo.json, tools/lookup_demo.js), on or off, no outbound call ---------------- */
  let demoData;
  const demoJson = () => { if (demoData === undefined){ try { demoData = opts.demo || JSON.parse(fs.readFileSync(path.join(ROOT, "lookup-demo.json"), "utf8")); } catch (e) { demoData = null; } } return demoData; };
  function demo(req, res, url){
    const D = demoJson(), p = url.pathname.slice("/api/lookup/demo".length), q = url.searchParams;
    if (!D || req.method !== "GET") return send(res, 404, {error: "Not found"});
    const wait = allowed(clientIp(req), "demo");
    if (wait) return send(res, 429, {error: "Too many requests from here: try again shortly.", code: "rate_limited", retryAfter: wait});
    if (p === "/profile") return send(res, 200, {...D.profile, icons: D.icons});
    if (p === "/matches"){
      if (q.get("queue") === "440") return send(res, 200, {queue: "flex", start: 0, games: [], more: false, total: 0, names: D.matches.names});
      const start = Math.max(0, parseInt(q.get("start") || "0", 10) || 0), count = Math.max(1, Math.min(20, parseInt(q.get("count") || "20", 10) || 20));
      const games = D.matches.games.slice(start, start + count), out = {...D.matches, start, games, more: start + count < D.matches.games.length};
      if (start) delete out.summary;
      return send(res, 200, out);
    }
    const m = p.match(/^\/match\/([A-Z0-9_]+)$/);
    if (m && D.match[m[1]]) return send(res, 200, {...D.match[m[1]], names: D.matches.names});
    return send(res, 404, {error: "Not found"});
  }

  function handler(req, res, url){
    if (url.pathname.startsWith("/api/lookup/demo/")) return demo(req, res, url);
    if (!enabled) return send(res, 404, {error: "Not found"});
    return handle(req, res, url).catch(e => {
      if (e instanceof ApiError) return send(res, e.status, {error: e.message, code: e.code, ...e.extra});
      warn(`lookup: server error (${e && e.message})`);
      return send(res, 500, {error: "Server error", code: "error"});
    });
  }
  // the page routes: off → a 404 page for /lookup, /lookup.html and /lookup/...; on → /lookup/<region>/<name>-<tag> redirects to
  // /lookup#/<region>/<name>-<tag> (the page's hash routing); the page is noindex either way
  handler.route = url => {
    const p = url.pathname;
    if (!/^\/lookup(\.html)?(\/.*)?$/.test(p)) return null;
    // the demo page: the same page (it switches to /api/lookup/demo on this path), on or off, noindex
    if (/^\/lookup\/demo\/?$/.test(p)) return demoJson() ? {rewrite: "/lookup", headers: {"X-Robots-Tag": "noindex, nofollow"}} : {notFound: true};
    if (!enabled) return {notFound: true};
    const m = p.match(/^\/lookup\/([a-z0-9]{2,4})\/([^/]+)\/?$/i);
    if (m) return {redirect: `/lookup#/${encodeURIComponent(m[1].toLowerCase())}/${m[2]}`};
    if (p.startsWith("/lookup/")) return {notFound: true};
    return {headers: {"X-Robots-Tag": "noindex, nofollow"}};
  };
  handler.enabled = enabled;
  handler.stats = stats;
  return handler;
};
module.exports.PLATFORMS = PLATFORMS;
module.exports.ACCOUNT_ROUTE = ACCOUNT_ROUTE;
module.exports.parseLimits = parseLimits;
