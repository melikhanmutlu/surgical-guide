// Loading and picking behaviour on window.Studio: a DICOM / zip read can be cancelled and a newer load replaces an older one (C1.1, C1.2),
// the sample asks before it replaces a planned case (C9.3), picks go to the mandible while the fibula-only view is on (C7).
// Run: node test_load.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { dicom } from './lib/dicomw.mjs';

const P = studio({ dicom: true, pre: ['codecs.js', 'unzip.js'] }); const St = await ready(P); const S = St.S;
const px = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const series = (n = 4) => Array.from({ length: n }, (_, k) => new File([dicom({ rows: 2, cols: 3, pixels: px(6, i => 1000 + 10 * k + i), ipp: [5, -3, 10 + k * 1.25], iop: [1, 0, 0, 0, 1, 0], ps: [0.5, 0.7], series: '1.2.3.7', sop: `1.2.3.${k + 100}`, thickness: 1 })], `s${k}.dcm`));
const el = id => P.doc.getElementById(id);
const fire = (id, type) => { const e = el(id); (e.listeners[type] || []).forEach(f => f({ type, target: e })); };

test('readDicom with a live control reads normally', async () => {
  const ctl = St.startLoad(); const r = await St.readDicom(series(), ctl);
  assert.ok(!r.error, r.error); assert.equal(r.vol.nz, 4);
});
test('cancelled before the first step: readDicom stops with LOAD_CANCELLED and returns no volume', async () => {
  const ctl = St.startLoad(); ctl.cancelled = true;
  await assert.rejects(St.readDicom(series(), ctl), e => e === St.LOAD_CANCELLED);
});
test('the cancel button of the busy bar cancels the load that owns it', async () => {
  const ctl = St.startLoad(), done = St.readDicom(series(), ctl).catch(e => e);
  el('busyCancel').listeners.click.forEach(f => f({ type: 'click' }));      // pressed while the read is under way
  assert.equal(await done, St.LOAD_CANCELLED); assert.equal(ctl.cancelled, true); assert.equal(ctl.byUser, true);
  assert.equal(St.loadStopped(ctl), true); assert.equal(el('busy').hidden, true, 'busy bar is hidden after a cancel');
});
test('a newer load replaces an older one: the older is cancelled (silently), the newer is not', async () => {
  const a = St.startLoad(), b = St.startLoad();
  assert.equal(a.cancelled, true); assert.equal(a.byUser, false); assert.equal(b.cancelled, false);
  await assert.rejects(St.readDicom(series(), a), e => e === St.LOAD_CANCELLED);
  assert.equal(St.loadStopped(a), true, 'stale load is reported as stopped');
  assert.equal(St.loadStopped(b), false);
});

let fetched = 0, asked = 0, answer = false;
P.g.fetch = () => { fetched++; return new Promise(() => {}); };           // the sample download never finishes: only "was it started?"
P.g.confirm = () => { asked++; return answer; };
const tick = () => new Promise(r => setTimeout(r, 20));
test('sample over a planned case: asks first and does nothing on "no"', async () => {
  S.anchor = { p: new P.g.THREE.Vector3(), n: new P.g.THREE.Vector3(0, 0, 1) }; S.planes = [{ off: 0, yaw: 0, pitch: 0, w: 1.2 }];
  asked = fetched = 0; answer = false; fire('sampleM', 'click'); await tick();
  assert.equal(asked, 1); assert.equal(fetched, 0, 'declined: nothing is loaded'); assert.ok(S.anchor && S.planes.length === 1, 'the plan is still there');
  fire('sampleL', 'click'); await tick(); assert.equal(asked, 2); assert.equal(fetched, 0);
});
test('sample over a planned case: "yes" loads it', async () => {
  asked = fetched = 0; answer = true; fire('sampleM', 'click'); await tick();
  assert.equal(asked, 1); assert.equal(fetched, 1);
});
test('sample with no plan: no question', async () => {
  S.anchor = null; S.planes = []; S.screws = [];
  asked = fetched = 0; answer = false; fire('sampleM', 'click'); await tick();
  assert.equal(asked, 0); assert.equal(fetched, 1);
});

test('picks apply to the mandible: with the fibula-only view on, setMode(anchor) switches the view and says so', () => {
  const calls = []; let view = 'f';
  P.g.Fibula = { view: () => view, setView: v => { calls.push(v); view = v; }, active: () => false };
  St.setMode('anchor');
  assert.deepEqual(calls, ['m']); assert.equal(S.mode, 'anchor');
  assert.match(el('caseMsg').textContent, /mandibulaya alındı/);
  calls.length = 0; St.setMode('orbit'); St.setMode('anchor');
  assert.deepEqual(calls, [], 'already on the mandible view: nothing to switch');
  view = 'f'; St.setMode('orbit'); assert.deepEqual(calls, [], 'leaving a pick mode does not switch the view');
  view = 's'; St.setMode('screw'); assert.deepEqual(calls, [], 'the split view shows the mandible too');
  St.setMode('orbit');
});
test('mandibleView() is a no-op without a fibula module', () => { delete P.g.Fibula; assert.equal(St.mandibleView(), false); });

await run('loading and picks');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
