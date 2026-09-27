// Rift Logic site server: the static site (same rules as `serve`, from serve.json) plus bug reports.
//   POST /api/report            → stores one report (JSON) under REPORT_DIR; size-capped and rate-limited
//   GET  /api/reports?since=ID  → list of reports newer than ID      (Authorization: Bearer REPORT_TOKEN)
//   GET  /api/reports/ID        → one report                        (Authorization: Bearer REPORT_TOKEN)
// Env: PORT, REPORT_DIR (a Railway volume, e.g. /data/reports), REPORT_TOKEN (≥ 24 chars; reading is off without it).
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const {Readable} = require("stream");
const handler = require("serve-handler");

const ROOT = __dirname;
// etag: serve-handler hashes each file once per mtime and answers If-None-Match with 304
const CONFIG = {...JSON.parse(fs.readFileSync(path.join(ROOT, "serve.json"), "utf8")), etag: true};
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

// ---- compression: brotli / gzip for text files, precompressed once per (path, mtime, size) and held in memory ----
// serve-handler still does routing, headers (serve.json: CSP, nosniff, …), ETag/304, Range and HEAD; we swap in the
// compressed bytes through its createReadStream hook and fix the headers in writeHead. Range requests get identity bytes.
const COMPRESSIBLE = /\.(html|js|json|css|svg|txt|xml|webmanifest|ico)$/i, MIN_SIZE = 1024;
const SKIP = /(^|\/)(\.|node_modules(\/|$)|reasoning(\/|$))|\.template(\.html)?$|^(package(-lock)?|railway|serve|links)\.json$|^server\.js$/;
const packs = new Map();   // absolute path → {key, gz: Promise<Buffer>, br: Buffer|null, brJob: Promise|null}
const brOpts = size => ({params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size}});
const pz = (fn, buf, opts) => new Promise((ok, fail) => fn(buf, opts, (e, out) => e ? fail(e) : ok(out)));
function pack(abs, st){
  const key = `${st.mtimeMs}:${st.size}`;
  let p = packs.get(abs);
  if (!p || p.key !== key){
    const raw = fs.promises.readFile(abs);
    p = {key, br: null, brJob: null, raw, gz: raw.then(b => pz(zlib.gzip, b, {level: 9}))};
    p.gz.catch(() => packs.delete(abs));
    packs.set(abs, p);
  }
  return p;
}
function brotli(p){   // quality 11 is slow (seconds for the big files): run it in the background, gzip meanwhile
  if (!p.brJob) p.brJob = p.raw.then(b => pz(zlib.brotliCompress, b, brOpts(b.length))).then(b => { p.br = b; p.raw = null; return b; }, () => null);
  return p.brJob;
}
const eligible = abs => { const rel = path.relative(ROOT, abs).split(path.sep).join("/"); return !rel.startsWith("..") && COMPRESSIBLE.test(rel) && !SKIP.test(rel); };
function accepts(req){
  const out = {};
  for (const part of String(req.headers["accept-encoding"] || "").split(",")){
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map(x => x.trim()).find(x => x.startsWith("q="));
    if (name && (q ? parseFloat(q.slice(2)) : 1) > 0) out[name] = true;
  }
  return {br: !!(out.br || out["*"]), gzip: !!(out.gzip || out["*"])};
}
async function warm(){   // precompress every served text file at startup, one at a time
  const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(d => {
    const abs = path.join(dir, d.name);
    if (d.isSymbolicLink()) return [];
    return d.isDirectory() ? (SKIP.test(path.relative(ROOT, abs) + "/") ? [] : walk(abs)) : [abs];
  });
  for (const abs of walk(ROOT)) if (eligible(abs)){
    try { const st = fs.statSync(abs); if (st.size >= MIN_SIZE){ const p = pack(abs, st); await p.gz; await brotli(p); } } catch (e) {}
  }
}

function serveStatic(req, res){
  const want = req.headers.range == null ? accepts(req) : {br: false, gzip: false};
  let enc = null, body = null, notModified = false;
  // our ETags carry an encoding suffix ("sha-br"); the identity sha is what serve-handler compares for 304s
  const inm = req.headers["if-none-match"];
  if (inm) req.headers["if-none-match"] = inm.replace(/-(br|gz)"$/, '"');
  const ims = Date.parse(req.headers["if-modified-since"] || "");
  const methods = {
    // serve-handler calls this with one argument to hash a file for its ETag (and for error pages): identity bytes there
    createReadStream: (abs, opts) => opts === undefined ? fs.createReadStream(abs) : open(abs, opts),
  };
  async function open(abs, opts){
      const st = await fs.promises.stat(abs);
      res.setHeader("Last-Modified", st.mtime.toUTCString());
      if (eligible(abs)) res.setHeader("Vary", "Accept-Encoding");
      if (opts.start === undefined && !inm && ims >= Math.floor(st.mtimeMs / 1000) * 1000){ notModified = true; return Readable.from([]); }
      if (opts.start === undefined && eligible(abs) && st.size >= MIN_SIZE && (want.br || want.gzip)){
        const p = pack(abs, st);
        if (want.br && p.br) { enc = "br"; body = p.br; }
        else {
          if (want.br) brotli(p);
          if (want.gzip) { body = await p.gz.catch(() => null); if (body) enc = "gzip"; }
        }
        if (body) return Readable.from([body]);
      }
      return fs.createReadStream(abs, opts);
  }
  const {writeHead, end} = res;
  res.writeHead = function(code, headers = {}){
    if (notModified && code === 200){   // If-Modified-Since hit (serve-handler only checks If-None-Match)
      for (const k of ["Content-Length", "Content-Type", "Content-Disposition", "Accept-Ranges"]) delete headers[k];
      code = 304;
    } else if (enc){
      headers["Content-Encoding"] = enc;
      headers["Content-Length"] = body.length;
      if (headers.ETag) headers.ETag = headers.ETag.replace(/"$/, enc === "br" ? '-br"' : '-gz"');
    }
    return writeHead.call(this, code, headers);
  };
  res.end = function(...a){   // serve-handler's own 304 (If-None-Match) skips writeHead: echo the client's ETag
    if (res.statusCode === 304 && !res.headersSent && inm) res.setHeader("ETag", inm);
    return end.apply(this, a);
  };
  return handler(req, res, {...CONFIG, public: ROOT}, methods);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return api(req, res, url).catch(e => send(res, 500, {error: "Server error"}));
  return serveStatic(req, res);
}).listen(PORT, () => { console.log(`Rift Logic on :${PORT} · reports → ${REPORT_DIR}`); if (process.env.RL_NO_WARM !== "1") warm(); });
