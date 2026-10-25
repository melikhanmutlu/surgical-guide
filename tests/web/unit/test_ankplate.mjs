// External plate on the corrected tibia (web/ankplate.js) on the synthetic ankle: the plate lies on the corrected bone
// over the opened cut, holes over and under the cut, the distal screws square to the turned distal tibia, screw lengths
// from the system's set past the far cortex; a hole too near the cut is critical; a changed angle asks for a rebuild;
// the package gets the plate and its screw list; the settings go through the plan.
// Run: node test_ankplate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('ankguide.js'); P.load('ankcorr.js'); P.load('ankplate.js');
const A = W.Ankle, G = W.AnkGuide, C = W.AnkCorr, PL = W.AnkPlate;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0);
const tib = A.pieces().find(p => p.name === 'Tibia'), tal = A.pieces().find(p => p.role === 'talus');
const zA = tib.c.z + 5, start = new T.Vector3(tib.c.x, tib.c.y, zA);
let Pt = null; for (let t = 0; t < 40; t += 0.1) { const q = start.clone().add(new T.Vector3(0, -t, 0)); if (A.sdfAt(tib, q) > 0) { Pt = q; break; } }
G.place(tib, Pt, new T.Vector3(0, -1, 0));
G.set('deg', 8);

// the corrected surface's vertices (tibia's own coordinates) and the planes
// the cap where the bone leaves the CT volume (top of the sample) is not a CT surface: left out
const gb = (tib.mesh.geometry.computeBoundingBox(), tib.mesh.geometry.boundingBox), cap = x => x.z > gb.max.z - 1.5;
const verts = m => { const p = m.geometry.attributes.position.array, o = []; for (let i = 0; i < p.length; i += 3) o.push(new T.Vector3(p[i], p[i + 1], p[i + 2])); return o; };


test('no plate before it is made', () => { assert.equal(PL.ready(), false); assert.equal(PL.files().length, 0); assert.equal(PL.checks().length, 0); });
// the synthetic tibia ends 28 mm over the cut (the sample's top): two holes over the cut keep the plate on bone
test('plate: one body over the cut, 2 + 3 holes reaching the bone, lengths from the 3.5 mm set', async () => {
  PL.set('nP', 2); await PL.make(); assert.ok(C.visible(), 'the corrected shape is made and shown first');
  const info = PL.info(); assert.ok(info, 'built'); assert.equal(info.pieces, 1); assert.ok(info.volume > 300, `volume ${info.volume}`); assert.ok(info.contact > 100, `contact ${info.contact}`);
  const sc = PL.parts().screws; assert.equal(sc.length, 5); sc.forEach(s => { assert.ok(s.entry && s.ok && s.run, JSON.stringify({ side: s.side, i: s.i, ok: s.ok })); assert.ok(PL.SYS.s35.lens.includes(s.run.L), `L ${s.run.L}`); assert.ok(s.run.L >= s.run.need - 1e-6); });
  assert.ok(St.parts.ankPlate && St.parts.ankPlate.visible, 'shown with the preview');
});
test('distal screws are square to the turned distal tibia; proximal ones to the proximal', () => {
  const o = C.result().o, n = G.frame().n, R = new T.Matrix3().setFromMatrix4(o.M), nD = n.clone().applyMatrix3(R).normalize();
  PL.parts().screws.forEach(s => { const want = (s.side > 0 ? n : nD).clone().negate(); assert.ok(s.dir.angleTo(want) < 1e-6, `${s.side}`); });
  near(PL.parts().screws.find(s => s.side < 0).dir.angleTo(n.clone().negate()) * 180 / Math.PI, 8, 1e-6);
});
test('the plate lies on the corrected bone: its inner face at the planned gap, the body on both sides of the cut', () => {
  const o = C.result().o, fd = C.field(o, true), p = PL.parts().mesh.geometry.attributes.position.array, q = PL.state().prm;
  // (the side walls' top edges stand further off where the round tibia drops away under the plate's flat width)
  let n = 0, inside = 0, far = 0, up = 0, dn = 0; const x = new T.Vector3();
  for (let i = 0; i < p.length; i += 3) { x.set(p[i], p[i + 1], p[i + 2]); const d = fd(x); n++; if (d < -0.3) inside++; if (d > q.gap + q.t + 3) far++; const z = x.clone().sub(o.pl.p).dot(o.N); if (z > 5) up++; if (z < -5) dn++; }
  assert.ok(inside / n < 0.01, `${inside}/${n} vertices in the bone`); assert.ok(far / n < 0.05, `${far}/${n} vertices off the bone`); assert.ok(up > 100 && dn > 100, `up ${up} down ${dn}`);
});
test('a hole within 5 mm of the cut is critical (sample threshold); 10 mm is not', async () => {
  assert.ok(!PL.checks().some(c => c[0] === 'crit' && /osteotomiye/.test(c[2])), JSON.stringify(PL.checks()));
  PL.set('first', 6); await PL.make();
  assert.ok(PL.checks().some(c => c[0] === 'crit' && /osteotomiye/.test(c[2])), JSON.stringify(PL.checks()));
  PL.set('first', 10); await PL.make();
});
test('the angle changes: the plate is stale and asks for a rebuild', async () => {
  G.set('deg', 10); assert.equal(PL.ready(), false); assert.ok(PL.checks().some(c => /yeniden oluşturun/.test(c[2])));
  await C.toggle(true); await PL.make(); assert.ok(PL.ready());
  const nD = PL.parts().screws.find(s => s.side < 0).dir; near(nD.angleTo(G.frame().n.clone().negate()) * 180 / Math.PI, 10, 1e-6);
  G.set('deg', 8); await C.toggle(true); await PL.make();
});
test('package: the preview plate named not to print and the screw list; the plate an approval item', () => {
  const fs_ = PL.files(); assert.deepEqual([...fs_.map(f => f.name)], ['plak/plak_onizleme_BASMAYIN.stl', 'plak/plak_vidalari.csv']);
  const csv = fs_[1].data.split('\n'); assert.equal(csv.length, 6); assert.match(csv[0], /^taraf;no;cap_mm;boy_mm/);
  assert.ok(A.items().some(i => i.k === 'plate'), JSON.stringify(A.items().map(i => i.k)));
  assert.ok(PL.checks().some(c => c[0] === 'warn' && /üretim STL'i alınmadı/.test(c[2])));
});
test('preview turned off: the plate is hidden with it', async () => {
  await C.toggle(false); assert.equal(St.parts.ankPlate, undefined); await C.toggle(true); assert.ok(St.parts.ankPlate);
});
// the production request: the corrected bone (gap filled) resampled on the reduced grid around the plate, no CT
// threshold (the distal tibia has moved). It failed in the page once: geom.js's G was looked for on window.
test('production: the server gets the corrected bone on the reduced grid, bone in the opened gap, no threshold', async () => {
  const keep = St.serverGuide; let req = null;
  St.serverGuide = async c => { req = c; return { stl: St.stlOf(PL.parts().mesh), productionOk: true, watertight: true, bodies: 1, volume: PL.info().volume, issues: [] }; };
  try { await PL.production(); } finally { St.serverGuide = keep; }
  assert.ok(req, 'request sent'); assert.equal(req.thr, null); assert.equal(req.F.length, St.S.red.nx * St.S.red.ny * St.S.red.nz);
  const o = C.result().o, x = o.hinge.clone().addScaledVector(o.a, o.depth * 0.6).addScaledVector(o.N, -o.depth * 0.6 * Math.tan(o.th) / 2);
  const ic = P.eval('G').indexOf(St.S.red, [x.x, x.y, x.z]).map(Math.round), r = St.S.red;
  assert.equal(req.F[ic[0] + r.nx * (ic[1] + r.ny * ic[2])], 1, 'the gap is bone in the production field');
  assert.ok(PL.files()[0].name === 'plak/plak.stl', PL.files()[0].name);
});
test('plan round trip: system and sizes restored, clamped; the plate is built again by the user', () => {
  PL.set('sys', 's27'); PL.set('W', 14);
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankPlate.get())); assert.equal(x.sys, 's27'); assert.equal(x.prm.W, 14);
  W.PlanExt.ankPlate.set(null); assert.equal(PL.state(), null);
  x.prm.nP = 9; W.PlanExt.ankPlate.set(x); assert.equal(PL.state().sys, 's27'); assert.equal(PL.state().prm.nP, 5, 'clamped'); assert.equal(PL.ready(), false);
});

