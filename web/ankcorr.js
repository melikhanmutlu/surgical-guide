/* Corrected shape of the opening wedge osteotomy (malleolar fracture case type): what the tibia looks like once the
   planned cut is opened by the wedge angle, so the surgeon sees the new alignment before the plate is planned.

   The cut is the guide's cut plane (ankguide.js cutPlane): normal N towards proximal. The hinge is the far cortex of the
   bone's section on that plane (the same hinge the wedge is built on, ankguide.js wedge): the line through the section's
   edge away from the guide, along b (in the plane, square to the opening direction a). The proximal tibia stays where it
   is; the distal tibia, the talus with it, turns about the hinge by the wedge angle so the cut opens on the guide side;
   the wedge is carried into the gap it fills.

   The corrected tibia is one closed surface: the distance field of the proximal half (the tibia's distance cut by the
   plane) united with the distal half sampled through the inverse turn, meshed on a 0.6 mm grid. The same field with the
   wedge's gap filled is the bone the external plate is fitted to (ankplate.js).
   Research prototype, not for clinical use: the angle, the hinge and the cut are the surgeon's decisions. */
'use strict';
window.AnkCorr = (function () {
  const St = window.Studio, A = window.Ankle, G = window.AnkGuide; if (!St || !A || !G || !window.CaseType) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  const H = 0.6;                       // grid of the corrected surface (mm)
  const COL = { bone: 0xd8c9a8, talus: 0xb9c6d3, wedge: 0xe0a03a };
  // sample threshold (clinical decision): an opening wider than this at the guide side risks the hinge cortex
  const LIM = { open: 10 };
  let res = null, vis = false, job = null, hidden = [];
  const holders = {};

  const tibia = () => { const f = G.frame(); return f ? f.p : null; };
  const motionKey = p => (p ? JSON.stringify([p.t.toArray(), p.q.toArray()]) : '');
  const keyOf = () => { const s = G.state(); if (!s) return ''; const tal = A.pieces().find(p => p.role === 'talus'); return JSON.stringify([s.piece, s.c, s.P, s.n, s.prm.off, s.prm.tiltA, s.prm.tiltB, s.prm.deg]) + motionKey(tibia()) + motionKey(tal); };

  // ---------- the osteotomy ----------
  // cut plane, hinge and the turn of the distal part, all in the tibia's own (CT) coordinates
  function geom() {
    const f = G.frame(); if (!f) return null;
    const q = G.state().prm, pl = G.cutPlane(f), sec = G.section(f, pl);
    let i0 = sec.nA, i1 = -1;
    for (let j = 0; j < sec.nA; j++) for (let i = 0; i < sec.nA; i++) if (sec.fp[i + sec.nA * j]) { if (i < i0) i0 = i; if (i > i1) i1 = i; }
    if (i1 < 0) return null;
    const sH = (i0 - 0.5) * sec.h - sec.R, depth = (i1 - i0 + 1) * sec.h, th = q.deg * Math.PI / 180;
    const hinge = pl.p.clone().addScaledVector(sec.a, sH), ax = sec.b.clone().normalize();
    // a turn of +th about b sends a towards -N: the distal cut face drops away on the guide side and the cut opens there
    const M = new T.Matrix4().makeTranslation(hinge.x, hinge.y, hinge.z).multiply(new T.Matrix4().makeRotationAxis(ax, th)).multiply(new T.Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z));
    return { f, pl, sec, hinge, ax, a: sec.a.clone(), N: pl.N.clone(), th, deg: q.deg, depth, open: depth * Math.tan(th), M, Mi: M.clone().invert() };
  }
  // signed distance (mm, outside > 0) of the corrected tibia at x (tibia's own coordinates); fill: the wedge's gap as bone
  function field(o, fill) {
    const p = o.f.p, P0 = o.pl.p, N = o.N, y = V(), w = V();
    return x => {
      const z = (x.x - P0.x) * N.x + (x.y - P0.y) * N.y + (x.z - P0.z) * N.z;
      let d = Infinity;
      if (z > -2) d = Math.max(A.sdfAt(p, x), -z);
      y.copy(x).applyMatrix4(o.Mi);
      const zd = (y.x - P0.x) * N.x + (y.y - P0.y) * N.y + (y.z - P0.z) * N.z;
      if (zd < 2) d = Math.min(d, Math.max(A.sdfAt(p, y), zd));
      // the gap: under the proximal cut face, over the turned distal one; bone where the cut section is
      if (fill && z < 0 && zd > 0) { w.copy(x).addScaledVector(N, -z); d = Math.min(d, Math.max(A.sdfAt(p, w), z, -zd)); }
      return d;
    };
  }
  // the tibia's surface box (own coordinates) with its turned distal copy, padded
  function box(o) {
    const g = o.f.p.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox.clone(), c = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) c.push(V(x, y, z).applyMatrix4(o.M));
    c.forEach(q => b.expandByPoint(q)); b.expandByScalar(2); return b;
  }
  // the corrected surface: the field on a grid as occupancy (sub-voxel surface), meshed in the worker
  async function surface(o, fill, me) {
    const b = box(o), lo = b.min, nx = Math.ceil((b.max.x - lo.x) / H) + 1, ny = Math.ceil((b.max.y - lo.y) / H) + 1, nz = Math.ceil((b.max.z - lo.z) / H) + 1;
    const F = new Float32Array(nx * ny * nz), fd = field(o, fill), x = V();
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        x.set(lo.x + i * H, lo.y + j * H, lo.z + k * H); const d = fd(x);
        F[i + nx * (j + ny * k)] = d === Infinity ? 0 : Math.max(0, Math.min(1, 0.5 - d / (2 * H)));
      }
      if (k % 12 === 11) { await St.sleep(); if (me !== job) return null; }
    }
    const net = await St.netsOf(F, nx, ny, nz, 0.5);
    if (me !== job) return null;
    return St.meshFromNets(net, (i, j, k) => [lo.x + i * H, lo.y + j * H, lo.z + k * H], new T.MeshStandardMaterial({ color: COL.bone, roughness: 0.7, metalness: 0, side: T.DoubleSide }));
  }
  // a piece's surface carried into the tibia's own frame and turned with the distal part
  function carried(p, o, color) {
    const tib = o.f.p, g = p.mesh.geometry.clone(), P = g.attributes.position.array, x = V();
    for (let v = 0; v < P.length; v += 3) { x.set(P[v], P[v + 1], P[v + 2]); x.copy(A.toOwn(tib, A.toWorld(p, x))).applyMatrix4(o.M); P[v] = x.x; P[v + 1] = x.y; P[v + 2] = x.z; }
    g.attributes.position.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingBox();
    return new T.Mesh(g, new T.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, side: T.DoubleSide }));
  }
  // the turn read in the joint's frame: lat (towards the fibula), post, up from the joint measures (else the scan axes)
  function frameAx() {
    const r = window.AnkLM && AnkLM.result(), ct = r && r.ct && r.ct.ok ? r.ct : null;
    const lat = ct ? ct.lat.clone() : V(A.meta && A.meta().side === 'L' ? 1 : -1, 0, 0), post = ct ? ct.post.clone() : V(0, 1, 0);
    return { lat: lat.normalize(), post: post.normalize(), up: V().crossVectors(lat, post).z < 0 ? V().crossVectors(post, lat).normalize() : V().crossVectors(lat, post).normalize(), plafond: ct && ct.L.plafond ? ct.L.plafond.clone() : null };
  }
  function measures(o) {
    const fa = frameAx(), r = o.ax.clone().multiplyScalar(o.deg);
    // where the cut opens: the dominant anatomical direction of a
    const dirs = [['lateral', fa.lat], ['medial', fa.lat.clone().negate()], ['post', fa.post], ['ant', fa.post.clone().negate()]];
    const side = dirs.reduce((b, d) => (o.a.dot(d[1]) > b[1] ? [d[0], o.a.dot(d[1])] : b), ['', -2])[0];
    const pl = fa.plafond, moved = pl ? pl.clone().applyMatrix4(o.M).distanceTo(pl) : null;
    return { deg: o.deg, open: o.open, depth: o.depth, side, coronal: r.dot(fa.post), sagittal: r.dot(fa.lat), axial: r.dot(fa.up), plafondMove: moved, hinge: o.hinge.toArray() };
  }

  // ---------- build and show ----------
  let pending = null;
  function build() { const p = pending = run(); p.finally(() => { if (pending === p) pending = null; }); return p; }
  // the corrected shape for the current plan: the one shown, the one being built, or a new one
  async function ensure() {
    if (live()) return res;
    if (pending) { await pending.catch(() => null); if (live()) return res; }
    return build();
  }
  async function run() {
    if (!on() || !G.frame()) return null;
    const me = job = {}, key = keyOf(), o = geom();
    if (!o) { job = null; return null; }
    St.busy(true, xl('Düzeltilmiş tibia hesaplanıyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      const mesh = await surface(o, false, me); if (!mesh) return null;
      const tal = A.pieces().find(p => p.role === 'talus');
      const talus = tal ? carried(tal, o, COL.talus) : null;
      let wedge = null;
      if (o.deg > 0) { const w = await G.wedge(o.f, o.pl); if (me !== job) return null; if (w) { w.mesh.geometry.applyMatrix4(o.M); w.mesh.geometry.computeVertexNormals(); wedge = w.mesh; } }
      res = { key, o, mesh, talus, wedge, info: measures(o) };
      if (vis) show();
      St.emit('ankCorr');
      return res;
    } finally { if (me === job) { job = null; St.busy(false); } render(); }
  }
  const live = () => !!(res && res.key === keyOf() && on());
  function holder(id, label, mesh, color, p) {
    if (!mesh) { St.setPart(id, null, null); delete holders[id]; return; }
    const g = new T.Group(); mesh.position.copy(p.c).negate(); g.add(mesh); g.userData.piece = p; holders[id] = g;
    St.setPart(id, label, g, color); sync();
  }
  function sync() { Object.values(holders).forEach(g => { const pv = g.userData.piece.pivot; g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); g.updateMatrixWorld(true); }); }
  // while the preview is on, the original tibia, talus and the guide are hidden (restored when it is turned off)
  function hideOriginals() {
    const tib = tibia(), tal = A.pieces().find(p => p.role === 'talus'), ids = [];
    A.pieces().forEach((p, i) => { if (p === tib || p === tal) ids.push('ank' + i); });
    ids.push('ankGuide', 'ankWedge');
    ids.forEach(id => { const pt = St.parts[id]; if (pt && pt.visible) { pt.visible = false; pt.obj.visible = false; if (!hidden.includes(id)) hidden.push(id); } });
  }
  function restore() { hidden.forEach(id => { const pt = St.parts[id]; if (pt) { pt.visible = true; pt.obj.visible = true; } }); hidden = []; }
  function show() {
    const ok = vis && live(), p = res && res.o.f.p;
    holder('ankCorr', xl('Düzeltilmiş tibia'), ok ? res.mesh : null, COL.bone, p);
    holder('ankCorrTal', xl('Talus (düzeltilmiş)'), ok ? res.talus : null, COL.talus, p);
    holder('ankCorrWedge', xl('Kama (yerinde)'), ok ? res.wedge : null, COL.wedge, p);
    if (ok) hideOriginals(); else restore();
    St.renderParts(); St.render();
  }
  async function toggle(x) {
    vis = x == null ? !vis : !!x;
    if (vis && !live()) await ensure();
    show(); render(); St.emit('ankCorr');
  }
  function drop() { job = null; res = null; ['ankCorr', 'ankCorrTal', 'ankCorrWedge'].forEach(id => holder(id, '', null)); restore(); }

  // ---------- panel ----------
  const SIDE = { lateral: 'lateral', medial: 'medial', post: 'arkada', ant: 'önde' };
  function render() {
    const el = $('ankCorrBox'); if (!el) return;
    if (!on()) { el.innerHTML = ''; return; }
    const f = G.frame(), m = live() ? res.info : null, stale = res && !live();
    const turn = m ? [['Koronal', m.coronal], ['Sagittal', m.sagittal], ['Aksiyel', m.axial]].filter(([, v]) => Math.abs(v) >= 0.05).map(([k, v]) => `${xl(k)} ${fmt(Math.abs(v), 1)}°`).join(' · ') : '';
    const corr = m && (m.side === 'medial' || m.side === 'lateral') ? xl(m.side === 'medial' ? 'Medial açılma: eklem valgus yönünde döner.' : 'Lateral açılma: eklem varus yönünde döner.') : '';
    el.innerHTML = `<p class="hint more">${xl('Kesi ve kama açısına göre tibianın yeni şekli: proksimal tibia yerinde kalır, distal tibia ve talus menteşe (karşı korteks) çevresinde kama açısı kadar döner, kama açılan boşluğa oturur.')}</p>
      <div class="btns"><button id="acShow" aria-pressed="${vis}" ${f && !job ? '' : 'disabled'}>${vis ? xl('Önceki hale dön') : xl('Düzeltilmiş hali göster')}</button></div>
      ${!f ? `<p class="hint">${xl('Önce guide\'ı yerleştirin; kesi düzlemi ve kama açısı oradan alınır.')}</p>` : ''}
      ${m ? `<dl class="kv"><dt>${xl('Kama açısı')}</dt><dd>${fmt(m.deg, 1)}°</dd>
        <dt>${xl('Açılma')}</dt><dd>${fmt(m.open, 1)} mm ${m.side ? xl(SIDE[m.side]) : ''} · ${xl('kesit')} ${fmt(m.depth, 0)} mm</dd>
        <dt>${xl('Eklemin dönüşü')}</dt><dd>${turn || '0°'}</dd>
        ${m.plafondMove != null ? `<dt>${xl('Plafond merkezi')}</dt><dd>${fmt(m.plafondMove, 1)} mm ${xl('yer değiştirir')}</dd>` : ''}</dl>
        ${corr ? `<p class="hint">${corr}</p>` : ''}
        ${m.open > LIM.open ? `<p class="hint" style="color:var(--warn)">${xl(`Açılma ${fmt(m.open, 1)} mm: ${LIM.open} mm üstünde menteşe korteksi kırılabilir (örnek eşik, klinik karar).`)}</p>` : ''}
        <p class="hint more">${xl('Fibula ve diğer parçalar yerinde gösterilir. Testere payı (yarık) hesaba katılmadı.')}</p>` : stale ? `<p class="hint">${xl('Kesi ya da açı değişti; önizleme yeniden hesaplanacak.')}</p>` : ''}`;
    const b = $('acShow'); if (b) b.addEventListener('click', () => toggle());
  }
  function checks() {
    if (!on() || !live() || !(res.info.open > LIM.open)) return [];
    return [['warn', 'Uyarı', xl(`Kama açılması ${fmt(res.info.open, 1)} mm; ${LIM.open} mm üstünde menteşe korteksi kırılabilir (örnek eşik, klinik karar).`), 'ank']];
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);
  // the files of the package: the corrected tibia (and talus) in the plan frame, for checking the plate and bending
  function files() {
    if (!live()) return [];
    const p = res.o.f.p, fs = [{ name: 'duzeltme/duzeltilmis_tibia.stl', data: G.toPlan(St.stlOf(res.mesh), p) }];
    if (res.talus) fs.push({ name: 'duzeltme/talus_duzeltilmis.stl', data: G.toPlan(St.stlOf(res.talus), p) });
    return fs;
  }

  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (vis && on() && !live() && G.frame()) toggle(true); else render(); }, 350); };
  bus.addEventListener('changed', () => { sync(); if (res && !live()) { if (vis) later(); else render(); } });
  bus.addEventListener('caseType', () => { if (!on()) { vis = false; drop(); } render(); });
  bus.addEventListener('volume', () => { vis = false; drop(); render(); });
  bus.addEventListener('ankPieces', () => { drop(); vis = false; render(); });
  // the ankle module shows its pieces again on every step change: keep the originals hidden while the preview is on
  ['st2', 'stRed', 'stAnkS', 'stAnkG', 'st7', 'stAnkOut'].forEach(id => $(id) && $(id).addEventListener('toggle', () => { if (vis && live()) { hidden = []; hideOriginals(); St.renderParts(); St.render(); } render(); }));
  render();
  return { on, geom, field, build, ensure, toggle, live, files, checks, visible: () => vis, result: () => (live() ? res : null), info: () => (live() ? res.info : null), LIM };
})();
