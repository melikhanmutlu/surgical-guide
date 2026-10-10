/* Workspace chrome: collapsible panels, focus mode, fullscreen, inspector tabs, and the status tags derived from app panels. */
'use strict';
(function () {
  const $ = id => document.getElementById(id), app = $('app');
  const narrow = matchMedia('(max-width: 820px)');
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // ---------- panels ----------
  let left = narrow.matches ? false : store.get('gs.left') !== '0', right = narrow.matches ? false : store.get('gs.right') !== '0', saved = null;
  function apply() {
    app.classList.toggle('no-left', !left); app.classList.toggle('no-right', !right);
    $('tLeft').setAttribute('aria-pressed', left); $('tRight').setAttribute('aria-pressed', right);
    $('tFocus').setAttribute('aria-pressed', !left && !right);
    $('eLeft').hidden = left; $('eRight').hidden = right;
    if (!narrow.matches) { store.set('gs.left', left ? '1' : '0'); store.set('gs.right', right ? '1' : '0'); }
  }
  const setLeft = v => { left = v; if (narrow.matches && v) right = false; apply(); };
  const setRight = v => { right = v; if (narrow.matches && v) left = false; apply(); };
  function focusMode() {
    if (left || right) { saved = [left, right]; left = right = false; }
    else { [left, right] = saved || [!narrow.matches, !narrow.matches]; saved = null; }
    apply();
  }
  $('tLeft').addEventListener('click', () => setLeft(!left));
  $('tRight').addEventListener('click', () => setRight(!right));
  $('eLeft').addEventListener('click', () => setLeft(true));
  $('eRight').addEventListener('click', () => setRight(true));
  $('tFocus').addEventListener('click', focusMode);
  narrow.addEventListener('change', () => { if (narrow.matches) { left = right = false; } apply(); });
  apply();   // the stored panel state applies from the first paint

  // fullscreen (falls back to focus mode where the host frame does not allow it)
  const fsOK = document.fullscreenEnabled && app.requestFullscreen;
  $('tFull').addEventListener('click', async () => {
    if (!fsOK) { focusMode(); return; }
    try { document.fullscreenElement ? await document.exitFullscreen() : await app.requestFullscreen(); } catch (e) { focusMode(); }
  });
  document.addEventListener('fullscreenchange', () => $('tFull').setAttribute('aria-pressed', !!document.fullscreenElement));

  // keyboard: [ ] panels, F focus, Esc leaves focus mode
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.key === '[') setLeft(!left);
    else if (e.key === ']') setRight(!right);
    else if (e.key === 'f' || e.key === 'F') focusMode();
    else if (e.key === 'Escape' && !left && !right && !document.fullscreenElement) focusMode();
    else return;
    e.preventDefault();
  });

  // ---------- theme: follows the system until the viewer picks one ----------
  const root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)');
  const savedTheme = store.get('gs.theme'); if (savedTheme === 'light' || savedTheme === 'dark') root.dataset.theme = savedTheme;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches);
  const syncTheme = () => { $('tTheme').title = isDark() ? 'Aydınlık temaya geç' : 'Koyu temaya geç'; $('tTheme').setAttribute('aria-label', $('tTheme').title); window.dispatchEvent(new Event('themechange')); };
  $('tTheme').addEventListener('click', () => { root.dataset.theme = isDark() ? 'light' : 'dark'; store.set('gs.theme', root.dataset.theme); syncTheme(); });
  dark.addEventListener('change', syncTheme); syncTheme();

  // ---------- inspector tabs (arrow keys move between tabs) ----------
  const tabs = () => [...document.querySelectorAll('.tab')].filter(t => !t.hidden);
  function openTab(id, show) {
    if (!$(id)) return;
    [...document.querySelectorAll('.tab')].forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; $(t.dataset.tab).hidden = !on; });
    store.set('gs.tab2', id);
    if (show && !right) setRight(true);
  }
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => openTab(t.dataset.tab, true));
    t.addEventListener('keydown', e => {
      const list = tabs(), i = list.indexOf(t);
      const j = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
      if (j < 0) return; e.preventDefault(); openTab(list[j].dataset.tab); list[j].focus(); list[j].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });
  const savedTab = store.get('gs.tab2'); openTab(savedTab && $(savedTab) && !document.querySelector(`.tab[data-tab="${savedTab}"]`).hidden ? savedTab : 'pPrt');
  window.Layout = { openTab, setLeft, setRight };
})();
