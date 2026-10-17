// Senaryo G · görünüm çubuğu ve katman adları (2026-10-17)
// G1: görünüm çubuğu (3B / şerit / 2×2) tüm görüntüleme alanının altına sabit; kesit panelleri açıkken 3B hücresine girmiyor.
// G2: Katmanlar listesinde bir satıra çift tıklayıp ad değiştirme (Enter kaydeder, Esc vazgeçer); ad planla saklanır,
//     plan özeti (SHA-256, onay zinciri) değişmez. Örnek vaka, gerçek tarayıcı.
'use strict';
const H = require('./lib');

(async () => {
  const h = await H.start({ name: 'G_view_layers', dir: 'G' });
  const { page } = h;
  await h.goto(); await h.idle();
  const geo = () => page.evaluate(() => {
    const R = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
    return { wrap: R('.stagewrap'), views: R('#views'), hud: R('.hud'), c3d: R('#cell3d') };
  });
  for (const [btn, mode] of [['#vm3d', '3B'], ['#vmStrip', 'şerit'], ['#vmQuad', '2×2']]) {
    await h.run('G1.' + mode, mode, `Görünüm çubuğu, ${mode} düzeni`, 'Çubuk görüntüleme alanının en altında, tam genişlikte; görünümlerin üstüne binmiyor', async () => {
      await page.click(btn); await h.sleep(600); await h.idle();
      const g = await geo(), probs = [];
      if (Math.abs(g.hud.b - g.wrap.b) > 1.5) probs.push(`çubuk altta değil (${g.hud.b} / ${g.wrap.b})`);
      if (Math.abs(g.hud.w - g.wrap.w) > 2) probs.push(`çubuk tam genişlikte değil (${g.hud.w} / ${g.wrap.w})`);
      if (g.hud.t < g.views.b - 1) probs.push(`çubuk görünümlerin üstüne biniyor (${g.hud.t} < ${g.views.b})`);
      if (mode !== '3B' && g.hud.t < g.c3d.b - 1) probs.push('çubuk 3B hücresinin içinde');
      return { pass: !probs.length, actual: probs.join(' | ') || JSON.stringify({ hud: [Math.round(g.hud.t), Math.round(g.hud.b)], views: Math.round(g.views.b) }), evidence: await h.shot('G1_' + mode.replace('×', 'x')) };
    });
  }
  await page.click('#vm3d'); await h.idle();

  await h.run('G2.1', 'Katmanlar', 'Kemik satırına çift tıkla, yeni ad yaz, Enter', 'Liste yeni adı gösterir; plan ext.names içinde; plan özeti aynı', async () => {
    await page.click('#tab-pPrt'); await h.sleep(200);
    const hash0 = await h.ev(() => Audit.planHash());
    await page.dblclick('#parts [data-rn="bone"]');
    const inp = page.locator('#parts .pname-in'); await inp.waitFor({ timeout: 5000 });
    await inp.fill('Sağ mandibula'); await inp.press('Enter'); await h.sleep(300);
    const r = await h.ev(() => ({ txt: document.querySelector('#parts [data-rn="bone"]').textContent, names: (Studio.planOf().ext || {}).names, hash: Audit.planHash(), vis: Studio.parts.bone.visible }));
    const ok = r.txt === 'Sağ mandibula' && r.names && r.names.bone === 'Sağ mandibula' && r.hash === hash0 && r.vis === true;
    return { pass: ok, actual: JSON.stringify({ txt: r.txt, names: r.names, sameHash: r.hash === hash0, visible: r.vis }), evidence: await h.shot('G2_ad') };
  });
  await h.run('G2.2', 'Katmanlar', 'Çift tıkla, yaz, Esc', 'Ad değişmez', async () => {
    await page.dblclick('#parts [data-rn="bone"]');
    const inp = page.locator('#parts .pname-in'); await inp.waitFor({ timeout: 5000 });
    await inp.fill('Vazgeçilen'); await inp.press('Escape'); await h.sleep(300);
    const txt = await page.textContent('#parts [data-rn="bone"]');
    return { pass: txt === 'Sağ mandibula', actual: txt };
  });
  await h.run('G2.3', 'Katmanlar', 'Plan yeniden açılır (applyPlan)', 'Ad geri gelir', async () => {
    const saved = await h.ev(() => JSON.stringify(Studio.planOf()));
    await h.ev(() => Studio.renamePart('bone', ''));
    await h.ev(p => Studio.applyPlan(JSON.parse(p)), saved); await h.idle();
    const txt = await page.textContent('#parts [data-rn="bone"]');
    return { pass: txt === 'Sağ mandibula', actual: txt };
  });
  const r = await h.done();
  if (r.fail) process.exitCode = 1;
})();
