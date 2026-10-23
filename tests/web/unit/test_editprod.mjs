// Production bone after brush / eraser edits (plan 1.2). segThr() turned null as soon as anything was painted or
// erased, so the production request (guideRequest) and the preview's fine field fell back to the 0.8 mm working mask
// over the whole guide: one eraser click far from the guide made the contact surface step on the 0.8 mm grid (p99
// 1.5-2 mm off the CT on the real sample). Now the CT stays the bone at full resolution; only the edited cells follow
// the edits. Phantom: tests/phantoms/phantoms.mjs mandibleBar. Run: node test_editprod.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['segedit.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const SE = () => P.eval('SegEdit');

const v = mandibleBar({});
S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-editprod' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
S.qcBase = St.qualityCheck(S.vol); St.syncQC();
await St.segment(true); await St.settled();
Object.assign(S.gAuto, { L: 0 }); S.g.L = 36; S.g.split = 0;
S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
S.planes = [{ off: -8, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 8, yaw: 0, pitch: 0, w: 0.8, ok: false }];
S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();

const ctx = () => Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld() }, St.frameAxes());
const maskOf = q => Buffer.from(q.mask_b64, 'base64');
// the world point of a cell of the request's crop
const cellWorld = (q, id) => { const { nx, ny, origin, sp, axes } = q.crop, i = id % nx, j = ((id / nx) | 0) % ny, k = (id / (nx * ny)) | 0;
  return [0, 1, 2].map(a => origin[a] + axes[0][a] * i * sp[0] + axes[1][a] * j * sp[1] + axes[2][a] * k * sp[2]); };
async function stroke(tool, w) { const se = SE(); se.setTool(tool); se.paint(w.slice(), null, true); await se.strokeEnd(); se.off(); await St.settled(); }

let q0, F0;
test('the unedited threshold case: the production request carries the CT (mask_scale 255)', () => {
  assert.ok(/^Eşik/.test(S.segMethod), S.segMethod);
  const c = ctx(); assert.ok(c.thr != null);
  q0 = St.guideRequest(c); assert.equal(q0.mask_scale, 255);
  F0 = St.guideField();
});

// on the lower border (the stroke opens to the outside, as an eraser at the surface does), inside the crop, far below
// the guide's seat at the crest
const FAR = [14, 0, -23.5], IN = V(14, 0, -22.5);
test('an eraser stroke away from the guide: still the CT at full resolution, the mask unchanged outside the stroke', async () => {
  await stroke('erase', FAR);
  assert.ok(SE().edited(), 'the stroke changed the mask');
  const c = ctx();
  assert.ok(c.thr != null, 'the threshold stays after an edit');
  const q1 = St.guideRequest(c); assert.equal(q1.mask_scale, 255);
  const a = maskOf(q0), b = maskOf(q1); assert.equal(a.length, b.length);
  let diff = 0, far = 0, erased = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    diff++;
    const w = cellWorld(q1, i), d = Math.hypot(w[0] - FAR[0], w[1] - FAR[1], w[2] - FAR[2]);
    if (d > 3 + 1.5) far++; else if (a[i] >= 128 && b[i] === 0) erased++;
  }
  assert.ok(diff > 0 && erased > 0, `the erased cells leave the bone (diff ${diff}, erased ${erased})`);
  assert.equal(far, 0, `${far} cells changed outside the stroke`);
});

test('the preview fine field follows the same rule: equal to the unedited one at the seat, lower in the erased spot', () => {
  const F1 = St.guideField();
  assert.notEqual(F1, F0, 'a new field for the edits');
  for (let x = -16; x <= 16; x += 4) for (const z of [0.5, -0.5, -1.5]) for (const y of [-5, 0, 5]) {
    const q = V(x, y, z); assert.ok(Math.abs(F1(q) - F0(q)) < 1e-6, `at ${x},${y},${z}: ${F0(q)} -> ${F1(q)}`);
  }
  assert.ok(F0(IN) > 0 && F1(IN) < F0(IN), `the erased spot is no longer bone (${F0(IN)} -> ${F1(IN)})`);
});

test('editsAt: a painted cell below the threshold is bone, an erased one is not', () => {
  const N = S.red.nx * S.red.ny * S.red.nz, add = new Uint8Array(N), del = new Uint8Array(N);
  const ix = G.indexOf(S.red, [0, 0, 3]).map(Math.round), id = ix[0] + S.red.nx * (ix[1] + S.red.ny * ix[2]); add[id] = 1;
  const E = St.editsAt({ add, del }, S.red);
  assert.ok(E.add(G.worldOf(S.red, ...ix)) && !E.del(G.worldOf(S.red, ...ix)));
  assert.ok(!E.add([0, 0, 10]));
  assert.equal(St.editsAt(null, S.red), null);
});

test('an AI mask (no threshold): an information row says the production surface is the 0.8 mm grid', () => {
  const m0 = S.segMethod;
  try {
    St.renderChecks(); assert.ok(!(S.checkList || []).some(c => /0,8 mm ızgaradan/.test(c[2])), 'none on a threshold');
    S.segMethod = 'Yapay zeka sunucusu (test)'; St.renderChecks();
    const r = S.checkList.filter(c => /0,8 mm ızgaradan/.test(c[2]));
    assert.equal(r.length, 1); assert.equal(r[0][0], 'info');
  } finally { S.segMethod = m0; St.renderChecks(); }
});

await run('editprod');
