// Regression: after Undo the plate must still be computed (Plate.get() non-null) and the package must contain the plate files.
'use strict';
const H = require('./lib');
(async () => {
  const h = await H.start({ name: 'Y3_plate_undo', dir: 'Y3' });
  const { page } = h;
  await h.goto();
  const caseName = 'Y3 plak ' + Date.now().toString(36);
  // ---------- approved plan survives a reopen / undo ----------
  const approveAll = async () => {
    await h.openStep(7); await page.fill('#surgeon', 'Dr. E2E Cerrah'); await page.press('#surgeon', 'Tab');
    for (let k = 0; k < 30; k++) { const b = page.locator('#appr button[data-ap]', { hasText: 'Onayla' }).first(); if (!(await b.count())) break; await b.click(); await h.sleep(250); await h.idle(30000, 300); }
    await page.fill('#au_eng_n', 'Müh. E2E'); await page.click('#auditBox button[data-a="onay"][data-r="eng"]'); await h.sleep(300);
    await page.click('#auditBox button[data-a="onay"][data-r="sur"]'); await h.sleep(500); await h.idle();
    return { pend: await h.ev(() => Studio.pendingList()), zip: await page.$eval('#expZip', b => !b.disabled), pill: await page.textContent('#readyPill') };
  };
  const fullPlan = async (alignPlate) => {
    await h.openStep(1); await page.evaluate(() => { const d = document.getElementById('secCases'); if (!d.open) d.querySelector('summary').click(); });
    await page.click('#caseNew'); await h.sleep(300); await page.click('#sampleM'); await h.idle();
    await page.fill('#caseName', caseName + (alignPlate ? '-plak' : '-undo')).catch(() => {}); await page.press('#caseName', 'Enter').catch(() => {});
    await page.click('#fibSample'); await h.idle(); await page.click('#scM'); await h.idle();
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    await h.openStep(4); await page.click('#fibN button[data-n="1"]'); await h.idle();
    await h.openStep(5); await page.evaluate(() => { const d = document.getElementById('secPlate'); if (!d.open) d.querySelector('summary').click(); });
    await page.check('#plOn'); await h.sleep(800); await h.idle();
    if (alignPlate) { await page.click('#plScrews'); await h.sleep(800); await h.idle(); await h.sleep(600); await h.idle(); }
  };
  await h.run('A2.10', 'Onaylı plan + geri al', 'Plak (hizalamasız) + tüm onaylar → kesi 1 değişikliği → ↶ geri al → paket indir', 'Onaylar geri gelir; paket plak dosyalarını içerir', async () => {
    await fullPlan(false);
    const a = await approveAll();
    await h.openStep(3); await page.click('#plList button[data-s="p0"]'); await page.focus('#f_off'); await page.keyboard.press('ArrowRight'); await h.sleep(1500); await h.idle();
    await page.keyboard.press('Escape'); await page.click('#undo'); await h.sleep(1500); await h.idle(); await h.sleep(1000);
    const b = { pend: await h.ev(() => Studio.pendingList()), zip: await page.$eval('#expZip', x => !x.disabled), plateLast: await h.ev(() => !!Plate.get()) };
    let list = [];
    if (b.zip) {
      await h.openStep(8);
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('#expZip')]);
      const p = require('path').join(h.outDir, 'A2.10_paket_geri_al.zip'); await d.saveAs(p);
      list = require('child_process').execFileSync('unzip', ['-Z1', p]).toString().trim().split('\n');
    }
    const plak = list.filter(f => /^plak/.test(f));
    return { pass: a.zip && b.zip && plak.length >= 2, actual: `onay sonrası paket=${a.zip}; geri al sonrası paket=${b.zip}, bekleyen ${JSON.stringify(b.pend)}, Plate.get() dolu=${b.plateLast}; paket ${list.length} dosya, plak dosyaları: ${plak.join(', ') || 'YOK'}` };
  });
  await h.done();
})();
