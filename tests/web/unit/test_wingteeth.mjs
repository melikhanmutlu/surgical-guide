// Slot wings and the teeth (Denetim 8, e2e scenario K):
//  - 7a277ac carried the slot rim along each cut over the whole bone the cut goes through (slot wing, for the ramus).
//    On the dentate body of the default real-CT sample the bone the cut goes through runs on over the teeth (and, where
//    the upper jaw is not split off, into the upper jaw): the wings climbed 25 mm over the crowns and the guide sat on a
//    filling (metal under the guide, critical; the default case no longer reached the package). A wing now stops where
//    the teeth begin (CT above the metal threshold: enamel or metal) and never reaches onto them;
//  - the automatic width / lateral centre after a build (app.js regenerate) read the body's extent across v from every
//    guide voxel, the wings too: the 64.8 mm "body" moved the guide 13 mm onto the teeth (vc 3.5 -> 16.5). The body's
//    extent (bodyW / bodyV) now leaves the wing voxels out.
// Each test failed on 7a277ac. Synthetic bone; guide frame = world (u = x, v = y, n = z, top of the bone at z = 0).
// Run: node test_wingteeth.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ extra: { confirm: () => true, fetch: async () => { throw new Error('offline'); } } });
const St = await ready(P); const T = P.g.THREE, S = St.S;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// a tall thin section (as the ramus: 40 mm across v), and a jaw whose bone runs from v = -20 up to v = 34 with teeth
// (crowns, above the metal threshold) at 8 < v < 14: past them the bone of the other jaw (joined, not split off)
const PLATE = q => q.z < 0 && q.z > -6 && Math.abs(q.y) < 20 && Math.abs(q.x) < 70;
const JAW = q => q.z < 0 && q.z > -6 && q.y > -20 && q.y < 34 && Math.abs(q.x) < 70;
const TEETH = q => q.z < 0 && q.z > -6 && q.y > 8 && q.y < 14 && Math.abs(q.x) < 70;
const occ = (gr, uu, vv, nn) => { const i = Math.round((uu - gr.lo[0]) / gr.h), j = Math.round((vv - gr.lo[1]) / gr.h), k = Math.round((nn - gr.lo[2]) / gr.h); if (i < 0 || j < 0 || k < 0 || i >= gr.nx || j >= gr.ny || k >= gr.nz) return 0; return gr.Gm[i + gr.nx * (j + gr.ny * k)]; };
const maxV = gr => { let m = -Infinity; for (let k = 0; k < gr.nz; k++) for (let j = 0; j < gr.ny; j++) for (let i = 0; i < gr.nx; i++) if (gr.Gm[i + gr.nx * (j + gr.ny * k)]) m = Math.max(m, gr.lo[1] + j * gr.h); return m; };
const build = (bone, extra = {}) => St.buildGuide(Object.assign({ P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [], bone, h: 0.4, fast: true, wings: true,
  g: Object.assign({}, St.G_DEFAULT, { wrapU: null, W: 22, wrap: 4 }) }, extra));

test('a slot wing stops below the teeth: it is not carried over the crowns onto the other jaw (7a277ac: to v = 36)', async () => {
  const out = await build(JAW, { hard: TEETH });
  const w = out.result.wings && out.result.wings[0];
  assert.ok(w, 'a wing on the low side (the bone runs on past the body there)');
  near(w[0], -22, 0.6, 'low end: bone edge + 2 mm, as before');
  assert.ok(w[1] <= 11 + 1e-6, 'high end stays at the body edge (v = 11), below the teeth at v = 8..14: ' + w[1]);
  assert.ok(maxV(out.grid) < 14, 'no guide voxel over the teeth or the other jaw: highest v ' + maxV(out.grid));
  assert.equal(occ(out.grid, 1.6, 20, 0.3 + 1), 0, 'no rim beside the slot over the other jaw (v = 20)');
});

test('by default the teeth are read from the CT (above the metal threshold): the same stop without ctx.hard', async () => {
  // a CT that covers the jaw: 3000 HU (enamel) at 8 < y < 14, bone values elsewhere
  const sp = [0.5, 0.5, 0.5], origin = [-80, -30, -12], nx = 321, ny = 141, nz = 41;
  const hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = { x: origin[0] + i * sp[0], y: origin[1] + j * sp[1], z: origin[2] + k * sp[2] };
    hu[i + nx * (j + ny * k)] = TEETH(q) ? 3000 : JAW(q) ? 1500 : -1000;
  }
  const vol0 = S.vol; S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  try {
    const out = await build(JAW);
    const w = out.result.wings && out.result.wings[0];
    assert.ok(w && w[1] <= 11 + 1e-6, 'high end at the body edge: ' + JSON.stringify(w));
  } finally { S.vol = vol0; }
});

test('without teeth (the ramus) the wing is unchanged: over the whole bone, 2 mm past it', async () => {
  const out = await build(PLATE, { hard: () => false });
  const w = out.result.wings && out.result.wings[0];
  assert.ok(w, 'a wing');
  near(w[0], -22, 0.6); near(w[1], 22, 0.6);
});

test('the body width read after a build leaves the wings out (7a277ac: the wings counted, bodyW 44 for a 22 mm body)', async () => {
  const out = await build(PLATE, { hard: () => false });
  assert.ok(out.result.wings, 'wings built');
  assert.ok(maxV(out.grid) > 20, 'the wing voxels are in the guide');
  assert.ok(out.result.bodyW <= 23, 'bodyW is the body: ' + out.result.bodyW);
  assert.ok(out.result.bodyV[0] >= -11.6 && out.result.bodyV[1] <= 11.6, 'bodyV within the body: ' + out.result.bodyV);
  const off = await build(PLATE, { wings: false });
  near(out.result.bodyW, off.result.bodyW, 0.5, 'same width as the guide without wings (within a voxel each side)');
});

await run('test_wingteeth');
