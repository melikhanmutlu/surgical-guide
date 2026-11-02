// Cut centred on the bone and slot wings (Melikhan 2026-11-02):
//  - a cut turned with the handle or the angle sliders used to swing about the point where it meets the guide axis
//    (on the bone surface, or off the bone), so the cut slid over the bone while it was turned. Now it turns about the
//    middle of the bone section it cuts (cutSection: mean of the bone voxels in the plane near the cut point), and a
//    moved cut's point settles there (centreCut);
//  - the guide's slot covered only the guide's own band across the bone (W), so on a tall section (the ramus) the saw
//    was guided over a part of the cut. Now the slot rim is carried along the cut over the whole bone it crosses
//    (slot wing, app.js slotWing, gkernel.js; the server builds the same, tests/server/test_slot_boss.py).
// Phantom: tests/phantoms/phantoms.mjs mandibleBar; synthetic bone for the guide kernel. Run: node test_cutcentre.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ extra: { confirm: () => true, fetch: async () => { throw new Error('offline'); } } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// ---- slot wings on a synthetic bone (guide frame = world: u = x, v = y, n = z, top of the bone at z = 0) ----
const PLATE = q => q.z < 0 && q.z > -6 && Math.abs(q.y) < 20 && Math.abs(q.x) < 70;    // a tall thin section (40 mm across v)
const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;      // a section narrower than the guide
const occ = (gr, uu, vv, nn) => { const i = Math.round((uu - gr.lo[0]) / gr.h), j = Math.round((vv - gr.lo[1]) / gr.h), k = Math.round((nn - gr.lo[2]) / gr.h); if (i < 0 || j < 0 || k < 0 || i >= gr.nx || j >= gr.ny || k >= gr.nz) return 0; return gr.Gm[i + gr.nx * (j + gr.ny * k)]; };
const build = (bone, wings, g) => St.buildGuide({ P: V(), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [], bone, h: 0.4, fast: true, wings,
  g: Object.assign({}, St.G_DEFAULT, { wrapU: null, W: 22, wrap: 4 }, g) });

test('slot wing: on a 40 mm tall section the slot rim runs along the cut over the whole bone (before: only the 22 mm guide band)', async () => {
  const off = await build(PLATE, false), on = await build(PLATE, true);
  assert.equal(off.result.wings || null, null);
  const w = on.result.wings && on.result.wings[0];
  assert.ok(w, 'a wing for the cut');
  near(w[0], -22, 0.6, 'wing low end: bone edge + 2 mm'); near(w[1], 22, 0.6, 'wing high end');
  const c = 0.3;
  for (const vv of [-18, -14, 14, 18]) {
    assert.equal(occ(off.grid, 1.6, vv, c + 1), 0, `no guide at v = ${vv} before`);
    assert.equal(occ(on.grid, 1.6, vv, c + 1), 1, `rim beside the slot at v = ${vv}`);
    assert.equal(occ(on.grid, -1.6, vv, c + 1), 1, `rim on the other side at v = ${vv}`);
    assert.equal(occ(on.grid, 0, vv, c + 1), 0, `slot open at v = ${vv}`);
  }
  assert.equal(occ(on.grid, 8, 18, c + 1), 0, 'the wing is a rim along the cut, not a wider body');
  assert.equal(on.result.pieces, 1, 'one piece');
});
test('slot wing: a section narrower than the guide gets none, and the guide is the same as before', async () => {
  const off = await build(BAR, false), on = await build(BAR, true);
  assert.equal(on.result.wings, null);
  assert.equal(on.grid.Gm.length, off.grid.Gm.length);
  let diff = 0; for (let i = 0; i < on.grid.Gm.length; i++) if (on.grid.Gm[i] !== off.grid.Gm[i]) diff++;
  assert.equal(diff, 0, 'identical body');
});
test('slot wing goes to the server request (planes[].wing) and widens the crop', async () => {
  const on = await build(PLATE, true);
  const pls = [{ p: V(0, 0, 0), pSlot: V(0, 0, 0), N: V(1, 0, 0), w: 0.8 }];
  const out = St.margPlanes({ pls, wings: on.result.wings, marg: null }, q => [q.x, q.y, q.z]);
  assert.deepEqual(out[0].wing, on.result.wings[0]);
});

