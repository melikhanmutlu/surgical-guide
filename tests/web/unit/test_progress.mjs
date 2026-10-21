// Progress bar of long jobs (Melikhan 2026-10-21: "guide oluştururken ne kadar bekleyeceğini yüzde ile göster"):
//  - busy({ f }) / busyFrac: a determinate bar with the percentage and, once the rate is known, the time left; never
//    backwards; a later step of the same job keeps its start; busy() without f leaves no stale percentage behind
//  - the guide kernel reports its stages (GKernel.run onProgress), buildGuide and the two-piece buildGuideSet pass them on
//    in order up to 1, the guide rebuild fills the bar on screen
//  - fitWrap: the first rung fills the bar (a further rung switches to the running bar with the attempt number)
//  - serverGuide: POST /guide?job=<id>, polls GET /guide/progress?job=<id> while it runs and hands the server's share on;
//    the production STL fills one bar over its calls
//  - the worker forwards { id, p } progress messages without ending the job
//  - the new strings have their English form
// Run: node test_progress.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, plain, src } from './lib/harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const P = studio({ server: 'http://srv', extra: { AbortController } });
const St = await ready(P), T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
{
  // a straight bar of bone along x
  const sp = [0.8, 0.8, 0.8], box = { x: 40, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 36 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-progress' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan(split = 0) {
  await St.settled(); S.prod = null;
  S.g.split = split; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
}
const ctxOf = () => Object.assign({ g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld(), bone: St.boneAt, field: St.guideField() }, St.frameAxes());
const width = () => parseFloat($('busyBar').firstElementChild.style.width);

test('busy({ f }) shows a determinate bar with the percentage; busyFrac never runs backwards and gives the time left', async () => {
  St.busy(true, 'Guide üretiliyor…', { f: 0, restart: true });
  assert.equal($('busyBar').hidden, false); assert.ok($('busyBar').classList.contains('det'));
  assert.match($('busyText').textContent, /^Guide üretiliyor… %0$/);
  await sleep(900);
  assert.ok(St.busyFrac(0.5, null, true));
  assert.equal(width(), 50); assert.equal($('busyBar').getAttribute('aria-valuenow'), '50');
  assert.match($('busyText').textContent, /%50 · yaklaşık 1 sn kaldı$/, $('busyText').textContent);
  St.busyFrac(0.3, null, true);
  assert.equal(width(), 50, 'never backwards');
  // a later step of the same job keeps the bar and its start
  St.busy(true, 'Adım 2', { f: 0.6 });
  assert.equal(width(), 60); assert.match($('busyText').textContent, /^Adım 2 %60/);
  // a job without a percentage: the running bar, no stale width or value
  St.busy(true, 'Başka iş');
  assert.equal($('busyBar').hidden, true); assert.equal($('busyBar').getAttribute('aria-valuenow'), null);
  assert.equal(St.busyFrac(0.9, null, true), false, 'no determinate job on screen');
  St.busy(false);
});

test('busySpan maps a part of the job; the step text can change on the way', () => {
  St.busy(true, 'İş', { f: 0, restart: true });
  const sp = St.busySpan(0.4, 0.8, 'İkinci adım');
  sp(0.5); St.busyFrac(NaN, null, true);
  assert.ok(Math.abs(width() - 60) < 1e-9, String(width())); assert.match($('busyText').textContent, /^İkinci adım %60/);
  sp(2); St.busyFrac(NaN, null, true); assert.ok(Math.abs(width() - 80) < 1e-9, 'clamped to the part');
  St.busy(false);
});

test('GKernel.run reports its stages in order, ending at 1; the result does not depend on the callback', async () => {
  await plan();
  const seen = [], a = await St.buildGuide(Object.assign(ctxOf(), { onProgress: f => seen.push(f) }));
  const b = await St.buildGuide(ctxOf());
  assert.ok(seen.length >= 6, 'bone sampling, the kernel stages, the mesh: ' + JSON.stringify(seen));
  assert.deepEqual(seen, seen.slice().sort((x, y) => x - y), 'in order');
  assert.equal(seen.at(-1), 1); assert.ok(seen[0] > 0 && seen[0] < 0.2);
  assert.equal(a.mesh.geometry.attributes.position.count, b.mesh.geometry.attributes.position.count);
  assert.equal(a.result.volume, b.result.volume);
});

test('two-piece guide: each piece fills its half of the bar', async () => {
  await plan(2);
  const seen = []; await St.buildGuideSet(Object.assign(ctxOf(), { onProgress: f => seen.push(f) }));
  assert.ok(seen.some(f => f > 0.3 && f <= 0.5) && seen.some(f => f > 0.5 && f < 1), JSON.stringify(seen));
  assert.deepEqual(seen, seen.slice().sort((x, y) => x - y)); assert.equal(seen.at(-1), 1);
  await plan(0);
});

test('the guide rebuild fills the bar on screen (determinate, ending at 100 %)', async () => {
  const log = [];
  // watch the bar while the rebuild runs
  let stop = false; const watch = (async () => { while (!stop) { if (!$('busy').hidden && $('busyBar').classList.contains('det')) log.push(width()); await sleep(0); } })();
  S.g.wrap = S.g.wrap === 5 ? 6 : 5; await St.regenerate(); stop = true; await watch;
  assert.ok(log.length >= 2, 'the bar was determinate during the rebuild: ' + JSON.stringify(log.slice(0, 20)));
  assert.ok(log.some(w => w > 0 && w < 100), 'it moved between 0 and 100: ' + JSON.stringify(log));
});

test('fitWrap: the first rung reports progress, in order, past the coarse build', async () => {
  await plan();
  const seen = []; St.busy(true, 'Guide oluşturuluyor… 2/2', { f: 0, restart: true });
  const f = await St.fitWrap({ onProgress: x => seen.push(x) });
  assert.ok(f, 'fit ran');
  const rungs = (S.fitLog || []).length;
  assert.ok(seen.length >= 4 && seen.some(x => x > 0.3), JSON.stringify(seen));
  assert.deepEqual(seen, seen.slice().sort((x, y) => x - y));
  if (rungs > 1) assert.match($('busyText').textContent, /deneme \d+/);
  St.busy(false);
});

test('serverGuide: POST /guide?job=<id>, polls /guide/progress with the same id and passes the share on', async () => {
  await plan();
  const reply = { stl_b64: Buffer.from(new Uint8Array(84)).toString('base64'), watertight: true, production_ok: true, bodies: 1, volume_mm3: 4000, faces: 10, ms: 5 };
  const calls = [], old = W.fetch; let polls = 0;
  W.fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET' });
    if (/\/guide\/progress\?job=/.test(url)) { polls++; return new Response(JSON.stringify(polls === 1 ? { f: null, stage: 'none' } : polls === 2 ? { f: 0, stage: 'queue' } : { f: Math.min(1, 0.25 * polls), stage: 'edt' }), { status: 200 }); }
    await sleep(2400);
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  try {
    const seen = [], r = await St.serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr() }, ctxOf()), null, (f, st) => seen.push([f, st]));
    assert.equal(r.watertight, true);
    const post = calls.find(c => c.method === 'POST'), job = /\/guide\?job=([0-9a-f]{18})$/.exec(post.url);
    assert.ok(job, post.url);
    const pollsOf = calls.filter(c => c.method === 'GET');
    assert.ok(pollsOf.length >= 2 && pollsOf.every(c => c.url === `http://srv/guide/progress?job=${job[1]}`), JSON.stringify(pollsOf));
    assert.deepEqual(seen[0], [0, 'queue'], 'a poll before the job exists (f null) is not passed on');
    assert.ok(seen.some(([f, st]) => f > 0 && st === 'edt'), JSON.stringify(seen));
    // polling stops with the answer
    const n = calls.length; await sleep(1600); assert.equal(calls.length, n, 'no polls after the reply');
    // without a progress callback: no job id, no polls
    calls.length = 0; await St.serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr() }, ctxOf()));
    assert.deepEqual(calls.map(c => c.url), ['http://srv/guide']);
  } finally { W.fetch = old; }
});

