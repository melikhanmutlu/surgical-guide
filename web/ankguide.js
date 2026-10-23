/* Ankle cutting guide (malleolar fracture case type): an osteotomy guide on one piece of the ankle (by default the
   tibia), with a saw slot along the planned cut, K-wire sleeves on both sides of the cut, and the wedge that fills an
   opening osteotomy of the chosen angle.

   The guide is placed by a click on the bone: the point and the surface normal there are the guide frame (u along the
   bone's long axis in the surface plane, v = n x u, n the seating normal). The body, the slot and the sleeves are the
   studio's own guide (app.js buildGuide + gkernel.js), run on the piece's signed distance field instead of the whole
   bone mask, in the piece's CT position; the guide follows the piece if the piece is moved.
   The wedge: the bone's cross-section on the cut plane (holes filled), thickness 0 at the hinge (the far cortex, away
   from the guide) growing with tan(angle) towards the guide side.
   Research prototype, not for clinical use: the cut, the angle and the wedge are the surgeon's decisions. */
'use strict';
window.AnkGuide = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  // body and cut defaults (engineering assumptions; the clinical team sets the final values)
  const DEF = { off: 0, tiltA: 0, tiltB: 0, kerf: 1.0, deg: 8, L: 40, W: 24, wrap: 6, wall: 3, pinD: 2.0, pinDu: 11 };
  const LIM = { off: [-25, 25], tiltA: [-30, 30], tiltB: [-30, 30], kerf: [0.6, 2], deg: [0, 20], L: [24, 60], W: [16, 40], wrap: [2, 12], wall: [2, 4.5], pinD: [1.2, 3.2], pinDu: [6, 20] };
  const COL = { guide: 0x3f7fd9, wedge: 0xe0a03a, slot: 0xd9534f };
  // the joint (sample threshold, the clinical team sets it): the saw cut and the K-wires stay JOINT_MIN mm away from the
  // articular surface = the guide bone's surface within JOINT_NEAR mm of the talus (the plafond, the malleolar facets)
  const JOINT = { near: 4, min: 5 };
  let st = null;          // { piece, c, P, n, prm }: the placement (piece-own coordinates) and the settings
  let out = null;         // { key, guide, wedge, info } the last build
  let picking = false, job = null;
  const holders = {};     // part id -> Group that follows the piece's pivot

  const clamp = (k, x) => Math.max(LIM[k][0], Math.min(LIM[k][1], +x));
  const prm = () => (st ? st.prm : DEF);
  const piece = () => (st ? A.pieces().find(p => p.name === st.piece && p.c.distanceTo(V(...st.c)) < 5) || A.pieces().find(p => p.c.distanceTo(V(...st.c)) < 5) || null : null);
  const r3 = q => [q.x, q.y, q.z].map(x => Math.round(x * 1000) / 1000);

  // ---------- geometry ----------
  function frame() {
    const p = piece(); if (!p || !st) return null;
    const P = V(...st.P), n = V(...st.n).normalize();
    // u: the scan's long (z) axis laid into the surface plane; the bone's axis on an ankle CT
    let u = V(0, 0, 1).addScaledVector(n, -n.z); if (u.lengthSq() < 0.05) u = V(1, 0, 0).addScaledVector(n, -n.x);
    u.normalize();
    return { p, P, n, u, v: V().crossVectors(n, u).normalize() };
  }
  // the cut: through P + off along u, normal u turned by tiltA about v (towards the guide) and tiltB about n (sideways)
  function cutPlane(f) {
    const q = prm(), d = Math.PI / 180;
    const N = f.u.clone().applyAxisAngle(f.v, q.tiltA * d).applyAxisAngle(f.n, q.tiltB * d).normalize();
    return { p: f.P.clone().addScaledVector(f.u, q.off), N, w: q.kerf, off: q.off };
  }
  // K-wires: one above and one below the cut, on the guide's centre line, straight into the bone (-n)
  function pins(f) {
    const q = prm();
    return [1, -1].map(s => {
      const top = f.P.clone().addScaledVector(f.u, q.off + s * q.pinDu).addScaledVector(f.n, 15), dir = f.n.clone().negate();
      let entry = null;
      for (let t = 0; t <= 45; t += 0.25) { const x = top.clone().addScaledVector(dir, t); if (A.sdfAt(f.p, x) <= 0) { entry = x; break; } }
      return { entry, dir, side: s, sc: { d: q.pinD, D: q.pinD + 2.5, sleeveH: 8, len: 40 } };
    });
  }
  // the bone's section on the cut plane, holes filled: {fp, nA, R, h, a, b}
  function section(f, pl) {
    const N = pl.N, a = f.n.clone().addScaledVector(N, -f.n.dot(N)).normalize(), b = V().crossVectors(N, a);
    const h = 0.4, R = 45, nA = Math.round(2 * R / h) + 1, fp = new Uint8Array(nA * nA), x = V();
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) {
      x.copy(pl.p).addScaledVector(a, i * h - R).addScaledVector(b, j * h - R);
      if (A.sdfAt(f.p, x) <= 0) fp[i + nA * j] = 1;
    }
    // fill holes: everything not reached from the border through empty cells is inside
    const seen = new Uint8Array(nA * nA), q = [];
    for (let i = 0; i < nA; i++) for (const id of [i, i + nA * (nA - 1), i * nA, i * nA + nA - 1]) if (!fp[id] && !seen[id]) { seen[id] = 1; q.push(id); }
    while (q.length) { const id = q.pop(), i = id % nA, j = (id / nA) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nA || jj >= nA) continue; const k = ii + nA * jj; if (!fp[k] && !seen[k]) { seen[k] = 1; q.push(k); } } }
    let area = 0; for (let k = 0; k < fp.length; k++) if (!seen[k]) { fp[k] = 1; area++; }
    return { fp, nA, R, h, a, b, area: area * h * h };
  }
  // the opening wedge: thickness (s - sHinge) tan(angle) over the section; s along a (towards the guide)
  async function wedge(f, pl) {
    const q = prm(); if (!(q.deg > 0)) return null;
    const sec = section(f, pl), { fp, nA, R, h, a, b } = sec;
    let i0 = nA, i1 = -1, j0 = nA, j1 = -1;
    for (let j = 0; j < nA; j++) for (let i = 0; i < nA; i++) if (fp[i + nA * j]) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    if (i1 < 0) return null;
    const tn = Math.tan(q.deg * Math.PI / 180), sHinge = i0 * h, Hmax = (i1 - i0) * h * tn, PAD = 2;
    const nx = i1 - i0 + 1 + 2 * PAD, ny = j1 - j0 + 1 + 2 * PAD, nz = Math.ceil(Hmax / h) + 1 + 2 * PAD, m = new Uint8Array(nx * ny * nz);
    for (let k = PAD; k < nz - PAD; k++) for (let j = PAD; j < ny - PAD; j++) for (let i = PAD; i < nx - PAD; i++) {
      const fi = i0 + i - PAD, fj = j0 + j - PAD; if (!fp[fi + nA * fj]) continue;
      if ((k - PAD) * h <= (fi * h - sHinge) * tn) m[i + nx * (j + ny * k)] = 1;
    }
    const net = await St.blurNetsOf(m, nx, ny, nz);
    const toW = (x, y, z) => { const s = (i0 + x - PAD) * h - R, t = (j0 + y - PAD) * h - R, hh = (z - PAD) * h; return [0, 1, 2].map(k => { const c = 'xyz'[k]; return pl.p[c] + a[c] * s + b[c] * t + pl.N[c] * hh; }); };
    const mesh = St.meshFromNets(net, toW, new T.MeshStandardMaterial({ color: COL.wedge, roughness: 0.6, metalness: 0, side: T.DoubleSide, transparent: true, opacity: 0.85 }));
    return { mesh, info: { deg: q.deg, open: Hmax, width: (j1 - j0) * h, depth: (i1 - i0) * h, area: sec.area } };
  }

  // ---------- the joint: how far the cut and the wires stay from the articular surface ----------
  // all in the guide bone's own (CT) coordinates; the talus is sampled through both pieces' motions
  function jointPts(f) {
    const tal = A.pieces().find(p => p.role === 'talus' && p !== f.p); if (!tal) return null;
    const P = f.p.mesh.geometry.attributes.position.array, out = [], x = V();
    const step = Math.max(1, Math.floor(P.length / 3 / 40000));
    for (let v = 0; v < P.length / 3; v += step) {
      x.fromArray(P, 3 * v); const d = A.sdfAt(tal, A.toOwn(tal, A.toWorld(f.p, x)));
      if (d < JOINT.near) out.push(x.x, x.y, x.z);
    }
    return { tal, J: new Float32Array(out) };
  }
  const minTo = (J, x) => { let m = Infinity; for (let k = 0; k < J.length; k += 3) { const dx = J[k] - x.x, dy = J[k + 1] - x.y, dz = J[k + 2] - x.z, d = dx * dx + dy * dy + dz * dz; if (d < m) m = d; } return Math.sqrt(m); };
  function joint(f, pl, scs) {
    const jp = jointPts(f); if (!jp || !jp.J.length) return null;
    const { J, tal } = jp, sec = section(f, pl), x = V();
    // the saw: every cell of the bone's section on the cut plane (the blade cuts through the whole section)
    let slot = Infinity;
    for (let j = 0; j < sec.nA; j += 2) for (let i = 0; i < sec.nA; i += 2) {
      if (!sec.fp[i + sec.nA * j]) continue;
      x.copy(pl.p).addScaledVector(sec.a, i * sec.h - sec.R).addScaledVector(sec.b, j * sec.h - sec.R);
      const d = minTo(J, x); if (d < slot) slot = d;
    }
    // a wire: from where it enters the bone to where it leaves the far cortex (the last bone point within 60 mm)
    const pins = scs.map(s => {
      if (!s.entry) return null;
      let last = 0; const y = V();
      for (let t = 0; t <= 60; t += 0.5) { y.copy(s.entry).addScaledVector(s.dir, t); if (A.sdfAt(f.p, y) <= 0) last = t; }
      let d = Infinity, talus = false;
      for (let t = 0; t <= last; t += 0.5) {
        y.copy(s.entry).addScaledVector(s.dir, t); d = Math.min(d, minTo(J, y));
        if (A.sdfAt(tal, A.toOwn(tal, A.toWorld(f.p, y))) <= 0) talus = true;
      }
      return { d, len: last, talus };
    });
    return { slot, pins, n: J.length / 3 };
  }

  // ---------- build ----------
  const keyOf = () => JSON.stringify(st);
  async function make() {
    if (!on()) return;
    const f = frame(); if (!f) { St.alertMsg(xl('Önce guide\'ın oturacağı kemiğe tıklayın.')); return; }
    const me = job = {}, key = keyOf(), q = prm(), pl = cutPlane(f), scs = pins(f);
    const g = Object.assign({}, St.G_DEFAULT, { L: q.L, W: q.W, wrap: q.wrap, wall: q.wall, uc: q.off, vc: 0, split: 0, rot: 0, roll: 0, bar: 0, stopP: 0, stopT: 0, stopB: 0, wrapU: null });
    const occ = x => { const s = A.sdfAt(f.p, x); return s === Infinity ? 0 : Math.max(0, Math.min(1, 0.5 - s / 0.8)); };
    St.busy(true, xl('Guide oluşturuluyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      const r = await St.buildGuide({ g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [pl], scs, bone: x => A.sdfAt(f.p, x) <= 0, field: occ, h: 0.4 });
      if (me !== job) return;
      const w = await wedge(f, pl);
      if (me !== job) return;
      const pins_ = r.result.screwInfo.map((s, i) => ({ side: scs[i].side, ok: !!s.ok, entry: !!scs[i].entry, inBone: s.inBone || 0, crosses: !!s.crossesPlane }));
      const jt = joint(f, pl, scs);
      out = { key, piece: f.p, guide: r.mesh, wedge: w && w.mesh, prod: null, req: { g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [pl], scs, wrapProfile: r.result.wrapProfile, seatDir: r.result.seatDir, gap: null }, info: { volume: r.result.volume, contact: r.result.contact, pieces: r.result.pieces, pins: pins_, wedge: w && w.info, joint: jt } };
      show(); St.emit('changed');
    } catch (e) { St.alertMsg(xl('Guide oluşturulamadı: ') + (e.message || e)); }
    finally { if (me === job) { job = null; St.busy(false); } render(); }
  }
  // the production STL: the same body, slot and sleeves on the server (Manifold, 0.2 mm), on the full-resolution CT of
  // this piece only (the piece's cells of the segmentation, as a field on the reduced grid)
  async function production() {
    if (!ready() || !St.serverGuide) return;
    const me = out, p = out.piece, r = S.red, F = new Float32Array(r.nx * r.ny * r.nz);
    const L = A.labels(); for (let i = 0; i < F.length; i++) if (L[i] === p.label) F[i] = 1;
    St.busy(true, xl('Üretim STL\'i sunucuda hazırlanıyor…'), { f: 0, restart: true });
    try {
      const thr = +($('thr') ? $('thr').value : 300);
      const res = await St.serverGuide(Object.assign({ vol: S.vol, red: r, F, thr }, out.req), null, f => St.busy(true, xl('Üretim STL\'i sunucuda hazırlanıyor…'), { f }));
      if (me !== out) return;
      out.prod = res; St.emit('changed');
      if (!res.productionOk) St.alertMsg(xl('Sunucu üretim STL\'ini basıma uygun bulmadı: ') + (res.issues || []).map(i => i.code).join(', '));
    } catch (e) { St.alertMsg(String(e.message || e)); }
    finally { St.busy(false); render(); }
  }
  function holder(id, label, mesh, color, p) {
    if (!mesh) { St.setPart(id, null, null); delete holders[id]; return; }
    const g = new T.Group(); mesh.position.copy(p.c).negate(); g.add(mesh); g.userData.piece = p; holders[id] = g;
    St.setPart(id, label, g, color); sync();
  }
  function sync() { Object.values(holders).forEach(g => { const pv = g.userData.piece.pivot; g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); g.updateMatrixWorld(true); }); }
  function show() {
    const live = out && out.key === keyOf() && on();
    holder('ankGuide', xl('Guide'), live ? out.guide : null, COL.guide, out && out.piece);
    holder('ankWedge', xl('Kama'), live ? out.wedge : null, COL.wedge, out && out.piece);
    St.renderParts(); St.render();
  }
  function drop() { job = null; out = null; holder('ankGuide', '', null); holder('ankWedge', '', null); St.renderParts && St.renderParts(); }

  // ---------- placing: a click on a piece while "Yerleştir" is on ----------
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = picking && on() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const meshes = A.pieces().filter(p => p.role !== 'out' && p.mesh.parent && p.mesh.parent.visible).map(p => p.mesh);
    const h = St.ray.intersectObjects(meshes, false)[0]; if (!h) return;
    const p = h.object.userData.ankle, nW = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    place(p, A.toOwn(p, h.point), nW.applyQuaternion(p.q.clone().invert()));
    picking = false; render();
  });
  // a placement in the piece's own coordinates; the normal is averaged over the bone around the point (as app.js frameAt)
  function place(p, P, nGuess) {
    let n = nGuess.clone().normalize();
    const e = 1.0, g = V((A.sdfAt(p, V(P.x + e, P.y, P.z)) - A.sdfAt(p, V(P.x - e, P.y, P.z))), (A.sdfAt(p, V(P.x, P.y + e, P.z)) - A.sdfAt(p, V(P.x, P.y - e, P.z))), (A.sdfAt(p, V(P.x, P.y, P.z + e)) - A.sdfAt(p, V(P.x, P.y, P.z - e))));
    if (isFinite(g.length()) && g.length() > 1e-6) n = g.normalize().add(n).normalize();
    st = { piece: p.name, c: r3(p.c), P: r3(P), n: r3(n), prm: Object.assign({}, st ? st.prm : DEF) };
    changed();
  }
  function changed() { if (out && out.key !== keyOf()) { out = null; show(); } St.emit('changed'); render(); }

  // ---------- panel ----------
  const SL = [['off', 'Kesi yüksekliği', 'mm', 1], ['tiltA', 'Kesi eğimi (guide yönünde)', '°', 1], ['tiltB', 'Kesi eğimi (yana)', '°', 1], ['deg', 'Kama açısı', '°', 0.5], ['kerf', 'Testere yarığı', 'mm', 0.1],
    ['L', 'Guide boyu', 'mm', 1], ['W', 'Guide eni', 'mm', 1], ['wrap', 'Sarma derinliği', 'mm', 0.5], ['wall', 'Duvar', 'mm', 0.5], ['pinD', 'K-teli çapı', 'mm', 0.1], ['pinDu', 'Tel ile kesi arası', 'mm', 1]];
  function render() {
    const box = $('ankGuideBox'); if (!box) return;
    const f = frame(), q = prm(), live = out && out.key === keyOf();
    const sl = ([k, lbl, unit, step]) => `<div class="ctl"><div class="ctl-row"><label for="ag_${k}">${xl(lbl)}</label><output id="ag_${k}O">${fmt(q[k], step < 1 ? 1 : 0)} ${unit}</output></div><input type="range" id="ag_${k}" min="${LIM[k][0]}" max="${LIM[k][1]}" step="${step}" value="${q[k]}" ${f ? '' : 'disabled'}></div>`;
    const info = live ? out.info : null, w = info && info.wedge;
    box.innerHTML = `<p class="hint more">${xl('Guide\'ın oturacağı kemiğe (genelde distal tibia) tıklayın; tıklanan nokta guide\'ın merkezi, oradaki yüzey oturma yönüdür. Kesi guide\'ın ortasından geçer; ayarları değiştirip guide\'ı yeniden oluşturun.')}</p>
      <div class="btns"><button id="agPick" aria-pressed="${picking}">${picking ? xl('Kemiğe tıklayın…') : f ? xl('Yeniden yerleştir') : xl('Yerleştir')}</button>
      <button class="primary" id="agMake" ${f && !job ? '' : 'disabled'}>${xl('Guide oluştur')}</button>
      <button id="agProd" ${live && !job ? '' : 'disabled'} title="${xl('Aynı guide sunucuda 0,2 mm ızgarada, su geçirmez olarak üretilir.')}">${xl('Üretim STL\'i')}</button></div>
      ${f ? `<p class="hint">${xl('Kemik')}: <b>${esc(f.p.name)}</b></p>` : ''}
      <details class="sec" open><summary>${xl('Kesi ve kama')}</summary><div class="col">${SL.slice(0, 5).map(sl).join('')}</div></details>
      <details class="sec"><summary>${xl('Guide gövdesi ve teller')}</summary><div class="col">${SL.slice(5).map(sl).join('')}</div></details>
      ${info ? `<dl class="kv"><dt>${xl('Guide hacmi')}</dt><dd>${fmt(info.volume / 1000, 1)} cm³</dd><dt>${xl('Temas alanı')}</dt><dd>${fmt(info.contact, 0)} mm²</dd>
        <dt>${xl('K-telleri')}</dt><dd>${info.pins.map(p => (p.ok ? `${fmt(p.inBone, 0)} mm ${xl('kemikte')}` : xl('yok'))).join(' · ')}</dd>
        <dt>${xl('Eklemden uzaklık')}</dt><dd>${info.joint ? `${xl('kesi')} ${fmt(info.joint.slot, 1)} mm · ${xl('teller')} ${info.joint.pins.map(p => (p ? fmt(p.d, 1) : '–')).join(' / ')} mm` : xl('ölçülemedi')}</dd>
        <dt>${xl('Üretim STL\'i')}</dt><dd>${out.prod ? (out.prod.productionOk ? `${xl('hazır')} · ${fmt(out.prod.volume / 1000, 1)} cm³` : xl('basıma uygun değil')) : xl('alınmadı')}</dd>
        ${w ? `<dt>${xl('Kama')}</dt><dd>${fmt(w.deg, 1)}° · ${xl('açılma')} ${fmt(w.open, 1)} mm · ${fmt(w.depth, 0)} × ${fmt(w.width, 0)} mm</dd>` : ''}</dl>` : f ? `<p class="hint">${xl('Ayarlar değişti ya da guide henüz oluşturulmadı.')}</p>` : ''}`;
    $('agPick').addEventListener('click', () => { picking = !picking; render(); });
    $('agMake').addEventListener('click', () => make());
    $('agProd').addEventListener('click', () => production());
    SL.forEach(([k, , unit, step]) => { const el = $('ag_' + k); if (!el) return;
      el.addEventListener('input', () => { $('ag_' + k + 'O').textContent = `${fmt(+el.value, step < 1 ? 1 : 0)} ${unit}`; });
      el.addEventListener('change', () => { if (!st) return; st.prm = Object.assign({}, st.prm, { [k]: clamp(k, el.value) }); changed(); }); });
  }

  // ---------- checks, outputs, plan ----------
  function checks() {
    if (!on() || !st) return [];
    const o = [];
    if (!(out && out.key === keyOf())) { o.push(['warn', 'Uyarı', xl('Guide ayarları değişti; guide\'ı yeniden oluşturun.'), 'ank']); return o; }
    out.info.pins.forEach(p => {
      const nm = p.side > 0 ? xl('Üst K-teli') : xl('Alt K-teli');
      if (!p.entry || !p.ok) o.push(['warn', 'Uyarı', xl(`${nm} kemiğe ulaşmıyor ya da guide gövdesinin dışında kaldı.`), 'ank']);
      else if (p.crosses) o.push(['crit', 'Kritik', xl(`${nm} testere yarığını kesiyor; teli kesiden uzaklaştırın.`), 'ank']);
      else if (p.inBone < 10) o.push(['warn', 'Uyarı', xl(`${nm} kemikte yalnız ${fmt(p.inBone, 0)} mm ilerliyor.`), 'ank']);
    });
    if (out.info.pieces > 1) o.push(['warn', 'Uyarı', xl('Guide birden fazla parçaya bölündü; ölçüleri büyütün.'), 'ank']);
    const jt = out.info.joint;
    if (!jt) o.push(['warn', 'Uyarı', xl('Eklem yüzeyi bulunamadı (talus yok ya da guide kemiğine değmiyor); kesinin ve tellerin ekleme uzaklığı denetlenmedi.'), 'ank']);
    else {
      if (jt.slot < JOINT.min) o.push(['crit', 'Kritik', xl(`Testere kesisi eklem yüzeyine ${fmt(jt.slot, 1)} mm yaklaşıyor (en az ${JOINT.min} mm); kesiyi eklemden uzaklaştırın.`), 'ank']);
      jt.pins.forEach((p, i) => {
        if (!p) return; const nm = out.info.pins[i] && out.info.pins[i].side > 0 ? xl('Üst K-teli') : xl('Alt K-teli');
        if (p.talus) o.push(['crit', 'Kritik', xl(`${nm} eklemi geçip talusa giriyor; teli kaldırın ya da yönünü değiştirin.`), 'ank']);
        else if (p.d < JOINT.min) o.push(['crit', 'Kritik', xl(`${nm} eklem yüzeyine ${fmt(p.d, 1)} mm yaklaşıyor (en az ${JOINT.min} mm).`), 'ank']);
      });
    }
    if (!(out.prod && out.prod.productionOk)) o.push(['warn', 'Uyarı', xl('Guide\'ın üretim STL\'i alınmadı; pakette yalnız tarayıcı önizlemesi var (dosya adı "BASMAYIN"). Kesi guide\'ı adımında "Üretim STL\'i" düğmesine basın.'), 'ank']);
    return o;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);
  const ready = () => !!(out && out.key === keyOf() && on());
  // One frame for every file of the package: the CT's patient coordinates (LPS, mm) with every piece in its planned
  // (reduced) position, the frame of the reduced model. The guide and the wedge are built on their piece in its CT
  // position and carried here by that piece's motion x' = q (x - c) + c + t (cerceve.json, ankle.js, has every motion).
  function toPlan(stl, p) {
    if (!p || !A.moved(p)) return stl;
    const u = stl.slice(), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = dv.getUint32(80, true), x = V();
    for (let t = 0, o = 84; t < n; t++, o += 50) for (let k = 0; k < 4; k++) {
      const b = o + 12 * k; x.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true));
      if (k === 0) x.applyQuaternion(p.q); else x.copy(A.toWorld(p, x));
      dv.setFloat32(b, x.x, true); dv.setFloat32(b + 4, x.y, true); dv.setFloat32(b + 8, x.z, true);
    }
    return u;
  }
  // the guide: the server's production STL when there is one; else the browser preview, named so it is not printed
  function files() {
    if (!ready()) return [];
    const p = out.piece, prod = out.prod && out.prod.productionOk;
    const fs = [prod ? { name: 'guide/kesi_guide.stl', data: toPlan(out.prod.stl, p) } : { name: 'guide/kesi_guide_onizleme_BASMAYIN.stl', data: toPlan(St.stlOf(out.guide), p) }];
    if (out.wedge) fs.push({ name: 'guide/kama.stl', data: toPlan(St.stlOf(out.wedge), p) });
    return fs;
  }
  (window.PlanExt = window.PlanExt || {}).ankGuide = {
    label: 'Malleol guide\'ı',
    get: () => (on() && st ? JSON.parse(JSON.stringify(st)) : null),
    set(x) {
      const ok = x && typeof x.piece === 'string' && [x.c, x.P, x.n].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite));
      if (!ok) { st = null; drop(); render(); return; }
      const p0 = Object.assign({}, DEF); Object.keys(DEF).forEach(k => { if (x.prm && Number.isFinite(+x.prm[k])) p0[k] = clamp(k, x.prm[k]); });
      st = { piece: x.piece.slice(0, 40), c: x.c.map(Number), P: x.P.map(Number), n: x.n.map(Number), prm: p0 }; out = null; show(); render();
    },
  };

  bus.addEventListener('changed', () => { sync(); St.render(); });
  bus.addEventListener('caseType', () => { if (!on()) { st = null; drop(); } render(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { st = null; } drop(); render(); });
  bus.addEventListener('bone', () => { drop(); render(); });
  bus.addEventListener('ankPieces', () => { drop(); render(); });
  if ($('stAnkG')) $('stAnkG').addEventListener('toggle', () => { if (!$('stAnkG').open) { picking = false; } render(); });
  render();
  return { on, place, make, production, frame, cutPlane, pins, section, files, ready, checks, joint, toPlan, JOINT, state: () => st, info: () => (out ? out.info : null), parts: () => out, LIM, DEF, set: (k, v) => { if (st) { st.prm = Object.assign({}, st.prm, { [k]: clamp(k, v) }); changed(); } } };
})();
