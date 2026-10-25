// i18n leftovers check: every Turkish string literal in the UI sources (web/*.js except the dictionary itself)
// must have an English entry in i18n_en.js. Same lookup as the runtime (I18N.t with lang = en).
// A string counts as Turkish when it has a Turkish letter, or is multi-word text containing a known Turkish word.
// Literals that are only glued pieces (leading/trailing punctuation, ${} slots) are tried in several shapes.
// Run: node test_i18n_cover.mjs   (I18N_LIST=1 prints every missing string)
import fs from 'node:fs';
import { test, run, assert } from './lib/t.mjs';
import { plain, src, REPO } from './lib/harness.mjs';

const store = { 'gs.lang': 'en' }, noop = () => {};
const doc = { readyState: 'complete', documentElement: { lang: 'tr', nodeType: 1, firstChild: null, hasAttribute: () => false }, title: '', getElementById: () => null, addEventListener: noop };
const P = plain({ localStorage: { getItem: k => store[k] ?? null, setItem: noop }, document: doc, MutationObserver: class { observe() {} disconnect() {} },
  alert: noop, confirm: () => true, prompt: () => null, Event: class { constructor(t) { this.type = t; } }, dispatchEvent: noop });
P.load('i18n_en.js'); P.load('i18n.js');
const T = P.eval('I18N.t');

const TRCH = /[çğıöşüÇĞİÖŞÜ]/;
const TRWORD = /\b(ve|bir|için|yok|var|ile|veya|kesi|vida|kesim|plak|onay|onayla|seç|aç|kapat|kaydet|sil|ekle|yükle|hata|uyarı|açık|kapalı|kemik|katman|dosya|seri|dilim|hasta|olgu|kılavuz|rehber|delik|boşluk|duvar|kalınlık|uzunluk|genişlik|derinlik|açı|eksen|merkez|sol|sağ|üst|alt|ön|arka|iç|dış|tam|yarım|önce|sonra|gerekli|bekliyor|tamam|iptal|evet|hayır|lütfen|değil|daha|çok|az|ne|bu|şu|rapor|ayar|seçili|kaldır|göster|gizle|uygula|geri|ileri|hazır|tarih|soyad)\b/i;
const isTurkish = s => s.trim().length > 1 && (TRCH.test(s) || (/\s/.test(s.trim()) && TRWORD.test(s) && /[a-z]{2}/.test(s)));

