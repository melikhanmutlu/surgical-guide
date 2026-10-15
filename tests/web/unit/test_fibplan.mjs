// Fibula plan state on synthetic data (Denetim 4): an automatic segment count re-chosen after a cut move keeps the
// surgeon's knots / angles / rolls when the count is the same and says so when it changes (W8); a leg split never leaves
// an empty candidate (W9); the fibula load has its own load controller (W5); the approval signature covers the guide
// angle (D-6) and plans without slotW / nAuto keep theirs (W20); implant segment / position survive a restore (W4).
// Run: node test_fibplan.mjs
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
const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], extra: { fetch: fetchStub }, post: ['fibula.js', 'implant.js'] });
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

test('W5: a fibula DICOM load does not cancel a mandible load that is running (separate controllers)', async () => {
  const m = St.startLoad();
  const f = new File([new Uint8Array([1, 2, 3])], 'x.dcm');
  const el = $('fibDicom'); el.files = [f]; fire('fibDicom', 'change');
  await sleep(200);
  assert.equal(m.cancelled, false, 'the mandible load is still live');
  assert.equal(St.loadStopped(m), false);
});

test('W8: with an automatic count, a 1 mm cut move keeps the knots, angles and rolls; a count change is announced', async () => {
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().last);
  const P0 = W.Fibula.plan(); P0.nAuto = 1;
  await cuts(-20, 21); await sleep(30);
  const n = W.Fibula.plan().n;
  // hand edits
  const Q = W.Fibula.plan(); Q.yaw[0] = 7; Q.pitch[0] = -4; Q.roll[0] = 12; Q.rollAuto = 0; if (Q.knots.length) Q.knots[0] = Math.min(0.8, Q.knots[0] + 0.05);
  const before = JSON.stringify([Q.knots, Q.yaw, Q.pitch, Q.roll]);
  await cuts(-20, 22);
  near(W.Fibula.choice().L, W.Fibula.defect().L, 0.5, 'the count was chosen again for the new length');
  assert.equal(W.Fibula.plan().n, n);
  assert.equal(JSON.stringify([W.Fibula.plan().knots, W.Fibula.plan().yaw, W.Fibula.plan().pitch, W.Fibula.plan().roll]), before, 'hand edits kept');
  // a count change cannot keep them, and says so (the straight bar always takes one segment: start from two)
  const R = W.Fibula.plan(); R.n = 2; R.knots = [0.5]; R.yaw = [0, 3, 0]; R.pitch = [0, 0, 0]; R.roll = [0, 0];
  await cuts(-20, 24);
  assert.equal(W.Fibula.plan().n, 1);
  assert.match($('fibMsg').textContent, /segment sayısı 2 → 1 oldu\. Segment sınırları, kesi açıları ve rotasyonlar sıfırlandı/);
  await cuts(-20, 20);
});

test('D-6: the fibula approval follows the guide angle; W20: a plan without slotW / nAuto keeps them absent', async () => {
  S.g.rot = 0;
  fire('fibApprove', 'click'); assert.equal(W.Fibula.approved(), true);
  S.g.rot = 15; assert.equal(W.Fibula.approved(), false, 'turning the guide turns cuts in the jaw: the approval is stale');
  S.g.rot = 0; assert.equal(W.Fibula.approved(), true, 'back at 0: the signature is the one without a rotation');
  const p = St.clone(W.Fibula.plan()); delete p.slotW; delete p.nAuto;
  await W.Fibula.apply(p);
  assert.ok(!('slotW' in W.Fibula.plan()) && !('nAuto' in W.Fibula.plan()), 'not written in when the plan did not have them');
});

test('W4: an implant on segment 4 or the strut, 80 mm along, survives a plan restore', () => {
  W.PlanExt.impl.set([{ seg: 4, t: 80, d: 4, len: 10, tb: 0, tm: 0 }, { seg: 9, t: 900 }]);
  const l = W.Implants.list();
  assert.equal(l[0].seg, 4); assert.equal(l[0].t, 80);
  assert.equal(l[1].seg, W.Fibula.MAX_N, 'clamped to the largest plan'); assert.ok(l[1].t <= 400);
  W.PlanExt.impl.set(null);
});

test('W9: after a leg split the joined candidate is gone; choosing any listed candidate never throws', async () => {
  LEG = legSample(true);
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().F && W.Fibula.state().F.cands.length && W.Fibula.state().last, 60000);
  const F = W.Fibula.state().F, joined = F.cands.find(c => c.rad > 9);
  if (!joined) {
    // the separator split the synthetic leg by itself: check the guard on a candidate whose bone is gone (what a split
    // leaves behind), which used to throw RangeError (new Float64Array(-Infinity))
    console.log('    (separator split the leg itself; candidates ' + F.cands.map(c => c.rad.toFixed(1)).join(', ') + ')');
    const i0 = W.Fibula.state().F.c.i; F.cands.push(Object.assign({}, F.cands[0], { label: 65000, tibia: null }));
    assert.doesNotThrow(() => fire('fibCand', 'change', String(F.cands.length - 1)));
    assert.equal(W.Fibula.state().F.c.i, i0, 'the current candidate stays'); assert.match($('fibMsg').textContent, /kemiği artık yok/);
    F.cands.pop(); return;
  }
  const p = St.clone(W.Fibula.plan()); p.legSplit = { f: [14, 0, 40], t: [-12, 0, 40] };
  await W.Fibula.apply(p);
  assert.ok(F.split, 'split done');
  assert.ok(!F.cands.some(c => c.label === joined.label), 'joined candidate removed');
  for (let i = 0; i < F.cands.length; i++) assert.doesNotThrow(() => fire('fibCand', 'change', String(i)));
});

await run('fibplan');
