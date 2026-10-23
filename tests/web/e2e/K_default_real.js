// Senaryo K · Varsayılan gerçek BT akışı (Denetim 6): açılış varsayılanı (adres parametresiz) = anonim gerçek BT mandibula örneği, kutudan çıktığı gibi akış:
// K1 açılış: gerçek BT örneği, kritik var mı (kemik modeli kapısı dahil); K2 Otomatik planla; K3 gerçek BT fibula örneği + fibula guide;
// K4 onaylar + paket kilidi; K5 üretim STL'i (ilerleme çubuğu olayları); K6 paket içeriği: guide_uretim.stl, 3MF üretimden mi; K7 tek STL indir = üretim.
'use strict';
const fs = require('fs'), path = require('path');
const H = require('./lib');
(async () => {
  const h = await H.start({ name: 'K_default_real', dir: 'K' });
  const { page } = h;
  await h.goto(H.BASE + '/'); await h.idle();
  const st = () => h.ev(() => { const S = Studio.S; return { src: S.source && S.source.name, planes: S.planes.length, screws: S.screws.length, crit: S.crit, critList: (S.checkList || []).filter(c => c[0] === 'crit').map(c => c[2]), pieces: Studio.parts.guide ? (S.result && S.result.pieces) : 0, pill: document.getElementById('readyPill').textContent, zip: !document.getElementById('expZip').disabled }; });
  await h.run('K1', 'Açılış', 'Adres parametresiz açılır', 'Kaynak mandible_ct; DICOM etiketi/hasta adı yok; kritik kontrol yok', async () => {
    const s = await st(); const info = await page.textContent('#caseInfo');
    const qc = await h.ev(() => (Studio.S.qc || []).map(q => q[0] + ':' + q[2]));
    return { pass: s.src === 'mandible_ct' && !/hasta|patient/i.test(info), actual: JSON.stringify({ src: s.src, info: info.replace(/\s+/g, ' ').slice(0, 160), qc, crit: s.critList }), evidence: await h.shot('K1_acilis') };
  });
  await h.run('K2', 'Otomatik planla', '#autoPrep', '2 kesi, tek parça guide, vidalar, kritik yok', async () => {
    await h.openStep(3); const t = Date.now(); await page.click('#autoPrep'); await h.idle(300000);
    const s = await st(); return { pass: s.planes === 2 && s.pieces === 1 && s.screws >= 3 && !s.critList.some(c => !/Fibula/.test(c)), actual: `${Date.now() - t} ms ${JSON.stringify(s)}`, evidence: await h.shot('K2_otoplan') };
  });
  await h.run('K3', 'Fibula', 'Gerçek BT fibula örneği (#fibSampleCt), otomatik fibula guide', 'Fibula planı ve guide hazır, kritik yok', async () => {
    await h.openStep(1); const t = Date.now(); await page.click('#fibSampleCt');  // the fibula sample buttons live in step 1 (Vaka ve görüntüler)
    await h.fibLoaded(300000);                                                    // loaded and parsed; the plan follows on its own (there is a resection)
    await page.waitForFunction(() => window.Fibula && Fibula.plan() && Fibula.choice() && Studio.S.fib && Studio.S.fib.guide, null, { timeout: 300000 });
    await h.idle(300000);
    const s = await st(); const fb = await h.ev(() => { const c = Fibula.choice(); return { guide: !!(Studio.S.fib && Studio.S.fib.guide), n: c && c.n, dev: c && +c.dev.toFixed(2), L: c && +c.L.toFixed(1) }; });
    return { pass: fb.guide && !s.crit, actual: `${Date.now() - t} ms ${JSON.stringify(fb)} kritik ${JSON.stringify(s.critList)}`, evidence: await h.shot('K3_fibula') };
  });
  await h.run('K4', 'Onay', 'Cerrah adı, tüm öğeler, mühendis, cerrah', 'Paket etkin, Onaylı plan', async () => {
    await h.openStep(7); await page.fill('#surgeon', 'Dr. Denetim'); await page.press('#surgeon', 'Tab');
    const all = page.locator('#appr button', { hasText: 'Tüm öğeleri onayla' }); if (await all.count()) { await all.first().click(); await h.sleep(300); await h.idle(60000); }
    for (let k = 0; k < 30; k++) { const b = page.locator('#appr button[data-ap]', { hasText: 'Onayla' }).first(); if (!(await b.count())) break; await b.click(); await h.sleep(250); await h.idle(30000, 300); }
    await page.fill('#au_eng_n', 'Müh. Denetim'); await page.click('#auditBox button[data-a="onay"][data-r="eng"]'); await h.sleep(300);
    const sur = page.locator('#auditBox button[data-a="onay"][data-r="sur"]'); if (await sur.count()) await sur.click(); await h.sleep(500); await h.idle();
    const s = await st(); return { pass: s.zip && /Onaylı/.test(s.pill), actual: JSON.stringify({ pill: s.pill, zip: s.zip, crit: s.critList, msg: await page.textContent('#apprMsg') }), evidence: await h.shot('K4_onay') };
  });
  await h.run('K5', 'Üretim', '#expSrv: sunucuda üretim STL\'i; ilerleme çubuğu', 'Su geçirmez, 1 parça; çubuk yüzde gösterir ve geri gitmez', async () => {
    await h.openStep(8);
    await page.evaluate(() => { window.__bar = []; const el = document.getElementById('busyBar'); new MutationObserver(() => { const v = el.getAttribute('aria-valuenow'); if (v != null) window.__bar.push(+v); }).observe(el, { attributes: true }); });
    const t = Date.now(); await page.click('#expSrv'); await h.sleep(500); await h.idle(600000);
    const m = await page.textContent('#prodMsg'), bar = await h.ev(() => window.__bar);
    const mono = bar.every((v, i) => !i || v >= bar[i - 1]);
    return { pass: /su geçirmez/.test(m) && !/DEĞİL/.test(m) && bar.length > 3 && mono, actual: `${Date.now() - t} ms; çubuk ${bar.length} güncelleme, tekdüze=${mono}, son=${bar.at(-1)}; "${m.replace(/\s+/g, ' ').slice(0, 300)}"`, evidence: await h.shot('K5_uretim') };
  });
  const dl = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click(sel)]); const p = path.join(h.outDir, d.suggestedFilename()); await d.saveAs(p); return p; };
  await h.run('K6', 'Paket', 'Paket zip içeriği; guideler.3mf üretim STL\'inden mi', 'guide_uretim.stl, fibula_guide_uretim.stl, 3MF üçgen sayısı üretimle aynı', async () => {
    const zp = await dl('#expZip'); const list = H.zipList(zp);
    const rd = (z, n) => { try { return H.zipRead(z, n); } catch (e) { return null; } };
    const tri = n => { const b = rd(zp, n); return b ? b.readUInt32LE(80) : -1; };
    const mf = rd(zp, 'guideler.3mf'); let tris3 = -1; if (mf) { const tmp = path.join(h.outDir, 'g.3mf'); fs.writeFileSync(tmp, mf); const model = rd(tmp, '3D/3dmodel.model'); tris3 = model ? (model.toString().match(/<triangle /g) || []).length : -1; }
    const tp = tri('guide_uretim.stl'), tf = tri('fibula_guide_uretim.stl');
    return { pass: list.includes('guide_uretim.stl') && list.includes('fibula_guide_uretim.stl') && tris3 === tp + tf, actual: `${list.length} dosya; guide_uretim ${tp} üçgen, fibula ${tf}, 3MF ${tris3}; ${list.join(', ')}`, evidence: path.relative(H.E2E, zp) };
  });
  await h.run('K7', 'Tek STL', 'Ayrı STL\'ler → guide', 'guide_uretim.stl adıyla, üretim üçgen sayısıyla', async () => {
    const p = await dl('#oneStl button[data-one="guide"]'); const n = fs.readFileSync(p).readUInt32LE(80);
    return { pass: /guide_uretim/.test(path.basename(p)), actual: `${path.basename(p)} ${n} üçgen; ${await page.textContent('#oneMsg')}` };
  });
  await h.done();
})().catch(e => { console.error('FAIL K', e); process.exit(1); });
