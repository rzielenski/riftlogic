// Rift Logic Play: server-authoritative quiz runs and the leaderboard (mounted by server.js under /api/play/). No time limits.
//   POST /api/play/start {mode}             → {run, mode, q, n, lives, score, streak}  a new run and its first question
//                                             mode: all (default) | kill | abil (ability numbers, higher/lower) | item (item stats, prices)
//   POST /api/play/answer {run, qid, choice} → {correct, answer, x, points, score, lives, streak, over, …}   100 points a right answer
//   POST /api/play/next {run}               → {q, n}                                   the next question
//   POST /api/play/submit {run, name}       → {id, rank}                               a finished run, once
//   GET  /api/play/board?period=day|week|all&mode=all|kill|abil|item → {period, mode, rules, rows: [{rank, name, score, date}]}
//                                             top 50, best per name, one board per mode; only runs under the current rules (RULES)
//   DELETE /api/play/score/ID               (Authorization: Bearer REPORT_TOKEN)       moderation
// The question pool (web/play-pool.json, made by src/play_export.py with the engine) never leaves the server: a question goes
// out without its answer, the answer only after the player has answered it.
// Scores: PLAY_DIR/scores-YYYY-MM.jsonl, append-only (a deletion is a tombstone line), loaded into memory at startup. Each carries
// the rules version it was played under (v); the boards show the current version only (v1, timed with a speed bonus, is kept but hidden).
// Only a salted SHA-256 of the IP is stored, for rate limiting; the raw IP is never stored, logged or returned.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

// rules v2: untimed, 100 points a right answer (v1 had time limits and a speed bonus)
const RULES = 2, LIVES = 3, POINTS = 100;
// a run is dropped after 2 h without a call (no clock runs meanwhile: a player may think as long as they like)
const RUN_IDLE_MS = 2 * 3600e3, MAX_RUNS = 5000, MAX_RUNS_PER_IP = 4;
const START_PER_MIN = 12, START_PER_DAY = 400, SUBMIT_PER_MIN = 4, SUBMIT_PER_DAY = 40;
const MAX_SCORE_BYTES = 50 * 1024 * 1024, BOARD_TTL_MS = 30e3, TOP = 50;
// question kinds per mode, with weights: kill or no kill stays the most common in a mixed run
const MODES = {all: {kill: 40, mc: 26, hilo: 8, stat: 12, item: 14}, kill: {kill: 1}, abil: {mc: 80, hilo: 20}, item: {item: 1}};
const KINDS = ["kill", "mc", "hilo", "stat", "item"];
const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;
// a small built-in blocklist, matched as substrings after folding leetspeak and dropping spaces, _ and -
const BLOCK = ["fuck", "fuk", "fck", "shit", "cunt", "bitch", "whore", "slut", "nigg", "nigr", "niga", "fag", "retard", "rape", "nazi", "hitler",
  "kike", "spic", "chink", "tranny", "dick", "cock", "pussy", "penis", "vagin", "porn", "cum", "anal", "twat", "wank", "kys", "killyourself", "admin", "riotgames"];
const FOLD = {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "$": "s", "@": "a", "!": "i"};

function validName(raw){
  if (typeof raw !== "string") return {error: "A name is 3–16 letters, digits, spaces, _ or -."};
  const name = raw.trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) return {error: "A name is 3–16 letters, digits, spaces, _ or -."};
  const flat = name.toLowerCase().replace(/[\s_-]/g, "").replace(/[0-9$@!]/g, c => FOLD[c] || c);
  if (/https?|www|dotcom|discordgg|twitchtv|youtube|tiktok/.test(flat)) return {error: "No links or handles in names."};
  if (BLOCK.some(w => flat.includes(w))) return {error: "Please pick another name."};
  return {name};
}

