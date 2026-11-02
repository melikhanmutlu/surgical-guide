// Lesion brush in 3D paints only inside the segmented model the stroke starts on (Melikhan 2026-11-02): the brush ball
// is centred on the surface under the pointer, so half of it lay outside the model and the painted lesion bulged about
// one brush radius out of the bone into the air and the soft tissue. Now a stroke on the bone paints bone voxels only,
// a stroke on a tissue layer paints that layer's HU range only; the slice brush is unchanged. A new volume also gets
// the soft tissue layer next to the skin by default.
// Phantom: tests/phantoms/phantoms.mjs mandibleBar (bone in 3 mm of 40 HU soft tissue, air outside). Run: node test_lesion3d.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['segedit.js', 'layers.js', 'lesion.js', 'masks.js', 'mpr.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const S = St.S, G = P.eval('G'), W = P.g;
const v = mandibleBar({});
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-lesion3d' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
St.emit('volume'); await new Promise(r => setTimeout(r, 50));
await St.segment(true); await St.settled();
const LS = P.eval('Lesion'), r = S.red;

// a point on the bone's top surface at x = 0 (the crest: bone below, soft tissue and air above)
function crest() {
  const i = Math.round((0 - r.origin[0]) / r.sp[0]), j = Math.round((0 - r.origin[1]) / r.sp[1]);
  let top = -1; for (let k = 0; k < r.nz; k++) if (S.mask[i + r.nx * (j + r.ny * k)]) top = k;
  return G.worldOf(r, i, j, top);
}
const paintedIdx = () => { const m = LS.mask(), out = []; if (m) for (let q = 0; q < m.length; q++) if (m[q]) out.push(q); return out; };

test('a new volume gets the skin and the soft tissue layers', () => {
  const kinds = W.Layers.list().map(L => L.kind);
  assert.ok(kinds.includes('skin') && kinds.includes('muscle'), kinds.join(','));
});
test('3D stroke on the bone paints bone voxels only (before: the brush ball spilled into soft tissue and air)', () => {
  LS.clear(); LS.setTool('paint');
  const p = crest();
  LS.paint(p, null, true, St.parts.bone.obj); LS.paint([p[0] + 4, p[1], p[2]], null, false); LS.strokeEnd();
  const L = paintedIdx();
  assert.ok(L.length > 20, 'painted ' + L.length);
  const out = L.filter(q => !S.mask[q]);
  assert.equal(out.length, 0, `${out.length} painted voxels outside the bone`);
  LS.setTool('paint');
});
test('3D stroke on the soft tissue layer paints that HU range only (no air, no bone)', () => {
  LS.clear(); LS.setTool('paint');
  const soft = W.Layers.list().find(L => L.kind === 'muscle'), obj = St.parts['layer_' + soft.id].obj;
  const p = crest(); p[2] += 1.6;
  LS.paint(p, null, true, obj); LS.strokeEnd();
  const L = paintedIdx();
  assert.ok(L.length > 10, 'painted ' + L.length);
  const out = L.filter(q => r.hu[q] < soft.min || r.hu[q] > soft.max);
  assert.equal(out.length, 0, `${out.length} painted voxels outside ${soft.min}–${soft.max} HU`);
  LS.setTool('paint');
});
test('the slice brush still paints the whole disc (the surgeon draws on the CT)', () => {
  LS.clear(); LS.setTool('paint');
  const p = crest();
  LS.paint(p, 1, true); LS.strokeEnd();
  const L = paintedIdx();
  assert.ok(L.some(q => !S.mask[q]) && L.some(q => S.mask[q]), 'disc covers bone and what is around it');
  LS.setTool('paint'); LS.clear();
});

await run();
