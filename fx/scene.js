/* Rift Logic background scene: the ONE place the background's drawing code lives (src/theme_fx.py inlines it into every page).
 * Fog of War v2 (approved 2026-09-27): a tiny seeded "match" (lane waves, towers, camps, a jungler, wards, pings, recalls,
 * objective pulses) feeds small uniform arrays to one fragment shader, web/fx/rift-fog.glsl. No mouse effects.
 *
 * Contract: this file is one JS expression evaluating to  {create(gl, host), fallback(light)}.
 *   create  called once with a WebGL1 context on <canvas id="fx"> (alpha:false, no depth/stencil/antialias, low-power) and
 *           host = {section: "code"|"docs"|"draft"|"champions"|"pro", sec: 0-3 (docs = 0), FRAG: the fragment shader};
 *           returns {render(s)} (optionally resize(W, H), dispose()); throw to fall back.
 *   render  s = {t, dt, W, H, ratio, light, mx, my, ms, sec, section, evalP}: t, dt in s (dt 0 = a still frame); W, H canvas
 *           px; light 0-1 (eased); mx/my/ms pointer (always 0: no mouse effects); evalP the draft eval bar's blue win
 *           probability 0-1 (eased), -1 on pages without one.
 *   fallback(light)  no WebGL: a static 2D render into its own fixed canvas (#fx2d); called again on resize / theme change.
 * The host owns everything else: the loop, pause (user toggle, hidden tab, reduced motion = one still frame, typing),
 * adaptive resolution, the DPR cap and context loss. */
