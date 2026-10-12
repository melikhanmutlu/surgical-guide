// Long resections and the condyle (plan-4 A1, A2, B1, B2, B4) through window.Studio on synthetic bone (no patient data):
// the connecting bar between two guides (lugs on both pieces, a closed separate mesh clear of the bone), when two guides
// and a bar are proposed (longCase: lesion length, straight axis leaving the bone), the posterior stop of a ramus guide,
// and web/condyle.js (new condyle offset moves the graft end, warning above 10 mm, screw places on a kept condyle's
// stump, condyle position against the other condyle).
// Run: node test_longres.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

const P = studio({ post: ['condyle.js', 'bridge.js'] }); const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G');
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function idle(ms = 200, timeout = 300000) {
  const t0 = performance.now(); let since = null;
  while (performance.now() - t0 < timeout) {
    const ok = P.doc.getElementById('busy').hidden && (!S.guideOn || St.live.shown >= St.live.ver);
    if (ok) { if (since === null) since = performance.now(); if (performance.now() - since >= ms) return; } else since = null;
    await sleep(40);
  }
  throw new Error('timeout waiting for idle');
}
async function volume(bone, box) {
  const sp = [0.8, 0.8, 0.8], nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bone(origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2])) hu[i + nx * (j + ny * k)] = 1200;
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, St.AUTO_DEFAULT); S.fitLog = []; S.result = null;
  Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null, ok: false });
}
// a 45 mm radius arc in the x-z plane (elliptical section 8 x 7, top at x = 0) and a straight bar along x (top z = 0)
const ARC = (x, y, z) => { const r = Math.hypot(x, z + 45), th = Math.atan2(x, z + 45); if (Math.abs(th) > 1.25) return false; const d = 45 - 7 - r; return (y / 8) ** 2 + (d / 7) ** 2 < 1; };
const STRAIGHT = (x, y, z) => Math.abs(x) < 48 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1;
function setPlan(offs, o = {}) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = offs.map(off => ({ off, yaw: 0, pitch: 0, w: 1.2 }));
  S.g.split = o.split || 0; S.gAuto.split = 0; S.g.bar = o.bar ? 1 : 0; S.gAuto.bar = 0;
}
async function plan(offs, o) { setPlan(offs, o); S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate(); await idle(); }
// every edge of an indexed (or position-welded) triangle mesh is shared by exactly two triangles
function closed(geo) {
  const p = geo.attributes.position.array, key = i => `${p[3 * i].toFixed(4)},${p[3 * i + 1].toFixed(4)},${p[3 * i + 2].toFixed(4)}`, id = new Map(), vid = [];
  for (let i = 0; i < p.length / 3; i++) { const k = key(i); if (!id.has(k)) id.set(k, id.size); vid.push(id.get(k)); }
  const ix = geo.index ? geo.index.array : Array.from({ length: p.length / 3 }, (_, i) => i), E = new Map();
  for (let t = 0; t < ix.length; t += 3) for (let e = 0; e < 3; e++) { const a = vid[ix[t + e]], b = vid[ix[t + (e + 1) % 3]], k = a < b ? a + ',' + b : b + ',' + a; E.set(k, (E.get(k) || 0) + 1); }
  let bad = 0; for (const c of E.values()) if (c !== 2) bad++;
  return { bad, edges: E.size, verts: id.size };
}
const checks = () => { const out = []; (P.g.ExtraChecks || []).forEach(f => f().forEach(c => out.push(c))); return out; };
const ref = cond => { P.g.Ref = { get: () => ({ cond, n: [1, 0, 0], d: 0 }) }; };

