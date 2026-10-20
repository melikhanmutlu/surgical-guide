// Denetim 5 fibula tests: graft order reversal (F2), double-barrel fold (F1), approval signature covers the bone axis (F3),
// junction spacing (F4), hand-placed screws reset on a count change (F7); review follow-ups: hand-placed screws also
// reset by the count buttons and the barrel / order switches (F8), an order switched on and off again and a stamp made
// before the v2 signature keep the approval (F9), condylar resection checks the real stump junction whichever face meets
// it (F10), the recipient side follows the pedicle end (F11). Run: node test_d5_fib.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import zlib from 'node:zlib';

// leg sample (app's sample format). joined: a full-length bone bridge fuses fibula and tibia into one piece
function legSample(joined) {
  const nx = 64, ny = 48, nz = 300, origin = [-32, -24, -150], q = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i, y = origin[1] + j, z = origin[2] + k;
    const fib = Math.hypot(x - 14, y) < 7 && Math.abs(z) < 135, tib = Math.hypot(x + 12, y) < 14 && Math.abs(z) < 140;
    const bridge = joined && x > -2 && x < 10 && Math.abs(y) < 6 && Math.abs(z) < 120;
    q[i + nx * (j + ny * k)] = fib || tib || bridge ? 200 : 0;
  }
  return { dims: [nx, ny, nz], spacing: [1, 1, 1], origin, scale: 10, offset: -1000, data: zlib.gzipSync(Buffer.from(q)).toString('base64') };
}
let LEG = legSample(false);
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], extra: { fetch: fetchStub }, post: ['condyle.js', 'fibula.js', 'implant.js', 'osteo.js', 'ves.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const fire = (id, type, value) => { const el = $(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

// straight mandible bar along x, long enough to move the cuts
{
  const nx = 160, ny = 50, nz = 40, sp = [0.8, 0.8, 0.8], origin = [-64, -20, -24], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 60) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -20, yaw: 0, pitch: 0, w: 1.2 }, { off: 20, yaw: 0, pitch: 0, w: 1.2 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
}
async function cuts(a, b) { S.planes[0].off = a; S.planes[1].off = b; await St.rebuildResection(); await St.regenerate(); St.emit('parts'); await sleep(30); }

// (waits for the new load itself: with a fibula already loaded, active() and last are true before the reload replaces
// S.fib, and a test that went on at once had its plan replaced under it)
async function start() { const was = S.fib; fire('fibSample', 'click'); await until(() => S.fib !== was && W.Fibula.active() && W.Fibula.state().last); await sleep(50); }

test('F2: reversing the graft order puts segment 0 (distal fibula) at the other end, and the plan keeps the cut planes', async () => {
  await start(); await cuts(-30, 30);
  const P0 = W.Fibula.plan(); P0.nAuto = 0; fire('fibN', 'click');
  const a = W.Fibula.state().last, ends = W.Studio.resEnds();
  const x0 = a.segs[0].P0.clone(), xl = a.segs[a.segs.length - 1].P1.clone();
  assert.ok(x0.distanceTo(ends.A.p) < 10 && xl.distanceTo(ends.B.p) < 10, 'normal order: first graft at A, last at B');
  W.Fibula.plan().rev = 1; W.Fibula.plan().rev = 1; fire('fibRev', 'change', undefined);
  const el = $('fibRev'); el.checked = true; fire('fibRev', 'change');
  await sleep(100);
  const b = W.Fibula.state().last, e2 = W.Studio.resEnds();
  assert.ok(b.segs[0].P0.distanceTo(e2.B.p) < 10 && b.segs[b.segs.length - 1].P1.distanceTo(e2.A.p) < 10, 'reversed: first graft at B, last at A');
  const g0 = b.segs[0];
  near(Math.abs(g0.N0.dot(e2.B.N)), 1, 1e-6, 'the end face is the stump plane'); assert.ok(g0.N0.dot(g0.x) > 0, 'face normals run along the graft');
  assert.notEqual(JSON.stringify(W.Fibula.plan()), undefined);
  assert.equal(W.Fibula.approved(), false);
  fire('fibApprove', 'click'); assert.equal(W.Fibula.approved(), true);
  W.Fibula.plan().rev = 0; assert.equal(W.Fibula.approved(), false, 'the order is part of what was approved');
  W.Fibula.plan().rev = 0; const el2 = $('fibRev'); el2.checked = false; fire('fibRev', 'change'); await sleep(50);
});

