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
// a point on the anterior (-y in LPS) surface of the tibia, 5 mm above its centre (the cut and both wires > 5 mm from
// the plafond; lower, the lower wire nears the joint, see the joint test)
const zA = tib.c.z + 5, start = new T.Vector3(tib.c.x, tib.c.y, zA);
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
  assert.ok(!G.checks().some(c => c[0] === 'crit'), JSON.stringify(G.checks()) + JSON.stringify(G.info().joint) + ' P ' + Pt.toArray());
  // the slot: no guide vertex lies within the kerf half-width of the cut plane inside the body's middle (the bridge
  // ribs that hold the body together across the slot run along its +v / -v edges, outside |v| < 5 mm)
  const f = G.frame(), pl = G.cutPlane(f), pos = G.parts().guide.geometry.attributes.position.array; let inSlot = 0;
  for (let i = 0; i < pos.length; i += 3) { const v = new T.Vector3(pos[i], pos[i + 1], pos[i + 2]), d = v.clone().sub(pl.p); if (Math.abs(d.dot(pl.N)) < 0.2 && d.length() < 8 && Math.abs(d.dot(f.v)) < 5) inSlot++; }
  assert.equal(inSlot, 0, 'slot open at the guide centre');
});
test('wedge: opening = depth x tan(angle), width and depth those of the tibia section', () => {
  const w = G.info().wedge; assert.ok(w); near(w.open, w.depth * Math.tan(8 * Math.PI / 180), 0.05);
  assert.ok(w.depth > 15 && w.depth < 50, `depth ${w.depth}`); assert.ok(w.width > 15 && w.width < 50, `width ${w.width}`);
  const pos = G.parts().wedge.geometry.attributes.position; assert.ok(pos.count > 100);
});
test('package: without a production STL the guide goes in as a preview named not to be printed, with the wedge', () => {
  const names = G.files().map(f => f.name); assert.deepEqual([...names], ['guide/kesi_guide_onizleme_BASMAYIN.stl', 'guide/kama.stl']);
  assert.ok(G.checks().some(c => c[0] === 'warn' && /üretim STL'i alınmadı/.test(c[2])));
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
// the joint (plan 3.5): the cut and the K-wires keep 5 mm (sample threshold) from the articular surface, the tibia's
// surface within 4 mm of the talus. The joint check was missing: a guide 10 mm lower passed with a wire 4.9 mm from it.
test('joint: the cut and the wires are measured against the plafond; > 5 mm here, no joint check is critical', () => {
  const jt = G.info().joint; assert.ok(jt && jt.n > 50, JSON.stringify(jt));
  assert.ok(jt.slot > 5, `slot ${jt.slot}`); jt.pins.forEach(p => { assert.ok(p && p.d > 5 && !p.talus, JSON.stringify(p)); });
  assert.ok(!G.checks().some(c => /eklem/.test(c[2])), JSON.stringify(G.checks()));
});
test('joint: a guide 10 mm lower brings the lower wire within 5 mm of the plafond: critical', async () => {
  const P0 = G.state().P.slice(), n0 = G.state().n.slice();
  let Q = null; const s0 = new T.Vector3(tib.c.x, tib.c.y, tib.c.z - 5); for (let t = 0; t < 40; t += 0.1) { const q = s0.clone().add(new T.Vector3(0, -t, 0)); if (A.sdfAt(tib, q) > 0) { Q = q; break; } }
  G.place(tib, Q, new T.Vector3(0, -1, 0)); await G.make();
  assert.ok(G.checks().some(c => c[0] === 'crit' && /Alt K-teli eklem yüzeyine/.test(c[2])), JSON.stringify(G.checks()));
  // the cut moved down onto the joint: the saw is critical too
  G.set('off', -12); await G.make();
  assert.ok(G.checks().some(c => c[0] === 'crit' && /Testere kesisi eklem yüzeyine/.test(c[2])), JSON.stringify(G.checks()));
  G.place(tib, new T.Vector3(...P0), new T.Vector3(...n0)); G.set('off', 0); await G.make();
  assert.ok(!G.checks().some(c => c[0] === 'crit'), JSON.stringify(G.checks()));
});
// one frame (plan 3.3): a guide on a moved piece is written where that piece is in the reduced model, not at its CT place
test('frame: the guide and wedge STLs follow their piece into the reduced model (vertex = reduced piece surface)', () => {
  const i = A.pieces().indexOf(tib), q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), 0.2), t = new T.Vector3(3, -2, 1);
  A.setMotion(i, t, q, true);
  try {
    const stl = G.files()[0].data, dv = new DataView(stl.buffer, stl.byteOffset), g0 = G.parts().guide.geometry.attributes.position.array;
    // the first triangle's first vertex: the preview's vertex moved by the tibia's motion
    const v = new T.Vector3(dv.getFloat32(84 + 12, true), dv.getFloat32(84 + 16, true), dv.getFloat32(84 + 20, true));
    const I = G.parts().guide.geometry.index.array, w = A.toWorld(tib, new T.Vector3().fromArray(g0, 3 * I[0]));
    assert.ok(v.distanceTo(w) < 1e-3, `${v.toArray()} vs ${w.toArray()}`);
    const fr = JSON.parse(A.frameJSON()); assert.ok(fr.parcalar.find(p => p.ad === 'Tibia').tasindi);
  } finally { A.setMotion(i, new T.Vector3(), new T.Quaternion(), true); }
  const stl = G.files()[0].data, dv = new DataView(stl.buffer, stl.byteOffset), g0 = G.parts().guide.geometry.attributes.position.array, I = G.parts().guide.geometry.index.array;
  near(dv.getFloat32(84 + 12, true), g0[3 * I[0]], 1e-4, 'unmoved: the CT position');
});
test('plan round trip: placement and settings restored, the guide is built again by the user', () => {
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankGuide.get())); assert.equal(x.piece, 'Tibia'); assert.equal(x.prm.pinDu, 11);
  W.PlanExt.ankGuide.set(null); assert.equal(G.state(), null);
  W.PlanExt.ankGuide.set(x); assert.deepEqual(G.state().P, x.P); assert.equal(G.ready(), false);
  const bad = JSON.parse(JSON.stringify(x)); bad.prm.deg = 99; W.PlanExt.ankGuide.set(bad); assert.equal(G.state().prm.deg, 20, 'clamped');
});

await run('ankle cutting guide');
