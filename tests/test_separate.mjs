// Bones that a threshold joins: G.edt (anisotropic), G.separator / G.separate (watershed with neck / core merging) and
// Bones.pickMandible / Bones.boneWarnings, on synthetic volumes only.   Run: node tests/test_separate.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { plain, REPO } from './lib/load.mjs';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
const P = plain('geom.js', 'bones.js'), G = P.eval('G'), B = P.eval('Bones');

// ---- tiny volume builder: 1 mm voxels unless sp is given; shapes are added with fill(shapeFn) ----
function grid(nx, ny, nz, sp = [1, 1, 1]) {
  const m = new Uint8Array(nx * ny * nz), at = (i, j, k) => i + nx * (j + ny * k);
  const fill = f => { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (f(i * sp[0], j * sp[1], k * sp[2])) m[at(i, j, k)] = 1; };
  const count = () => m.reduce((s, x) => s + x, 0);
  return { nx, ny, nz, sp, m, fill, at, count };
}
// capsule-free solid cylinder along an axis through (a, b): axis 'x' | 'y' | 'z', from t0 to t1, radius r
const cyl = (axis, a, b, t0, t1, r) => (x, y, z) => {
  const [t, u, v] = axis === 'x' ? [x, y, z] : axis === 'y' ? [y, x, z] : [z, x, y];
  return t >= t0 && t <= t1 && (u - a) ** 2 + (v - b) ** 2 <= r * r;
};
const or = (...fs) => (x, y, z) => fs.some(f => f(x, y, z));

test('edt: anisotropic voxels give the distance in mm', () => {
  // a slab of 6 voxels in z (k = 1..6) with 2 mm z-spacing: voxel k = 3 is 3 voxels = 6 mm from the empty layer k = 0
  const g = grid(9, 9, 9, [1, 1, 2]); g.fill((x, y, z) => z >= 2 && z <= 12);
  const feat = new Uint8Array(g.m.length); for (let v = 0; v < feat.length; v++) feat[v] = g.m[v] ? 0 : 1;
  const D = G.edt(feat, g.nx, g.ny, g.nz, g.sp);
  near(D[g.at(4, 4, 3)], 6, 1e-4);
  near(D[g.at(4, 4, 1)], 2, 1e-4);
  // without spacing the same grid is in voxel units
  const Dv = G.edt(feat, g.nx, g.ny, g.nz);
  near(Dv[g.at(4, 4, 3)], 3, 1e-4);
});

test('separate: two cylinders joined by a thin bridge are two pieces, each keeps its full length', () => {
  const g = grid(100, 60, 60);
  // tibia-like (r 9) and fibula-like (r 5) rods, 80 mm long, 20 mm apart (surface to surface 6 mm); a 2 mm thick plate joins them over 12 mm
  const bridge = (x, y, z) => x >= 44 && x <= 56 && y >= 21 && y <= 31 && z >= 29 && z <= 31;
  g.fill(or(cyl('x', 14, 30, 10, 90, 9), cyl('x', 34, 30, 10, 90, 5), bridge));
  const total = g.count();
  assert.equal(G.components(g.m, g.nx, g.ny, g.nz, 1).comps.length, 1, 'the threshold mask is one piece');
  const r = G.separate(g.m, g.nx, g.ny, g.nz, g.sp, { ratio: 0.45, minSize: 100 });
  assert.equal(r.comps.length, 2);
  assert.equal(r.comps[0].size + r.comps[1].size, total, 'every voxel belongs to a piece');
  const thick = r.comps[0], thin = r.comps[1];
  near(thick.peak, 9, 0.8); near(thin.peak, 5, 0.8);
  // the thin rod keeps its whole length (80 mm) and the thick one too
  near(thin.box[3] - thin.box[0] + 1, 81, 1); near(thick.box[3] - thick.box[0] + 1, 81, 1);
  // the pieces are on their own side of the neck: thin piece centroid y ~ 46
  assert.ok(Math.abs(thin.centroid[1] - 34) < 2, 'thin rod centroid on its own axis (y = 34), got ' + thin.centroid[1]);
});

