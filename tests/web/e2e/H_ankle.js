// Senaryo H · malleol kırığı vaka tipi (2026-10-21), sentetik trimalleoler ayak bileği örneği, gerçek tarayıcı.
// H1 vaka tipi değişince adımlar doğru sırada (iki kez değiştirince de); H2 parçalar adlandırılır, 3B'de tıklayınca seçilir;
// H3 bilinen yer değiştirmenin tersiyle redüksiyon: çakışma yok, aralık kapanır; H4 aşırı redüksiyon kritik;
// H5 onaylar (redüksiyon + mühendis + cerrah) ve paket; H6 sayfa yenilenip plan açılınca parça konumları ve onay geri gelir;
// H7 çene tipine dönünce çene örneği, kondil işaretleri ve 8 adım geri gelir; H8 açılış (?ornek yok) malleol tipiyle anonim
// gerçek ayak bileği BT örneğini açar: tibia, fibula, talus bulunur, atel parça sayılmaz; H9 gerçek örnekte distal tibia ön
// yüzüne (talus kubbesinin 30 mm üstü) kesi guide'ı: gövde, yarık, iki K-teli, kama, kesi ve teller eklemden > 5 mm, sunucudan
// su geçirmez üretim STL'i, pakette guide dosyası üretim STL'inden; H10 (plan M6-M9) otomatik yerleşim, malzeme seçimi,
// guide ve kama tek tek onaylanır, paket cerceve.json'da her STL'in SHA-256'sı dosyanın kendisiyle aynı, rapor özetleri
// listeler, referans guide kıyası paneli görünür; H11 düzeltme önizlemesi: distal tibia ve talus kama açısı kadar döner;
// H12 düzeltilmiş tibiaya dış plak, sunucuda üretim STL'i, plak onayı ve pakette plak + vida listesi.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib');

