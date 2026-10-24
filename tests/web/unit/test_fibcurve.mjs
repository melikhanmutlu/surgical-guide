// C8 (plan "Çene rekonstrüksiyonu: P0 sonrası"): on a curved defect the segment rule "never a segment under 20 mm" kept
// one straight segment that missed the arch (Denetim 6: a 45 mm parasymphysis defect, 1 segment 9.8 mm off, 2 segments
// refused for a 15.8 mm segment). Now a count that follows the defect at least 1 mm better with every segment at least
// the critical 15 mm is offered with its numbers (a warning with a fix); nothing changes until it is chosen, and choosing
// it lowers this plan's minimum segment rule to the short segment and plans the count again.
// C9: an expansile tumour bends the resected bone's line away from the healthy side's mirror image; the mirror is
// then offered (a warning with a fix), the plan keeps its mirror setting until the fix is taken.
// Run: node test_fibcurve.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import zlib from 'node:zlib';

function legSample() {
  const nx = 64, ny = 48, nz = 300, origin = [-32, -24, -150], q = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i, y = origin[1] + j, z = origin[2] + k;
    q[i + nx * (j + ny * k)] = (Math.hypot(x - 14, y) < 7 && Math.abs(z) < 135) || (Math.hypot(x + 12, y) < 14 && Math.abs(z) < 140) ? 200 : 0;
  }
  return { dims: [nx, ny, nz], spacing: [1, 1, 1], origin, scale: 10, offset: -1000, data: zlib.gzipSync(Buffer.from(q)).toString('base64') };
}
const LEG = legSample();
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], extra: { fetch: fetchStub }, post: ['fibula.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const fire = (id, type) => { const el = $(id); (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

test('shortAlternative: only after a missed deviation target, never under the critical length, at least 1 mm better', () => {
  const F = W.Fibula, tbl = [{ n: 1, lens: [45], dev: 9.8 }, { n: 2, lens: [15.8, 29.2], dev: 1.5 }];
  const ch = F.segmentChoice(tbl, 45, 20, 3, 25);
  assert.equal(ch.n, 1); assert.equal(ch.reason, 'len', 'the rule keeps one segment');
  const a = F.shortAlternative(tbl, ch, 15); assert.ok(a, 'offered'); assert.equal(a.n, 2); near(a.min, 15.8, 1e-9); near(a.dev, 1.5, 1e-9);
  assert.equal(F.shortAlternative([{ n: 1, lens: [45], dev: 9.8 }, { n: 2, lens: [14.5, 30.5], dev: 1.5 }], ch, 15), null, 'under 15 mm: never');
  assert.equal(F.shortAlternative([{ n: 1, lens: [45], dev: 4.0 }, { n: 2, lens: [15.8, 29.2], dev: 3.5 }], Object.assign({}, ch, { dev: 4.0 }), 15), null, 'under 1 mm better: no offer');
  assert.equal(F.shortAlternative(tbl, { n: 1, reason: 'dev', dev: 1 }, 15), null, 'the target met: no offer');
});

// a jaw curved in the x-z plane (centre line radius R about (0, ., -R)), cut at x = ±X: a defect the straight graft misses
const R = 20;
test('a curved defect: one segment misses it, the two-segment offer is shown, choosing it follows the defect under 3 mm', async () => {
  {
    const sp = [0.8, 0.8, 0.8], box = { x: 40, y: 20, z: 40 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
    const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2], r = Math.hypot(x, z + R), th = Math.atan2(x, z + R);
      if (Math.abs(th) < 1.4 && (y / 7) ** 2 + ((r - R) / 5) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200;
    }
    S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
    S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-curve' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
    await St.segment(true);
    S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
    S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2 }, { off: 15, yaw: 0, pitch: 0, w: 1.2 }];
    S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
  }
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().last);
  const ch = W.Fibula.choice(), last = () => W.Fibula.state().last;
  console.log('    defect', W.Fibula.defect().L.toFixed(1), 'choice', JSON.stringify(ch));
  assert.equal(W.Fibula.plan().n, 1, 'the rule keeps one segment');
  assert.ok(last().dev > 3, 'one segment misses the arch: ' + last().dev);
  assert.ok(ch.alt && ch.alt.n === 2, JSON.stringify(ch));
  const row = () => W.Fibula.checks().find(c => /segmentle greft defekt hattından/.test(c[2]));
  const r = row(); assert.ok(r, JSON.stringify(W.Fibula.checks().map(c => c[2])));
  assert.equal(r[0], 'warn'); assert.equal(r[4][0][0], 'fibShortSeg');
  assert.ok(!W.Fibula.plan().rules || !('segMin' in W.Fibula.plan().rules), 'nothing changed before the choice');
  await St.runFix('fibShortSeg'); await sleep(30);
  assert.equal(W.Fibula.plan().n, 2);
  assert.equal(W.Fibula.plan().rules.segMin, Math.floor(ch.alt.min));
  assert.ok(last().dev < 3, 'two segments follow the defect: ' + last().dev);
  assert.ok(!row(), 'the offer is gone');
  assert.match($('fibMsg').textContent, /En kısa segment kuralı bu plan için \d+ mm yapıldı; segment sayısı 2/);
});

