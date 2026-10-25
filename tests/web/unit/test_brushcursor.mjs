// Brush cursor on the slices: with a brush tool on (bone brush / eraser, lesion brush, marking), the pointer over a slice
// is a thin circle of the brush radius at the view's zoom with a small cross, outline only; the system cursor is hidden.
// Before, the circle showed only while painting (and the pointer stayed a plain crosshair).
// Phantom: tests/phantoms/phantoms.mjs mandibleBar. Run: node test_brushcursor.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['segedit.js', 'lesion.js', 'masks.js', 'mpr.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const S = St.S, G = P.eval('G');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const v = mandibleBar({});
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-brushcursor' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true); await St.settled();

const MPR = P.eval('MPR'), SE = P.eval('SegEdit'), LS = P.eval('Lesion'), MK = P.eval('Masks');
const view = MPR.views[0], c = view.canvas;
// a 2D context that records what is drawn
const calls = [];
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^(arc|moveTo|lineTo|stroke|beginPath|fillRect|fillText|drawImage|setTransform|setLineDash|putImageData)$/.test(k) ? (...a) => calls.push([k, ...a, o.strokeStyle]) : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : k === 'getImageData' ? () => ({ data: [] }) : undefined), set: (o, k, x) => { o[k] = x; return true; } });
{ const mk = P.doc.createElement.bind(P.doc); P.doc.createElement = t => { const e = mk(t); e.getContext = () => ctx; return e; }; }
MPR.views.forEach(x => { x.canvas.getContext = () => ctx; if (x.canvas.width === undefined) { x.canvas.width = 800; x.canvas.height = 600; } });
P.doc.getElementById('vmStrip').click(); await sleep(30);
const move = (X, Y) => (c.listeners.pointermove || []).forEach(f => f({ clientX: X, clientY: Y, pointerId: 1 }));
const rings = () => calls.filter(x => x[0] === 'arc' && Math.abs(x[1] - 400) < 1e-6 && Math.abs(x[2] - 300) < 1e-6);

test('no brush tool: a plain crosshair, no ring at the pointer', async () => {
  calls.length = 0; move(400, 300); await sleep(30);
  assert.equal(c.style.cursor, 'crosshair'); assert.equal(rings().length, 0);
});
test('bone brush: the pointer is a circle of the brush radius at the zoom (green), the system cursor hidden', async () => {
  SE.setTool('brush'); calls.length = 0; move(400, 300); await sleep(30);
  assert.equal(c.style.cursor, 'none');
  const T = MPR.xf(view), r = rings();
  assert.ok(r.length >= 1, 'a ring at the pointer');
  assert.ok(r.every(x => Math.abs(x[3] - 3 * T.s) < 1e-6), `radius ${r.map(x => x[3])} vs ${3 * T.s}`);   // 3 mm default
  assert.ok(r.some(x => x[6] === '#46c98b'), 'green line');
  assert.ok(!calls.some(x => x[0] === 'fillRect' && x[1] > 380 && x[1] < 420 && x[2] > 280 && x[2] < 320 && calls.indexOf(x) > calls.indexOf(r[0])), 'outline only');
});
test('the ring follows the zoom and the radius control', async () => {
  view.zoom = 2; const se = P.doc.getElementById('seRad'); se.value = '6'; (se.listeners.input || []).forEach(f => f({ target: se }));
  calls.length = 0; move(400, 300); await sleep(30);
  const T = MPR.xf(view); assert.ok(rings().every(x => Math.abs(x[3] - 6 * T.s) < 1e-6) && rings().length, 'radius 6 mm at zoom 2');
  view.zoom = 1;
});
test('eraser red; lesion brush; marking; the pick tool shows no ring', async () => {
  SE.setTool('erase'); calls.length = 0; move(400, 300); await sleep(30); assert.ok(rings().some(x => x[6] === '#e5484d'));
  SE.off(); LS.setTool('paint'); calls.length = 0; move(400, 300); await sleep(30); assert.ok(rings().some(x => x[6] === '#ff6b6b'), 'lesion');
  LS.setTool('paint'); MK.setTool('paint'); calls.length = 0; move(400, 300); await sleep(30); assert.ok(rings().length > 0, 'marking'); assert.equal(c.style.cursor, 'none');
  MK.setTool('pick', true); calls.length = 0; move(400, 300); await sleep(30); assert.equal(rings().length, 0); assert.notEqual(c.style.cursor, 'none');
  MK.off();
});
test('ending the tool without a move gives the cursor back; leaving the view drops the ring', async () => {
  SE.setTool('brush'); move(400, 300); await sleep(30); assert.equal(c.style.cursor, 'none');
  SE.off(); await sleep(30); assert.equal(c.style.cursor, 'crosshair');
  SE.setTool('brush'); move(400, 300); await sleep(30);
  (c.listeners.pointerleave || []).forEach(f => f({})); calls.length = 0; MPR.redraw(); await sleep(30);
  assert.equal(rings().length, 0); SE.off();
});
await run();
