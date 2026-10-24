// Plan-state regressions (Denetim 3 fixes) on window.Studio: new volume resets guide settings / lesion bounds.
// Run: node test_state.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { dicom } from './lib/dicomw.mjs';

const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'] }); const St = await ready(P); const S = St.S;
const px = (n, f) => Array.from({ length: n }, (_, i) => f(i));
// small synthetic 4-slice series, no patient data
const series = () => [3, 2, 1, 0].map(k => new File([dicom({ rows: 2, cols: 3, pixels: px(6, i => 1000 + 10 * k + i), ipp: [5, -3, 10 + k * 1.25], iop: [1, 0, 0, 0, 1, 0], ps: [0.5, 0.7], series: '1.2.3.7', sop: `1.2.3.${k + 100}`, slope: 1, icpt: -1024, thickness: 1, kernel: 'BONE' })], `s${k}.dcm`));
const vol = (await St.readDicom(series())).vol;

test('O-2: loading a new volume resets guide settings and lesion bounds (previous patient does not carry over)', async () => {
  S.g.L = 77; S.g.W = 33; S.g.wall = 4; S.g.split = 1; S.g.stopT = 1;
  S.lesion.from = -25; S.lesion.to = 31; S.lesion.margin = 9; S.lesion.condyle = 'R'; S.lesion.ok = true;
  S.source = { type: 'dicom', name: 'other', fp: 'dicom:other' };
  await St.setVolume(vol, 'Yeni hasta', 'dicom');
  assert.equal(S.g.L, 36); assert.equal(S.g.W, 22); assert.equal(S.g.wall, 2.5); assert.equal(S.g.split, 0); assert.equal(S.g.stopT, 0);
  assert.equal(S.lesion.from, -6); assert.equal(S.lesion.to, 6); assert.equal(S.lesion.margin, 3); assert.equal(S.lesion.condyle, null); assert.equal(S.lesion.ok, false);
});

test('O-2: restoring a plan (autoAnchor false) keeps the plan\'s own settings', async () => {
  S.g.L = 77; S.autoAnchor = false;
  await St.setVolume(vol, 'Plan', 'dicom');
  assert.equal(S.g.L, 77); S.g.L = 36;
});

const fire = (id, type, value) => { const el = P.doc.getElementById(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };
test('low: a guide body slider (wall) and the side selector clear every approval', async () => {
  const ok = () => { S.lesion.ok = true; S.planes = [{ off: 0, yaw: 0, pitch: 0, w: 1.2, ok: true }]; S.screws = [{ ok: true }]; };
  const all = () => S.lesion.ok || S.planes.some(p => p.ok) || S.screws.some(c => c.ok);
  ok(); fire('g_wall', 'input', 3); assert.equal(all(), false, 'wall slider');
  ok(); fire('g_side', 'change', 1); assert.equal(all(), false, 'side');
  ok(); fire('g_bridge', 'input', 5); assert.equal(all(), false, 'bridge slider');
  S.planes = []; S.screws = [];
});

test('C3: the lesion type sets the sample margin (benign 3, aggressive benign 10, malignant 10); "not set" keeps it; saved with the plan; a new patient starts without it', async () => {
  S.lesion.margin = 4; S.lesion.ok = true; S.anchor = null;
  fire('l_type', 'change', 'malign'); assert.equal(S.lesion.margin, 10); assert.equal(S.lesion.type, 'malign'); assert.equal(S.lesion.ok, false, 'the bounds are approved again');
  fire('l_type', 'change', 'benign'); assert.equal(S.lesion.margin, 3);
  S.lesion.margin = 6; fire('l_type', 'change', ''); assert.equal(S.lesion.margin, 6, 'not set: the margin stays'); assert.equal(S.lesion.type, undefined); assert.ok(!('type' in St.planOf().lesion), 'no type in the saved plan (old plan hashes stay)');
  fire('l_type', 'change', 'aggressive'); assert.equal(S.lesion.margin, 10);
  const p = St.planOf(); assert.equal(p.lesion.type, 'aggressive');
  S.lesion.type = null; await St.applyPlan(p); assert.equal(S.lesion.type, 'aggressive'); assert.equal(P.doc.getElementById('l_type').value, 'aggressive');
  const bad = JSON.parse(JSON.stringify(p)); bad.lesion.type = '<x>'; await St.applyPlan(bad); assert.equal(S.lesion.type, undefined);
  S.lesion.type = 'malign'; S.source = { type: 'dicom', name: 'other2', fp: 'dicom:other2' }; S.autoAnchor = true;
  await St.setVolume(vol, 'Yeni hasta', 'dicom'); assert.ok(!S.lesion.type, 'a new patient: no type');
});

await run('plan state (Denetim 3 fixes)');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
