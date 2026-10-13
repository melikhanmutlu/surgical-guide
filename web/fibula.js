/* Fibula reconstruction in the same case: the defect between the mandible cuts is filled with 1-3 fibula segments
   (planning ported from the first editor), the segments are shown transplanted into the mandible, and a fibula
   cutting guide is generated on the fibula with the same voxel guide builder as the mandible guide.
   The fibula plan is part of the case plan (saved, versioned, undoable) and needs its own surgeon approval. */
'use strict';
window.Fibula = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, G, fmt, bus } = St, $ = id => document.getElementById(id);
  const MIN_LEN = 20, MAX_N = 4, DEV_WARN = 3, ANGLE_WARN = 35, PROX_KEEP = 60, DISTAL_MIN = 60, THR = 250, DBL_GAP = 15;
  // segment length bands (literature: >= 15 mm keeps the periosteal supply, ~20 mm is the usual floor; the segments at the
  // stumps carry the fixation and heal less well, so >= 25 mm there): < SEG_ERR critical, SEG_ERR..MIN_LEN a warning,
  // a stump segment of a multi-segment graft under STUMP_MIN a warning. DEV_TIE: deviations this close count as equal
  const SEG_ERR = 15, STUMP_MIN = 25, DEV_TIE = 0.5;
  const FIB_R = [2.5, 12];                 // mm: slenderest / thickest radius a fibula can have (warning above)
  const FIB_LEN = [120, 500];              // mm: shortest / longest fibula (CT table rails are 800 mm and more)
  const FIB_RATIOS = [0.45, 0.5, 0.4, 0.55, 0.35, 0.6];   // neck / core thickness ratios tried by G.separator
  const GRAFT = [0xe2a33c, 0xc9822a], FGUIDE = St.COLORS.fguide, BONE = St.COLORS.bone;
  const r2d = THREE.MathUtils.radToDeg, deg = THREE.MathUtils.degToRad;
  St.renderer.localClippingEnabled = true;
  St.scene.traverse(o => { if (o.isLight) o.layers.enableAll(); });
  const leg = new THREE.Group(); St.scene.add(leg);          // fibula-side scene, drawn on layer 1 only
  const onLeg = o => { o.traverse(c => c.layers.set(1)); leg.add(o); return o; };
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.6, metalness: 0, side: THREE.DoubleSide }, extra));
  const keepAtLeast = (N, p, h = 0) => new THREE.Plane(N.clone(), -N.dot(p) - h);         // keeps (x-p)·N >= h
  const keepAtMost = (N, p, h = 0) => new THREE.Plane(N.clone().negate(), N.dot(p) - h);   // keeps (x-p)·N <= -h
  let F = null;            // loaded fibula: { source, label, vol, red, labels, cands, c (current candidate) }
  let pending = null;      // stored plan waiting for its DICOM series
  let view = 'm', last = null, grafts = null, guideTimer = null, guideKey = '', building = false;
  const fsel = { joint: null, seg: null, mode: null, first: null };   // selection in the fibula view; bone pick / split mode
  const msg = t => { $('fibMsg').textContent = t || ''; $('fibMsg').hidden = !t; };
  // vOff: graft shift towards the occlusal plane; dbl: double barrel (a second strut stacked dblH mm above);
  // fg / fsc: fibula guide body and screw edits (null = automatic)
  // nAuto: the segment count is still chosen from the defect (pressing a count button takes it over by hand)
  // kerf: the saw blade (bone taken by one cut); slotW: width of the guide's saw slot (null = the kerf, as it was before
  // the two were separate). The slot lies outside each graft face, so the graft keeps its planned length.
  const defaultPlan = () => ({ source: null, cand: null, mirror: 0, n: 2, nAuto: 1, knots: [0.5], yaw: [0, 0, 0], pitch: [0, 0, 0], roll: [0, 0], kerf: 1.0, slotW: null, distal: 70, vOff: 0, dbl: 0, dblH: null, fg: null, fsc: null, ok: false });
  // A segment count is acceptable when every segment is >= minLen and, with two or more segments, the two at the stumps
  // are >= stumpMin (a single segment touches both stumps and no other count makes it longer).
  const lensOk = (lens, minLen = MIN_LEN, stumpMin = STUMP_MIN) => lens.every(x => x >= minLen - 1e-9) && (lens.length < 2 || (lens[0] >= stumpMin - 1e-9 && lens[lens.length - 1] >= stumpMin - 1e-9));
  // Segment count for a defect of length L from a table of candidates [{n, lens, dev}] (one row per count tried):
  // a defect shorter than one segment is one segment (nothing can make it longer); otherwise the fewest segments that
  // are acceptable (lensOk) and follow the defect within devWarn, then the fewest with every segment >= minLen within
  // devWarn (stump segments under stumpMin are then a warning, not a reason to follow the defect worse); if no count
  // reaches the deviation target, the count with the smallest deviation among those with every segment >= minLen
  // (deviations within DEV_TIE count as equal and the fewer segments win), a stump-acceptable count preferred when it is
  // within DEV_TIE of that. A segment under minLen is never traded for a smaller deviation.
  function segmentChoice(table, L, minLen = MIN_LEN, devWarn = DEV_WARN, stumpMin = STUMP_MIN) {
    const rows = table.slice().sort((a, b) => a.n - b.n), okLen = r => lensOk(r.lens, minLen, stumpMin), okMin = r => lensOk(r.lens, minLen, 0);
    const rej = r => ({ n: r.n, dev: r.dev, min: Math.min(...r.lens), stump: r.lens.length > 1 ? Math.min(r.lens[0], r.lens[r.lens.length - 1]) : null });
    if (L < minLen) { const r = rows.find(x => x.n === 1) || rows[0]; return { n: r.n, reason: 'short', dev: r.dev, lens: r.lens }; }
    const good = rows.find(r => okLen(r) && r.dev <= devWarn) || rows.find(r => okMin(r) && r.dev <= devWarn);
    if (good) return { n: good.n, reason: 'dev', dev: good.dev, lens: good.lens, stumpOk: okLen(good), rejected: rows.filter(r => r.n < good.n).map(rej) };
    const leastOf = f => { let m = null; for (const r of rows.filter(f)) if (!m || r.dev < m.dev - DEV_TIE) m = r; return m; };
    const a = leastOf(okLen), b = leastOf(okMin), least = a && (!b || a.dev <= b.dev + DEV_TIE) ? a : b;
    if (least) return { n: least.n, reason: 'len', dev: least.dev, lens: least.lens, stumpOk: okLen(least), rejected: rows.filter(r => !okMin(r)).map(rej) };
    const r = rows.find(x => x.n === 1) || rows[0];
    return { n: r.n, reason: 'short', dev: r.dev, lens: r.lens };
  }
  // try 1..MAX_N segments on the defect D (knots optimised for each) and pick with segmentChoice; the plan's n / knots are set
  function chooseSegments(D) {
    const P0 = plan(), table = [];
    for (let n = 1; n <= MAX_N; n++) {
      if (n > 1 && D.L / n < MIN_LEN - 1) break;                      // more segments can only be shorter
      setN(n); last = compute(D); optimizeKnots(); const c = compute(D);
      table.push({ n, lens: c.segs.filter(g => !g.barrel).map(g => g.L), dev: c.dev, knots: P0.knots.slice() });
    }
    const pick = segmentChoice(table, D.L);
    setN(pick.n); P0.knots = table.find(r => r.n === pick.n).knots;
    S.fib.choice = Object.assign(pick, { L: D.L, table: table.map(r => ({ n: r.n, dev: +r.dev.toFixed(2), min: +Math.min(...r.lens).toFixed(1) })) });
    return pick;
  }

  // ---------- small linear algebra ----------
  function eig3(A) {          // Jacobi; returns [{val, vec:[3]}] sorted by value, descending
    const a = A.map(r => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 50; it++) {
      let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-12) break;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
    return [0, 1, 2].map(i => ({ val: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.val - x.val);
  }

  // ---------- loading and fibula detection ----------
  async function load(kind, files) {
    St.busy(true, 'Fibula BT\'si okunuyor…'); await St.sleep();
    let vol, source, label;
    const ctl = kind === 'sample' ? null : St.startLoad();       // a DICOM / zip read can be cancelled; a newer load replaces it
    try {
      if (kind === 'sample') { vol = await St.readSample('leg'); source = { type: 'sample', name: 'leg', fp: 'sample:leg' }; label = 'Örnek: alt bacak (sentetik BT)'; }
      else { const r = await St.readDicom(files, ctl); if (St.loadStopped(ctl)) return false; if (r.error) { St.busy(false); msg(r.error); return false; } ({ vol, source, label } = r); }
    } catch (e) {
      if (e === St.LOAD_CANCELLED) { St.loadStopped(ctl); return false; }
      St.busy(false); msg('Fibula BT\'si açılamadı: ' + e.message); return false;
    }
    St.busy(true, 'Fibula ayrıştırılıyor…'); await St.sleep();
    const red = G.reduce(vol, 0.8), { labels, comps, count } = G.components(G.threshold(red, THR), red.nx, red.ny, red.nz, 200);
    const top = comps.slice(0, 6), longOf = st => st.filter(c => c.len >= 80 && c.elong >= 3);
    let stats = boneStats(red, labels, top), long = longOf(stats), strict = fibulaCands(long);
    if (!long.length) { St.busy(false); msg('Bu seride uzun kemik (fibula) bulunamadı. Alt bacak BT\'si yükleyin.'); return false; }
    const warn = [];
    // A bone threshold joins tibia, fibula and foot (one piece per leg: the whole lower leg then looks like a 98 mm
    // "fibula"). Cut the thick long pieces at their thin necks; the fibula is the slender piece beside a thicker parallel one.
    const thickAll = long.filter(c => c.rad > FIB_R[1] && c.len >= 150), first = strict, thick = thickAll.length > first.length ? thickAll : [];   // a clean leg CT has as many fibulas as thick pieces
    if (thick.length) {
      St.busy(true, 'Tibia ve fibula ayrılıyor…'); await St.sleep();
      const seps = thick.map(c => ({ c, sepr: G.separator(labels, red.nx, red.ny, red.nz, red.sp, { label: c.label }) }));
      const rest = top.filter(c => !thick.some(t => t.label === c.label));
      const cutAt = ratio => {
        let base = count; const pieces = [];
        seps.forEach(({ c, sepr }) => { sepr.restore(c.label); const ps = sepr.run({ ratio, base, out: labels, minSize: 100 }); base += ps.ids; pieces.push(...ps); });
        stats = boneStats(red, labels, rest.concat(pieces.slice(0, 80)));
        long = longOf(stats); strict = fibulaCands(long);
        return { ratio, n: strict.length };
      };
      let best = null, last = null;
      for (const ratio of FIB_RATIOS) {
        last = cutAt(ratio);
        if (!best || last.n > best.n) best = last;
        if (last.n >= thick.length) break;               // one fibula per leg-like piece
        St.busy(true, 'Tibia ve fibula ayrılıyor…'); await St.sleep();
      }
      if (best.n > first.length) { if (best.ratio !== last.ratio) cutAt(best.ratio); }
      else {
        seps.forEach(({ c, sepr }) => sepr.restore(c.label));         // nothing gained: back to the plain threshold pieces
        stats = boneStats(red, labels, top); long = longOf(stats); strict = first;
        if (!first.length) warn.push('Tibia ve fibula eşik maskesinde birleşik ve otomatik ayrılamadı; aday tüm alt bacak olabilir. Fibula planını kurmadan önce adayın çapını ve uzunluğunu kontrol edin.');
      }
    }
    // fibula candidates: slender long pieces with a thicker parallel piece (tibia) beside them, longest first (arms and ribs are
    // shorter); else the old guess (thinnest long piece)
    let fibs = strict.slice().sort((a, b) => b.len - a.len || a.rad - b.rad);
    if (!fibs.length) {
      fibs = long.slice().sort((a, b) => a.rad - b.rad);
      fibs.forEach(c => { const others = long.filter(o => o !== c && o.rad > c.rad * 1.25); c.tibia = others.sort((a, b) => a.C.distanceTo(c.C) - b.C.distanceTo(c.C))[0] || null; });
      const withT = fibs.filter(c => c.tibia); if (withT.length) fibs = withT;
    }
    F = { source, label, vol, red, labels, cands: fibs, c: null, warn };
    $('fibCand').innerHTML = fibs.map((c, i) => `<option value="${i}" title="Taraf tahminidir">Aday ${i + 1} · ${fmt(c.len, 0)} mm · Ø${fmt(2 * c.rad, 0)} · ${c.C.x > 0 ? 'sol' : 'sağ'}</option>`).join('');
    if (!fibs.some(c => c.rad <= FIB_R[1])) warn.push(`En ince aday bile Ø${fmt(2 * fibs[0].rad, 0)} mm; bu fibula değil, tibia ya da tüm alt bacak. Fibula planı güvenilmez.`);
    St.busy(false); msg(warn[0] || (fibs[0].tibia ? '' : 'Tibia ayırt edilemedi; fibula guide\'ının yanal yönü tahmini.'));
    $('sceneSeg').hidden = false; $('fibBody').hidden = false;
    return true;
  }
  // a fibula is slender (radius ~3-9 mm, never above FIB_R[1]), long, and runs beside a thicker, parallel, comparably long
  // bone (the tibia); `c.tibia` is set on every one that does. Ribs, metatarsals and the like have no such partner.
  function fibulaCands(long) {
    const out = [];
    long.forEach(c => {
      if (c.len < FIB_LEN[0] || c.len > FIB_LEN[1] || c.elong < 5 || c.rad < FIB_R[0] || c.rad > FIB_R[1]) return;
      const near = o => { const d = o.C.clone().sub(c.C); return d.sub(c.ax.clone().multiplyScalar(d.dot(c.ax))).length(); };      // distance between the axes
      const partner = long.filter(o => o !== c && o.rad >= c.rad * 1.3 && o.len >= c.len * 0.6 && Math.abs(o.ax.dot(c.ax)) >= 0.9 && near(o) <= 80).sort((a, b) => near(a) - near(b))[0];
      if (partner) { c.tibia = partner; out.push(c); }
    });
    return out;
  }
  function boneStats(red, labels, comps) {
    const lut = new Int32Array(comps.reduce((m, c) => Math.max(m, c.label), 0) + 1).fill(-1); comps.forEach((c, i) => { lut[c.label] = i; });
    const acc = comps.map(() => ({ n: 0, s: [0, 0, 0], ss: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }));
    const { nx, ny, nz } = red;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const lb = labels[i + nx * (j + ny * k)]; if (lb <= 0 || lb >= lut.length) continue;
      const id = lut[lb]; if (id < 0) continue;
      const w = G.worldOf(red, i, j, k), a = acc[id]; a.n++;
      for (let p = 0; p < 3; p++) { a.s[p] += w[p]; for (let q = 0; q < 3; q++) a.ss[p][q] += w[p] * w[q]; }
    }
    return comps.map((c, id) => {
      const a = acc[id], m = a.s.map(x => x / a.n), cov = a.ss.map((r, p) => r.map((x, q) => x / a.n - m[p] * m[q])), e = eig3(cov);
      const ax = V(...e[0].vec).normalize(); if (ax.z < 0) ax.negate();          // +s runs proximal (superior in LPS)
      return { label: c.label, C: V(...m), ax, elong: Math.sqrt(e[0].val / Math.max(e[1].val, 1e-6)), len: Math.sqrt(12 * e[0].val), rad: 2 * Math.sqrt(e[1].val) };
    });
  }
  // detailed geometry of the chosen fibula: local frame, extent, radius, bending (centre offset per mm), meshes
  function setCandidate(i) {
    const c = F.cands[i], red = F.red, { nx, ny, nz } = red, n = red.hu.length;
    const mask = new Uint8Array(n); for (let v = 0; v < n; v++) if (F.labels[v] === c.label) mask[v] = 1;
    const a = c.ax.clone();
    let e2 = c.tibia ? c.C.clone().sub(c.tibia.C) : V(1, 0, 0);
    e2.sub(a.clone().multiplyScalar(e2.dot(a))); if (e2.lengthSq() < 1e-6) e2 = V(0, 1, 0).sub(a.clone().multiplyScalar(a.y)); e2.normalize();
    const e3 = V().crossVectors(a, e2);
    let smin = Infinity, smax = -Infinity; const pts = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let ii = 0; ii < nx; ii++) {
      if (!mask[ii + nx * (j + ny * k)]) continue;
      const d = V(...G.worldOf(red, ii, j, k)).sub(c.C), s = d.dot(a), y = d.dot(e2), z = d.dot(e3);
      pts.push(s, y, z); if (s < smin) smin = s; if (s > smax) smax = s;
    }
    const nb = Math.ceil(smax - smin) + 1, by = new Float64Array(nb), bz = new Float64Array(nb), bn = new Float64Array(nb);
    for (let p = 0; p < pts.length; p += 3) { const b = Math.floor(pts[p] - smin); by[b] += pts[p + 1]; bz[b] += pts[p + 2]; bn[b]++; }
    const off = Array.from({ length: nb }, (_, b) => (bn[b] > 3 ? [by[b] / bn[b], bz[b] / bn[b]] : null));
    for (let b = 0; b < nb; b++) if (!off[b]) off[b] = off[b - 1] || [0, 0];
    const rads = [];
    for (let p = 0; p < pts.length; p += 3) { const o = off[Math.floor(pts[p] - smin)]; rads.push(Math.hypot(pts[p + 1] - o[0], pts[p + 2] - o[1])); }
    rads.sort((x, y) => x - y);
    const FR = rads[Math.floor(rads.length * 0.9)] + Math.min(...red.sp) / 2;
    const Fm = G.blur(mask, nx, ny, nz), toW = (x, y, z) => G.worldOf(red, x, y, z);
    const geo = St.meshFromNets(G.surfaceNets(Fm, nx, ny, nz), toW, mat(BONE)).geometry;
    let tgeo = null;
    if (c.tibia) { const tm = new Uint8Array(n); for (let v = 0; v < n; v++) if (F.labels[v] === c.tibia.label) tm[v] = 1; tgeo = St.meshFromNets(G.surfaceNets(G.blur(tm, nx, ny, nz), nx, ny, nz), toW, mat(BONE)).geometry; }
    F.c = { i, FC: c.C.clone(), FA: [a, e2, e3], smin, smax, FR, off, mask, Fm, geo, tgeo, centroid: [c.C.x, c.C.y, c.C.z] };
    buildScenes();
  }
  const offAt = s => { const o = F.c.off; return o[Math.min(o.length - 1, Math.max(0, Math.round(s - F.c.smin)))]; };
  const toFib = (s, y = 0, z = 0) => { const [a, b, c] = F.c.FA; return F.c.FC.clone().add(a.clone().multiplyScalar(s)).add(b.clone().multiplyScalar(y)).add(c.clone().multiplyScalar(z)); };
  const onAxis = s => { const o = offAt(s); return toFib(s, o[0], o[1]); };
  const dirFib = v => { const [a, b, c] = F.c.FA; return a.clone().multiplyScalar(v.x).add(b.clone().multiplyScalar(v.y)).add(c.clone().multiplyScalar(v.z)).normalize(); };
  const fibBone = q => St.boneAtIn(F.red, F.c.Fm, q);

  // ---------- defect between the first and last mandible cut ----------
  function defect() {
    const E = S.resMask && St.resEnds(); if (!E) return null;
    const { A, B } = E, r = S.red;
    const dir = B.p.clone().sub(A.p).normalize(), len = B.p.distanceTo(A.p);
    const NA = A.N.clone(), NB = B.N.clone(); if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
    const bw = 1.5, nb = Math.ceil(len / bw) + 2, acc = Array.from({ length: nb }, () => [0, 0, 0, 0]);
    // stump face centres: resected bone within a band behind each cut, the narrowest band (3, 8, 15 mm) that holds bone;
    // a cut through thin or no bone (foramen region, a cut that leaves the bone) still gets a face from the kept bone
    // around the plane, and the condylar end of an open-ended resection is the condyle itself
    const BANDS = [3, 8, 15], ea = BANDS.map(() => [0, 0, 0, 0]), eb = BANDS.map(() => [0, 0, 0, 0]);
    // occlusal direction: patient superior (LPS +z) across the defect line; crest = highest resected bone per bin
    const vup = V(0, 0, 1).sub(dir.clone().multiplyScalar(dir.z)).normalize(), crest = new Float64Array(nb).fill(-Infinity);
    const add = (x, q) => { x[0] += q.x; x[1] += q.y; x[2] += q.z; x[3]++; };
    for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      if (!S.resMask[i + r.nx * (j + r.ny * k)]) continue;
      const q = V(...G.worldOf(r, i, j, k)), t = q.clone().sub(A.p).dot(dir), b = Math.min(nb - 1, Math.max(0, Math.floor(t / bw)));
      add(acc[b], q); const hq = q.dot(vup); if (hq > crest[b]) crest[b] = hq;
      const da = q.clone().sub(A.p).dot(NA) - A.w / 2, db = -(q.clone().sub(B.p).dot(NB)) - B.w / 2;
      BANDS.forEach((w, n) => { if (da < w) add(ea[n], q); if (db < w) add(eb[n], q); });
    }
    const cen = x => V(x[0] / x[3], x[1] / x[3], x[2] / x[3]);
    const firstBand = e => e.find(x => x[3] >= 6) || null;
    // kept bone within `w` mm of the plane around the cut point (the stump face itself), when the resected side has none
    const keptFace = (p, N, w = 3, R = 25) => {
      const c = G.indexOf(r, p.toArray()), rad = r.sp.map(x => Math.ceil(R / x)), x = [0, 0, 0, 0];
      for (let k = Math.max(0, Math.round(c[2]) - rad[2]); k <= Math.min(r.nz - 1, Math.round(c[2]) + rad[2]); k++) for (let j = Math.max(0, Math.round(c[1]) - rad[1]); j <= Math.min(r.ny - 1, Math.round(c[1]) + rad[1]); j++) for (let i = Math.max(0, Math.round(c[0]) - rad[0]); i <= Math.min(r.nx - 1, Math.round(c[0]) + rad[0]); i++) {
        if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
        const q = V(...G.worldOf(r, i, j, k)); if (q.distanceTo(p) > R || Math.abs(q.clone().sub(p).dot(N)) > w) continue;
        add(x, q);
      }
      return x[3] >= 6 ? cen(x) : null;
    };
    const fa = firstBand(ea), fb = firstBand(eb);
    const PA = fa ? cen(fa) : keptFace(A.p, NA), PB = fb ? cen(fb) : B.virtual ? B.p.clone() : keptFace(B.p, NB);
    if (!PA || !PB) return null;
    PA.sub(NA.clone().multiplyScalar(PA.clone().sub(A.p).dot(NA))); PB.sub(NB.clone().multiplyScalar(PB.clone().sub(B.p).dot(NB)));
    let mid = acc.filter(x => x[3] > 4).map(cen).filter(q => q.clone().sub(PA).dot(NA) > 3 && q.clone().sub(PB).dot(NB) < -3);
    mid = mid.map((q, i) => (i > 0 && i < mid.length - 1 ? q.clone().add(mid[i - 1]).add(mid[i + 1]).multiplyScalar(1 / 3) : q));
    // target shape from the healthy side: each point of the defect line is replaced by the mirror image of the bone
    // centre found at its mirrored position (the tumour may have deformed the resected bone)
    let mirrored = 0;
    if (S.fib && S.fib.plan && S.fib.plan.mirror) { const m = mirrorLine(mid); mid = m.pts; mirrored = m.n; }
    // vertical position: the whole line moves along vup; its ends stay in their cut planes
    const vo = (S.fib && S.fib.plan && S.fib.plan.vOff) || 0, inPlane = N => { const w = vup.clone().sub(N.clone().multiplyScalar(vup.dot(N))); return w.multiplyScalar(1 / Math.max(w.dot(vup), 0.3)); };
    if (vo) { PA.addScaledVector(inPlane(NA), vo); PB.addScaledVector(inPlane(NB), vo); mid.forEach(q => q.addScaledVector(vup, vo)); }
    const pts = [PA, ...mid, PB], s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + pts[i].distanceTo(pts[i - 1]));
    for (let b = 1; b < nb; b++) if (crest[b] === -Infinity) crest[b] = crest[b - 1];
    for (let b = nb - 2; b >= 0; b--) if (crest[b] === -Infinity) crest[b] = crest[b + 1];
    const crestAt = q => crest[Math.min(nb - 1, Math.max(0, Math.floor(q.clone().sub(A.p).dot(dir) / bw)))];
    return { pts, s, L: s[s.length - 1], NA, NB, up: S.anchor.n.clone(), vup, crestAt, inPlane, A, B, mirrored, nmid: mid.length };
  }
  // mid-sagittal plane: through the condyles' midpoint, normal along the line between them; without condyles the
  // patient's left-right axis through the centre of the mandible
  function symPlane() {
    const ref = window.Ref && Ref.get && Ref.get(), cR = ref && ref.cond && ref.cond.R, cL = ref && ref.cond && ref.cond.L;
    if (cR && cL) { const a = V(...cR), b = V(...cL); return { p: a.clone().add(b).multiplyScalar(0.5), N: b.clone().sub(a).normalize() }; }
    const r = S.red; let sx = 0, sy = 0, sz = 0, c = 0;
    for (let k = 0; k < r.nz; k += 2) for (let j = 0; j < r.ny; j += 2) for (let i = 0; i < r.nx; i += 2) { const v = i + r.nx * (j + r.ny * k); if (S.mask[v] || (S.resMask && S.resMask[v])) { const w = G.worldOf(r, i, j, k); sx += w[0]; sy += w[1]; sz += w[2]; c++; } }
    return c ? { p: V(sx / c, sy / c, sz / c), N: V(1, 0, 0) } : null;
  }
  function mirrorLine(mid) {
    const P = symPlane(); if (!P || !S.mask) return { pts: mid, n: 0 };
    const refl = q => q.clone().addScaledVector(P.N, -2 * q.clone().sub(P.p).dot(P.N)), r = S.red, R = 9;
    let n = 0;
    const out = mid.map(q => {
      const m = refl(q);
      if (Math.abs(q.clone().sub(P.p).dot(P.N)) < 12) return q;        // at the midline the mirror is the defect itself
      const c = G.indexOf(r, m.toArray()), rad = r.sp.map(x => Math.ceil(R / x)); let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (let k = Math.round(c[2]) - rad[2]; k <= Math.round(c[2]) + rad[2]; k++) for (let j = Math.round(c[1]) - rad[1]; j <= Math.round(c[1]) + rad[1]; j++) for (let i = Math.round(c[0]) - rad[0]; i <= Math.round(c[0]) + rad[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz || !S.mask[i + r.nx * (j + r.ny * k)]) continue;
        const w = G.worldOf(r, i, j, k); if ((w[0] - m.x) ** 2 + (w[1] - m.y) ** 2 + (w[2] - m.z) ** 2 > R * R) continue;
        sx += w[0]; sy += w[1]; sz += w[2]; cnt++;
      }
      if (cnt < 20) return q;
      n++; return refl(V(sx / cnt, sy / cnt, sz / cnt));
    });
    return { pts: out.map((q, i) => (i > 0 && i < out.length - 1 ? q.clone().add(out[i - 1]).add(out[i + 1]).multiplyScalar(1 / 3) : q)), n };
  }
  // while a mandible cut is dragged: move the graft ends into the cut planes as they are now (the resected piece is
  // rebuilt on release, then the full plan follows)
  let liveRaf = 0;
  function livePlanes() {
    if (!active() || !last || S.restoring || liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      const E = St.resEnds(); if (!E || E.condyle) return;
      const D0 = last.D, dir = E.B.p.clone().sub(E.A.p).normalize();
      const NA = E.A.N.clone(), NB = E.B.N.clone(); if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
      const onPlane = (q, p, N) => q.clone().addScaledVector(N, p.clone().sub(q).dot(N));
      const PA = onPlane(D0.pts[0], E.A.p, NA), PB = onPlane(D0.pts[D0.pts.length - 1], E.B.p, NB);
      const mid = D0.pts.slice(1, -1).filter(q => q.clone().sub(PA).dot(NA) > 3 && q.clone().sub(PB).dot(NB) < -3);
      const pts = [PA, ...mid, PB], sArr = [0];
      for (let i = 1; i < pts.length; i++) sArr.push(sArr[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const D = Object.assign({}, D0, { pts, s: sArr, L: sArr[sArr.length - 1], NA, NB, A: E.A, B: E.B });
      try { const c = compute(D); draw(c); syncOutputs(); } catch (e) { /* the full update on release redraws */ }
    });
  }
  function at(D, x) {
    const s = D.s; x = Math.min(Math.max(x, 0), D.L);
    let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m; else hi = m; }
    return D.pts[lo].clone().lerp(D.pts[hi], (x - s[lo]) / ((s[hi] - s[lo]) || 1));
  }
  function deviation(D, k) {
    let dev = 0;
    for (let i = 0; i < k.length - 1; i++) {
      const A = at(D, k[i]), d = at(D, k[i + 1]).sub(A).normalize();
      for (let j = 1; j < 30; j++) { const p = at(D, k[i] + (k[i + 1] - k[i]) * j / 30).sub(A); dev = Math.max(dev, p.sub(d.clone().multiplyScalar(p.dot(d))).length()); }
    }
    return dev;
  }

  // ---------- segment plan (same rules as the first editor) ----------
  function compute(D) {
    const P0 = plan(), n = P0.n, k = [0, ...P0.knots.map(f => f * D.L), D.L], P = k.map(x => at(D, x)), d = [];
    for (let i = 0; i < n; i++) d.push(P[i + 1].clone().sub(P[i]).normalize());
    const normals = [];
    for (let j = 0; j <= n; j++) {
      if (j === 0) { normals.push(D.NA.clone()); continue; }
      if (j === n) { normals.push(D.NB.clone()); continue; }
      const nrm = d[j - 1].clone().add(d[j]).normalize().applyAxisAngle(D.up, deg(P0.yaw[j] || 0));
      const h = V().crossVectors(D.up, nrm); if (h.lengthSq() > 1e-8) nrm.applyAxisAngle(h.normalize(), deg(P0.pitch[j] || 0));
      normals.push(nrm.normalize());
    }
    const segs = [], FR = F.c.FR, tilt = v => Math.hypot(v.y, v.z) / Math.max(Math.abs(v.x), 1e-3);
    let cursor = F.c.smin + P0.distal, prevEnd = null;
    for (let i = 0; i < n; i++) {
      const x = d[i], b = D.up.clone().sub(x.clone().multiplyScalar(D.up.dot(x))).normalize().applyAxisAngle(x, deg(P0.roll[i] || 0)), z = V().crossVectors(x, b);
      const loc = v => V(v.dot(x), v.dot(b), v.dot(z)), n0 = loc(normals[i]), n1 = loc(normals[i + 1]);
      if (prevEnd) cursor += slotOf(P0) + 1 + FR * (tilt(prevEnd) + tilt(n0));
      const L = P[i + 1].distanceTo(P[i]);
      segs.push({ i, L, s0: cursor, s1: cursor + L, x, b, z, n0, n1, P0: P[i], P1: P[i + 1], N0: normals[i], N1: normals[i + 1], barrel: 0,
        a0: r2d(Math.acos(Math.min(1, Math.abs(n0.x)))), a1: r2d(Math.acos(Math.min(1, Math.abs(n1.x)))) });
      cursor += L; prevEnd = n1;
    }
    // double barrel: one straight strut dblH above the lower one, cut to the same mandible planes; a short piece
    // (DBL_GAP) is taken out between the barrels on the fibula so the graft can fold on its periosteum
    if (P0.dbl) {
      const h = dblH(), U0 = P[0].clone().addScaledVector(D.inPlane(D.NA), h), U1 = P[n].clone().addScaledVector(D.inPlane(D.NB), h);
      const x = U1.clone().sub(U0).normalize(), b = D.up.clone().sub(x.clone().multiplyScalar(D.up.dot(x))).normalize(), z = V().crossVectors(x, b);
      const loc = v => V(v.dot(x), v.dot(b), v.dot(z)), n0 = loc(D.NA), n1 = loc(D.NB), L = U0.distanceTo(U1);
      cursor += slotOf(P0) + 1 + FR * (tilt(prevEnd) + tilt(n0)) + DBL_GAP;
      segs.push({ i: n, L, s0: cursor, s1: cursor + L, x, b, z, n0, n1, P0: U0, P1: U1, N0: D.NA, N1: D.NB, barrel: 1,
        a0: r2d(Math.acos(Math.min(1, Math.abs(n0.x)))), a1: r2d(Math.acos(Math.min(1, Math.abs(n1.x)))) });
      cursor += L;
    }
    // fibula -> mandible transform of each segment (the graft meshes and graftBone use it)
    const [fa, fe2, fe3] = F.c.FA, FT = new THREE.Matrix4().makeBasis(fa, fe2, fe3).transpose(), FC = F.c.FC;
    segs.forEach(g => {
      const o = offAt((g.s0 + g.s1) / 2);
      g.M = new THREE.Matrix4().makeTranslation(g.P0.x, g.P0.y, g.P0.z).multiply(new THREE.Matrix4().makeBasis(g.x, g.b, g.z))
        .multiply(new THREE.Matrix4().makeTranslation(-g.s0, -o[0], -o[1])).multiply(FT).multiply(new THREE.Matrix4().makeTranslation(-FC.x, -FC.y, -FC.z));
      g.Minv = g.M.clone().invert();
      // graft top relative to the original alveolar crest at the segment middle (negative = below the crest)
      const m = g.P0.clone().lerp(g.P1, 0.5); g.crest = m.dot(D.vup) + FR - D.crestAt(m);
    });
    return { k, P, normals, segs, dev: deviation(D, k), proxLeft: F.c.smax - cursor, used: cursor - (F.c.smin + P0.distal), D };
  }
  const plan = () => S.fib.plan;
  const dblH = () => plan().dblH || Math.round((2 * F.c.FR + 1) * 2) / 2;
  // is world point q (mandible side) inside graft segment i?
  function graftBone(i, q) {
    const g = last && last.segs[i]; if (!g) return false;
    if (q.clone().sub(g.P0).dot(g.N0) < 0 || q.clone().sub(g.P1).dot(g.N1) > 0) return false;
    return fibBone(q.clone().applyMatrix4(g.Minv));
  }
  // approval is tied to what the surgeon decided (fibula parameters + mandible cuts), not to derived numbers; a cut's
  // point within its plane (pv / pn, a cut turned with the bone) moves the defect's end, so it counts when it is set
  const r3 = x => Math.round(x * 1000) / 1000;
  const sig = () => { const { ok, by, at, sig: _s, ...p } = plan(); const a = [p, S.planes.map(q => (q.pv || q.pn ? [q.off, q.yaw, q.pitch, q.w, q.pv || 0, q.pn || 0] : [q.off, q.yaw, q.pitch, q.w])), S.anchor ? [S.anchor.p, S.anchor.n].map(v => [v.x, v.y, v.z].map(r3)) : null,
    // the defect also depends on the condyle (condylar resection) and on the bone mask itself
    S.lesion.condyle || null, S.lesion.condyle && window.Ref && Ref.get() ? Ref.get().cond[S.lesion.condyle] || null : null,
    document.getElementById('thr').value, window.SegEdit ? SegEdit.key() : ''];
    // condylar resection: the graft's condylar end lies `neo` mm short of the fossa (web/condyle.js), so the defect and the
    // segments follow that distance; appended only then, so the signature of every other plan is unchanged
    if (S.lesion.condyle && window.Condyle && Condyle.neoOffset) a.push(['neo', r3(Condyle.neoOffset())]);
    return JSON.stringify(a); };

  // ---------- scenes ----------
  function clearLeg() { while (leg.children.length) { const c = leg.children.pop(); c.traverse(o => { if (o.material) o.material.dispose(); if (o.geometry && o.geometry !== F?.c?.geo && o.geometry !== F?.c?.tgeo) o.geometry.dispose(); }); } }
  function buildScenes() {
    clearLeg();
    grafts = new THREE.Group();
    St.setPart('grafts', 'Fibula greftleri', grafts, GRAFT[0]);
    const fm = onLeg(new THREE.Mesh(F.c.geo, mat(BONE, { transparent: true, opacity: 0.3, depthWrite: false }))); fm.userData.keep = true; fm.userData.bone = 'fib';
    if (F.c.tgeo) { const tm = onLeg(new THREE.Mesh(F.c.tgeo, mat(BONE, { transparent: true, opacity: 0.12, depthWrite: false }))); tm.userData.keep = true; tm.userData.bone = 'tib'; }
  }
  function disc(center, normal, r, color, opacity) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    m.position.copy(center); m.quaternion.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize()); return m;
  }
  function draw(c) {
    // mandible side: each segment moved from the fibula into the defect
    while (grafts.children.length) { const m = grafts.children.pop(); m.material.dispose(); }
    for (let i = leg.children.length - 1; i >= 0; i--) { const o = leg.children[i]; if (!o.userData.keep && !o.userData.guide) { leg.remove(o); o.material.dispose(); if (o.geometry !== F.c.geo) o.geometry.dispose(); } }
    if (!c) { St.render(); return; }
    c.segs.forEach((g, i) => {
      const o = offAt((g.s0 + g.s1) / 2);
      const m = new THREE.Mesh(F.c.geo, mat(GRAFT[i % 2], { clippingPlanes: [keepAtLeast(g.N0, g.P0), keepAtMost(g.N1, g.P1)] }));
      m.matrixAutoUpdate = false; m.matrix.copy(g.M); m.matrixWorldNeedsUpdate = true; m.userData.seg = i; grafts.add(m);
      // fibula side: the same segment in the leg, plus the cut discs
      const w0 = dirFib(g.n0), w1 = dirFib(g.n1), p0 = toFib(g.s0, o[0], o[1]), p1 = toFib(g.s1, o[0], o[1]);
      onLeg(new THREE.Mesh(F.c.geo, mat(GRAFT[i % 2], { emissive: fsel.seg === i ? 0x332200 : 0, clippingPlanes: [keepAtLeast(w0, p0), keepAtMost(w1, p1)] }))).userData.legSeg = i;
      // cut discs: joint j between segment j-1 and j; joint 0 and n are the mandible's own cuts
      const j0 = g.barrel ? -1 : i, j1 = g.barrel ? -2 : i + 1;
      [[p0, w0, j0], [p1, w1, j1]].forEach(([pp, ww, j]) => { const d = onLeg(disc(pp, ww, F.c.FR + 8, 0xe0533d, fsel.joint === j ? 0.5 : 0.2)); d.userData.disc = true; d.userData.joint = j; d.userData.seg = i; });
    });
    St.applyExplode(); St.render();
  }
  // view: 'm' mandible, 'f' fibula, 's' both side by side (mandible left, fibula right)
  function fitLeg(cam, ctl) {
    const box = new THREE.Box3(); leg.children.filter(o => o.userData.disc || o.userData.guide).forEach(o => box.expandByObject(o));
    if (box.isEmpty()) box.setFromObject(leg);
    const ctr = box.getCenter(V()), r = Math.max(30, box.getSize(V()).length() / 2);
    const dir = F.c.FA[1].clone().add(F.c.FA[2].clone().multiplyScalar(0.4)).normalize();
    ctl.target.copy(ctr); cam.position.copy(ctr).add(dir.multiplyScalar(r / Math.sin(deg(cam.fov) / 2) * 1.1)); ctl.update();
  }
  function setView(v) {
    view = v;
    St.setSplit(v === 's');
    if (v !== 's') St.camera.layers.set(v === 'f' ? 1 : 0);
    if (St.syncGizmo) St.syncGizmo();
    $('scM').setAttribute('aria-pressed', v === 'm'); $('scF').setAttribute('aria-pressed', v === 'f'); $('scS').setAttribute('aria-pressed', v === 's');
    $('fibView').textContent = v === 'f' ? 'Mandibulayı göster' : 'Fibulayı göster';
    if (v === 'f' && F && F.c) fitLeg(St.camera, St.controls);
    else if (v === 's' && F && F.c) { fitLeg(St.camF, St.ctlF); if (St.parts.bone) St.fitTo(St.parts.bone.obj); }
    else if (v === 'm' && St.parts.bone) St.fitTo(St.parts.bone.obj);
    St.updateMarkers(); St.render();
  }

  // ---------- fibula guide ----------
  function guideCtx(c) {
    const FR = F.c.FR, [u] = F.c.FA;
    const sA = c.segs[0].s0, sB = c.segs[c.segs.length - 1].s1, sm = (sA + sB) / 2, om = offAt(sm);
    const n = F.c.FA[1].clone();
    let Pg = null; const top = toFib(sm, om[0], om[1]).add(n.clone().multiplyScalar(FR + 15));
    for (let t = 0; t < FR + 30; t += 0.2) { const q = top.clone().add(n.clone().multiplyScalar(-t)); if (fibBone(q)) { Pg = q; break; } }
    if (!Pg) return null;
    const v = V().crossVectors(n, u).normalize();
    const g = guideBody(c);
    const pls = slotPlanes(c);
    // screws: position along the segment and angle around the fibula axis are editable (fsc); without edits they are
    // placed by autoScrews (two on a segment of STUMP_MIN mm or more, at least three on the guide, clear of every slot)
    const fsc = guideScrews(c);
    const scs = fsc.map(f => { const st = screwAt(c, f); return { sc: { d: f.d, D: f.D, sleeveH: f.sleeveH, len: f.len }, dir: st.dir, entry: st.entry }; });
    return { g, P: Pg, u: u.clone(), v, n, pls, scs, fsc, bone: fibBone, field: q => St.fieldAt(F.red, F.c.Fm, [q.x, q.y, q.z]) };
  }
  // effective slot width: the plan's slot (never narrower than the blade), else the blade itself (the old single value)
  const slotOf = P0 => Math.max(P0.kerf, P0.slotW == null ? P0.kerf : P0.slotW);
  // saw slots of the fibula guide: one outside each graft face (p = the face, pSlot = the slot centre, w = slot width);
  // the guide and the production STL open the slot at pSlot, the screw checks measure the distance to the cut at p
  function slotPlanes(c) {
    const u = F.c.FA[0], sw = slotOf(plan()), out = [];
    c.segs.forEach(sg => {
      const o = offAt((sg.s0 + sg.s1) / 2);
      [[sg.s0, sg.n0, -1], [sg.s1, sg.n1, 1]].forEach(([s, nl, side]) => {
        const N = dirFib(nl); if (N.dot(u) < 0) N.negate();
        const p = toFib(s, o[0], o[1]);
        out.push({ p, pSlot: p.clone().add(N.clone().multiplyScalar(side * sw / 2)), N, w: sw });
      });
    });
    return out;
  }
  // a guide screw on the fibula: the point at `off` mm from the segment middle, the drill along -n turned `ang` degrees
  // about the fibula axis, the bone entry found by a ray from above
  function screwAt(c, f) {
    const sg = c.segs[f.seg], FR = F.c.FR, [u] = F.c.FA, n = F.c.FA[1], half = Math.max(0, sg.L / 2 - 3);
    const s = (sg.s0 + sg.s1) / 2 + Math.max(-half, Math.min(half, f.off)), o = offAt(s);
    const out = n.clone().applyAxisAngle(u, deg(f.ang)), dir = out.clone().negate();
    const t0 = toFib(s, o[0], o[1]).add(out.clone().multiplyScalar(FR + 15)); let entry = null;
    for (let t = 0; t < FR + 30; t += 0.2) { const q = t0.clone().add(dir.clone().multiplyScalar(t)); if (fibBone(q)) { entry = q; break; } }
    return { s, dir, entry, axis: toFib(s, o[0], o[1]) };
  }
  // The rules a fibula guide screw is placed by (the same as the mandible guide's): the sleeve stands on the guide
  // body (entry inside the body width, no deeper below the bone's top than the wrap), the drill enters bone and stays
  // in it for SCREW_MIN_DEPTH mm, the sleeve keeps SCREW_SLOT_GAP mm from every saw slot along the whole hole, and a
  // hole SCREW_CUT_GAP mm or more from the cut scores better (bone bridge between the hole and the osteotomy).
  const SCREW_MIN_DEPTH = 4, SCREW_SLOT_GAP = 2, SCREW_CUT_GAP = 5, SCREW_CUT_WARN = 3, SLOT_REACH = 45, SCREW_TIGHT_GAP = 0.5;
  function screwSite(c, f, pls, body, minGap = SCREW_SLOT_GAP) {
    const st = screwAt(c, f); if (!st.entry) return null;
    const { entry, dir } = st, n = F.c.FA[1], v = V().crossVectors(n, F.c.FA[0]).normalize(), cw = body.clear + body.wall;
    // the sleeve on the body: across the guide inside its width; below the top of the bone at most the wrap
    const top = screwAt(c, Object.assign({}, f, { ang: 0 })).entry;
    if (Math.abs(entry.clone().sub(st.axis).dot(v)) + f.D / 2 > body.W / 2 - 0.5) return null;
    if (top && top.clone().sub(entry).dot(n) > body.wrap - 0.5) return null;
    let inBone = 0, slotGap = Infinity, cutGap = Infinity; const q = V(), d = V();
    for (let t = -(cw + f.sleeveH); t <= f.len + 1e-9; t += 0.25) {
      q.copy(entry).addScaledVector(dir, t);
      const bone = t >= 0 && fibBone(q); if (bone) inBone += 0.25;
      for (const pw of pls) {
        d.copy(q).sub(pw.pSlot); const a = d.dot(pw.N); if (d.lengthSq() - a * a > SLOT_REACH * SLOT_REACH) continue;
        slotGap = Math.min(slotGap, Math.abs(a) - pw.w / 2 - f.D / 2);
        if (bone) { const b = Math.abs(q.clone().sub(pw.p).dot(pw.N)) - f.d / 2; if (b < cutGap) cutGap = b; }
      }
    }
    if (inBone < SCREW_MIN_DEPTH || slotGap < minGap) return null;
    return { s: st.s, inBone, slotGap, cutGap, score: Math.min(slotGap, 6) + 0.6 * Math.min(cutGap, SCREW_CUT_GAP + 3) + 0.1 * Math.min(inBone, f.len) - 0.04 * Math.abs(f.ang) };
  }
  // Automatic guide screws: two on a segment of STUMP_MIN mm or more, one on a shorter one, at least three on the guide
  // (extra ones on the longest segments); each placed on the best site that keeps the rules above, searched along the
  // segment and around the fibula axis. A segment with no such site keeps a screw at its middle, which the checks report.
  let autoKey = '', autoVal = null;
  function autoScrews(c) {
    const body = guideBody(c), pls = slotPlanes(c);
    const key = JSON.stringify([F.c.i, body.W, body.wrap, body.wall, body.clear, pls.map(p => [p.pSlot.toArray(), p.N.toArray(), p.w].flat().map(x => Math.round(x * 100)))]);
    if (key === autoKey && autoVal) return autoVal.map(f => Object.assign({}, f));
    const lower = c.segs, want = lower.map(g => (g.L >= STUMP_MIN ? 2 : 1));
    for (let tot = want.reduce((a, b) => a + b, 0); tot < 3; tot++) { const i = lower.map((g, k) => [g.L / (want[k] + 1), k]).sort((a, b) => b[0] - a[0])[0][1]; want[i]++; }
    const out = [], segSites = [], picks = [];
    // the next screw on segment i: best score, kept sep mm from the ones already there, a little bonus for spreading out
    const next = (i, sep) => {
      const sg = lower[i], pick = picks[i]; let best = null, bs = -Infinity;
      for (const st of segSites[i]) {
        if (pick.some(p => Math.abs(p.s - st.s) < sep)) continue;
        const spread = pick.length ? Math.min(...pick.map(p => Math.abs(p.s - st.s))) : 0, sc = st.score + 0.08 * Math.min(spread, sg.L / 2);
        if (sc > bs) { bs = sc; best = st; }
      }
      if (best) pick.push(best);
      return !!best;
    };
    lower.forEach((sg, i) => {
      const base = screwDefault(i), half = Math.max(0, sg.L / 2 - 3), sites = [];
      for (let off = -half; off <= half + 1e-9; off += 1) for (const ang of [0, -10, 10, -20, 20, -30, 30]) {
        const f = Object.assign({}, base, { off: +off.toFixed(1), ang }), r = screwSite(c, f, pls, body);
        if (r) sites.push(Object.assign(r, { f }));
      }
      sites.sort((a, b) => b.score - a.score);
      segSites.push(sites); picks.push([]);
      for (let k = 0; k < want[i]; k++) if (!next(i, base.D + 3)) break;
    });
    // fewer than three on the guide: add where a site is still free, first at the usual spacing, then sleeves 1 mm apart
    for (const sep of [screwDefault(0).D + 3, screwDefault(0).D + 1]) {
      let tot = picks.reduce((a, p) => a + p.length, 0);
      for (const i of lower.map((g, k) => k).sort((a, b) => lower[b].L / (picks[b].length + 1) - lower[a].L / (picks[a].length + 1))) {
        while (tot < 3 && next(i, sep)) tot++;
      }
    }
    // a segment with no site gets no screw (a drill path through a slot would be worse than none); the checks name it.
    // Only when no segment has a site at all, each segment keeps its best site that is at least on bone and clear of the
    // slots by SCREW_TIGHT_GAP (closer than the rule, flagged for the surgeon to check or move by hand); none if not even that.
    const anyPick = picks.some(p => p.length);
    lower.forEach((sg, i) => {
      if (!picks[i].length && !anyPick) {
        const base = screwDefault(i), half = Math.max(0, sg.L / 2 - 3); let best = null;
        for (let off = -half; off <= half + 1e-9; off += 1) for (const ang of [0, -10, 10, -20, 20, -30, 30]) {
          const f = Object.assign({}, base, { off: +off.toFixed(1), ang }), r = screwSite(c, f, pls, body, SCREW_TIGHT_GAP);
          if (r && (!best || r.slotGap > best.slotGap + 1e-9)) best = Object.assign(r, { f });
        }
        if (best) out.push(Object.assign({}, best.f, { auto: 1, none: 1 }));
      }
      picks[i].sort((a, b) => a.s - b.s).forEach(p => out.push(Object.assign({}, p.f, { auto: 1 })));
    });
    autoKey = key; autoVal = out;
    return out.map(f => Object.assign({}, f));
  }
  // fibula guide body: automatic values unless the plan overrides them (fg); the material profile's fit and the
  // periosteum allowance follow the mandible guide
  // Size the guide from the bone where it sits. FR (90th-percentile radius of the whole candidate) also counts the wider
  // head and any tibia stump, so a guide sized from it stands clear of a slender shaft: the bridge strip floats free of
  // the shell (several bodies) and the wrap runs past the shaft's widest level (an undercut, no direction to seat it).
  // Cross-sections every few mm over the guide span: half-width across the guide, and the depth from the top of the
  // bone down to its widest level (the deepest wrap that stays undercut-free), worst case over the span.
  let secKey = '', secVal = null;
  function localSection(sA, sB) {
    const key = F.c.i + '|' + sA.toFixed(1) + '|' + sB.toFixed(1) + '|' + F.c.FR.toFixed(2);
    if (key === secKey) return secVal;
    const R0 = F.c.FR + 4, st = 0.5, q = V(), [a, e2, e3] = F.c.FA, base = F.c.FC, step = Math.max(2, (sB - sA) / 12);
    let half = 0, depth = Infinity;
    for (let s = sA; s <= sB + 1e-6; s += step) {
      const o = offAt(s), wid = []; let maxW = 0, topY = -Infinity;
      for (let y = -R0; y <= R0; y += st) {
        let z0 = Infinity, z1 = -Infinity;
        for (let z = -R0; z <= R0; z += st) {
          q.copy(base).addScaledVector(a, s).addScaledVector(e2, o[0] + y).addScaledVector(e3, o[1] + z);
          if (fibBone(q)) { if (z < z0) z0 = z; if (z > z1) z1 = z; }
        }
        const w = z1 >= z0 ? z1 - z0 + st : 0; wid.push([y, w]); if (w > maxW) maxW = w; if (w > 0 && y > topY) topY = y;
      }
      if (maxW <= 0) continue;
      // widest level = middle of the levels within 3 % of the maximum width (a round section is flat at its equator)
      const eq = wid.filter(([, w]) => w >= 0.97 * maxW).map(([y]) => y), yEq = eq.reduce((x, y) => x + y, 0) / eq.length;
      half = Math.max(half, maxW / 2); depth = Math.min(depth, topY - yEq);
    }
    secKey = key; secVal = half > 0 ? { half, depth } : null;
    return secVal;
  }
  function guideAuto(c) {
    const FR = F.c.FR, sA = c.segs[0].s0, sB = c.segs[c.segs.length - 1].s1, sec = localSection(sA, sB), Rl = sec ? Math.min(FR, sec.half) : FR, dp = sec ? Math.min(FR, sec.depth) : FR;
    return { span: sB - sA, Lm: 8, W: Math.round(2 * (Rl + 2.8) + 2), wrap: Math.max(2, Math.round(dp * 0.8 * 2) / 2), wall: 2.5, clear: S.g.clear };
  }
  // The body runs Lm past the outer cuts, and further where a slot is oblique: a slot tilted across the guide runs
  // diagonally over the body, (W/2 |N·v| + depth |N·n|) / |N·u| mm along it on each side of its centre. A body that
  // ends before the slot leaves the corner past it held by nothing (the rib runs along one edge only): a loose piece
  // and a slot open on one side. Each end is taken past the farthest point of every slot by SLOT_END mm; the body
  // centre moves with it (uc, relative to the middle of the segments).
  const SLOT_END = 3, SLOT_END_MAX = 30;
  function guideBody(c) {
    const a = guideAuto(c), e = Object.assign({}, a, plan().fg || {});
    const sA = c.segs[0].s0, sB = c.segs[c.segs.length - 1].s1, sm = (sA + sB) / 2, FR = F.c.FR, [ax, n] = F.c.FA, v = V().crossVectors(n, ax).normalize();
    const cw = e.clear + (S.g.peri || 0) + e.wall, dn = [FR - e.wrap - 1, FR + cw + 0.5], dv = e.W / 2 + 0.5;
    let lo = sA - e.Lm, hi = sB + e.Lm;
    slotPlanes(c).forEach(pw => {
      const nu = pw.N.dot(ax), nv = pw.N.dot(v), nn = pw.N.dot(n); if (Math.abs(nu) < 0.1) return;
      // the slot centre lies on the bone axis; the body's cross-section corners around it (across: +-W/2, along n: from
      // the wrap line to the top of the shell)
      const sc = pw.pSlot.clone().sub(F.c.FC).dot(ax), half = pw.w / 2 / Math.abs(nu);
      for (const dV of [-dv, dv]) for (const dN of dn) {
        const s = sc - (nv * dV + nn * dN) / nu;
        lo = Math.min(lo, s - half - SLOT_END); hi = Math.max(hi, s + half + SLOT_END);
      }
    });
    // at most SLOT_END_MAX past the outer cut (a nearly lengthwise slot would need the whole leg; buildFibGuide then puts
    // the rib on the edge the slot cuts off) and never past the ends of the bone
    lo = Math.max(lo, sA - Math.max(e.Lm, SLOT_END_MAX), F.c.smin - 4); hi = Math.min(hi, sB + Math.max(e.Lm, SLOT_END_MAX), F.c.smax + 4);
    const L = Math.round(hi - lo), uc = +((lo + hi) / 2 - sm).toFixed(2);
    return { rot: 0, L, uc, W: e.W, wrap: e.wrap, wall: e.wall, clear: e.clear, bridge: 4, side: 1, peri: S.g.peri || 0, fit: S.g.fit || 0 };
  }
  const screwDefault = (seg) => ({ seg, off: 0, ang: 0, d: 2.0, D: 5, sleeveH: 5, len: Math.round(2 * F.c.FR) });
  function guideScrews(c) {
    const list = plan().fsc || autoScrews(c);
    return list.map(f => Object.assign(screwDefault(0), f, { seg: Math.min(c.segs.length - 1, Math.max(0, f.seg | 0)) }));
  }
  function scheduleGuide() {
    clearTimeout(guideTimer);
    guideTimer = setTimeout(buildFibGuide, 450);
  }
  async function buildFibGuide() {
    if (!active() || !last || building) { if (building) scheduleGuide(); return; }
    const ctx = guideCtx(last); S.fib.guideFail = !ctx; if (!ctx) { S.fib.guide = null; St.updatePanels(); return; }
    const key = JSON.stringify([ctx.g, ctx.pls.map(p => [p.p.toArray(), p.N.toArray(), p.w].flat().map(x => Math.round(x * 100))), ctx.scs.map(s => s.entry && s.entry.toArray().map(x => Math.round(x * 100)))]);
    if (key === guideKey && S.fib.guide) return;
    building = true;
    St.busy(true, 'Fibula guide\'ı üretiliyor…'); await St.sleep();
    try {
      let out = await St.buildGuide(ctx), adapt = null, flip = false;
      // a guide that splits or cannot be put on: the rib (bridge) on the other edge first (a corner cut off by an oblique
      // slot on one edge is held by a rib on that edge), then shallower wraps half a mm at a time (the section is not
      // round, the bone bends under the guide); a wrap set by hand (fg.wrap) is left alone. The best build is kept:
      // fewest pieces, then one that can be put on.
      const bad = R => R.pieces > 1 || (R.seat && R.seat.ok && !R.seat.free), w0 = ctx.g.wrap;
      const rank = R => R.pieces * 2 + (R.seat && R.seat.ok && !R.seat.free ? 1 : 0);
      const tryG = async g => { const o2 = await St.buildGuide(Object.assign({}, ctx, { g })); if (rank(o2.result) < rank(out.result)) { out.mesh.geometry.dispose(); out = o2; ctx.g = g; return true; } o2.mesh.geometry.dispose(); return false; };
      if (bad(out.result)) flip = await tryG(Object.assign({}, ctx.g, { side: -ctx.g.side }));
      if (bad(out.result) && !(plan().fg && plan().fg.wrap != null)) {
        const g0 = ctx.g; let lowest = null;
        for (let w = w0 - 0.5; w >= 2 && bad(out.result); w -= 0.5) { lowest = w; if (await tryG(Object.assign({}, g0, { wrap: w }))) adapt = w; }
        if (lowest !== null) out.result.adapt = { from: w0, to: adapt == null ? lowest : adapt, ok: !bad(out.result) };
      }
      if (flip) out.result.sideFlip = true;
      leg.children.filter(o => o.userData.guide).forEach(o => { leg.remove(o); St.mat && o.material.dispose(); o.geometry.dispose(); });
      out.mesh.material = mat(FGUIDE); out.mesh.userData.guide = true; onLeg(out.mesh); St.simplifyMesh(out.mesh);
      S.fib.guide = { mesh: out.mesh, result: out.result, ctx, key, grid: out.grid }; guideKey = key;
    } finally { building = false; St.busy(false); }
    renderStep(); St.updatePanels(); St.render(); St.emit('fibGuide');
  }

  // ---------- checks, UI ----------
  function checks() {
    if (!active()) return [];
    const out = [], P0 = plan(), c = last;
    // the fibula itself: thick = tibia / whole lower leg, not a fibula
    if (F.c && F.c.FR > FIB_R[1]) out.push(['warn', 'Uyarı', `Seçili fibula yarıçapı ${fmt(F.c.FR, 1)} mm (en çok ${FIB_R[1]} mm beklenir); tibia ya da ayak kemikleri fibulaya karışmış olabilir. Başka bir aday seçin ya da BT'yi kontrol edin.`, 'fib']);
    if (F.warn) F.warn.forEach(t => out.push(['warn', 'Uyarı', t, 'fib']));
    if (!c) {
      const miss = St.cutMisses ? St.cutMisses() : [];
      if (miss.length) return out.concat([['crit', 'Kritik', `Fibula: kesi ${miss.map(i => i + 1).join(' ve ')} kemiği kesmediği için defekt hattı kurulamıyor; kesiyi kemiğin üstüne taşıyın.`]]);
      return out.concat([['warn', 'Uyarı', S.segWarn && S.segWarn.length ? 'Fibula: mandibula kemiği şüpheli (Kontroller sekmesindeki kemik uyarısına bakın); iki kesi ve rezeke parça olmadan segment planı kurulamaz.' : 'Fibula: mandibulada iki kesi ve rezeke parça olmadan segment planı kurulamaz.']]);
    }
    // a defect shorter than one segment: one segment, reported once as a warning (no count can make it longer)
    const shortDefect = c.D.L < MIN_LEN && c.segs.filter(g => !g.barrel).length === 1;
    if (shortDefect) out.push(['warn', 'Uyarı', `Defekt ${fmt(c.D.L)} mm, tek segment ${MIN_LEN} mm'nin altında kalıyor (kısa rezeksiyon); segment bölünmedi. Kanlanma için greft boyunu cerrahla değerlendirin.`]);
    else {
      // length bands: < SEG_ERR critical, SEG_ERR..MIN_LEN a warning; with two or more segments the ones at the stumps >= STUMP_MIN
      const lower = c.segs.filter(g => !g.barrel), ends = lower.length > 1 ? [lower[0], lower[lower.length - 1]] : [];
      c.segs.forEach(g => {
        if (g.L < SEG_ERR) out.push(['crit', 'Kritik', `Fibula segmenti ${g.i + 1} ${fmt(g.L)} mm; ${SEG_ERR} mm altı segment kanlanmasını ve tespitini kaybeder. Segment sayısını azaltın ya da kesileri kaydırın.`]);
        else if (g.L < MIN_LEN) out.push(['warn', 'Uyarı', `Fibula segmenti ${g.i + 1} ${fmt(g.L)} mm; ${MIN_LEN} mm altı (${SEG_ERR}–${MIN_LEN} mm) kanlanma açısından sınırda.`]);
        else if (ends.includes(g) && g.L < STUMP_MIN) out.push(['warn', 'Uyarı', `Fibula segmenti ${g.i + 1} güdüğe komşu ve ${fmt(g.L)} mm; güdük segmentlerinde en az ${STUMP_MIN} mm önerilir (tespit ve kaynama).`]);
      });
    }
    const ch = S.fib.choice;
    if (ch && ch.table && ch.table.length && P0.nAuto && Math.abs(ch.L - c.D.L) < 0.5) {
      const tbl = ch.table.map(r => `${r.n}: ${fmt(r.min)}/${fmt(r.dev)}`).join('; ');
      out.push(['info', 'Bilgi', ch.reason === 'short' ? `Segment sayısı otomatik seçildi: ${ch.n} (defekt bir segmentten kısa). Denenen sayılar (en kısa segment mm / sapma mm): ${tbl}.`
        : ch.reason === 'dev' ? `Segment sayısı otomatik seçildi: ${ch.n} (en az segmentle sapma ≤ ${DEV_WARN} mm). Denenen sayılar (en kısa segment mm / sapma mm): ${tbl}.`
          : `Segment sayısı otomatik seçildi: ${ch.n} (sapma hedefi tutmuyor; ${MIN_LEN} mm altı segment vermeyen sayılar içinde en küçük sapma, ${fmt(DEV_TIE)} mm içindeki sapmalarda az segment ve güdük segmentleri ${STUMP_MIN} mm üstü olan sayı). Denenen sayılar (en kısa segment mm / sapma mm): ${tbl}.`]);
    }
    c.segs.forEach(g => [['başlangıç', g.a0], ['bitiş', g.a1]].forEach(([w, a]) => { if (a > ANGLE_WARN) out.push(['warn', 'Uyarı', `Fibula segmenti ${g.i + 1} ${w} kesisi ${fmt(a)}°; ${ANGLE_WARN}° üstü temas yüzeyini azaltır.`]); }));
    if (c.dev > DEV_WARN) out.push(['warn', 'Uyarı', `Greftler defekt hattından ${fmt(c.dev)} mm sapıyor (eşik ${DEV_WARN} mm). Segment ekleyin ya da "Kesileri öner"i kullanın.`]);
    if (P0.distal < DISTAL_MIN) out.push(['crit', 'Kritik', `Distal korunan fibula ${fmt(P0.distal, 0)} mm; ayak bileği stabilitesi için en az ${DISTAL_MIN} mm.`]);
    if (c.proxLeft < PROX_KEEP) out.push(['crit', 'Kritik', `Fibula yetmiyor: proksimalde ${fmt(Math.max(c.proxLeft, 0), 0)} mm kalıyor, en az ${PROX_KEEP} mm gerekli.`]);
    const R = S.fib.guide && S.fib.guide.result;
    if (!R && !building && S.fib.guideFail) out.push(['warn', 'Uyarı', 'Fibula guide\'ı üretilemedi; fibula yüzeyi bulunamadı.']);
    if (R) {
      const shortSeg = c.segs.some(g => g.L < MIN_LEN), ad = R.adapt;
      if (R.pieces > 1) out.push(['crit', 'Kritik', `Fibula guide'ı ${R.pieces} parçaya bölünüyor.${shortSeg ? ' Segment 20 mm\'den kısa: iki kesi yuvası arasında guide tutunamıyor; segmenti uzatın ya da segment sayısını azaltın.' : ''}`]);
      if (R.seat && R.seat.ok && !R.seat.free) out.push(['crit', 'Kritik', ad ? `Fibula guide'ı hiçbir yönde takılamıyor; sarma derinliği ${fmt(ad.from, 1)} mm'den ${fmt(ad.to, 1)} mm'ye indirildi, yine de takılamıyor.${shortSeg ? ' Segment 20 mm\'den kısa; kesileri kısa tutmak guide\'ın oturmasını bozuyor.' : ''}` : 'Fibula guide\'ı hiçbir yönde takılamıyor; sarma derinliği fazla. Sarma derinliğini azaltın.']);
      else if (ad && ad.ok) out.push(['info', 'Bilgi', `Fibula guide'ı takılabilsin diye sarma derinliği ${fmt(ad.from, 1)} mm'den ${fmt(ad.to, 1)} mm'ye indirildi.`]);
      if (R.contact < 100) out.push(['warn', 'Uyarı', `Fibula guide'ı temas alanı ${fmt(R.contact, 0)} mm²; oturma belirsiz olabilir. Sarmayı artırın ya da guide'ı daha geniş bir kemik yüzeyine taşıyın.`]);
      R.screwInfo.forEach((si, i) => {
        if (!si.ok) out.push(['crit', 'Kritik', si.noBody ? `Fibula vidası ${i + 1} altında guide gövdesi yok; kovan boşlukta kalırdı. Vidayı kaydırın ya da sarmayı artırın.` : `Fibula vidası ${i + 1} kemiğe ulaşmıyor; vidayı kemiğin üstüne kaydırın.`]);
        else if (si.crossesPlane) out.push(['crit', 'Kritik', `Fibula vidası ${i + 1} matkap yolu kesi yuvasıyla kesişiyor; vidayı yuvadan uzaklaştırın.`]);
        else if (si.slotGap < 0.5) out.push(['warn', 'Uyarı', `Fibula vidası ${i + 1} kovanı kesi yuvasına ${fmt(Math.max(0, si.slotGap))} mm yaklaşıyor (en az 0,5 mm); testere yoluna değebilir. Vidayı yuvadan uzaklaştırın.`]);
        // hole checks: bone along the hole, bone bridge to the cut (>= SCREW_CUT_GAP mm, our own inference)
        if (si.ok && si.inBone < SCREW_MIN_DEPTH) out.push(['warn', 'Uyarı', `Fibula vidası ${i + 1} deliği boyunca yalnız ${fmt(si.inBone)} mm kemik var (en az ${SCREW_MIN_DEPTH} mm); vida tutmayabilir. Vidayı daha kalın kemiğe kaydırın.`]);
        if (si.ok && !si.crossesPlane && Number.isFinite(si.cutGap) && si.cutGap < SCREW_CUT_GAP) out.push([si.cutGap < SCREW_CUT_WARN ? 'warn' : 'info', si.cutGap < SCREW_CUT_WARN ? 'Uyarı' : 'Bilgi', si.cutGap < SCREW_CUT_WARN ? `Fibula vidası ${i + 1} deliği kesiye ${fmt(Math.max(0, si.cutGap))} mm; ${SCREW_CUT_GAP} mm kesin kural değil, önerilen eşiktir, ${SCREW_CUT_WARN} mm altında kemik köprüsü kırılabilir. Vidayı kesiden uzaklaştırın.` : `Fibula vidası ${i + 1} deliği kesiye ${fmt(Math.max(0, si.cutGap))} mm; ${SCREW_CUT_GAP} mm önerilen bir eşiktir, kesin kural değildir. İsterseniz vidayı biraz uzaklaştırın.`]);
      });
      // fixation: two screws on a segment of STUMP_MIN mm or more, at least three on the guide (screws that hold: on bone, clear of the slots)
      const fsc = S.fib.guide.ctx.fsc || [], held = R.screwInfo.map(si => si.ok && !si.crossesPlane);
      const nHeld = held.filter(Boolean).length;
      if (!nHeld) out.push(['crit', 'Kritik', 'Fibula guide\'ını kemiğe tutturan vida yok; vida kurallarına uyan yer bulunamadı. Kesileri fibulaya daha dik planlayın ya da vidaları elle yerleştirin.']);
      else if (nHeld < 3) out.push(['warn', 'Uyarı', `Fibula guide'ı ${nHeld} vidayla sabitleniyor; en az 3 vida önerilir (guide eğilip dönmesin).`]);
      c.segs.forEach((g, k) => { const m = fsc.filter((f, i) => f.seg === k && held[i]).length; if (g.L >= STUMP_MIN && m < 2) out.push(['warn', 'Uyarı', `Fibula segmenti ${g.i + 1} ${fmt(g.L)} mm ve üzerinde ${m} vida var; ${STUMP_MIN} mm ve üstü segmentte 2 vida önerilir.`]); });
      if (!P0.fsc) c.segs.map((g, k) => k).filter(k => !fsc.some(f => f.seg === k)).forEach(k => out.push(['warn', 'Uyarı', `Fibula segmenti ${k + 1} üzerinde vida kurallarına (kemikte en az ${SCREW_MIN_DEPTH} mm, yuvadan en az ${SCREW_SLOT_GAP} mm, kovan gövdede) uyan yer yok; bu segmente vida konmadı. Kesileri dikleştirin ya da vidayı elle yerleştirin.`]));
      if (fsc.some(f => f.none)) out.push(['warn', 'Uyarı', `Fibula guide'ında bazı segmentlerde vida kurallarına (kemikte en az ${SCREW_MIN_DEPTH} mm, yuvadan en az ${SCREW_SLOT_GAP} mm, kovan gövdede) uyan yer bulunamadı; vidalar yuvaya ${fmt(SCREW_TIGHT_GAP)}–${SCREW_SLOT_GAP} mm yakın en iyi yere kondu. Vidaları kontrol edin ya da elle yerleştirin.`]);
      if (R.sideFlip) out.push(['info', 'Bilgi', 'Fibula guide\'ının köprüsü diğer kenara alındı; eğik bir yuva guide\'ın bir köşesini ayırıyordu.']);
    }
    // saw slot against the blade: slot = blade + 0.1-0.3 mm (a wider slot lets the blade tilt and angle errors add up)
    const sw = slotOf(P0);
    if (sw - P0.kerf > 0.3 + 1e-9) out.push(['warn', 'Uyarı', `Fibula guide yuvası (${fmt(sw, 2)} mm) testere payından (${fmt(P0.kerf, 2)} mm) ${fmt(sw - P0.kerf, 2)} mm geniş; bıçaktan en çok 0,3 mm geniş yuva önerilir, daha genişi açı hatası biriktirir.`]);
    return out;
  }
  const active = () => !!(F && F.c && S.fib && S.fib.plan);
  const approved = () => active() && !!plan().ok && plan().sig === sig();
  function syncUI() {
    if (!active()) return;
    const P0 = plan(), D = last && last.D, Ld = D ? D.L : 0;
    document.querySelectorAll('#fibN button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.n === P0.n));
    $('fibKnots').innerHTML = P0.knots.map((f, i) => `<div class="ctl"><div class="ctl-row"><label for="fk${i}">Kesi ${i + 1} konumu</label><output>${fmt(f * Ld)} mm</output></div><input type="range" id="fk${i}" min="0.08" max="0.92" step="0.005" value="${f}"></div>`).join('');
    $('fibRolls').innerHTML = P0.roll.map((r, i) => `<div class="ctl"><div class="ctl-row"><label for="fr${i}">Segment ${i + 1} dönüşü</label><output>${fmt(r, 0)}°</output></div><input type="range" id="fr${i}" min="-180" max="180" step="1" value="${r}"></div>`).join('');
    $('fibJointBox').hidden = P0.n < 2;
    const js = $('fibJoint'), jv = Math.min(+js.value || 1, P0.n - 1) || 1;
    js.innerHTML = Array.from({ length: P0.n - 1 }, (_, j) => `<option value="${j + 1}">Segment ${j + 1}–${j + 2}</option>`).join(''); js.value = jv;
    $('fibYaw').value = P0.yaw[jv] || 0; $('fibPitch').value = P0.pitch[jv] || 0;
    $('fibYawO').textContent = fmt(P0.yaw[jv] || 0, 0) + '°'; $('fibPitchO').textContent = fmt(P0.pitch[jv] || 0, 0) + '°';
    $('fibKerf').value = P0.kerf; $('fibKerfO').textContent = fmt(P0.kerf) + ' mm';
    $('fibSlot').value = slotOf(P0); $('fibSlotO').textContent = fmt(slotOf(P0), 2) + ' mm';
    $('fibDistal').value = P0.distal; $('fibDistalO').textContent = fmt(P0.distal, 0) + ' mm';
    $('fibVOff').value = P0.vOff || 0; $('fibVOffO').textContent = fmt(P0.vOff || 0) + ' mm';
    $('fibMirror').checked = !!P0.mirror;
    $('fibDbl').checked = !!P0.dbl; $('fibDblHBox').hidden = !P0.dbl; $('fibDblH').value = dblH(); $('fibDblHO').textContent = fmt(dblH()) + ' mm';
    P0.knots.forEach((_, i) => {
      const el = $('fk' + i);
      el.addEventListener('input', () => { const lo = (i ? P0.knots[i - 1] : 0) + 0.08, hi = (i < P0.knots.length - 1 ? P0.knots[i + 1] : 1) - 0.08; P0.knots[i] = Math.min(hi, Math.max(lo, +el.value)); edited(true); });
      el.addEventListener('change', () => edited(false, true));
    });
    P0.roll.forEach((_, i) => { const el = $('fr' + i); el.addEventListener('input', () => { P0.roll[i] = +el.value; edited(true); }); el.addEventListener('change', () => edited(false, true)); });
  }
  function renderStep() {
    if (!active()) { $('tag6').hidden = true; return; }
    const c = last, R = S.fib.guide && S.fib.guide.result;
    $('fibRows').innerHTML = c ? c.segs.map(g => `<tr><td>${g.i + 1}${g.barrel ? ' (üst)' : ''}</td><td>${fmt(g.L)} mm</td><td>${fmt(g.s0 - F.c.smin, 0)} mm</td><td>${fmt(g.a0, 0)}° / ${fmt(g.a1, 0)}°</td><td>${fmt(g.crest)} mm</td></tr>`).join('') : '<tr><td colspan="5">Defekt yok</td></tr>';
    const mm = $('fibMirrorMsg'); if (mm) { mm.hidden = !(plan().mirror && c); mm.textContent = plan().mirror && c ? (c.D.mirrored ? `Defekt hattının ${c.D.mirrored}/${c.D.nmid} noktası sağlam taraftan aynalandı${window.Ref && Ref.get && Ref.get() ? '' : ' (orta hat kemiğin ortasından tahmin edildi)'}.` : 'Karşı tarafta eşleşen sağlam kemik bulunamadı (defekt orta hatta olabilir); mevcut kemik kullanılıyor.') : ''; }
    $('fibSum').innerHTML = c ? `<dt>Defekt boyu (hat boyunca)</dt><dd>${fmt(c.D.L)} mm</dd><dt>Greftlerin hattan sapması</dt><dd>${fmt(c.dev, 2)} mm</dd><dt>Kullanılan fibula</dt><dd>${fmt(c.used)} mm</dd><dt>Proksimalde kalan</dt><dd>${fmt(c.proxLeft, 0)} mm</dd><dt>Fibula guide'ı</dt><dd>${R ? `${fmt(S.fib.guide.ctx.g.L, 0)} mm, temas ${fmt(R.contact, 0)} mm²` : building ? 'üretiliyor' : '–'}</dd>` : '';
    const ck = checks(); $('fibChecks').innerHTML = (ck.length ? ck : [['ok', 'Uygun', 'Fibula kontrolleri geçti.']]).map(([k, t, m]) => `<li class="${k}"><b>${t}</b><span>${m}</span></li>`).join('');
    const crit = ck.some(x => x[0] === 'crit'), ok = approved();
    $('fibApprove').textContent = ok ? 'Fibula onayını kaldır' : 'Fibula planını onayla';
    $('fibApprove').disabled = !ok && (crit || !c || !R);
    $('fibStatus').textContent = ok ? `Fibula planı onaylandı${plan().by ? ' · ' + plan().by : ''}.` : plan().ok ? 'Plan onaydan sonra değişti; yeniden onay gerekli.' : crit ? 'Kritik kontrol varken onaylanamaz.' : 'Fibula planı cerrah onayı bekliyor.';
    const t = $('tag6'), tx = ok ? 'Onaylı' : crit ? 'Kritik' : 'Onay bekliyor'; t.hidden = ok; t.className = 'tag ' + (ok ? 'ok' : crit ? 'crit' : 'warn'); t.textContent = ''; t.title = tx; t.setAttribute('aria-label', tx);
  }
  // recompute the plan from the current mandible and fibula state; user edits also create a history entry
  function update() {
    if (!active()) { if (grafts) draw(null); return; }
    const D = defect();
    // an automatic segment count follows the defect: a new resection length (cuts moved, condyle, first defect) is planned again
    if (D && plan().nAuto && !(S.fib.choice && Math.abs(S.fib.choice.L - D.L) < 0.5)) chooseSegments(D);
    last = D ? compute(D) : null;
    draw(last); renderStep(); St.updatePanels();
    if (last) scheduleGuide();
  }
  let liveTimer = null;
  function edited(live, commit) {
    if (live) { clearTimeout(liveTimer); syncOutputs(); liveTimer = setTimeout(update, 30); }
    if (commit || !live) { update(); syncUI(); St.emit('changed'); }
  }
  function syncOutputs() {
    const P0 = plan(), Ld = last ? last.D.L : 0;
    P0.knots.forEach((f, i) => { const o = $('fk' + i) && $('fk' + i).parentElement.querySelector('output'); if (o) o.textContent = fmt(f * Ld) + ' mm'; });
    P0.roll.forEach((r, i) => { const o = $('fr' + i) && $('fr' + i).parentElement.querySelector('output'); if (o) o.textContent = fmt(r, 0) + '°'; });
  }
  function setN(n) {
    const P0 = plan(); P0.n = n; P0.knots = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
    P0.yaw = Array(n + 1).fill(0); P0.pitch = Array(n + 1).fill(0); P0.roll = Array(n).fill(0);
  }
  function optimizeKnots() {
    const P0 = plan(); if (P0.n < 2 || !last) return;
    // short segments are penalised: every segment under MIN_LEN + 1, the two at the stumps under STUMP_MIN + 1
    const D = last.D, ns = P0.n, cost = k => { const full = [0, ...k.map(f => f * D.L), D.L]; let pen = 0; for (let i = 0; i < full.length - 1; i++) pen += Math.max(0, (i === 0 || i === ns - 1 ? STUMP_MIN : MIN_LEN) + 1 - (full[i + 1] - full[i])) * 2; return deviation(D, full) + pen; };
    let k = P0.knots.slice(), best = cost(k);
    for (let step = 0.08; step >= 0.004; step /= 2) for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (let i = 0; i < k.length; i++) for (const dl of [-step, step]) { const t = k.slice(); t[i] += dl; if (t[i] <= (i ? t[i - 1] : 0) + 0.08 || t[i] >= (i < t.length - 1 ? t[i + 1] : 1) - 0.08) continue; const c = cost(t); if (c < best - 1e-4) { best = c; k = t; moved = true; } }
      if (!moved) break;
    }
    P0.knots = k.map(f => Math.round(f * 1000) / 1000);
  }

  // ---------- plan persistence ----------
  async function start(kind, files) {
    if (!(await load(kind, files))) return;
    setCandidate(0);
    const P0 = defaultPlan(); P0.source = Object.assign({}, F.source); P0.cand = F.c.centroid.map(x => Math.round(x * 10) / 10);
    S.fib = { plan: P0, guide: null };
    if (pending && pending.source && pending.source.fp === F.source.fp) { const p = pending; pending = null; await apply(p); return; }
    // segment count from the defect (segmentChoice); re-chosen while the plan stays automatic and the defect changes
    const D = defect();
    if (D) chooseSegments(D);
    if (St.parts.resected) { St.parts.resected.visible = false; St.parts.resected.obj.visible = false; }
    guideKey = ''; update(); syncUI(); setView('f'); St.emit('changed');
  }
  // a stored plan is untrusted input: keep every value inside the range its control allows (like applyPlan does for the guide).
  // kerf <= 0 would give a guide without saw slots, so it is also reported
  function sanitize(p) {
    const q = St.clone(p), warn = [], num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; }, cl = (v, a, b, d) => Math.max(a, Math.min(b, num(v, d)));
    const D0 = defaultPlan();
    if (!(num(q.kerf, 0) > 0)) warn.push('Testere payı (kerf) sıfır ya da geçersiz; ' + D0.kerf + ' mm kullanıldı. Testere yuvaları için değeri kontrol edin.');
    q.kerf = num(q.kerf, 0) > 0 ? cl(q.kerf, 0.5, 2, D0.kerf) : D0.kerf;
    // slot width: null (plans saved before it existed) = the kerf; never narrower than the blade
    q.slotW = q.slotW == null || !Number.isFinite(Number(q.slotW)) ? null : Math.max(q.kerf, cl(q.slotW, 0.5, 2.5, q.kerf));
    q.distal = cl(q.distal, 40, 140, D0.distal); q.vOff = cl(q.vOff, -12, 12, 0);
    q.dblH = q.dblH == null ? null : cl(q.dblH, 8, 30, 8); q.dbl = q.dbl ? 1 : 0;
    q.n = Math.round(cl(q.n, 1, MAX_N, 2)); q.nAuto = q.nAuto ? 1 : 0;      // a stored count is a decision unless it says it was automatic
    const n = q.n, ang = (a, len) => Array.from({ length: len }, (_, i) => cl(Array.isArray(a) ? a[i] : 0, -180, 180, 0));
    q.yaw = ang(q.yaw, n + 1); q.pitch = ang(q.pitch, n + 1); q.roll = ang(q.roll, n);
    const kn = Array.isArray(q.knots) && q.knots.length === n - 1 ? q.knots.map(x => cl(x, 0.05, 0.95, 0.5)) : null;
    q.knots = kn && kn.every((x, i) => i === 0 || x > kn[i - 1]) ? kn : Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
    return { plan: q, warn };
  }
  async function apply(p) {
    if (!p) { if (S.fib) unload(); return; }
    const sn = sanitize(p); p = sn.plan; if (sn.warn.length) setTimeout(() => St.alertMsg(sn.warn.join(' ')), 0);
    if (!F || !F.source || F.source.fp !== p.source.fp) {
      if (p.source && p.source.type === 'sample') { if (!(await load('sample'))) return; }
      else { pending = p; msg(`Bu planın fibula serisi "${p.source ? p.source.name : '?'}". Fibula planını açmak için aynı seriyi ilk adımda yükleyin.`); if (window.UI) UI.openStep('st1'); return; }
      F.c = null;
    }
    if (p.legSplit && !F.split && Array.isArray(p.legSplit.f) && Array.isArray(p.legSplit.t)) { const c = splitLeg(V(...p.legSplit.f), V(...p.legSplit.t)); if (c) F.cands.push(c); }
    let best = 0, bd = Infinity; F.cands.forEach((c, i) => { const d = c.C.distanceTo(V(...(p.cand || [0, 0, 0]))); if (d < bd) { bd = d; best = i; } });
    if (!F.c || F.c.i !== best) setCandidate(best);
    $('fibCand').value = best;
    S.fib = { plan: St.clone(p), guide: S.fib && S.fib.plan && F.c ? S.fib.guide : null };
    // a stored plan keeps its segment count and cuts as saved; an automatic count is chosen again only when the defect changes
    const D0 = defect(); S.fib.choice = D0 ? { L: D0.L, n: S.fib.plan.n, reason: 'stored', table: [] } : null;
    $('sceneSeg').hidden = false; $('fibBody').hidden = false;
    update(); syncUI();
  }
  function unload() {
    S.fib = null; F = null; last = null; guideKey = '';
    clearLeg(); St.setPart('grafts', null, null); grafts = null;
    if (view === 'f') setView('m');
    $('sceneSeg').hidden = true; $('fibBody').hidden = true; $('tag6').hidden = true; msg('');
    St.updatePanels(); St.render();
  }

  // ---------- exports ----------
  function exportFiles(files) {
    if (!active() || !S.fib.guide) return;
    const prod = S.fib.prod && S.fib.prod.key === S.fib.guide.key ? S.fib.prod : null;
    if (prod) files.push({ name: 'fibula_guide_uretim.stl', data: prod.stl });
    files.push({ name: prod ? 'fibula_guide_onizleme.stl' : 'fibula_guide.stl', data: St.stlOf(S.fib.guide.mesh) });
    files.push({ name: 'fibula_plani.json', data: JSON.stringify(summary(), null, 2) });
  }
  function summary() {
    const P0 = plan(), c = last;
    return { fibula_serisi: F.label, segment_sayisi: P0.n, testere_payi_mm: P0.kerf, yuva_genisligi_mm: slotOf(P0), distal_korunan_mm: P0.distal,
      segmentler: c ? c.segs.map(g => ({ no: g.i + 1, kat: g.barrel ? 'üst' : 'alt', boy_mm: +g.L.toFixed(1), distal_uctan_mm: +(g.s0 - F.c.smin).toFixed(1), kesi_acilari_deg: [+g.a0.toFixed(1), +g.a1.toFixed(1)], rotasyon_deg: P0.roll[g.i] || 0, kret_farki_mm: +g.crest.toFixed(1) })) : [],
      dikey_kayma_mm: P0.vOff || 0, cift_namlu: P0.dbl ? { namlu_arasi_mm: dblH() } : null,
      sapma_mm: c ? +c.dev.toFixed(2) : null, proksimalde_kalan_mm: c ? +c.proxLeft.toFixed(0) : null, onay: approved() ? { cerrah: P0.by, zaman: P0.at } : null };
  }
  function reportHTML() {
    if (!active()) return '';
    const s = summary(), esc = t => String(t).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
    return `<h2>Fibula rekonstrüksiyonu</h2><p>${esc(F.label)} · ${s.segment_sayisi} segment · testere payı ${fmt(s.testere_payi_mm)} mm · distal korunan ${fmt(s.distal_korunan_mm, 0)} mm · proksimalde kalan ${s.proksimalde_kalan_mm ?? '–'} mm · ${approved() ? `onaylı (${esc(plan().by || '')})` : 'onay bekliyor'}</p>
<table><tr><th>Segment</th><th>Boy</th><th>Distal uçtan</th><th>Uç açıları</th><th>Rotasyon</th></tr>${s.segmentler.map(g => `<tr><td>${g.no}</td><td>${fmt(g.boy_mm)} mm</td><td>${fmt(g.distal_uctan_mm)} mm</td><td>${fmt(g.kesi_acilari_deg[0])}° / ${fmt(g.kesi_acilari_deg[1])}°</td><td>${g.rotasyon_deg}°</td></tr>`).join('')}</table>`;
  }
  async function production(signal) {
    if (!active() || !S.fib.guide) return;
    const x = S.fib.guide.ctx;
    const r = await St.serverGuide({ vol: F.vol, red: F.red, F: F.c.Fm, thr: THR, g: x.g, P: x.P, u: x.u, v: x.v, n: x.n, pls: x.pls, scs: x.scs, wrapProfile: S.fib.guide.result.wrapProfile }, signal);
    S.fib.prod = Object.assign(r, { key: S.fib.guide.key });
    $('prodMsg').textContent += ` Fibula guide'ı: ${r.watertight ? 'su geçirmez' : 'SU GEÇİRMEZ DEĞİL'}, ${r.bodies} parça${r.bodies > 1 ? ' (BİRDEN FAZLA PARÇA)' : ''}.`;
  }


  // ---------- fibula view: click to select, active structure (mandible / fibula), bone pick and split ----------
  const cv = St.renderer.domElement, rc = new THREE.Raycaster(); rc.layers.set(1);
  function paneAt(e) {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (S.split) { const hw = Math.floor(r.width / 2); return x > hw ? { pane: 'f', cam: St.camF, ndc: [((x - hw) / (r.width - hw)) * 2 - 1, -(y / r.height) * 2 + 1] } : { pane: 'm' }; }
    if (view === 'f' && F && F.c) return { pane: 'f', cam: St.camera, ndc: [(x / r.width) * 2 - 1, -(y / r.height) * 2 + 1] };
    return { pane: 'm' };
  }
  // the structure being worked on: its pane label is highlighted and its panel opens
  let activePane = 'm';
  function setActive(p, openPanel) {
    activePane = p;
    $('mainLabel').classList.toggle('on', p === 'm'); const fl = $('splitPane').querySelector('.vlabel'); if (fl) fl.classList.toggle('on', p === 'f');
    if (!openPanel || !window.UI) return;
    const open = document.querySelector('details.step[open]'), id = open && open.id;
    if (p === 'f' && id !== 'st4') UI.openStep('st4');
    if (p === 'm' && (id === 'st4' || !id)) UI.openStep('st3');
  }
  const note = t => { const el = $('fibPickMsg'); if (el) { el.textContent = t || ''; el.hidden = !t; } };
  function focusBox(id) {
    if (window.UI) UI.openStep('st4');
    const el = $(id); if (!el) return;
    for (let d = el.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;   // folded sections open to show it
    requestAnimationFrame(() => { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
  }
  let down = null;
  // the right half of the split view is covered by its own pane (its orbit controls), so listen on both
  const onUp = e => {
    const d = down; down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4 || !F || !F.c) return;
    // a pick or brush of the mandible is under way (cut region, screw site, segmentation / lesion tools): the click is not for the leg
    if (S.mode !== 'orbit' || (window.SegEdit && SegEdit.tool()) || (window.Lesion && Lesion.active()) || (window.Masks && Masks.tool())) return;
    const pa = paneAt(e);
    if (pa.pane === 'm') { if (S.split) setTimeout(() => setActive('m', !!(S.sel || S.guideSel)), 0); return; }
    rc.setFromCamera(new THREE.Vector2(pa.ndc[0], pa.ndc[1]), pa.cam);
    clickLeg(rc.intersectObjects(leg.children, true));
  };
  [cv, $('splitPane')].forEach(el => { el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; }); el.addEventListener('pointerup', onUp); });
  function clickLeg(hits) {
    if (fsel.mode) { const h = hits.find(x => x.object.userData.bone || x.object.userData.all); if (h) boneClick(h.point); return; }
    setActive('f', true);
    if (!active()) return;
    const dk = hits.find(h => h.object.userData.disc), sg = hits.find(h => h.object.userData.legSeg !== undefined), gd = hits.find(h => h.object.userData.guide);
    if (dk) { selectJoint(dk.object.userData.joint); return; }
    if (gd && (!sg || gd.distance <= sg.distance)) { fsel.joint = fsel.seg = null; draw(last); focusBox('fgBox'); note('Fibula guide\'ı seçildi; gövde ve vida ayarları aşağıda.'); return; }
    if (sg) { const i = sg.object.userData.legSeg; fsel.seg = i; fsel.joint = null; draw(last); focusBox(plan().roll.length > i ? 'fr' + i : 'fibRows'); note(`Segment ${i + 1} seçildi; dönüşünü ve kesi konumlarını ayarlayabilirsiniz.`); return; }
    fsel.joint = fsel.seg = null; draw(last); note('');
  }
  function selectJoint(j) {
    const P0 = plan();
    if (j > 0 && j < P0.n) {
      fsel.joint = j; fsel.seg = null; $('fibJoint').value = j; syncUI(); draw(last); focusBox('fibJointBox');
      note(`Segment ${j}–${j + 1} arasındaki kesi seçildi; açısını aşağıdan ayarlayın.`); return;
    }
    // the graft's two ends are cut to the mandible's own planes: those are edited on the mandible
    const E = St.resEnds(), end = j === 0 ? E && E.A : E && E.B;
    const k = end && !end.virtual ? St.planesWorld().findIndex(q => Math.abs(q.off - end.off) < 1e-6 && q.N.distanceTo(end.N) < 1e-6) : -1;
    fsel.joint = j; fsel.seg = null; draw(last);
    if (k >= 0) { St.select('p' + k); setActive('m', true); note(`Bu uç mandibuladaki Kesi ${k + 1} ile aynı düzlemde; açısını mandibulada değiştirince fibula da güncellenir.`); }
    else note('Bu uç kondile bağlı; mandibula tarafındaki kesiyle değişir.');
  }
  // which labelled bone is at a world point (a small neighbourhood vote)
  function labelAt(q) {
    const r = F.red, c = G.indexOf(r, [q.x, q.y, q.z]).map(Math.round), votes = new Map();
    for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = c[0] + di, j = c[1] + dj, k = c[2] + dk; if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) continue;
      const l = F.labels[i + r.nx * (j + r.ny * k)]; if (l > 0) votes.set(l, (votes.get(l) || 0) + 1);
    }
    return votes.size ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
  }
  function useCandidate(c, extra) {
    let i = F.cands.indexOf(c); if (i < 0) { F.cands.push(c); i = F.cands.length - 1; }
    $('fibCand').innerHTML = F.cands.map((x, k) => `<option value="${k}" title="Taraf tahminidir">${x.picked ? 'Seçilen' : 'Aday ' + (k + 1)} · ${fmt(x.len, 0)} mm · Ø${fmt(2 * x.rad, 0)} · ${x.C.x > 0 ? 'sol' : 'sağ'}</option>`).join('');
    setCandidate(i); $('fibCand').value = i;
    if (active()) { const P0 = plan(); P0.cand = F.c.centroid.map(x => Math.round(x * 10) / 10); Object.assign(P0, extra || {}); guideKey = ''; edited(false, true); setView(view); }
  }
  function boneClick(q) {
    const l = labelAt(q); if (!l) { note('Tıklanan yerde kemik yok.'); return; }
    if (fsel.mode === 'pick') {
      endMode();
      let c = F.cands.find(x => x.label === l);
      if (!c) { c = boneStats(F.red, F.labels, [{ label: l }])[0]; c.picked = true; c.tibia = (F.c && F.cands[F.c.i] && F.cands[F.c.i].tibia && F.cands[F.c.i].tibia.label !== l) ? F.cands[F.c.i].tibia : null; }
      useCandidate(c); note(`Fibula olarak seçildi (${fmt(c.len, 0)} mm, Ø${fmt(2 * c.rad, 0)} mm).`); return;
    }
    if (!fsel.first) { fsel.first = q.clone(); fsel.firstL = l; marker(q, 0x46c98b); note('Şimdi aynı parçada tibiaya tıklayın.'); return; }
    const pf = fsel.first, lf = fsel.firstL; endMode();
    if (l !== lf) { note('İki tıklama aynı (birleşik) kemik parçasında olmalı. Ayrı parçalarsa "Fibulayı modelde seç"i kullanın.'); return; }
    const out = splitLeg(pf, q); if (!out) { note('Ayrılamadı; tıklamaları kemik gövdesinin ortasına yakın yapın.'); return; }
    useCandidate(out, { legSplit: { f: pf.toArray().map(x => Math.round(x * 10) / 10), t: q.toArray().map(x => Math.round(x * 10) / 10) } });
    note('Fibula tibiadan ayrıldı.');
  }
  // seeded split of one joined piece into fibula (seed at pf) and tibia (seed at pt); returns the fibula candidate
  function splitLeg(pf, pt) {
    const r = F.red, l = labelAt(pf); if (!l || labelAt(pt) !== l) return null;
    const n = r.nx * r.ny * r.nz, dom = new Uint8Array(n), seeds = new Uint8Array(n);
    for (let v = 0; v < n; v++) if (F.labels[v] === l) dom[v] = 1;
    [[pf, 1], [pt, 2]].forEach(([q, val]) => {
      const c = G.indexOf(r, [q.x, q.y, q.z]), rad = r.sp.map(x => Math.ceil(5 / x));
      for (let k = Math.round(c[2]) - rad[2]; k <= Math.round(c[2]) + rad[2]; k++) for (let j = Math.round(c[1]) - rad[1]; j <= Math.round(c[1]) + rad[1]; j++) for (let i = Math.round(c[0]) - rad[0]; i <= Math.round(c[0]) + rad[0]; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) continue;
        const v = i + r.nx * (j + r.ny * k); if (dom[v] && ((i - c[0]) * r.sp[0]) ** 2 + ((j - c[1]) * r.sp[1]) ** 2 + ((k - c[2]) * r.sp[2]) ** 2 <= 25) seeds[v] = val;
      }
    });
    const { lab } = G.splitSeeds(r, dom, seeds, THR);
    let mx = 0; for (let v = 0; v < n; v++) if (F.labels[v] > mx) mx = F.labels[v];
    let nf = 0, nt = 0;
    for (let v = 0; v < n; v++) { if (lab[v] === 1) { F.labels[v] = mx + 1; nf++; } else if (lab[v] === 2) { F.labels[v] = mx + 2; nt++; } }
    if (nf < 100 || nt < 100) return null;
    const [cf, ct] = boneStats(r, F.labels, [{ label: mx + 1 }, { label: mx + 2 }]);
    cf.tibia = ct; cf.picked = true; F.split = true; return cf;
  }
  // all bones of the leg scan, faint, while a bone is being picked
  function showAll(on) {
    leg.children.filter(o => o.userData.all).forEach(o => { leg.remove(o); o.geometry.dispose(); o.material.dispose(); });
    if (on) {
      const r = F.red, m = new Uint8Array(F.labels.length); for (let v = 0; v < m.length; v++) if (F.labels[v] > 0) m[v] = 1;
      const o = onLeg(St.meshFromNets(G.surfaceNets(G.blur(m, r.nx, r.ny, r.nz), r.nx, r.ny, r.nz), (x, y, z) => G.worldOf(r, x, y, z), mat(0x9aa5b1, { transparent: true, opacity: 0.35, depthWrite: false })));
      o.userData.all = true; o.userData.keep = true;
    }
    St.render();
  }
  function marker(q, color) { const m = onLeg(new THREE.Mesh(new THREE.SphereGeometry(3, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }))); m.position.copy(q); m.userData.keep = true; m.userData.marker = true; St.render(); }
  function startMode(m) {
    if (!F || !F.c) return;
    if (fsel.mode === m) { endMode(); note(''); return; }
    endMode(); fsel.mode = m; fsel.first = null;
    if (view === 'm') setView(active() ? 's' : 'f');
    showAll(true); setActive('f');
    $('fibPick').setAttribute('aria-pressed', m === 'pick'); $('fibSplit').setAttribute('aria-pressed', m === 'split');
    note(m === 'pick' ? 'Fibula görünümünde fibula olacak kemiğe tıklayın.' : 'Birleşik görünen kemikte önce fibulaya, sonra tibiaya tıklayın.');
  }
  function endMode() {
    fsel.mode = null; fsel.first = null; if (!F) return;
    leg.children.filter(o => o.userData.marker).forEach(o => { leg.remove(o); o.geometry.dispose(); o.material.dispose(); });
    showAll(false); $('fibPick').setAttribute('aria-pressed', 'false'); $('fibSplit').setAttribute('aria-pressed', 'false');
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && fsel.mode) { endMode(); note(''); } });
  // opening a step makes its structure the active one
  document.querySelectorAll('details.step[name="flow"]').forEach(d => d.addEventListener('toggle', () => { if (d.open && S.split) setActive(d.id === 'st4' ? 'f' : 'm'); }));

  // ---------- wiring ----------
  $('fibSample').addEventListener('click', () => start('sample'));
  $('fibDicom').addEventListener('change', e => { if (e.target.files.length) start('dicom', [...e.target.files]); e.target.value = ''; });
  $('fibFiles').addEventListener('change', e => { if (e.target.files.length) start('dicom', [...e.target.files]); e.target.value = ''; });
  $('fibCand').addEventListener('change', e => { setCandidate(+e.target.value); plan().cand = F.c.centroid.map(x => Math.round(x * 10) / 10); guideKey = ''; edited(false, true); setView(view); });
  document.querySelectorAll('#fibN button').forEach(b => b.addEventListener('click', () => { if (!active()) return; plan().nAuto = 0; setN(+b.dataset.n); update(); optimizeKnots(); edited(false, true); }));
  $('fibOpt').addEventListener('click', () => { if (!active()) return; optimizeKnots(); edited(false, true); });
  $('fibPick').addEventListener('click', () => startMode('pick'));
  $('fibSplit').addEventListener('click', () => startMode('split'));
  $('fibJoint').addEventListener('change', syncUI);
  [['fibYaw', 'yaw'], ['fibPitch', 'pitch']].forEach(([id, key]) => {
    $(id).addEventListener('input', e => { const j = +$('fibJoint').value; plan()[key][j] = +e.target.value; $(id + 'O').textContent = fmt(+e.target.value, 0) + '°'; edited(true); });
    $(id).addEventListener('change', () => edited(false, true));
  });
  $('fibDbl').addEventListener('change', e => { if (!active()) return; plan().dbl = e.target.checked ? 1 : 0; edited(false, true); });
  [['fibKerf', 'kerf', v => fmt(v) + ' mm'], ['fibDistal', 'distal', v => fmt(v, 0) + ' mm'], ['fibVOff', 'vOff', v => fmt(v) + ' mm'], ['fibDblH', 'dblH', v => fmt(v) + ' mm']].forEach(([id, key, f]) => {
    $(id).addEventListener('input', e => { plan()[key] = +e.target.value; $(id + 'O').textContent = f(+e.target.value); if (key === 'kerf') { $('fibSlot').value = slotOf(plan()); $('fibSlotO').textContent = fmt(slotOf(plan()), 2) + ' mm'; } edited(true); });
    $(id).addEventListener('change', () => edited(false, true));
  });
  // slot width: set on its own, never below the blade (the kerf)
  $('fibSlot').addEventListener('input', e => { if (!active()) return; const P0 = plan(); P0.slotW = Math.max(P0.kerf, +e.target.value); $('fibSlotO').textContent = fmt(slotOf(P0), 2) + ' mm'; edited(true); });
  $('fibSlot').addEventListener('change', () => { if (active()) { syncUI(); edited(false, true); } });
  $('fibApprove').addEventListener('click', () => {
    const P0 = plan();
    if (approved()) { St.unapprove(P0); delete P0.sig; } else { St.stamp(P0); P0.sig = sig(); }
    renderStep(); St.updatePanels(); St.emit('changed');
  });
  $('fibView').addEventListener('click', () => setView(view === 'f' ? 'm' : 'f'));
  $('scM').addEventListener('click', () => setView('m'));
  $('scF').addEventListener('click', () => setView('f'));
  $('scS').addEventListener('click', () => setView('s'));
  bus.addEventListener('parts', () => { if (active() && !S.restoring) update(); });
  bus.addEventListener('livePlanes', livePlanes);
  $('fibMirror').addEventListener('change', e => { if (!active()) return; plan().mirror = e.target.checked ? 1 : 0; guideKey = ''; edited(false, true); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring) && S.fib) unload(); });

  // fibula guide edits from the guide panel: drop the cached key so the guide is rebuilt
  function guideEdited() { guideKey = ''; scheduleGuide(); renderStep(); St.emit('changed'); }
  const guideInfo = () => (active() && last ? { auto: guideAuto(last), body: guideBody(last), screws: guideScrews(last), segs: last.segs, FR: F.c.FR } : null);
  return { setActive, activePane: () => activePane, summary: () => (active() ? summary() : null), view: () => view, active, approved, checks, apply, exportFiles, reportHTML, production, setView, state: () => ({ F, last, view }),
    graftBone, fibBone: q => (F && F.c ? fibBone(q) : false), guideInfo, guideEdited, plan: () => (active() ? plan() : null), building: () => building, segmentChoice, lensOk, choice: () => (S.fib && S.fib.choice) || null, defect, MIN_LEN, MAX_N, DEV_WARN, SEG_ERR, STUMP_MIN, DEV_TIE, slotOf: () => (active() ? slotOf(plan()) : null) };
})();
