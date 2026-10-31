/* Lesion painting on the slices: the surgeon paints the lesion (any slice, any view) and the cuts and screws are
   planned from it: cut positions and angles clear the painted region by the safety margin while removing as little
   bone as possible (Studio.planFromLesion). The painted voxels live on the 0.8 mm working grid, show as a red
   overlay on the slices and a red body in 3D, and are part of the plan (saved, versioned, undoable). */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Lesion = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const COLOR = 0xd9363e;
  let shown = '', tool = null, mask = null, radius = 4, stroke = null, lastPaint = null, planMsg = '', planning = false;
  // lastAxis: the slice axis of the last brush stroke (the slices are filled in between along it); sugg: the region a
  // click grew (an orange proposal the surgeon adds or drops, never part of the plan by itself)
  let lastAxis = 2, sugg = null, suggMsg = '';

  const n = () => S.red ? S.red.nx * S.red.ny * S.red.nz : 0;
  const ensure = () => { const N = n(); if (!mask || mask.length !== N) mask = new Uint8Array(N); };
  // the painted voxels as a list, kept until the mask changes (a stroke, an undo, a new mask): the checks, the plan hash
  // and the status read it on every edit, and a scan of the whole working grid costs about a second on a CT
  let ver = 0, memo = null;
  function painted() {
    if (memo && memo.mask === mask && memo.ver === ver) return memo;
    const list = [];
    if (mask) for (let v = 0; v < mask.length; v++) if (mask[v]) list.push(v);
    return (memo = { mask, ver, list: Int32Array.from(list), rle: null });
  }
  const count = () => painted().list.length;
  function points() {
    const out = [], r = S.red, L = painted().list; if (!mask || !r) return out;
    for (const v of L) out.push(V(...G.worldOf(r, v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0)));
    return out;
  }

  // ---------- painting: a disc in the slice plane ----------
  function stamp(world, axis, erase) {
    ensure();
    const r = S.red, c = G.indexOf(r, world), dim = [r.nx, r.ny, r.nz], rad = r.sp.map(s => Math.ceil(radius / s));
    if (axis != null) { rad[axis] = 0; if (!erase) lastAxis = axis; }
    const lo = c.map((x, a) => Math.max(0, Math.round(x) - rad[a])), hi = c.map((x, a) => Math.min(dim[a] - 1, Math.round(x) + rad[a]));
    let changed = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const d = [(i - c[0]) * r.sp[0], (j - c[1]) * r.sp[1], (k - c[2]) * r.sp[2]]; if (axis != null) d[axis] = 0;
      if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > radius * radius) continue;
      const v = i + r.nx * (j + r.ny * k);
      if (erase ? mask[v] : !mask[v]) { mask[v] = erase ? 0 : 1; changed++; }
    }
    if (changed) ver++;
    return changed;
  }
  function paint(world, axis, first) {
    if (!tool || !S.red) return;
    if (tool === 'grow') { if (first) grow(world); return; }
    if (first) stroke = { n: 0 };
    if (!stroke) return;
    stroke.n += stamp(world, axis, tool === 'erase'); lastPaint = { p: world, axis };
    marker(world, axis);
    if (window.MPR) MPR.redraw();
  }
  function strokeEnd() {
    const s = stroke; stroke = null; lastPaint = null;
    if (s && s.n) { dirty = true; changed(); } else if (window.MPR) MPR.redraw();
    clearMarkers();
  }
  // the stroke while it is drawn (Melikhan 2026-10-29: the paint showed in 3D only once the brush was let go): a light
  // disc or ball per brush step, red for the brush and grey for the eraser; the lesion body replaces them on release
  const mk = new THREE.Group(); mk.renderOrder = 6; St.scene.add(mk);
  let mkLast = null, mkGeo = null, mkDisc = null;
  function marker(world, axis) {
    const p = V(...world); if (mkLast && mkLast.distanceTo(p) < radius * 0.5) return;
    mkLast = p;
    const mat = new THREE.MeshBasicMaterial({ color: tool === 'erase' ? 0x8c959c : COLOR, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    let m;
    if (axis == null) { mkGeo = mkGeo || new THREE.SphereGeometry(1, 14, 10); m = new THREE.Mesh(mkGeo, mat); }
    else {
      // a slice stroke paints a disc in the slice plane (the working grid axis is the voxel axis of S.red)
      mkDisc = mkDisc || new THREE.CircleGeometry(1, 32); m = new THREE.Mesh(mkDisc, mat); mat.side = THREE.DoubleSide;
      const ax = S.red.axes && S.red.axes[axis] ? V(...S.red.axes[axis]).normalize() : V(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
      m.quaternion.setFromUnitVectors(V(0, 0, 1), ax);
    }
    m.position.copy(p); m.scale.setScalar(radius); m.renderOrder = 6; mk.add(m); St.render();
  }
  function clearMarkers() { mkLast = null; if (!mk.children.length) return; mk.children.slice().forEach(c => { mk.remove(c); c.material.dispose(); }); St.render(); }
  // the brush outline at the pointer in 3D: a circle of the brush radius lying on the surface under it
  let ringObj = null;
  function ring(h) {
    if (!ringObj) {
      const pts = []; for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
      ringObj = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true }));
      ringObj.renderOrder = 999; ringObj.userData.brushRing = true; St.scene.add(ringObj);
    }
    ringObj.material.color.set(tool === 'erase' ? 0x5b6670 : COLOR);
    ringObj.position.copy(h.point).addScaledVector(h.nrm, 0.2);
    ringObj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.nrm);
    ringObj.scale.setScalar(radius); ringObj.visible = true; St.render();
  }
  function ringOff() { if (ringObj && ringObj.visible) { ringObj.visible = false; St.render(); } }
  // C2: painting is one step. When the brush is put down (Esc, the tool button, another mode) after new paint, the
  // cuts are planned from the lesion, the resected piece is taken off and the guide is built, as "Hazırla" does.
  // Not when something is approved (the surgeon re-plans that by hand) or while a plan is being built.
  let dirty = false;
  async function autoAfterPaint() {
    if (!dirty || !count() || planning) return;
    dirty = false;
    const approved = (S.lesion && S.lesion.ok) || S.planes.some(p => p.ok) || S.screws.some(c => c.ok);
    if (approved) { planMsg = ' ' + xl('Onaylı öğeler var: kesileri yeniden önermek için "Lezyondan kesi öner"e basın.'); status(); return; }
    if (St.autoPrep) await St.autoPrep(); else await plan();
  }
  function changed() { planMsg = ''; build(); status(); St.emit('changed'); if (window.MPR) MPR.redraw(); }

  // ---------- 3D body ----------
  function build() { body('lesionPaint', 'Lezyon (boyanan)', count() ? painted().list : null, COLOR, 0.55); buildShell(); }
  function body(key, name, L, color, opacity) {
    const r = S.red;
    if (!r || !L || !L.length) { St.setPart(key, null, null); return; }
    const b = [Infinity, Infinity, Infinity, -1, -1, -1];
    for (const v of L) { const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / (r.nx * r.ny)) | 0; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k; }
    // the surface is taken on the painted box (plus 2 voxels) only, not on the whole working grid
    const bb = [b[0] - 2, b[1] - 2, b[2] - 2, b[3] + 2, b[4] + 2, b[5] + 2].map((x, a) => Math.max(0, Math.min([r.nx, r.ny, r.nz][a % 3] - 1, x)));
    const sx = bb[3] - bb[0] + 1, sy = bb[4] - bb[1] + 1, sz = bb[5] - bb[2] + 1, f = new Float32Array(sx * sy * sz);
    for (const v of L) { const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / (r.nx * r.ny)) | 0; f[(i - bb[0]) + sx * ((j - bb[1]) + sy * (k - bb[2]))] = 1; }
    const toW = (i, j, k) => St.toWorldRed(i + bb[0], j + bb[1], k + bb[2]);
    const m = St.meshFromNets(G.surfaceNets(f, sx, sy, sz, 0.5), toW, new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: true, opacity, depthWrite: false }));
    m.renderOrder = 4;
    St.setPart(key, name, m, color);
  }

  // ---------- the margin shell (plan 2026-10-30, step 4) ----------
  // The painted lesion grown by the safety margin in every direction: shown see-through in 3D, and measured against the
  // marked canal and roots (Canal: S.canals, S.roots), so the surgeon sees what the margin takes with it. The cuts
  // already clear every painted voxel by the margin (planFromLesion); the shell adds what the cuts cannot show: the
  // canal and the roots inside the margin, and how much bone is left under it (marginal resection, app.js).
  const SHELL_COLOR = 0xe8a33c;
  let shellMemo = null;
  function shellInfo() {
    const r = S.red, L = painted().list, mg = S.lesion ? S.lesion.margin : 0;
    if (!r || !L.length) return null;
    if (shellMemo && shellMemo.ver === ver && shellMemo.mask === mask && shellMemo.mg === mg && shellMemo.red === r) return shellMemo;
    const b = [Infinity, Infinity, Infinity, -1, -1, -1];
    for (const v of L) { const q = [v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0]; for (let a = 0; a < 3; a++) { if (q[a] < b[a]) b[a] = q[a]; if (q[a] > b[a + 3]) b[a + 3] = q[a]; } }
    const pad = r.sp.map(x => Math.ceil((mg + 2) / x) + 1), lo = [0, 1, 2].map(a => Math.max(0, b[a] - pad[a])), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, b[a + 3] + pad[a]));
    const sx = hi[0] - lo[0] + 1, sy = hi[1] - lo[1] + 1, sz = hi[2] - lo[2] + 1, m = new Uint8Array(sx * sy * sz);
    for (const v of L) { const i = v % r.nx - lo[0], j = ((v / r.nx) | 0) % r.ny - lo[1], k = ((v / (r.nx * r.ny)) | 0) - lo[2]; m[i + sx * (j + sy * k)] = 1; }
    const D = G.edt(m, sx, sy, sz, r.sp);
    // the lesion's surface voxels (for distances to the canal and roots)
    const surf = [];
    for (const v of L) {
      const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / (r.nx * r.ny)) | 0;
      if (i > 0 && j > 0 && k > 0 && i < r.nx - 1 && j < r.ny - 1 && k < r.nz - 1 && mask[v - 1] && mask[v + 1] && mask[v - r.nx] && mask[v + r.nx] && mask[v - r.nx * r.ny] && mask[v + r.nx * r.ny]) continue;
      surf.push(G.worldOf(r, i, j, k));
    }
    const near = p => { let d = Infinity; for (const q of surf) { const x = p[0] - q[0], y = p[1] - q[1], z = p[2] - q[2], e = x * x + y * y + z * z; if (e < d) d = e; } return Math.sqrt(d); };
    let canal = null, roots = [];
    (S.canals || []).forEach(c => (c.pts || []).forEach(p => { const d = near(p) - (window.Canal ? Canal.R_CANAL : 1.5); if (canal == null || d < canal) canal = d; }));
    (S.roots || []).forEach((rt, i) => { let d = Infinity; for (let t = 0; t <= 1.0001; t += 0.1) { const p = [0, 1, 2].map(a => rt.a[a] + (rt.b[a] - rt.a[a]) * t); d = Math.min(d, near(p) - (rt.r || 2.5)); } roots.push({ i, d }); });
    shellMemo = { ver, mask, mg, red: r, lo, sx, sy, sz, D, canal, roots, hasCanal: (S.canals || []).length > 0, hasRoots: (S.roots || []).length > 0, inRoots: roots.filter(x => x.d < mg).length };
    return shellMemo;
  }
  function buildShell() {
    const r = S.red, sh = shellInfo(), mg = S.lesion ? S.lesion.margin : 0;
    if (!sh || !(mg > 0)) { St.setPart('lesionShell', null, null); return; }
    const f = new Float32Array(sh.D.length); for (let i = 0; i < f.length; i++) f[i] = -sh.D[i];
    const toW = (i, j, k) => St.toWorldRed(i + sh.lo[0], j + sh.lo[1], k + sh.lo[2]);
    const m = St.meshFromNets(G.surfaceNets(f, sh.sx, sh.sy, sh.sz, -mg), toW, new THREE.MeshStandardMaterial({ color: SHELL_COLOR, roughness: 0.8, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 3;
    St.setPart('lesionShell', 'Güvenlik payı kabuğu', m, SHELL_COLOR);
  }
  // one line for the status: the margin shell against the canal and the roots
  function shellLine() {
    const sh = shellInfo(), mg = S.lesion ? S.lesion.margin : 0; if (!sh) return '';
    const parts = [];
    if (sh.hasCanal) parts.push(sh.canal < mg ? xl(`kanal pay içinde (lezyona ${fmt(Math.max(0, sh.canal), 1)} mm)`) : xl(`kanala ${fmt(sh.canal, 1)} mm`));
    else parts.push(xl('kanal işaretlenmedi'));
    if (sh.hasRoots) parts.push(sh.inRoots ? xl(`${sh.inRoots} diş kökü pay içinde`) : xl('diş kökleri pay dışında'));
    return ` ${xl(`Güvenlik payı kabuğu (${fmt(mg, 1)} mm):`)} ${parts.join(', ')}.`;
  }

  // ---------- fill between the painted slices (plan 2026-10-30, step 3) ----------
  // The lesion is painted on a few slices (the first, the widest, the last); the slices in between are filled by
  // blending the painted shapes: each painted slice's signed distance (in-plane, mm) is interpolated linearly between
  // two painted slices and the voxels at or below zero are painted. It reads no density, so it cannot run into the
  // canal or the marrow; it also knows nothing past the bone, so a lesion breaking through the cortex is painted by hand.
  function sliceDist(axis, k) {
    const r = S.red, a1 = axis === 0 ? 1 : 0, a2 = axis === 2 ? 1 : 2, d = [r.nx, r.ny, r.nz], n1 = d[a1], n2 = d[a2], m = new Uint8Array(n1 * n2), ix = [0, 0, 0]; ix[axis] = k;
    let any = 0;
    for (let b = 0; b < n2; b++) for (let a = 0; a < n1; a++) { ix[a1] = a; ix[a2] = b; if (mask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])]) { m[a + n1 * b] = 1; any++; } }
    return any ? { sd: G.sdf(m, n1, n2, 1, [r.sp[a1], r.sp[a2], 1]), a1, a2, n1, n2 } : null;
  }
  function fillBetween(axis = lastAxis) {
    if (!mask || !S.red) return 0;
    const r = S.red, dim = [r.nx, r.ny, r.nz], has = [];
    for (let k = 0; k < dim[axis]; k++) { const ix = [0, 0, 0]; ix[axis] = k; let hit = false; const a1 = axis === 0 ? 1 : 0, a2 = axis === 2 ? 1 : 2;
      for (let b = 0; b < dim[a2] && !hit; b++) for (let a = 0; a < dim[a1]; a++) { ix[a1] = a; ix[a2] = b; if (mask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])]) { hit = true; break; } }
      if (hit) has.push(k); }
    let added = 0;
    for (let q = 1; q < has.length; q++) {
      const k1 = has[q - 1], k2 = has[q]; if (k2 - k1 < 2) continue;
      const A = sliceDist(axis, k1), B = sliceDist(axis, k2); if (!A || !B) continue;
      for (let k = k1 + 1; k < k2; k++) {
        const t = (k - k1) / (k2 - k1), ix = [0, 0, 0]; ix[axis] = k;
        for (let b = 0; b < A.n2; b++) for (let a = 0; a < A.n1; a++) {
          const c = a + A.n1 * b; if ((1 - t) * A.sd[c] + t * B.sd[c] > 0) continue;
          ix[A.a1] = a; ix[A.a2] = b; const v = ix[0] + r.nx * (ix[1] + r.ny * ix[2]); if (!mask[v]) { mask[v] = 1; added++; }
        }
      }
    }
    if (added) { ver++; dirty = true; changed(); }
    return added;
  }

  // ---------- one click: grow the dark region (proposal) ----------
  // A lytic lesion is darker than the bone round it. From the clicked voxel the region grows over voxels of a similar
  // density (within GROW_TOL HU of the seed's mean), below the bone threshold, within GROW_R mm of the seed and inside
  // the bone's own shell: the bone is closed over breaches up to ~3 mm (dilated by GROW_CLOSE voxels) and the region
  // may reach GROW_CLOSE voxels past the space it encloses, so a lesion stops at the cortex and does not spill along the
  // outside of the jaw. The canal and the marrow are dark too: the proposal is shown in orange to be checked on the
  // slices and added by hand. A sclerotic (bright) lesion is not found this way at all.
  const GROW_TOL = 150, GROW_R = 30, GROW_CLOSE = 2;
  function grow(world) {
    const r = S.red; if (!r || !r.hu) return;
    const thr = (St.segThr && St.segThr()) ?? 300, c = G.indexOf(r, world).map(Math.round), dim = [r.nx, r.ny, r.nz];
    if (c.some((x, a) => x < 1 || x >= dim[a] - 1)) return;
    let sum = 0, cnt = 0;
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { sum += r.hu[(c[0] + di) + r.nx * ((c[1] + dj) + r.ny * (c[2] + dk))]; cnt++; }
    const hu0 = sum / cnt;
    if (hu0 >= thr) { sugg = null; suggMsg = xl('Tıklanan yer kemik yoğunluğunda: koyu (litik) lezyonun içine tıklayın. Parlak (sklerotik) lezyon otomatik bulunamaz, fırçayla boyayın.'); showSugg(); return; }
    const R = r.sp.map(s => Math.ceil(GROW_R / s)), lo = c.map((x, a) => Math.max(0, x - R[a])), hi = c.map((x, a) => Math.min(dim[a] - 1, x + R[a]));
    const bx = hi[0] - lo[0] + 1, by = hi[1] - lo[1] + 1, bz = hi[2] - lo[2] + 1, N = bx * by * bz, at = (i, j, k) => (i + lo[0]) + r.nx * ((j + lo[1]) + r.ny * (k + lo[2]));
    const bone = new Uint8Array(N);
    for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) if (r.hu[at(i, j, k)] >= thr) bone[i + bx * (j + by * k)] = 1;
    const Db = G.edt(bone, bx, by, bz), closed = new Uint8Array(N); for (let q = 0; q < N; q++) closed[q] = Db[q] <= GROW_CLOSE ? 1 : 0;
    const out = G.exterior(closed, bx, by, bz), cav = new Uint8Array(N); for (let q = 0; q < N; q++) cav[q] = !out[q] && !closed[q] ? 1 : 0;
    const Dc = G.edt(cav, bx, by, bz), seed = (c[0] - lo[0]) + bx * ((c[1] - lo[1]) + by * (c[2] - lo[2]));
    const ok = q => Dc[q] <= GROW_CLOSE && !bone[q];
    if (!ok(seed)) { sugg = null; suggMsg = xl('Tıklanan yer kemiğin içinde kapalı bir boşlukta değil: lezyon kemik dışına açılıyorsa fırçayla boyayın.'); showSugg(); return; }
    const seen = new Uint8Array(N), queue = new Int32Array(N), bxy = bx * by, list = []; let head = 0, tail = 0;
    seen[seed] = 1; queue[tail++] = seed;
    while (head < tail) {
      const q = queue[head++], i = q % bx, j = ((q / bx) | 0) % by, k = (q / bxy) | 0, v = at(i, j, k);
      if (Math.abs(r.hu[v] - hu0) > GROW_TOL) continue;
      list.push(v);
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const i2 = i + di, j2 = j + dj, k2 = k + dk; if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= bx || j2 >= by || k2 >= bz) continue;
        const q2 = i2 + bx * (j2 + by * k2); if (seen[q2] || !ok(q2)) continue; seen[q2] = 1; queue[tail++] = q2;
      }
    }
    sugg = Int32Array.from(list);
    const vol = list.length * r.sp[0] * r.sp[1] * r.sp[2] / 1000;
    suggMsg = `${xl(`Öneri ${fmt(vol, 2)} cm³: tıklanan noktadan kemik duvarına kadar koyu bölge.`)} ${xl('Kanal ve ilik de koyu görünür: öneriyi kesitlerde kontrol edin, uygunsa "Öneriyi ekle"ye basın. Kemik dışına taşan kısmı fırçayla ekleyin.')}`;
    showSugg();
  }
  function showSugg() {
    body('lesionSugg', 'Lezyon önerisi', sugg, 0xf08c28, 0.45);
    $('lsSuggBox').hidden = !sugg && !suggMsg; $('lsSuggMsg').textContent = suggMsg;
    $('lsSuggAdd').disabled = $('lsSuggDrop').disabled = !sugg || !sugg.length;
    if (window.MPR) MPR.redraw();
  }
  function suggAdd() {
    if (!sugg || !sugg.length) return; ensure();
    let n = 0; for (const v of sugg) if (!mask[v]) { mask[v] = 1; n++; }
    sugg = null; suggMsg = ''; showSugg();
    if (n) { ver++; dirty = true; changed(); }
  }
  function suggDrop() { sugg = null; suggMsg = ''; showSugg(); }

  // ---------- 3D: paint on whatever surface is showing (skin, soft tissue or another layer, or bone); Alt orbits ----------
  const cv = St.renderer.domElement, mouse = new THREE.Vector2();
  function hit3D(e) {
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    if (e.clientX - rect.left > rw) return null;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const t = ['bone', 'resected'].filter(k => St.parts[k] && St.parts[k].visible).map(k => St.parts[k].obj).concat(window.Layers ? Layers.targets() : []);
    const h = St.ray.intersectObjects(t, false)[0]; if (!h) return null;
    const nrm = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : St.ray.ray.direction.clone().negate();
    if (nrm.dot(St.ray.ray.direction) > 0) nrm.negate();
    return { point: h.point.clone(), nrm };
  }
  let down3 = false;
  cv.addEventListener('pointerdown', e => {
    if (!tool || tool === 'grow' || e.altKey || e.button !== 0) return;
    const h = hit3D(e); if (!h) return;
    down3 = true; cv.setPointerCapture(e.pointerId); ring(h); paint(h.point.toArray(), null, true);
  });
  cv.addEventListener('pointermove', e => {
    if (!tool || tool === 'grow') return;
    const h = hit3D(e); if (h) ring(h); else ringOff();
    if (down3 && h) paint(h.point.toArray(), null, false);
  });
  cv.addEventListener('pointerup', () => { if (!down3) return; down3 = false; strokeEnd(); });
  cv.addEventListener('pointerleave', () => { if (!down3) ringOff(); });
  document.addEventListener('keydown', e => { if (e.key === 'Alt' && tool) St.controls.enableRotate = true; });
  document.addEventListener('keyup', e => { if (e.key === 'Alt' && tool) St.controls.enableRotate = false; });

  // ---------- slices: painted voxels red (the brush outline follows the pointer, mpr.js) ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    if (!S.red || (!mask && !lastPaint && !sugg)) return;
    const r = S.red, k = Math.round(G.indexOf(r, G.worldOf(S.vol, ...A.st.cur))[v.axis]);
    if (sugg && sugg.length && k >= 0 && k < [r.nx, r.ny, r.nz][v.axis]) {
      const a1 = v.ix, a2 = v.iy, sx = r.sp[a1] / S.vol.sp[a1] * T.sx * T.s, sy = r.sp[a2] / S.vol.sp[a2] * T.sy * T.s;
      ctx.fillStyle = 'rgba(240,140,40,.45)';
      for (const q of sugg) {
        const ix = [q % r.nx, ((q / r.nx) | 0) % r.ny, (q / (r.nx * r.ny)) | 0]; if (ix[v.axis] !== k) continue;
        const im = A.idxToImg(v, A.toIdx(G.worldOf(r, ...ix)));
        ctx.fillRect(T.fx(im[0]) - sx / 2, T.fy(im[1]) - sy / 2, sx + 0.5, sy + 0.5);
      }
    }
    if (mask && k >= 0 && k < [r.nx, r.ny, r.nz][v.axis]) {
      const a1 = v.ix, a2 = v.iy, d1 = [r.nx, r.ny, r.nz][a1], d2 = [r.nx, r.ny, r.nz][a2], ix = [0, 0, 0]; ix[v.axis] = k;
      const sx = r.sp[a1] / S.vol.sp[a1] * T.sx * T.s, sy = r.sp[a2] / S.vol.sp[a2] * T.sy * T.s;
      ctx.fillStyle = 'rgba(217,54,62,.42)';
      for (let b = 0; b < d2; b++) for (let a = 0; a < d1; a++) {
        ix[a1] = a; ix[a2] = b; if (!mask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])]) continue;
        const im = A.idxToImg(v, A.toIdx(G.worldOf(r, ...ix)));
        ctx.fillRect(T.fx(im[0]) - sx / 2, T.fy(im[1]) - sy / 2, sx + 0.5, sy + 0.5);
      }
    }
  });

  // ---------- panel ----------
  function setTool(t) {
    tool = tool === t ? null : t;
    if (tool && St.mandibleView) St.mandibleView();
    if (tool) {
      if (St.S.mode !== 'orbit') St.setMode('orbit');
      if (window.SegEdit) SegEdit.off();
      if (window.Masks) Masks.off();
      if (window.Measure && Measure.active()) $('toolMeasure').click();
      // painting happens on the slices: make sure they are on screen
      if ($('vm3d') && $('vm3d').getAttribute('aria-pressed') === 'true') $('vmStrip').click();
      // on narrower screens give the slices the room: close the review panel while painting
      if (window.innerWidth < 1280 && window.Layout) Layout.setRight(false);
    }
    St.controls.enableRotate = !tool; if (window.MPR) MPR.redraw();
    if (!tool) { ringOff(); clearMarkers(); setTimeout(autoAfterPaint, 0); }
    document.querySelectorAll('#lsTools [data-t]').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === tool));
    const b = $('modeBadge');
    if (tool) { b.hidden = false; b.textContent = shown = tool === 'grow' ? 'Lezyon önerisi: kesitte lezyonun içine tıklayın · Esc ile bitir' : `Lezyon ${tool === 'erase' ? 'silgisi' : 'fırçası'}: kesitlerde ya da 3B görünümde sürükleyin · döndürmek için Alt · Esc ile bitir`; }
    else if (/^Lezyon/.test(b.textContent) || (shown && (b.textContent === shown || b.textContent === xl(shown)))) b.hidden = true;
  }
  function status() {
    const c = count(), r = S.red, vol = r ? c * r.sp[0] * r.sp[1] * r.sp[2] / 1000 : 0;
    let ext = '';
    if (c && S.anchor) { const { u } = St.frameAxes(), o = points().map(q => q.sub(S.anchor.p).dot(u)); let mn = Infinity, mx = -Infinity; for (const x of o) { if (x < mn) mn = x; if (x > mx) mx = x; } ext = xl(` · eksende ${fmt(mx - mn)} mm`); }
    $('lsStat').textContent = c ? `${xl(`Boyanan lezyon ${fmt(vol, 2)} cm³`)}${ext}.${shellLine()}${planMsg}` : '';
    $('lsPlan').disabled = !c || planning; $('lsClear').disabled = !c; $('lsFill').disabled = !c;
  }
  let wrapNote = '';
  async function plan() {
    const pts = points(); if (!pts.length || planning) return;
    planning = true; $('lsPlan').disabled = true;
    try { await planNow(pts); } finally { planning = false; status(); }
  }
  async function planNow(pts) {
    St.busy(true, 'Kesiler lezyona göre hesaplanıyor…'); await St.sleep();
    try {
      // the guide is centred over the lesion
      if (!St.anchorFromLesion(pts)) { if (!S.anchor) { St.busy(false); St.alertMsg(xl('Lezyonun üzerinde kemik yüzeyi bulunamadı; "Bölgeyi modelde seç" ile bölgeyi modelde seçin.')); return; } }
      St.planFromLesion(pts);
      // with a guide already on, it follows the new cuts and is checked again for fit
      if (S.guideOn) {
        St.busy(true, 'Guide\'ın takılabilirliği kontrol ediliyor…');
        // one rebuild job at a time (W25): fitWrap tries wrap / split / screw values on S.g, so it waits for a running rebuild
        const f = await St.exclusive(() => St.fitWrap());
        wrapNote = !f ? '' : !f.ok ? xl(' Guide bu yerleşimde takılamıyor; kontrolleri inceleyin.') : (f.split ? xl(' Kavisli kemik nedeniyle iki ayrı guide seçildi.') : '') + (f.wrap < (S.kind === 'leg' ? 6 : 5) ? xl(` Guide takılabilsin diye sarma derinliği ${fmt(f.wrap, 1)} mm'ye indirildi.`) : '');
      } else wrapNote = '';
    } finally { St.busy(false); }
    // say what changed: cut positions and angles, screw count
    const pl = S.planes.slice().sort((a, b) => a.off - b.off), ang = q => (q.yaw || q.pitch ? xl(`, açı ${fmt(Math.hypot(q.yaw, q.pitch), 0)}°`) : '');
    if (pl.length) planMsg = ` ${xl('Kesiler')} ${pl.map(q => `${fmt(q.off, 1)} mm${ang(q)}`).join(` ${xl('ve')} `)}.${S.guideOn ? xl(` ${S.screws.length} vida yerleştirildi.`) : ''}${wrapNote}`;
    status();
  }
  $('lesPaint').innerHTML = `<p class="hint more">Fırça lezyonu kırmızıyla boyar: kesitlerde ya da 3B görünümde görünen yüzeyin (cilt, yumuşak doku, kemik) üstünde. Kemiği Anatomi adımındaki Katmanlar'dan kapatabilirsiniz. Silgi boyamayı geri alır. Fırçayı bırakınca (Esc) kesiler lezyonu güvenlik payı kadar dışarıda bırakacak şekilde konur, rezeksiyon parçası çıkarılır ve guide oluşturulur.</p>
    <span class="seg tools" id="lsTools" role="group" aria-label="Lezyon aracı">
      <button data-t="paint" aria-pressed="false"><svg class="i"><use href="#i-brush"/></svg>Fırça</button>
      <button data-t="erase" aria-pressed="false"><svg class="i"><use href="#i-eraser"/></svg>Silgi</button>
      <button data-t="grow" aria-pressed="false" title="Kesitte lezyonun içine tıklayın: koyu bölge kemik duvarına kadar önerilir"><svg class="i"><use href="#i-target"/></svg>Tıkla bul</button>
    </span>
    <div class="ctl"><div class="ctl-row"><label for="lsRad">Fırça yarıçapı</label><output id="lsRadO">4 mm</output></div><input type="range" id="lsRad" min="1" max="12" step="0.5" value="4"></div>
    <div class="btns"><button id="lsFill" disabled title="Boyanan kesitlerin arasındaki kesitleri şekli düzgünce değiştirerek doldurur"><svg class="i"><use href="#i-files"/></svg>Kesitler arasını doldur</button></div>
    <div class="col" id="lsSuggBox" hidden><p class="hint" id="lsSuggMsg" role="status"></p><div class="btns"><button class="accent" id="lsSuggAdd" disabled>Öneriyi ekle</button><button id="lsSuggDrop" class="ghost" disabled>Öneriyi sil</button></div></div>
    <div class="btns"><button class="primary" id="lsPlan" disabled><svg class="i"><use href="#i-spark"/></svg>Lezyondan kesi öner</button><button id="lsClear" disabled>Temizle</button></div>
    <p class="hint" id="lsStat"></p>
    <p class="hint more">En kolay yol: lezyonun ilk göründüğü, en geniş ve son göründüğü üç kesiti boyayıp "Kesitler arasını doldur"a basın. Kemik dışına taşan kısmı ayrıca boyayın. Kesiler boyanan bölgeyi güvenlik payı kadar dışarıda bırakır; açı, en az kemik alınacak şekilde 30°'ye kadar seçilir.</p>`;
  document.querySelectorAll('#lsTools [data-t]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
  $('lsRad').addEventListener('input', e => { radius = +e.target.value; $('lsRadO').textContent = `${fmt(radius, 1)} mm`; });
  // with a guide on, a new proposal builds the guide again from scratch as the first automatic plan does ("Hazırla"),
  // not out of the last guide's fit (Melikhan 2026-10-28)
  $('lsPlan').addEventListener('click', () => (S.guideOn && St.autoPrep ? St.autoPrep() : plan()));
  $('lsClear').addEventListener('click', () => { mask = null; dirty = false; changed(); });
  $('lsFill').addEventListener('click', () => { const n = fillBetween(); planMsg = n ? ' ' + xl(`Kesitler arası dolduruldu (${n} voksel).`) : ' ' + xl('Doldurulacak boşluk yok: aynı yöndeki en az iki kesiti, aralarında boş kesit bırakarak boyayın.'); status(); if (n) setTimeout(autoAfterPaint, 0); });
  $('lsSuggAdd').addEventListener('click', () => { suggAdd(); setTimeout(autoAfterPaint, 0); });
  $('lsSuggDrop').addEventListener('click', suggDrop);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && tool) setTool(tool); });
  St.onEndModes(() => { if (tool) setTool(tool); });
  bus.addEventListener('volume', e => { if (tool) setTool(tool); sugg = null; suggMsg = ''; showSugg(); if (!(e.detail && e.detail.restoring)) { mask = null; St.setPart('lesionPaint', null, null); status(); } });
  let shellKey = '';
  bus.addEventListener('changed', () => {
    if (stroke) return;
    const k = JSON.stringify([ver, S.lesion && S.lesion.margin, (S.canals || []).length, (S.roots || []).length, (S.canals || []).map(c => (c.pts || []).length)]);
    if (k !== shellKey) { shellKey = k; shellMemo = null; buildShell(); }
    status();
  });

  // ---------- plan storage (run-length encoded) ----------
  function rle(a) { const out = []; let cur = 0, run = 0; for (let i = 0; i < a.length; i++) { if (a[i] === cur) run++; else { out.push(run.toString(36)); cur ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); }
  function unrle(s, N) { const a = new Uint8Array(N); let p = 0, cur = 0; String(s).split(',').forEach(t => { const r = parseInt(t, 36) || 0; if (cur) a.fill(1, p, Math.min(N, p + r)); p += r; cur ^= 1; }); return a; }
  (window.PlanExt = window.PlanExt || {}).lesionPaint = {
    label: 'Boyanan lezyon',
    get: () => { const P = painted(); if (!P.list.length) return null; if (P.rle === null) P.rle = rle(mask); return { dims: [S.red.nx, S.red.ny, S.red.nz], m: P.rle }; },
    set(x) {
      mask = x && S.red && Array.isArray(x.dims) && x.dims.join() === [S.red.nx, S.red.ny, S.red.nz].join() && typeof x.m === 'string' ? unrle(x.m, n()) : null;
      planMsg = ''; build(); status(); if (window.MPR) MPR.redraw();
    },
  };
  status();

  return { count, shellInfo, fillBetween, grow, suggAdd, suggDrop, sugg: () => (sugg ? sugg.length : 0), mask: () => mask, clear: () => { mask = null; dirty = false; planMsg = ''; changed(); }, autoAfterPaint, active: () => !!tool, tool: () => tool, brush: () => (tool ? { r: radius, color: tool === 'erase' ? '#e5e8eb' : '#ff6b6b' } : null), paint, strokeEnd, points, setTool, plan, off: () => { if (tool) setTool(tool); } };
})();