test('bar (A2): two guides on the arc carry a lug each; the bar is a separate closed mesh clear of the bone and of the resected region', async () => {
  await volume(ARC, { x: 50, y: 24, z: 50 }); await plan([-25, 25], { split: 2, bar: true });
  const b = S.result.bar; assert.ok(b && b.ok, 'bar planned: ' + JSON.stringify(b && b.why));
  assert.equal(S.result.parts.length, 2); S.result.parts.forEach((p, i) => assert.ok(p.lug && p.lugOk, 'lug on piece ' + i));
  assert.ok(St.parts.bar && St.parts.bar.obj, 'bar part shown');
  const c = closed(St.parts.bar.obj.geometry); assert.equal(c.bad, 0, `bar mesh has ${c.bad} open/non-manifold edges of ${c.edges}`);
  assert.ok(b.clear >= St.BAR.clearBone - 0.5, 'clearance from bone ' + b.clear);
  // independent: no bar vertex within 1 mm of the bone (ARC itself, resected piece included)
  const p = St.parts.bar.obj.geometry.attributes.position.array; let hit = 0;
  for (let i = 0; i < p.length; i += 3) for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (ARC(p[i] + dx, p[i + 1] + dy, p[i + 2] + dz)) hit++;
  assert.equal(hit, 0, 'bar vertices within 1 mm of bone');
  assert.notEqual(b.route, 'buccal', 'a free inferior / lingual route exists on the arc');
  // the bar's ends rest on the lug pads (the rod starts on each pad's rim)
  b.spec.pads.forEach((pd, i) => assert.ok(b.spec.path[i ? b.spec.path.length - 1 : 0].distanceTo(pd.c) < pd.R + 0.01, 'rod end on pad ' + i));
  assert.ok(checks().some(c => c[0] === 'info' && /^Bağlantı köprüsü: /.test(c[2])), 'bar check line');
});

