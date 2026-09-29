// Rift Logic player lookup: the analysis of one ranked game (web/lookup-api.js calls it; server-side only, hidden by serve.json).
// SOLO-QUEUE MODELS ONLY (never the pro ones): web/lookup-model.json, written by src/lookup_model.py from the site's solo tables.
//
// Per game, from the MATCH-V5 match and timeline JSON:
//   curve     blue's win probability at every game minute 1..T (T = frames - 2: the last frame is the partial end minute), the
//             solo in-game model (src/winprob_solo.py, variant "full") on the state at m:00 built exactly as winprob_solo._game()
//             builds it (events with timestamp <= m:00; deaths on the clock from level and time; inhibitors down 5 min; elder
//             150 s, baron 180 s; completed legendaries net of undo and sell), plus the draft logit and the scaling score;
//             minute 0 of the curve = the draft win probability (side prior + the draft)
//   wpa       the site's solo WPA for every player (wpa() on the Champions page): side prior -> draft (Shapley shares of the
//             five per-role draft terms) -> 14:00 (Shapley shares of each position's gold, XP, kill, CS and legendary-item
//             differences vs the same-position opponent; objectives, side and the rest stay in the base) -> result (the 14:00
//             -> end change, split equally among the five). The ten add up to 0 (the five of a team: its result - its prior).
//   deaths    WP lost (wpLost()): each death's share of its team's win-probability DROP over the game minute it happened in
//             (0 when the team gained), shared among that team's deaths in that minute; untraded = no enemy died within 15 s
//             (the site's rule: the three nearest deaths either side in time order)
//   plays     event WPA: in each minute the team GAINED win probability, the gain is split equally among the team's kills and
//             objectives in that minute, and each one's share equally among its participants (killer + assists; for a monster
//             or building, the team's killer and assisters). Plays total = the gains credited to the player - their WP lost.
//   lane      gold / XP / CS difference at 10:00 and 15:00 vs the same-position opponent, and the gold differences against the
//             matchup's expected value (lookup-model.json lane: c0 by side + u(a) - u(b) + m(a, b), empirical Bayes)
//   build     the completed legendaries in order: this game's item WPA (the team's WP change from the minute before the
//             completion to 6 minutes later, minus the average change of states at that minute and WP decile, as itemWpa())
//             and the champion + role's item WPA from the build explorer (builds.json)
//   runes     keystone + secondary tree; the keystone's WPA vs the champion + role average (the Runes tab)
"use strict";

