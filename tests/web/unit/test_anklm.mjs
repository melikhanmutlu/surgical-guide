// Malleolar fracture, plan M2: joint landmarks and reduction measurements (web/anklm.js) on the synthetic trimalleolar
// ankle (web/sample_ankle.json, surgiguide/phantom.py ankle_phantom, fracture bands 1 mm):
// - reduced to the phantom's known displacement: the articular steps are ~0 and the gaps ~ the 1 mm band;
// - a fragment moved 2 mm proximally after the reduction: step +2 ± 0.3 mm (acceptance M2.2); 1.5 mm distally: -1.5;
// - the talus moved 2 mm laterally: the medial clear space +2 ± 0.3 mm, the talar shift (MCS - SCS) too;
// - the fibula moved 2 mm laterally: the tibiofibular clear space +2 ± 0.3 mm;
// - landmarks: malleolar tips are the lowest points; a landmark set by hand moves with its piece and is saved;
// - warnings only on the planned position, with sample thresholds.
// Run: node test_anklm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { saveAcc } from './lib/acc.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js');
const A = W.Ankle, LM = W.AnkLM;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);
function reduceAll() {
  ANKLE.truth.forEach(tr => {
    const i = byName(tr.name); assert.ok(i >= 0, tr.name);
    const R = new T.Quaternion().setFromAxisAngle(new T.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180);
    A.setMotion(i, new T.Vector3(...tr.move).negate(), R.invert(), true);
  });
}
const shift = (n, d) => { const i = byName(n), p = A.pieces()[i]; A.setMotion(i, p.t.clone().add(new T.Vector3(...d)), p.q.clone(), true); };
const red = () => LM.result().red;
const stepOf = n => red().m.steps.find(s => s.name === n);

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
const acc = {};

