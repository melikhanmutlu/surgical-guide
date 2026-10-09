/* CT date check: the acquisition (or series, or study) date read from the DICOM header and the planned surgery date.
   A plan made on a CT older than three weeks at surgery may no longer match the bone (tumour growth, remodelling),
   so the step warns. Only dates are kept; no patient name or ID. */
'use strict';
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
  const tr = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString('tr-TR') : '–');
  const today = () => new Date().toISOString().slice(0, 10);

  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [], ct = ctDate(), fd = fibDate();
    if (!S.vol) return out;
    const one = (d, what) => {
      if (!d) return;
      if (surgery) {
        const n = days(d, surgery);
        if (n < 0) out.push(['warn', 'Uyarı', `${what} ameliyat tarihinden sonra (${tr(d)}); tarihleri kontrol edin.`, 'data']);
        else if (n > MAX_DAYS) out.push(['warn', 'Uyarı', `${what} ameliyattan ${n} gün önce çekilmiş (${tr(d)}); ${MAX_DAYS} günden eski. Lezyon büyümüş ya da kemik değişmiş olabilir; güncel BT önerilir.`, 'data']);
      } else if (days(d, today()) > MAX_DAYS) out.push(['info', 'Bilgi', `${what} ${days(d, today())} gün önce çekilmiş; BT yaşı kontrolü için ameliyat tarihini girin.`, 'data']);
    };
    one(ct, 'Mandibula BT\'si'); one(fd, 'Fibula BT\'si');
    if (!ct && S.source && S.source.type === 'dicom') out.push(['info', 'Bilgi', 'BT tarihi DICOM başlığında yok (anonimleştirilmiş olabilir); BT yaşı denetlenemedi.', 'data']);
    if (surgery && days(today(), surgery) < 0) out.push(['info', 'Bilgi', `Planlanan ameliyat tarihi geçmişte (${tr(surgery)}).`, 'data']);
    return out;
  });
  function render() {
    const el = $('dateInfo'); if (!el) return;
    const ct = ctDate(), fd = fibDate();
    el.innerHTML = `<dt>BT tarihi</dt><dd>${ct ? tr(ct) : S.source && S.source.type === 'dicom' ? 'başlıkta yok' : 'örnek vaka'}</dd>${fd ? `<dt>Fibula BT tarihi</dt><dd>${tr(fd)}</dd>` : ''}${ct && surgery ? `<dt>Ameliyatta BT yaşı</dt><dd>${days(ct, surgery)} gün</dd>` : ''}`;
    if (document.activeElement !== $('surgDate')) $('surgDate').value = surgery;
  }
  $('surgDate').addEventListener('change', e => { surgery = e.target.value || ''; render(); St.renderChecks(); St.emit('changed'); });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const ct = ctDate(); if (!ct && !surgery) return;
    if (d.keep) d.keep(220); d.h2('Tarihler');
    d.table(['Tarih', 'Değer'], [['BT çekim tarihi', tr(ct)], ['Fibula BT tarihi', tr(fibDate())], ['Planlanan ameliyat', tr(surgery)], ['Ameliyatta BT yaşı', ct && surgery ? `${days(ct, surgery)} gün (sınır ${MAX_DAYS} gün)` : '–']], [0.5, 0.5]);
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
