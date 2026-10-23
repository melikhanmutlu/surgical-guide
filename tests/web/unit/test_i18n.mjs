// i18n coverage: every Turkish UI string in index.html and app.js should have an English entry in i18n_en.js.
// Loads i18n_en.js + i18n.js (lang = en) in a vm, extracts Turkish strings, and asks the real I18N.t() for each one.
// index.html: text nodes + title / aria-label / placeholder attributes (exact, as the DOM walker sees them).
// app.js: string and template literals (comments skipped); template ${…} become a number (the common case), HTML in
// templates is split into text nodes / attributes. Strings glued together with + at run time cannot be rebuilt
// statically, so app.js counts are an upper bound (pieces like "Kesi " + n may be reported although "Kesi #" exists).
// Also checks the lookup mechanics (numbers, singular "1 screw", whitespace, untouched Turkish when lang = tr).
// Run: node test_i18n.mjs            (set I18N_LIST=1 to print every missing string)
import { test, run, assert } from './lib/t.mjs';
import { plain, src } from './lib/harness.mjs';

function load(lang) {
  const store = { 'gs.lang': lang };
  const noop = () => {};
  const doc = { readyState: 'complete', documentElement: { lang: 'tr', nodeType: 1, firstChild: null, hasAttribute: () => false }, title: 'Guide Stüdyosu',
    getElementById: () => null, addEventListener: noop };
  const P = plain({ localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, document: doc,
    MutationObserver: class { observe() {} disconnect() {} }, alert: noop, confirm: () => true, prompt: () => null, Event: class { constructor(t) { this.type = t; } },
    dispatchEvent: noop });
  P.load('i18n_en.js'); P.load('i18n.js');
  return { t: P.eval('I18N.t'), D: P.eval('window.I18N_EN') };
}
const EN = load('en'), TR = load('tr');

const TRCH = /[çğıöşüÇĞİÖŞÜ]/;
const TRWORD = /\b(ve|bir|için|yok|var|ile|veya|kesi|vida|kesim|plak|onay|onayla|seç|aç|kapat|kaydet|sil|ekle|yükle|hata|uyarı|açık|kapalı|kemik|katman|segment|dosya|seri|dilim|hasta|olgu|kılavuz|rehber|delik|boşluk|duvar|kalınlık|uzunluk|genişlik|derinlik|açı|eksen|merkez|sol|sağ|üst|alt|ön|arka|iç|dış|tam|yarım|önce|sonra|gerekli|bekliyor|tamam|iptal|evet|hayır|lütfen|değil|daha|çok|az|en|ne|bu|şu|o)\b/i;
const isTurkish = s => TRCH.test(s) || (/\s/.test(s.trim()) && TRWORD.test(s) && /[a-z]{2}/.test(s));

// ---------- HTML: text nodes and the three attributes ----------
function fromHtml(html) {
  const out = [];
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|textarea)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g))
    for (const a of m[0].matchAll(/\b(title|aria-label|placeholder)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.push(a[3] ?? a[4]);
  for (const m of html.replace(/<[^>]*>/g, '\u0000').split('\u0000')) out.push(m);
  return out.map(s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&middot;/g, '·').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
    .filter(s => s.trim());
}

// ---------- JS: a small tokenizer that yields string / template contents and skips comments and regex literals ----------
function literals(code) {
  const out = []; let i = 0, prev = '';
  const regexOk = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|new|delete|void|throw)$/.test(prev);
  function tmpl() {                        // at the char after the opening backtick; returns the template text with ${} -> 7
    let s = '';
    while (i < code.length) {
      const c = code[i];
      if (c === '\\') { s += code[i + 1] === 'n' ? '\n' : code[i + 1]; i += 2; continue; }
      if (c === '`') { i++; return s; }
      if (c === '$' && code[i + 1] === '{') { i += 2; js('}'); s += '\u0001'; continue; }
      s += c; i++;
    }
    return s;
  }
  function js(end) {
    let depth = 0;
    while (i < code.length) {
      const c = code[i];
      if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
      if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 2; if (i < 2) i = code.length; continue; }
      if (c === '"' || c === "'") {
        let s = ''; i++;
        while (i < code.length && code[i] !== c) { if (code[i] === '\\') { s += code[i + 1] === 'n' ? '\n' : code[i + 1]; i += 2; } else s += code[i++]; }
        i++; out.push(s); prev = 'x'; continue;
      }
      if (c === '`') { i++; out.push(tmpl()); prev = 'x'; continue; }
      if (c === '/' && regexOk()) {          // regex literal
        i++; let cls = false;
        while (i < code.length) { const d = code[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
        i++; while (/[a-z]/.test(code[i] || '')) i++; prev = 'x'; continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (end === '}' && depth === 0) { i++; return; } depth--; }
      if (!/\s/.test(c)) { const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 40)); if (m) { prev = m[0]; i += m[0].length; continue; } prev = c; }
      i++;
    }
  }
  js(null);
  return out;
}
const fromJs = code => literals(code).flatMap(s => (/<[a-zA-Z/]/.test(s) ? fromHtml(s) : [s])).flatMap(s => s.split('\n')).filter(s => s.trim());

