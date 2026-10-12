// Reopening a saved plan reproduces it exactly (e2e C4b): a condylar resection with a non-default new-condyle offset,
// a cut turned with the bone (its point moved within the plane: pv / pn) and a fibula plan. planOf -> applyPlan /
// openPlan must give back the same cuts, offsets, fibula segments, plan hash (web/audit.js) and fibula approval; and
// the new-condyle offset belongs to the fibula approval (it moves the graft end), not to the resection approval.
// Synthetic bone only (straight bar "mandible", synthetic leg). Run: node test_reopen.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import zlib from 'node:zlib';

function legSample() {
  const nx = 64, ny = 48, nz = 300, origin = [-32, -24, -150], q = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i, y = origin[1] + j, z = origin[2] + k;
    const fib = Math.hypot(x - 14, y) < 7 && Math.abs(z) < 135, tib = Math.hypot(x + 12, y) < 14 && Math.abs(z) < 140;
    q[i + nx * (j + ny * k)] = fib || tib ? 200 : 0;
  }
  return { dims: [nx, ny, nz], spacing: [1, 1, 1], origin, scale: 10, offset: -1000, data: zlib.gzipSync(Buffer.from(q)).toString('base64') };
}
const LEG = legSample();
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub }, post: ['condyle.js', 'fibula.js', 'audit.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const fire = (id, type, value) => { const el = $(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };
// condyle reference (web/ref.js is not loaded): the right condyle at the bar's right end
W.Ref = { get: () => ({ cond: { R: [44, 0, -6], L: [-44, 0, -6] }, n: [1, 0, 0], d: 0 }) };

// straight bar along x (top z = 0); a condylar resection from one cut at +10 mm to the right condyle
async function mandible() {
  const sp = [0.8, 0.8, 0.8], box = { x: 50, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 48 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-reopen' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  // the cut's point moved within its (unchanged) plane, as cutAlongBone leaves a cut turned with the bone
  S.planes = [{ off: 10, yaw: 0, pitch: 0, w: 1.2, ok: false, pv: -2.5, pn: -3 }];
  S.lesion.condyle = 'R'; S.guideOn = true;
  St.placeScrews(); await St.rebuildResection(); await St.regenerate();
}
// key order is not part of a plan (a restored lesion / screw lists its fields in another order)
const canon = x => (Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}' : JSON.stringify(x));
const snap = () => {
  const E = St.resEnds(), st = W.Fibula.state();
  return { A: E.A.p.toArray(), B: E.B.p.toArray(), neo: W.Condyle.neoOffset(), segs: st.last.segs.map(g => g.L), n: W.Fibula.plan().n, knots: W.Fibula.plan().knots.slice(),
    planes: canon(S.planes), plan: canon(St.planOf()), hash: W.Audit.planHash(), fibOk: W.Fibula.approved(), lesionOk: !!S.lesion.ok };
};
let saved = null, before = null;

test('setup: condylar resection, new condyle 8 mm (non-default), cut point moved in its plane, fibula plan approved', async () => {
  await mandible();
  W.Condyle.setNeo(8); St.emit('changed');
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().last);
  await sleep(100);
  const E = St.resEnds(); assert.equal(E.condyle, 'R'); near(E.B.neo, 8, 1e-9, 'graft end 8 mm short of the fossa');
  near(E.A.p.y, -2.5, 1e-9, 'cut point moved along v'); near(E.A.p.z, -3, 1e-9, 'cut point moved along n');
  S.lesion.ok = true; S.lesion.by = 'test';
  fire('fibApprove', 'click'); assert.equal(W.Fibula.approved(), true, 'fibula approved');
  saved = St.clone(St.planOf()); before = snap();
  assert.equal(saved.ext.condyle.neo, 8, 'the offset is saved with the plan');
  assert.equal(saved.planes[0].pv, -2.5); assert.equal(saved.planes[0].pn, -3);
  assert.ok(before.segs.length >= 1 && before.segs.every(L => L > 0), JSON.stringify(before.segs));
});

test('applyPlan round trip: cuts (pv / pn), new-condyle offset, fibula segments, plan hash and approvals are identical', async () => {
  // disturb everything the plan restores
  W.Condyle.setNeo(5); S.planes = [{ off: 12, yaw: 0, pitch: 0, w: 1.2 }]; S.lesion.ok = false;
  await St.applyPlan(St.clone(saved)); await sleep(100);
  const after = snap();
  assert.equal(after.neo, 8, 'new-condyle offset restored (not reset to 0 or the default)');
  assert.equal(after.planes, before.planes, 'cuts restored with their in-plane point (pv / pn)');
  after.A.forEach((x, i) => near(x, before.A[i], 1e-9, 'cut point A[' + i + ']')); after.B.forEach((x, i) => near(x, before.B[i], 1e-9, 'graft end B[' + i + ']'));
  assert.equal(after.n, before.n); assert.deepEqual(after.knots, before.knots);
  after.segs.forEach((L, i) => near(L, before.segs[i], 1e-6, 'segment ' + (i + 1)));
  assert.equal(after.plan, before.plan, 'planOf after reopening is the saved plan');
  assert.equal(after.hash, before.hash, 'plan hash unchanged');
  assert.equal(after.fibOk, true, 'fibula approval kept'); assert.equal(after.lesionOk, true, 'resection approval kept');
});

test('openPlan (same series) also round-trips; a stored plan with a damaged pv is opened without it', async () => {
  W.Condyle.setNeo(0); S.planes = [];
  assert.equal(await St.openPlan(St.clone(saved)), true); await sleep(100);
  const after = snap();
  assert.equal(after.hash, before.hash); assert.equal(after.neo, 8); after.segs.forEach((L, i) => near(L, before.segs[i], 1e-6)); assert.equal(after.fibOk, true);
  const bad = St.clone(saved); bad.planes[0].pv = 'x'; bad.planes[0].pn = 1e9;
  await St.applyPlan(bad); await sleep(50);
  assert.equal(S.planes[0].pv, undefined, 'non-numeric pv dropped'); assert.equal(S.planes[0].pn, 80, 'pn clamped to the control range');
  await St.applyPlan(St.clone(saved)); await sleep(100); assert.equal(snap().hash, before.hash);
});

test('the new-condyle offset is part of the fibula approval: changing it drops the fibula approval, not the resection approval', async () => {
  assert.equal(W.Fibula.approved(), true); assert.equal(S.lesion.ok, true);
  W.Condyle.setNeo(8); St.emit('changed');                     // builds the slider (render)
  fire('neoOff', 'input', 10); await sleep(50);
  assert.equal(W.Condyle.neoOffset(), 10);
  assert.equal(W.Fibula.approved(), false, 'fibula approval dropped');
  assert.equal(S.lesion.ok, true, 'resection approval kept (the resected piece does not move)');
  fire('neoOff', 'input', 8); await sleep(50);
  assert.equal(W.Fibula.approved(), true, 'back at the approved offset: the signature matches again');
  // a moved cut point (pv) also changes the defect, so it drops the fibula approval
  S.planes[0].pv = -1; assert.equal(W.Fibula.approved(), false); S.planes[0].pv = -2.5; assert.equal(W.Fibula.approved(), true);
});

await run('reopen round trip (condyle offset, cut pv / pn, fibula, plan hash)');
await new Promise(r => process.stdout.write('', r)); process.exit(process.exitCode || 0);
