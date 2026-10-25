// Guide screws against the saw slots after a cut edit (thread "Kesi ile vida deliği çakışması", 2026-10-25).
// Melikhan: after adjusting the cuts the screw holes sat on top of the slots in the model. Two causes:
//  - the distance to a slot was measured only along the drill path in bone, but the sleeve stands from the entry up
//    through the guide (clearance + wall + sleeveH) and the kernel adds it after cutting the slots: a sleeve that
//    reaches into a slot fills it and the saw stops. A cut turned 20° about the lateral axis leaned its slot 1.7 mm into
//    a sleeve while the check said "3.3 mm away"; tilted automatic screws leaned their own sleeve to 0.8 mm of a slot
//  - after a cut edit the screws were placed again only when one ended up between the outer cuts; a cut moved or
//    turned next to a screw (hand-set or automatic) left it in the slot
// Now: the sleeve column counts (automatic placement, checks, mandible and fibula guide), a cut edit moves the screws
// it reaches clear of it (hand-set ones too, with a message), under screwSlotMin (clinical.js) critical, under
// screwSlotGap a warning, both with a one-click fix; the kernel's slot is open where the sleeve stood.
// Run: node test_screwslot.mjs
import { test as test0, run, assert } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const P = studio({ post: ['store.js', 'mfg.js'], extra: { addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const test = (name, fn) => test0(name, async () => { await St.settled(); return fn(); });
{
  // straight bar "mandible" along x (|x| < 58), elliptic section 20 x 12 mm, top at z = 0
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-screwslot' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
// the smallest distance from any slot edge to any sleeve over its whole column (entry up through the guide)
const sleeveGaps = () => { const pls = St.planesWorld(), cw = S.g.clear + (S.g.peri || 0) + S.g.wall; return S.screws.map(sc => { const w = St.screwWorld(sc); return w.entry ? St.sleeveSlotGap(w.entry, w.dir, sc, pls, cw) : Infinity; }); };
const rows = re => { St.renderChecks(); return (S.checkList || []).filter(c => re.test(c[2])); };
async function start() {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 0.8, ok: false }];
  S.guideOn = true; S.g.split = 0; S.gAuto.split = 0;
  St.placeScrews(); await St.rebuildResection(); await St.regenerate(); await St.settled();
}

test('clinical.js holds the thresholds (sample values) and the modules read them', () => {
  const C = W.Clinical;
  assert.equal(C.v('screwSlotGap'), 2); assert.equal(C.v('screwSlotMin'), 0.5); assert.equal(C.v('screwCutGap'), 5); assert.equal(C.v('screwCutWarn'), 3);
  assert.equal(St.SCREW_SLOT_GAP, 2); assert.equal(St.SCREW_SLOT_MIN, 0.5);
  assert.match(src('fibula.js'), /screwSlotGap: CVf\('screwSlotGap', 2\)/, 'fibula rules default from the profile');
  assert.ok(!/SCREW_SLOT_GAP = 2\b/.test(src('app.js')), 'no own copy in app.js');
});

test('automatic screws keep screwSlotGap from every slot over the sleeve column too (tilted screws leaned theirs to 0.8 mm)', async () => {
  await start();
  assert.ok(S.screws.length >= 2, 'screws placed: ' + S.screws.length);
  sleeveGaps().forEach((g, i) => assert.ok(g >= St.SCREW_SLOT_GAP - 1e-6, `screw ${i + 1} sleeve ${g.toFixed(2)} mm from a slot`));
  // buildGuide reports the same distance (sleeve column included) to the checks
  S.result.screwInfo.forEach((si, i) => assert.ok(si.ok && si.slotGap >= St.SCREW_SLOT_GAP - 1e-6, `screw ${i + 1} slotGap ${si.slotGap}`));
});

test('a cut turned over the screws (pitch 20° and 35°): the screws are moved clear, no sleeve in a slot, no slot check', async () => {
  await start();
  for (const pitch of [20, 35]) {
    S.planes[1].pitch = pitch; St.schedule(true); await St.settled();
    sleeveGaps().forEach((g, i) => assert.ok(g >= St.SCREW_SLOT_GAP - 1e-6, `pitch ${pitch}: screw ${i + 1} sleeve ${g.toFixed(2)} mm from a slot`));
    assert.equal(rows(/kesi yuvasına/).length, 0, 'no slot check: ' + rows(/kesi yuvasına/).map(r => r[2]).join(' | '));
  }
});

test('a cut moved up to a hand-set screw: the screw is moved away (kept by hand, approval dropped, message)', async () => {
  await start();
  const right = S.screws.filter(sc => sc.u > 0); assert.ok(right.length, 'a screw past cut 2');
  const hs = right[0]; hs.hand = 1; hs.ok = true; const u0 = hs.u;
  W.document.getElementById('caseMsg').textContent = '';
  // the slot edge 1 mm from the sleeve (old code: no re-placement, no check under 2 mm)
  S.planes[1].off = Math.round((hs.u - hs.D / 2 - S.planes[1].w / 2 - 1) * 10) / 10;
  assert.ok(St.screwSlotGap(hs, St.planesWorld()) < St.SCREW_SLOT_GAP, 'set-up: the moved cut comes within 2 mm of the screw: ' + St.screwSlotGap(hs, St.planesWorld()));
  St.schedule(true); await St.settled();
  assert.ok(S.screws.includes(hs) && hs.hand, 'the same hand-set screw');
  assert.ok(hs.u > u0, `moved away from the cut: ${u0} -> ${hs.u}`);
  assert.equal(hs.ok, false, 'approval dropped');
  sleeveGaps().forEach((g, i) => assert.ok(g >= St.SCREW_SLOT_GAP - 1e-6, `screw ${i + 1} sleeve ${g.toFixed(2)} mm`));
  assert.match(W.document.getElementById('caseMsg').textContent, /elle yerleştirilmiş vida yuvadan/);
});

test('a hand-set screw dragged next to a slot: critical (into the slot) / warning (under 2 mm), each with the fix that clears it', async () => {
  await start();
  const hs = S.screws.find(sc => sc.u > 0); hs.hand = 1;
  const edge = S.planes[1].off + S.planes[1].w / 2;
  // sleeve 1 mm into the slot
  hs.u = edge + hs.D / 2 - 1; hs.tiltU = 0; hs.tiltV = 0; St.schedule(false); await St.settled();
  let r = rows(/kesi yuvasına|kesi yuvasıyla/);
  assert.ok(r.length && r[0][0] === 'crit', 'critical: ' + r.map(x => x[0] + ' ' + x[2]).join(' | '));
  assert.ok(r[0][4] && r[0][4].some(f => f[0] === 'screwClear'), 'with the fix button');
  // 1 mm from the slot: a warning
  hs.u = edge + hs.D / 2 + 1; St.schedule(false); await St.settled();
  r = rows(/kesi yuvasına/);
  assert.ok(r.length && r[0][0] === 'warn' && /önerilen en az 2(,0)? mm/.test(r[0][2]), 'warning: ' + r.map(x => x[0] + ' ' + x[2]).join(' | '));
  // the fix
  await St.runFix('screwClear'); await St.settled();
  assert.equal(rows(/kesi yuvasına|kesi yuvasıyla/).length, 0, 'cleared');
  sleeveGaps().forEach((g, i) => assert.ok(g >= St.SCREW_SLOT_GAP - 1e-6, `screw ${i + 1} sleeve ${g.toFixed(2)} mm`));
});

test('the kernel fills a slot where a sleeve stands in it (why the sleeve column counts)', async () => {
  const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;
  const sc = { d: 2, D: 5, sleeveH: 5, len: 10 }, entry = V(1.5, 0, 0), dir = V(0, 0, -1);
  const out = await St.buildGuide({ P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [{ sc, dir, entry }], bone: BAR, h: 0.4, fast: true,
    g: Object.assign({}, St.G_DEFAULT, { wrapU: null, L: 36, W: 16 }) });
  const si = out.result.screwInfo[0];
  assert.ok(si.ok && si.slotGap < 0, 'buildGuide reports the sleeve in the slot: ' + si.slotGap);
  assert.ok(!si.crossesPlane, 'the drill itself stays out of the slot');
});

await run('guide screws vs saw slots after a cut edit');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
