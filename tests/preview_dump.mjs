// Builds the browser preview guide (web/app.js through window.Studio in a node vm, no browser) for a few cases and
// writes, per case, the production request(s) the studio itself sends to /guide (captured from productionSTL through a
// stubbed fetch) and the preview mesh, so tests/test_server_preview.py can compare the server's STL with the preview.
// Synthetic bone and the built-in sample case; a real series only when --real <folder> is given (nothing from it is
// written anywhere but the output folder you name; never commit it).
//   node tests/preview_dump.mjs <outdir> [--cases bar,sample,arc,arc_split2,arc_bar] [--real <dicom folder> --cells body:L:45,angle:L:60]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { studio, ready, REPO } from './web/unit/lib/harness.mjs';

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: node tests/preview_dump.mjs <outdir> [--cases a,b] [--real <dir> --cells body:L:45]'); process.exit(2); }
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const cases = (opt('--cases') || 'bar,sample,arc,arc_split2,arc_bar').split(',').filter(Boolean);
const real = opt('--real'), cells = (opt('--cells') || 'body:L:45,angle:L:60').split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

// ---------- studio in node: fetch serves the sample files and captures the production requests ----------
const captured = [];
const emptyStl = Buffer.alloc(84);
const fetchStub = async (url, init) => {
  const s = String(url);
  if (/\/guide\/progress\?/.test(s)) return { ok: true, status: 200, json: async () => ({ f: null, stage: 'none' }) };
  if (init && init.method === 'POST' && /\/guide(\?job=[\w-]+)?$/.test(s)) {
    captured.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ stl_b64: emptyStl.toString('base64'), watertight: true, bodies: 1, volume_mm3: 0, faces: 0, ms: 0 }) };
  }
  const f = path.join(REPO, 'web', s.replace(/^.*\//, ''));
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')), text: async () => fs.readFileSync(f, 'utf8') };
};
const P = studio({ extra: { fetch: fetchStub, AbortController: globalThis.AbortController }, server: 'http://server.invalid', dicom: !!real, pre: real ? ['codecs.js', 'unzip.js'] : [], post: real ? ['bones.js'] : [] });
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function idle(ms = 300, timeout = 600000) {
  const t0 = performance.now(); let since = null;
  while (performance.now() - t0 < timeout) {
    const ok = $('busy').hidden && (!S.guideOn || St.live.shown >= St.live.ver);
    if (ok) { if (since === null) since = performance.now(); if (performance.now() - since >= ms) return; } else since = null;
    await sleep(50);
  }
  throw new Error('timeout waiting for idle: ' + $('busyText').textContent);
}

// ---------- synthetic CT (as tests/web/unit/test_adaptive.mjs) ----------
async function volume(bone, box = { x: 50, y: 24, z: 42 }) {
  const sp = [0.8, 0.8, 0.8], nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (bone(x, y, z)) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: { acqDate: '20260101' } };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
  Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, St.AUTO_DEFAULT); S.fitLog = []; S.autoSize = null; S.result = null;
  Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null, ok: false });
}
const ellipseBar = (hy, hz, len = 48) => (x, y, z) => Math.abs(x) < len && (y / hy) ** 2 + ((z + hz) / hz) ** 2 < 1;
// bone bent about the v (y) axis: a 45 mm radius arc in the x-z plane, elliptical cross-section (8 x 7), top at x = 0
const ARC = (x, y, z) => { const r = Math.hypot(x, z + 45), th = Math.atan2(x, z + 45); if (Math.abs(th) > 1.25) return false; const d = 45 - 7 - r; return (y / 8) ** 2 + (d / 7) ** 2 < 1; };
async function plan(offs, opts = {}) {
  S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) };
  S.planes = offs.map(off => ({ off, yaw: 0, pitch: 0, w: 1.2 }));
  S.g.split = opts.split || 0; if (opts.split) S.gAuto.split = 0;
  S.g.bar = opts.bar ? 1 : 0; S.gAuto.bar = 0;
  S.guideOn = true; St.placeScrews(); await St.rebuildResection();
  if (opts.fit) await St.fitWrap();
  await St.regenerate(); await idle();
}

