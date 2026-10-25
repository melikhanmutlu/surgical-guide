/* Joint landmarks and reduction measurements of the malleolar fracture (plan M2): measured on the pieces' surfaces in
   the CT position ("BT") and in the planned position ("Redükte"), so the plan shows what the reduction changed.

   Surfaces: every piece's mesh vertices (up to SAMPLE per piece, area-weighted), its outward normal from the gradient of
   its own distance field. A point is moved with its piece's motion x' = q (x - c) + c + t (ankle.js toWorld).
   - tibial complex: the tibia and every fragment except the lateral malleolus; fibular complex: fibula + lateral malleolus
   - articular surface: tibial-complex surface within FACET mm of the talus and facing it (its normal against the
     talus' distance gradient); the plafond is the part facing down (normal · up < -0.5) within NEAR mm; the medial
     facet the part facing lateral on the medial side of the talus
   - superior clear space (SCS) / medial clear space (MCS): area-weighted median distance of the plafond / medial facet
     to the talus; talar shift = MCS - SCS (a talus pushed laterally opens the medial space)
   - articular step and gap of a fragment: along the fracture line, its articular border (within 6 mm of its main bone)
     against the main bone's articular border (within 6 mm of the fragment): step = difference of the median distances
     to the talus (+ = the fragment lies proximal), gap = median distance of its border to the main bone's surface
   - tibiofibular clear space (TFCS): the smallest distance from the fibular complex to the tibial complex in a 4 mm slab
     10 mm above the plafond (the syndesmosis)
   - posterior fragment share: its part of the plafond's area (%)
   Landmarks: plafond centre, medial and lateral malleolus tips (lowest points), Chaput and Volkmann tubercles
   (anterolateral and posterolateral extremes of the distal tibia 3-12 mm above the plafond), the incisura (the tibia
   nearest the fibula 8-12 mm above the plafond), the top of the talar dome. Each can be set by hand (a click on a piece,
   saved with the plan, moves with the piece). Thresholds are sample values from the literature (step and gap 2 mm,
   MCS 4 mm or 1 mm over the SCS, TFCS 6 mm, posterior fragment 25 %): the clinical team sets them.
   Research prototype, not for clinical use. */