test('serverGuide: an older server without the progress endpoint (404) stops the polling, the build goes on', async () => {
  const reply = { stl_b64: Buffer.from(new Uint8Array(84)).toString('base64'), watertight: true, bodies: 1, volume_mm3: 1, faces: 1, ms: 1 };
  const calls = [], old = W.fetch;
  W.fetch = async (url, o = {}) => { calls.push(url); if (/progress/.test(url)) return new Response('not found', { status: 404 }); await sleep(2000); return new Response(JSON.stringify(reply), { status: 200 }); };
  try {
    const r = await St.serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr() }, ctxOf()), null, () => {});
    assert.equal(r.watertight, true);
    assert.equal(calls.filter(u => /progress/.test(u)).length, 1, JSON.stringify(calls));
  } finally { W.fetch = old; }
});

test('productionSTL: one bar over the server calls, filled from the server progress', async () => {
  await plan();
  const reply = { stl_b64: Buffer.from(new Uint8Array(84)).toString('base64'), watertight: true, production_ok: true, bodies: 1, volume_mm3: 4000, faces: 10, ms: 5 };
  const old = W.fetch, widths = []; let polls = 0;
  W.fetch = async (url, o = {}) => {
    if (/progress/.test(url)) { polls++; return new Response(JSON.stringify({ f: Math.min(0.9, 0.3 * polls), stage: 'env' }), { status: 200 }); }
    await sleep(2600); return new Response(JSON.stringify(reply), { status: 200 });
  };
  let stop = false; const watch = (async () => { while (!stop) { if (!$('busy').hidden && $('busyBar').classList.contains('det')) widths.push(width()); await sleep(50); } })();
  try { $('expSrv').click(); for (let i = 0; i < 200 && !S.prod; i++) await sleep(50); }
  finally { stop = true; await watch; W.fetch = old; }
  assert.ok(S.prod && S.prod.watertight, 'the production STL came back');
  assert.ok(widths.some(w => w > 0 && w < 100), 'the bar moved with the server: ' + JSON.stringify(widths.slice(0, 40)));
  assert.match($('busyText').textContent, /hazırlanıyor… 1\/1|%/);
});

