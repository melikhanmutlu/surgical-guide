// Malleolar fracture, plan M4 + M5: the screw plan (web/ankscrew.js) on the synthetic trimalleolar ankle reduced to
// the phantom's known displacement (web/sample_ankle.json):
// - templates: the medial malleolus screws start on the fragment and cross into the tibia, the posterior screws reach
//   the posterior fragment, the syndesmosis screw goes fibula -> tibia; none of them is critical;
// - the suggested length is the far cortex - 2 mm, checked against an independent march over the label voxels (± 1 mm);
// - checks: a screw 6 mm too long leaves the far cortex (critical), a screw turned into the joint reaches the talus
//   (critical), two screws in one place collide (critical), a screw inside one piece does not cross the fracture;
// - a screw moves with its piece; saved with the plan and restored.
// Run: node test_ankscrew.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankscrew.js');
const A = W.Ankle, SC = W.AnkScrew, G = P.eval('G');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
ANKLE.truth.forEach(tr => {
  const i = byName(tr.name);
  const R = new T.Quaternion().setFromAxisAngle(new T.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180);
  A.setMotion(i, new T.Vector3(...tr.move).negate(), R.invert(), true);
});

// independent of the distance fields: is a world point inside a bone piece's label voxels (nearest voxel)?
const L = A.labels(), r = S.red;
function labelAt(w) {
  for (const p of A.pieces()) {
    if (p.role === 'talus' || p.role === 'out') continue;
    const ijk = G.indexOf(r, A.toOwn(p, w).toArray()).map(Math.round);
    if (ijk.some((v, k) => v < 0 || v >= [r.nx, r.ny, r.nz][k])) continue;
    if (L[ijk[0] + r.nx * (ijk[1] + r.ny * ijk[2])] === p.label) return p;
  }
  return null;
}
function labelExit(s, gap = s.kind === 'synd' ? 15 : 3) {
  const w = SC.world(s); let inRun = false, last = null, gapFrom = null;
  for (let t = 0; t <= 120; t += 0.1) {
    const x = w.E.clone().addScaledVector(w.d, t), b = labelAt(x);
    if (b) { inRun = true; last = t; gapFrom = null; } else if (inRun) { if (gapFrom == null) gapFrom = t; if (t - gapFrom >= gap) break; }
  }
  return last;
}
const crit = s => SC.issues().filter(i => i.id === s.id && i.lvl === 'crit');
const acc = {};

