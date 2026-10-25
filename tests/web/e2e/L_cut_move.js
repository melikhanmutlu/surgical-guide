// Regression (2026-10-25): the move handle of a turned cut. The handle's axes used to stay on the guide frame, so a
// turned cut could only slide along the straight guide axis. Now (default "Kesiye göre") the handle's x arrow is the
// cut's normal and turns with the cut; dragging it with the mouse moves the plane square to itself, the angle stays,
// and the cut's approval drops. "Dünya eksenleri" puts the handle on the world x-y-z.
'use strict';
const H = require('./lib');
(async () => {
  const h = await H.start({ name: 'L_cut_move', dir: 'L' });
  const { page } = h;
  await h.goto();
  await h.run('L.1', 'Döndürülmüş kesinin taşıma tutamacı', 'Örnek vaka, otomatik planla, Kesi 1 yatay açı 25°, tutamacın x okunu fareyle sürükle',
    'Tutamacın x ekseni kesi normaline paralel; sürükleme kesiyi kendi normali boyunca taşır, açı aynı kalır, kesi onayı düşer; dünya modunda eksenler x-y-z', async () => {
    await h.openStep(1); await page.click('#sampleM'); await h.idle();
    await h.openStep(3); await page.click('#autoPrep'); await h.idle();
    const prep = await h.ev(() => {
      const { S } = Studio; const o = S.planes[0];
      o.yaw = 25; o.ok = true; Studio.select('p0'); Studio.syncGizmo(); Studio.render();
      return { n: S.planes.length, gizmo: !!Studio.gizmo };
    });
    await h.sleep(500); await h.idle();
    const axes = await h.ev(() => {
      const { S, proxy, THREE: _ } = Studio, pw = Studio.planesWorld()[0], x = new proxy.position.constructor(1, 0, 0).applyQuaternion(proxy.quaternion);
      return { dotN: Math.abs(x.dot(pw.N)), box: !document.getElementById('moveBox').hidden, showY: Studio.gizmo.showY, showZ: Studio.gizmo.showZ };
    });
    // the screen direction of the handle's x arrow: hover along it until the gizmo picks the X axis, then drag
    const scr = await h.ev(() => {
      const { proxy, camera, renderer } = Studio, r = renderer.domElement.getBoundingClientRect();
      const toS = q => { const p = q.clone().project(camera); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; };
      const x = new proxy.position.constructor(1, 0, 0).applyQuaternion(proxy.quaternion);
      return { o: toS(proxy.position), t: toS(proxy.position.clone().addScaledVector(x, 5)) };
    });
    const dir = [scr.t[0] - scr.o[0], scr.t[1] - scr.o[1]], L = Math.hypot(...dir), ux = dir[0] / L, uy = dir[1] / L;
    let at = null;
    for (let s = 20; s <= 160 && !at; s += 6) {
      const p = [scr.o[0] + ux * s, scr.o[1] + uy * s];
      await page.mouse.move(p[0], p[1]); await h.sleep(30);
      if (await h.ev(() => Studio.gizmo.axis === 'X')) at = p;
    }
    const before = await h.ev(() => { const pw = Studio.planesWorld()[0]; return { p: pw.p.toArray(), N: pw.N.toArray(), yaw: pw.pl.yaw, pitch: pw.pl.pitch }; });
    if (at) {
      await page.mouse.down(); for (let k = 1; k <= 10; k++) { await page.mouse.move(at[0] + ux * 4 * k, at[1] + uy * 4 * k); await h.sleep(20); } await page.mouse.up();
      await h.sleep(400); await h.idle();
    }
    const after = await h.ev(b => {
      const pw = Studio.planesWorld()[0], V = pw.p.constructor, d = pw.p.clone().sub(new V(...b.p));
      return { moved: d.length(), along: Math.abs(d.dot(new V(...b.N))), dotN: pw.N.dot(new V(...b.N)), yaw: pw.pl.yaw, pitch: pw.pl.pitch, ok: pw.pl.ok };
    }, before);
    // world axes
    const world = await h.ev(() => {
      const sel = document.getElementById('moveSpace'); sel.value = 'world'; sel.dispatchEvent(new Event('change'));
      const q = Studio.proxy.quaternion; const r = { w: Math.abs(q.w), xyz: Math.hypot(q.x, q.y, q.z) };
      sel.value = 'cut'; sel.dispatchEvent(new Event('change')); return r;
    });
    const pass = prep.gizmo && axes.dotN > 0.999 && axes.box && axes.showY && axes.showZ && !!at && after.moved > 0.5 && after.along / after.moved > 0.98
      && after.dotN > 0.9999 && after.yaw === before.yaw && after.pitch === before.pitch && after.ok === false && world.w > 0.9999;
    return { pass, actual: `x·N=${axes.dotN.toFixed(4)} kutu=${axes.box} tutuldu=${!!at} taşındı=${after.moved.toFixed(2)} mm (normal boyunca ${after.along.toFixed(2)}) açı ${after.yaw}/${after.pitch} onay=${after.ok} dünya q.w=${world.w.toFixed(4)}` };
  });
  await h.done();
})();
