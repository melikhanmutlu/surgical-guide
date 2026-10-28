// Malleolar fracture case type on the built-in anonymised real ankle CT (web/sample_ankle_ct.json, plan 3.6):
// - the tibia and the talus, one threshold piece across the joint at 300 HU, are cut apart at the joint;
// - names: Tibia, Fibula, Talus once each; the calcaneus is not the talus and the navicular is not a "Medial malleol"
//   (both happened before 2026-10-23); the splint pieces are left out; the foot outside the ankle region is not listed;
// - the ankle region (talar dome +100 / -40 mm) can be changed and comes back with the plan;
// - a cutting guide on the anterior distal tibia: the cut and the K-wires are measured against the plafond, a guide on
//   the joint is critical; the package names the preview "BASMAYIN" and carries cerceve.json.
// Run: node test_ankle_real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const SAMP = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle_ct.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle_ct\./.test(url)) return { json: async () => SAMP }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g, G = P.eval('G');
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankmirror.js'); P.load('ankguide.js'); P.load('metrics.js'); P.load('refcmp.js');
const A = W.Ankle, AG = W.AnkGuide;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 300000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const named = n => A.pieces().filter(p => p.name === n);

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
const t0 = Date.now();
await St.loadSample('ankle_ct');
await until(() => A.pieces().length > 0 && !A.building());
const msLoad = Date.now() - t0;
console.log('  (pieces: ' + A.pieces().map(p => `${p.name} ${p.cm3.toFixed(1)}`).join(', ') + '; hysteresis pieces ' + JSON.stringify(S.compsAll.comps.filter(c => c.hys).map(c => [+(c.size * S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000).toFixed(1), G.worldOf(S.red, ...c.centroid).map(Math.round)])) + ')');

test('joint cut: the threshold piece of tibia + talus is cut in two at the joint', () => {
  assert.match(S.segMethod, /eklem ayırma/);
  const tib = named('Tibia')[0], tal = named('Talus')[0];
  assert.ok(tib && tal, A.pieces().map(p => p.name).join(','));
  assert.ok(tib.cm3 > 40 && tib.cm3 < 70, `tibia ${tib.cm3}`); assert.ok(tal.cm3 > 20 && tal.cm3 < 40, `talus ${tal.cm3}`);
  // the talus lies under the tibia (LPS: +z is up), within the tibia's footprint, not behind the ankle as the calcaneus
  assert.ok(tal.c.z < tib.c.z - 30, `talus z ${tal.c.z} tibia z ${tib.c.z}`);
  assert.ok(Math.hypot(tal.c.x - tib.c.x, tal.c.y - tib.c.y) < 15, `talus ${tal.c.toArray()} tibia ${tib.c.toArray()}`);
});
test('names: one tibia, fibula and talus; no malleolar fragment named on this CT (navicular, calcaneus are not)', () => {
  ['Tibia', 'Fibula', 'Talus'].forEach(n => assert.equal(named(n).length, 1, n));
  ['Medial malleol', 'Lateral malleol', 'Posterior malleol'].forEach(n => assert.equal(named(n).length, 0, `${n}: ${JSON.stringify(named(n).map(p => [p.cm3, p.c.toArray()]))}`));
  // the calcaneus (34 cm³, behind and below the talus) is named "Kalkaneus" (Melikhan 2026-10-28), and is the only one
  const calc = A.pieces().find(p => p.cm3 > 30 && p.cm3 < 40 && p.role === 'other');
  assert.ok(calc, A.pieces().map(p => `${p.name} ${p.cm3.toFixed(1)}`).join(', '));
  assert.equal(calc.name, 'Kalkaneus'); assert.equal(named('Kalkaneus').length, 1);
  assert.ok(A.pieces().filter(p => p.role === 'out').length >= 3, 'splint pieces left out');
  assert.equal(A.meta().side, 'R');
});
// Melikhan 2026-10-28: in the Anatomy step only the planning bone (the tibia, Yapı 1) was shown; the fibula, talus and
// calcaneus were hidden, so the two leg bones could not be seen side by side
test('Anatomy step: the fibula, talus and calcaneus are shown beside the planning bone (tibia)', () => {
  const st2 = P.doc.getElementById('st2'); st2.open = true; (st2.listeners.toggle || []).forEach(f => f({ target: st2 }));
  const vis = n => { const i = A.pieces().findIndex(p => p.name === n); const pt = St.parts['ank' + i]; return !!(pt && pt.visible && pt.obj.visible); };
  assert.ok(St.parts.bone.visible, 'planning bone shown');
  assert.ok(S.selected.has(named('Tibia')[0].label) && !S.selected.has(named('Fibula')[0].label), 'planning bone is the tibia only');
  assert.equal(vis('Tibia'), false, 'the tibia is the planning bone itself');
  ['Fibula', 'Talus', 'Kalkaneus'].forEach(n => assert.ok(vis(n), `${n} shown`));
  assert.ok(A.pieces().every((p, i) => p.role !== 'out' || !St.parts['ank' + i].visible), 'splint stays hidden');
  st2.open = false; (st2.listeners.toggle || []).forEach(f => f({ target: st2 }));
  assert.equal(St.parts.bone.visible, false); assert.ok(vis('Tibia') && vis('Fibula'));
});
test('region: talar dome found; the foot below the region (navicular, cuneiforms) is not listed; nothing dropped silently', () => {
  const ri = A.roiInfo(); assert.equal(ri.talus, true); assert.equal(ri.bilateral, false);
  assert.ok(ri.outRoi >= 4, `out of region ${ri.outRoi}`); assert.equal(ri.capped, 0);
  // no listed piece lies mostly below the region: the navicular (centre 47 mm in front of the talus) is gone
  assert.ok(!A.pieces().some(p => p.c.y < -40 && p.c.z < -30), A.pieces().map(p => `${p.name} ${p.c.toArray().map(Math.round)}`).join('; '));
  assert.ok(A.pieces().length <= 16);
});
test('region: a larger region lists the foot bones as "Diğer kemik"; it is saved with the plan and comes back', async () => {
  const n0 = A.pieces().length;
  A.setRoi({ above: 100, below: 90 }); await until(() => !A.building() && A.roi().below === 90 && A.pieces().length > 0);
  assert.ok(A.pieces().length > n0, `${A.pieces().length} > ${n0}`);
  assert.equal(named('Medial malleol').length, 0, 'the navicular is still not a malleolus');
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankle.get())); assert.deepEqual(x.roi, { above: 100, below: 90, side: '' });
  A.setRoi({ above: 100, below: 40 }); await until(() => !A.building() && A.roi().below === 40);
  assert.equal(A.pieces().length, n0);
  W.PlanExt.ankle.set(x); await until(() => !A.building() && A.roi().below === 90);
  await until(() => A.pieces().length > n0);
  W.PlanExt.ankle.set(Object.assign({}, x, { roi: { above: 100, below: 40, side: '' } })); await until(() => !A.building() && A.roi().below === 40 && A.pieces().length === n0);
});