test('separate: one bone with a thick side branch stays one piece', () => {
  const g = grid(80, 80, 60);
  g.fill(or(cyl('x', 30, 30, 5, 75, 8), cyl('y', 40, 30, 30, 75, 6)));     // T junction, both thick
  const r = G.separate(g.m, g.nx, g.ny, g.nz, g.sp, { ratio: 0.45, minSize: 100 });
  assert.equal(r.comps.length, 1);
});

test('separate: pieces that are not connected stay separate, tiny ones are dropped by minSize', () => {
  const g = grid(80, 40, 40);
  g.fill(or(cyl('x', 20, 20, 5, 30, 6), cyl('x', 20, 20, 45, 75, 6), (x, y, z) => x === 2 && y === 2 && z === 2));
  const r = G.separate(g.m, g.nx, g.ny, g.nz, g.sp, { ratio: 0.45, minSize: 50 });
  assert.equal(r.comps.length, 2);
  assert.equal(r.labels[g.at(2, 2, 2)] > 0, true, 'a dropped piece is still labelled, just not listed');
});

test('separator: runs with other ratios reuse the distance transform; restore puts the original label back', () => {
  const g = grid(100, 60, 60);
  const bridge = (x, y, z) => x >= 44 && x <= 56 && y >= 21 && y <= 31 && z >= 29 && z <= 31;
  g.fill(or(cyl('x', 14, 30, 10, 90, 9), cyl('x', 34, 30, 10, 90, 5), bridge));
  const lab = new Int32Array(g.m.length); for (let v = 0; v < lab.length; v++) lab[v] = g.m[v] ? 7 : 0;
  const sep = G.separator(lab, g.nx, g.ny, g.nz, g.sp, { label: 7 });
  const lo = sep.run({ ratio: 0.2, base: 100, out: lab, minSize: 100 });        // everything merges
  assert.equal(lo.length, 1);
  const hi = sep.run({ ratio: 0.45, base: 100, out: lab, minSize: 100 });
  assert.equal(hi.length, 2); assert.ok(hi.every(c => c.label > 100));
  assert.equal(hi.ids >= 2, true);
  sep.restore(7);
  let n7 = 0; for (let v = 0; v < lab.length; v++) if (lab[v] === 7) n7++;
  assert.equal(n7, g.count());
});

test('separate: empty mask', () => {
  const r = G.separate(new Uint8Array(1000), 10, 10, 10, [1, 1, 1], {});
  assert.equal(r.comps.length, 0);
});