const ROLE_OF = {TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4};
const ROLES = ["top", "jungle", "mid", "bot", "support"];
const DRAGONS = ["AIR", "FIRE", "WATER", "EARTH", "HEXTECH", "CHEMTECH"];
const TOWER = {OUTER_TURRET: "towerOuter", INNER_TURRET: "towerInner", BASE_TURRET: "towerBase", NEXUS_TURRET: "towerNexus"};
const BRW = [6, 6, 8, 8, 10, 12, 16, 21, 26, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
const FIX = {FiddleSticks: "Fiddlesticks"};
const OBJ_LABEL = {towerOuter: "Outer turret", towerInner: "Inner turret", towerBase: "Base turret", towerNexus: "Nexus turret",
  inhib: "Inhibitor", plate: "Turret plate", grubs: "Voidgrub", herald: "Rift Herald", baron: "Baron", elder: "Elder drake",
  soul: "Dragon soul", dragAir: "Cloud drake", dragFire: "Infernal drake", dragWater: "Ocean drake", dragEarth: "Mountain drake",
  dragHextech: "Hextech drake", dragChemtech: "Chemtech drake"};
const sig = z => 1 / (1 + Math.exp(-z));
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const r1 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
const WTS = [1 / 5, 1 / 20, 1 / 30, 1 / 20, 1 / 5];                    // Shapley weights j! (4 - j)! / 5! by coalition size j

function deathTimer(level, sec){
  const m = sec / 60;
  let f;
  if (m < 15) f = 0;
  else if (m < 30) f = Math.ceil(2 * (m - 15)) * 0.00425;
  else if (m < 45) f = 0.1275 + Math.ceil(2 * (m - 30)) * 0.003;
  else f = Math.min(0.5, 0.2175 + Math.ceil(2 * (m - 45)) * 0.0145);
  return BRW[Math.max(1, Math.min(18, Math.trunc(level))) - 1] * (1 + f);
}

/* ---------------- the model file, prepared once ---------------- */
function prepare(M){
  const n = M.champs.length, idx = new Map(M.champs.map((c, i) => [c, i]));
  const D = M.draft, s = new Float64Array(5 * n), p = [], sMean = [], lane = [], laneE = [], syn = [], synE = [];
  for (let r = 0; r < 5; r++){
    for (const [c, v] of D.s[r]) s[r * n + c] = v;
    const pr = new Float64Array(n); for (const [c, v] of D.p[r]) pr[c] = v; p.push(pr);
    let m = 0, t = 0; for (const [c, v] of D.p[r]){ m += v * s[r * n + c]; t += v; } sMean.push(t ? m / t : 0);
    const L = new Map(), a = D.lane[r]; for (let i = 0; i < a.length; i += 3) L.set(a[i] * n + a[i + 1], a[i + 2]); lane.push(L);
    const E = new Float64Array(n); for (const [c, v] of D.laneE[r]) E[c] = v; laneE.push(E);
  }
  D.synPairs.forEach((_, j) => { const Y = new Map(), a = D.syn[j]; for (let i = 0; i < a.length; i += 3) Y.set(a[i] * n + a[i + 1], a[i + 2]); syn.push(Y);
    const e1 = new Float64Array(n), e2 = new Float64Array(n); for (const [c, v] of D.synE[j][0]) e1[c] = v; for (const [c, v] of D.synE[j][1]) e2[c] = v; synE.push([e1, e2, D.synE[j][2]]); });
  // lane matchup table (gd10, gd15)
  const LT = M.lane, W = LT.width, lt = {stats: LT.stats, c0: LT.c0, sd: LT.sd, u: [], pairs: []};
  for (let r = 0; r < 5; r++){
    lt.u.push(LT.stats.map((_, j) => { const m = new Map(); for (const [c, v, g] of LT.u[r][j]) m.set(c, [v, g]); return m; }));
    const P = new Map(), a = LT.pairs[r]; for (let i = 0; i < a.length; i += W) P.set(a[i] * n + a[i + 1], a.slice(i + 2, i + W)); lt.pairs.push(P);
  }
  return {M, n, idx, feats: M.wp.feats, legend: new Set(M.wp.legend), draft: {D, s, p, sMean, lane, laneE, syn, synE}, lt};
}

/* ---------------- draft model (the engine's dwpLogit, web/engine.js; src/draftwp.py) ---------------- */
function teamFeats(X, T){
  const D = X.draft.D, A = T.map((c, r) => c >= 0 && D.attr[c] ? D.attr[c] : D.attrMean[r]);
  const sum = j => A.reduce((t, a) => t + a[j], 0), F = sum(0), E = sum(1), Y = sum(2), R = sum(3), dd = sum(5);
  const apd = A.reduce((t, a) => t + a[4] * a[5], 0), ap = apd / Math.max(dd, 1e-9), arch = j => sum(11 + j) / 5, mx = Math.max;
  return [mx(0, 2 - F), mx(0, F - 3), mx(0, 3.5 - E), mx(0, 4.5 - Y), mx(0, 2 - R), mx(0, 0.28 - ap, ap - 0.62),
    mx(0, sum(6) - 2) + mx(0, sum(7) - 2) + mx(0, sum(8) - 2) + mx(0, sum(9) - 1), mx(0, sum(10) - 4), arch(2) * arch(1) * 4,
    arch(0), arch(1), arch(2), arch(3), arch(4), arch(5)];
}
const profScore = (X, T) => { const f = teamFeats(X, T); return X.draft.D.profW.reduce((t, w, j) => t + w * f[j], 0); };
function synScore(X, T){
  let z = 0; const n = X.n;
  X.draft.D.synPairs.forEach(([r1, r2], j) => { const a = T[r1], b = T[r2], [e1, e2, e0] = X.draft.synE[j];
    z += a >= 0 && b >= 0 ? (X.draft.syn[j].get(a * n + b) || 0) : a >= 0 ? e1[a] : b >= 0 ? e2[b] : e0; });
  return z;
}
function draftLogit(X, B, R){
  const d = X.draft, n = X.n; let z = d.D.b0;
  for (let r = 0; r < 5; r++){
    const a = B[r], b = R[r];
    z += (a >= 0 ? d.s[r * n + a] : d.sMean[r]) - (b >= 0 ? d.s[r * n + b] : d.sMean[r]);
    if (a >= 0 && b >= 0){ if (a !== b) z += a < b ? (d.lane[r].get(a * n + b) || 0) : -(d.lane[r].get(b * n + a) || 0); }
    else if (a >= 0) z += d.laneE[r][a]; else if (b >= 0) z -= d.laneE[r][b];
  }
  return z + synScore(X, B) - synScore(X, R) + profScore(X, B) - profScore(X, R);
}
/* blue's per-role draft terms z_r (sum + b0 = draftLogit): strengths + lane matchup + half of each synergy pair + the role's
   Shapley share of the profile score (empty slots at the role mean), as src/draftwp.py draft_z() splits it */
function draftTerms(X, B, R){
  const d = X.draft, n = X.n, z = [0, 0, 0, 0, 0];
  for (let r = 0; r < 5; r++){
    const a = B[r], b = R[r];
    z[r] += (a >= 0 ? d.s[r * n + a] : d.sMean[r]) - (b >= 0 ? d.s[r * n + b] : d.sMean[r]);
    if (a >= 0 && b >= 0){ if (a !== b) z[r] += a < b ? (d.lane[r].get(a * n + b) || 0) : -(d.lane[r].get(b * n + a) || 0); }
    else if (a >= 0) z[r] += d.laneE[r][a]; else if (b >= 0) z[r] -= d.laneE[r][b];
  }
  // synergy: each pair's (blue - red) value, half to each of its two roles
  d.D.synPairs.forEach(([r1, r2], j) => {
    const one = T => { const a = T[r1], b = T[r2], [e1, e2, e0] = d.synE[j];
      return a >= 0 && b >= 0 ? (d.syn[j].get(a * n + b) || 0) : a >= 0 ? e1[a] : b >= 0 ? e2[b] : e0; };
    const v = one(B) - one(R); z[r1] += v / 2; z[r2] += v / 2;
  });
  const shares = T => {
    const vals = new Float64Array(32);
    for (let k = 0; k < 32; k++) vals[k] = profScore(X, T.map((c, r) => (k >> r) & 1 ? c : -1));
    const out = [0, 0, 0, 0, 0];
    for (let r = 0; r < 5; r++) for (let k = 0; k < 32; k++) if (!((k >> r) & 1)) out[r] += WTS[popc(k)] * (vals[k | (1 << r)] - vals[k]);
    return out;
  };
  const pb = shares(B), pr = shares(R);
  for (let r = 0; r < 5; r++) z[r] += pb[r] - pr[r];
  return z;
}
const popc = k => { let c = 0; while (k){ c += k & 1; k >>= 1; } return c; };
/* Shapley shares of the five z in sigmoid(base + sum z) - ref; the empty coalition's value split equally (src/winprob.py) */
function shapley(base, z, ref){
  const v = new Float64Array(32);
  for (let k = 0; k < 32; k++){ let t = base; for (let i = 0; i < 5; i++) if ((k >> i) & 1) t += z[i]; v[k] = sig(t) - ref; }
  const out = [0, 1, 2, 3, 4].map(() => v[0] / 5);
  for (let i = 0; i < 5; i++) for (let k = 0; k < 32; k++) if (!((k >> i) & 1)) out[i] += WTS[popc(k)] * (v[k | (1 << i)] - v[k]);
  return out;
}

/* ---------------- slots: participant -> blue top..support, red top..support ---------------- */
function slotsOf(match, tl){
  const ps = match.info.participants, guessed = [];
  const role = new Array(ps.length).fill(null);
  for (const team of [100, 200]){
    const idxs = ps.map((p, i) => i).filter(i => ps[i].teamId === team), used = new Set();
    for (const i of idxs){ const r = ROLE_OF[ps[i].teamPosition]; if (r != null && !used.has(r)){ role[i] = r; used.add(r); } }
    for (const i of idxs) if (role[i] == null){ const r = ROLE_OF[ps[i].individualPosition]; if (r != null && !used.has(r)){ role[i] = r; used.add(r); guessed.push(i); } }
    for (const i of idxs) if (role[i] == null){ const r = [0, 1, 2, 3, 4].find(q => !used.has(q)); role[i] = r; used.add(r); guessed.push(i); }
  }
  const slotOfIdx = ps.map((p, i) => (p.teamId === 100 ? 0 : 5) + role[i]);
  // timeline participantId -> slot, through the puuid when the timeline lists it (else the k-th participant, as the site does)
  const pid2slot = new Map(), byPuuid = new Map(ps.map((p, i) => [p.puuid, i]));
  const tps = tl && tl.info && tl.info.participants;
  if (Array.isArray(tps) && tps.length === ps.length && tps.every(t => byPuuid.has(t.puuid)))
    for (const t of tps) pid2slot.set(+t.participantId, slotOfIdx[byPuuid.get(t.puuid)]);
  else ps.forEach((p, i) => pid2slot.set(i + 1, slotOfIdx[i]));
  const bySlot = new Array(10); ps.forEach((p, i) => { bySlot[slotOfIdx[i]] = p; });
  return {slotOfIdx, pid2slot, bySlot, guessed: guessed.length > 0};
}

/* ---------------- the state at every minute: winprob_solo._game() ---------------- */
function extract(X, match, tl){
  const fr = tl.info.frames, T = fr.length - 2;
  if (T < 3) return null;
  const {pid2slot, bySlot, guessed, slotOfIdx} = slotsOf(match, tl);
  const P = [];
  for (let mi = 0; mi <= T; mi++){
    const row = []; for (let s = 0; s < 10; s++) row.push([0, 0, 0, 0]);
    for (const [pid, v] of Object.entries(fr[mi].participantFrames || {})){
      const s = pid2slot.get(+pid);
      if (s != null) row[s] = [v.totalGold || 0, v.xp || 0, v.level || 0, (v.minionsKilled || 0) + (v.jungleMinionsKilled || 0)];
    }
    P.push(row);
  }
  const ev = [];
  for (const f of fr) for (const e of f.events || []) ev.push(e);
  ev.sort((a, b) => a.timestamp - b.timestamp);                      // stable, like Python's sorted()
  const side = s => s < 5 ? 0 : 1, LEG = X.legend;
  const deaths = [], objs = [], comps = [], kc = new Array(10).fill(0), dc = new Array(10).fill(0);
  const deadUntil = new Array(10).fill(0), cnt = [{}, {}], inhibDown = [[], []], elderUntil = [0, 0], baronUntil = [0, 0];
  const drakes = [0, 0], soul = [0, 0], legend = new Array(10).fill(0), last = new Map();
  const inc = (sd, f) => { cnt[sd][f] = (cnt[sd][f] || 0) + 1; };
  const slotsOfIds = ids => (ids || []).map(i => pid2slot.get(i)).filter(s => s != null);
  const states = [];
  let j = 0;
  const handle = (e, mi) => {
    const ty = e.type, sec = e.timestamp / 1000;
    if (ty === "CHAMPION_KILL"){
      const v = pid2slot.get(e.victimId), k = pid2slot.has(e.killerId) ? pid2slot.get(e.killerId) : -1;
      if (v == null) return;
      dc[v]++; if (k >= 0) kc[k]++;
      // after the last full minute: listed (cost 0: no next minute to measure) but outside the state, as in the site's model
      if (mi == null){ deaths.push({sec, v, k, assists: slotsOfIds(e.assistingParticipantIds), bounty: 0, end: true}); return; }
      inc(1 - side(v), "kills");
      const lvl = mi > 0 ? P[Math.min(mi, T)][v][2] : 1;
      deadUntil[v] = sec + deathTimer(lvl || 1, sec);
      deaths.push({sec, v, k, assists: slotsOfIds(e.assistingParticipantIds), bounty: (e.bounty || 0) + (e.shutdownBounty || 0)});
    } else if (mi == null) return;
    else if (ty === "BUILDING_KILL"){
      const taker = e.teamId === 100 ? 1 : 0;                       // teamId = the building's owner
      const who = [pid2slot.get(e.killerId), ...slotsOfIds(e.assistingParticipantIds)].filter(s => s != null && side(s) === taker);
      if (e.buildingType === "TOWER_BUILDING"){ const f = TOWER[e.towerType]; if (f){ inc(taker, f); objs.push({sec, side: taker, type: f, who}); } }
      else if (e.buildingType === "INHIBITOR_BUILDING"){ inc(taker, "inhib"); inhibDown[taker].push(sec + 300); objs.push({sec, side: taker, type: "inhib", who}); }
    } else if (ty === "TURRET_PLATE_DESTROYED"){
      const taker = e.teamId === 100 ? 1 : 0;
      inc(taker, "plates"); objs.push({sec, side: taker, type: "plate", who: [pid2slot.get(e.killerId)].filter(s => s != null && side(s) === taker)});
    } else if (ty === "ELITE_MONSTER_KILL"){
      const tk = e.killerTeamId; if (tk !== 100 && tk !== 200) return;
      const s_ = tk === 100 ? 0 : 1, mt = e.monsterType, sub = e.monsterSubType || "";
      const who = [pid2slot.get(e.killerId), ...slotsOfIds(e.assistingParticipantIds)].filter(s => s != null && side(s) === s_);
      let f = null;
      if (mt === "HORDE") f = "grubs";
      else if (mt === "RIFTHERALD") f = "herald";
      else if (mt === "BARON_NASHOR"){ f = "baron"; baronUntil[s_] = sec + 180; }
      else if (mt === "DRAGON"){
        if (sub === "ELDER_DRAGON"){ f = "elder"; elderUntil[s_] = sec + 150; }
        else { const d = sub.replace("_DRAGON", ""); const t = d.charAt(0) + d.slice(1).toLowerCase(); if (DRAGONS.includes(d)){ f = "drag" + t; drakes[s_]++; } }
      }
      if (f){ inc(s_, f); objs.push({sec, side: s_, type: f, who}); }
    } else if (ty === "DRAGON_SOUL_GIVEN"){
      if (e.teamId === 100 || e.teamId === 200){ const s_ = e.teamId === 100 ? 0 : 1; soul[s_] = 1; objs.push({sec, side: s_, type: "soul", who: []}); }
    } else if (ty === "ITEM_PURCHASED"){
      const s_ = pid2slot.get(e.participantId);
      if (s_ != null && LEG.has(e.itemId)){ legend[s_]++; if (!last.has(s_)) last.set(s_, []); last.get(s_).push(comps.length); comps.push({sec, slot: s_, item: e.itemId}); }
    } else if (ty === "ITEM_UNDO"){
      const s_ = pid2slot.get(e.participantId);
      if (s_ != null && LEG.has(e.beforeId)){
        legend[s_]--;
        const L = last.get(s_) || [];
        for (let q = L.length - 1; q >= 0; q--){ const c = comps[L[q]]; if (c.item === e.beforeId && c.slot >= 0){ c.slot = -1; break; } }
      }
    } else if (ty === "ITEM_SOLD"){
      const s_ = pid2slot.get(e.participantId);
      if (s_ != null && LEG.has(e.itemId)) legend[s_]--;
    }
  };
  const F = X.feats.filter(f => f !== "draft" && f !== "scaling");
  for (let mi = 0; mi <= T; mi++){
    const lim = mi * 60000;
    while (j < ev.length && ev[j].timestamp <= lim) handle(ev[j++], mi);
    const p = P[mi], x = {}, g = (sd, f) => cnt[sd][f] || 0, now = lim / 1000;
    for (let r = 0; r < 5; r++){ x["gold:" + ROLES[r]] = (p[r][0] - p[5 + r][0]) / 1000; x["xp:" + ROLES[r]] = (p[r][1] - p[5 + r][1]) / 1000; }
    let cs = 0; for (let s = 0; s < 10; s++) cs += (s < 5 ? 1 : -1) * p[s][3]; x.cs = cs / 100;
    for (const f of ["kills", "towerOuter", "towerInner", "towerBase", "towerNexus", "plates", "inhib", "grubs", "herald", "baron", "elder", ...DRAGONS.map(d => "drag" + d.charAt(0) + d.slice(1).toLowerCase())])
      x[f] = g(0, f) - g(1, f);
    let dead = 0; for (let s = 0; s < 10; s++) if (deadUntil[s] > now) dead += s < 5 ? -1 : 1;
    x.alive = dead;
    x.inhibDown = inhibDown[0].filter(t => t > now).length - inhibDown[1].filter(t => t > now).length;
    const noSoul = !soul[0] && !soul[1];
    x.soulPoint = (drakes[0] >= 3 && noSoul ? 1 : 0) - (drakes[1] >= 3 && noSoul ? 1 : 0);
    x.soul = soul[0] - soul[1];
    x.elderActive = (elderUntil[0] > now ? 1 : 0) - (elderUntil[1] > now ? 1 : 0);
    x.baronActive = (baronUntil[0] > now ? 1 : 0) - (baronUntil[1] > now ? 1 : 0);
    let lg = 0; for (let s = 0; s < 10; s++) lg += (s < 5 ? 1 : -1) * legend[s]; x.legend = lg;
    states.push(F.map(f => x[f] || 0));
  }
  for (; j < ev.length; j++) handle(ev[j], null);
  const ok = bySlot.every((p, s) => p && kc[s] === p.kills && dc[s] === p.deaths);
  return {T, P, states, F, deaths, objs, comps: comps.filter(c => c.slot >= 0), bySlot, pid2slot, slotOfIdx, guessed, killCheck: ok};
}

/* ---------------- one game ---------------- */
function analyze(X, match, tl){
  const M = X.M, info = match.info, W = M.wp;
  const E = extract(X, match, tl);
  if (!E) return null;
  const {T, P, states, F, bySlot} = E;
  const champ = s => FIX[bySlot[s].championName] || bySlot[s].championName;
  const cidx = s => X.idx.has(champ(s)) ? X.idx.get(champ(s)) : -1;
  const B = [0, 1, 2, 3, 4].map(cidx), R = [5, 6, 7, 8, 9].map(cidx);
  const draft = draftLogit(X, B, R), dz = draftTerms(X, B, R), db0 = M.draft.b0;
  const sc = W.scaling, scaling = [0, 1, 2, 3, 4].reduce((t, s) => t + (sc[champ(s)] || 0) - (sc[champ(s + 5)] || 0), 0);
  const fi = new Map(F.map((f, i) => [f, i]));
  const logitAt = m => {
    const c = W.t[Math.min(m, W.maxMinute)], x = states[m];
    let z = c[0];
    W.feats.forEach((f, k) => { z += c[k + 1] * (f === "draft" ? draft : f === "scaling" ? scaling : x[fi.get(f)]); });
    return z;
  };
  const lg = [NaN], pw = [sig(db0 + dz.reduce((a, b) => a + b, 0))];   // index 0: the draft WP (blue)
  for (let m = 1; m <= T; m++){ const z = logitAt(m); lg.push(z); pw.push(sig(z)); }
  const blueWon = !!(bySlot[0] && bySlot[0].win);
  const res = s => (s < 5) === blueWon ? 1 : 0;
  // ---- WPA (site definition), all ten players
  const LE = W.laneEnd, wpa = new Array(10).fill(null);
  if (T >= LE){
    const c = W.t[LE], w = {}; W.feats.forEach((f, k) => { w[f] = c[k + 1]; });
    const kill14 = new Array(10).fill(0), leg14 = new Array(10).fill(0);
    for (const d of E.deaths) if (d.sec <= LE * 60 && d.k >= 0) kill14[d.k]++;
    for (const q of E.comps) if (q.sec <= LE * 60) leg14[q.slot]++;
    const x14 = states[LE], P14 = P[LE], zb = [];
    for (let r = 0; r < 5; r++)
      zb.push(w["gold:" + ROLES[r]] * x14[fi.get("gold:" + ROLES[r])] + w["xp:" + ROLES[r]] * x14[fi.get("xp:" + ROLES[r])]
        + w.kills * (kill14[r] - kill14[5 + r]) + w.cs * (P14[r][3] - P14[5 + r][3]) / 100 + w.legend * (leg14[r] - leg14[5 + r]));
    const l14 = lg[LE], bb = l14 - zb.reduce((a, b) => a + b, 0), prior = W.prior;
    for (const s of [1, -1]){
      const wp0 = sig(s * prior), drf = shapley(s * db0, dz.map(v => s * v), wp0);
      const wpd = sig(s * (db0 + dz.reduce((a, b) => a + b, 0)));
      const lane = shapley(s * bb, zb.map(v => s * v), wpd), wp14 = sig(s * l14);
      for (let r = 0; r < 5; r++){
        const slot = s > 0 ? r : 5 + r, team = (res(slot) - wp14) / 5;
        wpa[slot] = {draft: 100 * drf[r], lane: 100 * lane[r], team: 100 * team, total: 100 * (drf[r] + lane[r] + team)};
      }
    }
  }
  // ---- deaths: WP lost (the site's wpLost), untraded
  const teamS = s => s < 5 ? 1 : -1;
  const dmin = d => Math.floor(d.sec / 60), okMin = m => m >= 1 && m + 1 <= T;
  const change = (s, m) => teamS(s) * (pw[m + 1] - pw[m]);          // the team's WP change over minute m
  const teamDeaths = new Map();
  for (const d of E.deaths) if (okMin(dmin(d))){ const k = dmin(d) + ":" + (d.v < 5); teamDeaths.set(k, (teamDeaths.get(k) || 0) + 1); }
  const order = E.deaths.map((d, i) => i).filter(i => !E.deaths[i].end).sort((a, b) => E.deaths[a].sec - E.deaths[b].sec || a - b);
  const traded = new Array(E.deaths.length).fill(false);
  order.forEach((i, a) => { for (const b of [a - 1, a + 1, a - 2, a + 2, a - 3, a + 3]) if (b >= 0 && b < order.length){
    const J = E.deaths[order[b]], I = E.deaths[i]; if (Math.abs(J.sec - I.sec) <= 15 && (J.v < 5) !== (I.v < 5)){ traded[i] = true; break; } } });
  E.deaths.forEach((d, i) => { if (d.end) traded[i] = E.deaths.some(J => Math.abs(J.sec - d.sec) <= 15 && (J.v < 5) !== (d.v < 5)); });
  const deaths = E.deaths.map((d, i) => {
    const m = dmin(d), ok = okMin(m), raw = ok ? change(d.v, m) : null;
    const lost = ok ? Math.max(0, -raw) / Math.max(1, teamDeaths.get(m + ":" + (d.v < 5)) || 1) : 0;
    return {sec: d.sec, slot: d.v, killer: d.k, assists: d.assists, lost: 100 * lost, swing: raw == null ? null : 100 * raw, traded: traded[i], lane: d.sec < LE * 60};
  });
  // ---- plays: gains in minutes the team gained, shared among its kills + objectives, then among their participants
  const gains = new Array(10).fill(0), plays = [];
  const posByMin = new Map();
  const addPos = (m, sd, who, what, sec) => { if (!okMin(m)) return; const k = m + ":" + sd; if (!posByMin.has(k)) posByMin.set(k, []); posByMin.get(k).push({who, what, sec}); };
  for (const d of E.deaths) addPos(dmin(d), d.v < 5 ? 1 : 0, [d.k, ...d.assists].filter(s => s >= 0 && (s < 5) !== (d.v < 5)), {kind: "kill", victim: d.v, killer: d.k}, d.sec);
  for (const o of E.objs) addPos(Math.floor(o.sec / 60), o.side, o.who, {kind: "objective", type: o.type}, o.sec);
  for (const [k, list] of posByMin){
    const [m, sd] = k.split(":").map(Number), gain = sd === 0 ? pw[m + 1] - pw[m] : pw[m] - pw[m + 1];
    const each = gain > 0 ? gain / list.length : 0;
    for (const e of list){
      const who = [...new Set(e.who)], per = who.length ? each / who.length : 0;
      for (const s of who) gains[s] += per;
      plays.push({sec: e.sec, side: sd, who, ...e.what, credit: 100 * per, swing: 100 * gain});
    }
  }
  plays.sort((a, b) => a.sec - b.sec);
  // ---- lane: diffs at 10 and 15 vs the same position; expected gold diffs of the matchup
  const lane = new Array(10).fill(null), fr = tl.info.frames;
  const at = (m, s) => { const f = fr[m]; if (!f) return null; for (const [pid, v] of Object.entries(f.participantFrames || {})) if (E.pid2slot.get(+pid) === s) return v; return null; };
  for (let s = 0; s < 10; s++){
    const o = s < 5 ? s + 5 : s - 5, out = {opp: o};
    for (const m of [10, 15]){
      const a = at(m, s), b = at(m, o);
      out["m" + m] = a && b ? {gold: a.totalGold - b.totalGold, xp: a.xp - b.xp, cs: (a.minionsKilled + a.jungleMinionsKilled) - (b.minionsKilled + b.jungleMinionsKilled)} : null;
    }
    const r = s % 5, A = cidx(s), Bc = cidx(o), sd = s < 5 ? 1 : -1;
    out.expected = {};
    X.lt.stats.forEach((st, j) => {
      if (A < 0 || Bc < 0){ out.expected[st] = null; return; }
      const ua = X.lt.u[r][j].get(A), ub = X.lt.u[r][j].get(Bc);
      let m = 0, games = 0;
      if (A !== Bc){ const e = X.lt.pairs[r].get(Math.min(A, Bc) * X.n + Math.max(A, Bc)); if (e){ m = (A < Bc ? 1 : -1) * e[3 + 2 * j]; games = e[0]; } }
      const v = A === Bc ? sd * X.lt.c0[r][j] : sd * X.lt.c0[r][j] + (ua ? ua[0] : 0) - (ub ? ub[0] : 0) + m;
      out.expected[st] = {value: v, pairGames: games, sd: X.lt.sd ? X.lt.sd[r][j] : null};
    });
    lane[s] = out;
  }
  // ---- item WPA per completion (the site's itemWpa rule) and the build explorer's values
  const DR = M.drift, H = DR.h;
  const build = new Array(10).fill(null).map(() => []);
  for (const q of E.comps){
    const m0 = Math.floor(q.sec / 60), s = teamS(q.slot);
    let game = null;
    if (m0 >= 1 && m0 + H <= T){
      const d = s * (pw[m0 + H] - pw[m0]), pt = s > 0 ? pw[m0] : 1 - pw[m0];
      game = 100 * (d - DR.t[Math.min(m0, W.maxMinute)][Math.min(Math.floor(pt * 10), 9)]);
    }
    const key = champ(q.slot) + "|" + (q.slot % 5), cell = (M.items[key] || {})[String(q.item)];
    build[q.slot].push({item: q.item, min: q.sec / 60, game, typical: cell ? {n: cell[0], mean: cell[1], sd: cell[2]} : null});
  }
  // ---- runes
  const runes = bySlot.map((p, s) => {
    const st = {}; for (const x of (p.perks && p.perks.styles) || []) st[x.description] = x;
    const pri = st.primaryStyle, sub = st.subStyle, key = pri && pri.selections && pri.selections[0] ? pri.selections[0].perk : null;
    const R = M.runes[champ(s) + "|" + (s % 5)], k = R && key != null ? R.keys[String(key)] : null;
    return {keystone: key, primary: pri ? pri.style : null, secondary: sub ? sub.style : null,
      perks: [...(pri ? pri.selections.map(x => x.perk) : []), ...(sub ? sub.selections.map(x => x.perk) : [])],
      wpa: k && R.base ? {n: k[0], vsAvg: k[1] - R.base[1], lane: k[3] - R.base[2]} : null};
  });
  return {T, pw, lg, draft, dz, db0, scaling, blueWon, wpa, deaths, plays, gains: gains.map(g => 100 * g), lane, build, runes,
    killCheck: E.killCheck, guessed: E.guessed, bySlot, slotOfIdx: E.slotOfIdx, champ: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(champ), objs: E.objs, comps: E.comps};
}

/* ---------------- per-player views ---------------- */
function slotOfPuuid(match, puuid){
  const i = match.info.participants.findIndex(p => p.puuid === puuid);
  return i;
}
const remake = match => match.info.gameDuration < 300 || match.info.participants.some(p => p.gameEndedInEarlySurrender);

// the match card (no timeline needed) + the analysis summary for the player, when A (analyze()) is given
function card(X, match, puuid, A){
  const info = match.info, i = slotOfPuuid(match, puuid);
  if (i < 0) return null;
  const p = info.participants[i], min = info.gameDuration / 60, champ = FIX[p.championName] || p.championName;
  const st = {}; for (const x of (p.perks && p.perks.styles) || []) st[x.description] = x;
  const out = {id: match.metadata.matchId, queue: info.queueId, end: info.gameEndTimestamp || info.gameStartTimestamp + info.gameDuration * 1000,
    duration: info.gameDuration, remake: remake(match), win: !!p.win, champ, role: null, side: p.teamId === 100 ? "blue" : "red",
    k: p.kills, d: p.deaths, a: p.assists, cs: p.totalMinionsKilled + p.neutralMinionsKilled, cspm: r2((p.totalMinionsKilled + p.neutralMinionsKilled) / min),
    level: p.champLevel, items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6], spells: [p.summoner1Id, p.summoner2Id],
    keystone: st.primaryStyle && st.primaryStyle.selections && st.primaryStyle.selections[0] ? st.primaryStyle.selections[0].perk : null,
    secondary: st.subStyle ? st.subStyle.style : null};
  if (A){
    const s = A.slotOfIdx[i]; out.role = ROLES[s % 5]; out.slot = s;
    const w = A.wpa[s], lostT = A.deaths.filter(d => d.slot === s).reduce((t, d) => t + d.lost, 0);
    out.wpa = w ? r2(w.total) : null;
    out.plays = r2(A.gains[s] - lostT);
    out.wpLost = r2(lostT);
    const L = A.lane[s], e15 = L.expected.gd15;
    out.gd15 = L.m15 ? L.m15.gold : null;
    out.gd15vs = L.m15 && e15 ? Math.round(L.m15.gold - e15.value) : null;
  } else { const r = ROLE_OF[p.teamPosition]; out.role = r != null ? ROLES[r] : null; }
  return out;
}

