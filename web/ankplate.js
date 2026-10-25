/* Patient-specific external plate for the opening wedge osteotomy (malleolar fracture case type): a plate shaped on the
   corrected tibia (ankcorr.js) that holds the new alignment, with screw holes on both sides of the cut.

   The plate sits on the guide side (where the cut opens) over the osteotomy. Its frame is the guide's (u along the bone,
   n out of the bone, v across), on the proximal tibia; the holes are on the plate's centre line, nP over the cut along u
   and nD under it in the turned distal frame (the distal tibia's own u and n after the correction), the first at `first`
   mm from the cut, then every `pitch` mm. The body is the studio's guide shell (app.js buildGuide + gkernel.js) on the
   corrected bone with the wedge's gap filled: a band `t` thick at `gap` from the bone, a shallow wrap so it lies on the
   surface instead of around it, no slot, flush holes. Each screw runs square to its bone part into the far cortex; its
   length is the plate, the near cortex to the far one and 1 mm past it, rounded up to the system's lengths.
   The production STL is the same body on the server (Manifold, 0.2 mm) on the corrected bone resampled on the reduced
   grid. Defaults (system, sizes, 5 mm from the cut and the joint) are sample values: the clinical team and the
   manufacturer set the final ones. Research prototype, not for clinical use. */
