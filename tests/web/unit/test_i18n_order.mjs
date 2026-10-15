// i18n number order: the Turkish keys carry "#" for every number and I18N.t puts the run-time numbers back. An English
// entry that names its numbers in another order must use positional slots ("#2 … #1"); a plain "#" fills left to right.
// Every dictionary entry is filled with distinct numbers, translated with the real I18N.t, and checked:
//   - every number comes out exactly once (no slot lost, none doubled, no "#" left),
//   - the unit right after a number (mm, mm², °, %, HU) is the same in both languages,
//   - a number in brackets stays in brackets ("yuva (2 mm) testere payından (1 mm)"),
//   - the word that names a number ("Kesi 2" / "cut 2", "Vida 3" / "screw 3") names the same thing.
// Also: no duplicate keys in i18n_en.js (a later copy silently overrides an earlier one), US spelling, and the
// lookup mechanics of positional slots inside joined phrases. Run: node test_i18n_order.mjs
import { test, run, assert } from './lib/t.mjs';
import { plain, src } from './lib/harness.mjs';

const store = { 'gs.lang': 'en' }, noop = () => {};
const doc = { readyState: 'complete', documentElement: { lang: 'tr', nodeType: 1, firstChild: null, hasAttribute: () => false }, title: '', getElementById: () => null, addEventListener: noop };
const P = plain({ localStorage: { getItem: k => store[k] ?? null, setItem: noop }, document: doc, MutationObserver: class { observe() {} disconnect() {} },
  alert: noop, confirm: () => true, prompt: () => null, Event: class { constructor(t) { this.type = t; } }, dispatchEvent: noop });
P.load('i18n_en.js'); P.load('i18n.js');
const T = P.eval('I18N.t'), D = P.eval('window.I18N_EN');
// the dictionary as written (i18n.js adds suffix-less aliases at load time)
const RAW = (() => { const g = { window: {} }; new Function('window', src('i18n_en.js'))(g.window); return g.window.I18N_EN; })();

