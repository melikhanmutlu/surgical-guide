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
  await h.run('L.2', 'Kesitte kesiyi döndürme ve taşıma', '2×2 görünüm, Kesi 1 seçili, aksiyel kesitte çizgideki yuvarlak tutamacı fareyle çevir, sonra çizgiyi sürükle',
    'Tutamaç kesiyi aksiyel düzlemde döndürür (normalin kesit eksenine açısı aynı kalır, açı değişir, pivot kesi üstünde kalır), çizgi sürüklemesi açıyı değiştirmeden kesiyi taşır, onay düşer', async () => {
    await page.click('#vmQuad'); await h.sleep(600);
    await h.ev(() => { Studio.S.planes[0].ok = true; Studio.select(null); Studio.select('p0'); MPR.jumpTo(Studio.planesWorld()[0].p); MPR.redraw(); });
    await h.sleep(600); await h.idle();
    const k = await h.ev(() => {
      const v = MPR.views[0], r = v.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2), kn = v.knob;
      if (!kn) return null;
      return { X: r.left + kn.X / dpr, Y: r.top + kn.Y / dpr, PX: r.left + kn.PX / dpr, PY: r.top + kn.PY / dpr, pivot: kn.pivot.toArray(), A: MPR.sliceAxis(v).toArray(), N0: Studio.planesWorld()[0].N.toArray() };
    });
    if (!k) return { pass: false, actual: 'aksiyel kesitte döndürme tutamacı yok' };
    // turn the handle 20° around the pivot on screen
    const R = Math.hypot(k.X - k.PX, k.Y - k.PY), a0 = Math.atan2(k.Y - k.PY, k.X - k.PX);
    await page.mouse.move(k.X, k.Y); await page.mouse.down();
    for (let s = 1; s <= 10; s++) { const a = a0 + s * 2 * Math.PI / 180; await page.mouse.move(k.PX + R * Math.cos(a), k.PY + R * Math.sin(a)); await h.sleep(20); }
    await page.mouse.up(); await h.sleep(400); await h.idle();
    const t = await h.ev(k => {
      const pw = Studio.planesWorld()[0], V = pw.p.constructor, N0 = new V(...k.N0), A = new V(...k.A);
      return { turn: Math.acos(Math.min(1, Math.abs(pw.N.dot(N0)))) * 180 / Math.PI, NA: Math.abs(Math.abs(pw.N.dot(A)) - Math.abs(N0.dot(A))), piv: Math.abs(new V(...k.pivot).sub(pw.p).dot(pw.N)), ok: pw.pl.ok, yaw: pw.pl.yaw, pitch: pw.pl.pitch, N: pw.N.toArray(), p: pw.p.toArray() };
    }, k);
    // drag the line on the axial slice 25 px sideways (along the screen normal of the line)
    const ln = await h.ev(() => {
      const v = MPR.views[0], r = v.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2), T = MPR.xf(v), L = v.lines.find(x => x.i === 0).L;
      const ax = T.fx(L.a[0]), ay = T.fy(L.a[1]), bx = T.fx(L.b[0]), by = T.fy(L.b[1]), kn = v.knob;
      // a point on the line away from the handle
      const m = [(kn.PX * 0.6 + (Math.hypot(ax - kn.PX, ay - kn.PY) > Math.hypot(bx - kn.PX, by - kn.PY) ? ax : bx) * 0.4), (kn.PY * 0.6 + (Math.hypot(ax - kn.PX, ay - kn.PY) > Math.hypot(bx - kn.PX, by - kn.PY) ? ay : by) * 0.4)];
      const d = Math.hypot(bx - ax, by - ay);
      return { X: r.left + m[0] / dpr, Y: r.top + m[1] / dpr, nx: -(by - ay) / d, ny: (bx - ax) / d };
    });
    await page.mouse.move(ln.X, ln.Y); await page.mouse.down();
    for (let s = 1; s <= 5; s++) { await page.mouse.move(ln.X + ln.nx * 5 * s, ln.Y + ln.ny * 5 * s); await h.sleep(20); }
    await page.mouse.up(); await h.sleep(400); await h.idle();
    const m = await h.ev(t => { const pw = Studio.planesWorld()[0], V = pw.p.constructor; return { dN: pw.N.dot(new V(...t.N)), shift: Math.abs(pw.p.clone().sub(new V(...t.p)).dot(new V(...t.N))), yaw: pw.pl.yaw, pitch: pw.pl.pitch }; }, t);
    await page.click('#vm3d');
    const pass = t.turn > 10 && t.turn < 30 && t.NA < 0.01 && t.piv < 0.1 && t.ok === false && m.dN > 0.9999 && m.shift > 1 && m.yaw === t.yaw && m.pitch === t.pitch;
    return { pass, actual: `döndü ${t.turn.toFixed(1)}° (açı ${t.yaw}/${t.pitch}), N·eksen farkı=${t.NA.toFixed(4)}, pivot uzaklığı ${t.piv.toFixed(3)} mm, onay=${t.ok}; çizgi sürüklemesi ${m.shift.toFixed(2)} mm, açı ${m.yaw}/${m.pitch}` };
  });
  await h.done();
})();
