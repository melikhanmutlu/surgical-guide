// Regressions for the external (Gemini) audit, 2026-10-16, checked against the code:
//  #1  an oblique guide frame (normal / bone axis not on a grid axis) survives planOf -> applyPlan bit for bit: the item
//      approvals (itemSig, 1e-4 on the normals) and the plan hash stay valid (the plan stored the normals to 1e-3 and
//      renormalised them on reading: every approval dropped on reopen or undo)
//  #2  a rebuild scheduled before a resection region exists does not leave "busy" on screen
//  F1  fitWrap's confirmed guide is shown without building it again
//  P1  post-op cut plane normal exact on a long thin cut face (the power iteration converged too slowly there)
//  S1  a draft waiting for its autosave when a new scan is loaded is saved into the case that was open, never into a
//      case made for the new scan
//  S2  two saves that overlap while the case is being created make one case, not two
// Synthetic bone only. Run: node test_d6_gemini.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// a case server: create answers after `createDelay` ms; records creates and drafts
const srv = { creates: 0, drafts: [], createDelay: 0 };
const fetch = async (url, o = {}) => {
  const m = o.method || 'GET', json = x => new Response(JSON.stringify(x), { status: 200 });
  if (/\/cases$/.test(url) && m === 'POST') { const id = 'c' + ++srv.creates; await sleep(srv.createDelay); return json({ id }); }
  if (/\/cases$/.test(url)) return json([]);
  const d = url.match(/\/cases\/([^/]+)\/draft$/); if (d) { srv.drafts.push({ id: d[1], plan: JSON.parse(o.body).plan, keepalive: !!o.keepalive }); return json({ ok: true }); }
  if (/\/versions$/.test(url)) return json(m === 'POST' ? { n: 1 } : []);
  return json({ ok: true });
};
const P = studio({ post: ['store.js', 'audit.js', 'dates.js', 'postop.js'], server: 'http://srv', extra: { addEventListener() {}, removeEventListener() {}, fetch, AbortController: globalThis.AbortController } });
const St = await ready(P), T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
for (let i = 0; i < 100 && $('stBackend').textContent !== 'Sunucu'; i++) await sleep(20);

async function bar(fp) {
  const sp = [0.8, 0.8, 0.8], box = { x: 50, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 48 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: fp, fp };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  St.emit('volume', {});   // what loading a scan announces (store.js starts a new case)
}

test('#1: an oblique frame round-trips bit for bit; item approvals and the plan hash stay valid (reopen / undo)', async () => {
  await bar('d6-a');
  // a frame tilted off every grid axis (as frameAt gives on a real jaw)
  const n = V(0.137, -0.211, 0.968).normalize(), axis = V(0.991, 0.05, 0).sub(n.clone().multiplyScalar(n.dot(V(0.991, 0.05, 0)))).normalize();
  S.anchor = { p: V(0.3, -0.2, 0.1), n, axis };
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 4, pitch: 0, w: 1.2, ok: false }];
  Object.assign(S.lesion, { from: -15, to: 15, condyle: null }); S.guideOn = true; St.placeScrews();
  $('surgeon').value = 'test';
  [S.lesion, ...S.planes, ...S.screws].forEach(St.stamp);
  await St.settled();
  const h0 = W.Audit.planHash(), saved = St.clone(St.planOf());
  await St.applyPlan(St.clone(saved)); await St.settled();
  assert.equal(S.anchor.n.x, n.x); assert.equal(S.anchor.axis.z, axis.z, 'normals restored exactly');
  const off = [S.lesion, ...S.planes, ...S.screws].filter(o => !o.ok).length;
  assert.equal(off, 0, 'no approval dropped on reopen');
  assert.equal(W.Audit.planHash(), h0, 'plan hash unchanged');
  // an older plan stored the normals to 1e-3: still opened (normalised), only its stale signatures are dropped
  const old = St.clone(saved); old.anchor.n = old.anchor.n.map(x => Math.round(x * 1000) / 1000);
  await St.applyPlan(old); await St.settled();
  assert.ok(Math.abs(S.anchor.n.length() - 1) < 1e-12, 'a 1e-3 normal is normalised');
});

test('#2: a rebuild scheduled before a resection region exists does not leave "busy" on screen', async () => {
  await St.settled(); S.anchor = null;
  St.busy(true, 'Rezeksiyon güncelleniyor…');
  await St.regenerate();
  assert.equal($('busy').hidden, true, 'busy cleared');
});

test('fitWrap: the guide it confirmed at 0.4 mm is shown as is, not built a second time; the same as a fresh build', async () => {
  await bar('d6-fit');
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2 }, { off: 15, yaw: 0, pitch: 0, w: 1.2 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.settled();
  const f = await St.fitWrap(); assert.ok(f && f.ok, 'fit found: ' + JSON.stringify(S.fitLog));
  const b0 = St.guideBuilds(); await St.settled();
  assert.equal(St.guideBuilds() - b0, 0, 'no second build after the fit');
  const kept = { pieces: S.result.pieces, tris: St.parts.guide.obj.geometry.index.count };
  await St.regenerate();
  assert.equal(St.guideBuilds() - b0, 1, 'a later rebuild builds');
  assert.equal(S.result.pieces, kept.pieces); assert.equal(St.parts.guide.obj.geometry.index.count, kept.tris, 'identical guide');
});

test('P1: the post-op cut plane normal is exact on a long thin face, from a guess 35° off', () => {
  const n = V(0.3, -0.2, 0.93).normalize(), a = V(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize(), b = n.clone().cross(a);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const pts = []; for (let i = 0; i < 400; i++) pts.push(a.clone().multiplyScalar(rnd() * 30).addScaledVector(b, rnd() * 3));
  const r = W.PostOp.planeFit(pts, n.clone().applyAxisAngle(a, 0.6));
  assert.ok(r.angleTo(n) < 1e-9, 'angle error ' + r.angleTo(n));
  assert.ok(W.PostOp.planeFit(pts, n.clone().negate()).dot(n) < 0, 'oriented like the guess');
});

test('S1: a pending autosave goes to the case that was open when a new scan is loaded', async () => {
  srv.drafts = []; srv.creates = 0;
  await bar('d6-first'); await sleep(50);
  W.CaseStore.setAutosave(true);
  await W.CaseStore.saveNow(); await sleep(20);
  const first = srv.drafts.at(-1).id; srv.drafts = [];
  S.planes = [{ off: -12, yaw: 0, pitch: 0, w: 1.2, ok: false }]; St.emit('changed'); await sleep(400);   // snapshot -> queued, not yet sent
  await bar('d6-second'); await sleep(1300);
  assert.ok(srv.drafts.length >= 1, 'the queued draft was saved');
  assert.ok(srv.drafts.every(d => d.id === first), 'only into the first case: ' + JSON.stringify(srv.drafts.map(d => d.id)));
  assert.equal(srv.creates, 1, 'no case was made for the second scan by the old draft');
});

test('S2: overlapping saves while the case is being created make one case', async () => {
  await bar('d6-third'); await sleep(50);
  srv.creates = 0; srv.drafts = []; srv.createDelay = 150;
  await Promise.all([W.CaseStore.saveNow(), W.CaseStore.saveNow()]);
  srv.createDelay = 0;
  assert.equal(srv.creates, 1, 'one case');
  assert.equal(new Set(srv.drafts.map(d => d.id)).size, 1, 'both drafts in it');
});

await run('external audit fixes (approval round trip, busy, autosave races)');
await new Promise(r => process.stdout.write('', r)); process.exit(process.exitCode || 0);
