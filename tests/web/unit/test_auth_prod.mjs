// Denetim 4 server follow-ups in the studio:
//  G2   access token: auth.js sends `Authorization: Bearer <token>` on every server call, asks once (one dialog for calls
//       that meet a 401 together), clears a refused token, asks again and retries once; no question without YOLMED_AUTH;
//       store.js treats a 401 probe as "server present, token needed"; app.js / store.js / ui.js call the server through it
//  P5/P6/E3 the /guide reply's production_ok, issues (screw_no_body + index, resolution_coarsened, not_manifold),
//       screws_missing, resolution and version are kept; production_ok false holds approval and the package back
//  version  window.YOLMED_VERSION in planOf() (outside the approval hash), plan.json, rapor.html, the PDF report
//  G4   SRI on the CDN scripts (the hashes match the vendored copies of the same files) and on the WASM codecs
//  W25  lesion.js runs fitWrap as an exclusive rebuild job
// Run: node test_auth_prod.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, run, assert } from './lib/t.mjs';
import { plain, studio, ready, src, VENDOR } from './lib/harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const memStore = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
// a fake server: answers 401 unless the right token comes with the call; records every call
function server(token = 'secret') {
  const calls = [];
  const fetch = async (url, o = {}) => {
    const h = o.headers || {}; calls.push({ url, auth: h.Authorization || null, method: o.method || 'GET' });
    if (token && h.Authorization !== 'Bearer ' + token && !/\/health$/.test(url)) return new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 });
    return new Response(JSON.stringify(/\/cases$/.test(url) ? [] : { ok: true }), { status: 200 });
  };
  return { calls, fetch };
}
function authCtx(srv, need) {
  const P = plain({ sessionStorage: memStore(), fetch: srv.fetch, YOLMED_AUTH: need, document: { getElementById: () => null } });
  P.load('auth.js'); const A = P.g.ServerAuth, asked = [];
  return { P, A, asked, answers: list => { A.prompt = async again => { asked.push(again); return list.shift() ?? null; }; } };
}

