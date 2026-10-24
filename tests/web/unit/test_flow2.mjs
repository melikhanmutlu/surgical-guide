// The surgeon's main flow, steps 6-8 (approval, report) and the responsiveness fixes, on a synthetic straight bar:
//  - "Tüm öğeleri onayla" approves every item in one action, needs the surgeon's name, leaves an item with a critical check open
//  - the PDF report prints the engineer's and the surgeon's names and approval times in the signature block, and the
//    production STL state; the HTML report has the two approvals and a footer that matches the STLs in the package
//  - a pointer drag of a cut does not rebuild the guide until the drag ends
//  - the painted lesion's voxel list follows every stroke, erase and plan load (it is cached between changes)
// Run: node test_flow2.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';

// ---------- a canvas 2D context good enough for report.js: records fillText, measures text at 0.5 em per letter ----------
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
function ctx2d(cv) {
  const c = { canvas: cv, font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    measureText(t) { const px = +(/(\d+(?:\.\d+)?)px/.exec(this.font) || [0, 10])[1]; return { width: String(t).length * px * 0.5 }; },
    fillText() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {}, save() {}, restore() {} };
  return c;
}
const P = studio({ post: ['store.js', 'audit.js', 'dates.js', 'lesion.js'], extra: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
// canvases made by ui.js and report.js (loaded after this) get the 2D context above and a 1×1 JPEG as their picture
{ const ce = P.doc.createElement; P.doc.createElement = t => { const el = ce(t); if (t === 'canvas') { let g = null; el.getContext = () => g || (g = ctx2d(el)); el.toDataURL = () => 'data:image/jpeg;base64,' + Buffer.from(JPEG).toString('base64'); } return el; }; }
P.load('ui.js'); P.load('report.js');
const St = await ready(P); const T = P.g.THREE, S = St.S, G = P.eval('G'), W = P.g, $ = id => P.doc.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
const sleep = ms => new Promise(r => setTimeout(r, ms));
{
  const sp = [0.8, 0.8, 0.8], box = { x: 64, y: 24, z: 20 }, nx = Math.round(2 * box.x / sp[0]), ny = Math.round(2 * box.y / sp[1]), nz = Math.round((box.z + 6) / sp[2]);
  const origin = [-box.x, -box.y, -box.z], hu = new Int16Array(nx * ny * nz).fill(-1000);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2]; if (Math.abs(x) < 58 && (y / 10) ** 2 + ((z + 6) / 6) ** 2 < 1) hu[i + nx * (j + ny * k)] = 1200; }
  S.vol = { hu, nx, ny, nz, sp, origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], meta: {} };
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-flow2' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan() {
  await St.settled();
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2'; S.lesion.condyle = null;   // (as setVolume leaves it)
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
}
const frames = async () => { await sleep(260); await St.settled(); await sleep(30); };
const STD = `Hastaya özel`;
// a valid two-step sign-off appended to the audit log the way audit.js does it (act() is not exported)
function signOff(...roles) {
  const A = W.Audit, log = A.log().map(e => Object.assign({}, e));
  for (const role of roles) {
    const prev = log.length ? log[log.length - 1].hash : '0'.repeat(64);
    const e = { n: log.length + 1, at: new Date().toISOString(), role, name: role === 'eng' ? 'Müh Y' : 'Dr X', action: 'onay', comment: '', plan: A.planHash(), prev };
    e.hash = A.sha256([e.prev, e.n, e.at, e.role, e.name, e.action, e.comment, e.plan].join('|')); log.push(e);
  }
  W.PlanExt.audit.set({ log });
}

