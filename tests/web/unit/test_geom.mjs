// geom.js (G): index/world transforms, block reduction, resampling, threshold, components, exterior fill, EDT, blur,
// surface nets, seeded split. Synthetic volumes only.   Run: node test_geom.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { plain } from './lib/harness.mjs';
const P = plain(); P.load('geom.js'); const G = P.eval('G');

const ball = (n, r, c = [(n - 1) / 2, (n - 1) / 2, (n - 1) / 2]) => { const m = new Uint8Array(n * n * n); for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i - c[0]) ** 2 + (j - c[1]) ** 2 + (k - c[2]) ** 2 <= r * r) m[i + n * (j + n * k)] = 1; return m; };
// rotation about z by 30° then tilt: an oblique, right-handed DICOM frame
const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
const OBL = { nx: 10, ny: 12, nz: 8, sp: [0.5, 0.7, 1.25], origin: [-12.5, 30, 101], axes: [[c30, s30, 0], [-s30, c30, 0], [0, 0, 1]] };

test('worldOf/indexOf round trip on an oblique, anisotropic grid', () => {
  for (const ijk of [[0, 0, 0], [3, 7, 2], [9.5, 0.25, 7]]) {
    const w = G.worldOf(OBL, ...ijk), b = G.indexOf(OBL, w);
    ijk.forEach((x, a) => near(b[a], x, 1e-9, 'axis ' + a));
  }
  // spacing is applied in mm: one step in j moves 0.7 mm along the second axis
  const a = G.worldOf(OBL, 0, 0, 0), b = G.worldOf(OBL, 0, 1, 0);
  near(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.7, 1e-12);
});

