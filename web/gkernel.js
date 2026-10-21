/* The guide kernel: from the bone sampled on the guide's local grid to the guide's distance field, its surface and
   the seating analysis. Plain arrays in, plain arrays out, no DOM and no three.js: the studio runs it in a Web Worker
   (gworker.js) so the page stays responsive while a guide is built, and in the page itself where a worker is not
   available (a page opened from a file, the unit tests). app.js buildGuide samples the bone and measures the drill
   paths, then hands everything else here. Grid: x = u along the bone, y = v across it, z = n the seating normal. */
'use strict';
var GKernel = (function () {
  // seat.js publishes Seat on the page's window, or on the worker's global scope
  const seatModule = () => (typeof self !== 'undefined' && self.Seat) || (typeof window !== 'undefined' && window.Seat) || null;
  // onProgress(f), optional: the share of the kernel done (0..1) at the end of each stage, by the stage times measured on
  // the anonymised real CT sample (distance 24 %, envelope 57 %, screws 74 %, field 79 %, surface and seating 100 %)
  function run(K, onProgress) {
    const t0 = performance.now(), T = {}, tick = f => { if (onProgress) onProgress(f); };
    const { h, lo, nx, ny, nz, B, soft, g, sUp, stopX, stopZ, vc, uc } = K, N = nx * ny * nz, nxy = nx * ny;
    // wrap depth at a position along the guide: the hand / global value, capped by the automatic per-position profile
    // (g.wrapU = [[uu, depth], ...]) where the bone's widest level is shallower towards an end of the guide
    const wrapOf = uu => { const pr = g.wrapU; if (!pr || !pr.length) return g.wrap; if (uu <= pr[0][0]) return Math.min(g.wrap, pr[0][1]); for (let a = 1; a < pr.length; a++) if (uu <= pr[a][0]) { const t = (uu - pr[a - 1][0]) / ((pr[a][0] - pr[a - 1][0]) || 1); return Math.min(g.wrap, pr[a - 1][1] + t * (pr[a][1] - pr[a - 1][1])); } return Math.min(g.wrap, pr[pr.length - 1][1]); };
    // solid = bone plus every void the outside cannot reach; d = signed distance to its surface (outside > 0), lightly smoothed
    // as the server does; the guide is the level set of a few such fields (shell band, box, slots, sleeves) combined with
    // min / max, so every plane in the design stays a plane and the mesh below can be marched on exact distances
    const O = G.exterior(B, nx, ny, nz), Bs = new Uint8Array(N); for (let i = 0; i < N; i++) Bs[i] = O[i] ? 0 : 1;
    const D = G.edt(Bs, nx, ny, nz); T.edt = performance.now() - t0; tick(0.24);
    const dist = new Float32Array(N); for (let i = 0; i < N; i++) dist[i] = Bs[i] ? -h / 2 : D[i] * h - h / 2;
    // within a voxel and a half of the surface the distance comes from the density itself, (0.5 - density) / |gradient|,
    // which places the surface to a fraction of a voxel instead of the voxel the node-to-node distance lands in
    if (soft) {
      const near = 1.5 * h, g2 = 1 / (2 * h), fade = 0.5 * h;
      for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const id = i + nx * (j + ny * k), de = dist[id]; if (de > near || (Bs[id] && soft[id] <= 0.5)) continue;
        const gx = (soft[id + 1] - soft[id - 1]) * g2, gy = (soft[id + nx] - soft[id - nx]) * g2, gz = (soft[id + nxy] - soft[id - nxy]) * g2, gm = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gm < 0.05) continue;
        const sd = Math.max(-near, Math.min(near, (0.5 - soft[id]) / gm)), wgt = de <= near - fade ? 1 : (near - de) / fade;
        dist[id] = de + wgt * (sd - de);
      }
    }
    const dd = G.blur(dist, nx, ny, nz);
    // periosteum allowance (soft tissue left on the bone) adds to the clearance
    const c = g.clear + (g.peri || 0), w = g.wall, cw = c + w;
    const colTopBone = new Float32Array(nx * ny).fill(-Infinity);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (Bs[i + nx * (j + ny * k)]) colTopBone[i + nx * j] = lo[2] + k * h;
    // the wrap depth follows the bone: on a curved jaw the bone drops away from the guide plane towards the guide
    // ends, so the depth limit is measured from the top of the bone at each position along the guide (never above
    // the plane through the anchor)
    const topU = new Float32Array(nx).fill(0);
    for (let i = 0; i < nx; i++) {
      let t = -Infinity;
      for (let j = 0; j < ny; j++) if (Math.abs(lo[1] + j * h - vc) <= g.W / 2) t = Math.max(t, colTopBone[i + nx * j]);
      topU[i] = t === -Infinity ? 0 : Math.min(0, t);
    }
    const win = Math.max(1, Math.round(1.5 / h)), wrapAt = new Float32Array(nx);
    for (let i = 0; i < nx; i++) { let m = 0; for (let a = Math.max(0, i - win); a <= Math.min(nx - 1, i + win); a++) m = Math.min(m, topU[a]); wrapAt[i] = m - wrapOf(lo[0] + i * h); }
    // ---- insertion direction and the seatable envelope ----
    // The guide is put on along one direction d (a cone of up to 40° around n). Along d the bone surface has a visible
    // part (nothing above it along d) and a hidden part under its own overhangs: tooth crowns over the alveolar bone,
    // the lower border curving in, the lingual side of a thin bone. The shell is built on the envelope = bone plus its
    // shadow along d (every undercut filled), so it is one connected sheet that lifts off along d by construction, and
    // it is kept only where real bone is within `skirt` of it, so it stops at the silhouette instead of hanging down
    // beside a deep undercut. d is chosen per build: the direction that sees the most bone surface under the guide
    // footprint, with a small cost per degree of tilt so the seating normal wins a near tie (K.seatDir forces one).
    const seatCand = [];
    for (let tilt = 0; tilt <= 40; tilt += 10) for (let az = 0; az < (tilt ? 360 : 1); az += 45) { const tr = tilt * Math.PI / 180, ar = az * Math.PI / 180; seatCand.push({ tilt, az, d: [Math.sin(tr) * Math.cos(ar), Math.sin(tr) * Math.sin(ar), Math.cos(tr)] }); }
    const basis2 = d => { const t = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], a = [t[1] * d[2] - t[2] * d[1], t[2] * d[0] - t[0] * d[2], t[0] * d[1] - t[1] * d[0]], l = Math.hypot(a[0], a[1], a[2]) || 1; const ea = a.map(x => x / l); return [ea, [d[1] * ea[2] - d[2] * ea[1], d[2] * ea[0] - d[0] * ea[2], d[0] * ea[1] - d[1] * ea[0]]]; };
    // projection of the grid onto the plane normal to d, in voxel units (i, j, k) so that an axis-aligned d maps every
    // column to its own cell: the top of the bone per cell. `st` > 1 samples every st-th voxel (direction scoring)
    function projection(d, st = 1) {
      const [ea, eb] = basis2(d), cell = st;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const x of [0, nx - 1]) for (const y of [0, ny - 1]) for (const z of [0, nz - 1]) { const a = x * ea[0] + y * ea[1] + z * ea[2], b = x * eb[0] + y * eb[1] + z * eb[2]; amin = Math.min(amin, a); amax = Math.max(amax, a); bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); }
      const na = Math.floor((amax - amin) / cell) + 2, nb = Math.floor((bmax - bmin) / cell) + 2, top = new Float32Array(na * nb).fill(-Infinity);
      const ea0 = ea[0] / cell, ea1 = ea[1] / cell, ea2 = ea[2] / cell, eb0 = eb[0] / cell, eb1 = eb[1] / cell, eb2 = eb[2] / cell, a0 = amin / cell - 0.5, b0 = bmin / cell - 0.5;
      const cellOf = (i, j, k) => Math.floor(i * ea0 + j * ea1 + k * ea2 - a0) + na * Math.floor(i * eb0 + j * eb1 + k * eb2 - b0);
      const tOf = (i, j, k) => (i * d[0] + j * d[1] + k * d[2]) * h;
      for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) {
        const r = nx * (j + ny * k), ca = j * ea1 + k * ea2 - a0, cb = j * eb1 + k * eb2 - b0, ct = (j * d[1] + k * d[2]) * h;
        for (let i = 0; i < nx; i += st) { if (!Bs[r + i]) continue; const ci = Math.floor(i * ea0 + ca) + na * Math.floor(i * eb0 + cb), t = i * d[0] * h + ct; if (t > top[ci]) top[ci] = t; }
      }
      return { d, ea, eb, cell: cell * h, na, nb, top, cellOf, tOf };
    }
    // bone surface under the guide footprint (a little beyond the box, so a direction is judged on what the guide can reach)
    const surf = [], surfSt = h < 0.6 ? 2 : 1;
    for (let k = 1; k < nz - 1; k += surfSt) for (let j = 1; j < ny - 1; j += surfSt) for (let i = 1; i < nx - 1; i += surfSt) {
      const id = i + nx * (j + ny * k); if (!Bs[id]) continue;
      if (Bs[id - 1] && Bs[id + 1] && Bs[id - nx] && Bs[id + nx] && Bs[id - nxy] && Bs[id + nxy]) continue;
      if (Math.abs(lo[0] + i * h - uc) > g.L / 2 + 2 || Math.abs(lo[1] + j * h - vc) > g.W / 2 + 2 || lo[2] + k * h < wrapAt[i] - 2) continue;
      surf.push(id);
    }
    const visCount = (pj, tol) => { let vis = 0; for (const id of surf) { const i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0; if (pj.top[pj.cellOf(i, j, k)] - pj.tOf(i, j, k) <= tol) vis++; } return vis; };
    let seatPick = null, seatBest = -Infinity;
    const forced = K.seatDir && seatCand.find(cd => cd.tilt === K.seatDir.tilt && cd.az === K.seatDir.az);
    for (const cd of forced ? [forced] : seatCand) {
      const pj = projection(cd.d, surfSt), score = visCount(pj, 1.5 * pj.cell) * (1 - 0.005 * cd.tilt);
      if (score > seatBest) { seatBest = score; seatPick = cd; }
    }
    const prj = projection(seatPick.d, 1), seatDir = { tilt: seatPick.tilt, az: seatPick.az, d: seatPick.d, visible: 0, hidden: 0 };
    { const vis = visCount(prj, 1.5 * h), a = surfSt * surfSt * h * h; seatDir.visible = vis * a; seatDir.hidden = (surf.length - vis) * a; }
    // envelope = bone + its shadow along d; its distance field (dE) carries the shell, dd (real bone) the clearance checks
    const E = new Uint8Array(N), tTop = new Float32Array(N); let nShadow = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k), tp = prj.top[prj.cellOf(i, j, k)];
      tTop[id] = tp - prj.tOf(i, j, k);
      if (Bs[id]) E[id] = 1; else if (tTop[id] > 0.5 * h) { E[id] = 2; nShadow++; }
    }
    // the shadow is one voxel wider across d than the silhouette (not deeper, not higher): a wall standing beside a
    // silhouette then keeps a voxel plus the clearance from it, and the seating sweep (one-voxel cells) sees the two apart
    if (nShadow) {
      const { ea, eb } = prj, nb4 = [[ea[0], ea[1], ea[2]], [-ea[0], -ea[1], -ea[2]], [eb[0], eb[1], eb[2]], [-eb[0], -eb[1], -eb[2]]].map(q => q.map(Math.round));
      const add = [];
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const id = i + nx * (j + ny * k); if (E[id]) continue;
        for (const [di, dj, dk] of nb4) { const i2 = i + di, j2 = j + dj, k2 = k + dk; if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= nx || j2 >= ny || k2 >= nz) continue; if (E[i2 + nx * (j2 + ny * k2)] === 2) { add.push(id); break; } }
      }
      for (const id of add) E[id] = 3;
    }
    let ddE = dd;
    if (nShadow) {
      const DE = G.edt(E, nx, ny, nz), distE = new Float32Array(N);
      for (let i = 0; i < N; i++) distE[i] = E[i] ? -h / 2 : DE[i] * h - h / 2;
      // the density refinement applies where the envelope surface is the bone surface itself (not a shadow face)
      if (soft) { for (let i = 0; i < N; i++) if (!E[i] || Bs[i]) { if (Math.abs(distE[i] - (Bs[i] ? -h / 2 : D[i] * h - h / 2)) < 0.5 * h) distE[i] = dist[i]; } }
      ddE = G.blur(distE, nx, ny, nz);
    }
    T.env = performance.now() - t0; tick(0.57);
    // the saw slots and the two-guide gap as planes in guide-frame coordinates (signed distance = a*uu + b*vv + c*nn - e)
    const slots = K.slots, gp = K.gp;
    const F = new Float32Array(N).fill(h * 4);
    const bridgeLo = cw - 0.5, bridgeHi = cw + 2.5, skirt = g.skirt == null ? 3 : g.skirt;
    // the bridge (the rib that carries the body across the saw slots) runs along the body's own +v / -v edge at each
    // position along the guide: on a bone curved across v the box edge lies off the body, so a rib there would float
    const edgeV = new Float32Array(nx).fill(NaN);
    for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      const e0 = new Float32Array(nx).fill(NaN);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const vv = lo[1] + j * h; for (let i = 0; i < nx; i++) { if (F[i + nx * (j + ny * k)] >= 0) continue; const e = e0[i]; if (Number.isNaN(e) || (g.side > 0 ? vv > e : vv < e)) e0[i] = vv; } }
      // smoothed along u (the rib must not step), never beyond the box edge
      for (let i = 0; i < nx; i++) { let m = NaN, cnt = 0, sum = 0; for (let q = Math.max(0, i - win); q <= Math.min(nx - 1, i + win); q++) if (!Number.isNaN(e0[q])) { cnt++; sum += e0[q]; m = Number.isNaN(m) ? e0[q] : (g.side > 0 ? Math.min(m, e0[q]) : Math.max(m, e0[q])); } edgeV[i] = cnt ? m : NaN; }
    }
    for (let k = 0; k < nz; k++) {
      const nn = lo[2] + k * h;
      for (let j = 0; j < ny; j++) {
        const vv = lo[1] + j * h, av = Math.abs(vv - vc), sd = vv > vc ? sUp.pos : sUp.neg, band = sd && av > g.W / 2 - 2;
        for (let i = 0; i < nx; i++) {
          const id = i + nx * (j + ny * k), uu = lo[0] + i * h, d = dd[id], dE = ddE[id];
          const ev = edgeV[i], eT = pass === 0 || Number.isNaN(ev) ? 1e3 : (g.side > 0 ? ev - g.bridge - vv : vv - ev - g.bridge);
          const outer = Math.abs(uu - uc) - g.L / 2;
          if (outer > 0 || dE > bridgeHi + h) { F[id] = Math.max(outer, dE - bridgeHi); continue; }
          // box: guide length and width, depth below the wrap line (stops: a lip past the edge, only off the bone's shadow)
          const shadow = colTopBone[i + nx * j] > nn;
          let box = Math.max(outer, av - g.W / 2, wrapAt[i] - nn);
          if (band && shadow) box = Math.max(box, h);
          if (sd) {
            const stop = (band && !shadow) ? Math.max(outer, av - g.W / 2 - stopX, wrapAt[i] - stopZ - nn) : 1e3;
            box = Math.min(box, stop);
          }
          let shell = Math.max(c - dE, dE - cw);
          if (pass === 1) for (const s of slots) shell = Math.max(shell, s.half - Math.abs(s.a * uu + s.b * vv + s.c * nn - s.e));   // (pass 0 finds the body edge without the slots, so the rib does not dip into them)
          const bridge = Math.max(bridgeLo - dE, dE - bridgeHi, eT);
          // near real bone: the envelope point under this voxel is bone, or a shadow face within `skirt` of bone
          F[id] = Math.max(box, d - dE - skirt, Math.min(shell, bridge));
        }
      }
    }
    }
    // the body as one region of the footprint (cells of the projection along d): small islands cut off by the
    // silhouette or the box are dropped and reported, larger ones stay and count as pieces
    const dropped = [];
    {
      const nc = prj.na * prj.nb, fp = new Uint8Array(nc), lab = new Int32Array(nc).fill(-1), own = new Int32Array(N).fill(-1);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const id = i + nx * (j + ny * k); if (F[id] < 0) { const ci = prj.cellOf(i, j, k); fp[ci] = 1; own[id] = ci; } }
      const comps2 = [], q = new Int32Array(nc);
      for (let s0 = 0; s0 < nc; s0++) {
        if (!fp[s0] || lab[s0] >= 0) continue;
        const L = comps2.length; let head = 0, tail = 0; q[tail++] = s0; lab[s0] = L; let size = 0;
        while (head < tail) {
          const cI = q[head++]; size++; const a = cI % prj.na, b = (cI / prj.na) | 0;
          for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a2 = a + da, b2 = b + db; if (a2 < 0 || b2 < 0 || a2 >= prj.na || b2 >= prj.nb) continue; const c2 = a2 + prj.na * b2; if (fp[c2] && lab[c2] < 0) { lab[c2] = L; q[tail++] = c2; } }
        }
        comps2.push({ L, size, area: size * prj.cell * prj.cell });
      }
      const main = comps2.reduce((a, b) => (b.size > a.size ? b : a), comps2[0] || { L: -1, size: 0 });
      const drop = new Set(comps2.filter(cm => cm !== main && cm.area < 50).map(cm => cm.L));
      if (K.debugFp) K.debugFp({ fp, lab, na: prj.na, nb: prj.nb, comps: comps2, main });
      if (drop.size) { for (let id = 0; id < N; id++) if (own[id] >= 0 && drop.has(lab[own[id]])) F[id] = h; comps2.forEach(cm => { if (drop.has(cm.L)) dropped.push(+cm.area.toFixed(1)); }); }
    }
    // screw sleeves (added) and drill holes (removed)
    // sleeves and holes: the caller gives each screw in grid coordinates (el = entry, ol = outward axis); the drill path
    // through bone is measured by the caller (it reads the bone field)
    const screwOut = [], axes = [];
    for (const s of K.screws) {
      if (!s) { screwOut.push({ ok: false }); continue; }
      const { el, ol, R, r, top } = s;
      // a sleeve is only added where the guide body is: the body must be present along the sleeve axis just above the
      // clearance (bone that drops away under a guide end, the silhouette, or outside the box leave none), or the
      // sleeve would float free of the shell; such a screw is reported instead
      // (the shell may stand up to `skirt` off the bone where the envelope's shadow face carries it, so the body is
      // looked for over the clearance band plus that allowance; the sleeve reaches down to the entry in any case)
      const ie = Math.max(0, Math.min(nx - 1, Math.round((el[0] - lo[0]) / h)));
      let onN = 0, onHit = 0;
      { const [pa, pb] = basis2(ol), ts = Math.max(0.2, h / 2); for (let t = c + 0.3; t <= cw - 0.3 + 1e-9; t += ts) onN++; for (let t = c + 0.3; t <= cw - 0.3 + skirt + 1e-9; t += ts) for (const [sa, sb] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { const x = el[0] + ol[0] * t + (pa[0] * sa + pb[0] * sb) * R, y = el[1] + ol[1] * t + (pa[1] * sa + pb[1] * sb) * R, z = el[2] + ol[2] * t + (pa[2] * sa + pb[2] * sb) * R, i = Math.round((x - lo[0]) / h), j = Math.round((y - lo[1]) / h), k = Math.round((z - lo[2]) / h); if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) { const q = i + nx * (j + ny * k); if (F[q] < 0 || (ddE[q] > c - h && ddE[q] <= cw + h && slots.some(sl => Math.abs(sl.a * x + sl.b * y + sl.c * z - sl.e) < sl.half + h))) onHit++; } } }
      const onBody = onN > 0 && onHit >= 0.5 * 5 * onN;
      if (!onBody) { screwOut.push({ ok: false, noBody: true, depth: el[2] - wrapAt[ie] }); continue; }
      // only the grid cells within R of the drill axis (the hole runs through the whole grid)
      const rng = [0, 1, 2].map(a => { const p1 = el[a] - ol[a] * 400, p2 = el[a] + ol[a] * 400; return [Math.max(0, Math.floor((Math.min(p1, p2) - R - lo[a]) / h) - 1), Math.min([nx, ny, nz][a] - 1, Math.ceil((Math.max(p1, p2) + R - lo[a]) / h) + 1)]; });
      const info = { ok: true }; axes.push({ el, ol, R, r, top, rng, info });
      screwOut.push(info);
    }
    const radialAt = (A, i, j, k) => {
      const qa = lo[0] + i * h - A.el[0], qb = lo[1] + j * h - A.el[1], qc = lo[2] + k * h - A.el[2], t = qa * A.ol[0] + qb * A.ol[1] + qc * A.ol[2];
      const ra = qa - t * A.ol[0], rb = qb - t * A.ol[1], rc = qc - t * A.ol[2];
      return [Math.sqrt(ra * ra + rb * rb + rc * rc), t];
    };
    // the sleeve keeps clear of the envelope (bone and its shadow along the insertion direction) like the shell does;
    // the part of the cylinder that would stand in the shadow is left out and, when that is more than a tenth, reported
    for (const A of axes) {
      let all = 0, shaded = 0;
      for (let k = A.rng[2][0]; k <= A.rng[2][1]; k++) for (let j = A.rng[1][0]; j <= A.rng[1][1]; j++) for (let i = A.rng[0][0]; i <= A.rng[0][1]; i++) {
        const [rad, t] = radialAt(A, i, j, k); if (rad > A.R + h) continue;
        const id = i + nx * (j + ny * k), cyl = Math.max(rad - A.R, -1 - t, t - A.top);
        if (cyl < 0 && dd[id] > c) { all++; if (ddE[id] <= c) shaded++; }
        F[id] = Math.min(F[id], Math.max(cyl, c - dd[id], c - ddE[id]));
      }
      if (all && shaded > 0.1 * all) A.info.shadowed = +(shaded / all).toFixed(2);
    }
    for (const A of axes) for (let k = A.rng[2][0]; k <= A.rng[2][1]; k++) for (let j = A.rng[1][0]; j <= A.rng[1][1]; j++) for (let i = A.rng[0][0]; i <= A.rng[0][1]; i++) {
      const rad = radialAt(A, i, j, k)[0]; if (rad > A.r + h) continue;
      const id = i + nx * (j + ny * k); F[id] = Math.max(F[id], A.r - rad);
    }
    if (gp) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (F[id] >= 0) continue;
      const uu = lo[0] + i * h, vv = lo[1] + j * h, nn = lo[2] + k * h;
      F[id] = Math.max(F[id], Math.min(gp.A.a * uu + gp.A.b * vv + gp.A.c * nn - gp.A.e - gp.ta, -(gp.B.a * uu + gp.B.b * vv + gp.B.c * nn - gp.B.e) - gp.tb));
    }
    // the surface must close inside the grid
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) { const id = i + nx * (j + ny * k); if (F[id] < h) F[id] = h; }
    T.screws = performance.now() - t0; tick(0.74);
    // drop specks left by slots and holes (under 1 % of the main body or 1 mm³); count real pieces
    const Gm = new Uint8Array(N); for (let i = 0; i < N; i++) if (F[i] < 0) Gm[i] = 1;
    const cc = G.components(Gm, nx, ny, nz, 1), big = cc.comps.length ? cc.comps[0].size : 0, minSize = Math.max(big * 0.01, 1 / (h * h * h));
    const comps = cc.comps.filter(cm => cm.size >= minSize), keepL = new Set(comps.map(cm => cm.label));
    for (let i = 0; i < N; i++) if (Gm[i] && !keepL.has(cc.labels[i])) { Gm[i] = 0; F[i] = h; }
    let vol = 0, contact = 0, undercutCols = 0, bvLo = Infinity, bvHi = -Infinity;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (!Gm[id]) continue;
      vol++; const d = dd[id], vv = lo[1] + j * h; if (vv < bvLo) bvLo = vv; if (vv > bvHi) bvHi = vv;
      if (d > c && d <= bridgeHi) {
        if (d <= cw && d <= c + h) contact++;
        // bone above this voxel along the insertion direction (more than a voxel and a half: the silhouette itself is not an undercut)
        if (tTop[id] > 1.5 * h) undercutCols++;
      }
    }
    T.field = performance.now() - t0; tick(0.79);
    const net = G.marchTets(F, nx, ny, nz, 0);
    // winding follows the grid -> world map, which is a reflection when (u, v, n) is left-handed
    if (K.mirror) { const ix = net.indices; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
    const Seat = seatModule(), seat = Seat && !K.fast ? Seat.analyze({ Gm, B, D, nx, ny, nz, h, lo, clear: c }) : null;
    const wrapProfile = []; for (let i = 0; i < nx; i += Math.max(1, Math.round(1 / h))) wrapProfile.push([+(lo[0] + i * h).toFixed(2), +wrapAt[i].toFixed(2)]);
    T.kernel = performance.now() - t0; tick(1);
    return { net, screws: screwOut, wrapProfile, pieces: comps.length, contact: contact * h * h, undercut: undercutCols * h * h, volume: vol * h * h * h, seat, seatDir, dropped,
      bodyW: vol ? +(bvHi - bvLo + h).toFixed(1) : 0, bodyV: vol ? [+bvLo.toFixed(1), +bvHi.toFixed(1)] : null, T, Gm, B, F, edgeV, wrapAt };
  }
  // the buffers a worker answer moves instead of copying
  const transfer = o => [o.net.positions.buffer, o.net.indices.buffer, o.Gm.buffer, o.B.buffer, o.F.buffer, o.edgeV.buffer, o.wrapAt.buffer];
  return { run, transfer };
})();
