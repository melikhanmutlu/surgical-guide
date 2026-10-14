// plate.js on synthetic bones: the plate line must not fold back over itself (Denetim 4 E1), an implausible line is
// critical (Plate.critical, blocks approval / package), screw length includes the plate (W10), the panel does not show
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
// ends at arch angle thB on the B side: 60 deg leaves it short of the B cut + 25 mm extension, so a surface walk runs
// round the end and back along the inner (lingual) face to the A side; 100 deg is long enough.
const RB = 41, arch = thB => (x, y, z) => { const r = Math.hypot(x, z + RB), th = Math.atan2(x, z + RB) * 180 / Math.PI; return th < thB && th > -85 && ((r - 35) / 6) ** 2 + (y / 10) ** 2 < 1; };
const ARCH_BOX = { x0: -46, x1: 46, y0: -13, y1: 13, z0: -50, z1: 4 };
// the largest gap between two points of the line >= 25 mm apart along it, measured as the smallest distance between them
function minFar(R) { let m = Infinity; const p = R.path; for (let i = 0; i < p.length; i++) for (let j = i + 25; j < p.length; j++) m = Math.min(m, p[i].p.distanceTo(p[j].p)); return m; }

test('E1: on an arch that ends short of the extension the line stops at the end of the bone instead of folding back along the inner face', async () => {
  await volume(arch(60), ARCH_BOX);
  const R = await plan(13);
  assert.ok(R, 'a plate line');
  // before the fix: 182 mm, 21 holes, the last 7 back over the defect on the lingual face (z -12 .. -36), 492 deg bend
  assert.ok(R.L < 110, 'length ' + R.L);
  assert.ok(minFar(R) > 8, 'no fold: points 25 mm apart along the line stay apart, closest ' + minFar(R).toFixed(1));
  // monotone along the arch: the arch angle of the line only grows from the A end to the B end
  const ang = R.path.map(q => Math.atan2(q.p.x, q.p.z + RB));
  assert.ok(ang.every((a, i) => !i || a >= ang[i - 1] - 0.02), 'arch angle grows along the line');
  assert.ok(R.holes.every(h => Math.hypot(h.p.x, h.p.z + RB) > 38), 'every hole on the outer (buccal) face: ' + R.holes.map(h => Math.hypot(h.p.x, h.p.z + RB).toFixed(1)));
  assert.equal(R.back, true); assert.equal(R.ok, false);
  assert.equal(JSON.stringify(W.Plate.critical()), '[]', 'a short but plausible plate is not critical');
  assert.ok(plateChecks().some(c => c[0] === 'warn' && /geri dönüyordu; hat orada kesildi/.test(c[2])), 'the cut-short line is reported');
});

test('E1: on a long enough arch the line reaches the extension on both sides, plausible, no warning about it', async () => {
  await volume(arch(100), ARCH_BOX);
  const R = await plan(13);
  assert.ok(R && R.ok && !R.back, JSON.stringify(R && { ok: R.ok, back: R.back }));
  assert.ok(R.L > 85 && R.L < 120, 'length ' + R.L);
  assert.ok(R.bend.outPlane > 90 && R.bend.outPlane < 200, 'bend along the arch ' + R.bend.outPlane);
  assert.equal(JSON.stringify(W.Plate.critical()), '[]');
  assert.ok(!plateChecks().some(c => c[0] === 'crit' || /kemik yüzeyinden çıktı|geri dönüyordu/.test(c[2])), JSON.stringify(plateChecks()));
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

await run('plate.js');
