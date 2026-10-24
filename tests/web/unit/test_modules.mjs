// Studio modules on a synthetic case (straight bar "mandible" + synthetic leg with fibula and tibia cylinders):
// mfg.js (profile -> design), dates.js (CT age), fit.js (gap / wall maps), guiderot.js (slice handle -> degrees),
// fibula.js + osteo.js (junction angle / contact) + fguide.js (fibula guide edits). Run: node test_modules.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import zlib from 'node:zlib';

// synthetic leg as the app's sample format: gzip of uint8 q, hu = q*scale + offset
function legSample() {
  const nx = 64, ny = 48, nz = 300, sp = [1, 1, 1], origin = [-32, -24, -150], q = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i, y = origin[1] + j, z = origin[2] + k;
    const fib = Math.hypot(x - 14, y) < 7 && Math.abs(z) < 135, tib = Math.hypot(x + 12, y) < 14 && Math.abs(z) < 140;
    q[i + nx * (j + ny * k)] = fib || tib ? 200 : 0;
  }
  return { dims: [nx, ny, nz], spacing: sp, origin, scale: 10, offset: -1000, data: zlib.gzipSync(Buffer.from(q)).toString('base64') };
}
const LEG = legSample();
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub }, post: ['fibula.js', 'fguide.js', 'osteo.js', 'mfg.js', 'fit.js', 'dates.js', 'guiderot.js', 'implant.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 30000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const checks = () => (W.ExtraChecks || []).flatMap(f => { try { return f(); } catch (e) { return [['err', 'err', String(e)]]; } });
const fire = (id, type, value) => { const el = $(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

// straight bone bar along x (16 wide, 14 high, top at z = 0), anchor on top, cuts at ±10 mm
async function mandible() {
  const nx = 120, ny = 50, nz = 40, sp = [0.8, 0.8, 0.8], origin = [-48, -20, -24], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 40) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -10, yaw: 0, pitch: 0, w: 1.2 }, { off: 10, yaw: 0, pitch: 0, w: 1.2 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
}
await mandible();

// ---------- mfg.js ----------
test('mfg: choosing SLA writes clear 0.2, fit 0.1, slot = blade 0.6 + tol 0.2 = 0.8 mm into every cut, and unapproves changed cuts', () => {
  S.planes.forEach(p => { p.ok = true; p.by = 'x'; });
  fire('mfProf', 'change', 'sla');
  near(S.g.clear, 0.2, 1e-12); near(S.g.fit, 0.1, 1e-12); S.planes.forEach(p => { near(p.w, 0.8, 1e-12); assert.equal(p.ok, false); });
  assert.ok(S.g.wall >= 2.0, 'wall raised to the profile minimum');
});
test('mfg: checks flag a wall below the profile minimum (crit) and a slot narrower than blade + tolerance (warn)', () => {
  S.g.wall = 1.6; S.planes[0].w = 0.7;
  const c = checks(); assert.ok(c.some(x => x[0] === 'crit' && /duvar/i.test(x[2]))); assert.ok(c.some(x => x[0] === 'warn' && /Kesi 1 yuvası/.test(x[2])));
  S.g.wall = 2.5; S.planes[0].w = 0.8;
});
test('mfg: plan extension round trip, and a new (non-restoring) volume resets the profile', () => {
  const x = W.PlanExt.mfg.get(); assert.equal(x.prof, 'sla');
  W.PlanExt.mfg.set(null); assert.equal(W.PlanExt.mfg.get(), null);
  W.PlanExt.mfg.set(x); assert.equal(W.PlanExt.mfg.get().prof, 'sla');
  St.emit('volume', { restoring: false }); assert.equal(W.Mfg.get().prof, null);
});
// D2 (plan after P0): print presets for resin (SLA, PolyJet) and PA12 SLS, the drill hole choice (printed / metal
// sleeve; not chosen by default, the clinical team picks) and a build direction that keeps supports off the contact
test('D2: PolyJet and PA12 presets, the sleeve choice is stored only when made, the build direction keeps supports off the contact surface', async () => {
  assert.ok(W.Mfg.presets.polyjet && W.Mfg.presets.sls && W.Mfg.presets.sla, Object.keys(W.Mfg.presets).join());
  assert.equal(W.Mfg.get().prof, null, 'no profile until one is chosen (the default stays)');
  fire('mfProf', 'change', 'polyjet');
  assert.equal(W.Mfg.get().sleeve, undefined); assert.ok(!('sleeve' in W.PlanExt.mfg.get()), 'not chosen: not in the plan');
  assert.ok(checks().some(c => /metal kovan ya da basılı delik seçilmedi/.test(c[2])));
  fire('mfSleeve', 'change', '1'); assert.equal(W.Mfg.get().sleeve, 1); assert.equal(W.PlanExt.mfg.get().sleeve, 1);
  assert.ok(checks().some(c => /Metal kovan seçildi/.test(c[2])));
  W.PlanExt.mfg.set({ prof: 'sls', sleeve: 'x' }); assert.equal(W.Mfg.get().sleeve, undefined, 'a damaged value is dropped');
  W.PlanExt.mfg.set({ prof: 'sls', sleeve: 0 }); assert.equal(W.Mfg.get().sleeve, 0);
  await St.regenerate(); await St.settled();
  const b = W.Mfg.buildDir(); assert.ok(b, 'a build direction');
  assert.equal(JSON.stringify(b.axis), JSON.stringify([-0, -0, -1].map(x => +x.toFixed(4))), 'bone side up: build axis -n');
  assert.equal(b.contactSupportMm2, 0, 'no support on the contact surface');
  assert.ok(b.reverseContactMm2 > 100, 'the other way up the contact surface would carry supports: ' + b.reverseContactMm2);
  assert.ok(W.Mfg.summary().baski_yonu && W.Mfg.summary().matkap_delikleri === 'basılı delik');
  St.emit('volume', { restoring: false });
});
test('mfg: a damaged plan with an unknown profile key does not break the checks list', () => {
  try { W.PlanExt.mfg.set({ prof: 'nonexistent' }); } catch (e) { /* applyPlan catches and calls set(null) */ W.PlanExt.mfg.set(null); }
  assert.ok(!checks().some(x => x[0] === 'err'), JSON.stringify(checks().filter(x => x[0] === 'err')));
});

// ---------- dates.js ----------
test('dates: CT 30 days before surgery -> warning; CT after surgery -> warning; 10 days -> nothing', () => {
  const D = W.Dates; assert.equal(D.days('2026-01-01', '2026-01-31'), 30);
  fire('surgDate', 'change', '2026-01-31');
  assert.ok(checks().some(x => x[0] === 'warn' && /30 gün önce/.test(x[2])));
  fire('surgDate', 'change', '2025-12-25'); assert.ok(checks().some(x => x[0] === 'warn' && /ameliyat tarihinden sonra/.test(x[2])));
  fire('surgDate', 'change', '2026-01-11'); assert.ok(!checks().some(x => /BT'si ameliyat/.test(x[2]) || /gün önce çekilmiş/.test(x[2])));
});
test('dates: days() across a DST change is a whole number (UTC parse)', () => { assert.equal(W.Dates.days('2026-03-28', '2026-03-30'), 2); assert.equal(W.Dates.days('2026-10-24', '2026-10-26'), 2); });
test('dates: malformed surgery date from a plan yields no warning and no exception', () => {
  W.PlanExt.dates.set({ surgery: '<script>', ct: 'x' }); assert.doesNotThrow(() => checks());
  W.PlanExt.dates.set(null);
});

// ---------- fit.js ----------
test('fit: gap map on the built guide reports the share of the inner surface within ±0.25 mm of the design gap', async () => {
  W.Fit.view.map = 'gap'; W.Fit.refresh();
  const s = W.Fit.stats().m; assert.ok(s && s.mode === 'gap' && s.inner > 100, JSON.stringify(s));
  near(s.design, S.g.clear + (S.g.peri || 0), 1e-12);
  console.log(`       fit map: design ${s.design} mm, inner vertices ${s.inner}, in band ${(s.inBand * 100).toFixed(0)} %, tighter ${(s.tight * 100).toFixed(0)} %`);
  // the app's own map should agree with its design; with clearance 0.2-0.3 mm the voxel guide sits ~0 mm off the bone (finding B-1)
  assert.ok(s.tight < 0.5, `share closer than design-0.25 mm: ${(s.tight * 100).toFixed(0)} % (inBand ${(s.inBand * 100).toFixed(0)} %)`);
});
test('fit: wall map reports a minimum thickness close to the design wall', () => {
  W.Fit.view.map = 'wall'; W.Fit.refresh(); const s = W.Fit.stats().m;
  assert.ok(s && s.mode === 'wall'); assert.ok(s.minT > 0 && s.minT <= S.g.wall + 0.6, JSON.stringify(s));
  W.Fit.view.map = 'none'; W.Fit.refresh(); assert.equal(W.Fit.stats().m, null);
});

// ---------- guiderot.js ----------
test('guiderot: dragging the slice handle to a point 30° off the guide axis sets the guide angle to 30 (degrees, not radians)', () => {
  S.g.rot = 0;
  const v = { axis: 2 }, Tx = { fx: x => x, fy: y => y }, A = { toIdx: w => G.indexOf(S.vol, w), idxToImg: (vv, ix) => [ix[0], ix[1]], st: { cur: G.indexOf(S.vol, [0, 0, 1]) } };
  // the seating normal is along z, so the axial view (axis 2) sees the seating plane face-on
  const h = (W.SliceHandles || [])[0]; assert.ok(h, 'handle registered');
  const half = S.g.L / 2 + 6, end = G.indexOf(S.vol, [half, 0, 0]);
  assert.equal(h.hit(v, end[0], end[1], Tx, A), true, 'hit at the handle');
  h.drag([Math.cos(Math.PI / 6) * 20, Math.sin(Math.PI / 6) * 20, 0]); h.end();
  assert.equal(S.g.rot, 30);
});

// ---------- fibula.js + osteo.js + fguide.js ----------
test('fibula: synthetic leg loads, the thinner long bone is the fibula candidate, a plan with ≥1 segment of the defect length is made', async () => {
  S.g.rot = 0; S.planes = [{ off: -10, yaw: 0, pitch: 0, w: 1.2 }, { off: 10, yaw: 0, pitch: 0, w: 1.2 }]; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().last);
  const st = W.Fibula.state(); near(st.F.c.FR, 7, 1.5, 'fibula radius');
  const segs = st.last.segs, L = segs.reduce((s, g) => s + g.L, 0);
  near(L, 20, 1.5, 'graft length vs. 20 mm defect between cut centres');
});
test('fibula: segments do not overlap on the fibula and keep the distal margin', () => {
  const st = W.Fibula.state(), P0 = W.Fibula.plan();
  st.last.segs.forEach((g, i, a) => { if (i) assert.ok(g.s0 >= a[i - 1].s1 + P0.kerf, 'gap between segments'); });
  assert.ok(st.last.segs[0].s0 - st.F.c.smin >= P0.distal - 1e-9);
});
test('osteo: straight bar -> graft axis within 5° of the stump axis, contact ≥ 80 % of the graft section at both ends', async () => {
  await sleep(400); W.Osteo.update(); const r = W.Osteo.get();
  assert.ok(r && r.length >= 2, 'junctions: ' + JSON.stringify(r));
  // kerf on the resected side (default): the graft meets the stump flush, planned gap 0 at both ends
  assert.equal(S.g.kerfSide, 1);
  r.filter(o => o.kind !== 'J').forEach(o => { assert.ok(o.angle != null && o.angle < 5, o.name + ' angle ' + o.angle); assert.ok(o.overlap > 0.8, o.name + ' overlap ' + o.overlap); near(o.gap, 0, 1e-9, 'gap 0 with the kerf on the resected side'); });
  // slot centred on the plane: half the slot (0.6 mm) is lost from each stump, and the slot centre moves back onto the plane
  S.g.kerfSide = 0; St.placeScrews(); await St.rebuildResection(); await St.regenerate(); await sleep(400); W.Osteo.update();
  const r0 = W.Osteo.get();
  r0.filter(o => o.kind !== 'J').forEach(o => near(o.gap, 0.6, 1e-9, 'gap = slot/2 when centred'));
  St.planesWorld().forEach(pw => { near(pw.shift, 0, 1e-12); near(pw.pSlot.distanceTo(pw.p), 0, 1e-12); });
  S.g.kerfSide = 1; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
  const pw = St.planesWorld().sort((a, b) => a.off - b.off);
  near(pw[0].shift, 0.6, 1e-12, 'first cut: slot shifted towards the defect (+u)'); near(pw[1].shift, -0.6, 1e-12, 'last cut: towards the defect (-u)');
  near(pw[0].pSlot.x, -10 + 0.6, 1e-9); near(pw[1].pSlot.x, 10 - 0.6, 1e-9);
});
test('fibula guide: built on the fibula, slots of kerf width, one piece', async () => {
  await until(() => S.fib.guide && S.fib.guide.result, 60000);
  const R = S.fib.guide.result; assert.equal(R.pieces, 1);
  // A1: a new plan gets the mandible's slot (blade + tolerance) and rim, not the 1.0 mm kerf
  near(W.Fibula.plan().slotW, St.slotDefault(), 1e-12); assert.equal(W.Fibula.plan().boss, St.G_DEFAULT.boss);
  near(W.Fibula.slotOf(), St.slotDefault(), 1e-12);
  S.fib.guide.ctx.pls.forEach(p => near(p.w, St.slotDefault(), 1e-12));
  // automatic screws keep every rule: on bone, clear of the slots (no drill path through a slot)
  assert.ok(R.screwInfo.length >= 1);
  R.screwInfo.forEach((si, i) => { assert.ok(si.ok, 'screw ' + i + ' on bone'); assert.ok(!si.crossesPlane, 'screw ' + i + ' clear of the slots'); });
});
test('fibula: slot width separate from the blade; slots open at slotW outside each face, segments spaced by slot + 1 mm', async () => {
  const keep = St.clone(W.Fibula.plan()), p = St.clone(keep);
  p.kerf = 0.6; p.slotW = 0.8; await W.Fibula.apply(p)
  await until(() => S.fib.guide && S.fib.guide.ctx && Math.abs(S.fib.guide.ctx.pls[0].w - 0.8) < 1e-9 && Math.abs(S.fib.guide.ctx.pls[0].pSlot.distanceTo(S.fib.guide.ctx.pls[0].p) - 0.4) < 1e-9, 60000);
  near(W.Fibula.slotOf(), 0.8, 1e-12);
  S.fib.guide.ctx.pls.forEach(q => { near(q.w, 0.8, 1e-12); near(q.pSlot.distanceTo(q.p), 0.4, 1e-9, 'slot centre w/2 outside the face'); });
  const st = W.Fibula.state(); st.last.segs.forEach((g, i, a) => { if (i) assert.ok(g.s0 >= a[i - 1].s1 + 0.8 + 1 - 1e-6, 'segments spaced by slot + 1 mm'); });
  assert.ok(!W.Fibula.checks().some(c => /yuvası .* geniş/.test(c[2])), 'slot 0.2 mm over the blade: no warning');
  p.slotW = 1.2; await W.Fibula.apply(p); await sleep(30);
  assert.ok(W.Fibula.checks().some(c => c[0] === 'warn' && /yuvası .* geniş/.test(c[2])), 'slot 0.6 mm over the blade is warned');
  p.slotW = 0.3; await W.Fibula.apply(p); near(W.Fibula.plan().slotW, 0.6, 1e-9, 'never narrower than the blade');
  p.slotW = 9; await W.Fibula.apply(p); near(W.Fibula.plan().slotW, 2.5, 1e-9, 'clamped to the slider range');
  await W.Fibula.apply(keep);
  await until(() => S.fib.guide && S.fib.guide.result && Math.abs(S.fib.guide.ctx.pls[0].w - (keep.slotW == null ? keep.kerf : keep.slotW)) < 1e-9 && Math.abs(S.fib.guide.ctx.pls[0].pSlot.distanceTo(S.fib.guide.ctx.pls[0].p) - Math.max(keep.kerf, keep.slotW || 0) / 2) < 1e-9, 60000);
});
test('fguide: editing the body wall writes plan.fg, unapproves the fibula plan and rebuilds', async () => {
  const p = W.Fibula.plan(); p.ok = true; p.by = 'x';
  W.FibGuide.render(); const el = $('fg_wall'); assert.ok(el.listeners.change, 'slider wired');
  el.value = '3.5'; el.listeners.change.forEach(f => f({}));
  assert.equal(p.fg.wall, 3.5); assert.equal(p.ok, false);
  await until(() => S.fib.guide && S.fib.guide.ctx.g.wall === 3.5, 60000);
});
test('fguide: adding a screw copies the selected one 8 mm further along (clamped to ±25 mm)', () => {
  const p = W.Fibula.plan(); $('fgAdd').listeners = {}; W.FibGuide.render();   // fake elements persist across renders: drop old listeners
  const n0 = W.Fibula.guideInfo().screws.length; (P.doc.getElementById('fgAdd').listeners.click || []).forEach(f => f({}));
  assert.equal(p.fsc.length, n0 + 1); near(p.fsc.at(-1).off, Math.min(25, (p.fsc[0].off || 0) + 8), 1e-12);
});

// ---------- fibula: donor side, roll, pedicle, clinical profile, bone bridge between segments ----------
test('fibula side: the synthetic leg (fibula at +x of the tibia) is a left leg, known from the tibia; a contradicting hand choice is warned', async () => {
  const ls = W.Fibula.legSide(); assert.equal(ls.side, 'L'); assert.equal(ls.how, 'tibia');
  assert.ok(!W.Fibula.checks().some(c => /bacak tarafı/i.test(c[2])), 'no side message when the tibia gives it');
  fire('fibSide', 'change', 'R'); assert.equal(W.Fibula.plan().side, 'R'); assert.equal(W.Fibula.legSide().how, 'manual');
  assert.ok(W.Fibula.checks().some(c => c[0] === 'warn' && /Bacak tarafı sağ seçili, ama fibula tibianın solunda/.test(c[2])));
  fire('fibSide', 'change', ''); assert.equal(W.Fibula.plan().side, null); assert.equal(W.Fibula.legSide().how, 'tibia');
});
test('fibula side: without a tibia the side is a guess (critical until chosen) and the guide face e2 is the lateral side of the chosen leg', async () => {
  const st = W.Fibula.state(), cand = st.F.cands[st.F.c.i], tib = cand.tibia;
  cand.tibia = null;
  try {
    assert.equal(W.Fibula.legSide().how, 'guess');
    assert.ok(W.Fibula.checks().some(c => c[0] === 'crit' && /Tibia bulunamadı/.test(c[2])), 'critical while the side is a guess');
    fire('fibSide', 'change', 'R');
    assert.ok(!W.Fibula.checks().some(c => /Tibia bulunamadı/.test(c[2])), 'chosen side clears it');
    assert.ok(W.Fibula.state().F.c.FA[1].x < -0.9, 'right leg: guide face towards patient right (-x)');
    fire('fibSide', 'change', 'L');
    assert.ok(W.Fibula.state().F.c.FA[1].x > 0.9, 'left leg: towards +x');
  } finally { cand.tibia = tib; fire('fibSide', 'change', ''); }
});
test('fibula roll: automatic roll turns the lateral face buccal (pedicle lingual); a hand roll that puts the pedicle buccal is warned', async () => {
  // the straight bar has no outer side; a block added behind it moves the mandible centre so +y-side is lingual, -y buccal
  const keepMask = S.mask, m = keepMask.slice(), r = S.red;
  for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) { const w = G.worldOf(r, i, j, k); if (w[1] > 10 && w[1] < 19 && Math.abs(w[0]) < 40 && w[2] < 0 && w[2] > -14) m[i + r.nx * (j + r.ny * k)] = 1; }
  S.mask = m;
  try {
    const p = W.Fibula.plan(); $('fibRollAuto').checked = true; fire('fibRollAuto', 'change');
    assert.equal(p.rollAuto, 1);
    const segs = W.Fibula.state().last.segs.filter(g => !g.barrel);
    segs.forEach(g => {
      assert.ok(g.out && g.out.y < -0.9, 'buccal is -y: ' + (g.out && g.out.toArray()));
      assert.ok(g.lat.dot(g.out) > 0.99, 'lateral face buccal: ' + g.lat.dot(g.out));
      assert.ok(g.ped.dot(g.out) < -0.5, 'pedicle lingual: ' + g.ped.dot(g.out));
    });
    assert.ok(!W.Fibula.checks().some(c => /pedikül tarafı bukkala/.test(c[2])));
    // a hand roll of 180° from the suggestion: the slider turns the suggestion off and the pedicle faces buccally
    W.Fibula.syncUI && W.Fibula.syncUI();
    const r0 = p.roll[0], el = $('fr0'); el.value = String(((r0 + 360) % 360) - 180);
    (el.listeners.input || []).forEach(f => f({ target: el })); (el.listeners.change || []).forEach(f => f({ target: el }));
    await sleep(60);
    assert.equal(p.rollAuto, 0, 'hand roll turns the suggestion off');
    assert.ok(W.Fibula.checks().some(c => c[0] === 'warn' && /Fibula segmenti 1: pedikül tarafı bukkala/.test(c[2])), 'buccal pedicle is warned');
    $('fibRollAuto').checked = true; fire('fibRollAuto', 'change');
    assert.ok(!W.Fibula.checks().some(c => /pedikül tarafı bukkala/.test(c[2])), 'back to the suggestion');
  } finally { S.mask = keepMask; fire('fibRollAuto', 'change'); }
});
test('fibula rules: a changed threshold is stored in the plan (only if it differs), drives the checks, and resets', async () => {
  const p = W.Fibula.plan(); assert.equal(p.rules, undefined);
  fire('fru_segMin', 'change', '200');            // clamped to its range (max 40)
  assert.equal(JSON.stringify(p.rules), '{"segMin":40}');
  await sleep(30); assert.ok(W.Fibula.checks().some(c => /40 mm('nin)? altı/.test(c[2])), 'checks follow the profile');
  fire('fru_gapWarn', 'change', '0.2'); assert.equal(p.rules.gapWarn, 0.2);
  fire('fru_gapWarn', 'change', '1');              // back to the default: not stored
  assert.ok(!('gapWarn' in p.rules));
  (P.doc.getElementById('fibRulesReset').listeners.click || []).forEach(f => f({}));
  assert.equal(p.rules, undefined);
});
test('fibula bridge: two segments leave both saw slots and the bone bridge between them over the whole section', async () => {
  const keep = St.clone(W.Fibula.plan()), q = St.clone(keep); q.n = 2; q.nAuto = 0; q.knots = [0.5]; q.yaw = [0, 20, 0]; q.pitch = [0, 0, 0]; q.roll = [0, 0]; q.fsc = null;
  await W.Fibula.apply(q); await sleep(30);
  const st = W.Fibula.state(), [a, b] = st.last.segs, sw = Math.max(W.Fibula.plan().kerf, W.Fibula.slotOf()),   // (the cut: the wider of the kerf and the slot)
    FR = st.F.c.FR, tilt = v => Math.hypot(v.y, v.z) / Math.abs(v.x);
  // (Denetim 5 F4: the closure uses the thickest section radius, and each slot is as thick along the axis as its face is oblique)
  const FRm = st.F.c.FRm, slx = v => sw / Math.max(0.5, Math.abs(v.x));
  near(b.s0 - a.s1, slx(a.n1) + slx(b.n0) + W.Fibula.RULES.wedgeBridge + FRm * (tilt(a.n1) + tilt(b.n0)), 1e-9);
  // at the section edge the two cut planes are still apart by both slots and the bridge
  assert.ok(b.s0 - a.s1 - FRm * (tilt(a.n1) + tilt(b.n0)) - slx(a.n1) - slx(b.n0) >= W.Fibula.RULES.wedgeBridge - 1e-9);
  assert.ok(FRm >= FR);
  await W.Fibula.apply(keep);
});
test('fibula plan: a stored plan without side / rollAuto / rules keeps those keys absent (approval signature unchanged)', async () => {
  const keep = St.clone(W.Fibula.plan()), q = St.clone(keep); delete q.side; delete q.rollAuto; delete q.rules;
  await W.Fibula.apply(q); const p = W.Fibula.plan();
  assert.ok(!('side' in p) && !('rollAuto' in p) && !('rules' in p));
  q.rules = { segMin: 20, devWarn: 'x', bogus: 5, gapErr: 3 }; await W.Fibula.apply(q);
  assert.equal(JSON.stringify(W.Fibula.plan().rules), '{"gapErr":3}', 'defaults, junk and unknown keys dropped');
  await W.Fibula.apply(keep);
});

test('O-5: stored fibula plan with kerf <= 0 or out-of-range values is clamped to the control ranges and reported', async () => {
  const keep = St.clone(W.Fibula.plan()), p = St.clone(keep);
  p.kerf = 0; p.distal = 9999; p.vOff = NaN; p.yaw[0] = 1e9; p.knots = [NaN]; p.dblH = -4;
  await W.Fibula.apply(p); await sleep(30);
  const q = W.Fibula.plan();
  near(q.kerf, 1.0, 1e-9, 'kerf 0 -> default'); assert.equal(q.distal, 140); assert.equal(q.vOff, 0); assert.equal(q.yaw[0], 180); assert.ok(q.knots.every(k => k > 0 && k < 1)); assert.equal(q.dblH, 8);
  assert.match($('toast').textContent, /Testere payı/, 'user is told that the saw kerf was invalid');
  p.kerf = 7; await W.Fibula.apply(p); assert.equal(W.Fibula.plan().kerf, 2);
  await W.Fibula.apply(keep);
});
test('O-5: stored implant plan is clamped (position, diameter, length, tilt, segment) and non-finite values fall back', () => {
  W.PlanExt.impl.set([{ seg: 99, t: 1e9, d: -5, len: NaN, tb: 400, tm: 'x' }, null, 5]);
  const l = W.PlanExt.impl.get(); assert.equal(l.length, 1);
  const o = l[0]; assert.equal(o.seg, W.Fibula.MAX_N); assert.equal(o.t, 400); assert.equal(o.d, 3); assert.equal(o.len, 10); assert.equal(o.tb, 89); assert.equal(o.tm, 0);   // W4: segment up to the largest fibula plan, not 0..2 / 60 mm
  W.PlanExt.impl.set(null);
});

await run('modules (mfg, dates, fit, guiderot, fibula, osteo, fguide)');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
