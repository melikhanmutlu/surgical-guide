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

  // ---------- inspector tabs ----------
  const tabs = [...document.querySelectorAll('.tab')];
  function openTab(id) {
    tabs.forEach(t => { const on = t.dataset.tab === id; t.setAttribute('aria-selected', on); $(t.dataset.tab).hidden = !on; });
    store.set('gs.tab', id);
  }
  tabs.forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));
  const savedTab = store.get('gs.tab'); if (savedTab && $(savedTab)) openTab(savedTab);

  // ---------- status tags, derived from what the app renders ----------
  const tag = (el, cls, text) => { el.className = 'tag' + (cls ? ' ' + cls : ''); el.textContent = text; el.hidden = !text; };
  function sync() {
    const qc = [...$('qc').children].map(li => li.className);
    tag($('tag1'), qc.includes('crit') ? 'crit' : qc.includes('warn') ? 'warn' : qc.length ? 'ok' : '', qc.includes('crit') ? 'Kritik' : qc.includes('warn') ? 'Uyarı' : qc.length ? 'Uygun' : '');
    const sel = $('comps').querySelectorAll('input:checked').length;
    tag($('tag2'), '', sel ? `${sel} yapı` : '');
    const les = $('lesStatus').textContent;
    tag($('tag4'), les ? (/onaylandı/.test(les) ? 'ok' : 'warn') : '', les ? (/onaylandı/.test(les) ? 'Onaylı' : 'Bekliyor') : '');
    const dots = $('elList').querySelectorAll('.dot'), ok = $('elList').querySelectorAll('.dot.ok').length;
    tag($('tag5'), dots.length ? (ok === dots.length ? 'ok' : 'warn') : '', dots.length ? `${ok}/${dots.length} onaylı` : '');
    const crit = $('checks').querySelectorAll('li.crit').length + $('qc').querySelectorAll('li.crit').length;
    $('critCnt').hidden = !crit; $('critCnt').textContent = crit;
    const pill = $('readyPill');
    if (!$('appr').children.length) { pill.className = 'pill'; pill.textContent = 'Hazırlanıyor'; }
    else if (crit) { pill.className = 'pill crit'; pill.textContent = 'Kritik uyarı'; }
    else if (!$('expZip').disabled) { pill.className = 'pill ok'; pill.textContent = 'Onaylı plan'; }
    else { pill.className = 'pill'; pill.textContent = 'Onay bekliyor'; }
    const dd = $('caseInfo').querySelector('dd'); $('caseTitle').textContent = dd ? dd.textContent : '';
  }
  let pend = false;
  const mo = new MutationObserver(() => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; sync(); }); } });
  ['qc', 'comps', 'lesStatus', 'elList', 'checks', 'appr', 'caseInfo', 'expMsg'].forEach(id => mo.observe($(id), { childList: true, subtree: true, characterData: true }));
  apply(); sync();
})();