function pdfText(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  const objs = {}; for (const m of s.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) objs[m[1]] = m[2];
  const cmap = {}, font = Object.values(objs).find(o => /\/Type \/Font/.test(o));
  assert.ok(font, 'a font resource');
  const tu = /\/ToUnicode (\d+) 0 R/.exec(font); assert.ok(tu, 'the font has a /ToUnicode map');
  const cm = /stream\n([\s\S]*?)\nendstream/.exec(objs[tu[1]])[1];
  for (const m of cm.matchAll(/<([0-9A-F]{2})> <([0-9A-F]{4})>/g)) cmap[parseInt(m[1], 16)] = String.fromCharCode(parseInt(m[2], 16));
  const pages = [];
  for (const o of Object.values(objs)) {
    if (!/\/Type \/Page\b/.test(o)) continue;
    const cs = objs[/\/Contents (\d+) 0 R/.exec(o)[1]], body = /stream\n([\s\S]*?)\nendstream/.exec(cs)[1];
    assert.equal(+/\/Length (\d+)/.exec(cs)[1], Buffer.byteLength(body, 'latin1'), 'content stream /Length');
    assert.ok(!/NaN|Infinity|undefined/.test(body), 'no bad numbers in the content stream');
    const out = [];
    for (const m of body.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) {
      const raw = m[1].replace(/\\([0-7]{3}|.)/g, (_, e) => e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e);
      out.push([...raw].map(ch => cmap[ch.charCodeAt(0)] ?? '�').join(''));
    }
    assert.ok(/\bBT 3 Tr\b/.test(body), 'text drawn invisible (render mode 3) over the page picture');
    pages.push(out.join('\n'));
  }
  return pages;
}

test('Tüm öğeleri onayla: one action approves every item; without a name nothing; a critical item stays open', async () => {
  await plan(); S.crit = 0; S.qc = []; S.checkList = []; $('surgeon').value = ''; St.renderAppr();
  assert.equal($('apprAll').disabled, false, 'items wait: the button is on');
  $('apprAll').click();
  assert.ok(![S.lesion, ...S.planes, ...S.screws].some(o => o.ok), 'nothing approved without the surgeon name');
  assert.ok(/cerrahın adını/.test($('apprMsg').textContent), $('apprMsg').textContent);
  $('surgeon').value = 'Dr X'; $('apprAll').click();
  assert.ok([S.lesion, ...S.planes, ...S.screws].every(o => o.ok && o.by === 'Dr X'), 'every item approved by the surgeon ' + JSON.stringify([S.lesion, ...S.planes, ...S.screws].map(o => [o.ok, o.by])) + $('apprMsg').textContent + JSON.stringify(S.checkList));
  assert.equal(JSON.stringify(St.pendingList()), JSON.stringify(['Mühendis teknik onayı', 'Cerrah klinik onayı']));
  assert.equal($('apprAll').disabled, true, 'nothing left: the button is off');
  // a critical check on cut 1: it stays open, the rest is approved and the message names it
  St.unapproveAll(); S.checkList = [['crit', 'Kritik', 'test', 'p0']]; St.renderAppr();
  $('apprAll').click();
  assert.equal(S.planes[0].ok, false, 'cut 1 (critical) not approved');
  assert.ok(S.lesion.ok && S.planes[1].ok && S.screws.every(s => s.ok), 'the others approved');
  assert.ok(/Kesi 1/.test($('apprMsg').textContent), $('apprMsg').textContent);
  S.checkList = [];
});

