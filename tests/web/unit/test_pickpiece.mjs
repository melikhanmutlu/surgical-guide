// Bone model editing (segedit.js), Melikhan 2026-10-28:
// - "Parça sil": after the eraser has cut the bone apart, a click on the 3D model removes the whole connected piece
//   under it; Shift-click keeps only that piece. Before, the only way was to erase or lasso each piece by hand.
// - the brush / eraser outline follows the pointer over the 3D model too (a circle of the brush radius lying on the
//   surface); before, the 3D view showed nothing until the button was pressed.
// Phantom: tests/phantoms/phantoms.mjs mandibleBar (a bar along x, -50..50 mm). Run: node test_pickpiece.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['segedit.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const v = mandibleBar({});
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-pickpiece' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true); await St.settled();
const SE = P.eval('SegEdit');
const setRad = r => { const e = $('seRad'); e.value = String(r); (e.listeners.input || []).forEach(f => f({ target: e })); };
// mask voxels left of x = -5 mm and right of x = +5 mm
function sides() {
  const r = S.red; let L = 0, R = 0;
  for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
    const vv = i + r.nx * (j + r.ny * k); if (!S.mask[vv]) continue;
    const x = G.worldOf(r, i, j, k)[0]; if (x < -5) L++; else if (x > 5) R++;
  }
  return { L, R };
}
async function cutInTwo() {
  setRad(8); SE.setTool('erase');
  for (let z = -24; z <= 0; z += 4) SE.paint([0, 0, z], null, z === -24);
  await SE.strokeEnd(); SE.off(); await St.settled();
  const r = S.red, { comps } = G.components(S.mask, r.nx, r.ny, r.nz, 1);
  assert.equal(comps.length, 2, `the eraser cut the bar in two (${comps.length} pieces)`);
}

test('the tool is in the panel next to the scissors', () => {
  assert.ok($('segEdit').innerHTML.includes('data-t="pick"'), 'Parça sil button');
});
test('a click on one half removes that whole half; the other half stays', async () => {
  await cutInTwo(); const s0 = sides(); assert.ok(s0.L > 1000 && s0.R > 1000, JSON.stringify(s0));
  const n = await SE.pickPiece(new T.Vector3(30, 0, -12), false); await St.settled();
  const s1 = sides();
  assert.ok(n > 1000, `removed ${n}`); assert.equal(s1.R, 0, 'right half gone'); assert.equal(s1.L, s0.L, 'left half untouched');
  assert.ok(SE.edited() && /Parça silindi/.test($('seStat').innerHTML), $('seStat').innerHTML);
});
test('Shift-click keeps only the clicked piece', async () => {
  await SE.reset(); await St.settled(); await cutInTwo(); const s0 = sides();
  await SE.pickPiece(new T.Vector3(30, 0, -12), true); await St.settled();
  const s1 = sides(); assert.equal(s1.L, 0, 'left half gone'); assert.equal(s1.R, s0.R, 'right half kept');
});
test('a click off the bone removes nothing', async () => {
  const before = sides(); const n = await SE.pickPiece(new T.Vector3(0, 0, 60), false);
  assert.equal(n, 0); assert.deepEqual(sides(), before);
  await SE.reset(); await St.settled();
});
test('3D brush outline: hovering the bone with the eraser shows a ring of the brush radius on the surface', async () => {
  const cv = St.renderer.domElement, cam = St.camera; setRad(5); SE.setTool('erase');
  St.fitTo(St.parts.bone.obj); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  // a pixel over the bar's middle
  const p = new T.Vector3(-20, 0, -12).project(cam), X = (p.x + 1) / 2 * 800, Y = (1 - p.y) / 2 * 600;
  (cv.listeners.pointermove || []).forEach(f => f({ clientX: X, clientY: Y, pointerId: 1 }));
  const ring = St.scene.children.find(o => o.userData && o.userData.brushRing);
  assert.ok(ring && ring.visible, 'ring shown on hover');
  assert.ok(Math.abs(ring.scale.x - 5) < 1e-9, `radius ${ring.scale.x}`);
  assert.equal('#' + ring.material.color.getHexString(), '#e5484d');
  (cv.listeners.pointerleave || []).forEach(f => f({})); assert.equal(ring.visible, false, 'gone when the pointer leaves');
  (cv.listeners.pointermove || []).forEach(f => f({ clientX: X, clientY: Y, pointerId: 1 })); assert.ok(ring.visible);
  SE.off(); assert.equal(ring.visible, false, 'gone when the tool is off');
});
await run('pick piece + 3D brush outline');