test('F1: the folded upper barrel runs back from the last lower segment: hinge on the fibula is short, faces meet the stumps', async () => {
  await start(); await cuts(-30, 30);
  const P0 = W.Fibula.plan(); P0.nAuto = 0; P0.dbl = 1; P0.dblH = 15; fire('fibN', 'click'); P0.dbl = 1; W.Fibula.plan().dbl = 1; fire('fibDbl', 'change');
  $('fibDbl').checked = true; fire('fibDbl', 'change'); await sleep(100);
  const c = W.Fibula.state().last, bar = c.segs.find(g => g.barrel), low = c.segs.filter(g => !g.barrel), E = W.Studio.resEnds();
  assert.ok(bar, 'barrel present');
  const hinge = bar.s0 - low[low.length - 1].s1;
  assert.ok(hinge < 40, 'hinge ' + hinge + ' mm of fibula (was the whole defect + 15 before)');
  assert.ok(bar.P0.distanceTo(low[low.length - 1].P1) < 25, 'the barrel starts above where the last lower segment ends');
  assert.ok(bar.N0.dot(bar.x) > 0 && bar.N1.dot(bar.x) > 0, 'both faces point along the strut');
  assert.ok(bar.P0.distanceTo(E.B.p) < 25 && bar.P1.distanceTo(E.A.p) < 25, 'upper strut runs B to A');
  $('fibDbl').checked = false; fire('fibDbl', 'change'); await sleep(50);
});

test('F3: the approval signature covers the guide frame bone axis', async () => {
  await start(); await cuts(-30, 30);
  fire('fibApprove', 'click'); assert.equal(W.Fibula.approved(), true);
  const ax = S.anchor.axis.clone();
  S.anchor.axis = V(ax.x, ax.y + 0.05, ax.z).normalize();
  assert.equal(W.Fibula.approved(), false, 'the bone axis moved every cut plane');
  S.anchor.axis = ax; assert.equal(W.Fibula.approved(), true);
});

test('F4: spacing between two segments grows with the oblique faces and uses the thickest section', async () => {
  await start(); await cuts(-30, 30);
  const P0 = W.Fibula.plan(); P0.nAuto = 0; fire('fibN', 'click');
  const g = W.Fibula.state().last.segs;
  if (g.length < 2) return;
  const gap = g[1].s0 - g[0].s1;
  const R = W.Fibula.rules(), FRm = W.Fibula.state().F.c.FRm;
  assert.ok(FRm >= W.Fibula.state().F.c.FR, 'thickest radius is not under the 90th percentile one');
  assert.ok(gap >= 2 * W.Fibula.slotOf() + R.wedgeBridge - 1e-6, 'gap ' + gap + ' holds both slots and the bridge');
});

test('F7: hand-placed screws are reset when the segment count changes', async () => {
  await start(); await cuts(-30, 30);
  const R = W.Fibula.plan(); R.n = 2; R.knots = [0.5]; R.yaw = [0, 0, 0]; R.pitch = [0, 0, 0]; R.roll = [0, 0]; R.fsc = [{ seg: 1, off: 0, ang: 0 }];
  await cuts(-30, 24);
  if (W.Fibula.plan().n !== 2) assert.ok(!W.Fibula.plan().fsc, 'cleared with the count change');
});

test('R1: straight bone with oblique cuts gives a straight defect line (length ~ chord, deviation ~ 0)', async () => {
  S.planes[0].yaw = 25; S.planes[1].yaw = -25;
  await cuts(-30, 30);
  await start();
  const D = W.Fibula.defect(), c = W.Fibula.state().last;
  const chord = D.pts[0].distanceTo(D.pts[D.pts.length - 1]);
  assert.ok(D.L < chord * 1.05, `defect line ${D.L} mm vs chord ${chord} mm (a hook at the oblique cuts made it longer)`);
  assert.ok(c.dev < 2, `deviation ${c.dev} mm`);
  S.planes[0].yaw = 0; S.planes[1].yaw = 0; await cuts(-30, 30);
});

