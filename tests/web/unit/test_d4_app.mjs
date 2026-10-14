// Denetim 4 regressions in app.js / mpr.js / store.js / mfg.js / condyle.js (synthetic straight bar "mandible"):
//  W1  a screw's piece frame (part) survives planOf -> applyPlan (undo / redo, reopen, version restore) and is in prodKey
//  W13 hand-set screws survive a change between one and two guides (written into the other frame, not deleted)
//  W7  the "no screw past cut N" critical follows the screws there now (cleared by a screw set by hand / an undo)
//  W12 a cut whose kept side meets no bone (bonelessCut) is computed again: no screws past it, the info line
//  W16 the two-guide piece frames follow the bone mask
//  W11 no cut drag clamps its position to ±45 mm (the plan allows ±CUT_OFF_MAX = 80)
//  E1 / E3 a production STL that is not watertight and a plate path that could not be completed are critical
//  D2  a package's plan.json (planOf + summary) opens again; junk does not
//  D5 / W26 history labels follow the value an entry ended at; Ctrl+Z pressed past the start ends at the start
//  W19 the drill control: the sleeve follows the drill down as well as up, the built-in defaults stay
//  condyle chosen on the side away from the lesion: a warning
// Run: node test_d4_app.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const P = studio({ post: ['store.js', 'mfg.js', 'condyle.js'], extra: { addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fire = (id, type, value) => { const el = $(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

// straight bar along x (|x| < 58, top z = 0)
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-d4' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
const entryOf = sc => { const e = St.screwWorld(sc).entry; return e ? e.toArray() : null; };
function twoGuides() {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; S.g.split = 2; S.gAuto.split = 0; $('perSide').value = '2';
  St.placeScrews();
}

test('W1: two-guide screws keep their piece frame through planOf -> applyPlan (the path of undo, reopen and version restore)', async () => {
  twoGuides();
  assert.ok(St.pieceFrames(), 'piece frames on the bar');
  assert.ok(S.screws.length >= 2 && S.screws.every(sc => sc.part === -1 || sc.part === 1), 'every screw on a piece frame: ' + JSON.stringify(S.screws.map(s => s.part)));
  $('surgeon').value = 'Dr Y'; S.screws.forEach(sc => St.stamp(sc));
  const before = S.screws.map(sc => ({ part: sc.part, e: entryOf(sc) })), key0 = St.prodKey();
  const saved = St.clone(St.planOf());
  assert.deepEqual(saved.screws.map(s => s.part), before.map(b => b.part), 'the plan file carries part');
  await St.applyPlan(St.clone(saved));
  assert.deepEqual(S.screws.map(s => s.part), before.map(b => b.part), 'part restored');
  S.screws.forEach((sc, i) => { const e = entryOf(sc); assert.ok(e && before[i].e, 'entry on bone'); for (let k = 0; k < 3; k++) near(e[k], before[i].e[k], 1e-6, `screw ${i + 1} entry unchanged`); });
  assert.ok(S.screws.every(sc => sc.ok), 'approvals bound to the same values come back');
  // nothing between the cuts (the resected segment): every entry lies past its own cut
  S.screws.forEach(sc => { const x = entryOf(sc)[0]; assert.ok(sc.part < 0 ? x < -15 : x > 15, `screw on part ${sc.part} at x=${x}`); });
  assert.equal(St.prodKey(), key0, 'same production key after the round trip');
  const flip = St.clone(saved); flip.screws[0].part = -flip.screws[0].part;
  await St.applyPlan(flip);
  assert.notEqual(St.prodKey(), key0, 'a screw on the other piece frame is another production guide');
  assert.equal(S.screws[0].ok, false, 'a stamp moved to another frame is not an approval');
  await St.applyPlan(St.clone(saved));
});

