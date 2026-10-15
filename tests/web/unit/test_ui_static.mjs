// Interface rules that can be read from the markup and the style sheets without a browser (Denetim 4 arayüz):
//   - light-theme status text >= 4.5:1 and input edges >= 3:1 on the panel colors (WCAG 1.4.3 / 1.4.11), for the
//     base theme (index.html) and the card style (styles/kart.css), which overrides the tokens,
//   - the card style's fixed 36 px button height does not reach the two-line review / history rows,
//   - landmarks: one <main>, an <h1>, a skip link; the plan JSON is marked translate="no",
//   - the package lock reason sits in the package row, next to the download button,
//   - run-time strings: "# kritik", history labels, the osteotomy legend and layer aria-labels come out in English.
// Run: node test_ui_static.mjs
import { test, run, assert } from './lib/t.mjs';
import { plain, src } from './lib/harness.mjs';

const html = src('index.html'), kart = src('styles/kart.css');
const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const tokens = block => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\b/gi)].map(m => [m[1], m[2].toLowerCase()]));
const lightBase = tokens(/:root \{([\s\S]*?)\n\}/.exec(html)[1]);
const lightKart = { ...lightBase, ...tokens(/:root:root\[data-style="k1"\] \{([\s\S]*?)\n\}/.exec(kart)[1]) };

for (const [name, T] of [['base theme', lightBase], ['card style', lightKart]]) {
  test(`${name}: status text >= 4.5:1, input edge >= 3:1 on panel, sunken rows and the open step`, () => {
    const bad = [];
    for (const fg of ['ok', 'warn', 'crit', 'muted', 'faint']) for (const bg of ['panel', 'sunken', 'accent-soft', 'bg']) if (T[fg] && T[bg] && ratio(T[fg], T[bg]) < 4.5) bad.push(`${fg} on ${bg}: ${ratio(T[fg], T[bg]).toFixed(2)}`);
    for (const [fg, bg] of [['crit', 'crit-bg'], ['warn', 'warn-bg'], ['ok', 'ok-bg']]) if (T[fg] && T[bg] && ratio(T[fg], T[bg]) < 4.5) bad.push(`${fg} on ${bg}: ${ratio(T[fg], T[bg]).toFixed(2)}`);
    for (const bg of ['panel', 'sunken']) if (ratio(T.control, T[bg]) < 3) bad.push(`control edge on ${bg}: ${ratio(T.control, T[bg]).toFixed(2)}`);
    assert.deepEqual(bad, []);
  });
}

test('card style: inputs and selects are edged with --control; the 36 px button rule spares review, history and link buttons', () => {
  assert.match(kart, /input\[type=text\][^{]*\{[^}]*border-color:\s*var\(--control\)/);
  const rule = /^(html\[data-style="k1"\] button[^{]*)\{[^}]*height:\s*36px/m.exec(kart);
  assert.ok(rule, 'the fixed-height button rule exists');
  for (const c of ['.go', '.link', '.hist button']) assert.ok(rule[1].includes(c), `rule excludes ${c}`);
  assert.match(rule[1], /:where\(/, 'exclusions add no specificity (top-bar overrides still win)');
});

test('landmarks and markup: main, h1, skip link, plan JSON not translated, lock reason in the package row', () => {
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.match(html, /<h1 class="brand">/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<pre id="json" translate="no">/);
  const row = /<li>(?:(?!<\/li>)[\s\S])*id="expZip"(?:(?!<\/li>)[\s\S])*<\/li>/.exec(html);
  assert.ok(row && /id="expMsg"/.test(row[0]), 'expMsg is in the same row as the download button');
  assert.match(html, /id="chkNote"[^>]*>Eşikler örnek değerlerdir; kurumunuzun klinik ekibi onaylamalıdır\./);
});

// run-time strings, translated with the real dictionary
const noop = () => {};
const P = plain({ localStorage: { getItem: () => 'en', setItem: noop }, document: { readyState: 'complete', documentElement: { lang: 'tr', nodeType: 1, firstChild: null, hasAttribute: () => false }, title: '', getElementById: () => null, addEventListener: noop },
  MutationObserver: class { observe() {} disconnect() {} }, alert: noop, confirm: () => true, prompt: () => null, Event: class {}, dispatchEvent: noop });
P.load('i18n_en.js'); P.load('i18n.js');
const T = P.eval('I18N.t');
test('run-time strings: critical count, history labels, legend, layer labels, clinical terms', () => {
  const S = [
    ['2 kritik', '2 critical'],
    ['2 kritik · 1 uyarı · 8 bilgi', '2 critical · 1 warning · 8 info'],
    ['Kesi 1 konum -11,0 → -12,0', 'Cut 1 position: -11.0 → -12.0'],
    ['Vida 3 vida boyu 12 → 14', 'Screw 3 screw length: 12 → 14'],
    ['güvenlik payı 3,0 → 5,0', 'Safety margin: 3.0 → 5.0'],
    ['Katmanı kaldır: Cilt (dış yüzey)', 'Remove layer: Skin (outer surface)'],
    ['Cilt (dış yüzey): alt HU sınırı', 'Skin (outer surface): lower HU limit'],
    ['-8,0 – 8,0 mm, pay 3,0 mm', '-8.0 to 8.0 mm · safety margin 3.0 mm'],
    ['Rezeksiyon sınırı', 'Resection extent'],
    ['-8,0 – 8,0 mm, güvenlik payı 3,0 mm', '-8.0 to 8.0 mm · safety margin 3.0 mm'],
    ['Rezeksiyon aralığı', 'Resection extent'],
    ['Kesileri aralık + güvenlik payına göre koy', 'Place cuts at extent + safety margin'],
    ['Onay bekliyor (10)', 'Awaiting approval (10)'],
  ];
  for (const [tr, en] of S) assert.equal(T(tr), en);
  const legend = /<p class="hint more">(M: mandibula[^<]*)<\/p>/.exec(src('osteo.js'))[1].replace(/\$\{[^}]+\}/g, '0,5');
  assert.ok(!/[çğıöşü]/.test(T(legend)), 'osteotomy legend fully English: ' + T(legend));
});

await run('UI static rules (contrast, layout rules, landmarks, run-time strings)');
