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

test('units (Denetim 4 W15): the block is the projected overhang area in mm², the same for a thin or thick shelf and at half the grid step; under FREE_MM2 is free', () => {
  // shelf over the guide at i 5..13, j 4..15 (9 x 12 cells of 0.5 mm = 27 mm² seen along n), 1 or 3 voxels thick
  const shelf = T => (i, j, k) => k < 8 || (i < 3 && k < 19 + T) || (k >= 16 && k < 16 + T && i < 14);
  const guide = (i, j, k) => k >= 9 && k < 13 && i > 4 && i < 26 && j > 3 && j < 16;
  const thin = Seat.analyze(grid(NX, NY, NZ, shelf(1), guide)), thick = Seat.analyze(grid(NX, NY, NZ, shelf(3), guide));
  near(thin.dirs[0].block, 27, 1e-9, 'thin shelf'); near(thick.dirs[0].block, 27, 1e-9, 'thick shelf (a voxel count would be 3x)');
  // (the base is one fine voxel thicker so the guide still touches it within the contact distance)
  const fine = Seat.analyze(grid(2 * NX, 2 * NY, 2 * NZ, (i, j, k) => k < 17 || shelf(1)(i >> 1, j >> 1, k >> 1), (i, j, k) => guide(i >> 1, j >> 1, k >> 1), 0.25));
  near(fine.dirs[0].block, 27, 1.5, 'half the grid step');
  assert.equal(Seat.FREE_MM2, 2);
  // a single overhanging voxel column (0.25 mm²) is noise: the straight direction stays free
  const speck = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => k < 8 || (i < 3 && k < 19) || (k === 16 && i < 3) || (k === 16 && i === 10 && j === 10), guide));
  assert.ok(speck.dirs[0].block > 0 && speck.dirs[0].block < Seat.FREE_MM2 && speck.best.tilt === 0, JSON.stringify(speck.dirs[0]));
});

test('A2: a shell on a round shaft (the fibula) resists neither rotation about the shaft axis nor sliding along it', () => {
  // shaft along x (u), radius 6 voxels, centre at j = 10, k = 8; the guide wraps the upper half (0.3 mm off)
  const r = Seat.analyze(grid(NX, NY, NZ, (i, j, k) => Math.hypot(j - 10, k - 8) < 6, (i, j, k) => { const d = Math.hypot(j - 10, k - 8); return i > 3 && i < 26 && d >= 6.6 && d < 10 && k >= 8; }));
  assert.ok(r.ok && r.free > 0);
  const rotU = r.axisU.r, slideU = Math.min(...r.slides.filter(x => Math.abs(x.dir[0]) > 0.7).map(x => x.r));
  assert.ok(rotU < 0.05, 'rotation about the shaft resisted by ' + rotU); assert.ok(slideU < 0.05, 'slide along the shaft resisted by ' + slideU);
  assert.ok(Math.hypot(r.axisU.at[1] - 5, r.axisU.at[2] - 4) < 3, 'the free axis runs inside the shaft: ' + r.axisU.at);
  // rotation about the lateral axis is resisted (the shell would lift off one end)
  assert.ok(Math.min(...r.rots.filter(x => x.axis === 'v').map(x => x.r)) > 0.05);
});

// ---------- the fit test (plan 2026-10-30): Seat.freeMoves on the sub-voxel signed distance ----------
// signed distance to the bone (mm, outside > 0) as the kernel builds it before the blur
function fitGrid(nx, ny, nz, boneFn, guideFn, h = 0.5, clear = 0.3) {
  const g = grid(nx, ny, nz, boneFn, guideFn, h), N = nx * ny * nz, dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = g.B[i] ? -h / 2 : g.D[i] * h - h / 2;
  // the guide's inner surface sits `clear` off the bone: guide voxels closer than that are not guide
  for (let i = 0; i < N; i++) if (g.Gm[i] && dist[i] < clear) g.Gm[i] = 0;
  return { Gm: g.Gm, dist, nx, ny, nz, h, lo: [0, 0, 0], clear, d: [0, 0, 1] };
}
const moveOf = (r, kind, axis) => r.moves.filter(m => m.kind === kind && m.axis === axis);

