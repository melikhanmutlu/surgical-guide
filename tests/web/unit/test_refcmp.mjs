// Malleolar fracture, plan M9: the reference guide comparison (web/refcmp.js) on the synthetic ankle. The studio's own
// guide, written as STL, stands in for a guide from another program:
// - loaded where it was built: recognised as the same CT (moved < 1 mm, < 1°), its inner face at its clearance;
// - lifted 2 mm off the bone and tilted 5°: fitted back to the bone, its vertices within 1 mm (median) of where it
//   was built (a lift and a wider clearance look alike on a round bone: the clearance is read as 0-1 mm);
// - the wedge's angle read from its two large faces is the planned angle ± 0.3°;
// - ASCII STL reads the same as binary.
// Run: node test_refcmp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { saveAcc } from './lib/acc.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, W = P.g;
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankmirror.js'); P.load('ankguide.js'); P.load('metrics.js'); P.load('refcmp.js');
const A = W.Ankle, G = W.AnkGuide, RC = W.RefCmp;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
G.suggest(); await G.make();
const stl = St.stlOf(G.parts().guide), P0 = RC.parseStl(stl);
const acc = {};

// the STL moved: x' = R (x - c) + c + t
function moved(Pa, deg, axis, t) {
  const n = Pa.length / 3; let c = [0, 0, 0]; for (let i = 0; i < Pa.length; i += 3) { c[0] += Pa[i]; c[1] += Pa[i + 1]; c[2] += Pa[i + 2]; } c = c.map(v => v / n);
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(...axis).normalize(), deg * Math.PI / 180), out = new Float32Array(Pa.length), x = new T.Vector3();
  for (let i = 0; i < Pa.length; i += 3) { x.set(Pa[i] - c[0], Pa[i + 1] - c[1], Pa[i + 2] - c[2]).applyQuaternion(q).add(new T.Vector3(c[0] + t[0], c[1] + t[1], c[2] + t[2])); out[i] = x.x; out[i + 1] = x.y; out[i + 2] = x.z; }
  return out;
}
function toBinary(Pa) {
  const n = Pa.length / 9, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf); dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + 50 * t + 12 + 4 * k, Pa[9 * t + k], true);
  return new Uint8Array(buf);
}
const errOf = (Pa, a) => { const d = [], x = new T.Vector3(); for (let i = 0; i < Pa.length; i += 27) { x.set(Pa[i], Pa[i + 1], Pa[i + 2]).applyQuaternion(a.q).add(a.t); d.push(Math.hypot(x.x - P0[i], x.y - P0[i + 1], x.z - P0[i + 2])); } d.sort((u, v) => u - v); return d[Math.floor(d.length / 2)]; };

test('as built: the same CT (moved < 1 mm, < 1°), seated on the tibia at its clearance', () => {
  const r = RC.load(stl, 'kendi.stl'); assert.ok(r && r.a, JSON.stringify(r && r.why));
  assert.equal(r.a.piece.name, 'Tibia'); assert.equal(r.a.same, true, `moved ${r.a.move} mm ${r.a.angle}°`);
  near(r.a.off, 0.3, 0.25, 'clearance'); assert.ok(r.a.med < 0.3, `spread ${r.a.med}`);
  assert.ok(r.cmp && r.cmp.centre < 0.5, JSON.stringify(r.cmp && r.cmp.centre));
  console.log(`  (as built: moved ${r.a.move.toFixed(2)} mm ${r.a.angle.toFixed(2)}°, clearance ${r.a.off.toFixed(2)}, spread median ${r.a.med.toFixed(2)} p90 ${r.a.p90.toFixed(2)} mm)`);
});
// (a guide on a round shaft can slide along the shaft and turn about it and fit as well: the test moves it the ways the
// bone's surface pins down, off the bone and tilted)
test('lifted 2 mm off the bone and tilted 5°: fitted back, median vertex error < 1 mm', () => {
  const f = G.frame(), Pm = moved(P0, 5, f.v.toArray(), f.n.clone().multiplyScalar(2).toArray());
  const r = RC.load(toBinary(Pm), 'tasinmis.stl'); assert.ok(r && r.a, JSON.stringify(r && r.why));
  assert.equal(r.a.same, false); const e = errOf(Pm, r.a); acc.ref_fit_mm = e;
  console.log(`  (moved: recovered ${r.a.move.toFixed(2)} mm ${r.a.angle.toFixed(2)}°, median vertex error ${e.toFixed(2)} mm)`);
  assert.ok(e < 1, `error ${e}`); near(r.a.angle, 5, 0.5, 'angle');
});
test('wedge angle from its faces; ASCII STL', () => {
  const w = RC.wedgeAngleOf(RC.parseStl(St.stlOf(G.parts().wedge))); near(w, G.info().wedge.deg, 0.3, 'wedge'); acc.ref_wedge = w;
  const ascii = 'solid x\n' + Array.from({ length: P0.length / 9 }, (_, t) => `facet normal 0 0 0\nouter loop\n${[0, 1, 2].map(k => `vertex ${P0[9 * t + 3 * k]} ${P0[9 * t + 3 * k + 1]} ${P0[9 * t + 3 * k + 2]}`).join('\n')}\nendloop\nendfacet`).join('\n') + '\nendsolid x\n';
  const Pa = RC.parseStl(new TextEncoder().encode(ascii)); assert.equal(Pa.length, P0.length); near(Pa[100], P0[100], 1e-4);
});

await run('ankle M9 (reference guide comparison)');
saveAcc('refcmp', acc);
