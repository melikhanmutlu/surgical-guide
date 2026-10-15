/* CT date check: the acquisition (or series, or study) date read from the DICOM header and the planned surgery date.
   A plan made on a CT older than three weeks at surgery may no longer match the bone (tumour growth, remodelling),
   so the step warns. Only dates are kept; no patient name or ID. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
// Shared date / time display for the interface language (approval stamps, case list, audit trail, PDF report header).
// EN spells the month ("Oct 14, 2026"), never 10/14 against 14.10; times are 24 h in both languages.
window.DateFmt = (function () {
  const en = () => !!(window.I18N && I18N.lang === 'en');
  const ok = t => t != null && t !== '' && !isNaN(new Date(t).getTime());
  const HM = { hour: '2-digit', minute: '2-digit', hour12: false };
  const f = (trOpt, enOpt) => t => (!ok(t) ? '–' : en() ? new Date(t).toLocaleString('en-US', enOpt) : new Date(t).toLocaleString('tr-TR', trOpt));
  return {
    date: f({ day: '2-digit', month: '2-digit', year: 'numeric' }, { day: 'numeric', month: 'short', year: 'numeric' }),
    dateTime: f({ day: '2-digit', month: '2-digit', year: 'numeric', ...HM }, { day: 'numeric', month: 'short', year: 'numeric', ...HM }),
    short: f({ day: '2-digit', month: '2-digit', ...HM }, { day: 'numeric', month: 'short', ...HM }),   // no year: recent items (case list)
    time: f(HM, HM),
  };
})();
window.Dates = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus } = St, $ = id => document.getElementById(id);
  const MAX_DAYS = 21;   // three weeks (sample value; the clinical team sets the limit)
  let surgery = '', ctSaved = '';
  const iso = d => (/^\d{8}$/.test(d || '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
  const ctOf = vol => { const m = vol && vol.meta || {}; return iso(m.acqDate) || iso(m.seriesDate) || iso(m.studyDate); };
  const ctDate = () => ctOf(S.vol) || ctSaved;
  const fibDate = () => { const st = window.Fibula && Fibula.active() ? Fibula.state() : null; return st && st.F ? ctOf(st.F.vol) : ''; };
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const tr = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString(...(window.I18N && I18N.lang === 'en' ? ['en-US', { day: 'numeric', month: 'short', year: 'numeric' }] : ['tr-TR'])) : '–');   // EN: "Oct 14, 2026", never 10/14 vs 14.10
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };   // local date, not UTC

  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [], ct = ctDate(), fd = fibDate();
    if (!S.vol) return out;
    const one = (d, what) => {
      if (!d) return;
      if (surgery) {
        const n = days(d, surgery);
        if (n < 0) out.push(['warn', 'Uyarı', xl(`${what} ameliyat tarihinden sonra (${tr(d)}); tarihleri kontrol edin.`), 'data']);
        else if (n > MAX_DAYS) out.push(['warn', 'Uyarı', xl(`${what} ameliyattan ${n} gün önce çekilmiş (${tr(d)}); ${MAX_DAYS} günden eski. Lezyon büyümüş ya da kemik değişmiş olabilir; güncel BT önerilir.`), 'data']);
      } else if (days(d, today()) > MAX_DAYS) out.push(['info', 'Bilgi', xl(`${what} ${days(d, today())} gün önce çekilmiş; BT yaşı kontrolü için ameliyat tarihini girin.`), 'data']);
    };
    one(ct, 'Mandibula BT\'si'); one(fd, 'Fibula BT\'si');
    if (!ct && S.source && S.source.type === 'dicom') out.push(['info', 'Bilgi', xl('BT tarihi DICOM başlığında yok (anonimleştirilmiş olabilir); BT yaşı denetlenemedi.'), 'data']);
    if (surgery && days(today(), surgery) < 0) out.push(['info', 'Bilgi', xl(`Planlanan ameliyat tarihi geçmişte (${tr(surgery)}).`), 'data']);
    return out;
  });
  function render() {
    const el = $('dateInfo'); if (!el) return;
    const ct = ctDate(), fd = fibDate();
    el.innerHTML = `<dt>BT tarihi</dt><dd>${ct ? tr(ct) : S.source && S.source.type === 'dicom' ? xl('başlıkta yok') : xl('örnek vaka')}</dd>${fd ? `<dt>Fibula BT tarihi</dt><dd>${tr(fd)}</dd>` : ''}${ct && surgery ? `<dt>Ameliyatta BT yaşı</dt><dd>${xl(`${days(ct, surgery)} gün`)}</dd>` : ''}`;
    if (document.activeElement !== $('surgDate')) $('surgDate').value = surgery;
  }
  $('surgDate').addEventListener('change', e => { surgery = e.target.value || ''; render(); St.renderChecks(); St.emit('changed'); });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const ct = ctDate(); if (!ct && !surgery) return;
    if (d.keep) d.keep(220); d.h2('Tarihler');
    d.table(['Tarih', 'Değer'], [['BT çekim tarihi', tr(ct)], ['Fibula BT tarihi', tr(fibDate())], ['Planlanan ameliyat', tr(surgery)], ['Ameliyatta BT yaşı', ct && surgery ? xl(`${days(ct, surgery)} gün (sınır ${MAX_DAYS} gün)`) : '–']], [0.5, 0.5]);
  });
  (window.PlanExt = window.PlanExt || {}).dates = {
    label: 'Ameliyat tarihi',
    get: () => (surgery || ctDate() ? { surgery, ct: ctDate() } : null),
    set(x) { surgery = (x && x.surgery) || ''; ctSaved = (x && x.ct) || ''; render(); },
  };
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { ctSaved = ''; surgery = ''; } render(); });
  ['changed', 'planApplied'].forEach(ev => bus.addEventListener(ev, render));
  render();
  return { ctDate, surgery: () => surgery, days };
})();