(() => {
  // ---------- shared map geometry (shader, sim, 2D fallback) ----------
  const BB = [-.8, -.8], RB = [.8, .8], BARON = [-.3, .4], DRAG = [.32, -.36];
  const mixv = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lanePos = (l, s) => {
    if (l === 0) return s < .5 ? mixv([-.82, -.6], [-.82, .82], s * 2) : mixv([-.82, .82], [.6, .82], s * 2 - 1);
    if (l === 1) return mixv([-.6, -.6], [.6, .6], s);
    return s < .5 ? mixv([-.6, -.82], [.82, -.82], s * 2) : mixv([.82, -.82], [.82, .6], s * 2 - 1);
  };
  const LANE_LEN = [2.84, 1.7, 2.84];
  const TOWER_S = [.13, .27, .73, .87];             // 2 blue, 2 red per lane
  const TOWERS = [];
  for (let l = 0; l < 3; l++) TOWER_S.forEach((s, i) => TOWERS.push({p: lanePos(l, s), side: i < 2 ? 0 : 1, l, ring: 0, cd: 0}));
  const CAMPS = [[-.42, -.05], [-.6, .2], [-.05, -.5], [.2, -.6], [.42, .05], [.6, -.2], [.05, .5], [-.2, .6]]
    .map((p, i) => ({p, side: i < 4 ? 0 : 1, alive: 1, pulse: 0, respawn: 0}));
  // jungler route (blue side); "c" = camp index to clear on arrival
  const ROUTE = [[-.58, -.46], {c: 0}, {c: 1}, [-.3, .2], [-.36, -.12], [-.22, -.3], {c: 2}, {c: 3}, [.26, -.3], [.02, -.34], [-.4, -.62]]
    .map(w => w.c !== undefined ? {p: CAMPS[w.c].p, c: w.c} : {p: w});
  const WARD_SPOTS = [[-.28, .22], [.2, -.24], [-.52, .48], [.5, -.5], [-.1, .1], [.1, -.08], [-.48, .1], [.14, -.46], [.26, .2], [-.24, -.3], [.62, .28], [-.62, -.3]];
  const EWARD_SPOTS = [[.08, .18], [.36, .22], [-.14, .32], [.22, -.06], [.5, -.12]];
  const PING_SPOTS = () => [DRAG, BARON, [-.2, .2], [.18, -.2], [0, 0], lanePos(0, S.front[0]), lanePos(2, S.front[2]), lanePos(1, S.front[1])];
  const DRAKES = [[1, .42, .14], [.16, .72, .86], [.78, .56, .3], [.72, .82, .96], [.32, .82, 1], [.5, .92, .22]];

  // ---------- seeded sim ----------
  let seed = 7;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const S = {
    t: 0, front: [.5, .5, .5], fade: [0, 0, 0], minions: new Float32Array(36),
    wards: [0, 1, 2, 3].map(i => ({p: WARD_SPOTS[i * 3], age: rr(0, 30), life: rr(40, 60)})),
    ew: {p: EWARD_SPOTS[0], next: 30},
    champ: {i: 0, p: ROUTE[0].p.slice(), wait: 0},
    pings: [0, 1, 2].map(() => ({p: [0, 0], age: 9, type: 0})),
    recall: {p: [0, 0], age: 9}, shot: {a: [0, 0], b: [0, 0], age: 9, side: 0},
    drag: [1, .42, .14], dPulse: 9, bPulse: 9,
    next: {ping: 4, recall: 22, obj: 14, camp: 18}, notable: [], lastN: -9
  };
  const busy = () => { S.notable = S.notable.filter(e => e > S.t); return S.notable.length >= 2 || S.t - S.lastN < 2.2; };
  const claim = dur => { S.notable.push(S.t + dur); S.lastN = S.t; };

  function step(dt) {
    const t = (S.t += dt);
    // lane waves: each lane pushes one way over a cycle, then the wave dies and resets
    for (let l = 0; l < 3; l++) {
      const per = 58 + l * 11, c = (t + l * 23) / per, u = c - Math.floor(c);
      const dir = ((Math.floor(c) + l) & 1) ? 1 : -1;
      S.front[l] = .5 + dir * .2 * sstep(.04, .9, u);
      S.fade[l] = sstep(0, .05, u) * (1 - sstep(.93, 1, u));
      const ds = .032 / LANE_LEN[l];
      for (let k = 0; k < 3; k++) {
        const j = Math.sin(t * 3.1 + k * 2.3 + l) * ds * .25;
        const b = lanePos(l, S.front[l] - ds * (k + .55) + j), r = lanePos(l, S.front[l] + ds * (k + .55) - j);
        const o = (l * 3 + k) * 4;
        S.minions[o] = b[0]; S.minions[o + 1] = b[1]; S.minions[o + 2] = r[0]; S.minions[o + 3] = r[1];
      }
    }
    // towers: range ring when the wave front is inside range; occasional shots at the nearest enemy minion
    for (const tw of TOWERS) {
      const fp = lanePos(tw.l, S.front[tw.l]);
      const near = S.fade[tw.l] > .5 && dist(fp, tw.p) < .17 ? 1 : 0;
      tw.ring += (near - tw.ring) * (1 - Math.exp(-dt / .6));
      tw.cd -= dt;
      if (tw.ring > .7 && tw.cd <= 0 && S.shot.age > 1.4) {
        const o = tw.l * 12 + (tw.side ? 0 : 2);          // enemy's front minion
        S.shot = {a: tw.p, b: [S.minions[o], S.minions[o + 1]], age: 0, side: tw.side};
        tw.cd = rr(2.2, 3.4);
      }
    }
    S.shot.age += dt / .55;
    // jungler
    const ch = S.champ;
    if (ch.wait > 0) { ch.wait -= dt; }
    else {
      const w = ROUTE[(ch.i + 1) % ROUTE.length], d = dist(ch.p, w.p), sp = .055 * dt;
      if (d <= sp) {
        ch.p = w.p.slice(); ch.i = (ch.i + 1) % ROUTE.length;
        if (w.c !== undefined && CAMPS[w.c].alive > .9) { ch.wait = 4.5; CAMPS[w.c].clearing = 1; }
      } else { ch.p[0] += (w.p[0] - ch.p[0]) / d * sp; ch.p[1] += (w.p[1] - ch.p[1]) / d * sp; }
    }
    // camps: clear (dim out), respawn later with a soft pulse
    for (const cp of CAMPS) {
      if (cp.clearing) { cp.alive -= dt / 3.5; if (cp.alive <= 0) { cp.alive = 0; cp.clearing = 0; cp.respawn = rr(38, 55); } }
      else if (cp.alive < 1 && cp.respawn > 0) { cp.respawn -= dt; if (cp.respawn <= 0) { cp.alive = 1; cp.pulse = 1e-3; } }
      if (cp.pulse > 0) { cp.pulse += dt / 1.8; if (cp.pulse >= 1) cp.pulse = 0; }
    }
    if (t > S.next.camp) {                                // the unseen enemy jungler clears too
      const red = CAMPS.filter(c => c.side && c.alive === 1 && !c.clearing);
      if (red.length) red[Math.floor(rnd() * red.length)].clearing = 1;
      S.next.camp = t + rr(20, 32);
    }
    // wards expire and get replaced elsewhere
    for (const w of S.wards) {
      w.age += dt;
      if (w.age > w.life) {
        const used = S.wards.map(x => x.p), free = WARD_SPOTS.filter(p => !used.includes(p));
        w.p = free[Math.floor(rnd() * free.length)]; w.age = 0; w.life = rr(40, 65);
      }
    }
    if (t > S.ew.next) { S.ew.p = EWARD_SPOTS[Math.floor(rnd() * EWARD_SPOTS.length)]; S.ew.next = t + rr(40, 60); }
    // dragon element hue: slow crossfade every 40s
    const dc = t / 40, di = Math.floor(dc), dk = sstep(.8, 1, dc - di);
    const A = DRAKES[di % 6], B = DRAKES[(di + 1) % 6];
    for (let i = 0; i < 3; i++) S.drag[i] = A[i] + (B[i] - A[i]) * dk;
    // notable events (scheduled, at most two at once)
    for (const pg of S.pings) pg.age += dt / 2.4;
    S.recall.age += dt / 5.5; S.dPulse += dt / 3; S.bPulse += dt / 3;
    if (t > S.next.ping) {
      if (busy()) S.next.ping = t + 1.2;
      else {
        const pg = S.pings.find(x => x.age >= 1);
        if (pg) {
          const sp = PING_SPOTS(), p = sp[Math.floor(rnd() * sp.length)];
          pg.p = [p[0] + rr(-.04, .04), p[1] + rr(-.04, .04)]; pg.age = 0;
          const r = rnd(); pg.type = r < .45 ? 0 : r < .8 ? 1 : 2; claim(2.4);
        }
        S.next.ping = t + rr(6, 11);
      }
    }
    if (t > S.next.recall) {
      if (busy()) S.next.recall = t + 1.5;
      else { const l = Math.floor(rnd() * 3); S.recall.p = lanePos(l, rr(.2, .3)); S.recall.p = [S.recall.p[0] + .05, S.recall.p[1] + .05 * (l === 0 ? -1 : 1)]; S.recall.age = 0; claim(5.5); S.next.recall = t + rr(32, 50); }
    }
    if (t > S.next.obj) {
      if (busy()) S.next.obj = t + 1.5;
      else { if (rnd() < .6) S.dPulse = 0; else S.bPulse = 0; claim(3); S.next.obj = t + rr(38, 58); }
    }
  }

  // ---------- 2D fallback (no WebGL): static cartographic render ----------
  function fallback2D(light) {
    let c2 = document.getElementById("fx2d");
    if (!c2) {
      c2 = document.createElement("canvas"); c2.id = "fx2d"; c2.setAttribute("aria-hidden", "true");
      c2.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block;z-index:-1;pointer-events:none";
      const cv0 = document.getElementById("fx"); cv0.parentNode.insertBefore(c2, cv0.nextSibling);
    }
    const w = c2.width = Math.round(innerWidth * Math.min(devicePixelRatio || 1, 1.5)), h = c2.height = Math.round(innerHeight * Math.min(devicePixelRatio || 1, 1.5));
    const g = c2.getContext("2d"); if (!g) return;
    const X = p => [w / 2 + p[0] / 1.14 * h * .95, h * .52 - p[1] / 1.615 * h * .95], U = h * .95 / 1.4;
    const P = light
      ? {bg: "#E9E3D3", lane: "#D2C6AC", riv: "#C4D5D8", ink: "rgba(92,76,52,.35)", fog: "rgba(240,242,244,.72)", blue: "#2F6FD0", red: "#C4453A", gold: "#A87A12"}
      : {bg: "#0A1310", lane: "#1B1812", riv: "#0B1A22", ink: "rgba(79,216,210,.18)", fog: "rgba(4,6,9,.72)", blue: "#5B93E8", red: "#E26B5F", gold: "#F4D796"};
    g.fillStyle = P.bg; g.fillRect(0, 0, w, h);
    g.lineCap = "round"; g.lineJoin = "round";
    const path = (pts, lw, col) => { g.beginPath(); pts.forEach((p, i) => { const q = X(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.lineWidth = lw * U; g.strokeStyle = col; g.stroke(); };
    path([[-.85, .85], [.85, -.85]], .15, P.riv);
    [[[-.82, -.6], [-.82, .82], [.6, .82]], [[-.6, -.6], [.6, .6]], [[-.6, -.82], [.82, -.82], [.82, .6]]].forEach(l => path(l, .08, P.lane));
    [[[-.82, -.6], [-.82, .82], [.6, .82]], [[-.6, -.6], [.6, .6]], [[-.6, -.82], [.82, -.82], [.82, .6]]].forEach(l => path(l, .004, P.ink));
    const glow = (p, r, col, a) => { const q = X(p), gr = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], r * U); gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)"); g.globalAlpha = a; g.fillStyle = gr; g.fillRect(q[0] - r * U, q[1] - r * U, 2 * r * U, 2 * r * U); g.globalAlpha = 1; };
    glow(BARON, .12, "#8A4FD8", .5); glow(DRAG, .12, "#E8742A", .5);
    // fog layer with vision holes
    const f = document.createElement("canvas"); f.width = w; f.height = h; const fg = f.getContext("2d");
    fg.fillStyle = P.fog; fg.fillRect(0, 0, w, h); fg.globalCompositeOperation = "destination-out";
    const hole = (p, r) => { const q = X(p), gr = fg.createRadialGradient(q[0], q[1], r * U * .6, q[0], q[1], r * U); gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(1, "rgba(0,0,0,0)"); fg.fillStyle = gr; fg.beginPath(); fg.arc(q[0], q[1], r * U, 0, 7); fg.fill(); };
    hole(BB, .36); TOWERS.filter(t => !t.side).forEach(t => hole(t.p, .16)); [WARD_SPOTS[0], WARD_SPOTS[1], WARD_SPOTS[6]].forEach(p => hole(p, .13)); hole([-.36, -.12], .14);
    g.drawImage(f, 0, 0);
    const dot = (p, r, col, a) => { const q = X(p); g.globalAlpha = a; g.fillStyle = col; g.beginPath(); g.arc(q[0], q[1], r * U, 0, 7); g.fill(); g.globalAlpha = 1; };
    glow(BB, .2, P.blue, .5); glow(RB, .2, P.red, .35);
    TOWERS.forEach(t => dot(t.p, .012, t.side ? P.red : P.blue, t.side ? .45 : .9));
    [WARD_SPOTS[0], WARD_SPOTS[1], WARD_SPOTS[6]].forEach(p => { dot(p, .01, P.gold, .9); const q = X(p); g.strokeStyle = P.gold; g.globalAlpha = .25; g.lineWidth = 1; g.beginPath(); g.arc(q[0], q[1], .12 * U, 0, 7); g.stroke(); g.globalAlpha = 1; });
    dot([-.36, -.12], .014, P.blue, 1);
    CAMPS.forEach(c => dot(c.p, .01, P.gold, c.side ? .25 : .6));
  }

  // per-page camera framing (map units, added to the slow pan): code/docs centre, draft toward the blue base,
  // champions toward the bot side / dragon, pro toward baron
  const FRAME = [[0, 0], [-.1, -.08], [.07, -.06], [-.06, .08]];
  function create(gl, host) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, host.FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    ["uR", "uT", "uM", "uL", "uCam", "uTx", "uMin", "uFront", "uTw", "uCamp", "uPing", "uWard", "uEW", "uChamp", "uRecall", "uShot", "uSP", "uDrag", "uBar", "uE"]
      .forEach(n => U[n] = gl.getUniformLocation(prog, n) || gl.getUniformLocation(prog, n + "[0]"));
    const A = {front: new Float32Array(12), tw: new Float32Array(48), camp: new Float32Array(32), ping: new Float32Array(12), ward: new Float32Array(16)};
    const F = FRAME[host.sec] || FRAME[0];
    for (let i = 0; i < 400; i++) step(.1);             // warm up: waves in lane, wards placed, a camp or two cleared
    return {
      render(s) {
        if (s.dt > 0) step(Math.min(s.dt, .1));
        const t = S.t;
        gl.viewport(0, 0, s.W, s.H);
        // camera: slow pan + zoom breathing, plus the page's framing (no cursor tilt)
        gl.uniform4f(U.uCam, .035 * Math.sin(t * .041) + F[0], .025 * Math.sin(t * .029 + 1) + F[1], 1 - .035 * (.5 + .5 * Math.sin(t * .033)), 0);
        gl.uniform1f(U.uTx, 0);
        gl.uniform2f(U.uR, s.W, s.H); gl.uniform1f(U.uT, t % 1000);
        gl.uniform3f(U.uM, 0, 0, 0); gl.uniform1f(U.uL, s.light);
        gl.uniform1f(U.uE, s.evalP);
        gl.uniform4fv(U.uMin, S.minions);
        for (let l = 0; l < 3; l++) { const f = lanePos(l, S.front[l]); A.front.set([f[0], f[1], S.fade[l], 0], l * 4); }
        gl.uniform4fv(U.uFront, A.front);
        TOWERS.forEach((tw, i) => A.tw.set([tw.p[0], tw.p[1], tw.side, tw.ring], i * 4)); gl.uniform4fv(U.uTw, A.tw);
        CAMPS.forEach((c, i) => A.camp.set([c.p[0], c.p[1], clamp01(c.alive), c.pulse], i * 4)); gl.uniform4fv(U.uCamp, A.camp);
        S.pings.forEach((pg, i) => A.ping.set([pg.p[0], pg.p[1], Math.min(pg.age, 1), pg.type], i * 4)); gl.uniform4fv(U.uPing, A.ping);
        S.wards.forEach((w, i) => {
          const a = sstep(0, 1.2, w.age) * (1 - sstep(w.life - 3, w.life, w.age)), rad = .13 * (1 - .25 * sstep(w.life * .6, w.life, w.age));
          A.ward.set([w.p[0], w.p[1], a, rad], i * 4);
        });
        gl.uniform4fv(U.uWard, A.ward);
        gl.uniform3f(U.uEW, S.ew.p[0], S.ew.p[1], 1);
        gl.uniform3f(U.uChamp, S.champ.p[0], S.champ.p[1], 1);
        gl.uniform4f(U.uRecall, S.recall.p[0], S.recall.p[1], Math.min(S.recall.age, 1), 0);
        gl.uniform4f(U.uShot, S.shot.a[0], S.shot.a[1], S.shot.b[0], S.shot.b[1]);
        gl.uniform3f(U.uSP, Math.min(S.shot.age, 1), 1, S.shot.side);
        gl.uniform4f(U.uDrag, S.drag[0], S.drag[1], S.drag[2], Math.min(S.dPulse, 1));
        gl.uniform1f(U.uBar, Math.min(S.bPulse, 1));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    };
  }
  return {create, fallback: fallback2D};
})()
