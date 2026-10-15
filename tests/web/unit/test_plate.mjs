// plate.js on synthetic bones: the plate line must not fold back over itself or roll over the lower border / crest onto
// the lingual face (Denetim 4 E1), it crosses the defect at the chosen height and says when that misses the graft, an
// implausible line is critical (Plate.critical, blocks approval / package), screw length includes the plate (W10), the panel does not show
// contradicting messages or a stale "matched" count (E6 / D6), and plate screws in the two-guide layout carry their
// piece. No patient data. Run: node test_plate.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ extra: { fetch: async () => { throw new Error('offline'); } }, post: ['plate.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = () => (W.ExtraChecks || []).flatMap(f => f());
const plateChecks = () => checks().filter(c => /[Pp]lak/.test(c[2]));

async function volume(bone, box) {
  const sp = [0.8, 0.8, 0.8], nx = Math.round((box.x1 - box.x0) / sp[0]), ny = Math.round((box.y1 - box.y0) / sp[1]), nz = Math.round((box.z1 - box.z0) / sp[2]);
  const origin = [box.x0, box.y0, box.z0], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bone(origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2])) hu[i + nx * (j + ny * k)] = 1200;
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan(cut, opts = {}) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -cut, yaw: 0, pitch: 0, w: 1.2 }, { off: cut, yaw: 0, pitch: 0, w: 1.2 }];
  if (opts.L) { S.g.L = opts.L; S.gAuto.L = 0; }
  S.g.split = opts.split || 0; S.gAuto.split = 0;
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
  W.PlanExt.plate.set({ on: true, sys: 'recon24', h: 0, ext: 25 });
  await sleep(50); W.Plate.compute();
  return W.Plate.get();
}
// a curved "arch": the buccal face is the outside of a circle of radius 41 mm about (0, ·, -41) in the x-z plane (anchor on
// top at the origin, u = x along the arch, n = +z), cross-section an ellipse 12 mm deep (radial) x 20 mm high (y). The bone
// ends at arch angle thB on the B side: 45 deg leaves it short of the B cut + 25 mm extension along the arch (about 19 mm
// past the cut), so a surface walk ran round the end and back along the inner (lingual) face to the A side (with the
// bone ending at 60 deg: 182 mm, 492 deg); 100 deg is long enough.
const RB = 41, arch = thB => (x, y, z) => { const r = Math.hypot(x, z + RB), th = Math.atan2(x, z + RB) * 180 / Math.PI; return th < thB && th > -85 && ((r - 35) / 6) ** 2 + (y / 10) ** 2 < 1; };
const ARCH_BOX = { x0: -46, x1: 46, y0: -13, y1: 13, z0: -50, z1: 4 };
// the largest gap between two points of the line >= 25 mm apart along it, measured as the smallest distance between them
function minFar(R) { let m = Infinity; const p = R.path; for (let i = 0; i < p.length; i++) for (let j = i + 25; j < p.length; j++) m = Math.min(m, p[i].p.distanceTo(p[j].p)); return m; }

test('E1: on an arch that ends short of the extension the line stops at the end of the bone instead of folding back along the inner face', async () => {
  await volume(arch(45), ARCH_BOX);
  const R = await plan(13);
  assert.ok(R, 'a plate line');
  assert.ok(R.L > 55 && R.L < 75, 'length ' + R.L);
  assert.ok(minFar(R) > 8, 'no fold: points 25 mm apart along the line stay apart, closest ' + minFar(R).toFixed(1));
  // monotone along the arch: the arch angle of the line only grows from the A end to the B end
  const ang = R.path.map(q => Math.atan2(q.p.x, q.p.z + RB));
  assert.ok(ang.every((a, i) => !i || a >= ang[i - 1] - 0.02), 'arch angle grows along the line');
  assert.ok(R.holes.every(h => Math.hypot(h.p.x, h.p.z + RB) > 38), 'every hole on the outer (buccal) face: ' + R.holes.map(h => Math.hypot(h.p.x, h.p.z + RB).toFixed(1)));
  assert.equal(R.ok, false);
  assert.equal(JSON.stringify(W.Plate.critical()), '[]', 'a short but plausible plate is not critical');
  assert.ok(plateChecks().some(c => c[0] === 'warn' && /istenen uzunluğa ulaşmadan/.test(c[2])), 'the cut-short line is reported');
});