test('reduce: 2x2x2 binning averages HU and puts the origin at the bin centre', () => {
  const nx = 4, ny = 4, nz = 4, hu = new Int16Array(64);
  for (let v = 0; v < 64; v++) hu[v] = v;   // linear ramp: bin mean is the value at the bin centre
  const vol = { hu, nx, ny, nz, sp: [0.4, 0.4, 0.4], origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  const r = G.reduce(vol, 0.8);
  assert.deepEqual([r.nx, r.ny, r.nz], [2, 2, 2]);
  r.sp.forEach(s => near(s, 0.8, 1e-12));
  r.origin.forEach(o => near(o, 0.2, 1e-12));
  // bin (0,0,0) covers i,j,k in {0,1}: mean of v = i + 4j + 16k = 0.5 + 2 + 8 = 10.5 -> Int16 truncation gives 10
  assert.equal(r.hu[0], 10);
  // world position of reduced voxel (1,1,1) equals the mean of the source voxel centres it covers
  const w = G.worldOf(r, 1, 1, 1); w.forEach(x => near(x, 1.0, 1e-12));
});

test('reduce: already-coarse volume (sp > target) is passed through at factor 1', () => {
  const vol = { hu: new Int16Array(27).fill(7), nx: 3, ny: 3, nz: 3, sp: [1, 1, 2], origin: [1, 2, 3], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  const r = G.reduce(vol, 0.8);
  assert.deepEqual([r.nx, r.ny, r.nz], [3, 3, 3]); assert.deepEqual([...r.sp], [1, 1, 2]); assert.deepEqual([...r.origin], [1, 2, 3]);
});

test('reduce -> resample path when the binned grid exceeds maxVox (thin-slice study)', () => {
  const n = 40, hu = new Int16Array(n * n * n).fill(100);
  const vol = { hu, nx: n, ny: n, nz: n, sp: [0.2, 0.2, 0.2], origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  const r = G.reduce(vol, 0.2, 1000);   // factor 1 would keep 64000 voxels > 1000
  assert.ok(r.nx * r.ny * r.nz <= 1000, `got ${r.nx * r.ny * r.nz} voxels`);
  assert.ok(r.hu.every(x => x === 100), 'constant field stays constant after trilinear resampling');
  // physical extent is preserved within one output voxel
  near(r.nx * r.sp[0], n * 0.2, r.sp[0] + 1e-9);
});

test('threshold is strict (> thr)', () => {
  const m = G.threshold({ hu: Int16Array.from([249, 250, 251]) }, 250);
  assert.deepEqual([...m], [0, 0, 1]);
});

test('components: 6-connectivity, size filter, sorted by size, centroid in voxel units', () => {
  const nx = 6, ny = 3, nz = 1, m = new Uint8Array(18);
  // a 3-voxel bar at j=0 (i=0..2), a single voxel at (5,2), and a diagonal neighbour (4,1) that is NOT 6-connected to (5,2)
  [0, 1, 2].forEach(i => { m[i] = 1; }); m[5 + 6 * 2] = 1; m[4 + 6 * 1] = 1;
  const { labels, comps } = G.components(m, nx, ny, nz, 1);
  assert.equal(comps.length, 3);
  assert.equal(comps[0].size, 3); near(comps[0].centroid[0], 1, 1e-12);
  assert.notEqual(labels[5 + 12], labels[4 + 6]);
  assert.equal(G.components(m, nx, ny, nz, 2).comps.length, 1, 'minSize drops singletons');
  assert.equal(G.components(new Uint8Array(18), nx, ny, nz).comps.length, 0, 'empty mask');
});

test('exterior: a closed cavity is not reached from the border, an open one is', () => {
  const n = 9, shell = ball(n, 3.6), inner = ball(n, 2);
  for (let v = 0; v < shell.length; v++) if (inner[v]) shell[v] = 0;   // hollow ball
  const out = G.exterior(shell, n, n, n), c = 4 + n * (4 + n * 4);
  assert.equal(out[c], 0, 'centre of the closed cavity is interior');
  assert.equal(out[0], 1, 'corner is exterior');
  // drill a hole along +x from the cavity to the border
  for (let i = 4; i < n; i++) shell[i + n * (4 + n * 4)] = 0;
  assert.equal(G.exterior(shell, n, n, n)[c], 1, 'opened cavity is exterior');
});

test('edt equals brute-force Euclidean distance (voxel units) on a random feature set', () => {
  const nx = 7, ny = 5, nz = 6, N = nx * ny * nz, f = new Uint8Array(N);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let v = 0; v < N; v++) f[v] = rnd() < 0.05 ? 1 : 0;
  f[0] = 1;
  const D = G.edt(f, nx, ny, nz);
  let worst = 0;
  for (let v = 0; v < N; v++) {
    const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / (nx * ny)) | 0; let b = Infinity;
    for (let w = 0; w < N; w++) if (f[w]) { const a = w % nx, c = ((w / nx) | 0) % ny, e = (w / (nx * ny)) | 0; b = Math.min(b, Math.hypot(i - a, j - c, k - e)); }
    worst = Math.max(worst, Math.abs(D[v] - b));
  }
  assert.ok(worst < 1e-4, 'max error ' + worst);
});

test('edt: no feature voxel at all gives a huge distance (1e10), single-line grids work', () => {
  const D = G.edt(new Uint8Array(8), 8, 1, 1);
  assert.ok(D.every(x => x > 1e9));
  const f = new Uint8Array(5); f[2] = 1; assert.deepEqual([...G.edt(f, 5, 1, 1)], [2, 1, 0, 1, 2]);
  const g = new Uint8Array(5); g[4] = 1; assert.deepEqual([...G.edt(g, 1, 1, 5)], [4, 3, 2, 1, 0], 'z-only grid');
});

test('blur: [1 2 1]/4 per axis, constant field preserved, single voxel spreads to 27 with weights summing to 1', () => {
  const n = 5, m = new Uint8Array(n * n * n); m[2 + n * (2 + n * 2)] = 1;
  const b = G.blur(m, n, n, n);
  near(b.reduce((s, x) => s + x, 0), 1, 1e-6); near(b[2 + n * (2 + n * 2)], 0.125, 1e-7);
  near(b[1 + n * (1 + n * 1)], 1 / 64, 1e-7);
  assert.ok(G.blur(new Uint8Array(27).fill(1), 3, 3, 3).every(x => Math.abs(x - 1) < 1e-6));
});

// mesh helpers
function meshStats(net) {
  const P = net.positions, I = net.indices, edges = new Map(); let vol = 0, area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    [[a, b], [b, c], [c, a]].forEach(([x, y]) => { const k = x < y ? x + ',' + y : y + ',' + x; edges.set(k, (edges.get(k) || 0) + 1); });
    const A = [P[3 * a], P[3 * a + 1], P[3 * a + 2]], B = [P[3 * b], P[3 * b + 1], P[3 * b + 2]], C = [P[3 * c], P[3 * c + 1], P[3 * c + 2]];
    vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  const open = [...edges.values()].filter(x => x !== 2).length;
  return { vol, area, open, tris: I.length / 3 };
}

test('surfaceNets on a blurred ball: closed (every edge shared by 2 triangles), outward-facing, volume within 5 %', () => {
  const n = 24, r = 8, F = G.blur(ball(n, r), n, n, n);
  const s = meshStats(G.surfaceNets(F, n, n, n, 0.5));
  assert.equal(s.open, 0, 'open edges');
  assert.ok(s.vol > 0, 'signed volume must be positive (outward normals); got ' + s.vol);
  near(s.vol, 4 / 3 * Math.PI * r ** 3, 0.05 * 4 / 3 * Math.PI * r ** 3, 'volume');
});

test('surfaceNets box limits the meshed cells; an empty or full field gives no triangles', () => {
  const n = 24, F = G.blur(ball(n, 8), n, n, n);
  const all = G.surfaceNets(F, n, n, n, 0.5), half = G.surfaceNets(F, n, n, n, 0.5, [0, 0, 0, n - 1, n - 1, 11]);
  assert.ok(half.indices.length > 0 && half.indices.length < all.indices.length);
  for (let t = 0; t < half.positions.length; t += 3) assert.ok(half.positions[t + 2] <= 12.0001);
  assert.equal(G.surfaceNets(new Float32Array(n * n * n), n, n, n).indices.length, 0);
  assert.equal(G.surfaceNets(new Float32Array(n * n * n).fill(1), n, n, n).indices.length, 0);
});

test('surfaceNets: a solid touching the grid border is left open there (known limitation, mesh not watertight)', () => {
  const n = 10, m = new Uint8Array(n * n * n);
  for (let k = 0; k < 5; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) m[i + n * (j + n * k)] = 1;   // slab to the border
  const s = meshStats(G.surfaceNets(G.blur(m, n, n, n), n, n, n));
  assert.ok(s.open > 0, 'expected open boundary edges for a solid cut by the grid border');
});

test('splitSeeds: two dense blocks joined by a low-density neck split at the neck', () => {
  const nx = 21, ny = 5, nz = 5, N = nx * ny * nz, hu = new Int16Array(N), dom = new Uint8Array(N), seeds = new Uint8Array(N);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = i + nx * (j + ny * k); dom[v] = 1; hu[v] = i === 10 ? 260 : 1200; }
  seeds[2 + nx * (2 + ny * 2)] = 1; seeds[18 + nx * (2 + ny * 2)] = 2;
  const { lab, box } = G.splitSeeds({ nx, ny, nz, hu }, dom, seeds);
  assert.deepEqual([...box], [0, 0, 0, 20, 4, 4]);
  for (let i = 0; i < nx; i++) { const l = lab[i + nx * (2 + ny * 2)]; if (i < 10) assert.equal(l, 1, 'i=' + i); if (i > 10) assert.equal(l, 2, 'i=' + i); }
  assert.ok(lab.every((x, v) => !dom[v] || x > 0), 'every domain voxel labelled');
  assert.equal(G.splitSeeds({ nx, ny, nz, hu }, new Uint8Array(N), seeds).box, null, 'empty domain');
});

test('splitSeeds: a domain without any seed returns all zeros (no crash, no infinite loop)', () => {
  const nx = 4, ny = 4, nz = 4, N = 64, dom = new Uint8Array(N).fill(1);
  const { lab } = G.splitSeeds({ nx, ny, nz, hu: new Int16Array(N).fill(1000) }, dom, new Uint8Array(N));
  assert.ok(lab.every(x => x === 0));
});

test('NaN in HU input: threshold treats NaN as background, components/edt stay finite', () => {
  const m = G.threshold({ hu: Float32Array.from([NaN, 500, NaN]) }, 250);
  assert.deepEqual([...m], [0, 1, 0]);
  assert.ok([...G.edt(m, 3, 1, 1)].every(Number.isFinite));
});

await run('geom.js');
