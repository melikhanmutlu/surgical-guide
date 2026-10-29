// Senaryo S · sade panel (2026-10-25, flow.js + casetype.js grupları)
// S1: çene akışında 6 numaralı adım (2026-10-29: Vaka ve BT ile Kemik modeli ayrı adımlar); Guide'lar adımı Mandibula / Fibula / Vidalar sekmeli, sekme geçişi tek satır gösterir.
// S2: Gelişmiş bölümleri varsayılan kapalı; adımın ana alanında az kontrol var; Gelişmiş başlığında ayar sayısı yazmaz (Melikhan 2026-10-28: açıp görsün).
// S3: Ayarlar'daki "Tüm ayarları açık göster" bütün Gelişmiş bölümlerini açar, kapatınca kapanır.
// S4: Gelişmiş içindeki adlı bir bölüm açılınca (düzeltme düğmesi, bağlantı) Gelişmiş de açılır.
// S5: Rezeksiyonda "Kesitte boya" / "Merkez nokta" seçimi; boyama seçilince kesit şeridi gelir.
// S6: bu panel işlemlerinin hiçbiri planı değiştirmez: plan özeti (SHA-256) aynı kalır.
// S7: malleol vaka tipinde de 6 numaralı adım.
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

  await h.run('S1.1', 'Adımlar', 'Çene vakası, sol panel', '6 numaralı adım: Vaka ve BT, Kemik modeli, Rezeksiyon, Guide\'lar, Doğrulama ve onay, Çıktılar (Melikhan 2026-10-29: Kemik modeli ayrı adım)', async () => {
    const r = await rows();
    const want = ['1 Vaka ve BT', '2 Kemik modeli', '3 Rezeksiyon', "4 Guide'lar", '5 Doğrulama ve onay', '6 Çıktılar'];
    return { pass: JSON.stringify(r) === JSON.stringify(want), actual: JSON.stringify(r), evidence: await h.shot('S1_adimlar') };
  });
  await h.run('S1.2', 'Sekmeler', "Guide'lar adımında Fibula sekmesi", 'Fibula bölümü açılır; listede yine tek "4 Guide\'lar" satırı; sekme basılı', async () => {
    await h.ev(() => UI.openStep('st5')); await h.sleep(300);
    const tabs = await h.ev(() => [...document.querySelectorAll('#st5 .part-tabs button')].map(b => b.textContent));
    await page.click('#st5 .part-tabs button[data-part="st4"]'); await h.sleep(400);
    const r = await rows(), st4 = await h.ev(() => document.getElementById('st4').open), pressed = await h.ev(() => document.querySelector('#st4 .part-tabs button[data-part="st4"]').getAttribute('aria-pressed'));
    const ok = JSON.stringify(tabs) === JSON.stringify(['Mandibula', 'Fibula', 'Vidalar']) && st4 && pressed === 'true' && r.filter(x => x.startsWith('4 ')).length === 1;
    return { pass: ok, actual: JSON.stringify({ tabs, st4, pressed, rows: r }), evidence: await h.shot('S1_fibula_sekmesi') };
  });

  await h.run('S2', 'Gelişmiş', 'Her adımın Gelişmiş bölümü', 'Kapalı gelir; başlıkta ayar sayısı yok; Guide\'lar ana alanında 10\'dan az kontrol', async () => {
    await h.ev(() => UI.openStep('st5')); await h.sleep(300);
    const r = await h.ev(() => {
      const adv = [...document.querySelectorAll('details.adv')].map(d => ({ id: d.id, open: d.open, sum: (d.querySelector(':scope > summary') || {}).textContent }));
      const main = [...document.querySelectorAll('#st5 .body input, #st5 .body select, #st5 .body button')].filter(e => !e.closest('[hidden]') && !e.closest('details[data-adv]') && !e.closest('.part-tabs') && e.offsetParent).length;
      return { adv, main };
    });
    const ok = r.adv.length >= 5 && r.adv.every(a => !a.open) && r.adv.every(a => !/\d/.test(a.sum || '')) && r.main < 10;
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

  // Melikhan 2026-10-29: with "Elle düzeltme" open the fourth tool ("Parça sil") made the left panel wider than itself
  // (the section ran off to the right), and in "Görüntü katmanları" the layer names ran under the HU inputs
  await h.run('S5b', 'Panel genişliği', 'Kemik modeli: bütün bölümler açık (Elle düzeltme, Görüntü katmanları)', 'Sol panel yatay taşmaz; katman adı ile HU kutuları üst üste binmez', async () => {
    await h.ev(() => UI.openStep('st2')); await h.sleep(300);
    await page.evaluate(() => document.querySelectorAll('#st2 details').forEach(d => { d.open = true; })); await h.sleep(600);
    const r = await h.ev(() => { const p = document.getElementById('leftPanel'), pb = p.getBoundingClientRect(), out = [], bad = [];
      document.querySelectorAll('#st2 *').forEach(e => { const b = e.getBoundingClientRect(); if (b.width && b.right > pb.right + 1) out.push(e.id || e.className || e.tagName); });
      document.querySelectorAll('#layerBox .lay').forEach(li => { const l = li.querySelector('label'), hu = li.querySelector('.hu'); if (!l || !hu) return; const a = l.getBoundingClientRect(), b = hu.getBoundingClientRect();
        if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) || l.scrollWidth > l.clientWidth + 1) bad.push(l.textContent.trim()); });
      return { sw: p.scrollWidth, cw: p.clientWidth, out: out.slice(0, 8), bad }; });
    await page.evaluate(() => document.querySelectorAll('#st2 details').forEach(d => { d.open = false; }));
    return { pass: r.sw <= r.cw && !r.out.length && !r.bad.length, actual: JSON.stringify(r), evidence: await h.shot('S5b_panel') };
  });

  await h.run('S6', 'Plan özeti', 'Yukarıdaki panel işlemlerinden sonra', 'Plan özeti (SHA-256) değişmedi', async () => {
    const hash1 = await h.ev(() => Audit.planHash());
    return { pass: hash1 === hash0, actual: `${hash0} → ${hash1}` };
  });

  await h.run('S7', 'Malleol', 'Vaka tipi Malleol kırığı', '6 numaralı adım: Vaka ve BT, Anatomi ve parçalar, Redüksiyon, Vidalar ve guide, Doğrulama ve onay, Çıktılar', async () => {
    await h.ev(() => CaseType.set('ankle')); await h.sleep(500);
    const r = await rows();
    const want = ['1 Vaka ve BT', '2 Anatomi ve parçalar', '3 Redüksiyon', '4 Vidalar ve guide', '5 Doğrulama ve onay', '6 Çıktılar'];
    const ev = await h.shot('S7_malleol');
    await h.ev(() => CaseType.set('mandible')); await h.sleep(300);
    return { pass: JSON.stringify(r) === JSON.stringify(want), actual: JSON.stringify(r), evidence: ev };
  });
  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