test('E1: on a long enough arch the line reaches the extension on both sides, plausible, no warning about it', async () => {
  await volume(arch(100), ARCH_BOX);
  const R = await plan(13);
  assert.ok(R && R.ok, JSON.stringify(R && { ok: R.ok }));
  // cut to cut 26 mm + slot halves + 25 mm past each cut, the extension measured along the curved bone: about 77 mm
  assert.ok(R.L > 74 && R.L < 90, 'length ' + R.L);
  assert.ok(R.bend.outPlane > 90 && R.bend.outPlane < 200, 'bend along the arch ' + R.bend.outPlane);
  assert.equal(JSON.stringify(W.Plate.critical()), '[]');
  assert.ok(!plateChecks().some(c => c[0] === 'crit' || /kemik yüzeyinden çıktı|grefte değmiyor/.test(c[2])), JSON.stringify(plateChecks()));
});

test('E1: near the lower border and near the crest the line stays on the buccal face at its height (no roll onto the lingual face)', async () => {
  // the arch's cross-section is 20 mm high (y -10 .. 10): 8 mm off the middle the rounded border / crest is 2 mm away, where
  // a walk along the surface normal rolled over onto the inner face (on the real CT: 151 mm, 509 deg, under the bone)
  for (const h of [-8, 8]) {
    W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h })); await sleep(50); const R = W.Plate.compute();
    assert.ok(R && R.ok, 'h ' + h);
    assert.ok(R.path.every(q => Math.hypot(q.p.x, q.p.z + RB) > 37 && Math.abs(q.p.y - h) < 2.5), 'h ' + h + ': every point on the outer face near its height');
    assert.ok(R.path.every(q => q.n.x * q.p.x + q.n.z * (q.p.z + RB) > 0), 'h ' + h + ': the plate faces outwards all along');
    assert.ok(R.L > 74 && R.L < 90 && minFar(R) > 8, 'h ' + h + ' length ' + R.L);
    assert.equal(JSON.stringify(W.Plate.critical()), '[]', 'h ' + h);
  }
  W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h: 0 })); await sleep(50); W.Plate.compute();
});

test('E1: Plate.assess marks a folded, an over-long and an over-bent line critical; the check is a "crit" (blocks approval and package)', async () => {
  const R = W.Plate.get(), E = R.E;
  // the old fold: out along the arch and back over the same points 3 mm lower
  const fold = { E, L: 2 * R.L, bend: { inPlane: 5, outPlane: 200, twist: 20 }, path: [...R.path, ...R.path.slice().reverse().map(q => ({ p: q.p.clone().add(V(0, 0, -3)) }))] };
  const a = W.Plate.assess(fold).map(c => c.why);
  assert.ok(a.includes('fold') && a.includes('length'), JSON.stringify(a));
  assert.equal(W.Plate.assess({ E, L: R.L, path: R.path, bend: { inPlane: 234, outPlane: 652, twist: 30 } }).map(c => c.why).join(), 'bend', 'the real-CT numbers (652 / 234 deg)');
  assert.equal(W.Plate.assess(R).length, 0, 'the plausible line');
  // a critical line: a "crit" check, S.crit counts it, the panel says so and the template/screw buttons are off
  R.crit = W.Plate.assess(fold);
  St.renderChecks();
  assert.ok(checks().some(c => c[0] === 'crit' && /kendi üzerine katlanıyor/.test(c[2])));
  assert.ok(S.crit >= 1, 'S.crit ' + S.crit);
  assert.ok(W.Plate.summary().kritik.length >= 2);
  W.Plate.compute(); St.renderChecks();
  assert.equal(JSON.stringify(W.Plate.critical()), '[]');
});

// straight bar 14 mm thick (z -14 .. 0), 16 wide (y), x -52 .. 52
const bar = (x, y, z) => z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 52;
const BAR_BOX = { x0: -56, x1: 56, y0: -20, y1: 20, z0: -24, z1: 8 };

