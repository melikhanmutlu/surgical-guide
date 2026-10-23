// Adaptive mandible guide sizing (app.js sizeBody / autoBody / fitWrap / buildGuideSet) on synthetic bones of different
// heights, a tapering bone and a curved "angle" bone, the fibula segment-count rule (fibula.js segmentChoice) and the
// saw-kerf side setting (stump gap). No patient data. Run: node test_adaptive.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const fetchStub = async () => { throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub }, post: ['fibula.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g;
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// a synthetic CT: bone(x, y, z) -> bool on a 0.8 mm grid; the guide frame sits on the top face (z = 0), u = x, v = y
async function volume(bone, box = { x: 50, y: 24, z: 42 }) {
  const sp = [0.8, 0.8, 0.8], nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (bone(x, y, z)) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, St.AUTO_DEFAULT); S.fitLog = []; S.autoSize = null; S.result = null;
  Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null, ok: false });
}
// elliptical bar along x: half-height hy across y (the mandible's height), top at z = 0, widest level at z = -hz
const ellipseBar = (hy, hz, len = 48) => (x, y, z) => Math.abs(x) < len && (y / hy) ** 2 + ((z + hz) / hz) ** 2 < 1;
async function plan(offs, opts = {}) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = offs.map(off => ({ off, yaw: 0, pitch: 0, w: 0.8 }));
  S.g.split = opts.split || 0; if (opts.split) S.gAuto.split = 0;
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
  return S.result;
}
const checks = () => S.checkList || [];
const text = () => checks().map(c => c[2]).join('\n');

test('sizeBody: the body width follows the bone height (10 / 20 / 30 mm) and the wrap the depth to the widest level; the guide seats in one piece with every sleeve on bone', async () => {
  const got = [];
  for (const hy of [5, 10, 15]) {
    await volume(ellipseBar(hy, 6));
    const R = await plan([-12, 12]);
    const height = 2 * hy, wantW = Math.max(10, Math.min(40, Math.round(height + 2 * (S.g.clear + S.g.wall) + 2)));
    got.push({ height, W: S.g.W, wrap: S.g.wrap, pieces: R.pieces, free: R.seat && R.seat.free, screws: R.screwInfo.map(s => s.ok) });
    assert.ok(Math.abs(S.g.W - wantW) <= 2, `height ${height}: W ${S.g.W} (expected about ${wantW})`);
    assert.ok(S.g.wrapU && S.g.wrapU.length >= 3, 'wrap profile recorded');
    assert.ok(S.g.wrap >= 2 && S.g.wrap <= 0.8 * 6 + 1, `height ${height}: wrap ${S.g.wrap} from depth 6 (0.8 x depth, rounded to 0.5)`);
    assert.ok(S.autoSize && Math.abs(S.autoSize.height - height) <= 1.2, 'measured bone height ' + (S.autoSize && S.autoSize.height));
    assert.equal(R.pieces, 1, `height ${height}: one piece`);
    assert.ok(R.seat && R.seat.ok && R.seat.free > 0, `height ${height}: seatable (${R.seat && R.seat.free})`);
    assert.ok(R.screwInfo.length >= 2 && R.screwInfo.every(s => s.ok), `height ${height}: every sleeve on bone`);
    assert.ok(/Guide gövdesi kemiğe göre boyutlandı/.test(text()), 'the automatic size is stated in the checks');
    assert.ok(!checks().some(c => c[0] === 'crit'), 'no critical: ' + text());
  }
  console.log('    ' + got.map(g => `h${g.height}: W ${g.W} wrap ${g.wrap} pieces ${g.pieces} free ${g.free}`).join(' | '));
  assert.ok(got[0].W < got[1].W && got[1].W < got[2].W, 'width grows with the bone height');
});

test('sizeBody: hand-set width is kept (gAuto.W = 0) while the wrap stays automatic; "back to automatic" restores sizing', async () => {
  await volume(ellipseBar(10, 6));
  S.gAuto.W = 0; S.g.W = 30; S.g.vc = 0;
  await plan([-12, 12]);
  assert.equal(S.g.W, 30, 'hand-set width respected'); assert.ok(S.g.wrapU, 'wrap still automatic');
  S.gAuto.W = 1; St.placeScrews();
  assert.ok(S.g.W < 30, 'automatic width again: ' + S.g.W);
});