// an arch (centre line radius RA about (0, ., -RA)) cut at x = 12 and 32; tumour: a ball on the outer side between the cuts
async function arch(tumour) {
  const RA = 36, sp = [0.8, 0.8, 0.8], box = { x: 46, y: 20, z: 46 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000), th0 = Math.asin(22 / RA), tc = [(RA + 8) * Math.sin(th0), 0, (RA + 8) * Math.cos(th0) - RA];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2], r = Math.hypot(x, z + RA), th = Math.atan2(x, z + RA);
    const b = Math.abs(th) < 1.3 && (y / 7) ** 2 + ((r - RA) / 5) ** 2 < 1, t = tumour && Math.hypot(x - tc[0], y - tc[1], z - tc[2]) < 12;
    if (b || t) hu[i + nx * (j + ny * k)] = 1200;
  }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-arch-' + tumour }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: 12, yaw: 0, pitch: 0, w: 1.2 }, { off: 32, yaw: 0, pitch: 0, w: 1.2 }];
  S.screws = []; St.placeScrews(); await St.rebuildResection(); await St.regenerate(); St.emit('parts'); await sleep(50);
}
const mirrorRow = () => W.Fibula.checks().find(c => /sağlam tarafın ayna görüntüsünden en çok/.test(c[2]));
test('C9: an expansile tumour on the defect side: the mirror is offered, the plan keeps it off until the fix', async () => {
  await arch(true);
  await until(() => W.Fibula.state().last && W.Fibula.defect());
  const g = W.Fibula.state().last.D.mirrorGap; console.log('    mirror gap', JSON.stringify(g));
  assert.equal(W.Fibula.plan().mirror, 0, 'the default stays off');
  assert.ok(g && g.max >= W.Fibula.MIRROR_GAP, JSON.stringify(g));
  const r = mirrorRow(); assert.ok(r, JSON.stringify(W.Fibula.checks().map(c => c[2])));
  assert.equal(r[0], 'warn'); assert.equal(r[4][0][0], 'fibMirrorOn');
  await St.runFix('fibMirrorOn'); await sleep(30);
  assert.equal(W.Fibula.plan().mirror, 1); assert.equal($('fibMirror').checked, true);
  assert.ok(W.Fibula.state().last.D.mirrored >= 3, 'the line comes from the healthy side');
  assert.ok(!mirrorRow(), 'no offer once mirrored');
  W.Fibula.plan().mirror = 0;
});
test('C9: the same arch without the tumour: no offer', async () => {
  await arch(false);
  await until(() => W.Fibula.state().last && W.Fibula.defect());
  const g = W.Fibula.state().last.D.mirrorGap; console.log('    mirror gap', JSON.stringify(g));
  assert.ok(g && g.max < W.Fibula.MIRROR_GAP, JSON.stringify(g));
  assert.ok(!mirrorRow());
});

await run('fibula segment rule on a curved defect');
