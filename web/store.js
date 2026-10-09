/* Case store: autosaved drafts, immutable versions, undo/redo.
   Backends share one interface; the first that answers wins:
   hospital server (REST, /cases) > this page's own database (artifact db) > this browser (localStorage).
   Only plan JSON is stored, never image data. */
'use strict';
(function () {
  const St = window.Studio; if (!St) return;
  const $ = id => document.getElementById(id), S = St.S;
  const nowISO = () => new Date().toISOString();
  const when = iso => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rid = () => Math.random().toString(36).slice(2, 10);
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // ---------- backends ----------
  function RestBackend(base) {
    const req = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error(`sunucu ${r.status}`);
      return r.json();
    };
    return {
      label: 'Hastane sunucusu',
      list: () => req('GET', '/cases'),
      create: m => req('POST', '/cases', m),
      get: id => req('GET', `/cases/${id}`),
      saveDraft: (id, plan) => req('PUT', `/cases/${id}/draft`, { plan }),
      versions: id => req('GET', `/cases/${id}/versions`),
      addVersion: (id, v) => req('POST', `/cases/${id}/versions`, v),
      getVersion: (id, n) => req('GET', `/cases/${id}/versions/${n}`),
    };
  }
  function ArtifactBackend(db) {
    // drafts and plans are stored as JSON strings so partial updates never merge stale keys
    const caseDoc = id => db.doc(`cases/${id}`);
    const out = d => { const x = d.data(); return { id: d.id, name: x.name, kind: x.kind, fingerprint: x.fingerprint, updated_at: x.updated_at, n_versions: x.n_versions || 0 }; };
    return {
      label: 'Sayfa veritabanı',
      async list() { const q = await db.collection('cases').orderBy('updated_at', 'desc').limit(50).get(); return q.docs.map(out); },
      async create(m) { const id = rid(); await caseDoc(id).set(Object.assign({}, m, { updated_at: nowISO(), n_versions: 0, draft_json: '' })); return { id }; },
      async get(id) { const d = await caseDoc(id).get(); if (!d.exists) throw new Error('vaka bulunamadı'); const x = d.data(); return Object.assign(out(d), { draft: x.draft_json ? JSON.parse(x.draft_json) : null }); },
      async saveDraft(id, plan) { const t = nowISO(); await caseDoc(id).update({ draft_json: JSON.stringify(plan), updated_at: t }); return { ok: true, updated_at: t }; },
      async versions(id) { const q = await db.collection(`cases/${id}/versions`).orderBy('n', 'desc').limit(200).get(); return q.docs.map(d => { const x = d.data(); return { n: x.n, note: x.note, author: x.author, created_at: x.created_at }; }); },
      async addVersion(id, v) {
        const prev = await this.versions(id), n = (prev.length ? prev[0].n : 0) + 1, t = nowISO();
        await db.doc(`cases/${id}/versions/v${String(n).padStart(4, '0')}`).set({ n, note: v.note, author: v.author, created_at: t, plan_json: JSON.stringify(v.plan) });
        await caseDoc(id).update({ n_versions: n, updated_at: t });
        return { n };
      },
      async getVersion(id, n) { const d = await db.doc(`cases/${id}/versions/v${String(n).padStart(4, '0')}`).get(); const x = d.data(); return { n: x.n, note: x.note, author: x.author, created_at: x.created_at, plan: JSON.parse(x.plan_json) }; },
    };
  }
  function LocalBackend() {
    const KEY = 'yolmed.cases.v1';
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { cases: {}, versions: {} }; } catch (e) { return { cases: {}, versions: {} }; } };
    const save = d => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { throw new Error('tarayıcı depolaması kullanılamıyor'); } };
    return {
      label: 'Bu tarayıcı',
      async list() { const d = load(); return Object.entries(d.cases).map(([id, c]) => ({ id, name: c.name, kind: c.kind, fingerprint: c.fingerprint, updated_at: c.updated_at, n_versions: (d.versions[id] || []).length })).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); },
      async create(m) { const d = load(), id = rid(); d.cases[id] = Object.assign({}, m, { updated_at: nowISO(), draft: null }); save(d); return { id }; },
      async get(id) { const c = load().cases[id]; if (!c) throw new Error('vaka bulunamadı'); return Object.assign({ id }, c); },
      async saveDraft(id, plan) { const d = load(), t = nowISO(); d.cases[id].draft = plan; d.cases[id].updated_at = t; save(d); return { ok: true, updated_at: t }; },
      async versions(id) { return (load().versions[id] || []).map(({ plan, ...v }) => v).reverse(); },
      async addVersion(id, v) { const d = load(), arr = d.versions[id] = d.versions[id] || [], n = arr.length + 1, t = nowISO(); arr.push({ n, note: v.note, author: v.author, created_at: t, plan: v.plan }); d.cases[id].updated_at = t; save(d); return { n }; },
      async getVersion(id, n) { return (load().versions[id] || []).find(v => v.n === n); },
    };
  }
  async function pickBackend() {
    const url = St.serverUrl();
    if (url) {
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(url + '/cases', { signal: ctl.signal }); clearTimeout(t);
        if (r.ok && Array.isArray(await r.json())) return RestBackend(url);
      } catch (e) { /* not reachable from here */ }
    }
    if (window.claude && window.claude.use) {
      const db = await window.claude.use('db');
      if (db) { try { await db.collection('cases').limit(1).get(); return ArtifactBackend(db); } catch (e) { /* fall through */ } }
    }
    return LocalBackend();
  }

  // ---------- state ----------
  let backend = null, caseId = null, caseName = '', lastJSON = null, userAt = -1e9, snapTimer = null, saveTimer = null, pendingSave = null;
  const H = { list: [], idx: -1 };
  ['pointerdown', 'keydown', 'input', 'change'].forEach(t => document.addEventListener(t, e => { if (e.isTrusted) userAt = performance.now(); }, true));
  const setSave = (text, cls) => { $('saveState').textContent = text; $('stSave').textContent = text; $('saveState').style.color = cls === 'err' ? 'var(--crit)' : ''; };
  function renderCaseHead() {
    $('caseName').disabled = !!caseId;
    if (caseId) $('caseName').value = caseName;
    const t = $('tag0'); t.className = 'tag ' + (caseId ? 'ok' : 'warn'); t.textContent = caseId ? 'Kayıtlı' : 'Kayıtsız';
    $('stBackend').textContent = backend ? backend.label : '–';
  }
  function updUndo() { $('undo').disabled = H.idx <= 0; $('redo').disabled = H.idx >= H.list.length - 1; }
  const remember = () => { try { localStorage.setItem('yolmed.lastCase', JSON.stringify({ backend: backend.label, id: caseId })); } catch (e) {} };

  // ---------- history (undo / redo) ----------
  function baseline() { const p = St.planOf(); lastJSON = JSON.stringify(p); H.list = [p]; H.idx = 0; updUndo(); }
  function snapshot() {
    if (S.restoring || !S.red) return;
    const plan = St.planOf(), js = JSON.stringify(plan);
    if (js === lastJSON) return;
    const user = performance.now() - userAt < 5000;
    lastJSON = js;
    if (H.idx < 0) { H.list = [plan]; H.idx = 0; }
    else if (!user) H.list[H.idx] = plan;          // derived update (preset, async recompute): not an undo step
    else { H.list = H.list.slice(0, H.idx + 1); H.list.push(plan); if (H.list.length > 150) H.list.shift(); H.idx = H.list.length - 1; }
    updUndo();
    if (caseId || (user && H.list.length > 1)) queueSave(plan);
  }
  async function step(d) {
    const i = H.idx + d; if (i < 0 || i >= H.list.length || S.restoring) return;
    H.idx = i; updUndo();
    await St.applyPlan(H.list[i]);
    lastJSON = JSON.stringify(St.planOf());
    if (caseId) queueSave(H.list[i]);
  }
  St.bus.addEventListener('changed', () => { if (S.restoring) return; clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 300); });
  St.bus.addEventListener('volume', e => {
    if (e.detail && e.detail.restoring) return;
    caseId = null; caseName = ''; $('caseName').value = ''; H.list = []; H.idx = -1; lastJSON = null; updUndo(); renderCaseHead(); renderVersions([]); setSave('Kaydedilmedi');
    markCurrent();
  });
  St.bus.addEventListener('exported', () => { if (backend) saveVersion('Üretim paketi alındı'); });
  $('undo').addEventListener('click', () => step(-1));
  $('redo').addEventListener('click', () => step(1));
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { step(-1); e.preventDefault(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { step(1); e.preventDefault(); }
  });

  // ---------- drafts ----------
  async function ensureCase() {
    if (caseId) return caseId;
    const src = S.source || {};
    caseName = $('caseName').value.trim() || `${src.type === 'sample' ? 'Örnek' : src.name || 'Vaka'} · ${new Date().toLocaleDateString('tr-TR')}`;
    const r = await backend.create({ name: caseName, kind: S.kind || '', fingerprint: src.fp || '' });
    caseId = r.id; remember(); renderCaseHead(); refreshList();
    return caseId;
  }
  function queueSave(plan) {
    if (!backend) return;
    pendingSave = plan; setSave('Kaydediliyor…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const p = pendingSave; pendingSave = null;
      try { await ensureCase(); const r = await backend.saveDraft(caseId, p); setSave('Kaydedildi ' + when(r.updated_at || nowISO()).split(' ').pop()); }
      catch (e) { setSave('Kaydedilemedi', 'err'); St.alertMsg('Plan kaydedilemedi: ' + e.message); }
    }, 1000);
  }
  async function flush() { if (pendingSave) { clearTimeout(saveTimer); const p = pendingSave; pendingSave = null; await ensureCase(); await backend.saveDraft(caseId, p); setSave('Kaydedildi'); } }

  // ---------- case list ----------
  async function refreshList() {
    if (!backend) return;
    try {
      const list = await backend.list();
      $('caseList').innerHTML = list.slice(0, 12).map(c => `<li data-id="${esc(c.id)}"><span class="meta"><span>${esc(c.name)}</span><small>${when(c.updated_at)} · ${c.n_versions || 0} sürüm</small></span><span class="act"><button data-open="${esc(c.id)}">Aç</button></span></li>`).join('') || '<li class="hint">Kayıtlı vaka yok.</li>';
      $('caseList').querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openCase(b.dataset.open)));
      markCurrent();
    } catch (e) { $('caseList').innerHTML = `<li class="err">Liste alınamadı: ${esc(e.message)}</li>`; }
  }
  const markCurrent = () => $('caseList').querySelectorAll('li[data-id]').forEach(li => li.classList.toggle('cur', li.dataset.id === caseId));
  async function openCase(id) {
    try {
      await flush();
      St.busy(true, 'Vaka açılıyor…');
      const c = await backend.get(id);
      caseId = c.id; caseName = c.name; remember(); renderCaseHead(); markCurrent();
      let plan = c.draft;
      if (!plan) { const vs = await backend.versions(id); if (vs.length) plan = (await backend.getVersion(id, vs[0].n)).plan; }
      loadVersions();
      if (!plan) { St.busy(false); setSave('Boş vaka'); return; }
      const ok = await St.openPlan(plan);
      St.busy(false);
      if (ok) { baseline(); setSave('Açıldı'); } else { awaitingDicom = true; setSave('DICOM bekleniyor'); }
    } catch (e) { St.busy(false); St.alertMsg('Vaka açılamadı: ' + e.message); }
  }
  let awaitingDicom = false;
  St.bus.addEventListener('planApplied', () => { if (awaitingDicom) { awaitingDicom = false; baseline(); setSave('Açıldı'); } });

  // ---------- versions ----------
  function renderVersions(vs) {
    $('verList').innerHTML = vs.map(v => `<li><span class="meta"><span>S${v.n}${v.note ? ' · ' + esc(v.note) : ''}</span><small>${esc(v.author || '–')} · ${when(v.created_at)}</small></span><span class="act"><button data-v="${v.n}">Yükle</button></span></li>`).join('') || (caseId ? '<li class="hint">Henüz sürüm yok.</li>' : '');
    $('verList').querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => restoreVersion(+b.dataset.v)));
  }
  async function loadVersions() { if (!caseId) { renderVersions([]); return; } try { renderVersions(await backend.versions(caseId)); } catch (e) { $('verMsg').textContent = 'Sürümler alınamadı: ' + e.message; } }
  async function saveVersion(note) {
    try {
      await ensureCase(); await flush();
      const plan = St.planOf(), r = await backend.addVersion(caseId, { plan, note: note || '', author: plan.surgeon || '' });
      $('verMsg').textContent = `S${r.n} kaydedildi.`; $('verNote').value = '';
      loadVersions(); refreshList();
    } catch (e) { $('verMsg').textContent = 'Sürüm kaydedilemedi: ' + e.message; }
  }
  async function restoreVersion(n) {
    try {
      const v = await backend.getVersion(caseId, n);
      const ok = await St.openPlan(v.plan);
      if (!ok) return;
      lastJSON = null; snapshot(); queueSave(St.planOf());
      $('verMsg').textContent = `S${n} geri yüklendi ve taslak oldu. Geri almak için Ctrl+Z.`;
    } catch (e) { $('verMsg').textContent = 'Sürüm yüklenemedi: ' + e.message; }
  }
  $('verSave').addEventListener('click', () => saveVersion($('verNote').value.trim()));
  $('caseNew').addEventListener('click', async () => { await flush(); caseId = null; caseName = ''; $('caseName').value = ''; renderCaseHead(); renderVersions([]); baseline(); setSave('Yeni vaka; ilk değişiklikte kaydedilir'); markCurrent(); });
  $('caseRefresh').addEventListener('click', refreshList);
  async function connect() {
    setSave('Bağlanıyor…');
    backend = await pickBackend();
    renderCaseHead(); refreshList(); loadVersions(); setSave(caseId ? 'Bağlandı' : 'Kaydedilmedi');
  }
  $('srvConnect').addEventListener('click', async () => { await flush().catch(() => {}); caseId = null; await connect(); });

  // ---------- start: pick a backend, then reopen the last case once the first volume is in ----------
  let firstVolume = new Promise(res => St.bus.addEventListener('volume', res, { once: true }));
  (async () => {
    renderCaseHead(); setSave('Bağlanıyor…');
    backend = await pickBackend();
    renderCaseHead(); setSave('Kaydedilmedi');
    refreshList();
    await firstVolume;
    await new Promise(r => setTimeout(r, 600));
    let last = null; try { last = JSON.parse(localStorage.getItem('yolmed.lastCase')); } catch (e) {}
    if (last && last.id && last.backend === backend.label) await openCase(last.id);
    else baseline();
  })();
  window.addEventListener('beforeunload', () => { if (pendingSave) { try { flush(); } catch (e) {} } });
})();