test('bar (A2): no bar unless two pieces; the bar switch alone on a one-piece layout says so', async () => {
  await plan([-25, 25], { split: 0, bar: true });
  assert.ok(!St.parts.bar, 'no bar part on a one-piece guide');
  assert.ok(checks().some(c => /yalnız iki guide'lı düzende/.test(c[2])));
});

test('longCase (A1): lesion >= 55 mm, the straight axis leaving the bone, none for a short straight segment', async () => {
  setPlan([-25, 25]); Object.assign(S.lesion, { from: -30, to: 30 });
  assert.equal(St.longCase().why, 'len');
  Object.assign(S.lesion, { from: -6, to: 6 }); assert.equal(St.longCase(), null, 'arc +-25: bone stays within reach of the straight axis');
  setPlan([-40, 40]); const lc = St.longCase(); assert.ok(lc && lc.why === 'axis', 'arc +-40 leaves the axis: ' + JSON.stringify(lc));
  assert.ok(Math.abs(lc.at) >= 25, 'first off-bone position ' + lc.at);
  await volume(STRAIGHT, { x: 50, y: 24, z: 20 }); setPlan([-40, 40]); assert.equal(St.longCase(), null, 'straight bar: one guide');
});

test('fitWrap (A1): a long lesion is proposed as two guides joined by the bar', async () => {
  await volume(ARC, { x: 50, y: 24, z: 50 }); setPlan([-28, 28]); Object.assign(S.lesion, { from: -28, to: 28 });
  Object.assign(S.gAuto, St.AUTO_DEFAULT); S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.fitWrap(); await St.regenerate(); await idle();
  assert.equal(S.g.split, 2, 'split'); assert.equal(S.g.bar, 1, 'bar'); assert.ok(S.result.bar && S.result.bar.ok, 'bar built: ' + JSON.stringify(S.result.bar && S.result.bar.why));
  assert.ok(checks().some(c => c[0] === 'info' && /^Uzun rezeksiyon: lezyon/.test(c[2])));
});

test('stopSides (B3): the posterior stop goes on the frame side that faces +y (posterior), only on a front-to-back v axis', () => {
  assert.deepEqual(Object.assign({}, St.stopSides({ stopP: 1 }, V(0, 1, 0))), { pos: true, neg: false });
  assert.deepEqual(Object.assign({}, St.stopSides({ stopP: 1 }, V(0, -1, 0))), { pos: false, neg: true });
  assert.deepEqual(Object.assign({}, St.stopSides({ stopP: 1 }, V(0, 0, 1))), { pos: false, neg: false });
  assert.deepEqual(Object.assign({}, St.stopSides({ stopT: 1 }, V(0, 0, 1))), { pos: true, neg: false });
});

test('new condyle (B2): the offset moves the graft end short of the fossa, > 10 mm warns, the report notes disc and fixation', async () => {
  await volume(STRAIGHT, { x: 50, y: 24, z: 20 }); ref({ R: [44, 0, -6], L: [-44, 0, -6] });
  setPlan([10]); S.lesion.condyle = 'R';
  const C = V(44, 0, -6);
  P.g.Condyle.setNeo(5); let E = St.resEnds(); near(E.B.p.distanceTo(C), 5, 1e-6, 'neo 5'); assert.ok(E.B.cond.distanceTo(C) < 1e-9, 'resected piece still found at the condyle');
  near(E.B.p.clone().sub(C).normalize().dot(St.planesWorld()[0].p.clone().sub(C).normalize()), 1, 1e-9, 'moved along the line to the cut');
  let cs = checks(); assert.ok(cs.some(c => c[0] === 'info' && /Eklem diski korunur; ameliyattan sonra en az 2 hafta/.test(c[2])));
  assert.ok(!cs.some(c => /fossadan .* uzakta/.test(c[2])), 'no warning at 5 mm');
  P.g.Condyle.setNeo(12); E = St.resEnds(); near(E.B.neo, 12, 1e-6);
  cs = checks(); assert.ok(cs.some(c => c[0] === 'warn' && /Yeni kondil fossadan 12(,0)? mm uzakta/.test(c[2])), 'warning above 10 mm');
  P.g.Condyle.setNeo(0); E = St.resEnds(); assert.ok(E.B.p.distanceTo(C) < 1e-9, 'neo 0: at the fossa');
  P.g.Condyle.setNeo(5);
  assert.equal(JSON.stringify(P.g.PlanExt.condyle.get()), 'null'); P.g.Condyle.setNeo(8); assert.equal(P.g.PlanExt.condyle.get().neo, 8);
  P.g.PlanExt.condyle.set({ neo: 99 }); assert.equal(P.g.Condyle.neoOffset(), 20, 'clamped');
  P.g.PlanExt.condyle.set(null); assert.equal(P.g.Condyle.neoOffset(), 5, 'a plan without the field reopens at the default (the plan hash stays the same)');
});

test('condyle position (B4): against the mirror of the other condyle, tolerance 4 mm with the condyle involved, 3 mm on the body', async () => {
  ref({ R: [44, 0, -6], L: [-41, 2, -6] }); setPlan([10]); S.lesion.condyle = 'R';
  let ps = P.g.Condyle.position(); near(ps.len, Math.hypot(3, 2), 1e-6); assert.equal(ps.tol, 4); near(ps.dx, 3, 1e-6);
  ref({ R: [70, 0, -6], L: [-68, 0, -6] }); S.lesion.condyle = null; setPlan([-12, 12]); ps = P.g.Condyle.position(); assert.equal(ps.tol, 3, 'body segment far from the condyles'); near(ps.len, 2, 1e-6);
  assert.ok(checks().some(c => c[0] === 'info' && /kondil konumu, diğer kondilin ayna görüntüsüne göre: 2(,0)? mm .*tolerans 3 mm\./.test(c[2])), checks().map(c => c[2]).join(' | '));
});

test('kept condyle (B1): a long stump takes >= 3 screws (info), a short one fewer (warning: keeping it may not be practical)', async () => {
  ref({ R: [44, 0, -6], L: [-44, 0, -6] }); S.lesion.condyle = null; setPlan([-12, 12]);
  let sp = P.g.Condyle.stumpPlaces(); assert.ok(sp, 'stump found'); assert.ok(sp.n >= 3, 'long stump screws ' + JSON.stringify(sp));
  assert.ok(checks().some(c => c[0] === 'info' && /güdüğünde \d+ vida yeri var/.test(c[2])));
  ref({ R: [24, 0, -6], L: [-44, 0, -6] }); sp = P.g.Condyle.stumpPlaces(); assert.ok(sp && sp.n < 3, 'short stump ' + JSON.stringify(sp));
  assert.ok(checks().some(c => c[0] === 'warn' && /Kondilin korunması pratik olmayabilir/.test(c[2])));
});

await run('long resection / bar / condyle');