test('fit test: a flat plate on flat bone slides and twists freely (the free directions are reported)', () => {
  const r = Seat.freeMoves(fitGrid(NX, NY, NZ, (i, j, k) => k < 8, (i, j, k) => k >= 8 && k < 13 && i > 3 && i < 26 && j > 3 && j < 16));
  assert.ok(r.ok && r.n > 0);
  assert.ok(r.moves.filter(m => m.kind === 'slide').every(m => m.free), 'every slide on a flat face is free');
  assert.ok(moveOf(r, 'rot', 'd').every(m => m.free), 'twisting on a flat face is free');
  // tilting about u or v pushes one edge into the bone
  assert.ok(moveOf(r, 'rot', 'u').every(m => !m.free) && moveOf(r, 'rot', 'v').every(m => !m.free), JSON.stringify(r.moves.filter(m => m.kind === 'rot').map(m => [m.axis, m.sign, m.free, m.pivot])));
});

test('fit test: a guide in a groove cannot slide across it, only along it', () => {
  const bone = (i, j, k) => k < 8 || ((j < 5 || j > 14) && k < 14);
  const r = Seat.freeMoves(fitGrid(NX, NY, NZ, bone, (i, j, k) => k >= 8 && k < 16 && i > 3 && i < 26 && j >= 5 && j <= 14));
  const sl = r.moves.filter(m => m.kind === 'slide');
  assert.ok(sl.filter(m => Math.abs(m.dir[1]) > 0.5).every(m => !m.free), 'across the groove blocked');
  assert.ok(sl.filter(m => Math.abs(m.dir[0]) > 0.99).every(m => m.free), 'along the groove free');
});

test('fit test: a box over a block fits in one place only, even for a step of a fifth of a voxel', () => {
  // a 10 x 6 block on a base; the guide covers the block's top and four sides
  const blk = (i, j, k) => k < 6 || (i >= 10 && i < 20 && j >= 7 && j < 13 && k < 12);
  const r = Seat.freeMoves(fitGrid(NX, NY, NZ, blk, (i, j, k) => i >= 7 && i < 23 && j >= 4 && j < 16 && k >= 6 && k < 15));
  assert.equal(r.free, 0, JSON.stringify(r.moves.filter(m => m.free).map(m => [m.kind, m.axis, m.az, m.sign])));
  // a step of a fifth of a voxel (0.1 mm) across the block is still seen: the distance is read between the voxels
  const fine = Seat.freeMoves(fitGrid(NX, NY, NZ, blk, (i, j, k) => i >= 7 && i < 23 && j >= 4 && j < 16 && k >= 6 && k < 15), { T: 0.1 });
  assert.equal(fine.free, 0, 'a 0.1 mm slide is blocked: ' + JSON.stringify(fine.moves.filter(m => m.free).map(m => [m.kind, m.axis, m.az])));
});

test('fit test with screws: two pins hold every slide and twist the bone alone lets through; one pin lets it turn about itself', () => {
  const g = fitGrid(NX, NY, NZ, (i, j, k) => k < 8, (i, j, k) => k >= 8 && k < 13 && i > 3 && i < 26 && j > 3 && j < 16);
  const two = Seat.freeMoves(Object.assign({}, g, { screws: [{ el: [4, 5, 4], ol: [0, 0, 1] }, { el: [11, 5, 4], ol: [0, 0, 1] }] }));
  assert.ok(two.free > 0 && two.freeScrewed === 0, `free ${two.free}, with screws ${two.freeScrewed}`);
  const one = Seat.freeMoves(Object.assign({}, g, { screws: [{ el: [7.5, 5, 4], ol: [0, 0, 1] }] }));
  // the one pin stands at the contact centroid: the twist about it stays free, the slides are held
  assert.ok(moveOf(one, 'rot', 'd').every(m => m.freeScrewed), 'one pin: the guide still turns about it');
  assert.ok(one.moves.filter(m => m.kind === 'slide').every(m => !m.freeScrewed), 'one pin holds the slides');
});

await run('seat.js');