test('G2: asks once, sends the token, a refused token is cleared and asked again, the call retried once', async () => {
  const srv = server(), { A, asked, answers, P } = authCtx(srv, true);
  answers(['wrong', 'secret']);
  const r = await A.fetch('http://s/cases', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.deepEqual(asked, [false, true], 'asked before the first call, then again after the 401 (with the "not accepted" note)');
  assert.deepEqual(srv.calls.map(c => c.auth), ['Bearer wrong', 'Bearer secret']);
  assert.equal(P.g.sessionStorage.getItem('yolmed.token'), 'secret', 'kept for the tab');
  // later calls carry it, nothing is asked
  await A.fetch('http://s/guide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(asked.length, 2); assert.equal(srv.calls.at(-1).auth, 'Bearer secret');
  assert.equal(A.header({ a: 1 }).Authorization, 'Bearer secret');
});

test('G2: calls that meet a 401 together share one question; a wrong answer twice gives the 401 back (no loop)', async () => {
  const srv = server(), { A, asked, answers } = authCtx(srv, false);
  answers(['secret']);
  const rs = await Promise.all([A.fetch('http://s/cases'), A.fetch('http://s/cases/x'), A.fetch('http://s/guide', { method: 'POST' })]);
  assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
  assert.equal(asked.length, 1, 'one dialog for three calls');
  const s2 = server('other'), b = authCtx(s2, true); b.answers(['x', 'y', 'z']);
  const r = await b.A.fetch('http://s/cases');
  assert.equal(r.status, 401); assert.equal(s2.calls.length, 2, 'one retry only'); assert.equal(b.asked.length, 2);
  assert.equal(b.A.token(), 'y', 'the last answer is kept until the server refuses it');
});

test('G2: without YOLMED_AUTH on an open server nothing is asked and no header is sent; a closed dialog is not asked again until Settings', async () => {
  const srv = server(null), { A, asked, answers } = authCtx(srv, false);
  answers([]);
  assert.equal((await A.fetch('http://s/cases')).status, 200);
  assert.equal(asked.length, 0); assert.equal(srv.calls[0].auth, null);
  const s2 = server(), b = authCtx(s2, true); b.answers([null]);
  assert.equal((await b.A.fetch('http://s/cases')).status, 401);
  assert.equal((await b.A.fetch('http://s/cases')).status, 401);
  assert.equal(b.asked.length, 1, 'closing the dialog is remembered (no question on every autosave)');
  b.answers(['secret']); assert.equal(await b.A.enter(), true, 'Settings asks again');
  assert.equal((await b.A.fetch('http://s/cases')).status, 200);
});

test('G2: every server call in the studio goes through auth.js; the store probe takes a 401 as "server present"', () => {
  const app = src('app.js'), store = src('store.js'), ui = src('ui.js');
  for (const [f, code] of [['app.js', app], ['store.js', store], ['ui.js', ui]]) {
    const raw = [...code.matchAll(/\bfetch\(([^)]{0,80})/g)].map(m => m[1]).filter(a => !/^`sample_/.test(a));
    // what is left: the store's probe (sends the header itself) and the fallback inside the wrappers
    raw.forEach(a => assert.ok(/^url \+ '\/(cases|health)'|^u, o$/.test(a) || /ServerAuth/.test(a), `${f}: fetch(${a}) bypasses ServerAuth`));
  }
  assert.ok(/sfetch\(`\$\{url\}\/segment/.test(app) && (app.match(/sfetch\(url \+ '\/guide'/g) || []).length === 2, 'segment and both /guide calls');
  assert.ok(/ServerAuth\.header\(\)/.test(store) && /r\.status === 401\) return RestBackend\(url\)/.test(store));
  assert.ok(/fetch\(url \+ '\/health', \{ signal: ac\.signal, headers: window\.ServerAuth \? ServerAuth\.header\(\) : \{\} \}\)/.test(ui), 'the health light sends the token, never asks');
  const html = src('index.html');
  assert.ok(html.indexOf('src="config.js"') < html.indexOf('src="auth.js"') && html.indexOf('src="auth.js"') < html.indexOf('src="app.js"'), 'auth.js after config.js, before app.js');
  assert.ok(/<dialog id="dlgTok"[\s\S]*<input id="tokIn" type="password" autocomplete="off"/.test(html), 'an in-app dialog with a password field');
});

// ---------- the studio ----------
const srv = server();
const P = studio({ pre: ['auth.js'], post: ['store.js', 'audit.js', 'dates.js', 'report.js'], server: 'http://srv', extra: { addEventListener() {}, removeEventListener() {}, sessionStorage: memStore(), YOLMED_AUTH: true, YOLMED_VERSION: '9.9.9-test', fetch: srv.fetch, AbortController: globalThis.AbortController } });
P.g.ServerAuth.prompt = async () => 'secret';
const St = await ready(P), T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-auth' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan() {
  await St.settled(); S.prod = null;
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2';
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
}
const prodOf = (reply, sent) => Object.assign({ stl: new Uint8Array(84), watertight: reply.watertight ?? true, bodies: 1, volume: 5000, faces: 100, ms: 1 }, St.prodReply(reply, sent), { key: St.prodKey() });

test('G2: the store found the server through the 401 probe and its calls carry the token', async () => {
  for (let i = 0; i < 100 && $('stBackend').textContent !== 'Sunucu'; i++) await sleep(20);
  assert.equal($('stBackend').textContent, 'Sunucu', 'a 401 probe is a server that wants a token, not "offline"');
  const probe = srv.calls.find(c => /\/cases$/.test(c.url));
  assert.ok(probe, 'probed'); assert.ok(srv.calls.some(c => /\/cases$/.test(c.url) && c.auth === 'Bearer secret'), 'the list went with the token: ' + JSON.stringify(srv.calls.slice(0, 5)));
});

test('P5/P6: serverGuide keeps production_ok, issues, screws_missing, resolution and version from the reply', async () => {
  await plan();
  assert.ok(S.screws.length >= 2, 'screws placed: ' + S.screws.length);
  const reply = { stl_b64: Buffer.from(new Uint8Array(84)).toString('base64'), watertight: true, production_ok: false, bodies: 1, volume_mm3: 4000, faces: 10, ms: 5, version: '9.9.9-srv',
    issues: [{ code: 'screw_no_body', screw: 1 }, { code: 'resolution_coarsened', requested_mm: 0.2, used_mm: 0.35, coarser_than_preview: false }], screws_missing: 1, resolution: 0.35, requested_resolution: 0.2 };
  const calls = [];
  const old = W.fetch; W.fetch = async (url, o) => { calls.push({ url, auth: o.headers.Authorization }); return new Response(JSON.stringify(reply), { status: 200 }); };
  try {
    const c = Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld(), wrapProfile: S.result && S.result.wrapProfile, seatDir: S.result && S.result.seatDir }, St.frameAxes());
    const sent = c.scs.filter(s => s.entry), r = await St.serverGuide(c);
    assert.equal(calls[0].auth, 'Bearer secret', '/guide carries the token');
    assert.equal(r.productionOk, false); assert.equal(r.screwsMissing, 1); assert.equal(r.resolution, 0.35); assert.equal(r.version, '9.9.9-srv');
    assert.deepEqual([...r.screwNos], [S.screws.indexOf(sent[1].sc) + 1], 'the request index maps back to the plan screw');
    assert.equal(r.issues.length, 2);
  } finally { W.fetch = old; }
  // an older server without production_ok: judged by watertight
  assert.equal(St.prodReply({ watertight: false }, []).productionOk, false);
  assert.equal(St.prodReply({ watertight: true }, []).productionOk, true);
});

