// app.js guide kernel through window.Studio, on synthetic bone (no patient data):
// buildGuide (clearance, cut slots, drill holes, sleeves, pieces, split), planesWorld / screwWorld (deg -> direction),
// splitGap, stlOf, zipBytes (read back with python zipfile), guideRequest, applyPlan clamping.
// Run: node test_guide.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const P = studio(); const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G');
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const G0 = { rot: 0, roll: 0, L: 36, W: 22, wrap: 6, wall: 2.5, clear: 0.3, bridge: 4, side: 1, split: 0, flange: 3, peri: 0, fit: 0, stopT: 0, stopB: 0, stopL: 6, stopD: 5 };
// straight bar of bone along x, 16 mm wide (y), top face at z = 0
const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;
const frame = (p = V()) => ({ P: p, u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1) });
const build = (o = {}) => St.buildGuide(Object.assign({ pls: [], scs: [], bone: BAR, h: 0.4, fast: true }, frame(o.p), o, { g: Object.assign({}, G0, o.g || {}) }));
const pos = m => m.geometry.attributes.position.array;
// value of the guide occupancy grid at frame-local (uu, vv, nn)
const occ = (gr, uu, vv, nn) => { const i = Math.round((uu - gr.lo[0]) / gr.h), j = Math.round((vv - gr.lo[1]) / gr.h), k = Math.round((nn - gr.lo[2]) / gr.h); return gr.Gm[i + gr.nx * (j + gr.ny * k)]; };
// median height of the guide's inner (bone-facing) surface above the bar top, away from slots and edges
function innerGap(mesh) { const p = pos(mesh), z = []; for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 1]) < 4 && Math.abs(p[i]) < 8 && p[i + 2] > -1 && p[i + 2] < 1.6) z.push(p[i + 2]); z.sort((a, b) => a - b); return z[z.length >> 1]; }

test('buildGuide: one piece on a straight bar, inner surface faces the bone top', async () => {
  const o = await build();
  assert.equal(o.result.pieces, 1);
  assert.ok(o.mesh.geometry.index.count > 1000);
  assert.ok(o.result.contact > 150, 'contact ' + o.result.contact);
});

test('buildGuide: inner surface sits at the design clearance (clear 0.3 mm) above the bone surface (no interference, error ≤ h/2 = 0.2 mm), for every grid phase', async () => {
  const got = [];
  for (const ph of [0, 0.1, 0.2, 0.3]) got.push(+(innerGap((await build({ p: V(0, 0, ph) })).mesh)).toFixed(2));
  // finding B-1: the shell starts at the first voxel CENTRE farther than `clear` from a bone voxel CENTRE, so any clear < h gives ~0
  // fixed: distances are measured to the bone surface (half a voxel nearer than the voxel centre), so the guide never penetrates the bone
  got.forEach(z => near(z, 0.35, 0.2, `inner surface heights by phase ${got.join(', ')} mm; design clearance 0.3 mm:`));
});

test('buildGuide: clearance 0 mm still leaves no interference and grows with the setting (voxel-quantised)', async () => {
  const a = innerGap((await build({ g: { clear: 0 } })).mesh), b = innerGap((await build({ g: { clear: 0.2 } })).mesh), c = innerGap((await build({ g: { clear: 0.39 } })).mesh), d = innerGap((await build({ g: { clear: 0.41 } })).mesh);
  // documents the behaviour; passes when quantised (this is the evidence for B-1)
  assert.ok(a >= -0.05, 'clear 0 must not bury the guide in the bone: ' + a); assert.ok(d >= c && c >= b && b >= a - 1e-6, `monotonic ${a} ${b} ${c} ${d}`);
});

