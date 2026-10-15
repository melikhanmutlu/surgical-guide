// Denetim 4 verification leftovers (synthetic straight bar "mandible"):
//  pill  the top bar status (#readyPill, ui.js) follows the package lock on every change: after the two plan sign-offs
//        (audit.js) and after an undo it no longer stays at "Onay bekliyor (1)" over an open package
//  D1    the PDF report carries a text layer (invisible PDF text over the page images): the text can be searched and
//        copied, Turkish letters included
// Run: node test_d4_last.mjs
import { test, run, assert } from './lib/t.mjs';
import { studio, ready } from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- a canvas 2D context good enough for report.js: records fillText, measures text at 0.5 em per letter ----------
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
function ctx2d(cv) {
  const c = { canvas: cv, font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    measureText(t) { const px = +(/(\d+(?:\.\d+)?)px/.exec(this.font) || [0, 10])[1]; return { width: String(t).length * px * 0.5 }; },
    fillText() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {}, save() {}, restore() {} };
  return c;
}
const P = studio({ post: ['store.js', 'audit.js', 'dates.js'], extra: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
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
  S.source = { type: 'dicom', name: 'synthetic', fp: 'synthetic-d4last' };
  S.red = G.reduce(S.vol, 0.8); S.kind = 'dicom'; S.autoAnchor = false;
  await St.segment(true);
}
async function plan() {
  await St.settled();
  S.g.split = 0; S.anchor = { p: V(0, 0, 0), n: V(0, 0, 1), axis: V(1, 0, 0) }; $('perSide').value = '2'; S.lesion.condyle = null;   // (as setVolume leaves it)
  S.planes = [{ off: -15, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: 15, yaw: 0, pitch: 0, w: 1.2, ok: false }];
  S.guideOn = true; St.placeScrews(); await St.regenerate(); await St.settled();
}
// let the ui.js frame (requestAnimationFrame → setTimeout 0 here) and audit.js' 200 ms render run
const frames = async () => { await sleep(260); await St.settled(); await sleep(30); };
const pill = () => $('readyPill').textContent;
// the pill and the package lock tell the same story
function agree(when) {
  const open = !$('expZip').disabled, pend = St.pendingList().length;
  if (open) assert.equal(pill(), 'Onaylı plan', `${when}: package open, pill says "${pill()}" (pending ${JSON.stringify(St.pendingList())})`);
  else if (!S.crit) assert.equal(pill(), pend ? `Onay bekliyor (${pend})` : 'Onay bekliyor', `${when}: package locked with ${pend} pending (${JSON.stringify(St.pendingList())})`);
  assert.ok(!(open && pend), `${when}: never open while something is pending`);
}
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

test('pill: follows the lock through item approvals, the two sign-offs, an edit and its undo', async () => {
  await plan(); $('surgeon').value = 'Dr X'; S.crit = 0; S.qc = [];
  await frames(); agree('planned');
  [S.lesion, ...S.planes, ...S.screws].forEach(o => St.stamp(o)); St.renderAppr(); St.emit('changed'); await frames();
  assert.equal(JSON.stringify(St.pendingList()), JSON.stringify(['Mühendis teknik onayı', 'Cerrah klinik onayı']));
  agree('items approved'); assert.equal(pill(), 'Onay bekliyor (2)');
  signOff('eng'); St.renderAppr(); await frames(); agree('engineer signed'); assert.equal(pill(), 'Onay bekliyor (1)');
  // the clinical sign-off: audit.js re-renders the lock; no 'changed' event this time (the audit render timer only)
  signOff('sur'); St.renderAppr(); await frames();
  assert.equal($('expZip').disabled, false, 'both signed: package open'); agree('surgeon signed'); assert.equal(pill(), 'Onaylı plan');
  // an edit: cut 1 moves, its approval and both sign-offs go stale
  const before = St.planOf(), h0 = W.Audit.planHash();
  S.planes[0].off += 0.5; St.unapprove(S.planes[0]); St.schedule(true, true); St.emit('changed'); await frames();
  assert.equal($('expZip').disabled, true); agree('after the edit');
  // undo: the approved plan comes back with its log
  await St.applyPlan(before); await frames();
  assert.equal(W.Audit.planHash(), h0, 'the undone plan is the signed one');
  assert.equal($('expZip').disabled, false, 'undo restores the approved plan ' + JSON.stringify(St.pendingList())); agree('after the undo');
});

test('pill: a lock left open while an approval is pending is closed when the status is drawn (fail-safe)', async () => {
  await plan(); $('surgeon').value = 'Dr X'; S.crit = 0; S.qc = [];
  [S.lesion, ...S.planes, ...S.screws].forEach(o => St.stamp(o)); signOff('eng', 'sur'); St.renderAppr(); await frames();
  assert.equal(pill(), 'Onaylı plan');
  S.screws[0].ok = false; St.emit('select'); await frames();      // pending changed behind renderAppr's back
  assert.equal($('expZip').disabled, true, 'locked'); agree('stale lock'); assert.equal(pill(), 'Onay bekliyor (1)');   // Vida 1 (approval stamps are outside the signed plan hash)
});

// ---------- D1: PDF text layer ----------
// a small reader for the uncompressed PDF report.js writes: objects, page content streams, Tj strings, the font's
// /Differences and /ToUnicode map back to Unicode
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
test('D1: the PDF report has a searchable text layer with Turkish letters', async () => {
  await plan(); S.crit = 0; $('surgeon').value = 'Dr Çağrı Işık';
  W.Image = class { constructor() { this.width = 1000; this.height = 640; } set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };   // (snapshots have a size)
  const blob = await W.Report.build(), bytes = new Uint8Array(await blob.arrayBuffer());
  assert.ok(/^%PDF-1\.4/.test(Buffer.from(bytes.slice(0, 8)).toString('latin1')));
  const pages = pdfText(bytes), all = pages.join('\n');
  assert.ok(pages.length >= 1 && pages.every(p => p.length > 20), 'every page has text: ' + pages.map(p => p.length));
  for (const t of ['Hastaya özel cerrahi plan raporu', 'Kesim tablosu', 'Kesi 1', 'Montaj sırası', 'Otomatik kontroller', 'Biyomedikal mühendis', 'İmza', 'Onaylayan: Dr Çağrı Işık', 'İki aşamalı onay', 'Araştırma prototipi çıktısıdır; klinik kullanım için doğrulanmamıştır.', `Sayfa 1 / ${pages.length}`])
    assert.ok(all.includes(t), `"${t}" in the text layer:\n` + all.slice(0, 1500));
  assert.ok(!all.includes('�'), 'every letter maps back to Unicode');
  // the picture is still there: one JPEG per page
  assert.equal((Buffer.from(bytes).toString('latin1').match(/\/Filter \/DCTDecode/g) || []).length, pages.length);
  // poppler, when the machine has it, reads the same text (the JS reader above is the test of record)
  let txt = null; const f = path.join(os.tmpdir(), `d4last_${process.pid}.pdf`);
  try { fs.writeFileSync(f, bytes); txt = execFileSync('pdftotext', ['-enc', 'UTF-8', f, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { txt = null; } finally { try { fs.unlinkSync(f); } catch (e) {} }
  if (txt !== null) for (const t of ['Hastaya özel cerrahi plan raporu', 'Biyomedikal mühendis', 'İmza', 'Işık']) assert.ok(txt.includes(t), `pdftotext finds "${t}":\n` + txt.slice(0, 800));
});

await run('d4_last');
await new Promise(r => process.stdout.write("", r)); process.exit(process.exitCode || 0);   // (the studio's timers keep the loop alive)
