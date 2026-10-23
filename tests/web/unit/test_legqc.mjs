// Leg CT quality control and its own threshold (plan 1.1). The mandible CT had image quality checks that hold the
// approval and the package back; the leg CT had none and a fixed 250 HU threshold (fibula.js THR), so a tilted, gappy
// or contrast-enhanced leg CT gave a fibula guide without a word. Now:
//  - the leg CT runs the same quality checks; its critical ones count like the mandible's (S.qc, step 1, package lock)
//  - contrast in the vessels beside the fibula (250-600 HU far from any cortex) is a warning
//  - the leg has its own threshold control (#fibThr); the plan keeps it (only when it is not 250) and a reopened plan
//    comes back with it; the fibula guide and the server request use it
// Phantoms: tests/phantoms/phantoms.mjs leg(). Run: node test_legqc.mjs
import { test, run, assert, near } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { leg, toSample } from '../../phantoms/phantoms.mjs';

let LEG = toSample(leg(), 'leg');
const fetchStub = async url => { if (/sample_leg/.test(url)) return { json: async () => LEG }; throw new Error('offline'); };
const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'], extra: { fetch: fetchStub, confirm: () => true }, post: ['fibula.js'] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 90000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(50); } };
const fire = (id, type, value) => { const el = $(id); if (value !== undefined) el.value = value; (el.listeners[type] || []).forEach(f => f({ type, target: el })); };

// straight mandible bar along x with two cuts (the fibula needs a defect)
{
  const nx = 160, ny = 50, nz = 40, sp = [0.8, 0.8, 0.8], origin = [-64, -20, -24], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (z < 0 && z > -14 && Math.abs(y) < 8 && Math.abs(x) < 60) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { modality: 'CT', thickness: 0.8, bits: 16 } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-legqc' }; S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  S.qcBase = St.qualityCheck(S.vol); St.syncQC();
  await St.segment(true);
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = [{ off: -20, yaw: 0, pitch: 0, w: 0.8 }, { off: 20, yaw: 0, pitch: 0, w: 0.8 }];
  S.guideOn = true; St.placeScrews(); await St.rebuildResection(); await St.regenerate();
}
async function loadLeg(opts) {
  LEG = toSample(leg(opts), 'leg');
  if (W.Fibula.active()) await W.Fibula.apply(null);
  fire('fibSample', 'click');
  await until(() => W.Fibula.active() && W.Fibula.state().last);
}
const legRows = () => (S.qc || []).filter(q => /^Bacak BT'si:/.test(q[2]));

test('a clean leg CT: its quality lines are in step 1 under "Bacak BT\'si:", none critical or warning', async () => {
  await loadLeg({});
  const r = legRows();
  assert.ok(r.length >= 2, JSON.stringify(S.qc));
  assert.ok(!r.some(q => q[0] === 'crit' || q[0] === 'warn'), JSON.stringify(r));
  assert.ok(r.some(q => /Kesit kalınlığı 1,00 mm/.test(q[2])), JSON.stringify(r));
});

test('a tilted leg CT (5°) is critical and holds the approval back', async () => {
  await loadLeg({ tilt: 5 });
  const r = legRows().filter(q => q[0] === 'crit');
  assert.equal(r.length, 1, JSON.stringify(legRows()));
  assert.match(r[0][2], /^Bacak BT'si: Gantry eğimi 5,0°/);
  // a critical S.qc line is what audit.js can() and the package (app.js renderAppr) refuse on
  assert.ok(S.qc.some(q => q[0] === 'crit'));
});

test('a leg CT with a missing slice is critical', async () => {
  await loadLeg({ missing: true });
  assert.ok(legRows().some(q => q[0] === 'crit' && /kesit aralığı düzensiz/.test(q[2])), JSON.stringify(legRows()));
});

test('contrast in the peroneal artery (420 HU) is a warning; the native leg has none', async () => {
  await loadLeg({ contrast: 420 });
  const w = legRows().filter(q => q[0] === 'warn' && /kontrastlı \(anjiyo\) BT/.test(q[2]));
  assert.equal(w.length, 1, JSON.stringify(legRows()));
  const cm3 = Number(/Kemik dışında ([\d,]+) cm³/.exec(w[0][2])[1].replace(',', '.'));
  near(cm3, leg({ contrast: 420 }).expect.contrastCm3, 0.6, 'the vessel volume');
});

test('the leg threshold: its own control, kept in the plan (not when 250), back on reopen, used by the fibula guide', async () => {
  await loadLeg({});
  assert.equal(W.Fibula.state().F.thr, 250);
  assert.ok(!('thr' in W.Fibula.plan()));
  fire('fibThr', 'change', '320');
  await until(() => W.Fibula.state().F && W.Fibula.state().F.thr === 320 && W.Fibula.state().last);
  assert.equal(W.Fibula.plan().thr, 320);
  assert.ok(W.Fibula.state().F.c, 'a candidate is kept');
  // a reopened plan carries it; a plan without one comes back at 250
  const p = St.clone(W.Fibula.plan());
  await W.Fibula.apply(null); await W.Fibula.apply(p);
  await until(() => W.Fibula.state().F && W.Fibula.state().last);
  assert.equal(W.Fibula.state().F.thr, 320);
  const q = St.clone(p); delete q.thr;
  await W.Fibula.apply(q);
  await until(() => W.Fibula.state().F && W.Fibula.state().F.thr === 250 && W.Fibula.state().last);
  // a stored value out of range is clamped
  const bad = St.clone(p); bad.thr = 5000;
  await W.Fibula.apply(bad);
  await until(() => W.Fibula.state().F && W.Fibula.state().F.thr === 800);
});

test('unloading the fibula removes its quality lines; unloading while its guide is being built does not throw', async () => {
  await loadLeg({ tilt: 5 });
  assert.ok(legRows().length);
  // (the fibula guide build started by the load is still running: the unload lands in the middle of it)
  const errs = []; const onErr = e => errs.push(e); process.on('uncaughtException', onErr); process.on('unhandledRejection', onErr);
  try {
    await W.Fibula.apply(null);
    assert.equal(legRows().length, 0);
    await sleep(8000);
    assert.equal(errs.length, 0, String(errs[0] && errs[0].stack));
    assert.equal(S.fib, null);
  } finally { process.off('uncaughtException', onErr); process.off('unhandledRejection', onErr); }
});

await run('legqc');