test('buildGuide: cut slot is cleared across the shell, centred on the plane, width = w (±h)', async () => {
  const w = 1.2, o = await build({ pls: [{ p: V(10, 0, 0), N: V(1, 0, 0), w }] });
  const gr = o.grid, nn = G0.clear + G0.wall / 2;
  // slot voxels are empty through the shell at all lateral positions
  for (let vv = -8; vv <= 8; vv += 0.4) assert.equal(occ(gr, 10, vv, nn), 0, 'slot centre filled at vv=' + vv);
  // material on both sides of the slot
  assert.equal(occ(gr, 10 - w / 2 - 0.6, 0, nn), 1); assert.equal(occ(gr, 10 + w / 2 + 0.6, 0, nn), 1);
  // measured width along u at mid-shell from the occupancy row
  let run = 0; for (let uu = 8; uu <= 12; uu += gr.h) if (!occ(gr, uu, 0, nn)) run++;
  near(run * gr.h, w, gr.h + 1e-9, 'slot width');
  assert.equal(o.result.pieces, 1, 'the bridge keeps the guide in one piece');
});

test('buildGuide: a tilted slot (yaw 25°) follows the plane: every voxel within w/2 of the plane is empty in the shell', async () => {
  const a = 25 * Math.PI / 180, N = V(Math.cos(a), Math.sin(a), 0), p0 = V(-6, 0, 0), w = 1.0, o = await build({ pls: [{ p: p0, N, w }] }), gr = o.grid;
  let bad = 0, n = 0;
  for (let k = 0; k < gr.nz; k++) for (let j = 0; j < gr.ny; j++) for (let i = 0; i < gr.nx; i++) {
    const uu = gr.lo[0] + i * gr.h, vv = gr.lo[1] + j * gr.h, nn = gr.lo[2] + k * gr.h;
    if (nn < G0.clear || nn > G0.clear + G0.wall || Math.abs(vv) > 6) continue;   // away from the bridge band, which spans the slot by design
    if (Math.abs((uu - p0.x) * N.x + (vv - p0.y) * N.y) <= w / 2 - 1e-6) { n++; if (gr.Gm[i + gr.nx * (j + gr.ny * k)]) bad++; }
  }
  assert.ok(n > 50); assert.equal(bad, 0);
});

test('buildGuide: degenerate slot width (w <= 0) or NaN normal leaves no slot, and nothing reports it', async () => {
  const o = await build({ pls: [{ p: V(10.2, 0, 0), N: V(1, 0, 0), w: -1 }] });
  assert.equal(occ(o.grid, 10.4, 0, G0.clear + G0.wall / 2), 1, 'w<0: the guide is solid at the cut');
  // NaN normal: silently no slot either
  const o2 = await build({ pls: [{ p: V(10, 0, 0), N: V(NaN, 0, 0), w: 1.2 }] });
  assert.equal(occ(o2.grid, 10, 0, G0.clear + G0.wall / 2), 1, 'NaN normal: no slot');
});

test('buildGuide: drill hole of diameter d + fit through the guide, sleeve of diameter D rises sleeveH above the shell', async () => {
  const sc = { d: 2.0, D: 5, sleeveH: 5, len: 10 }, fit = 0.2, o = await build({ g: { fit }, scs: [{ sc, dir: V(0, 0, -1), entry: V(-12, 0, 0) }] }), gr = o.grid;
  const top = G0.clear + G0.wall + sc.sleeveH;
  for (let nn = 0.8; nn < top - 0.4; nn += 0.4) assert.equal(occ(gr, -12, 0, nn), 0, 'hole at nn=' + nn);
  // hole radius (d+fit)/2 = 1.1: a cell 1.2 mm off axis inside the sleeve is material, 0.8 mm off axis is empty
  assert.equal(occ(gr, -12 + 0.8, 0, G0.clear + G0.wall + 2), 0);
  assert.equal(occ(gr, -12 + 2.0, 0, G0.clear + G0.wall + 2), 1, 'sleeve wall');
  assert.equal(occ(gr, -12 + 3.2, 0, G0.clear + G0.wall + 2), 0, 'outside sleeve D/2 = 2.5');
  const si = o.result.screwInfo[0]; assert.ok(si.ok); near(si.inBone, 10, 0.26); assert.equal(si.crossesPlane, false); assert.equal(si.exitAt, null);
});

