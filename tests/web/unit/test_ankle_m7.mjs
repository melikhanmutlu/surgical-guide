// Malleolar fracture, plan M7: item approvals and the package's file hashes (web/ankle.js, audit.js) on the synthetic
// ankle reduced to its known displacement, with the medial malleolus screws and the cutting guide and wedge:
// - each screw, the guide and the wedge is approved on its own; the package waits for every one of them;
// - an item changed after its approval loses it (a screw lengthened, the guide moved); its stamp stays as "Plan değişti";
// - approving an item does not change the plan's design hash (the engineer and surgeon approvals stand);
// - Audit.sha256b is the standard SHA-256 of the bytes; cerceve.json and the report list every STL's hash; an STL that
//   changes changes its hash.
// Run: node test_ankle_m7.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, REPO } from './lib/harness.mjs';

const ANKLE = JSON.parse(fs.readFileSync(path.join(REPO, 'web', 'sample_ankle.json'), 'utf8'));
const fetchStub = async url => { if (/sample_ankle/.test(url)) return { json: async () => ANKLE }; throw new Error('offline'); };
const P = studio({ extra: { fetch: fetchStub } });
const St = await ready(P); const T = P.g.THREE, S = St.S, W = P.g, $ = id => P.doc.getElementById(id);
P.eval(`window.CaseType = (() => { let cur = 'mandible'; return { get: () => cur, set(x) { if (x !== cur) { cur = x; Studio.emit('caseType', x); } } }; })();`);
P.load('audit.js'); P.load('ankle.js'); P.load('anklm.js'); P.load('ankguide.js'); P.load('ankscrew.js');
const A = W.Ankle, SC = W.AnkScrew, G = W.AnkGuide, Au = W.Audit;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 120000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const byName = n => A.pieces().findIndex(p => p.name === n);

await until(() => !(St.loadBusy && St.loadBusy()));
W.CaseType.set('ankle');
await St.loadSample('ankle');
await until(() => A.pieces().length > 0 && !A.building());
ANKLE.truth.forEach(tr => {
  const i = byName(tr.name), R = new T.Quaternion().setFromAxisAngle(new T.Vector3(...tr.rot_axis).normalize(), tr.rot_deg * Math.PI / 180);
  A.setMotion(i, new T.Vector3(...tr.move).negate(), R.invert(), true);
});
SC.template('mm');
G.suggest(); await G.make();
$('surgeon').value = 'Dr Test';

function signAudit() {
  const log = [], h = Au.planHash(), prev0 = '0'.repeat(64);
  const e1 = { n: 1, at: '2026-10-24T10:00:00Z', role: 'eng', name: 'Muh', action: 'onay', comment: '', plan: h, prev: prev0 }; e1.hash = Au.sha256([e1.prev, e1.n, e1.at, e1.role, e1.name, e1.action, e1.comment, e1.plan].join('|'));
  const e2 = { n: 2, at: '2026-10-24T10:01:00Z', role: 'sur', name: 'Dr Test', action: 'onay', comment: '', plan: h, prev: e1.hash }; e2.hash = Au.sha256([e2.prev, e2.n, e2.at, e2.role, e2.name, e2.action, e2.comment, e2.plan].join('|'));
  log.push(e1, e2); W.PlanExt.audit.set({ log });
}

