// Inferior alveolar canal and tooth roots (plan 1.4). The bone model fills the canal (a closed soft-tissue tube inside
// the bone), so a guide screw across it was checked against the far cortex only and the canal was never mentioned.
// canal.js: the canal is traced between clicks along the dark tube, roots are marked with two clicks; a screw within
// 2 mm of the canal or through a root is critical, automatic screws stop 2 mm short. Phantom: tests/phantoms/phantoms.mjs
// mandibleBar({ canal, roots }). Run: node test_canal.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['canal.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const C = () => P.eval('Canal');

const v = mandibleBar({ canal: true, roots: [-30] });
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-canal' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true); await St.settled();
Object.assign(S.gAuto, { L: 0 }); S.g.L = 40; S.g.split = 0;
S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '1';
S.planes = [{ off: -8, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 8, yaw: 0, pitch: 0, w: 0.8, ok: false }];
S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
const rows = re => { St.renderChecks(); return (S.checkList || []).filter(c => re.test(c[2])); };
const lenBefore = S.screws.map(s => s.len);

test('no canal marked: no canal rows, nothing in the plan (a plan saved before keeps its approval signature)', () => {
  assert.equal(rows(/sinir kanalına|diş kökünü/).length, 0);
  assert.equal(St.planOf().ext.canal, undefined);
});

test('A5: no canal marked, screws in bone: the package is locked until the canal is checked; a moved screw asks again', async () => {
  const gate = () => rows(/sinir kanalı işaretlenmedi|kanal kontrolünden sonra değişti/);
  let r = gate(); assert.equal(r.length, 1, JSON.stringify(S.checkList.map(c => c[2])));
  assert.equal(r[0][0], 'crit'); assert.equal(JSON.stringify(r[0][4]), JSON.stringify([['canalMark', 'Kanalı işaretle'], ['canalOk', 'Kanal kontrol edildi']]));
  await St.runFix('canalOk'); assert.equal(gate().length, 0);
  const ext = St.planOf().ext.canal; assert.ok(ext && typeof ext.checked === 'string' && !ext.canals.length, 'the check is in the plan');
  // reopened: still checked
  P.eval('PlanExt').canal.set(null); assert.equal(gate().length, 1); P.eval('PlanExt').canal.set(ext); assert.equal(gate().length, 0);
  // a longer screw: asked again
  S.screws[0].len += 2; r = gate(); assert.equal(r.length, 1); assert.match(r[0][2], /kanal kontrolünden sonra değişti/);
  S.screws[0].len -= 2; assert.equal(gate().length, 0);
  // the mark-the-canal fix starts the canal tool
  await St.runFix('canalMark'); assert.equal(C().mode(), 'canal'); C().setMode('canal');
  P.eval('PlanExt').canal.set(null);
});

test('B1: the canal is suggested as the long thin dark tube inside the bone; it counts only once accepted', () => {
  const c = C(), t = c.tubes();
  assert.ok(t.length >= 1, 'a tube found'); assert.ok(t[0].len > 70 && t[0].area < 15, JSON.stringify(t[0]));
  const r = c.suggest(); assert.equal(r.suggestions, 1, 'one canal (the roots and the marrow are no tubes)');
  const sg = S.canalSuggest[0], mid = sg.pts.filter(p => Math.abs(p[0]) < 30);
  const off = Math.max(...mid.map(p => Math.hypot(p[1] - v.expect.canal.y, p[2] - v.expect.canal.z)));
  assert.ok(off < 1, `the suggestion leaves the canal by ${off.toFixed(2)} mm`);
  // not a canal yet: the gate still asks, no canal rows
  assert.equal(S.canals.length, 0); assert.equal(rows(/sinir kanalı işaretlenmedi/).length, 1);
  c.acceptSuggest(); assert.equal(S.canals.length, 1); assert.equal(S.canalSuggest.length, 0);
  assert.equal(rows(/sinir kanalı işaretlenmedi/).length, 0);
  S.canals = []; c.dropSuggest();
});

test('tracing: two clicks off the canal axis, the path between them runs in the canal (within 1 mm of its axis)', () => {
  const c = C(); c.setMode('canal');
  assert.ok(c.active());
  c.pick([-36, 1.5, -15]); c.pick([36, -1, -17]);
  c.setMode('canal');
  assert.equal(S.canals.length, 1);
  assert.equal(rows(/sinir kanalı işaretlenmedi/).length, 0, 'a marked canal opens the gate');
  const mid = S.canals[0].pts.filter(p => Math.abs(p[0]) < 25);
  assert.ok(mid.length > 30, `${mid.length} points`);
  const off = Math.max(...mid.map(p => Math.hypot(p[1] - v.expect.canal.y, p[2] - v.expect.canal.z)));
  assert.ok(off < 1, `the path leaves the canal by ${off.toFixed(2)} mm`);
});

