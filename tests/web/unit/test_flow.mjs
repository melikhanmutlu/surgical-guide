// The surgeon's main flow, steps 2-3 (resection region and cuts), on synthetic bone:
//  - a lesion as tall as it is long keeps the guide axis along the bone (not across it)
//  - the cuts proposed from a range on a curved bone clear the whole range by the safety margin
//  - lesionMargins measures how far each outer cut is from the lesion (the critical check uses it)
//  - turning a cut keeps its point on the bone
//  - a guide turn that would turn a cut is refused, the cuts stay
//  - a new guide centre drops every approval
// Run: node test_flow.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: [] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
async function volume(bone, box, sp = [0.8, 0.8, 0.8]) {
  const nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bone(origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2])) hu[i + nx * (j + ny * k)] = 1200;
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-flow-' + box.x };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); S.guideOn = false; S.screws = []; S.planes = []; S.anchor = null;
  Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null, ok: false });
}
// signed clearance of points from the outer cuts, on the lesion side (min per cut)
function clearance(pts) {
  const pw = St.planesWorld().sort((a, b) => a.off - b.off), { u } = St.frameAxes();
  return pw.map((p, i) => { const N = p.N.dot(u) < 0 ? p.N.clone().negate() : p.N, s = i === 0 ? 1 : -1; let m = Infinity; for (const q of pts) m = Math.min(m, s * q.clone().sub(p.p).dot(N)); return m; });
}

// a straight body 96 mm long, 10 mm thick, 30 mm tall; a lesion painted as a stack of axial discs 22 mm tall, 8 mm wide
test('a lesion taller than long: the guide axis stays along the bone and the cuts clear it', async () => {
  await volume((x, y, z) => Math.abs(x) < 48 && Math.abs(y) < 5 && z > -30 && z < 0, { x: 50, y: 20, z: 40 });
  const pts = []; for (let z = -26; z <= -4; z += 0.8) for (let x = -4; x <= 4; x += 0.8) for (let y = -4; y <= 4; y += 0.8) if (x * x + y * y <= 16) pts.push(V(x, y, z));
  assert(St.anchorFromLesion(pts.map(p => p.clone())), 'anchored');
  St.planFromLesion(pts.map(p => p.clone()));
  const { u } = St.frameAxes();
  assert(Math.abs(u.x) > 0.95, `axis along the bone, u = ${u.toArray().map(x => x.toFixed(2))}`);
  const cl = clearance(pts); assert(cl.every(c => c >= 2.95), `clearance ${cl.map(c => c.toFixed(2))}`);
});
test('lesionMargins follows a cut moved into the lesion', () => {
  const m0 = St.lesionMargins(); assert(m0.length === 2 && m0.every(m => m.d >= 2.9), `before ${JSON.stringify(m0)}`);
  const lo = S.planes.reduce((a, b) => (b.off < a.off ? b : a)); lo.off += 6;
  const m1 = St.lesionMargins(), d = m1.find(m => S.planes[m.i] === lo).d;
  assert(d < 0, `moved cut is ${d.toFixed(2)} mm from the lesion`);
  lo.off -= 6;
});
test('a new guide centre drops every approval', () => {
  $('surgeon').value = 'Dr Test';
  S.planes.forEach(St.stamp); St.stamp(S.lesion);
  S.screws = [{ u: 20, v: 0, tiltU: 0, tiltV: 0, d: 2, D: 5, sleeveH: 5, len: 10, hand: 1 }]; St.stamp(S.screws[0]);
  const pts = [V(10, -5, -15), V(14, -5, -15)];
  St.anchorFromLesion(pts);
  assert(!S.screws[0].ok && !S.lesion.ok, 'screw and range unapproved');
  S.screws = [];
});

// a jaw curved in the x-z plane (radius 38 at the centre line), the guide on top at the origin
let bone = null;
test('curved bone', async () => {
  await volume((x, y, z) => { const r = Math.hypot(x, z + 45), th = Math.atan2(x, z + 45); if (Math.abs(th) > 1.25) return false; const d = 45 - 7 - r; return (y / 8) ** 2 + (d / 7) ** 2 < 1; }, { x: 50, y: 24, z: 50 });
  const r = S.red; bone = []; for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) if (S.mask[i + r.nx * (j + r.ny * k)]) bone.push(V(...G.worldOf(r, i, j, k)));
  assert(bone.length > 1000);
});
for (const [from, to, margin] of [[-18, 18, 3], [-25, 25, 3], [-20, 20, 5]]) test(`range ${from}..${to}, margin ${margin} on a curved bone: the cuts clear the range`, () => {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.g.rot = 0; S.planes = [];
  Object.assign(S.lesion, { from, to, margin });
  $('suggest').click();
  const cl = clearance(bone.filter(q => q.x >= from && q.x <= to));
  assert(cl.every(c => c >= margin - 0.2), `clearance ${cl.map(c => c.toFixed(2))}`);
});
test('turning a cut keeps its point on the bone', () => {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; Object.assign(S.lesion, { from: -25, to: 25, margin: 3 });
  $('suggest').click();
  const i = S.planes.findIndex(p => p.pv !== undefined); assert(i >= 0, 'a turned cut');
  const ref = St.planesWorld()[i].p.clone();
  St.select('p' + i); St.renderElements();
  const el = $('f_pitch');
  for (const d of [2, 10]) {
    el.value = String(S.planes[i].pitch + d); (el.listeners.input || []).forEach(f => f({ type: 'input', target: el }));
    const pw = St.planesWorld()[i], dist = Math.abs(ref.clone().sub(pw.p).dot(pw.N));
    assert(dist < 0.2, `+${d}°: the old point is ${dist.toFixed(2)} mm off the plane`);
  }
  St.select(null);
});
test('a guide turn that would turn a cut is refused and the cuts stay', () => {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.g.rot = 0;
  S.planes = [{ off: -10, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 10, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  const before = JSON.stringify(S.planes);
  assert(St.setGuideRot(85) === false, 'refused');
  assert(S.g.rot === 0 && JSON.stringify(S.planes) === before, 'nothing changed');
  assert(St.setGuideRot(20) === true && S.g.rot === 20, 'a small turn is fine');
});
await run('main flow: resection region and cuts');
process.exit(0);