'use strict';
window.AnkLM = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  // piece names as {0}, {1} in a message (ankle.js named): looked up with number stand-ins, the names put back translated
  const named = (tpl, ...names) => { let s = xl(tpl.replace(/\{(\d)\}/g, (_, i) => String(90001 + +i))); names.forEach((n, i) => { s = s.split(String(90001 + i)).join(xl(n)); }); return s; };
  const on = () => CaseType.get() === 'ankle';
  const LIM = { near: 6, facet: 10, border: 6, minPts: 15, step: 2, gap: 2, mcs: 4, mcsOver: 1, tfcs: 6, post: 25 };
  const SAMPLE = 4000, UP = new T.Vector3(0, 0, 1);
  const LM = [['plafond', 'Plafond merkezi'], ['mmTip', 'Medial malleol ucu'], ['lmTip', 'Lateral malleol ucu'], ['chaput', 'Chaput tüberkülü'], ['volkmann', 'Volkmann tüberkülü'], ['incisura', 'İnsizura'], ['dome', 'Talus kubbesi']];
  let over = {};          // landmark -> { piece, c, x } set by hand (piece-own coordinates)
  let res = null, resKey = '', picking = null;

  // ---------- surfaces ----------
  const cache = new WeakMap();
  function surf(p) {
    const g = p.mesh.geometry; let s = cache.get(g); if (s) return s;
    const P = g.attributes.position.array, I = g.index ? g.index.array : null, nv = P.length / 3, area = new Float32Array(nv);
    const a = V(), b = V(), c = V();
    if (I) for (let t = 0; t < I.length; t += 3) { a.fromArray(P, I[t] * 3); b.fromArray(P, I[t + 1] * 3); c.fromArray(P, I[t + 2] * 3); const ar = b.sub(a).cross(c.sub(a)).length() / 6; area[I[t]] += ar; area[I[t + 1]] += ar; area[I[t + 2]] += ar; }
    else area.fill(1);
    const step = Math.max(1, Math.floor(nv / SAMPLE)), n = Math.ceil(nv / step), x = new Float32Array(3 * n), nn = new Float32Array(3 * n), w = new Float32Array(n), q = V(), e = 0.6;
    for (let v = 0, k = 0; v < nv; v += step, k++) {
      q.fromArray(P, 3 * v); x[3 * k] = q.x; x[3 * k + 1] = q.y; x[3 * k + 2] = q.z;
      let wa = 0; for (let u = v; u < Math.min(nv, v + step); u++) wa += area[u]; w[k] = wa;
      const gr = V(A.sdfAt(p, V(q.x + e, q.y, q.z)) - A.sdfAt(p, V(q.x - e, q.y, q.z)), A.sdfAt(p, V(q.x, q.y + e, q.z)) - A.sdfAt(p, V(q.x, q.y - e, q.z)), A.sdfAt(p, V(q.x, q.y, q.z + e)) - A.sdfAt(p, V(q.x, q.y, q.z - e)));
      if (!(gr.lengthSq() > 1e-12) || !isFinite(gr.x + gr.y + gr.z)) gr.set(0, 0, 0); else gr.normalize();
      nn[3 * k] = gr.x; nn[3 * k + 1] = gr.y; nn[3 * k + 2] = gr.z;
    }
    s = { x, n: nn, w, k: n }; cache.set(g, s); return s;
  }
  // a pose: the CT position (red = false) or the planned one (red = true)
  const toW = (p, x, red) => (red ? A.toWorld(p, x) : x.clone());
  const sdfW = (o, w, red) => A.sdfAt(o, red ? A.toOwn(o, w) : w);
  const wmed = arr => { if (!arr.length) return null; arr.sort((a, b) => a[0] - b[0]); const tot = arr.reduce((s, a) => s + a[1], 0); let acc = 0; for (const [v, w] of arr) { acc += w; if (acc >= tot / 2) return v; } return arr[arr.length - 1][0]; };

  // ---------- the measurements of one pose ----------
  function compute(red) {
    const ps = A.pieces().filter(p => p.role !== 'out'), tib = ps.find(p => p.role === 'tibia'), fib = ps.find(p => p.role === 'fibula'), tal = ps.find(p => p.role === 'talus');
    if (!tib || !tal) return { ok: false, why: !tib ? 'Tibia yok' : 'Talus yok' };
    const frags = ps.filter(p => p.role === 'frag'), latF = frags.filter(p => p.name === 'Lateral malleol');
    const tibC = [tib, ...frags.filter(p => !latF.includes(p))], fibC = [fib, ...latF].filter(Boolean);
    const tc = toW(tal, tal.c, red);
    // lateral: from the tibia towards the fibula (horizontal); without a fibula from the side (right ankle: -x in LPS)
    let lat = fib ? toW(fib, fib.c, red).sub(toW(tib, tib.c, red)).setZ(0) : V(A.meta().side === 'L' ? 1 : -1, 0, 0);
    if (lat.lengthSq() < 1e-6) lat = V(-1, 0, 0); lat.normalize();
    const post = V(-lat.y, lat.x, 0); if (post.y < 0) post.negate();
    // every sampled point of the complexes, in this pose
    const pts = new Map(), q = V(), nq = V();
    [...tibC, ...fibC, tal].forEach(p => {
      const s = surf(p), out = [];
      for (let k = 0; k < s.k; k++) {
        q.set(s.x[3 * k], s.x[3 * k + 1], s.x[3 * k + 2]); nq.set(s.n[3 * k], s.n[3 * k + 1], s.n[3 * k + 2]);
        const w = toW(p, q, red), n = red ? nq.clone().applyQuaternion(p.q) : nq.clone(), dT = p === tal ? 0 : sdfW(tal, w, red);
        // articular: near the talus and facing it (the normal against the talus' own outward gradient)
        let art = false;
        if (p !== tal && dT < LIM.facet) {
          const e = 0.6, g = V(sdfW(tal, V(w.x + e, w.y, w.z), red) - sdfW(tal, V(w.x - e, w.y, w.z), red), sdfW(tal, V(w.x, w.y + e, w.z), red) - sdfW(tal, V(w.x, w.y - e, w.z), red), sdfW(tal, V(w.x, w.y, w.z + e), red) - sdfW(tal, V(w.x, w.y, w.z - e), red));
          art = isFinite(g.x + g.y + g.z) && g.lengthSq() > 1e-12 && n.dot(g.normalize()) < -0.7;
        }
        out.push({ w, n, a: s.w[k], dT, art });
      }
      pts.set(p, out);
    });
    const plaf = [], facet = [], share = new Map();
    tibC.forEach(p => pts.get(p).forEach(o => {
      if (!o.art) return;
      if (o.dT < LIM.near && o.n.dot(UP) < -0.5) { plaf.push(o); share.set(p, (share.get(p) || 0) + o.a); }
      if (Math.abs(o.n.dot(UP)) < 0.6 && o.n.dot(lat) > 0.5 && V().subVectors(o.w, tc).dot(lat) < 0) facet.push(o);
    }));
    const aTot = plaf.reduce((s, o) => s + o.a, 0), pz0 = aTot ? plaf.reduce((s, o) => s + o.w.z * o.a, 0) / aTot : null;
    // the medial clear space is read on the upper medial facet (10 mm under the plafond), as on a mortise view
    const facetU = pz0 == null ? facet : facet.filter(o => o.w.z >= pz0 - 10 && o.w.z <= pz0 + 1);
    const m = { scs: wmed(plaf.map(o => [o.dT, o.a])), mcs: wmed(facetU.map(o => [o.dT, o.a])), nPlaf: plaf.length, nFacet: facetU.length };
    m.shift = m.scs != null && m.mcs != null ? m.mcs - m.scs : null;
    m.shares = tibC.filter(p => share.has(p)).map(p => ({ name: p.name, pct: aTot ? 100 * share.get(p) / aTot : 0 }));
    const pm = tibC.find(p => p.name === 'Posterior malleol'); m.post = pm && aTot ? 100 * (share.get(pm) || 0) / aTot : null;
    // the plafond's height and centre
    const pz = pz0;
    // steps and gaps of the fragments along their fracture lines
    m.steps = [];
    // step: the articular surface on both sides of the fracture line (1.5-6 mm from the other piece: the rounded edge
    // of the line itself left out), on surfaces facing the same way (normals within ~35° of the fragment's mean, so a
    // corner of the joint, plafond against a malleolar facet, compares nothing): the difference of the median distances
    // to the talus (+ = the fragment lies away from the talus, proximal on the plafond). The joint space is the
    // reference, so the talus' own curvature drops out. gap: the fracture line's opening on the joint surface, the low
    // (3 %) quantile of the distances of the fragment's surface by the joint to the main bone. Too few points on parallel
    // surfaces (a transverse medial malleolus fracture at the corner of the mortise): no step, the gap and the medial
    // clear space say how it sits.
    const wq = (arr, f) => { if (!arr.length) return null; arr.sort((a, b) => a[0] - b[0]); const tot = arr.reduce((s, a) => s + a[1], 0); let acc = 0; for (const [v, w] of arr) { acc += w; if (acc >= f * tot) return v; } return arr[arr.length - 1][0]; };
    const pair = (F, M) => {
      if (!M) return;
      const fd = pts.get(F).filter(o => o.art).map(o => ({ o, d: sdfW(M, o.w, red) })), md = pts.get(M).filter(o => o.art).map(o => ({ o, d: sdfW(F, o.w, red) }));
      const band = z => z.d >= 1.5 && z.d < LIM.border;
      let fb = fd.filter(band), mb = md.filter(band);
      const nF = fb.reduce((s, z) => s.addScaledVector(z.o.n, z.o.a), V()).normalize();
      fb = fb.filter(z => z.o.n.dot(nF) > 0.8); mb = mb.filter(z => z.o.n.dot(nF) > 0.8);
      // the opening: every surface point of the fragment by the joint (within FACET mm of the talus, the fracture
      // surface included); none within BORDER mm of the main bone = the fracture line does not reach the joint
      const jd = pts.get(F).filter(o => o.dT < LIM.facet).map(o => [Math.max(0, sdfW(M, o.w, red)), o.a]).filter(z => z[0] < 30);
      const gap = wq(jd, 0.03);
      const ok = fb.length >= LIM.minPts && mb.length >= LIM.minPts;
      m.steps.push({ name: F.name, with: M.name, step: ok ? wmed(fb.map(z => [z.o.dT, z.o.a])) - wmed(mb.map(z => [z.o.dT, z.o.a])) : null, gap: gap != null && gap < LIM.border ? gap : null, n: Math.min(fb.length, mb.length) });
    };
    tibC.slice(1).forEach(F => pair(F, tib)); latF.forEach(F => pair(F, fib));
    // the syndesmosis
    m.tfcs = null;
    if (pz != null && fibC.length) {
      let best = Infinity;
      fibC.forEach(p => pts.get(p).forEach(o => { if (Math.abs(o.w.z - (pz + 10)) <= 2) tibC.forEach(t => { const d = sdfW(t, o.w, red); if (d < best) best = d; }); }));
      if (best < 30) m.tfcs = best;
    }
    // landmarks
    const L = {}, arg = (list, f) => { let b = null, bv = -Infinity; list.forEach(o => { const v = f(o); if (v > bv) { bv = v; b = o; } }); return b ? b.w.clone() : null; };
    const tibPts = tibC.flatMap(p => pts.get(p)), fibPts = fibC.flatMap(p => pts.get(p));
    if (aTot) L.plafond = plaf.reduce((s, o) => s.addScaledVector(o.w, o.a), V()).multiplyScalar(1 / aTot);
    L.mmTip = arg(tibPts.filter(o => V().subVectors(o.w, tc).dot(lat) < -5), o => -o.w.z);
    L.lmTip = fibPts.length ? arg(fibPts, o => -o.w.z) : null;
    if (pz != null) {
      const slab = tibPts.filter(o => o.w.z >= pz + 3 && o.w.z <= pz + 12);
      L.chaput = arg(slab, o => o.w.dot(lat) - o.w.dot(post)); L.volkmann = arg(slab, o => o.w.dot(lat) + o.w.dot(post));
      if (fibC.length) { const s2 = tibPts.filter(o => o.w.z >= pz + 8 && o.w.z <= pz + 12); L.incisura = arg(s2, o => -Math.min(...fibC.map(f => sdfW(f, o.w, red)))); }
    }
    // the top of the dome under the plafond centre (the highest talar point anywhere can sit on the lateral shoulder)
    const tp = pts.get(tal), under = L.plafond ? tp.filter(o => Math.hypot(o.w.x - L.plafond.x, o.w.y - L.plafond.y) < 8) : [];
    L.dome = arg(under.length >= 3 ? under : tp, o => o.w.z);
    // landmarks set by hand
    Object.entries(over).forEach(([k, o]) => { const p = ps.find(x => x.name === o.piece && x.c.distanceTo(V(...o.c)) < 5) || ps.find(x => x.c.distanceTo(V(...o.c)) < 5); if (p) { L[k] = toW(p, V(...o.x), red); L[k].hand = true; } });
    return { ok: true, m, L, lat, post, pz };
  }
  const keyOf = () => JSON.stringify(A.pieces().map(p => [p.label, p.name, p.role, p.cm3, p.t.toArray(), p.q.toArray()])) + JSON.stringify(over);
  function result() {
    if (!on() || !A.pieces().length) return null;
    const k = keyOf(); if (res && resKey === k) return res;
    res = { ct: compute(false), red: compute(true) }; resKey = k; return res;
  }

  // ---------- checks: on the planned position ----------
  function checks() {
    const r = result(); if (!r || !r.red.ok || !A.pieces().some(A.moved)) return [];
    const m = r.red.m, o = [];
    m.steps.forEach(s => {
      if (s.step != null && Math.abs(s.step) >= LIM.step) o.push(['warn', 'Uyarı', named(`{0} ile {1} arasında eklem basamağı ${fmt(Math.abs(s.step), 1)} mm (örnek eşik ${LIM.step} mm).`, s.name, s.with), 'ank']);
      if (s.gap != null && s.gap >= LIM.gap) o.push(['warn', 'Uyarı', named(`{0} ile {1} arasında eklemde ${fmt(s.gap, 1)} mm aralık (örnek eşik ${LIM.gap} mm).`, s.name, s.with), 'ank']);
    });
    if (m.mcs != null && (m.mcs > LIM.mcs || (m.shift != null && m.shift > LIM.mcsOver))) o.push(['warn', 'Uyarı', xl(`Medial açıklık ${fmt(m.mcs, 1)} mm, üst açıklık ${fmt(m.scs, 1)} mm: talus lateral kaymış olabilir (örnek eşik ${LIM.mcs} mm ya da üst açıklık + ${LIM.mcsOver} mm).`), 'ank']);
    if (m.tfcs != null && m.tfcs > LIM.tfcs) o.push(['warn', 'Uyarı', xl(`Tibiofibular açıklık ${fmt(m.tfcs, 1)} mm (örnek eşik ${LIM.tfcs} mm); sindesmoz açık olabilir.`), 'ank']);
    if (m.post != null && m.post >= LIM.post) o.push(['info', 'Bilgi', xl(`Posterior malleol eklem yüzeyinin %${fmt(m.post, 0)}'i (örnek eşik %${LIM.post}).`), 'ank']);
    return o;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);

  // ---------- 3D markers (planned position) ----------
  const grp = new T.Group(); grp.name = 'ankLM';
  function markers() {
    while (grp.children.length) { const c = grp.children.pop(); c.geometry.dispose(); c.material.dispose(); }
    const r = on() && $('stRed') && $('stRed').open ? result() : null;
    if (r && r.red.ok) Object.entries(r.red.L).forEach(([k, w]) => {
      if (!w) return; const s = new T.Mesh(new T.SphereGeometry(1.4, 12, 8), new T.MeshBasicMaterial({ color: w.hand ? 0xd9534f : 0x2bb0b0, depthTest: false })); s.position.copy(w); s.renderOrder = 5; s.userData.lm = k; grp.add(s);
    });
    if (!grp.parent && St.scene) St.scene.add(grp);
    St.render();
  }

  // ---------- panel ----------
  const f1 = x => (x == null ? '–' : fmt(x, 1));
  function render() {
    const box = $('ankLM'); if (!box) return;
    const r = result();
    if (!r) { box.innerHTML = ''; return; }
    if (!r.ct.ok) { box.innerHTML = `<p class="hint">${xl('Eklem ölçüleri için tibia ve talus gerekli.')} (${esc(xl(r.ct.why))})</p>`; return; }
    const a = r.ct.m, b = r.red.m, row = (lbl, x, y, lim) => `<tr><td>${xl(lbl)}</td><td>${x}</td><td>${y}</td><td>${lim}</td></tr>`;
    const steps = b.steps.map(s => { const c = a.steps.find(z => z.name === s.name) || {}, nm = esc(xl(s.name)); return row(`${xl('Basamak')}: ${nm}`, f1(c.step), f1(s.step), `${LIM.step} mm`) + row(`${xl('Aralık')}: ${nm}`, f1(c.gap), f1(s.gap), `${LIM.gap} mm`); }).join('');
    box.innerHTML = `<div class="tbl"><table><thead><tr><th>${xl('Ölçü (mm)')}</th><th>${xl('BT')}</th><th>${xl('Redükte')}</th><th>${xl('Örnek eşik')}</th></tr></thead><tbody>
      ${steps}${row('Üst açıklık (SCS)', f1(a.scs), f1(b.scs), '–')}${row('Medial açıklık (MCS)', f1(a.mcs), f1(b.mcs), `${LIM.mcs} mm`)}${row('Talus kayması (MCS − SCS)', f1(a.shift), f1(b.shift), `${LIM.mcsOver} mm`)}
      ${row('Tibiofibular açıklık', f1(a.tfcs), f1(b.tfcs), `${LIM.tfcs} mm`)}${row('Posterior parça payı (%)', a.post == null ? '–' : fmt(a.post, 0), b.post == null ? '–' : fmt(b.post, 0), `${LIM.post} %`)}</tbody></table></div>
      <p class="hint more">${xl('Basamak: parçanın eklem yüzeyinin kırık hattında ana kemiğe göre talustan uzaklık farkı (+ proksimal). Aralık: kırık hattında eklem yüzeyindeki açıklık. Ölçüler yüzeylerden otomatik alınır; eşikler literatürden örnektir, klinik ekip belirler.')}</p>
      <h3 class="sub">${xl('Landmarklar')}</h3><ul class="lmList">${LM.map(([k, lbl]) => { const w = r.red.L[k]; return `<li><span>${xl(lbl)}${w && w.hand ? ` <small>(${xl('elle')})</small>` : ''}</span> <button class="link" data-lm="${k}" aria-pressed="${picking === k}">${picking === k ? xl('Kemiğe tıklayın…') : xl('Düzelt')}</button>${over[k] ? ` <button class="link" data-lmx="${k}">${xl('Otomatiğe dön')}</button>` : ''}</li>`; }).join('')}</ul>`;
    box.querySelectorAll('[data-lm]').forEach(b => b.addEventListener('click', () => { picking = picking === b.dataset.lm ? null : b.dataset.lm; render(); }));
    box.querySelectorAll('[data-lmx]').forEach(b => b.addEventListener('click', () => setLandmark(b.dataset.lmx, null)));
  }
  // a landmark set by hand: a world point on a piece (planned position); null = back to the automatic one
  function setLandmark(k, p, w) {
    if (!LM.some(x => x[0] === k)) return false;
    if (!p) delete over[k]; else { const x = A.toOwn(p, w); over[k] = { piece: p.name, c: p.c.toArray().map(v => Math.round(v * 10) / 10), x: x.toArray().map(v => Math.round(v * 100) / 100) }; }
    St.emit('changed'); refresh(); return true;
  }
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = picking && on() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const h = St.ray.intersectObjects(A.pieces().filter(p => p.role !== 'out' && p.mesh.parent && p.mesh.parent.visible).map(p => p.mesh), false)[0]; if (!h) return;
    const k = picking; picking = null; setLandmark(k, h.object.userData.ankle, h.point);
  });
  function refresh() { render(); markers(); }

  (window.PlanExt = window.PlanExt || {}).ankLM = {
    label: 'Malleol landmarkları',
    get: () => (on() && Object.keys(over).length ? JSON.parse(JSON.stringify(over)) : null),
    set(x) {
      over = {};
      if (x && typeof x === 'object') Object.entries(x).forEach(([k, o]) => { if (LM.some(z => z[0] === k) && o && typeof o.piece === 'string' && [o.c, o.x].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite))) over[k] = { piece: o.piece.slice(0, 40), c: o.c.map(Number), x: o.x.map(Number) }; });
      refresh();
    },
  };
  let tmo = null;
  ['changed', 'ankPieces', 'planApplied'].forEach(ev => bus.addEventListener(ev, () => { if (!on()) return; clearTimeout(tmo); tmo = setTimeout(refresh, 150); }));
  bus.addEventListener('caseType', () => { if (!on()) { over = {}; picking = null; } refresh(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) over = {}; });
  if ($('stRed')) $('stRed').addEventListener('toggle', () => { if (!$('stRed').open) picking = null; markers(); });

  return { on, compute, result, checks, setLandmark, landmarks: () => LM.slice(), LIM, render };
})();
