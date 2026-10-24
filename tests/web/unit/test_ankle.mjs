// Malleolar fracture case type (web/ankle.js) on the synthetic trimalleolar ankle sample (web/sample_ankle.json,
// surgiguide/phantom.py ankle_phantom): pieces and their names, the reduction back to the phantom's known displacement
// (no overlap, gaps close), an over-reduction flagged as critical, the plan round trip and its approval binding, the
// reduced model STL, the package gate, and the mandible flow's pending list untouched by the ankle hooks.
// Run: node test_ankle.mjs
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g, $ = id => P.doc.getElementById(id);
// casetype.js needs the page's step list; a stub holds the case type the way it does
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js');
const A = W.Ankle;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);
// the inverse of the phantom's displacement p' = R (p - c0) + c0 + t about the displaced centre c' = c0 + t: q = R^-1, -t
function reduceAll() {
  ANKLE.truth.forEach(tr => {
    const i = byName(tr.name); assert.ok(i >= 0, tr.name);
    const R = new T.Quaternion().setFromAxisAngle(new T.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180);
    A.setMotion(i, new T.Vector3(...tr.move).negate(), R.invert(), true);
  });
}

await until(() => !(St.loadBusy && St.loadBusy()));
const thr0 = $('thr') && $('thr').value;
W.CaseType.set('ankle');
const thrA = $('thr') && $('thr').value;
await St.loadSample('ankle');
await until(() => A.pieces().length > 0);