// the detail panel for the player
function detail(X, match, puuid, A){
  const c = card(X, match, puuid, A);
  if (!c || !A) return c;
  const s = c.slot, o = s < 5 ? s + 5 : s - 5, blue = s < 5, M = X.M;
  const team = p => blue ? p : 1 - p;
  const names = M.names;
  const involved = e => e.who && e.who.includes(s);
  const events = [];
  for (const d of A.deaths){
    if (d.slot === s) events.push({t: r1(d.sec / 60), kind: "death", by: d.killer >= 0 ? A.champ[d.killer] : null, lost: r2(d.lost), swing: r2(d.swing == null ? null : d.swing), traded: d.traded});
  }
  for (const e of A.plays) if (involved(e)){
    if (e.kind === "kill") events.push({t: r1(e.sec / 60), kind: e.killer === s ? "kill" : "assist", victim: A.champ[e.victim], credit: r2(e.credit), swing: r2(e.swing)});
    else events.push({t: r1(e.sec / 60), kind: "objective", type: e.type, label: OBJ_LABEL[e.type] || e.type, credit: r2(e.credit), swing: r2(e.swing)});
  }
  events.sort((a, b) => a.t - b.t);
  const typ = (k, r) => { const cr = M.typical.champRole[k][c.champ + "|" + r], ro = M.typical.role[k][r]; return {champ: cr ? cr[1] : null, role: ro ? ro[1] : null}; };
  const r = s % 5, L = A.lane[s];
  const opp = A.bySlot[o];
  return {...c,
    curve: A.pw.map((p, m) => [m, r2(100 * team(p))]),
    result: A.blueWon === blue ? 1 : 0,
    wpaParts: A.wpa[s] ? {draft: r2(A.wpa[s].draft), lane: r2(A.wpa[s].lane), team: r2(A.wpa[s].team), total: r2(A.wpa[s].total)} : null,
    typical: {wpa: typ("wpa", r), wpLost: typ("wpLost", r), wpLostLane: typ("wpLostLane", r), cspm: typ("cspm", r)},
    events,
    deaths: A.deaths.filter(d => d.slot === s).map(d => ({t: r1(d.sec / 60), by: d.killer >= 0 ? A.champ[d.killer] : null, lost: r2(d.lost), traded: d.traded, lane: d.lane})),
    lane: {opp: opp ? {champ: A.champ[o]} : null, m10: L.m10, m15: L.m15,
      expected: {gd10: L.expected.gd10 ? Math.round(L.expected.gd10.value) : null, gd15: L.expected.gd15 ? Math.round(L.expected.gd15.value) : null,
        pairGames: L.expected.gd15 ? L.expected.gd15.pairGames : 0}},
    build: A.build[s].map(b => ({item: b.item, name: names.items[String(b.item)] || null, min: r1(b.min), game: r2(b.game),
      typical: b.typical ? {n: b.typical.n, mean: r2(b.typical.mean), lo: r2(b.typical.mean - 1.96 * b.typical.sd / Math.sqrt(b.typical.n)), hi: r2(b.typical.mean + 1.96 * b.typical.sd / Math.sqrt(b.typical.n))} : null})),
    runes: {...A.runes[s], wpa: A.runes[s].wpa ? {n: A.runes[s].wpa.n, vsAvg: r2(A.runes[s].wpa.vsAvg), lane: r2(A.runes[s].wpa.lane)} : null},
    team: [0, 1, 2, 3, 4].map(q => { const t = blue ? q : 5 + q, e = blue ? 5 + q : q, pt = A.bySlot[t], pe = A.bySlot[e];
      return [{champ: A.champ[t], k: pt.kills, d: pt.deaths, a: pt.assists, me: t === s}, {champ: A.champ[e], k: pe.kills, d: pe.deaths, a: pe.assists}]; }),
    checks: {kills: A.killCheck, rolesGuessed: A.guessed}};
}

