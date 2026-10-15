// Senaryo C · Hata ve uç akışlar (örnek vaka + gerçek BT zip'i ile yükleme iptali, sunucu kapalıyken STL)
// Sunucuyu durdurma adımı için SERVER_PID ve SERVER_CMD ortam değişkenleri gerekir (run_all.sh verir).
'use strict';
const H = require('./lib');
const fs = require('fs'), path = require('path'), { execSync, spawn } = require('child_process');
const VERI = process.env.VERI || '/mnt/project-files/surgical-guide-prototype/audit/denetim3/veri';

(async () => {
  const h = await H.start({ name: 'C_edge', dir: 'C' });
  const { page } = h;
  const st = () => h.state();
  const seg = async (selId, v) => page.click(`#${selId} + .seg button[data-v="${v}"]`);
  await h.goto();

  // ---------- C1: cancel mid-upload ----------
  await h.run('C1.1', '1 · Yükleme iptali', 'mandibula_anon.zip yüklenirken iptal düğmesi var mı?', 'Uzun yüklemede "İptal" seçeneği', async () => {
    await h.openStep(1);
    await page.setInputFiles('#dicomFiles', path.join(VERI, 'mandibula_anon.zip'));
    await h.sleep(6000);
    const b = await page.evaluate(() => ({ busy: !document.getElementById('busy').hidden, text: document.getElementById('busyText').textContent, cancel: !document.getElementById('busyCancel').hidden }));
    const ev = await h.shot('C1.1_yukleme_suruyor');
    h.c1 = b;
    return { pass: b.cancel, actual: `meşgul=${b.busy}, "${b.text}", iptal düğmesi görünür=${b.cancel}`, evidence: ev };
  });
  await h.run('C1.2', '1 · Yükleme iptali', 'Yükleme sürerken ikinci bir dosya seç (DICOM olmayan .txt) — ikinci seçim ilkinin yerini alır', 'İlk yükleme sessizce bırakılır (eski seri vakayı ezmez), ikinci dosyanın hatası gösterilir, meşgul katman kapanır', async () => {
    const txt = path.join(h.SCRATCH, 'bad', 'notlar.txt'); fs.mkdirSync(path.dirname(txt), { recursive: true }); if (!fs.existsSync(txt)) fs.writeFileSync(txt, 'x'.repeat(1000));
    await page.setInputFiles('#dicomFiles', txt);
    await h.sleep(3000);
    const mid = await page.evaluate(() => ({ busy: !document.getElementById('busy').hidden, text: document.getElementById('busyText').textContent, msg: document.getElementById('caseMsg').hidden ? '' : document.getElementById('caseMsg').textContent }));
    await h.sleep(15000);                    // the replaced zip load must not come back and overwrite the case
    const s = await h.ev(() => ({ src: Studio.S.source && Studio.S.source.type, slices: Studio.S.source && Studio.S.source.slices, kind: Studio.S.kind, busy: !document.getElementById('busy').hidden }));
    return { pass: !mid.busy && /DICOM/.test(mid.msg) && s.src === 'sample' && !s.busy, actual: `ikinci seçimden 3 sn sonra: meşgul=${mid.busy}, mesaj "${mid.msg}"; 15 sn sonra kaynak ${s.src} (${s.kind}), meşgul=${s.busy}`, evidence: await h.shot('C1.2_ikinci_secim') };
  });
  await h.run('C1.4', '1 · Yükleme iptali', 'Zip yüklenirken "İptal" düğmesine bas', 'Yükleme durur, meşgul katman kapanır, "Yükleme iptal edildi" denir, vaka (örnek) değişmez', async () => {
    await page.setInputFiles('#dicomFiles', path.join(VERI, 'mandibula_anon.zip'));
    await h.sleep(5000);
    const shown = await page.evaluate(() => !document.getElementById('busyCancel').hidden);
    if (shown) await page.click('#busyCancel');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { await h.sleep(500); gone = await page.evaluate(() => document.getElementById('busy').hidden); }
    await h.sleep(5000);
    const s = await h.ev(() => ({ src: Studio.S.source && Studio.S.source.type, busy: !document.getElementById('busy').hidden, msg: document.getElementById('caseMsg').hidden ? '' : document.getElementById('caseMsg').textContent }));
    return { pass: shown && gone && !s.busy && s.src === 'sample' && /iptal/.test(s.msg), actual: `düğme görünür=${shown}; katman kapandı=${gone}; 5 sn sonra kaynak ${s.src}, meşgul=${s.busy}, mesaj "${s.msg}"`, evidence: await h.shot('C1.4_iptal') };
  });
  await h.run('C1.3', '1 · Yükleme iptali', 'Yükleme sürerken sayfayı yenile', 'Sayfa temiz açılır, örnek vaka yüklenir, yarım vaka kalmaz', async () => {
    await page.setInputFiles('#dicomFiles', path.join(VERI, 'mandibula_anon.zip'));
    await h.sleep(8000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(2000); await h.idle();
    const s = await h.ev(() => ({ src: Studio.S.source && Studio.S.source.name, kind: Studio.S.kind }));
    return { pass: s.kind === 'mandible' || s.kind === 'dicom', actual: `yenileme sonrası kaynak "${s.src}" (${s.kind})`, evidence: await h.shot('C1.3_yenile') };
  });
  // restart from the sample for the remaining scenarios
  await h.openStep(1); await page.click('#sampleM'); await h.idle(); await h.settle();

  // ---------- C7: fibula view vs mandible interactions ----------
  await h.run('C7', '3 · Rezeksiyon (fibula yüklü)', 'Örnek fibulayı yükle; 3. adımda "Bölgeyi modelde seç" + 3B görünüme tıkla', 'Görünüm mandibulaya döner ya da seçim yapılır', async () => {
    await page.click('#fibSample'); await h.idle(); await h.settle();
    const view = await h.ev(() => Fibula.view());
    await h.openStep(3); await page.click('#pickAnchor'); await h.sleep(300);
    const badge = await page.$eval('#modeBadge', e => e.hidden ? '' : e.textContent);
    const view2 = await h.ev(() => Fibula.view());
    const pts = await h.hits('bone', 24);                          // a bone point of the (now shown) mandible
    if (pts.length) { const p = pts[Math.floor(pts.length / 2)]; await h.click3d(p.x, p.y); }
    await h.sleep(1000); await h.idle();
    const s = await st(), step = await h.ev(() => [...document.querySelectorAll('details.step')].find(d => d.open).id);
    const ev = await h.shot('C7_fibula_gorunumu');
    await page.keyboard.press('Escape');
    return { pass: view2 === 'm' && s.planes.length > 0 && /mandibulaya alındı/.test(await page.$eval('#caseMsg', e => e.hidden ? '' : e.textContent)), actual: `fibula sonrası sahne=${view}; "Bölgeyi seç" sonrası sahne=${view2}; rozet "${badge}"; tık sonrası kesi ${s.planes.length}, açık adım ${step}`, evidence: ev };
  });
  await h.run('C7b', '2 · Anatomi (fibula yüklü)', 'Fibula görünümünde adım 2 silgisini seç, 3B görünüme tıkla', 'Görünüm mandibulaya döner, adım 4 açılmaz, silgi mandibulaya uygulanır', async () => {
    await page.click('#scF'); await h.sleep(500);
    await h.openStep(2);
    await page.evaluate(() => { const d = document.querySelector('#segEdit details'); if (d && !d.open) d.querySelector('summary').click(); });
    await page.click('#segEdit button[data-t="erase"]'); await h.sleep(500);
    const view = await h.ev(() => Fibula.view());
    const pts = await h.hits('bone', 24);
    const before = await h.ev(() => { let c = 0; const m = Studio.S.mask; for (let i = 0; i < m.length; i++) c += m[i] ? 1 : 0; return c; });
    if (pts.length) { const p = pts[Math.floor(pts.length / 2)]; for (let i = 0; i < 3; i++) { await h.click3d(p.x + i * 6, p.y); await h.sleep(300); } }
    await h.idle();
    const after = await h.ev(() => { let c = 0; const m = Studio.S.mask; for (let i = 0; i < m.length; i++) c += m[i] ? 1 : 0; return c; });
    const step = await h.ev(() => [...document.querySelectorAll('details.step')].find(d => d.open).id);
    await page.keyboard.press('Escape');
    return { pass: view === 'm' && pts.length > 0 && after !== before && step === 'st2', actual: `sahne=${view}; maske voksel ${before} → ${after}; açık adım ${step}`, evidence: await h.shot('C7b_firca') };
  });
  await page.click('#scM'); await h.sleep(500);
  await h.openStep(1); await page.click('#sampleM'); await h.idle();   // drop the fibula again

  // ---------- C2: reopen an old plan with a different threshold ----------
  await h.run('C2', 'Yeniden açma', 'Planı eşik 250 ile kaydet (sürüm), eşiği 400 yap, sürümü yükle', 'Eşik 250\'ye döner, guide ve rezeke hacim aynı', async () => {
    await h.openStep(3); await page.click('#autoPrep'); await h.idle(); await h.sleep(2500); await h.settle();
    const a = await h.ev(() => ({ thr: document.getElementById('thr').value, vol: Math.round(Studio.S.resectedVolume || 0), pieces: Studio.S.result && Studio.S.result.pieces, bone: Studio.parts.bone.obj.geometry.attributes.position.count }));
    await page.click('#tab-pVer'); await page.fill('#verNote', 'esik250'); await page.click('#verSave'); await h.sleep(1500);
    await h.openStep(2); await h.setRange('#thr', 400); await h.sleep(500); await h.idle(); await h.settle();
    const b = await h.ev(() => ({ thr: document.getElementById('thr').value, vol: Math.round(Studio.S.resectedVolume || 0), pieces: Studio.S.result && Studio.S.result.pieces, crit: Studio.S.crit }));
    await page.click('#tab-pVer'); await h.sleep(300);
    await page.locator('#verList li', { hasText: 'esik250' }).locator('button').first().click(); await h.sleep(1500); await h.idle(); await h.sleep(800); await h.idle(); await h.settle();
    const c = await h.ev(() => ({ thr: document.getElementById('thr').value, vol: Math.round(Studio.S.resectedVolume || 0), pieces: Studio.S.result && Studio.S.result.pieces, bone: Studio.parts.bone.obj.geometry.attributes.position.count }));
    return { pass: c.thr === '250' && Math.abs(c.vol - a.vol) <= a.vol * 0.01 && c.pieces === a.pieces, actual: `kayıt ${JSON.stringify(a)}; eşik 400: ${JSON.stringify(b)}; sürüm yüklenince ${JSON.stringify(c)}` };
  });

  // ---------- C3: resection near the ramus > 35 mm ----------
  await h.run('C3', '3 · Rezeksiyon', 'Ramusa yakın bölge seç (sol gövde, açıya yakın), sınır −20…20 mm + pay 3 (46 mm) → "Kesileri sınıra göre koy"', 'Kritik kontrol yoksa guide tek parça ve yuvalar/kovanlar guide üzerinde; değilse açık uyarı', async () => {
    await h.openStep(3); await page.click('#planReset'); await h.idle();
    await page.click('.presets button[data-view="ant"]'); await h.sleep(800);
    const pts = await h.hits('bone', 10);
    const r = await page.$eval('#stage', e => e.getBoundingClientRect().toJSON());
    const band = pts.filter(p => p.y > r.top + r.height * 0.5 && p.y < r.top + r.height * 0.8).sort((a, b) => a.x - b.x);
    const p = band[Math.floor(band.length * 0.1)];
    await page.click('#pickAnchor'); await h.click3d(p.x, p.y); await h.sleep(800); await h.idle();
    await page.evaluate(() => { const d = document.getElementById('secBounds'); if (!d.open) d.querySelector('summary').click(); });
    await h.setRange('#l_from', -20); await h.setRange('#l_to', 20); await h.setRange('#l_margin', 3);
    await page.click('#suggest'); await h.sleep(500); await h.idle();
    if (await page.isEnabled('#guideMake')) { await page.click('#guideMake'); await h.idle(); }
    await page.click('#resRemove').catch(() => {}); await h.idle();
    const s = await st(), stat = await page.textContent('#guideStat');
    const scr = await h.ev(() => Studio.S.screws.map(x => x ? [x.u, x.v] : null));
    const warn = await h.ev(() => [...document.querySelectorAll('#checks li')].map(l => l.className.replace('checks', '').trim().slice(0, 5) + ': ' + l.textContent.trim().slice(0, 100)));
    const ev = await h.shot('C3_ramus_46mm');
    // the fit ladder may choose two guides, one per cut on its own axis, near the angle: with no critical check that
    // layout is as valid as one piece, provided each guide carries a screw
    const lay = await h.ev(() => ({ split: Studio.S.g.split, parts: [...new Set(Studio.S.screws.filter(Boolean).map(x => x.part))].length }));
    const ok = s.crit ? true : lay.split === 2 ? s.pieces === 2 && lay.parts === 2 : s.pieces === 1;
    return { pass: ok && !s.nullScrews, actual: `anchor ${JSON.stringify(p.p.map(x => +x.toFixed(1)))}; kesiler ${JSON.stringify(s.planes.map(x => x.off))}, L=${s.L}, parça ${s.pieces}, vidalar ${JSON.stringify(scr)}, kritik ${s.crit}; "${stat}"; kontroller: ${warn.join(' | ')}`, evidence: ev };
  });
  await h.run('C3b', '3 · Rezeksiyon', 'Aynı geniş rezeksiyonda (46 mm) iki parça guide', 'İki parça; kalan kritik varsa açıkça listelenir', async () => {
    await h.openStep(5); await seg('g_split', '1'); await h.sleep(500); await h.idle();
    const s = await st();
    const ev = await h.shot('C3b_ramus_iki_guide');
    await seg('g_split', '0'); await h.idle();
    return { pass: s.pieces === 2 && (!s.crit || s.critList.length > 0), actual: `parça ${s.pieces}, kritik ${s.crit} ${s.critList.join(' | ')}`, evidence: ev };
  });

  // ---------- C4: condyle-included resection ----------
  await h.run('C4', '3 · Rezeksiyon', 'Örnek vakada Otomatik planla → Rezeksiyon tipi "Kondil dahil, sağ" → fibula örneği', 'Rezeke hacim büyür; fibula greft boyu artar; kontroller tutarlı', async () => {
    await h.openStep(3); await page.click('#planReset'); await h.idle();
    await page.click('#autoPrep'); await h.idle();
    const v0 = await h.ev(() => Math.round(Studio.S.resectedVolume || 0));
    await page.selectOption('#resType', 'R'); await h.sleep(600); await h.idle();
    const v1 = await h.ev(() => Math.round(Studio.S.resectedVolume || 0)), hint = await page.$eval('#resTypeHint', e => !e.hidden);
    await h.openStep(1); await page.click('#fibSample'); await h.idle(); await page.click('#scM').catch(() => {});
    const segs = await h.ev(() => Fibula.state().last ? Fibula.state().last.segs.map(s => Math.round(s.L)) : null);
    const s = await st();
    const ev = await h.shot('C4_kondil_dahil');
    h.c4 = { v0, v1, segs };
    return { pass: v1 > v0 * 2 && segs && segs.reduce((a, b) => a + b, 0) > 40, actual: `rezeke hacim ${v0} → ${v1} mm³, ipucu görünür=${hint}; fibula segmentleri ${JSON.stringify(segs)} mm; kritik ${s.crit} ${s.critList.join(' | ')}`, evidence: ev };
  });
  await h.run('C4b', 'Yeniden açma', 'Kondil dahil plan (fibula ile) kaydedilir, sayfa yenilenir', 'Rezeksiyon, fibula segmentleri ve hacim aynen geri gelir', async () => {
    await h.sleep(3000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await h.waitReady(); await h.sleep(3000); await h.idle(); await h.sleep(1500); await h.idle();
    const v = await h.ev(() => Math.round(Studio.S.resectedVolume || 0));
    const segs = await h.ev(() => Fibula.state().last ? Fibula.state().last.segs.map(s => Math.round(s.L)) : null);
    const s = await st();
    return { pass: s.condyle === 'R' && Math.abs(v - h.c4.v1) <= h.c4.v1 * 0.05 && JSON.stringify(segs) === JSON.stringify(h.c4.segs), actual: `kondil=${s.condyle}; hacim ${h.c4.v1} → ${v}; segmentler ${JSON.stringify(h.c4.segs)} → ${JSON.stringify(segs)}; kritik ${s.crit}; durum "${s.pill}"`, evidence: await h.shot('C4b_kondil_yeniden') };
  });

  // ---------- C5: very short segment ----------
  await h.run('C5', '4 · Fibula', 'Dar rezeksiyon (−2…2, pay 3 → 10 mm) ve 3 segment', 'Kısa segmentler kritik olarak işaretlenir, onay engellenir', async () => {
    await h.openStep(1); await page.click('#sampleM'); await h.idle();
    await page.click('#fibSample'); await h.idle(); await page.click('#scM').catch(() => {});
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    await page.evaluate(() => { const d = document.getElementById('secBounds'); if (!d.open) d.querySelector('summary').click(); });
    await h.setRange('#l_from', -2); await h.setRange('#l_to', 2); await h.setRange('#l_margin', 3);
    await page.click('#suggest'); await h.sleep(500); await h.idle();
    await h.openStep(4); await page.click('#fibN button[data-n="3"]'); await h.idle();
    const segs = await h.ev(() => (Fibula.state().last ? Fibula.state().last.segs : []).map(s => +s.L.toFixed(1)));
    const fc = await h.ev(() => [...document.querySelectorAll('#fibChecks li')].map(l => l.textContent.trim()));
    const appr = await page.$eval('#fibApprove', b => b.disabled).catch(() => null);
    const ev = await h.shot('C5_kisa_segment');
    return { pass: fc.some(t => /en az 20 mm|15 mm altı segment/.test(t)) && appr === true, actual: `segmentler ${JSON.stringify(segs)}; kontroller ${fc.join(' | ')}; fibApprove disabled=${appr}`, evidence: ev };
  });

  // ---------- C9: re-check of earlier audit findings ----------
  await h.run('C9.1', 'Yeniden kontrol (D2 C1/C2)', 'Geniş sınır −30…30 + pay 10 → "Kesileri sınıra göre koy" (1 ve 2 vida/taraf)', 'null vida yok; yuva/kovan guide dışındaysa kritik kontrol', async () => {
    await h.openStep(1); await page.click('#sampleM'); await h.idle();
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    const out = [];
    for (const per of ['1', '2']) {
      await seg('perSide', per); await h.idle();
      await page.evaluate(() => { const d = document.getElementById('secBounds'); if (!d.open) d.querySelector('summary').click(); });
      await h.setRange('#l_from', -30); await h.setRange('#l_to', 30); await h.setRange('#l_margin', 10);
      await page.click('#suggest'); await h.sleep(500); await h.idle();
      const s = await st(), scr = await h.ev(() => Studio.S.screws.map(x => x ? x.u : null));
      out.push({ per, planes: s.planes.map(p => p.off), L: s.L, screws: scr, pieces: s.pieces, crit: s.crit, list: s.critList });
    }
    const ev = await h.shot('C9.1_genis');
    const ok = out.every(o => !o.screws.includes(null) && (o.crit > 0 || o.pieces === 1));
    return { pass: ok, actual: JSON.stringify(out), evidence: ev };
  });
  await h.run('C9.2', 'Yeniden kontrol (D2 M1)', '"Bölgeyi modelde seç" sonra lezyon Fırçası; 3B kemiğe tıkla', 'Guide merkezi taşınmaz (seçim modu fırçayla kapanır)', async () => {
    await h.openStep(3); await page.click('#planReset'); await h.idle(); await page.click('#autoPrep'); await h.idle();
    const a0 = await h.ev(() => Studio.S.anchor.p.toArray().map(x => +x.toFixed(2)));
    await page.click('#pickAnchor');
    await page.evaluate(() => { const d = document.getElementById('secLes'); if (!d.open) d.querySelector('summary').click(); });
    await page.click('#lesPaint button[data-t="paint"]'); await h.sleep(300);
    const mode = await h.ev(() => Studio.S.mode);
    const pts = await h.hits('bone', 20); const p = pts[Math.floor(pts.length * 0.3)];
    await h.click3d(p.x, p.y); await h.sleep(800); await h.idle();
    const a1 = await h.ev(() => Studio.S.anchor.p.toArray().map(x => +x.toFixed(2)));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    return { pass: JSON.stringify(a0) === JSON.stringify(a1), actual: `fırça açıkken S.mode=${mode}; anchor ${JSON.stringify(a0)} → ${JSON.stringify(a1)}` };
  });
  await h.run('C9.3', 'Yeniden kontrol (D2 L6)', 'Planlı vakada mandibula "Örnek veri"ye yeniden bas (yeni veri yükleme)', 'Kaydedilmemiş plan için onay sorulur', async () => {
    const before = h.log.filter(l => /dialog:confirm/.test(l)).length;
    await h.openStep(1); await page.click('#sampleM'); await h.idle();
    const after = h.log.filter(l => /dialog:confirm/.test(l)).length;
    const s = await st();
    return { pass: after > before, actual: `onay diyaloğu sayısı ${before} → ${after}; yükleme sonrası kesi ${s.planes.length}` };
  });

  // ---------- C6: server offline, then production STL ----------
  await h.run('C6', '8 · Teslim (sunucu kapalı)', 'Sunucuyu durdur, "Üret" (üretim STL)', 'Açık hata mesajı, meşgul katman kapanır, uygulama çalışmaya devam eder', async () => {
    if (!process.env.SERVER_PID) return { pass: null, actual: 'SERVER_PID verilmedi, atlandı' };
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    process.kill(+process.env.SERVER_PID, 'SIGTERM'); await h.sleep(1500);
    await h.openStep(8);
    const t = Date.now();
    await page.click('#expSrv'); await h.sleep(500); const ok = await h.idle(200000);
    const m = await page.textContent('#prodMsg'), save = await page.textContent('#saveState');
    // a plan edit while offline: does the save indicator say so?
    await h.openStep(5); await h.setRange('#g_W', 24); await h.sleep(4000); await h.idle();
    const save2 = await page.textContent('#saveState');
    const ev = await h.shot('C6_sunucu_kapali');
    // restart the server for later runs
    if (process.env.SERVER_CMD) { const p = spawn('bash', ['-c', process.env.SERVER_CMD], { detached: true, stdio: 'ignore' }); p.unref(); fs.writeFileSync(path.join(h.SCRATCH, 'server.pid'), String(p.pid)); await h.sleep(2500); }
    return { pass: ok && m.length > 0 && !/hazır/.test(m), actual: `${Date.now() - t} ms; mesaj "${m}"; kayıt durumu "${save}" → düzenleme sonrası "${save2}"`, evidence: ev };
  });
  await h.done();
})();
