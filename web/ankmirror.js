/* The healthy side as the reduction template (plan M3): on a CT of both legs, the other leg's tibia and fibula are
   mirrored across the sagittal plane between the legs and fitted to the planned leg's tibia (its distal FIT mm, above
   the fracture's reach the bones of both sides are alike: Verbakel 2024, 75 pairs, plafond median 0.57 mm). A fragment
   can then be fitted to the mirrored bone ("Aynaya hizala"); its motion is written like any other.

   The template: the other leg's tibia and fibula as distance fields (crop + 12 mm) and surface points; a world point w
   lies at template distance sdf_other(M^-1 w), M = R S + t (S the reflection, R t the fit), so no new field is needed.
   Fitting: point-to-surface ICP on the distance field (each point steps to the surface along the gradient), trimmed
   (only points within TRIM mm of the surface count: the fracture surfaces and the other side's missing pieces fall
   out), Horn's closed-form rotation (quaternion, 4x4 Jacobi). Research prototype, not for clinical use. */
'use strict';
window.AnkMirror = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  const FIT = 60, ABOVE = 20, PAD = 12, TRIM = 3, ITER = 40, KEEP = 0.7;
  let tpl = null;      // { key, parts: [{ label, role, sdf: {d, lo, nx, ny, nz}, pts: Float32Array }], mid, R, t, rms, max, n }
  let job = null, shown = false, last = null;

  // ---------- small linear algebra ----------
  // Horn 1987: the rotation q and translation t that move points a onto b (weights w), least squares
  function horn(a, b, w) {
    let W = 0; const ca = V(), cb = V();
    for (let i = 0; i < a.length; i++) { ca.addScaledVector(a[i], w[i]); cb.addScaledVector(b[i], w[i]); W += w[i]; }
    ca.multiplyScalar(1 / W); cb.multiplyScalar(1 / W);
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < a.length; i++) { const x = [a[i].x - ca.x, a[i].y - ca.y, a[i].z - ca.z], y = [b[i].x - cb.x, b[i].y - cb.y, b[i].z - cb.z]; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += w[i] * x[r] * y[c]; }
    const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = M;
    const N = [[Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx], [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz], [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy], [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
    const { vals, vecs } = jacobi4(N); let k = 0; for (let i = 1; i < 4; i++) if (vals[i] > vals[k]) k = i;
    const q = new T.Quaternion(vecs[1][k], vecs[2][k], vecs[3][k], vecs[0][k]).normalize();
    const t = cb.clone().sub(ca.clone().applyQuaternion(q));
    return { q, t };
  }
  function jacobi4(A0) {
    const a = A0.map(r => r.slice()), v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0; for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
      if (off < 1e-20) break;
      for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 4; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    return { vals: [0, 1, 2, 3].map(i => a[i][i]), vecs: v };
  }
  // trilinear sample of a crop distance field at a world point (CT grid of S.red); outside the crop: +Infinity
  function sdfCrop(s, w) {
    const r = S.red, o = r.origin, ax = r.axes, sp = r.sp, dx = w.x - o[0], dy = w.y - o[1], dz = w.z - o[2];
    const fx = (dx * ax[0][0] + dy * ax[0][1] + dz * ax[0][2]) / sp[0] - s.lo[0], fy = (dx * ax[1][0] + dy * ax[1][1] + dz * ax[1][2]) / sp[1] - s.lo[1], fz = (dx * ax[2][0] + dy * ax[2][1] + dz * ax[2][2]) / sp[2] - s.lo[2];
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= s.nx - 1 && fy <= s.ny - 1 && fz <= s.nz - 1)) return Infinity;
    const ix = Math.min(s.nx - 2, Math.floor(fx)), iy = Math.min(s.ny - 2, Math.floor(fy)), iz = Math.min(s.nz - 2, Math.floor(fz));
    const wx = fx - ix, wy = fy - iy, wz = fz - iz, nx = s.nx, nxy = s.nx * s.ny, d = s.d, b = ix + nx * iy + nxy * iz;
    const c00 = d[b] * (1 - wx) + d[b + 1] * wx, c10 = d[b + nx] * (1 - wx) + d[b + nx + 1] * wx, c01 = d[b + nxy] * (1 - wx) + d[b + nxy + 1] * wx, c11 = d[b + nxy + nx] * (1 - wx) + d[b + nxy + nx + 1] * wx;
    return (c00 * (1 - wy) + c10 * wy) * (1 - wz) + (c01 * (1 - wy) + c11 * wy) * wz;
  }
  // one step of point-to-surface ICP: each source point (world) paired with its foot on the surface of dist()
  // keep: the fraction of the closest points used (trimmed ICP); 1 = every point within `trim`
  function icp(src, dist, iters = ITER, trim = TRIM, keep = 1) {
    let q = new T.Quaternion(), t = V(), rms = Infinity, n = 0, max = 0;
    const cur = src.map(p => p.clone()), e = 0.5;
    for (let it = 0; it < iters; it++) {
      let pr = [];
      cur.forEach(p => { const d = dist(p); if (Math.abs(d) < trim) pr.push([p, d]); });
      if (keep < 1 && pr.length) { pr.sort((x, y) => Math.abs(x[1]) - Math.abs(y[1])); pr = pr.slice(0, Math.max(20, Math.round(keep * pr.length))); }
      const a = [], b = [], w = []; let ss = 0; max = 0;
      pr.forEach(([p, d]) => {
        const g = V(dist(V(p.x + e, p.y, p.z)) - dist(V(p.x - e, p.y, p.z)), dist(V(p.x, p.y + e, p.z)) - dist(V(p.x, p.y - e, p.z)), dist(V(p.x, p.y, p.z + e)) - dist(V(p.x, p.y, p.z - e)));
        if (!isFinite(g.x + g.y + g.z) || g.lengthSq() < 1e-12) return;
        g.normalize(); a.push(p); b.push(p.clone().addScaledVector(g, -d)); w.push(1); ss += d * d; if (Math.abs(d) > max) max = Math.abs(d);
      });
      n = a.length; if (n < 20) return null;
      rms = Math.sqrt(ss / n);
      const h = horn(a, b, w);
      cur.forEach(p => p.applyQuaternion(h.q).add(h.t));
      q = h.q.clone().multiply(q); t = t.clone().applyQuaternion(h.q).add(h.t);
      if (2 * Math.acos(Math.min(1, Math.abs(h.q.w))) < 1e-5 && h.t.length() < 1e-4) break;
    }
    return { q, t, rms, n, max };
  }

  // ---------- the template ----------
  const keyOf = () => { const ri = A.roiInfo(); return S.red && ri && ri.bilateral && ri.other && ri.other.length ? ri.other.map(o => o.label).join(',') + '|' + ri.mid + '|' + A.pieces().map(p => p.label).join(',') : ''; };
  function crop(label) {
    const r = S.red, L = A.labels(); let b = [r.nx, r.ny, r.nz, -1, -1, -1];
    for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) if (L[v] === label) { if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k; }
    if (b[3] < 0) return null;
    const pad = Math.ceil(PAD / Math.min(...r.sp)), lo = [0, 1, 2].map(a => Math.max(0, b[a] - pad)), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, b[a + 3] + pad));
    const [nx, ny, nz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), m = new Uint8Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const row = lo[0] + r.nx * (lo[1] + j + r.ny * (lo[2] + k)), o = nx * (j + ny * k); for (let i = 0; i < nx; i++) if (L[row + i] === label) m[o + i] = 1; }
    return { m, lo, nx, ny, nz };
  }
  async function build() {
    const key = keyOf(); if (!key) { tpl = null; render(); return null; }
    if (tpl && tpl.key === key) return tpl;
    const me = job = {}, r = S.red, ri = A.roiInfo(), tib = A.pieces().find(p => p.role === 'tibia'); if (!tib) return null;
    St.busy(true, xl('Karşı taraf aynası hazırlanıyor…')); await St.sleep();
    try {
      const parts = [];
      for (const o of ri.other) {
        const c = crop(o.label); if (!c) continue;
        const net = await St.blurNetsOf(c.m, c.nx, c.ny, c.nz); if (me !== job) return null;
        const P = net.positions, step = Math.max(1, Math.floor(P.length / 3 / 6000)), pts = [];
        for (let i = 0; i < P.length / 3; i += step) { const w = G.worldOf(r, P[3 * i] + c.lo[0], P[3 * i + 1] + c.lo[1], P[3 * i + 2] + c.lo[2]); pts.push(V(...w)); }
        let d = null; const bg = St.bg && St.bg('ank', { op: 'sdf', mask: c.m, nx: c.nx, ny: c.ny, nz: c.nz, sp: r.sp });
        if (bg) try { d = await bg; } catch (e) { /* in the page */ }
        if (!d) { await St.sleep(); d = G.sdf(c.m, c.nx, c.ny, c.nz, r.sp); }
        if (me !== job) return null;
        parts.push({ label: o.label, role: o.role, sdf: { d, lo: c.lo, nx: c.nx, ny: c.ny, nz: c.nz }, pts, net, c });
      }
      const ot = parts.find(p => p.role === 'tibia'); if (!ot) { tpl = null; return null; }
      // the reflection across x = mid (LPS: the sagittal plane between the legs), then the fit on the tibia's distal FIT mm
      const mid = ri.mid, refl = p => V(2 * mid - p.x, p.y, p.z);
      const dTib = w => A.sdfAt(tib, A.toOwn(tib, w));
      // both legs lie in one scan: the same heights are compared. The metaphysis above the fracture's reach (ABOVE..FIT
      // mm over the planned tibia's lowest point) is fitted first, its centroids matched to start; then the whole
      // distal end with the worst 30 % of the points left out (the fracture's missing and displaced pieces)
      const tz = tibZ(tib), all = ot.pts.map(refl);
      const src = all.filter(p => p.z <= tz + FIT && p.z >= tz - 25), srcU = src.filter(p => p.z >= tz + ABOVE);
      const tgtU = []; const pos = tib.mesh.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) { const w = A.toWorld(tib, V(pos[i], pos[i + 1], pos[i + 2])); if (w.z <= tz + FIT && w.z >= tz + ABOVE) tgtU.push(w); }
      const cen = a => a.reduce((s, p) => s.add(p), V()).multiplyScalar(1 / Math.max(1, a.length));
      const t0 = cen(tgtU).sub(cen(srcU)); src.forEach(p => p.add(t0));      // srcU holds the same points
      const fit = icp(srcU, dTib, ITER, 8); if (fit) { src.forEach(p => p.applyQuaternion(fit.q).add(fit.t)); }
      const fit2 = icp(src, dTib, ITER, TRIM, KEEP);
      if (!fit || !fit2) { tpl = null; St.alertMsg(xl('Karşı taraf aynası tibiaya oturtulamadı.')); return null; }
      // the whole map M = R S + t: R = q2 q1, t = R (t0) ... composed from the steps
      const q = fit2.q.clone().multiply(fit.q), t = t0.clone().applyQuaternion(fit.q).add(fit.t).applyQuaternion(fit2.q).add(fit2.t);
      tpl = { key, parts, mid, q, t, rms: fit2.rms, max: fit2.max, n: fit2.n };
      showMesh();
      return tpl;
    } finally { if (me === job) { job = null; St.busy(false); } render(); }
  }
  // the lowest point of the tibia (world, planned position)
  function tibZ(tib) { const pos = tib.mesh.geometry.attributes.position.array; let z = Infinity; for (let i = 2; i < pos.length; i += 3) if (pos[i] < z) z = pos[i]; return z + tib.t.z; }
  // template map: other leg's CT point -> mirrored, fitted world point, and back
  const fwd = (tp, p) => V(2 * tp.mid - p.x, p.y, p.z).applyQuaternion(tp.q).add(tp.t);
  const inv = (tp, w) => { const p = w.clone().sub(tp.t).applyQuaternion(tp.q.clone().invert()); return V(2 * tp.mid - p.x, p.y, p.z); };
  const tplDist = (tp, w) => { const p = inv(tp, w); let d = Infinity; tp.parts.forEach(x => { const s = sdfCrop(x.sdf, p); if (s < d) d = s; }); return d; };

  // ---------- fitting a piece to the template ----------
  async function align(i) {
    const p = A.pieces()[i]; if (!p) return null;
    const tp = await build(); if (!tp) return null;
    const pos = p.mesh.geometry.attributes.position.array, step = Math.max(1, Math.floor(pos.length / 3 / 3000)), src = [];
    for (let k = 0; k < pos.length / 3; k += step) src.push(A.toWorld(p, V(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2])));
    const dist = w => tplDist(tp, w);
    let f1 = icp(src.map(x => x.clone()), dist, ITER, 6);
    if (!f1) return null;
    const mid = src.map(x => x.clone().applyQuaternion(f1.q).add(f1.t));
    const f2 = icp(mid, dist, ITER, TRIM, KEEP); if (!f2) return null;
    const dq = f2.q.clone().multiply(f1.q), dt = f1.t.clone().applyQuaternion(f2.q).add(f2.t);
    // world x' = dq x + dt applied on top of the piece's motion: q' = dq q, t' = dq (c + t) + dt - c
    const q2 = dq.clone().multiply(p.q), t2 = p.c.clone().add(p.t).applyQuaternion(dq).add(dt).sub(p.c);
    A.setMotion(i, t2, q2, true);
    last = { name: p.name, rms: f2.rms, max: f2.max, n: f2.n, moved: dt.length(), ang: 2 * Math.acos(Math.min(1, Math.abs(dq.w))) * 180 / Math.PI };
    render(); return last;
  }

  // ---------- 3D: the template, semi-transparent ----------
  function showMesh() {
    if (!tpl || !shown || !on()) { St.setPart('ankMirror', null, null); St.renderParts(); St.render(); return; }
    const g = new T.Group();
    tpl.parts.forEach(x => {
      const m = St.meshFromNets(x.net, (a, b, c) => { const w = G.worldOf(S.red, a + x.c.lo[0], b + x.c.lo[1], c + x.c.lo[2]); return fwd(tpl, V(...w)).toArray(); }, new T.MeshStandardMaterial({ color: 0x46c98b, transparent: true, opacity: 0.35, depthWrite: false, side: T.DoubleSide }));
      g.add(m);
    });
    St.setPart('ankMirror', xl('Karşı taraf aynası'), g, 0x46c98b); St.renderParts(); St.render();
  }

  // ---------- panel ----------
  function render() {
    const box = $('ankMirror'); if (!box) return;
    if (!on() || !A.pieces().length) { box.innerHTML = ''; return; }
    const ri = A.roiInfo();
    if (!ri || !ri.bilateral || !(ri.other && ri.other.length)) { box.innerHTML = `<p class="hint">${xl('Karşı bacak BT\'de yok; ayna şablonu kullanılamaz. Redüksiyon elle ve eklem ölçüleriyle yapılır.')}</p>`; return; }
    const sel = A.pieces()[A.selected ? A.selected() : -1];
    box.innerHTML = `<p class="hint more">${xl('Sağlam bacağın tibia ve fibulası sagittal düzlemde aynalanıp tibianın distal 60 mm\'sine oturtulur; seçili parça bu aynaya hizalanabilir. Ayna yalnız şablondur; redüksiyon cerrahın kararıdır.')}</p>
      ${tpl ? `<p class="hint">${xl(`Ayna oturması: RMS ${fmt(tpl.rms, 2)} mm, en büyük ${fmt(tpl.max, 1)} mm (${tpl.n} nokta).`)}</p>` : ''}
      <div class="btns"><button id="amShow" aria-pressed="${shown}">${shown ? xl('Aynayı gizle') : xl('Aynayı göster')}</button>
      <button id="amAlign" ${sel && sel.role !== 'out' ? '' : 'disabled'}>${xl('Seçili parçayı aynaya hizala')}</button></div>
      ${last ? `<p class="hint">${xl(`${last.name}: ${fmt(last.moved, 1)} mm ve ${fmt(last.ang, 1)}° taşındı; aynaya RMS ${fmt(last.rms, 2)} mm.`)}</p>` : ''}`;
    $('amShow').addEventListener('click', async () => { shown = !shown; if (shown) await build(); showMesh(); render(); });
    $('amAlign').addEventListener('click', () => { const i = A.selected ? A.selected() : -1; if (i >= 0) align(i); });
  }
  bus.addEventListener('ankPieces', () => { if (tpl && tpl.key !== keyOf()) tpl = null; last = null; showMesh(); render(); });
  bus.addEventListener('caseType', () => { if (!on()) { tpl = null; shown = false; } showMesh(); render(); });
  bus.addEventListener('volume', () => { tpl = null; last = null; });
  bus.addEventListener('changed', () => { if (on()) render(); });
  render();
  return { build, align, template: () => tpl, horn, icp, fwd, inv, tplDist, FIT };
})();
