// E4 (plan "Çene rekonstrüksiyonu: P0 sonrası"): the post-op CT tool on a phantom with known transforms.
//  - metrics.js: a rotation's Euler angles (x, y, z in LPS) and a plane's tilt as two components in the cut face
//  - a post-op scan that is the planned result (the resected piece gone) moved by a known rigid transform: the registration finds it (< 0.1 mm,
//    < 0.1°, per Euler angle too), the condyles, gonions and menton have not moved (< 0.1 mm), the gonial angles agree
//  - the right ramus piece moved 1.6 mm (two voxels) after the resection: its condyle and gonion move 1.6 mm, the
//    other side does not
// Run: node test_postop.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, plain } from './lib/harness.mjs';

const PM = plain(); PM.load('metrics.js'); const Mx = PM.eval('Metrics');
const P = studio({ pre: ['metrics.js'], post: ['postop.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

test('Euler angles: a rotation made as Rz(c) Ry(b) Rx(a) gives back a, b, c (< 0.001°); plane tilt components', () => {
  const r = d => d * Math.PI / 180, Rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]], Ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]], Rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mm = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  for (const [a, b, c] of [[3, -2, 5], [-12, 7.5, 40], [0.05, 0, -0.08]]) {
    const e = Mx.euler({ R: mm(Rz(r(c)), mm(Ry(r(b)), Rx(r(a)))), t: [0, 0, 0] });
    near(e.x, a, 1e-3); near(e.y, b, 1e-3); near(e.z, c, 1e-3);
  }
  // a cut face normal n = x, vertical z: turned 2° about the vertical and 3° about the face's horizontal
  const n = [1, 0, 0], m1 = [Math.cos(r(2)), Math.sin(r(2)), 0], t1 = Mx.planeTilt(n, m1, [0, 0, 1]);
  near(Math.abs(t1.about1), 2, 1e-9); near(t1.about2, 0, 1e-9); near(t1.total, 2, 1e-9);
  const m2 = [Math.cos(r(3)), 0, Math.sin(r(3))], t2 = Mx.planeTilt(n, m2, [0, 0, 1]);
  near(t2.about1, 0, 1e-9); near(Math.abs(t2.about2), 3, 1e-9);
});

