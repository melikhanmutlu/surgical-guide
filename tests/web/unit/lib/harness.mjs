// Loads the app's classic browser scripts (web/*.js, read-only from the audited checkout) into a node vm context.
// - plain(): a bare window for pure modules (geom.js, seat.js, codecs.js, unzip.js)
// - studio(): a fake DOM + THREE r147 (vendored copy of the same CDN build) + stubbed WebGL renderer / OrbitControls, then
//   app.js itself, so window.Studio (buildGuide, planesWorld, screwWorld, stlOf, zipBytes, guideRequest, planOf, applyPlan …)
//   can be called on synthetic inputs. No source file is modified; everything runs on copies in memory.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.SG_REPO || path.resolve(HERE, '../../../..');
export const VENDOR = path.join(HERE, '..', 'vendor');
export const src = f => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');

export function withDicomParser(P) { vm.runInContext(fs.readFileSync(path.join(VENDOR, 'dicomParser.min.js'), 'utf8'), P.ctx, { filename: 'dicomParser.min.js' }); return P; }
export function plain(extra = {}) {
  const g = { console, performance, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, Blob, Response, File: globalThis.File,
    DecompressionStream: globalThis.DecompressionStream, TransformStream: globalThis.TransformStream, CompressionStream: globalThis.CompressionStream, crypto: globalThis.crypto, DataView, BigInt, atob, btoa, URL, structuredClone, queueMicrotask, ...extra };
  g.window = g; g.globalThis = g; g.self = g;
  const ctx = vm.createContext(g);
  return { ctx, g, load: f => vm.runInContext(src(f), ctx, { filename: f }), eval: s => vm.runInContext(s, ctx) };
}

// ---------- fake DOM ----------
// initial values of inputs/selects from index.html, so the app starts with the same control values as in the browser
function htmlDefaults() {
  const html = src('index.html'), out = {};
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const t = m[0], id = /\bid="([^"]+)"/.exec(t), v = /\bvalue="([^"]*)"/.exec(t);
    if (id) out[id[1]] = { value: v ? v[1] : '', checked: /\bchecked\b/.test(t), type: (/\btype="([^"]+)"/.exec(t) || [])[1] || 'text' };
  }
  for (const m of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const opts = [...m[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)];
    const sel = opts.find(o => /\bselected\b/.test(o[0])) || opts[0];
    out[m[1]] = { value: sel ? sel[1] : '', type: 'select' };
  }
  return out;
}
class ClassList { constructor() { this.s = new Set(); } add(...c) { c.forEach(x => this.s.add(x)); } remove(...c) { c.forEach(x => this.s.delete(x)); } toggle(c, on) { const v = on === undefined ? !this.s.has(c) : !!on; v ? this.s.add(c) : this.s.delete(c); return v; } contains(c) { return this.s.has(c); } }
export class FakeEl {
  constructor(id, tag = 'div', init = {}) {
    this.id = id; this.tagName = tag.toUpperCase(); this.nodeType = 1; this._html = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.value = init.value ?? ''; this.checked = !!init.checked; this.type = init.type || ''; this.style = {}; this.dataset = {}; this.classList = new ClassList();
    this.children = []; this.attrs = {}; this.listeners = {}; this.files = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  get firstElementChild() { return this._first || (this._first = new FakeEl('', 'div')); }
  get parentElement() { return this._parent || (this._parent = new FakeEl('', 'div')); }
  get nextElementSibling() { return null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  dispatchEvent(e) { if (!e.target) try { e.target = this; } catch (x) {} (this.listeners[e.type] || []).forEach(f => f(e)); return true; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  querySelector() { return new FakeEl('', 'div'); } querySelectorAll() { return []; } closest() { return new FakeEl('', 'div'); }
  appendChild(c) { this.children.push(c); return c; } insertBefore(c) { return c; } insertAdjacentHTML(p, h) { this._html += h; } remove() {}
  contains() { return false; } focus() {} blur() {} click() { this.dispatchEvent({ type: 'click' }); } scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; }
  setPointerCapture() {} releasePointerCapture() {}
  get clientWidth() { return 800; } get clientHeight() { return 600; } get offsetWidth() { return 800; }
  getContext() { return null; } toDataURL() { return 'data:,'; }
}
export function fakeDocument() {
  const defs = htmlDefaults(), els = {};
  const doc = {
    readyState: 'complete', title: 'Guide Stüdyosu', documentElement: new FakeEl('html', 'html'), body: new FakeEl('body', 'body'), head: new FakeEl('head', 'head'),
    activeElement: null, els,
    getElementById(id) { return els[id] || (els[id] = new FakeEl(id, defs[id] && defs[id].type === 'select' ? 'select' : defs[id] ? 'input' : 'div', defs[id] || {})); },
    createElement(t) { return new FakeEl('', t); }, querySelector() { return new FakeEl('', 'div'); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, createTextNode(t) { return { nodeType: 3, data: t }; },
  };
  doc.activeElement = doc.body;
  return doc;
}

// ---------- THREE + app.js ----------
export function threeCtx(extra = {}) {
  const P = plain(extra), g = P.g;
  const doc = fakeDocument();
  Object.assign(g, {
    document: doc, navigator: { userAgent: 'node' }, devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800,
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })(),
    requestAnimationFrame: f => setTimeout(() => f(performance.now()), 0), cancelAnimationFrame: id => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    alert: () => {}, confirm: () => true, prompt: () => null, Event: class { constructor(t) { this.type = t; } }, CustomEvent: globalThis.CustomEvent, EventTarget: globalThis.EventTarget,
    Image: class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } },
    fetch: async () => { throw new Error('offline (unit test)'); },
  }, extra);
  vm.runInContext(fs.readFileSync(path.join(VENDOR, 'three.min.js'), 'utf8'), P.ctx, { filename: 'three.min.js' });
  return { ...P, doc };
}
export function studio(opts = {}) {
  const P = threeCtx(opts.extra || {}), g = P.g, T = g.THREE;
  // WebGL is not available in node: a renderer that draws nothing; OrbitControls only needs a target
  T.WebGLRenderer = class { constructor() { this.domElement = new FakeEl('canvas', 'canvas'); this.localClippingEnabled = false; } setPixelRatio() {} getPixelRatio() { return 1; } setSize() {} getSize(v) { return v.set(800, 600); } render() {} setScissorTest() {} setViewport() {} setScissor() {} dispose() {} };
  T.OrbitControls = class { constructor(cam) { this.object = cam; this.target = new T.Vector3(); this.enabled = true; } update() {} addEventListener() {} };
  g.YOLMED_SERVER = opts.server || '';
  if (opts.dicom) vm.runInContext(fs.readFileSync(path.join(VENDOR, 'dicomParser.min.js'), 'utf8'), P.ctx, { filename: 'dicomParser.min.js' });
  (opts.pre || []).forEach(f => P.load(f));
  P.load('geom.js'); P.load('seat.js'); P.load('gkernel.js');
  P.load('app.js');
  (opts.post || []).forEach(f => P.load(f));
  return P;
}
// wait until window.Studio exists (app.js is an async IIFE; Studio is published synchronously before its first await)
export async function ready(P) { for (let i = 0; i < 200 && !P.g.Studio; i++) await new Promise(r => setTimeout(r, 5)); if (!P.g.Studio) throw new Error('Studio not published'); await new Promise(r => setTimeout(r, 20)); return P.g.Studio; }