// Denetim 7 (2026-10-25): a plate (or guide) in the plan that is not built for the plan as it is now (a setting changed,
// the case reopened) used to drop out of the approval items and of the package without a word: the package then went
// out with neither the plate STL nor its screw list. It is now an item that waits for the rebuild and cannot be approved.
test('a planned plate not built (reopened case): a pending item that cannot be approved; built again it is an approval item', async () => {
  assert.ok(PL.state() && !PL.ready());
  const it = A.items().find(i => i.k === 'plate');
  assert.ok(it && it.due, JSON.stringify(A.items()));
  assert.equal(A.itemOk(it), false);
  assert.ok((W.PendingHooks || []).flatMap(f => f()).includes('Dış plak'));
  P.eval(`document.getElementById('surgeon') || (() => { const i = document.createElement('input'); i.id = 'surgeon'; document.body.appendChild(i); return i; })()`).value = 'Dr Test';
  assert.equal(A.approveItem('plate'), false, 'not approvable before the rebuild');
  assert.equal(PL.files().length, 0);
  PL.set('sys', 's35'); PL.set('nP', 2); PL.set('nD', 2); await C.toggle(true); await PL.make(); assert.ok(PL.ready());
  const it2 = A.items().find(i => i.k === 'plate'); assert.ok(it2 && !it2.due);
  const ok2 = A.approveItem('plate'); assert.ok(ok2, JSON.stringify([it2, PL.checks().filter(c => c[0] === 'crit'), P.eval("(document.getElementById('ankApprMsg') || {}).textContent")])); assert.ok(A.itemOk(A.items().find(i => i.k === 'plate')));
  // a guide that is placed but not built for the current plan is pending in the same way
  G.set('off', (G.state().prm.off || 0) + 2);
  const g = A.items().find(i => i.k === 'guide'); assert.ok(!G.ready() && g && g.due, JSON.stringify(A.items().map(i => [i.k, !!i.due])));
});

await run('ankle external plate');
