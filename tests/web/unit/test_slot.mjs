// Saw slot play (plan 1.3): the blade tilts atan((slot - blade) / guided depth) in a slot. The guide used to have a
// 1.2 mm slot over a 2.5 mm wall (a 0.6 mm blade tilts ~13°, ~2.5 mm off on the lingual cortex) and nothing checked it.
// Now:
//  - the blade thickness is a plan field (S.g.blade), the slot a new cut gets is blade + tolerance (0.2 mm, or the
//    material profile's), and the slot is guided over S.g.boss mm by a raised rim beside it (gkernel, server)
//  - a slot play over 3° (sample threshold) is critical, with a one-click fix (slot to the blade, rim raised)
//  - a plan saved before the rim existed opens without one (as approved) and gets the critical check
//  - the fibula guide's slot is checked against its kerf the same way
// Run: node test_slot.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: ['mfg.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

test('slot play: 1.2 mm slot, 0.6 mm blade, 2.8 mm guide = critical (> 3°); 0.8 mm slot with a 5 mm rim <= 3°', () => {
  const a = St.slotPlay(1.2, 0.6, 2.8), b = St.slotPlay(0.8, 0.6, 5);
  near(a, Math.atan(0.6 / 2.8) * 180 / Math.PI, 1e-9); assert.ok(a > St.SLOT_PLAY_MAX);
  near(b, Math.atan(0.2 / 5) * 180 / Math.PI, 1e-9); assert.ok(b <= St.SLOT_PLAY_MAX);
  near(St.slotPlay(0.5, 0.6, 3), 0, 1e-12, 'a slot narrower than the blade has no play (the blade does not fit: the Mfg check)');
  // the guided depth: the rim when it is deeper than the wall, else the wall
  assert.equal(St.slotDepth({ wall: 2.5, boss: 5 }), 5); assert.equal(St.slotDepth({ wall: 2.5, boss: 0 }), 2.5); assert.equal(St.slotDepth({ wall: 3, boss: 2 }), 3);
});

test('defaults: blade 0.6 mm, rim 5 mm; a new cut gets blade + 0.2 mm; a material profile sets the blade and its tolerance', () => {
  assert.equal(St.G_DEFAULT.blade, 0.6); assert.equal(St.G_DEFAULT.boss, 5);
  Object.assign(S.g, St.G_DEFAULT);
  near(St.slotDefault(), 0.8, 1e-9);
  S.g.blade = 0.4; near(St.slotDefault(), 0.6, 1e-9); S.g.blade = 0.6;
  const M = P.eval('Mfg');
  try { Object.assign(M.get(), M.presets.sls, { prof: 'sls', blade: 0.5 }); M.apply(); near(S.g.blade, 0.5, 1e-9); near(St.slotDefault(), 0.8, 1e-9, 'PA12 SLS: 0.5 + 0.3'); }
  finally { Object.assign(M.get(), { prof: null, blade: 0.6, slotTol: 0.2 }); S.g.blade = 0.6; }
});

// straight bar of bone along x, top at z = 0; one cut across x = 0
const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;
const occ = (gr, uu, vv, nn) => { const i = Math.round((uu - gr.lo[0]) / gr.h), j = Math.round((vv - gr.lo[1]) / gr.h), k = Math.round((nn - gr.lo[2]) / gr.h); return gr.Gm[i + gr.nx * (j + gr.ny * k)]; };
const build = g => St.buildGuide({ P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [], bone: BAR, h: 0.4, fast: true,
  g: Object.assign({}, St.G_DEFAULT, { wrapU: null }, g) });

test('guide kernel: the rim stands boss mm over the inner surface beside the slot, the slot stays open, the wall elsewhere is unchanged', async () => {
  const off = await build({ boss: 0 }), on = await build({ boss: 5 });
  const c = 0.3;
  // 1.2 mm beside the slot, 4 mm over the inner surface: rim only
  assert.equal(occ(off.grid, 1.2, 0, c + 4), 0); assert.equal(occ(on.grid, 1.2, 0, c + 4), 1); assert.equal(occ(on.grid, -1.2, 0, c + 4), 1);
  // the rim's top: material at c + 4.6, none at c + 5.4
  assert.equal(occ(on.grid, 1.6, 0, c + 4.6), 1); assert.equal(occ(on.grid, 1.6, 0, c + 5.4), 0);
  // the slot: open at every depth of the rim
  for (const nn of [0.8, 2, 3.2, 4.4]) assert.equal(occ(on.grid, 0, 0, nn), 0, 'slot at ' + nn);
  // 8 mm off the slot the wall is the plain wall (2.5 mm)
  assert.equal(occ(on.grid, 8, 0, c + 1.2), 1); assert.equal(occ(on.grid, 8, 0, c + 4), 0);
  assert.ok(on.result.volume > off.result.volume);
  assert.equal(on.result.pieces, 1);
  // a rim no deeper than the wall builds nothing
  const same = await build({ boss: 2.5 });
  assert.equal(same.result.volume, off.result.volume);
});

