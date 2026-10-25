/* Simple panel: the left panel follows the main flow. Numbered steps come from the case type's groups
   (casetype.js); a group of several workflow steps shows as one numbered step with tabs for its parts. Each part keeps
   its own <details> element, so code that opens or watches a step by id is unchanged.
   Settings the main flow does not need sit in a folded "Gelişmiş" section at the bottom of their step. "Tüm ayarları
   açık göster" (Settings) opens every such section, and a section opens by itself when something inside it is opened
   (a check's fix button, a test). The resection step offers two ways to mark the region: painting on the slices or a
   centre point. Nothing here changes the plan. */
'use strict';
(() => {
  const St = window.Studio; if (!St || !window.CaseType) return;
  const { bus } = St, $ = id => document.getElementById(id), root = document.documentElement;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } } };
  const steps = () => [...document.querySelectorAll('details.step[name="flow"]')];
  const open = id => (window.UI ? UI.openStep(id) : ($(id).open = true));

  // ---------- groups: one visible row per numbered step, tabs for its parts ----------
  let groups = [];
  function buildTabs() {
    groups = CaseType.groups();
    document.querySelectorAll('.part-tabs').forEach(el => el.remove());
    steps().forEach(d => { d.classList.remove('in-group'); delete d.dataset.part; });
    groups.forEach(g => {
      if (g.parts.length < 2) return;
      g.parts.forEach(([id, lab]) => {
        const d = $(id); d.classList.add('in-group'); d.dataset.part = lab;
        const bar = document.createElement('div');
        bar.className = 'part-tabs seg full'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', g.title);
        g.parts.forEach(([pid, plab]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.part = pid; b.textContent = plab;
          b.setAttribute('aria-pressed', String(pid === id));
          b.addEventListener('click', () => { if (pid !== id) open(pid); });
          bar.appendChild(b);
        });
        d.querySelector(':scope > .body').prepend(bar);
      });
    });
    rows();
  }
  // in a group only one summary shows: the open part's, or the first part's while the group is closed
  function rows() {
    groups.forEach(g => {
      const ids = g.parts.map(p => p[0]), on = ids.find(id => $(id).open) || ids[0];
      ids.forEach(id => $(id).classList.toggle('grp-hide', id !== on));
    });
    marks();
  }
  // a tab shows its part's own completion (ui.js keeps it in data-pdone)
  function marks() {
    document.querySelectorAll('.part-tabs button').forEach(b => { const d = $(b.dataset.part); b.classList.toggle('done', !!(d && d.dataset.pdone === '1')); });
  }
  steps().forEach(d => d.addEventListener('toggle', rows));
  new MutationObserver(marks).observe($('leftPanel'), { attributes: true, attributeFilter: ['data-pdone'], subtree: true });
  bus.addEventListener('groups', buildTabs);

  // ---------- "Gelişmiş" sections ----------
  const ADV = 'details[data-adv]';
  const advAll = () => root.dataset.adv === 'all';
  function setAll(on, init) {
    root.dataset.adv = on ? 'all' : '';
    if ($('advAll')) $('advAll').checked = on;
    if (on) document.querySelectorAll(ADV).forEach(d => { d.open = true; });
    else if (!init) document.querySelectorAll(ADV).forEach(d => { d.open = false; });
    store.set('gs.advAll', on ? '1' : '0');
  }
  if ($('advAll')) $('advAll').addEventListener('change', e => setAll(e.target.checked));
  // a named section opened inside a folded one (a check's fix, a test, a link) brings the folded section with it, in the
  // step that is open. Sections a module renders already open (no id) do not: they would unfold "Gelişmiş" on every redraw.
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d || d.tagName !== 'DETAILS' || !d.open || !d.id || d.matches('details.step')) return;
    const step = d.closest('details.step[name="flow"]'); if (step && !step.open) return;
    for (let p = d.parentElement && d.parentElement.closest('details'); p && p !== step; p = p.parentElement && p.parentElement.closest('details')) if (!p.open) p.open = true;
  }, true);
  // how many settings a folded section holds
  const COUNTED = 'input:not([type=file]):not([type=hidden]), select:not([hidden]), button:not(.info):not(.link), .seg button';
  function counts() {
    document.querySelectorAll('details.adv').forEach(d => {
      const sm = d.querySelector(':scope > summary'); if (!sm) return;
      let aux = sm.querySelector('.aux');
      if (!aux) { aux = document.createElement('span'); aux.className = 'aux'; sm.appendChild(aux); }
      const n = [...d.querySelectorAll(COUNTED)].filter(el => !el.closest('[hidden]')).length;
      const t = n ? xl(`${n} ayar`) : '';
      if (aux.textContent !== t) aux.textContent = t;
    });
  }
  let cq = false;
  const later = () => { if (!cq) { cq = true; requestAnimationFrame(() => { cq = false; counts(); mini(); }); } };
  new MutationObserver(later).observe($('leftPanel'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

  // ---------- resection: paint on the slices or pick a centre point ----------
  const RX = 'gs.rxMode';
  function rxMode(m, user) {
    root.dataset.rx = m;
    document.querySelectorAll('#rxMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    store.set(RX, m);
    // painting happens on the slices: the first switch to it brings the slice strip in next to the 3D view
    if (user && m === 'paint' && $('views') && $('views').dataset.mode === '3d' && $('vmStrip')) $('vmStrip').click();
  }
  document.querySelectorAll('#rxMode button').forEach(b => b.addEventListener('click', () => rxMode(b.dataset.m, true)));
  rxMode(store.get(RX) === 'point' ? 'point' : 'paint');
  // the safety margin is the one number of the range form the main flow needs; it moves next to the region tools
  const mg = $('l_margin') && $('l_margin').closest('.ctl');
  if (mg && $('rxMargin')) $('rxMargin').appendChild(mg);

  // ---------- review step: the state of the checks at a glance ----------
  function mini() {
    const box = $('chkMini'); if (!box) return;
    const li = [...document.querySelectorAll('#checks > li')];
    const c = li.filter(x => x.classList.contains('crit')).length, w = li.filter(x => x.classList.contains('warn')).length;
    const any = li.length > 0;
    const html = !any ? '' : `<div class="chk-mini ${c ? 'crit' : w ? 'warn' : 'ok'}"><span>${c ? xl(`${c} kritik`) : ''}${c && w ? ' · ' : ''}${w ? xl(`${w} uyarı`) : ''}${!c && !w ? xl('Tüm kontroller geçti.') : ''}</span><button type="button" class="link" id="chkMiniGo">${xl('Kontrolleri aç')}</button></div>`;
    if (box.dataset.h === html) return;
    box.dataset.h = html; box.innerHTML = html;
    const go = $('chkMiniGo'); if (go) go.addEventListener('click', () => window.UI && UI.openTab('pChk'));
  }
  new MutationObserver(later).observe($('checks'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  // ---------- the saved-cases menu in the top bar closes on a click outside it, on Esc and after opening a case ----------
  const menu = $('secCases');
  if (menu) {
    document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
    $('caseList').addEventListener('click', e => { if (e.target.closest('[data-open]')) menu.open = false; });
  }

  setAll(store.get('gs.advAll') === '1', true);
  buildTabs(); counts(); mini();
  window.Flow = { rows, buildTabs, rxMode, setAll };
})();
