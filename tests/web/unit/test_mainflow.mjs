// Main flow audit (denetim 5, real anonymous CT) regressions on synthetic bone, through window.Studio:
//  - the guide axis of a new centre: the arch tangent is kept over a slanted direction the bone runs a little further
//    along (on the real CT a centre click gave a 45° slant: cuts across the jaw, a 40 mm guide in two pieces)
//  - without an arch the candidate the bone runs furthest along wins
//  - ramusAxis: a body axis near the angle that still follows the arch is not the ramus; one that leaves it is
//  - nearestPiece: a small piece (a tooth crown) a little nearer the centre than the body does not become the resected piece
//  - the symmetry reference is computed as soon as a new volume opens, with the 2 mm mirror fit
// Run: node test_mainflow.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: ['ref.js'] }); const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function volume(bone, box) {
  const sp = [0.8, 0.8, 0.8], nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bone(origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2])) hu[i + nx * (j + ny * k)] = 1200;
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-mainflow' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
// a stub dental arch: points along x (normal +x), so its tangent runs along y
const ARCH_Y = { pts: Array.from({ length: 21 }, (_, i) => ({ x: 0, y: -50 + 5 * i, nx: 1, ny: 0 })) };
const ARCH_X = { pts: Array.from({ length: 21 }, (_, i) => ({ x: -50 + 5 * i, y: 0, nx: 0, ny: 1 })) };

test('chooseAxis: the arch tangent is kept when the bone runs at least 70 % as far along it as along a slant', async () => {
  // a plate 96 x 68 mm, 10 mm thick, top at z = 0: along y the bone runs 68 mm, along the diagonal 90 (the 45 mm cap)
  await volume((x, y, z) => Math.abs(x) < 48 && Math.abs(y) < 34 && z <= 0 && z > -10, { x: 52, y: 40, z: 14 });
  W.Reformat = { arch: () => ARCH_Y };
  try {
    S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 1, 0).normalize() };
    St.chooseAxis(null);
    const runs = Object.fromEntries(S.axisRuns.map(k => [k.from, k.run]));
    assert.ok(runs.pca > runs.arch && runs.arch >= 0.7 * runs.pca, `test set-up: slant runs further, arch within 70 % (${JSON.stringify(runs)})`);
    assert.ok(/^arch/.test(S.anchor.axisFrom), `arch chosen, got ${S.anchor.axisFrom}`);
    assert.ok(Math.abs(S.anchor.axis.y) > 0.95, `axis along the arch (y), got ${S.anchor.axis.toArray().map(x => x.toFixed(2))}`);
  } finally { delete W.Reformat; }
});

test('chooseAxis: without an arch, the candidate the bone runs furthest along wins', async () => {
  // a bar along x, 20 mm wide: the first guess points 20° off y (across the bar); its perpendicular runs along the bar
  await volume((x, y, z) => Math.abs(x) < 48 && Math.abs(y) < 10 && z <= 0 && z > -10, { x: 52, y: 16, z: 14 });
  const a = 20 * Math.PI / 180;
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(Math.sin(a), Math.cos(a), 0) };
  St.chooseAxis(null);
  assert.ok(/^pca90/.test(S.anchor.axisFrom), `perpendicular chosen, got ${S.anchor.axisFrom}`);
  assert.ok(Math.abs(S.anchor.axis.x) > 0.95, `axis along the bar, got ${S.anchor.axis.toArray().map(x => x.toFixed(2))}`);
});

test('ramusAxis: near the angle an axis that follows the arch is the body; one that leaves it for the condyle is the ramus', async () => {
  // the real CT: centre 45 mm from the condyle, the body axis 34° off the direction to it
  const keep = W.Ref, th = 34 * Math.PI / 180, cond = [45 * Math.cos(th), 0, 45 * Math.sin(th)];
  W.Ref = Object.assign({}, keep, { get: () => ({ cond: { R: cond } }) });
  try {
    S.anchor = { p: V(0, 0, 0), n: V(0, -1, 0), axis: V(1, 0, 0) };
    W.Reformat = { arch: () => ARCH_X };
    assert.equal(St.ramusAxis(), false, 'axis along the arch: body');
    S.anchor.axis = V(Math.cos(th), 0, Math.sin(th)).normalize();
    assert.equal(St.ramusAxis(), true, 'axis pointing at the condyle, off the arch: ramus');
    delete W.Reformat; S.anchor.axis = V(1, 0, 0);
    assert.equal(St.ramusAxis(), true, 'no arch known: the condyle test alone (as before)');
  } finally { W.Ref = keep; delete W.Reformat; }
});

