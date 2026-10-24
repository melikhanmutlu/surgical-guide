/* Material and manufacturing profile: presets for the printing process set the tolerances of the guides
   (bone clearance, cut slot tolerance over the saw blade, minimum wall, drill sleeve fit). Applying a profile
   writes these into the mandible and fibula guide design; checks flag a design that drifts below the profile.
   Values are typical starting points; the manufacturer validates them for its own process. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Mfg = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus, esc } = St, $ = id => document.getElementById(id);
  const PRESETS = {
    sla: { name: 'SLA reçine (biyouyumlu)', clear: 0.2, slotTol: 0.2, minWall: 2.0, fit: 0.1, note: 'Sterilizasyon sonrası boyut kontrolü önerilir.' },
    sls: { name: 'SLS PA12', clear: 0.3, slotTol: 0.3, minWall: 2.5, fit: 0.2, note: 'Toz yüzey pürüzü nedeniyle boşluklar geniş tutulur.' },
    polyjet: { name: 'PolyJet reçine (biyouyumlu)', clear: 0.2, slotTol: 0.2, minWall: 2.0, fit: 0.1, note: 'Destek malzemesi tümüyle temizlenmeli; sterilizasyon sonrası boyut kontrolü önerilir.' },
    ti: { name: 'Titanyum (SLM)', clear: 0.2, slotTol: 0.15, minWall: 1.2, fit: 0.05, note: 'Destek yapıları ve yüzey işlemi sonrası ölçü kontrolü yapılır.' },
    custom: { name: 'Özel', clear: 0.3, slotTol: 0.2, minWall: 2.0, fit: 0.1, note: '' },
  };
  const CV = (k, d) => (window.Clinical ? Clinical.v(k) : d);   // clinical.js (C4)
  const DEF = { prof: null, blade: 0.6, clear: 0.3, slotTol: CV('slotTol', 0.2), minWall: CV('minWall', 2.0), fit: 0.1 };
  const F = [['blade', 'Testere ağzı kalınlığı', 0.3, 1.5, 0.05, 'mm'], ['clear', 'Kemik aralığı', 0, 1, 0.05, 'mm'], ['slotTol', 'Yuva toleransı (testereye ek)', 0, 0.8, 0.05, 'mm'], ['minWall', 'En ince duvar', 0.8, 4, 0.1, 'mm'], ['fit', 'Kovan geçme payı (matkaba ek)', 0, 0.5, 0.05, 'mm']];
  let M = Object.assign({}, DEF);
  // a stored plan is untrusted input (G1: its values were written into the form unescaped): the profile key must be a
  // known preset, every number finite and inside its control's range, anything else falls back to the default
  function clean(x) {
    const o = Object.assign({}, DEF); if (!x || typeof x !== 'object') return o;
    o.prof = typeof x.prof === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, x.prof) ? x.prof : null;
    F.forEach(([k, , mn, mx]) => { const v = Number(x[k]); if (x[k] !== null && x[k] !== '' && Number.isFinite(v)) o[k] = Math.max(mn, Math.min(mx, v)); });
    if (x.sleeve === 0 || x.sleeve === 1) o.sleeve = x.sleeve;   // drill holes: 0 printed, 1 metal sleeves (unset: not chosen)
    return o;
  }
  const slot = () => Math.round((M.blade + M.slotTol) * 100) / 100;

  // write the profile into the design; changed items lose their approval
  function apply() {
    if (!M.prof) return;
    S.g.clear = M.clear; S.g.fit = M.fit; S.g.blade = M.blade; if (S.g.wall < M.minWall) S.g.wall = M.minWall;
    const w = slot();
    S.planes.forEach(p => { if (Math.abs(p.w - w) > 1e-6) { p.w = w; St.unapprove(p); } });
    const fp = window.Fibula && Fibula.plan();
    if (fp) {
      // the fibula plan keeps the two apart: the blade is the bone a cut takes, the slot is the guide's opening
      fp.kerf = Math.min(2, Math.max(0.5, M.blade)); fp.slotW = Math.max(fp.kerf, Math.min(2.5, w));
      if (fp.fg) { if (fp.fg.clear != null) fp.fg.clear = M.clear; if (fp.fg.wall != null && fp.fg.wall < M.minWall) fp.fg.wall = M.minWall; }
      St.unapprove(fp); Fibula.guideEdited();
    }
    syncG(); St.schedule(true);
  }
  // the guide sliders in step 5 show S.g; poke them so their outputs follow
  function syncG() { ['clear', 'wall'].forEach(k => { const el = $('g_' + k); if (el) { el.value = S.g[k]; el.dispatchEvent(new Event('input')); } }); }

  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = []; if (!S.anchor) return out;
    if (!M.prof) { out.push(['info', 'Bilgi', 'Üretim profili seçilmedi; toleranslar varsayılan değerlerde.', 'guide']); return out; }
    const nm = PRESETS[M.prof].name, w = slot();
    if (S.g.wall < M.minWall - 1e-6) out.push(['crit', 'Kritik', `${xl(`Guide duvarı ${fmt(S.g.wall)} mm;`)} ${xl(nm)} ${xl(`için en az ${fmt(M.minWall)} mm.`)}`, 'guide']);
    const fg = window.Fibula && Fibula.guideInfo && Fibula.guideInfo();
    if (fg && fg.body.wall < M.minWall - 1e-6) out.push(['crit', 'Kritik', `${xl(`Fibula guide'ı duvarı ${fmt(fg.body.wall)} mm;`)} ${xl(nm)} ${xl(`için en az ${fmt(M.minWall)} mm.`)}`, 'fib']);
    S.planes.forEach((p, i) => {
      if (p.w < w - 1e-6) out.push(['warn', 'Uyarı', xl(`Kesi ${i + 1} yuvası ${fmt(p.w)} mm; testere ${fmt(M.blade, 2)} mm ve tolerans ${fmt(M.slotTol, 2)} mm için en az ${fmt(w, 2)} mm.`), 'p' + i]);
      // a slot much wider than the blade lets it tilt: angle errors add up unnoticed (blade + 0.1-0.3 mm guides best)
      else if (p.w - M.blade > 0.3 + 1e-6) out.push(['warn', 'Uyarı', `Kesi ${i + 1} yuvası ${fmt(p.w, 2)} mm, testereden ${fmt(p.w - M.blade, 2)} mm geniş; en çok 0,3 mm önerilir, daha geniş yuva açı hatası biriktirir.`, 'p' + i]);
    });
    if (M.sleeve == null) out.push(['info', 'Bilgi', xl('Matkap delikleri için metal kovan ya da basılı delik seçilmedi (Üretim profili).'), 'guide']);
    else if (M.sleeve === 0 && M.prof !== 'ti') out.push(['info', 'Bilgi', xl('Basılı delikte matkap guide malzemesini aşındırabilir ve parçacık bırakabilir; tekrarlı delmede metal kovan önerilir.'), 'guide']);
    else if (M.sleeve === 1) out.push(['info', 'Bilgi', xl('Metal kovan seçildi: guide deliği kovanın dış çapına göre açılmalı; bu sürüm kovan yuvasını ayrıca çizmiyor, üreticiyle doğrulayın.'), 'guide']);
    if (Math.abs(S.g.clear - M.clear) > 1e-6) out.push(['info', 'Bilgi', xl(`Kemik boşluğu ${fmt(S.g.clear, 2)} mm, profil ${fmt(M.clear, 2)} mm öneriyor.`), 'guide']);
    if (Math.abs((S.g.fit || 0) - M.fit) > 1e-6) out.push(['info', 'Bilgi', xl(`Kovan geçme payı ${fmt(S.g.fit || 0, 2)} mm, profil ${fmt(M.fit, 2)} mm öneriyor.`), 'guide']);
    return out;
  });
  // D2: the build direction that keeps supports off the bone contact surface. Supports grow under faces that look down
  // more than 45° from the build axis; the guide's contact faces look towards the bone (-n), so with the bone side up
  // (build axis -n) they need none. Measured on the guide mesh: the overhang area, and how much of it is contact (a
  // triangle whose point 0.3 mm + the bone clearance along its normal is bone).
  function overhang(Z) {
    const g = St.parts.guide && St.parts.guide.obj; if (!g) return null;
    let all = 0, contact = 0; const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), q = new THREE.Vector3(), lim = -Math.SQRT1_2;
    g.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      o.updateMatrixWorld(true);
      const A = o.geometry.attributes.position.array, I = o.geometry.index ? o.geometry.index.array : null, n = I ? I.length : A.length / 3;
      for (let t = 0; t < n; t += 3) {
        for (let k = 0; k < 3; k++) { const i = (I ? I[t + k] : t + k) * 3; v[k].set(A[i], A[i + 1], A[i + 2]).applyMatrix4(o.matrixWorld); }
        e1.subVectors(v[1], v[0]); e2.subVectors(v[2], v[0]); const nn = e1.cross(e2), a = nn.length() / 2; if (!(a > 0)) continue;
        nn.normalize(); if (nn.dot(Z) >= lim) continue;
        all += a;
        q.copy(v[0]).add(v[1]).add(v[2]).multiplyScalar(1 / 3).addScaledVector(nn, (S.g.clear || 0) + 0.3);
        if (St.boneAt(q)) contact += a;
      }
    });
    return { all, contact };
  }
  function buildDir() {
    if (!S.anchor || !St.parts.guide) return null;
    const n = S.anchor.n.clone().normalize(), up = n.clone().negate(), a = overhang(up), b = overhang(n);
    return a && b ? { axis: up.toArray().map(x => +x.toFixed(4)), supportMm2: +a.all.toFixed(0), contactSupportMm2: +a.contact.toFixed(0), reverseContactMm2: +b.contact.toFixed(0) } : null;
  }
  function summary() {
    if (!M.prof) return null;
    return { profil: PRESETS[M.prof].name, testere_mm: M.blade, kemik_boslugu_mm: M.clear, yuva_toleransi_mm: M.slotTol, yuva_genisligi_mm: slot(), en_ince_duvar_mm: M.minWall, kovan_gecme_payi_mm: M.fit,
      matkap_delikleri: M.sleeve === 1 ? 'metal kovan' : M.sleeve === 0 ? 'basılı delik' : null, baski_yonu: buildDir(),
      tasarim: { kemik_boslugu_mm: S.g.clear, periost_payi_mm: S.g.peri || 0, duvar_mm: S.g.wall, yuvalar_mm: S.planes.map(p => p.w), matkap_deligi_mm: S.screws.map(s => +(s.d + (S.g.fit || 0)).toFixed(2)) }, not: PRESETS[M.prof].note };
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(300); d.h2('Malzeme ve üretim profili');
    d.table(['Özellik', 'Profil', 'Tasarım'], [['Malzeme / süreç', s.profil, ''], ['Kemik boşluğu', `${fmt(s.kemik_boslugu_mm, 2)} mm`, `${fmt(s.tasarim.kemik_boslugu_mm, 2)} mm + periost ${fmt(s.tasarim.periost_payi_mm, 2)} mm`], ['Kesi yuvası', `${fmt(s.testere_mm, 2)} + ${fmt(s.yuva_toleransi_mm, 2)} mm`, s.tasarim.yuvalar_mm.map(x => fmt(x, 2)).join(', ') + ' mm'], ['En ince duvar', `${fmt(s.en_ince_duvar_mm)} mm`, `${fmt(s.tasarim.duvar_mm)} mm`], ['Kovan geçme payı', `${fmt(s.kovan_gecme_payi_mm, 2)} mm`, s.tasarim.matkap_deligi_mm.length ? `${xl('delik')} ${s.tasarim.matkap_deligi_mm.map(x => fmt(x, 2)).join(', ')} mm` : '–']], [0.3, 0.3, 0.4]);
    if (s.matkap_delikleri) d.text(`${xl('Matkap delikleri:')} ${xl(s.matkap_delikleri)}.`, { size: 20 });
    if (s.baski_yonu) d.text(xl(`Önerilen baskı yönü: kemiğe bakan yüz yukarı (yapı ekseni guide'ın oturma yönünün tersi). Destek gereken alan ${fmt(s.baski_yonu.supportMm2, 0)} mm², temas yüzeyinde ${fmt(s.baski_yonu.contactSupportMm2, 0)} mm² (ters yönde ${fmt(s.baski_yonu.reverseContactMm2, 0)} mm²).`), { size: 20 });
    if (s.not) d.text(s.not, { size: 20, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'uretim_profili.json', data: JSON.stringify(s, null, 2) }); });

  function render() {
    const box = $('mfgBox'); if (!box) return;
    if (box.contains(document.activeElement) && document.activeElement.type === 'range') return;
    box.innerHTML = `<h3 class="sub">Üretim profili</h3>
      <div class="ctl"><label for="mfProf" class="lbl2">Malzeme ve süreç</label><select id="mfProf"><option value="">Seçilmedi</option>${Object.entries(PRESETS).map(([k, x]) => `<option value="${esc(k)}" ${M.prof === k ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      ${M.prof ? `<div class="ctl"><label for="mfSleeve" class="lbl2">Matkap delikleri</label><select id="mfSleeve"><option value="" ${M.sleeve == null ? 'selected' : ''}>Seçilmedi</option><option value="0" ${M.sleeve === 0 ? 'selected' : ''}>Basılı delik</option><option value="1" ${M.sleeve === 1 ? 'selected' : ''}>Metal kovan</option></select></div>` : ''}
      ${M.prof ? F.map(([k, t, mn, mx, st, un]) => `<div class="ctl"><div class="ctl-row"><label for="mf_${k}">${t}</label><output id="mfo_${k}">${fmt(M[k], 2)} ${un}</output></div><input type="range" id="mf_${k}" min="${mn}" max="${mx}" step="${st}" value="${esc(String(M[k]))}" ${M.prof !== 'custom' && k !== 'blade' ? 'disabled' : ''}></div>`).join('') +
        `<p class="hint">${xl(`Kesi yuvası ${fmt(slot(), 2)} mm olur.`)}</p><p class="hint more">${xl('Profil uygulanınca boşluk, geçme payı, yuvalar ve en ince duvar tasarıma yazılır; değişen kesilerin onayı kalkar.')} ${xl(PRESETS[M.prof].note)}</p>` : '<p class="hint more">Profil seçilince guide toleransları üretim yöntemine göre ayarlanır.</p>'}`;
    $('mfProf').addEventListener('change', e => { const k = e.target.value || null; M = Object.assign({}, M, k ? PRESETS[k] : {}, { prof: k }); delete M.name; delete M.note; apply(); render(); St.emit('changed'); });
    const sl = $('mfSleeve'); if (sl) sl.addEventListener('change', e => { const v = e.target.value; if (v === '') delete M.sleeve; else M.sleeve = +v; render(); St.emit('changed'); });
    F.forEach(([k, , , , , un]) => { const el = $('mf_' + k); if (!el) return;
      el.addEventListener('input', () => { M[k] = +el.value; $('mfo_' + k).textContent = `${fmt(M[k], 2)} ${un}`; });
      el.addEventListener('change', () => { el.blur(); apply(); render(); St.emit('changed'); }); });
  }
  (window.PlanExt = window.PlanExt || {}).mfg = {
    label: 'Üretim profili',
    get: () => (M.prof ? Object.assign({}, M) : null),
    set(x) { M = clean(x); render(); },
  };
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { M = Object.assign({}, DEF); render(); } });
  render();
  return { summary, presets: PRESETS, get: () => M, apply, buildDir, overhang };
})();