test('W10: screw length is measured from the plate top: bone path + 1 mm + gap + plate thickness, rounded up to the system', async () => {
  await volume(bar, BAR_BOX);
  const R = await plan(10, { L: 50 });
  const h = R.holes.find(x => x.usable), need = h.thick + 1 + 0.15 + W.Plate.params().t;
  assert.ok(h.thick > 12.5 && h.thick < 14.5, 'bone path ' + h.thick);
  assert.equal(h.len, [6, 8, 10, 12, 14, 16, 18, 20, 22, 24].find(x => x >= need), `need ${need.toFixed(2)} -> ${h.len}`);
  assert.equal(h.len, 18, 'a 14 mm bone under a 2.5 mm plate takes an 18 mm screw (16 from the bone surface alone)');
});

test('E6 / D6: after "align screws to the plate" the summary counts them matched; when the line is lost the old message goes', async () => {
  W.Plate.placeScrews();
  assert.match($('plMsg').textContent, /^2 guide vidası plak deliklerine yerleştirildi/);
  assert.equal(W.Plate.summary().guide_ile_eslesen, 2, 'matched right after placing');
  assert.match($('plSum').innerHTML, /Guide ile eşleşen<\/dt><dd>2</);
  W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h: 15 }));
  await sleep(50);
  assert.equal(W.Plate.get(), null, 'no line 15 mm off the bar');
  assert.match($('plSum').innerHTML, /Plak hattı bulunamadı/);
  assert.equal($('plMsg').textContent, '', 'no "screws placed" next to "no plate line"');
});

test('two-guide layout: plate screws carry the piece of their side and land on their holes', async () => {
  await volume(bar, BAR_BOX);
  await plan(10, { L: 50, split: 2 });
  W.Plate.placeScrews();
  assert.ok(S.screws.length >= 2 && S.screws.every(s => s.plate && (s.part === -1 || s.part === 1)), JSON.stringify(S.screws.map(s => s.part)));
  assert.ok(S.screws.some(s => s.part === -1) && S.screws.some(s => s.part === 1));
  assert.equal(W.Plate.summary().guide_ile_eslesen, S.screws.length, 'every plate screw sits on a hole');
});

test('E1: a graft placed above the plate height: the line crosses the defect on the intact contour, warns and proposes a height that meets the graft', async () => {
  await volume(bar, BAR_BOX);
  await plan(10, { L: 50 });
  // a stand-in graft in the defect, 2 .. 10 mm above the plate's height (the real CT case: fibula at the alveolar level)
  const g = new T.Group(), m = new T.Mesh(new T.BoxGeometry(22, 9, 12), new T.MeshBasicMaterial()); m.position.set(0, 6, -6); g.add(m);
  St.setPart('grafts', 'Greft', g, 0xffffff); g.updateMatrixWorld(true);
  try {
    let R = W.Plate.compute();
    assert.ok(R && R.ok, 'a line at height 0');
    assert.ok(R.path.some(q => q.kind === 'defect') && !R.path.some(q => q.kind === 'graft'), 'over the defect on the intact contour');
    assert.ok(R.L > 65 && R.L < 85 && !W.Plate.critical().length, 'plausible, not critical: ' + R.L);
    assert.ok(R.graftGap && R.graftGap.lo === 2 && R.graftGap.hi === 10 && R.graftGap.sug === 5, JSON.stringify(R.graftGap));
    assert.ok(plateChecks().some(c => c[0] === 'warn' && /grefte değmiyor; greft bu noktada 2 ile 10 mm yükseklik arasında\. Plak yüksekliğini yaklaşık 5 mm/.test(c[2])), JSON.stringify(plateChecks()));
    W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h: 5 })); await sleep(50); R = W.Plate.compute();
    assert.ok(R && R.ok && R.path.some(q => q.kind === 'graft') && !R.graftGap, 'at the proposed height the line runs on the graft');
    assert.ok(!plateChecks().some(c => /grefte değmiyor/.test(c[2])));
  } finally { St.setPart('grafts', '', null); W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h: 0 })); await sleep(50); }
});