test('reports: the engineer and the surgeon are printed with their approval times; production state and footer match the package', async () => {
  await plan(); S.crit = 0; S.qc = []; $('surgeon').value = 'Dr X'; S.prod = null;
  [S.lesion, ...S.planes, ...S.screws].forEach(o => St.stamp(o)); signOff('eng', 'sur'); St.renderAppr(); await frames();
  W.Image = class { constructor() { this.width = 1000; this.height = 640; } set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
  const all = pdfText(new Uint8Array(await (await W.Report.build()).arrayBuffer())).join('\n');
  for (const t of ['Ad Soyad: Müh Y', 'Ad Soyad: Dr X', 'Teknik onay:', 'Klinik onay:', "Üretim STL'i alınmadı; pakette yalnız 0,4 mm voksel önizleme var: guide.stl."])
    assert.ok(all.includes(t), `"${t}" in the PDF:\n` + all.slice(-1500));
  assert.ok(!all.includes('Ad Soyad: ________________'), 'no blank name line once both approved');
  let h = St.reportHTML();
  assert.ok(h.includes('İki aşamalı onay') && h.includes('Müh Y') && h.includes('Dr X'), 'HTML has the two approvals');
  assert.ok(h.includes("Pakette yalnız 0,4 mm voksel önizleme STL'leri var; üretim STL'i alınmadı.") && !h.includes('Guide 0,4 mm voksel çözünürlüğünde üretilmiştir'), 'footer says preview only');
  S.prod = { key: St.prodKey(), watertight: true, bodies: 1, volume: 5000, faces: 100, resolution: 0.2, productionOk: true, issues: [], screwNos: [] };
  h = St.reportHTML();
  assert.ok(/Guide üretim STL'i sunucuda 0,20 mm ızgarada yüzey tabanlı boolean ile üretilmiştir/.test(h), 'footer names the production grid ' + h.slice(-600));
  const all2 = pdfText(new Uint8Array(await (await W.Report.build()).arrayBuffer())).join('\n');
  assert.ok(all2.includes("Üretim STL'i sunucuda yüzey tabanlı boolean ile üretildi (guide_uretim.stl): su geçirmez, 1 parça"), 'PDF production line:\n' + all2.slice(-1500));
  S.prod = null;
});

test('a pointer drag of a cut rebuilds nothing until it ends; the end rebuilds once', async () => {
  await plan(); const R0 = S.result, builds = St.guideBuilds();
  S.planes[0].off -= 1; St.unapprove(S.planes[0]); St.schedule(true, 'drag');
  S.planes[0].off -= 1; St.schedule(true, 'drag');
  await sleep(700);
  assert.ok(S.result === R0 && St.guideBuilds() === builds, 'no build while the drag goes on');
  St.schedule(true); await St.settled();
  assert.ok(S.result !== R0, 'the release rebuilds the guide');
});

test('C2: putting the brush down after painting plans the cuts and builds the guide; with approved items it only says how', async () => {
  await St.settled(); const L = W.Lesion;
  St.unapproveAll(); S.anchor = null; S.planes = []; S.screws = []; S.guideOn = false; L.clear();
  L.setTool('paint'); for (const x of [-4, 0, 4]) { L.paint([x, 0, -1], 2, true); L.strokeEnd(); }
  L.setTool('paint');   // the tool off: the plan follows
  for (let i = 0; i < 400 && !(S.guideOn && S.planes.length && S.result); i++) await sleep(50);
  await St.settled();
  assert.ok(S.planes.length >= 2, 'cuts planned: ' + S.planes.length + ' ' + L.points().length + ' ' + !!St.parts.bone + ' ' + $('lsStat').textContent + ' | ' + $('caseMsg').textContent + ' tool ' + L.tool());
  const offs = S.planes.map(p => p.off).sort((a, b) => a - b);
  assert.ok(offs[0] < -4 && offs[offs.length - 1] > 4, 'the cuts clear the lesion: ' + offs);
  assert.equal(S.guideOn, true, 'the guide is built'); assert.ok(S.screws.length > 0);
  // approved items: nothing is re-planned on its own
  S.planes[0].ok = true; const before = JSON.stringify(S.planes.map(p => p.off));
  L.setTool('paint'); L.paint([8, 0, -1], 2, true); L.strokeEnd(); L.setTool('paint');
  await sleep(100); await St.settled();
  assert.equal(JSON.stringify(S.planes.map(p => p.off)), before);
  assert.match($('lsStat').textContent, /Onaylı öğeler var/);
  S.planes[0].ok = false; L.clear();
});

test('painted lesion: points, count and the stored mask follow strokes, erasing and a loaded plan', async () => {
  await plan(); const L = W.Lesion, ext = W.PlanExt.lesionPaint;
  L.clear(); assert.equal(L.points().length, 0);
  L.setTool('paint'); L.paint([0, 0, -6], 2, true); L.strokeEnd();
  const n1 = L.points().length; assert.ok(n1 > 10, 'a disc painted: ' + n1);
  L.paint([6, 0, -6], 2, true); L.strokeEnd();
  const n2 = L.points().length; assert.ok(n2 > n1, `a second disc adds voxels: ${n1} -> ${n2}`);
  const saved = ext.get(); assert.ok(saved && saved.m, 'stored');
  L.setTool('erase'); L.paint([0, 0, -6], 2, true); L.strokeEnd(); L.setTool('erase');
  const n3 = L.points().length; assert.ok(n3 < n2 && n3 > 0, `erasing removes the first disc: ${n2} -> ${n3}`);
  assert.notEqual(ext.get().m, saved.m, 'the stored mask changed with the erase');
  ext.set(saved); assert.equal(L.points().length, n2, 'a loaded mask brings its voxels back');
  L.clear(); assert.equal(L.points().length, 0); assert.equal(ext.get(), null);
});

await run('main flow: approval, reports, drag, lesion');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);