test('reduced: articular steps ~0, gaps ~ the 1 mm fracture band; the CT position shows the displacement', () => {
  const ct = LM.result().ct; assert.ok(ct.ok, ct.why);
  reduceAll();
  const m = red().m; assert.ok(m.nPlaf > 50, `plafond points ${m.nPlaf}`);
  // the posterior lip is on the plafond: step measured; the medial malleolus breaks at the corner of the mortise (its
  // facet against the plafond): no parallel surfaces, no step, only the gap
  const sp = stepOf('Posterior malleol'); assert.ok(sp && sp.step != null, JSON.stringify(sp));
  assert.ok(Math.abs(sp.step) < 0.3, `posterior step ${sp.step}`); acc.step0 = sp.step;
  ['Medial malleol', 'Posterior malleol'].forEach(n => { const s = stepOf(n); assert.ok(s.gap != null && s.gap < 1.6, `${n} gap ${s.gap}`); acc[`gap0_${n}`] = s.gap; });
  assert.equal(stepOf('Medial malleol').step, null);
  // the posterior fragment sat 2.2 mm proximal in the CT (phantom move z +2.2, turned 6°)
  const c = ct.m.steps.find(s => s.name === 'Posterior malleol'); assert.ok(c && c.step > 1, `CT posterior step ${c && c.step}`);
  console.log(`  (reduced: steps ${m.steps.map(s => `${s.name} ${s.step == null ? '-' : s.step.toFixed(2)}/${s.gap == null ? '-' : s.gap.toFixed(2)}`).join(', ')}; SCS ${m.scs.toFixed(2)} MCS ${m.mcs && m.mcs.toFixed(2)} TFCS ${m.tfcs && m.tfcs.toFixed(2)} post ${m.post && m.post.toFixed(0)} %)`);
});
test('step: the posterior fragment 2 mm proximal reads +2 ± 0.3 mm, 1.5 mm distal reads -1.5 ± 0.3 mm', () => {
  const s0 = stepOf('Posterior malleol').step;
  shift('Posterior malleol', [0, 0, 2]); const s1 = stepOf('Posterior malleol').step; near(s1 - s0, 2, 0.3, 'proximal'); near(s1, 2, 0.3);
  acc.step_2mm = s1;
  shift('Posterior malleol', [0, 0, 0.5]);
  assert.ok(LM.checks().some(c => /eklem basamağı/.test(c[2]) && /Posterior malleol/.test(c[2])), JSON.stringify(LM.checks()));
  shift('Posterior malleol', [0, 0, -4]); near(stepOf('Posterior malleol').step, -1.5, 0.3, 'distal');
  shift('Posterior malleol', [0, 0, 1.5]); near(stepOf('Posterior malleol').step, s0, 0.05);
  assert.ok(!LM.checks().some(c => /eklem basamağı/.test(c[2])));
});
test('talus 2 mm lateral: medial clear space and talar shift +2 ± 0.3 mm', () => {
  const m0 = red().m; assert.ok(m0.mcs != null && m0.nFacet > 10, `facet ${m0.nFacet}`);
  shift('Talus', [-2, 0, 0]);       // lateral is -x on this right ankle
  const m1 = red().m; near(m1.mcs - m0.mcs, 2, 0.3, 'MCS'); near(m1.shift - m0.shift, 2, 0.35, 'shift');
  acc.mcs_2mm = m1.mcs - m0.mcs;
  shift('Talus', [2, 0, 0]);
});
test('fibula 2 mm lateral: tibiofibular clear space +2 ± 0.3 mm', () => {
  const t0 = red().m.tfcs; assert.ok(t0 != null, 'measured');
  shift('Fibula', [-2, 0, 0]); shift('Lateral malleol', [-2, 0, 0]);
  near(red().m.tfcs - t0, 2, 0.3); acc.tfcs_2mm = red().m.tfcs - t0;
  shift('Fibula', [2, 0, 0]); shift('Lateral malleol', [2, 0, 0]);
});
test('landmarks: malleolar tips are the lowest points of their side; plafond centre over the talar dome', () => {
  const L = red().L; ['plafond', 'mmTip', 'lmTip', 'chaput', 'volkmann', 'incisura', 'dome'].forEach(k => assert.ok(L[k], k));
  assert.ok(L.mmTip.x > L.plafond.x + 5, 'medial tip medial (+x)'); assert.ok(L.lmTip.x < L.plafond.x - 5, 'lateral tip lateral (-x)');
  assert.ok(L.mmTip.z < L.plafond.z && L.lmTip.z < L.plafond.z, 'tips below the plafond');
  assert.ok(L.lmTip.z < L.mmTip.z, 'the lateral malleolus reaches lower');
  assert.ok(Math.hypot(L.plafond.x - L.dome.x, L.plafond.y - L.dome.y) < 12, 'plafond centre over the dome');
  assert.ok(L.chaput.y < L.volkmann.y, 'Chaput anterior, Volkmann posterior');
});
test('landmark by hand: moves with its piece, saved and restored with the plan', () => {
  const i = byName('Medial malleol'), p = A.pieces()[i], w = A.toWorld(p, p.c.clone().add(new T.Vector3(0, 0, -3)));
  assert.equal(LM.setLandmark('mmTip', p, w), true);
  near(red().L.mmTip.distanceTo(w), 0, 0.01); assert.equal(red().L.mmTip.hand, true);
  shift('Medial malleol', [0, 1, 0]); near(red().L.mmTip.y - w.y, 1, 0.01);
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankLM.get())); assert.ok(x.mmTip);
  W.PlanExt.ankLM.set(null); assert.ok(!red().L.mmTip.hand);
  W.PlanExt.ankLM.set(x); assert.equal(red().L.mmTip.hand, true);
  LM.setLandmark('mmTip', null); assert.equal(W.PlanExt.ankLM.get(), null);
  shift('Medial malleol', [0, -1, 0]);
});
test('no warnings before anything is moved (the CT position is the fracture, not a plan)', () => {
  A.reset(null); assert.deepEqual([...LM.checks()], []);
});
test('speed: both poses measured in under 1.5 s', () => {
  reduceAll(); const t0 = Date.now(); LM.compute(false); LM.compute(true); const ms = Date.now() - t0;
  console.log(`  (two poses ${ms} ms)`); assert.ok(ms < 1500, `${ms} ms`);
});

await run('ankle M2 (landmarks and joint measures)');
saveAcc('anklm', acc);