test('E1: over the defect a hole is usable only when its screw runs >= 4 mm in graft bone; a segment left with < 2 is named', async () => {
  await volume(bar, BAR_BOX);
  await plan(10, { L: 50 });
  // stand-in graft and fibula plan: one segment, bone 1.5 .. 10.5 mm above the plate's height 0, 12 mm deep, across the defect
  const g = new T.Group(), m = new T.Mesh(new T.BoxGeometry(22, 9, 12), new T.MeshBasicMaterial()); m.position.set(0, 6, -6); g.add(m);
  St.setPart('grafts', 'Greft', g, 0xffffff); g.updateMatrixWorld(true);
  const seg = { i: 0, P0: V(-10, 6, -6), N0: V(1, 0, 0), P1: V(10, 6, -6), N1: V(1, 0, 0), x: V(1, 0, 0), L: 20, barrel: false };
  const inG = q => Math.abs(q.x) <= 10 && q.y >= 1.5 && q.y <= 10.5 && q.z <= 0 && q.z >= -12;
  const had = W.Fibula, hadFib = S.fib; S.fib = { plan: { n: 1 } };
  // (a proxy: the app's other calls into Fibula get a no-op)
  W.Fibula = new Proxy({ active: () => true, state: () => ({ last: { segs: [seg] } }), plan: () => ({ kerf: 1 }), rules: () => ({ screwMinDepth: 4 }), graftBone: (i, q) => inG(q), checks: () => [] }, { get: (o, k) => (k in o ? o[k] : () => null) });
  const setH = async h => { W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h })); await sleep(50); return W.Plate.compute(); };
  try {
    // height 0: the defect holes' axes pass under the graft (a graze at most): unusable, reason given, segment 1 warned
    let R = await setH(0); const d0 = R.holes.filter(h => h.region === 'defect');
    assert.ok(d0.length && d0.every(h => !h.usable && (h.why === 'graft' || h.why === 'cut')) && d0.some(h => h.why === 'graft'), JSON.stringify(d0.map(h => [h.why, h.graft])));
    const s0 = W.Plate.summary();
    assert.equal(s0.kullanilabilir.defekt, 0); assert.equal(s0.grefte_tutunmuyor, d0.filter(h => h.why === 'graft').length);
    assert.ok(s0.delikler.some(h => h.neden === 'greftte 4 mm kemik yok'));
    assert.match($('plSum').innerHTML, /Grefte tutunmuyor/);
    assert.ok(plateChecks().some(c => c[0] === 'warn' && /Plak greft segmenti 1 üzerinde 0 vidaya yer bırakıyor/.test(c[2])), JSON.stringify(plateChecks()));
    // a graze: the axis touches the graft's lower edge for < 4 mm
    R = await setH(1); assert.ok(R.holes.filter(h => h.region === 'defect' && h.why !== 'cut').every(h => !h.usable && h.graft < 4), JSON.stringify(R.holes.map(h => [h.region, h.why, h.graft])));
    // height 5: the axis runs 12 mm through the graft: usable (the 20 mm defect has room for one hole clear of the cuts,
    // so the segment is still named, now with 1)
    R = await setH(5); const d5 = R.holes.filter(h => h.region === 'defect' && h.usable);
    assert.ok(d5.length === 1 && d5.every(h => h.graft >= 4 && h.seg === 0 && h.len), JSON.stringify(R.holes.map(h => [h.region, h.why, h.graft])));
    assert.equal(W.Plate.summary().grefte_tutunmuyor, 0);
    assert.ok(plateChecks().some(c => /Plak greft segmenti 1 üzerinde 1 vidaya/.test(c[2])) && !plateChecks().some(c => /segmenti 1 üzerinde 0/.test(c[2])));
  } finally { if (had) W.Fibula = had; else delete W.Fibula; S.fib = hadFib; St.setPart('grafts', '', null); W.PlanExt.plate.set(Object.assign({}, W.PlanExt.plate.get(), { h: 0 })); await sleep(50); }
});

await run('plate.js');