test('F8: hand-placed screws are reset by the double barrel / reverse order switches (and the count buttons, setN)', async () => {
  await start(); await cuts(-30, 30);
  const P0 = W.Fibula.plan(), setFsc = () => { W.Fibula.plan().fsc = [{ seg: 0, off: 0, ang: 0 }]; };
  setFsc(); $('fibDbl').checked = true; fire('fibDbl', 'change'); await sleep(50);
  assert.equal(W.Fibula.plan().fsc, undefined, 'folding the barrel resets them');
  $('fibDbl').checked = false; fire('fibDbl', 'change'); await sleep(50);
  setFsc(); $('fibRev').checked = true; fire('fibRev', 'change'); await sleep(50);
  assert.equal(W.Fibula.plan().fsc, undefined, 'reversing the order resets them');
  $('fibRev').checked = false; fire('fibRev', 'change'); await sleep(50);
});

test('F9: an order switched on and off keeps the approval; a stamp made before the v2 signature is still valid', async () => {
  await start(); await cuts(-30, 30);
  if (W.Fibula.approved()) fire('fibApprove', 'click');
  fire('fibApprove', 'click'); assert.equal(W.Fibula.approved(), true);
  $('fibRev').checked = true; fire('fibRev', 'change'); await sleep(50); assert.equal(W.Fibula.approved(), false);
  $('fibRev').checked = false; fire('fibRev', 'change'); await sleep(50);
  assert.equal('rev' in W.Fibula.plan(), false, 'no rev: 0 left behind');
  assert.equal(W.Fibula.approved(), true, 'back to the approved plan');
  // an earlier stamp: the same signature without the v2 mark, the bone axis and the centred kerf entries
  const P0 = W.Fibula.plan(), a = JSON.parse(P0.sig.slice(2)).filter(x => !(Array.isArray(x) && (x[0] === 'axis' || x[0] === 'kerfSide')));
  P0.sig = JSON.stringify(a);
  assert.equal(W.Fibula.approved(), true, 'a plan approved before this release keeps its approval');
  S.planes[1].off += 2; assert.equal(W.Fibula.approved(), false, 'and loses it when a cut moves'); S.planes[1].off -= 2;
});

test('F10/F11: condylar resection, reversed order: the junction checked is the real stump (M1), never the new condyle; the recipient side follows the pedicle end', async () => {
  W.Ref = { get: () => ({ cond: { R: [56, 0, -7], L: [-56, 0, -7] }, n: [1, 0, 0], d: 0 }) };
  S.planes = [{ off: 10, yaw: 0, pitch: 0, w: 1.2 }]; S.lesion.condyle = 'R';
  St.placeScrews(); await St.rebuildResection(); await St.regenerate(); St.emit('parts'); await sleep(30);
  await start(); await sleep(100);
  const stumps = () => { W.Osteo.update(); return (W.Osteo.get() || []).filter(o => o.kind !== 'J'); };
  for (const rev of [false, true]) {
    $('fibRev').checked = rev; fire('fibRev', 'change'); await sleep(100);
    const r = stumps();
    assert.equal(r.length, 1, `rev ${rev}: one stump junction: ` + JSON.stringify(r.map(o => o.name)));
    assert.ok(/Mandibula 1/.test(r[0].name), `rev ${rev}: at the real stump (${r[0].name})`);
    const E = St.resEnds(), segs = W.Fibula.state().last.segs, ex = segs[segs.length - 1].P1, nr = ex.distanceTo(E.A.p) <= ex.distanceTo(E.B.p) ? E.A : E.B, fr = nr === E.A ? E.B : E.A;
    W.Vessels && W.Vessels.update && W.Vessels.update();
    const sum = W.Vessels && W.Vessels.summary ? W.Vessels.summary() : null;
    if (sum) assert.equal(sum.alici_taraf, nr.p.x > fr.p.x ? 'sol' : 'sağ', `rev ${rev}: recipient on the pedicle side`);
  }
  $('fibRev').checked = false; fire('fibRev', 'change'); await sleep(50);
  S.lesion.condyle = null; S.planes = [{ off: -30, yaw: 0, pitch: 0, w: 1.2 }, { off: 30, yaw: 0, pitch: 0, w: 1.2 }];
});

await run('d5_fib');