test('medial malleolus template: 2 screws from the fragment into the tibia, length from the far cortex, not critical', () => {
  const r0 = SC.template('mm'); assert.ok(r0.screws, r0.why); assert.equal(r0.screws.length, 2);
  SC.analyse().forEach(a => {
    assert.equal(a.s.piece, 'Medial malleol'); assert.equal(a.pieces.slice(0, 2).join(','), 'Medial malleol,Tibia');
    const ex = labelExit(a.s); near(a.m.exit, ex, 1, 'far cortex vs label march'); acc[`mm_exit_diff_${a.s.id}`] = a.m.exit - ex;
    assert.ok(a.s.L <= 45 && a.s.L >= 10 && (a.s.L % 2 === 0 || a.s.L === 45), `L ${a.s.L}`);
    assert.ok(a.s.L <= a.m.exit - 2 + 1e-9 || a.s.L === 45, `L ${a.s.L} exit ${a.m.exit}`);
    assert.equal(crit(a.s).length, 0, JSON.stringify(SC.issues()));
  });
  const [a, b] = SC.analyse(); assert.ok(a.clear.c > 4, `clearance ${a.clear.c}`);
  console.log(`  (mm screws: L ${SC.screws().map(s => s.L).join(' / ')} mm, far cortex ${SC.analyse().map(a => a.m.exit.toFixed(1)).join(' / ')} mm, label march ${SC.screws().map(s => labelExit(s).toFixed(1)).join(' / ')})`);
  void b;
});
test('posterior template: through the posterior fragment, not critical; syndesmosis: fibula -> tibia', () => {
  const r1 = SC.template('post'); assert.ok(r1.screws, r1.why); assert.equal(r1.screws.length, 2);
  r1.screws.forEach(s => { const a = SC.analyse().find(z => z.s.id === s.id); assert.ok(a.pieces.includes('Posterior malleol') && a.pieces.includes('Tibia'), a.pieces.join(',')); assert.equal(crit(s).length, 0, JSON.stringify(SC.issues())); near(a.m.exit, labelExit(s), 1); });
  const r2 = SC.template('synd'); assert.ok(r2.screws, r2.why);
  const a = SC.analyse().find(z => z.s.id === r2.screws[0].id); assert.equal(a.pieces[0], 'Fibula'); assert.ok(a.pieces.includes('Tibia'), a.pieces.join(','));
  assert.equal(crit(r2.screws[0]).length, 0, JSON.stringify(SC.issues())); near(a.m.exit, labelExit(a.s), 1);
  assert.equal(SC.done(), true);
});
test('checks: too long -> far cortex critical; turned into the talus -> critical; two in one place -> collision', () => {
  const s = SC.screws()[0], a0 = SC.analyse()[0];
  SC.set(s.id, 'L', Math.ceil(a0.m.exit) + 6); assert.ok(crit(s).some(i => /karşı korteksten/.test(i.msg)), JSON.stringify(SC.issues()));
  SC.set(s.id, 'auto'); assert.equal(crit(s).length, 0, JSON.stringify(crit(s)));
  // a screw from the medial malleolus straight down into the joint
  const pz = W.AnkLM.result().red.pz, tal = A.pieces()[byName('Talus')];
  const tw = A.toWorld(tal, tal.c.clone()), x = SC.add('click', new T.Vector3(tw.x, tw.y, pz + 25), new T.Vector3(0, 0, -1), 3.5, { L: 40 });
  assert.ok(x); assert.ok(crit(x).some(i => /talusa/.test(i.msg)), JSON.stringify(SC.issues().filter(i => i.id === x.id)));
  SC.remove(x.id);
  // a copy of screw 1 collides with it
  const w = SC.world(s), y = SC.add('mm', w.E.clone().addScaledVector(w.d, -5), w.d, 4.0);
  assert.ok(crit(s).some(i => /çakışıyor/.test(i.msg)) || crit(y).some(i => /çakışıyor/.test(i.msg)), JSON.stringify(SC.issues()));
  near(SC.segDist(new T.Vector3(0, 0, 0), new T.Vector3(10, 0, 0), new T.Vector3(5, 3, -1), new T.Vector3(5, 3, 1)), 3, 1e-9);
  SC.remove(y.id);
  assert.equal(SC.done(), true);
});
test('a screw inside one piece: does not cross the fracture (warning); moves with its piece', () => {
  const tib = A.pieces()[byName('Tibia')], pz = W.AnkLM.result().red.pz, c = A.toWorld(tib, tib.c.clone());
  const s = SC.add('click', new T.Vector3(c.x, c.y - 60, pz + 50), new T.Vector3(0, 1, 0), 3.5);
  assert.ok(s); assert.ok(SC.issues().some(i => i.id === s.id && /kırık hattını geçmiyor/.test(i.msg)), JSON.stringify(SC.issues()));
  const e0 = SC.world(s).E.clone(), i = byName('Tibia'), p = A.pieces()[i];
  A.setMotion(i, p.t.clone().add(new T.Vector3(0, 0, 3)), p.q.clone(), true);
  near(SC.world(s).E.z - e0.z, 3, 1e-6);
  A.setMotion(i, p.t.clone().add(new T.Vector3(0, 0, -3)), p.q.clone(), true);
  SC.remove(s.id);
});
test('saved with the plan and restored; templates give a reason when the anatomy is missing', () => {
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankScrews.get())); assert.equal(x.length, 5);
  W.PlanExt.ankScrews.set(null); assert.equal(SC.screws().length, 0); assert.equal(SC.done(), false);
  W.PlanExt.ankScrews.set(x); assert.equal(SC.screws().length, 5);
  x.forEach((s, k) => { const t = SC.screws()[k]; assert.equal(JSON.stringify([t.kind, t.piece, t.D, t.L]), JSON.stringify([s.kind, s.piece, s.D, s.L])); });
  W.PlanExt.ankScrews.set([{ kind: 'bad' }, { kind: 'mm', piece: 'X', c: [0, 0], E: [0, 0, 0], d: [0, 0, 1] }]); assert.equal(SC.screws().length, 0);
  W.PlanExt.ankScrews.set(x);
  fs.mkdirSync(path.join(REPO, 'tests', 'realct'), { recursive: true });
  W.__screwAcc = acc;
});

await run('ankle M4/M5 (screw plan and checks)');