// ---- the cut turns about the middle of the bone (mandibleBar: bone along x, section centre at y = 0, z = -12, crest z = 0) ----
const vol = mandibleBar({ gum: false });
S.vol = { hu: vol.hu, nx: vol.nx, ny: vol.ny, nz: vol.nz, sp: vol.sp, origin: vol.origin, axes: vol.axes, meta: vol.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-cutcentre' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
await St.segment(true); await St.settled();

test('cutSection: the middle of the bone section a cut goes through, from a point on the bone surface', () => {
  const sec = St.cutSection(V(20, 0, 0), V(1, 0, 0));
  assert.ok(sec, 'section found');
  near(sec.c.x, 20, 0.3); near(sec.c.y, 0, 1); near(sec.c.z, -12, 1.5);
  assert.ok(sec.r > 8 && sec.r < 16, 'radius covers the section: ' + sec.r);
});
function setup(o) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.g.rot = 0;
  S.planes = [Object.assign({ off: 20, yaw: 0, pitch: 0, w: 0.8, ok: false }, o)];
}
test('a moved cut settles in the middle of the bone; the plane itself does not move', () => {
  setup({});
  const N0 = St.planesWorld()[0].N.clone(), d0 = St.planesWorld()[0].p.dot(N0);
  assert.ok(St.centreCut(0), 'centred');
  const pw = St.planesWorld()[0];
  near(pw.p.z, -12, 1.5, 'cut point at the middle of the section'); near(pw.p.y, 0, 1);
  near(pw.N.dot(N0), 1, 1e-9); near(pw.p.dot(N0), d0, 0.06, 'same plane');
});
test('the pitch slider turns the cut about the middle of the bone (before: about the crest, the cut slid 4 mm)', () => {
  setup({}); St.centreCut(0); const c = St.planesWorld()[0].p.clone();
  S.sel = 'p0'; St.renderElements();
  const el = $('f_pitch'); assert.ok(el, 'pitch slider'); el.value = '20';
  (el.listeners.input || []).forEach(f => f({ target: el }));
  const pw = St.planesWorld()[0];
  near(S.planes[0].pitch, 20, 1e-9);
  near(c.clone().sub(pw.p).dot(pw.N), 0, 0.15, 'the middle of the bone stays on the cut');
  assert.ok(pw.p.distanceTo(c) < 0.3, 'the cut point stays: ' + pw.p.distanceTo(c));
});
test('the rotate handle turns the cut about the middle of the bone', () => {
  setup({}); S.planes[0].pv = undefined; delete S.planes[0].pv;
  const c = St.cutSection(St.planesWorld()[0].p, St.planesWorld()[0].N).c;
  S.sel = 'p0'; St.gz.mode = 'rotate';
  const { u, v, n } = St.frameAxes();
  St.proxy.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(u, v, n)); St.proxy.position.copy(St.planesWorld()[0].p); St.proxy.updateMatrixWorld();
  St.gz.start = St.gizmoStart();
  St.proxy.quaternion.premultiply(new T.Quaternion().setFromAxisAngle(v, 20 * Math.PI / 180)); St.gizmoApply(); St.gz.start = null;
  const pw = St.planesWorld()[0];
  assert.ok(Math.abs(S.planes[0].pitch) > 10, 'turned: ' + S.planes[0].pitch);
  near(c.clone().sub(pw.p).dot(pw.N), 0, 0.15, 'the middle of the bone stays on the cut');
  St.gz.mode = 'translate';
});

await run();
