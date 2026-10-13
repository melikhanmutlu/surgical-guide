// Senaryo A1 · Örnek vaka, adım 1-8 sırayla (gerçek fare/klavye olaylarıyla)
'use strict';
const H = require('./lib');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

(async () => {
  const h = await H.start({ name: 'A1_flow', dir: 'A' });
  const { page } = h;
  const st = () => h.state();
  const seg = async (selId, v) => page.click(`#${selId} + .seg button[data-v="${v}"]`);

  await h.run('A1.0', '0 · Açılış', 'Sayfayı aç; örnek mandibula kendiliğinden yüklenir; /health', 'Model görünür, konsol temiz, /health 200', async () => {
    const t = Date.now();
    const r = await page.request.get(h.BASE + '/health');
    await h.goto();
    const ms = Date.now() - t, s = await st(), mem = await h.mem();
    return { pass: r.status() === 200 && s.kind === 'mandible', actual: `/health ${r.status()}, hazır ${ms} ms, kind=${s.kind}, heap ${mem && mem.used} MB`, evidence: await h.shot('A1.0_acilis') };
  });

  // ---------- step 1 ----------
  await h.run('A1.1', '1 · Vaka', 'Örnek veri (mandibula) + fibula örneği, vaka adı', 'Mandibula ve fibula yüklü, vaka adı başlıkta', async () => {
    await h.openStep(1);
    await page.click('#sampleM'); await h.idle();
    await page.click('#fibSample'); await h.idle();
    const nameDisabled = await page.$eval('#caseName', e => e.disabled);
    if (!nameDisabled) { await page.fill('#caseName', 'E2E örnek vaka'); await page.press('#caseName', 'Enter'); }
    await h.sleep(500);
    h.viewAfterFib = await h.ev(() => document.querySelector('#sceneSeg [aria-pressed="true"], #sceneSeg .on') ? document.querySelector('#sceneSeg [aria-pressed="true"], #sceneSeg .on').id : (Fibula.view ? Fibula.view() : '?'));
    await h.shot('A1.1_fibula_gorunumu');
    // mandible view for the mandible steps (the fibula sample leaves the 3D view on the leg)
    await page.click('#scM'); await h.sleep(500); await h.idle();
    const s = await st();
    const fibOn = await h.ev(() => !!(window.Fibula && Fibula.active && Fibula.active()));
    const title = await page.textContent('#caseTitle');
    return { pass: s.kind === 'mandible' && fibOn, actual: `kind=${s.kind}, fibula aktif=${fibOn}, başlık="${title}", caseName disabled=${nameDisabled}, fibula yüklenince sahne=${h.viewAfterFib}`, evidence: await h.shot('A1.1_vaka') };
  });

  // ---------- step 2 ----------
  await h.run('A1.2a', '2 · Anatomi', 'Kemik eşiğini klavyeyle 250 → 300 HU (ArrowRight ×5)', 'Eşik 300, kemik yeniden segmente edilir, hata yok', async () => {
    await h.openStep(2);
    const v0 = await h.ev(() => Studio.parts.bone.obj.geometry.attributes.position.count);
    await page.focus('#thr');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.dispatchEvent('#thr', 'change');
    await h.sleep(300); await h.idle();
    const thr = await page.inputValue('#thr'), out = await page.textContent('#thrO');
    const v1 = await h.ev(() => Studio.parts.bone.obj.geometry.attributes.position.count);
    return { pass: thr === '300' && v1 !== v0, actual: `thr=${thr} (${out}), kemik tepe sayısı ${v0} → ${v1}`, evidence: await h.shot('A1.2a_esik300') };
  });
  await h.run('A1.2b', '2 · Anatomi', 'Eşiği 250\'ye geri al (sayısal kutuya 250 yaz + Enter)', 'Eşik 250', async () => {
    const num = page.locator('#thrBox input[data-num], #thrBox input[type=number]').first();
    if (await num.count()) { await num.fill('250'); await num.press('Enter'); } else await h.setRange('#thr', 250);
    await h.sleep(300); await h.idle();
    const thr = await page.inputValue('#thr');
    return { pass: thr === '250', actual: `thr=${thr}` };
  });
  await h.run('A1.2c', '2 · Anatomi', 'Segmentasyon düzeltme: Fırça ile 3B kemiğe 3 tık, sonra Silgi, Esc', 'SegEdit.edited() true, voksel sayısı değişir', async () => {
    const pts = await h.hits('bone', 24);
    if (!pts.length) return { pass: false, actual: 'kemik ekranda bulunamadı' };
    const before = await h.ev(() => { let c = 0; const m = Studio.S.mask; for (let i = 0; i < m.length; i++) c += m[i] ? 1 : 0; return c; });
    await page.evaluate(() => { const d = document.querySelector('#segEdit details'); if (d && !d.open) d.querySelector('summary').click(); });
    await h.sleep(300);
    await page.click('#segEdit button[data-t="brush"]');
    const p = pts[Math.floor(pts.length / 2)];
    for (let i = 0; i < 3; i++) { await h.click3d(p.x + i * 6, p.y); await h.sleep(300); }
    await h.idle();
    const mid = await h.ev(() => { let c = 0; const m = Studio.S.mask; for (let i = 0; i < m.length; i++) c += m[i] ? 1 : 0; return c; });
    await page.click('#segEdit button[data-t="erase"]');
    await h.click3d(p.x, p.y); await h.sleep(300); await h.idle();
    const after = await h.ev(() => { let c = 0; const m = Studio.S.mask; for (let i = 0; i < m.length; i++) c += m[i] ? 1 : 0; return c; });
    await page.keyboard.press('Escape');
    const edited = await h.ev(() => !!(window.SegEdit && SegEdit.edited && SegEdit.edited()));
    const ev = await h.shot('A1.2c_segedit');
    return { pass: edited && (mid !== before || after !== before), actual: `maske voksel ${before} → fırça ${mid} → silgi ${after}; edited=${edited}`, evidence: ev };
  });
  await h.run('A1.2d', '2 · Anatomi', '"Tüm düzeltmeleri geri al" + katman göster/gizle + katman ekle', 'Düzeltmeler sıfırlanır; katman listesi değişir', async () => {
    const b = page.locator('#seReset');
    if (await b.isEnabled()) await b.click();
    await h.idle();
    const edited = await h.ev(() => !!(SegEdit.edited && SegEdit.edited()));
    await page.evaluate(() => { const d = document.getElementById('secLayers'); if (!d.open) d.querySelector('summary').click(); });
    const n0 = await page.locator('#layerBox [data-on]').count();
    await page.selectOption('#layerKind', { index: 1 }).catch(() => {});
    await page.click('#layerAdd'); await h.idle();
    const n1 = await page.locator('#layerBox [data-on]').count();
    const cb = page.locator('#layerBox [data-on]').first(); await cb.click(); await h.idle(); await cb.click(); await h.idle();
    return { pass: !edited && n1 === n0 + 1, actual: `düzeltme kaldı=${edited}, katman ${n0} → ${n1}`, evidence: await h.shot('A1.2d_katman') };
  });

  // ---------- step 3 ----------
  await h.run('A1.3a', '3 · Rezeksiyon', '"Otomatik planla" (örnek vakada hazır bölge)', '2 kesi, rezeke parça, tek parça guide, 4 vida, kritik yok', async () => {
    await h.openStep(3);
    const t = Date.now();
    await page.click('#autoPrep'); await h.idle();
    const s = await st(), stat = await page.textContent('#guideStat');
    h.autoMs = Date.now() - t;
    h.critAfterAuto = s;
    return { pass: s.planes.length === 2 && s.guideOn && s.pieces === 1 && s.screws === 4 && !s.critList.some(c => !/Fibula/.test(c)), actual: `${Date.now() - t} ms; kesiler ${JSON.stringify(s.planes.map(p => p.off))}, vida ${s.screws}, parça ${s.pieces}, kritik ${s.crit}; "${stat}"`, evidence: await h.shot('A1.3a_otoplan') };
  });
  await h.run('A1.3a2', '3/4 · Rezeksiyon+Fibula', 'Kutudan çıktığı gibi: örnek mandibula + örnek fibula + Otomatik planla', 'Kritik kontrol yok (onaylanabilir örnek plan)', async () => {
    const s = h.critAfterAuto || await st(); const n = await page.locator('#fibRows tr').count();
    return { pass: !s.crit, actual: `fibula segment sayısı ${n}; kritik ${s.crit}: ${s.critList.join(' | ')}`, evidence: 'kanit/A/A1.3a_otoplan.jpg' };
  });
  const dragCut = async (id, mode, du) => h.run(id, '3 · Rezeksiyon', `Kesi 1'i 3B modelde fareyle sürükle (${mode === 'bone' ? 'Kemik boyunca' : 'Guide ekseni'}, ~${du} mm)`, 'Kesi konumu değişir, onayı kalkar, geçmişe yazılır, guide yeniden üretilir', async () => {
    await page.keyboard.press('Escape'); await h.sleep(200);
    await page.evaluate(m => { document.getElementById('dragAxis').value = m; }, mode);
    const g = await h.ev(du => { const S = Studio.S, pw = Studio.planesWorld()[0], f = Studio.frameAxes(), v = x => [x.x, x.y, x.z]; return { a: v(pw.p.clone().add(f.n.clone().multiplyScalar(6))), b: v(S.anchor.p.clone().add(f.u.clone().multiplyScalar(pw.off + du))), off: pw.off, hist: CaseStore.history.list.length }; }, du);
    const vis = await page.isVisible('#dragAxis').catch(() => false);
    const A = await h.proj(g.a), B = await h.proj(g.b);
    await h.drag3d(A, B, 14);
    await h.sleep(600); await h.idle();
    const s = await st();
    const after = await h.ev(() => ({ off: Studio.S.planes[0].off, yaw: Studio.S.planes[0].yaw, ok: Studio.S.planes[0].ok, hist: CaseStore.history.list.slice(-1)[0].label, n: CaseStore.history.list.length }));
    const ev = await h.shot(id + '_drag_' + mode);
    return { pass: Math.abs(after.off - g.off) >= 1 && s.pieces >= 1, actual: `dragAxis görünür=${vis}; off ${g.off} → ${after.off}, yaw ${after.yaw}, onay=${after.ok}; geçmiş "${after.hist}"; parça ${s.pieces}, kritik ${s.crit} ${s.critList.join(' | ')}`, evidence: ev };
  });
  await dragCut('A1.3b', 'bone', -4);
  await dragCut('A1.3c', 'guide', 3);
  await h.run('A1.3d', '3 · Rezeksiyon', 'Kesi 2 yatay açısını slider ile klavyeden değiştir (ArrowRight ×10)', 'yaw değişir, guide yeniden üretilir', async () => {
    await page.click('#plList button[data-s="p1"]'); await h.sleep(200);
    await page.focus('#f_yaw'); for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await h.sleep(800); await h.idle();
    const y = await h.ev(() => Studio.S.planes[1].yaw), s = await st();
    await page.keyboard.press('Escape');
    return { pass: y === 5, actual: `yaw=${y}, parça ${s.pieces}, kritik ${s.crit}`, evidence: await h.shot('A1.3d_yaw') };
  });
  await h.run('A1.3e', '3 · Rezeksiyon', 'Ctrl+Z ×2 (yaw ve sürükleme geri) ve Ctrl+Y', 'Geri alma ve yineleme kesileri geri getirir', async () => {
    const o0 = await h.ev(() => Studio.S.planes.map(p => [p.off, p.yaw]));
    await page.click('#stage', { position: { x: 30, y: 30 } }).catch(() => {});
    await page.keyboard.press('Control+z'); await h.sleep(800); await h.idle();
    await page.keyboard.press('Control+z'); await h.sleep(800); await h.idle();
    const o1 = await h.ev(() => Studio.S.planes.map(p => [p.off, p.yaw]));
    await page.keyboard.press('Control+y'); await h.sleep(800); await h.idle();
    const o2 = await h.ev(() => Studio.S.planes.map(p => [p.off, p.yaw]));
    return { pass: JSON.stringify(o1) !== JSON.stringify(o0) && JSON.stringify(o2) !== JSON.stringify(o1), actual: `kesiler ${JSON.stringify(o0)} → undo×2 ${JSON.stringify(o1)} → redo ${JSON.stringify(o2)}` };
  });
  await h.run('A1.3f', '3 · Rezeksiyon', '"Sınırları sayıyla gir": −8/8 → "Kesileri sınıra göre koy"; rezeke parça göster/gizle', 'Kesiler ±11 mm, parça tek, rezeke gizle/göster çalışır', async () => {
    await h.openStep(3);
    await page.evaluate(() => { const d = document.getElementById('secBounds'); if (!d.open) d.querySelector('summary').click(); });
    await page.fill('#lesCtl input[data-num]#l_from, #l_from', '-8').catch(() => {});
    await h.setRange('#l_from', -8); await h.setRange('#l_to', 8); await h.setRange('#l_margin', 3);
    await page.click('#suggest'); await h.sleep(500); await h.idle();
    const s = await st();
    await page.click('#resRemove'); await h.idle(); const vis1 = await h.ev(() => Studio.parts.resected && Studio.parts.resected.visible);
    await page.click('#resRemove'); await h.idle(); const vis2 = await h.ev(() => Studio.parts.resected && Studio.parts.resected.visible);
    return { pass: JSON.stringify(s.planes.map(p => p.off)) === '[-11,11]' && s.pieces === 1 && vis1 !== vis2, actual: `kesiler ${JSON.stringify(s.planes)}, parça ${s.pieces}, vida ${s.screws}, rezeke görünür ${vis1} → ${vis2}`, evidence: await h.shot('A1.3f_sinir') };
  });

  // ---------- step 5: guides ----------
  await h.run('A1.5a', '5 · Guide', 'Düzen: İki parça (segment düğmesi)', '2 parça, kritik yok', async () => {
    await h.openStep(5);
    await seg('g_split', '1'); await h.sleep(500); await h.idle();
    const s = await st();
    return { pass: s.split === 1 && s.pieces === 2 && !s.critList.some(c => !/Fibula/.test(c)), actual: `split=${s.split}, parça ${s.pieces}, kritik ${s.crit} ${s.critList.join(' | ')}`, evidence: await h.shot('A1.5a_iki_guide') };
  });
  await h.run('A1.5b', '5 · Guide', 'Düzen: Tek parça\'ya dön; guide uzunluğunu sayı kutusuna 50 yaz', '1 parça, L=50', async () => {
    await seg('g_split', '0'); await h.sleep(400); await h.idle();
    const num = page.locator('#gCtl input[data-num]').first();
    const ids = await h.ev(() => [...document.querySelectorAll('#gCtl input')].map(e => e.id + ':' + e.type).join(','));
    const box = page.locator('#gCtl input[type=number]').first();
    const L = page.locator('#g_L');
    // numeric twin is the input placed just before the range in the same .ctl
    const twin = page.locator('#g_L').locator('xpath=ancestor::div[contains(@class,"ctl")]//input[not(@type="range")]').first();
    if (await twin.count()) { await twin.fill('50'); await twin.press('Enter'); } else await h.setRange('#g_L', 50);
    await h.sleep(500); await h.idle();
    const s = await st();
    return { pass: s.split === 0 && s.pieces === 1 && s.L === 50, actual: `split=${s.split}, parça ${s.pieces}, L=${s.L}, kritik ${s.crit}`, evidence: await h.shot('A1.5b_tek_guide') };
  });
  await h.run('A1.5c', '5 · Guide', 'Köprü tarafı + / − ve renk haritası "Aralık"', 'Guide yeniden üretilir, hata yok', async () => {
    const side0 = await h.ev(() => Studio.S.g.side);
    const pressed = await page.$eval('#g_side + .seg button[aria-pressed="true"]', b => b.dataset.v).catch(() => null);
    await seg('g_side', side0 === 1 ? '-1' : '1'); await h.idle();
    const side1 = await h.ev(() => Studio.S.g.side);
    await seg('g_side', String(side0)); await h.idle();
    await seg('fitMap', 'gap').catch(() => {}); await h.idle();
    const ev = await h.shot('A1.5c_fitmap');
    await seg('fitMap', 'none').catch(() => {});
    const s = await st();
    return { pass: side1 !== side0 && String(side0) === pressed, actual: `g.side başlangıç ${side0} (basılı düğme ${pressed}) → ${side1}; parça ${s.pieces}`, evidence: ev };
  });

  // ---------- step 6: screws ----------
  await h.run('A1.6a', '6 · Vidalar', '"Vida" + guide üzerine tıkla (vida ekle)', 'Vida sayısı +1', async () => {
    await h.openStep(6);
    const n0 = (await st()).screws;
    await page.click('#addScrew'); await h.sleep(200);
    const badge = await page.textContent('#modeBadge');
    const gh = await h.hits('guide', 10);
    const P = gh[Math.floor(gh.length * 0.8)] || { x: 0, y: 0 };
    await h.click3d(P.x, P.y); await h.sleep(500); await h.idle();
    const s = await st();
    return { pass: s.screws === n0 + 1, actual: `rozet "${badge}"; vida ${n0} → ${s.screws}, kritik ${s.crit} ${s.critList.join(' | ')}`, evidence: await h.shot('A1.6a_vida_ekle') };
  });
  await h.run('A1.6b', '6 · Vidalar', 'Vida 1\'i 3B\'de fareyle 3 mm dışa sürükle, sonra eğimi slider ile değiştir', 'u/v değişir', async () => {
    const i = 0;   // an outer screw: it sits over remaining bone (the new one may be over the removed segment)
    await page.keyboard.press('Escape'); await h.sleep(200);
    const w = await h.ev(i => { const s = Studio.screwWorld(Studio.S.screws[i]); const e = s.entry || Studio.S.anchor.p; return { e: [e.x, e.y, e.z], u: Studio.S.screws[i].u }; }, i);
    const f = await h.ev(() => { const a = Studio.frameAxes().u; return [a.x, a.y, a.z]; });
    const A = await h.proj(w.e), B = await h.proj([w.e[0] - 3 * f[0], w.e[1] - 3 * f[1], w.e[2] - 3 * f[2]]);
    await h.drag3d(A, B, 10); await h.sleep(500); await h.idle();
    const u1 = await h.ev(i => Studio.S.screws[i].u, i);
    await h.openStep(6); await page.click(`#scList button[data-s="s${i}"]`).catch(() => {}); await h.sleep(300);
    if (!(await page.isVisible('#f_tiltU'))) await page.click(`#scList button[data-s="s${i}"]`); await h.sleep(300);
    await page.focus('#f_tiltU'); for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowRight');
    await h.sleep(700); await h.idle();
    const t = await h.ev(i => Studio.S.screws[i].tiltU, i);
    return { pass: u1 !== w.u && t !== 0, actual: `u ${w.u} → ${u1} (sürükleme), tiltU → ${t}`, evidence: await h.shot('A1.6b_vida_tasi') };
  });
  await h.run('A1.6c', '6 · Vidalar', 'Seçili vidayı "Vidayı sil"', 'Vida sayısı −1', async () => {
    const n0 = (await st()).screws;
    await h.openStep(6);
    if (!(await page.isVisible('#delEl'))) await page.click(`#scList button[data-s="s${n0 - 1}"]`); await h.sleep(300);
    await page.click('#delEl'); await h.sleep(400); await h.idle();
    const s = await st();
    return { pass: s.screws === n0 - 1 && !s.nullScrews, actual: `vida ${n0} → ${s.screws}, null vida ${s.nullScrews}, kritik ${s.crit}` };
  });
  await h.run('A1.6d', '3 · Guide', 'Taraf başına vida 1 ↔ 2', '2 / 4 vida, null yok', async () => {
    await h.openStep(3);
    await seg('perSide', '1'); await h.sleep(400); await h.idle(); const a = await st();
    await seg('perSide', '2'); await h.sleep(400); await h.idle(); const b = await st();
    return { pass: a.screws === 2 && b.screws === 4 && !a.nullScrews && !b.nullScrews, actual: `1/taraf → ${a.screws} vida (parça ${a.pieces}); 2/taraf → ${b.screws} vida (parça ${b.pieces}), kritik ${b.crit}` };
  });

  // ---------- step 4: fibula ----------
  for (const n of [3, 2, 1]) {
    await h.run('A1.4.' + n, '4 · Fibula', `Segment sayısı ${n}`, `${n} segment satırı, sonuç tablosu dolu`, async () => {
      await h.openStep(4);
      await page.click(`#fibN button[data-n="${n}"]`); await h.sleep(500); await h.idle();
      const rows = await page.locator('#fibRows tr').count();
      const checks = await h.ev(() => [...document.querySelectorAll('#fibChecks li')].map(l => l.className.replace('checks', '').trim() + ': ' + l.textContent.trim()).slice(0, 6));
      const ev = await h.shot(`A1.4.${n}_fibula_${n}seg`);
      return { pass: rows === n, actual: `satır ${rows}; ${checks.join(' | ')}`, evidence: ev };
    });
  }
  await h.run('A1.4.4', '4 · Fibula', '"Kesileri öner" (1 segmentte), sahne M/F/S', 'Hata yok, görünüm değişir', async () => {
    await page.click('#fibOpt'); await h.idle();
    for (const b of ['scF', 'scS', 'scM']) { if (await page.isVisible('#' + b)) { await page.click('#' + b); await h.sleep(600); await h.idle(); if (b !== 'scM') await h.shot('A1.4.4_' + b); } }
    const rows = await page.locator('#fibRows tr').count();
    return { pass: rows === 1, actual: `segment satırı ${rows}` };
  });
  await h.run('A1.4.5', '4 · İmplant', 'Dental implant: "Otomatik yerleştir"', 'En az 1 implant, tablo', async () => {
    await page.evaluate(() => { const d = document.getElementById('secImpl'); if (!d.open) d.querySelector('summary').click(); });
    await h.sleep(300);
    if (!(await page.isVisible('#imAuto'))) return { pass: false, actual: 'imAuto görünmüyor' };
    await page.click('#imAuto'); await h.sleep(800); await h.idle();
    const msg = await page.textContent('#imMsg').catch(() => ''), n = await page.locator('#imList button').count();
    const ev = await h.shot('A1.4.5_implant');
    return { pass: n >= 1, actual: `${n} implant; "${msg}"`, evidence: ev };
  });
  await h.run('A1.4.6', '4 · İmplant', '"İmplant ekle" (+) ve sil', 'Sayı +1 / −1', async () => {
    const n0 = await page.locator('#imList button').count();
    await page.click('#imAdd'); await h.idle(); const n1 = await page.locator('#imList button').count();
    await page.click('#imDel'); await h.idle(); const n2 = await page.locator('#imList button').count();
    return { pass: n1 === n0 + 1 && n2 === n0, actual: `${n0} → ${n1} → ${n2}` };
  });

  // ---------- plate (step 5) ----------
  await h.run('A1.5d', '5 · Plak', '"Plak planla" + "Vidaları plağa hizala"', 'Plak özeti (uzunluk, delik) görünür', async () => {
    await h.openStep(5);
    await page.evaluate(() => { const d = document.getElementById('secPlate'); if (!d.open) d.querySelector('summary').click(); });
    await page.check('#plOn'); await h.sleep(800); await h.idle();
    const sum = await page.textContent('#plSum').catch(() => '');
    const dis = await page.$eval('#plScrews', b => b.disabled).catch(() => true);
    if (!dis) { await page.click('#plScrews'); await h.idle(); }
    const msg = await page.textContent('#plMsg').catch(() => '');
    return { pass: /delik/.test(sum), actual: `özet "${sum.replace(/\s+/g, ' ').slice(0, 160)}"; mesaj "${(msg || '').slice(0, 120)}"`, evidence: await h.shot('A1.5d_plak') };
  });

  // ---------- step 7: review & approval ----------
  await h.run('A1.7a', '7 · Onay', 'Cerrah adı + tüm öğe onayları + fibula + mühendis teknik onay + cerrah klinik onay', 'Paket düğmesi etkin, durum "Onaylı plan"', async () => {
    await h.openStep(7);
    await page.fill('#surgeon', 'Dr. E2E Cerrah'); await page.press('#surgeon', 'Tab');
    // approve each pending row (re-query after each click: the list re-renders)
    for (let k = 0; k < 30; k++) {
      const b = page.locator('#appr button[data-ap]', { hasText: 'Onayla' }).first();
      if (!(await b.count())) break; await b.click(); await h.sleep(250); await h.idle(30000, 300);
    }
    const msgItems = await page.textContent('#apprMsg');
    await page.fill('#au_eng_n', 'Müh. E2E');
    await page.click('#auditBox button[data-a="onay"][data-r="eng"]'); await h.sleep(300);
    const sur = page.locator('#auditBox button[data-a="onay"][data-r="sur"]');
    if (await sur.count()) await sur.click(); await h.sleep(500); await h.idle();
    const s = await st(), zip = await page.$eval('#expZip', b => !b.disabled), au = await page.textContent('#auditBox');
    return { pass: zip && /Onaylı/.test(s.pill || ''), actual: `paket etkin=${zip}, durum "${s.pill}", kritik ${s.crit}, apprMsg "${msgItems}", audit "${au.replace(/\s+/g, ' ').slice(0, 200)}"`, evidence: await h.shot('A1.7a_onay') };
  });

  // ---------- step 8: export ----------
  const dl = async (sel, name) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click(sel)]);
    const p = path.join(h.outDir, name || d.suggestedFilename()); await d.saveAs(p); return p;
  };
  await h.run('A1.8a', '8 · Teslim', '"Üret" (sunucuda üretim STL\'i, /guide)', 'Su geçirmez, 1 parça', async () => {
    await h.openStep(8);
    const t = Date.now();
    await page.click('#expSrv'); await h.sleep(500); await h.idle(300000);
    const m = await page.textContent('#prodMsg');
    return { pass: /su geçirmez/.test(m) && !/DEĞİL/.test(m) && /1 parça/.test(m), actual: `${Date.now() - t} ms: "${m}"`, evidence: await h.shot('A1.8a_uretim') };
  });
  let zipPath = null;
  await h.run('A1.8b', '8 · Teslim', 'Üretim paketi (zip) indir, içeriği listele', 'guide_uretim.stl, plan.json, cerrahi_rapor.pdf, fibula ve plak dosyaları', async () => {
    zipPath = await dl('#expZip', 'A_guide_paketi.zip');
    const list = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n');
    const need = ['guide_uretim.stl', 'guide_onizleme.stl', 'kemik_kalan.stl', 'kemik_tam.stl', 'rezeke_parca.stl', 'plan.json', 'rapor.html', 'cerrahi_rapor.pdf'];
    const miss = need.filter(f => !list.includes(f));
    fs.writeFileSync(path.join(h.outDir, 'A_guide_paketi.list.txt'), list.join('\n'));
    return { pass: !miss.length, actual: `${list.length} dosya: ${list.join(', ')}${miss.length ? ' · EKSİK: ' + miss.join(',') : ''}`, evidence: path.relative(H.E2E, zipPath) };
  });
  await h.run('A1.8c', '8 · Teslim', 'Paketteki plan.json: içerik ve yeniden açılabilirlik', 'Geçerli JSON; kesiler/vidalar plandaki ile aynı', async () => {
    const txt = execFileSync('unzip', ['-p', zipPath, 'plan.json']).toString();
    let j = null; try { j = JSON.parse(txt); } catch (e) { return { pass: false, actual: 'JSON değil' }; }
    const s = await h.ev(() => ({ pl: Studio.S.planes.map(p => p.off), sc: Studio.S.screws.length, full: Object.keys(Studio.planOf()) }));
    const keys = Object.keys(j);
    const same = JSON.stringify((j.kesiler || j.planes || []).map(p => p.off)) === JSON.stringify(s.pl);
    const reopenable = ['source', 'anchor', 'planes', 'screws'].every(k => keys.includes(k));
    return { pass: same, actual: `anahtarlar: ${keys.join(',')}; kesiler aynı=${same}; planOf anahtarları: ${s.full.join(',')}; yeniden açılabilir (planOf biçimi)=${reopenable}` };
  });
  await h.run('A1.8d', '8 · Teslim', 'PDF raporu indir; açılır mı (pdfinfo/pdftotext)', '%PDF, ≥1 sayfa', async () => {
    const p = await dl('#expPdf', 'A_cerrahi_rapor.pdf');
    const head = fs.readFileSync(p).slice(0, 5).toString();
    let info = ''; try { info = execFileSync('pdfinfo', [p]).toString(); } catch (e) { info = 'pdfinfo yok: ' + e.message.slice(0, 80); }
    let txt = ''; try { txt = execFileSync('pdftotext', [p, '-']).toString(); } catch (e) { txt = ''; }
    const pages = (/Pages:\s+(\d+)/.exec(info) || [])[1];
    return { pass: head === '%PDF-' && +pages >= 1, actual: `başlık ${head}, sayfa ${pages}, boyut ${fs.statSync(p).size} B, metin katmanı ${txt.replace(/\f|\s/g, '').length} karakter`, evidence: path.relative(H.E2E, p) };
  });
  await h.run('A1.8e', '8 · Teslim', 'HTML rapor, 3MF, navigasyon, tek STL\'ler (Tam/Kalan/Rezeke/Guide)', 'Her biri indirilebilir, boş değil', async () => {
    const out = [];
    for (const [sel, nm] of [['#expRep', 'A_rapor.html'], ['#x3mf', null], ['#xNav', null], ['#oneStl button[data-one="full"]', null], ['#oneStl button[data-one="bone"]', null], ['#oneStl button[data-one="res"]', null], ['#oneStl button[data-one="guide"]', null]]) {
      try { const p = await dl(sel, nm ? nm : undefined); out.push(`${path.basename(p)} ${fs.statSync(p).size}B`); } catch (e) { out.push(`${sel}: HATA ${e.message.slice(0, 60)}`); }
    }
    return { pass: !out.some(x => /HATA/.test(x)), actual: out.join('; ') };
  });
  await h.run('A1.8f', '8 · Teslim', 'Onaydan sonra plan değişikliği (kesi 1 off +0,5) paketi kilitler; Ctrl+Z geri açar', 'Paket kilitlenir, Ctrl+Z ile tekrar açılır', async () => {
    await h.openStep(3); await page.click('#plList button[data-s="p0"]'); await page.focus('#f_off'); await page.keyboard.press('ArrowRight'); await h.sleep(800); await h.idle();
    const locked = await page.$eval('#expZip', b => b.disabled), pill = (await st()).pill;
    await page.keyboard.press('Escape'); await page.click('#stage', { position: { x: 30, y: 30 } }).catch(() => {});
    await page.keyboard.press('Control+z'); await h.sleep(1000); await h.idle();
    const un = await page.$eval('#expZip', b => b.disabled), pill2 = (await st()).pill;
    return { pass: locked && !un, actual: `değişiklik sonrası paket kilitli=${locked} (durum "${pill}"); Ctrl+Z sonrası kilitli=${un} (durum "${pill2}")` };
  });

  h.saveJSON('A1_plan_final.json', await h.ev(() => Studio.planOf()));
  await h.done();
})();
