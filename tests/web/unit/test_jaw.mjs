// B3 (plan "Çene rekonstrüksiyonu: P0 sonrası"): with the teeth closed the threshold mask joins the maxilla to the
// mandible through the teeth, and the neck cut (Bones.pickMandible) keeps it: on the real sample CT the "mandible"
// held ~38 cm³ of maxilla. Now:
//  - Bones.maxillaSuspect: bone on the midline higher than a symphysis with its incisors -> a warning row
//  - Masks "Üst çeneyi ayır": the bone below the occlusal plane marks the mandible, the midline bone above it the
//    maxilla, and the usual seeded split cuts the teeth contact; the rami (lateral, above the plane) stay mandible
//  - the marks are the Masks marks, so the split is saved with the plan and reopens the same
// Phantom: a body (|x| < 52) with teeth pillars up to z 40, a maxilla block (|x| < 34, z 40..75) on the teeth, and two
// rami (46 < |x| < 52) up to z 92.
// Run: node test_jaw.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ pre: ['bones.js'], post: ['masks.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const S = St.S, G = P.eval('G'), W = P.g, B = P.eval('Bones'), $ = id => P.doc.getElementById(id);
const BASE = 100000;

const MAXILLA = (x, y, z) => Math.abs(x) < 34 && Math.abs(y) < 10 && z >= 40 && z < 75;
function phantom(withMaxilla) {
  const sp = [0.8, 0.8, 0.8], o = [-60, -16, -2], nx = 150, ny = 40, nz = 125, hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = o[0] + i * sp[0], y = o[1] + j * sp[1], z = o[2] + k * sp[2], ax = Math.abs(x);
    const body = ax < 52 && Math.abs(y) < 6 && z >= 2 && z < 26;
    const tooth = ax < 42 && Math.abs(((x + 44) % 8) - 4) < 2 && Math.abs(y) < 2.5 && z >= 26 && z < 40;
    const ramus = ax > 46 && ax < 52 && Math.abs(y) < 6 && z >= 2 && z < 92;
    // the tooth tips meet the maxilla through a partial-volume layer (lower density), as closed teeth do on a CT
    if (body || tooth || ramus || (withMaxilla && MAXILLA(x, y, z))) hu[i + nx * (j + ny * k)] = tooth && z >= 38.4 ? 450 : 1200;
  }
  return { hu, nx, ny, nz, sp, origin: o, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
}
async function load(withMaxilla) {
  await W.PlanExt.masks.set(null);
  S.vol = phantom(withMaxilla); S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-jaw-' + withMaxilla };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false; S.anchor = null; S.planes = []; S.screws = [];
  await St.segment(true); await St.settled();
}
const vox = () => S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000;
// mask voxels inside the maxilla block (away from its contact face) and on the rami above the plane
function count(pred) { const r = S.red; let n = 0; for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) { const v = i + r.nx * (j + r.ny * k); if (!S.mask[v]) continue; const p = G.worldOf(r, i, j, k); if (pred(p[0], p[1], p[2])) n++; } return n; }
const warned = () => (S.segWarn || []).some(w => /üst çene \(maksilla\) mandibulaya bağlı/.test(w[2]));

test('a mandible with the maxilla on its teeth: suspected and warned; a mandible alone is not', async () => {
  await load(true);
  const m = B.maxillaSuspect(S.red, S.mask); assert.ok(m && m.vol > 2, JSON.stringify(m)); assert.ok(m.top > 70, JSON.stringify(m));
  assert.ok(warned(), JSON.stringify(S.segWarn));
  await load(false);
  assert.equal(B.maxillaSuspect(S.red, S.mask), null, 'the rami are lateral: not the midline');
  assert.ok(!warned());
});

test('"Üst çeneyi ayır": the maxilla becomes its own layer, the mandible keeps body, teeth and rami', async () => {
  await load(true);
  const before = S.mask.reduce((a, b) => a + b, 0);
  const g = B.jawGuess(S.red, S.mask); assert.ok(g >= 25 && g <= 70, 'a starting plane in range: ' + g);
  W.Masks.setOcc(38);   // the contact is 38 mm above the lowest point (z 2 -> 40)
  await W.Masks.jawRun(); await St.settled();
  const mx = S.comps.find(c => c.label === BASE + 2), md = S.comps.find(c => c.label === BASE + 1);
  assert.ok(mx && md, JSON.stringify(S.comps.map(c => c.label)));
  assert.deepEqual([...S.selected], [BASE + 1]);
  // the block is 68 x 20 x 35 mm = 47.6 cm³ (voxelized)
  near(mx.size * vox(), 47.6, 3, 'maxilla volume');
  { const left = []; count((x, y, z) => { if (MAXILLA(x, y, z) && z > 41.5 && left.length < 2000) left.push([x, y, z].map(Math.round)); return false; }); const xs = left.map(p => p[0]), ys = left.map(p => p[1]), zs = left.map(p => p[2]); assert.equal(left.length, 0, 'no maxilla left in the planning bone: ' + JSON.stringify([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)])); }
  assert.ok(count((x, y, z) => Math.abs(x) > 46 && z > 60) > 100, 'the rami above the plane stay mandible');
  assert.ok(count((x, y, z) => Math.abs(x) < 42 && z > 30 && z < 38) > 50, 'the lower teeth stay mandible');
  assert.ok(before - S.mask.reduce((a, b) => a + b, 0) > 0);
  assert.ok(!warned(), 'no warning after the split');
  assert.match($('mkStat').textContent, /Üst çene ayrıldı/);
  // the marks are saved with the plan and reopen the same split
  const saved = W.PlanExt.masks.get(); assert.ok(saved && saved.layers.length === 2 && saved.layers[1].name === 'Üst çene');
  const n1 = md.size;
  await W.PlanExt.masks.set(null); assert.ok(warned(), 'without the marks the maxilla is back');
  await W.PlanExt.masks.set(JSON.parse(JSON.stringify(saved))); await St.settled();
  assert.equal(S.comps.find(c => c.label === BASE + 1).size, n1);
});

test('no maxilla above the plane: nothing is split and the panel says why', async () => {
  await load(false);
  W.Masks.setOcc(38); await W.Masks.jawRun();
  assert.ok(!S.comps.some(c => c.label >= BASE), 'no layers');
  assert.match($('mkStat').textContent, /orta hatta kemik yok/);
});

await run('jaw (upper jaw split)');