// a U-shaped mandible (LPS: x left, y back, z up): body arch radius 40 about the origin, rami behind its ends with a
// condyle on top; the plan resects 16 mm of the right body
const SOFT = 40, BONE = 1200;
function bone(x, y, z) {
  const r = Math.hypot(x, y), th = Math.atan2(x, -y);
  if (Math.abs(th) < 75 * Math.PI / 180 && y < -2 && ((r - 40) / 5) ** 2 + (z / 10) ** 2 < 1) return true;
  const ax = Math.abs(x);
  if (ax > 34 && ax < 44 && y > -14 && y < 16 && z > -10 && z < 10) return true;
  if (ax > 34 && ax < 44 && y > 6 && y < 16 && z >= 10 && z < 40) return true;
  return ((ax - 39) / 8) ** 2 + ((y - 11) / 5) ** 2 + ((z - 44) / 5) ** 2 < 1;
}
const box = { x0: -50, y0: -48, z0: -14 }, sp = [0.8, 0.8, 0.8], nx = 125, ny = 88, nz = 83;
function hu0() { const hu = new Int16Array(nx * ny * nz).fill(-1000); for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bone(box.x0 + i * sp[0], box.y0 + j * sp[1], box.z0 + k * sp[2])) hu[i + nx * (j + ny * k)] = BONE; return hu; }
const HU = hu0();
S.vol = { hu: HU, nx, ny, nz, sp, origin: [box.x0, box.y0, box.z0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-postop' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true);
const th = -40 * Math.PI / 180, AP = V(40 * Math.sin(th), -40 * Math.cos(th), 10), AX = V(Math.cos(th), Math.sin(th), 0);
S.anchor = { p: AP, n: V(0, 0, 1), axis: AX };
S.planes = [{ off: -8, yaw: 0, pitch: 0, w: 1.0 }, { off: 8, yaw: 0, pitch: 0, w: 1.0 }];
await St.rebuildResection();
// the scan moved rigidly: same voxels, origin and axes turned 4° about (0.3, 0.2, 1) and moved (5, -3, 4)
const Mrot = new T.Matrix4().makeRotationAxis(V(0.3, 0.2, 1).normalize(), 4 * Math.PI / 180).setPosition(5, -3, 4);
function moved(hu) { const o = V(box.x0, box.y0, box.z0).applyMatrix4(Mrot); return { hu, nx, ny, nz, sp: sp.slice(), origin: o.toArray(), axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => V(...a).transformDirection(Mrot).toArray()), meta: {} }; }
const lmOf = k => W.PostOp.result().landmarks.find(l => l.key === k);

test('a post-op scan moved by a known transform: registration < 0.1 mm and < 0.1° (each Euler angle too); landmarks still', async () => {
  const hu = HU.slice(); for (let v = 0; v < hu.length; v++) if (S.resMask[v]) hu[v] = SOFT;     // the resection as planned
  await W.PostOp.load(moved(hu), 'test');
  const R = W.PostOp.result(); assert.ok(R, 'a result');
  const Tm = R.T.clone().multiply(Mrot), d = Mx.decompose(Tm.elements, { colMajor: true });
  assert.ok(d.angle < 0.1, 'rotation left ' + d.angle); assert.ok(d.shift < 0.1, 'shift left ' + d.shift);
  const eT = R.reg.euler, eM = Mx.euler(Mrot.clone().invert().elements, { colMajor: true });
  ['x', 'y', 'z'].forEach(k => assert.ok(Math.abs(eT[k] - eM[k]) < 0.1, `${k}: ${eT[k]} vs ${eM[k]}`));
  const keys = R.landmarks.map(l => l.key);
  for (const k of ['condR', 'condL', 'gonR', 'gonL', 'men']) assert.ok(keys.includes(k), JSON.stringify(keys));
  R.landmarks.filter(l => !l.angle).forEach(l => { assert.ok(l.ok, l.name); assert.ok(l.disp < 0.1, `${l.name} ${l.disp}`); });
  R.landmarks.filter(l => l.angle).forEach(l => assert.ok(Math.abs(l.post - l.plan) < 0.1, `${l.name} ${l.plan} -> ${l.post}`));
  R.cuts.filter(c => c.ok).forEach(c => assert.ok(Number.isFinite(c.yaw) && Number.isFinite(c.pitch), JSON.stringify(c)));
  const s = W.PostOp.summary(); assert.ok(s.hizalama_euler_deg && s.noktalar.length >= 5, JSON.stringify(s.noktalar));
});

test('the right ramus moved 1.6 mm after the resection: its condyle and gonion move 1.6 mm, the left side stays', async () => {
  const hu = HU.slice(), r = S.red, n = AX.clone();
  for (let v = 0; v < hu.length; v++) if (S.resMask && S.resMask[v]) hu[v] = SOFT;
  const free = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = i + nx * (j + ny * k); if (hu[v] !== BONE) continue;
    const q = V(box.x0 + i * sp[0], box.y0 + j * sp[1], box.z0 + k * sp[2]);
    if (q.clone().sub(AP).dot(n) < -8 && q.x < 0) free.push(v);
  }
  free.forEach(v => { hu[v] = SOFT; }); free.forEach(v => { hu[v - 2] = BONE; });    // two voxels towards -x (patient right)
  await W.PostOp.load(moved(hu), 'test');
  for (const k of ['condR', 'gonR']) { const l = lmOf(k); assert.ok(l && l.ok, k); near(l.disp, 1.6, 0.2, k); assert.ok(l.d[0] < -1.3, k + ' moved right: ' + JSON.stringify(l.d)); }
  for (const k of ['condL', 'gonL', 'men']) { const l = lmOf(k); assert.ok(l && l.ok && l.disp < 0.2, `${k} ${l && l.disp}`); }
});

await run('post-op CT tool');
