// Open items after Denetim 5 (real CT): a plan reset brings the guide settings back to the defaults (the old case's
// height stayed), the stump face ignores bone far from the cut point (a ramus strip crossed by the cut plane seated the
// graft 20 mm above the stump, contact 20 %), automatic fibula guide screws end inside the far cortex (bicortical, no
// tip out of the bone), and the leg surfaces are meshed off the page (the fibula load held the page 8-10 s).
// Run: node test_d7_open.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import zlib from 'node:zlib';

function legSample() {
  const nx = 64, ny = 48, nz = 300, origin = [-32, -24, -150], q = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i, y = origin[1] + j, z = origin[2] + k;
    q[i + nx * (j + ny * k)] = (Math.hypot(x - 14, y) < 7 && Math.abs(z) < 135) || (Math.hypot(x + 12, y) < 14 && Math.abs(z) < 140) ? 200 : 0;
  }
  return { dims: [nx, ny, nz], spacing: [1, 1, 1], origin, scale: 10, offset: -1000, data: zlib.gzipSync(Buffer.from(q)).toString('base64') };
}
const LEG = legSample();
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], extra: { fetch: fetchStub }, post: ['condyle.js', 'fibula.js', 'implant.js', 'osteo.js', 'ves.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const fire = (id, type) => { const el = $(id); (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

// mandible bar along x (z -14..0) with a thin strip rising 70 mm from it just inside the first cut, like the ramus an
// oblique cut near the angle crosses
async function bar(extra = () => false) {
  const nx = 160, ny = 50, nz = 120, sp = [0.8, 0.8, 0.8], origin = [-64, -20, -24], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2];
    const body = z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 60, strip = x > -19.5 && x < -17 && Math.abs(y) < 1.5 && z >= 0 && z < 70;
    if (body || strip || extra(x, y, z)) hu[i + nx * (j + ny * k)] = 1200;
  }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -20, yaw: 0, pitch: 0, w: 1.2 }, { off: 20, yaw: 0, pitch: 0, w: 1.2 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate(); St.emit('parts');
}
await bar();
async function start() { const was = S.fib; fire('fibSample', 'click'); await until(() => S.fib !== was && W.Fibula.active() && W.Fibula.state().last); await sleep(50); }

test('Stump face: bone the cut plane crosses far from the cut point (a rising strip) does not lift the defect line', async () => {
  const D = W.Fibula.defect(); assert.ok(D, 'defect');
  const E = St.resEnds(), a = D.pts[0], b = D.pts[D.pts.length - 1];
  assert.ok(Math.abs(E.A.p.x + 20) < 3 && Math.abs(E.B.p.x - 20) < 3, 'cuts at x = -20 and 20');
  // the body's section centre is at z = -7; the strip pulled the old face centre to z of about +10
  assert.ok(a.z < -3 && a.z > -11, `start of the defect line at the body (z ${a.z.toFixed(1)})`);
  assert.ok(Math.abs(a.z - b.z) < 4, `both ends at the same height (${a.z.toFixed(1)}, ${b.z.toFixed(1)})`);
});

test('Defect line: a strip rising from the middle of the defect does not lift the line; a tall (dentate) stump face meets the line', async () => {
  // a strip rising 70 mm from the middle of the resected body: the slab centres follow the body, not the strip
  await bar((x, y, z) => x > -4 && x < -1 && Math.abs(y) < 1.5 && z >= 0 && z < 70);
  let D = W.Fibula.defect(); assert.ok(D, 'defect');
  const top = Math.max(...D.pts.map(p => p.z));
  assert.ok(top < -2, `line stays in the body (highest point z ${top.toFixed(1)})`);
  // a body 54 mm tall from x = 12 on (teeth on the bone): the stump face at B is the centre of that section (z = 13),
  // not of the bone within reach of the cut point, and the line runs into it
  await bar((x, y, z) => x >= 12 && x < 60 && Math.abs(y) < 8 && z >= 0 && z < 40);
  D = W.Fibula.defect(); const b = D.pts[D.pts.length - 1], m = D.pts[D.pts.length - 2];
  assert.ok(Math.abs(b.z - 13) < 4, `face at the section centre (z ${b.z.toFixed(1)})`);
  assert.ok(Math.abs(b.z - m.z) < 4, `the line meets the face (${m.z.toFixed(1)} -> ${b.z.toFixed(1)})`);
  await bar();
});

test('Fibula: the leg meshes arrive from the background; the plan does not wait for them', async () => {
  await start();
  const c = W.Fibula.state().F.c;
  assert.ok(c.meshReady && typeof c.meshReady.then === 'function', 'leg meshes are made in the background');
  await c.meshReady;
  assert.ok(c.geo.getAttribute('position') && c.geo.getAttribute('position').count > 100, 'fibula surface filled in');
  assert.ok(c.tgeo && c.tgeo.getAttribute('position') && c.tgeo.getAttribute('position').count > 100, 'tibia surface filled in');
});

test('Fibula guide screws: an automatic screw ends inside the far cortex (no tip out of the bone)', async () => {
  St.emit('parts'); await sleep(100); await until(() => S.fib.guide && !W.Fibula.pending()); await sleep(600);
  const r = W.Fibula.guideReport(), FR = W.Fibula.state().F.c.FR;
  assert.ok(r.screws.length >= 2, 'screws placed');
  r.screws.forEach(x => {
    assert.ok(x.len < Math.round(2 * FR), `screw ${x.no}: shorter than the bicortical default (${x.len} mm, FR ${FR.toFixed(1)})`);
    assert.ok(x.inBone != null && x.inBone >= x.len - 0.3, `screw ${x.no}: the whole screw in bone (${x.inBone} of ${x.len} mm)`);
    assert.ok(x.len >= 6, `screw ${x.no}: at least 6 mm`);
  });
});

test('Plan reset: the guide settings go back to the defaults (height, layout, wrap)', async () => {
  Object.assign(S.g, { W: 40, split: 1, wrap: 9, wrapU: 9 });
  fire('planReset', 'click'); await sleep(50); await until(() => !S.anchor && S.planes.length === 0); await sleep(300);
  assert.equal(S.g.W, St.G_DEFAULT.W, 'height back to the default');
  assert.equal(S.g.split, St.G_DEFAULT.split, 'one piece again');
  assert.equal(S.g.wrap, St.G_DEFAULT.wrap, 'wrap back to the default');
  assert.equal(S.g.wrapU, null, 'no wrap set by the user');
});

await run('d7_open');