test('sha256b: the standard SHA-256 of the bytes', () => {
  const b = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
  assert.equal(Au.sha256b(b), crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'));
  assert.equal(Au.sha256b(b.buffer), crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'));
  assert.equal(Au.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('items: each screw, the guide and the wedge; the package waits for every approval', () => {
  const it = A.items(); assert.equal(it.filter(x => /^screw:/.test(x.k)).length, 2); assert.ok(it.some(x => x.k === 'guide') && it.some(x => x.k === 'wedge'));
  const crit = W.ExtraChecks.flatMap(f => f()).filter(c => c[0] === 'crit'); assert.equal(crit.length, 0, JSON.stringify(crit));
  A.approve(); assert.equal(A.approved(), true);
  const h0 = Au.planHash(); signAudit(); S.crit = 0;
  assert.equal(A.packReady(), false, 'items not yet approved');
  it.forEach(x => assert.equal(A.approveItem(x.k), true, x.k));
  assert.equal(Au.planHash(), h0, 'item approvals do not change the design hash');
  assert.ok(A.items().every(A.itemOk)); assert.equal(A.packReady(), true);
});
test('an item changed after its approval loses it; the others stand', () => {
  const s = SC.screws()[0], k = A.items().find(x => /^screw:/.test(x.k)).k;
  SC.set(s.id, 'L', s.L - 4);
  const it = A.items(), mine = it.find(x => x.k === k);
  assert.equal(A.itemOk(mine), false); assert.equal(it.filter(A.itemOk).length, it.length - 1);
  assert.equal(A.packReady(), false);
  SC.set(s.id, 'L', s.L); assert.equal(A.itemOk(A.items().find(x => x.k === k)), true, 'back to what was approved');
  // the guide moved: guide and wedge lose theirs
  const st = G.state(); G.set('off', st.prm.off + 2);
  const gi = A.items().find(x => x.k === 'guide'); assert.ok(gi && gi.due && !A.itemOk(gi), 'stale guide: listed as waiting for its rebuild (Denetim 7), not approved'); assert.equal(A.packReady(), false);
  G.set('off', st.prm.off);
});
test('approvals saved with the plan; the package lists every STL hash in cerceve.json and the report', async () => {
  await G.make(); A.items().filter(x => !A.itemOk(x)).forEach(x => A.approveItem(x.k));
  signAudit(); S.crit = 0; assert.equal(A.packReady(), true);
  const x = JSON.parse(JSON.stringify(W.PlanExt.ankAppr.get())); assert.ok(Object.keys(x).length >= 4);
  W.PlanExt.ankAppr.set(null); assert.equal(A.packReady(), false); W.PlanExt.ankAppr.set(x); assert.equal(A.packReady(), true);
  const files = A.packFiles(), fr = JSON.parse(files.find(f => f.name === 'cerceve.json').data), rep = files.find(f => f.name === 'rapor.html').data;
  const stls = files.filter(f => /\.stl$/.test(f.name)); assert.ok(stls.length >= 4);
  stls.forEach(f => { const h = crypto.createHash('sha256').update(Buffer.from(f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data))).digest('hex'); assert.equal(fr.sha256[f.name], h, f.name); assert.ok(rep.includes(h), `report has ${f.name}`); });
  assert.equal(fr.vidalar.length, 2); assert.ok(fr.onaylar.reduksiyon);
  // a piece moved: the reduced model's hash changes
  const h1 = fr.sha256['redukte_model.stl'], i = byName('Talus'), p = A.pieces()[i];
  A.setMotion(i, p.t.clone().add(new T.Vector3(0.5, 0, 0)), p.q.clone(), true);
  assert.notEqual(A.stlHashes([{ name: 'redukte_model.stl', data: A.reducedStl() }])['redukte_model.stl'], h1);
});

test('report (M8): joint measures before / after, screws, guide and wedge, sample thresholds, print guide', () => {
  const r = A.reportHTML({ 'x.stl': 'ab'.repeat(32) });
  ['Eklem ölçüleri', 'Üst açıklık (SCS)', 'Vidalar', 'Karşı korteks (mm)', 'Kesi guide\'ı ve kama', 'Yuva boşluğu', 'STL\'de ölçülen', 'Örnek eşikler', 'Baskı rehberi', 'PolyJet (MED610)', 'Dosya özetleri (SHA-256)', 'Medial malleol vidası 1']
    .forEach(k => assert.ok(r.includes(k), k));
  // each screw is a row, the wedge's measured angle is there
  assert.equal((r.match(/Medial malleol vidası \d/g) || []).length >= 2, true);
});

await run('ankle M7 (item approvals, file hashes)');
