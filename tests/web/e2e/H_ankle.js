// Senaryo H · malleol kırığı vaka tipi (2026-10-21), sentetik trimalleoler ayak bileği örneği, gerçek tarayıcı.
// H1 vaka tipi değişince adımlar doğru sırada (iki kez değiştirince de); H2 parçalar adlandırılır, 3B'de tıklayınca seçilir;
// H3 bilinen yer değiştirmenin tersiyle redüksiyon: çakışma yok, aralık kapanır; H4 aşırı redüksiyon kritik;
// H5 onaylar (redüksiyon + mühendis + cerrah) ve paket; H6 sayfa yenilenip plan açılınca parça konumları ve onay geri gelir;
// H7 çene tipine dönünce çene örneği, kondil işaretleri ve 8 adım geri gelir.
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

  await h.run('H1', 'Vaka tipi', 'Çene → malleol → çene → malleol', 'Adımlar: st1, st2, stRed, st7, stAnkOut; çene tipinde st1..st8; örnek vaka tipe göre değişir', async () => {
    await page.selectOption('#caseType', 'ankle'); await pieces(); await h.idle();
    const a = await order(), srcA = await h.ev(() => Studio.S.source.name);
    await page.selectOption('#caseType', 'mandible'); await page.waitForFunction(() => Studio.S.source && Studio.S.source.name === 'mandible' && !Studio.loadBusy(), null, { timeout: 180000 }); await h.idle();
    const m = await order();
    await page.selectOption('#caseType', 'ankle'); await pieces(); await h.idle();
    const b = await order();
    const wantA = ['st1', 'st2', 'stRed', 'st7', 'stAnkOut'], wantM = ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'st8'];
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

  await h.done();
})().catch(e => { console.error(e); process.exit(1); });
