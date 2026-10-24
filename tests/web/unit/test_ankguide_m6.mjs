// Malleolar fracture, plan M6: the cutting guide's automatic placement, bone axis, material and sleeve presets,
// seating, slot play and the wedge angle measured back from its mesh (web/ankguide.js) on the synthetic ankle:
// - the tibia's principal axis is the leg (z) within 3°; a tilted bone tilts the frame with it;
// - the automatic placement lands on the anterior distal tibia 25-40 mm over the dome; the guide built there has no
//   critical check, its inner face lies at the planned clearance (p50 < 0.3 mm);
// - the wedge angle measured on its mesh is the planned angle ± 0.2°;
// - a material preset sets the slot to blade + tolerance and the wall to its minimum; a metal sleeve widens the wire
//   holes to the sleeve; no material chosen is an information check; a slot 0.6 mm wider than the blade is critical.
// Run: node test_ankguide_m6.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { saveAcc } from './lib/acc.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankguide.js');
const A = W.Ankle, G = W.AnkGuide;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
const tib = A.pieces().find(p => p.name === 'Tibia');
const deg = (a, b) => Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
const acc = {};

test('bone axis: the tibia\'s principal axis is the leg (z) within 3°', () => {
  const ax = G.boneAxis(tib); const a = deg(ax, new T.Vector3(0, 0, 1)); acc.axis_deg = a;
  assert.ok(a < 3, `axis ${ax.toArray()} ${a}°`); assert.ok(ax.z > 0, 'points up');
});
test('automatic placement: anterior distal tibia 25-40 mm over the dome; built without a critical check', async () => {
  const r = G.suggest(); assert.ok(!r.why, r.why); assert.ok(r.height >= 25 && r.height <= 40, JSON.stringify(r));
  const f = G.frame(); assert.equal(f.p.name, 'Tibia'); assert.ok(f.n.y < -0.5, `faces anterior ${f.n.toArray()}`);
  await G.make(); const info = G.info(); assert.ok(info && G.ready());
  const crit = G.checks().filter(c => c[0] === 'crit'); assert.equal(crit.length, 0, JSON.stringify(crit));
  assert.ok(info.joint && info.joint.slot >= 5, `joint ${info.joint && info.joint.slot}`);
  console.log(`  (suggested ${r.height} mm over the dome, turned ${r.angle}°, cover ${(r.cover * 100).toFixed(0)} %; seat p50 ${info.fit.p50.toFixed(2)} p95 ${info.fit.p95.toFixed(2)} p99 ${info.fit.p99.toFixed(2)} mm, n ${info.fit.n}; play ${info.play.toFixed(2)}°)`);
  assert.ok(info.fit.p50 < 0.3, `seat p50 ${info.fit.p50}`); acc.seat = info.fit;
  assert.ok(info.play <= 3, `play ${info.play}`);
});
test('wedge: the angle measured on the mesh is the planned angle ± 0.2°', async () => {
  const w = G.info().wedge; assert.ok(w && w.measured != null, JSON.stringify(w));
  near(w.measured, 8, 0.2, 'measured'); acc.wedge8 = w.measured;
  G.set('deg', 14); await G.make(); near(G.info().wedge.measured, 14, 0.2, 'measured 14°'); acc.wedge14 = G.info().wedge.measured;
  console.log(`  (wedge measured ${acc.wedge8.toFixed(2)}° / ${acc.wedge14.toFixed(2)}°)`);
});
test('material: no choice is an information check; a preset sets slot, wall and clearance; a metal sleeve widens the holes', async () => {
  assert.ok(G.checks().some(c => c[0] === 'info' && /malzemesi seçilmedi/.test(c[2])));
  const holes0 = G.pins(G.frame()).map(s => s.sc.d);
  G.setMat('pa12'); const q = G.state().prm; near(q.kerf, q.blade + 0.3, 1e-9); assert.ok(q.wall >= 2.5);
  assert.ok(!G.checks().some(c => /malzemesi seçilmedi/.test(c[2])));
  // SLS PA12's wider slot (blade + 0.3) is held by a longer slot lip: still no critical check, the blade tilts < 3°
  await G.make(); assert.ok(G.info().play <= 3, `play ${G.info().play}`); assert.equal(G.checks().filter(c => c[0] === 'crit').length, 0, JSON.stringify(G.checks()));
  W.PlanExt.ankGuide.set(Object.assign(W.PlanExt.ankGuide.get(), { prm: Object.assign({}, q, { sleeve: 'metal' }) }));
  const holes1 = G.pins(G.frame()).map(s => s.sc.d); near(holes1[0] - holes0[0], 2 * 0.5 + (0.2 - 0.1), 1e-9, 'metal sleeve hole');
  assert.equal(G.state().prm.mat, 'pa12'); assert.equal(G.state().prm.sleeve, 'metal');
});
test('slot play: a slot 0.6 mm wider than the blade lets it tilt over 3°: critical', async () => {
  G.set('kerf', G.state().prm.blade + 0.6); await G.make();
  assert.ok(G.info().play > 3, `play ${G.info().play}`);
  assert.ok(G.checks().some(c => c[0] === 'crit' && /eğilebilir/.test(c[2])), JSON.stringify(G.checks()));
  G.set('kerf', 0.4); assert.ok(G.checks().some(c => c[0] === 'crit' || c[0] === 'warn'));
});

await run('ankle M6 (guide placement, axis, material, seat, wedge angle)');
saveAcc('ankguide', acc);