function literals(code) {
  const out = []; let i = 0, prev = '';
  const regexOk = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|new|delete|void|throw)$/.test(prev);
  function tmpl() {
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
      if (c === '/' && regexOk()) {
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
function fromHtml(h) {
  const out = [];
  h = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|textarea)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of h.matchAll(/<[a-zA-Z][^>]*>/g))
    for (const a of m[0].matchAll(/\b(title|aria-label|placeholder)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.push(a[3] ?? a[4]);
  for (const m of h.replace(/<[^>]*>/g, '\u0000').split('\u0000')) out.push(m);
  return out.map(s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&middot;/g, '·').replace(/&quot;/g, '"').replace(/&#39;/g, "'")).filter(s => s.trim());
}
const fromJs = code => literals(code).flatMap(s => (/<[a-zA-Z/]/.test(s) ? fromHtml(s) : [s])).flatMap(s => s.split('\n')).filter(s => s.trim());

// a ${} slot standing for a word or a name ("İmplant 3", "sağ", "SLA reçine") is matched against the dictionary keys
const KEYS = Object.keys(P.eval('window.I18N_EN'));
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asKey = x => x.replace(/(?<![A-Za-z0-9ÇĞİÖŞÜçğıöşü])[-−+]?\d+(?:[.,]\d+)*(?![A-Za-zÇĞİÖŞÜçğıöşü])/g, '#');   // same lifting as i18n.js
const viaKey = s => {
  if (!s.includes('\u0001')) return false;
  const re = new RegExp('^' + s.split('\u0001').map(p => esc(asKey(p))).join('[#\\p{L}\\d ()%°.,\\-–/·+\'’]{0,40}?') + '$', 'u');
  return KEYS.some(k => re.test(k));
};
// {0} {1}: the name slots of a template filled after translation (ankle.js / anklm.js named())
const translated = s0 => { const s = s0.replace(/\{\d\}/g, '\u0001'); return viaKey(s) || [s, s.replace(/\u0001/g, '7'), s.replace(/\u0001/g, ''), s.replace(/\u0001/g, 'Vida 7')].some(v => v.trim() && T(v) !== v); };
const KEEP = new Set(['Türkçe']);   // the language's own name in the selector stays Turkish on purpose
const SKIP_FILES = new Set(['i18n.js', 'i18n_en.js']);
const files = fs.readdirSync(`${REPO}/web`).filter(f => f.endsWith('.js') && !SKIP_FILES.has(f)).sort();

for (const f of files) {
  // lines marked i18n-skip (fixed file content) or branching on I18N.lang (own English text) are not checked
  const code = src(f).split('\n').map(l => (/i18n-skip|I18N\.lang/.test(l) ? '' : l)).join('\n');
  const tr = [...new Set(fromJs(code).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => isTurkish(s) && !/="/.test(s)))];
  const missing = tr.filter(s => !translated(s) && !KEEP.has(s)).map(s => s.replace(/\u0001/g, '${…}'));
  test(`${f}: every Turkish literal has an English entry (${missing.length} of ${tr.length} missing)`, () => {
    const lines = src(f).split('\n');
    for (const s of missing.slice(0, process.env.I18N_LIST ? 1e9 : 20)) {
      const frag = s.split('${…}').sort((a, b) => b.length - a.length)[0].slice(0, 22), n = lines.findIndex(l => l.includes(frag));
      console.log(`      - ${f}:${n + 1} ${JSON.stringify(s)}`);
      if (process.env.I18N_LIST === '2' && n >= 0) console.log('          ' + lines[n].trim().slice(0, 330));
    }
    assert.equal(missing.length, 0, `${missing.length} untranslated strings in ${f}`);
  });
}
// strings as they look at run time (numbers filled in) must come out in English with the numbers in the right place
test('run-time samples come out in English', () => {
  const S = [
    ['Toplam: +1,20 cm³ eklendi, −0,50 cm³ çıkarıldı.', 'Total: +1.20 cm³ added, −0.50 cm³ removed.'],
    ['Mandibula BT\'si ameliyattan 120 gün önce çekilmiş (01.02.2026); 90 günden eski. Lezyon büyümüş ya da kemik değişmiş olabilir; güncel BT önerilir.', 'The mandible CT was taken 120 days before surgery (01.02.2026); older than 90 days. The lesion may have grown or the bone changed; a recent CT is recommended.'],
    ['Mandibula guide\'ını kemiğe 12° eğik yönde oturtun; oturmanın tam olduğunu kontrol edin.', 'Seat the mandible guide on the bone in the direction tilted 12°; check that it seats fully.'],
    ['İmplant 3 çevresinde 1 mm kemik duvarı yüzeyin yalnız %40\'inde var; daha ince implant ya da eğim düşünün.', 'Implant 3: a 1 mm bone wall around it exists on only 40% of the surface; consider a thinner implant or a different tilt.'],
    ['Segment 2 (üst)', 'Segment 2 (upper)'],
    ['Fibula segmenti 2 bitiş kesisi 31°; 30° üstü temas yüzeyini azaltır.', 'Fibula segment 2 end cut is 31°; angles above 30° reduce the contact surface.'],
    ['Ameliyat sonrası: Kesi 2 plandan +0,8 mm, 3,1° sapmış (sınır 2 mm, 3°).', 'Post-operative: Cut 2 deviates +0.8 mm and 3.1° from the plan (limit 2 mm, 3°).'],
    ['1 gün', '1 day'], ['5 gün', '5 days'],
  ];
  for (const [tr, en] of S) assert.equal(T(tr), en);
});

// Denetim 7: a name translated first and then put into a translated template (const nm = xl('Üst K-teli'); xl(`${nm} …`))
// never matches: at run time the key is "Upper K-wire …", half English. The name goes outside the template instead.
test('no translated name inside a translated template', () => {
  const bad = [];
  for (const f of fs.readdirSync(REPO + '/web').filter(f => f.endsWith('.js') && !/^i18n/.test(f))) {
    const code = fs.readFileSync(REPO + '/web/' + f, 'utf8');
    for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=[^;\n]*\b(?:xl|I18N\.t)\(/g)) {
      const name = m[1], after = code.slice(m.index, m.index + 2500);
      const use = after.match(new RegExp('\\b(?:xl|I18N\\.t)\\(`[^`]*\\$\\{' + name + '\\}'));
      if (use) bad.push(`${f}: ${name} → ${use[0].slice(0, 80)}`);
    }
  }
  assert.equal(bad.length, 0, bad.join('\n'));
});

await run('i18n leftovers (all web/*.js vs i18n_en.js)');
