// Senaryo B1 · Gerçek BT (anonim) yükleme: zip, seri seçici, görüntü kalite kontrolleri, hatalı zip / DICOM olmayan dosya
'use strict';
const H = require('./lib');
const fs = require('fs'), path = require('path');
const VERI = process.env.VERI || '/mnt/project-files/surgical-guide-prototype/audit/denetim3/veri';
const MZ = path.join(VERI, 'mandibula_anon.zip'), FZ = path.join(VERI, 'fibula_anon.zip');

// long tasks (main-thread freezes) are collected from page start
const LT = () => {
  window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
};
async function freezes(h) { return h.ev(() => { const a = window.__lt || []; window.__lt = []; return { n: a.length, max: a.length ? Math.max(...a) : 0, over1s: a.filter(x => x > 1000).length, total: a.reduce((s, x) => s + x, 0) }; }); }
module.exports = { MZ, FZ, LT, freezes, VERI };

if (require.main === module) (async () => {
  const h = await H.start({ name: 'B_real', dir: 'B' });
  const { page } = h;
  await page.addInitScript(LT);
  await h.goto();
  await freezes(h);

  // ---- broken inputs first (small, fast) ----
  const tmp = path.join(h.SCRATCH, 'bad'); fs.mkdirSync(tmp, { recursive: true });
  const broken = path.join(tmp, 'bozuk.zip');
  { const fd = fs.openSync(MZ, 'r'), b = Buffer.alloc(3 * 1024 * 1024); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); fs.writeFileSync(broken, b); }   // truncated: no central directory
  const garbage = path.join(tmp, 'rastgele.zip'); fs.writeFileSync(garbage, Buffer.concat([Buffer.from('PK\x03\x04'), require('crypto').randomBytes(200000)]));
  const txt = path.join(tmp, 'notlar.txt'); fs.writeFileSync(txt, 'Bu bir DICOM dosyası değildir.\n'.repeat(100));
  const png = path.join(tmp, 'resim.dcm'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

  for (const [id, f, what] of [['B1.e1', broken, 'Kesik (bozuk) zip: mandibula_anon.zip ilk 3 MB'], ['B1.e2', garbage, 'Rastgele baytlı .zip'], ['B1.e3', txt, 'DICOM olmayan .txt dosyası'], ['B1.e4', png, '.dcm uzantılı PNG başlığı']]) {
    await h.run(id, '1 · Yükleme (hatalı)', what, 'Anlaşılır hata mesajı, önceki vaka bozulmaz, sayfa hatası yok', async () => {
      await h.openStep(1);
      const before = await h.ev(() => Studio.S.source && Studio.S.source.name);
      await page.setInputFiles('#dicomFiles', f);
      await h.sleep(800); await h.idle(60000);
      const msg = await page.$eval('#caseMsg', e => e.hidden ? '' : e.textContent), busyVis = await page.$eval('#busy', e => !e.hidden);
      const after = await h.ev(() => Studio.S.source && Studio.S.source.name);
      return { pass: !!msg && !busyVis && before === after, actual: `mesaj "${msg}", meşgul katman açık=${busyVis}, kaynak ${before} → ${after}`, evidence: await h.shot(id) };
    });
  }

  // ---- mandible zip ----
  let loadMs = 0;
  await h.run('B1.1', '1 · Yükleme', 'mandibula_anon.zip (291 MB, 1243 dosya, 6 seri) "Dosya / .zip" ile', 'İlerleme çubuğu, seri seçici 6 seriyi listeler, hacim yüklenir', async () => {
    const m0 = await h.mem(); const t = Date.now();
    await page.setInputFiles('#dicomFiles', MZ);
    const samples = [];
    // sample the progress text while loading
    for (let i = 0; i < 2000; i++) {
      await h.sleep(1000);
      const b = await page.evaluate(() => ({ on: !document.getElementById('busy').hidden, t: document.getElementById('busyText').textContent })).catch(() => ({ on: true, t: '?' }));
      if (i % 5 === 0) samples.push(`${Math.round((Date.now() - t) / 1000)}s ${b.t}`);
      if (!b.on && i > 2) { await h.idle(600000); break; }
    }
    loadMs = Date.now() - t;
    const m1 = await h.mem(), fz = await freezes(h);
    const opts = await page.$$eval('#serSel option', o => o.map(x => x.textContent));
    const src = await h.ev(() => ({ name: Studio.S.source.name, slices: Studio.S.source.slices, dims: [Studio.S.vol.nx, Studio.S.vol.ny, Studio.S.vol.nz], sp: Studio.S.vol.sp }));
    fs.writeFileSync(path.join(h.outDir, 'B1.1_progress.txt'), samples.join('\n'));
    h.loadInfo = { loadMs, m0, m1, fz };
    return { pass: opts.length >= 6 && src.slices > 100, actual: `${(loadMs / 1000).toFixed(1)} s; heap ${m0 && m0.used} → ${m1 && m1.used} MB; uzun görev ${fz.n} (en uzun ${fz.max} ms, >1 sn: ${fz.over1s}); açılan seri "${src.name}" ${src.slices} kesit ${JSON.stringify(src.dims)} sp ${JSON.stringify(src.sp.map(x => +x.toFixed(3)))}; seçici: ${opts.length} seri`, evidence: await h.shot('B1.1_mandibula_yuklendi'), seriler: opts };
  });
  await h.run('B1.2', '1 · Seri seçici', 'Seri seçiciden "#3 0.625mm Bone" seç', 'Bone serisi açılır (417 kesit)', async () => {
    await h.openStep(1);
    const opts = await page.$$eval('#serSel option', o => o.map(x => ({ v: x.value, t: x.textContent })));
    const bone = opts.find(o => /0\.625mm Bone/i.test(o.t));
    if (!bone) return { pass: false, actual: 'Bone serisi listede yok: ' + opts.map(o => o.t).join(' | ') };
    const cur = await page.inputValue('#serSel');
    const t = Date.now();
    if (cur !== bone.v) { await page.selectOption('#serSel', bone.v); await h.sleep(1000); await h.idle(600000); }
    const src = await h.ev(() => ({ name: Studio.S.source.name, slices: Studio.S.source.slices }));
    const fz = await freezes(h);
    return { pass: /Bone/.test(src.name) && src.slices === 417, actual: `önceki seçili ${opts.find(o => o.v === cur).t.slice(0, 40)}; ${Date.now() - t} ms; açılan "${src.name}" ${src.slices} kesit; uzun görev en uzun ${fz.max} ms; seçenekler: ${opts.map(o => o.t).join(' | ')}`, evidence: await h.shot('B1.2_bone_serisi') };
  });
  await h.run('B1.3', 'Kontroller', 'Kontroller sekmesi: görüntü bilgisi ve görüntü kalite kontrolleri (gerçek veri)', 'Seri bilgisi (kesit, voksel, tarih) ve QC maddeleri dolu', async () => {
    await page.click('#tab-pChk'); await h.sleep(500);
    const info = await page.textContent('#caseInfo'), date = await page.textContent('#dateInfo');
    const qc = await page.$$eval('#qc li', l => l.map(x => (x.className || '') + ': ' + x.textContent.trim()));
    const ev = await h.shot('B1.3_kontroller');
    const comps = await page.$$eval('#comps label, #comps .row', l => l.map(x => x.textContent.trim()).slice(0, 10)).catch(() => []);
    return { pass: qc.length > 0 && /kesit|mm/.test(info), actual: `bilgi "${info.replace(/\s+/g, ' ')}", tarih "${date.replace(/\s+/g, ' ')}"; QC: ${qc.join(' | ')}; bileşenler: ${comps.join(' | ')}`, evidence: ev };
  });
  await h.run('B1.4', '1 · Fibula', 'fibula_anon.zip (303 MB, 1592 dosya, 3 seri) fibula "Dosya / .zip" ile', 'Fibula hacmi yüklenir (1.25mm, 1057 kesit), aday listesi dolu', async () => {
    await h.openStep(1);
    const m0 = await h.mem(), t = Date.now();
    await page.setInputFiles('#fibFiles', FZ);
    for (let i = 0; i < 2000; i++) { await h.sleep(1000); const on = await page.evaluate(() => !document.getElementById('busy').hidden).catch(() => true); if (!on && i > 2) { await h.idle(900000); break; } }
    const ms = Date.now() - t, m1 = await h.mem(), fz = await freezes(h);
    const msg = await page.$eval('#fibMsg', e => e.textContent).catch(() => '');
    const fib = await h.ev(() => ({ active: !!(Fibula.active && Fibula.active()), cands: [...document.querySelectorAll('#fibCand option')].map(o => o.textContent) }));
    await h.openStep(4); await h.idle();
    return { pass: fib.active, actual: `${(ms / 1000).toFixed(1)} s; heap ${m0 && m0.used} → ${m1 && m1.used} MB; uzun görev en uzun ${fz.max} ms (>1 sn ${fz.over1s}); fibMsg "${msg}"; adaylar ${fib.cands.join(' | ')}`, evidence: await h.shot('B1.4_fibula') };
  });

  await h.run('B1.5', '4 · Fibula (gerçek)', 'Otomatik aday Ø98 mm (bacak bütünü). Önce "Tibiadan ayır" (fibula 791,450 → tibia 752,450), olmazsa "Modelde seç" ile fibula gövdesine tıkla', 'Fibula tek başına aday olur (çap ~10-30 mm)', async () => {
    await h.openStep(4);
    const c0 = await page.$$eval('#fibCand option', o => o.map(x => x.textContent));
    const cur = async () => page.$eval('#fibCand', e => e.selectedOptions[0] && e.selectedOptions[0].textContent);
    const dia = t => +((/Ø(\d+)/.exec(t || '') || [])[1] || 0);
    const log = [];
    await page.click('#fibSplit'); await h.sleep(300);
    await h.click3d(791, 450); await h.sleep(600); await h.click3d(752, 450); await h.sleep(1500); await h.idle(600000);
    log.push(`ayır: "${await page.$eval('#fibPickMsg', e => e.textContent).catch(() => '')}" → ${await cur()}`);
    await h.shot('B1.5a_tibiadan_ayir');
    for (const x of [791, 789, 793, 787, 795, 785]) {
      if (dia(await cur()) > 8 && dia(await cur()) < 35) break;
      await page.click('#fibPick'); await h.sleep(500);
      await h.click3d(x, 450); await h.sleep(1500); await h.idle(600000);
      log.push(`seç (${x},450): "${await page.$eval('#fibPickMsg', e => e.textContent).catch(() => '')}" → ${await cur()}`);
    }
    const sel = await cur(), c1 = await page.$$eval('#fibCand option', o => o.map(x => x.textContent));
    return { pass: dia(sel) > 8 && dia(sel) < 35, actual: `otomatik adaylar ${c0.join(' | ')}; ${log.join(' ; ')}; sonuç adaylar ${c1.join(' | ')}`, evidence: await h.shot('B1.5_fibula_secimi') };
  });
  // ---------- planning on real data ----------
  const REAL = path.join(H.KANIT, 'real'); fs.mkdirSync(REAL, { recursive: true });
  const st = () => h.state();
  const seg = async (selId, v) => page.click(`#${selId} + .seg button[data-v="${v}"]`);
  // the reference (midplane, condyles) is computed by "Simetri ve kondilleri bul" / Otomatik planla, not on load (Denetim 4
  // e2e H1): on load the mandible must be split off as its own component
  await h.run('B2.0', '2 · Anatomi (gerçek)', 'Bileşen listesi gerçek veride (yüklemede otomatik ayırma)', 'Mandibula ayrı bileşen ("Mandibula (otomatik ayrıldı)") ve seçili', async () => {
    await page.click('#scM').catch(() => {}); await h.sleep(500);
    await h.openStep(2); await h.idle();
    const comps = await page.$$eval('#comps label, #comps .row, #comps li', l => l.map(x => x.textContent.trim().replace(/\s+/g, ' ')).slice(0, 12)).catch(() => []);
    const ref = await h.ev(() => { const r = Ref.get(); return r ? Object.keys(r) : null; });
    const refTxt = (await page.textContent('#refBox')).replace(/\s+/g, ' ').slice(0, 300);
    const sel = await h.ev(() => [...Studio.S.selected]);
    const ev = await h.shot('B2.0_anatomi_gercek');
    const mand = comps.some(c => /^Mandibula \(otomatik ayrıldı\)/.test(c));
    return { pass: mand && sel.length >= 1, actual: `bileşenler: ${comps.join(' | ')}; seçili ${JSON.stringify(sel)}; Ref ${JSON.stringify(ref)}; refBox "${refTxt}"`, evidence: ev };
  });
  const PX_A = [[760, 618], [735, 612], [790, 626], [812, 632], [705, 600], [698, 570], [688, 540]];   // mandible: body, angle, ramus, chin (right view, 1440x900)
  const PX_B = [[700, 350], [800, 420], [760, 470], [830, 520], [640, 610], [650, 680], [790, 545]];   // cranium, maxilla, cervical spine
  let W_A = [], W_B = [], W_ANCHOR = null;
  await h.run('B2.0b', '2 · Anatomi (gerçek)', '"Bitişik kemikleri ayır": mandibulaya Kemik A (gövde, açı, ramus, çene), kafatası/maksilla/omurgaya Kemik B işareti (3B modelde tık) → "Ayır"', 'Planlama kemiği yalnız mandibula (z açıklığı < 120 mm)', async () => {
    await page.click('#scM').catch(() => {}); await h.openStep(2);
    await page.click('.presets button[data-view="right"]'); await h.sleep(1000);
    for (const [x, y] of PX_A) W_A.push(await h.pick(x, y)); for (const [x, y] of PX_B) W_B.push(await h.pick(x, y));
    W_ANCHOR = W_A[0];
    await page.evaluate(() => { const d = document.getElementById('secMask'); if (!d.open) d.querySelector('summary').click(); });
    const mark = async (label, pts) => {
      await page.click(`#mkLayers input[name="mkCur"][value="${label}"]`); await h.sleep(200);
      if (await page.getAttribute('#maskBox button[data-t="paint"]', 'aria-pressed') !== 'true') await page.click('#maskBox button[data-t="paint"]');
      await h.sleep(600); await page.click('.presets button[data-view="right"]'); await h.sleep(800);
      for (const w of pts) { if (!w) continue; const P = await h.proj(w); await h.click3d(P.x, P.y); await h.sleep(250); }
    };
    await mark(1, W_A); await mark(2, W_B); await h.idle();
    const marks = (await page.textContent('#mkLayers')).replace(/\s+/g, ' ');
    const ev1 = await h.shot('B2.0b_isaretler');
    const t = Date.now();
    if (await page.isEnabled('#mkRun')) { await page.click('#mkRun'); await h.sleep(1000); await h.idle(900000); }
    await page.keyboard.press('Escape'); await page.click('#vm3d').catch(() => {}); await h.sleep(800);
    const comps = await page.$$eval('#comps li', l => l.map(x => x.textContent.trim().replace(/\s+/g, ' ')).slice(0, 10));
    const bb = await h.ev(() => { const b = new THREE.Box3().setFromObject(Studio.parts.bone.obj); return [b.min.toArray().map(Math.round), b.max.toArray().map(Math.round)]; });
    const msg = (await page.textContent('#maskBox')).replace(/\s+/g, ' ').slice(-120);
    await page.click('.presets button[data-view="right"]'); await h.sleep(800);
    const ev = await h.shot('B2.0b_ayrildi');
    const zspan = bb[1][2] - bb[0][2];
    return { pass: zspan < 120, actual: `${Date.now() - t} ms; işaretler "${marks}"; planlama kemiği kutusu ${JSON.stringify(bb)} (z açıklığı ${zspan} mm; ayırmadan önce 242 mm); katmanlar: ${comps.join(' | ')}; "${msg}"`, evidence: ev1 + ', ' + ev };
  });
  await h.run('B2.1', '3 · Rezeksiyon (gerçek)', 'Sağdan görünüm; "Bölgeyi modelde seç" + sağ mandibula gövdesine tıkla (sağ görünümde 760,618 pikselindeki kemik noktası)', 'Guide merkezi sağ gövdede (x<0), iki kesi konur', async () => {
    await h.openStep(3);
    await page.click('.presets button[data-view="right"]'); await h.sleep(1000);
    await page.click('#vm3d').catch(() => {}); await h.sleep(500);
    await page.click('.presets button[data-view="right"]'); await h.sleep(800);
    await page.click('#pickAnchor'); await h.sleep(300);
    const P = W_ANCHOR ? await h.proj(W_ANCHOR) : { x: 760, y: 618 };
    await h.click3d(P.x, P.y); await h.sleep(1500); await h.idle(300000);
    const a = await h.ev(() => Studio.S.anchor && { p: Studio.S.anchor.p.toArray().map(x => +x.toFixed(1)), n: Studio.S.anchor.n.toArray().map(x => +x.toFixed(2)) });
    const s = await st(), fz = await freezes(h);
    return { pass: !!a && a.p[0] < 0 && s.planes.length === 2, actual: `anchor ${JSON.stringify(a)}; kesiler ${JSON.stringify(s.planes.map(p => p.off))}; uzun görev en uzun ${fz.max} ms`, evidence: await h.shot('B2.1_bolge_secildi') };
  });
  await h.run('B2.2', '3 · Rezeksiyon (gerçek)', 'Sınır −10…10, pay 3 (26 mm lateral gövde) → "Kesileri sınıra göre koy" → "Rezeke parçayı gizle" → "Guide oluştur"', 'Rezeke parça yalnız mandibulada; guide tek parça, takılabilir; kritik yok', async () => {
    await page.evaluate(() => { const d = document.getElementById('secBounds'); if (!d.open) d.querySelector('summary').click(); });
    await h.setRange('#l_from', -10); await h.setRange('#l_to', 10); await h.setRange('#l_margin', 3);
    const t = Date.now();
    await page.click('#suggest'); await h.sleep(500); await h.idle(600000);
    const tRes = Date.now() - t;
    await page.click('#resRemove').catch(() => {}); await h.idle();
    const t2 = Date.now();
    await h.openStep(5);   // the guide button sits in the Guides step (simple panel)
    if (await page.isEnabled('#guideMake') && await page.isVisible('#guideMake')) { await page.click('#guideMake'); await h.sleep(500); await h.idle(900000); }
    // the canal gate (plan A): the surgeon checks the screws against the canal on the slices and says so with the row's fix
    { if (await h.ev(() => { const b = document.querySelector('.checks li [data-fix="canalOk"]'); if (b) b.click(); return !!b; })) { await h.sleep(300); await h.idle(); } }
    const tG = Date.now() - t2, s = await st(), stat = await page.textContent('#guideStat'), fz = await freezes(h), mem = await h.mem();
    const vol = await h.ev(() => Math.round(Studio.S.resectedVolume || 0));
    const bb = await h.ev(() => { const r = Studio.parts.resected; if (!r) return null; const b = new THREE.Box3().setFromObject(r.obj); return [b.min.toArray().map(Math.round), b.max.toArray().map(Math.round)]; });
    const checks = await h.ev(() => [...document.querySelectorAll('#checks li')].map(l => l.className.replace('checks', '').trim().slice(0, 5) + ': ' + l.textContent.trim().slice(0, 110)));
    const ev = await h.shot('B2.2_guide_gercek');
    await page.click('.presets button[data-view="ant"]'); await h.sleep(800); await h.shot('B2.2_guide_gercek_on');
    return { pass: s.guideOn && s.pieces === 1 && !s.crit, actual: `rezeksiyon ${tRes} ms, guide ${tG} ms; kesiler ${JSON.stringify(s.planes.map(p => p.off))}, rezeke hacim ${vol} mm³, rezeke kutusu ${JSON.stringify(bb)}; L=${s.L}, parça ${s.pieces}, vida ${s.screws} (null ${s.nullScrews}), kritik ${s.crit}; "${stat}"; uzun görev en uzun ${fz.max} ms, toplam ${fz.total} ms; heap ${mem && mem.used} MB; kontroller: ${checks.join(' | ')}`, evidence: ev };
  });
  await h.run('B2.3', '4 · Fibula (gerçek)', 'Fibula segment sayısı 1, 2, 3 ve "Kesileri öner"', 'Segmentler fibulaya yerleşir; kısa segment kritik', async () => {
    await h.openStep(4); const out = [];
    for (const n of [1, 2, 3]) {
      await page.click(`#fibN button[data-n="${n}"]`); await h.sleep(500); await h.idle(600000);
      const segs = await h.ev(() => Fibula.state().last ? Fibula.state().last.segs.map(s => +s.L.toFixed(1)) : null);
      const fc = await h.ev(() => [...document.querySelectorAll('#fibChecks li')].map(l => l.className.replace('checks', '').trim().slice(0, 4) + ':' + l.textContent.trim().slice(0, 70)));
      out.push(`${n}: ${JSON.stringify(segs)} [${fc.join(' | ')}]`);
      await h.shot(`B2.3_fibula_${n}seg`);
    }
    await page.click('#fibN button[data-n="1"]'); await h.idle(600000);
    await page.click('#fibOpt'); await h.idle(600000);
    const s = await st();
    await page.click('#scS').catch(() => {}); await h.sleep(1000); await h.shot('B2.3_yan_yana'); await page.click('#scM').catch(() => {});
    return { pass: out.length === 3 && !out.some(o => /null/.test(o.split('[')[0])), actual: out.join(' ; ') + ` ; son kritik ${s.crit}` };
  });
  await h.run('B2.4', '5 · Plak (gerçek)', 'Plak planla', 'Plak özeti; plak kritik değil, uzunluk rezeksiyon + 2 × uzantı + 40 mm içinde', async () => {
    await h.openStep(5); await page.evaluate(() => { const d = document.getElementById('secPlate'); if (!d.open) d.querySelector('summary').click(); });
    await page.check('#plOn'); await h.sleep(800); await h.idle(300000);
    const sum = (await page.textContent('#plSum').catch(() => '')).replace(/\s+/g, ' ');
    const msg = await page.textContent('#plMsg').catch(() => '');
    // Denetim 4 E1: on this CT the line used to wind round the bone (235 mm, 29 holes, 652° bend) and still went into the
    // package. The plate must now be plausible: not critical, and no longer than the resection plus both extensions allow
    const pl = await h.ev(() => { const p = Plate.get(), P = Plate.params(); return p ? { L: Math.round(p.L), holes: p.holes.length, crit: Plate.critical().map(c => c.text), ext: P.ext, ok: p.ok } : null; });
    const res = await h.ev(() => { const pw = Studio.planesWorld(); return pw.length === 2 ? Math.abs(pw[1].off - pw[0].off) : null; });
    const maxL = res != null && pl && pl.ext != null ? res + 2 * pl.ext + 40 : 150;
    return { pass: /delik/.test(sum) && !!pl && !pl.crit.length && pl.L <= maxL, actual: `"${sum.slice(0, 200)}" ${msg}; plak ${JSON.stringify(pl)}, rezeksiyon ${res} mm, üst sınır ${maxL} mm`, evidence: await h.shot('B2.4_plak_gercek') };
  });
  await h.run('B2.5', '7 · Onay (gerçek)', 'Cerrah adı, öğe onayları, fibula, mühendis + cerrah onayı', 'Paket etkin', async () => {
    await h.openStep(7);
    { if (await h.ev(() => { const b = document.querySelector('.checks li [data-fix="canalOk"]'); if (b) b.click(); return !!b; })) { await h.sleep(300); await h.idle(); } }   // screws moved since (plate): checked again
    await page.fill('#surgeon', 'Dr. E2E Cerrah'); await page.press('#surgeon', 'Tab');
    for (let k = 0; k < 30; k++) { const b = page.locator('#appr button[data-ap]', { hasText: 'Onayla' }).first(); if (!(await b.count())) break; await b.click(); await h.sleep(300); await h.idle(60000, 300); }
    const am = await page.textContent('#apprMsg');
    await page.fill('#au_eng_n', 'Müh. E2E'); await page.click('#auditBox button[data-a="onay"][data-r="eng"]'); await h.sleep(300);
    await page.click('#auditBox button[data-a="onay"][data-r="sur"]').catch(() => {}); await h.sleep(500); await h.idle();
    const zip = await page.$eval('#expZip', b => !b.disabled), s = await st(), why = await page.$eval('#expZip', b => b.title);
    return { pass: zip, actual: `paket=${zip}, durum "${s.pill}", kritik ${s.crit} ${s.critList.join(' | ')}; apprMsg "${am}"; ${why}`, evidence: await h.shot('B2.5_onay_gercek') };
  });
  await h.run('B2.6', '8 · Teslim (gerçek)', 'Sunucuda üretim STL\'i (/guide) — mandibula + fibula guide', 'Su geçirmez, beklenen parça sayısı', async () => {
    await h.openStep(8); const t = Date.now();
    await page.click('#expSrv'); await h.sleep(500); await h.idle(900000);
    const m = await page.textContent('#prodMsg');
    return { pass: /su geçirmez/.test(m) && !/DEĞİL/.test(m) && !/FAZLA/.test(m), actual: `${Date.now() - t} ms: "${m}"`, evidence: await h.shot('B2.6_uretim_gercek') };
  });
  await h.run('B2.7', '8 · Teslim (gerçek)', 'Paket zip + ayrı guide STL; guide STL\'leri ve plan.json → kanit/real/', 'Paket indirilir; dosyalar kaydedilir', async () => {
    const out = [];
    const zipOk = await page.$eval('#expZip', b => !b.disabled);
    if (zipOk) {
      const [d] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#expZip')]);
      const zp = path.join(h.SCRATCH, 'real_paket.zip'); await d.saveAs(zp);
      const list = require('./lib').zipList(zp);
      out.push(`paket ${list.length} dosya: ${list.join(', ')}`);
      const keep = list.filter(f => /^(guide_uretim|guide_onizleme|fibula_guide_uretim|fibula_guide_onizleme)\.stl$|^(plan|fibula_plani|plak_plani|osteotomi_raporu|onay_kaydi|navigasyon)\.json$|^cerrahi_rapor\.pdf$/.test(f));
      require('./lib').zipExtract(zp, keep, REAL);
      fs.writeFileSync(path.join(REAL, 'paket_listesi.txt'), list.join('\n'));
    } else out.push('paket kilitli; yalnız tek STL ve plan');
    const files = await h.ev(() => {
      const S = Studio.S, b64 = d => { const u = typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
      const out = [];
      if (S.prod && S.prod.stl) out.push({ name: 'guide_uretim.stl', data: b64(S.prod.stl), meta: { watertight: S.prod.watertight, bodies: S.prod.bodies, volume: S.prod.volume, faces: S.prod.faces, ms: S.prod.ms, productionOk: S.prod.productionOk, print: S.prod.printChecks || null, issues: (S.prod.issues || []).map(i => i.code) } });
      if (S.prod && S.prod.stl) out.push({ name: 'guide_uretim_meta.json', data: b64(JSON.stringify({ watertight: S.prod.watertight, bodies: S.prod.bodies, volume: S.prod.volume, faces: S.prod.faces, productionOk: S.prod.productionOk, print: S.prod.printChecks || null, issues: (S.prod.issues || []).map(i => i.code), current: S.prod.key === Studio.prodKey(), crit: Studio.S.crit })) });
      if (Studio.parts.guide) out.push({ name: 'guide_onizleme.stl', data: b64(Studio.stlOf ? Studio.stlOf(Studio.parts.guide.obj) : '') });
      const ff = []; try { Fibula.exportFiles(ff); } catch (e) {}
      ff.forEach(f => out.push({ name: f.name, data: b64(f.data) }));
      if (S.fib && S.fib.prod) out.push({ name: 'fibula_guide_uretim_meta.json', data: b64(JSON.stringify({ watertight: S.fib.prod.watertight, bodies: S.fib.prod.bodies, volume: S.fib.prod.volume, faces: S.fib.prod.faces, productionOk: S.fib.prod.productionOk, print: S.fib.prod.printChecks || null, issues: (S.fib.prod.issues || []).map(i => i.code), current: S.fib.prod.key === (S.fib.guide && S.fib.guide.key) })) });
      return out;
    });
    for (const f of files) { if (!f.data) continue; fs.writeFileSync(path.join(REAL, f.name), Buffer.from(f.data, 'base64')); out.push(`kanit/real/${f.name} ${Buffer.from(f.data, 'base64').length} B${f.meta ? ' ' + JSON.stringify(f.meta) : ''}`); }
    // the full plan (planOf, reopenable) for the consistency worker
    fs.writeFileSync(path.join(REAL, 'plan_full.json'), JSON.stringify(await h.ev(() => Studio.planOf()), null, 1));
    fs.writeFileSync(path.join(REAL, 'plan_frame.json'), JSON.stringify(await h.ev(() => { const f = Studio.frameAxes(), v = x => x.toArray(); return { anchor: v(Studio.S.anchor.p), u: v(f.u), v: v(f.v), n: v(f.n), planesWorld: Studio.planesWorld().map(p => ({ off: p.off, w: p.w, p: v(p.p), N: v(p.N) })), screwsWorld: Studio.S.screws.map(sc => { const s = Studio.screwWorld(sc); return { sc, dir: v(s.dir), entry: s.entry && v(s.entry) }; }), g: Studio.S.g, source: Studio.S.source, vol: { dims: [Studio.S.vol.nx, Studio.S.vol.ny, Studio.S.vol.nz], sp: Studio.S.vol.sp, origin: Studio.S.vol.origin, axes: Studio.S.vol.axes }, thr: document.getElementById('thr').value }; }), null, 1));
    // what the accuracy measures read (tools/realct_audit.py accuracy): the fibula segments and its guide's slots
    fs.writeFileSync(path.join(REAL, 'olcum.json'), JSON.stringify(await h.ev(() => { const st = window.Fibula && Fibula.state(), S = Studio.S, v = x => x.toArray();
      return { fibSegs: st && st.last ? st.last.segs.map(s => s.L) : null, fibSlots: S.fib && S.fib.guide && S.fib.guide.ctx ? S.fib.guide.ctx.pls.map(p => ({ p: v(p.pSlot || p.p), N: v(p.N), w: p.w })) : null, blade: S.g.blade, boss: S.g.boss, wall: S.g.wall, slots: S.planes.map(p => p.w), kerf: window.Fibula && Fibula.plan() ? Fibula.plan().kerf : null }; }), null, 1));
    // the bone the production server builds the mandible guide against (its request's crop at the CT's resolution): the
    // contact measure reads the guide against this surface, not the 0.8 mm bone STL (plan A4)
    { const crop = await h.ev(() => { const S = Studio.S, St = Studio; if (!S.guideOn || !S.anchor) return null;
        const pt = S.result && S.result.parts && S.result.parts[0];
        const c = pt ? Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: pt.g, P: pt.frame.P, pls: pt.pls, gap: pt.gap, scs: pt.scs, wrapProfile: pt.wrapProfile }, pt.frame)
          : Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld(), wrapProfile: S.result && S.result.wrapProfile }, St.frameAxes());
        const q = St.guideRequest(c); return { crop: q.crop, mask_b64: q.mask_b64, mask_scale: q.mask_scale || null }; });
      if (crop) fs.writeFileSync(path.join(REAL, 'kemik_kesit.json'), JSON.stringify(crop)); }
    // the single files from the Teslim list too
    for (const k of ['guide', 'bone', 'res', 'full']) {
      try { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click(`#oneStl button[data-one="${k}"]`)]); const p = path.join(h.SCRATCH, 'real_' + d.suggestedFilename()); await d.saveAs(p); out.push(`${d.suggestedFilename()} ${fs.statSync(p).size} B`); if (k === 'guide') fs.copyFileSync(p, path.join(REAL, 'tek_' + d.suggestedFilename())); if (k === 'bone') fs.copyFileSync(p, path.join(REAL, 'kemik.stl')); } catch (e) { out.push(`${k}: ${e.message.slice(0, 50)}`); }
    }
    return { pass: zipOk, actual: out.join(' ; '), evidence: 'kanit/real/' };
  });
  await h.run('B2.8', 'Kaydet / yeniden aç (gerçek)', 'Sayfayı yenile: DICOM vaka için aynı seriyi yeniden yüklemesi istenir; zip yeniden yüklenince plan açılır', 'Mesaj gösterilir; aynı zip ile plan aynen geri gelir', async () => {
    const before = await h.ev(() => ({ planes: Studio.S.planes.map(p => p.off), screws: Studio.S.screws.length, vol: Math.round(Studio.S.resectedVolume || 0) }));
    await h.sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(3000); await h.idle();
    const msg = await page.$eval('#caseMsg', e => e.hidden ? '' : e.textContent);
    await h.openStep(1);
    await page.setInputFiles('#dicomFiles', MZ);
    for (let i = 0; i < 2000; i++) { await h.sleep(1000); const on = await page.evaluate(() => !document.getElementById('busy').hidden).catch(() => true); if (!on && i > 2) { await h.idle(900000); break; } }
    await h.sleep(3000); await h.idle(600000);
    const src = await h.ev(() => Studio.S.source && Studio.S.source.name);
    const after = await h.ev(() => ({ planes: Studio.S.planes.map(p => p.off), screws: Studio.S.screws.length, vol: Math.round(Studio.S.resectedVolume || 0) }));
    return { pass: JSON.stringify(before.planes) === JSON.stringify(after.planes) && before.screws === after.screws, actual: `yenileme mesajı "${msg}"; yeniden yüklenen seri "${src}"; önce ${JSON.stringify(before)} → sonra ${JSON.stringify(after)}`, evidence: await h.shot('B2.8_yeniden_ac_gercek') };
  });
  h.saveJSON('B1_state.json', { load: h.loadInfo, plan: await h.ev(() => Studio.planOf()) });
  await h.done();
})();
