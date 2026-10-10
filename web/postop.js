/* Post-op CT comparison: a CT taken after surgery is aligned to the plan on the bone that was meant to stay
   (trimmed ICP on a signed distance field), then the result is measured against the plan:
   - cut position and angle at each end of the defect, from the stump face (rays walked from the remaining bone
     towards the defect until the post-op bone ends);
   - each fibula graft fitted on its own (local ICP), giving centroid shift, axis angle and end shifts;
   - a colour map of the post-op bone surface against the planned reconstruction (remaining bone + grafts).
   Only the volume is read; no patient name or ID is kept. Thresholds are sample values. */
'use strict';
window.PostOp = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const LIM = { pos: 2, ang: 5, inl: 0.5 };
  let post = null, R = null, msg = '', sig = '', hidden = null;
  const view = { map: true, only: true };

  // ---------- world-aligned isotropic grids with a signed distance field (negative inside) ----------
  function mkGrid(lo, hi, h) { const n = [0, 1, 2].map(d => Math.max(3, Math.ceil((hi[d] - lo[d]) / h) + 1)); return { lo: lo.slice(), h, nx: n[0], ny: n[1], nz: n[2] }; }
  function fill(g, inside) {
    const m = new Uint8Array(g.nx * g.ny * g.nz); let c = 0;
    for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++)
      if (inside(g.lo[0] + i * g.h, g.lo[1] + j * g.h, g.lo[2] + k * g.h)) { m[i + g.nx * (j + g.ny * k)] = 1; c++; }
    g.count = c; return m;
  }
  function signed(g, m) {
    const out = G.edt(m, g.nx, g.ny, g.nz), inv = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
    const din = G.edt(inv, g.nx, g.ny, g.nz), sd = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) sd[i] = m[i] ? -(din[i] - 0.5) * g.h : (out[i] - 0.5) * g.h;
    return sd;
  }
  function samp(g, A, x, y, z) {
    const fx = (x - g.lo[0]) / g.h, fy = (y - g.lo[1]) / g.h, fz = (z - g.lo[2]) / g.h, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= g.nx - 1 || j >= g.ny - 1 || k >= g.nz - 1) return null;
    const a = fx - i, b = fy - j, c = fz - k, nx = g.nx, nxy = nx * g.ny, o = i + nx * j + nxy * k;
    const c00 = A[o] * (1 - a) + A[o + 1] * a, c10 = A[o + nx] * (1 - a) + A[o + nx + 1] * a, c01 = A[o + nxy] * (1 - a) + A[o + nxy + 1] * a, c11 = A[o + nxy + nx] * (1 - a) + A[o + nxy + nx + 1] * a;
    return (c00 * (1 - b) + c10 * b) * (1 - c) + (c01 * (1 - b) + c11 * b) * c;
  }
  function grad(g, A, x, y, z) {
    const h = g.h, gx = [samp(g, A, x + h, y, z), samp(g, A, x - h, y, z)], gy = [samp(g, A, x, y + h, z), samp(g, A, x, y - h, z)], gz = [samp(g, A, x, y, z + h), samp(g, A, x, y, z - h)];
    if ([gx, gy, gz].some(p => p[0] === null || p[1] === null)) return null;
    const v = [gx[0] - gx[1], gy[0] - gy[1], gz[0] - gz[1]], l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  }
  const field = (g, m) => ({ g, sd: signed(g, m) });
  const sdAt = (f, q) => samp(f.g, f.sd, q.x, q.y, q.z);

  // ---------- rigid fit ----------
  function solve6(H, g) {
    const A = H.map((r, i) => r.concat([-g[i]]));
    for (let c = 0; c < 6; c++) {
      let p = c; for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 6; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 7; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map((r, i) => r[6] / r[i]);
  }
  const rotDeg = T => { const q = new THREE.Quaternion().setFromRotationMatrix(T); return THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q.w)))); };
  const transOf = T => V().setFromMatrixPosition(T);

  // trimmed ICP of points P (n of them) onto the zero level of a signed distance field, point-to-plane
  // (Gauss-Newton on the signed distance, linearised about the centroid of the kept points); T0 is the start
  function icp(P, n, f, T0, o = {}) {
    const keep = o.keep || 0.7, cap = o.cap || 8, T = T0.clone(), X = new Float64Array(3 * n), Nn = new Float64Array(3 * n), D = new Float32Array(n);
    const pairs = (Tm) => {
      const e = Tm.elements; let m = 0;
      for (let i = 0; i < n; i++) {
        const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
        const x = e[0] * px + e[4] * py + e[8] * pz + e[12], y = e[1] * px + e[5] * py + e[9] * pz + e[13], z = e[2] * px + e[6] * py + e[10] * pz + e[14];
        const d = samp(f.g, f.sd, x, y, z); if (d === null) continue;
        const gr = grad(f.g, f.sd, x, y, z); if (!gr) continue;
        X[3 * m] = x; X[3 * m + 1] = y; X[3 * m + 2] = z; Nn[3 * m] = gr[0]; Nn[3 * m + 1] = gr[1]; Nn[3 * m + 2] = gr[2]; D[m] = d; m++;
      }
      return m;
    };
    const absSorted = m => Array.from(D.subarray(0, m), Math.abs).sort((a, b) => a - b);
    for (let it = 0; it < (o.iters || 60); it++) {
      const m = pairs(T); if (m < 30) break;
      const srt = absSorted(m), thr = Math.min(srt[Math.floor((m - 1) * keep)], it < 6 ? cap : Math.max(1.5, cap / 2));
      const c = [0, 0, 0]; let k = 0;
      for (let i = 0; i < m; i++) if (Math.abs(D[i]) <= thr) { c[0] += X[3 * i]; c[1] += X[3 * i + 1]; c[2] += X[3 * i + 2]; k++; }
      if (k < 20) break; c[0] /= k; c[1] /= k; c[2] /= k;
      const H = [...Array(6)].map(() => [0, 0, 0, 0, 0, 0]), g = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < m; i++) {
        if (Math.abs(D[i]) > thr) continue;
        const x = X[3 * i] - c[0], y = X[3 * i + 1] - c[1], z = X[3 * i + 2] - c[2], nx = Nn[3 * i], ny = Nn[3 * i + 1], nz = Nn[3 * i + 2];
        const J = [y * nz - z * ny, z * nx - x * nz, x * ny - y * nx, nx, ny, nz];
        for (let a = 0; a < 6; a++) { g[a] += J[a] * D[i]; for (let b = a; b < 6; b++) H[a][b] += J[a] * J[b]; }
      }
      for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
      const dx = solve6(H, g); if (!dx) break;
      const w = V(dx[0], dx[1], dx[2]), ang = w.length();
      const dT = new THREE.Matrix4().makeTranslation(c[0] + dx[3], c[1] + dx[4], c[2] + dx[5]);
      if (ang > 1e-9) dT.multiply(new THREE.Matrix4().makeRotationAxis(w.clone().normalize(), ang));
      dT.multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
      T.premultiply(dT);
      if (THREE.MathUtils.radToDeg(ang) < 0.002 && Math.hypot(dx[3], dx[4], dx[5]) < 0.002) break;
    }
    const m = pairs(T); let inl = 0;
    for (let i = 0; i < m; i++) if (Math.abs(D[i]) < 1) inl++;
    const srt = m ? absSorted(m) : [], k = Math.max(1, Math.floor(m * keep)); let ss = 0;
    for (let i = 0; i < k && i < srt.length; i++) ss += srt[i] * srt[i];
    return { T, rms: m ? Math.sqrt(ss / Math.min(k, srt.length)) : Infinity, inl: m ? inl / m : 0, n: m };
  }

  // ---------- post-op volume -> bone mask, blurred field, surface ----------
  async function prep(vol) {
    St.busy(true, 'Ameliyat sonrası BT: kemik ayrılıyor…'); await St.sleep();
    const r = G.reduce(vol, 0.8), thr = +$('thr').value || 300, m = new Uint8Array(r.hu.length);
    for (let i = 0; i < m.length; i++) m[i] = r.hu[i] >= thr && r.hu[i] < 2800 ? 1 : 0;   // plates and screws (metal) left out
    const { labels, comps } = G.components(m, r.nx, r.ny, r.nz, 200), vox = r.sp[0] * r.sp[1] * r.sp[2];
    const keep = new Set(comps.filter(c => c.size * vox >= 300).map(c => c.label));
    for (let i = 0; i < m.length; i++) m[i] = keep.has(labels[i]) ? 1 : 0;
    const F = G.blur(m, r.nx, r.ny, r.nz);
    St.busy(true, 'Ameliyat sonrası BT: yüzey çıkarılıyor…'); await St.sleep();
    const net = G.surfaceNets(F, r.nx, r.ny, r.nz), np = net.positions.length / 3, W = new Float32Array(np * 3);
    for (let i = 0; i < np; i++) W.set(G.worldOf(r, net.positions[3 * i], net.positions[3 * i + 1], net.positions[3 * i + 2]), 3 * i);
    // a fixed, evenly spread subset for the fit
    const step = Math.max(1, Math.floor(np / 9000)), cnt = Math.floor(np / step), Pts = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) Pts.set(W.subarray(3 * i * step, 3 * i * step + 3), 3 * i);
    return { r, F, net, W, Pts, nPts: cnt };
  }

  // ---------- plan side ----------
  function planInside() {
    const r = S.red, a = r.axes, s = r.sp, o = r.origin, mask = S.mask, res = S.resMask;
    return (x, y, z) => {
      const dx = x - o[0], dy = y - o[1], dz = z - o[2];
      const i = Math.round((dx * a[0][0] + dy * a[0][1] + dz * a[0][2]) / s[0]), j = Math.round((dx * a[1][0] + dy * a[1][1] + dz * a[1][2]) / s[1]), k = Math.round((dx * a[2][0] + dy * a[2][1] + dz * a[2][2]) / s[2]);
      if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) return false;
      const v = i + r.nx * (j + r.ny * k); return !!mask[v] && !(res && res[v]);
    };
  }
  function planBox() {
    const r = S.red, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < r.nz; k += 2) for (let j = 0; j < r.ny; j += 2) for (let i = 0; i < r.nx; i += 2) {
      if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
      const w = G.worldOf(r, i, j, k); for (let d = 0; d < 3; d++) { if (w[d] < lo[d]) lo[d] = w[d]; if (w[d] > hi[d]) hi[d] = w[d]; }
    }
    return [lo.map(v => v - 10), hi.map(v => v + 10)];
  }
  function grafts() {
    if (!window.Fibula || !Fibula.active()) return [];
    const st = Fibula.state(); if (!st.last || !st.F || !st.F.c) return [];
    const FR = st.F.c.FR;
    return st.last.segs.map((g, i) => {
      const pad = FR + 6, lo = [0, 1, 2].map(d => Math.min(g.P0.getComponent(d), g.P1.getComponent(d)) - pad), hi = [0, 1, 2].map(d => Math.max(g.P0.getComponent(d), g.P1.getComponent(d)) + pad);
      return { i, g, lo, hi, FR };
    });
  }
  const inBox = (b, x, y, z) => x >= b.lo[0] && y >= b.lo[1] && z >= b.lo[2] && x <= b.hi[0] && y <= b.hi[1] && z <= b.hi[2];
  const q0 = V();
  const graftIn = (b, x, y, z) => inBox(b, x, y, z) && Fibula.graftBone(b.i, q0.set(x, y, z));
  const planSig = () => JSON.stringify([S.planes, S.lesion, S.anchor && S.anchor.p, window.Fibula && Fibula.plan ? Fibula.plan() : null, S.selected && [...S.selected]]);

  // ---------- the comparison ----------
  async function run() {
    if (!post) return;
    if (!S.anchor || !S.mask) { msg = 'Önce plan gerekli.'; render(); return; }
    try {
      St.busy(true, 'Plan kemiği hazırlanıyor…'); await St.sleep();
      const [lo, hi] = planBox(), g = mkGrid(lo, hi, 0.8), inside = planInside();
      const ref = field(g, fill(g, inside));
      const GB = grafts();
      const recon = GB.length ? field(g, fill(g, (x, y, z) => inside(x, y, z) || GB.some(b => graftIn(b, x, y, z)))) : ref;
      // 1) global fit on the remaining bone: from the scan as it is and from the centroids lined up; the better one wins
      St.busy(true, 'Kalan kemiğe hizalanıyor…'); await St.sleep();
      const P = post.Pts, n = post.nPts, cP = V(); for (let i = 0; i < n; i++) cP.add(V(P[3 * i], P[3 * i + 1], P[3 * i + 2])); cP.multiplyScalar(1 / n);
      const cR = V(); let cn = 0;
      for (let k = 0; k < g.nz; k += 2) for (let j = 0; j < g.ny; j += 2) for (let i = 0; i < g.nx; i += 2) { const v = i + g.nx * (j + g.ny * k); if (ref.sd[v] < 0 && ref.sd[v] > -1.2) { cR.add(V(g.lo[0] + i * g.h, g.lo[1] + j * g.h, g.lo[2] + k * g.h)); cn++; } }
      if (cn) cR.multiplyScalar(1 / cn);
      const starts = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(cR.x - cP.x, cR.y - cP.y, cR.z - cP.z)];
      let best = null;
      for (const T0 of starts) { const f = icp(P, n, ref, T0, { keep: 0.7, cap: 10, iters: 60 }); if (!best || f.inl > best.inl + 0.02 || (Math.abs(f.inl - best.inl) <= 0.02 && f.rms < best.rms)) best = f; await St.sleep(); }
      const T = best.T, Ti = T.clone().invert();
      const postAt = q => { const p = q.clone().applyMatrix4(Ti); return St.fieldAt(post.r, post.F, [p.x, p.y, p.z]) > 0.5; };
      const rem = S.mask.slice(); if (S.resMask) for (let v = 0; v < rem.length; v++) if (S.resMask[v]) rem[v] = 0;
      const remF = G.blur(rem, S.red.nx, S.red.ny, S.red.nz), planAt = q => St.fieldAt(S.red, remF, [q.x, q.y, q.z]) > 0.5;
      const graftAt = q => GB.some(b => graftIn(b, q.x, q.y, q.z));
      // 2) cuts, from the stump face
      St.busy(true, 'Kesiler ve greftler ölçülüyor…'); await St.sleep();
      const cuts = [], ends = St.resEnds();
      if (ends) {
        const dirAB = ends.B.p.clone().sub(ends.A.p);
        [[ends.A, 1], [ends.B, -1]].forEach(([E, sgn]) => {
          if (E.virtual) return;
          const Nin = E.N.clone().normalize(); if (Nin.dot(dirAB) * sgn < 0) Nin.negate();
          cuts.push(Object.assign({ name: `Kesi ${S.planes.indexOf(E.pl) + 1}` }, stump(E.p, Nin, ref, postAt, planAt, GB.length ? graftAt : null)));
        });
      }
      // 3) grafts, one local fit each on the post-op points next to it
      const gr = [];
      if (GB.length) {
        const fields = GB.map(b => { const gg = mkGrid(b.lo, b.hi, 0.5), m = fill(gg, (x, y, z) => Fibula.graftBone(b.i, q0.set(x, y, z))); let c = V(), k = 0;
          for (let z = 0; z < gg.nz; z++) for (let y = 0; y < gg.ny; y++) for (let x = 0; x < gg.nx; x++) if (m[x + gg.nx * (y + gg.ny * z)]) { c.add(V(gg.lo[0] + x * gg.h, gg.lo[1] + y * gg.h, gg.lo[2] + z * gg.h)); k++; }
          return { b, f: field(gg, m), c: k ? c.multiplyScalar(1 / k) : b.g.P0.clone().lerp(b.g.P1, 0.5), vox: k }; });
        const W = post.W, nW = W.length / 3, e = T.elements, sel = fields.map(() => []), stepW = Math.max(1, Math.floor(nW / 60000));
        for (let i = 0; i < nW; i += stepW) {
          const px = W[3 * i], py = W[3 * i + 1], pz = W[3 * i + 2], q = V(e[0] * px + e[4] * py + e[8] * pz + e[12], e[1] * px + e[5] * py + e[9] * pz + e[13], e[2] * px + e[6] * py + e[10] * pz + e[14]);
          const dr = sdAt(ref, q); if (dr !== null && dr < 1) continue;
          let bi = -1, bd = 3;
          fields.forEach((F, j) => { const d = sdAt(F.f, q); if (d !== null && Math.abs(d) < bd) { bd = Math.abs(d); bi = j; } });
          if (bi >= 0) sel[bi].push(q.x, q.y, q.z);
        }
        fields.forEach((F, j) => {
          const g = F.b.g, no = j + 1, pts = Float32Array.from(sel[j]), m = pts.length / 3;
          if (m < 150 || !F.vox) { gr.push({ no, barrel: g.barrel, ok: false, n: m }); return; }
          const fit = icp(pts, m, F.f, new THREE.Matrix4(), { keep: 0.85, cap: 3, iters: 40 }), A = fit.T.clone().invert();
          const disp = F.c.clone().applyMatrix4(A).distanceTo(F.c), ax = g.x.clone().transformDirection(A);
          gr.push({ no, barrel: g.barrel, ok: true, n: m, disp, ang: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(ax.dot(g.x))))), rot: rotDeg(A),
            end0: g.P0.clone().applyMatrix4(A).distanceTo(g.P0), end1: g.P1.clone().applyMatrix4(A).distanceTo(g.P1), rms: fit.rms });
        });
      }
      // 4) surface deviation map
      St.busy(true, 'Sapma haritası çiziliyor…'); await St.sleep();
      const surf = paint(T, recon, GB.length ? ref : null);
      R = { T, reg: { rms: best.rms, inl: best.inl, n: best.n, shift: transOf(T).length(), rot: rotDeg(T) }, cuts, grafts: gr, surf, source: post.source, ctDate: post.ctDate };
      sig = planSig(); msg = ''; R.stale = false;
    } catch (e) { msg = 'Karşılaştırma yapılamadı: ' + e.message; R = null; }
    finally { St.busy(false); render(); St.renderChecks(); St.render(); }
  }

  // stump face of the remaining bone at a cut: rays start 5 mm inside the planned remaining bone and walk towards
  // the defect until the bone ends, once in the planned bone and once in the post-op bone (both are blurred voxel
  // masks of the same kind, so the method's own bias cancels). Shift = post-op exit minus planned exit
  // (+ = more bone left than planned); angle = between the planes fitted to the two sets of exit points.
  function stump(p, Nin, ref, postAt, planAt, graftAt) {
    const e1 = V().crossVectors(Nin, Math.abs(Nin.x) < 0.9 ? V(1, 0, 0) : V(0, 1, 0)).normalize(), e2 = V().crossVectors(Nin, e1);
    const exit = (s, at, max) => { for (let t = 0; t <= max; t += 0.1) if (!at(s.clone().addScaledVector(Nin, t))) return t; return null; };
    let valid = 0, joined = 0; const ex = [], A = [], B = [];
    for (let a = -20; a <= 20; a += 0.8) for (let b = -20; b <= 20; b += 0.8) {
      const s = p.clone().addScaledVector(Nin, -5).addScaledVector(e1, a).addScaledVector(e2, b), d0 = sdAt(ref, s);
      if (d0 === null || d0 > -0.6) continue;
      // keep rays that reach the planned cut face (the planned bone ends within 1 mm of the plane)
      const tp = exit(s, planAt, 8); if (tp === null || Math.abs(tp - 5) > 1) continue;
      valid++;
      const te = exit(s, postAt, 13);
      // the post-op bone runs on into where a graft was planned: stump and graft cannot be told apart on this ray
      if (graftAt && (te === null || te > tp + 0.5) && graftAt(s.clone().addScaledVector(Nin, tp + 0.6))) { joined++; continue; }
      if (te !== null) { ex.push(te - tp); A.push(s.clone().addScaledVector(Nin, tp)); B.push(s.clone().addScaledVector(Nin, te)); }
    }
    if (valid < 20) return { ok: false, why: 'kesit yüzeyi bulunamadı', rays: valid };
    if (ex.length < Math.max(20, 0.3 * valid)) return { ok: false, why: 'güdük greftle birleşik', rays: valid, joined: joined / valid };
    ex.sort((a, b) => a - b);
    const nA = planeFit(A, Nin), nB = planeFit(B, Nin);
    return { ok: true, pos: ex[ex.length >> 1], ang: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(nA.dot(nB))))), rays: valid, exits: ex.length, joined: joined / valid };
  }
  // normal of the least-squares plane through points (smallest principal axis), started from a guess
  function planeFit(pts, guess) {
    const c = pts.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / pts.length), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    pts.forEach(q => { const d = [q.x - c.x, q.y - c.y, q.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; });
    const tr = C[0][0] + C[1][1] + C[2][2]; let nv = guess.clone();
    for (let it = 0; it < 200; it++) nv = V((tr - C[0][0]) * nv.x - C[0][1] * nv.y - C[0][2] * nv.z, -C[1][0] * nv.x + (tr - C[1][1]) * nv.y - C[1][2] * nv.z, -C[2][0] * nv.x - C[2][1] * nv.y + (tr - C[2][2]) * nv.z).normalize();
    return nv;
  }

  // ---------- 3D: the post-op surface, aligned, coloured by distance to the planned reconstruction ----------
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const RED = [0.84, 0.19, 0.15], YEL = [0.95, 0.75, 0.2], GRN = [0.2, 0.68, 0.4], BLU = [0.25, 0.5, 0.9], NEU = [0.78, 0.8, 0.83];
  const devColor = d => (d < 0 ? lerp3(GRN, BLU, Math.min(1, -d / 2.5)) : d < 1.25 ? lerp3(GRN, YEL, d / 1.25) : lerp3(YEL, RED, Math.min(1, (d - 1.25) / 1.25)));
  function paint(T, recon, ref) {
    const r = post.r, mesh = St.meshFromNets(post.net, (x, y, z) => { const w = G.worldOf(r, x, y, z); return V(...w).applyMatrix4(T).toArray(); }, St.mat(0xffffff, { vertexColors: true }));
    const P = mesh.geometry.attributes.position.array, n = P.length / 3, col = new Float32Array(n * 3), all = [], gpart = [];
    for (let i = 0; i < n; i++) {
      const q = V(P[3 * i], P[3 * i + 1], P[3 * i + 2]), d = sdAt(recon, q);
      if (d === null || Math.abs(d) > 15) { col.set(NEU, 3 * i); continue; }
      col.set(devColor(d), 3 * i); all.push(Math.abs(d));
      if (ref) { const dr = sdAt(ref, q); if (dr !== null && dr > 2) gpart.push(Math.abs(d)); }
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    St.setPart('postop', 'Ameliyat sonrası (sapma)', mesh, 0x7c5cc4); St.renderParts(); isolate(view.only); mesh.visible = view.map && St.parts.postop.visible;
    // the post-op surface lives in the mandible scene
    if (window.Fibula && Fibula.active() && Fibula.view && Fibula.view() !== 'm') Fibula.setView('m');
    St.fitTo(mesh);
    const st = a => { if (!a.length) return null; a.sort((x, y) => x - y); return { in1: a.filter(v => v <= 1).length / a.length, in2: a.filter(v => v <= 2).length / a.length, p95: a[Math.floor(0.95 * (a.length - 1))], n: a.length }; };
    return { all: st(all), graft: st(gpart) };
  }
  function isolate(on) {
    const parts = St.parts;
    if (on && parts.postop && !hidden) { hidden = {}; Object.values(parts).forEach(p => { if (p.id !== 'postop') { hidden[p.id] = p.visible; p.visible = false; p.obj.visible = false; } }); }
    if (!on && hidden) { Object.entries(hidden).forEach(([id, v]) => { const p = parts[id]; if (p) { p.visible = v; p.obj.visible = v; } }); hidden = null; }
    St.renderParts(); St.render();
  }
  function legend() {
    let el = $('postLegend');
    if (!el) { el = document.createElement('div'); el.id = 'postLegend'; el.className = 'fitlegend'; el.style.bottom = '130px'; document.querySelector('.stagewrap').appendChild(el); }
    el.hidden = !(R && St.parts.postop && view.map);
    el.innerHTML = '<b>Ameliyat sonrası, plana göre</b><i style="background:linear-gradient(90deg,#4080e6,#33ad66 50%,#f2bf33 75%,#d6302a)"></i><span><em>-2,5</em><em>0 mm</em><em>+2,5</em></span><span><em>eksik kemik</em><em>fazla kemik</em></span>';
  }
  function clear() { isolate(false); post = null; R = null; msg = ''; St.setPart('postop', null, null); St.renderParts(); render(); St.renderChecks(); St.render(); }

  // ---------- loading ----------
  async function load(vol, source) {
    try {
      clearKeep();
      const p = await prep(vol), m = vol.meta || {};
      const iso = d => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
      post = Object.assign(p, { source, ctDate: iso(m.acqDate) || iso(m.seriesDate) || iso(m.studyDate) });
    } catch (e) { St.busy(false); msg = 'Ameliyat sonrası BT okunamadı: ' + e.message; render(); return; }
    await run();
  }
  function clearKeep() { isolate(false); R = null; St.setPart('postop', null, null); }

  // synthetic post-op scan from the plan (sample cases only): the resected piece removed, the grafts placed with a known
  // error, the remaining bone over-cut at the first end, and the whole scan moved; used to check the measurements
  function simulate(o = {}) {
    const r = S.red, ends = St.resEnds(); if (!r || !S.resMask || !ends) throw new Error('rezeksiyon planı yok');
    const over = o.over ?? 2, gsh = o.graftShift ?? 1.5, gang = o.graftAngle ?? 4, hu = Int16Array.from(r.hu), soft = 40;
    for (let v = 0; v < hu.length; v++) if (S.resMask[v]) hu[v] = soft;
    const NinA = ends.A.N.clone().normalize(); if (NinA.dot(ends.B.p.clone().sub(ends.A.p)) < 0) NinA.negate();
    const idxBox = (lo, hi) => { const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) { const ix = G.indexOf(r, [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]); for (let d = 0; d < 3; d++) { a[d] = Math.min(a[d], ix[d]); b[d] = Math.max(b[d], ix[d]); } }
      const n = [r.nx, r.ny, r.nz]; return [a.map(v => Math.max(0, Math.floor(v))), b.map((v, d) => Math.min(n[d] - 1, Math.ceil(v)))]; };
    const each = (lo, hi, f) => { const [a, b] = idxBox(lo, hi); for (let k = a[2]; k <= b[2]; k++) for (let j = a[1]; j <= b[1]; j++) for (let i = a[0]; i <= b[0]; i++) f(i + r.nx * (j + r.ny * k), V(...G.worldOf(r, i, j, k))); };
    if (over > 0) { const p = ends.A.p, R0 = 35; each([p.x - R0, p.y - R0, p.z - R0], [p.x + R0, p.y + R0, p.z + R0], (v, q) => { const s = q.clone().sub(p).dot(NinA); if (s <= 0 && s > -over && q.distanceTo(p) < R0 && S.mask[v]) hu[v] = soft; }); }
    const truth = [];
    grafts().forEach(b => {
      const g = b.g, c = g.P0.clone().lerp(g.P1, 0.5), moved = b.i === 0;
      const D = moved ? new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationAxis(g.z.clone().normalize(), THREE.MathUtils.degToRad(gang))).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)) : new THREE.Matrix4();
      if (moved) D.premultiply(new THREE.Matrix4().makeTranslation(...g.b.clone().normalize().multiplyScalar(gsh).toArray()));
      const Dinv = D.clone().invert(), lo = b.lo.map(v => v - 4), hi = b.hi.map(v => v + 4);
      each(lo, hi, (v, q) => { if (Fibula.graftBone(b.i, q.applyMatrix4(Dinv))) hu[v] = 1300; });
      truth.push({ no: b.i + 1, shift: moved ? gsh : 0, angle: moved ? gang : 0 });
    });
    const M = new THREE.Matrix4().makeRotationAxis(V(0.3, 0.2, 1).normalize(), THREE.MathUtils.degToRad(o.rot ?? 4)).setPosition(...(o.move || [5, -3, 4]));
    const org = V(...r.origin).applyMatrix4(M), axes = r.axes.map(a => V(...a).transformDirection(M).toArray());
    return { vol: { hu, nx: r.nx, ny: r.ny, nz: r.nz, sp: r.sp.slice(), origin: org.toArray(), axes, meta: {} }, truth: { overCut: over, grafts: truth, rot: o.rot ?? 4, move: o.move || [5, -3, 4] } };
  }

  // ---------- panel ----------
  const sgn = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
  function render() {
    const box = $('postBox'); if (!box) return;
    const sample = S.source && S.source.type === 'sample', hasPlan = !!(S.anchor && St.resEnds());
    const cutRow = c => (c.ok ? `<tr><td>${c.name}</td><td>${sgn(c.pos)} mm${Math.abs(c.pos) >= 0.3 ? ` (${c.pos > 0 ? 'dar' : 'geniş'})` : ''}</td><td>${fmt(c.ang)}°</td></tr>` : `<tr><td>${c.name}</td><td colspan="2">${c.why}</td></tr>`).replace('<tr>', c.joined > 0.1 ? `<tr title="Işınların %${fmt(c.joined * 100, 0)}'i greftle birleşik; bunlar ölçüme katılmadı.">` : '<tr>');
    const grRow = g => (g.ok ? `<tr><td>${g.no}${g.barrel ? ' (üst)' : ''}</td><td>${fmt(g.disp)} mm</td><td>${fmt(g.ang)}°</td><td>${fmt(g.end0)} / ${fmt(g.end1)} mm</td></tr>` : `<tr><td>${g.no}</td><td colspan="3">yeterli yüzey yok</td></tr>`);
    const pc = v => `%${fmt(v * 100, 0)}`;
    box.innerHTML = `<h3 class="sub">Ameliyat sonrası</h3>
      <p class="hint more">Ameliyat sonrası BT plana hizalanır. Kesi, greft ve yüzey sapması ölçülür.</p>
      <span class="btns"><label class="filebtn"><svg class="i"><use href="#i-folder"/></svg>Post-op BT<input type="file" id="postDir" webkitdirectory multiple></label>${sample ? `<button id="postSim" ${hasPlan ? '' : 'disabled'} title="Plandan üretilen sentetik ameliyat sonrası BT: kesi 1 2 mm geniş, greft 1 kaydırılmış, tarama döndürülmüş">Sentetik deneme</button>` : ''}${post ? '<button id="postClr">Kaldır</button>' : ''}</span>
      ${msg ? `<p class="hint">${msg}</p>` : ''}
      ${R ? `${R.stale ? '<p class="hint">Plan değişti. <button class="link" id="postRe">Yeniden hesapla</button></p>' : ''}
      <dl class="kv"><dt title="Kalan kemik yüzeyinin 1 mm içinde oturan kısmı ve kalan farkın RMS'i">Hizalama</dt><dd>${pc(R.reg.inl)}, RMS ${fmt(R.reg.rms, 2)} mm</dd>${R.ctDate ? `<dt>Post-op BT tarihi</dt><dd>${new Date(R.ctDate + 'T12:00:00').toLocaleDateString('tr-TR')}</dd>` : ''}
      ${R.surf.all ? `<dt title="Plana 1 mm ve 2 mm içinde kalan yüzey">Yüzey ≤ 1 / 2 mm</dt><dd>${pc(R.surf.all.in1)} / ${pc(R.surf.all.in2)}</dd>` : ''}${R.surf.graft ? `<dt title="Yalnız greft bölgesi">Greft ≤ 1 / 2 mm</dt><dd>${pc(R.surf.graft.in1)} / ${pc(R.surf.graft.in2)}</dd>` : ''}</dl>
      ${R.cuts.length ? `<div class="tbl"><table><thead><tr><th>Kesi</th><th>Konum</th><th>Açı</th></tr></thead><tbody>${R.cuts.map(cutRow).join('')}</tbody></table></div>` : ''}
      ${R.grafts.length ? `<div class="tbl"><table><thead><tr><th>Greft</th><th>Kayma</th><th>Eksen</th><th>Uçlar</th></tr></thead><tbody>${R.grafts.map(grRow).join('')}</tbody></table></div>` : ''}
      <label class="chk"><input type="checkbox" id="postMap" ${view.map ? 'checked' : ''}> Sapma haritasını göster</label>
      <label class="chk"><input type="checkbox" id="postOnly" ${view.only ? 'checked' : ''}> Diğer modelleri gizle</label>` : ''}
      <p class="hint more">Hizalama, plandaki kalan kemiğe göre yapılır. Post-op BT plan BT'sine yakın konumda olmalı; büyük dönmeler hizalanmaz. Kesi konumu güdük yüzeyinden ölçülür: + kemik planlanandan fazla kalmış (rezeksiyon dar), − fazla alınmış. Greft güdüğe kaynamışsa kesi ölçülemez; greft tablosuna bakın. Greftin kendi ekseni boyunca kayması ve dönmesi zayıf ölçülür. Metal (plaka, vida) ayrılır. Sınırlar (${LIM.pos} mm, ${LIM.ang}°) örnek değerlerdir.</p>`;
    $('postDir').addEventListener('change', async e => {
      const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
      const r = await St.readDicom(files); St.busy(false);
      if (r.error) { msg = r.error; render(); return; }
      await load(r.vol, 'dicom');
    });
    if ($('postSim')) $('postSim').addEventListener('click', async () => { try { St.busy(true, 'Sentetik ameliyat sonrası BT üretiliyor…'); await St.sleep(); const s = simulate(); R = null; await load(s.vol, 'sentetik'); if (R) R.truth = s.truth; render(); } catch (e) { St.busy(false); msg = 'Sentetik deneme yapılamadı: ' + e.message; render(); } });
    if ($('postClr')) $('postClr').addEventListener('click', clear);
    if ($('postRe')) $('postRe').addEventListener('click', run);
    if ($('postMap')) $('postMap').addEventListener('change', e => { view.map = e.target.checked; const p = St.parts.postop; if (p) { p.visible = view.map; p.obj.visible = view.map; } St.renderParts(); legend(); St.render(); });
    if ($('postOnly')) $('postOnly').addEventListener('change', e => { view.only = e.target.checked; isolate(view.only); });
    legend();
  }

  // ---------- checks, report, export ----------
  function issues() {
    if (!R || R.stale) return [];
    const out = [];
    if (R.reg.inl < LIM.inl) out.push(['warn', 'Uyarı', `Ameliyat sonrası BT plana iyi hizalanmadı (yüzeyin %${fmt(R.reg.inl * 100, 0)}'i 1 mm içinde); sapmalar güvenilir değil.`]);
    R.cuts.forEach(c => { if (c.ok && (Math.abs(c.pos) > LIM.pos || c.ang > LIM.ang)) out.push(['warn', 'Uyarı', `Ameliyat sonrası: ${c.name} plandan ${sgn(c.pos)} mm, ${fmt(c.ang)}° sapmış (sınır ${LIM.pos} mm, ${LIM.ang}°).`]); });
    R.grafts.forEach(g => { if (g.ok && (g.disp > LIM.pos || g.ang > LIM.ang)) out.push(['warn', 'Uyarı', `Ameliyat sonrası: greft ${g.no} ${fmt(g.disp)} mm kaymış, ekseni ${fmt(g.ang)}° dönmüş (sınır ${LIM.pos} mm, ${LIM.ang}°).`]); });
    if (!out.length) out.push(['info', 'Bilgi', 'Ameliyat sonrası kesi ve greft sapmaları sınırlar içinde.']);
    return out;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(issues);
  function summary() {
    if (!R) return null;
    const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
    return { kaynak: R.source, post_op_bt_tarihi: R.ctDate || null, plan_degisti: !!R.stale,
      hizalama: { yuzey_1mm_orani: r2(R.reg.inl), rms_mm: r2(R.reg.rms), oteleme_mm: r2(R.reg.shift), donme_deg: r2(R.reg.rot) },
      kesiler: R.cuts.map(c => (c.ok ? { kesi: c.name, konum_sapmasi_mm: r2(c.pos), aci_sapmasi_deg: r2(c.ang), isin: c.rays, greftle_birlesik_oran: r2(c.joined || 0) } : { kesi: c.name, olculemedi: c.why })),
      greftler: R.grafts.map(g => (g.ok ? { greft: g.no, merkez_kaymasi_mm: r2(g.disp), eksen_acisi_deg: r2(g.ang), toplam_donme_deg: r2(g.rot), uc_kaymasi_mm: [r2(g.end0), r2(g.end1)] } : { greft: g.no, olculemedi: 'yeterli yüzey yok' })),
      yuzey: R.surf.all ? { bir_mm_ici: r2(R.surf.all.in1), iki_mm_ici: r2(R.surf.all.in2), p95_mm: r2(R.surf.all.p95) } : null,
      greft_bolgesi: R.surf.graft ? { bir_mm_ici: r2(R.surf.graft.in1), iki_mm_ici: r2(R.surf.graft.in2), p95_mm: r2(R.surf.graft.p95) } : null,
      esikler: { konum_mm: LIM.pos, aci_deg: LIM.ang }, gercek_deger: R.truth || undefined };
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!R) return;
    if (d.keep) d.keep(300); d.h2('Ameliyat sonrası karşılaştırma');
    const rows = [['Hizalama', `%${fmt(R.reg.inl * 100, 0)} yüzey 1 mm içinde, RMS ${fmt(R.reg.rms, 2)} mm`]];
    R.cuts.forEach(c => rows.push([c.name, c.ok ? `${sgn(c.pos)} mm, ${fmt(c.ang)}°` : c.why]));
    R.grafts.forEach(g => rows.push([`Greft ${g.no}`, g.ok ? `kayma ${fmt(g.disp)} mm, eksen ${fmt(g.ang)}°, uçlar ${fmt(g.end0)} / ${fmt(g.end1)} mm` : 'ölçülemedi']));
    if (R.surf.all) rows.push(['Yüzey sapması', `%${fmt(R.surf.all.in1 * 100, 0)} ≤ 1 mm, %${fmt(R.surf.all.in2 * 100, 0)} ≤ 2 mm`]);
    if (R.stale) rows.push(['Not', 'Plan karşılaştırmadan sonra değişti.']);
    d.table(['Ölçü', 'Değer'], rows, [0.35, 0.65]);
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'postop_karsilastirma.json', data: JSON.stringify(s, null, 2) }); });

  bus.addEventListener('volume', () => { if (post || R) clear(); else render(); });
  bus.addEventListener('changed', () => { if (R && !R.stale && planSig() !== sig) { R.stale = true; render(); St.renderChecks(); } });
  bus.addEventListener('planApplied', render);
  render();
  return { load, run, simulate, clear, result: () => R, summary };
})();
