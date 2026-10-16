/* Osteotomy report: every bone-to-bone junction of the reconstruction (mandible stump to graft at each end of the
   defect, and graft to graft between fibula segments) with its angle, bone contact area and gap.
   Contact is measured by sampling both sections in the junction plane on a 0.3 mm grid: a point is in contact when
   the stump (or the previous segment) has bone just behind the plane and the next piece has bone just in front.
   Between segments the angle is the closing wedge taken out of the fibula (angle between the two cuts on the
   fibula); at the mandible ends it is the angle between the graft axis and the mandible stump axis. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
const UP = () => (window.I18N && I18N.lang === 'en' ? 'u' : 'ü');   // 'upper barrel' marker in the short labels
window.Osteo = (function () {
  const St = window.Studio; if (!St || !window.Fibula) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const r2d = THREE.MathUtils.radToDeg;
  // sample thresholds from the fibula plan's clinical profile (Fibula.rules); the clinical team sets the final values
  // gap: > gapWarn a warning, >= gapErr critical (healed junctions averaged ~1.3 mm, non-unions ~2.5 mm), at every junction
  const lim = () => { const r = Fibula.rules(); return { overlap: r.overlap, area: r.area, wedge: r.wedgeWarn, gap: r.gapWarn, gapErr: r.gapErr, axis: r.axisInfo }; };
  const STEP = 0.3;
  let last = null, key = '', timer = null;

  function basis(N) { const t = Math.abs(N.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), a = V().crossVectors(N, t).normalize(); return [a, V().crossVectors(N, a)]; }
  // walk a square grid of radius R in the plane (p, N) and count where behind(q) / ahead(q) hold
  function section(p, N, R, behind, ahead) {
    const [e1, e2] = basis(N), n = Math.ceil(R / STEP), q = V();
    let a = 0, b = 0, both = 0; const ca = V(), cb = V();
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      q.copy(p).addScaledVector(e1, i * STEP).addScaledVector(e2, j * STEP);
      const x = behind(q), y = ahead(q);
      if (x) { a++; ca.add(q); } if (y) { b++; cb.add(q); } if (x && y) both++;
    }
    const A = STEP * STEP;
    return { areaA: a * A, areaB: b * A, contact: both * A, ca: a ? ca.multiplyScalar(1 / a) : null, cb: b ? cb.multiplyScalar(1 / b) : null };
  }
  // gap between two pieces across a junction plane, measured on the bone: at grid points of the plane, the distance
  // from the plane back to the first bone of the piece behind plus forward to the first bone of the piece ahead (each
  // looked for up to `reach` mm); the median over the points where both are found. Two faces cut to the same plane
  // give ~0; a step or a wedge left open shows as a gap.
  function gapAcross(p, N, R, behind, ahead, reach = 5, step = 0.6, dt = 0.2) {
    const [e1, e2] = basis(N), n = Math.ceil(R / step), q = V(), x = V(), gaps = [];
    const first = (f, sgn) => { for (let t = 0; t <= reach + 1e-9; t += dt) { x.copy(q).addScaledVector(N, sgn * t); if (f(x)) return t; } return null; };
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      q.copy(p).addScaledVector(e1, i * step).addScaledVector(e2, j * step);
      const ta = first(behind, -1); if (ta === null) continue;
      const tb = first(ahead, 1); if (tb === null) continue;
      gaps.push(ta + tb);
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  }
  // mandible stump axis from the section centroids 3 mm and 12 mm behind the stump face (out = away from the defect)
  function stumpAxis(p, out) {
    const [e1, e2] = basis(out), c = [];
    for (const d of [3, 12]) {
      const o = p.clone().addScaledVector(out, d), acc = V(); let k = 0;
      for (let i = -60; i <= 60; i += 2) for (let j = -60; j <= 60; j += 2) { const q = o.clone().addScaledVector(e1, i * STEP).addScaledVector(e2, j * STEP); if (St.boneAt(q)) { acc.add(q); k++; } }
      if (k < 10) return null; c.push(acc.multiplyScalar(1 / k));
    }
    return c[0].sub(c[1]).normalize();   // points towards the defect
  }

  function compute() {
    const st = Fibula.active() ? Fibula.state() : null, E = St.resEnds();
    if (!st || !st.last || !E) return null;
    const segs = st.last.segs, FR = st.F.c.FR, gb = (i, q) => Fibula.graftBone(i, q);
    const out = [], lower = segs.filter(g => !g.barrel), upper = segs.filter(g => g.barrel);
    const mand = (g, end) => {
      // end 'A': stump behind -N of the first cut; end 'B': stump beyond +N of the last cut. N runs A -> B.
      // 'A' / 'B' here are the graft's own first / last face; which mandible stump it meets is found from where it lies (a
      // reversed graft order or a folded upper barrel meets the stumps the other way round, Denetim 5 F1/F2)
      const N = (end === 'A' ? g.N0 : g.N1).clone(), sgn = end === 'A' ? -1 : 1, p = end === 'A' ? g.P0 : g.P1, atA = p.distanceTo(E.A.p) <= p.distanceTo(E.B.p), P = atA ? E.A : E.B;
      // planned gap at this end: the half slot behind the plane (0 when the kerf lies on the resected side, Studio.stumpGap)
      const gap = St.stumpGap ? St.stumpGap(P) : P.w / 2;
      const back = gap + 0.4, sec = section(p, N, Math.max(18, FR + 6), q => St.boneAt(q.clone().addScaledVector(N, sgn * back)), q => gb(g.i, q.clone().addScaledVector(N, -sgn * 0.4)));
      const ax = stumpAxis(p.clone().addScaledVector(N, sgn * gap), N.clone().multiplyScalar(sgn));
      // graft direction leaving the stump into the defect
      const into = g.x.clone().multiplyScalar(-sgn), axis = ax ? r2d(ax.angleTo(into)) : null;
      return { kind: end, name: `Mandibula ${atA ? '1' : '2'} – segment ${g.i + 1}${g.barrel ? ' (üst)' : ''}`, short: end === 'A' ? `M${atA ? 1 : 2}–S${g.i + 1}${g.barrel ? UP() : ''}` : `S${g.i + 1}${g.barrel ? UP() : ''}–M${atA ? 1 : 2}`, seg: g.i, angle: axis, angleKind: 'eksen',
        contact: sec.contact, graftArea: sec.areaB, otherArea: sec.areaA, gap };
    };
    // a graft face that meets the virtual end (the new condyle of a condylar resection) has no stump to check; which face
    // that is follows where it lies, not its 'A' / 'B' name (reversed order, folded upper barrel)
    const stump = (g, end) => { const p = end === 'A' ? g.P0 : g.P1; if (!E.condyle || p.distanceTo(E.A.p) <= p.distanceTo(E.B.p)) out.push(mand(g, end)); };
    if (lower.length) stump(lower[0], 'A');
    for (let j = 0; j < lower.length - 1; j++) {
      const a = lower[j], b = lower[j + 1], N = a.N1;
      const sec = section(a.P1, N, FR + 5, q => gb(a.i, q.clone().addScaledVector(N, -0.4)), q => gb(b.i, q.clone().addScaledVector(N, 0.4)));
      const wedge = r2d(Math.acos(Math.max(-1, Math.min(1, a.n1.dot(b.n0))))), bend = r2d(a.x.angleTo(b.x));
      // between segments the saw kerf is taken from the fibula between the grafts, so the planned gap is 0; the gap is
      // measured on the two transplanted segments (it is the same rule as at the stumps)
      const gm = gapAcross(a.P1, N, FR + 5, q => gb(a.i, q), q => gb(b.i, q));
      out.push({ kind: 'J', name: `Segment ${a.i + 1} – segment ${b.i + 1}`, short: `S${a.i + 1}–S${b.i + 1}`, seg: b.i, angle: wedge, bend, angleKind: 'kama',
        contact: sec.contact, graftArea: Math.min(sec.areaA, sec.areaB), otherArea: Math.max(sec.areaA, sec.areaB), gap: gm == null ? 0 : gm, measured: gm != null, shift: sec.ca && sec.cb ? sec.ca.distanceTo(sec.cb) : null });
    }
    if (lower.length) stump(lower[lower.length - 1], 'B');
    upper.forEach(g => { stump(g, 'A'); stump(g, 'B'); });
    out.forEach(o => { o.overlap = o.graftArea > 0 ? o.contact / o.graftArea : 0; });
    return out;
  }

  // ---------- checks, panel, report, export ----------
  function checks() {
    const out = []; if (!last) return out;
    const LIM = lim();
    last.forEach(o => {
      if (o.graftArea > 0 && o.overlap < LIM.overlap) out.push(['warn', 'Uyarı', `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`kemik teması greft kesitinin %${fmt(o.overlap * 100, 0)}'i (örnek eşik %${LIM.overlap * 100}). Kemik iyileşmesi için temas artırılmalı.`)}`, 'fib']);
      else if (o.contact < LIM.area) out.push(['warn', 'Uyarı', `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`temas alanı ${fmt(o.contact, 0)} mm² (örnek eşik ${LIM.area} mm²).`)}`, 'fib']);
      if (o.kind === 'J' && o.angle > LIM.wedge) out.push(['warn', 'Uyarı', `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`kapama kaması ${fmt(o.angle, 0)}° (örnek eşik ${LIM.wedge}°); kesi yüzeyleri uzar, temas zayıflar.`)}`, 'fib']);
      const fix = xl(o.kind === 'J' ? 'Eklem açısını ya da segment dönüşünü kontrol edin.' : 'Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.');
      if (o.gap >= LIM.gapErr) out.push(['crit', 'Kritik', `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`${o.kind === 'J' ? 'ölçülen' : 'planlanan'} aralık ${fmt(o.gap)} mm (hata eşiği ${fmt(LIM.gapErr)} mm); kaynamama riski.`)} ${fix}`, 'fib']);
      else if (o.gap > LIM.gap) out.push(['warn', 'Uyarı', o.kind === 'J' ? `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`ölçülen aralık ${fmt(o.gap)} mm (örnek eşik ${fmt(LIM.gap)} mm).`)} ${fix}` : `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`planlanan aralık ${fmt(o.gap)} mm (örnek eşik ${fmt(LIM.gap)} mm).`)} ${fix}`, 'fib']);
      if (o.kind !== 'J' && o.angle != null && o.angle > LIM.axis) out.push(['info', 'Bilgi', `${xl('Osteotomi')} ${xl(o.name)}: ${xl(`greft ekseni mandibula ekseninden ${fmt(o.angle, 0)}° sapıyor.`)}`, 'fib']);
    });
    return out;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);
  const angTxt = o => o.angle == null ? '–' : `${fmt(o.angle, 0)}° ${xl(o.kind === 'J' ? 'kama' : 'eksen')}`;
  function render() {
    const box = $('osteoBox'); if (!box) return;
    if (!last || !last.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="sub">Osteotomi raporu</h3>
      <div class="tbl"><table><thead><tr><th>Bağlantı</th><th>Açı</th><th>Temas</th><th>Aralık (mm)</th></tr></thead><tbody>${last.map(o => `<tr title="${o.name}"><td>${o.short}</td><td>${angTxt(o)}</td><td>${fmt(o.contact, 0)} mm² %${fmt(o.overlap * 100, 0)}</td><td>${fmt(o.gap)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint more">M: mandibula güdüğü · S: fibula segmenti (ü: üst namlu) · Kama: segmentler arasında çıkarılan kapama kaması. Eksen: greft ile güdük arasındaki açı. Temas: greft kesitine oranı. Aralık: güdük uçlarında testere yuvasının güdükten aldığı kemik; segmentler arasında planlı aralık 0, tabloda ölçülen değer. ${fmt(lim().gap)} mm üstü uyarı, ${fmt(lim().gapErr)} mm ve üstü kritik.</p>`;
  }
  function summary() {
    return last ? last.map(o => ({ baglanti: o.name, aci_deg: o.angle == null ? null : +o.angle.toFixed(1), aci_turu: o.kind === 'J' ? 'kapama kaması' : 'greft-mandibula ekseni', bukme_deg: o.bend != null ? +o.bend.toFixed(1) : undefined,
      temas_mm2: Math.round(o.contact), temas_orani: +o.overlap.toFixed(2), greft_kesiti_mm2: Math.round(o.graftArea), aralik_mm: +o.gap.toFixed(2), merkez_kaymasi_mm: o.shift != null ? +o.shift.toFixed(1) : undefined })) : null;
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!last || !last.length) return;
    if (d.keep) d.keep(330); d.h2('Osteotomi raporu');
    d.table(['Bağlantı', 'Açı', 'Temas alanı', 'Temas oranı', 'Aralık'], last.map(o => [o.name, angTxt(o), `${fmt(o.contact, 0)} mm²`, `%${fmt(o.overlap * 100, 0)}`, `${fmt(o.gap)} mm`]), [0.36, 0.16, 0.18, 0.15, 0.15]);
    d.text('Temas, iki kemik kesitinin bağlantı düzleminde 0,3 mm aralıkla örneklenmesiyle hesaplanır. Eşikler örnek değerlerdir.', { size: 20, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'osteotomi_raporu.json', data: JSON.stringify(s, null, 2) }); });

  function update() {
    const st = Fibula.active() ? Fibula.state() : null;
    const k = st && st.last ? JSON.stringify(st.last.segs.map(g => [g.P0, g.P1, g.N0, g.N1, g.s0, g.i]).concat(S.planes.map(p => [p.off, p.yaw, p.pitch, p.w]))) : '';
    if (k === key) { render(); return; }
    key = k;
    try { last = k ? compute() : null; } catch (e) { last = null; }
    render(); St.renderChecks();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 300); };
  ['changed', 'parts', 'planApplied', 'fibGuide'].forEach(e => bus.addEventListener(e, () => { if (!S.restoring) later(); }));
  bus.addEventListener('volume', () => { last = null; key = ''; render(); });
  return { get: () => last, summary, update };
})();
