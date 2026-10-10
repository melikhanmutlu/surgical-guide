/* Material and manufacturing profile: presets for the printing process set the tolerances of the guides
   (bone clearance, cut slot tolerance over the saw blade, minimum wall, drill sleeve fit). Applying a profile
   writes these into the mandible and fibula guide design; checks flag a design that drifts below the profile.
   Values are typical starting points; the manufacturer validates them for its own process. */
'use strict';
window.Mfg = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus } = St, $ = id => document.getElementById(id);
  const PRESETS = {
    sla: { name: 'SLA reçine (biyouyumlu)', clear: 0.2, slotTol: 0.2, minWall: 2.0, fit: 0.1, note: 'Sterilizasyon sonrası boyut kontrolü önerilir.' },
    sls: { name: 'SLS PA12', clear: 0.3, slotTol: 0.3, minWall: 2.5, fit: 0.2, note: 'Toz yüzey pürüzü nedeniyle boşluklar geniş tutulur.' },
    ti: { name: 'Titanyum (SLM)', clear: 0.2, slotTol: 0.15, minWall: 1.2, fit: 0.05, note: 'Destek yapıları ve yüzey işlemi sonrası ölçü kontrolü yapılır.' },
    custom: { name: 'Özel', clear: 0.3, slotTol: 0.2, minWall: 2.0, fit: 0.1, note: '' },
  };
  const DEF = { prof: null, blade: 0.6, clear: 0.3, slotTol: 0.2, minWall: 2.0, fit: 0.1 };
  const F = [['blade', 'Testere ağzı kalınlığı', 0.3, 1.5, 0.05, 'mm'], ['clear', 'Kemik aralığı', 0, 1, 0.05, 'mm'], ['slotTol', 'Yuva toleransı (testereye ek)', 0, 0.8, 0.05, 'mm'], ['minWall', 'En ince duvar', 0.8, 4, 0.1, 'mm'], ['fit', 'Kovan geçme payı (matkaba ek)', 0, 0.5, 0.05, 'mm']];
  let M = Object.assign({}, DEF);
  const slot = () => Math.round((M.blade + M.slotTol) * 100) / 100;

  // write the profile into the design; changed items lose their approval
  function apply() {
    if (!M.prof) return;
    S.g.clear = M.clear; S.g.fit = M.fit; if (S.g.wall < M.minWall) S.g.wall = M.minWall;
    const w = slot();
    S.planes.forEach(p => { if (Math.abs(p.w - w) > 1e-6) { p.w = w; St.unapprove(p); } });
    const fp = window.Fibula && Fibula.plan();
    if (fp) {
      fp.kerf = Math.min(2, Math.max(0.5, w));
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
    if (S.g.wall < M.minWall - 1e-6) out.push(['crit', 'Kritik', `Guide duvarı ${fmt(S.g.wall)} mm; ${nm} için en az ${fmt(M.minWall)} mm.`, 'guide']);
    const fg = window.Fibula && Fibula.guideInfo && Fibula.guideInfo();
    if (fg && fg.body.wall < M.minWall - 1e-6) out.push(['crit', 'Kritik', `Fibula guide'ı duvarı ${fmt(fg.body.wall)} mm; ${nm} için en az ${fmt(M.minWall)} mm.`, 'fib']);
    S.planes.forEach((p, i) => { if (p.w < w - 1e-6) out.push(['warn', 'Uyarı', `Kesi ${i + 1} yuvası ${fmt(p.w)} mm; testere ${fmt(M.blade, 2)} mm ve tolerans ${fmt(M.slotTol, 2)} mm için en az ${fmt(w, 2)} mm.`, 'p' + i]); });
    if (Math.abs(S.g.clear - M.clear) > 1e-6) out.push(['info', 'Bilgi', `Kemik boşluğu ${fmt(S.g.clear, 2)} mm, profil ${fmt(M.clear, 2)} mm öneriyor.`, 'guide']);
    if (Math.abs((S.g.fit || 0) - M.fit) > 1e-6) out.push(['info', 'Bilgi', `Kovan geçme payı ${fmt(S.g.fit || 0, 2)} mm, profil ${fmt(M.fit, 2)} mm öneriyor.`, 'guide']);
    return out;
  });
  function summary() {
    if (!M.prof) return null;
    return { profil: PRESETS[M.prof].name, testere_mm: M.blade, kemik_boslugu_mm: M.clear, yuva_toleransi_mm: M.slotTol, yuva_genisligi_mm: slot(), en_ince_duvar_mm: M.minWall, kovan_gecme_payi_mm: M.fit,
      tasarim: { kemik_boslugu_mm: S.g.clear, periost_payi_mm: S.g.peri || 0, duvar_mm: S.g.wall, yuvalar_mm: S.planes.map(p => p.w), matkap_deligi_mm: S.screws.map(s => +(s.d + (S.g.fit || 0)).toFixed(2)) }, not: PRESETS[M.prof].note };
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(300); d.h2('Malzeme ve üretim profili');
    d.table(['Özellik', 'Profil', 'Tasarım'], [['Malzeme / süreç', s.profil, ''], ['Kemik boşluğu', `${fmt(s.kemik_boslugu_mm, 2)} mm`, `${fmt(s.tasarim.kemik_boslugu_mm, 2)} mm + periost ${fmt(s.tasarim.periost_payi_mm, 2)} mm`], ['Kesi yuvası', `${fmt(s.testere_mm, 2)} + ${fmt(s.yuva_toleransi_mm, 2)} mm`, s.tasarim.yuvalar_mm.map(x => fmt(x, 2)).join(', ') + ' mm'], ['En ince duvar', `${fmt(s.en_ince_duvar_mm)} mm`, `${fmt(s.tasarim.duvar_mm)} mm`], ['Kovan geçme payı', `${fmt(s.kovan_gecme_payi_mm, 2)} mm`, s.tasarim.matkap_deligi_mm.length ? `delik ${s.tasarim.matkap_deligi_mm.map(x => fmt(x, 2)).join(', ')} mm` : '–']], [0.3, 0.3, 0.4]);
    if (s.not) d.text(s.not, { size: 20, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'uretim_profili.json', data: JSON.stringify(s, null, 2) }); });

  function render() {
    const box = $('mfgBox'); if (!box) return;
    if (box.contains(document.activeElement) && document.activeElement.type === 'range') return;
    box.innerHTML = `<h3 class="sub">Üretim profili</h3>
      <div class="ctl"><label for="mfProf" class="lbl2">Malzeme ve süreç</label><select id="mfProf"><option value="">Seçilmedi</option>${Object.entries(PRESETS).map(([k, x]) => `<option value="${k}" ${M.prof === k ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>
      ${M.prof ? F.map(([k, t, mn, mx, st, un]) => `<div class="ctl"><div class="ctl-row"><label for="mf_${k}">${t}</label><output id="mfo_${k}">${fmt(M[k], 2)} ${un}</output></div><input type="range" id="mf_${k}" min="${mn}" max="${mx}" step="${st}" value="${M[k]}" ${M.prof !== 'custom' && k !== 'blade' ? 'disabled' : ''}></div>`).join('') +
        `<p class="hint">Kesi yuvası ${fmt(slot(), 2)} mm olur.</p><p class="hint more">Profil uygulanınca boşluk, geçme payı, yuvalar ve en ince duvar tasarıma yazılır; değişen kesilerin onayı kalkar. ${PRESETS[M.prof].note}</p>` : '<p class="hint more">Profil seçilince guide toleransları üretim yöntemine göre ayarlanır.</p>'}`;
    $('mfProf').addEventListener('change', e => { const k = e.target.value || null; M = Object.assign({}, M, k ? PRESETS[k] : {}, { prof: k }); delete M.name; delete M.note; apply(); render(); St.emit('changed'); });
    F.forEach(([k, , , , , un]) => { const el = $('mf_' + k); if (!el) return;
      el.addEventListener('input', () => { M[k] = +el.value; $('mfo_' + k).textContent = `${fmt(M[k], 2)} ${un}`; });
      el.addEventListener('change', () => { el.blur(); apply(); render(); St.emit('changed'); }); });
  }
  (window.PlanExt = window.PlanExt || {}).mfg = {
    label: 'Üretim profili',
    get: () => (M.prof ? Object.assign({}, M) : null),
    set(x) { M = Object.assign({}, DEF, x || {}); render(); },
  };
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { M = Object.assign({}, DEF); render(); } });
  render();
  return { summary, presets: PRESETS, get: () => M, apply };
})();