test('nearestPiece: a small piece slightly nearer the centre loses to the body; a body far beyond the tie distance does not win', () => {
  const r = { nx: 40, ny: 10, nz: 10, sp: [1, 1, 1], origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }, n = r.nx * r.ny * r.nz;
  const lab = (crownX, bodyFrom) => {
    const L = new Int32Array(n);
    L[crownX + r.nx * (5 + r.ny * 5)] = 2;                                   // one voxel crown
    for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = bodyFrom; i < 40; i++) L[i + r.nx * (j + r.ny * k)] = 1;
    return L;
  };
  const comps = [{ label: 1, size: 3000 }, { label: 2, size: 1 }], q = V(0, 5, 5), lo = [0, 0, 0], hi = [39, 9, 9];
  assert.equal(St.nearestPiece(lab(1, 3), comps, r, lo, hi, q).label, 1, 'crown 1 mm, body 3 mm away: the body');
  assert.equal(St.nearestPiece(lab(1, 10), comps, r, lo, hi, q).label, 2, 'crown 1 mm, body 10 mm away: the crown is the nearest bone');
  assert.equal(St.nearestPiece(new Int32Array(n), comps, r, lo, hi, q), null, 'no bone: null');
});

test('Ref: a new volume gets its midline plane and the 2 mm mirror fit at once (no click needed); a symmetric jaw is not flagged', async () => {
  // a symmetric U-shaped jaw (two bodies joined at the chin), x is the left-right axis
  const U = (x, y, z) => { const inBody = Math.abs(Math.abs(x) - 25) < 5 && y > -35 && y < 15, chin = y >= -40 && y <= -30 && Math.abs(x) < 30; return (inBody || chin) && z <= 0 && z > -14; };
  await volume(U, { x: 36, y: 44, z: 18 });
  S.restoring = false; St.emit('volume', { restoring: false });
  for (let i = 0; i < 200 && !(W.Ref.get() && W.Ref.get().fit !== undefined); i++) await sleep(50);
  const ref = W.Ref.get();
  assert.ok(ref, 'reference computed on the volume event');
  assert.ok(Number.isFinite(ref.fit) && ref.fit >= 0.75, `mirror fit of a symmetric jaw ≥ 0.75, got ${ref.fit}`);
  near(Math.abs(ref.n[0]), 1, 0.05, 'plane normal along x');
  const warn = (W.ExtraChecks || []).flatMap(f => { try { return f() || []; } catch (e) { return []; } }).filter(c => /ayna görüntüsüyle/.test(c[2]));
  assert.equal(warn.length, 0, 'no mirror warning');
});

test('Guide screws: an automatic mandible guide screw ends 1 mm inside the far cortex instead of passing through it', async () => {
  // a bar 9 mm thick under the guide: the 12 mm default would leave its tip 3 mm out of the far side
  await volume((x, y, z) => Math.abs(x) < 48 && Math.abs(y) < 10 && z <= 0 && z > -9, { x: 52, y: 16, z: 14 });
  S.g.split = 0; S.lesion.condyle = null; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2 }, { off: 15, yaw: 0, pitch: 0, w: 1.2 }];
  S.screws = []; St.placeScrews();
  assert.ok(S.screws.length >= 2, 'screws placed');
  for (const sc of S.screws) {
    const w = St.screwWorld(sc), tip = w.entry.clone().addScaledVector(w.dir, sc.len);
    assert.ok(sc.len >= 6 && sc.len < 12, `shortened, got ${sc.len}`);
    assert.ok(tip.z > -9 + 0.5, `tip inside the bone (z ${tip.z.toFixed(1)})`);
  }
  // a screw the surgeon placed keeps its length
  const hand = Object.assign({}, S.screws[0], { hand: 1, len: 12 }); S.screws = [hand]; St.placeScrews();
  assert.equal(S.screws.find(sc => sc.hand).len, 12, 'hand-placed screw keeps its length');
});

await run('test_mainflow');