test('sizeBody: a bone that drops away towards one end gets a shallower wrap there (per-side wrap), one piece, sleeves on bone', async () => {
  // height 24 and widest level 8 mm deep at x <= 0, tapering to height 12 / widest level 3 mm deep at x = 30
  const taper = (x, y, z) => { const t = Math.max(0, Math.min(1, x / 30)), hy = 12 - 6 * t, hz = 8 - 5 * t; return Math.abs(x) < 48 && (y / hy) ** 2 + ((z + hz) / hz) ** 2 < 1; };
  await volume(taper);
  const R = await plan([-14, 14]);
  const pr = S.g.wrapU; assert.ok(pr && pr.length >= 3, 'profile');
  const at = uu => pr.reduce((a, b) => (Math.abs(b[0] - uu) < Math.abs(a[0] - uu) ? b : a))[1];
  const thick = at(Math.min(...pr.map(p => p[0]))), thin = at(Math.max(...pr.map(p => p[0])));
  console.log(`    wrap profile ${pr.map(p => p[0] + ':' + p[1]).join(' ')} (W ${S.g.W}, vc ${S.g.vc})`);
  assert.ok(thin < thick, `wrap shallower at the thin end: ${thin} < ${thick}`);
  assert.ok(thin <= 0.8 * 3.5 + 1 && thick >= 0.8 * 7.5 - 1, 'profile follows the depth to the widest level');
  assert.equal(R.pieces, 1); assert.ok(R.seat && R.seat.free > 0, 'seatable');
  assert.ok(R.screwInfo.every(s => s.ok), 'no floating sleeve: ' + JSON.stringify(R.screwInfo.map(s => ({ ok: s.ok, noBody: s.noBody }))));
});

// bone bent about the v (y) axis: a 45 mm radius arc in the x-z plane, elliptical cross-section (8 x 7), top at x = 0
const ARC = (x, y, z) => { const r = Math.hypot(x, z + 45), th = Math.atan2(x, z + 45); if (Math.abs(th) > 1.25) return false; const d = 45 - 7 - r; return (y / 8) ** 2 + (d / 7) ** 2 < 1; };

test('angle bone: the local bone axes at the two cuts differ by > 20°, split = 2 builds two guides on their own frames, each seatable, every sleeve on bone', async () => {
  await volume(ARC, { x: 50, y: 24, z: 50 });
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.planes = [{ off: -25, yaw: 0, pitch: 0, w: 0.8 }, { off: 25, yaw: 0, pitch: 0, w: 0.8 }];
  const ang = St.cutsAngle(); console.log(`    angle between the cut frames ${ang.toFixed(0)}°`);
  assert.ok(ang > 20 && ang < 90, 'cuts straddle the bend: ' + ang);
  const fa = St.cutFrame(St.planesWorld()[0], V(-1, 0, 0), V(0, 0, 1)); assert.ok(fa && fa.u.x < -0.5 && fa.n.z > 0.5 && Math.abs(fa.n.x) > 0.2, 'frame A tilted with the bone: ' + JSON.stringify(fa && fa.n));
  const R = await plan([-25, 25], { split: 2 });
  assert.equal(R.pieces, 2, 'two guides'); assert.equal(R.parts.length, 2);
  R.parts.forEach((p, i) => { assert.ok(p.result.pieces === 1, `part ${i} one piece`); assert.ok(p.result.seat && p.result.seat.free > 0, `part ${i} seatable`); assert.ok(Math.abs(p.frame.n.x) > 0.2, `part ${i} frame follows the local bone (n = ${p.frame.n.x.toFixed(2)}, ${p.frame.n.z.toFixed(2)})`); });
  assert.ok(R.seat && R.seat.free > 0 && R.seat.parts.length === 2, 'merged seat = worse of the two');
  assert.ok(R.screwInfo.length >= 2 && R.screwInfo.every(s => s.ok), 'sleeves on bone: ' + JSON.stringify(R.screwInfo.map(s => ({ ok: s.ok, noBody: s.noBody }))));
  assert.ok(!checks().some(c => c[0] === 'crit'), 'no critical: ' + text());
  const mesh = St.parts.guide && St.parts.guide.obj; assert.ok(mesh && mesh.geometry.index.count > 2000, 'merged mesh present');
});

