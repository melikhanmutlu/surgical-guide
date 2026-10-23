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

// A1 (plan after P0): the fibula guide's slot was the kerf (1.0 mm) and the slot check measured the play against the
// kerf, so it said 0°; the saw's blade (S.g.blade 0.6 mm) tilts atan(0.4 / 2.5) = 9.1° in it. Now the play is measured
// against the blade, an old plan is critical with a one-click fix, and a new plan has a blade-fit slot and a slot rim.
const meshVol = m => { const a = m.geometry.attributes.position.array, ix = m.geometry.index ? m.geometry.index.array : null, n = ix ? ix.length : a.length / 3; let v = 0;
  for (let i = 0; i < n; i += 3) { const [p, q, r] = [0, 1, 2].map(k => (ix ? ix[i + k] : i + k) * 3); v += a[p] * (a[q + 1] * a[r + 2] - a[q + 2] * a[r + 1]) - a[p + 1] * (a[q] * a[r + 2] - a[q + 2] * a[r]) + a[p + 2] * (a[q] * a[r + 1] - a[q + 1] * a[r]); }
  return Math.abs(v) / 6; };
test('A1: a new fibula plan has a blade-fit slot and a slot rim; an old one (slot = kerf 1.0) is critical, the fix fits it', async () => {
  const fresh = W.Fibula.plan();
  near(fresh.slotW, St.slotDefault(), 1e-9, 'new plan: slot = blade + tolerance'); assert.equal(fresh.boss, St.G_DEFAULT.boss);
  const play = () => W.Fibula.checks().filter(c => /Fibula guide yuvasında testere/.test(c[2]));
  const built = (f) => until(() => S.fib.guide && S.fib.guide.result && !W.Fibula.pending() && f(S.fib.guide.ctx), 60000);
  await built(x => x.g.boss === St.G_DEFAULT.boss);
  assert.equal(play().length, 0, 'no play critical on a new plan');
  const vNew = meshVol(S.fib.guide.mesh);
  // the cut takes the kerf (1.0 mm, wider than the 0.8 mm slot): the slot is centred in it, half the kerf outside the face
  S.fib.guide.ctx.pls.forEach(q => { near(q.w, St.slotDefault(), 1e-9); near(q.pSlot.distanceTo(q.p), fresh.kerf / 2, 1e-9); });
  const old = St.clone(fresh); delete old.slotW; delete old.boss; old.kerf = 1.0;
  await W.Fibula.apply(old); await built(x => !x.g.boss && Math.abs(x.pls[0].w - 1.0) < 1e-9);
  const r = play(); assert.equal(r.length, 1, JSON.stringify(W.Fibula.checks().map(c => c[2])));
  assert.equal(r[0][0], 'crit'); assert.match(r[0][2], /9,1° eğilebilir \(yuva 1,00 mm, bıçak 0,60 mm, kılavuz derinliği 2,5 mm\)/);
  assert.equal(JSON.stringify(r[0][4]), JSON.stringify([['fibSlotFit', 'Yuvayı bıçağa uydur']]));
  const vOld = meshVol(S.fib.guide.mesh);
  assert.ok(vNew > vOld + 20, `the slot rim adds material (${vOld.toFixed(0)} -> ${vNew.toFixed(0)} mm³)`);
  // the fix: slot to the blade, rim to the default; the play is under the limit
  await St.runFix('fibSlotFit'); await built(x => x.g.boss === St.G_DEFAULT.boss);
  near(W.Fibula.plan().slotW, St.slotDefault(), 1e-9); assert.equal(W.Fibula.plan().boss, St.G_DEFAULT.boss);
  assert.equal(play().length, 0); assert.ok(!W.Fibula.checks().some(c => /yuvası .* geniş/.test(c[2])));
  const a = St.slotPlay(W.Fibula.slotOf(), S.g.blade, St.slotDepth(S.fib.guide.ctx.g)); assert.ok(a <= St.SLOT_PLAY_MAX, a + '°');
  // the production request carries the rim
  assert.equal(St.guideRequest(Object.assign({ vol: W.Fibula.state().F.vol, red: W.Fibula.state().F.red, F: W.Fibula.state().F.c.Fm, thr: W.Fibula.state().F.thr }, S.fib.guide.ctx)).g.boss, St.G_DEFAULT.boss);
});

test('A2: the guide on the round synthetic fibula turns about its axis before the screws: a warning, the fix deepens the wrap', async () => {
  const built = f => until(() => S.fib.guide && S.fib.guide.result && !W.Fibula.pending() && f(S.fib.guide.ctx), 60000);
  await built(() => true);
  const rot = () => W.Fibula.checks().filter(c => /Fibula guide'ı vidalar takılmadan önce kemik ekseni/.test(c[2]));
  const r = rot(); assert.equal(r.length, 1, JSON.stringify(W.Fibula.checks().map(c => c[2])));
  assert.equal(r[0][0], 'warn'); assert.match(r[0][2], /etrafında dönebilir/);
  const rep = W.Fibula.guideReport(); assert.ok(rep.seat && rep.seat.rotU < 0.05, JSON.stringify(rep.seat));
  if (r[0][4]) {
    assert.equal(r[0][4][0][0], 'fibWrapUp'); const w0 = S.fib.guide.ctx.g.wrap;
    await St.runFix('fibWrapUp'); await built(x => Math.abs(x.g.wrap - (w0 + 1)) < 1e-9);
    assert.equal(W.Fibula.plan().fg.wrap, w0 + 1);
    const p = W.Fibula.plan(); p.fg = null; await W.Fibula.apply(St.clone(p)); await built(x => Math.abs(x.g.wrap - w0) < 1e-9);
  }
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