// ---- a head: vault (thin hollow shell) + mandible arch + vertebral column, all touching through thin necks ----
function head() {
  const g = grid(150, 150, 220, [1, 1, 1]);
  const skull = (x, y, z) => { const d = Math.hypot((x - 75) / 70, (y - 75) / 60, (z - 150) / 60); return d <= 1 && d >= 0.9 && z > 120; };   // vault, 5-6 mm thick
  g.fill(skull);
  // mandible: a U-shaped arch of 7 mm radius tube (spheres along the path, chin to the front), two rami going up to
  // thin 2.5 mm necks (the joints) at the skull base; a vertebral column behind joins the vault through a thin neck too
  const pts = []; for (let a = 180; a <= 360; a += 2) pts.push([75 + 55 * Math.cos(a * Math.PI / 180), 90 + 55 * Math.sin(a * Math.PI / 180), 70]);
  const tube = (x, y, z) => pts.some(([px, py, pz]) => (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= 49);
  const ramus = (x0) => cyl('z', x0, 90, 70, 118, 6);
  const neck = (x0) => cyl('z', x0, 90, 118, 128, 2.5);
  const vertebrae = cyl('z', 75, 125, 0, 125, 9);
  g.fill(or(tube, ramus(20), ramus(130), neck(20), neck(130), vertebrae, cyl('z', 75, 125, 120, 128, 3)));
  return g;
}

test('pickMandible: a skull + mandible + spine component is cut and the mandible piece is taken', () => {
  const g = head(), red = { nx: g.nx, ny: g.ny, nz: g.nz, sp: g.sp };
  const { labels, comps, count } = G.components(g.m, g.nx, g.ny, g.nz, 200);
  const vox = 1e-3;
  assert.ok(comps[0].size * vox > 0, 'sanity');
  const res = B.pickMandible(red, labels, comps, count);
  // the whole thing is too tall / wide for a mandible: it must be cut (or fail loudly), never silently accepted
  assert.notEqual(res.status, 'whole');
  assert.equal(res.status, 'split');
  {
    const c = res.comps.find(x => x.label === res.picked);
    // the picked piece lies in the lower part of the volume and is not the vault
    assert.ok(c.centroid[2] < 110, 'picked piece is below the vault: z centroid ' + c.centroid[2]);
    assert.ok(res.ext[2] <= B.LIM.height);
    // no vault voxel in the picked piece
    let vault = 0; for (let k = 130; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (labels[i + g.nx * (j + g.ny * k)] === res.picked) vault++;
    assert.equal(vault, 0);
  }
});

test('pickMandible runs in the background thread (gworker.js) with the same result as in the page', () => {
  // the worker script in a bare context: importScripts loads the web/ files, postMessage is captured
  const out = [], g = { console, performance, setTimeout, clearTimeout, postMessage: (m, tr) => out.push(m) };
  g.self = g; g.globalThis = g; const ctx = vm.createContext(g);
  g.importScripts = (...fs_) => fs_.forEach(f => vm.runInContext(fs.readFileSync(path.join(REPO, 'web', f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(REPO, 'web', 'gworker.js'), 'utf8'), ctx, { filename: 'gworker.js' });
  const h = head(), red = { nx: h.nx, ny: h.ny, nz: h.nz, sp: h.sp };
  const a = G.components(h.m, h.nx, h.ny, h.nz, 200), b = G.components(h.m, h.nx, h.ny, h.nz, 200);
  const res = B.pickMandible(red, a.labels, a.comps, a.count);
  g.onmessage({ data: { id: 7, op: 'pickMandible', red, labels: b.labels, comps: b.comps, count: b.count } });
  assert.equal(out.length, 1); assert.equal(out[0].id, 7); assert.ok(!out[0].error, out[0].error);
  const w = out[0].out;
  assert.equal(w.res.status, res.status); assert.equal(w.res.picked, res.picked);
  let diff = 0; for (let v = 0; v < a.labels.length; v++) if (a.labels[v] !== w.labels[v]) diff++;
  assert.equal(diff, 0, 'the relabelled volume comes back');
});

test('pickMandible: a mandible-sized component is left alone (status whole, labels unchanged)', () => {
  const g = grid(130, 120, 90);
  const pts = []; for (let a = 200; a <= 340; a += 3) pts.push([65 + 42 * Math.cos(a * Math.PI / 180), 100 + 42 * Math.sin(a * Math.PI / 180), 40]);
  g.fill((x, y, z) => pts.some(([px, py, pz]) => (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= 49));
  const red = { nx: g.nx, ny: g.ny, nz: g.nz, sp: g.sp };
  const { labels, comps, count } = G.components(g.m, g.nx, g.ny, g.nz, 200);
  const before = Int32Array.from(labels);
  const res = B.pickMandible(red, labels, comps, count);
  assert.equal(res.status, 'whole'); assert.equal(res.picked, comps[0].label);
  assert.deepEqual(Array.from(labels), Array.from(before));
});

test('pickMandible: nothing mandible-like inside a too-big component -> failed, labels restored', () => {
  const g = grid(150, 150, 150);
  g.fill(cyl('z', 75, 75, 0, 149, 40));                       // a 750 cm3 solid column: too big, and no neck to cut
  const red = { nx: g.nx, ny: g.ny, nz: g.nz, sp: g.sp };
  const { labels, comps, count } = G.components(g.m, g.nx, g.ny, g.nz, 200);
  const top = comps[0].label, before = Int32Array.from(labels);
  const res = B.pickMandible(red, labels, comps, count);
  assert.equal(res.status, 'failed'); assert.equal(res.picked, top);
  assert.deepEqual(Array.from(labels), Array.from(before), 'a failed cut leaves the labels as they were');
});

test('boneWarnings: too big, and cut off by the scan range', () => {
  const g = grid(100, 100, 100), red = { nx: 100, ny: 100, nz: 100, sp: [1, 1, 1] };
  g.fill((x, y, z) => x < 70 && y < 70 && z < 70);           // 343 cm3, touches z = 0
  const w = B.boneWarnings(red, g.m).map(x => x.code);
  assert.deepEqual(JSON.parse(JSON.stringify(w)).sort(), ['big', 'edge']);
  const h = grid(100, 100, 100); h.fill((x, y, z) => x > 20 && x < 60 && y > 20 && y < 50 && z > 20 && z < 50);
  assert.equal(B.boneWarnings(red, h.m).length, 0);
  assert.equal(B.boneWarnings(red, new Uint8Array(1e6)).length, 0);
});

// one ramus with its condyle handed to the skull piece by the neck cut (real CT, Denetim 5): the healthy side's mirror
// image gives it back; the skull base it touched, and a block touching only the healthy side, stay where they are
function oneSidedJaw() {
  const g = grid(150, 110, 120);
  const pts = []; for (let a = 0; a <= 180; a += 2) pts.push([75 + 50 * Math.cos(a * Math.PI / 180), 30 + 50 * Math.sin(a * Math.PI / 180), 30]);
  const arch = (x, y, z) => pts.some(([px, py, pz]) => (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= 36);
  const ramusR = cyl('z', 25, 30, 30, 85, 5), ramusL = cyl('z', 125, 30, 30, 85, 5);
  const neckR = cyl('z', 25, 30, 85, 92, 2), neckL = cyl('z', 125, 30, 85, 92, 2);
  const base = (x, y, z) => x >= 10 && x <= 140 && y >= 10 && y <= 60 && z >= 92 && z <= 112;
  const lab = new Int32Array(g.nx * g.ny * g.nz);
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const v = g.at(i, j, k);
    if (arch(i, j, k) || ramusL(i, j, k)) lab[v] = 1;                 // the mandible as cut: arch + left ramus
    else if (ramusR(i, j, k) || neckR(i, j, k) || neckL(i, j, k) || base(i, j, k)) lab[v] = 2;   // skull piece took the right ramus
  }
  const red = { nx: g.nx, ny: g.ny, nz: g.nz, sp: g.sp };
  return { g, lab, red, ramusR, base };
}
test('mirrorRecover: a ramus left on the skull piece goes back to the mandible, the skull base stays', () => {
  const { g, lab, red, ramusR, base } = oneSidedJaw();
  const pieces = [{ label: 1, size: lab.filter(x => x === 1).length, box: [0, 0, 0, 0, 0, 0] }, { label: 2, size: lab.filter(x => x === 2).length, box: [0, 0, 0, 0, 0, 0] }];
  const pl = B.midPlane(red, lab, 1);
  assert.ok(Math.abs(pl.n[0]) > 0.99, 'midplane across x, got ' + pl.n);
  const res = B.mirrorRecover(red, lab, 1, pieces);
  assert.ok(res.added > 2, 'added ' + JSON.stringify(res));
  let inR = 0, gotR = 0, baseTaken = 0;
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const v = g.at(i, j, k);
    if (ramusR(i, j, k) && k < 80) { inR++; if (lab[v] === 1) gotR++; }
    if (base(i, j, k) && lab[v] === 1) baseTaken++;
  }
  assert.ok(gotR / inR > 0.95, `right ramus back on the mandible: ${gotR}/${inR}`);
  assert.equal(baseTaken, 0, 'no skull base voxel moves to the mandible');
  assert.equal(pieces[0].size, lab.filter(x => x === 1).length, 'the mandible piece size follows');
});
test('mirrorRecover: a symmetric mandible is left alone', () => {
  const { lab, red, ramusR } = oneSidedJaw();
  const g = grid(150, 110, 120);
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (lab[g.at(i, j, k)] === 2 && ramusR(i, j, k)) lab[g.at(i, j, k)] = 1;
  const before = Int32Array.from(lab);
  const res = B.mirrorRecover(red, lab, 1, [{ label: 1, size: 0 }, { label: 2, size: 0 }]);
  assert.ok(res.fit >= 0.8, 'fit ' + res.fit); assert.equal(res.added, 0);
  assert.deepEqual(Array.from(lab), Array.from(before));
});

run('test_separate');
