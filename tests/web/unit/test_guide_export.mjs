// The printable guide outside the package (thread "Guide STL kalitesi", 2026-10-21): a user took "Ayrı STL'ler → Guide"
// before any production STL and got the 0.4 mm voxel preview as guide.stl, and printed-looking files from 3MF were the
// preview too. Now:
//  - the single Guide button makes the production STL on the server first (like the package) and saves guide_uretim.stl
//  - without a server the preview leaves as guide_onizleme.stl with a message that it is not for printing
//  - guideler.3mf carries the production STL's triangles once it is made (also inside the package)
// Run: node test_guide_export.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// a tetrahedron as binary STL: what the fake server sends back for every /guide call
function tetraStl() {
  const P = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], F = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const buf = new ArrayBuffer(84 + F.length * 50), dv = new DataView(buf); dv.setUint32(80, F.length, true);
  F.forEach((f, t) => f.forEach((vi, k) => P[vi].forEach((x, c) => dv.setFloat32(84 + t * 50 + 12 + k * 12 + c * 4, x, true))));
  return Buffer.from(buf).toString('base64');
}
const calls = [];
const fetch = async (url, o = {}) => {
  calls.push(url);
  if (/\/guide(\?job=[\w-]+)?$/.test(url)) return new Response(JSON.stringify({ stl_b64: tetraStl(), watertight: true, bodies: 1, volume_mm3: 166.7, faces: 4, ms: 1, production_ok: true, issues: [], resolution: 0.2, version: 'test' }), { status: 200 });
  return new Response('{}', { status: 200 });
};
const saved = [];
const claude = { use: async () => ({ save: async ({ filename, data }) => { saved.push({ filename, bytes: new Uint8Array(await data.arrayBuffer()) }); } }) };
const P = studio({ server: 'http://s', post: ['export.js'], extra: { fetch, claude, AbortController, Response, Blob, atob, btoa, addEventListener() {}, removeEventListener() {} } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

// straight bar "mandible" along x, approved two-cut plan
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-export' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true); await St.settled();
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 0.8, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
  P.g.PendingHooks = [];
  S.resectedVolume = null;   // the synthetic bar has no resected piece; the empty-piece check is not under test
  $('surgeon').value = 'Dr X'; [S.lesion, ...S.planes, ...S.screws].forEach(o => St.stamp(o)); S.crit = 0; S.qc = [];
  St.renderAppr();
}
const previewTris = () => St.stlOf(St.parts.guide.obj).length;

test('setup: approved plan, package open, no production STL yet', () => {
  assert.ok(St.parts.guide, 'guide built'); assert.equal($('expZip').disabled, false, JSON.stringify(St.pendingList()));
  assert.ok(!S.prod);
});

test('single Guide button: makes the production STL on the server and saves guide_uretim.stl (not the preview)', async () => {
  saved.length = 0; calls.length = 0;
  await St.exportOne('guide');
  assert.ok(calls.some(u => /\/guide(\?job=[\w-]+)?$/.test(u)), 'the server was asked: ' + JSON.stringify(calls));
  assert.deepEqual(saved.map(f => f.filename), ['guide_uretim.stl'], $('expMsg').textContent + ' / ' + $('oneMsg').textContent);
  assert.equal(saved[0].bytes.length, 84 + 4 * 50, 'the server STL, not the preview');
  assert.match($('oneMsg').textContent, /guide_uretim\.stl indirildi/);
});

test('guideler.3mf carries the production STL once it is made', async () => {
  const z = new TextDecoder().decode(P.g.Exports.guides3MF());
  assert.ok(z.includes('Mandibula guide (üretim)'), z.slice(0, 300));
  assert.equal((z.match(/<triangle /g) || []).length, 4, 'the four triangles of the server STL');
});

test('3MF button: makes the production STL first when it is out of date', async () => {
  S.prod = null; saved.length = 0; calls.length = 0;
  $('x3mf').click();
  for (let i = 0; i < 400 && saved.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(calls.some(u => /\/guide(\?job=[\w-]+)?$/.test(u)), 'the server was asked');
  assert.deepEqual(saved.map(f => f.filename), ['guideler.3mf', 'modeller.3mf']);
  assert.ok(new TextDecoder().decode(saved[0].bytes).includes('Mandibula guide (üretim)'));
});

test('no server: the preview leaves as guide_onizleme_BASMAYIN.stl with a not-for-printing message (C6: the name says it)', async () => {
  S.prod = null; saved.length = 0; calls.length = 0; $('aiUrl').value = '';
  await St.exportOne('guide');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(saved.map(f => f.filename)), JSON.stringify(['guide_onizleme_BASMAYIN.stl']));
  assert.equal(saved[0].bytes.length, previewTris());
  assert.match($('oneMsg').textContent, /0,4 mm voksel önizlemesidir, baskı için değildir/);
  const z = new TextDecoder().decode(P.g.Exports.guides3MF());
  assert.ok(z.includes('Mandibula guide (önizleme, BASMAYIN)'), 'the 3MF object is labelled too');
});

test('C7: the production STL carries its SHA-256 and server version into plan.json, the approval record and the report; one changed byte stops the package', async () => {
  S.prod = null; saved.length = 0; $('aiUrl').value = 'http://s'; $('expZip').disabled = false;
  await St.productionSTL();
  assert.match(S.prod.sha256 || '', /^[0-9a-f]{64}$/);
  assert.equal(S.prod.sha256, require('node:crypto').createHash('sha256').update(Buffer.from(S.prod.stl)).digest('hex'));
  await St.exportPackage();
  const z = saved.find(f => f.filename === 'guide_paketi.zip'); assert.ok(z, JSON.stringify(saved.map(f => f.filename)) + $('caseMsg').textContent);
  const t = Buffer.from(z.bytes).toString('latin1');
  assert.ok(t.includes(`"sha256": "${S.prod.sha256}"`), 'plan.json / onay_kaydi.json record the digest');
  assert.ok(t.includes('"sunucu_surumu": "test"') && t.includes('"izgara_mm": 0.2'));
  assert.ok(St.reportHTML().includes(S.prod.sha256), 'the report names it');
  // one byte of the STL changed after it was made: no package
  saved.length = 0; const b = new Uint8Array(S.prod.stl); b[100] ^= 1; S.prod.stl = b;
  await St.exportPackage();
  assert.ok(!saved.some(f => f.filename === 'guide_paketi.zip'), 'no package');
  assert.match($('caseMsg').textContent, /guide_uretim\.stl: Dosyanın özeti \(SHA-256\) kaydedilenle eşleşmiyor/);
  S.prod = null;
});

test('C6: a package without a production STL holds the preview as guide_onizleme_BASMAYIN.stl, never as guide.stl', async () => {
  S.prod = null; saved.length = 0; $('aiUrl').value = ''; $('expZip').disabled = false;
  await St.exportPackage();
  const z = saved.find(f => f.filename === 'guide_paketi.zip'); assert.ok(z, JSON.stringify(saved.map(f => f.filename)));
  const t = Buffer.from(z.bytes).toString('latin1');
  assert.ok(t.includes('guide_onizleme_BASMAYIN.stl'));
  assert.ok(!/(^|[^_a-z])guide\.stl/.test(t), 'no file named guide.stl');
  assert.ok(!t.includes('guide_uretim.stl'));
});

await run('guide export (single STL, 3MF): production STL first');
