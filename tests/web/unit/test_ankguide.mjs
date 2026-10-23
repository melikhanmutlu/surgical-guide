// Ankle cutting guide (web/ankguide.js) on the synthetic trimalleolar ankle sample: the guide placed on the anterior
// distal tibia gets a body, a saw slot and two K-wire sleeves that reach the bone; the wedge's opening is its depth times
// tan(angle); a wire that crosses the tilted cut is critical; settings changed after the build ask for a rebuild; the
// placement and settings go through the plan; the package carries the guide and the wedge.
// Run: node test_ankguide.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('ankguide.js');
const A = W.Ankle, G = W.AnkGuide;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0);
const tib = A.pieces().find(p => p.name === 'Tibia');
// a point on the anterior (-y in LPS) surface of the tibia, 20 mm above its lower end
const zA = tib.c.z - 5, start = new T.Vector3(tib.c.x, tib.c.y, zA);
let Pt = null; for (let t = 0; t < 40; t += 0.1) { const q = start.clone().add(new T.Vector3(0, -t, 0)); if (A.sdfAt(tib, q) > 0) { Pt = q; break; } }

test('placement: frame on the anterior tibia, n points out of the bone (anterior), u along the leg', () => {
  assert.ok(Pt, 'surface found');
  G.place(tib, Pt, new T.Vector3(0, -1, 0));
  const f = G.frame(); assert.equal(f.p.name, 'Tibia');
  assert.ok(f.n.y < -0.8, `n ${f.n.toArray()}`); assert.ok(Math.abs(f.u.z) > 0.9, `u ${f.u.toArray()}`);
  near(f.u.dot(f.v), 0, 1e-9); near(new T.Vector3().crossVectors(f.u, f.v).dot(f.n), 1, 1e-6);
});
test('guide: one body with a slot; both K-wires reach the bone and run > 10 mm in it; no critical check', async () => {
  await G.make();
  const info = G.info(); assert.ok(info, 'built'); assert.ok(G.ready());
  assert.equal(info.pieces, 1); assert.ok(info.volume > 1000, `volume ${info.volume}`); assert.ok(info.contact > 100, `contact ${info.contact}`);
  assert.equal(info.pins.length, 2); info.pins.forEach(p => { assert.ok(p.ok && p.entry, JSON.stringify(p)); assert.ok(p.inBone > 10, `in bone ${p.inBone}`); assert.equal(p.crosses, false); });
  assert.ok(!G.checks().some(c => c[0] === 'crit'), JSON.stringify(G.checks()));
  // the slot: no guide vertex lies within the kerf half-width of the cut plane inside the body's middle
  const pl = G.cutPlane(G.frame()), pos = G.parts().guide.geometry.attributes.position.array; let inSlot = 0;
  for (let i = 0; i < pos.length; i += 3) { const v = new T.Vector3(pos[i], pos[i + 1], pos[i + 2]), d = v.clone().sub(pl.p); if (Math.abs(d.dot(pl.N)) < 0.2 && d.length() < 8) inSlot++; }
  assert.equal(inSlot, 0, 'slot open at the guide centre');
});
test('wedge: opening = depth x tan(angle), width and depth those of the tibia section', () => {
  const w = G.info().wedge; assert.ok(w); near(w.open, w.depth * Math.tan(8 * Math.PI / 180), 0.05);
  assert.ok(w.depth > 15 && w.depth < 50, `depth ${w.depth}`); assert.ok(w.width > 15 && w.width < 50, `width ${w.width}`);
  const pos = G.parts().wedge.geometry.attributes.position; assert.ok(pos.count > 100);
});
test('package: the guide and the wedge go into the ankle package', () => {
  const names = G.files().map(f => f.name); assert.deepEqual([...names], ['guide/kesi_guide.stl', 'guide/kama.stl']);
  const n = new DataView(G.files()[0].data.buffer).getUint32(80, true); assert.ok(n > 500);
});
test('a setting changed after the build: the guide is stale, a rebuild is asked for', () => {
  G.set('deg', 10); assert.equal(G.ready(), false); assert.ok(G.checks().some(c => /yeniden oluşturun/.test(c[2])));
});
test('a wire crossing the tilted cut is critical', async () => {
  G.set('deg', 8); G.set('pinDu', 6); G.set('tiltA', 30); await G.make();
  assert.ok(G.checks().some(c => c[0] === 'crit' && /testere yarığını kesiyor/.test(c[2])), JSON.stringify(G.checks()));
  G.set('pinDu', 11); G.set('tiltA', 0); await G.make(); assert.ok(!G.checks().some(c => c[0] === 'crit'));
});
test('plan round trip: placement and settings restored, the guide is built again by the user', () => {
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankGuide.get())); assert.equal(x.piece, 'Tibia'); assert.equal(x.prm.pinDu, 11);
  W.PlanExt.ankGuide.set(null); assert.equal(G.state(), null);
  W.PlanExt.ankGuide.set(x); assert.deepEqual(G.state().P, x.P); assert.equal(G.ready(), false);
  const bad = JSON.parse(JSON.stringify(x)); bad.prm.deg = 99; W.PlanExt.ankGuide.set(bad); assert.equal(G.state().prm.deg, 20, 'clamped');
});

await run('ankle cutting guide');