'use strict';
// Geo: geom.js's G (a script-level const, not on window; the G inside is the ankle guide module)
window.AnkPlate = (function (Geo) {
  const St = window.Studio, A = window.Ankle, G = window.AnkGuide, C = window.AnkCorr; if (!St || !A || !G || !C || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  const COL = { plate: 0xa9b6c4, screw: 0x6b7b8b };
  // screw systems (typical small-fragment values; the plate's maker sets them): screw, plate hole, lengths on offer
  const SYS = {
    s35: { name: '3,5 mm küçük fragman', d: 3.5, hole: 3.7, lens: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 45, 50, 55, 60] },
    s27: { name: '2,7 mm', d: 2.7, hole: 2.9, lens: [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40] },
  };
  const DEF = { W: 12, t: 3, gap: 0.15, nP: 3, nD: 3, pitch: 10, first: 10 };
  const LIM = { W: [8, 20], t: [1.5, 5], gap: [0, 0.5], nP: [1, 5], nD: [1, 5], pitch: [6, 16], first: [6, 25] };
  // sample thresholds (clinical decision): a screw keeps CUT_MIN mm from the osteotomy and JOINT.min from the joint;
  // at least MIN_SIDE screws in bone on each side; a screw shorter than IN_MIN mm in bone holds poorly
  const RULE = { cutMin: 5, minSide: 2, inMin: 10, past: 1 };
  let st = null;          // { sys, prm } the plate's settings (in the plan)
  let out = null;         // { key, mesh, screws, info, req, prod } the last build
  let job = null;
  const holders = {};

  const clamp = (k, x) => Math.max(LIM[k][0], Math.min(LIM[k][1], k === 'nP' || k === 'nD' ? Math.round(+x) : +x));
  const prm = () => (st ? st.prm : Object.assign({}, DEF));
  const sys = () => SYS[st && st.sys] || SYS.s35;
  const corrKey = () => { const r = C.result(); return r ? r.key : ''; };
  const keyOf = () => JSON.stringify(st) + '|' + corrKey();
  const occ = d => (d === Infinity ? 0 : Math.max(0, Math.min(1, 0.5 - d / 0.8)));

  // ---------- screws ----------
  // the holes: entry on the corrected bone, direction into it, the part (1 proximal, -1 distal) and the hole's place
  function holes(o, fd) {
    const q = prm(), f = o.f, P0 = o.pl.p, R = new T.Matrix3().setFromMatrix4(o.M), out = [];
    const uD = f.u.clone().applyMatrix3(R).normalize(), nD = f.n.clone().applyMatrix3(R).normalize();
    for (const side of [1, -1]) {
      const k = side > 0 ? q.nP : q.nD;
      for (let i = 0; i < k; i++) {
        const s = q.first + i * q.pitch;
        // proximal: along u from the cut; distal: the same in the distal tibia's turned frame (from the cut's point turned)
        const base = side > 0 ? P0.clone().addScaledVector(f.u, s) : P0.clone().applyMatrix4(o.M).addScaledVector(uD, -s);
        const n = side > 0 ? f.n : nD, dir = n.clone().negate(), top = base.clone().addScaledVector(n, 15);
        let entry = null;
        for (let t = 0; t <= 45; t += 0.2) { const x = top.clone().addScaledVector(dir, t); if (fd(x) <= 0) { entry = x; break; } }
        out.push({ side, i, s, entry, dir, n });
      }
    }
    return out;
  }
  // a screw's run in the corrected bone: where it leaves the far cortex, how close it comes to the cut and to the joint
  function screwRun(o, fd, h, jointAt) {
    if (!h.entry) return null;
    const y = V(), P0 = o.pl.p, N = o.N; let last = 0, cut = Infinity, joint = Infinity, talus = false;
    for (let t = 0; t <= 70; t += 0.25) { y.copy(h.entry).addScaledVector(h.dir, t); if (fd(y) <= 0) last = t; }
    for (let t = 0; t <= last; t += 0.25) {
      y.copy(h.entry).addScaledVector(h.dir, t);
      // the cut: the proximal face (plane z = 0) for a proximal screw, the turned distal face for a distal one
      const z = h.side > 0 ? y.clone().sub(P0).dot(N) : -y.clone().applyMatrix4(o.Mi).sub(P0).dot(N);
      cut = Math.min(cut, z - sys().d / 2);
      const j = jointAt(y); joint = Math.min(joint, j.d); if (j.talus) talus = true;
    }
    const q = prm(), need = q.t + q.gap + last + RULE.past, L = sys().lens.find(x => x >= need - 1e-6) || null;
    return { inBone: last, cut, joint, talus, need, L };
  }
  // the joint in the corrected frame: the tibia's articular surface (within JOINT.near of the talus, CT position) turned
  // with the distal part; the talus turned with it
  function jointOf(o) {
    const tib = o.f.p, tal = A.pieces().find(p => p.role === 'talus' && p !== tib);
    if (!tal) return () => ({ d: Infinity, talus: false });
    const P = tib.mesh.geometry.attributes.position.array, J = [], x = V(), step = Math.max(1, Math.floor(P.length / 3 / 30000));
    for (let v = 0; v < P.length / 3; v += step) { x.fromArray(P, 3 * v); if (A.sdfAt(tal, A.toOwn(tal, A.toWorld(tib, x))) < G.JOINT.near) { x.applyMatrix4(o.M); J.push(x.x, x.y, x.z); } }
    const w = V();
    return y => {
      let m = Infinity; for (let k = 0; k < J.length; k += 3) { const dx = J[k] - y.x, dy = J[k + 1] - y.y, dz = J[k + 2] - y.z, d = dx * dx + dy * dy + dz * dz; if (d < m) m = d; }
      w.copy(y).applyMatrix4(o.Mi);
      return { d: Math.sqrt(m), talus: A.sdfAt(tal, A.toOwn(tal, A.toWorld(tib, w))) <= 0 };
    };
  }

  // ---------- build ----------
  async function make() {
    if (!on()) return;
    // the plate is shaped on the corrected tibia: made (and shown) first when it is not there
    if (!C.visible() || !C.live()) await C.toggle(true);
    if (!C.result()) { St.alertMsg(xl('Önce guide\'ı yerleştirin; kesi düzlemi ve kama açısı oradan alınır.')); return; }
    if (!st) st = { sys: 's35', prm: Object.assign({}, DEF) };
    const me = job = {}, key = keyOf(), r = C.result(), o = r.o, f = o.f, q = prm(), sy = sys();
    const fd = C.field(o, true), hs = holes(o, fd);
    // the body box along u covers every hole with 7 mm beyond the outermost ones
    const us = hs.filter(h => h.entry).map(h => h.entry.clone().sub(o.pl.p).dot(f.u));
    if (us.length < 2) { St.alertMsg(xl('Plak delikleri kemiğe ulaşmıyor; plağı ya da guide\'ı taşıyın.')); job = null; return; }
    const uA = Math.min(...us) - 7, uB = Math.max(...us) + 7;
    const g = Object.assign({}, St.G_DEFAULT, { L: uB - uA, W: q.W, wrap: 1.5, wall: q.t, uc: (uA + uB) / 2 + o.pl.p.clone().sub(f.P).dot(f.u), vc: 0, split: 0, rot: 0, roll: 0, bar: 0, bridge: 0, stopP: 0, stopT: 0, stopB: 0, wrapU: null, clear: q.gap, fit: 0, blade: 0, boss: 0 });
    const scs = hs.map(h => ({ entry: h.entry, dir: h.dir, side: h.side, sc: { d: sy.hole, D: sy.hole + 3, sleeveH: 0, len: 60 } }));
    St.busy(true, xl('Plak oluşturuluyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      const res = await St.buildGuide({ g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [], scs, bone: x => fd(x) <= 0, field: x => occ(fd(x)), h: 0.4 });
      if (me !== job) return;
      const jointAt = jointOf(o);
      const screws = hs.map((h, i) => Object.assign({ ok: !!(res.result.screwInfo[i] && res.result.screwInfo[i].ok) }, h, { run: screwRun(o, fd, h, jointAt) }));
      res.mesh.material = new T.MeshStandardMaterial({ color: COL.plate, roughness: 0.45, metalness: 0.15, side: T.DoubleSide });
      out = { key, o, mesh: res.mesh, screws, prod: null, req: { g, P: f.P, u: f.u, v: f.v, n: f.n, pls: [], scs, wrapProfile: res.result.wrapProfile, seatDir: res.result.seatDir, gap: null },
        info: { volume: res.result.volume, contact: res.result.contact, pieces: res.result.pieces, length: uB - uA, sys: sy.name } };
      show(); St.emit('changed');
    } catch (e) { St.alertMsg(xl('Plak oluşturulamadı: ') + (e.message || e)); }
    finally { if (me === job) { job = null; St.busy(false); } render(); }
  }
  // the production STL: the same body on the server, on the corrected bone (gap filled) resampled on the reduced grid
  // around the plate (the CT values cannot be used: the distal tibia has moved)
  async function production() {
    if (!ready() || !St.serverGuide) return;
    const me = out, r = S.red, F = new Float32Array(r.nx * r.ny * r.nz), fd = C.field(out.o, true), x = V();
    const pts = out.screws.filter(s => s.entry).map(s => s.entry), c = pts.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / pts.length);
    const Rr = out.info.length / 2 + 45, ic = G0().indexOf(r, [c.x, c.y, c.z]), lo = [0, 1, 2].map(a => Math.max(0, Math.floor(ic[a] - Rr / r.sp[a]))), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, Math.ceil(ic[a] + Rr / r.sp[a])));
    St.busy(true, xl('Plağın üretim STL\'i sunucuda hazırlanıyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      for (let k = lo[2]; k <= hi[2]; k++) { for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) { const w = G0().worldOf(r, i, j, k); x.set(w[0], w[1], w[2]); F[i + r.nx * (j + r.ny * k)] = fd(x) <= 0 ? 1 : 0; } if (k % 10 === 0) await St.sleep(); }
      if (me !== out) return;
      const res = await St.serverGuide(Object.assign({ vol: S.vol, red: r, F, thr: null, ed: null }, out.req), null, f => St.busy(true, xl('Plağın üretim STL\'i sunucuda hazırlanıyor…'), { f }));
      if (me !== out) return;
      out.prod = res; St.emit('changed');
      if (!res.productionOk) St.alertMsg(xl('Sunucu plağın üretim STL\'ini uygun bulmadı: ') + (res.issues || []).map(i => i.code).join(', '));
    } catch (e) { St.alertMsg(String(e.message || e)); }
    finally { St.busy(false); render(); }
  }
  const G0 = () => Geo;
  const ready = () => !!(out && out.key === keyOf() && on());

  // ---------- show ----------
  function holder(id, label, obj, color, p) {
    if (!obj) { St.setPart(id, null, null); delete holders[id]; return; }
    const g = new T.Group(); obj.position.copy(p.c).negate(); g.add(obj); g.userData.piece = p; holders[id] = g;
    St.setPart(id, label, g, color); sync();
  }
  function sync() { Object.values(holders).forEach(g => { const pv = g.userData.piece.pivot; g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); g.updateMatrixWorld(true); }); }
  function screwGroup() {
    const g = new T.Group(), mat = new T.MeshStandardMaterial({ color: COL.screw, roughness: 0.4, metalness: 0.5 });
    out.screws.forEach(s => {
      if (!s.entry || !s.run || !s.run.L) return;
      const L = s.run.L, top = s.entry.clone().addScaledVector(s.n, prm().t + prm().gap), c = top.clone().addScaledVector(s.dir, L / 2);
      const m = new T.Mesh(new T.CylinderGeometry(sys().d / 2, sys().d / 2, L, 16), mat.clone());
      m.position.copy(c); m.quaternion.setFromUnitVectors(V(0, 1, 0), s.dir.clone().negate()); g.add(m);
    });
    return g;
  }
  // the plate is in the corrected frame: shown with the corrected preview only
  function show() {
    const ok = ready() && C.visible(), p = out && out.o.f.p;
    holder('ankPlate', xl('Dış plak'), ok ? out.mesh : null, COL.plate, p);
    holder('ankPlateScrews', xl('Plak vidaları'), ok ? screwGroup() : null, COL.screw, p);
    St.renderParts(); St.render();
  }
  function drop() { job = null; out = null; holder('ankPlate', '', null); holder('ankPlateScrews', '', null); }

  // ---------- checks ----------
  function checks() {
    if (!on() || !st) return [];
    const o = [];
    if (!ready()) { o.push(['warn', 'Uyarı', xl('Plak ayarları ya da düzeltme değişti; plağı yeniden oluşturun.'), 'ank']); return o; }
    // a screw's name and the message after it are translated apart (the name carries the hole number)
    const sc = out.screws, say = (s, t) => `${xl(s.side > 0 ? 'Proksimal vida' : 'Distal vida')} ${s.i + 1}: ${xl(t)}`;
    sc.forEach(s => {
      const r = s.run;
      if (!s.entry || !s.ok || !r) { o.push(['warn', 'Uyarı', say(s, 'kemiğe ulaşmıyor ya da plak gövdesinin dışında.'), 'ank']); return; }
      if (r.talus) o.push(['crit', 'Kritik', say(s, 'eklemi geçip talusa giriyor.'), 'ank']);
      else if (r.joint < G.JOINT.min) o.push(['crit', 'Kritik', say(s, `eklem yüzeyine ${fmt(r.joint, 1)} mm yaklaşıyor (en az ${G.JOINT.min} mm, örnek eşik).`), 'ank']);
      if (r.cut < RULE.cutMin) o.push(['crit', 'Kritik', say(s, `osteotomiye ${fmt(Math.max(0, r.cut), 1)} mm yakın (en az ${RULE.cutMin} mm, örnek eşik); deliği kesiden uzaklaştırın.`), 'ank']);
      if (r.inBone < RULE.inMin) o.push(['warn', 'Uyarı', say(s, `kemikte yalnız ${fmt(r.inBone, 0)} mm ilerliyor.`), 'ank']);
      if (!r.L) o.push(['warn', 'Uyarı', say(s, `gereken boy ${fmt(r.need, 0)} mm sistemde yok.`), 'ank']);
    });
    for (const side of [1, -1]) {
      const good = sc.filter(s => s.side === side && s.ok && s.run && !s.run.talus && s.run.joint >= G.JOINT.min && s.run.cut >= RULE.cutMin && s.run.inBone >= RULE.inMin).length;
      if (good < RULE.minSide) o.push(['crit', 'Kritik', side > 0 ? xl(`Proksimal tarafta ${good} sağlam vida var (en az ${RULE.minSide}, örnek eşik); düzeltme sabitlenmez.`) : xl(`Distal tarafta ${good} sağlam vida var (en az ${RULE.minSide}, örnek eşik); düzeltme sabitlenmez.`), 'ank']);
    }
    if (out.info.pieces > 1) o.push(['warn', 'Uyarı', xl('Plak birden fazla parçaya bölündü; eni ya da kalınlığı artırın.'), 'ank']);
    if (!(out.prod && out.prod.productionOk)) o.push(['warn', 'Uyarı', xl('Plağın üretim STL\'i alınmadı; pakette yalnız tarayıcı önizlemesi var (dosya adı "BASMAYIN").'), 'ank']);
    o.push(['info', 'Bilgi', xl('Plak metal (ör. titanyum) üretim için bir tasarım taslağıdır; malzeme, kalınlık ve vida sistemi üreticiyle doğrulanır.'), 'ank']);
    return o;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);

  // ---------- outputs ----------
  function screwList() {
    if (!ready()) return [];
    return out.screws.filter(s => s.entry && s.run).map(s => ({ taraf: s.side > 0 ? 'proksimal' : 'distal', no: s.i + 1, cap_mm: sys().d, boy_mm: s.run.L, kemikte_mm: +s.run.inBone.toFixed(1), kesiye_mm: +Math.max(0, s.run.cut).toFixed(1), ekleme_mm: s.run.joint === Infinity ? null : +s.run.joint.toFixed(1) }));
  }
  function files() {
    if (!ready()) return [];
    const p = out.o.f.p, prod = out.prod && out.prod.productionOk;
    const rows = screwList(), csv = ['taraf;no;cap_mm;boy_mm;kemikte_mm;kesiye_mm;ekleme_mm', ...rows.map(r => [r.taraf, r.no, r.cap_mm, r.boy_mm == null ? '' : r.boy_mm, r.kemikte_mm, r.kesiye_mm, r.ekleme_mm == null ? '' : r.ekleme_mm].join(';'))].join('\n');
    return [prod ? { name: 'plak/plak.stl', data: G.toPlan(out.prod.stl, p) } : { name: 'plak/plak_onizleme_BASMAYIN.stl', data: G.toPlan(St.stlOf(out.mesh), p) }, { name: 'plak/plak_vidalari.csv', data: csv }];
  }

  // ---------- panel ----------
  const SL = [['first', 'İlk delik kesiden', 'mm', 0.5], ['pitch', 'Delik aralığı', 'mm', 0.5], ['nP', 'Proksimal delik', '', 1], ['nD', 'Distal delik', '', 1], ['W', 'Plak eni', 'mm', 0.5], ['t', 'Plak kalınlığı', 'mm', 0.1], ['gap', 'Kemik boşluğu', 'mm', 0.05]];
  function changed() { if (out && out.key !== keyOf()) { out = null; show(); } St.emit('changed'); render(); }
  function render() {
    const box = $('ankPlateBox'); if (!box) return;
    if (!on()) { box.innerHTML = ''; return; }
    const q = prm(), live = ready(), sy = sys();
    const sl = ([k, lbl, unit, step]) => `<div class="ctl"><div class="ctl-row"><label for="ap_${k}">${xl(lbl)}</label><output id="ap_${k}O">${fmt(q[k], step < 1 ? (step < 0.1 ? 2 : 1) : 0)} ${unit}</output></div><input type="range" id="ap_${k}" min="${LIM[k][0]}" max="${LIM[k][1]}" step="${step}" value="${q[k]}"></div>`;
    const rows = live ? screwList() : [];
    box.innerHTML = `<p class="hint more">${xl('Plak düzeltilmiş kemiğe, kesinin açıldığı tarafta oturur; delikler kesinin üstünde ve altında, vidalar karşı kortekse kadar. Düzeltilmiş şekil yoksa önce o hesaplanır.')}</p>
      <div class="btns"><button class="primary" id="apMake" ${G.frame() && !job ? '' : 'disabled'}>${xl('Plak oluştur')}</button>
      <button id="apProd" ${live && !job ? '' : 'disabled'} title="${xl('Aynı plak sunucuda 0,2 mm ızgarada, su geçirmez olarak üretilir.')}">${xl('Üretim STL\'i')}</button></div>
      <details class="sec"><summary>${xl('Plak ve delikler')}</summary><div class="col">
        <div class="ctl"><div class="ctl-row"><label for="ap_sys">${xl('Vida sistemi')}</label></div><select id="ap_sys">${Object.entries(SYS).map(([k, s]) => `<option value="${k}" ${(st ? st.sys : 's35') === k ? 'selected' : ''}>${xl(s.name)}</option>`).join('')}</select></div>
        ${SL.map(sl).join('')}</div></details>
      ${live ? `<dl class="kv"><dt>${xl('Plak')}</dt><dd>${fmt(out.info.length, 0)} × ${fmt(q.W, 0)} × ${fmt(q.t, 1)} mm · ${fmt(out.info.volume / 1000, 1)} cm³</dd>
        <dt>${xl('Temas alanı')}</dt><dd>${fmt(out.info.contact, 0)} mm²</dd>
        <dt>${xl('Vidalar')}</dt><dd>${rows.map(r => `${r.taraf === 'proksimal' ? 'P' : 'D'}${r.no} ${r.boy_mm ? fmt(r.boy_mm, 0) + ' mm' : '–'}`).map(esc).join(' · ')} (${xl(sy.name)})</dd>
        <dt>${xl('Üretim STL\'i')}</dt><dd>${out.prod ? (out.prod.productionOk ? `${xl('hazır')} · ${fmt(out.prod.volume / 1000, 1)} cm³` : xl('uygun değil')) : xl('alınmadı')}</dd></dl>
        <p class="hint more">${xl('Varsayılan ölçüler ve eşikler örnektir (klinik karar); plak metal üretim için taslaktır, üretici doğrular.')}</p>` : st ? `<p class="hint">${xl('Ayarlar değişti ya da plak henüz oluşturulmadı.')}</p>` : ''}`;
    $('apMake').addEventListener('click', () => make());
    $('apProd').addEventListener('click', () => production());
    $('ap_sys').addEventListener('change', e => { if (!SYS[e.target.value]) return; st = st || { sys: 's35', prm: Object.assign({}, DEF) }; st.sys = e.target.value; changed(); });
    SL.forEach(([k, , unit, step]) => { const el = $('ap_' + k); if (!el) return;
      el.addEventListener('input', () => { $('ap_' + k + 'O').textContent = `${fmt(+el.value, step < 1 ? (step < 0.1 ? 2 : 1) : 0)} ${unit}`; });
      el.addEventListener('change', () => { st = st || { sys: 's35', prm: Object.assign({}, DEF) }; st.prm = Object.assign({}, st.prm, { [k]: clamp(k, el.value) }); changed(); }); });
  }

  (window.PlanExt = window.PlanExt || {}).ankPlate = {
    label: 'Malleol dış plağı',
    get: () => (on() && st ? JSON.parse(JSON.stringify(st)) : null),
    set(x) {
      if (!x || typeof x !== 'object') { st = null; drop(); render(); return; }
      const p0 = Object.assign({}, DEF); Object.keys(DEF).forEach(k => { if (x.prm && x.prm[k] != null && Number.isFinite(+x.prm[k])) p0[k] = clamp(k, x.prm[k]); });
      st = { sys: SYS[x.sys] ? x.sys : 's35', prm: p0 }; out = null; show(); render();
    },
  };
  bus.addEventListener('changed', () => { sync(); if (out && out.key !== keyOf()) { out = null; show(); render(); } });
  bus.addEventListener('ankCorr', () => { show(); render(); });
  bus.addEventListener('caseType', () => { if (!on()) { st = null; drop(); } render(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) st = null; drop(); render(); });
  bus.addEventListener('ankPieces', () => { drop(); render(); });
  render();
  return { on, make, production, ready, checks, files, screwList, holes, state: () => st, info: () => (ready() ? out.info : null), parts: () => out, set: (k, v) => { st = st || { sys: 's35', prm: Object.assign({}, DEF) }; if (k === 'sys') { if (SYS[v]) st.sys = v; } else st.prm = Object.assign({}, st.prm, { [k]: clamp(k, v) }); changed(); }, SYS, DEF, LIM, RULE, show };
})(typeof G !== 'undefined' ? G : null);
