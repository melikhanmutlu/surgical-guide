// Senaryo S · sade panel (2026-10-25, flow.js + casetype.js grupları)
// S1: çene akışında 5 numaralı adım; Guide'lar adımı Mandibula / Fibula / Vidalar sekmeli, sekme geçişi tek satır gösterir.
// S2: Gelişmiş bölümleri varsayılan kapalı; adımın ana alanında az kontrol var; Gelişmiş'te ayar sayısı yazar.
// S3: Ayarlar'daki "Tüm ayarları açık göster" bütün Gelişmiş bölümlerini açar, kapatınca kapanır.
// S4: Gelişmiş içindeki adlı bir bölüm açılınca (düzeltme düğmesi, bağlantı) Gelişmiş de açılır.
// S5: Rezeksiyonda "Kesitte boya" / "Merkez nokta" seçimi; boyama seçilince kesit şeridi gelir.
// S6: bu panel işlemlerinin hiçbiri planı değiştirmez: plan özeti (SHA-256) aynı kalır.
// S7: malleol vaka tipinde de 5 numaralı adım.
'use strict';
const H = require('./lib');

(async () => {
  const h = await H.start({ name: 'S_simple_panel', dir: 'S', simple: true });
  const { page } = h;
  await h.goto(); await h.idle();
  await h.openStep(3); await page.click('#rxMode button[data-m="point"]'); await page.click('#autoPrep'); await h.idle(); await h.idle();
  const hash0 = await h.ev(() => Audit.planHash());
  const rows = () => h.ev(() => [...document.querySelectorAll('details.step[name="flow"]')].filter(d => !d.hidden && getComputedStyle(d).display !== 'none')
    .map(d => d.querySelector('summary .n').textContent + ' ' + [...d.querySelector('summary').childNodes].filter(n => n.nodeType === 3).map(n => n.data).join('').trim()));

  await h.run('S1.1', 'Adımlar', 'Çene vakası, sol panel', '5 numaralı adım: Görüntüler, Rezeksiyon, Guide\'lar, Doğrulama ve onay, Çıktılar', async () => {
    const r = await rows();
    const want = ['1 Görüntüler', '2 Rezeksiyon', "3 Guide'lar", '4 Doğrulama ve onay', '5 Çıktılar'];
    return { pass: JSON.stringify(r) === JSON.stringify(want), actual: JSON.stringify(r), evidence: await h.shot('S1_adimlar') };
  });
  await h.run('S1.2', 'Sekmeler', "Guide'lar adımında Fibula sekmesi", 'Fibula bölümü açılır; listede yine tek "3 Guide\'lar" satırı; sekme basılı', async () => {
    await h.ev(() => UI.openStep('st5')); await h.sleep(300);
    const tabs = await h.ev(() => [...document.querySelectorAll('#st5 .part-tabs button')].map(b => b.textContent));
    await page.click('#st5 .part-tabs button[data-part="st4"]'); await h.sleep(400);
    const r = await rows(), st4 = await h.ev(() => document.getElementById('st4').open), pressed = await h.ev(() => document.querySelector('#st4 .part-tabs button[data-part="st4"]').getAttribute('aria-pressed'));
    const ok = JSON.stringify(tabs) === JSON.stringify(['Mandibula', 'Fibula', 'Vidalar']) && st4 && pressed === 'true' && r.filter(x => x.startsWith('3 ')).length === 1;
    return { pass: ok, actual: JSON.stringify({ tabs, st4, pressed, rows: r }), evidence: await h.shot('S1_fibula_sekmesi') };
  });

  await h.run('S2', 'Gelişmiş', 'Her adımın Gelişmiş bölümü', 'Kapalı gelir; ayar sayısı yazar; Guide\'lar ana alanında 10\'dan az kontrol', async () => {
    await h.ev(() => UI.openStep('st5')); await h.sleep(300);
    const r = await h.ev(() => {
      const adv = [...document.querySelectorAll('details.adv')].map(d => ({ id: d.id, open: d.open, aux: (d.querySelector('summary .aux') || {}).textContent }));
      const main = [...document.querySelectorAll('#st5 .body input, #st5 .body select, #st5 .body button')].filter(e => !e.closest('[hidden]') && !e.closest('details[data-adv]') && !e.closest('.part-tabs') && e.offsetParent).length;
      return { adv, main };
    });
    const ok = r.adv.length >= 5 && r.adv.every(a => !a.open) && r.adv.filter(a => /\d+ ayar/.test(a.aux || '')).length >= 4 && r.main < 10;
    return { pass: ok, actual: JSON.stringify(r), evidence: await h.shot('S2_gelismis_kapali') };
  });

  await h.run('S3', 'Uzman görünümü', 'Ayarlar → Tüm ayarları açık göster, sonra kapat', 'Açınca bütün Gelişmiş bölümleri açık, kapatınca kapalı', async () => {
    const set = on => h.ev(on => { const c = document.getElementById('advAll'); c.checked = on; c.dispatchEvent(new Event('change', { bubbles: true })); }, on);
    await set(true); await h.sleep(200);
    const a = await h.ev(() => [...document.querySelectorAll('details[data-adv]')].every(d => d.open));
    await set(false); await h.sleep(200);
    const b = await h.ev(() => [...document.querySelectorAll('details[data-adv]')].every(d => !d.open));
    return { pass: a && b, actual: JSON.stringify({ hepsiAcik: a, hepsiKapali: b }) };
  });

  await h.run('S4', 'Açığa çıkarma', 'Kemik modeli sekmesinde "Bitişik kemikleri ayır" bölümü açılır (düzeltme düğmesi gibi)', 'Üstündeki Gelişmiş bölümü de açılır', async () => {
    await h.ev(() => UI.openStep('st2')); await h.sleep(300);
    await h.ev(() => { document.getElementById('secMask').open = true; }); await h.sleep(300);
    const r = await h.ev(() => ({ adv: document.getElementById('adv_st2').open, vis: !!document.getElementById('maskBox').offsetParent }));
    await h.ev(() => { document.getElementById('secMask').open = false; document.getElementById('adv_st2').open = false; });
    return { pass: r.adv && r.vis, actual: JSON.stringify(r), evidence: await h.shot('S4_acilan') };
  });

  await h.run('S5', 'Rezeksiyon yolu', '"Kesitte boya" seç', 'Fırça araçları görünür, "Otomatik planla" gizli; görünüm 3B + şerit olur', async () => {
    await h.ev(() => UI.openStep('st3')); await h.sleep(300);
    await page.click('#vm3d'); await h.sleep(300);
    await page.click('#rxMode button[data-m="paint"]'); await h.sleep(500);
    const r = await h.ev(() => ({ brush: !!document.querySelector('#lsTools').offsetParent, auto: !!document.getElementById('autoPrep').offsetParent, mode: document.getElementById('views').dataset.mode, margin: !!document.querySelector('#rxMargin #l_margin') }));
    await page.click('#rxMode button[data-m="point"]'); await h.sleep(300);
    const r2 = await h.ev(() => ({ brush: !!document.querySelector('#lsTools').offsetParent, auto: !!document.getElementById('autoPrep').offsetParent }));
    await page.click('#vm3d'); await h.sleep(300);
    const ok = r.brush && !r.auto && r.mode !== '3d' && r.margin && !r2.brush && r2.auto;
    return { pass: ok, actual: JSON.stringify({ boya: r, nokta: r2 }), evidence: await h.shot('S5_rezeksiyon') };
  });

  await h.run('S6', 'Plan özeti', 'Yukarıdaki panel işlemlerinden sonra', 'Plan özeti (SHA-256) değişmedi', async () => {
    const hash1 = await h.ev(() => Audit.planHash());
    return { pass: hash1 === hash0, actual: `${hash0} → ${hash1}` };
  });

  await h.run('S7', 'Malleol', 'Vaka tipi Malleol kırığı', '5 numaralı adım: Görüntüler, Redüksiyon, Vidalar ve guide, Doğrulama ve onay, Çıktılar', async () => {
    await h.ev(() => CaseType.set('ankle')); await h.sleep(500);
    const r = await rows();
    const want = ['1 Görüntüler', '2 Redüksiyon', '3 Vidalar ve guide', '4 Doğrulama ve onay', '5 Çıktılar'];
    const ev = await h.shot('S7_malleol');
    await h.ev(() => CaseType.set('mandible')); await h.sleep(300);
    return { pass: JSON.stringify(r) === JSON.stringify(want), actual: JSON.stringify(r), evidence: ev };
  });
  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
