// Layer opacity (Katmanlar): the skin layer at 100 % is fully opaque from either slider. The scene list slider
// (web/app.js setOpacity) used to multiply by the layer's preset opacity (skin 0.22), so 100 % still showed 0.22.
// Both sliders now set the same opacity, which is saved with the plan. Synthetic volume only.
// Skin surface: on a whole CT the skin is the body outline, not the bone; on the defaced real CT samples (tissue > 5 mm
// from bone is air) the layer says why it only shells the bone.
// Run: node test_layer_opacity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const fetchStub = async url => { const m = /sample_(\w+)\.json/.exec(url); if (m) { const d = JSON.parse(fs.readFileSync(path.join(REPO, 'web', `sample_${m[1]}.json`), 'utf8')); return { json: async () => d }; } throw new Error('offline'); };
const P = studio({ post: ['layers.js'], extra: { fetch: fetchStub } });
const St = await ready(P); const S = St.S, G = P.eval('G'), W = P.g;

function head() {
  const sp = [1, 1, 1], nx = 40, ny = 40, nz = 40, origin = [-20, -20, -20], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if ((i - 20) ** 2 + (j - 20) ** 2 + (k - 20) ** 2 < 14 ** 2) hu[i + nx * (j + ny * k)] = 40;
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.red = G.reduce(S.vol, 1);
}
const mats = pt => { const a = []; pt.obj.traverse(c => { if (c.material) a.push(c.material); }); return a; };
let pt;

test('setup: skin layer built with its preset opacity', async () => {
  head();
  await W.Layers.add('skin');
  const L = W.Layers.list()[0];
  pt = St.parts['layer_' + L.id];
  assert.ok(pt, 'skin layer is in the scene list');
  mats(pt).forEach(m => { assert.ok(Math.abs(m.opacity - 0.22) < 1e-9); assert.equal(m.transparent, true); });
});

test('scene list slider at 100 %: skin fully opaque (was 0.22)', () => {
  St.setOpacity(pt, 1);
  mats(pt).forEach(m => { assert.equal(m.opacity, 1, 'opacity 1'); assert.equal(m.transparent, false); assert.equal(m.depthWrite, true); });
  assert.equal(pt.obj.renderOrder, 0, 'drawn with the opaque objects');
  assert.equal(pt.opacity, 1, 'list slider shows 100 %');
  assert.equal(W.Layers.list()[0].opacity, 1, 'layer panel value follows');
  assert.equal(W.PlanExt.layers.get()[0].opacity, 1, 'saved with the plan');
});

test('scene list slider at 50 %: the value itself, not 0.22 x 0.5', () => {
  St.setOpacity(pt, 0.5);
  mats(pt).forEach(m => { assert.ok(Math.abs(m.opacity - 0.5) < 1e-9, 'opacity 0.5, got ' + m.opacity); assert.equal(m.transparent, true); assert.equal(m.depthWrite, false); });
  St.setOpacity(pt, 1);
  mats(pt).forEach(m => assert.equal(m.opacity, 1, 'back to opaque'));
});

test('reopen with skin at 100 %: opaque, list slider at 100 %', async () => {
  await W.PlanExt.layers.set([{ kind: 'skin', name: 'Cilt', min: -300, max: 3071, color: 0xe2a48c, opacity: 1, on: true, outer: true }]);
  const L = W.Layers.list()[0], p2 = St.parts['layer_' + L.id];
  mats(p2).forEach(m => { assert.equal(m.opacity, 1); assert.equal(m.transparent, false); });
  assert.equal(p2.opacity, 1);
  St.setOpacity(p2, 1);
  mats(p2).forEach(m => assert.equal(m.opacity, 1, 'list slider after reopen keeps it opaque'));
});

test('other parts keep the multiplier (bone etc. unchanged)', () => {
  const T = W.THREE, m = new T.MeshBasicMaterial({ transparent: true, opacity: 0.4 }), o = new T.Mesh(new T.BoxGeometry(1, 1, 1), m);
  St.setPart('xtest', 'x', o, 0xffffff);
  St.setOpacity(St.parts.xtest, 0.5);
  assert.ok(Math.abs(m.opacity - 0.2) < 1e-9);
  St.setPart('xtest', null, null);
});

test('skin of a whole CT is the body outline, far outside the bone', async () => {
  const sp = [1, 1, 1], nx = 60, ny = 60, nz = 40, origin = [-30, -30, -20], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const r = Math.hypot(i - 30, j - 30); if (r < 25) hu[i + nx * (j + ny * k)] = r < 6 ? 1200 : 40;   // soft tissue round a bone rod
  }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} }; S.red = G.reduce(S.vol, 1);
  await W.PlanExt.layers.set([{ kind: 'skin', name: 'Cilt', min: -300, max: 3071, color: 0xe2a48c, opacity: 1, on: true, outer: true }]);
  const L = W.Layers.list()[0], o = St.parts['layer_' + L.id].obj; o.updateMatrixWorld();
  const bb = new W.THREE.Box3().setFromObject(o), w = bb.max.x - bb.min.x;
  assert.ok(w > 44 && w < 54, 'skin width ~50 mm (body), got ' + w.toFixed(1));
  assert.equal(L.defaced, false);
  assert.doesNotMatch(P.doc.getElementById('layerList').innerHTML, /anonimleştirildi/);
});

test('defaced real CT sample: marked, and the skin layer says why it only shells the bone', async () => {
  const v = await St.readSample('mandible_ct');
  assert.equal(v.meta.defaced, true, 'mandible_ct sample is marked defaced');
  for (const n of ['leg_ct', 'ankle_ct']) assert.equal((await St.readSample(n)).meta.defaced, true, n);
  assert.ok(!(await St.readSample('mandible')).meta || !(await St.readSample('mandible')).meta.defaced, 'synthetic sample not marked');
  S.vol.meta = { defaced: true };
  await W.PlanExt.layers.set([{ kind: 'skin', name: 'Cilt', min: -300, max: 3071, color: 0xe2a48c, opacity: 1, on: true, outer: true }]);
  assert.equal(W.Layers.list()[0].defaced, true);
  assert.match(P.doc.getElementById('layerList').innerHTML, /Örnek BT anonimleştirildi/);
  S.vol.meta = {};
});

test('a skin layer hidden in Katmanlar stays hidden after an undo rebuilds the layer list (Melikhan 2026-10-29)', async () => {
  // the undo restores PlanExt.layers: the skin is built again under a new run-time id (layer_<n>), and the hidden list
  // was kept by that id, so the skin came back
  head();
  const L = W.Layers.list().find(x => x.kind === 'skin'); const id = 'layer_' + L.id;
  if (!St.parts[id]) await W.Layers.add('skin');
  const sid = 'layer_' + W.Layers.list().find(x => x.kind === 'skin').id;
  St.setVisible(sid, false);
  await W.PlanExt.layers.set(JSON.parse(JSON.stringify(W.PlanExt.layers.get())));
  const now = 'layer_' + W.Layers.list().find(x => x.kind === 'skin').id;
  assert.notEqual(now, sid, 'rebuilt under a new id');
  assert.ok(St.parts[now], 'rebuilt');
  assert.equal(St.parts[now].visible, false, 'still hidden');
  assert.equal(St.parts[now].obj.visible, false);
  St.setVisible(now, true);
});

await run('layer opacity');
await new Promise(r => process.stdout.write('', r)); process.exit(process.exitCode || 0);
