// Senaryo A2 · Kaydet → sayfayı yenile → vakayı yeniden aç; sürüm; geçmiş; geri al / ileri al; yeni vaka eski durumu temizler
'use strict';
const H = require('./lib');

// the design part of a plan (what must survive a save / reopen)
const core = () => {
  const p = Studio.planOf(), r = x => typeof x === 'number' ? Math.round(x * 100) / 100 : x;
  const S = Studio.S;
  return {
    planes: (p.planes || []).map(q => [r(q.off), r(q.yaw), r(q.pitch), r(q.w)]), screws: (p.screws || []).map(q => q && [r(q.u), r(q.v), r(q.tiltU), r(q.tiltV), r(q.len)]),
    g: Object.fromEntries(Object.entries(p.g || {}).map(([k, v]) => [k, r(v)])), guideOn: p.guideOn, resRemoved: p.resRemoved, lesion: p.lesion && { from: p.lesion.from, to: p.lesion.to, margin: p.lesion.margin, condyle: p.lesion.condyle || null },
    fibN: p.fibula && p.fibula.n, fibSegs: Fibula.state().last && Fibula.state().last.segs ? Fibula.state().last.segs.map(s => r(s.L)) : null,
    pieces: S.result && S.result.pieces, crit: S.crit, resVol: S.resectedVolume ? Math.round(S.resectedVolume) : null, thr: document.getElementById('thr').value,
    plate: !!(p.ext && p.ext.plate && p.ext.plate.on), impl: p.ext && p.ext.impl ? (Array.isArray(p.ext.impl) ? p.ext.impl.length : (p.ext.impl.list || []).length) : 0,
  };
};
const diff = (a, b) => Object.keys(Object.assign({}, a, b)).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(k => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);

