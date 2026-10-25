// Corrected shape of the opening wedge osteotomy (web/ankcorr.js) on the synthetic ankle: the proximal tibia stays, the
// distal tibia and the talus turn about the hinge (the section's far cortex) by the wedge angle; the cut opens on the
// guide side by depth x tan(angle); an anterior guide gives a sagittal turn; the wedge is carried into the gap; the
// preview follows the angle; angle 0 leaves the bone as it is; the package gets the corrected tibia.
// Run: node test_ankcorr.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('ankguide.js'); P.load('ankcorr.js');
const A = W.Ankle, G = W.AnkGuide, C = W.AnkCorr;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0);
const tib = A.pieces().find(p => p.name === 'Tibia'), tal = A.pieces().find(p => p.role === 'talus');
const zA = tib.c.z + 5, start = new T.Vector3(tib.c.x, tib.c.y, zA);
let Pt = null; for (let t = 0; t < 40; t += 0.1) { const q = start.clone().add(new T.Vector3(0, -t, 0)); if (A.sdfAt(tib, q) > 0) { Pt = q; break; } }
G.place(tib, Pt, new T.Vector3(0, -1, 0));
G.set('deg', 8);

// the corrected surface's vertices (tibia's own coordinates) and the planes
// the cap where the bone leaves the CT volume (top of the sample) is not a CT surface: left out
const gb = (tib.mesh.geometry.computeBoundingBox(), tib.mesh.geometry.boundingBox), cap = x => x.z > gb.max.z - 1.5;
const verts = m => { const p = m.geometry.attributes.position.array, o = []; for (let i = 0; i < p.length; i += 3) o.push(new T.Vector3(p[i], p[i + 1], p[i + 2])); return o; };