test('buildGuide: screwInfo flags a screw that crosses a cut and one that leaves the bone', async () => {
  const sc = { d: 2, D: 5, sleeveH: 5, len: 20 };
  const o = await build({ pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 1.2 }], scs: [{ sc, dir: V(0, 0, -1), entry: V(0.5, 0, 0) }, { sc, dir: V(0, 0, -1), entry: V(12, 0, 0) }, { sc, dir: V(0, 0, -1), entry: null }] });
  const [a, b, c] = o.result.screwInfo;
  assert.equal(a.crossesPlane, true); assert.equal(b.crossesPlane, false);
  near(b.exitAt, 14, 0.3, 'bar is 14 mm thick: a 20 mm screw exits at 14'); near(b.inBone, 14, 0.3);
  assert.equal(c.ok, false, 'no entry -> not ok');
});

test('buildGuide: screw-vs-cut check uses the screw radius (screw d=2 whose axis is 1.4 mm from a 1.2 mm slot centre touches the slot margin)', async () => {
  const sc = { d: 2, D: 5, sleeveH: 5, len: 10 };
  const o = await build({ pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 1.2 }], scs: [{ sc, dir: V(0, 0, -1), entry: V(1.4, 0, 0) }, { sc: { d: 3, D: 6, sleeveH: 5, len: 10 }, dir: V(0, 0, -1), entry: V(1.9, 0, 0) }, { sc, dir: V(0, 0, -1), entry: V(2.4, 0, 0) }] });
  const [a, b, c] = o.result.screwInfo;
  assert.equal(a.crossesPlane, true, 'axis 1.4 mm from the centre: slot half-width 0.6 + screw radius 1.0 = 1.6 > 1.4');
  assert.equal(b.crossesPlane, true, 'd=3 (radius 1.5): 0.6 + 1.5 = 2.1 > 1.9');
  assert.equal(c.crossesPlane, false, 'axis 2.4 mm away clears it');
});

test('buildGuide: split mode makes two pieces with nothing between the outer cuts (beyond the flange)', async () => {
  const pls = [{ p: V(-10, 0, 0), N: V(1, 0, 0), w: 1.2, off: -10 }, { p: V(10, 0, 0), N: V(1, 0, 0), w: 1.2, off: 10 }];
  const o = await build({ g: { split: 1, L: 50 }, pls });
  assert.equal(o.result.pieces, 2);
  assert.equal(occ(o.grid, 0, 0, G0.clear + G0.wall / 2), 0);
  // the flange: material within w/2 + flange beyond the slot on the defect side (between -9.4 and -6.4)
  assert.equal(occ(o.grid, -8, 0, G0.clear + G0.wall / 2), 1);
});

test('buildGuide: no bone at all -> empty guide, 0 pieces, no exception', async () => {
  const o = await build({ bone: () => false });
  assert.equal(o.result.pieces, 0);
});

test('buildGuide: wrap depth — the shell never reaches deeper than wrap below the bone top', async () => {
  const o = await build({ g: { wrap: 4 } }), gr = o.grid;
  let deepest = 0;
  for (let k = 0; k < gr.nz; k++) for (let j = 0; j < gr.ny; j++) for (let i = 0; i < gr.nx; i++) if (gr.Gm[i + gr.nx * (j + gr.ny * k)]) deepest = Math.min(deepest, gr.lo[2] + k * gr.h);
  assert.ok(deepest >= -4 - 1e-6, 'deepest ' + deepest);
  assert.ok(deepest <= -3.5, 'wraps down to about 4 mm: ' + deepest);
});

test('splitGap: normals oriented from the first to the last cut whatever their sign', () => {
  const g = St.splitGap({ split: 1 }, [{ p: V(10, 0, 0), N: V(-1, 0, 0), w: 1, off: 10 }, { p: V(-10, 0, 0), N: V(1, 0, 0), w: 1, off: -10 }]);
  near(g.A.p.x, -10, 1e-12); near(g.A.N.x, 1, 1e-12); near(g.B.N.x, 1, 1e-12);
  assert.equal(St.splitGap({ split: 0 }, []), null);
});