// plan M2 on the real CT (an intact joint: no fragment): the joint spaces are those of a normal ankle
test('joint measures: superior and medial clear space 1.5-5 mm, landmarks on the right ankle in place', () => {
  const r = W.AnkLM.result(); assert.ok(r && r.ct.ok, r && r.ct.why);
  const m = r.ct.m, L = r.ct.L;
  console.log(`  (SCS ${m.scs && m.scs.toFixed(2)} MCS ${m.mcs && m.mcs.toFixed(2)} TFCS ${m.tfcs && m.tfcs.toFixed(2)} mm; plafond points ${m.nPlaf}, facet ${m.nFacet})`);
  assert.ok(m.scs > 1.5 && m.scs < 5, `SCS ${m.scs}`); assert.ok(m.mcs > 1.5 && m.mcs < 5, `MCS ${m.mcs}`);
  assert.ok(m.tfcs != null && m.tfcs < 8, `TFCS ${m.tfcs}`);
  // right ankle: lateral is -x (LPS); the lateral malleolus reaches lower than the medial
  assert.ok(L.lmTip.x < L.mmTip.x, 'lateral tip lateral'); assert.ok(L.lmTip.z < L.mmTip.z, 'lateral malleolus lower');
  assert.ok(Math.abs(L.plafond.z - L.dome.z) < 6 && Math.hypot(L.plafond.x - L.dome.x, L.plafond.y - L.dome.y) < 15, `plafond centre at the dome ${JSON.stringify([L.plafond, L.dome].map(v => [v.x, v.y, v.z].map(a => +a.toFixed(1))))}`);
  assert.deepEqual([...W.AnkLM.checks()], [], 'no warnings before a reduction');
  // one leg in this CT: no mirror template, and the panel says so
  assert.match(P.doc.getElementById('ankMirror').innerHTML, /Karşı bacak BT'de yok/);
});

// the guide on the anterior distal tibia, 30 mm over the talar dome
const tib = () => named('Tibia')[0];
function anterior(zOver) {
  const r = S.red, zD = G.worldOf(r, 0, 0, A.roiInfo().kDome)[2], p = tib(), z = zD + zOver;
  // the tibia's centre at that height: mean of its surface vertices within 2 mm of z
  const pos = p.mesh.geometry.attributes.position.array; let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 2] - z) < 2) { sx += pos[i]; sy += pos[i + 1]; n++; }
  const s = new T.Vector3(sx / n, sy / n, z);
  // from 40 mm in front, inwards to the anterior cortex (the centre itself is in the medullary cavity)
  for (let t = 40; t > 0; t -= 0.1) { const q = s.clone().add(new T.Vector3(0, -t, 0)); if (A.sdfAt(p, q) <= 0.2) return q.add(new T.Vector3(0, -0.3, 0)); }
  return null;
}
test('guide on the anterior distal tibia 30 mm over the dome: built, the cut and wires > 5 mm from the plafond', async () => {
  const Pt = anterior(30); assert.ok(Pt, 'surface');
  AG.place(tib(), Pt, new T.Vector3(0, -1, 0)); const t1 = Date.now(); await AG.make(); const ms = Date.now() - t1;
  const info = AG.info(); assert.ok(AG.ready() && info.pieces === 1, JSON.stringify(info && info.pieces));
  const jt = info.joint; assert.ok(jt && jt.n > 100, JSON.stringify(jt));
  assert.ok(jt.slot > 5, `slot ${jt.slot}`); jt.pins.forEach(p => assert.ok(p && p.d > 5 && !p.talus, JSON.stringify(p)));
  assert.ok(!AG.checks().some(c => c[0] === 'crit'), JSON.stringify(AG.checks()));
  console.log(`  (guide ${ms} ms; load ${msLoad} ms; joint ${jt.n} pts, cut ${jt.slot.toFixed(1)} mm, wires ${jt.pins.map(p => p.d.toFixed(1)).join(' / ')} mm)`);
});
test('guide 8 mm over the dome: the cut reaches the joint, critical', async () => {
  const keep = AG.state();
  const Pt = anterior(8); AG.place(tib(), Pt, new T.Vector3(0, -1, 0)); await AG.make();
  assert.ok(AG.checks().some(c => c[0] === 'crit' && /eklem yüzeyine/.test(c[2])), JSON.stringify(AG.checks()));
  W.PlanExt.ankGuide.set(keep); await AG.make();
});
test('package: preview named BASMAYIN, the wedge, and cerceve.json with the frame and every piece motion', () => {
  const names = AG.files().map(f => f.name); assert.deepEqual([...names], ['guide/kesi_guide_onizleme_BASMAYIN.stl', 'guide/kama.stl']);
  const fr = JSON.parse(A.frameJSON()); assert.match(fr.frame, /LPS/); assert.ok(fr.parcalar.some(p => p.ad === 'Talus'));
  assert.ok(fr.parcalar.every(p => p.t.length === 3 && p.q.length === 4));
});

