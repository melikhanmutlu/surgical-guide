// metrics.js (plan Faz 0.1): surface distances, plane angle / offset, rigid transform decomposition, Kabsch and ICP,
// on shapes with known answers (two parallel planes, a cube and its shifted copy, a rotated point cloud).
// Run: node test_metrics.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { plain } from './lib/harness.mjs';
const P = plain(); P.load('metrics.js'); const M = P.eval('Metrics');

// a flat square grid of n x n quads at height z (side `s` mm)
function sheet(n, s, z, shift = [0, 0]) {
  const pos = [], idx = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(shift[0] + i * s / n, shift[1] + j * s / n, z);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = i + (n + 1) * j, b = a + 1, c = a + n + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
// an axis-aligned box as 12 triangles
function box(lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
  return { positions: Float32Array.from(v.flat()), indices: Uint32Array.from(f.flat()) };
}

test('two parallel sheets 0.5 mm apart: every distance 0.5 (mean, RMS, HD95, max), all within 2 mm', () => {
  const r = M.surfaceDistance(sheet(20, 30, 0.5, [5, 5]), sheet(10, 40, 0));
  near(r.mean, 0.5, 1e-6); near(r.rms, 0.5, 1e-6); near(r.hd95, 0.5, 1e-6); near(r.max, 0.5, 1e-6);
  assert.equal(r.within, 1);
});

test('point-to-triangle, not point-to-vertex: a coarse target still gives the exact plane distance', () => {
  // the target has vertices only every 20 mm; the sample points lie between them
  const r = M.surfaceDistance(sheet(7, 20, 0.25, [3, 4]), sheet(2, 40, 0));
  near(r.max, 0.25, 1e-6);
});

test('a known distance distribution: share within the tolerance and the 95th percentile', () => {
  // 101 points above a large sheet at heights 0, 0.03, ..., 3.0 mm
  const pts = []; for (let i = 0; i <= 100; i++) pts.push(10, 10, 0.03 * i);
  const r = M.surfaceDistance({ positions: Float32Array.from(pts) }, sheet(4, 40, 0), { tol: 2 });
  near(r.within, 67 / 101, 1e-9, 'heights <= 2.0 mm: 0..66');
  near(r.hd95, 0.03 * 95, 1e-5); near(r.median, 1.5, 1e-5); near(r.max, 3, 1e-5);
  near(r.mean, 1.5, 1e-5);
});

test('a cube and its copy shifted 0.7 mm: symmetric HD95 0.7, mean below it (faces parallel to the shift are at 0)', () => {
  const A = box([0, 0, 0], [20, 20, 20]), B = box([0.7, 0, 0], [20.7, 20, 20]);
  const r = M.surfaceDistance(A, B, { symmetric: true });
  near(r.sym.max, 0.7, 1e-6); near(r.sym.hd95, 0.7, 1e-6);
  // the corners sit on the shifted cube's faces or 0.7 mm off them: only the x faces' corners are off
  assert.ok(r.ab.mean > 0 && r.ab.mean <= 0.7 + 1e-9);
});

test('plane angle and offset: 7° apart, 1.5 mm along the first normal; normals pointing either way are the same plane', () => {
  const a = { p: [0, 0, 0], n: [0, 0, 1] }, t = 7 * Math.PI / 180, b = { p: [3, -2, 1.5], n: [Math.sin(t), 0, Math.cos(t)] };
  near(M.planeAngle(a, b), 7, 1e-9); near(M.planeOffset(a, b), 1.5, 1e-12);
  near(M.planeAngle(a, { p: [0, 0, 0], n: [0, 0, -1] }), 0, 1e-9);
  near(M.planeAngle(a, { p: [0, 0, 0], n: [1, 0, 0] }), 90, 1e-9);
});

test('decompose: axis-angle 7° and translation 3 mm, in row-major 4x4, three.js column-major and {R, t}', () => {
  const R = M.rotation([1, 2, 2], 7), t = [1, 2, 2];
  const rm = [R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1];
  const cm = [0, 1, 2, 3].flatMap(c => [0, 1, 2, 3].map(r => rm[r * 4 + c]));
  for (const d of [M.decompose({ R, t }), M.decompose(rm), M.decompose({ elements: cm })]) {
    near(d.angle, 7, 1e-9); near(d.shift, 3, 1e-12);
    [1 / 3, 2 / 3, 2 / 3].forEach((x, i) => near(d.axis[i], x, 1e-9, 'axis ' + i));
  }
  // a rotation about a point: no displacement of that point
  const c = [10, 20, 30], Rc = [0, 1, 2].map(i => R[i][0] * c[0] + R[i][1] * c[1] + R[i][2] * c[2]);
  const about = M.decompose({ R, t: [c[0] - Rc[0], c[1] - Rc[1], c[2] - Rc[2]] }, { about: c });
  near(about.shift, 0, 1e-9); near(about.angle, 7, 1e-9);
});

test('Kabsch: recovers a rotation of 25° and a 12 mm translation from point pairs (< 0.01 mm, < 0.01°); no reflection', () => {
  const R = M.rotation([0.3, -1, 0.5], 25), t = [4, -8, 8], src = [];
  for (let i = 0; i < 40; i++) src.push([Math.sin(i) * 30, Math.cos(1.7 * i) * 20, (i % 7) * 4]);
  const dst = src.map(p => M.apply({ R, t }, p));
  const f = M.kabsch(src, dst), d = M.decompose(f);
  near(d.angle, 25, 0.01); near(Math.hypot(...f.t.map((x, i) => x - t[i])), 0, 0.01); assert.ok(f.rms < 1e-6);
  // det(R) = +1
  const Rm = f.R, det = Rm[0][0] * (Rm[1][1] * Rm[2][2] - Rm[1][2] * Rm[2][1]) - Rm[0][1] * (Rm[1][0] * Rm[2][2] - Rm[1][2] * Rm[2][0]) + Rm[0][2] * (Rm[1][0] * Rm[2][1] - Rm[1][1] * Rm[2][0]);
  near(det, 1, 1e-9);
  // planar points (a flat cloud) still give a proper rotation
  const flat = src.map(p => [p[0], p[1], 0]), f2 = M.kabsch(flat, flat.map(p => M.apply({ R, t }, p)));
  near(M.decompose(f2).angle, 25, 0.01);
});

test('ICP: a cloud moved 4° and 1.5 mm comes back onto its surface (< 0.05 mm RMS)', () => {
  // an irregular closed surface: a box with a bump (two boxes' vertices) as the target cloud, dense enough
  const pos = []; for (let k = 0; k <= 10; k++) for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) {
    if (i && j && k && i < 10 && j < 10 && k < 10) continue;     // the shell of a 20 x 14 x 10 box
    pos.push(i * 2 + 0.3 * Math.sin(j), j * 1.4, k * (1 + 0.02 * i));
  }
  const dst = { positions: Float32Array.from(pos) }, R = M.rotation([0, 0.2, 1], 4), t = [1, -1, 0.5];
  const cloud = []; for (let v = 0; v < pos.length / 3; v += 3) cloud.push(M.apply({ R, t }, [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]));
  const r = M.icp(cloud, dst, { iters: 80 });
  assert.ok(r.rms < 0.05, 'rms ' + r.rms);
  const back = M.decompose(M.compose(r, { R, t }));
  assert.ok(back.angle < 0.1 && back.shift < 0.1, JSON.stringify(back));
});

await run('metrics');