const KEEP = new Set(['Türkçe']);   // the language's own name in the selector stays Turkish on purpose
// a ${} slot (\u0001) is tried as a number, as nothing and as a word; a string counts as translated if any variant is found.
// "exact" = literal text with no ${} slot and no sign of being a piece of a + concatenation (leading/trailing punctuation or space)
const translated = s => [s, s.replace(/\u0001/g, '7'), s.replace(/\u0001/g, ''), s.replace(/\u0001/g, 'Vida 7')].some(v => v.trim() && EN.t(v) !== v);
function coverage(strings) {
  const tr = [...new Set(strings.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => isTurkish(s) && !/="/.test(s)))];
  const missing = tr.filter(s => !translated(s) && !KEEP.has(s)).map(s => s.replace(/\u0001/g, '${…}'));
  const exact = missing.filter(s => !s.includes('${…}') && !/^[,.;:·/(+\-]/.test(s));
  return { total: tr.length, missing, exact };
}

test('lookup mechanics: numbers lifted out and put back, singular for a lone 1, whitespace kept, unknown text unchanged', () => {
  const D = EN.D, k = Object.keys(D).find(x => /#/.test(x) && !/#.*#/.test(x));
  assert.ok(k, 'dictionary has a key with one number');
  assert.equal(EN.t('  ' + k.replace('#', '12,5') + ' '), '  ' + D[k].replace('#', '12.5') + ' ');
  assert.equal(EN.t('zzz bilinmeyen metin qq'), 'zzz bilinmeyen metin qq');
  assert.equal(EN.t('123'), '123', 'pure numbers untouched');
  assert.equal(TR.t(k), k, 'Turkish mode leaves strings alone');
  const pl = Object.keys(D).find(x => /^# \w+$/.test(x) && / screws$/.test(D[x]));
  if (pl) assert.equal(EN.t(pl.replace('#', '1')), '1 screw');
});

test('dictionary hygiene: no empty values, no value still containing Turkish letters', () => {
  const D = EN.D, bad = Object.entries(D).filter(([k, v]) => !v || !String(v).trim() || TRCH.test(v));
  // 'Stüdyosu' style proper names are acceptable; print them so a reviewer can decide
  if (bad.length) console.log('    entries with empty / Turkish-looking English:', bad.slice(0, 10).map(([k, v]) => `${k} => ${v}`).join(' | '));
  assert.ok(bad.filter(([, v]) => !v || !String(v).trim()).length === 0, 'empty English values');
});

// Denetim 6 (A3.3): a dictionary key written with a literal number ("sunucu yoksa 0,4 mm önizleme") is never found, because
// the lookup lifts every number of the page text to "#" first; the English stays Turkish at run time while the coverage
// tests, which compare keys to keys, pass. Every number a key could carry must be written as "#".
test('dictionary keys hold no bare number: every number is a # placeholder (the lookup lifts numbers before it looks)', () => {
  const NUM = /(?<![A-Za-z0-9ÇĞİÖŞÜçğıöşü])[-−+]?\d+(?:[.,]\d+)*(?![A-Za-zÇĞİÖŞÜçğıöşü])/;
  const bad = Object.keys(EN.D).filter(k => NUM.test(k) && !/^[\d.,%#\s\-−+]*$/.test(k));
  if (bad.length) console.log('    keys with literal numbers:', bad.slice(0, 10).join(' | '));
  assert.equal(bad.length, 0, `${bad.length} dictionary keys with a literal number`);
  // the title that stayed Turkish in the browser (index.html, step 8) comes out in English with its number
  assert.equal(EN.t('Sunucuda üretilen su geçirmez STL (gerekirse şimdi üretilir); sunucu yoksa 0.4 mm önizleme'),
    'The watertight STL made on the server (made now if needed); without a server, the 0.4 mm preview');
});

const html = coverage(fromHtml(src('index.html'))), app = coverage(fromJs(src('app.js')));
test(`index.html: every Turkish text node / title / aria-label / placeholder has an English entry (${html.missing.length} of ${html.total} missing)`, () => {
  console.log(`    index.html: ${html.total} distinct Turkish strings, ${html.missing.length} without English`);
  for (const s of html.missing.slice(0, process.env.I18N_LIST ? 1e9 : 15)) console.log('      - ' + JSON.stringify(s));
  assert.equal(html.missing.length, 0, `${html.missing.length} untranslated strings in index.html`);
});
test(`app.js: every Turkish literal has an English entry (${app.missing.length} of ${app.total} missing, ${app.exact.length} certain)`, () => {
  console.log(`    app.js: ${app.total} distinct Turkish strings, ${app.missing.length} without English; ${app.exact.length} of them are whole literals with no \${} slot (certainly missing)`);
  for (const s of (process.env.I18N_LIST ? app.missing : app.exact.slice(0, 25))) console.log('      - ' + JSON.stringify(s));
  assert.equal(app.missing.length, 0, `${app.missing.length} untranslated strings in app.js`);
});

await run('i18n (index.html + app.js vs i18n_en.js)');