test('A3: the slot flange carries the rim past the body edge across the guide; the slot stays open in it; off by default', async () => {
  // (a body 8 mm wide on the 16 mm bar, so the flange past its edge still lies over bone)
  const W2 = 4, c = 0.3;
  assert.equal(St.G_DEFAULT.slotFlange, 0, 'off by default (a design option, Lohn 2025)');
  const off = await build({ boss: 5, W: 8 }), on = await build({ boss: 5, W: 8, slotFlange: 3 });
  // 2 mm past the body edge, beside the slot, 2 mm over the inner surface: flange only
  for (const sv of [1, -1]) { assert.equal(occ(off.grid, 1.2, sv * (W2 + 2), c + 2), 0); assert.equal(occ(on.grid, 1.2, sv * (W2 + 2), c + 2), 1, 'flange at v ' + sv); }
  // not past the flange (4 mm out), not away from the slot (8 mm along), and the slot open in it
  assert.equal(occ(on.grid, 1.2, W2 + 4, c + 2), 0); assert.equal(occ(on.grid, 8, W2 + 2, c + 2), 0);
  for (const nn of [0.8, 2, 3.2, 4.4]) assert.equal(occ(on.grid, 0, W2 + 2, nn), 0, 'slot open at ' + nn);
  assert.equal(on.result.pieces, 1); assert.ok(on.result.volume > off.result.volume);
});

test('production request carries boss / bossW (the server builds the same rim)', () => {
  Object.assign(S.g, St.G_DEFAULT, { boss: 5, bossW: 2 });
  const vol = { hu: new Int16Array(40 * 40 * 40).fill(-1000), nx: 40, ny: 40, nz: 40, sp: [1, 1, 1], origin: [-20, -20, -20], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  const red = G.reduce(vol, 0.8);
  const q = St.guideRequest({ vol, red, F: new Float32Array(red.nx * red.ny * red.nz), thr: null, g: S.g, P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [], scs: [] });
  assert.equal(q.g.boss, 5); assert.equal(q.g.bossW, 2);
});

// the studio on a synthetic bar "mandible" (as test_quality_gate.mjs)
async function bar(gOver = {}, w = 1.2) {
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2];
    if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200;
  }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-slot' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true); await St.settled();
  Object.assign(S.g, gOver);
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w, ok: false }, { off: 15, yaw: 0, pitch: 0, w, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
  St.renderChecks();
}
const rows = re => (S.checkList || []).filter(c => re.test(c[2]));

test('checks: the old design (1.2 mm slot, no rim) is critical per cut with the fix; the fix brings both under 3°', async () => {
  await bar({ boss: 0, blade: 0.6 }, 1.2);
  const r = rows(/yuvasında testere/);
  assert.equal(r.length, 2, JSON.stringify(S.checkList.map(c => c[2])));
  assert.ok(r.every(x => x[0] === 'crit'));
  assert.match(r[0][2], /Kesi 1 yuvasında testere 13,5° eğilebilir \(yuva 1,20 mm, bıçak 0,60 mm, kılavuz derinliği 2,5 mm\)/);
  assert.equal(r[0][4][0][0], 'slotFit');
  S.planes[0].ok = true;
  await St.runFix('slotFit'); await St.regenerate(); await St.settled(); St.renderChecks();
  assert.equal(rows(/yuvasında testere/).length, 0, JSON.stringify(rows(/yuvasında testere/)));
  near(S.planes[0].w, 0.8, 1e-9); assert.equal(S.g.boss, 5);
  assert.equal(S.planes[0].ok, false, 'a slot changed by the fix loses its approval');
});

test('checks: the new defaults pass (0.8 mm slot, 5 mm rim)', async () => {
  await bar({ boss: 5, blade: 0.6 }, 0.8);
  assert.equal(rows(/yuvasında testere/).length, 0);
});

test('a plan saved before the rim existed opens without one; one saved with it keeps it', async () => {
  await bar({ boss: 5, blade: 0.6 }, 0.8);
  const p = St.planOf(); assert.equal(p.g.boss, 5); assert.equal(p.g.blade, 0.6);
  const old = JSON.parse(JSON.stringify(p)); delete old.g.boss; delete old.g.blade; delete old.g.bossW;
  await St.applyPlan(old); assert.equal(S.g.boss, 0); assert.equal(S.g.blade, 0.6);
  await St.applyPlan(p); assert.equal(S.g.boss, 5);
  const bad = JSON.parse(JSON.stringify(p)); bad.g.boss = 99; bad.g.blade = -3;
  await St.applyPlan(bad); assert.equal(S.g.boss, 10); assert.equal(S.g.blade, 0.3);
});

await run('slot');