// ---------- one case: the preview mesh and the request(s) productionSTL sends ----------
async function dump(name, extra = {}) {
  if (!St.parts.guide || !S.result) throw new Error(name + ': no guide');
  captured.length = 0;
  $('expSrv').click();
  // one request per guide piece, and one for the connecting bar when the plan has one
  const hasBar = !!(S.result.bar && S.result.bar.ok), want = (S.result.parts && S.result.parts.length === 2 ? 2 : 1) + (hasBar ? 1 : 0);
  for (let i = 0; i < 6000 && !(captured.length >= want && $('busy').hidden); i++) await sleep(50);
  if (captured.length !== want) throw new Error(`${name}: ${captured.length} requests captured, expected ${want} (${$('prodMsg').textContent})`);
  const R = S.result, parts = R.parts || null;
  const meta = Object.assign({
    name, split: S.g.split, pieces: R.pieces, volume: R.volume, contact: R.contact, undercut: R.undercut, dropped: R.dropped || null,
    bar: hasBar, seatDir: R.seatDir ? { tilt: R.seatDir.tilt, az: R.seatDir.az } : null, parts: parts && parts.map(p => ({ g: p.g, seatDir: p.result.seatDir && { tilt: p.result.seatDir.tilt, az: p.result.seatDir.az }, pieces: p.result.pieces, volume: p.result.volume })),
    g: Object.assign({}, S.g), gAuto: Object.assign({}, S.gAuto), fitLog: S.fitLog, planes: S.planes.map(p => ({ off: p.off, yaw: p.yaw, pitch: p.pitch, w: p.w })),
    screws: R.screwInfo.map(si => ({ ok: !!si.ok, noBody: !!si.noBody, shadowed: si.shadowed || 0 })), anchor: { p: S.anchor.p.toArray(), n: S.anchor.n.toArray() },
    red: { sp: S.red.sp, dims: [S.red.nx, S.red.ny, S.red.nz] }, vol: { sp: S.vol.sp, dims: [S.vol.nx, S.vol.ny, S.vol.nz] }, crit: (S.checkList || []).filter(c => c[0] === 'crit').map(c => c[2]),
  }, extra);
  fs.writeFileSync(path.join(out, name + '_meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(out, name + '_reqs.json'), JSON.stringify(captured));
  fs.writeFileSync(path.join(out, name + '_preview.stl'), St.stlOf(St.parts.guide.obj));
  if (hasBar) {
    if (!St.parts.bar) throw new Error(name + ': bar planned but no bar mesh');
    fs.writeFileSync(path.join(out, name + '_bar_preview.stl'), St.stlOf(St.parts.bar.obj));
    fs.writeFileSync(path.join(out, name + '_bar_meta.json'), JSON.stringify({ route: S.result.bar.route, len: S.result.bar.len, clear: S.result.bar.clear, d: S.result.bar.d }, null, 1));
  }
  console.log(`${name}: split ${S.g.split} pieces ${R.pieces} volume ${R.volume.toFixed(0)} mm3 seat ${JSON.stringify(meta.seatDir || meta.parts.map(p => p.seatDir))} L ${S.g.L} W ${S.g.W} wrap ${S.g.wrap} screws ${meta.screws.map(s => s.ok ? 'ok' : 'x').join(',')} requests ${captured.length} (${captured.map(r => `${r.crop.nx}x${r.crop.ny}x${r.crop.nz}`).join(' ')})`);
}

for (const c of cases) {
  const t = performance.now();
  if (c === 'bar') { await volume(ellipseBar(10, 6)); await plan([-12, 12], { fit: true }); await dump(c); }
  else if (c === 'arc') { await volume(ARC, { x: 50, y: 24, z: 50 }); await plan([-25, 25], { fit: true }); await dump(c); }
  else if (c === 'arc_split2') { await volume(ARC, { x: 50, y: 24, z: 50 }); await plan([-25, 25], { split: 2 }); await dump(c); }
  // two guides joined by the connecting bar (the long-resection layout): the bar is a third, separate request
  else if (c === 'arc_bar') { await volume(ARC, { x: 50, y: 24, z: 50 }); await plan([-25, 25], { split: 2, bar: true }); if (!(S.result.bar && S.result.bar.ok)) throw new Error('arc_bar: no bar (' + JSON.stringify(S.result.bar && S.result.bar.why) + ')'); await dump(c); }
  else if (c === 'sample') {
    S.autoAnchor = true;
    S.source = { type: 'sample', name: 'mandible', fp: 'sample:mandible' };
    const vol = await St.readSample('mandible');
    await St.setVolume(vol, 'Örnek: mandibula (sentetik BT)', 'mandible'); await idle();
    $('autoPrep').click(); await sleep(300); await idle(); await dump(c, { guideStat: $('guideStat').textContent });
  } else throw new Error('unknown case ' + c);
  console.log(`  (${((performance.now() - t) / 1000).toFixed(1)} s)`);
}

// ---------- real series (optional): the sweep's region placement (tests/sweep/sweep_page.js) ----------
if (real) {
  const files = fs.readdirSync(real).filter(f => !f.startsWith('.')).sort().map(f => new File([fs.readFileSync(path.join(real, f))], f));
  const t = performance.now();
  const r = await St.readDicom(files);
  if (r.error) throw new Error('readDicom: ' + r.error);
  S.autoAnchor = true; S.source = { type: 'dicom', name: 'real', fp: 'real' };
  await St.setVolume(r.vol, r.label, 'dicom'); await idle();
  console.log(`real series: ${r.vol.nx}x${r.vol.ny}x${r.vol.nz} @ ${r.vol.sp.map(x => x.toFixed(3)).join('x')} mm, work grid ${S.red.nx}x${S.red.ny}x${S.red.nz}, segmentation "${S.segMethod}" (${((performance.now() - t) / 1000).toFixed(1)} s)`);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'tests', 'sweep', 'sweep_page.js'), 'utf8'), P.ctx, { filename: 'sweep_page.js' });
  const SW = P.g.SW;
  for (const cell of cells) {
    const [region, side, len] = cell.split(':');
    const t1 = performance.now();
    // a fresh plan per cell: the previous region's anchor, cuts and settings must not carry over
    S.anchor = null; S.planes = []; S.screws = []; S.guideOn = false; S.result = null; S.g.split = 0; Object.assign(S.g, St.G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, St.AUTO_DEFAULT);
    const setup = await SW.setRegion(region, side, +len);
    if (!setup.ok) { console.log(`real_${region}_${side}_${len}: ${setup.why}`); continue; }
    await idle();
    await dump(`real_${region}_${side}_${len}`, { setup: { centre: setup.centre, anchor: setup.anchor, lesion: setup.lesion, guideStat: setup.guideStat, arch: setup.arch } });
    console.log(`  (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
  }
}
process.exit(0);