module.exports = function playApi({ROOT, PLAY_DIR, TOKEN, send, readBody, clientIp, now = () => Date.now()}){
  fs.mkdirSync(PLAY_DIR, {recursive: true});
  // salt for the IP hashes: PLAY_SALT, else one made once and kept next to the scores
  const saltFile = path.join(PLAY_DIR, ".salt");
  let SALT = process.env.PLAY_SALT;
  if (!SALT){ try { SALT = fs.readFileSync(saltFile, "utf8").trim(); } catch (e) {} }
  if (!SALT){ SALT = crypto.randomBytes(24).toString("hex"); try { fs.writeFileSync(saltFile, SALT, {mode: 0o600}); } catch (e) {} }
  const ipHash = ip => crypto.createHash("sha256").update(SALT + "|" + ip).digest("hex").slice(0, 20);

  /* ---------------- the pool ---------------- */
  let POOL = null;
  function pool(){
    if (POOL) return POOL;
    const f = path.join(ROOT, "play-pool.json");
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    POOL = {names: d.names || {}, items: d.items || {}, patch: d.patch};
    for (const k of KINDS) POOL[k] = d[k] || [];
    return POOL;
  }
  // what the player sees: never the answer, the explanation or the engine program
  function view(q, kind){
    if (kind === "kill") return {id: q.id, kind, a: {c: q.a.c, l: q.a.l, it: q.a.it, combo: q.a.combo, g: q.a.g},
                                 t: {c: q.t.c, l: q.t.l, it: q.t.it, g: q.t.g, hp: q.t.hp, max: q.t.max, ar: q.t.ar, mr: q.t.mr}};
    if (kind === "mc") return {id: q.id, kind: "mc", c: q.c, s: q.s, name: q.name, type: q.kind, r: q.r, rs: q.rs || null, opts: q.opts, unit: q.unit};
    if (kind === "hilo") return {id: q.id, kind, c: q.c, s: q.s, name: q.name, r: q.r, v: q.v};
    if (kind === "stat") return {id: q.id, kind, st: q.st, l: q.l, opts: q.opts};
    return {id: q.id, kind: "item", i: q.i, st: q.st, opts: q.opts, unit: q.unit};
  }
  const nOpts = (q, kind) => kind === "hilo" ? 2 : q.opts.length;

  /* ---------------- runs ---------------- */
  const runs = new Map();   // id → run
  function sweep(){
    const t = now();
    for (const [id, r] of runs) if (t - r.last > RUN_IDLE_MS) runs.delete(id);
  }
  setInterval(sweep, 60e3).unref();
  function issue(run){
    const P = pool();
    const W = Object.entries(MODES[run.mode]).filter(([k]) => P[k].length);
    let r = Math.random() * W.reduce((a, [, w]) => a + w, 0), kind = W[W.length - 1][0];
    for (const [k, w] of W){ r -= w; if (r < 0){ kind = k; break; } }
    const list = P[kind];
    let q = null;
    for (let i = 0; i < 40 && !q; i++){ const c = list[Math.floor(Math.random() * list.length)]; if (!run.seen.has(c.id)) q = c; }
    if (!q) q = list[Math.floor(Math.random() * list.length)];
    run.seen.add(q.id); run.n++;
    run.cur = {q, kind};
    return {q: view(q, kind), n: run.n};
  }

  /* ---------------- rate limits (by hashed IP) ---------------- */
  const hits = new Map();
  function limited(key, perMin, perDay){
    const t = now(), list = (hits.get(key) || []).filter(x => t - x < 86400e3);
    if (list.filter(x => t - x < 60e3).length >= perMin || list.length >= perDay){ hits.set(key, list); return true; }
    list.push(t); hits.set(key, list);
    if (hits.size > 20000) for (const [k, v] of hits) if (!v.some(x => t - x < 86400e3)) hits.delete(k);
    return false;
  }

  /* ---------------- scores ---------------- */
  let scores = [], scoreBytes = 0;
  const deleted = new Set();
  for (const f of fs.readdirSync(PLAY_DIR).filter(f => /^scores-\d{4}-\d{2}\.jsonl$/.test(f)).sort()){
    const text = fs.readFileSync(path.join(PLAY_DIR, f), "utf8"); scoreBytes += text.length;
    for (const line of text.split("\n")) if (line.trim()){
      try { const e = JSON.parse(line); if (e.del) deleted.add(e.del); else if (e.id && e.name) scores.push(e); } catch (e) {}
    }
  }
  scores = scores.filter(e => !deleted.has(e.id));
  function append(obj){
    const d = new Date(now()), f = path.join(PLAY_DIR, `scores-${d.toISOString().slice(0, 7)}.jsonl`), line = JSON.stringify(obj) + "\n";
    fs.appendFileSync(f, line); scoreBytes += line.length;
  }
  function since(period){
    const d = new Date(now());
    if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (period === "week"){ const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); }
    return 0;
  }
  // best per name (case-insensitive; the earlier of equal scores), highest first
  function bests(period, mode){
    const from = since(period), best = new Map();
    for (const e of scores){
      if ((e.v || 1) !== RULES || Date.parse(e.date) < from || (e.mode || "all") !== mode) continue;
      const k = e.name.toLowerCase(), b = best.get(k);
      if (!b || e.score > b.score || (e.score === b.score && e.date < b.date)) best.set(k, e);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const boards = {};
  function board(period, mode){
    const c = boards[period + mode];
    if (c && now() - c.at < BOARD_TTL_MS) return c.body;
    const rows = bests(period, mode).slice(0, TOP).map((e, i) => ({rank: i + 1, name: e.name, score: e.score, date: e.date.slice(0, 10)}));
    const body = {period, mode, rules: RULES, rows, updated: new Date(now()).toISOString()};
    boards[period + mode] = {at: now(), body};
    return body;
  }
  const rankFor = (score, mode) => Object.fromEntries(["day", "week", "all"].map(p => [p, 1 + bests(p, mode).filter(e => e.score > score).length]));
  const modeOf = m => typeof m === "string" && MODES[m] ? m : "all";

  const json = async req => { try { const b = JSON.parse(await readBody(req)); return b && typeof b === "object" ? b : null; } catch (e) { return null; } };
  const runOf = (body) => body && typeof body.run === "string" ? runs.get(body.run) : null;

  return async function handle(req, res, url){
    const p = url.pathname;
    if (p === "/api/play/board" && req.method === "GET"){
      const period = ["day", "week", "all"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "day";
      return send(res, 200, board(period, modeOf(url.searchParams.get("mode"))));
    }
    if (p === "/api/play/start" && req.method === "POST"){
      if (!pool()) return send(res, 503, {error: "No question pool."});
      const body = await json(req), mode = modeOf(body && body.mode);
      if (!Object.keys(MODES[mode]).some(k => POOL[k].length)) return send(res, 503, {error: "No questions for this mode."});
      const ip = ipHash(clientIp(req));
      if (limited("s" + ip, START_PER_MIN, START_PER_DAY)) return send(res, 429, {error: "Too many runs from here — try again in a minute."});
      sweep();
      const mine = [...runs.values()].filter(r => r.ip === ip).sort((a, b) => a.last - b.last);
      while (mine.length >= MAX_RUNS_PER_IP) runs.delete(mine.shift().id);     // the oldest of this player's runs gives way
      if (runs.size >= MAX_RUNS) return send(res, 503, {error: "The game is busy — try again soon."});
      const id = crypto.randomBytes(12).toString("hex");
      const run = {id, ip, mode, created: now(), last: now(), n: 0, seen: new Set(), cur: null, lives: LIVES, score: 0, streak: 0, bestStreak: 0,
                   answered: 0, correct: 0, over: false, submitted: false};
      runs.set(id, run);
      const first = issue(run);
      return send(res, 200, {run: id, mode, ...first, lives: run.lives, score: 0, streak: 0, patch: POOL.patch});
    }
    if (p === "/api/play/answer" && req.method === "POST"){
      const body = await json(req), run = runOf(body);
      if (!run) return send(res, 404, {error: "Run not found (it may have expired)."});
      if (run.over) return send(res, 409, {error: "This run is over."});
      const cur = run.cur;
      if (!cur || body.qid !== cur.q.id) return send(res, 409, {error: "Not the current question."});
      const t = now();
      const ans = cur.q.ans;
      const choice = cur.kind === "kill" ? (body.choice === true || body.choice === false ? body.choice : null)
                                         : (Number.isInteger(body.choice) && body.choice >= 0 && body.choice < nOpts(cur.q, cur.kind) ? body.choice : null);
      const correct = choice !== null && choice === ans;
      const points = correct ? POINTS : 0;
      run.answered++; run.last = t; run.cur = null;
      if (correct){ run.correct++; run.score += points; run.streak++; run.bestStreak = Math.max(run.bestStreak, run.streak); }
      else { run.lives--; run.streak = 0; }
      run.over = run.lives <= 0;
      const out = {correct, answer: ans, x: cur.q.x, points, score: run.score, lives: run.lives, streak: run.streak, over: run.over};
      if (run.over) Object.assign(out, {answered: run.answered, right: run.correct, bestStreak: run.bestStreak, rank: rankFor(run.score, run.mode)});
      return send(res, 200, out);
    }
    if (p === "/api/play/next" && req.method === "POST"){
      const body = await json(req), run = runOf(body);
      if (!run) return send(res, 404, {error: "Run not found (it may have expired)."});
      if (run.over) return send(res, 409, {error: "This run is over."});
      if (run.cur) return send(res, 409, {error: "Answer the current question first."});
      run.last = now();
      return send(res, 200, issue(run));
    }
    if (p === "/api/play/submit" && req.method === "POST"){
      const body = await json(req), run = runOf(body);
      if (!run) return send(res, 404, {error: "Run not found (it may have expired)."});
      if (!run.over) return send(res, 409, {error: "Finish the run first."});
      if (run.submitted) return send(res, 409, {error: "This run is already on the board."});
      const v = validName(body.name);
      if (v.error) return send(res, 400, {error: v.error});
      const ip = ipHash(clientIp(req));
      if (limited("u" + ip, SUBMIT_PER_MIN, SUBMIT_PER_DAY)) return send(res, 429, {error: "Too many submissions from here — try again later."});
      if (scoreBytes >= MAX_SCORE_BYTES) return send(res, 507, {error: "Score storage is full."});
      const e = {id: crypto.randomBytes(8).toString("hex"), v: RULES, name: v.name, mode: run.mode, score: run.score, answered: run.answered, correct: run.correct,
                 date: new Date(now()).toISOString(), run: run.id, ip};
      append(e); scores.push(e); run.submitted = true;
      for (const k of Object.keys(boards)) delete boards[k];                     // show it on the next read
      return send(res, 201, {id: e.id, name: e.name, mode: e.mode, score: e.score, rank: rankFor(e.score, e.mode)});
    }
    const m = p.match(/^\/api\/play\/score\/([0-9a-f]{16})$/);
    if (m && req.method === "DELETE"){
      const auth = String(req.headers.authorization || ""), want = TOKEN ? `Bearer ${TOKEN}` : null;
      const okTok = want && auth.length === want.length && crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(want));
      if (!okTok) return send(res, 404, {error: "Not found"});
      const i = scores.findIndex(e => e.id === m[1]);
      if (i < 0) return send(res, 404, {error: "Not found"});
      scores.splice(i, 1); append({del: m[1], date: new Date(now()).toISOString()});
      for (const k of Object.keys(boards)) delete boards[k];
      return send(res, 200, {deleted: m[1]});
    }
    return send(res, 404, {error: "Not found"});
  };
};
module.exports.validName = validName;