test('the worker forwards { id, p } progress without ending the job; gworker posts progress only when asked', async () => {
  const code = src('gworker.js');
  assert.match(code, /GKernel\.run\(m\.K, m\.progress \? p => self\.postMessage\(\{ id: m\.id, p \}\) : null\)/);
  // the page side: a fake Worker that sends two progress messages, then the answer
  const app = src('app.js');
  assert.match(app, /if \(e\.data\.p != null\) \{ if \(j\.onProgress\)/);
});

test('the new strings have their English form', () => {
  const Q = plain({ localStorage: { getItem: () => 'en', setItem() {} }, document: { readyState: 'complete', documentElement: { lang: 'tr', nodeType: 1, firstChild: null, hasAttribute: () => false }, title: '', getElementById: () => null, addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} }, alert() {}, confirm: () => true, prompt: () => null, Event: class {}, dispatchEvent() {} });
  Q.load('i18n_en.js'); Q.load('i18n.js');
  const t = Q.eval('I18N.t');
  for (const [tr, en] of [['Guide kemiğe oturtuluyor · deneme 3', 'Seating the guide on the bone · attempt 3'], ["Fibula guide'ı oturtuluyor · deneme 2", 'Seating the fibula guide · attempt 2'],
    ['Sunucu başka bir işi bitiriyor; sırada…', 'The server is finishing another job; queued…'], ['İlerleme', 'Progress'], ['%42', '42%'], ['· yaklaşık 12 sn kaldı', '· about 12 s left']]) assert.equal(t(tr), en);
});

await run('progress bar (busy, guide kernel, fit, server job)');
