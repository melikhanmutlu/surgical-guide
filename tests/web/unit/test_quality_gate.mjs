// Quality gate and automatic fixes (thread "Guide STL kalitesi", 2026-10-21): a plan on a real CT was approved and its
// guide printed while the Kontroller tab only warned that the automatic mandible looked contaminated and that the fit
// ladder had found no seatable guide. Now:
//  - a planning bone in doubt (automatic separation at the edge of the expected size, untouched and unconfirmed) is a
//    critical check with two fixes: go to the separation, or confirm the bone model (stored in the plan, valid for
//    this bone only)
//  - a fit ladder that ends without a passing rung is critical only when the kept guide itself fails (pieces,
//    insertion direction, screws), with a "try again" fix; a kept guide that passes is information
//  - the production request carries the CT as a ramp around the threshold (mask_scale 255): bone >= 128, its
//    neighbours below the threshold < 128, other bone 0
//  - the server's print checks (thin wall, guide in bone, guide in the bone's shadow) are critical checks and words
//  - grafts more than DEV_ERR (twice DEV_WARN) mm off the defect line are critical, with "Kesileri öner" as the fix
// Run: node test_quality_gate.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, src } from './lib/harness.mjs';

const P = studio({ post: ['export.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// straight bar "mandible" along x with a 100 HU partial-volume rim around it, and a second bone (a block) apart from it
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2], e = (y / 10) ** 2 + ((z + 6) / 6) ** 2;
    if (Math.abs(x) < 58 && e < 1) hu[i + nx * (j + ny * k)] = 1200;
    else if (Math.abs(x) < 59 && e < 1.25) hu[i + nx * (j + ny * k)] = 100;
  }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-gate' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true); await St.settled();
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
}
const crits = () => (S.checkList || []).filter(c => c[0] === 'crit').map(c => c[2]);
const row = re => (S.checkList || []).find(c => re.test(c[2]));

test('setup: a guide on the bar, no critical check from the bone or the fit', () => {
  St.renderChecks();
  assert.ok(St.parts.guide);
  assert.ok(!crits().some(t => /mandibula|takılabilir guide vermedi/.test(t)), JSON.stringify(crits()));
});

test('bone in doubt: critical with two fixes; confirming clears it for this bone only, and it is kept in the plan', async () => {
  const picked = [...S.selected][0];
  try {
    S.segInfo = { status: 'split', picked, vol: 65, ext: [99, 82, 116], before: { vol: 550, ext: [150, 170, 240] } };
    S.boneOk = null; St.renderChecks();
    const r = row(/Otomatik ayrılan mandibula \(65 cm³, yükseklik 116 mm\)/);
    assert.ok(r && r[0] === 'crit', JSON.stringify(crits()));
    assert.equal(JSON.stringify(r[4].map(f => f[0])), JSON.stringify(['bone', 'boneOk']));
    assert.match($('checks').innerHTML, /data-fix="boneOk"/);
    await St.runFix('boneOk');
    assert.ok(!row(/Otomatik ayrılan mandibula/), 'confirmed: no longer critical');
    assert.equal(St.planOf().boneOk, St.boneKey());
    // another bone (a different threshold) is not covered by the confirmation
    const t0 = $('thr').value; $('thr').value = String(+t0 + 50);
    St.renderChecks(); assert.ok(row(/Otomatik ayrılan mandibula/), 'a different bone: critical again');
    $('thr').value = t0; St.renderChecks(); assert.ok(!row(/Otomatik ayrılan mandibula/));
    // a bone in range is no check at all
    S.boneOk = null; S.segInfo = { status: 'split', picked, vol: 55, ext: [99, 82, 90] }; St.renderChecks();
    assert.ok(!row(/Otomatik ayrılan mandibula/));
    // a bone the user changed (another selection) is theirs: no check
    S.segInfo = { status: 'split', picked: picked + 999, vol: 65, ext: [99, 82, 116] }; St.renderChecks();
    assert.ok(!row(/Otomatik ayrılan mandibula/));
  } finally { S.segInfo = null; S.boneOk = null; St.renderChecks(); }
});

test('fit ladder without a passing rung: information when the kept guide passes, critical with a fix when it fails', () => {
  const R = S.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1;
  assert.equal(R.pieces, want);
  S.fitLog = [{ step: 'wrap', split: 0, wrap: 12.5, flange: 3, ok: false }, { step: 'wrap', split: 0, wrap: 11.5, flange: 3, ok: false },
    { step: 'kept', split: 0, wrap: 12.5, flange: 3, ok: false, pieces: 3, want, free: 1, screws: 0 }];
  St.renderChecks();
  assert.ok(row(/tutulan guide parça, takma yönü ve vida kontrollerini geçiyor/), JSON.stringify(S.checkList.map(c => c[2]).filter(t => /uyum/.test(t))));
  assert.ok(!row(/takılabilir guide vermedi/));
  const p0 = R.pieces; R.pieces = want + 1;
  try {
    St.renderChecks();
    const r = row(/takılabilir guide vermedi/);
    assert.ok(r && r[0] === 'crit'); assert.equal(JSON.stringify(r[4]), JSON.stringify([['fit', 'Yeniden dene']]));
  } finally { R.pieces = p0; S.fitLog = []; St.renderChecks(); }
});

