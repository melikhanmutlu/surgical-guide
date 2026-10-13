// seat.js (Seat.analyze): insertion directions, overhanging bone, stability against slides/rotations. Synthetic grids.
// Run: node test_seat.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { plain } from './lib/harness.mjs';
const P = plain(); P.load('geom.js'); P.load('seat.js'); const G = P.eval('G'), Seat = P.eval('Seat');

function grid(nx, ny, nz, boneFn, guideFn, h = 0.5) {
  const N = nx * ny * nz, B = new Uint8Array(N), Gm = new Uint8Array(N);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = i + nx * (j + ny * k); if (boneFn(i, j, k)) B[v] = 1; else if (guideFn(i, j, k)) Gm[v] = 1; }
  return { Gm, B, D: G.edt(B, nx, ny, nz), nx, ny, nz, h, lo: [0, 0, 0], clear: 0.3 };
}
const NX = 30, NY = 20, NZ = 24;

test('flat bone, flat guide on top: every direction of the 40° cone is free, the best one is straight (tilt 0)', () => {
  const r = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => k < 8, (i, j, k) => k >= 9 && k < 13 && i > 3 && i < 26 && j > 3 && j < 16));
  assert.ok(r.ok); assert.equal(r.dirs.length, 33); assert.equal(r.free, 33); assert.equal(r.best.tilt, 0); assert.equal(r.best.block, 0);
  assert.ok(r.area > 0);
});

test('flat contact gives (almost) no resistance to sliding: worst slide resisted share < 5 %', () => {
  const r = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => k < 8, (i, j, k) => k >= 9 && k < 13 && i > 3 && i < 26 && j > 3 && j < 16));
  assert.ok(r.worstSlide.r < 0.05, 'worst slide ' + r.worstSlide.r);
});

test('guide sitting in a groove resists sliding across the groove', () => {
  // bone with two ridges along x (j < 5 and j > 14 rise to k < 14), guide fills the groove between them
  const bone = (i, j, k) => k < 8 || ((j < 5 || j > 14) && k < 14);
  const r = Seat.analyze(grid(NX, NY, NZ, bone, (i, j, k) => k >= 9 && k < 16 && i > 3 && i < 26 && j >= 6 && j <= 13));
  const across = r.slides.filter(s => Math.abs(s.dir[1]) > 0.9);
  assert.ok(across.length && across.every(s => s.r > 0.05), JSON.stringify(across.map(s => s.r)));
});

test('bone overhanging the guide blocks straight insertion; blocking points are reported for the best direction', () => {
  // a bone shelf at k 16..18 over half of the guide, connected to the base by a wall at i < 3
  const bone = (i, j, k) => k < 8 || (i < 3 && k < 19) || (k >= 16 && k < 19 && i < 14);
  const r = Seat.analyze(grid(NX, NY, NZ, bone, (i, j, k) => k >= 9 && k < 13 && i > 4 && i < 26 && j > 3 && j < 16));
  assert.ok(r.ok);
  assert.ok(r.dirs[0].block > 0, 'straight direction must be blocked');
  if (r.best.block > 0) assert.ok(r.blockPts.length > 0);
  else assert.ok(r.best.tilt > 0, 'a free direction exists only when tilted');
});

test('guide far from bone: no contacts -> ok:false (callers then skip the seating checks)', () => {
  const r = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => k < 4, (i, j, k) => k >= 15 && k < 18));
  assert.equal(r.ok, false); assert.equal(r.area, 0);
});

test('units: contact area is in mm² (contacts × h²); halving h at the same geometry keeps area within 25 %', () => {
  const a = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => k < 8, (i, j, k) => k >= 9 && k < 13 && i > 3 && i < 26 && j > 3 && j < 16, 0.5));
  const b = Seat.analyze(grid(2 * NX, 2 * NY, 2 * NZ, (i, j, k) => k < 16, (i, j, k) => k >= 17 && k < 25 && i > 7 && i < 52 && j > 7 && j < 32, 0.25));
  near(b.area, a.area, 0.25 * a.area, 'contact area mm²');
});

await run('seat.js');