/* ---------------- the profile summary over the analysed games + focus areas ---------------- */
function summary(X, rows){
  // rows: [{card, A}] (A may be null: no timeline / remake)
  const M = X.M, games = rows.filter(x => x.card && !x.card.remake);
  const champs = new Map(), roles = [0, 0, 0, 0, 0];
  for (const {card: c} of games){
    const e = champs.get(c.champ) || {champ: c.champ, games: 0, wins: 0, k: 0, d: 0, a: 0, cs: 0, min: 0, wpa: 0, nWpa: 0};
    e.games++; e.wins += c.win ? 1 : 0; e.k += c.k; e.d += c.d; e.a += c.a; e.cs += c.cs; e.min += c.duration / 60;
    if (c.wpa != null){ e.wpa += c.wpa; e.nWpa++; }
    champs.set(c.champ, e);
    if (c.role) roles[ROLES.indexOf(c.role)]++;
  }
  const champRows = [...champs.values()].sort((a, b) => b.games - a.games || a.champ.localeCompare(b.champ)).map(e => ({
    champ: e.champ, games: e.games, wins: e.wins, losses: e.games - e.wins, k: r1(e.k / e.games), d: r1(e.d / e.games), a: r1(e.a / e.games),
    kda: r2((e.k + e.a) / Math.max(1, e.d)), cspm: r2(e.cs / e.min), wpa: e.nWpa ? r2(e.wpa / e.nWpa) : null}));
  // per-game metrics vs typical for the champion + role (the role's pooled value when the champion has too few games)
  const typ = (k, champ, r) => { const cr = M.typical.champRole[k][champ + "|" + r]; return cr && cr[0] >= 30 ? cr : M.typical.role[k][r]; };
  const acc = {wpa: [], wpLost: [], wpLostLane: [], wpLostLate: [], untraded: [], cspm: [], gd15: []};
  for (const {card: c, A} of games){
    if (!A || c.slot == null) continue;
    const r = c.slot % 5, s = c.slot, my = A.deaths.filter(d => d.slot === s);
    const lost = my.reduce((t, d) => t + d.lost, 0), lostLane = my.filter(d => d.lane).reduce((t, d) => t + d.lost, 0);
    const push = (k, x, t) => { if (x != null && t) acc[k].push([x, t[1], t[2]]); };
    push("wpa", c.wpa, typ("wpa", c.champ, r));
    push("wpLost", lost, typ("wpLost", c.champ, r));
    push("wpLostLane", lostLane, typ("wpLostLane", c.champ, r));
    const tl = typ("wpLost", c.champ, r), tll = typ("wpLostLane", c.champ, r);
    if (tl && tll) acc.wpLostLate.push([lost - lostLane, tl[1] - tll[1], Math.sqrt(Math.max(1, tl[2] ** 2 - tll[2] ** 2))]);
    push("untraded", my.filter(d => !d.traded).length, typ("untraded", c.champ, r));
    if (r !== 4) push("cspm", c.cspm, typ("cspm", c.champ, r));
    const L = A.lane[s];
    if (L.m15 && L.expected.gd15) acc.gd15.push([L.m15.gold, L.expected.gd15.value, L.expected.gd15.sd || 1500]);
  }
  const stat = k => { const a = acc[k]; if (!a.length) return null; const n = a.length, you = a.reduce((t, x) => t + x[0], 0) / n,
    typical = a.reduce((t, x) => t + x[1], 0) / n, se = Math.sqrt(a.reduce((t, x) => t + x[2] ** 2, 0)) / n;
    return {n, you: r2(you), typical: r2(typical), z: se > 0 ? (you - typical) / se : 0}; };
  const S = {}; for (const k of Object.keys(acc)) S[k] = stat(k);
  const focus = focusAreas(S);
  const wins = games.filter(x => x.card.win).length;
  return {games: games.length, wins, losses: games.length - wins, champs: champRows, roles: ROLES.map((r, i) => ({role: r, games: roles[i]})), stats: S, focus};
}