test('production request: the CT as a ramp around the threshold (bone >= 128, rim < 128, mask_scale 255)', () => {
  const c = Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld() }, St.frameAxes());
  assert.ok(c.thr != null);
  const q = St.guideRequest(c), raw = Buffer.from(q.mask_b64, 'base64');
  assert.equal(q.mask_scale, 255);
  let bone = 0, rim = 0, rimMax = 0;
  for (const b of raw) { if (b >= 128) bone++; else if (b > 0) { rim++; rimMax = Math.max(rimMax, b); } }
  assert.ok(bone > 1000 && rim > 100, `bone ${bone} rim ${rim}`);
  // the 100 HU rim is part bone: a value between 0 and 128
  assert.equal(rimMax, St.softOcc(100, c.thr));
  // an AI mask (no threshold) stays 0/1 without a scale
  const q2 = St.guideRequest(Object.assign({}, c, { thr: null }));
  assert.equal(q2.mask_scale, undefined);
  assert.ok(Buffer.from(q2.mask_b64, 'base64').every(b => b <= 1));
});

test('production request: a clean soft-tissue/bone step keeps the bone-mask surface (soft tissue 0, cortex 255)', () => {
  // the consistency harness (2026-10-21): with soft tissue at 0.4 instead of 0 the server's guide sat 0.2 mm farther
  // off the bone than the preview and the planned clearance
  for (const thr of [150, 250, 400, 700]) {
    assert.equal(St.softOcc(40, thr), 0, `soft tissue at thr ${thr}`);
    assert.equal(St.softOcc(-1000, thr), 0);
    assert.equal(St.softOcc(1500, thr), 255, `cortex at thr ${thr}`);
    assert.ok(Math.abs(St.softOcc(thr, thr) - 127.5) <= 0.5, `the threshold itself is the middle at thr ${thr}`);
    assert.ok(St.softOcc(thr - 40, thr) < 128 && St.softOcc(thr - 40, thr) > 0 && St.softOcc(thr + 40, thr) > 128 && St.softOcc(thr + 40, thr) < 255, `partial volume is graded at thr ${thr}`);
  }
});

test('print checks from the server: critical checks in words, and the report line', () => {
  const issues = [{ code: 'thin_wall', mm3: 3.2, min_wall_mm: 1 }, { code: 'bone_overlap', mm3: 2 }, { code: 'undercut', mm3: 4.5 }];
  S.prod = { key: St.prodKey(), stl: new Uint8Array(84), watertight: true, bodies: 1, volume: 5000, faces: 10, issues, productionOk: false, screwNos: [], screwsMissing: 0,
    printChecks: { thin_wall_mm3: 3.2, thin_patch_mm3: 3.2, bone_overlap_mm3: 2, undercut_mm3: 4.5, min_wall_mm: 1 } };
  try {
    St.renderChecks();
    assert.ok(row(/1,0 mm'den ince duvar var \(3,2 mm³\)/) && row(/2,0 mm³'ü kemiğin içinde/) && row(/4,5 mm³'ü takma yönünde kemiğin gölgesinde/), JSON.stringify(crits()));
    assert.ok(S.crit >= 3);
    assert.match(St.printLine(S.prod), /ince duvar/);
    S.prod.issues = []; S.prod.productionOk = true;
    assert.match(St.printLine(S.prod), /Baskı denetimi geçti/);
  } finally { S.prod = null; St.renderChecks(); }
});

test('fibula: grafts beyond DEV_ERR off the defect line are critical, with the cut suggestion as the fix', () => {
  const f = src('fibula.js');
  assert.match(f, /DEV_ERR = 2 \* DEV_WARN/);
  assert.match(f, /if \(c\.dev > DEV_ERR\) out\.push\(\['crit', 'Kritik'[^\n]*\[\['fibOpt', 'Kesileri öner'\]\]\]\);/);
  assert.match(src('app.js'), /Fibula\.checks\(\)\.forEach\(c => out\.push\(\[c\[0\], c\[1\], c\[2\], c\[3\] \|\| 'fib', c\[4\]\]\)\)/);
});

await run('quality gate and fixes');
