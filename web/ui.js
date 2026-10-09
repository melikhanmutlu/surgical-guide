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

  // ---------- completion and status tags ----------
  const tag = (el, cls, text) => { if (!el) return; el.className = 'tag' + (cls ? ' ' + cls : ''); el.textContent = text; el.hidden = !text; };
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
      st5: !!R && R.pieces === want && !gCrit,
      st6: S.screws.length > 0 && scOk === S.screws.length && !critOf(/^s\d/),
      st7: !$('expZip').disabled,
      st8: exported,
    };
    tag($('tag1'), !S.vol ? '' : qcCrit ? 'crit' : qcWarn ? 'warn' : 'ok', !S.vol ? '' : qcCrit ? 'Kritik' : qcWarn ? 'Uyarı' : 'Uygun');
    tag($('tag2'), S.selected && S.selected.size ? 'ok' : '', S.selected && S.selected.size ? `${S.selected.size} yapı` : '');
    const resN = S.planes.length + 1, resOk = plOk + (S.lesion.ok ? 1 : 0);
    tag($('tag3'), !S.anchor ? '' : critOf(/^p\d|lesion/) ? 'crit' : resOk === resN ? 'ok' : 'warn', !S.anchor ? '' : `${resOk}/${resN} onaylı`);
    tag($('tag5g'), !R ? '' : gCrit ? 'crit' : 'ok', !R ? '' : gCrit ? 'Kritik' : R.pieces === 1 ? 'Tek parça' : want === 2 && R.pieces === 2 ? 'İki guide' : `${R.pieces} parça`);
    tag($('tag5'), !S.screws.length ? '' : critOf(/^s\d/) ? 'crit' : scOk === S.screws.length ? 'ok' : 'warn', S.screws.length ? `${scOk}/${S.screws.length} onaylı` : '');
    const pend = S.anchor ? St.pendingList().length : 0;
    tag($('tag7'), !S.anchor ? '' : S.crit ? 'crit' : done.st7 ? 'ok' : 'warn', !S.anchor ? '' : S.crit ? `${S.crit} kritik` : done.st7 ? 'Onaylı' : `${pend} bekliyor`);
    tag($('tag8'), done.st8 ? 'ok' : '', done.st8 ? 'Alındı' : '');
    const counted = steps.filter(d => d.id !== 'st4' || fibOn);
    steps.forEach(d => d.classList.toggle('done', !!done[d.id]));
    const n = counted.filter(d => done[d.id]).length;
    $('flowBar').style.width = (100 * n / counted.length) + '%';
    $('flowTxt').textContent = `${n}/${counted.length} adım tamam`;
    // top bar: overall state and title
    const crit = S.crit + (qcCrit ? 1 : 0);
    $('critCnt').hidden = !crit; $('critCnt').textContent = crit;
    const pill = $('readyPill');
    if (!S.anchor) { pill.className = 'pill'; pill.textContent = 'Hazırlanıyor'; }
    else if (crit) { pill.className = 'pill crit'; pill.textContent = 'Kritik uyarı'; }
    pill.title = crit && S.anchor ? 'Kontrolleri aç' : '';
    if ($('fibIntro')) $('fibIntro').hidden = !!(window.Fibula && Fibula.state().F);
    else if (done.st7) { pill.className = 'pill ok'; pill.textContent = 'Onaylı plan'; }
    else { pill.className = 'pill'; pill.textContent = 'Onay bekliyor'; }
    const dd = $('caseInfo').querySelector('dd');
    $('caseTitle').textContent = $('caseName').value.trim() || (dd ? dd.textContent : '');
    document.title = ($('caseName').value.trim() ? $('caseName').value.trim() + ' · ' : '') + 'Yolmed Guide Stüdyosu';
  }
  let pend = false;
  const later = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; sync(); }); } };
  ['changed', 'parts', 'volume', 'planApplied', 'select'].forEach(t => bus.addEventListener(t, later));
  const mo = new MutationObserver(later);
  ['qc', 'comps', 'checks', 'appr', 'caseInfo', 'expMsg', 'fibStatus'].forEach(id => mo.observe($(id), { childList: true, subtree: true, characterData: true }));
  $('caseName').addEventListener('input', later);

  // ---------- numeric entry beside each slider (type an exact value; arrow keys step it) ----------
  function enhance(range) {
    if (range.dataset.num) return;
    const row = range.closest('.ctl') && range.closest('.ctl').querySelector('.ctl-row'); if (!row) return;
    const out = row.querySelector('output'); if (!out) return;
    range.dataset.num = '1';
    const unit = (out.textContent.match(/[^\d\s,.\-−]+$/) || [''])[0].trim();
    const wrap = document.createElement('span'); wrap.className = 'num';
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = range.min; inp.max = range.max; inp.step = range.step;
    inp.setAttribute('aria-label', (row.querySelector('label') || {}).textContent || 'Değer');
    wrap.append(inp, Object.assign(document.createElement('span'), { textContent: unit, className: 'u' }));
    out.classList.add('hasnum'); out.after(wrap);
    const show = () => { if (document.activeElement !== inp) inp.value = range.value; const u = (out.textContent.match(/[^\d\s,.\-−]+$/) || [''])[0].trim(); if (u) wrap.querySelector('.u').textContent = u; };
    show();
    new MutationObserver(show).observe(out, { childList: true, characterData: true, subtree: true });
    range.addEventListener('input', show);
    const commit = () => {
      let v = parseFloat(String(inp.value).replace(',', '.')); if (!isFinite(v)) { show(); return; }
      v = Math.min(+range.max, Math.max(+range.min, v));
      range.value = v; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true }));
      inp.value = range.value;
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); inp.blur(); } });
  }
  const scanRanges = () => document.querySelectorAll('.side .ctl input[type=range]').forEach(enhance);
  document.querySelectorAll('.side').forEach(el => new MutationObserver(scanRanges).observe(el, { childList: true, subtree: true }));
  scanRanges();

  // ---------- dialogs: settings, shortcuts ----------
  const openDlg = id => { const d = $(id); if (d.open) return; d.showModal ? d.showModal() : d.setAttribute('open', ''); };
  $('tSettings').addEventListener('click', () => openDlg('dlgSet'));
  $('tConn').addEventListener('click', () => openDlg('dlgSet'));
  $('tHelp').addEventListener('click', () => openDlg('dlgHelp'));
  const setDev = on => { $('devMode').checked = on; document.querySelectorAll('.tab.dev').forEach(t => { t.hidden = !on; }); if (!on && !$('pJsn').hidden && window.Layout) Layout.openTab('pChk'); store.set('gs.dev', on ? '1' : '0'); };
  $('devMode').addEventListener('change', e => setDev(e.target.checked));
  setDev(store.get('gs.dev') === '1');

  // ---------- server connection light ----------
  async function ping() {
    const url = St.serverUrl(), dot = $('connDot');
    if (!url) { dot.className = 'conn'; $('stConn').textContent = 'tanımlı değil'; return; }
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 2500);
      const r = await fetch(url + '/health', { signal: ac.signal }); clearTimeout(t);
      const ok = r.ok; dot.className = 'conn ' + (ok ? 'ok' : 'off');
      $('stConn').textContent = ok ? 'bağlı' : `yanıt ${r.status}`; $('tConn').title = ok ? `Hastane sunucusu bağlı (${url})` : 'Hastane sunucusu yanıt vermiyor';
    } catch (e) { dot.className = 'conn off'; $('stConn').textContent = 'ulaşılamıyor'; $('tConn').title = `Hastane sunucusuna ulaşılamıyor (${url})`; }
  }
  $('srvConnect').addEventListener('click', ping);
  ping(); setInterval(ping, 30000);

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
    const tex = t => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
      g.fillStyle = dark() ? '#1b2025' : '#f7f8f9'; g.fillRect(0, 0, 128, 128); g.strokeStyle = dark() ? '#3a424a' : '#c5ccd3'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
      g.fillStyle = dark() ? '#e5e8eb' : '#14181c'; g.font = '600 34px IBM Plex Sans, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 64, 66);
      const tx = new THREE.CanvasTexture(c); tx.anisotropy = 4; return tx; };
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    let mats = faces.map(f => new THREE.MeshBasicMaterial({ map: tex(f[0]) }));
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), mats); sc.add(box);
    // the texts must read upright from outside: rotate the maps per face
    const fixUV = () => { const uv = box.geometry.attributes.uv; /* default UVs read correctly for side faces with z up */ uv.needsUpdate = true; };
    fixUV();
    window.addEventListener('themechange', () => { mats.forEach((m, i) => { m.map.dispose(); m.map = tex(faces[i][0]); m.needsUpdate = true; }); draw(); });
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
  const last = store.get('gs.step'); if (last && $(last)) openStep(last);
  sync();
  $('readyPill').addEventListener('click', () => { if ($('readyPill').classList.contains('crit')) window.Layout && Layout.openTab('pChk', true); });
  return { openStep, openTab: id => window.Layout && Layout.openTab(id, true), onRender, sync, viewFrom };
})();
