// Slice navigation in the 2D slice views (mpr.js, reformat.js): every view has its own slider, and the wheel, the
// slider and the keys on a focused view (arrows, Shift+arrows, Page Up / Down, Home / End) move the same slice
// position, so the slider always shows the slice on screen. Reformats (panoramic, perpendicular to a cut) move their
// own offset the same way. The pointer interactions (cursor click) keep working.
// Run: node test_slicenav.mjs
import { test as test0, run, assert } from './lib/t.mjs';
import { studio, ready, FakeEl } from './lib/harness.mjs';

// a 2D context that draws nothing (node has no canvas)
const ctx2d = new Proxy({}, { get: (o, k) => k in o ? o[k] : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) : k === 'canvas' ? { width: 800, height: 600 } : k === 'measureText' ? () => ({ width: 10 }) : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
FakeEl.prototype.getContext = function () { return ctx2d; };

const P = studio({ post: ['mpr.js', 'reformat.js'] });
const St = await ready(P); const S = St.S, MPR = P.g.MPR, R = P.g.Reformat, $ = id => P.doc.getElementById(id);
const tick = () => new Promise(r => setTimeout(r, 15));
const test = (name, fn) => test0(name, async () => { await tick(); return fn(); });
const key = (el, k, o = {}) => { const e = { type: 'keydown', key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; el.dispatchEvent(e); return e; };
const wheel = (el, dy, o = {}) => el.dispatchEvent({ type: 'wheel', deltaY: dy, shiftKey: false, ctrlKey: false, metaKey: false, clientX: 400, clientY: 300, preventDefault() {}, ...o });
const view = id => MPR.views.find(v => v.id === id);

// a small synthetic volume: 40 x 30 x 50 voxels
{
  const nx = 40, ny = 30, nz = 50, hu = new Int16Array(nx * ny * nz).fill(-1000);
  S.vol = { hu, nx, ny, nz, sp: [1, 1, 1], origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  St.bus.dispatchEvent(new P.g.CustomEvent('volume', { detail: {} }));
  $('vmQuad').dispatchEvent({ type: 'click' });   // 3D + three slices
  await tick(); await tick();
}

test('every slice view has its own slider, showing the slice on screen', () => {
  const bars = MPR.views.map(v => v.bar);
  assert.ok(bars.every(b => b && b.type === 'range'), 'a range slider per view');
  assert.equal(new Set(bars).size, 3, 'three distinct sliders');
  const d = [40, 30, 50];
  MPR.views.forEach(v => {
    assert.equal(v.bar.hidden, false, v.id + ' slider shown');
    assert.equal(+v.bar.min, 0); assert.equal(+v.bar.max, d[v.axis] - 1, v.id + ' max = last slice');
    assert.equal(+v.bar.value, Math.round(MPR.state.cur[v.axis]), v.id + ' value = current slice');
  });
  assert.ok(view('ax').canvas.tabIndex === 0, 'the slice view joins the Tab order (keys need focus)');
});

test('arrow keys on a focused view move its slice (Shift: 5), the slider follows', async () => {
  const v = view('ax'), c = v.canvas;
  MPR.setPos(v, 20); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 20);
  let e = key(c, 'ArrowUp'); await tick();
  assert.ok(e.prevented && e.stopped, 'the key is taken by the view (no page scroll, no 3D shortcut)');
  assert.equal(Math.round(MPR.state.cur[2]), 21); assert.equal(+v.bar.value, 21, 'slider follows the key');
  key(c, 'ArrowDown'); key(c, 'ArrowLeft'); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 19);
  key(c, 'ArrowRight', { shiftKey: true }); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 24, 'Shift moves 5 slices like Shift+wheel');
  assert.equal(v.bar.getAttribute('aria-valuetext'), '25/50');
});

test('Page Up / Down move 10 slices, Home / End go to the first and the last slice, clamped', async () => {
  const v = view('co'), c = v.canvas;
  MPR.setPos(v, 10); await tick();
  key(c, 'PageUp'); await tick(); assert.equal(Math.round(MPR.state.cur[1]), 20);
  key(c, 'PageUp'); await tick(); assert.equal(Math.round(MPR.state.cur[1]), 29, 'clamped to the last slice');
  key(c, 'PageDown'); await tick(); assert.equal(Math.round(MPR.state.cur[1]), 19);
  key(c, 'Home'); await tick(); assert.equal(MPR.state.cur[1], 0); assert.equal(+v.bar.value, 0);
  key(c, 'End'); await tick(); assert.equal(MPR.state.cur[1], 29); assert.equal(+v.bar.value, 29);
});

