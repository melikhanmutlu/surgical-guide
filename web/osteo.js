/* Osteotomy report: every bone-to-bone junction of the reconstruction (mandible stump to graft at each end of the
   defect, and graft to graft between fibula segments) with its angle, bone contact area and gap.
   Contact is measured by sampling both sections in the junction plane on a 0.3 mm grid: a point is in contact when
   the stump (or the previous segment) has bone just behind the plane and the next piece has bone just in front.
   Between segments the angle is the closing wedge taken out of the fibula (angle between the two cuts on the
   fibula); at the mandible ends it is the angle between the graft axis and the mandible stump axis. */
'use strict';
window.Osteo = (function () {
  const St = window.Studio; if (!St || !window.Fibula) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const r2d = THREE.MathUtils.radToDeg;
  // sample thresholds; the clinical team sets the final values
  const LIM = { overlap: 0.5, area: 40, wedge: 45, gap: 1.0, axis: 30 };
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
      const P = end === 'A' ? E.A : E.B, N = (end === 'A' ? g.N0 : g.N1).clone(), sgn = end === 'A' ? -1 : 1, p = end === 'A' ? g.P0 : g.P1;
      const back = P.w / 2 + 0.4, sec = section(p, N, Math.max(18, FR + 6), q => St.boneAt(q.clone().addScaledVector(N, sgn * back)), q => gb(g.i, q.clone().addScaledVector(N, -sgn * 0.4)));
      const ax = stumpAxis(p.clone().addScaledVector(N, sgn * P.w / 2), N.clone().multiplyScalar(sgn));
      // graft direction leaving the stump into the defect
      const into = g.x.clone().multiplyScalar(-sgn), axis = ax ? r2d(ax.angleTo(into)) : null;
      return { kind: end, name: `Mandibula ${end === 'A' ? '1' : '2'} – segment ${g.i + 1}${g.barrel ? ' (üst)' : ''}`, short: end === 'A' ? `M1–S${g.i + 1}${g.barrel ? 'ü' : ''}` : `S${g.i + 1}${g.barrel ? 'ü' : ''}–M2`, seg: g.i, angle: axis, angleKind: 'eksen',
        contact: sec.contact, graftArea: sec.areaB, otherArea: sec.areaA, gap: P.w / 2 };
    };
    lower.length && out.push(mand(lower[0], 'A'));
    for (let j = 0; j < lower.length - 1; j++) {
      const a = lower[j], b = lower[j + 1], N = a.N1;
      const sec = section(a.P1, N, FR + 5, q => gb(a.i, q.clone().addScaledVector(N, -0.4)), q => gb(b.i, q.clone().addScaledVector(N, 0.4)));
      const wedge = r2d(Math.acos(Math.max(-1, Math.min(1, a.n1.dot(b.n0))))), bend = r2d(a.x.angleTo(b.x));
      out.push({ kind: 'J', name: `Segment ${a.i + 1} – segment ${b.i + 1}`, short: `S${a.i + 1}–S${b.i + 1}`, seg: b.i, angle: wedge, bend, angleKind: 'kama',
        contact: sec.contact, graftArea: Math.min(sec.areaA, sec.areaB), otherArea: Math.max(sec.areaA, sec.areaB), gap: 0, shift: sec.ca && sec.cb ? sec.ca.distanceTo(sec.cb) : null });
    }
    if (!E.condyle && lower.length) out.push(mand(lower[lower.length - 1], 'B'));
    upper.forEach(g => { out.push(mand(g, 'A')); if (!E.condyle) out.push(mand(g, 'B')); });
    out.forEach(o => { o.overlap = o.graftArea > 0 ? o.contact / o.graftArea : 0; });
    return out;
  }

  // ---------- checks, panel, report, export ----------
  function checks() {
    const out = []; if (!last) return out;
    last.forEach(o => {
      if (o.graftArea > 0 && o.overlap < LIM.overlap) out.push(['warn', 'Uyarı', `Osteotomi ${o.name}: kemik teması greft kesitinin %${fmt(o.overlap * 100, 0)}'i (örnek eşik %${LIM.overlap * 100}). Kemik iyileşmesi için temas artırılmalı.`, 'fib']);
      else if (o.contact < LIM.area) out.push(['warn', 'Uyarı', `Osteotomi ${o.name}: temas alanı ${fmt(o.contact, 0)} mm² (örnek eşik ${LIM.area} mm²).`, 'fib']);
      if (o.kind === 'J' && o.angle > LIM.wedge) out.push(['warn', 'Uyarı', `Osteotomi ${o.name}: kapama kaması ${fmt(o.angle, 0)}° (örnek eşik ${LIM.wedge}°); kesi yüzeyleri uzar, temas zayıflar.`, 'fib']);
      if (o.gap > LIM.gap) out.push(['warn', 'Uyarı', `Osteotomi ${o.name}: planlanan aralık ${fmt(o.gap)} mm (örnek eşik ${fmt(LIM.gap)} mm). Kesi yuvasını daraltın.`, 'fib']);
      if (o.kind !== 'J' && o.angle != null && o.angle > LIM.axis) out.push(['info', 'Bilgi', `Osteotomi ${o.name}: greft ekseni mandibula ekseninden ${fmt(o.angle, 0)}° sapıyor.`, 'fib']);
    });
    return out;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);
  const angTxt = o => o.angle == null ? '–' : `${fmt(o.angle, 0)}° ${o.kind === 'J' ? 'kama' : 'eksen'}`;
  function render() {
    const box = $('osteoBox'); if (!box) return;
    if (!last || !last.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3 class="sub">Osteotomi raporu</h3>
      <div class="tbl"><table><thead><tr><th>Bağlantı</th><th>Açı</th><th>Temas</th><th>Aralık (mm)</th></tr></thead><tbody>${last.map(o => `<tr title="${o.name}"><td>${o.short}</td><td>${angTxt(o)}</td><td>${fmt(o.contact, 0)} mm² %${fmt(o.overlap * 100, 0)}</td><td>${fmt(o.gap)}</td></tr>`).join('')}</tbody></table></div>
      <p class="hint more">M: mandibula güdüğü, S: fibula segmenti (ü: üst namlu). Kama: segmentler arası fibuladan çıkarılan kapama kaması. Eksen: greft ile mandibula güdüğü arasındaki açı. Temas yüzdesi greft kesitine göredir. Aralık testere yuvasının güdükten aldığı paydır; segmentler arasında testere payı fibulada ayrıldığından sıfırdır.</p>`;
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
