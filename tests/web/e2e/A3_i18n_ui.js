// Senaryo A3 · Dil TR ↔ EN her adımda (çevrilmemiş metin taraması), ayarlar diyaloğu, yardım
'use strict';
const H = require('./lib');
const fs = require('fs'), path = require('path');

(async () => {
  const h = await H.start({ name: 'A3_i18n_ui', dir: 'A' });
  const { page } = h;
  await h.goto();
  // a full plan so every step has content
  await h.openStep(1); await page.click('#fibSample'); await h.idle();
  await h.openStep(3); await page.click('#autoPrep'); await h.idle();
  await h.openStep(4); await page.click('#fibN button[data-n="1"]'); await h.idle();
  await h.openStep(5); await page.evaluate(() => { const d = document.getElementById('secPlate'); if (!d.open) d.querySelector('summary').click(); }); await page.check('#plOn'); await h.idle();

  await h.run('A3.1', 'Ayarlar', 'Ayarlar diyaloğu: aç, ışık ön ayarı "Kontrastlı", şiddet, varsayılana dön, Esc ile kapat', 'Diyalog açılır/kapanır; ışık değişir', async () => {
    await page.click('#tSettings'); await h.sleep(300);
    const open = await page.$eval('#dlgSet', d => d.open);
    const backend = await page.textContent('#stBackend'), conn = await page.textContent('#stConn');
    await page.selectOption('#lightP', 'contrast'); await h.sleep(300);
    const ev = await h.shot('A3.1_ayarlar');
    await h.setRange('#lightK', 1.4); await h.sleep(200);
    const k = await page.textContent('#lightKO');
    await page.click('#lightReset'); await h.sleep(200);
    const k2 = await page.textContent('#lightKO'), p2 = await page.inputValue('#lightP');
    await page.keyboard.press('Escape'); await h.sleep(300);
    const closed = !(await page.$eval('#dlgSet', d => d.open));
    return { pass: open && closed && k2 === '%100', actual: `açık=${open}, kayıt yeri "${backend}", sunucu "${conn}", şiddet ${k} → sıfırla ${k2} (${p2}), Esc ile kapandı=${closed}`, evidence: ev };
  });
  await h.run('A3.2', 'Yardım', 'Yardım düğmesi ve "?" kısayolu', 'Yardım diyaloğu açılır, Esc ile kapanır', async () => {
    await page.click('#tHelp'); await h.sleep(300);
    const o1 = await page.$eval('#dlgHelp', d => d.open);
    const ev = await h.shot('A3.2_yardim');
    const txt = (await page.textContent('#dlgHelp')).replace(/\s+/g, ' ').slice(0, 200);
    await page.keyboard.press('Escape'); await h.sleep(200);
    await page.click('#stage', { position: { x: 20, y: 20 } }).catch(() => {});
    await page.keyboard.press('?'); await h.sleep(300);
    const o2 = await page.$eval('#dlgHelp', d => d.open);
    await page.keyboard.press('Escape');
    return { pass: o1 && o2, actual: `düğme=${o1}, "?"=${o2}; "${txt}"`, evidence: ev };
  });

  const tabs = ['pPrt', 'pVer', 'pMes', 'pChk'];
  const scan = async (lang) => {
    const per = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await h.openStep(n); await h.idle();
      // open every collapsed section inside the step so its text is visible
      await page.evaluate(n => document.querySelectorAll(`#st${n} details:not([open]) > summary`).forEach(s => s.click()), n);
      await h.sleep(400);
      per['st' + n] = await h.untranslated('#st' + n);
      if (lang === 'en' && [3, 4, 7, 8].includes(n)) await h.shot(`A3.en_step${n}`);
    }
    for (const t of tabs) { await page.click('#tab-' + t); await h.sleep(300); per[t] = await h.untranslated('#rightPanel'); }
    per.header = await h.untranslated('header');
    per.stage = await h.untranslated('.stagewrap');
    await page.click('#tSettings'); await h.sleep(200); per.dlgSet = await h.untranslated('#dlgSet'); await page.keyboard.press('Escape');
    await page.click('#tHelp'); await h.sleep(200); per.dlgHelp = await h.untranslated('#dlgHelp'); await page.keyboard.press('Escape');
    return per;
  };
  let en = null;
  await h.run('A3.3', 'Dil', 'Ayarlar → Dil: English; her adım, sağ panel sekmeleri, diyaloglar taranır', 'Görünür Türkçe metin kalmaz', async () => {
    await page.click('#tSettings'); await h.sleep(200);
    await page.click('#langSel + .seg button[data-v="en"]'); await h.sleep(500); await page.keyboard.press('Escape');
    const lang = await page.evaluate(() => document.documentElement.lang);
    en = await scan('en');
    const all = [...new Set(Object.values(en).flat())];
    fs.writeFileSync(path.join(h.outDir, 'A3_untranslated_en.json'), JSON.stringify(en, null, 1));
    const counts = Object.entries(en).map(([k, v]) => `${k}:${v.length}`).join(' ');
    return { pass: all.length === 0, actual: `html lang=${lang}; çevrilmemiş benzersiz ${all.length} (${counts}); örnekler: ${all.slice(0, 12).join(' ‖ ')}`, evidence: 'kanit/A/A3_untranslated_en.json' };
  });
  await h.run('A3.4', 'Dil', 'EN açıkken yeni metin üreten işlemler: Otomatik planla yeniden, fibula 2 segment, onay mesajı, paket mesajı', 'Yeni metinler de İngilizce', async () => {
    await h.openStep(3); await page.click('#planReset'); await h.idle();
    await page.click('#autoPrep'); await h.idle();
    await h.openStep(4); await page.click('#fibN button[data-n="2"]'); await h.idle();
    await h.openStep(7); await page.click('#appr button[data-ap="lesion"]').catch(() => {}); await h.sleep(300);
    const a = await h.untranslated('#st3'), b = await h.untranslated('#st4'), c = await h.untranslated('#st7'), d = await h.untranslated('#pChk');
    await page.click('#tab-pChk'); await h.sleep(300); const e = await h.untranslated('#rightPanel');
    const toast = await page.$eval('#toast', t => t.hidden ? '' : t.textContent).catch(() => '');
    const all = [...new Set([...a, ...b, ...c, ...d, ...e])];
    const ev = await h.shot('A3.4_en_dinamik');
    return { pass: all.length === 0, actual: `çevrilmemiş ${all.length}: ${all.slice(0, 12).join(' ‖ ')}${toast ? ' · toast: ' + toast : ''}`, evidence: ev };
  });
  await h.run('A3.5', 'Dil', 'Dil: Türkçe\'ye dön', 'Tüm metin Türkçe; İngilizce kalıntı yok', async () => {
    await page.click('#tSettings'); await h.sleep(200);
    await page.click('#langSel + .seg button[data-v="tr"]'); await h.sleep(500); await page.keyboard.press('Escape');
    const left = await page.evaluate(() => {
      const EN = /\b(the|and|guide is|screws?|cut|approve|download|settings|bone|segment count|resection|delivery|review)\b/i, out = new Set();
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const t = n.data.trim(); const p = n.parentElement; if (!t || !p || !p.getClientRects().length || /^(SCRIPT|STYLE)$/.test(p.tagName) || p.closest('#caseTitle,#caseList,#verList,#histList,#caseInfo')) continue; if (EN.test(t) && !/[çğıöşüÇĞİÖŞÜ]/.test(t) && !/Guide|STL|PDF|HTML|3MF|DICOM|Yolmed|SEG|JSON/.test(t)) out.add(t.slice(0, 80)); }
      return [...out];
    });
    return { pass: left.length === 0, actual: `İngilizce kalıntı ${left.length}: ${left.slice(0, 10).join(' ‖ ')}`, evidence: await h.shot('A3.5_tr_geri') };
  });
  await h.run('A3.6', 'Dil', 'EN seçiliyken sayfayı yenile', 'Dil tercihi korunur, metin İngilizce', async () => {
    await page.click('#tSettings'); await h.sleep(200); await page.click('#langSel + .seg button[data-v="en"]'); await h.sleep(300); await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(1500);
    const lang = await page.evaluate(() => document.documentElement.lang), s1 = await page.textContent('#st1 summary');
    const u = await h.untranslated('#st1');
    await page.click('#tSettings'); await h.sleep(200); await page.click('#langSel + .seg button[data-v="tr"]'); await h.sleep(300); await page.keyboard.press('Escape');
    return { pass: lang === 'en' && !/Vaka/.test(s1), actual: `lang=${lang}, adım 1 başlığı "${s1.trim()}", adım 1 çevrilmemiş ${u.length}: ${u.slice(0, 6).join(' ‖ ')}` };
  });
  await h.done();
})();