(async () => {
  const h = await H.start({ name: 'A2_persist', dir: 'A' });
  const { page } = h;
  const st = () => h.state();
  const seg = async (selId, v) => page.click(`#${selId} + .seg button[data-v="${v}"]`);
  await h.goto();
  const caseName = 'E2E kalıcılık ' + Date.now().toString(36);

  let ref = null;
  await h.run('A2.1', 'Kaydet', 'Yeni vaka adı, örnek fibula, Otomatik planla, 1 segment, plak, implant; "Yeni vaka" sonra otomatik kayıt + sürüm S1', 'Kaydedildi, sürüm listesinde S1', async () => {
    await h.openStep(1);
    await page.evaluate(() => { const d = document.getElementById('secCases'); if (!d.open) d.querySelector('summary').click(); });
    await page.click('#caseNew'); await h.sleep(300);
    await page.fill('#caseName', caseName); await page.press('#caseName', 'Enter');
    await page.click('#fibSample'); await h.idle();
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    await h.openStep(4); await page.click('#fibN button[data-n="1"]'); await h.idle();
    await h.openStep(5); await page.evaluate(() => { const d = document.getElementById('secPlate'); if (!d.open) d.querySelector('summary').click(); }); await page.check('#plOn'); await h.idle();
    await h.openStep(4); await page.evaluate(() => { const d = document.getElementById('secImpl'); if (!d.open) d.querySelector('summary').click(); }); if (await page.isVisible('#imAuto')) { await page.click('#imAuto'); await h.idle(); }
    await h.sleep(3000);
    await page.click('#tab-pVer'); await h.sleep(300);
    await page.fill('#verNote', 'e2e S1'); await page.click('#verSave'); await h.sleep(1500);
    const save = await page.textContent('#saveState'), vers = await page.$$eval('#verList li', l => l.map(x => x.textContent.trim().slice(0, 60)));
    ref = await h.ev(core);
    h.saveJSON('A2_ref_plan.json', await h.ev(() => Studio.planOf()));
    return { pass: /Kaydedildi/.test(save) && vers.some(v => /S1/.test(v)), actual: `durum "${save}", sürümler ${JSON.stringify(vers)}; plan ${JSON.stringify(ref)}`, evidence: await h.shot('A2.1_kaydet') };
  });
  await h.run('A2.2', 'Yeniden aç', 'Sayfayı yenile (F5); son vaka kendiliğinden açılır', 'Plan aynen geri gelir (kesiler, vidalar, guide, fibula, plak, implant, rezeke hacim)', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(2500); await h.idle(); await h.sleep(1500); await h.idle();
    const now = await h.ev(core), d = diff(ref, now), title = await page.textContent('#caseTitle');
    return { pass: !d.length, actual: `başlık "${title}"; fark: ${d.join('; ') || 'yok'}`, evidence: await h.shot('A2.2_yeniden_ac') };
  });
  await h.run('A2.3', 'Vaka listesi', '"Yeni vaka" → örnek mandibula (temiz) → "Kayıtlı vakalar"dan vakayı "Aç"', 'Vaka planı geri gelir', async () => {
    await h.openStep(1);
    await page.evaluate(() => { const d = document.getElementById('secCases'); if (!d.open) d.querySelector('summary').click(); });
    await page.click('#caseNew'); await h.sleep(300);
    await page.click('#sampleM'); await h.idle();
    const cleared = await st();
    await page.click('#caseRefresh'); await h.sleep(800);
    const row = page.locator('#caseList li', { hasText: caseName }).first();
    if (!(await row.count())) return { pass: false, actual: 'vaka listede yok' };
    await row.locator('button', { hasText: 'Aç' }).click(); await h.sleep(1500); await h.idle(); await h.sleep(1000); await h.idle();
    const now = await h.ev(core), d = diff(ref, now);
    return { pass: !d.length && cleared.planes.length === 0, actual: `yeni vaka+örnek sonrası kesi ${cleared.planes.length}, fibula ${cleared.fib}; açınca fark: ${d.join('; ') || 'yok'}`, evidence: await h.shot('A2.3_listeden_ac') };
  });
  await h.run('A2.4', 'Geri al / ileri al', 'Üç değişiklik (guide L, kesi 1 off, vida sil), sonra üst çubuk ↶ ×3 ve ↷ ×3', 'Her adım geri / ileri gelir, son durum değişiklik sonrası ile aynı', async () => {
    const s0 = await h.ev(core);
    await h.openStep(5); await page.focus('#g_L'); for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); await page.dispatchEvent('#g_L', 'change'); await h.sleep(900); await h.idle();
    await h.openStep(3); await page.click('#plList button[data-s="p0"]'); await page.focus('#f_off'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await h.sleep(900); await h.idle();
    await h.openStep(6); await page.click('#scList button[data-s="s0"]'); await h.sleep(200); await page.click('#delEl'); await h.sleep(600); await h.idle();
    const s3 = await h.ev(core);
    const labels = await h.ev(() => CaseStore.history.list.slice(-4).map(e => e.label));
    for (let i = 0; i < 3; i++) { await page.click('#undo'); await h.sleep(900); await h.idle(); }
    const u = await h.ev(core);
    for (let i = 0; i < 3; i++) { await page.click('#redo'); await h.sleep(900); await h.idle(); }
    const r = await h.ev(core);
    const du = diff(s0, u), dr = diff(s3, r);
    return { pass: !du.filter(x => !/^crit|^pieces/.test(x)).length && !dr.filter(x => !/^crit|^pieces/.test(x)).length, actual: `geçmiş: ${labels.join(' / ')}; 3×geri fark: ${du.join('; ') || 'yok'}; 3×ileri fark: ${dr.join('; ') || 'yok'}` };
  });
  await h.run('A2.5', 'Geçmiş paneli', 'Geçmiş sekmesinde ilk girdiye tıkla, sonra son girdiye', 'Plan ilgili duruma döner', async () => {
    await page.click('#tab-pVer'); await h.sleep(300);
    const items = page.locator('#histList li button, #histList li');
    const n = await items.count();
    await items.first().click(); await h.sleep(1200); await h.idle();
    const a = await st();
    await items.last().click(); await h.sleep(1200); await h.idle();
    const b = await st();
    return { pass: n > 2 && JSON.stringify(a.planes) !== JSON.stringify(b.planes), actual: `${n} girdi; ilk girdide kesi ${a.planes.length}, son girdide kesi ${b.planes.length}`, evidence: await h.shot('A2.5_gecmis') };
  });
  await h.run('A2.6', 'Sürüm', 'Planı değiştir, sonra sürüm S1\'i yükle', 'S1 planı geri gelir', async () => {
    await h.openStep(5); await h.setRange('#g_W', 26); await h.sleep(600); await h.idle();
    await page.click('#tab-pVer'); await h.sleep(300);
    const b = page.locator('#verList li', { hasText: 'S1' }).locator('button').first();
    if (!(await b.count())) return { pass: false, actual: 'S1 yükle düğmesi yok' };
    await b.click(); await h.sleep(1500); await h.idle(); await h.sleep(800); await h.idle();
    const now = await h.ev(core), d = diff(ref, now), msg = await page.textContent('#verMsg');
    return { pass: !d.length, actual: `"${msg}"; S1 ile fark: ${d.join('; ') || 'yok'}` };
  });
  await h.run('A2.7', 'Yeni vaka', 'Kondil dahil (sağ) + iki parça guide kur, sonra "Yeni vaka" + mandibula "Örnek veri"', 'Rezeksiyon tipi segment, tek parça guide, fibula/plak/implant sıfır', async () => {
    await h.openStep(3); await page.selectOption('#resType', 'R'); await h.sleep(500); await h.idle();
    await h.openStep(5); await seg('g_split', '1'); await h.sleep(500); await h.idle();
    const before = await st();
    await h.openStep(1);
    await page.evaluate(() => { const d = document.getElementById('secCases'); if (!d.open) d.querySelector('summary').click(); });
    await page.click('#caseNew'); await h.sleep(300);
    await page.click('#sampleM'); await h.idle(); await h.sleep(1200); await h.idle();
    const s = await st(), c = await h.ev(core);
    const ui = await h.ev(() => ({ resType: document.getElementById('resType').value, split: document.getElementById('g_split').value, fib: !!(Fibula.active && Fibula.active()), plate: document.getElementById('plOn') ? document.getElementById('plOn').checked : null, title: document.getElementById('caseTitle').textContent, caseName: document.getElementById('caseName').value }));
    const ok = !s.condyle && s.split === 0 && !ui.fib && !c.plate && !c.impl && s.planes.length === 0;
    return { pass: ok, actual: `önce kondil=${before.condyle} split=${before.split}; sonra kondil=${s.condyle} split=${s.split} resType="${ui.resType}" g_split="${ui.split}", fibula aktif=${ui.fib}, plak=${c.plate}, implant=${c.impl}, kesi=${s.planes.length}, başlık "${ui.title}", vaka adı "${ui.caseName}"`, evidence: await h.shot('A2.7_yeni_vaka') };
  });
  await h.run('A2.8', 'Yeni vaka', 'Yeni vakada ilk değişiklik eski vakanın üzerine yazmamalı: Otomatik planla → vaka listesi', 'Listede yeni bir vaka; eski vaka ("' + caseName + '") planı değişmemiş', async () => {
    await h.openStep(3); await page.click('#autoPrep'); await h.idle(); await h.sleep(3000);
    const list = await h.ev(async () => (await (await fetch('/cases')).json()));
    const old = list.find(c => c.name === caseName);
    let oldPlan = null; if (old) { const c = await h.ev(async id => (await (await fetch('/cases/' + id)).json()), old.id); oldPlan = c.draft; }
    const oldHasFib = !!(oldPlan && oldPlan.fibula);
    return { pass: !!old && oldHasFib, actual: `sunucuda ${list.length} vaka; eski vaka bulundu=${!!old}, eski vakanın taslağında fibula hâlâ var=${oldHasFib}; son 3: ${list.slice(0, 3).map(c => c.name).join(' | ')}` };
  });
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
  await h.run('A2.9', 'Onaylı plan + yeniden aç', 'Plak + "Vidaları plağa hizala" + tüm onaylar (mühendis + cerrah) → sayfayı yenile', 'Plan aynı, onaylar geçerli kalır, paket indirilebilir', async () => {
    await fullPlan(true);
    const a = await approveAll();
    await h.sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(3000); await h.idle(); await h.sleep(1500); await h.idle();
    const b = { pend: await h.ev(() => Studio.pendingList()), zip: await page.$eval('#expZip', x => !x.disabled), pill: await page.textContent('#readyPill'), plateFlag: await h.ev(() => Studio.S.screws.map(s => !!s.plate)) };
    await h.openStep(7);
    const ev = await h.shot('A2.9_onayli_yeniden');
    return { pass: a.zip && b.zip && !b.pend.length, actual: `onay sonrası: paket=${a.zip}, durum "${a.pill}", bekleyen ${JSON.stringify(a.pend)}; yeniden açınca: paket=${b.zip}, durum "${b.pill}", bekleyen ${JSON.stringify(b.pend)}, vidalarda plate bayrağı ${JSON.stringify(b.plateFlag)}`, evidence: ev };
  });
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