(async () => {
  const h = await H.start({ name: 'H_ankle', dir: 'H' });
  const { page } = h;
  const REPO = process.env.REPO || path.resolve(__dirname, '../../..');
  const truth = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8')).truth;
  const order = () => page.evaluate(() => [...document.querySelectorAll('details.step[name="flow"]')].filter(d => !d.hidden).map(d => d.id));
  const pieces = () => page.waitForFunction(() => window.Ankle && Ankle.pieces().length > 0 && !(Studio.loadBusy && Studio.loadBusy()), null, { timeout: 180000 });
  await h.goto(); await h.idle();

  await h.run('H1', 'Vaka tipi', 'Çene → malleol → çene → malleol', 'Adımlar: st1, st2, stRed, stAnkS, stAnkG, st7, stAnkOut; çene tipinde st1, st2, st3, st5, st4, st6, st7, st8; örnek vaka tipe göre değişir', async () => {
    await page.selectOption('#caseType', 'ankle'); await pieces(); await h.idle();
    const a = await order(), srcA = await h.ev(() => Studio.S.source.name);
    await page.selectOption('#caseType', 'mandible'); await page.waitForFunction(() => Studio.S.source && Studio.S.source.name === 'mandible' && !Studio.loadBusy(), null, { timeout: 180000 }); await h.idle();
    const m = await order();
    await page.selectOption('#caseType', 'ankle'); await pieces(); await h.idle();
    const b = await order();
    const wantA = ['st1', 'st2', 'stRed', 'stAnkS', 'stAnkG', 'st7', 'stAnkOut'], wantM = ['st1', 'st2', 'st3', 'st5', 'st4', 'st6', 'st7', 'st8'];   // Guide'lar: Mandibula, Fibula, Vidalar
    const ok = JSON.stringify(a) === JSON.stringify(wantA) && JSON.stringify(b) === JSON.stringify(wantA) && JSON.stringify(m) === JSON.stringify(wantM) && srcA === 'ankle';
    return { pass: ok, actual: JSON.stringify({ a, m, b, srcA }), evidence: await h.shot('H1_tip') };
  });

  await h.run('H2', 'Parçalar', 'Altı kemik adlandırılır; 3B görünümde medial malleole tıklanınca o seçilir', 'Tibia, Fibula, Talus, Lateral/Medial/Posterior malleol; tıklama seçimi değiştirir', async () => {
    await page.evaluate(() => { document.getElementById('stRed').open = true; }); await h.sleep(500);
    const names = await h.ev(() => Ankle.pieces().map(p => p.name).sort());
    const c = await h.ev(() => { const p = Ankle.pieces().find(x => x.name === 'Medial malleol'); return p.c.clone().add(p.t).toArray(); });
    const s = await h.proj(c); await page.mouse.click(s.x, s.y); await h.sleep(400);
    const sel = await h.ev(() => (document.querySelector('#ankBody tr.on') || {}).textContent || '');
    const ok = JSON.stringify(names) === JSON.stringify(['Fibula', 'Lateral malleol', 'Medial malleol', 'Posterior malleol', 'Talus', 'Tibia']) && /Medial malleol/.test(sel);
    return { pass: ok, actual: JSON.stringify({ names, sel: sel.slice(0, 40) }), evidence: await h.shot('H2_parcalar') };
  });

  await h.run('H3', 'Redüksiyon', 'Fantomun bilinen yer değiştirmesinin tersi uygulanır', 'Üç parçada çakışma < 0,5 mm, aralık < 2 mm, temas > 0; kritik yok', async () => {
    const m = await h.ev(truth => {
      const P = Ankle.pieces();
      truth.forEach(tr => { const i = P.findIndex(p => p.name === tr.name); const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180); Ankle.setMotion(i, new THREE.Vector3(...tr.move).negate(), R.invert(), true); });
      return Ankle.metrics().filter(x => x.role === 'frag').map(x => ({ n: x.name, gap: +(x.gap || 0).toFixed(2), over: +x.over.toFixed(2), contact: Math.round(x.contact) }));
    }, truth);
    await h.sleep(500); await h.idle();
    const crit = await h.ev(() => Ankle.checks().filter(c => c[0] === 'crit').length);
    const ok = m.length === 3 && m.every(x => x.over < 0.5 && x.gap < 2 && x.contact > 10) && crit === 0;
    return { pass: ok, actual: JSON.stringify(m), evidence: await h.shot('H3_redukte') };
  });

  await h.run('H4', 'Aşırı redüksiyon', 'Medial malleol tibiaya 2,5 mm itilir', 'Kritik kontrol; Redüksiyon onaylanamaz; geri alınca kalkar', async () => {
    const r = await h.ev(() => { const P = Ankle.pieces(), i = P.findIndex(p => p.name === 'Medial malleol'), t0 = P[i].t.clone(), q0 = P[i].q.clone();
      Ankle.setMotion(i, t0.clone().add(new THREE.Vector3(-1, 0, 2.5)), q0, true); const c = Ankle.checks().filter(x => x[0] === 'crit').map(x => x[2]);
      Ankle.setMotion(i, t0, q0, true); return { c, after: Ankle.checks().filter(x => x[0] === 'crit').length }; });
    return { pass: r.c.length === 1 && r.after === 0, actual: JSON.stringify(r) };
  });

  let plan = null;
  await h.run('H5', 'Onay ve paket', 'Cerrah adı, Redüksiyon onayı, mühendis ve cerrah onayı, paketi indir', 'Paket: redükte model, 6 parça, plan, rapor, onay kaydı; mandibula dosyası yok', async () => {
    await page.evaluate(() => { document.getElementById('st7').open = true; }); await h.sleep(400);
    await page.fill('#surgeon', 'Dr Deneme'); await page.click('#ankOk'); await h.sleep(300);
    await page.fill('#au_eng_n', 'Muh Deneme'); await page.click('[data-a="onay"][data-r="eng"]'); await h.sleep(400);
    await page.click('[data-a="onay"][data-r="sur"]'); await h.sleep(600);
    await page.evaluate(() => { document.getElementById('stAnkOut').open = true; }); await h.sleep(400);
    const pill = await h.ev(() => document.getElementById('readyPill').textContent);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#ankPack')]);
    const fp = path.join(h.outDir, 'H5_paket.zip'); await dl.saveAs(fp);
    const list = H.zipList(fp), need = ['redukte_model.stl', 'plan.json', 'rapor.html', 'onay_kaydi.json'];
    plan = await h.ev(() => Studio.planOf());
    const ok = need.every(n => list.includes(n)) && list.filter(n => /^parcalar\//.test(n)).length === 6 && !list.some(n => /navigasyon|guide/.test(n)) && pill === 'Onaylı plan';
    return { pass: ok, actual: JSON.stringify({ pill, list }), evidence: await h.shot('H5_cikti') };
  });

  await h.run('H6', 'Planı yeniden aç', 'Sayfa yenilenir, kayıtlı plan açılır', 'Parça konumları, Redüksiyon onayı ve iki plan onayı geri gelir', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' }); await pieces(); await h.idle();
    await h.ev(p => Studio.openPlan(p), plan); await h.idle(); await h.sleep(800);
    const r = await h.ev(() => { const h = Audit.planHash(); return { red: Ankle.approved(), eng: Audit.status('eng', h).ok, sur: Audit.status('sur', h).ok, moved: Ankle.pieces().filter(p => p.t.length() > 0.5).map(p => p.name).sort(), type: CaseType.get() }; });
    const ok = r.red && r.eng && r.sur && r.moved.length === 3 && r.type === 'ankle';
    return { pass: ok, actual: JSON.stringify(r), evidence: await h.shot('H6_yeniden') };
  });

  await h.run('H7', 'Çeneye dönüş', 'Vaka tipi çene rekonstrüksiyonu', 'Çene örneği yüklenir, parçalar kalkar, kondil referansı hesaplanır', async () => {
    await page.evaluate(() => { document.getElementById('st1').open = true; }); await h.sleep(300);
    await page.selectOption('#caseType', 'mandible');
    // a moved reduction is a plan: the sample is not swapped by itself, the user loads it
    await h.sleep(500); await page.click('#sampleM');
    await page.waitForFunction(() => Studio.S.source && Studio.S.source.name === 'mandible' && !Studio.loadBusy() && window.Ref && Ref.get(), null, { timeout: 180000 }); await h.idle();
    const r = await h.ev(() => ({ pieces: Ankle.pieces().length, ankParts: Object.keys(Studio.parts).filter(k => /^ank\d/.test(k)).length, cond: Object.keys((Ref.get() || {}).cond || {}).length, bone: Studio.parts.bone.visible }));
    const o = await order();
    const ok = r.pieces === 0 && r.ankParts === 0 && r.cond === 2 && r.bone && o.length === 8;
    return { pass: ok, actual: JSON.stringify({ ...r, steps: o.length }), evidence: await h.shot('H7_cene') };
  });

  await h.run('H8', 'Gerçek BT örneği', 'Vaka tipi malleol kalırken sayfa ?ornek olmadan açılır', 'ankle_ct yüklenir; Tibia, Fibula, Talus var; dış nesneler gizli; kritik yok', async () => {
    await page.evaluate(() => { document.getElementById('st1').open = true; }); await h.sleep(300);
    await page.selectOption('#caseType', 'ankle'); await pieces(); await h.idle();
    // a first visit: no last case to reopen (store.js reopens yolmed.lastCase on load)
    await page.evaluate(() => localStorage.removeItem('yolmed.lastCase'));
    await page.goto(H.BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Studio && Studio.S.source && Studio.S.source.name === 'ankle_ct' && window.Ankle && Ankle.pieces().length > 0 && !Studio.loadBusy(), null, { timeout: 300000 }); await h.idle();
    const r = await h.ev(() => ({ names: Ankle.pieces().map(p => p.name), outShown: Ankle.pieces().filter(p => p.role === 'out' && p.pivot.visible).length, crit: Ankle.checks().filter(c => c[0] === 'crit').length, btn: !document.getElementById('sampleAct').hidden && document.getElementById('sampleMct').hidden }));
    const ok = ['Tibia', 'Fibula', 'Talus'].every(n => r.names.includes(n)) && r.outShown === 0 && r.crit === 0 && r.btn;
    await page.evaluate(() => { document.getElementById('stRed').open = true; }); await h.sleep(600);
    return { pass: ok, actual: JSON.stringify(r), evidence: await h.shot('H8_gercek') };
  });

  await h.run('H9', 'Kesi guide\'ı', 'Gerçek örnekte distal tibia ön yüzüne yerleştir, oluştur, üretim STL\'i al', 'Tek parça guide, iki tel kemikte, kama açılması derinlik × tan 8°, üretim STL\'i su geçirmez tek gövde, kritik yok', async () => {
    await page.evaluate(() => { document.getElementById('stAnkG').open = true; }); await h.sleep(500);
    await h.ev(() => {
      // 30 mm over the talar dome (the cut and the K-wires > 5 mm from the plafond); the tibia's centre at that height from its
      // surface, then from 40 mm in front inwards to the anterior cortex (the centre itself lies in the medullary cavity)
      const T = THREE, tib = Ankle.pieces().find(p => p.name === 'Tibia'), z = G.worldOf(Studio.S.red, 0, 0, Ankle.roiInfo().kDome)[2] + 30;
      const pos = tib.mesh.geometry.attributes.position.array; let n = 0, sx = 0, sy = 0, P = null;
      for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 2] - z) < 2) { sx += pos[i]; sy += pos[i + 1]; n++; }
      for (let t = 40; t > 0; t -= 0.1) { const q = new T.Vector3(sx / n, sy / n - t, z); if (Ankle.sdfAt(tib, q) <= 0.2) { P = q.add(new T.Vector3(0, -0.3, 0)); break; } }
      AnkGuide.place(tib, P, new T.Vector3(0, -1, 0));
    });
    const t0 = Date.now(); await h.ev(() => AnkGuide.make()); const ms = Date.now() - t0; await h.idle();
    await h.ev(() => AnkGuide.production()); await h.idle(300000);
    const r = await h.ev(() => { const i = AnkGuide.info(), p = AnkGuide.parts().prod; return { pieces: i.pieces, vol: Math.round(i.volume), pins: i.pins.map(x => x.ok && !x.crosses ? Math.round(x.inBone) : -1), open: +i.wedge.open.toFixed(2), depth: +i.wedge.depth.toFixed(1), prod: p && { ok: p.productionOk, wt: p.watertight, bodies: p.bodies, vol: Math.round(p.volume) }, crit: Ankle.checks().filter(c => c[0] === 'crit').length + AnkGuide.checks().filter(c => c[0] === 'crit').length,
      joint: i.joint && { slot: +i.joint.slot.toFixed(1), pins: i.joint.pins.map(x => +x.d.toFixed(1)) }, files: AnkGuide.files().map(f => f.name) }; });
    const ok = r.pieces === 1 && r.pins.every(x => x >= 8) && Math.abs(r.open - r.depth * Math.tan(8 * Math.PI / 180)) < 0.1 && r.prod && r.prod.ok && r.prod.wt && r.prod.bodies === 1 && Math.abs(r.prod.vol - r.vol) / r.vol < 0.15 && r.crit === 0 && ms < 15000
      && r.joint && r.joint.slot > 5 && r.joint.pins.every(x => x > 5) && r.files[0] === 'guide/kesi_guide.stl';
    return { pass: ok, actual: JSON.stringify({ ...r, ms }), evidence: await h.shot('H9_guide') };
  });

  await h.run('H10', 'Öğe onayları ve özetler', 'Gerçek örnekte otomatik yerleşim, PA12 malzemesi, guide ve kamayı ayrı ayrı onayla, paketi indir', 'Kritik yok; paket bekler, iki öğe onaylanınca hazır; cerceve.json\'daki SHA-256 her STL\'in kendisiyle aynı; raporda dosya özetleri; referans kıyası paneli var', async () => {
    await page.evaluate(() => { document.getElementById('stAnkG').open = true; }); await h.sleep(400);
    const sug = await h.ev(() => { const r = AnkGuide.suggest(); AnkGuide.setMat('pa12'); return r; });
    await h.ev(() => AnkGuide.make()); await h.idle();
    const crit = await h.ev(() => window.ExtraChecks.flatMap(f => f()).filter(c => c[0] === 'crit').map(c => c[2]));
    await page.evaluate(() => { document.getElementById('st7').open = true; }); await h.sleep(400);
    await page.fill('#surgeon', 'Dr Deneme');
    if (!(await h.ev(() => Ankle.approved()))) { await page.click('#ankOk'); await h.sleep(300); }
    // the items first (the surgeon's plan approval waits for them), then the engineer and the surgeon
    const before = await h.ev(() => ({ ready: Ankle.packReady(), items: Ankle.items().map(x => x.k) }));
    for (const k of before.items) { await page.click(`[data-ank-item="${k}"]`); await h.sleep(300); }
    await page.fill('#au_eng_n', 'Muh Deneme'); await page.click('[data-a="onay"][data-r="eng"]'); await h.sleep(400);
    await page.click('[data-a="onay"][data-r="sur"]'); await h.sleep(600);
    const after = await h.ev(() => Ankle.packReady());
    await page.evaluate(() => { document.getElementById('stAnkOut').open = true; }); await h.sleep(400);
    const msg = await h.ev(() => ({ t: document.getElementById('ankPackMsg').textContent, dis: document.getElementById('ankPack').disabled, crit: Studio.S.crit, red: Ankle.approved(), items: Ankle.items().map(x => [x.k, Ankle.itemOk(x)]) }));
    if (msg.dis) return { pass: false, actual: JSON.stringify({ sug, crit, before, after, msg }), evidence: await h.shot('H10_onay') };
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#ankPack')]);
    const fp = path.join(h.outDir, 'H10_paket.zip'); await dl.saveAs(fp);
    const list = H.zipList(fp), fr = JSON.parse(H.zipRead(fp, 'cerceve.json').toString('utf8')), rep = H.zipRead(fp, 'rapor.html').toString('utf8');
    const stls = list.filter(n => /\.stl$/.test(n)), bad = stls.filter(n => fr.sha256[n] !== require('crypto').createHash('sha256').update(H.zipRead(fp, n)).digest('hex') || !rep.includes(fr.sha256[n]));
    const refBox = await h.ev(() => !!document.getElementById('ankRef') && document.getElementById('ankRef').innerHTML.length > 0);
    const ok = !sug.why && crit.length === 0 && !before.ready && before.items.includes('guide') && before.items.includes('wedge') && after && stls.some(n => /^guide\/kesi_guide/.test(n)) && bad.length === 0 && refBox;
    return { pass: ok, actual: JSON.stringify({ sug, crit, before, after, stls, bad, refBox }), evidence: await h.shot('H10_onay') };
  });

  await h.run('H11', 'Düzeltme önizlemesi', 'Gerçek örnekte "Düzeltilmiş hali göster": distal tibia ve talus menteşe çevresinde kama açısı kadar döner', 'Önizleme < 15 s; eklemin dönüşü kama açısıyla aynı (±0,5°); asıl tibia gizli, düzeltilmiş tibia görünür; onaylar düşmez; geri dönünce asıl tibia görünür', async () => {
    await page.evaluate(() => { document.getElementById('stAnkG').open = true; }); await h.sleep(400);
    const ready0 = await h.ev(() => Ankle.packReady());
    const t0 = Date.now(); await page.click('#acShow');
    await page.waitForFunction(() => window.AnkCorr && AnkCorr.live() && AnkCorr.visible(), null, { timeout: 120000 }); const ms = Date.now() - t0; await h.idle();
    const r = await h.ev(() => { const m = AnkCorr.info(), tib = Ankle.pieces().findIndex(p => p.role === 'tibia'), deg = AnkGuide.state().prm.deg;
      return { deg, turn: +Math.hypot(m.coronal, m.sagittal, m.axial).toFixed(2), side: m.side, open: +m.open.toFixed(1), plaf: m.plafondMove && +m.plafondMove.toFixed(1), origHidden: !Studio.parts['ank' + tib].visible, corr: !!(Studio.parts.ankCorr && Studio.parts.ankCorr.visible), ready: Ankle.packReady(), files: AnkCorr.files().map(f => f.name) }; });
    await page.evaluate(() => { const b = document.querySelector('#ankCorrBox'); if (b) b.scrollIntoView(); }); await h.sleep(300);
    const shot = await h.shot('H11_duzeltme');
    await page.click('#acShow'); await h.sleep(500);
    const back = await h.ev(() => { const tib = Ankle.pieces().findIndex(p => p.role === 'tibia'); return Studio.parts['ank' + tib].visible && !Studio.parts.ankCorr; });
    const ok = ms < 15000 && Math.abs(r.turn - r.deg) < 0.5 && r.origHidden && r.corr && r.ready === ready0 && r.files.length === 2 && back;
    return { pass: ok, actual: JSON.stringify({ ...r, ready0, back, ms }), evidence: shot };
  });

  await h.run('H12', 'Dış plak', 'Gerçek örnekte düzeltilmiş tibiaya plak oluştur, sunucudan üretim STL\'i al, plağı onayla, paketi indir', 'Tek gövde, 3 + 2 vida kemikte, kritik yok, üretim STL\'i su geçirmez tek gövde; plak onaylanana kadar paket bekler; pakette plak.stl ve vida listesi, SHA-256 dosyayla aynı', async () => {
    await page.evaluate(() => { document.getElementById('stAnkG').open = true; }); await h.sleep(400);
    // the suggested cut is 25 mm over the dome: too little distal bone for two screws 5 mm off the joint (H12 run
    // 2026-10-25: distal screw 2 at 0.2 mm, critical). The cut is raised 12 mm and the guide built again
    // the 3rd distal hole (28 mm under the cut) still reaches the plafond there (critical, 0.2 mm): two distal holes
    await h.ev(async () => { AnkGuide.set('off', 12); await AnkGuide.make(); AnkPlate.set('nD', 2); });  await h.idle();
    const t0 = Date.now(); await page.click('#apMake');
    await page.waitForFunction(() => window.AnkPlate && AnkPlate.ready(), null, { timeout: 180000 }); const ms = Date.now() - t0; await h.idle();
    await h.ev(() => AnkPlate.production()); await h.idle(300000);
    const r = await h.ev(() => { const i = AnkPlate.info(), o = AnkPlate.parts(), p = o.prod;
      return { pieces: i.pieces, vol: Math.round(i.volume), len: Math.round(i.length), contact: Math.round(i.contact), screws: AnkPlate.screwList().map(x => `${x.taraf[0]}${x.no}:${x.boy_mm}/${x.kemikte_mm}/${x.kesiye_mm}/${x.ekleme_mm}`),
        crit: AnkPlate.checks().filter(c => c[0] === 'crit').map(c => c[2]), prod: p && { ok: p.productionOk, wt: p.watertight, bodies: p.bodies, vol: Math.round(p.volume), issues: (p.issues || []).map(x => x.code) }, shown: !!(Studio.parts.ankPlate && Studio.parts.ankPlate.visible), items: Ankle.items().map(x => x.k), ready: Ankle.packReady() }; });
    await page.evaluate(() => { const b = document.querySelector('#ankPlateBox'); if (b) b.scrollIntoView(); }); await h.sleep(300);
    const shot = await h.shot('H12_plak');
    await page.evaluate(() => { document.getElementById('st7').open = true; }); await h.sleep(400);
    // the raised cut changed the guide and the wedge: every pending item is approved again
    const pend = await h.ev(() => Ankle.items().filter(x => !Ankle.itemOk(x)).map(x => x.k));
    for (const k of pend) { await page.click(`[data-ank-item="${k}"]`); await h.sleep(300); }
    // the plan changed (cut, plate): the engineer and the surgeon sign it again
    if (!(await h.ev(() => Ankle.approved()))) { await page.click('#ankOk'); await h.sleep(300); }
    await page.fill('#au_eng_n', 'Muh Deneme'); await page.click('[data-a="onay"][data-r="eng"]'); await h.sleep(400);
    await page.click('[data-a="onay"][data-r="sur"]'); await h.sleep(600);
    const after = await h.ev(() => Ankle.packReady());
    await page.evaluate(() => { document.getElementById('stAnkOut').open = true; }); await h.sleep(400);
    let pack = null;
    if (after) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#ankPack')]);
      const fp = path.join(h.outDir, 'H12_paket.zip'); await dl.saveAs(fp);
      const list = H.zipList(fp), fr = JSON.parse(H.zipRead(fp, 'cerceve.json').toString('utf8'));
      const stl = list.find(n => /^plak\/plak/.test(n)); pack = { stl, csv: list.includes('plak/plak_vidalari.csv'), corr: list.includes('duzeltme/duzeltilmis_tibia.stl'), sha: !!stl && fr.sha256[stl] === require('crypto').createHash('sha256').update(H.zipRead(fp, stl)).digest('hex') };
    }
    const ok = r.pieces === 1 && r.screws.length === 5 && r.screws.every(x => !/:null\//.test(x)) && r.crit.length === 0 && r.prod && r.prod.ok && r.prod.wt && r.prod.bodies === 1 && Math.abs(r.prod.vol - r.vol) / r.vol < 0.2
      && r.shown && r.items.includes('plate') && !r.ready && after && pack && pack.stl === 'plak/plak.stl' && pack.csv && pack.corr && pack.sha;
    return { pass: ok, actual: JSON.stringify({ ...r, after, pack, ms }), evidence: shot };
  });


  // Denetim 7 (2026-10-25): in English the malleolar panels kept Turkish lines: the check messages with piece names
  // ("Lateral malleol ile Fibula arasında ortalama 2,7 mm aralık var.") never matched their dictionary entries, and the
  // plate panel's "i" lead sentence (the first sentence of its explanation) stayed as first written.
  await h.run('H13', 'İngilizce', 'H12 sonrası arayüz İngilizce; guide, düzeltme, plak, onay, çıktı panelleri ve kontroller', 'Türkçe harf içeren satır yok', async () => {
    await page.click('#langSel + .seg button[data-v="en"]').catch(() => page.evaluate(() => I18N.set('en'))); await h.sleep(800); await page.keyboard.press('Escape');
    await h.ev(() => { ['stAnkG', 'st7', 'stAnkOut', 'stRed'].forEach(id => { const d = document.getElementById(id); if (d) d.open = true; }); Ankle.renderChecks && Ankle.renderChecks(); });
    await h.sleep(1000);
    const tr = /[çğıöşüÇĞİÖŞÜ]/, bad = {};
    for (const id of ['ankGuideBox', 'ankCorrBox', 'ankPlateBox', 'ankAppr', 'ankOut', 'checks']) {
      const t = await h.ev(id => { const e = document.getElementById(id); return e ? e.innerText : ''; }, id);
      // piece names typed by the user and file names stay as they are
      const b = t.split('\n').filter(l => tr.test(l) && !/\.(stl|zip|csv|json|html)\b/.test(l)); if (b.length) bad[id] = b.slice(0, 4);
    }
    const shot = await h.shot('H13_en');
    await page.click('#langSel + .seg button[data-v="tr"]').catch(() => page.evaluate(() => I18N.set('tr'))); await h.sleep(500); await page.keyboard.press('Escape');
    return { pass: !Object.keys(bad).length, actual: JSON.stringify(bad), evidence: shot };
  });
  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
