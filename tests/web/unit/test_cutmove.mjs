// Cut move handle (2026-10-25): the move axes of a selected cut used to stay on the guide frame (x along the guide axis
// only), so a turned cut slid along the straight guide axis and could not be put where it was wanted on the bone.
// Now the "Taşıma ekseni" list picks the handle's axes:
//  - cut (default): x along the cut's normal (the plane moves square to itself, by exactly the distance moved), y and z
//    in the cut plane (the plane stays, its point on the bone moves); the axes turn with the cut
//  - world: the scene's x-y-z; the cut point follows the handle, the angle stays
//  - guide: the older handle (along the guide axis only)
// A move drops the cut's approval. Run: node test_cutmove.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ extra: { fetch: async () => { throw new Error('offline'); } } });
const St = await ready(P); const T = P.g.THREE, S = St.S, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

function setup(planes) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.g.rot = 0;
  S.planes = planes.map(p => Object.assign({ w: 0.8, ok: true, by: 'test', sig: 'x' }, p));
  S.sel = 'p0'; St.gz.mode = 'translate';
}
// a drag of the handle by `d` (world vector), the way TransformControls moves the proxy
function drag(i, d, space) {
  $('moveSpace').value = space;
  const b = St.cutMoveBasis(i);
  St.proxy.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(b.x, b.y, b.z)); St.proxy.position.copy(b.p); St.proxy.updateMatrixWorld();
  St.gz.start = St.gizmoStart();
  St.proxy.position.add(d); St.gizmoApply();
  St.gz.start = null;
}
const plane = i => St.planesWorld()[i];
const dist = (pw, q) => q.clone().sub(pw.p).dot(pw.N);

test('cut axes: x is the turned cut\'s normal, y and z lie in the cut plane, all square to each other', () => {
  setup([{ off: 10, yaw: 30, pitch: 15 }]);
  $('moveSpace').value = 'cut';
  const b = St.cutMoveBasis(0), N = plane(0).N;
  near(Math.abs(b.x.dot(N)), 1, 1e-9, 'x along the normal');
  near(b.y.dot(N), 0, 1e-9); near(b.z.dot(N), 0, 1e-9);
  near(b.x.dot(b.y), 0, 1e-9); near(b.y.dot(b.z), 0, 1e-9);
  near(V().crossVectors(b.x, b.y).dot(b.z), 1, 1e-9, 'right-handed');
  // the default is the cut's own axes
  $('moveSpace').value = ''; assert.equal(St.moveSpace(), 'cut');
});

test('cut axes: a 3 mm move along x moves a turned cut 3 mm square to itself (the old handle moved it 3 cos 30°)', () => {
  setup([{ off: 10, yaw: 30, pitch: 0 }]);
  const before = plane(0), N0 = before.N.clone(), q = before.p.clone();
  drag(0, St.cutMoveBasis(0, 'cut').x.clone().multiplyScalar(3), 'cut');
  const after = plane(0);
  near(after.N.dot(N0), 1, 1e-9, 'the angle stays');
  near(Math.abs(dist(after, q)), 3, 0.06, 'plane moved 3 mm along its normal');
  near(after.p.distanceTo(before.p), 3, 0.1, 'the cut point followed the handle');
  assert.equal(S.planes[0].ok, false, 'the cut is approved again'); assert.equal(S.planes[0].sig, undefined);
});

test('cut axes: an in-plane move keeps the plane and moves the cut point on it (the guide-axis handle could not)', () => {
  setup([{ off: 10, yaw: 30, pitch: 10 }]);
  const before = plane(0), b = St.cutMoveBasis(0, 'cut'), d = b.y.clone().multiplyScalar(4).addScaledVector(b.z, -2);
  drag(0, d, 'cut');
  const after = plane(0);
  near(after.N.dot(before.N), 1, 1e-9);
  near(dist(after, before.p), 0, 0.06, 'same plane');
  near(after.p.distanceTo(before.p.clone().add(d)), 0, 0.1, 'cut point moved by the drag');
});

test('world axes: the cut point follows a world x-y-z move, the angle stays', () => {
  setup([{ off: -12, yaw: -20, pitch: 25 }]);
  $('moveSpace').value = 'world';
  const b = St.cutMoveBasis(0);
  assert.equal(JSON.stringify([b.x.toArray(), b.y.toArray(), b.z.toArray()]), '[[1,0,0],[0,1,0],[0,0,1]]');
  const before = plane(0), d = V(1.5, -2, 3);
  drag(0, d, 'world');
  const after = plane(0);
  near(after.N.dot(before.N), 1, 1e-9);
  near(after.p.distanceTo(before.p.clone().add(d)), 0, 0.1);
  near(dist(after, before.p), -d.dot(before.N), 0.06);
});

test('guide axis: the older handle (off along the guide axis, 0.5 mm steps) is still there', () => {
  setup([{ off: 10, yaw: 30, pitch: 0 }]);
  drag(0, V(3, 0, 0), 'guide');
  assert.equal(S.planes[0].off, 13); assert.equal(S.planes[0].yaw, 30); assert.equal(S.planes[0].pv, undefined);
});

test('moveCutTo: a point too far out or a cut parallel to the guide axis is refused, the cut is left as it was', () => {
  setup([{ off: 10, yaw: 30, pitch: 0 }]);
  const o = S.planes[0], N = plane(0).N, keep = JSON.stringify(o);
  assert.equal(St.moveCutTo(o, V(St.CUT_OFF_MAX + 40, 0, 0), N), false);
  assert.equal(St.moveCutTo(o, V(5, 5, 0), V(0, 1, 0)), false);
  assert.equal(JSON.stringify(o), keep);
});

// a synthetic CT bar (no patient data) so a plan can be reopened and the resection rebuilt
async function volume() {
  const G = P.eval('G'), sp = [0.8, 0.8, 0.8], box = { x: 50, y: 24, z: 30 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 45 && Math.abs(y) < 7 && z < 0 && z > -14) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}

test('a moved cut is saved and reopened at the same place (pv / pn go into the plan); the resection follows it', async () => {
  await volume();
  setup([{ off: 10, yaw: 30, pitch: 10 }, { off: -10, yaw: 0, pitch: 0 }]);
  const b = St.cutMoveBasis(0, 'cut'); drag(0, b.y.clone().multiplyScalar(5).addScaledVector(b.x, 1), 'cut');
  const p0 = plane(0).p.clone(), N0 = plane(0).N.clone(), plan = JSON.parse(JSON.stringify(St.planOf()));
  S.planes = []; await St.applyPlan(plan);
  near(plane(0).p.distanceTo(p0), 0, 1e-6); near(plane(0).N.dot(N0), 1, 1e-9);
  // the resection is rebuilt from the moved cut without errors: it still lies between the two cuts
  await St.rebuildResection();
  assert.equal(St.resectedNear(V(0, 0, -7), 0.5), true, 'bone between the cuts is resected');
  assert.equal(St.resectedNear(V(30, 0, -7), 0.5), false, 'bone past the moved cut is kept');
});

await run();