test('pieces: six bones named from where they lie; right side found from the fibula', () => {
  const names = [...A.pieces().map(p => p.name)].sort();
  assert.deepEqual(names, ['Fibula', 'Lateral malleol', 'Medial malleol', 'Posterior malleol', 'Talus', 'Tibia']);
  assert.equal(A.meta().side, 'R');
  A.pieces().forEach(p => assert.ok(p.mesh.geometry.attributes.position.count > 100, p.name));
});
test('displaced: no piece moved yet, the fracture gaps are reported, nothing overlaps', () => {
  assert.ok(A.checks().some(c => c[0] === 'info'));
  const m = A.metrics()[byName('Medial malleol')];
  assert.equal(A.pieces()[byName('Medial malleol')].name, 'Medial malleol');
  assert.ok(m.gap > 2.5, `medial gap ${m.gap}`); assert.ok(m.over < 0.3, `overlap ${m.over}`);
});
test('reduction to the known displacement: every fragment meets its bone (gap < 2 mm, contact > 0, overlap < 0.5 mm)', () => {
  reduceAll();
  ['Lateral malleol', 'Medial malleol', 'Posterior malleol'].forEach(n => {
    const m = A.metrics()[byName(n)];
    assert.ok(m.gap < 2, `${n} gap ${m.gap}`); assert.ok(m.contact > 10, `${n} contact ${m.contact}`); assert.ok(m.over < 0.5, `${n} overlap ${m.over}`);
  });
  near(A.metrics()[byName('Lateral malleol')].ang, 8, 0.01); assert.ok(!A.checks().some(c => c[0] === 'crit'));
});
test('over-reduction: a piece pushed 2.5 mm into the tibia is critical and cannot be approved', () => {
  const i = byName('Medial malleol'), p = A.pieces()[i], t0 = p.t.clone(), q0 = p.q.clone();
  A.setMotion(i, t0.clone().add(new T.Vector3(-1, 0, 2.5)), q0, true);
  assert.ok(A.checks().some(c => c[0] === 'crit' && /Medial malleol, Tibia ile/.test(c[2])), JSON.stringify(A.checks()));
  $('surgeon').value = 'Dr Test'; A.approve(); assert.equal(A.approved(), false);
  A.setMotion(i, t0, q0, true); assert.ok(!A.checks().some(c => c[0] === 'crit'));
});
test('plan round trip: motions and approval restored; an edited motion in the file drops the approval', () => {
  $('surgeon').value = 'Dr Test'; A.approve(); assert.equal(A.approved(), true);
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankle.get())); assert.equal(x.pieces.length, 6); assert.equal(x.red.ok, true);
  A.reset(null); assert.equal(A.approved(), false); assert.ok(A.pieces().every(p => p.t.length() === 0));
  W.PlanExt.ankle.set(x);
  assert.equal(A.approved(), true); near(A.pieces()[byName('Medial malleol')].t.x, -2.5, 1e-9);
  const y = JSON.parse(JSON.stringify(x)); y.pieces.find(p => p.name === 'Medial malleol').t[0] += 1;
  W.PlanExt.ankle.set(y); assert.equal(A.approved(), false);
  W.PlanExt.ankle.set(x); assert.equal(A.approved(), true);
});
test('reduced model STL: every piece in its reduced position, binary STL with all triangles', () => {
  const stl = A.reducedStl(), n = new DataView(stl.buffer).getUint32(80, true);
  const tris = A.pieces().reduce((s, p) => s + p.mesh.geometry.index.count / 3, 0);
  assert.equal(n, tris); assert.equal(stl.length, 84 + 50 * n);
  // a vertex of the medial malleolus comes out moved by the reduction (the STL is not the CT position)
  const p = A.pieces()[byName('Medial malleol')], v = new T.Vector3().fromArray(p.mesh.geometry.attributes.position.array, 0);
  const w = v.clone().sub(p.c).applyQuaternion(p.q).add(p.c).add(p.t);
  assert.ok(w.distanceTo(v) > 1, 'moved');
  assert.equal(A.pieceFiles().length, 6);
});
test('rename: a piece named as a splint is hidden, not measured and not exported; named back it returns', () => {
  const i = byName('Posterior malleol'), n0 = A.reducedStl().length, tris = A.pieces()[i].mesh.geometry.index.count / 3;
  A.rename(i, 'Atel / dış nesne');
  assert.equal(A.pieces()[i].role, 'out'); assert.equal(A.reducedStl().length, n0 - 50 * tris); assert.equal(A.pieceFiles().length, 5);
  assert.ok(A.metrics().every(m => m.partner !== i), 'no piece measured against the splint');
  assert.ok(!A.checks().some(c => /Atel/.test(c[2])));
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankle.get())); A.rename(i, 'Posterior malleol'); assert.equal(A.pieces()[i].role, 'frag');
  W.PlanExt.ankle.set(x); assert.equal(A.pieces()[i].role, 'out', 'name and role come back with the plan');
  A.rename(i, 'Posterior malleol'); assert.equal(A.pieceFiles().length, 6);
  $('surgeon').value = 'Dr Test'; A.approve(); assert.equal(A.approved(), true);
});
// a long scan with a splint (real ankle CT, 2026-10-21): the splint lay against air and was named a malleolus, the femur
// and patella took the tibia and fibula's places. Synthetic labels on a 1 mm grid: body cylinder in air.
test('names on a long scan with a splint: splint left out, knee and midfoot bones "Diğer kemik", tibia/fibula/talus/fragment named', () => {
  const nx = 40, ny = 44, nz = 300, hu = new Int16Array(nx * ny * nz).fill(-1000), lab = new Int32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (Math.hypot(i - 20, j - 20) < 16) hu[at(i, j, k)] = 40;
  const put = (l, f) => { let n = 0, sx = 0, sy = 0, sz = 0; for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (f(i, j, k)) { lab[at(i, j, k)] = l; hu[at(i, j, k)] = 900; n++; sx += i; sy += j; sz += k; } return { label: l, size: n, cm3: n / 1000, c: new T.Vector3(sx / n, sy / n, sz / n) }; };
  const list = [
    put(1, (i, j, k) => k >= 30 && k < 280 && Math.hypot(i - 24, j - 20) < 5),         // tibia, leaves the top
    put(2, (i, j, k) => k >= 40 && k < 280 && Math.hypot(i - 12, j - 20) < 2.5),       // fibula
    put(3, (i, j, k) => k < nz && j >= 37 && j <= 38 && i >= 12 && i <= 28),           // posterior splint, in air
    put(4, (i, j, k) => k >= 280 && k < nz && Math.hypot(i - 22, j - 20) < 7),         // femur, leaves the top
    put(5, (i, j, k) => k >= 268 && k < 276 && i >= 20 && i < 28 && j >= 8 && j < 12), // patella
    put(6, (i, j, k) => k >= 4 && k < 28 && i >= 13 && i < 29 && j >= 12 && j < 28),   // talus
    put(7, (i, j, k) => k >= 30 && k < 37 && Math.hypot(i - 11, j - 20) < 2.5),        // lateral malleolus fragment
    put(8, (i, j, k) => k < 3 && i >= 15 && i < 25 && j >= 15 && j < 25),                // midfoot bone, below the ankle
  ];
  const r0 = S.red, l0 = S.labels;
  try {
    S.red = { nx, ny, nz, sp: [1, 1, 1], hu }; S.labels = lab;
    const side = A._names(list), by = l => list.find(p => p.label === l);
    assert.equal(by(3).role, 'out'); assert.equal(by(3).name, 'Atel / dış nesne');
    assert.equal(by(1).name, 'Tibia'); assert.equal(by(2).name, 'Fibula'); assert.equal(by(6).name, 'Talus');
    assert.equal(by(4).name, 'Diğer kemik'); assert.equal(by(5).name, 'Diğer kemik'); assert.equal(by(8).name, 'Diğer kemik'); assert.equal(by(7).name, 'Lateral malleol');
    assert.equal(side, 'R');
    assert.ok(by(1).airFrac < 0.1, `tibia air ${by(1).airFrac}`); assert.ok(by(3).airFrac > 0.9, `splint air ${by(3).airFrac}`);
  } finally { S.red = r0; S.labels = l0; }
});
// synthetic labels on a 1 mm grid (body cylinder(s) in air) for the naming rules of plan 3.1 / 3.2
function scene(nx, ny, nz, bodies) {
  const hu = new Int16Array(nx * ny * nz).fill(-1000), lab = new Int32Array(nx * ny * nz), at = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (bodies.some(([x, y, R]) => Math.hypot(i - x, j - y) < R)) hu[at(i, j, k)] = 40;
  const put = (l, f, h = 900) => { let n = 0, sx = 0, sy = 0, sz = 0; for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (f(i, j, k)) { lab[at(i, j, k)] = l; hu[at(i, j, k)] = h; n++; sx += i; sy += j; sz += k; } return { label: l, size: n, cm3: n / 1000, c: new T.Vector3(sx / n, sy / n, sz / n) }; };
  return { hu, lab, put, red: { nx, ny, nz, sp: [1, 1, 1], hu } };
}
function withScene(sc, f) { const r0 = S.red, l0 = S.labels; try { S.red = sc.red; S.labels = sc.lab; return f(); } finally { S.red = r0; S.labels = l0; } }
// a bone touching only the talus: the real CT's navicular came out as "Medial malleol" (it lay medial of the tibia's
// centre); a fragment is now a piece within 6 mm of the tibia or fibula
test('names: a navicular (touches only the talus) and a calcaneus are "Diğer kemik"; a fragment beside the tibia is one', () => {
  const sc = scene(80, 80, 160, [[30, 35, 40]]);
  const list = [
    sc.put(1, (i, j, k) => k >= 50 && k < 160 && Math.hypot(i - 32, j - 35) < 7),          // tibia, leaves the top
    sc.put(2, (i, j, k) => k >= 40 && k < 160 && Math.hypot(i - 18, j - 37) < 3),          // fibula (patient right: -x)
    sc.put(3, (i, j, k) => k >= 26 && k < 48 && i >= 22 && i < 42 && j >= 25 && j < 46),   // talus under the plafond
    sc.put(4, (i, j, k) => k >= 18 && k < 30 && i >= 40 && i < 50 && j >= 10 && j < 25),   // navicular: anterior-medial, at the talus only
    sc.put(5, (i, j, k) => k >= 2 && k < 24 && i >= 24 && i < 40 && j >= 40 && j < 62),    // calcaneus under the talus
    sc.put(6, (i, j, k) => k >= 44 && k < 56 && i >= 40 && i < 45 && j >= 31 && j < 39),   // medial malleolus fragment, 1 mm off the tibia
  ];
  withScene(sc, () => {
    const side = A._names(list), by = l => list.find(p => p.label === l);
    assert.equal(by(1).name, 'Tibia'); assert.equal(by(2).name, 'Fibula'); assert.equal(by(3).name, 'Talus');
    assert.equal(by(4).name, 'Diğer kemik'); assert.equal(by(5).name, 'Diğer kemik'); assert.equal(by(6).name, 'Medial malleol');
    assert.equal(side, 'R'); assert.equal(A.roiInfo().talus, true);
  });
});
// a cast lying on the skin (no padding): the old test (voxels within 3 mm of air > 50 %) let a 9 mm cast through as the
// longest piece, the "tibia"; the cast's surface lies against the air, a bone's does not
test('names: a 9 mm cast lying on the skin is "Atel / dış nesne", not a shaft', () => {
  const sc = scene(60, 60, 200, [[30, 30, 18]]);
  const list = [
    sc.put(1, (i, j, k) => k >= 40 && k < 200 && Math.hypot(i - 32, j - 28) < 6),
    sc.put(2, (i, j, k) => k >= 30 && k < 200 && Math.hypot(i - 19, j - 30) < 2.5),
    sc.put(3, (i, j, k) => k >= 10 && k < 38 && i >= 22 && i < 42 && j >= 18 && j < 40),
    sc.put(4, (i, j, k) => { const d = Math.hypot(i - 30, j - 30); return d >= 18 && d < 27 && j > 30; }),   // posterior 9 mm cast, all the scan long
  ];
  withScene(sc, () => {
    A._names(list); const by = l => list.find(p => p.label === l);
    assert.equal(by(4).role, 'out', `skin ${by(4).skinFrac} air ${by(4).airFrac}`); assert.equal(by(1).name, 'Tibia'); assert.equal(by(2).name, 'Fibula'); assert.equal(by(3).name, 'Talus');
  });
});
// both legs in one CT: the shafts of both were taken as tibia and fibula; now one leg is planned, the other left out
test('names: a CT of both legs plans one (the one with the fracture fragment, or the one chosen); the other is left out', () => {
  const sc = scene(150, 60, 160, [[35, 30, 22], [115, 30, 22]]);
  const leg = (b, x0, frag) => [
    sc.put(b + 1, (i, j, k) => k >= 50 && k < 160 && Math.hypot(i - x0, j - 30) < 7),
    sc.put(b + 2, (i, j, k) => k >= 40 && k < 160 && Math.hypot(i - (x0 < 75 ? x0 - 14 : x0 + 14), j - 32) < 3),
    sc.put(b + 3, (i, j, k) => k >= 26 && k < 48 && Math.abs(i - x0) < 10 && j >= 20 && j < 41),
    ...(frag ? [sc.put(b + 4, (i, j, k) => k >= 44 && k < 56 && i >= x0 + 8 && i < x0 + 13 && j >= 26 && j < 34)] : []),
  ];
  const list = [...leg(0, 35, true), ...leg(10, 115, false)];
  withScene(sc, () => {
    let side = A._names(list); const by = l => list.find(p => p.label === l);
    assert.equal(A.roiInfo().bilateral, true); assert.equal(A.roiInfo().side, 'R'); assert.equal(side, 'R');
    assert.equal(by(1).name, 'Tibia'); assert.equal(by(2).name, 'Fibula'); assert.equal(by(3).name, 'Talus'); assert.equal(by(4).role, 'frag');
    [11, 12, 13].forEach(l => assert.equal(by(l).role, 'side', `label ${l}`));
    side = A._names(list, { above: 100, below: 40, side: 'L' });
    assert.equal(by(11).name, 'Tibia'); assert.equal(by(12).name, 'Fibula'); assert.equal(by(13).name, 'Talus'); assert.equal(side, 'L');
    [1, 2, 3, 4].forEach(l => assert.equal(by(l).role, 'side', `label ${l}`));
  });
});
// the tibia and talus of the real CT were one threshold component across the joint: the joint neck is cut
test('separate: a tibia and a talus joined across a thin joint contact become two pieces; a lone bone stays one', () => {
  const sc = scene(50, 50, 120, [[25, 25, 20]]);
  sc.put(7, (i, j, k) => (k >= 32 && k < 120 && Math.hypot(i - 25, j - 25) < 9) || (k >= 4 && k < 30 && i >= 13 && i < 37 && j >= 13 && j < 37) || (k >= 30 && k < 32 && Math.hypot(i - 25, j - 25) < 2.2));
  const G = P.eval('G'), m = new Uint8Array(sc.lab.length); for (let v = 0; v < m.length; v++) m[v] = sc.lab[v] ? 1 : 0;
  const { labels, comps } = G.components(m, 50, 50, 120, 10);
  assert.equal(comps.length, 1, 'one threshold piece');
  const out = A.separate(sc.red, labels, comps);
  assert.equal(out.length, 2, JSON.stringify(out.map(c => [c.size, c.centroid.map(Math.round)])));
  const hi = out.find(c => c.centroid[2] > 50), lo = out.find(c => c.centroid[2] < 30);
  assert.ok(hi && lo, 'one above the joint, one below'); assert.ok(hi.size > 15000 && lo.size > 12000, `${hi.size} ${lo.size}`);
  // every voxel carries one of the two new labels (or a speck under the size limit)
  let a = 0, b = 0; for (let v = 0; v < labels.length; v++) { if (labels[v] === hi.label) a++; else if (labels[v] === lo.label) b++; }
  assert.equal(a, hi.size); assert.equal(b, lo.size);
  const sc2 = scene(40, 40, 100, [[20, 20, 15]]); sc2.put(1, (i, j, k) => k >= 5 && k < 95 && Math.hypot(i - 20, j - 20) < 8);
  const m2 = Uint8Array.from(sc2.lab, x => (x ? 1 : 0)), c2 = G.components(m2, 40, 40, 100, 10);
  assert.equal(A.separate(sc2.red, c2.labels, c2.comps).length, 1, 'a shaft is not cut');
});
// a medial malleolus fragment pressed against the tibia (plan M1.1): the fracture band is partial volume over the
// threshold, as wide as the bones (no neck); a cortex (1400 HU) around cancellous bone (450 HU), noise-free
function fusedScene(band) {
  const nx = 50, ny = 50, nz = 90, hu = new Int16Array(nx * ny * nz).fill(40), at = (i, j, k) => i + nx * (j + ny * k);
  const inT = (i, j, k) => k >= 20 && k < 90 && Math.hypot(i - 22, j - 25) < 10, inF = (i, j, k) => k >= 8 && k < 40 && i >= 33 && i < 40 && Math.abs(j - 25) < 7;
  const shell = (f, i, j, k) => f(i, j, k) && [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => !f(i + 2 * a, j + 2 * b, k + 2 * c));
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const T_ = inT(i, j, k), F = inF(i, j, k);
    if (T_ || F) hu[at(i, j, k)] = shell(T_ ? inT : inF, i, j, k) ? 1400 : 450;
    if (band && i === 32 && k >= 20 && k < 40 && Math.abs(j - 25) < 7) hu[at(i, j, k)] = 330;   // the fracture band, over 300 HU
  }
  return { nx, ny, nz, hu, sp: [1, 1, 1] };
}
test('separate (M1.1): a fragment fused to the tibia through a bright fracture band is cut off; the intact tibia is not cut', () => {
  const G = P.eval('G');
  for (const band of [true, false]) {
    const r = fusedScene(band), m = Uint8Array.from(r.hu, h => (h >= 300 ? 1 : 0)), { labels, comps } = G.components(m, r.nx, r.ny, r.nz, 10);
    if (band) assert.equal(comps.length, 1, 'one threshold piece');
    const out = A.separate(r, labels, comps, 300).filter(c => c.size > 200);
    assert.equal(out.length, 2, `band ${band}: ${JSON.stringify(out.map(c => [c.size, c.centroid.map(Math.round)]))}`);
    const fr = out.find(c => c.centroid[0] > 32);
    assert.ok(fr && Math.abs(fr.size - 7 * 13 * 32) < 0.15 * 7 * 13 * 32, `fragment ${fr && fr.size}`);
  }
  // one tibia alone, its cortex thinning out: stays one piece
  const r = fusedScene(false); for (let v = 0; v < r.hu.length; v++) { const i = v % 50; if (i >= 33) r.hu[v] = 40; }
  for (let v = 0; v < r.hu.length; v += 7) if (r.hu[v] === 1400) r.hu[v] = 500;   // patchy cortex
  const m = Uint8Array.from(r.hu, h => (h >= 300 ? 1 : 0)), c = G.components(m, 50, 50, 90, 10);
  assert.equal(A.separate(r, c.labels, c.comps, 300).filter(x => x.size > 200).length, 1);
});
test('package: locked until reduction + engineer + surgeon approvals; holds the STLs, plan, report and approval log', () => {
  assert.equal(A.packReady(), false);
  const Au = W.Audit; assert.ok(Au);
  // the two plan approvals through the audit panel's own log
  const log = [], h = Au.planHash(), prev0 = '0'.repeat(64);
  const e1 = { n: 1, at: '2026-10-21T10:00:00Z', role: 'eng', name: 'Muh', action: 'onay', comment: '', plan: h, prev: prev0 }; e1.hash = Au.sha256([e1.prev, e1.n, e1.at, e1.role, e1.name, e1.action, e1.comment, e1.plan].join('|'));
  const e2 = { n: 2, at: '2026-10-21T10:01:00Z', role: 'sur', name: 'Dr Test', action: 'onay', comment: '', plan: h, prev: e1.hash }; e2.hash = Au.sha256([e2.prev, e2.n, e2.at, e2.role, e2.name, e2.action, e2.comment, e2.plan].join('|'));
  log.push(e1, e2); W.PlanExt.audit.set({ log });
  S.crit = 0; assert.equal(A.packReady(), true);
  const names = A.packFiles().map(f => f.name);
  ['redukte_model.stl', 'plan.json', 'rapor.html', 'onay_kaydi.json', 'parcalar/medial_malleol_redukte.stl'].forEach(n => assert.ok(names.includes(n), n));
  assert.ok(!names.some(n => /^navigasyon/.test(n)), 'no mandible navigation file');
  assert.match(A.reportHTML(), /Araştırma prototipi/);
});
test('pending list: the ankle case lists only its own items; the mandible case does not see them', () => {
  A.reset(null);
  assert.deepEqual([...St.pendingList().filter(x => !/onayı$/.test(x))], ['Redüksiyon']);
  W.CaseType.set('mandible');
  assert.ok(!St.pendingList().includes('Redüksiyon')); assert.ok(St.pendingList().includes('Rezeksiyon aralığı'));
  assert.equal(A.pieces().length, 0, 'pieces dropped when leaving the ankle type');
});
// the real ankle CT fused tibia, talus and fibula at 250 HU; the ankle type segments at 300 HU, the mandible at 250
test('bone threshold follows the case type: 300 HU for an ankle, back to 250 HU for the mandible', () => {
  assert.equal(thr0, '250'); assert.equal(thrA, '300'); assert.equal($('thr').value, '250');
});

await run('ankle (malleolar fracture)');