test('a guide screw reaching 2 mm of the canal is critical; the fix ends it 2 mm short; automatic screws stop short', async () => {
  assert.ok(S.screws.length >= 2);
  // the screws as placed before the canal: within the bone, clear of the canal at their own length?
  const w = St.screwsWorld()[0], need = w.entry.z - (v.expect.canal.z + v.expect.canal.r + 2);
  S.screws[0].len = Math.ceil(w.entry.z - v.expect.canal.z); S.screws[0].hand = true;   // the tip at the canal's axis
  const r = rows(/Vida 1 alt alveoler sinir kanalına/);
  assert.equal(r.length, 1, JSON.stringify(S.checkList.map(c => c[2])));
  assert.equal(r[0][0], 'crit'); assert.equal(JSON.stringify(r[0][4]), JSON.stringify([['canalLen', 'Vidayı kanaldan önce bitir']]));
  await St.runFix('canalLen'); await St.settled();
  assert.ok(S.screws[0].len <= need && S.screws[0].len >= 6, `len ${S.screws[0].len}, need <= ${need.toFixed(1)}`);
  assert.equal(rows(/sinir kanalına/).length, 0);
  // automatic placement with the canal marked: every screw clear of it
  St.placeScrews(); await St.regenerate(); await St.settled();
  St.screwsWorld().forEach((s, i) => assert.ok(C().canalClear(s.entry, s.dir, s.sc.len, s.sc.d / 2) >= 2 - 1e-6, `screw ${i + 1}`));
  assert.equal(rows(/sinir kanalına/).length, 0);
  assert.ok(lenBefore.length);
});

test('a root under a screw: critical; deleting the root clears it', () => {
  const w = St.screwsWorld()[0], c = C();
  c.setMode('root'); c.pick([w.entry.x, 0, 0]); c.pick([w.entry.x, 0, -11]); c.setMode('root');
  assert.equal(S.roots.length, 1);
  const r = rows(/Vida 1 diş kökünü geçiyor \(kök 1\)/);
  assert.equal(r.length, 1); assert.equal(r[0][0], 'crit');
  S.roots.splice(0, 1); assert.equal(rows(/diş kökünü/).length, 0);
});

test('the plan keeps the canal and the roots; a reopened plan has them back, a damaged one drops them', async () => {
  const c = C(); c.setMode('root'); c.pick([20, 0, 0]); c.pick([20, 0, -10]); c.setMode('root');
  const ext = St.planOf().ext.canal;
  assert.equal(ext.canals.length, 1); assert.equal(ext.roots.length, 1);
  const E = P.eval('PlanExt').canal;
  E.set(null); assert.equal(S.canals.length + S.roots.length, 0); assert.equal(St.planOf().ext.canal, undefined);
  E.set(ext); assert.equal(S.canals.length, 1); assert.equal(S.roots.length, 1);
  E.set({ canals: [{ pts: [[1, 2]] }, { pts: 'x' }], roots: [{ a: [0, 0, 0], b: [0, 0, NaN] }] });
  assert.equal(S.canals.length + S.roots.length, 0);
});

test('segment distance: parallel, crossing, end to end', () => {
  const d = C().segSeg;
  assert.ok(Math.abs(d([0, 0, 0], [10, 0, 0], [0, 3, 0], [10, 3, 0]) - 3) < 1e-9);
  assert.ok(Math.abs(d([0, 0, 0], [10, 0, 0], [5, -5, 2], [5, 5, 2]) - 2) < 1e-9);
  assert.ok(Math.abs(d([0, 0, 0], [1, 0, 0], [4, 4, 0], [5, 4, 0]) - 5) < 1e-9);
});

test('a plate screw (native bone, not the graft) near the canal: critical; one in the defect is not checked', () => {
  const W = P.g, keep = W.Plate, c = C();
  c.setMode('canal'); c.pick([-36, 0, -16]); c.pick([36, 0, -16]); c.setMode('canal');
  try {
    const hole = (x, region) => ({ p: V(x, 0, -24), n: V(0, 0, -1), usable: true, len: 10, region });
    W.Plate = { get: () => ({ holes: [hole(-30, 'A'), hole(30, 'defect')] }), params: () => ({ on: true, d: 2 }), critical: () => [] };
    const r = rows(/Plak vidası \(delik \d\) alt alveoler sinir kanalına/);
    assert.equal(r.length, 1, JSON.stringify(r)); assert.ok(/delik 1\)/.test(r[0][2])); assert.equal(r[0][0], 'crit');
  } finally { W.Plate = keep; }
});

await run('canal');