const UNIT = /^\s?(mm²|mm³|mm|cm³|°|HU|ms|%)/;
const TRW = [[/^kesi(?!t)/, 'cut'], [/^vida/, 'screw'], [/^segment/, 'segment'], [/^i̇?mplant/, 'implant'], [/^plak/, 'plate'], [/^katman/, 'layer'], [/^delik/, 'hole'], [/^gün/, 'day'], [/^uyarı/, 'warning'], [/^kritik/, 'critical'], [/^adım/, 'step'], [/^kesit/, 'slice'], [/^voksel/, 'voxel'], [/^kayıt/, 'record']];
const ENW = { cut: 'cut', cuts: 'cut', screw: 'screw', screws: 'screw', segment: 'segment', segments: 'segment', implant: 'implant', implants: 'implant', plate: 'plate', layer: 'layer', layers: 'layer', hole: 'hole', holes: 'hole', day: 'day', days: 'day', warning: 'warning', warnings: 'warning', critical: 'critical', step: 'step', slice: 'slice', slices: 'slice', voxel: 'voxel', voxels: 'voxel', record: 'record', records: 'record', entry: 'record', entries: 'record' };
const trWord = w => { if (!w) return ''; const lw = w.toLocaleLowerCase('tr'); for (const [r, e] of TRW) if (r.test(lw)) return e; return ''; };
const enWord = w => (w ? ENW[w.toLowerCase()] || '' : '');
// what sits around the number n inside s: its unit and the word right before ("Kesi 2") or after ("2 vida")
function around(s, n, tr) {
  const i = s.indexOf(n), before = s.slice(0, i), after = s.slice(i + n.length).replace(/^['’][a-zçğıöşü]{1,4}/, '');
  let unit = (UNIT.exec(after) || [])[1] || '';
  if (/%\s?$/.test(before)) unit = '%';
  const wb = (/([A-Za-zÇĞİÖŞÜçğıöşüİ̇]+)\s$/.exec(before) || [])[1], wa = unit ? '' : (/^\s([A-Za-zÇĞİÖŞÜçğıöşüİ̇]+)/.exec(after) || [])[1];
  // in Turkish a noun names the number after it only in its bare or possessive form ("Kesi 2", "segmenti 2"); a case
  // ending ("segmentte 3 vidaya") means the number belongs to the next noun
  const lb = tr ? (/^(kesi(si)?|vida(sı)?|segment(i)?|i̇?mplant(ı)?|plak|katman(ı)?|delik|deliği|adım(ı)?|kesit(i)?|kayıt|kaydı)$/i.test(wb || '') ? trWord(wb) : '') : enWord(wb);
  const depth = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;   // inside "( … )" or not
  return { unit, lb, la: tr ? trWord(wa) : enWord(wa), depth };
}
const nums = c => Array.from({ length: c }, (_, i) => String(701 + i * 13));   // distinct, never a lone 1, no decimal to convert

test('no key is defined twice in i18n_en.js (a later copy would silently override the earlier one)', () => {
  const seen = new Map(), dup = [];
  for (const m of src('i18n_en.js').matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) { const k = JSON.parse(m[1]); if (seen.has(k)) dup.push(k); seen.set(k, 1); }
  assert.deepEqual(dup.slice(0, 10), [], `${dup.length} duplicate keys`);
});

test('every entry has as many number slots in English as in Turkish (positional #n: each 1..n used once)', () => {
  const bad = [];
  for (const [k, v] of Object.entries(RAW)) {
    const c = (k.match(/#/g) || []).length, pos = [...v.matchAll(/#(\d{1,2})(?![0-9A-Za-z])/g)].map(m => +m[1]);
    const ok = pos.length ? pos.length === c && pos.slice().sort((a, b) => a - b).every((x, i) => x === i + 1) && !/#(?!\d)/.test(v) : (v.match(/#/g) || []).length === c;
    if (!ok) bad.push(`${k} => ${v}`);
  }
  assert.deepEqual(bad, []);
});

test('every entry round-trips its numbers: each comes out once, with the same unit and naming the same thing', () => {
  const bad = [];
  for (const k of Object.keys(RAW)) {
    const c = (k.match(/#/g) || []).length;
    if (!c || RAW[k] === k) continue;   // "Segment #" is the same in both languages
    const N = nums(c); let i = 0;
    const tr = k.replace(/#/g, () => N[i++]), en = T(tr);
    if (en === tr) { bad.push(`not translated: ${k}`); continue; }
    for (const n of N) {
      const hits = en.split(n).length - 1;
      if (hits !== 1) { bad.push(`${n} appears ${hits}× : ${tr} => ${en}`); continue; }
      const a = around(tr, n, true), b = around(en, n, false);
      if (a.unit && b.unit !== a.unit) bad.push(`unit of ${n}: "${a.unit}" → "${b.unit}" : ${tr} => ${en}`);
      if (a.depth !== b.depth && c > 1) bad.push(`${n} ${a.depth ? 'inside' : 'outside'} brackets in Turkish, not in English : ${tr} => ${en}`);
      const la = a.lb || a.la, lb = b.lb || b.la;
      if (la && lb && la !== lb) bad.push(`${n} names ${la} → ${lb} : ${tr} => ${en}`);
    }
    if (/#/.test(en)) bad.push(`slot left: ${en}`);
  }
  if (process.env.I18N_LIST) bad.forEach(b => console.log("    " + b));
  assert.deepEqual(bad.slice(0, 15), [], `${bad.length} entries put numbers in the wrong place`);
});

test('positional slots survive joined phrases and parentheses; Turkish number format becomes English', () => {
  const key = Object.keys(RAW).find(k => /^Vida # kovanının %#/.test(k));
  assert.ok(key, 'sleeve-shadow entry present');
  const s = key.replace('#', '2').replace('#', '35');
  const en = T(s);
  assert.match(en, /^35% of the sleeve of screw 2\b/);
  // the same entry behind a known phrase: "Kesi 1 · <entry>" keeps the absolute order of both parts
  assert.match(T('Kesi 4 · ' + s), /^Cut 4 · 35% of the sleeve of screw 2\b/);
  assert.equal(T('−11,0 mm · 0,0° / 0,0°'), '−11.0 mm · 0.0° / 0.0°', 'a value readout with no dictionary entry still gets points');
  assert.equal(T('Temas alanı 1.234,5 mm²').replace(/^\D+/, ''), '1,234.5 mm²', 'Turkish thousands become English thousands');
  assert.equal(T('14.10.2026'), '14.10.2026', 'dates are left alone');
});

test('English uses US spelling', () => {
  const bad = Object.values(RAW).filter(v => /\b(centre|centred|colour|artefact|anonymis|neighbour|cancelled|grey|behaviour|optimis|recognis|normalis|visualis)/i.test(v));
  assert.deepEqual(bad, []);
});

test('the plan JSON (<pre translate="no">) and code are never translated; normal text next to it is', () => {
  const kids = (el, cs) => { cs.forEach((c, i) => { c.parentElement = el; c.nextSibling = cs[i + 1] || null; }); el.firstChild = cs[0] || null; return el; };
  const el = (tag, cs, at = {}) => kids({ nodeType: 1, tagName: tag, hasAttribute: a => a in at, getAttribute: a => at[a] ?? null, setAttribute: (a, v) => { at[a] = v; },
    closest(sel) { for (let e = this; e && e.tagName; e = e.parentElement) if (/^(PRE|CODE)$/.test(e.tagName) || (e.getAttribute && e.getAttribute('translate') === 'no')) return e; return null; } }, cs);
  const txt = d => ({ nodeType: 3, data: d });
  const json = '{\n  "kesiler": [ { "ad": "Kesi 2", "onay": "Bekliyor" } ]\n}', a = txt('Kesi 2'), j = txt(json), c = txt('Kesi 2');
  const root = el('HTML', [el('DIV', [a]), el('PRE', [j], { id: 'json', translate: 'no' }), el('CODE', [c])]);
  const d2 = { readyState: 'complete', documentElement: root, title: '', getElementById: () => null, addEventListener: noop };
  const Q = plain({ localStorage: { getItem: () => 'en', setItem: noop }, document: d2, MutationObserver: class { observe() {} disconnect() {} },
    alert: noop, confirm: () => true, prompt: () => null, Event: class { constructor(t) { this.type = t; } }, dispatchEvent: noop });
  Q.load('i18n_en.js'); Q.load('i18n.js');
  assert.equal(a.data, 'Cut 2');
  assert.equal(j.data, json, 'plan JSON left as written');
  assert.equal(c.data, 'Kesi 2', 'code left as written');
});

await run('i18n number order, duplicates, spelling');
