// Interface language. The studio is written in Turkish; with English selected (Settings → Dil / Language) every
// text node and the title / aria-label / placeholder attributes are swapped for their English form from
// I18N_EN (i18n_en.js). Numbers are lifted out before the lookup ("Kesi 2" → "Kesi #"), so one entry covers
// every count and measurement. The original Turkish is kept per node, so switching back restores it in place,
// and a module that re-renders simply writes Turkish again, which the observer translates on the fly.
(() => {
  const KEY = 'gs.lang', ATTRS = ['title', 'aria-label', 'placeholder'];
  const D = window.I18N_EN || {};
  const NUM = /(?<![A-Za-z0-9ÇĞİÖŞÜçğıöşü])[-−+]?\d+(?:[.,]\d+)*(?![A-Za-zÇĞİÖŞÜçğıöşü])/g;
  // also lifted out like numbers: plan hashes ("plan 5dda4e9c"), version and end labels ("S3", "M1–S4ü") and the letter of a default bone label ("Kemik C")
  const TOK = new RegExp(`(?<![A-Za-z0-9])(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,64}(?![A-Za-z0-9])|(?<=(?<![A-Za-z])[MS])\\d+(?![0-9A-Za-z])|(?<=(?<![A-Za-z])[MS])\\d+(?=ü)|(?<=\\bKemik )[A-Z](?![A-Za-z0-9ÇĞİÖŞÜçğıöşü])|${NUM.source}`, 'g');
  // Turkish case endings after a number ("%8'i", "20 mm'ye") carry no meaning in English
  const SUF = /([\d#](?: ?mm)?)['’](?:[a-zçğıöşü]{1,4})(?![A-Za-zÇĞİÖŞÜçğıöşü])/g;
  // "1 screws" → "1 screw": the dictionary holds the plural, a lone 1 takes the singular
  const ONE = /((?:^|[^\d.,])1 )(screw|segment|implant|position|cut|hole|file|item|version|warning|structure|approval|step|graft|plate|slice|series|piece|check|note|guide|vessel|point|day|week)s\b/g;
  let lang = 'tr';
  const miss = new Set();
  for (const k of Object.keys(D)) { const n = k.replace(SUF, '$1'); if (n !== k && D[n] == null) D[n] = D[k]; }   // Turkish keys with no English yet, for I18N.miss in the console
  try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'tr'; } catch (e) { /* storage blocked */ }

  // a key not in the dictionary as a whole is often several known phrases joined by the code ("Kesi 1 · onaylı",
  // "onay bekleyen: Kesi 1, Vida 2"), or one with a closing period or bracket; those parts are looked up one by one
  const SEP = /( · | — | – |; |: |, | \/ | \| |\. (?=[A-ZÇĞİÖŞÜ]))/;
  function look(k, deep) {
    if (D[k] != null) return D[k];
    const end = /^(.*?)([.:…!?)]+)$/.exec(k);
    if (end && D[end[1]] != null) return D[end[1]] + end[2];
    const wrap = /^([(“"'«]+)(.*?)([)”"'».:…!?]*)$/.exec(k);
    if (wrap && D[wrap[2]] != null) return wrap[1] + D[wrap[2]] + wrap[3];
    const par = /^(.+?) \(([^()]+)\)([.:]?)$/.exec(k);
    if (par) { const a = look(par[1], deep), b = look(par[2], true); if (a != null || b != null) return (a ?? par[1]) + ' (' + (b ?? par[2]) + ')' + par[3]; }
    if (deep) return null;
    const parts = k.split(SEP);
    if (parts.length < 3) return null;
    // longest run of parts that translates as one, from left to right ("A: b. C" may be known as "b. C")
    let hit = 0, outp = '';
    for (let i = 0; i < parts.length; i += 2) {
      let j = parts.length - 1, v = null;
      for (; j > i; j -= 2) if ((v = look(parts.slice(i, j + 1).join(''), true)) != null) break;
      if (v == null && parts[i]) v = look(parts[i], true);
      if (v != null) hit++;
      outp += (v ?? parts[i]) + (parts[j + 1] ?? '');
      i = j;
    }
    return hit ? outp : null;
  }
  // one string: keeps the surrounding whitespace, puts the numbers back in order
  function t(s) {
    if (lang !== 'en' || !s) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2].replace(/\s+/g, ' ');
    if (!core || !/[A-Za-zÇĞİÖŞÜçğıöşü%]/.test(core)) return s;
    const nums = [], k = core.replace(SUF, '$1').replace(TOK, x => { nums.push(x); return '#'; });
    const v = look(k);
    if (v == null) { if (/[çğıöşüÇĞİÖŞÜ]|\b(ve|ile|için|seç|yok|kesi|vida|onay|göster|ekle|sil|hazır|parça|kemik|açı|uzunluk)\b/i.test(k)) miss.add(k); return s; }
    let i = 0;
    const en = v.replace(/#/g, () => (i < nums.length ? nums[i++].replace(/^([-−+]?\d+),(\d+)$/, '$1.$2') : '#')).replace(ONE, '$1$2');
    return m[1] + en + m[3];
  }
  // a multi-line message (alerts, confirms) falls back to line by line
  const tMsg = s => { const w = t(s); return w !== s ? w : String(s).split('\n').map(t).join('\n'); };

  // per-node memory: the Turkish source and the English we wrote, so our own writes are recognised
  const src = new WeakMap(), out = new WeakMap(), touched = new Set();
  function text(n) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName) || p.isContentEditable) return;
    if (out.get(n) === n.data) return;
    const en = t(n.data);
    src.set(n, n.data);
    if (en !== n.data) { out.set(n, en); n.data = en; touched.add(n); } else out.delete(n);
  }
  function attrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const v = el.getAttribute(a), k = '@' + a, o = out.get(el) || {};
      if (o[k] === v) continue;
      const en = t(v), s = src.get(el) || {};
      s[k] = v; src.set(el, s);
      if (en !== v) { o[k] = en; out.set(el, o); el.setAttribute(a, en); touched.add(el); }
    }
  }
  function walk(n) {
    if (n.nodeType === 3) return text(n);
    if (n.nodeType !== 1) return;
    attrs(n);
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  }
  const mo = new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'characterData') text(m.target);
      else if (m.type === 'attributes') attrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  const watch = () => mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  function restore() {
    for (const n of touched) {
      const s = src.get(n), o = out.get(n);
      if (n.nodeType === 3) { if (s != null && o === n.data) n.data = s; }
      else if (s && o) for (const a of ATTRS) { const k = '@' + a; if (o[k] != null && n.getAttribute(a) === o[k]) n.setAttribute(a, s[k]); }
      out.delete(n);
    }
    touched.clear();
  }
  const tTitle = () => { if (lang === 'en') document.title = document.title.replace('Guide Stüdyosu', 'Guide Studio'); else document.title = document.title.replace('Guide Studio', 'Guide Stüdyosu'); };

  function set(l, quiet) {
    lang = l === 'en' ? 'en' : 'tr';
    try { localStorage.setItem(KEY, lang); } catch (e) { /* storage blocked */ }
    document.documentElement.lang = lang;
    mo.disconnect();
    if (lang === 'en') { walk(document.documentElement); watch(); } else restore();
    tTitle();
    const sel = document.getElementById('langSel'); if (sel && sel.value !== lang) sel.value = lang;
    if (!quiet) window.dispatchEvent(new Event('langchange'));
  }

  // dialogs the browser draws itself
  const A = window.alert.bind(window), C = window.confirm.bind(window), P = window.prompt.bind(window);
  window.alert = m => A(tMsg(m));
  window.confirm = m => C(tMsg(m));
  window.prompt = (m, d) => P(tMsg(m), d);

  window.I18N = { t, set, miss, get lang() { return lang; } };
  const start = () => {
    const sel = document.getElementById('langSel');
    if (sel) { sel.value = lang; sel.addEventListener('change', () => set(sel.value)); }
    set(lang, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