test('fitWrap ladder on the angle bone: the result is reported step by step and the final guide seats (one piece or two)', async () => {
  await volume(ARC, { x: 50, y: 24, z: 50 });
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.planes = [{ off: -25, yaw: 0, pitch: 0, w: 0.8 }, { off: 25, yaw: 0, pitch: 0, w: 0.8 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection();
  const f = await St.fitWrap();
  assert.ok(f && f.ok, 'a seatable layout found: ' + JSON.stringify(S.fitLog));
  assert.ok(S.fitLog.length >= 1 && S.fitLog.every(e => 'step' in e && 'wrap' in e && 'ok' in e), 'ladder log with values');
  assert.ok(S.fitLog[S.fitLog.length - 1].ok, 'last rung ok');
  await St.regenerate();
  const R = S.result, want = S.g.split ? 2 : 1;
  console.log(`    ladder ${S.fitLog.map(e => `${e.step}/s${e.split}/w${e.wrap}:${e.ok ? 'ok' : 'x'}`).join(' ')} -> split ${S.g.split} pieces ${R.pieces} free ${R.seat && R.seat.free}`);
  assert.equal(R.pieces, want); assert.ok(R.seat && R.seat.free > 0, 'seatable');
  if (S.fitLog.length > 1) assert.ok(/Otomatik uyum/.test(text()), 'the ladder is stated in the checks');
});

test('kerf side: stump gap 0 per end with the kerf on the resected side (default), w/2 when centred; the checks state the gap per end', async () => {
  await volume(ellipseBar(10, 6));
  assert.equal(S.g.kerfSide, 1, 'default: resected side');
  await plan([-12, 12]);
  const pw = St.planesWorld(); pw.forEach(p => near(St.stumpGap(p), 0, 1e-9)); near(pw[0].shift, 0.4, 1e-9); near(pw[1].shift, -0.4, 1e-9);
  assert.ok(/planlı aralık: kesi 1 ucunda 0,0 mm, kesi 2 ucunda 0,0 mm \(testere payı rezeke tarafta\)/.test(text()), text());
  S.g.kerfSide = 0; await St.rebuildResection(); await St.regenerate();
  St.planesWorld().forEach(p => { near(St.stumpGap(p), 0.4, 1e-9); near(p.shift, 0, 1e-9); });
  assert.ok(/kesi 1 ucunda 0,4 mm, kesi 2 ucunda 0,4 mm \(testere payı kesi düzlemine ortalı\)/.test(text()), text());
  S.planes.forEach(p => { p.w = 2.4; }); await St.regenerate();
  assert.ok(checks().some(c => c[0] === 'warn' && /aralık: kesi 1 ucunda 1,2 mm/.test(c[2])), 'gap above 1.0 mm is a warning: ' + text());
  S.g.kerfSide = 1; S.planes.forEach(p => { p.w = 0.8; });
});

// ---------- bone-aware screw placement (app.js placeScrews / bestScrew / evalScrew) ----------
const screwsOk = R => R.screwInfo.length && R.screwInfo.every(s => s.ok);
const slotGaps = R => R.screwInfo.filter(s => s.ok).map(s => +s.slotGap.toFixed(2));
const per = () => +W.document.getElementById('perSide').value || 1;   // screws per side in the harness page

test('screws on thin bone (8 mm high, 6 mm thick): every screw reaches bone with the drill at least 4 mm in bone, none dropped, no screw critical', async () => {
  await volume(ellipseBar(4, 3));
  const R = await plan([-12, 12]);
  console.log(`    screws ${S.screws.map(s => `u${s.u} v${s.v} t${s.tiltU}/${s.tiltV}`).join(' ')} inBone ${R.screwInfo.map(s => s.ok ? s.inBone.toFixed(1) : 'x').join(' ')} L ${S.g.L}`);
  assert.equal(S.screws.length, 2 * per()); assert.equal(S.screwDrops.length, 0);
  assert.ok(screwsOk(R), 'every sleeve on bone: ' + JSON.stringify(R.screwInfo.map(s => s.ok)));
  R.screwInfo.forEach(s => assert.ok(s.inBone >= 4, 'drill in bone ' + s.inBone));
  assert.ok(!checks().some(c => c[0] === 'crit' && /Vida/.test(c[2])), 'no screw critical: ' + text());
  assert.ok(S.screws.every(sc => Math.abs(sc.u) >= 12 + sc.D / 2 + 2 - 1e-9), 'sleeve at least 2 mm from the slot edge (slot on the resected side of the plane): ' + S.screws.map(s => s.u));
});

test('screws where the bone ends 8 mm past a cut: the screw past that cut sits on the short stump, 2 mm from the slot, and reaches bone', async () => {
  await volume((x, y, z) => x > -48 && x < 20 && ellipseBar(10, 6)(x, y, z));
  const R = await plan([-12, 12]);
  const right = S.screws.filter(sc => sc.u > 0);
  console.log(`    right screw ${right.map(s => `u${s.u} v${s.v} t${s.tiltU}/${s.tiltV}`).join(' ')} slot gaps ${slotGaps(R).join(' ')}`);
  assert.equal(right.length, per()); right.forEach(sc => assert.ok(sc.u > 12 && sc.u <= 20, 'on the 8 mm stump: ' + sc.u));
  assert.equal(S.screwDrops.length, 0); assert.ok(screwsOk(R), 'sleeves on bone');
  assert.ok(slotGaps(R).every(g => g >= 2 - 0.3), 'at least 2 mm between every sleeve and slot (±h): ' + slotGaps(R));
  assert.ok(!checks().some(c => c[0] === 'crit' && /Vida/.test(c[2])), 'no screw critical: ' + text());
});

test('no bone past one cut: that side gets no screw record, a critical check says why, the other side keeps its screw and the guide still holds the slots', async () => {
  await volume((x, y, z) => x > -48 && x < 13 && ellipseBar(10, 6)(x, y, z));
  const R = await plan([-12, 12]);
  assert.equal(S.screws.length, per(), 'left side only ' + JSON.stringify(S.screws.map(s => s.u)));
  assert.ok(S.screws.every(sc => sc.u < -12), 'the kept screws are past the left cut');
  assert.equal(S.screwDrops.length, per()); assert.ok(S.screwDrops.every(d => d.cut === 1));
  assert.ok(screwsOk(R), 'the placed screw reaches bone');
  assert.ok(checks().some(c => c[0] === 'crit' && /Kesi 2 ötesinde vida için uygun yer bulunamadı/.test(c[2])), 'dropped screw reported: ' + text());
  assert.ok(checks().some(c => c[0] === 'warn' && /Vidalar yalnız bir uçta/.test(c[2])), 'one-sided screws reported: ' + text());
  assert.ok(!checks().some(c => /kemiğe ulaşmıyor/.test(c[2])), 'no "does not reach bone" record is emitted: ' + text());
  assert.ok(S.g.L / 2 >= 12 + 0.6 + S.g.flange - 1e-9, 'the guide still covers both slots + flange: L ' + S.g.L);
  assert.equal(JSON.stringify(St.cutMisses()), '[]', 'both cuts pass through bone');
});

test('a cut past the end of the bone: "Kesi 2 kemiği kesmiyor" is critical, the other cut is fine; hand-moved screws survive a re-placement', async () => {
  await volume((x, y, z) => x > -48 && x < 20 && ellipseBar(10, 6)(x, y, z));
  await plan([-12, 30]);
  assert.equal(JSON.stringify(St.cutMisses()), '[1]');
  assert.ok(checks().some(c => c[0] === 'crit' && /Kesi 2 kemiği kesmiyor/.test(c[2])), 'cut 2 reported: ' + text());
  assert.ok(!checks().some(c => /Kesi 1 kemiği kesmiyor/.test(c[2])), 'cut 1 is through bone');
  // the surgeon drags a screw: it is marked and kept where it is by the next automatic placement
  const sc = S.screws.find(s => s.u < 0); sc.u = -30; sc.hand = 1;
  St.placeScrews();
  assert.ok(S.screws.some(s => s.hand && s.u === -30), 'hand-moved screw kept: ' + JSON.stringify(S.screws.map(s => [s.u, s.hand || 0])));
  assert.equal(S.screws.filter(s => s.u < -12).length, per(), 'the hand-moved screw counts for its side; no extra automatic screw there');
  S.screws = [];   // the hand-set screw must not leak into the next volume
});

test('long resection (76 mm between the cuts): the guide length follows the cuts and screws past 100 mm, every screw inside the body, split/length not capped', async () => {
  await volume(ellipseBar(10, 6, 70), { x: 75, y: 24, z: 42 });
  const R = await plan([-38, 38]);
  const half = S.g.L / 2;
  console.log(`    L ${S.g.L} screws ${S.screws.map(s => s.u).join(' ')}`);
  assert.ok(S.g.L > 100 && S.g.L <= 160, 'length beyond the old 100 mm cap: ' + S.g.L);
  assert.ok(S.screws.every(sc => Math.abs(sc.u) + sc.D / 2 <= half + 0.5), 'every screw inside the body');
  assert.ok(!checks().some(c => /guide gövdesinin dışında/.test(c[2])), 'no "outside the body" check: ' + text());
  assert.ok(screwsOk(R), 'sleeves on bone');
});

test('segmentChoice over defects of 20..90 mm on a 50 mm radius arc: every segment >= 20 mm, up to 4 segments, the fewest within 3 mm or else the smallest deviation', () => {
  const sc = W.Fibula.segmentChoice, Rr = 50, rows = [];
  for (let L = 20; L <= 90; L += 5) {
    const table = [];
    for (let n = 1; n <= W.Fibula.MAX_N; n++) { const l = L / n; table.push({ n, lens: Array(n).fill(l), dev: Rr * (1 - Math.cos(l / (2 * Rr))) }); }
    const r = sc(table, L), ok = table.filter(t => t.lens.every(x => x >= 20));
    assert.ok(r.lens.every(x => x >= 20 - 1e-9), `L ${L}: segment under 20 mm (n ${r.n})`);
    const within = ok.filter(t => t.dev <= 3);
    if (within.length) assert.equal(r.n, within[0].n, `L ${L}: fewest within 3 mm`);
    else assert.ok(r.dev <= Math.min(...ok.map(t => t.dev)) + 0.5, `L ${L}: smallest deviation (${r.dev.toFixed(2)} vs ${Math.min(...ok.map(t => t.dev)).toFixed(2)})`);
    rows.push(`${L}:${r.n}/${r.dev.toFixed(1)}`);
  }
  console.log('    L:n/dev ' + rows.join(' '));
  assert.equal(W.Fibula.MAX_N, 4);
  assert.equal(sc([{ n: 1, lens: [85], dev: 18 }, { n: 2, lens: [42, 43], dev: 4.6 }, { n: 3, lens: [28, 28, 29], dev: 2.1 }, { n: 4, lens: [21, 21, 21, 22], dev: 1.2 }], 85).n, 3, '85 mm: three segments reach 3 mm');
  assert.equal(sc([{ n: 1, lens: [60], dev: 12 }, { n: 2, lens: [30, 30], dev: 6 }, { n: 3, lens: [20, 20, 20], dev: 3.5 }], 60).n, 3, '60 mm on a tight curve: the smallest deviation, not the fewest');
});

test('segmentChoice: a defect shorter than one segment is one segment ("short"); otherwise the fewest segments within the deviation, never one under 20 mm when another count avoids it', () => {
  const sc = W.Fibula.segmentChoice, row = (n, lens, dev) => ({ n, lens, dev });
  let r = sc([row(1, [15], 0.5), row(2, [7.5, 7.5], 0.1)], 15); assert.equal(r.n, 1); assert.equal(r.reason, 'short');
  r = sc([row(1, [60], 5), row(2, [30, 30], 2), row(3, [20, 20, 20], 1)], 60); assert.equal(r.n, 2); assert.equal(r.reason, 'dev'); assert.deepEqual(r.rejected.map(x => x.n), [1]);
  r = sc([row(1, [50], 6), row(2, [25, 25], 4), row(3, [16, 17, 17], 1)], 50); assert.equal(r.n, 2); assert.equal(r.reason, 'len'); assert.deepEqual(r.rejected.map(x => x.n), [3]);
  r = sc([row(1, [25], 2.9), row(2, [12, 13], 0.1)], 25); assert.equal(r.n, 1); assert.equal(r.reason, 'dev');
  r = sc([row(1, [30], 9), row(2, [15, 15], 1)], 30); assert.equal(r.n, 1); assert.equal(r.reason, 'len');
  r = sc([row(1, [19], 9), row(2, [9.5, 9.5], 1)], 19); assert.equal(r.n, 1); assert.equal(r.reason, 'short');
  assert.equal(W.Fibula.MIN_LEN, 20); assert.equal(W.Fibula.DEV_WARN, 3);
});

test('segmentChoice: stump segments >= 25 mm preferred, never at the cost of a far worse deviation; deviations within 0.5 mm count as equal and the fewer segments win', () => {
  const sc = W.Fibula.segmentChoice, row = (n, lens, dev) => ({ n, lens, dev });
  assert.equal(W.Fibula.SEG_ERR, 15); assert.equal(W.Fibula.STUMP_MIN, 25); assert.equal(W.Fibula.DEV_TIE, 0.5);
  assert.ok(W.Fibula.lensOk([25, 20, 25]) && !W.Fibula.lensOk([24, 30, 25]) && W.Fibula.lensOk([22]) && !W.Fibula.lensOk([30, 19, 30]));
  // within the target: the fewest with stumps >= 25 first, else the fewest with every segment >= 20 (stump then only a warning)
  let r = sc([row(1, [70], 6), row(2, [22, 48], 2), row(3, [26, 20, 26], 1)], 70); assert.equal(r.n, 3, 'stump-acceptable count within the target wins'); assert.equal(r.reason, 'dev'); assert.equal(r.stumpOk, true);
  r = sc([row(1, [50], 6), row(2, [22, 28], 2)], 50); assert.equal(r.n, 2); assert.equal(r.reason, 'dev'); assert.equal(r.stumpOk, false);
  // the real-CT case (symphysis L 45): one segment 26 mm off, three segments with a 24.7 mm stump segment 7.8 mm off -> three
  r = sc([row(1, [141.5], 26.3), row(2, [13.3, 128], 27.7), row(3, [24.7, 60, 55], 7.8), row(4, [17.9, 40, 40, 40], 4.9)], 141.5);
  assert.equal(r.n, 3, 'a stump under 25 mm is not traded for a 26 mm deviation'); assert.equal(r.reason, 'len'); assert.deepEqual(r.rejected.map(x => x.n), [2, 4]);
  // a stump-acceptable count within DEV_TIE of the best deviation is preferred
  r = sc([row(1, [80], 9), row(2, [22, 58], 4.0), row(3, [26, 28, 26], 4.3)], 80); assert.equal(r.n, 3, 'within 0.5 mm: the stump-acceptable count'); assert.equal(r.stumpOk, true);
  r = sc([row(1, [80], 9), row(2, [22, 58], 4.0), row(3, [26, 28, 26], 4.6)], 80); assert.equal(r.n, 2, 'more than 0.5 mm worse: the better deviation, stump warned'); assert.equal(r.stumpOk, false);
  // equal deviations (within 0.5 mm): fewer segments
  r = sc([row(1, [60], 5), row(2, [30, 30], 4.7), row(3, [20, 20, 20], 4.6)], 60); assert.equal(r.n, 1);
});

await run('adaptive guide sizing, fit ladder, kerf side, segment choice');
