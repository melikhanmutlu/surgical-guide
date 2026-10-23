// Malleolar fracture, plan M1 (pieces and their correction) on the synthetic trimalleolar ankle (web/sample_ankle.json):
// - a piece cut in two by hand (two points across the fracture line): saved with the plan, laid again after a new
//   segmentation, undone when the plan opened has no split; the motion of the piece goes to both halves;
// - the bone brush / eraser (segedit.js, saved with the plan) changes the pieces: an erased fragment is gone, back
//   when the edit is removed;
// - a reopened plan gives a motion only to the piece that matches it (centre and volume), each piece once; a motion
//   that matches no piece is a warning, not dropped silently.
// Run: node test_ankle_m1.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('segedit.js'); P.load('masks.js'); P.load('audit.js'); P.load('ankle.js');
const A = W.Ankle, SE = W.SegEdit;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);
const settle = async () => { await sleep(30); await until(() => !A.building() && A.pieces().length > 0); };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await settle();
const n0 = A.pieces().length, tib0 = A.pieces()[byName('Tibia')].cm3;

// two points on the tibia's surface, 25 mm apart along the shaft (world = CT position, nothing moved yet)
function tibiaPts() {
  const p = A.pieces()[byName('Tibia')], pos = p.mesh.geometry.attributes.position.array;
  let lo = null, hi = null;
  for (let v = 0; v < pos.length; v += 3) { const z = pos[v + 2]; if (!lo || z < lo.z) lo = new T.Vector3(pos[v], pos[v + 1], z); if (!hi || z > hi.z) hi = new T.Vector3(pos[v], pos[v + 1], z); }
  return [lo, hi];
}
test('split by hand: two points on the tibia cut it in two; volume kept; the motion goes to both halves', async () => {
  const i = byName('Tibia'), p = A.pieces()[i];
  A.setMotion(i, new T.Vector3(1, 0, 0), new T.Quaternion(), true);
  const [a, b] = tibiaPts().map(x => A.toWorld(p, x));
  assert.equal(A.splitPiece(i, a, b), true);
  await settle();
  assert.equal(A.pieces().length, n0 + 1);
  const halves = A.pieces().filter(q => Math.abs(q.c.x - p.c.x) < 30 && q.cm3 > 1 && (q.name === 'Tibia' || q.role !== 'frag' || true)).filter(q => q.label === p.label || !A.pieces().some(o => o !== q && o.label === q.label) && q.t.x === 1);
  const moved = A.pieces().filter(q => Math.abs(q.t.x - 1) < 1e-9);
  assert.equal(moved.length, 2, 'both halves carry the motion');
  near(moved.reduce((s, q) => s + q.cm3, 0), tib0, 0.05 * tib0, 'tibia volume');
  assert.ok(halves.length >= 1);
  assert.equal(A.splits().length, 1);
});
test('split: saved with the plan; a new segmentation lays it again', async () => {
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankle.get())); assert.equal(x.splits.length, 1);
  assert.ok(x.pieces.every(e => e.cm3 > 0), 'volumes saved');
  await St.segment(false); await settle();
  assert.equal(A.pieces().length, n0 + 1, 'split laid again on the new labels');
  assert.equal(A.pieces().filter(q => Math.abs(q.t.x - 1) < 1e-9).length, 2, 'motions restored to both halves');
  // a plan without the split: segmented again, one tibia
  const y = JSON.parse(JSON.stringify(x)); y.splits = []; y.pieces = [];
  W.PlanExt.ankle.set(y); await sleep(50); await settle();
  assert.equal(A.pieces().length, n0); near(A.pieces()[byName('Tibia')].cm3, tib0, 1e-6);
  // and back
  W.PlanExt.ankle.set(x); await sleep(50); await settle();
  assert.equal(A.pieces().length, n0 + 1);
  W.PlanExt.ankle.set(y); await sleep(50); await settle(); assert.equal(A.pieces().length, n0);
});
test('brush / eraser: an erased fragment leaves the pieces; removing the edit brings it back; saved in the plan', async () => {
  const i = byName('Medial malleol'), lab = A.pieces()[i].label, N = S.labels.length;
  const del = new Uint8Array(N); for (let v = 0; v < N; v++) if (A.labels()[v] === lab) del[v] = 1;
  const rle = a => { const out = []; let cur = 0, run = 0; for (let k = 0; k < a.length; k++) { if (a[k] === cur) run++; else { out.push(run.toString(36)); cur ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); };
  W.PlanExt.seg.set({ dims: [S.red.nx, S.red.ny, S.red.nz], add: rle(new Uint8Array(N)), del: rle(del) });
  await St.rebuildBone(false); await settle();
  assert.equal(byName('Medial malleol'), -1, A.pieces().map(p => p.name).join(','));
  assert.equal(A.pieces().length, n0 - 1);
  assert.ok(W.PlanExt.seg.get(), 'the edit is in the plan');
  W.PlanExt.seg.set(null); await St.rebuildBone(false); await settle();
  assert.ok(byName('Medial malleol') >= 0); assert.equal(A.pieces().length, n0);
});
test('brush: voxels added against a fragment join it (a bigger piece, not a new one)', async () => {
  const i = byName('Lateral malleol'), p = A.pieces()[i], v0 = p.cm3, lab = p.label, r = S.red, L = A.labels(), N = L.length;
  const add = new Uint8Array(N);
  // one layer of voxels around the fragment (the empty neighbours of its voxels)
  for (let v = 0; v < N; v++) if (L[v] === lab) for (const u of [v - 1, v + 1, v - r.nx, v + r.nx]) if (u >= 0 && u < N && !L[u]) add[u] = 1;
  let nAdd = 0; for (let v = 0; v < N; v++) nAdd += add[v];
  const rle = a => { const out = []; let cur = 0, run = 0; for (let k = 0; k < a.length; k++) { if (a[k] === cur) run++; else { out.push(run.toString(36)); cur ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); };
  W.PlanExt.seg.set({ dims: [r.nx, r.ny, r.nz], add: rle(add), del: rle(new Uint8Array(N)) });
  await St.rebuildBone(false); await settle();
  assert.equal(A.pieces().length, n0, 'no new piece');
  const vox = r.sp[0] * r.sp[1] * r.sp[2] / 1000, q = A.pieces()[byName('Lateral malleol')];
  near(q.cm3, v0 + nAdd * vox, 0.02, 'fragment grew by the added voxels');
  W.PlanExt.seg.set(null); await St.rebuildBone(false); await settle();
  near(A.pieces()[byName('Lateral malleol')].cm3, v0, 1e-9);
});
test('reopened plan: a motion goes only to the matching piece (centre + volume), each piece once; the rest is a warning', () => {
  A.reset(null);
  const i = byName('Posterior malleol'), p = A.pieces()[i];
  A.setMotion(i, new T.Vector3(0, -2, 1), new T.Quaternion(), true);
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankle.get()));
  // the same motion saved twice for the same place: only one piece gets it
  const e = x.pieces.find(z => z.name === 'Posterior malleol');
  x.pieces.push(Object.assign({}, e, { name: 'Kopya' }));
  W.PlanExt.ankle.set(x);
  assert.equal(A.pieces().filter(q => q.t.length() > 0).length, 1);
  assert.ok(A.checks().some(c => c[0] === 'warn' && /eşleşmedi/.test(c[2]) && /Kopya/.test(c[2])), JSON.stringify(A.checks()));
  // a saved piece whose volume is far off (segmentation changed) is not matched
  const y = JSON.parse(JSON.stringify(W.PlanExt.ankle.get())); y.pieces = y.pieces.filter(z => z.name === 'Posterior malleol'); y.pieces[0].cm3 *= 2;
  W.PlanExt.ankle.set(y);
  assert.ok(A.pieces().every(q => q.t.length() === 0), 'not given to a piece of another size');
  assert.ok(A.checks().some(c => /eşleşmedi/.test(c[2])));
  // an edit clears the warning
  A.setMotion(i, new T.Vector3(0, -2, 1), new T.Quaternion(), true);
  assert.ok(!A.checks().some(c => /eşleşmedi/.test(c[2])));
  near(A.pieces()[i].t.y, -2, 1e-9); assert.equal(p.name, 'Posterior malleol');
});

test('layers: up to 8 bone layers (tibia, fibula, talus and the fragments), each its own colour', () => {
  const b = P.doc.getElementById('mkAdd'); for (let k = 0; k < 10; k++) if (!b.disabled) b.click();
  const L = W.Masks.layers(); assert.equal(L.length, 8); assert.equal(new Set(L.map(x => x.color)).size, 8); assert.equal(b.disabled, true);
});

await run('ankle M1 (pieces and their correction)');
