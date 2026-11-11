// Denetim 8 (2026-11-10) regressions in app.js / mpr.js (each failed on 7a277ac):
//  1. the open plan's marginal plane was the default of every guide build (Studio.buildGuide, guideRequest), so the fibula
//     guide of a marginal jaw plan (preview and production request) was clipped by a plane of the mandible;
//  2. the automatic layout could split a marginal guide in two, leaving the horizontal cut without a guide body;
//  3. a suggested marginal height over the slider's 30 mm was not restored by applyPlan (lost on save, undo, Başa dön);
//  4. "Planı sıfırla" kept the marginal resection, the lesion type, the margin and the fragile mark for the next region;
//  5. the fragile mark and "lesion type: not stated" changed the plan hash but left the lesion item approved;
//  6. a click on a cut's line in a slice view (no drag) dropped the cut's approval and rebuilt the guide.
// Phantom: tests/phantoms/phantoms.mjs mandibleBar. Run: node test_d8_app.mjs
import fs from 'node:fs';
import { test, run, assert } from './lib/t.mjs';
import { studio, ready, REPO, FakeEl } from './lib/harness.mjs';
import { mandibleBar } from '../../phantoms/phantoms.mjs';

const ctx2d = new Proxy({}, { get: (o, k) => k in o ? o[k] : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) : k === 'canvas' ? { width: 800, height: 600 } : k === 'measureText' ? () => ({ width: 10 }) : () => {} });
FakeEl.prototype.getContext = function () { return ctx2d; };
const P = studio({ post: ['lesion.js', 'mpr.js'], extra: { confirm: () => true, addEventListener() {}, removeEventListener() {}, fetch: async () => { throw new Error('offline'); } } });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), MPR = P.g.MPR, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const vol = mandibleBar({ gum: false });
S.vol = { hu: vol.hu, nx: vol.nx, ny: vol.ny, nz: vol.nz, sp: vol.sp, origin: vol.origin, axes: vol.axes, meta: vol.meta };
S.source = { type: 'dicom', name: 'phantom', fp: 'phantom-d8' };
S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
St.bus.dispatchEvent(new P.g.CustomEvent('volume', { detail: {} }));
await St.segment(true); await St.settled();
const plan0 = () => {
  S.anchor = { p: V(0, -6, -12), n: V(0, -1, 0), axis: V(1, 0, 0) }; S.g.rot = 0;
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 0.8, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 0.8, ok: false }];
  S.lesion.condyle = null; S.lesion.from = -12; S.lesion.to = 12;
};

test('a guide built for another bone is not clipped by the jaw plan\'s marginal plane', async () => {
  plan0(); S.lesion.marginal = 8;
  assert.ok(St.margPlane(), 'the jaw plan has a marginal plane');
  const fake = [{ p: V(100, 100, 100), pSlot: V(100, 100, 100), N: V(0, 0, 1), w: 1 }];
  const out = St.margPlanes({ pls: fake, wings: null }, q => [q.x, q.y, q.z]);
  assert.equal(out.length, 1, 'no horizontal plane added'); assert.ok(!out[0].clip, 'no clip');
  const BAR = q => q.z < 0 && q.z > -14 && Math.abs(q.y) < 8 && Math.abs(q.x) < 70;
  const ctx = m => Object.assign({ P: V(0, 0, 0), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), pls: [{ p: V(0, 0, 0), N: V(1, 0, 0), w: 0.8, off: 0 }], scs: [], bone: BAR, h: 0.4, fast: true,
    g: Object.assign({}, St.G_DEFAULT, { wrapU: null, W: 22, wrap: 4 }) }, m);
  const a = await St.buildGuide(ctx({})), b = await St.buildGuide(ctx({ marg: null }));
  let diff = 0; for (let i = 0; i < a.grid.Gm.length; i++) if (a.grid.Gm[i] !== b.grid.Gm[i]) diff++;
  assert.equal(diff, 0, `${diff} cells differ`);
  // the mandible's own builds do pass it
  const src = fs.readFileSync(REPO + '/web/app.js', 'utf8');
  assert.ok((src.match(/marg: margPlane\(\)/g) || []).length >= 4, 'the mandible preview, fit and production builds pass marg');
  delete S.lesion.marginal;
});

test('a marginal resection keeps the guide in one piece on a long resection', async () => {
  plan0(); S.planes[0].off = -32; S.planes[1].off = 32; S.lesion.from = -30; S.lesion.to = 30;
  Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, St.AUTO_DEFAULT || { split: 1 });
  assert.ok(S.gAuto.split, 'automatic layout on'); assert.ok(St.longCase(), 'the resection is long enough for two guides');
  S.lesion.marginal = 8;
  await St.makeGuide(); await St.settled();
  assert.ok(S.result, 'guide built'); assert.equal(S.g.split, 0, `split ${S.g.split}`);
  delete S.lesion.marginal;
});

test('the marginal height stays inside the slider range, which applyPlan restores', async () => {
  const el = $('l_marg'), src = fs.readFileSync(REPO + '/web/app.js', 'utf8'), html = fs.readFileSync(REPO + '/web/index.html', 'utf8');
  const m = /id="l_marg" min="([\d.]+)" max="([\d.]+)"/.exec(html), k = /const MARG_LO = ([\d.]+), MARG_HI = ([\d.]+);/.exec(src);
  assert.ok(m && k, 'slider and constants found'); assert.equal(+m[1], +k[1]); assert.equal(+m[2], +k[2]);
  assert.match(src, /S\.lesion\.marginal = Math\.min\(MARG_HI, hA\)/);
  plan0(); S.lesion.marginal = +k[2];
  const plan = JSON.parse(JSON.stringify(St.planOf())); delete S.lesion.marginal;
  await St.applyPlan(plan); await St.settled();
  assert.equal(S.lesion.marginal, +k[2], 'the largest height the studio sets comes back');
  void el;
});