// ---------- guide frame: planesWorld / screwWorld with a synthetic volume ----------
async function syntheticCase() {
  const nx = 120, ny = 50, nz = 40, sp = [0.8, 0.8, 0.8], origin = [-48, -20, -24], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 40) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
}
test('planesWorld: off along u, yaw about n and pitch in degrees (yaw 90 -> N = v; pitch 30 -> N·n = -sin 30°)', async () => {
  await syntheticCase(); S.g.rot = 0;
  S.planes = [{ off: 7, yaw: 0, pitch: 0, w: 1.2 }, { off: 0, yaw: 90, pitch: 0, w: 1.2 }, { off: 0, yaw: 0, pitch: 30, w: 1.2 }];
  const [a, b, c] = St.planesWorld();
  near(a.p.x, 7, 1e-9); near(a.N.x, 1, 1e-9);
  near(b.N.y, 1, 1e-9);
  near(c.N.z, -0.5, 1e-9); near(c.N.x, Math.cos(Math.PI / 6), 1e-9);
});
test('planesWorld: guide rotation g.rot (degrees) turns u about n', () => {
  S.g.rot = 90; const { u } = St.frameAxes(); near(u.y, 1, 1e-9); S.g.rot = 0;
});
test('screwWorld: entry on the bone top under (u, v), tilt in degrees (tiltU 30 -> dir·u = -sin 30°)', () => {
  const s = St.screwWorld({ u: 5, v: 2, tiltU: 30, tiltV: 0, d: 2, D: 5, sleeveH: 5, len: 10 });
  assert.ok(s.entry, 'entry found'); near(s.entry.x, 5, 1e-9); near(s.entry.y, 2, 1e-9); near(s.entry.z, 0, 0.8, 'entry on top face (within one 0.8 mm working voxel)');
  near(s.dir.x, -0.5, 1e-9); near(s.dir.z, -Math.cos(Math.PI / 6), 1e-9);
  const off = St.screwWorld({ u: 60, v: 0, tiltU: 0, tiltV: 0 }); assert.equal(off.entry, null, 'no bone under the guide position');
});
test('placeScrews: two screws per side outside the cuts, never inside the slot ± 1.5 mm, guide made long enough', () => {
  P.doc.getElementById('perSide').value = '2';
  S.planes = [{ off: -10, yaw: 0, pitch: 0, w: 1.2 }, { off: 10, yaw: 0, pitch: 0, w: 1.2 }]; S.guideOn = true;
  St.placeScrews();
  assert.equal(S.screws.length, 4);
  S.screws.forEach(sc => { assert.ok(Math.abs(sc.u) >= 10 + 0.6 + 1.5, 'u ' + sc.u); assert.ok(Math.abs(sc.u) + sc.D / 2 <= S.g.L / 2, 'inside guide length'); });
});

// ---------- STL / zip ----------
test('stlOf: binary STL with 80-byte header, triangle count, right-hand normals, raw (unexploded) coordinates', () => {
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)); g.setIndex([0, 1, 2]);
  const m = new T.Mesh(g); m.position.set(100, 0, 0);   // explode offset must not leak into the file
  const b = St.stlOf(m), dv = new DataView(b.buffer);
  assert.equal(b.length, 84 + 50); assert.equal(dv.getUint32(80, true), 1);
  near(dv.getFloat32(84 + 8, true), 1, 1e-6, 'normal z');
  near(dv.getFloat32(84 + 12 + 12, true), 1, 1e-6, 'second vertex x stays 1 (no position offset)');
});
test('zipBytes: archive opens in python zipfile with the same names and bytes (UTF-8 names)', () => {
  const files = [{ name: 'plan.json', data: '{"a":1}' }, { name: 'guide_ön.stl', data: new Uint8Array([1, 2, 3, 250]) }];
  const z = St.zipBytes(files), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z')), f = path.join(dir, 'a.zip'); fs.writeFileSync(f, z);
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"items":[[i.filename,list(z.read(i))] for i in z.infolist()]}))', f]).toString());
  assert.equal(out.bad, null);
  assert.deepEqual(out.items.map(x => x[0]), ['plan.json', 'guide_ön.stl']);
  assert.deepEqual(out.items[1][1], [1, 2, 3, 250]);
});

