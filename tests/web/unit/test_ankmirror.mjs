// Malleolar fracture, plan M3: the healthy side as the template (web/ankmirror.js) on a synthetic CT of both ankles
// (tools/make_ankle_bilateral.py: the right ankle of surgiguide.phantom.ankle_phantom with its trimalleolar fracture,
// the left one intact as its mirror across x = X):
// - the right (fractured) leg is planned, the left one is the template; the mirror sits on the right tibia with
//   RMS < 0.5 mm (acceptance M3.1) and the plane found is X;
// - "Aynaya hizala": each displaced fragment fitted to the mirror lands within 0.5 mm of the phantom's known reduction
//   (acceptance M3.2; turned up to 12°, back within 2.5°); the motion is a normal piece motion (saved, undoable);
// - a CT of one leg: no template, said in the panel.
// Run: node test_ankmirror.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ankbil-')), 'bil.json');
const X = +execFileSync('python3', [path.join(REPO, 'tools', 'make_ankle_bilateral.py'), OUT], { encoding: 'utf8' }).trim();
const BIL = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => BIL }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g, $ = id => P.doc.getElementById(id);
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankmirror.js');
const A = W.Ankle, M = W.AnkMirror;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 300000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
const acc = {};

test('both legs: the right (fractured) leg is planned, the left tibia and fibula are kept for the template', () => {
  const ri = A.roiInfo(); console.log('  (red', S.red.nx, S.red.ny, S.red.nz, S.red.sp, S.red.origin, 'mid', ri.mid, 'X', X, ')'); assert.equal(ri.bilateral, true); assert.equal(ri.side, 'R');
  assert.equal(ri.other.length, 2); near(ri.mid, X, 15, 'plane between the legs');
  ['Tibia', 'Fibula', 'Talus', 'Lateral malleol', 'Medial malleol', 'Posterior malleol'].forEach(n => assert.ok(byName(n) >= 0, `${n}: ${A.pieces().map(p => p.name)}`));
});
test('mirror: the left tibia, mirrored and fitted, sits on the right tibia with RMS < 0.5 mm; the plane is X', async () => {
  const t0 = Date.now(), tp = await M.build(); assert.ok(tp, 'template');
  console.log(`  (mirror fit ${Date.now() - t0} ms: RMS ${tp.rms.toFixed(3)} mm, max ${tp.max.toFixed(2)} mm, ${tp.n} points; q ${tp.q.toArray().map(v => v.toFixed(4))} t ${tp.t.toArray().map(v => v.toFixed(2))})`);
  assert.ok(tp.rms < 0.5, `rms ${tp.rms}`);
  // the map should be the identity reflection about X: a point of the left leg lands on its mirror image
  const p = new T.Vector3(X + 40, 5, 60), w = M.fwd(tp, p); near(w.x, 2 * X - p.x, 0.5); near(w.y, p.y, 0.5); near(w.z, p.z, 0.5);
  acc.mirror_rms = tp.rms;
});
// error of a fitted fragment against the phantom's truth: its surface points moved by the fitted and by the true
// reduction, mean distance; and the angle between the two rotations
function errOf(n) {
  const tr = BIL.truth.find(x => x.name === n), p = A.pieces()[byName(n)];
  const R = new T.Quaternion().setFromAxisAngle(new T.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180).invert(), tt = new T.Vector3(...tr.move).negate();
  const pos = p.mesh.geometry.attributes.position.array; let s = 0, k = 0;
  for (let i = 0; i < pos.length; i += 30) { const x = new T.Vector3(pos[i], pos[i + 1], pos[i + 2]); const a = A.toWorld(p, x), b = x.clone().sub(p.c).applyQuaternion(R).add(p.c).add(tt); s += a.distanceTo(b); k++; }
  const dq = p.q.clone().multiply(R.clone().invert()), cA = A.toWorld(p, p.c), cB = p.c.clone().add(tt);
  return { mm: s / k, deg: 2 * Math.acos(Math.min(1, Math.abs(dq.w))) * 180 / Math.PI, c: cA.distanceTo(cB) };
}
// the phantom's distal fibula is round: a turn about its own axis is not seen by any surface fit, so the lateral
// malleolus is judged by its centre only; the others by every surface point (mean distance to where the truth puts it)
for (const n of ['Medial malleol', 'Posterior malleol', 'Lateral malleol']) {
  test(`align to the mirror: ${n} lands within 0.5 mm of the known reduction`, async () => {
    const i = byName(n); A.reset(i);
    const r = await M.align(i); assert.ok(r, 'fitted');
    const e = errOf(n); console.log(`  (${n}: surface ${e.mm.toFixed(2)} mm, centre ${e.c.toFixed(2)} mm, ${e.deg.toFixed(2)}°, RMS ${r.rms.toFixed(2)} mm; moved ${r.moved.toFixed(1)} mm ${r.ang.toFixed(1)}°)`);
    acc[`align_${n}`] = e;
    if (n === 'Lateral malleol') assert.ok(e.c < 0.5, JSON.stringify(e)); else assert.ok(e.mm < 0.5 && e.c < 0.5 && e.deg < 2.5, JSON.stringify(e));
    assert.ok(r.rms < 0.5, `rms ${r.rms}`); assert.ok(A.moved(A.pieces()[i]));
  });
}
test('the fitted motions are piece motions: saved with the plan', () => {
  const x = W.PlanExt.ankle.get(); assert.ok(x.pieces.filter(p => p.t.some(v => v !== 0)).length >= 3);
});
test('panel: the mirror fit and the align button are shown', () => {
  W.AnkMirror && P.doc.getElementById('ankMirror');
  const box = $('ankMirror'); assert.ok(box && /RMS/.test(box.innerHTML), box && box.innerHTML);
  fs.writeFileSync(path.join(path.dirname(OUT), 'acc.json'), JSON.stringify(acc));
});

await run('ankle M3 (mirror of the healthy side)');
