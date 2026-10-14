/* Ramus and condyle (plan-4 B1, B2, B4; the notch note of B3).
   - Condyle kept (a segment resection with the condyle on a stump): the stump must take at least STUMP_MIN plate screws
     (bone depth for the drill, STUMP_GAP mm from the cut, STUMP_STEP mm apart); fewer and a warning says keeping the
     condyle may not be practical.
   - Condyle removed (condylar resection): the "new condyle" — the graft's condylar end is rounded and placed `neo` mm
     short of the fossa (the condyle's place), adjustable here; above NEO_WARN mm a warning (Swendseid 2021: > 1 cm
     inferior / anterior is linked to dysphagia and jaw deviation); the report notes that the disc is preserved and that
     at least two weeks of jaw (maxillomandibular) fixation are planned.
   - Condyle position: the planned condyle (the kept one, or the new condyle) against the mirror image of the other
     condyle, in the checks with its tolerance (TOL_RAMUS mm when the ramus or condyle is involved, Chen 2021; else TOL_BODY).
   - A guide running up the ramus rests on the posterior border (stopP in app.js); the sigmoid notch is located and its
     distance from the upper cut reported.
   Nothing here designs a prosthesis; the literature basis is audit/denetim3/literatur/RAPOR.md (3.3, 3.6). */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Condyle = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const NEO_DEFAULT = 5, NEO_MAX = 20, NEO_WARN = 10, STUMP_MIN = 3, STUMP_GAP = 5, STUMP_STEP = 6, STUMP_HEAD = 8, STUMP_NEAR = 75, TOL_RAMUS = 4, TOL_BODY = 3;
  let neo = NEO_DEFAULT;
  const cond = () => { const r = window.Ref && Ref.get && Ref.get(); return r && r.cond ? r : null; };
  const sideName = k => (k === 'R' ? 'Sağ' : 'Sol');

  // ---------- B1: screw places on the stump that keeps the condyle ----------
  // the condyle on the kept side of an outer cut within STUMP_NEAR mm (on that cut's side of the midline), outside the
  // resected piece: the stump runs from that cut to the condyle
  function stump() {
    const ref = cond(), E = St.resEnds(); if (!ref || !E || E.condyle || !S.anchor || S.planes.length < 2) return null;
    const f = St.pieceFrames(); if (!f) return null;
    let best = null;
    for (const k of ['R', 'L']) {
      const p = ref.cond[k]; if (!p) continue;
      const q = V(...p); if (St.resectedNear(q, 4)) continue;
      for (const [cut, fr] of [[f.A, f.a], [f.B, f.b]]) {
        const d = q.distanceTo(fr.P), sameSide = Math.sign(q.x * ref.n[0] + q.y * ref.n[1] + q.z * ref.n[2] - ref.d) === Math.sign(fr.P.x * ref.n[0] + fr.P.y * ref.n[1] + fr.P.z * ref.n[2] - ref.d);
        if (d > STUMP_NEAR || !sameSide || q.clone().sub(fr.P).dot(fr.u) <= 0) continue;
        if (!best || d < best.d) best = { k, q, cut, fr, d };
      }
    }
    return best;
  }
  let spCache = { key: null, out: null };
  function stumpPlaces() {
    const st = stump(); if (!st) return null;
    const key = JSON.stringify([st.k, st.q.toArray(), st.fr.P.toArray(), S.planes.map(p => [p.off, p.yaw, p.pitch, p.w]), S.g.rot, S.g.kerfSide]);
    if (spCache.key === key && spCache.mask === S.mask) return spCache.out;
    const { q: C, cut, fr } = st, dir = C.clone().sub(fr.P), L = dir.length(); dir.normalize();
    let n = fr.n.clone().addScaledVector(dir, -fr.n.dot(dir)); if (n.lengthSq() < 1e-4) n = fr.n.clone(); n.normalize();
    const side = V().crossVectors(n, dir).normalize(), Nk = cut.N.clone().multiplyScalar(Math.sign(cut.N.dot(dir)) || 1), pc = cut.pSlot || cut.p;
    const pa = Math.abs(n.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), ea = V().crossVectors(pa, n).normalize(), eb = V().crossVectors(n, ea).normalize(), qq = V();
    const placeAt = t => {
      for (const s of [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10]) {
        const top = fr.P.clone().addScaledVector(dir, t).addScaledVector(side, s).addScaledVector(n, 20);
        let e = null; for (let h = 0; h < 50; h += 0.25) { qq.copy(top).addScaledVector(n, -h); if (St.boneAt(qq)) { e = qq.clone(); break; } }
        if (!e || e.clone().sub(pc).dot(Nk) - cut.w / 2 < STUMP_GAP || e.distanceTo(C) < STUMP_HEAD) continue;
        let core = 0, cn = 0, inB = 0;
        for (let h = 1.5; h <= 4; h += 0.75) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { qq.copy(e).addScaledVector(n, -h).addScaledVector(ea, a).addScaledVector(eb, b); cn++; if (St.boneAt(qq)) core++; }
        if (core < 0.85 * cn) continue;
        for (let h = 0; h <= 10; h += 0.25) { qq.copy(e).addScaledVector(n, -h); if (St.boneAt(qq)) inB += 0.25; }
        if (inB >= 4) return { e, s };
      }
      return null;
    };
    let count = 0, last = -Infinity; const at = [];
    for (let t = 0; t <= L; t += 1) if (t - last >= STUMP_STEP) { const r = placeAt(t); if (r) { count++; last = t; at.push(+t.toFixed(0)); } }
    const out = { side: st.k, n: count, len: +L.toFixed(1), at, cut: S.planes.indexOf(cut.pl) };
    spCache = { key, mask: S.mask, out };
    return out;
  }

  // ---------- B4: planned condyle against the mirror image of the other one ----------
  // (with a new condyle: the fossa it is aimed at; its own offset `neo` below the fossa is planned and reported apart)
  function involved() {
    if (S.lesion.condyle) return true;
    const ref = cond(), E = St.resEnds(); if (!ref || !E || !S.anchor) return false;
    if (Math.abs(St.frameAxes().u.z) > 0.6) return true;
    return ['R', 'L'].some(k => ref.cond[k] && [E.A.p, E.B.p].some(p => p.distanceTo(V(...ref.cond[k])) < 50));
  }
  function position() {
    const ref = cond(); if (!ref || !ref.cond.R || !ref.cond.L || !S.anchor || !S.planes.length) return null;
    const E = St.resEnds(), n = V(...ref.n);
    let k = S.lesion.condyle;
    if (!k) { const { u } = St.frameAxes(), c = S.anchor.p.clone().addScaledVector(u, (S.lesion.from + S.lesion.to) / 2), s = c.dot(n) - ref.d; k = s < 0 ? 'R' : 'L'; }
    const o = k === 'R' ? 'L' : 'R', planned = S.lesion.condyle && E && E.condyle ? E.B.cond.clone() : V(...ref.cond[k]), other = V(...ref.cond[o]);
    const m = other.clone().addScaledVector(n, -2 * (other.dot(n) - ref.d)), d = planned.clone().sub(m);
    const tol = involved() ? TOL_RAMUS : TOL_BODY;
    return { side: k, len: d.length(), dz: d.z, dy: d.y, dx: Math.abs(planned.dot(n) - ref.d) - Math.abs(other.dot(n) - ref.d), tol, neo: !!S.lesion.condyle };
  }

  // ---------- B3: the sigmoid notch above a ramus guide ----------
  // On the ramus of the resected side, in the plane of the guide (u up the ramus, v front to back): the top of the bone
  // per position across v between the condyle and up to 40 mm in front of it; the notch is the lowest top between the
  // condyle and the highest point in front (the coronoid). Distance reported from the upper cut, along u.
  function notch() {
    const ref = cond(); if (!ref || !S.anchor || S.lesion.condyle) return null;
    const { u, v, n } = St.frameAxes(); if (Math.abs(u.z) <= 0.6) return null;
    const pl = St.planesWorld(); if (!pl.length) return null;
    const up = u.z > 0 ? u : u.clone().negate(), cut = pl.reduce((a, b) => (b.p.dot(up) > a.p.dot(up) ? b : a));
    const sideOf = q => Math.sign(q.dot(V(...ref.n)) - ref.d);
    const k = ['R', 'L'].find(x => ref.cond[x] && sideOf(V(...ref.cond[x])) === sideOf(S.anchor.p)); if (!k) return null;
    const C = V(...ref.cond[k]), fwd = v.clone().multiplyScalar(v.y > 0 ? -1 : 1), q = V(), tops = [];
    for (let s = 0; s <= 40; s += 1) {
      let top = -Infinity;
      for (let w = -8; w <= 8; w += 2) for (let h = 10; h >= -45; h -= 0.5) { q.copy(C).addScaledVector(fwd, s).addScaledVector(n.clone().sub(up.clone().multiplyScalar(n.dot(up))).normalize(), w).addScaledVector(up, h); if (St.boneAt(q)) { top = Math.max(top, h); break; } }
      tops.push(top);
    }
    let cor = -1; for (let s = 8; s < tops.length; s++) if (tops[s] > -Infinity && (cor < 0 || tops[s] > tops[cor])) cor = s;
    if (cor < 0) return null;
    let lo = -1; for (let s = 1; s < cor; s++) if (tops[s] > -Infinity && (lo < 0 || tops[s] < tops[lo])) lo = s;
    if (lo < 0) return null;
    const P = C.clone().addScaledVector(fwd, lo).addScaledVector(up, tops[lo]);
    return { p: P, dist: P.clone().sub(cut.p).dot(up), cut: S.planes.indexOf(cut.pl) };
  }

  // ---------- 3D: the new condyle's rounded end ----------
  let shown = null;
  function showNeo() {
    const E = S.lesion.condyle && S.anchor ? St.resEnds() : null, key = E && E.condyle ? E.B.p.toArray().map(x => x.toFixed(2)).join(',') : null;
    if (key === shown) return;
    shown = key;
    if (!key) { St.setPart('neocondyle', null, null); return; }
    const m = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 16), St.mat(0xb07fd6, { transparent: true, opacity: 0.55, depthWrite: false }));
    m.position.copy(E.B.p); St.setPart('neocondyle', 'Yeni kondil (yuvarlatılmış fibula ucu)', m, 0xb07fd6);
  }

  // ---------- controls ----------
  function render() {
    const box = $('neoBox'); if (!box) return;
    box.hidden = !S.lesion.condyle;
    if (box.hidden) return;
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = `<div class="ctl"><div class="ctl-row"><label for="neoOff">Yeni kondil: fossaya mesafe</label><output id="neoOffO"></output></div><input type="range" id="neoOff" min="0" max="${NEO_MAX}" step="0.5"></div><p class="hint more" data-for="neoOff">Fibula ucu yuvarlatılır ve kondilin yerinden (fossa) bu kadar aşağıya, kesiye doğru konur. 3-10 mm önerilir; 10 mm üstü uyarı verir. Eklem diski korunur.</p>`;
      $('neoOff').addEventListener('input', e => { neo = +e.target.value; $('neoOffO').textContent = `${fmt(neo)} mm`; St.schedule(true); St.emit('changed'); });
    }
    $('neoOff').value = neo; $('neoOffO').textContent = `${fmt(neo)} mm`;
  }
  ['parts', 'changed', 'planApplied'].forEach(t => bus.addEventListener(t, () => { try { render(); showNeo(); } catch (e) { /* no case yet */ } }));
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) neo = NEO_DEFAULT; });

  // the condyle chosen for a condylar resection against the side of the lesion: the lesion's centre on the guide axis lies
  // clearly (> 10 mm) across the midline from that condyle and nearer the other one (Denetim 3 open item: a right
  // condyle picked for a left lesion went unnoticed). A warning, not a block: a resection may cross the midline.
  function wrongSide() {
    const ref = cond(), k = S.lesion.condyle; if (!ref || !k || !S.anchor || !ref.cond.R || !ref.cond.L) return null;
    const { u } = St.frameAxes(), c = S.anchor.p.clone().addScaledVector(u, (S.lesion.from + S.lesion.to) / 2);
    const sd = q => q[0] * ref.n[0] + q[1] * ref.n[1] + q[2] * ref.n[2] - ref.d, sc = sd([c.x, c.y, c.z]), sk = sd(ref.cond[k]);
    const other = k === 'R' ? 'L' : 'R', closer = c.distanceTo(V(...ref.cond[k])) - c.distanceTo(V(...ref.cond[other]));
    return Math.sign(sc) !== Math.sign(sk) && Math.abs(sc) > 10 && closer > 0 ? { side: k, off: Math.abs(sc), closer } : null;
  }
  // ---------- checks ----------
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [];
    if (!S.anchor) return out;
    if (S.lesion.condyle) {
      const E = St.resEnds(), d = E && E.condyle ? E.B.neo : neo, sn = sideName(S.lesion.condyle).toLocaleLowerCase('tr-TR');
      const ws = wrongSide(); if (ws) out.push(['warn', 'Uyarı', ws.side === 'R' ? `Kondil dahil rezeksiyon sağ kondile ayarlı, ama lezyon orta hattın sol tarafında (orta hattan ${fmt(ws.off, 0)} mm, sol kondile ${fmt(ws.closer, 0)} mm daha yakın). Rezeksiyon tarafını kontrol edin.` : `Kondil dahil rezeksiyon sol kondile ayarlı, ama lezyon orta hattın sağ tarafında (orta hattan ${fmt(ws.off, 0)} mm, sağ kondile ${fmt(ws.closer, 0)} mm daha yakın). Rezeksiyon tarafını kontrol edin.`, 'lesion']);
      out.push(['info', 'Bilgi', xl(`Yeni kondil (${sn}): fibula ucu yuvarlatılır ve fossanın ${fmt(d)} mm altına, kesiye doğru yerleştirilir. Eklem diski korunur; ameliyattan sonra en az 2 hafta çene (maksillomandibüler) fiksasyonu planlanmalıdır.`), 'lesion']);
      if (d > NEO_WARN) out.push(['warn', 'Uyarı', `Yeni kondil fossadan ${fmt(d)} mm uzakta (10 mm üstü). 1 cm'den fazla aşağı ya da öne yer değiştirme yutma güçlüğü ve çene kaymasıyla ilişkili; mesafeyi azaltın.`, 'lesion']);
      out.push(['warn', 'Uyarı', 'Kondil rezeke ediliyor: en büyük konum sapması kondilde beklenir (3-4 mm). Yeni kondili oklüzal wafer ya da çene fiksasyonuyla konumlandırın; alternatif olarak kondil protezi değerlendirilebilir.', 'lesion']);
    } else {
      const sp = stumpPlaces();
      if (sp) {
        const sn = sideName(sp.side).toLocaleLowerCase('tr-TR');
        if (sp.n < STUMP_MIN) out.push(['warn', 'Uyarı', xl(`Korunan ${sn} kondilin güdüğünde yalnız ${sp.n} vida yeri var (en az ${STUMP_MIN}; kesiden en az ${STUMP_GAP} mm, aralık ${STUMP_STEP} mm). Kondilin korunması pratik olmayabilir; yeni kondil (kondil dahil rezeksiyon) ya da kondil protezi seçeneğini değerlendirin.`), 'lesion']);
        else out.push(['info', 'Bilgi', xl(`Korunan ${sn} kondilin güdüğünde ${sp.n} vida yeri var (en az ${STUMP_MIN}; kesiden en az ${STUMP_GAP} mm, aralık ${STUMP_STEP} mm; güdük ${fmt(sp.len, 0)} mm).`), 'lesion']);
      }
      const nt = notch();
      if (nt) out.push(['info', 'Bilgi', nt.dist >= 0 ? `Ramus guide'ı: sigmoid çentik, kesi ${nt.cut + 1} düzleminden ${fmt(nt.dist, 0)} mm yukarıda.` : `Ramus guide'ı: kesi ${nt.cut + 1} düzlemi sigmoid çentiğin ${fmt(-nt.dist, 0)} mm üstünden geçiyor; kondil ile koronoid ayrı kalır.`, 'guide']);
    }
    const ps = position();
    if (ps) {
      const msg = `${ps.neo ? 'Yeni kondil' : `${sideName(ps.side)} kondil`} konumu, diğer kondilin ayna görüntüsüne göre: ${fmt(ps.len)} mm (dikey ${fmt(ps.dz)}, ön-arka ${fmt(ps.dy)}, orta hatta uzaklık farkı ${fmt(ps.dx)} mm); tolerans ${fmt(ps.tol, 0)} mm${ps.tol === TOL_RAMUS ? ' (ramus/kondil dahil)' : ''}.`;
      // a kept condyle stays where it is (the figure is the patient's asymmetry, reported); the new condyle is aimed at the
      // fossa, so a fossa off the mirrored one by more than the tolerance is a warning
      const bad = ps.neo && ps.len > ps.tol;
      out.push([bad ? 'warn' : 'info', bad ? 'Uyarı' : 'Bilgi', msg, 'anat']);
    }
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!S.anchor) return;
    const ps = position(), sp = !S.lesion.condyle ? stumpPlaces() : null;
    if (!ps && !sp && !S.lesion.condyle) return;
    if (d.keep) d.keep(240); d.h2('Kondil');
    const rows = [];
    if (S.lesion.condyle) { const E = St.resEnds(); rows.push(['Yeni kondil', `fibula ucu yuvarlatılmış, fossanın ${fmt(E && E.condyle ? E.B.neo : neo)} mm altında`], ['Eklem diski', 'korunur'], ['Çene fiksasyonu', 'en az 2 hafta (maksillomandibüler)']); }
    if (sp) rows.push(['Korunan kondil güdüğü', `${sp.n} vida yeri (en az ${STUMP_MIN})`]);
    if (ps) rows.push(['Kondil konumu (diğer kondile göre)', `${fmt(ps.len)} mm, tolerans ${fmt(ps.tol, 0)} mm`]);
    d.table(['Ölçü', 'Değer'], rows, [0.5, 0.5]);
  });
  (window.PlanExt = window.PlanExt || {}).condyle = {
    label: 'Yeni kondil', pre: true,
    get: () => (neo !== NEO_DEFAULT ? { neo } : null),
    set(x) { const v = x && x.neo != null ? Number(x.neo) : NaN; neo = Number.isFinite(v) ? Math.max(0, Math.min(NEO_MAX, v)) : NEO_DEFAULT; render(); },
  };
  return { neoOffset: () => neo, setNeo: v => { neo = Math.max(0, Math.min(NEO_MAX, +v || 0)); render(); }, stumpPlaces, position, notch, wrongSide, NEO_WARN, STUMP_MIN, TOL_RAMUS, TOL_BODY };
})();