test('E3/P5: production_ok false (a screw without a body) holds approval and the package back; the message says why', async () => {
  await plan();
  const sent = St.screwsWorld().filter(s => s.entry);
  S.prod = prodOf({ watertight: true, production_ok: false, issues: [{ code: 'screw_no_body', screw: 0 }], screws_missing: 1, version: 'v-srv' }, sent);
  St.renderChecks(); St.renderAppr();
  const n = S.screws.indexOf(sent[0].sc) + 1, crit = S.checkList.filter(c => c[0] === 'crit');
  assert.ok(crit.some(c => c[2].startsWith(`Vida ${n} üretim STL'inde yok`) && c[3] === 's' + (n - 1)), JSON.stringify(crit.map(c => c[2])));
  assert.ok(S.crit > 0); assert.equal($('expZip').disabled, true, 'package locked');
  // the screw's approval is refused while its critical check stands
  $('surgeon').value = 'Dr X'; S.screws[n - 1].ok = false; St.approveItem('s' + (n - 1));
  assert.equal(S.screws[n - 1].ok, false); assert.ok(/kritik kontrol/.test($('apprMsg').textContent), $('apprMsg').textContent);
  assert.ok(/SUNUCU: BU STL BASILAMAZ\..*Vida \d+ üretim STL'inde yok/.test(St.prodWhy(S.prod)), St.prodWhy(S.prod));
  // a reply from the same plan that the server calls fine clears it
  S.prod = prodOf({ watertight: true, production_ok: true, issues: [] }, sent); St.renderChecks();
  assert.ok(!S.checkList.some(c => /üretim STL'inde yok|basılabilir/.test(c[2])));
});

test('P6/E3: a coarsened grid finer than the preview is information; coarser, or not manifold, is critical', async () => {
  await plan(); const base = S.crit;
  S.prod = prodOf({ watertight: true, production_ok: true, issues: [{ code: 'resolution_coarsened', requested_mm: 0.2, used_mm: 0.3, coarser_than_preview: false }], resolution: 0.3 }, []);
  St.renderChecks();
  assert.equal(S.crit, base, 'no critical');
  assert.ok(S.checkList.some(c => c[0] === 'info' && /ızgarası 0,30 mm'ye kabalaştırıldı \(istenen 0,20 mm\); önizlemeden yine ince/.test(c[2])), JSON.stringify(S.checkList.map(c => c[2])));
  S.prod = prodOf({ watertight: true, production_ok: false, issues: [{ code: 'resolution_coarsened', requested_mm: 0.2, used_mm: 0.5, coarser_than_preview: true }], resolution: 0.5 }, []);
  St.renderChecks();
  assert.ok(S.checkList.some(c => c[0] === 'crit' && /önizlemeden kaba/.test(c[2])));
  assert.equal($('expZip').disabled, true);
  S.prod = prodOf({ watertight: false, production_ok: false, issues: [{ code: 'not_manifold' }] }, []);
  St.renderChecks();
  assert.equal(S.checkList.filter(c => c[0] === 'crit' && /Üretim STL|üretim STL/.test(c[2])).length, 1, 'one critical for an open mesh (not two)');
  // the server's verdict alone, with a reason this studio does not know
  S.prod = prodOf({ watertight: true, production_ok: false, issues: [{ code: 'something_new' }] }, []);
  St.renderChecks();
  assert.ok(S.checkList.some(c => c[0] === 'crit' && /basılabilir bulmadı/.test(c[2])));
  S.prod = null; St.renderChecks();
});

test('version: planOf carries the studio version outside the approval hash; plan.json, rapor.html and the PDF line', async () => {
  await plan();
  assert.equal(St.planOf().software.studio, '9.9.9-test');
  const h = W.Audit.planHash(); W.YOLMED_VERSION = '10.0.0'; assert.equal(W.Audit.planHash(), h, 'a software update does not undo approvals'); W.YOLMED_VERSION = '9.9.9-test';
  S.prod = prodOf({ watertight: true, production_ok: true, issues: [], version: '9.9.8-srv' }, []);
  assert.deepEqual(JSON.parse(JSON.stringify(St.swInfo())), { studio: '9.9.9-test', guide_server: '9.9.8-srv' });
  assert.ok(St.reportHTML().includes('Yazılım sürümü: 9.9.9-test · üretim sunucusu 9.9.8-srv'), 'rapor.html');
  assert.ok(/software: swInfo\(\)/.test(src('app.js')), 'plan.json in the package carries both versions');
  assert.ok(/St\.swLine\(\)/.test(src('report.js')), 'the PDF report has the line');
  delete W.YOLMED_VERSION; assert.equal(St.planOf().software.studio, null);
  assert.ok(St.swLine().includes('bilinmiyor'));
  W.YOLMED_VERSION = '9.9.9-test'; S.prod = null;
});

test('G4: CDN scripts carry SRI that matches the files; the WASM codecs are checked too', () => {
  const html = src('index.html'), tags = [...html.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)];
  assert.equal(tags.length, 4);
  tags.forEach(([, url, rest]) => assert.ok(/integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/.test(rest), url));
  const sri = f => 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(path.join(VENDOR, f))).digest('base64');
  const of = name => tags.find(t => t[1].endsWith(name))[2];
  assert.ok(of('three.min.js').includes(sri('three.min.js')), 'three.min.js hash = vendored copy of the same CDN file');
  assert.ok(of('dicomParser.min.js').includes(sri('dicomParser.min.js')), 'dicomParser hash');
  const P2 = plain(); P2.load('codecs.js');
  Object.entries(P2.g.DicomCodecs.codecs).forEach(([k, c]) => { if (!c.esm) assert.ok(/^sha384-/.test(c.sri) && /^sha384-/.test(c.wasmSri), k); });
  const code = src('codecs.js');
  assert.ok(/s\.integrity = integrity/.test(code) && /integrity: c\.wasmSri/.test(code) && /wasmBinary/.test(code));
});

test('W25: lesion.js runs fitWrap as an exclusive rebuild job', () => {
  const l = src('lesion.js');
  assert.ok(/St\.exclusive\(\(\) => St\.fitWrap\(\)\)/.test(l)); assert.ok(!/await St\.fitWrap\(\)/.test(l));
});

await run('Denetim 4 server follow-ups in the studio');
await new Promise(r => process.stdout.write('', r)); process.exit(process.exitCode || 0);