test('marginal resection: the bone left is measured where the lower border is highest, and the canal must lie between the cuts', () => {
  plan0(); S.lesion.marginal = 10;
  const M0 = St.margPlane(); assert.ok(M0 && Math.abs(M0.hMin - 10) < 1, `straight bar: ${M0 && M0.hMin}`);
  // the lower border raised by 5 mm over the half of the segment at +x
  const r = S.red, m = S.mask.slice(), up = M0.N; let n = 0;
  for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
    const v = i + r.nx * (j + r.ny * k); if (!m[v]) continue;
    const w = G.worldOf(r, i, j, k); if (w[0] > 0 && w[0] < 16 && w[0] * up.x + w[1] * up.y + w[2] * up.z < M0.lb + 5) { m[v] = 0; n++; }
  }
  assert.ok(n > 50, 'bone removed under the border');
  const old = S.mask; S.mask = m;
  try {
    const M = St.margPlane(); assert.ok(M, 'plane'); assert.ok(Math.abs(M.h - 10) < 1e-9);
    assert.ok(M.hMin < 6.5 && M.hMin > 3.5, `bone left at the raised border ${M.hMin}`);
  } finally { S.mask = old; }
  // the canal rule
  const L = P.g.Lesion, cnt = L.count; L.count = () => 5;
  try {
    S.canals = [{ pts: [[40, -2, -10], [50, -2, -10]] }];
    assert.match(St.margBlock(), /kesiler arasında işaretleyin/, 'a canal outside the cuts does not allow it');
    S.canals = [{ pts: [[-5, -2, -10], [5, -2, -10]] }];
    assert.equal(St.margBlock(), '');
  } finally { L.count = cnt; S.canals = []; delete S.lesion.marginal; }
});

test('Planı sıfırla clears the resection type, the lesion type, the margin and the fragile mark', async () => {
  plan0(); Object.assign(S.lesion, { marginal: 8, type: 'malign', margin: 10, marginSet: true, fragile: true });
  await St.resetPlan();
  assert.equal(S.lesion.marginal, undefined); assert.equal(S.lesion.type, undefined); assert.equal(S.lesion.marginSet, undefined);
  assert.equal(S.lesion.fragile, undefined); assert.equal(S.lesion.margin, 3);
});

test('the fragile mark and an unset lesion type drop the lesion\'s approval', () => {
  plan0();
  const fire = (id, v, prop = 'value') => { const e = $(id); e[prop] = v; (e.listeners.change || []).forEach(f => f({ target: e })); };
  Object.assign(S.lesion, { ok: true, by: 'test', sig: 'x' });
  fire('l_fragile', true, 'checked'); assert.ok(!S.lesion.ok, 'fragile: approval dropped');
  Object.assign(S.lesion, { ok: true, by: 'test', sig: 'x', type: 'benign' });
  fire('l_type', ''); assert.ok(!S.lesion.ok, 'type unset: approval dropped');
  fire('l_fragile', false, 'checked');
});

test('a click on a cut line in a slice selects the cut and changes nothing; a drag moves it', async () => {
  plan0(); await St.makeGuide(); await St.settled();
  $('vmQuad').dispatchEvent({ type: 'click' }); await sleep(50); MPR.redraw(); await sleep(50);
  const down = (c, X, Y) => c.dispatchEvent({ type: 'pointerdown', button: 0, clientX: X, clientY: Y, pointerId: 1, shiftKey: false });
  const up = c => c.dispatchEvent({ type: 'pointerup', pointerId: 1 });
  // find a point on a cut line: the first pointer-down that selects a cut
  let hit = null;
  outer: for (const v of MPR.views) { const c = v.canvas; if (!(v.lines || []).length) continue;
    for (let Y = 10; Y < c.height; Y += 6) for (let X = 10; X < c.width; X += 6) {
      S.sel = null; S.planes.forEach(p => Object.assign(p, { ok: true, by: 'test', sig: 'x' }));
      const before = JSON.stringify(S.planes); down(c, X, Y);
      if (MPR.state.drag && MPR.state.drag.kind === 'plane') { hit = { v, c, X, Y, i: MPR.state.drag.i, before }; break outer; }
      up(c);
    } }
  assert.ok(hit, 'a cut line was found on a slice view');
  up(hit.c); await St.settled();
  assert.equal(S.sel, 'p' + hit.i, 'the cut is selected');
  assert.equal(JSON.stringify(S.planes), hit.before, 'the click left the cut and its approval as they were');
  // a real drag still moves the cut and drops its approval
  down(hit.c, hit.X, hit.Y); hit.c.dispatchEvent({ type: 'pointermove', clientX: hit.X + 25, clientY: hit.Y + 25, pointerId: 1 }); up(hit.c); await St.settled();
  assert.ok(!S.planes[hit.i].ok, 'the dragged cut needs approval again');
  assert.notEqual(JSON.stringify(S.planes.map(p => [p.off, p.yaw, p.pitch, p.pv, p.pn])), JSON.stringify(JSON.parse(hit.before).map(p => [p.off, p.yaw, p.pitch, p.pv, p.pn])), 'the drag moved the cut');
});

await run('Denetim 8: app.js / mpr.js');
process.exit(process.exitCode || 0);
