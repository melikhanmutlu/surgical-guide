// D3 (plan "Çene rekonstrüksiyonu: P0 sonrası"): error propagation from the saw's play in the slots and the guide's
// seating clearance (web/errprop.js). With no play and no clearance nothing moves; a rim point of one face moves at most
// the analytic max(g / 2, r g / d) and the Monte Carlo reaches it; a point further down the chain moves more; the plan
// gives a chain (cut 1, cut 2) and the PDF section lists the range.
// Run: node test_errprop.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: ['errprop.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const E = () => W.ErrProp;

test('no play, no clearance: every point stays where it was planned', () => {
  const r = E().propagate({ faces: [{ p: [0, 0, 0], N: [1, 0, 0], g: 0, d: 5, guide: 'm' }, { p: [30, 0, 0], N: [1, 0, 0], g: 0, d: 5, guide: 'm' }], guides: { m: { clear: 0, half: 18 } },
    points: [{ name: 'a', after: 0, face: 0, r: 10, p: [0, 0, 0] }, { name: 'end', after: 1, p: [80, 0, 0] }] }, { n: 500 });
  r.forEach(x => assert.equal(x.max, 0, JSON.stringify(x)));
});

test('one face, slot 0.4 mm wider than the blade, 5 mm deep: a rim point 10 mm out moves at most 0.8 mm (analytic), and the run reaches it', () => {
  const g = 0.4, d = 5, rr = 10, an = E().rimMax(g, d, rr);
  near(an, 0.8, 1e-12);
  const r = E().propagate({ faces: [{ p: [0, 0, 0], N: [0, 0, 1], g, d }], points: [{ name: 'rim', after: 0, face: 0, r: rr, p: [0, 0, 0] }] }, { n: 20000 })[0];
  assert.ok(r.max <= an + 1e-9, 'never beyond the analytic bound: ' + r.max);
  assert.ok(r.max >= 0.97 * an, 'the run reaches it: ' + r.max);
  assert.ok(r.p50 > 0 && r.p50 < r.p95 && r.p95 < r.max);
  // close to the slot middle the offset bound g / 2 holds
  const c = E().propagate({ faces: [{ p: [0, 0, 0], N: [0, 0, 1], g, d }], points: [{ name: 'mid', after: 0, face: 0, r: 1, p: [0, 0, 0] }] }, { n: 20000 })[0];
  near(E().rimMax(g, d, 1), 0.2, 1e-12); assert.ok(c.max <= 0.2 + 1e-9 && c.max > 0.19, String(c.max));
});

test('a point further down the chain moves more than the faces; the same seed gives the same range', () => {
  const sp = { faces: [{ p: [0, 0, 0], N: [1, 0, 0], g: 0.4, d: 5 }, { p: [30, 0, 0], N: [1, 0, 0], g: 0.4, d: 5 }], points: [{ name: 'f', after: 1, face: 1, r: 10, p: [30, 0, 0] }, { name: 'condyle', after: 1, p: [90, 0, 40] }] };
  const a = E().propagate(sp, { n: 3000 }), b = E().propagate(sp, { n: 3000 });
  assert.ok(a[1].p95 > a[0].p95, JSON.stringify(a));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('the plan: two cuts give the chain; the PDF section lists the range', async () => {
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-errprop' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.0 }, { off: 15, yaw: 0, pitch: 0, w: 1.0 }];
  const spec = E().fromPlan();
  assert.equal(spec.faces.length, 2); near(spec.faces[0].g, 1.0 - S.g.blade, 1e-9);
  assert.equal(JSON.stringify(spec.points.map(p => p.name)), JSON.stringify(['Kesi 1 yüzeyi', 'Kesi 2 yüzeyi']));
  const res = E().run().res, rim = Math.max(5, S.g.W / 2), bound = E().rimMax(0.4, St.slotDepth(S.g), rim) + S.g.clear * (1 + rim / (S.g.L / 2));
  assert.ok(res[0].max > 0 && res[0].max <= bound + 1e-9, JSON.stringify(res[0]) + ' bound ' + bound);
  assert.ok(res[1].p95 > res[0].p95, 'the free side follows cut 1 over the 30 mm between the cuts: ' + JSON.stringify(res));
  // the slot fitted to the blade and no clearance: nothing
  S.planes.forEach(p => { p.w = S.g.blade; }); const c0 = S.g.clear; S.g.clear = 0;
  E().run().res.forEach(x => assert.equal(x.max, 0));
  S.g.clear = c0; S.planes.forEach(p => { p.w = 1.0; });
  // the section
  const lines = []; const d = { keep() {}, h2: t => lines.push(t), text: t => lines.push(t), table: (h, rows) => rows.forEach(r => lines.push(r.join(' | '))) };
  W.ReportSections.forEach(f => f(d));
  assert.ok(lines.includes('Hata yayılımı (öngörü)'), JSON.stringify(lines));
  assert.ok(lines.some(l => /^Kesi 1 yüzeyi \| [\d,]+ mm \| [\d,]+ mm \| [\d,]+ mm$/.test(l)), JSON.stringify(lines));
});

await run('error propagation');
