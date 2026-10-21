/* Workflow chrome: one open step at a time with "next" buttons and completion marks, step status tags, numeric
   entry beside every slider, settings and shortcut dialogs, server connection light, view presets and the
   orientation cube. Reads the planning state from window.Studio; it never changes the plan itself. */
'use strict';
window.UI = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const steps = [...document.querySelectorAll('details.step[name="flow"]')];

  // ---------- steps: only one open; "next" opens the following step ----------
  function openStep(id, scroll) {
    const el = $(id); if (!el) return;
    if (window.Layout && document.getElementById('app').classList.contains('no-left')) Layout.setLeft(true);
    el.open = true;
    if (scroll) requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  steps.forEach(d => d.addEventListener('toggle', () => { if (d.open) steps.forEach(o => { if (o !== d && o.open) o.open = false; }); store.set('gs.step', d.id); }));
  document.querySelectorAll('button.next').forEach(b => b.addEventListener('click', () => openStep(b.dataset.next, true)));
  // a click or brush mode belongs to the panel it was started from: moving to another step, or folding the section
  // that holds the pressed tool button, ends it, so the model never stops turning behind a closed panel
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('details.step[name="flow"] > summary, button.next')) St.endModes({ step: true }); }, true);
  document.addEventListener('toggle', e => { const d = e.target; if (d.tagName === 'DETAILS' && !d.open && d.querySelector('button[aria-pressed="true"][data-t], #fibPick[aria-pressed="true"], #fibSplit[aria-pressed="true"]')) St.endModes({ step: true }); }, true);

  // ---------- completion and status tags ----------
  // step rows show only an icon and a count ("0/3", "6"); the full wording is the tooltip. A plain "ok" with no
  // count is left to the tick beside the title, so the row does not show the same mark twice.
  const tag = (el, cls, text) => {
    if (!el) return;
    const num = (text.match(/\d+(\/\d+)?/) || [''])[0];
    el.className = 'tag' + (cls ? ' ' + cls : ''); el.textContent = num;
    el.title = text; if (text) el.setAttribute('aria-label', text); else el.removeAttribute('aria-label');
    el.hidden = !text || (cls === 'ok' && !num);
  };
  let exported = false;
  bus.addEventListener('exported', () => { exported = true; sync(); });
  bus.addEventListener('volume', () => { exported = false; });
  function sync() {
    const qc = S.qc || [], qcCrit = qc.some(q => q[0] === 'crit'), qcWarn = qc.some(q => q[0] === 'warn');
    const list = S.checkList || [], critOf = re => list.filter(o => o[0] === 'crit' && o[3] && re.test(o[3])).length;
    const fibOn = !!(window.Fibula && Fibula.active()), fibOk = fibOn && Fibula.approved();
    const plOk = S.planes.filter(p => p.ok).length, scOk = S.screws.filter(p => p.ok).length;
    const R = S.result, gCrit = critOf(/^guide$/), want = S.g.split && S.planes.length >= 2 ? 2 : 1;
    const done = {
      st1: !!S.vol && !qcCrit,
      st2: S.selected && S.selected.size > 0,
      st3: !!S.anchor && S.lesion.ok && S.planes.length > 0 && plOk === S.planes.length,
      st4: fibOk,
      st5: !!R && !!S.anchor && !!St.parts.guide && R.pieces === want && !gCrit,
      st6: S.screws.length > 0 && scOk === S.screws.length && !critOf(/^s\d/),
      st7: !$('expZip').disabled && (!St.lockState || St.lockState().ready),
      st8: exported,
    };
    // an ankle case (ankle.js) has its own steps and its own approval state
    const AK = window.Ankle && Ankle.on() ? Ankle.status() : null, planned = !!S.anchor || !!(AK && Ankle.planned());
    if (AK) Object.assign(done, AK.done, { st8: false });
    tag($('tag1'), !S.vol ? '' : qcCrit ? 'crit' : qcWarn ? 'warn' : 'ok', !S.vol ? '' : qcCrit ? 'Kritik' : qcWarn ? 'Uyarı' : 'Uygun');
    tag($('tag2'), S.selected && S.selected.size ? 'ok' : '', S.selected && S.selected.size ? `${S.selected.size} yapı` : '');
    const resN = S.planes.length + 1, resOk = plOk + (S.lesion.ok ? 1 : 0);
    tag($('tag3'), !S.anchor ? '' : critOf(/^p\d|lesion/) ? 'crit' : resOk === resN ? 'ok' : 'warn', !S.anchor ? '' : `${resOk}/${resN} onaylı`);
    tag($('tag5g'), !R ? '' : gCrit ? 'crit' : 'ok', !R ? '' : gCrit ? 'Kritik' : R.pieces === 1 ? 'Tek parça' : want === 2 && R.pieces === 2 ? 'İki guide' : `${R.pieces} parça`);
    tag($('tag5'), !S.screws.length ? '' : critOf(/^s\d/) ? 'crit' : scOk === S.screws.length ? 'ok' : 'warn', S.screws.length ? `${scOk}/${S.screws.length} onaylı` : '');
    // the status follows the package lock; a lock left open while something is pending is re-run first (fail-safe)
    if (S.anchor && !$('expZip').disabled && St.pendingList().length) St.renderAppr();
    const lock = St.lockState ? St.lockState() : { ready: !$('expZip').disabled, pend: St.pendingList().length }, pend = S.anchor ? lock.pend : AK && planned ? AK.pend : 0;
    tag($('tag7'), !planned ? '' : S.crit ? 'crit' : done.st7 ? 'ok' : 'warn', !planned ? '' : S.crit ? `${S.crit} kritik` : done.st7 ? 'Onaylı' : `${pend} bekliyor`);
    tag($('tag8'), done.st8 ? 'ok' : '', done.st8 ? 'Alındı' : '');
    const counted = steps.filter(d => !d.hidden && (d.id !== 'st4' || fibOn));
    steps.forEach(d => d.classList.toggle('done', !!done[d.id]));
    const n = counted.filter(d => done[d.id]).length;
    $('flowBar').style.width = (100 * n / counted.length) + '%';
    $('flowTxt').textContent = `${n}/${counted.length} adım tamam`;
    // top bar: overall state and title
    const crit = S.crit + (qcCrit ? 1 : 0);
    $('critCnt').hidden = !crit; $('critCnt').textContent = crit;
    const pill = $('readyPill');
    if (!planned) { pill.className = 'pill'; pill.textContent = 'Plan eksik'; }
    else if (crit) { pill.className = 'pill crit'; pill.textContent = 'Kritik uyarı'; }
    else if (done.st7) { pill.className = 'pill ok'; pill.textContent = 'Onaylı plan'; }
    else { pill.className = 'pill'; pill.textContent = pend ? `Onay bekliyor (${pend})` : 'Onay bekliyor'; }
    pill.title = crit && planned ? 'Kontrolleri aç' : '';
    // the package lock reason (#expMsg) sits under the download button; while it is locked a link leads to step 7
    $('goReview').hidden = !S.anchor || done.st7;
    // the 3D view's text alternative: what the plan holds now (WCAG 1.1.1); keys are listed in the label
    if (cv3d()) cv3d().setAttribute('aria-label', !S.vol ? '3B görünüm: model yüklenmedi.' : `3B görünüm: ${S.planes.length} kesi, ${S.screws.length} vida, ${crit} kritik kontrol. Ok tuşları döndürür, + ve − yakınlaştırır, 1–5 hazır yönler, 0 ortalar.`);
    if ($('fibIntro')) $('fibIntro').hidden = !!(window.Fibula && Fibula.state().F);
    const dd = $('caseInfo').querySelector('dd');
    $('caseTitle').textContent = $('caseTitle').title = $('caseName').value.trim() || (dd ? dd.textContent : '');
    document.title = ($('caseName').value.trim() ? $('caseName').value.trim() + ' · ' : '') + 'Yolmed Guide Stüdyosu';
  }
  let pend = false;
  const later = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; sync(); }); } };
  ['changed', 'parts', 'volume', 'planApplied', 'select', 'lock'].forEach(t => bus.addEventListener(t, later));
  const mo = new MutationObserver(later);
  ['qc', 'comps', 'checks', 'appr', 'caseInfo', 'expMsg', 'fibStatus'].forEach(id => mo.observe($(id), { childList: true, subtree: true, characterData: true }));
  $('caseName').addEventListener('input', later);
  $('goReview').addEventListener('click', () => { openStep('st7', true); const f = $('surgeon'); if (f && !f.value.trim()) setTimeout(() => f.focus(), 300); });

  // ---------- 3D canvas: name, focus and keyboard turning ----------
  // the WebGL canvas is created by the studio; it gets a role and a name, joins the Tab order and turns with the
  // arrow keys (15° steps around the view target), zooms with + / −, 0 fits the model. Picking regions and screws on
  // the model stays a pointer task; their numeric fields are in the steps.
  const cv3d = () => $('stage') && $('stage').querySelector('canvas');
  function canvasA11y() {
    const c = cv3d(); if (!c || c.dataset.a11y) return;
    c.dataset.a11y = '1'; c.tabIndex = 0; c.setAttribute('role', 'img');
    c.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const cam = St.camera, ctl = St.controls; if (!cam || !ctl) return;
      const off = cam.position.clone().sub(ctl.target), step = Math.PI / 12;
      let done = true;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') off.applyAxisAngle(cam.up.clone().normalize(), e.key === 'ArrowLeft' ? -step : step);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const side = V().crossVectors(cam.up, off).normalize(); off.applyAxisAngle(side, e.key === 'ArrowUp' ? step : -step); }
      else if (e.key === '+' || e.key === '=') off.multiplyScalar(0.85);
      else if (e.key === '-' || e.key === '−') off.multiplyScalar(1 / 0.85);
      else if (e.key === '0') { $('fit').click(); return e.preventDefault(); }
      else done = false;
      if (!done) return;
      e.preventDefault();
      cam.position.copy(ctl.target).add(off); ctl.update(); St.render();
    });
  }
  canvasA11y(); new MutationObserver(canvasA11y).observe($('stage'), { childList: true });

  // ---------- numeric entry beside each slider (type an exact value; arrow keys step it) ----------
  function enhance(range) {
    if (range.dataset.num) return;
    const row = range.closest('.ctl') && range.closest('.ctl').querySelector('.ctl-row'); if (!row) return;
    const out = row.querySelector('output'); if (!out) return;
    range.dataset.num = '1';
    const unit = (out.textContent.match(/[^\d\s,.\-−]+$/) || [''])[0].trim();
    const wrap = document.createElement('span'); wrap.className = 'num';
    // a text box (not type=number): the browser would show "0.5" in a Turkish interface whatever the page language;
    // here the value is written with the interface's separator (TR "0,5", EN "0.5") and the arrow keys step it
    const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off';
    inp.setAttribute('role', 'spinbutton'); inp.setAttribute('aria-valuemin', range.min); inp.setAttribute('aria-valuemax', range.max);
    inp.setAttribute('aria-label', (row.querySelector('label') || {}).textContent || 'Değer');
    wrap.append(inp, Object.assign(document.createElement('span'), { textContent: unit, className: 'u' }));
    out.classList.add('hasnum'); out.after(wrap);
    const loc = v => (window.I18N && I18N.lang === 'en' ? String(v) : String(v).replace('.', ','));
    const show = () => { inp.setAttribute('aria-valuenow', range.value); if (document.activeElement !== inp) inp.value = loc(range.value); const u = (out.textContent.match(/[^\d\s,.\-−]+$/) || [''])[0].trim(); if (u) wrap.querySelector('.u').textContent = u; };
    show();
    new MutationObserver(show).observe(out, { childList: true, characterData: true, subtree: true });
    range.addEventListener('input', show);
    const commit = () => {
      let v = parseFloat(String(inp.value).replace(',', '.')); if (!isFinite(v)) { show(); return; }
      v = Math.min(+range.max, Math.max(+range.min, v));
      range.value = v; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true }));
      inp.value = loc(range.value);
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { commit(); inp.blur(); return; }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const st = +range.step || 1, v = parseFloat(String(inp.value).replace(',', '.'));
      inp.value = loc(+((isFinite(v) ? v : +range.value) + (e.key === 'ArrowUp' ? st : -st)).toFixed(6)); commit();
    });
    window.addEventListener('langchange', show);
  }
  const scanRanges = () => document.querySelectorAll('.side .ctl input[type=range]').forEach(enhance);
  document.querySelectorAll('.side').forEach(el => new MutationObserver(scanRanges).observe(el, { childList: true, subtree: true }));
  scanRanges();

  // ---------- dialogs: settings, shortcuts ----------
  const openDlg = id => { const d = $(id); if (d.open) return; d.showModal ? d.showModal() : d.setAttribute('open', ''); };
  $('tSettings').addEventListener('click', () => openDlg('dlgSet'));
  $('tHelp').addEventListener('click', () => openDlg('dlgHelp'));
  const setDev = on => { $('devMode').checked = on; document.querySelectorAll('.tab.dev').forEach(t => { t.hidden = !on; }); if (!on && !$('pJsn').hidden && window.Layout) Layout.openTab('pChk'); store.set('gs.dev', on ? '1' : '0'); };
  $('devMode').addEventListener('change', e => setDev(e.target.checked));
  setDev(store.get('gs.dev') === '1');

  // ---------- server connection light ----------
  async function ping() {
    const url = St.serverUrl();
    if (!url) { $('stConn').textContent = 'yok (önizleme)'; return; }
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 2500);
      // (/health needs no token; the token goes along when there is one, the light never asks for it)
      const r = await fetch(url + '/health', { signal: ac.signal, headers: window.ServerAuth ? ServerAuth.header() : {} }); clearTimeout(t);
      $('stConn').textContent = r.ok ? 'bağlı' : `yanıt ${r.status}`;
    } catch (e) { $('stConn').textContent = 'ulaşılamıyor'; }
  }
  ping(); setInterval(ping, 30000);
  // a server that wants an access token (G2): Settings can enter it again (after the dialog was closed, or a new token)
  if (window.ServerAuth && ServerAuth.need()) { $('tokBox').hidden = false; $('tokSet').addEventListener('click', () => { $('dlgSet').close && $('dlgSet').close(); ServerAuth.enter(); }); }

  // ---------- keyboard ----------
  const PRESET = { ant: [0, -1, 0.12], right: [-1, 0, 0.12], left: [1, 0, 0.12], sup: [0, -0.03, 1], inf: [0, -0.03, -1] };
  function viewFrom(d) {
    const cam = St.camera, ctl = St.controls, r = cam.position.distanceTo(ctl.target), dir = V(...d).normalize();
    cam.position.copy(ctl.target).add(dir.multiplyScalar(r)); ctl.update(); St.render();
  }
  document.querySelectorAll('.presets button').forEach(b => b.addEventListener('click', () => viewFrom(PRESET[b.dataset.view])));
  document.addEventListener('keydown', e => {
    const a = document.activeElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'range' && a.type !== 'checkbox') return;
    if (e.key === '?') { openDlg('dlgHelp'); e.preventDefault(); }
    else if (/^[1-5]$/.test(e.key) && a.type !== 'range') viewFrom(PRESET[['ant', 'right', 'left', 'sup', 'inf'][+e.key - 1]]);
  });

  // ---------- orientation cube (patient axes, LPS: +x left, +y posterior, +z superior) ----------
  const cube = (() => {
    const cv = $('viewCube'); let r;
    try { r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true }); } catch (e) { cv.hidden = true; return null; }
    r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.setSize(96, 96, false);
    const sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    const faces = [['Sol', [1, 0, 0]], ['Sağ', [-1, 0, 0]], ['Arka', [0, 1, 0]], ['Ön', [0, -1, 0]], ['Üst', [0, 0, 1]], ['Alt', [0, 0, -1]]];
    const dark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    const tex = t => { t = window.I18N ? I18N.t(t) : t; const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
      g.fillStyle = dark() ? '#1b2025' : '#f7f8f9'; g.fillRect(0, 0, 128, 128); g.strokeStyle = dark() ? '#3a424a' : '#c5ccd3'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
      g.fillStyle = dark() ? '#e5e8eb' : '#14181c'; g.font = (t.length > 3 ? '600 26px' : '600 34px') + ' Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 64, 66);
      const tx = new THREE.CanvasTexture(c); tx.anisotropy = 4; return tx; };
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    let mats = faces.map(f => new THREE.MeshBasicMaterial({ map: tex(f[0]) }));
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), mats); sc.add(box);
    // the texts must read upright from outside: rotate the maps per face
    const fixUV = () => { const uv = box.geometry.attributes.uv; /* default UVs read correctly for side faces with z up */ uv.needsUpdate = true; };
    fixUV();
    const relabel = () => { mats.forEach((m, i) => { m.map.dispose(); m.map = tex(faces[i][0]); m.needsUpdate = true; }); draw(); };
    window.addEventListener('themechange', relabel); window.addEventListener('langchange', relabel);
    function draw() {
      const c = St.camera, d = c.position.clone().sub(St.controls.target).normalize();
      cam.position.copy(d.multiplyScalar(4)); cam.up.copy(c.up); cam.lookAt(0, 0, 0); r.render(sc, cam);
    }
    const rc = new THREE.Raycaster(), m2 = new THREE.Vector2();
    cv.addEventListener('click', e => {
      const b = cv.getBoundingClientRect(); m2.set((e.clientX - b.left) / b.width * 2 - 1, -(e.clientY - b.top) / b.height * 2 + 1);
      rc.setFromCamera(m2, cam); const h = rc.intersectObject(box)[0]; if (!h) return;
      const n = h.face.normal.clone(); viewFrom(Math.abs(n.z) > 0.9 ? [0, -0.03, n.z] : [n.x, n.y, 0.12]);
    });
    return { draw };
  })();
  let cubeRaf = 0;
  function onRender() { if (cube && !cubeRaf) cubeRaf = requestAnimationFrame(() => { cubeRaf = 0; cube.draw(); }); }

  // restore the last open step
  const last = store.get('gs.step'); if (last && $(last) && !$(last).hidden) openStep(last);
  sync();
  $('readyPill').addEventListener('click', () => { if ($('readyPill').classList.contains('crit')) window.Layout && Layout.openTab('pChk', true); });
  return { openStep, openTab: id => window.Layout && Layout.openTab(id, true), onRender, sync, viewFrom };
})();