test('W13: hand-set screws survive two guides -> one guide -> two guides, on the same drill line, approval removed', () => {
  twoGuides();
  const hs = S.screws.find(sc => sc.part === 1); hs.hand = 1; hs.ok = true;
  const e0 = entryOf(hs), n0 = S.screws.length;
  S.g.split = 0; const moved = St.placeScrews();
  assert.ok(moved >= 1, 'reported as moved'); assert.ok(S.screws.includes(hs), 'kept on one guide'); assert.equal(hs.part, undefined); assert.equal(hs.ok, false);
  const e1 = entryOf(hs); assert.ok(e1 && Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]) < 1, `same spot on the bone: ${e0} -> ${e1}`);
  S.g.split = 2; St.placeScrews();
  assert.ok(S.screws.includes(hs), 'kept on two guides'); assert.equal(hs.part, 1, 'back on the piece it holds');
  const e2 = entryOf(hs); assert.ok(Math.hypot(e2[0] - e0[0], e2[1] - e0[1], e2[2] - e0[2]) < 1, `same spot: ${e0} -> ${e2}`);
  assert.ok(S.screws.length >= n0 - 1);
});

test('W13: the layout switch says the hand-set screws were moved', () => {
  twoGuides(); S.screws[0].hand = 1; $('caseMsg').textContent = '';
  fire('g_split', 'change', '0');
  assert.ok(/Elle yerleştirilen vidalar/.test($('caseMsg').textContent), $('caseMsg').textContent);
  assert.ok(S.screws.some(sc => sc.hand), 'still there');
});

test('W7: the missing-screw critical follows the screws at that end (a screw set by hand, an undo, a deleted cut)', async () => {
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  St.placeScrews(); await St.regenerate();
  const crit = () => (S.checkList || []).filter(c => c[0] === 'crit' && /vida için uygun yer bulunamadı/.test(c[2]));
  // the automatic placement left the right end without its screw
  S.screws = S.screws.filter(sc => sc.u < 0); S.screwDrops = [{ pl: S.planes[1], cut: 1, side: 1, want: 1, why: 'noBone' }];
  St.renderChecks(); assert.equal(crit().length, 1, 'reported');
  const saved = St.clone(St.planOf());
  await St.applyPlan(St.clone(saved)); St.renderChecks();
  assert.equal(crit().length, 1, 'an undo to the same cuts and screws keeps it');
  S.screws.push(Object.assign({ u: 25, v: 0, tiltU: 0, tiltV: 0, ok: false, hand: 1 }, { d: 2, D: 5, sleeveH: 5, len: 12 }));
  St.renderChecks(); assert.equal(crit().length, 0, 'a screw set there by hand clears it');
  S.screws.pop(); St.renderChecks(); assert.equal(crit().length, 1);
  const moved = St.clone(saved); moved.planes[1].off = 20; await St.applyPlan(moved); St.renderChecks();
  assert.equal(crit().length, 0, 'another cut: the old placement says nothing about it');
  S.screwDrops = [{ pl: S.planes[1], cut: 1, side: 1, want: 1, why: 'noBone' }]; S.planes.splice(1, 1); St.renderChecks();
  assert.equal(crit().length, 0, 'a deleted cut takes its report with it');
});

