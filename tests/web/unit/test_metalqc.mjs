// Metal artefact under the guide (plan 1.5). The image check counted metal over the whole volume (app.js
// qualityCheck: one warning for any metal anywhere); a dental implant right under the guide's contact surface gave the
// same warning as one at the other end of the jaw, and streaks across the bone the guide sits on were not looked at.
// Now metalqc.js reads the CT in the band where the guide meets the bone: metal there is critical, streaks a warning.
// Phantoms: tests/phantoms/phantoms.mjs mandibleBar({ metal }). Run: node test_metalqc.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const P = studio({ post: ['metalqc.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

async function onBar(opts) {
  const v = mandibleBar(opts);
  S.vol = { hu: v.hu, nx: v.nx, ny: v.ny, nz: v.nz, sp: v.sp, origin: v.origin, axes: v.axes, meta: v.meta };
  S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-metal-' + JSON.stringify(opts) };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  S.qcBase = St.qualityCheck(S.vol); St.syncQC();
  await St.segment(true); await St.settled();
  Object.assign(S.gAuto, { L: 0 }); S.g.L = 36; S.g.split = 0;
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -8, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 8, yaw: 0, pitch: 0, w: 0.8, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
  St.renderChecks();
  return v;
}
const rows = re => (S.checkList || []).filter(c => re.test(c[2]));

test('an implant under the guide (x = 10 mm, through the crest): critical, a few mm³ of metal in the contact band', async () => {
  await onBar({ metal: { x: 10 } });
  assert.ok(S.result, 'a guide');
  const r = rows(/kemiğe oturduğu yüzeyde metal var/);
  assert.equal(r.length, 1, JSON.stringify(S.checkList.map(c => c[2])));
  assert.equal(r[0][0], 'crit');
  const m = P.eval('MetalQC').measureAll();
  assert.ok(m.metalMm3 >= 1, JSON.stringify(m));
  // the whole-volume image check still warns once
  assert.ok(S.qc.some(q => /Metal artefaktı olabilir/.test(q[2])));
});

test('an implant 40 mm away (outside the guide): no critical metal row (the whole-volume warning stays)', async () => {
  await onBar({ metal: { x: 40 } });
  assert.equal(rows(/kemiğe oturduğu yüzeyde metal var/).length, 0, JSON.stringify(rows(/metal/i)));
  assert.ok(S.qc.some(q => /Metal artefaktı olabilir/.test(q[2])));
});

test('streaks from an implant outside the guide reaching under it: a warning (spread over the soft tissue band)', async () => {
  await onBar({ metal: { x: 30, streak: true } });
  const r = rows(/çizgi artefaktı/);
  assert.equal(rows(/kemiğe oturduğu yüzeyde metal var/).length, 0);
  assert.equal(r.length, 1, JSON.stringify(S.checkList.map(c => c[2])));
  assert.equal(r[0][0], 'warn');
});

test('no metal, no streak: nothing (the soft tissue band of the phantom is quiet)', async () => {
  await onBar({});
  assert.equal(rows(/metal var|çizgi artefaktı/).length, 0);
  const m = P.eval('MetalQC').measureAll();
  assert.ok(m.sd < 50 && m.metalMm3 === 0, JSON.stringify(m));
});

// Regression (2026-10-25, real default CT): the guide's rim reached the crowns of the teeth; their enamel (a thin
// shell at 2500-3071 HU, where metal saturates too) was counted as metal and the critical row could not be cleared.
test('enamel crowns under the guide (thin shell above the threshold): no critical metal row, an enamel info row', async () => {
  await onBar({ roots: [-12, -3, 3, 12], enamel: true });
  assert.ok(S.result, 'a guide');
  const m = P.eval('MetalQC').measureAll();
  assert.ok(m.enamelMm3 >= 1, 'the guide band reaches the enamel: ' + JSON.stringify(m));
  assert.equal(rows(/kemiğe oturduğu yüzeyde metal var/).length, 0, JSON.stringify(m));
  assert.equal(m.metalMm3, 0, JSON.stringify(m));
  const r = rows(/diş minesine değiyor/);
  assert.equal(r.length, 1, JSON.stringify(S.checkList.map(c => c[2])));
  assert.equal(r[0][0], 'info');
});

test('a solid filling in an enamel crown under the guide: still critical', async () => {
  await onBar({ roots: [-12, -3, 3, 12], enamel: true, metal: { x: 3 } });
  const m = P.eval('MetalQC').measureAll();
  assert.ok(m.metalMm3 >= 1, JSON.stringify(m));
  assert.equal(rows(/kemiğe oturduğu yüzeyde metal var/).length, 1);
});

test('solidAt: a 1 mm shell is not solid, a 4 mm post is', () => {
  const nx = 40, ny = 40, nz = 40, hu = new Int16Array(nx * ny * nz).fill(0);
  const vol = { hu, nx, ny, nz, sp: [0.5, 0.5, 0.5] };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const d = Math.hypot(i - 10, j - 20) * 0.5;      // shell: 1 mm thick ring at 3 mm radius around (10, 20)
    if (d > 2 && d <= 3) hu[i + nx * (j + ny * k)] = 3000;
    if (Math.hypot(i - 30, j - 20) * 0.5 < 2) hu[i + nx * (j + ny * k)] = 3000;   // post: 2 mm radius around (30, 20)
  }
  const Q = P.eval('MetalQC');
  assert.equal(Q.solidAt(vol, 10 + 5, 20, 20), false, 'shell');
  assert.equal(Q.solidAt(vol, 30, 20, 20), true, 'post centre');
  assert.equal(Q.solidAt(vol, 30 + 3, 20, 20), true, 'post rim (inside the opening)');
});

await run('metalqc');