test('without a placed guide there is nothing to correct', () => {
  assert.equal(C.live(), false); assert.equal(C.files().length, 0);
});
test('hinge on the far cortex (posterior), turn about it opens the cut anteriorly by depth x tan(angle)', async () => {
  const r = await C.build(); assert.ok(r && C.live(), 'built');
  const o = r.o;
  // a points to the guide (anterior, -y); the hinge sits on the posterior side of the section
  assert.ok(o.a.y < -0.8, `a ${o.a.toArray()}`); assert.ok(o.hinge.y > o.pl.p.y + 5, `hinge ${o.hinge.toArray()} vs ${o.pl.p.toArray()}`);
  near(r.info.open, r.info.depth * Math.tan(8 * Math.PI / 180), 1e-6);
  // a point of the distal cut face at the guide-side edge drops by open below the plane
  const edge = o.hinge.clone().addScaledVector(o.a, o.depth), moved = edge.clone().applyMatrix4(o.M);
  near(moved.clone().sub(o.pl.p).dot(o.N), -o.depth * Math.sin(o.th), 1e-6);
  // the hinge itself does not move
  assert.ok(o.hinge.clone().applyMatrix4(o.M).distanceTo(o.hinge) < 1e-9);
});
test('anterior opening = sagittal turn of 8°, no coronal or axial component', () => {
  const m = C.info(); assert.equal(m.side, 'ant');
  near(Math.abs(m.sagittal), 8, 0.5); assert.ok(Math.abs(m.coronal) < 0.8, `coronal ${m.coronal}`); assert.ok(Math.abs(m.axial) < 0.8, `axial ${m.axial}`);
});
test('corrected tibia: proximal surface unchanged, distal surface = the CT distal surface turned about the hinge', () => {
  const r = C.result(), o = r.o, vs = verts(r.mesh); assert.ok(vs.length > 1000, `${vs.length} vertices`);
  let prox = 0, dist = 0, badP = 0, badD = 0;
  vs.forEach(x => {
    const z = x.clone().sub(o.pl.p).dot(o.N);
    // (the cap where the bone leaves the CT volume, outside the piece's distance box, is not a CT surface)
    const s = A.sdfAt(tib, x); if (z > 3 && s !== Infinity && !cap(x)) { prox++; if (Math.abs(s) > 0.6) badP++; }
    const y = x.clone().applyMatrix4(o.Mi), zd = y.clone().sub(o.pl.p).dot(o.N), sd = A.sdfAt(tib, y);
    if (zd < -3 && z < -3 && sd !== Infinity) { dist++; if (Math.abs(sd) > 0.6) badD++; }
  });
  assert.ok(prox > 300 && dist > 300, `prox ${prox} dist ${dist}`);
  assert.ok(badP / prox < 0.02, `proximal off the CT surface: ${badP}/${prox}`);
  assert.ok(badD / dist < 0.02, `distal off the turned CT surface: ${badD}/${dist}`);
  // the lowest tibia point (plafond side) moved: it is not on the CT surface any more
  const low = vs.reduce((b, x) => (x.z < b.z ? x : b));
  assert.ok(Math.abs(A.sdfAt(tib, low)) > 0.6 || low.distanceTo(low.clone().applyMatrix4(o.Mi)) > 1, 'distal end moved');
});
test('talus is carried with the distal tibia; the wedge fills the gap (its faces on the two cut faces)', () => {
  const r = C.result(), o = r.o; assert.ok(r.talus && r.wedge);
  const t0 = new T.Vector3().fromArray(tal.mesh.geometry.attributes.position.array, 0), t1 = new T.Vector3().fromArray(r.talus.geometry.attributes.position.array, 0);
  assert.ok(t1.distanceTo(t0.clone().applyMatrix4(o.M)) < 1e-3, 'talus vertex turned with the distal part');
  // every wedge vertex lies between the proximal cut face (z <= 0) and the turned distal face (zd >= 0)
  let bad = 0; verts(r.wedge).forEach(x => { const z = x.clone().sub(o.pl.p).dot(o.N), zd = x.clone().applyMatrix4(o.Mi).sub(o.pl.p).dot(o.N); if (z > 0.05 || zd < -0.05) bad++; });
  assert.equal(bad, 0, `${bad} wedge vertices outside the gap`);
});
test('field with the gap filled: a point in the opened gap is bone, the same point without fill is not', () => {
  const o = C.result().o, x = o.hinge.clone().addScaledVector(o.a, o.depth * 0.6).addScaledVector(o.N, -o.depth * 0.6 * Math.tan(o.th) / 2);
  assert.ok(C.field(o, true)(x) < 0, 'filled'); assert.ok(C.field(o, false)(x) > 0, 'open');
});
test('preview shown: originals hidden, corrected parts in the scene; turned off: originals back', async () => {
  await C.toggle(true); assert.ok(St.parts.ankCorr && St.parts.ankCorr.visible);
  const id = 'ank' + A.pieces().indexOf(tib); assert.equal(St.parts[id].visible, false);
  await C.toggle(false); assert.equal(St.parts.ankCorr, undefined); assert.equal(St.parts[id].visible, true);
});
test('the angle changes: the preview is stale; a rebuild follows the new angle; 0° leaves the bone as in the CT', async () => {
  G.set('deg', 12); assert.equal(C.live(), false);
  let r = await C.build(); near(r.info.deg, 12, 1e-9); near(Math.abs(r.info.sagittal), 12, 0.7);
  G.set('deg', 0); r = await C.build(); assert.equal(r.wedge, null); near(r.info.open, 0, 1e-9);
  let bad = 0, n = 0; verts(r.mesh).forEach((x, i) => { const s = A.sdfAt(tib, x); if (i % 7 || s === Infinity || cap(x)) return; n++; if (Math.abs(s) > 0.6) bad++; });
  assert.ok(bad / n < 0.02, `${bad}/${n} off the CT surface at 0°`);
  G.set('deg', 8);
});
test('package: the corrected tibia and talus in the plan frame; an opening over 10 mm warns (sample threshold)', async () => {
  await C.build(); const names = C.files().map(f => f.name);
  assert.deepEqual([...names], ['duzeltme/duzeltilmis_tibia.stl', 'duzeltme/talus_duzeltilmis.stl']);
  assert.ok(new DataView(C.files()[0].data.buffer).getUint32(80, true) > 1000);
  assert.equal(C.checks().length, 0, 'open < 10 mm');
  // the synthetic tibia is thin (8° opens it ~3 mm): the threshold is lowered under the opening for the check
  const lim = C.LIM.open; C.LIM.open = C.info().open - 0.5;
  try { assert.ok(C.checks().some(c => c[0] === 'warn' && /menteşe/.test(c[2])), JSON.stringify(C.checks())); } finally { C.LIM.open = lim; }
});

await run('ankle corrected shape');
