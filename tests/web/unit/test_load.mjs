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

// e2e: "Otomatik planla" pressed while the sample was downloading planned the outgoing case; the load then cleared the
// anchor under the running guide fit: "Cannot read properties of null (reading 'p')" in fitWrap
test('Otomatik planla while a case is loading: refused with a notice, nothing is planned', async () => {
  // the outgoing case is still on screen (its volume and bone model) while the sample download is under way
  const red = S.red, bone = St.parts.bone; S.red = red || { nx: 1, ny: 1, nz: 1 }; St.parts.bone = bone || { obj: {} };
  S.anchor = null; S.planes = []; S.screws = []; S.guideOn = false; el('caseMsg').textContent = '';
  try {
    fire('autoPrep', 'click'); await tick();
    assert.equal(S.anchor, null); assert.equal(S.planes.length, 0); assert.equal(S.guideOn, false);
    assert.match(el('caseMsg').textContent, /Vaka yükleniyor/);
  } finally { S.red = red; if (bone) St.parts.bone = bone; else delete St.parts.bone; }
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

// ---------- Denetim 4: W6 (sample over a running read), D4 (bone kernel first), W17 (the series list after a failed switch) ----------
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 20)); } return true; };
const ser24 = (uid, kernel, desc, base = 0) => Array.from({ length: 24 }, (_, k) => new File([dicom({ rows: 8, cols: 8, pixels: px(64, i => 1200 * ((i + k) % 3 === 0)), ipp: [0, 0, k], ps: [1, 1], series: uid, sop: `1.2.9.${base + k}`, thickness: 1, icpt: -1024, slope: 1, kernel })], `${uid}_${k}.dcm`));
test('D4: of two real series of the same coverage the bone-kernel one opens first', async () => {
  P.g.confirm = () => true;
  const ctl = St.startLoad(), r = await St.readDicom(ser24('1.2.40.1', 'STANDARD', 'STND', 0).concat(ser24('1.2.40.2', 'BONE', 'Bone', 100)), ctl);
  assert.ok(!r.error, r.error); assert.equal(r.vol.meta.kernel, 'BONE'); assert.equal(r.scan.cur, r.cur); assert.equal(r.scan.groups[r.cur][0].series.replace(/\0/g, ''), '1.2.40.2');
});
// plan B4: each slice is checked against the series: a turned slice, a slice of another size, a slice shifted in
// plane and a repeated position are critical (the volume would be sheared or mixed there); a clean series has none
test('B4: per-slice orientation, size, in-plane position and repeats are checked; a clean series passes', async () => {
  const mk = (k, o = {}) => new File([dicom(Object.assign({ rows: 8, cols: 8, pixels: px(64, i => 1200 * ((i + k) % 3 === 0)), ipp: [0, 0, k], iop: [1, 0, 0, 0, 1, 0], ps: [1, 1], series: '1.2.41.' + (o.uid || 1), sop: `1.2.41.9.${k}`, thickness: 1, icpt: -1024, slope: 1 }, o))], `b4_${k}.dcm`);
  const crit = async files => { const r = await St.readDicom(files, St.startLoad()); assert.ok(!r.error, r.error); return St.qualityCheck(r.vol).filter(c => c[0] === 'crit').map(c => c[2]); };
  const clean = Array.from({ length: 12 }, (_, k) => mk(k));
  assert.equal(JSON.stringify(await crit(clean)), "[]");
  const turned = clean.slice(); turned[5] = mk(5, { iop: [Math.cos(0.05), Math.sin(0.05), 0, -Math.sin(0.05), Math.cos(0.05), 0] });
  assert.ok((await crit(turned)).some(t => /1 kesitin yönü serinin ilk kesitinden 2,9°e kadar farklı/.test(t)));
  const shifted = clean.slice(); shifted[6] = mk(6, { ipp: [2, 0, 6] });
  assert.ok((await crit(shifted)).some(t => /1 kesit seri hattından 2,00 mm'ye kadar kaymış/.test(t)));
  const sized = clean.slice(); sized[3] = mk(3, { ps: [1.2, 1.2] });
  assert.ok((await crit(sized)).some(t => /1 kesitin boyutu ya da piksel aralığı seriden farklı/.test(t)));
  const twice = clean.concat([mk(4, { sop: '1.2.41.9.99' })]);
  assert.ok((await crit(twice)).some(t => /1 kesit aynı konumda iki kez var/.test(t)));
});

test('W17: a series switch that is cancelled leaves the list on the series that is loaded', async () => {
  S.anchor = null; S.planes = []; S.screws = [];
  const f = el('dicomFiles'); f.files = ser24('1.2.41.1', 'STANDARD', 'STND', 200).concat(ser24('1.2.41.2', 'BONE', 'Bone', 300)); fire('dicomFiles', 'change');
  assert.ok(await until(() => S.source && S.source.type === 'dicom' && !St.loadBusy() && el('busy').hidden && /selected/.test(el('serSel').innerHTML)), 'loaded, series list shown');
  const cur = /<option value="(\d)" selected/.exec(el('serSel').innerHTML)[1];
  const other = cur === '0' ? '1' : '0';
  el('serSel').value = other; fire('serSel', 'change');
  el('busyCancel').listeners.click.forEach(fn => fn({ type: 'click' }));      // cancelled while the other series is decoded
  assert.ok(await until(() => el('busy').hidden), 'stopped');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(/<option value="(\d)" selected/.exec(el('serSel').innerHTML)[1], cur, 'the list still names the loaded series');
});
test('W6: "Örnek vaka" while a DICOM read is running cancels the read (with a notice); the read never replaces the sample', async () => {
  const n = 16, q = Buffer.alloc(n * n * n); for (let i = 0; i < q.length; i++) q[i] = (i % n) > 4 && (i % n) < 11 ? 200 : 0;
  const { gzipSync } = await import('node:zlib');
  const SAMPLE = { dims: [n, n, n], spacing: [1, 1, 1], origin: [0, 0, 0], scale: 10, offset: -1000, data: gzipSync(q).toString('base64') };
  P.g.fetch = async () => ({ json: async () => SAMPLE });
  S.anchor = null; S.planes = []; S.screws = []; S.source = null; el('caseMsg').textContent = '';
  const f = el('dicomFiles'); f.files = ser24('1.2.42.1', 'BONE', 'Bone', 400); fire('dicomFiles', 'change');
  await new Promise(r => setTimeout(r, 5));
  fire('sampleM', 'click');
  assert.ok(await until(() => S.source && S.source.type === 'sample' && el('busy').hidden && !St.loadBusy()), 'sample loaded');
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(S.source.type, 'sample', 'the DICOM read did not land over the sample');
  assert.match(el('caseMsg').textContent, /Yükleme iptal edildi/);
});

test('a new volume waits for a guide job that is already running before it clears the plan', async () => {
  const T = P.g.THREE, n = 16, hu = new Int16Array(n * n * n).fill(-1000);
  S.anchor = { p: new T.Vector3(1, 2, 3), n: new T.Vector3(0, 0, 1), axis: new T.Vector3(1, 0, 0) };
  let seen = 'not run';
  const job = St.exclusive(async () => { await new Promise(r => setTimeout(r, 300)); seen = S.anchor ? S.anchor.p.x : null; });
  const load = St.setVolume({ hu, nx: n, ny: n, nz: n, sp: [1, 1, 1], origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} }, 'test', 'dicom');
  await job; assert.equal(seen, 1, 'the running job still had its anchor');
  await load; assert.equal(S.anchor, null, 'the new volume cleared the plan afterwards');
});

await run('loading and picks');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
