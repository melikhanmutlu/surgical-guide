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
W.CaseType.set('ankle');
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

await run('ankle (malleolar fracture)');
