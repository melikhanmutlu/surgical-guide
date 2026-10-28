// A guide built again from scratch when its cuts change (Melikhan 2026-10-28):
// - "Lezyondan kesi öner" gave its cuts a 1.2 mm slot (the blade can tilt 6.8°, critical) where the automatic plan uses the
//   blade + tolerance (0.8 mm);
// - a cut moved by hand after the guide was fitted kept the old fit's layout (two pieces, wrap depth) and screws, so
//   the cuts, screws and wires got mixed up; now the automatic values go back to their defaults, the screws are placed
//   again and the guide is fitted again, as the first automatic plan does. A restored plan is not re-fitted.
// Phantom: tests/phantoms/phantoms.mjs mandibleBar (straight bar along x). Run: node test_freshguide.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['lesion.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const v = mandibleBar({});
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-freshguide' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true); await St.settled();
// a lesion in the bar's middle, 16 mm long
const pts = []; for (let x = -8; x <= 8; x += 0.8) for (let z = -20; z <= -6; z += 0.8) for (let y = -3; y <= 3; y += 0.8) pts.push(V(x, y, z));

test('cuts proposed from a lesion get the automatic slot (blade + tolerance), not 1.2 mm', () => {
  assert.ok(St.anchorFromLesion(pts.map(p => p.clone())), 'anchored');
  St.planFromLesion(pts.map(p => p.clone()));
  assert.equal(S.planes.length, 2);
  S.planes.forEach(p => assert.ok(Math.abs(p.w - St.slotDefault()) < 1e-9, `slot ${p.w} vs ${St.slotDefault()}`));
  S.planes.forEach(p => assert.ok(St.slotPlay(p.w, S.g.blade, St.slotDepth(S.g)) <= St.SLOT_PLAY_MAX, `play ${St.slotPlay(p.w, S.g.blade, St.slotDepth(S.g))}`));
});
let g0;
test('the guide is fitted; a cut moved by hand afterwards rebuilds it from the automatic defaults', async () => {
  await St.makeGuide(); await St.settled();
  assert.ok(S.guideOn && S.result, 'guide built');
  g0 = { split: S.g.split, wrap: S.g.wrap, L: S.g.L, W: S.g.W };
  // what an old fit could have left in the automatic values: two pieces and a shallow wrap
  Object.assign(S.g, { split: 1, wrap: 2 });
  const before = S.planes.map(p => p.off);
  S.planes[0].off -= 4; St.schedule(true); await St.settled();
  assert.ok(S.planes[0].off === before[0] - 4, 'the cut stays where it was moved');
  assert.equal(S.g.split, g0.split, `layout from scratch: split ${S.g.split}`);
  assert.equal(S.g.wrap, g0.wrap, `wrap from scratch: ${S.g.wrap}`);
  // the screws stand outside the cuts, on both sides
  const pl = St.planesWorld().sort((a, b) => a.off - b.off), us = S.screws.map(s => s.u);
  assert.ok(us.length >= 2 && us.some(u => u < pl[0].off) && us.some(u => u > pl[pl.length - 1].off), `screws ${us} cuts ${pl.map(p => p.off)}`);
});
test('a value set by hand is kept through the rebuild', async () => {
  S.gAuto.W = 0; S.g.W = 18;
  S.planes[1].off += 2; St.schedule(true); await St.settled();
  assert.equal(S.g.W, 18); S.gAuto.W = 1;
});
test('a restored plan is not fitted again: its stored guide values stay', async () => {
  const plan = JSON.parse(JSON.stringify(St.planOf()));
  plan.guide = Object.assign({}, plan.guide, { wrap: 4.5 });
  await St.applyPlan(plan); await St.settled();
  const w = S.g.wrap; St.schedule(true); await St.settled();
  assert.equal(S.g.wrap, w, `restored wrap ${w} kept, now ${S.g.wrap}`);
});
// Melikhan 2026-10-28: layers hidden in Katmanlar came back on Ctrl+Z / a history step (the restore removes and makes
// the guide and the resected piece again; a new part started visible, the resected piece was shown by its own rule)
test('hidden layers stay hidden through an undo that rebuilds them', async () => {
  const withGuide = JSON.parse(JSON.stringify(St.planOf()));
  St.setVisible('guide', false); St.setVisible('resected', false);
  // the guide part removed and made again by the restore, as a step back and forward does
  St.setPart('guide', null, null); assert.ok(!St.parts.guide, 'guide part removed');
  await St.applyPlan(withGuide); await St.settled();
  assert.ok(St.parts.guide, 'guide made again'); assert.equal(St.parts.guide.visible, false, 'guide still hidden'); assert.equal(St.parts.guide.obj.visible, false);
  if (St.parts.resected) assert.equal(St.parts.resected.visible, false, 'resected piece still hidden');
  St.setVisible('guide', true); St.setPart('guide', null, null); await St.applyPlan(withGuide); await St.settled();
  assert.equal(St.parts.guide.visible, true, 'shown again once the user shows it');
});
await run('fresh guide after a cut change');