test('W12: a cut past the end of the bone is the boneless cut: no screws past it, all past the other one, an info line', async () => {
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '1';
  S.planes = [{ off: -10, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 62, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  assert.equal(St.bonelessCut(), 1); assert.equal(S.bonelessCut, 1);
  St.placeScrews();
  assert.ok(S.screws.length >= 2, 'two screws past the cut with bone: ' + S.screws.length);
  assert.ok(S.screws.every(sc => sc.u < -10), 'none past the boneless cut: ' + S.screws.map(s => s.u));
  assert.equal(S.screwDrops.length, 0, 'the boneless end is not a missing screw');
  await St.regenerate();
  assert.ok(S.checkList.some(c => /Kesi 2 kalan tarafında kemikle karşılaşmıyor.*kesi 1 tarafında/.test(c[2])), 'info line');
  S.planes[1].off = 20; assert.equal(St.bonelessCut(), null, 'both cuts on bone: none');
});

test('W16: the piece frames are found again on a new bone mask', () => {
  twoGuides();
  const f0 = St.pieceFrames(); assert.ok(f0); assert.equal(St.pieceFrames(), f0, 'cached for the same bone');
  S.maskF = S.maskF.slice(); assert.notEqual(St.pieceFrames(), f0, 'recomputed for another mask');
});

test('W11: no cut drag clamps the position to ±45 mm; the slice drag uses CUT_OFF_MAX', () => {
  assert.equal(St.CUT_OFF_MAX, 80);
  const app = src('app.js'), mpr = src('mpr.js');
  assert.ok(!/\.off = clampR\([^)]*-45, 45/.test(app) && !/clampR\(off, -45/.test(app), 'app.js still clamps a cut to ±45');
  assert.ok(!/Math\.max\(-45, Math\.min\(45, off\)\)/.test(mpr) && /CUT_OFF_MAX/.test(mpr), 'mpr.js slice drag');
});

test('E3 / E1: a production STL that is not watertight, and a plate path not completed, are critical (approval and package held)', async () => {
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  St.placeScrews(); await St.regenerate();
  const has = rx => (S.checkList || []).some(c => c[0] === 'crit' && rx.test(c[2]));
  S.prod = { key: St.prodKey(), watertight: false, bodies: 1, stl: new Uint8Array(84) }; St.renderChecks();
  assert.ok(has(/su geçirmez değil/), 'not watertight'); const n = S.crit;
  S.prod.watertight = true; S.prod.bodies = 3; St.renderChecks(); assert.ok(has(/su geçirmez değil ya da beklenenden fazla/), 'extra bodies');
  S.prod.bodies = 1; St.renderChecks(); assert.ok(!has(/su geçirmez/), 'a sound production STL'); assert.equal(S.crit, n - 1);
  S.prod.watertight = false; S.prod.key = 'stale'; St.renderChecks(); assert.ok(!has(/su geçirmez/), 'a stale one (not in the package) says nothing here');
  S.prod = null;
  W.Plate = { params: () => ({ on: true }), get: () => ({ ok: false }) }; St.renderChecks(); assert.ok(has(/Plak hattı kalan kemik boyunca tamamlanamadı/));
  W.Plate = { params: () => ({ on: false }), get: () => ({ ok: false }) }; St.renderChecks(); assert.ok(!has(/Plak hattı/), 'no plate planned');
  W.Plate = { params: () => ({ on: true }), get: () => ({ ok: false }), critical: () => [] }; St.renderChecks(); assert.ok(!has(/Plak hattı kalan/), 'plate.js reports its own');
  delete W.Plate;
});

test('D2: a package plan.json (planOf + summary) and a wrapped plan open; something else is refused', async () => {
  twoGuides();
  const pkg = Object.assign(St.clone(St.planOf()), { ozet: { guide_merkezi_mm: [0, 0, 0] } }), parts = S.screws.map(s => s.part);
  S.planes = [];
  assert.equal(await St.openPlan(St.clone(pkg)), true); assert.equal(S.planes.length, 2); assert.deepEqual(S.screws.map(s => s.part), parts);
  S.planes = [];
  assert.equal(await St.openPlan({ plan: St.clone(pkg) }), true); assert.equal(S.planes.length, 2);
  await assert.rejects(St.openPlan({ guide_merkezi_mm: [0, 0, 0], kesiler: [] }), /plan değil/);
  await assert.rejects(St.openPlan([1, 2]), /plan değil/);
});

test('W19: the drill control moves the sleeve both ways and leaves the built-in default alone', () => {
  twoGuides();
  const D0 = S.screws.map(s => s.D), d0 = S.screws[0].d;
  fire('gScrewD', 'input', '4'); S.screws.forEach((s, i) => { assert.equal(s.d, 4); near(s.D, Math.max(6, D0[i] - d0 + 4), 1e-9, 'sleeve wall kept'); });
  fire('gScrewD', 'input', String(d0)); S.screws.forEach((s, i) => near(s.D, D0[i], 1e-9, 'sleeve back to where it was'));
  fire('gScrewD', 'input', '3'); assert.equal(S.drillD, 3);
  S.kind = 'mandible'; S.drillD = null; St.placeScrews(); assert.ok(S.screws.every(s => s.d === 2 && s.D === 5), 'built-in default intact: ' + JSON.stringify(S.screws.map(s => [s.d, s.D])));
  S.kind = 'dicom';
});

test('G1: the production profile from a plan is numbers in range and a known preset (nothing written into the form as markup)', () => {
  const PAY = '"><img src=x onerror=alert(1)>';
  W.PlanExt.mfg.set({ prof: 'custom', blade: PAY, clear: '0.4', slotTol: 1e9, minWall: null, fit: -5 });
  const M = W.Mfg.get(); assert.equal(M.prof, 'custom'); assert.equal(M.blade, 0.6); assert.equal(M.clear, 0.4); assert.equal(M.slotTol, 0.8); assert.equal(M.minWall, 2); assert.equal(M.fit, 0);
  assert.ok(!$('mfgBox').innerHTML.includes('<img'), $('mfgBox').innerHTML.slice(0, 200));
  W.PlanExt.mfg.set({ prof: '<b>x</b>' }); assert.equal(W.Mfg.get().prof, null);
  W.PlanExt.mfg.set({ prof: '__proto__' }); assert.equal(W.Mfg.get().prof, null);
  W.PlanExt.mfg.set(null);
});

test('D5 / W26: an entry updated later reads with its final value; repeated undo stops at the first entry', async () => {
  const H = W.CaseStore.history;
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -11, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }]; S.screws = []; S.guideOn = false;
  const p0 = St.clone(St.planOf()); S.planes[0].off = -12; const p1 = St.clone(St.planOf());
  H.list = [{ plan: p0, label: 'Başlangıç', at: Date.now() }, { plan: p1, label: W.CaseStore.describe(p0, p1), at: Date.now(), auto: true }]; H.idx = 1;
  assert.ok(/-11,0 → -12,0/.test(H.list[1].label), H.list[1].label);
  S.planes[0].off = -13; St.emit('changed'); await sleep(450);
  assert.equal(H.list.length, 2, 'the rest of the drag is the same step');
  assert.ok(/-11,0 → -13,0/.test(H.list[1].label), 'label follows the value it ended at: ' + H.list[1].label);
  // four presses of undo from the third entry of three: the first entry, not the second
  const p2 = St.clone(St.planOf()); H.list.push({ plan: p2, label: 'x', at: Date.now() }); H.idx = 2;
  for (let i = 0; i < 4; i++) fire('undo', 'click');
  for (let i = 0; i < 400 && (H.idx !== 0 || S.restoring); i++) await sleep(50);
  assert.equal(H.idx, 0, 'ends at the start');
});

test('condyle side: a condylar resection on the side away from the lesion warns', () => {
  W.Ref = { get: () => ({ cond: { R: [50, 0, -6], L: [-50, 0, -6] }, n: [1, 0, 0], d: 0 }), compute: async () => {} };
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; Object.assign(S.lesion, { from: 20, to: 34 });
  S.lesion.condyle = 'L'; const w = W.Condyle.wrongSide(); assert.ok(w && w.side === 'L' && w.off > 10, JSON.stringify(w));
  S.lesion.condyle = 'R'; assert.equal(W.Condyle.wrongSide(), null, 'same side');
  Object.assign(S.lesion, { from: -4, to: 4, condyle: 'L' }); assert.equal(W.Condyle.wrongSide(), null, 'a lesion on the midline');
  S.lesion.condyle = null; delete W.Ref;
});

await run('Denetim 4 app fixes');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