test('modifier keys and other keys are left to the app (Ctrl+arrow, letters)', async () => {
  const v = view('sa'), c = v.canvas; MPR.setPos(v, 5); await tick();
  const e1 = key(c, 'ArrowUp', { ctrlKey: true }), e2 = key(c, 'k'); await tick();
  assert.ok(!e1.prevented && !e2.prevented && !e2.stopped);
  assert.equal(Math.round(MPR.state.cur[0]), 5, 'slice unchanged');
});

test('the slider moves the slice of its own view only; the other sliders keep their axis', async () => {
  const ax = view('ax'), co = view('co'), sa = view('sa');
  MPR.setPos(co, 7); MPR.setPos(sa, 9); await tick();
  ax.bar.value = '33'; ax.bar.dispatchEvent({ type: 'input' }); await tick();
  assert.equal(MPR.state.cur[2], 33, 'axial slice = slider value');
  assert.equal(Math.round(MPR.state.cur[1]), 7); assert.equal(Math.round(MPR.state.cur[0]), 9);
  assert.equal(+co.bar.value, 7); assert.equal(+sa.bar.value, 9);
});

test('the wheel still changes the slice and the slider follows; Ctrl+wheel still zooms without moving it', async () => {
  const v = view('ax'); MPR.setPos(v, 10); await tick();
  wheel(v.canvas, 100); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 11); assert.equal(+v.bar.value, 11);
  wheel(v.canvas, -100, { shiftKey: true }); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 6);
  const z = v.zoom; wheel(v.canvas, -100, { ctrlKey: true }); await tick();
  assert.ok(v.zoom > z, 'zoomed'); assert.equal(Math.round(MPR.state.cur[2]), 6, 'slice unchanged by zoom');
  wheel(v.bar, 100); await tick();
  assert.equal(Math.round(MPR.state.cur[2]), 7, 'the wheel over the slider moves the slice too');
});

test('a click on the slice still moves the shared cursor, and focuses the view for the keys', async () => {
  const v = view('ax'), c = v.canvas; let focused = false; c.focus = () => { focused = true; };
  MPR.setPos(v, 12); await tick();
  c.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 100, clientY: 100, pointerId: 1, shiftKey: false });
  c.dispatchEvent({ type: 'pointerup', pointerId: 1 });
  assert.ok(focused, 'the click focuses the slice view');
  assert.equal(Math.round(MPR.state.cur[2]), 12, 'a click in the plane keeps the slice');
  assert.ok(MPR.state.cur[0] !== 20 || MPR.state.cur[1] !== 15, 'the cursor moved in the plane: ' + MPR.state.cur);
});

test('a reformat (panoramic) gets its own range on the slider: keys, slider and wheel move its depth', async () => {
  const v = view('sa'); v.custom = R.pano; R.pano.depth = 0; MPR.redraw(); await tick();
  assert.equal(+v.bar.min, -15); assert.equal(+v.bar.max, 15); assert.equal(+v.bar.value, 0);
  const cur = MPR.state.cur.slice();
  key(v.canvas, 'ArrowUp'); await tick(); assert.equal(R.pano.depth, 1); assert.equal(+v.bar.value, 1);
  key(v.canvas, 'End'); await tick(); assert.equal(R.pano.depth, 15);
  v.bar.value = '-4'; v.bar.dispatchEvent({ type: 'input' }); await tick(); assert.equal(R.pano.depth, -4);
  wheel(v.canvas, 100); await tick(); assert.equal(R.pano.depth, -3); assert.equal(+v.bar.value, -3);
  assert.deepEqual(MPR.state.cur, cur, 'the standard slices are not moved by the panoramic depth');
  assert.equal(v.bar.getAttribute('aria-valuetext'), '-3 mm');
  v.custom = null; MPR.redraw(); await tick();
  assert.equal(+v.bar.max, 39, 'back to the sagittal slice range');
});

await run('slicenav');
