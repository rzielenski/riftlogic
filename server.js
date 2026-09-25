// Rift Logic site server: the static site (same rules as `serve`, from serve.json) plus bug reports.
//   POST /api/report            → stores one report (JSON) under REPORT_DIR; size-capped and rate-limited
//   GET  /api/reports?since=ID  → list of reports newer than ID      (Authorization: Bearer REPORT_TOKEN)
//   GET  /api/reports/ID        → one report                        (Authorization: Bearer REPORT_TOKEN)
// Env: PORT, REPORT_DIR (a Railway volume, e.g. /data/reports), REPORT_TOKEN (≥ 24 chars; reading is off without it).
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const handler = require("serve-handler");

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "serve.json"), "utf8"));
const PORT = +process.env.PORT || 3000;
const REPORT_DIR = process.env.REPORT_DIR || path.join(ROOT, ".reports");      // .reports is hidden by serve.json
const TOKEN = process.env.REPORT_TOKEN && process.env.REPORT_TOKEN.length >= 24 ? process.env.REPORT_TOKEN : null;
const MAX_BODY = 256 * 1024, MAX_FILES = 20000, MAX_DIR_BYTES = 500 * 1024 * 1024;
const PER_MIN = 5, PER_DAY = 60;

fs.mkdirSync(REPORT_DIR, {recursive: true});
if (!process.env.REPORT_DIR) console.warn(`REPORT_DIR not set: reports go to ${REPORT_DIR}, which is lost on redeploy`);
if (!TOKEN) console.warn("REPORT_TOKEN not set (or shorter than 24 chars): reading reports is disabled");

// rough disk accounting so a flood can't fill the volume
let files = 0, bytes = 0;
for (const f of fs.readdirSync(REPORT_DIR)) if (f.endsWith(".json")) { files++; bytes += fs.statSync(path.join(REPORT_DIR, f)).size; }

const hits = new Map();   // ip → [timestamps]
function limited(ip){
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 86400e3);
  const lastMin = list.filter(t => now - t < 60e3).length;
  if (lastMin >= PER_MIN || list.length >= PER_DAY) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 86400e3)) hits.delete(k);
  return false;
}
const send = (res, code, obj) => { res.writeHead(code, {"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff"}); res.end(JSON.stringify(obj)); };
const authed = req => TOKEN && crypto.timingSafeEqual(Buffer.from((req.headers.authorization || "").padEnd(TOKEN.length + 7).slice(0, TOKEN.length + 7)), Buffer.from(`Bearer ${TOKEN}`));
const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";

function readBody(req){
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY){ fail(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8"))); req.on("error", fail);
  });
}

async function api(req, res, url){
  if (url.pathname === "/api/report" && req.method === "POST"){
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    if (limited(ip)) return send(res, 429, {error: "Too many reports from here — try again later."});
    if (files >= MAX_FILES || bytes >= MAX_DIR_BYTES) return send(res, 507, {error: "Report storage is full."});
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, {error: "Bad report."}); }
    if (!body || typeof body.code !== "string" || !body.code.trim()) return send(res, 400, {error: "A report needs the program."});
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(4).toString("hex");
    const report = {id, received: new Date().toISOString(), note: str(body.note, 4000), code: str(body.code, 200000),
      output: str(body.output, 100000), errors: str(body.errors, 20000), patch: str(body.patch, 40), engine: str(body.engine, 80),
      page: str(body.page, 200), userAgent: str(req.headers["user-agent"], 300)};
    const text = JSON.stringify(report);
    fs.writeFileSync(path.join(REPORT_DIR, id + ".json"), text); files++; bytes += text.length;
    return send(res, 201, {id});
  }
  if (url.pathname === "/api/reports" && req.method === "GET"){
    if (!authed(req)) return send(res, 404, {error: "Not found"});
    const since = url.searchParams.get("since") || "";
    const list = fs.readdirSync(REPORT_DIR).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).filter(id => id > since).sort().slice(0, 200);
    return send(res, 200, {reports: list.map(id => JSON.parse(fs.readFileSync(path.join(REPORT_DIR, id + ".json"), "utf8")))});
  }
  const m = url.pathname.match(/^\/api\/reports\/([\w-]+)$/);
  if (m && req.method === "GET"){
    if (!authed(req)) return send(res, 404, {error: "Not found"});
    const f = path.join(REPORT_DIR, m[1] + ".json");
    return fs.existsSync(f) ? send(res, 200, JSON.parse(fs.readFileSync(f, "utf8"))) : send(res, 404, {error: "Not found"});
  }
  return send(res, 404, {error: "Not found"});
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return api(req, res, url).catch(e => send(res, 500, {error: "Server error"}));
  return handler(req, res, {...CONFIG, public: ROOT});
}).listen(PORT, () => console.log(`Rift Logic on :${PORT} · reports → ${REPORT_DIR}`));