// plan M6.1 on the real CT: the automatic placement gives a guide with no critical check
test('automatic placement on the real CT: no critical check', async () => {
  const keep = AG.state(); const r = AG.suggest(); assert.ok(!r.why, r.why); await AG.make();
  const crit = AG.checks().filter(c => c[0] === 'crit'); console.log(`  (suggested ${r.height} mm over the dome, turned ${r.angle}°, cover ${(r.cover * 100).toFixed(0)} %; seat p50 ${AG.info().fit && AG.info().fit.p50.toFixed(2)} p99 ${AG.info().fit && AG.info().fit.p99.toFixed(2)} mm)`);
  assert.equal(crit.length, 0, JSON.stringify(crit));
  W.PlanExt.ankGuide.set(keep); await AG.make();
});
// plan M9 on the real CT: the reference guide made in another program (anonymised project data, not in the repository)
const REF = '/mnt/project-files/surgical-guide-prototype/audit/denetim5/veri/malleol_ref_guide.stl', REFW = REF.replace('guide.stl', 'wedge.stl');
// The project's reference guide lies 13-20 mm off every bone of this CT (in LPS and in RAS) and no rigid pose seats more
// than a tenth of it: it was not made on this CT (or not in its coordinates). The comparison must say so, not force a fit.
test('reference guide (when the project file is there): seated on the bone, or reported as not from this CT', () => {
  if (!fs.existsSync(REF)) { console.log('  (reference guide file not present: skipped)'); return; }
  const r = W.RefCmp.load(new Uint8Array(fs.readFileSync(REF)), 'ref.stl'); assert.ok(r, 'result');
  if (fs.existsSync(REFW)) W.RefCmp.loadWedge(new Uint8Array(fs.readFileSync(REFW)), 'refw.stl');
  if (!r.a) { console.log(`  (reference: ${r.why})`); assert.match(r.why, /aynı BT/); return; }
  const a = r.a, c = r.cmp;
  console.log(`  (reference: on ${a.piece.name}, ${a.same ? 'as loaded (same CT)' : `moved ${a.move.toFixed(1)} mm ${a.angle.toFixed(1)}°`}, clearance ${a.off.toFixed(2)} mm, spread median ${a.med.toFixed(2)} p90 ${a.p90.toFixed(2)} mm, n ${a.n}; vs studio guide: centres ${c ? c.centre.toFixed(1) : '-'} mm)`);
  assert.ok(a.med < 1, `median ${a.med}`);
});

await run('ankle, real CT sample');