// ---------- server request ----------
test('guideRequest: crop around the guide, peri added to clear, drill + fit, planes and screws in world mm', () => {
  const c = Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: 250, g: Object.assign({}, G0, { peri: 0.2, fit: 0.1 }), pls: St.planesWorld(), scs: [{ sc: { d: 2, D: 5, sleeveH: 5 }, dir: V(0, 0, -1), entry: V(12, 0, 0) }] }, frame());
  const r = St.guideRequest(c);
  near(r.g.clear, 0.5, 1e-12); near(r.screws[0].d, 2.1, 1e-12);
  const ext = [0, 1, 2].map(a => [r.crop.origin[a], r.crop.origin[a] + (([r.crop.nx, r.crop.ny, r.crop.nz][a]) - 1) * r.crop.sp[a]]);
  ext.forEach(([lo, hi], a) => assert.ok(lo <= 0 && hi >= 0, 'crop contains the anchor on axis ' + a));
  const mask = Buffer.from(r.mask_b64, 'base64'); assert.equal(mask.length, r.crop.nx * r.crop.ny * r.crop.nz); assert.ok(mask.some(x => x));
});

// ---------- plan restore ----------
test('applyPlan: hostile / damaged plan values are clamped to the control ranges, NaN replaced by defaults', async () => {
  await St.applyPlan({ seg: { thr: 250 }, anchor: { p: [0, 0, 0], n: [0, 0, 1], axis: [1, 0, 0] }, g: { L: 1e9, W: 'x', wrap: -5, clear: NaN, wall: 0 },
    planes: [{ off: 999, yaw: -500, pitch: 'a', w: 0 }], screws: [{ u: 1e6, v: -1e6, d: 0, D: -1, len: 1e9 }, { u: 'x', tiltU: Infinity }], lesion: { from: -1e9, to: 1e9, margin: -1, condyle: '<b>' } });
  assert.equal(S.g.L, 100); assert.equal(S.g.W, 22); assert.equal(S.g.wrap, 2); assert.equal(S.g.clear, 0.3); assert.equal(S.g.wall, 1.5);
  assert.deepEqual([S.planes[0].off, S.planes[0].yaw, S.planes[0].pitch, S.planes[0].w], [45, -89, 0, 0.6]);
  assert.equal(S.lesion.condyle, null); assert.equal(S.lesion.margin, 0);
  S.screws.forEach(sc => assert.ok(sc.d >= 0.5 && sc.D >= sc.d && Math.abs(sc.u) <= 45 && Number.isFinite(sc.tiltU), JSON.stringify(sc)));
});
test('applyPlan: a null screw record triggers re-placement; with a degenerate cut (yaw -89°) the re-placed screws land outside the ±45 mm range', async () => {
  await St.applyPlan({ seg: { thr: 250 }, anchor: { p: [0, 0, 0], n: [0, 0, 1], axis: [1, 0, 0] }, planes: [{ off: 45, yaw: -89 }], screws: [null] });
  // documents behaviour: renderChecks flags these as 'outside the guide body' (crit), so not silent
  assert.ok(S.screws.some(sc => Math.abs(sc.u) > 45), JSON.stringify(S.screws.map(s => s.u)));
});
test('applyPlan: approvals in a stored plan come back as approvals (ok/by/at are trusted from the file)', async () => {
  await St.applyPlan({ seg: { thr: 250 }, anchor: { p: [0, 0, 0], n: [0, 0, 1], axis: [1, 0, 0] }, planes: [{ off: -10, ok: true, by: 'Dr X', at: '2026-01-01' }, { off: 10, ok: true, by: 'Dr X' }], lesion: { ok: true, by: 'Dr X' } });
  assert.equal(S.planes[0].ok, true); assert.equal(S.planes[0].by, 'Dr X'); assert.equal(S.lesion.ok, true);
});

await run('app.js guide kernel (Studio)');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