const MIN_FOCUS_GAMES = 5, FOCUS_Z = 1;
/* the one or two biggest win-chance leaks vs typical, phrased as what to work on (self-improvement: no rankings, no labels) */
function focusAreas(S){
  const pct = x => `${(Math.round(x * 10) / 10).toFixed(1)}%`, g = x => `${Math.round(Math.abs(x))}`;
  const cand = [];
  const add = (k, cost, text, area, tip) => { const s = S[k]; if (s && s.n >= MIN_FOCUS_GAMES && cost(s) >= FOCUS_Z) cand.push({key: k, score: cost(s), area, text: text(s), tip, n: s.n}); };
  add("wpLostLane", s => s.z, s => `Deaths before 14:00 cost you ${pct(s.you)} win chance per game (typical for your picks: ${pct(s.typical)}).`, "Early risk",
    "Win probability your team dropped in the minutes you died before 14:00, shared among that minute's deaths");
  add("wpLostLate", s => s.z, s => `Deaths after 14:00 cost you ${pct(s.you)} win chance per game (typical for your picks: ${pct(s.typical)}).`, "Mid-game positioning",
    "The same measure for deaths from 14:00 on");
  add("gd15", s => -s.z, s => `Gold at 15:00 averages ${g(s.typical - s.you)} below what your lane matchups usually give (you ${s.you >= 0 ? "+" : "−"}${g(s.you)}, matchups ${s.typical >= 0 ? "+" : "−"}${g(s.typical)}).`, "Lane economy",
    "Gold vs the same-position opponent at 15:00 against the expected value of that champion matchup in ranked solo games");
  add("cspm", s => -s.z, s => `CS ${s.you.toFixed(1)} per minute vs ${s.typical.toFixed(1)} typical for your picks.`, "Farming",
    "Minions + monsters per minute vs the same champions in the same role");
  add("untraded", s => s.z, s => `${s.you.toFixed(1)} deaths per game without a trade (typical for your picks: ${s.typical.toFixed(1)}).`, "Trading deaths",
    "Deaths where no enemy died within 15 seconds");
  cand.sort((a, b) => b.score - a.score);
  // the two death measures overlap: keep one of them
  const out = [];
  for (const c of cand){ if (out.length >= 2) break; if (c.key.startsWith("wpLost") && out.some(o => o.key.startsWith("wpLost"))) continue; out.push(c); }
  return out.map(c => ({key: c.key, area: c.area, text: `${c.text} Focus: ${c.area.toLowerCase()}.`, tip: c.tip, games: c.n}));
}

module.exports = {prepare, analyze, card, detail, summary, focusAreas, draftLogit, draftTerms, extract, slotsOf, remake, deathTimer, ROLES};
