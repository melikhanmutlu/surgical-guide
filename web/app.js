/* Guide studio: DICOM -> bone model -> guide placement -> editable cut slots / screw sleeves -> inspection. */
'use strict';
(async function () {
  const $ = id => document.getElementById(id);
  const fmt = (x, d = 1) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : Number(x)).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sleep = () => new Promise(r => setTimeout(r, 0));
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const deg = THREE.MathUtils.degToRad;
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // English text for a message assembled at run time (i18n.js looks up whole strings, so the fixed pieces are translated before joining)
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const COLORS = { bone: 0xddd5bd, resected: 0xd67850, guide: 0x3c82dc, fguide: 0x2a9d8f, screw: 0x8c959c, plane: 0xe0533d, anchor: 0x22a06b, lesion: 0x8e6fd6 };
  // busy indicator; long server jobs get a running bar, elapsed time and a cancel button
  let busyTick = null, busyCancelFn = null, pipeGuide = false;   // pipeGuide: the guide build is the last stage (4/4) of a bone rebuild
  const busy = (on, text, opt = {}) => {
    $('busy').hidden = !on; $('busy').setAttribute('aria-busy', on ? 'true' : 'false'); document.body.classList.toggle('is-busy', !!on); if (text) $('busyText').textContent = text;
    $('busyBar').hidden = !(on && opt.bar); $('busyBar').classList.remove('det'); $('busyBar').firstElementChild.style.width = ''; $('busyCancel').hidden = !(on && opt.cancel); busyCancelFn = on ? opt.cancel || null : null;
    clearInterval(busyTick);
    if (on && opt.bar) { const t0 = Date.now(); busyTick = setInterval(() => { $('busyText').textContent = `${xl(text)} ${xl(`${Math.round((Date.now() - t0) / 1000)} sn`)}${opt.max ? ' ' + xl(`/ en çok ${opt.max} sn`) : ''}`; }, 1000); }
  };
  // determinate bar for file loading: percentage and, once the rate is known, the time left
  const etaText = s => s < 60 ? `${Math.max(1, Math.round(s))} sn` : `${Math.floor(s / 60)} dk ${Math.round(s % 60)} sn`;
  // a DICOM / zip load can be cancelled (button in the busy bar) and a newer load replaces an older one: the older one stops at its next
  // progress step (LOAD_CANCELLED) and never reaches setVolume, so a stale series cannot overwrite the case
  const LOAD_CANCELLED = Object.assign(new Error('load cancelled'), { cancelled: true });
  let loadCtl = null, committing = false;
  function startLoad() { if (loadCtl) loadCtl.cancelled = true; return (loadCtl = { cancelled: false, byUser: false }); }
  // another load while the previous one is already building the case (setVolume) would race it: refuse with a notice
  function loadBlocked() { if (!committing) return false; alertMsg('Önceki yükleme sürüyor; bitince yeniden deneyin.'); return true; }
  // a plan action while a case is being read or built would plan the outgoing volume and have its state (anchor, cuts)
  // cleared under a running guide fit ("Otomatik planla" during the sample download threw in fitWrap): refuse with a notice
  function planBlocked() { if (!loadCtl && !committing) return false; alertMsg('Vaka yükleniyor; yükleme bitince yeniden deneyin.'); return true; }
  function progress(ctl) {
    const t0 = performance.now(); let last = -1e9;
    clearInterval(busyTick); $('busy').hidden = false; $('busy').setAttribute('aria-busy', 'true'); document.body.classList.add('is-busy'); $('busyBar').hidden = false; $('busyBar').classList.add('det'); $('busyCancel').hidden = !ctl;
    busyCancelFn = ctl ? () => { ctl.cancelled = ctl.byUser = true; $('busyCancel').hidden = true; $('busyText').textContent = 'Yükleme iptal ediliyor…'; } : null;
    return async (f, text) => {
      if (ctl && ctl.cancelled) throw LOAD_CANCELLED;
      const now = performance.now(); if (now - last < 120 && f < 1) return; last = now;
      f = Math.max(0, Math.min(1, f)); const el = (now - t0) / 1000, eta = f > 0.03 && el > 0.8 && f < 1 ? el * (1 - f) / f : null;
      $('busyBar').firstElementChild.style.width = (f * 100).toFixed(1) + '%';
      $('busyText').textContent = `${xl(text)} ${xl(`%${Math.floor(f * 100)}`)}${eta !== null ? ' ' + xl(`· yaklaşık ${etaText(eta)} kaldı`) : ''}`;
      await sleep();
    };
  }
  $('busyCancel').addEventListener('click', () => { if (busyCancelFn) busyCancelFn(); });

  // served by yolmed_server (config.js): the same origin is the case store, segmentation and STL service
  if (window.YOLMED_SERVER) $('aiUrl').value = window.YOLMED_SERVER;
  if (!window.THREE || !THREE.OrbitControls) { $('busyText').textContent = '3B kütüphanesi yüklenemedi. Sayfayı yenileyin.'; return; }

  // ---------- 3D view ----------
  const stage = $('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x5c6166, 0.5); scene.add(hemi);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000); camera.up.set(0, 0, 1);
  // head light from the viewer's upper left plus a weak fill from the right, so surfaces keep their shape without washing out
  const key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(-0.35, 0.45, 1); camera.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.15); fill.position.set(1, -0.2, 0.4); camera.add(fill); scene.add(camera);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  // optional second camera (fibula side, layer 1) for the side-by-side view, driven from the right half of the stage
  const camF = new THREE.PerspectiveCamera(35, 1, 1, 5000); camF.up.set(0, 0, 1); camF.layers.set(1);
  const keyF = key.clone(), fillF = fill.clone(); camF.add(keyF, fillF); scene.add(camF);
  // lighting: a preset (how much comes from the head light vs all around) times a brightness, kept per viewer
  const LIGHT = { balanced: [0.4, 0.48, 0.12], soft: [0.5, 0.3, 0.1], contrast: [0.26, 0.68, 0.1] };
  const lightStore = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  let light = { preset: LIGHT[lightStore.get('gs.light')] ? lightStore.get('gs.light') : 'balanced', k: +(lightStore.get('gs.lightK') || 1) };
  if (!(light.k >= 0.4 && light.k <= 1.6)) light.k = 1;
  // each view is lit only by the lights riding on its own camera; the other camera's pair is switched off while it draws
  // (intensity rather than visibility, so the light count and the compiled shaders stay the same)
  let lightI = [0, 0];
  function useLights(cam) {
    const m = cam !== camF;
    key.intensity = m ? lightI[0] : 0; fill.intensity = m ? lightI[1] : 0;
    keyF.intensity = m ? 0 : lightI[0]; fillF.intensity = m ? 0 : lightI[1];
  }
  function applyLight() {
    const [h, k, f] = LIGHT[light.preset];
    hemi.intensity = h * light.k; lightI = [k * light.k, f * light.k]; useLights(camera);
    lightStore.set('gs.light', light.preset); lightStore.set('gs.lightK', String(light.k));
    if ($('lightK')) { $('lightK').value = light.k; $('lightKO').textContent = `%${Math.round(light.k * 100)}`; $('lightP').value = light.preset; }
  }
  $('lightP').addEventListener('change', e => { light.preset = e.target.value; applyLight(); render(); });
  $('lightK').addEventListener('input', e => { light.k = +e.target.value; applyLight(); render(); });
  $('lightReset').addEventListener('click', () => { light = { preset: 'balanced', k: 1 }; applyLight(); render(); });
  applyLight();
  const ctlF = new THREE.OrbitControls(camF, $('splitPane'));
  // many edits ask for a frame in one go: draw once, on the next animation frame
  let renderQ = 0;
  function render() { if (!renderQ) renderQ = requestAnimationFrame(() => { renderQ = 0; renderNow(); }); }
  function renderNow() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (S.split) {
      const hw = Math.floor(w / 2);
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, hw, h); renderer.setScissor(0, 0, hw, h); useLights(camera); renderer.render(scene, camera);
      renderer.setViewport(hw, 0, w - hw, h); renderer.setScissor(hw, 0, w - hw, h); useLights(camF); renderer.render(scene, camF);
      useLights(camera);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h);
    } else { useLights(camera); renderer.render(scene, camera); }
    placeMarkers();
    if (window.UI && UI.onRender) UI.onRender();
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = (S.split ? w / 2 : w) / h; camera.updateProjectionMatrix();
    camF.aspect = (w / 2) / h; camF.updateProjectionMatrix();
    render();
  }
  function setSplit(on) {
    S.split = !!on; $('splitPane').hidden = !on; $('mainLabel').hidden = !on;
    camera.layers.set(0); resize();
  }
  controls.addEventListener('change', render); ctlF.addEventListener('change', render);
  new ResizeObserver(resize).observe(stage);
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.72, metalness: 0, side: THREE.DoubleSide }, extra));

  // scene parts (each can be shown, hidden, isolated, exploded)
  const parts = {};
  const partNames = {};   // user names of the layer list rows (renamePart below)
  const partKey = id => (window.Layers && Layers.keyOf ? Layers.keyOf(id) : id);
  function setPart(id, label, obj, color) {
    if (parts[id]) { scene.remove(parts[id].obj); disposeObj(parts[id].obj); }
    if (!obj) { delete parts[id]; return; }
    const prev = parts[id];
    parts[id] = { id, label, obj, color, visible: prev ? prev.visible : true, base: obj.position.clone() };
    obj.visible = parts[id].visible; scene.add(obj);
    if (prev && prev.opacity !== undefined && prev.opacity < 1) setOpacity(parts[id], prev.opacity);
  }
  function disposeObj(o) { o.traverse(c => { if (c.geometry && !c.geometry.userData.shared) c.geometry.dispose(); if (c.material) c.material.dispose(); }); }

  function meshFromNets(net, toWorld, material) {
    const p = net.positions, w = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) { const q = toWorld(p[i], p[i + 1], p[i + 2]); w[i] = q[0]; w[i + 1] = q[1]; w[i + 2] = q[2]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(w, 3));
    g.setIndex(new THREE.BufferAttribute(net.indices, 1));
    g.computeVertexNormals();
    return new THREE.Mesh(g, material);
  }

  // Marching tetrahedra triangulate smooth areas much finer than the shape needs. In the background (a few ms at a time, so
  // the page stays usable) the displayed guide's edges are collapsed while the surface moves less than LITE_TOL mm, which
  // cuts the STL / 3MF size several times over; the mesh stays closed and 2-manifold. A newer guide (the mesh leaves its
  // parent) cancels the job. window.GUIDE_LITE = false switches it off.
  const LITE_TOL = 0.03;
  async function simplifyMesh(mesh) {
    const g0 = mesh && mesh.geometry;
    if (!g0 || !g0.index || window.GUIDE_LITE === false) return false;
    const it = G.decimateGen({ positions: g0.attributes.position.array, indices: g0.index.array }, LITE_TOL);
    let t = performance.now(), r;
    for (;;) {
      r = it.next(); if (r.done) break;
      if (performance.now() - t > 14) { await new Promise(res => setTimeout(res, 0)); t = performance.now(); if (!mesh.parent || mesh.geometry !== g0) return false; }
    }
    if (!mesh.parent || mesh.geometry !== g0) return false;
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(r.value.positions, 3)); ng.setIndex(new THREE.BufferAttribute(r.value.indices, 1)); ng.computeVertexNormals();
    mesh.geometry = ng; g0.dispose();
    render();
    return true;
  }

  // ---------- case state ----------
  // kerfSide: where the saw slot lies relative to the planned cut plane. 1 = fully on the resected side (the cut plane
  // is the stump face, the graft sits flush), 0 = centred on the plane (half the slot width is lost from each stump).
  // vc: lateral (v) centre of the guide body relative to the anchor; set by the automatic sizing, 0 by hand.
  const G_DEFAULT = { rot: 0, roll: 0, L: 36, W: 22, wrap: 6, wall: 2.5, clear: 0.3, bridge: 4, side: 1, split: 0, flange: 3, peri: 0, fit: 0, stopT: 0, stopB: 0, stopL: 6, stopD: 5, kerfSide: 1, vc: 0 };
  // which body values are still chosen automatically from the bone (a slider edit takes a value over by hand)
  const AUTO_DEFAULT = { L: 1, W: 1, wrap: 1, split: 1 };
  // bar: the connecting bar between the two guides of a long resection (split 2); stopP: a lip on the posterior edge of a
  // guide that runs up the ramus (its v axis front to back), so the piece rests on the posterior border
  Object.assign(G_DEFAULT, { bar: 0, stopP: 0 }); Object.assign(AUTO_DEFAULT, { bar: 1, stopP: 1 });
  const S = {
    vol: null, red: null, labels: null, comps: [], selected: new Set(), mask: null,
    anchor: null,             // {p:Vector3, n:Vector3, axis:Vector3}
    g: Object.assign({}, G_DEFAULT), gAuto: Object.assign({}, AUTO_DEFAULT),
    fitLog: [],               // what the automatic fit ladder tried (wrap, two guides, flange), shown in the checks
    planes: [], screws: [], sel: null, explode: 0, mode: 'orbit', result: null,
    guideOn: false,           // the guide is built only after 'Guide oluştur', never on its own
    resRemoved: false,        // 'Rezeksiyon bölgesini sil': the resected piece is hidden
    lesion: { from: -6, to: 6, margin: 3, ok: false }, compNames: null, segMethod: 'Eşik', crit: 0, qc: [],
  };
  const bus = new EventTarget(), emit = (t, d) => bus.dispatchEvent(new CustomEvent(t, { detail: d }));
  const SCREW_DEFAULT = { mandible: { d: 2.0, D: 5, sleeveH: 5, len: 10 }, leg: { d: 2.5, D: 5.5, sleeveH: 6, len: 20 }, dicom: { d: 2.0, D: 5, sleeveH: 5, len: 12 } };
  // an item's approval stamp is bound to what was approved (D-7): its own values and the whole guide frame they are measured
  // from (centre, seating normal, bone axis, guide rotation): the cuts and drill lines are placed in that frame, so a frame
  // changed after approval moves them. The normals are renormalised on reading, so they are compared rounded to 1e-4.
  // A stored plan whose approved item was edited afterwards (or whose stamp was copied onto another item) opens with that
  // approval removed. Tamper-evident for a hand-edited file, not a signature: the audit chain (audit.js) is the record.
  const SIG_KEYS = { l: ['from', 'to', 'margin', 'condyle'], p: ['off', 'yaw', 'pitch', 'w', 'pv', 'pn'], s: ['u', 'v', 'tiltU', 'tiltV', 'd', 'D', 'sleeveH', 'len', 'part', 'plate'] };
  const kindOf = o => (o === S.lesion ? 'l' : S.planes.includes(o) ? 'p' : S.screws.includes(o) ? 's' : null);
  function itemSig(o, k) {
    const r3 = q => [q.x, q.y, q.z].map(x => Math.round(x * 1000) / 1000);
    const r4 = q => [q.x, q.y, q.z].map(x => Math.round(x * 1e4) / 1e4 + 0);
    const t = JSON.stringify([k, SIG_KEYS[k].map(x => (o[x] === undefined ? null : o[x])),
      S.anchor ? [r3(S.anchor.p), r4(S.anchor.n), r4(S.anchor.axis), S.g.rot || 0] : null]);
    let a = 0x811c9dc5, b = 0x5bd1e995;
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  const stamp = o => { o.ok = true; o.by = $('surgeon').value.trim(); o.at = new Date().toISOString(); const k = kindOf(o); if (k) o.sig = itemSig(o, k); };
  const unapprove = o => { o.ok = false; delete o.by; delete o.at; delete o.sig; };
  const unapproveAll = () => { unapprove(S.lesion); S.planes.forEach(unapprove); S.screws.forEach(unapprove); };

  // ---------- loading ----------
  async function gunzip(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const ds = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  async function readSample(name) {
    const d = await (await fetch(`sample_${name}.json`)).json();
    const q = await gunzip(d.data), hu = new Int16Array(q.length);
    for (let i = 0; i < q.length; i++) hu[i] = q[i] * d.scale + d.offset;
    const [nx, ny, nz] = d.dims;
    return { hu, nx, ny, nz, sp: d.spacing, origin: d.origin, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  }
  // the sample replaces whatever is being read (W6): a DICOM / zip read still running is cancelled (and says so) before
  // its volume could land over the sample; a newer load in turn replaces the sample before it is committed
  async function loadSample(name) {
    if (loadCtl) loadCtl.byUser = true;
    const ctl = startLoad();
    busy(true, 'Örnek vaka indiriliyor…');
    let vol;
    try { vol = await readSample(name); } catch (e) { if (loadCtl === ctl) loadCtl = null; throw e; }
    if (loadStopped(ctl)) return;
    if (loadCtl === ctl) loadCtl = null;
    S.source = { type: 'sample', name, fp: 'sample:' + name };
    await setVolume(vol, name === 'mandible' ? 'Örnek: mandibula (sentetik BT)' : 'Örnek: alt bacak (sentetik BT)', name);
  }
  // true when this load was cancelled (by the button, or replaced by a newer load); the busy bar is hidden unless a newer load owns it
  function loadStopped(ctl) {
    if (!ctl.cancelled) return false;
    if (loadCtl === ctl) { loadCtl = null; busy(false); }
    if (ctl.byUser) alertMsg('Yükleme iptal edildi.');
    return true;
  }
  async function loadDicom(files) {
    if (loadBlocked()) return;
    const ctl = startLoad();
    let r;
    try { r = await readDicom(files, ctl); } catch (e) { if (e !== LOAD_CANCELLED) { if (loadCtl === ctl) loadCtl = null; throw e; } }
    if (loadStopped(ctl) || !r) return;
    if (loadCtl === ctl) loadCtl = null;
    if (r.error) { busy(false); alertMsg(r.error); return; }
    S.source = r.source; scan = r.scan;
    if (S.pendingPlan && S.pendingPlan.source && S.pendingPlan.source.fp === r.source.fp) S.autoAnchor = false;
    await setVolume(r.vol, r.label, 'dicom');
  }
  // DICOM files -> { vol, label, source } or { error }
  async function readDicom(files, ctl) {
    if (!window.dicomParser) return { error: 'DICOM okuyucu yüklenemedi.' };
    const zipName = files.length === 1 && /\.zip$/i.test(files[0].name) ? files[0].name.replace(/\.zip$/i, '') : null;
    // one bar across the stages: unzip (if any) 30 %, reading the files, then decoding the chosen series
    const prog = progress(ctl), hasZip = window.Unzip && (files.some(f => /\.zip$/i.test(f.name || '')) || (await Promise.all(files.slice(0, 50).map(f => Unzip.isZip(f).catch(() => false)))).some(Boolean));
    const zw = hasZip ? 0.3 : 0, pw = (1 - zw) * 0.55, dw = 1 - zw - pw;
    await prog(0, 'Dosyalar okunuyor…');
    if (hasZip) {
      try {
        const x = await Unzip.expand(files, (i, n) => prog(zw * i / n, `Zip açılıyor (${i}/${n})…`));
        files = x.files;
        if (x.skipped.length) alertMsg(`${xl(`Zip içinde ${x.skipped.length} dosya açılamadı ve atlandı (şifreli, desteklenmeyen sıkıştırma ya da çok iç içe):`)} ${x.skipped.slice(0, 3).join(', ')}${x.skipped.length > 3 ? '…' : ''}`);
      } catch (e) { if (e === LOAD_CANCELLED) throw e; return { error: 'Zip açılamadı: ' + e.message }; }
    }
    if (!files.length) return { error: 'Dosya bulunamadı.' };
    const slices = [], unsup = {}; let skipped = 0, multi = 0;
    for (const f of files) {
      try {
        const ds = await dicomHeader(f);
        const ts = (ds.string('x00020010') || '1.2.840.10008.1.2.1').replace(/\0/g, '').trim();
        if (!ds.elements.x7fe00010) { skipped++; continue; }
        const ok = window.DicomCodecs ? DicomCodecs.supported(ts) : ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1'].includes(ts);
        if (!ok) { unsup[ts] = (unsup[ts] || 0) + 1; skipped++; continue; }
        if ((ds.intString('x00280008') || 1) > 1) { multi++; skipped++; continue; }
        const ipp = (ds.string('x00200032') || '').split('\\').map(Number), iop = (ds.string('x00200037') || '').split('\\').map(Number);
        if (ipp.length !== 3 || iop.length !== 6) { skipped++; continue; }
        slices.push({ ds, file: f, ipp, iop, series: ds.string('x0020000e') || '', sop: dstr(ds, 'x00080018'), path: f.relPath || f.webkitRelativePath || f.name });
      } catch (e) { skipped++; }
      await prog(zw + pw * (slices.length + skipped + multi) / files.length, `DICOM okunuyor (${slices.length + skipped} / ${files.length})…`);
    }
    if (!slices.length) { const u = Object.keys(unsup); return { error: u.length ? `${xl('Bu aktarım sözdizimi desteklenmiyor:')} ${u.map(t => window.DicomCodecs ? DicomCodecs.name(t) : t).join(', ')}.` : multi ? 'Çok çerçeveli (enhanced) DICOM henüz desteklenmiyor; seriyi tek kesitli dosyalar olarak dışa aktarın.' : 'Görüntü içeren DICOM bulunamadı.' }; }
    const bySeries = {}; slices.forEach(s => (bySeries[s.series] = bySeries[s.series] || []).push(s));
    const groups = Object.values(bySeries).sort((a, b) => b.length - a.length);
    let ser = groups[0];
    if (groups.length > 1) {
      // a plan waiting for its series picks it by fingerprint; otherwise the largest real series opens and the
      // others stay one click away in step 1 (Seri)
      const want = S.pendingPlan && S.pendingPlan.source && S.pendingPlan.source.fp;
      let hit = null;
      if (want) for (const g of groups) { const d = g[0].ds; if (await sha256(`${g[0].series}|${d.uint16('x00280011')}x${d.uint16('x00280010')}x${g.length}`) === want) { hit = g; break; } }
      // among the real series, a bone-kernel reconstruction (the one a guide is designed on) of about the same coverage
      // is preferred to a soft-tissue / standard one (D4)
      const real = groups.filter(g => !seriesInfo(g).warn), most = real.length ? real[0].length : 0;
      const bone = real.find(g => g.length >= 0.8 * most && BONE_RX.test(`${dstr(g[0].ds, 'x00181210')} ${dstr(g[0].ds, 'x0008103e')}`));
      ser = hit || bone || real[0] || groups[0];
    }
    const sc = { groups, zipName, skipped }, res = await decodeSeries(ser, prog, zw + pw, dw, sc);
    if (!res.error) { sc.cur = res.cur; res.scan = sc; }
    return res;
  }
  // header only (up to the pixel data tag) from the first 64 kB: a whole study is never held in memory while it is
  // sorted into series; the pixels of the chosen series are read one file at a time when it is decoded
  const dparse = (u8, o) => window.DicomCodecs ? DicomCodecs.parse(u8, o) : dicomParser.parseDicom(u8, o);
  async function dicomHeader(f) {
    const n = Math.min(f.size, 65536), opt = { untilTag: 'x7fe00010' };
    if (n < f.size) {
      try { const ds = await dparse(new Uint8Array(await f.slice(0, n).arrayBuffer()), opt); if (ds.elements.x7fe00010) return ds; } catch (e) { /* header longer than the slice */ }
    }
    return dparse(new Uint8Array(await f.arrayBuffer()), opt);
  }
  // series kept from the last DICOM load, so another one can be opened without reading the files again
  let scan = null;
  async function decodeSeries(ser, prog, p0, dw, sc) {
    // (the index of this series is returned as `cur`; the caller marks it current once the volume is in, so a failed or
    // cancelled switch leaves the list on the series that is actually loaded, W17)
    const { groups, zipName, skipped } = sc, bySeries = Object.fromEntries(groups.map(g => [g[0].series, g])), cur = groups.indexOf(ser);
    const r = V(...ser[0].iop.slice(0, 3)), c = V(...ser[0].iop.slice(3)), nrm = V().crossVectors(r, c);
    ser.sort((a, b) => V(...a.ipp).dot(nrm) - V(...b.ipp).dot(nrm));
    // two images at the same position (a repeated or second acquisition): keep the first
    const nIn = ser.length;
    ser = ser.filter((s, i) => !i || Math.abs(V(...s.ipp).dot(nrm) - V(...ser[i - 1].ipp).dot(nrm)) > 0.01);
    if (ser.length < nIn) alertMsg(`${nIn - ser.length} kesit aynı konumda tekrarlandığı için atlandı.`);
    const ds0 = ser[0].ds, rows = ds0.uint16('x00280010'), cols = ds0.uint16('x00280011');
    const ps = (ds0.string('x00280030') || '1\\1').split('\\').map(Number);
    const gaps = ser.slice(1).map((s, i) => Math.abs(V(...s.ipp).dot(nrm) - V(...ser[i].ipp).dot(nrm))).sort((a, b) => a - b);
    const dz = gaps.length ? gaps[gaps.length >> 1] : (parseFloat(ds0.string('x00180050')) || 1);
    if (!(dz > 0)) return { error: 'Kesit aralığı hesaplanamadı (kesit konumları eksik ya da aynı).' };
    const pos = ser.map(s => V(...s.ipp).dot(nrm)), dzList = pos.slice(1).map((p, i) => p - pos[i]);
    const span = V(...ser.at(-1).ipp).sub(V(...ser[0].ipp));
    const meta = { dzList, modality: (ds0.string('x00080060') || '').trim(), series: Object.keys(bySeries).length, picked: groups.length > 1,
      thickness: parseFloat(ds0.string('x00180050')) || null, kernel: (ds0.string('x00181210') || '').trim(),
      tilt: ser.length > 1 ? THREE.MathUtils.radToDeg(span.angleTo(nrm)) : 0, bits: ds0.uint16('x00280101') || 16,
      ts: (ds0.string('x00020010') || '1.2.840.10008.1.2.1').replace(/\0/g, '').trim(),
      // dates for the CT age check; UIDs so a DICOM SEG can reference this series (no patient name or ID is kept)
      studyDate: dstr(ds0, 'x00080020'), seriesDate: dstr(ds0, 'x00080021'), acqDate: dstr(ds0, 'x00080022'),
      uids: { study: dstr(ds0, 'x0020000d'), series: dstr(ds0, 'x0020000e'), frame: dstr(ds0, 'x00200052'), sopClass: dstr(ds0, 'x00080016'), sops: ser.map(s => s.sop) } };
    const fp = await sha256(`${ser[0].series}|${cols}x${rows}x${ser.length}`);
    const source = { type: 'dicom', name: (ds0.string('x0008103e') || 'DICOM').trim(), fp, slices: ser.length };
    const hu = new Int16Array(rows * cols * ser.length), ts0 = (ds0.string('x00020010') || '1.2.840.10008.1.2.1').replace(/\0/g, '').trim();
    const what = window.DicomCodecs && !/^1\.2\.840\.10008\.1\.2(\.1|\.2|\.1\.99)?$/.test(ts0) ? `${DicomCodecs.name(ts0)} açılıyor` : 'Kesitler hazırlanıyor';
    for (let k = 0; k < ser.length; k++) {
      let ds;
      try { ds = await dparse(new Uint8Array(await ser[k].file.arrayBuffer())); }
      catch (e) { return { error: `${xl(`Kesit ${k + 1} okunamadı:`)} ${e.message || e}` }; }
      const el = ds.elements.x7fe00010, signed = ds.uint16('x00280103') === 1;
      const slope = parseFloat(ds.string('x00281053') || '1'), icpt = parseFloat(ds.string('x00281052') || '0');
      let px;
      if (window.DicomCodecs) {
        try { px = await DicomCodecs.decode(ds); }
        catch (e) { return { error: `${xl(`Kesit ${k + 1} açılamadı:`)} ${e.message}` }; }
        if (px.length < rows * cols) return { error: `Kesit ${k + 1} boyutu seriyle uyuşmuyor.` };
      } else {
        const buf = ds.byteArray.buffer.slice(ds.byteArray.byteOffset + el.dataOffset, ds.byteArray.byteOffset + el.dataOffset + rows * cols * 2);
        px = signed ? new Int16Array(buf) : new Uint16Array(buf);
      }
      for (let i = 0; i < rows * cols; i++) hu[k * rows * cols + i] = Math.max(-1024, Math.min(32000, px[i] * slope + icpt));
      await prog(p0 + dw * (k + 1) / ser.length, `${what} (${k + 1} / ${ser.length})…`);
    }
    return { cur, source, vol: { hu, nx: cols, ny: rows, nz: ser.length, sp: [ps[1], ps[0], dz], origin: ser[0].ipp,
      axes: [[r.x, r.y, r.z], [c.x, c.y, c.z], [nrm.x, nrm.y, nrm.z]], meta }, label: `${zipName || ((ser[0].path || '').includes('/') ? ser[0].path.split('/')[0] : 'DICOM')}${groups.length > 1 && source.name ? ' · ' + source.name : ''} · ${xl(`${ser.length} kesit`)}${skipped ? xl(`, ${skipped} dosya atlandı`) : ''}` };
  }
  const dstr = (ds, tag) => (ds.string(tag) || '').replace(/\0/g, '').trim();
  const BONE_RX = /bone|kemik|osteo/i;
  // one line per series for the series switcher: description, size, slice thickness, kernel, and a warning for scouts
  function seriesInfo(g) {
    const d = g[0].ds, desc = dstr(d, 'x0008103e') || 'Açıklamasız seri', th = parseFloat(dstr(d, 'x00180050')), ps = dstr(d, 'x00280030').split('\\').map(Number);
    const kern = dstr(d, 'x00181210'), type = dstr(d, 'x00080008'), mod = dstr(d, 'x00080060'), num = dstr(d, 'x00200011');
    const parts = [`${g.length} kesit`, `${d.uint16('x00280011')}×${d.uint16('x00280010')}`];
    if (ps[0]) parts.push(`piksel ${fmt(ps[0], 2)} mm`); if (th) parts.push(`kalınlık ${fmt(th, 2)} mm`); if (kern) parts.push(`kernel ${kern}`); if (mod && mod !== 'CT') parts.push(mod);
    const warn = g.length < 20 ? 'çok az kesit (lokalizör olabilir)' : /LOCALIZER|SCOUT/i.test(type) ? 'lokalizör' : /DERIVED|SECONDARY/i.test(type) ? 'türetilmiş görüntü' : '';
    return { desc: (num ? `#${num} ` : '') + desc, sub: parts.join(' · '), warn };
  }
  function renderSeries() {
    const box = $('serBox'), sel = $('serSel');
    if (!scan || scan.groups.length < 2 || !S.source || S.source.type !== 'dicom') { box.hidden = true; return; }
    box.hidden = false;
    sel.innerHTML = scan.groups.map((g, i) => { const x = seriesInfo(g); return `<option value="${i}" ${i === scan.cur ? 'selected' : ''}>${esc(x.desc)} · ${esc(x.sub)}${x.warn ? ' · ' + esc(x.warn) : ''}</option>`; }).join('');
  }
  async function switchSeries(i) {
    if (!scan || !scan.groups[i] || i === scan.cur) return;
    if (S.anchor && !confirm('Seri değiştirilsin mi? Bu serideki kesiler ve guide silinir.')) { renderSeries(); return; }
    if (loadBlocked()) { renderSeries(); return; }
    const ctl = startLoad(), prog = progress(ctl); let r;
    try { await prog(0, 'Seri açılıyor…'); r = await decodeSeries(scan.groups[i], prog, 0, 1, scan); } catch (e) { if (e !== LOAD_CANCELLED) { if (loadCtl === ctl) loadCtl = null; throw e; } }
    if (loadStopped(ctl) || !r) { renderSeries(); return; }
    if (loadCtl === ctl) loadCtl = null;
    if (r.error) { busy(false); alertMsg(r.error); renderSeries(); return; }
    scan.cur = r.cur; S.source = r.source; await setVolume(r.vol, r.label, 'dicom');
  }
  async function sha256(t) {
    try { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { let h = 2166136261; for (const ch of t) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return 'f' + (h >>> 0).toString(16); }
  }
  // the message also floats over the view, since step 1 (where caseMsg lives) is often closed
  let toastT = 0;
  // "Vaka: … · Boyut: …" from the case box; textContent works while step 1 is collapsed
  const caseLine = () => [...$('caseInfo').querySelectorAll('dt')].map(dt => `${dt.textContent}: ${dt.nextElementSibling ? dt.nextElementSibling.textContent : ''}`).join(' · ');
  function alertMsg(t) {
    $('caseMsg').textContent = t; $('caseMsg').hidden = false;
    let el = $('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'alert'); el.addEventListener('click', () => { el.hidden = true; }); document.body.appendChild(el); }
    el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 8000);
  }

  async function setVolume(vol, label, kind) {
    committing = true;
    // a rebuild job that started before the load (guide fit, lesion plan) finishes before the case state is replaced
    try { await jobLock; return await setVolumeNow(vol, label, kind); } finally { committing = false; }
  }
  async function setVolumeNow(vol, label, kind) {
    $('caseMsg').hidden = true;
    S.vol = vol; S.kind = kind;
    busy(true, 'Hacim küçültülüyor… 1/4'); await sleep();
    S.red = G.reduce(vol, 0.8);
    $('caseInfo').innerHTML = `<dt>Vaka</dt><dd>${esc(label)}</dd><dt>Boyut</dt><dd>${vol.nx}×${vol.ny}×${vol.nz}</dd><dt>Voksel</dt><dd>${vol.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd><dt>Çalışma ızgarası</dt><dd>${S.red.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd>`;
    S.qcBase = qualityCheck(vol); S.segWarn = []; syncQC();
    S.anchor = null; S.planes = []; S.screws = []; S.sel = null; S.result = null; S.guideOn = false; S.resRemoved = false; unapprove(S.lesion);
    // a new volume is a new patient: the previous case's guide settings and lesion bounds must not carry over (a plan restore keeps its own)
    if (S.autoAnchor !== false) { S.drillD = null; S.screwDrops = []; S.screwBlocked = []; Object.assign(S.g, G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, AUTO_DEFAULT); S.fitLog = []; S.autoSize = null; Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null }); syncGuideInputs(); syncLesion(); }
    ['guide', 'bar', 'resected', 'anchor', 'lesion'].forEach(id => setPart(id, null, null));
    clearElementParts();
    await segment(true);
    renderSeries();
    emit('volume', { restoring: S.autoAnchor === false });
    if (S.pendingPlan && S.source && S.pendingPlan.source && S.pendingPlan.source.fp === S.source.fp) { const p = S.pendingPlan; S.pendingPlan = null; await applyPlan(p); }
    S.autoAnchor = true;
  }

  // ---------- image quality control (thresholds from published guide workflows; clinical team sets the final values) ----------
  function qualityCheck(vol) {
    const m = vol.meta || {}, out = [], dz = vol.sp[2], th = m.thickness || dz;
    if (m.modality && m.modality !== 'CT') out.push(['crit', 'Kritik', `${xl('Modalite')} ${m.modality}; ${xl('BT serisi gerekli.')}`]);
    const step = Math.max(dz, th);
    out.push(step <= 1 ? ['ok', 'Uygun', `Kesit kalınlığı ${fmt(th, 2)} mm, aralık ${fmt(dz, 2)} mm (≤ 1 mm).`]
      : step <= 1.5 ? ['warn', 'Uyarı', `Kesit ${fmt(step, 2)} mm; guide için ≤ 1 mm önerilir.`]
      : ['crit', 'Kritik', `Kesit ${fmt(step, 2)} mm; guide tasarımı için çok kalın (≤ 1 mm gerekli).`]);
    const ps = Math.max(vol.sp[0], vol.sp[1]);
    out.push(ps <= 0.8 ? ['ok', 'Uygun', `Piksel aralığı ${fmt(ps, 2)} mm.`] : ['warn', 'Uyarı', `Piksel aralığı ${fmt(ps, 2)} mm; FOV daraltılarak çekim önerilir.`]);
    if (m.dzList && m.dzList.length > 1) {
      const sorted = m.dzList.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      const bad = m.dzList.filter(d => Math.abs(d - med) > 0.1).length;
      out.push(bad ? ['crit', 'Kritik', `${bad} yerde kesit aralığı düzensiz; eksik ya da tekrar eden kesit olabilir.`] : ['ok', 'Uygun', 'Kesit aralığı düzenli, eksik kesit yok.']);
    }
    if (m.bits && m.bits <= 8) out.push(['crit', 'Kritik', `Görüntü ${m.bits} bit; HU değerleri korunmamış (pencerelenmiş ya da ekran görüntüsü). Ham BT serisi gerekli.`]);
    if (m.ts && /^1\.2\.840\.10008\.1\.2\.4\.(50|51|81|91)$/.test(m.ts) && window.DicomCodecs) out.push(['warn', 'Uyarı', `${DicomCodecs.name(m.ts)}: ${xl('kayıplı sıkıştırma; kemik sınırı birkaç HU kayabilir.')}`]);
    if (m.tilt > 1) out.push(['crit', 'Kritik', `Gantry eğimi ${fmt(m.tilt)}°; hacim eğik örneklenmiş, guide kemiğe oturmayabilir. Eğimsiz (0°) ya da eğimi düzeltilmiş seri kullanın.`]);
    let mn = Infinity, metal = 0, n = 0;
    for (let i = 0; i < vol.hu.length; i += 7) { const v = vol.hu[i]; if (v < mn) mn = v; if (v > 2500) metal++; n++; }
    if (mn > -900) out.push(['warn', 'Uyarı', `En düşük değer ${mn} HU; HU kalibrasyonu (rescale) şüpheli.`]);
    if (metal / n > 1e-4) out.push(['warn', 'Uyarı', 'Metal artefaktı olabilir (> 2500 HU bölgeler); segmentasyonu kontrol edin.']);
    if (m.series > 1) out.push(['info', 'Bilgi', m.picked ? `${m.series} seri bulundu; seçilen seri kullanıldı.` : `${m.series} seri bulundu; en çok kesitli seri kullanıldı.`]);
    out.push(['info', 'Bilgi', `Kapsam ${fmt(vol.nz * dz, 0)} mm${m.kernel ? `, kernel ${m.kernel}` : ''}.`]);
    return out;
  }
  // image quality checks + checks of the chosen planning bone (is it really only a mandible?)
  function syncQC() { S.qc = (S.qcBase || []).concat(S.segWarn || []); renderQC(); }
  function segChecks() {
    const out = [], inf = S.segInfo, w = (t, ...a) => out.push(['warn', 'Uyarı', t(...a)]);
    if (!S.mask || !S.red) return out;
    if (inf && inf.status === 'failed')
      w((v, e) => `Eşik maskesi kafatası, çene ve omurgayı tek parça veriyor (${v} cm³, yükseklik ${e} mm) ve mandibula otomatik ayrılamadı. Planlama kemiği olarak bu büyük parça alındı; kondil, rezeksiyon ve fibula planı güvenilmez. Yalnız mandibulayı "Seç" aracıyla ya da kemik listesinden seçin, ya da bitişik kemikleri işaretleyip ayırın.`, fmt(inf.before.vol, 0), fmt(inf.before.ext[2], 0));
    else if (inf && inf.status === 'split' && (inf.ext[2] > 105 || inf.vol < 30 || inf.vol > 120))
      w((v, e) => `Mandibula otomatik ayrıldı (${v} cm³, yükseklik ${e} mm) ama parça beklenen aralığın kenarında; üst çene ya da kafatası artıkları karışmış ya da mandibulanın bir kısmı eksik olabilir. Kemik modelini kontrol edin.`, fmt(inf.vol, 0), fmt(inf.ext[2], 0));
    if (window.Bones) Bones.boneWarnings(S.red, S.mask).forEach(x => {
      if (x.code === 'big' && !(inf && inf.status === 'failed')) w(v => `Planlama kemiği ${v} cm³; bir mandibula için fazla büyük (250 cm³ üstü). Kafatası, üst çene ya da omurga da seçili olabilir; planı bu kemikle kurmayın.`, fmt(x.vol, 0));
      if (x.code === 'edge') w(() => 'Planlama kemiği tarama alanının üst ya da alt kenarına dayanıyor; kafatası ya da omurga seçili olabilir.');
    });
    return out;
  }
  function renderQC() { $('qc').innerHTML = S.qc.map(([c, t, m]) => `<li class="${esc(c)}"><b>${esc(t)}</b><span>${esc(m)}</span></li>`).join(''); }

  // ---------- segmentation ----------
  async function segment(autoSelect) {
    busy(true, 'Kemik ayrılıyor… 2/4'); await sleep();
    const r = S.red, thr = +$('thr').value;
    const m = G.threshold(r, thr);
    const { labels, comps, count } = G.components(m, r.nx, r.ny, r.nz, 200);
    S.labels = labels; S.comps = comps.slice(0, 8); S.compNames = null; S.segMethod = `Eşik ${thr} HU (tarayıcı)`; S.segInfo = null;
    let pick = comps.length ? comps[0].label : null;
    // a head CT's threshold mask is one piece (skull + upper jaw + mandible + spine): cut it at its thin necks and take
    // the piece that is built like a mandible; when none is, keep the largest and say so (see segChecks)
    if (window.Bones && Bones.assess(r, labels, comps).cut) {
      busy(true, 'Bitişik kemikler ayrılıyor (kafatası, çene, omurga)… 2/4'); await sleep();
      const res = S.segInfo = Bones.pickMandible(r, labels, comps, count);
      if (res.status === 'split') {
        pick = res.picked; S.comps = res.comps.slice(0, 8);
        if (!S.comps.some(c => c.label === pick)) S.comps[S.comps.length - 1] = res.comps.find(c => c.label === pick);
        S.compNames = { [pick]: 'Mandibula (otomatik ayrıldı)' }; S.segMethod += ' + bitişik kemik ayırma';
      }
    }
    // painted layer marks (Masks) split the threshold mask into layers and choose the planning bone
    const split = window.Masks ? Masks.relabel() : false;
    if (!split && (autoSelect || ![...S.selected].some(l => S.comps.find(c => c.label === l)))) S.selected = new Set(pick == null ? [] : [pick]);
    renderComps();
    await rebuildBone(true);
    // a failed or doubtful cut is announced, not left for the Kontroller tab alone
    if (S.segInfo && S.segInfo.status !== 'whole' && S.segWarn.length && !S.restoring) alertMsg(S.segWarn[0][2]);
  }
  function renderComps() {
    if (window.Masks) { Masks.renderList(); return; }
    const vox = S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000;
    $('comps').innerHTML = S.comps.map((c, i) => `<label class="comp"><input type="checkbox" data-l="${c.label}" ${S.selected.has(c.label) ? 'checked' : ''}> ${S.compNames ? esc(S.compNames[c.label] || 'Yapı ' + (i + 1)) : 'Yapı ' + (i + 1)} <span>${fmt(c.size * vox)} cm³</span></label>`).join('') || '<p class="hint">Eşiğin üstünde yapı bulunamadı.</p>';
    $('comps').querySelectorAll('input').forEach(el => el.addEventListener('change', async () => {
      el.checked ? S.selected.add(+el.dataset.l) : S.selected.delete(+el.dataset.l);
      await rebuildBone(false);
    }));
  }
  async function segmentAI() {
    const r = S.red, url = serverUrl();
    if (!url) { alertMsg('Bu işlem sunucu gerektirir; yayındaki sitede (sguide.up.railway.app) çalışır.'); return; }
    const ac = new AbortController();
    busy(true, 'Segmentasyon sunucusunda çalışıyor…', { bar: true, cancel: () => ac.abort() });
    try {
      const q = new URLSearchParams({ nx: r.nx, ny: r.ny, nz: r.nz, sp: r.sp.join(','), origin: r.origin.join(','), axes: r.axes.flat().join(','), structures: $('aiStruct').value });
      const res = await sfetch(`${url}/segment?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: r.hu, signal: ac.signal });
      if (!res.ok) throw new Error(xl(`sunucu ${res.status} döndü`));
      const lab = new Uint8Array(await res.arrayBuffer()), names = JSON.parse(res.headers.get('X-Structures') || '[]');
      if (lab.length !== r.hu.length) throw new Error('etiket hacmi boyutu uyuşmuyor');
      const labels = Int32Array.from(lab), comps = names.map(s => ({ label: s.label, size: 0, centroid: [0, 0, 0] }));
      for (let v = 0; v < labels.length; v++) { const c = comps.find(cc => cc.label === labels[v]); if (c) c.size++; }
      S.segInfo = null; S.labels = labels; S.comps = comps.filter(c => c.size > 0); S.compNames = Object.fromEntries(names.map(s => [s.label, s.name]));
      S.selected = new Set(S.comps.slice(0, 1).map(c => c.label)); S.segMethod = `Yapay zeka sunucusu (${url})`;
      $('caseMsg').hidden = true; renderComps(); await rebuildBone(true);
    } catch (e) {
      busy(false); alertMsg(ac.signal.aborted ? 'Segmentasyon iptal edildi.' : `${xl('Segmentasyon sunucusuna ulaşılamadı')} (${xl(e.message)}). ${xl('Eşik yöntemiyle devam edebilirsiniz.')}`);
    }
  }
  async function rebuildBone(frame) {
    busy(true, 'Yüzey modeli oluşturuluyor… 3/4'); await sleep();
    const r = S.red, m = new Uint8Array(S.labels.length);
    for (let i = 0; i < m.length; i++) m[i] = S.selected.has(S.labels[i]) ? 1 : 0;
    if (window.SegEdit) SegEdit.applyTo(m);
    S.mask = m; S.maskF = G.blur(m, r.nx, r.ny, r.nz);
    S.segWarn = segChecks(); syncQC();
    await rebuildResection();
    if (frame && parts.bone) fitTo(parts.bone.obj);
    pipeGuide = true;
    try { if (S.kind && !S.anchor && S.autoAnchor !== false) presetCase(); else if (S.anchor) await regenerate(); } finally { pipeGuide = false; }
    busy(false); render(); emit('bone');
  }
  const toWorldRed = (x, y, z) => G.worldOf(S.red, x, y, z);

  // ---------- resected bone (between first and last plane, connected piece at the anchor) ----------
  // blur only inside box (+2 voxels of context) and write it into dst; the separable blur reaches 1 voxel per axis
  function blurInto(dst, mask, r, box) {
    const [i0, j0, k0, i1, j1, k1] = [Math.max(0, box[0] - 2), Math.max(0, box[1] - 2), Math.max(0, box[2] - 2), Math.min(r.nx - 1, box[3] + 2), Math.min(r.ny - 1, box[4] + 2), Math.min(r.nz - 1, box[5] + 2)];
    const sx = i1 - i0 + 1, sy = j1 - j0 + 1, sz = k1 - k0 + 1, sub = new Uint8Array(sx * sy * sz);
    for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) { const a = sx * (j + sy * k), b = i0 + r.nx * (j + j0 + r.ny * (k + k0)); for (let i = 0; i < sx; i++) sub[a + i] = mask[b + i]; }
    const f = G.blur(sub, sx, sy, sz);
    // keep the outermost layer from the full-volume field (the crop clamps its edges)
    for (let k = 1; k < sz - 1; k++) for (let j = 1; j < sy - 1; j++) { const a = sx * (j + sy * k), b = i0 + r.nx * (j + j0 + r.ny * (k + k0)); for (let i = 1; i < sx - 1; i++) dst[b + i] = f[a + i]; }
  }
  let fullBone = null;
  function fullBoneGeo() {
    if (!S.maskF || !S.red) return null;
    if (!fullBone || fullBone.F !== S.maskF) {
      if (fullBone && !(parts.bone && parts.bone.obj.geometry === fullBone.geo)) { fullBone.geo.userData.shared = false; fullBone.geo.dispose(); }
      const r = S.red, geo = meshFromNets(G.surfaceNets(S.maskF, r.nx, r.ny, r.nz), toWorldRed, null).geometry; geo.userData.shared = true;
      fullBone = { F: S.maskF, geo };
    }
    return fullBone.geo;
  }
  // The resected piece itself: the bone between the outer cuts (beyond each saw slot) connected to the anchor within
  // 70 mm, or from the cut to the condyle for a condylar resection. Two infinite cut planes on a curved jaw enclose
  // more than the piece (the bone of the other side of the chin curving back between them, the ramus or the coronoid
  // beside a cut at the angle); that bone stays, so every "is this resected" question asks the piece, not the slab.
  // Cached per plan; `dist` = the distance to the piece in mm over its box plus RES_PAD mm (for the screw margin).
  const RES_PAD = 6;
  let rpCache = { key: null, mask: null, piece: null };
  function resPieceKey(E) {
    const cond = E && E.condyle ? (E.B.cond || E.B.p).toArray() : null;
    return JSON.stringify([S.anchor && S.anchor.p.toArray(), S.anchor && S.anchor.n.toArray(), S.anchor && S.anchor.axis.toArray(), S.g.rot, S.g.kerfSide, S.lesion.condyle || '', cond, S.planes.map(p => [p.off, p.yaw, p.pitch, p.w, p.pv || 0, p.pn || 0])]);
  }
  function resPiece() {
    if (!S.anchor || !S.mask || !S.red) return null;
    const E = resEnds(); if (!E) return null;
    const key = resPieceKey(E);
    if (rpCache.key === key && rpCache.mask === S.mask) return rpCache.piece;
    const r = S.red, nxy = r.nx * r.ny, { A, B } = E;
    let piece = null;
    // a condylar resection runs from the cut to the condyle: search a ball around that span, keep the piece at the condyle
    const Bc = E.condyle ? B.cond || B.p : B.p, ap = E.condyle ? A.p.clone().lerp(Bc, 0.5) : S.anchor.p, R = E.condyle ? A.p.distanceTo(Bc) / 2 + 35 : 70, c = G.indexOf(r, [ap.x, ap.y, ap.z]);
    const rad = r.sp.map(s => Math.ceil(R / s));
    const lo = c.map((x, a) => Math.max(0, Math.floor(x - rad[a]))), hi = c.map((x, a) => Math.min([r.nx, r.ny, r.nz][a] - 1, Math.ceil(x + rad[a])));
    const cand = new Uint8Array(S.mask.length), ax = r.axes, sp = r.sp, o = r.origin;
    // the resected piece starts beyond the saw slot (slot centre pSlot, half width w/2)
    const aT = A.w / 2 + A.N.dot(A.pSlot || A.p), bT = -B.w / 2 + B.N.dot(B.pSlot || B.p);
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const v = i + r.nx * (j + r.ny * k); if (!S.mask[v]) continue;
      const x = o[0] + ax[0][0] * i * sp[0] + ax[1][0] * j * sp[1] + ax[2][0] * k * sp[2];
      const y = o[1] + ax[0][1] * i * sp[0] + ax[1][1] * j * sp[1] + ax[2][1] * k * sp[2];
      const z = o[2] + ax[0][2] * i * sp[0] + ax[1][2] * j * sp[1] + ax[2][2] * k * sp[2];
      if ((x - ap.x) ** 2 + (y - ap.y) ** 2 + (z - ap.z) ** 2 > R * R) continue;
      if (x * A.N.x + y * A.N.y + z * A.N.z > aT && (E.condyle || x * B.N.x + y * B.N.y + z * B.N.z < bT)) cand[v] = 1;
    }
    const { labels, comps } = G.components(cand, r.nx, r.ny, r.nz, 1);
    if (comps.length) {
      // the piece nearest the anchor
      let bd = Infinity, best = null;
      const near = E.condyle ? Bc : ap;
      comps.forEach(cm => { const d = V(...G.worldOf(r, ...cm.centroid)).distanceTo(near); if (d < bd) { bd = d; best = cm; } });
      const mask = new Uint8Array(cand.length), box = [Infinity, Infinity, Infinity, -1, -1, -1];
      for (let v = 0; v < cand.length; v++) if (labels[v] === best.label) {
        mask[v] = 1; const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / nxy) | 0;
        if (i < box[0]) box[0] = i; if (j < box[1]) box[1] = j; if (k < box[2]) box[2] = k; if (i > box[3]) box[3] = i; if (j > box[4]) box[4] = j; if (k > box[5]) box[5] = k;
      }
      // distance to the piece (mm) over its box grown by RES_PAD
      const pad = r.sp.map(s => Math.ceil(RES_PAD / s) + 1);
      const d0 = [0, 1, 2].map(a => Math.max(0, box[a] - pad[a])), d1 = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, box[a + 3] + pad[a]));
      const dn = [0, 1, 2].map(a => d1[a] - d0[a] + 1), sub = new Uint8Array(dn[0] * dn[1] * dn[2]);
      for (let k = 0; k < dn[2]; k++) for (let j = 0; j < dn[1]; j++) { const a = dn[0] * (j + dn[1] * k), b = d0[0] + r.nx * (j + d0[1] + r.ny * (k + d0[2])); for (let i = 0; i < dn[0]; i++) sub[a + i] = mask[b + i]; }
      piece = { mask, box, size: best.size, lo: d0, dims: dn, dist: G.edt(sub, dn[0], dn[1], dn[2], r.sp) };
    }
    rpCache = { key, mask: S.mask, piece };
    return piece;
  }
  // distance (mm) from a world point to the resected piece; Infinity when it is farther than RES_PAD or there is no piece
  function resDist(q, piece) {
    const r = S.red, ix = G.indexOf(r, [q.x, q.y, q.z]), i = Math.round(ix[0]) - piece.lo[0], j = Math.round(ix[1]) - piece.lo[1], k = Math.round(ix[2]) - piece.lo[2], d = piece.dims;
    if (i < 0 || j < 0 || k < 0 || i >= d[0] || j >= d[1] || k >= d[2]) return Infinity;
    return piece.dist[i + d[0] * (j + d[1] * k)];
  }
  // a point within m mm of the resected piece (null when there is no piece to ask)
  function resectedNear(q, m = 0) { const pc = resPiece(); return pc ? resDist(q, pc) <= m : null; }
  async function rebuildResection(opts = {}) {
    const r = S.red;
    const piece = resPiece(), resMask = piece ? piece.mask : null, box = piece ? piece.box : null, best = piece;
    // the remaining bone's field differs from the full one only around the resected piece
    let field = S.maskF;
    if (resMask && !opts.live) {
      const boneMask = S.mask.slice(); for (let v = 0; v < boneMask.length; v++) if (resMask[v]) boneMask[v] = 0;
      field = S.maskF.slice(); blurInto(field, boneMask, r, box);
    }
    if (opts.live) {
      // while dragging: the whole bone (meshed once) with the resected piece drawn over it
      fullBoneGeo();
      if (!parts.bone || parts.bone.obj.geometry !== fullBone.geo) setPart('bone', 'Kemik (kalan)', new THREE.Mesh(fullBone.geo, mat(COLORS.bone)), COLORS.bone);
    } else setPart('bone', 'Kemik (kalan)', meshFromNets(G.surfaceNets(field, r.nx, r.ny, r.nz), toWorldRed, mat(COLORS.bone)), COLORS.bone);
    if (resMask) {
      const rf = new Float32Array(resMask.length); blurInto(rf, resMask, r, box);
      const bb = [box[0] - 2, box[1] - 2, box[2] - 2, box[3] + 2, box[4] + 2, box[5] + 2];
      setPart('resected', 'Rezeke edilecek parça', meshFromNets(G.surfaceNets(rf, r.nx, r.ny, r.nz, 0.5, bb), toWorldRed, mat(COLORS.resected, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })), COLORS.resected);
    } else setPart('resected', null, null);
    S.resMask = resMask;
    S.resectedVolume = best ? best.size * r.sp[0] * r.sp[1] * r.sp[2] : 0;
  }

  // the two ends of the defect: the outermost cuts, or (condylar resection) the cut farthest from the condyle and the condyle
  function resEnds() {
    if (!S.anchor) return null;
    const pl = planesWorld(), side = S.lesion.condyle, ref = side && window.Ref && Ref.get(), cond = ref && ref.cond[side];
    if (side) {
      if (!pl.length || !cond) return null;
      const c = V(...cond), A = pl.reduce((a, b) => (b.p.distanceTo(c) > a.p.distanceTo(c) ? b : a)), dir = c.clone().sub(A.p).normalize();
      const N = A.N.clone(); if (N.dot(dir) < 0) N.negate();
      // new condyle (web/condyle.js): the graft's rounded end lies `neo` mm short of the fossa (the condyle's place), on
      // the line to the cut; the resected piece is still found at the condyle itself (B.cond)
      const neo = window.Condyle && Condyle.neoOffset ? Math.max(0, Math.min(c.distanceTo(A.p) - 10, Condyle.neoOffset() || 0)) : 0;
      return { A: Object.assign({}, A, { N }), B: { p: neo ? c.clone().addScaledVector(dir, -neo) : c, cond: c, neo, N: dir, w: 0, off: A.off, virtual: true }, condyle: side };
    }
    if (pl.length < 2) return null;
    pl.sort((a, b) => a.off - b.off);
    return { A: pl[0], B: pl[pl.length - 1], condyle: null };
  }

  // cuts whose plane meets no bone within the guide's reach (indices into S.planes): such a cut guides nothing and the
  // defect has no stump face there. Sampled on the plane across the body (±W/2 + 6 mm) and down to 45 mm below the anchor.
  let cmCache = { key: null, maskF: null, miss: [] };
  function cutMisses() {
    if (!S.anchor || !S.maskF) return [];
    const key = JSON.stringify([S.anchor.p.toArray(), S.anchor.n.toArray(), S.anchor.axis.toArray(), S.g.rot, S.g.W, S.planes.map(p => [p.off, p.yaw, p.pitch, p.pv || 0, p.pn || 0])]);
    if (cmCache.key === key && cmCache.maskF === S.maskF) return cmCache.miss;
    const { n } = frameAxes(), miss = [], q = V();
    planesWorld().forEach(pw => {
      const vAx = V().crossVectors(n, pw.N); if (vAx.lengthSq() < 1e-8) return;
      vAx.normalize(); const dAx = V().crossVectors(pw.N, vAx).normalize(), half = (S.g.W || 22) / 2 + 6;
      let hit = false;
      outer: for (let vv = -half; vv <= half; vv += 1) for (let dd = 8; dd >= -45; dd -= 1) {
        q.copy(pw.p).addScaledVector(vAx, vv).addScaledVector(dAx, dd);
        if (boneAt(q) || boneAt(q.clone().addScaledVector(pw.N, 0.6)) || boneAt(q.clone().addScaledVector(pw.N, -0.6))) { hit = true; break outer; }
      }
      if (!hit) miss.push(S.planes.indexOf(pw.pl));
    });
    cmCache = { key, maskF: S.maskF, miss };
    return miss;
  }

  // 'Rezeksiyon bölgesini sil': the piece between the cuts is hidden (it stays in the plan and the exports)
  function showResected() {
    const pt = parts.resected; if (!pt) return;
    pt.visible = !S.resRemoved; pt.obj.visible = pt.visible;
  }
  function syncSeq() {
    if ($('gRotBox')) $('gRotBox').hidden = !S.guideOn;
    const has = !!S.anchor && S.planes.length > 0, gOn = S.guideOn && !!S.anchor;
    $('resRemove').disabled = !has;
    $('resRemove').innerHTML = S.resRemoved ? '<svg class="i"><use href="#i-eye"/></svg>Rezeke parçayı göster' : '<svg class="i"><use href="#i-eye"/></svg>Rezeke parçayı gizle';
    $('guideMake').disabled = !has; $('guideMake').hidden = gOn;
    $('guideDel').hidden = !gOn; $('guideDel2Box').hidden = !gOn;
    $('planReset').disabled = !S.anchor;
    [['sq1', has], ['sq2', has && S.resRemoved], ['sq3', gOn]].forEach(([id, ok]) => $(id).classList.toggle('done', ok));
    $('gNone').hidden = gOn;
  }
  const makeGuide = () => exclusive(makeGuideNow);
  async function makeGuideNow() {
    if (committing) return;      // queued before a load began building the new case: its anchor and cuts are gone
    if (!S.anchor || !S.planes.length) { alertMsg('Önce kesileri belirleyin.'); return; }
    S.guideOn = true; placeScrews(); S.sel = null;
    busy(true, 'Rezeksiyon güncelleniyor… 1/2'); await sleep(); await rebuildResection();
    busy(true, 'Guide oluşturuluyor… 2/2'); await sleep();
    const f = await fitWrap();
    $('guideStat').textContent = !f ? '' : !f.ok ? 'Guide bu yerleşimde takılamıyor; kesileri ya da ayarları kontrol edin.'
      : `Guide hazır · ${S.screws.length} vida` + (f.split ? (S.g.split === 2 && S.g.bar ? ' · iki guide + bağlantı köprüsü' : S.g.split === 2 ? ' · iki parça, her kesi kendi ekseninde (açı bölgesi)' : ' · iki parça (kavisli kemik)') : '') + (f.wrap < (S.kind === 'leg' ? 6 : 5) ? ` · sarma ${fmt(f.wrap, 1)} mm'ye indirildi` : '');
    syncSeq();
  }
  // one button: region (sample spot, painted lesion, or one click on the model), cuts, resected piece removed, guide
  async function autoPrep() {
    if (!S.red || !parts.bone || planBlocked()) return;
    // a fresh automatic plan sizes the body from the bone again
    Object.assign(S.gAuto, AUTO_DEFAULT); S.fitLog = [];
    const pts = window.Lesion && Lesion.points ? Lesion.points() : [];
    if (pts.length) { await Lesion.plan(); }
    else if (!S.anchor) {
      const pr = S.presetRay, hit = pr && new THREE.Raycaster(pr.from, pr.dirv).intersectObject(parts.bone.obj, false)[0];
      if (!hit) { S.autoAfter = true; setMode('anchor'); alertMsg('Modelde rezeksiyon bölgesine bir kez tıklayın; gerisi otomatik yapılacak.'); return; }
      setAnchor(hit.point.clone(), pr.dirv.clone().negate()); suggest();
    }
    if (!S.planes.length) suggest();
    S.resRemoved = true; showResected();
    await makeGuide();
  }
  function deleteGuide() {
    S.guideOn = false; S.screws = []; S.sel = null; $('guideStat').textContent = 'Guide silindi. Kesiler duruyor.';
    schedule(false); syncSeq();
  }
  async function resetPlan() {
    if (S.anchor && !confirm('Plan sıfırlansın mı? Kesiler, guide ve vidalar silinir; onaylar da düşer.')) return;
    S.anchor = null; S.planes = []; S.screws = []; S.sel = null; S.result = null; S.grid = null; S.guideOn = false; S.resRemoved = false;
    Object.assign(S.gAuto, AUTO_DEFAULT); S.g.wrapU = null; S.g.vc = 0; S.fitLog = []; S.autoSize = null;
    unapproveAll(); $('guideStat').textContent = '';
    if (window.Lesion && Lesion.clear) Lesion.clear();
    ['guide', 'bar', 'resected', 'anchor', 'lesion'].forEach(id => setPart(id, null, null)); clearElementParts();
    busy(true, 'Kemik modeli yenileniyor…'); await sleep(); await rebuildResection(); busy(false);
    setMode('orbit'); updatePanels(); syncSeq(); render(); emit('parts'); emit('changed');
  }

  // ---------- anchor frame ----------
  function showAnchor() {
    if (!S.anchor) { setPart('anchor', null, null); return; }
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), mat(COLORS.anchor));
    m.position.copy(S.anchor.p); setPart('anchor', 'Guide merkezi', m, COLORS.anchor);
  }
  function setAnchor(p, nGuess) {
    S.anchor = frameAt(p, nGuess);
    S.g.roll = 0; S.g.vc = 0;
    showAnchor();
  }
  // local bone frame at a surface point: seating normal n (surface normal blended with the direction away from the local
  // bone centre) and the local bone axis (PCA of the bone within 16 mm). Used for the anchor and, for a guide split
  // into two pieces on a curved jaw (body + ramus), for each piece's own frame at its cut.
  function frameAt(p, nGuess) {
    // average surface normal and local bone axis (PCA) around the picked point
    const r = S.red, ip = G.indexOf(r, [p.x, p.y, p.z]).map(Math.round), rad = Math.ceil(16 / Math.min(...r.sp));
    const pts = [];
    for (let k = Math.max(0, ip[2] - rad); k <= Math.min(r.nz - 1, ip[2] + rad); k++)
      for (let j = Math.max(0, ip[1] - rad); j <= Math.min(r.ny - 1, ip[1] + rad); j++)
        for (let i = Math.max(0, ip[0] - rad); i <= Math.min(r.nx - 1, ip[0] + rad); i++)
          if (S.mask[i + r.nx * (j + r.ny * k)]) { const q = V(...G.worldOf(r, i, j, k)); if (q.distanceTo(p) <= 16) pts.push(q); }
    let n = nGuess.clone().normalize();
    if (pts.length > 20) {
      const c = pts.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / pts.length);
      const away = p.clone().sub(c).normalize();
      if (away.lengthSq() > 0) n = away.add(n).normalize();
      // PCA by power iteration on the covariance
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      pts.forEach(q => { const d = [q.x - c.x, q.y - c.y, q.z - c.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; });
      let e = V(1, 0.3, 0.2);
      for (let it = 0; it < 50; it++) e = V(C[0][0] * e.x + C[0][1] * e.y + C[0][2] * e.z, C[1][0] * e.x + C[1][1] * e.y + C[1][2] * e.z, C[2][0] * e.x + C[2][1] * e.y + C[2][2] * e.z).normalize();
      return { p: p.clone(), n, axis: e };
    }
    return { p: p.clone(), n, axis: Math.abs(n.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0) };
  }
  // guide frame: u along the bone axis (rotated by g.rot about n), v = n x u, n = seating normal
  function frameAxes() {
    const { n, axis } = S.anchor;
    let u = axis.clone().sub(n.clone().multiplyScalar(axis.dot(n))).normalize();
    u.applyAxisAngle(n, deg(S.g.rot));
    const v = V().crossVectors(n, u);
    return { u, v, n };
  }
  // p is the planned cut plane (the stump face when the kerf lies on the resected side); pSlot is the centre of the saw
  // slot in the guide, shifted by `shift` mm along N towards the defect (w/2 when kerfSide = 1, 0 when centred)
  function planesWorld() {
    const { u, v, n } = frameAxes();
    const out = S.planes.map(pl => {
      const N = u.clone().applyAxisAngle(n, deg(pl.yaw));
      N.applyAxisAngle(V().crossVectors(n, N).normalize(), deg(pl.pitch)).normalize();
      const p = S.anchor.p.clone().add(u.clone().multiplyScalar(pl.off));
      // (pv, pn: the plane's reference point on the bone, as its v and n coordinates; the point slides along u within
      // the plane, so the plane itself is still the one through the guide axis at `off`)
      if (pl.pv || pl.pn) { const Nu = N.dot(u); if (Math.abs(Nu) > 0.05) p.addScaledVector(u, -((pl.pv || 0) * N.dot(v) + (pl.pn || 0) * N.dot(n)) / Nu).addScaledVector(v, pl.pv || 0).addScaledVector(n, pl.pn || 0); }
      return { pl, off: pl.off, w: pl.w, N, p, pSlot: p.clone(), shift: 0 };
    });
    if (S.g.kerfSide && out.length) {
      const side = S.lesion.condyle, ref = side && window.Ref && Ref.get && Ref.get(), cond = ref && ref.cond && ref.cond[side];
      const lo = out.reduce((a, b) => (b.off < a.off ? b : a)), hi = out.reduce((a, b) => (b.off > a.off ? b : a));
      out.forEach(pw => {
        // direction towards the defect: towards the condyle for a condylar resection, else from the outer cuts inwards
        let dir = 0;
        if (cond) dir = Math.sign(V(...cond).sub(pw.p).dot(pw.N)) || 0;
        else if (out.length >= 2 && pw === lo) dir = Math.sign(pw.N.dot(u)) || 1;
        else if (out.length >= 2 && pw === hi) dir = -(Math.sign(pw.N.dot(u)) || 1);
        if (dir) { pw.shift = dir * pw.w / 2; pw.pSlot = pw.p.clone().addScaledVector(pw.N, pw.shift); }
      });
    }
    return out;
  }
  // bone lost from the stump at a cut: the half slot behind the plane that the shift did not move to the resected side
  const stumpGap = pw => Math.max(0, pw.w / 2 - Math.abs(pw.shift || 0));
  function screwsWorld() { return S.screws.map(screwWorld); }
  // the two frames of a two-guide layout (split 2), one at each outer cut (cutFrame); the same anchor and cuts give the
  // same frames, so they are kept until one of those changes
  // (the bone is part of the key: a new threshold, a brush edit or a mask split moves the frames' footing, W16)
  let pfCache = { key: null, maskF: null, frames: null };
  const cutsKey = () => JSON.stringify([S.anchor.p.toArray(), S.anchor.n.toArray(), S.anchor.axis.toArray(), S.g.rot, S.g.kerfSide, S.planes.map(p => [p.off, p.yaw, p.pitch, p.w, p.pv || 0, p.pn || 0])]);
  function pieceFrames() {
    if (!S.anchor || S.planes.length < 2) return null;
    const key = cutsKey();
    if (pfCache.key === key && pfCache.maskF === S.maskF) return pfCache.frames;
    const pls = planesWorld().sort((a, b) => a.off - b.off), { u, n } = frameAxes();
    const a = cutFrame(pls[0], u.clone().negate(), n), b = cutFrame(pls[pls.length - 1], u, n);
    pfCache = { key, maskF: S.maskF, frames: a && b ? { a, b, A: pls[0], B: pls[pls.length - 1] } : null };
    return pfCache.frames;
  }
  // the outer cut whose kept side meets no bone (the far cut of a disarticulation lies past the condyle), as an index
  // into S.planes, or null: that cut holds no screws (all sit past the other cut), the guide need not reach it and no
  // two-guide layout is tried for it (W12: was computed by the old placement and lost with it)
  let blCache = { key: null, maskF: null, v: null };
  function bonelessCut() {
    if (!S.anchor || S.planes.length < 2 || !S.maskF) return (S.bonelessCut = null);
    const E = resEnds(); if (E && E.condyle) return (S.bonelessCut = null);
    const key = cutsKey();
    if (blCache.key === key && blCache.maskF === S.maskF) return (S.bonelessCut = blCache.v);
    const pls = planesWorld().sort((a, b) => a.off - b.off), { u, n } = frameAxes(), A = pls[0], B = pls[pls.length - 1];
    const noA = !cutFrame(A, u.clone().negate(), n), noB = !cutFrame(B, u, n);
    const v = noA !== noB ? S.planes.indexOf((noA ? A : B).pl) : null;
    blCache = { key, maskF: S.maskF, v };
    return (S.bonelessCut = v);
  }
  // A screw written in another frame (the guide's, part 0, or one piece's of the two-guide layout, part -1 / 1): the same
  // drill line written in the target frame. The entry is found again down the target normal, so on a curved surface the
  // spot can move a little: the screw loses its approval. False when a frame is not there (fewer than two cuts).
  function partFrame(part) {
    if (!part) return S.anchor ? Object.assign({ P: S.anchor.p }, frameAxes()) : null;
    const f = pieceFrames(); return f ? (part < 0 ? f.a : f.b) : null;
  }
  function reframe(sc, part) {
    const from = partFrame(sc.part || 0), to = partFrame(part || 0); if (!from || !to) return false;
    const dir = from.n.clone().negate().applyAxisAngle(from.v, deg(sc.tiltU)).applyAxisAngle(from.u, deg(sc.tiltV)).normalize();
    const top = from.P.clone().addScaledVector(from.u, sc.u).addScaledVector(from.v, sc.v); let q = top.clone();
    for (let t = 0; t < 60; t += 0.2) { const c = top.clone().addScaledVector(from.n, 20 - t); if (boneAt(c)) { q = c; break; } }
    const d = q.sub(to.P), r = x => Math.round(x * 10) / 10, cl = (x, a) => Math.max(-a, Math.min(a, x));
    sc.u = cl(r(d.dot(to.u)), 80); sc.v = cl(r(d.dot(to.v)), 40);
    sc.tiltU = cl(Math.round(THREE.MathUtils.radToDeg(Math.asin(cl(-dir.dot(to.u), 1)))), 89);
    sc.tiltV = cl(Math.round(THREE.MathUtils.radToDeg(Math.atan2(dir.dot(to.v), -dir.dot(to.n)))), 89);
    if (part) sc.part = part; else delete sc.part;
    unapprove(sc); return true;
  }
  // the frame a screw's (u, v) refers to: its piece's frame in the two-guide layout (sc.part = -1 / 1), else the guide frame
  function screwFrame(sc) {
    if (S.g.split === 2 && sc.part) { const f = pieceFrames(); if (f) return sc.part < 0 ? f.a : f.b; }
    return Object.assign({ P: S.anchor.p }, frameAxes());
  }
  // the drill direction of a screw: down the frame normal, tilted by tiltU about v and tiltV about u
  function screwDir(sc) { const { u, v, n } = screwFrame(sc); return n.clone().negate().applyAxisAngle(v, deg(sc.tiltU)).applyAxisAngle(u, deg(sc.tiltV)).normalize(); }
  function screwWorld(sc) {
    const { P, u, v, n } = screwFrame(sc);
    {
      const dir = n.clone().negate().applyAxisAngle(v, deg(sc.tiltU)).applyAxisAngle(u, deg(sc.tiltV)).normalize();
      // entry = first bone voxel met when walking down -n from above the guide
      const top = P.clone().add(u.clone().multiplyScalar(sc.u)).add(v.clone().multiplyScalar(sc.v)).add(n.clone().multiplyScalar(20));
      let entry = null;
      for (let t = 0; t < 60; t += 0.2) { const q = top.clone().add(n.clone().multiplyScalar(-t)); if (boneAt(q)) { entry = q; break; } }
      return { sc, dir, entry };
    }
  }
  // ---------- the production server's bone, for the preview guide ----------
  // yolmed_server.build_guide builds on the full-resolution mask guideRequest sends (HU >= threshold within the planning
  // bone, or the work field > 0.5 when there is no threshold), closed cavities filled, smoothed with a Gaussian of half a
  // voxel and read trilinearly. The 0.8 mm work field (S.maskF) rounds the crest, teeth and thin plates of a real CT off
  // by 1-2 mm, so a preview on it differed from the printed guide by p99 1.5-2 mm there (D4 verification, B2.7). The
  // preview guide reads this field instead: built for a box of the volume around the guide (buildGuide asks for its
  // grid's box first), kept while the box, the bone and the threshold stay; a point outside the box (or a box too large
  // to hold) reads the work field as before.
  const FINE_MAX = 30e6;
  function fineField(vol, red, F, thr) {
    if (!vol || !vol.hu || !red || !F) return q => fieldAt(red, F, [q.x, q.y, q.z]);
    let C = null;   // { lo: [i, j, k], n: [nx, ny, nz], f: Float32Array }
    const coarse = q => fieldAt(red, F, [q.x, q.y, q.z]);
    function build(lo, hi) {
      const [nx, ny, nz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), N = nx * ny * nz, nxy = nx * ny;
      if (N > FINE_MAX || nx < 2 || ny < 2 || nz < 2) return null;
      const m = new Uint8Array(N), cut = thr == null ? 0.5 : 0.05;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const r = nx * (j + ny * k), src = lo[0] + vol.nx * (lo[1] + j + vol.ny * (lo[2] + k));
        for (let i = 0; i < nx; i++) {
          if (thr != null && vol.hu[src + i] < thr) continue;
          if (fieldAt(red, F, G.worldOf(vol, lo[0] + i, lo[1] + j, lo[2] + k)) > cut) m[r + i] = 1;
        }
      }
      const ext = G.exterior(m, nx, ny, nz);       // (binary_fill_holes: what the outside cannot reach is bone)
      let a = new Float32Array(N), b = new Float32Array(N);
      for (let i = 0; i < N; i++) a[i] = ext[i] ? 0 : 1;
      // scipy gaussian_filter(sigma 0.5 voxel): radius 2, weights e^-8, e^-2, 1, e^-2, e^-8, mirrored edges ('reflect')
      const w2 = Math.exp(-8), w1 = Math.exp(-2), sum = 1 + 2 * w1 + 2 * w2, W = [w2 / sum, w1 / sum, 1 / sum, w1 / sum, w2 / sum];
      const refl = (x, n) => (x < 0 ? -x - 1 : x >= n ? 2 * n - x - 1 : x);
      const pass = (n, stride, outer) => {
        for (const base of outer) for (let x = 0; x < n; x++) {
          let acc = 0; for (let t = -2; t <= 2; t++) acc += W[t + 2] * a[base + stride * refl(x + t, n)];
          b[base + stride * x] = acc;
        }
        [a, b] = [b, a];
      };
      const rows = function* (A, B, sa, sb) { for (let q = 0; q < B; q++) for (let p = 0; p < A; p++) yield p * sa + q * sb; };
      pass(nx, 1, rows(ny, nz, nx, nxy)); pass(ny, nx, rows(nx, nz, 1, nxy)); pass(nz, nxy, rows(nx, ny, 1, nx));
      return { lo, n: [nx, ny, nz], f: a };
    }
    const fn = q => {
      if (!C) return coarse(q);
      const ix = G.indexOf(vol, [q.x, q.y, q.z]), [nx, ny, nz] = C.n;
      const x = ix[0] - C.lo[0], y = ix[1] - C.lo[1], z = ix[2] - C.lo[2];
      if (!(x >= 0 && y >= 0 && z >= 0 && x <= nx - 1 && y <= ny - 1 && z <= nz - 1)) return coarse(q);
      const i = Math.min(nx - 2, Math.floor(x)), j = Math.min(ny - 2, Math.floor(y)), k = Math.min(nz - 2, Math.floor(z)), fx = x - i, fy = y - j, fz = z - k, nxy = nx * ny, b = i + nx * j + nxy * k, f = C.f;
      const c00 = f[b] * (1 - fx) + f[b + 1] * fx, c10 = f[b + nx] * (1 - fx) + f[b + nx + 1] * fx;
      const c01 = f[b + nxy] * (1 - fx) + f[b + nxy + 1] * fx, c11 = f[b + nxy + nx] * (1 - fx) + f[b + nxy + nx + 1] * fx;
      return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
    };
    // make sure the world points `pts` (a guide grid's corners) lie inside the held box, with a margin
    fn.prepare = pts => {
      const ix = pts.map(p => G.indexOf(vol, p)), dims = [vol.nx, vol.ny, vol.nz];
      const want = [0, 1, 2].map(a => [Math.max(0, Math.floor(Math.min(...ix.map(c => c[a]))) - 3), Math.min(dims[a] - 1, Math.ceil(Math.max(...ix.map(c => c[a]))) + 3)]);
      if (C && want.every(([l, h], a) => l >= C.lo[a] && h <= C.lo[a] + C.n[a] - 1)) return;
      const pad = [0, 1, 2].map(a => Math.ceil(6 / vol.sp[a]));
      C = build(want.map(([l], a) => Math.max(0, l - pad[a])), want.map(([, h], a) => Math.min(dims[a] - 1, h + pad[a]))) || C;
    };
    return fn;
  }
  // one per bone and threshold: the mandible's guide field (boneField for the guide); the fibula module asks for its own
  const fineCache = new Map();
  function guideField(vol = S.vol, red = S.red, F = S.maskF, thr = segThr()) {
    const hit = fineCache.get(F);
    if (hit && hit.vol === vol && hit.red === red && hit.thr === thr) return hit.fn;
    if (fineCache.size > 3) fineCache.clear();
    const fn = fineField(vol, red, F, thr); fineCache.set(F, { vol, red, thr, fn }); return fn;
  }
  function boneAt(q) { return boneAtIn(S.red, S.maskF, q); }
  function boneField(q) { return fieldAt(S.red, S.maskF, [q.x, q.y, q.z]); }
  function boneAtIn(r, F, q) { return fieldAt(r, F, [q.x, q.y, q.z]) > 0.5; }
  function fieldAt(r, F, w) {
    const ix = G.indexOf(r, w);
    const i = Math.floor(ix[0]), j = Math.floor(ix[1]), k = Math.floor(ix[2]);
    if (i < 0 || j < 0 || k < 0 || i >= r.nx - 1 || j >= r.ny - 1 || k >= r.nz - 1) return 0;
    const fx = ix[0] - i, fy = ix[1] - j, fz = ix[2] - k, nx = r.nx, nxy = r.nx * r.ny, b = i + nx * j + nxy * k;
    const c00 = F[b] * (1 - fx) + F[b + 1] * fx, c10 = F[b + nx] * (1 - fx) + F[b + nx + 1] * fx;
    const c01 = F[b + nxy] * (1 - fx) + F[b + nxy + 1] * fx, c11 = F[b + nxy + nx] * (1 - fx) + F[b + nxy + nx + 1] * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }

  // ---------- lesion target and automatic proposal (surgeon approves or edits) ----------
  function updateLesionPart() {
    if (!S.anchor) { setPart('lesion', null, null); return; }
    const { u, v, n } = frameAxes(), L = S.lesion, len = Math.max(0.5, L.to - L.from);
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, S.g.W, 16), new THREE.MeshBasicMaterial({ color: COLORS.lesion, transparent: true, opacity: 0.2, depthWrite: false }));
    m.position.copy(S.anchor.p).add(u.clone().multiplyScalar((L.from + L.to) / 2)).add(n.clone().multiplyScalar(-8));
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    setPart('lesion', 'Lezyon (hedef)', m, COLORS.lesion);
  }
  // where a point lies relative to the planned resection: inside the resected region (between the outer cuts, or from
  // the cut to the condyle for a condylar resection) within m mm; E = resEnds()
  function resectedAt(q, E, m = 0) {
    if (!E) return false;
    // the piece itself when it is known (m up to RES_PAD); the slab between the cuts only as a fallback
    const pc = m <= RES_PAD ? resPiece() : null;
    if (pc) return resDist(q, pc) <= m;
    const { A, B } = E;
    if (E.condyle) return q.clone().sub(A.p).dot(A.N) > -m;
    const dir = B.p.clone().sub(A.p).normalize(), NA = A.N.clone(), NB = B.N.clone();
    if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
    return q.clone().sub(A.p).dot(NA) > -m && q.clone().sub(B.p).dot(NB) < m;
  }
  // One screw position judged against the bone: the entry on bone with the sleeve over the guide body, the drill in
  // solid bone from the entry on (a ray that only skims a turned-away surface is not a screw), the drill path in bone
  // for at least SCREW_MIN_DEPTH mm (the whole screw length preferred), at least SCREW_SLOT_GAP mm between the sleeve
  // and every saw slot and no bone of the resected region on the path. Returns null when the position is unusable
  // (the reason counted in `why`), else { score, inBone, slotGap }: more bone scores higher, tilt lower.
  // a saw cut is the osteotomy through the bone at the slot, not the whole infinite plane: on a curved jaw the plane
  // of one cut passes the bone of the other side far from it. Screws keep their distance from a slot plane within
  // SLOT_REACH mm of the slot (in the plane), which covers the bone section the saw goes through (the cut-miss test
  // samples ±W/2 + 6 mm across and 45 mm down)
  const SLOT_REACH = 45, CUT_OFF_MAX = 80, PIECE_GAIN = 20, PIECE_TURN = 70, PIECE_BACK_MAX = 30, CUT_STEEP = 0.83, CUT_ALONG_DEG = 60;
  const SCREW_CREST_TOL = 6, SCREW_SLOT_GAP = 2, SCREW_MIN_DEPTH = 4, SCREW_GAP_MIN = 5, SCREW_GAP_MAX = 15, SCREW_GAP_FAR = 22, SCREW_GAP_BACK = 12, SCREW_CORE_R = 1.5, L_MAX = 160;
  // a screw hole closer than this to the osteotomy plane leaves a thin bone bridge that can break (checks only, a warning)
  const SCREW_CUT_GAP = 5, SCREW_CUT_WARN = 3;   // 5 mm = recommended bone bridge (info below it); a warning only under 3 mm
  // wrap depth at uu from a per-position profile ([[uu, depth], ...]) capped by the global value, as buildGuide's wrapOf
  function wrapAtU(wrap, pr, uu) {
    if (!pr || !pr.length) return wrap;
    if (uu <= pr[0][0]) return Math.min(wrap, pr[0][1]);
    for (let a = 1; a < pr.length; a++) if (uu <= pr[a][0]) { const t = (uu - pr[a - 1][0]) / ((pr[a][0] - pr[a - 1][0]) || 1); return Math.min(wrap, pr[a - 1][1] + t * (pr[a][1] - pr[a - 1][1])); }
    return Math.min(wrap, pr[pr.length - 1][1]);
  }
  // The guide body a screw must stand on, as buildGuide builds it on this frame: the box W wide about the lane vc whose
  // bottom at each position uu lies wrap(uu) below the bone's top there (the highest bone within the box width, never
  // above `cap`, the level of the frame plane the wrap is measured from). The shell follows the bone inside that box,
  // so a screw whose entry lies in the box stands on the body. secs = bone sections along the frame (boneSections over
  // the box width); wrap(uu) = the global depth capped by the per-position profile.
  function screwBody(frame, secs, W, vc, wrap, wrapU, cap = 0) {
    if (!secs || !secs.length) return null;
    const live = secs.filter(s => !s.empty); if (!live.length) return null;
    const near = uu => { let b = live[0]; for (const s of live) if (Math.abs(s.uu - uu) < Math.abs(b.uu - uu)) b = s; return b; };
    return { frame, W, vc, cap, top: uu => { const s = near(uu); return Math.abs(s.uu - uu) > 4 ? -Infinity : Math.min(cap, s.top); }, rawTop: uu => { const s = near(uu); return Math.abs(s.uu - uu) > 4 ? -Infinity : s.top; }, wrap: uu => wrapAtU(wrap, wrapU, uu), cache: new Map() };
  }
  function onBody(body, uu, vv, depth) {
    const key = uu + '|' + vv + '|' + depth.toFixed(1); if (body.cache.has(key)) return body.cache.get(key);
    // the entry lies within the body's depth range: not under the wrap limit, and not above the bone's crest there (a
    // column that meets other bone high above the frame, as on a guide turned round the jaw, is not a surface the sleeve stands on)
    const ok = Math.abs(vv - body.vc) <= body.W / 2 - 0.5 && depth >= body.top(uu) - body.wrap(uu) + 0.3 && (!body.rawTop || depth <= Math.max(body.rawTop(uu), body.top(uu)) + SCREW_CREST_TOL);
    body.cache.set(key, ok);
    return ok;
  }
  // thin: the graded fallback for thin bone (the upper ramus, a narrow chin): the plate is drilled through, so the core
  // ring is only asked to stay in bone while the drill axis does (that run at least SCREW_MIN_DEPTH mm), not over the
  // first 6 mm whatever the bone's thickness. Also returns cutGap: the bone bridge between the hole (radius d/2) and
  // the nearest osteotomy plane over the part of the hole in bone, as buildGuide measures it for the checks.
  // (entry: the screw's entry when the caller already has it; it depends on u, v and the frame only, not on the tilt)
  function evalScrew(sc, pls, body, E, why, thin = false, entry) {
    const s = entry !== undefined ? { sc, dir: screwDir(sc), entry } : screwWorld(sc); if (!s.entry) { if (why) why.noBone++; return null; }
    let below = 0;
    if (body) {
      const depth = s.entry.clone().sub(body.frame.P).dot(body.frame.n);
      if (!onBody(body, sc.u, sc.v, depth)) { if (why) why.noBody++; return null; }
      below = Math.max(0, body.top(sc.u) - depth);
    }
    // solid core: a ring of SCREW_CORE_R about the drill axis stays in bone over the first millimetres past the entry,
    // which a ray running along a surface turned away from the guide does not give
    const q = V(), d = V(), pa = Math.abs(s.dir.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), ea = V().crossVectors(pa, s.dir).normalize(), eb = V().crossVectors(s.dir, ea).normalize();
    let coreTo = Math.min(sc.len, 6);
    if (thin) {
      let run = 0; while (run + 0.25 <= sc.len && boneAt(q.copy(s.entry).addScaledVector(s.dir, run + 0.25))) run += 0.25;
      if (run < SCREW_MIN_DEPTH) { if (why) why.shallow++; return null; }
      coreTo = Math.min(coreTo, run - 0.75);
    }
    let core = 0, coreN = 0;
    for (let t = 1.5; t <= coreTo; t += 0.75) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      q.copy(s.entry).addScaledVector(s.dir, t).addScaledVector(ea, a * SCREW_CORE_R).addScaledVector(eb, b * SCREW_CORE_R); coreN++; if (boneAt(q)) core++;
    }
    if (!coreN || core < 0.85 * coreN) { if (why) why.shallow++; return null; }
    let inBone = 0, slotGap = Infinity, cutGap = Infinity, res = false;
    for (let t = 0; t <= sc.len; t += 0.25) {
      q.copy(s.entry).addScaledVector(s.dir, t);
      const bone = boneAt(q);
      if (bone) { inBone += 0.25; if (!res && resectedAt(q, E, SCREW_SLOT_GAP)) res = true; }
      for (const pw of pls) {
        d.copy(q).sub(pw.pSlot || pw.p); const a = d.dot(pw.N); if (d.lengthSq() - a * a > SLOT_REACH * SLOT_REACH) continue; slotGap = Math.min(slotGap, Math.abs(a) - pw.w / 2 - sc.D / 2);
        if (bone) cutGap = Math.min(cutGap, Math.abs(d.copy(q).sub(pw.p).dot(pw.N)) - sc.d / 2);
      }
    }
    if (res) { if (why) why.resected++; return null; }
    if (slotGap < SCREW_SLOT_GAP) { if (why) why.nearSlot++; return null; }
    if (inBone < SCREW_MIN_DEPTH) { if (why) why.shallow++; return null; }
    inBone = Math.min(inBone, sc.len);
    return { inBone, slotGap, cutGap, score: 10 * inBone - 0.15 * (Math.abs(sc.tiltU) + Math.abs(sc.tiltV)) - 1.0 * below };
  }
  function screwScore(sc, pls, body) { const r = evalScrew(sc, pls, body || null, resEnds(), null); return r ? r.score : -Infinity; }
  // the reason no screw position was found: the furthest stage any candidate reached in evalScrew (a lane off the bone
  // says nothing when another lane had bone but too little of it), and the check line per reason
  function screwWhy(why) { return ['shallow', 'nearSlot', 'resected', 'noBody', 'noBone'].find(k => why[k] > 0) || 'none'; }
  const DROP_MSG = {
    noBone: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (altında kemik yok); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
    shallow: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (kemik derinliği yetersiz); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
    nearSlot: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (kesi yuvasına çok yakın); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
    resected: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (rezeke bölgede); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
    noBody: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (guide gövdesinin altında kalıyor); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
    none: n => `Kesi ${n} ötesinde vida için uygun yer bulunamadı (uygun yer yok); vidayı elle yerleştirin ya da kesiyi taşıyın.`,
  };
  // The best screw past one cut: positions along u (SCREW_GAP_MIN..SCREW_GAP_MAX mm from the slot edge measured across
  // the slot, uAt(vv) = the u of the slot edge on lane vv, side = the kept direction, scale = 1 / cos of the angle
  // between u and the slot normal), across v (every lane of the body within lim of vc, the wanted lane vLane preferred)
  // and tilts (±20°), each judged by evalScrew; a position nearer the cut and the lane wins a tie. Straight screws are
  // tried first; when none fits, tilted ones over the whole grid; when still none, up to SCREW_GAP_FAR mm from the slot.
  // `taken` = screws already there (hand-set or placed before), kept clear by D + 1 mm. Returns the screw or null.
  // Graded: the stages above keep a bone bridge of SCREW_CUT_GAP mm between the hole and the osteotomy (measured on
  // the drill path in bone, as the checks measure it); when no position past the cut has that, one with at least
  // SCREW_CUT_WARN mm (3-4 mm from the slot edge included; the checks add a note), then any the slot clearance allows
  // (the checks warn). On thin bone (the upper ramus, a narrow chin), where no straight or tilted drill keeps the core
  // ring in bone over 6 mm, the plate is drilled through (evalScrew thin) with the same order of bridges.
  // (cut: the slot this screw holds past, when known: on a cut pitched against the frame the slot edge on the bone
  // lies well before or after uAt, which is measured in the frame plane, so positions from SCREW_GAP_BACK mm before it are
  // tried too, every one with its entry on the kept side of the slot)
  function bestScrew(def, uAt, side, scale, vLane, vc, lim, pls, body, E, taken, why, extra = {}, cut = null) {
    const mk = (uu, vv, tu, tv) => Object.assign({ u: uu, v: vv, tiltU: tu, tiltV: tv, ok: false }, def, extra);
    const blocked = S.screwBlocked || [];
    const clear = sc => taken.every(o => (o.part || 0) !== (sc.part || 0) || Math.hypot(o.u - sc.u, o.v - sc.v) >= Math.max(o.D, sc.D) + 1)
      && blocked.every(b => (b.part || 0) !== (sc.part || 0) || Math.hypot(b.u - sc.u, b.v - sc.v) >= sc.D + 1);
    const pen = (dist, vv) => Math.max(0, dist - 7) + 0.3 * Math.abs(vv - vLane);
    const tilts = [[0, 0]], more = [];
    for (let tu = -20; tu <= 20; tu += 10) for (let tv = -20; tv <= 20; tv += 10) if (tu || tv) more.push([tu, tv]);
    // the entry depends on (u, v) only: found once per position (a column that meets no bone skips every tilt)
    const entries = new Map(), entryAt = (uu, vv) => { const k = uu + '|' + vv; if (!entries.has(k)) entries.set(k, screwWorld(mk(uu, vv, 0, 0)).entry); return entries.get(k); };
    const seen = new Map(), kIn = cut && cut.keep, kept = e => !kIn || e.clone().sub(cut.pSlot || cut.p).dot(kIn) >= cut.w / 2 + def.d / 2;
    const grid = (d0, d1, tl, w, thin = false, dstep = 1, vstep = 1) => {
      const out = [];
      for (let dist = d0; dist <= d1; dist += dstep) for (let k = -Math.floor(lim); k <= Math.floor(lim); k += vstep) for (const [tu, tv] of tl) {
        const vv = vc + k, uu = Math.round((uAt(vv) + side * dist * scale) * 2) / 2, sc = mk(uu, vv, tu, tv);
        const key = [uu, vv, tu, tv, thin ? 1 : 0].join('|'); if (seen.has(key)) continue; seen.set(key, 1);
        if (!clear(sc)) continue;
        const e = entryAt(uu, vv); if (e && !kept(e)) continue;
        const r = evalScrew(sc, pls, body, E, w, thin, e); if (r) out.push({ sc, r, score: r.score - pen(Math.abs(dist), vv), dist, thin });
      }
      return out;
    };
    // the best candidate whose bridge is at least gMin
    const pick = (cands, gMin) => cands.filter(c => c.r.cutGap >= gMin).sort((a, b) => b.score - a.score);
    // (every stage counts towards the reason reported when nothing fits: the furthest any candidate got)
    let all = grid(SCREW_GAP_MIN, SCREW_GAP_MAX, tilts, why), gMin = SCREW_CUT_GAP, first = pick(all, gMin);
    if (!first.length) { all = all.concat(grid(SCREW_GAP_MIN, SCREW_GAP_MAX, more, why)); first = pick(all, gMin); }
    if (!first.length) { all = all.concat(grid(SCREW_GAP_MAX + 1, SCREW_GAP_FAR, tilts.concat(more), why)); first = pick(all, gMin); }
    // a pitched cut: the bone past it may start before the slot edge in the frame plane
    if (!first.length && kIn) { all = all.concat(grid(-SCREW_GAP_BACK, SCREW_GAP_MIN - 1, tilts.concat(more), why)); first = pick(all, gMin); }
    // a narrower bone bridge: 3-5 mm (the checks note it), then whatever clears the slot (the checks warn)
    if (!first.length) { if (!kIn) all = all.concat(grid(SCREW_CUT_WARN, SCREW_GAP_MIN - 1, tilts.concat(more), why)); gMin = SCREW_CUT_WARN; first = pick(all, gMin); }
    if (!first.length) { gMin = -Infinity; first = pick(all, gMin); }
    // thin bone, drilled through
    if (!first.length) {
      const th = grid(kIn ? -SCREW_GAP_BACK : SCREW_CUT_WARN, SCREW_GAP_FAR, tilts.concat(more), why, true, 1, 2);
      for (const g of [SCREW_CUT_GAP, SCREW_CUT_WARN, -Infinity]) { first = pick(th, g); if (first.length) { gMin = g; break; } }
    }
    let best = first[0] || null;
    // fine tilt around the best few (same bridge and bone test as the stage that found them)
    for (const c of first.slice(0, 5)) for (let tu = -20; tu <= 20; tu += 5) for (let tv = -20; tv <= 20; tv += 5) {
      if (tu === c.sc.tiltU && tv === c.sc.tiltV) continue;
      const sc = mk(c.sc.u, c.sc.v, tu, tv), r = evalScrew(sc, pls, body, E, null, c.thin, entryAt(c.sc.u, c.sc.v));
      if (r && r.cutGap >= gMin && r.score - pen(Math.abs(c.dist), sc.v) > best.score) best = { sc, score: r.score - pen(Math.abs(c.dist), sc.v), dist: c.dist };
    }
    return best ? best.sc : null;
  }
  // automatic body: width and lateral centre from the bone's extent under the guide, wrap depth per position from the
  // bone's widest level (sizeBody); hand-set values (S.gAuto false) are left alone. Returns the sizing (secs for the checks).
  // (keepWrap: the fit ladder owns the global wrap depth; only the per-position profile is refreshed)
  function autoBody(uA, uB, keepWrap = false) {
    if (!S.anchor || !S.maskF) return null;
    const auto = S.gAuto, fr = Object.assign({ P: S.anchor.p }, frameAxes());
    if (!auto.W && !auto.wrap) { S.g.wrapU = null; return null; }
    const sz = sizeBody(fr, boneField, uA, uB, S.g, { W: !!auto.W, wrap: !!auto.wrap });
    if (!sz.ok) return sz;
    if (auto.W) { S.g.W = sz.W; S.g.vc = sz.vc; }
    if (auto.wrap) { S.g.wrapU = sz.wrapU; if (!keepWrap) S.g.wrap = Math.max(2, Math.min(20, sz.wrap)); } else S.g.wrapU = null;
    S.autoSize = { W: sz.W, vc: sz.vc, wrap: sz.wrap, depth: Math.min(...sz.secs.map(s => s.depth)), height: Math.max(...sz.secs.map(s => s.vHi - s.vLo)), n: sz.secs.length };
    return sz;
  }
  // The jaw's basal line from the anchor along dir (±u): in cross-sections across the line (the bone within TRACK_R mm
  // in a 2 mm slab, TRACK_SIDE mm to either side), the centroid of the lowest TRACK_BAND mm of bone (the basal bone
  // above the lower border: teeth, an opposing jaw, the skull base in the same mask or the other half of a narrow chin
  // do not pull it), stepped 2 mm at a time, the direction following
  // the centroids. Returns the point at arc length s from the section through the anchor and the bone's direction
  // there, or null when the bone ends first. up = patient superior as the guide frame sees it.
  const TRACK_R = 22, TRACK_BAND = 14, TRACK_AHEAD = 6, TRACK_SIDE = 10;
  function boneTrack(dir, s, trace = null) {
    if (!S.mask || !S.red || !S.anchor) return null;
    const { v } = frameAxes(), up = Math.abs(v.z) > 0.3 ? v.clone().multiplyScalar(Math.sign(v.z)) : V(0, 0, 1);
    const r = S.red, q = V(), pts = [], sec = (c, t) => {
      const ci = G.indexOf(r, [c.x, c.y, c.z]), rad = r.sp.map(sp => Math.ceil(TRACK_R / sp));
      pts.length = 0; let lo = Infinity; const side = V().crossVectors(t, up); if (side.lengthSq() > 1e-6) side.normalize();
      for (let k = Math.max(0, Math.floor(ci[2] - rad[2])); k <= Math.min(r.nz - 1, Math.ceil(ci[2] + rad[2])); k++)
        for (let j = Math.max(0, Math.floor(ci[1] - rad[1])); j <= Math.min(r.ny - 1, Math.ceil(ci[1] + rad[1])); j++)
          for (let i = Math.max(0, Math.floor(ci[0] - rad[0])); i <= Math.min(r.nx - 1, Math.ceil(ci[0] + rad[0])); i++) {
            if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
            q.set(...G.worldOf(r, i, j, k)).sub(c); const a = q.dot(t);
            if (Math.abs(a) > 1 || q.lengthSq() - a * a > TRACK_R * TRACK_R || Math.abs(q.dot(side)) > TRACK_SIDE) continue;
            const h = q.dot(up); pts.push(q.x, q.y, q.z, h); if (h < lo) lo = h;
          }
      let n = 0; const m = V();
      for (let a = 0; a < pts.length; a += 4) if (pts[a + 3] <= lo + TRACK_BAND) { n++; m.x += pts[a]; m.y += pts[a + 1]; m.z += pts[a + 2]; }
      return n ? { c: m.multiplyScalar(1 / n).add(c), n } : { c, n: 0 };
    };
    let t = dir.clone().normalize(), cur = sec(S.anchor.p, t);
    if (trace) trace.push(['start', cur.n]);
    if (cur.n < 20) return null;
    // the path runs TRACK_AHEAD mm past s where the bone allows; the direction at s is the chord over ±TRACK_AHEAD mm
    // (a single 2 mm step follows every bump of the lower border)
    const n0 = cur.n, path = [[0, cur.c]]; let c = cur.c, done = 0;
    for (let it = 0; it < 90 && done < s + TRACK_AHEAD; it++) {
      const nx = sec(c.clone().addScaledVector(t, 2), t);
      if (trace) trace.push([+done.toFixed(1), nx.n, nx.c.toArray().map(x => +x.toFixed(1)), t.toArray().map(x => +x.toFixed(2))]);
      if (nx.n < Math.max(20, 0.15 * n0)) break;
      // a section suddenly much fuller than the last one has run into another structure (the genial tubercles, the
      // other half of the chin, a tooth row): the track stops there rather than follow it
      if (nx.n > 2.2 * Math.max(cur.n, 0.5 * n0)) break;
      cur = nx;
      const step = nx.c.clone().sub(c), len = step.length(); if (len < 0.5) break;
      done += len; c = nx.c; t = t.clone().add(step.multiplyScalar(1 / len)).normalize(); path.push([done, c]);
    }
    if (done < s) return null;
    const at = x => { for (let k = 1; k < path.length; k++) if (path[k][0] >= x) { const [s0, c0] = path[k - 1], [s1, c1] = path[k]; return c0.clone().lerp(c1, (x - s0) / ((s1 - s0) || 1)); } return path[path.length - 1][1].clone(); };
    const cS = at(s), tS = at(Math.min(done, s + TRACK_AHEAD)).sub(at(Math.max(0, s - TRACK_AHEAD)));
    return tS.lengthSq() > 1e-6 ? { c: cS, t: tS.normalize() } : null;
  }
  // a cut `off` mm from the anchor along the guide axis, proposed perpendicular to the bone where it crosses it: on a
  // curved jaw (chin, a short body, the angle) the bone `off` mm along the arch has turned away from the guide axis
  // and a cut square to the axis would run along the bone (no stump face, no bone for the screws past it). The cut
  // goes through the bone's centre line at that arc length, turned with the bone (up to CUT_TURN_MAX degrees; a turn
  // under CUT_TURN_MIN degrees keeps the straight cut), and keeps its reference point on the bone (pv, pn).
  const CUT_TURN_MIN = 12, CUT_TURN_MAX = 70, CUT_TURN_SPAN = 42;
  function cutAlongBone(off) {
    const pl = { off, yaw: 0, pitch: 0, w: 1.2, ok: false };
    if (Math.abs(off) < 8 || !S.anchor) return pl;
    const { u, v, n } = frameAxes(), tr = boneTrack(u.clone().multiplyScalar(Math.sign(off)), Math.abs(off));
    if (!tr) return pl;
    let N = tr.t.clone(); if (N.dot(u) < 0) N.negate();
    const ang = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, N.dot(u))));
    if (ang < CUT_TURN_MIN) return pl;
    // turned with the bone as far as the plane can still be written on the guide axis: it must cross the axis on the
    // cut's side of the anchor within CUT_OFF_MAX (a smaller turn is tried, 10° at a time, when the full one cannot)
    const d = tr.c.clone().sub(S.anchor.p), perp = N.clone().addScaledVector(u, -N.dot(u)).normalize();
    let o2 = NaN;
    for (let a = Math.min(ang, CUT_TURN_MAX); a >= CUT_TURN_MIN; a -= 10) {
      N = u.clone().multiplyScalar(Math.cos(deg(a))).addScaledVector(perp, Math.sin(deg(a)));
      o2 = N.dot(d) / N.dot(u);
      if (Math.abs(o2) <= CUT_OFF_MAX && Math.sign(o2) === Math.sign(off) && Math.abs(o2) >= 4) break;
      o2 = NaN;
    }
    if (!Number.isFinite(o2)) return pl;
    return Object.assign(pl, { off: Math.round(o2 * 10) / 10, yaw: +THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))).toFixed(1), pitch: +THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n))))).toFixed(1), pv: +d.dot(v).toFixed(1), pn: +d.dot(n).toFixed(1) });
  }
  function suggest() {
    if (!S.anchor) return;
    const L = S.lesion, a = Math.min(L.from, L.to) - L.margin, b = Math.max(L.from, L.to) + L.margin;
    // a short resection keeps straight cuts: the bone barely turns between them, and two cuts turned towards each other
    // would shorten the defect below the planned length (and the fibula segment below its 20 mm minimum)
    S.planes = b - a >= CUT_TURN_SPAN ? [cutAlongBone(a), cutAlongBone(b)] : [];
    const straight = [{ off: a, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: b, yaw: 0, pitch: 0, w: 1.2, ok: false }];
    if (!S.planes.length || S.planes[0].off >= S.planes[1].off) S.planes = straight;
    // a cut turned with the bone near the angle can swing up past the sigmoid notch and leave a condyle in the
    // resected piece of a segment resection: that cut stays square to the guide axis (the turn is only a proposal)
    const ref = !L.condyle && window.Ref && Ref.get && Ref.get(), conds = ref && ref.cond ? ['R', 'L'].map(k => ref.cond[k]).filter(Boolean).map(p => V(...p)) : [];
    const takesCondyle = () => conds.some(q => resectedNear(q, 4));
    if (conds.length && takesCondyle()) {
      const turned = S.planes.slice();
      for (const k of [0, 1]) if (turned[k].pv !== undefined) { S.planes = turned.map((p, i) => i === k ? straight[i] : p); if (!takesCondyle()) break; S.planes = turned; }
      if (takesCondyle()) S.planes = straight;
    }
    if (S.guideOn) placeScrews(); else S.screws = [];
    unapprove(S.lesion); S.sel = null;
    updateLesionPart(); schedule(true);
  }
  // Screws outside the two outer cuts (one or two per side, 'Vida / taraf'), each where the drill reaches the most bone
  // (bestScrew: along the axis 5-15 mm past the slot, across the body, tilted up to 20°, then the graded fallbacks:
  // further out, before the frame-plane slot edge on a pitched cut, a 3-5 mm bone bridge, thin bone), never on the resected side,
  // never within 2 mm of a slot. A side with no usable position gets no screw and a critical check says why
  // (S.screwDrops). Screws the surgeon placed or moved (sc.hand) are kept and the automatic ones fill up around them.
  // The guide is made long enough to hold the screws and the slots (up to L_MAX, from the plan, no fixed 100 mm).
  // The body the screws stand on, on any frame: buildGuide's box (W about vc, wrap(uu) below the bone's top per
  // position, never above `cap`), from bone sections over the box width along the span the screws may use.
  function screwBodyOn(frame, uA, uB, W, vc, wrap, wrapU, cap = 0) {
    const us = []; for (let x = uA; x <= uB + 1e-6; x += 3) us.push(x);
    return screwBody(frame, boneSections(frame.P, frame.u, frame.v, frame.n, boneField, us, { vHalf: W / 2, vc }), W, vc, wrap, wrapU, cap);
  }
  // (opts.keepWrap: the fit ladder sets the global wrap depth itself; the screws are placed for that depth)
  // Each side left without a screw is kept in S.screwDrops ({ pl: its cut, side, part: on a piece frame, want: screws
  // that end should hold }); the check follows the screws there now (liveDrops), so a screw set there by hand, an undo
  // or a deleted cut clears it (W7). Returns the number of hand-set screws written into another frame (layout change).
  function placeScrews(opts = {}) {
    const def = screwDef(), per = +($('perSide') ? $('perSide').value : 1) || 1;
    const { u, v, n } = frameAxes(), pls0 = planesWorld().sort((x, y) => x.off - y.off);
    S.screwDrops = [];
    // spots the fit ladder found no body under belong to that ladder's rungs (W23)
    if (!opts.keepWrap) S.screwBlocked = [];
    if (pls0.length < 1) { S.screws = []; return 0; }
    const hand = S.screws.filter(sc => sc && sc.hand);
    let moved = 0;
    // body width, lateral centre and wrap depth from the bone over the span the screws may need
    const span = [pls0[0].off - SCREW_GAP_MAX - pls0[0].w - def.D, pls0[pls0.length - 1].off + SCREW_GAP_MAX + pls0[pls0.length - 1].w + def.D];
    autoBody(Math.min(span[0], -8), Math.max(span[1], 8), !!opts.keepWrap);
    const pls = planesWorld().sort((x, y) => x.off - y.off), vc = S.g.vc || 0, E = resEnds();
    // two guides on their own frames (angle region, curved jaw): each piece's screws lie along its own bone axis past its cut
    // the screws the surgeon placed stay through a change of layout (W13): written into the frame of the piece they hold
    // (two guides) or into the guide frame (one guide)
    if (S.g.split === 2 && pls.length >= 2 && pieceFrames()) {
      const mid = (pls[0].off + pls[pls.length - 1].off) / 2;
      hand.forEach(sc => { if (!sc.part && reframe(sc, Math.sign(sc.u - mid) || 1)) moved++; });
      const sp = splitScrews(pls, per, def, E, hand.filter(sc => sc.part)); if (sp) { S.screws = sp; setLength(pls); return moved; }
    }
    hand.forEach(sc => { if (!sc.part) return; if (reframe(sc, 0)) moved++; else { delete sc.part; unapprove(sc); moved++; } });
    // the ends to hold: both outer cuts, or (one cut) both sides of it; a condylar resection keeps bone on one side only,
    // and so does a cut whose kept side meets no bone (bonelessCut: every screw past the other cut)
    let ends = pls.length > 1 ? [[pls[0], -1], [pls[pls.length - 1], 1]] : [[pls[0], -1], [pls[0], 1]];
    if (E && E.condyle) { const A = pls.find(p => p.pl === E.A.pl) || pls[0]; ends = [[A, Math.sign(-E.A.N.dot(u)) || -1]]; }
    const bc = bonelessCut(); if (bc != null && pls.length > 1) ends = ends.filter(([pw]) => pw.pl !== S.planes[bc]);
    const perEnd = (E && E.condyle) || (bc != null && pls.length > 1) ? Math.max(per, 2) : per;
    const sv = perEnd === 2 ? Math.max(2, Math.min(5, S.g.W / 2 - def.D / 2 - 1.5)) : 0, lanes = perEnd === 2 ? [vc - sv, vc + sv] : [vc];
    const lim = Math.max(0, S.g.W / 2 - def.D / 2 - 0.5);
    // the body the screws stand on: the box buildGuide builds on this frame
    const body = screwBodyOn(Object.assign({ P: S.anchor.p }, frameAxes()), Math.min(span[0], -8) - 7, Math.max(span[1], 8) + 7, S.g.W, vc, S.g.wrap, S.g.wrapU, 0);
    const out = hand.filter(sc => !sc.part);
    for (const [pw, side] of ends) {
      // the u of the slot edge on lane vv (slot centre shifted by kerfSide, tilted cuts cross each lane elsewhere)
      const cu = Math.max(0.2, Math.abs(pw.N.dot(u))), scale = 1 / cu;
      const uAt = vv => pw.off + (pw.shift || 0) * Math.sign(pw.N.dot(u) || 1) - vv * pw.N.dot(v) / Math.max(0.2, pw.N.dot(u)) + side * pw.w / 2 * scale;
      const have = out.filter(sc => Math.sign(sc.u - uAt(sc.v)) === side).length;
      for (let k = have; k < perEnd; k++) {
        const why = { noBone: 0, noBody: 0, resected: 0, nearSlot: 0, shallow: 0 };
        const best = bestScrew(def, uAt, side, scale, lanes[k % lanes.length], vc, lim, pls, body, E, out, why, {}, { p: pw.p, pSlot: pw.pSlot, w: pw.w, keep: pw.N.clone().multiplyScalar(Math.sign(pw.N.dot(u) * side) || side) });
        if (best) out.push(best); else S.screwDrops.push({ pl: pw.pl, cut: Math.max(0, S.planes.indexOf(pw.pl)), side, want: perEnd, why: screwWhy(why) });
      }
    }
    S.screws = out;
    setLength(pls);
    return moved;
  }
  // the drops still open: the cut is still there and its end holds fewer screws than the placement wanted
  function liveDrops() {
    const pls = planesWorld();
    return (S.screwDrops || []).filter(d => {
      const pw = d.pl && pls.find(x => x.pl === d.pl); if (!pw) return false;
      d.cut = S.planes.indexOf(d.pl);
      return S.screws.filter(sc => sc && (d.part ? sc.part === d.side : !sc.part && Math.sign(sc.u - pw.off) === d.side)).length < (d.want || 1);
    });
  }
  // the screw defaults with the drill chosen in step 6 (gScrewD); the sleeve keeps the default's wall around the drill
  function screwDef() {
    const b = SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom, d = S.drillD;
    return d ? Object.assign({}, b, { d, D: Math.max(Math.round((d + 2) * 10) / 10, Math.round((b.D - b.d + d) * 10) / 10) }) : b;
  }
  // guide length from what it has to hold: every screw sleeve and every slot plus the flange, never above L_MAX
  function setLength(pls) {
    if (S.gAuto.L) {
      const forScrews = 2 * Math.max(0, ...S.screws.filter(sc => !sc.part).map(sc => Math.abs(sc.u) + sc.D / 2 + 1));
      const forCuts = 2 * Math.max(0, ...pls.map(p => Math.abs(p.off) + p.w / 2 + S.g.flange));
      S.g.L = Math.min(L_MAX, Math.max(16, Math.ceil(Math.max(forScrews, forCuts))));
    }
    syncGuideInputs();
  }
  // screws for the two-guide layout: on each piece's own frame (cutFrame), past the stump face along the piece's bone
  // axis (up the ramus for a cut at the angle), one or two across; stored in the guide frame as every screw is. The
  // slot crosses the piece frame obliquely, so its edge is found per lane and the distance is measured across the slot.
  // The body of one piece of the two-guide layout, sized as buildGuideSet sizes the piece: its anchor on the bone near
  // the middle of the span it will have (the capture flange behind the slot, the screws up to SCREW_GAP_FAR past it),
  // width and lateral centre from the bone over that span, wrap from the piece's own profile within the global depth.
  function pieceBody(cut, fr, def) {
    const half = cut.w / 2 + Math.abs(cut.shift || 0), back = half + S.g.flange, reach = SCREW_GAP_FAR + def.D / 2 + 2;
    let Pq = null; { const Pc = fr.P.clone().addScaledVector(fr.u, (reach - back) / 2), top = Pc.clone().addScaledVector(fr.n, 20); for (let t = 0; t < 70; t += 0.25) { const c = top.clone().addScaledVector(fr.n, -t); if (boneAt(c)) { Pq = c; break; } } }
    const cap = Pq ? Pq.clone().sub(fr.P).dot(fr.n) : 0, auto = S.gAuto;
    const sz = sizeBody(fr, boneField, -back, reach, S.g, { W: !!auto.W, wrap: !!auto.wrap });
    const W = sz.W, vc = sz.vc || 0, wrapU = auto.wrap ? sz.wrapU : null;
    return { W, vc, wrap: Math.min(S.g.wrap, sz.wrap), body: screwBodyOn(fr, -back, reach, W, vc, S.g.wrap, wrapU, cap) };
  }
  // the deepest wrap the pieces' own bone allows (the fit ladder starts the two-guide layout from it)
  function pieceWrapTop() {
    const f = pieceFrames(); if (!f) return 0;
    const def = screwDef();
    return Math.min(20, Math.max(...[[f.A, f.a], [f.B, f.b]].map(([cut, fr]) => sizeBody(fr, boneField, -(cut.w / 2 + S.g.flange), SCREW_GAP_FAR + def.D / 2 + 2, S.g, { W: true, wrap: true }).wrap)));
  }
  function splitScrews(pls, per, def, E, hand) {
    const f = pieceFrames(); if (!f) return null;
    const out = hand.slice();
    for (const [cut, fr, part] of [[f.A, f.a, -1], [f.B, f.b, 1]]) {
      if (E && E.condyle && cut.pl !== E.A.pl) continue;             // the piece on the resected side holds no screw
      const c = fr.u.dot(cut.N), cu = Math.max(0.2, Math.abs(c)), scale = 1 / cu, d0 = (cut.pSlot || cut.p).clone().sub(fr.P).dot(cut.N), vN = fr.v.dot(cut.N);
      const uAt = vv => (d0 - vv * vN) / (c || 0.2) + cut.w / 2 * scale;
      // the piece's own body and lanes: across its whole width, one lane or two about its lateral centre preferred
      const pb = pieceBody(cut, fr, def), lim = Math.max(0, pb.W / 2 - def.D / 2 - 0.5);
      const sv = per === 2 ? Math.max(2, Math.min(5, pb.W / 2 - def.D / 2 - 1.5)) : 0, lanes = per === 2 ? [pb.vc - sv, pb.vc + sv] : [pb.vc];
      const have = out.filter(sc => sc.part === part).length;
      for (let k = have; k < per; k++) {
        const why = { noBone: 0, noBody: 0, resected: 0, nearSlot: 0, shallow: 0 };
        const best = bestScrew(def, uAt, 1, scale, lanes[k % lanes.length], pb.vc, lim, pls, pb.body, E, out, why, { part }, { p: cut.p, pSlot: cut.pSlot, w: cut.w, keep: cut.N.clone().multiplyScalar(Math.sign(c) || 1) });
        if (best) out.push(best); else S.screwDrops.push({ pl: cut.pl, cut: Math.max(0, S.planes.indexOf(cut.pl)), side: part, part: true, want: per, why: screwWhy(why) });
      }
    }
    return out;
  }
  // a painted lesion (world points) -> lesion extent, and cuts that clear it by the safety margin at the angle that
  // removes the least bone (up to 30°, small penalty per degree so a straight cut wins a near tie)
  function planFromLesion(pts) {
    if (!S.anchor || !pts.length) return null;
    // the safety margin is measured to the stump face: with the kerf on the resected side that face is the plane itself,
    // with a centred slot it lies w/2 behind the plane
    const { u, v, n } = frameAxes(), A0 = S.anchor.p, L = S.lesion, w = 1.2, clear = L.margin + (S.g.kerfSide ? 0 : w / 2);
    const rel = pts.map(q => q.clone().sub(A0)), offs = rel.map(q => q.dot(u));
    const lo = Math.min(...offs), hi = Math.max(...offs), mid = (lo + hi) / 2;
    L.from = Math.round(lo * 2) / 2; L.to = Math.round(hi * 2) / 2;
    // bone near the lesion, every other voxel (enough to compare candidate cuts)
    const r = S.red, c = A0.clone().add(u.clone().multiplyScalar(mid)), R = (hi - lo) / 2 + L.margin + 40, bone = [];
    const ci = G.indexOf(r, [c.x, c.y, c.z]), rad = r.sp.map(sp => Math.ceil(R / sp));
    for (let k = Math.max(0, Math.round(ci[2] - rad[2])); k <= Math.min(r.nz - 1, ci[2] + rad[2]); k += 2)
      for (let j = Math.max(0, Math.round(ci[1] - rad[1])); j <= Math.min(r.ny - 1, ci[1] + rad[1]); j += 2)
        for (let i = Math.max(0, Math.round(ci[0] - rad[0])); i <= Math.min(r.nx - 1, ci[0] + rad[0]); i += 2) {
          if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
          const q = V(...G.worldOf(r, i, j, k)); if (q.distanceTo(c) <= R) bone.push(q.sub(A0));
        }
    const normal = (yaw, pitch) => { const N = u.clone().applyAxisAngle(n, deg(yaw)); return N.applyAxisAngle(V().crossVectors(n, N).normalize(), deg(pitch)).normalize(); };
    // candidates for one side, cheapest first. Tilting has to pay for itself: 0.6 % of the bone per degree plus
    // a fixed amount, so a small lesion keeps straight cuts and a cut tilts only where it saves real bone
    function cands(side) {
      const out = [];
      for (let yaw = -30; yaw <= 30; yaw += 5) for (let pitch = -30; pitch <= 30; pitch += 5) {
        const N = normal(yaw, pitch), un = N.dot(u);
        let off = side < 0 ? Infinity : -Infinity;
        for (const q of rel) { const x = side < 0 ? (q.dot(N) - clear) / un : (q.dot(N) + clear) / un; off = side < 0 ? Math.min(off, x) : Math.max(off, x); }
        const d0 = off * un; let cnt = 0;
        for (const b of bone) { const s = b.dot(N) - d0, along = b.dot(u); if (side < 0 ? s > 0 && along < mid : s < 0 && along > mid) cnt++; }
        const ang = Math.abs(yaw) + Math.abs(pitch);
        out.push({ pl: { off: Math.round(off * 10) / 10, yaw, pitch, w, ok: false }, N, d0, cost: cnt * (1 + 0.006 * ang) + 3 * ang });
      }
      return out.sort((a, b) => a.cost - b.cost);
    }
    // two cuts must not cross inside the bone: no bone point may lie on the kept side of both
    const crosses = (a, b) => { let k = 0; for (const q of bone) if (q.dot(a.N) - a.d0 < -0.5 && q.dot(b.N) - b.d0 > 0.5 && ++k > 2) return true; return false; };
    const AA = cands(-1), BB = cands(1), A = AA.slice(0, 8), B = BB.slice(0, 8);
    let pair = null;
    for (const a of A) { for (const b of B) if (!pair || a.cost + b.cost < pair[0].cost + pair[1].cost) { if (!crosses(a, b)) pair = [a, b]; } }
    if (!pair) pair = [AA.find(c => !c.pl.yaw && !c.pl.pitch), BB.find(c => !c.pl.yaw && !c.pl.pitch)];
    S.planes = pair.map(c => c.pl);
    if (S.guideOn) placeScrews(); else S.screws = [];
    unapprove(S.lesion); S.sel = null;
    syncLesion(); updateLesionPart(); schedule(true);
    return S.planes;
  }
  // after an automatic plan: if the guide cannot be put on (or splits), try a shallower wrap, 1 mm at a time
  // Fallback ladder: (1) shallower wrap, 1 mm at a time; (2) two guides: on their own frames when the cuts straddle the
  // angle of the jaw (local bone axes more than 20° apart), else one frame with a gap; (3) a shorter capture flange
  // on the two guides. Values set by hand (S.gAuto false) are not touched. Every step is recorded in S.fitLog for the
  // checks. The "ok" criterion is the expected piece count, at least one free insertion direction and the screws: the
  // automatic screws are placed again for every rung (the body they stand on is as deep as that rung's wrap), and a
  // rung whose guide drops a screw, holds one on a sleeve off the body or out of bone, or is held at one end only is
  // not ok, so a straight guide that cannot hold screws on a curved jaw goes on to the two-guide layouts.
  // A1: when two guides joined by a bar are proposed instead of one straight guide (lesion length, the straight axis
  // leaving the bone, a segment of the ramus with the condyle kept); null when one guide is the first choice
  const LONG_MM = 55, AXIS_DROP = 20;
  function longCase() {
    const L = S.lesion, len = Math.abs(L.to - L.from), E = resEnds();
    if (!S.anchor || S.planes.length < 2 || (E && E.condyle)) return null;
    if (len >= LONG_MM) return { len, why: 'len' };
    if (ramusAxis()) return { len, why: 'ramus' };
    const off = axisOffBone(); return off ? { len, why: 'axis', at: off.off } : null;
  }
  // the guide axis runs up the ramus (more vertical than not)
  function ramusAxis() { return !!S.anchor && Math.abs(frameAxes().u.z) > 0.6; }
  // the straight guide axis between the outer cuts: the first position where no bone lies within AXIS_DROP mm below the
  // guide plane across the body width (a single straight guide cannot follow the bone there), or null
  function axisOffBone() {
    if (!S.anchor || S.planes.length < 2) return null;
    const pl = planesWorld().sort((a, b) => a.off - b.off), { u, v, n } = frameAxes(), W = S.g.W || 22, vc = S.g.vc || 0, q = V();
    for (let uu = pl[0].off; uu <= pl[pl.length - 1].off + 1e-6; uu += 2) {
      let hit = false;
      for (let vv = vc - W / 2; vv <= vc + W / 2 + 1e-6 && !hit; vv += 2) for (let t = -10; t <= AXIS_DROP; t += 1) { q.copy(S.anchor.p).addScaledVector(u, uu).addScaledVector(v, vv).addScaledVector(n, -t); if (boneAt(q)) { hit = true; break; } }
      if (!hit) return { off: uu };
    }
    return null;
  }
  const FIT_BUDGET_MS = 45000;
  // the last guide fitWrap confirmed at the final resolution, with the inputs it was built from: regenerate() takes it
  // instead of building the same guide a second time when nothing changed in between
  let fitBuilt = null;
  const fitKey = () => JSON.stringify([S.g, S.anchor && [S.anchor.p, S.anchor.n, S.anchor.axis].map(q => q.toArray()), S.planes.map(p => [p.off, p.yaw, p.pitch, p.w, p.pv || 0, p.pn || 0]),
    S.screws.map(c => [c.u, c.v, c.tiltU, c.tiltV, c.d, c.D, c.sleeveH, c.len, c.part || 0])]);
  // (the screws by identity too: the built result points at the screw objects it was made with)
  function keepFit(o) { if (fitBuilt) disposeObj(fitBuilt.out.mesh); fitBuilt = { key: fitKey(), field: guideField(), scs: S.screws.slice(), out: o }; }
  function takeFit() {
    const f = fitBuilt; fitBuilt = null; if (!f) return null;
    if (f.key === fitKey() && f.field === guideField() && f.scs.length === S.screws.length && f.scs.every((c, i) => c === S.screws[i])) return f.out;
    disposeObj(f.out.mesh); return null;
  }
  async function fitWrap() {
    if (!S.anchor) return null;
    const auto = S.gAuto, w0 = S.g.wrap, f0 = S.g.flange, s0 = S.g.split, log = [], t0 = performance.now();
    // the rung that came closest when none fits (kept at the end): the right piece count first, then a free seating
    // direction, then the fewest failed screws; `onlyScrews` marks a rung whose body sits but whose screws fail,
    // `noBoneDrop` one whose automatic placement found no bone at all past a cut (no wrap depth mends that),
    // `rejected` the automatic screws the built guide found no body under (their spots are kept clear on a retry)
    let best = null, onlyScrews = false, noBoneDrop = false, rejected = [];
    S.screwBlocked = [];
    const over = () => performance.now() - t0 > FIT_BUDGET_MS;
    const place = () => { if (S.guideOn) placeScrews({ keepWrap: true }); };
    // failed screws of a rung: dropped positions, sleeves off the body or out of bone, and a guide held at one end
    // only (one guide across two real cuts) or a piece without a screw (two guides)
    const screwsBad = R => {
      const bad = R.screwInfo.filter(si => !si.ok).length + (S.screwDrops || []).length, E = resEnds();
      const real2 = S.planes.length >= 2 && !(E && E.condyle) && bonelessCut() == null;
      let held = true;
      if (real2 && S.g.split === 2) { const c = [0, 0]; R.screwInfo.forEach(si => { if (si.ok && si.s.sc.part) c[si.s.sc.part < 0 ? 0 : 1]++; }); held = c[0] > 0 && c[1] > 0; }
      else if (real2) { const pl = planesWorld().sort((x, y) => x.off - y.off), mid = (pl[0].off + pl[pl.length - 1].off) / 2, sides = new Set(R.screwInfo.filter(si => si.ok).map(si => Math.sign(si.s.sc.u - mid))); held = sides.has(-1) && sides.has(1); }
      return bad + (held ? 0 : 1);
    };
    const test = async (h = 0.8) => {
      const o = await buildGuideSet(Object.assign({ g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), bone: boneAt, field: guideField(), h, noBarMesh: true }, frameAxes())); const R = o.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1;
      const bad = screwsBad(R), scOk = !bad, piecesOk = R.pieces === want, seatFree = !R.seat || !R.seat.ok || R.seat.free > 0;
      if (!scOk) log.push({ step: 'screws', split: S.g.split, wrap: S.g.wrap, flange: S.g.flange, ok: false, screws: bad });
      const score = (piecesOk ? 1000 : 0) + (seatFree ? 100 : 0) - bad - (h > 0.5 ? 0.5 : 0);
      if (!best || score > best.score) best = { score, wrap: S.g.wrap, split: S.g.split, flange: S.g.flange, pieces: R.pieces, want, free: R.seat && R.seat.ok ? R.seat.free : null, screws: bad };
      onlyScrews = piecesOk && seatFree && !scOk;
      noBoneDrop = (S.screwDrops || []).some(d => d.why === 'noBone');
      rejected = R.screwInfo.filter(si => !si.ok && si.noBody && si.s.sc && !si.s.sc.hand).map(si => ({ part: si.s.sc.part || 0, u: si.s.sc.u, v: si.s.sc.v }));
      const pass = piecesOk && (h > 0.5 || seatFree) && scOk;
      // a rung that passes at the final resolution is the guide the rebuild after the fit would make again: kept for it
      if (pass && h <= 0.4) keepFit(o); else disposeObj(o.mesh);
      return pass;
    };
    // coarse grid first, then confirm at the resolution of the final guide
    const okAt = async () => (await test()) && (await test(0.4));
    // start from the usual depth (an earlier plan may have lowered it), never below 2 mm (the bridge needs it)
    const top = auto.wrap ? Math.max(w0, S.kind === 'leg' ? 6 : 5) : w0, wMin = auto.wrap ? 2 : w0;
    // a rung whose body sits in one piece with a free direction and fails only on its screws is not mended by a
    // shallower wrap (a shallower body holds fewer of them), so that ladder ends there
    // (a sleeve the built guide finds no body under: its spot is kept clear and the screws placed again, twice at most;
    // the whole fit stops at FIT_BUDGET_MS and keeps the closest rung)
    const ladder = async (step, from, stop = over, dw = 1) => {
      let ok = false;
      for (let w = from; !ok && w >= wMin && !stop(); w -= dw) {
        S.g.wrap = w; place(); onlyScrews = false; ok = await okAt(); log.push({ step, split: S.g.split, wrap: w, flange: S.g.flange, ok });
        for (let r = 0; !ok && r < 2 && onlyScrews && rejected.length && !stop(); r++) { S.screwBlocked.push(...rejected); place(); ok = await okAt(); log.push({ step, split: S.g.split, wrap: w, flange: S.g.flange, ok, retry: r + 1 }); }
        if (!ok && (onlyScrews || noBoneDrop)) break;
      }
      return ok;
    };
    // A1 / B3: a long resection (lesion LONG_MM or more), a straight guide axis that leaves the bone between the cuts, or a
    // segment of the ramus (condyle kept): two guides on their own frames joined by the connecting bar are tried first,
    // the single guide only when they cannot be put on. A guide running up the ramus rests on the posterior border (stopP).
    // a cut that meets no bone leaves nothing for a guide to hold past it: no layout mends that (the check says so)
    const sortedPl = S.planes.length >= 2 ? planesWorld().sort((x, y) => x.off - y.off) : [], misses = cutMisses();
    const outerMiss = sortedPl.length >= 2 && (misses.includes(S.planes.indexOf(sortedPl[0].pl)) || misses.includes(S.planes.indexOf(sortedPl[sortedPl.length - 1].pl)));
    const lng = S.planes.length >= 2 && auto.split && bonelessCut() == null && !outerMiss ? longCase() : null;
    S.longCase = lng; S.fitAngle = 0;
    if (auto.bar) S.g.bar = 0;
    if (auto.stopP) S.g.stopP = ramusAxis() ? 1 : 0;
    let ok = false, split = false, tried2 = false;
    if (lng && !over()) {
      S.g.split = 2; if (auto.bar) S.g.bar = 1; tried2 = true;
      // (3 mm rungs within half the fit budget, so the single guide is still tried when the two cannot be put on)
      ok = await ladder('long', auto.wrap ? Math.min(20, Math.max(top, Math.round(pieceWrapTop()))) : top, () => performance.now() - t0 > FIT_BUDGET_MS * 0.5, 3);
      if (ok) split = true; else { S.g.split = s0; if (auto.bar) S.g.bar = 0; }
    }
    if (!ok) ok = await ladder('wrap', top);
    // a long resection on a curved jaw: two separate guides, one on each side, sit on straighter bone and hold their
    // screws along their own bone; two guides on their own frames start from the depth their own bone allows
    if (!ok && auto.split && !S.g.split && S.planes.length >= 2 && bonelessCut() == null && !outerMiss && !over()) {
      const ang = cutsAngle();
      // the screws follow the layout: on two frames each piece holds its own, on one frame they sit beside the cuts
      const layout = sp => { S.g.split = sp; return sp === 2 && auto.wrap ? Math.min(20, Math.max(top, Math.round(pieceWrapTop()))) : top; };
      let from = layout(ang > 20 && !tried2 ? 2 : 1); S.fitAngle = ang;
      ok = await ladder('split', from);
      if (!ok && auto.split && !over() && !(tried2 && S.g.split === 1)) { from = layout(S.g.split === 2 ? 1 : 2); ok = await ladder('split', from); }
      // the capture flange past each slot shortened: each guide reaches less far around the curve
      if (!ok && S.g.flange > 2 && !over()) { S.g.flange = 2; ok = await ladder('flange', from); if (!ok) S.g.flange = f0; }
      if (ok) split = true; else S.g.split = s0;
    }
    // nothing fits: keep the rung that came closest (its layout, flange and wrap) rather than the first one
    if (!ok && best) {
      if (auto.split && S.planes.length >= 2) S.g.split = best.split;
      if (auto.wrap) S.g.wrap = best.wrap; S.g.flange = best.flange;
      place();
      log.push({ step: 'kept', split: S.g.split, wrap: S.g.wrap, flange: S.g.flange, ok: false, pieces: best.pieces, want: best.want, free: best.free, screws: best.screws });
      if (lng && auto.bar) S.g.bar = S.g.split === 2 ? 1 : 0;
    } else if (!ok) { S.g.wrap = top; place(); }
    S.fitLog = log;
    if ($('g_split')) $('g_split').value = String(S.g.split || 0);
    syncGuideInputs(); schedule(false);
    return { wrap: S.g.wrap, split, ok };
  }
  // guide centre for a painted lesion: the outer bone surface opposite the lesion centre (away from the arch / shaft centre)
  function anchorFromLesion(pts) {
    if (!pts.length || !parts.bone) return false;
    const c = pts.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / pts.length);
    const box = new THREE.Box3().setFromObject(parts.bone.obj); if (parts.resected) box.union(new THREE.Box3().setFromObject(parts.resected.obj)); const bc = box.getCenter(V());
    const out = c.clone().sub(bc); out.z = 0; if (out.lengthSq() < 1) out.set(0, -1, 0); out.normalize();
    const targets = ['bone', 'resected'].filter(k => parts[k]).map(k => parts[k].obj);
    const rc = new THREE.Raycaster(c.clone().addScaledVector(out, 120), out.clone().negate());
    const hit = rc.intersectObjects(targets, false)[0]; if (!hit) return false;
    const nrm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld); if (nrm.dot(out) < 0) nrm.negate();
    setAnchor(hit.point.clone(), nrm);
    // the guide axis follows the painted lesion when the stroke has a direction (6 mm or more across the seating
    // normal): on the chin or up the ramus the local bone PCA is ambiguous (the bone is as tall as it is long within
    // 16 mm), and the surgeon's stroke says which way the resection runs
    const nA = S.anchor.n, flat = pts.map(q => q.clone().sub(c).addScaledVector(nA, -q.clone().sub(c).dot(nA)));
    if (flat.length >= 2) {
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      flat.forEach(d => { const a = [d.x, d.y, d.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += a[i] * a[j]; });
      let e = flat.reduce((a, b) => (b.lengthSq() > a.lengthSq() ? b : a), flat[0]).clone(); if (e.lengthSq() < 1e-6) e = S.anchor.axis.clone();
      for (let it = 0; it < 30; it++) e = V(C[0][0] * e.x + C[0][1] * e.y + C[0][2] * e.z, C[1][0] * e.x + C[1][1] * e.y + C[1][2] * e.z, C[2][0] * e.x + C[2][1] * e.y + C[2][2] * e.z).normalize();
      const span = Math.max(...flat.map(d => d.dot(e))) - Math.min(...flat.map(d => d.dot(e)));
      if (span >= 6 && e.lengthSq() > 0.5) { if (e.dot(S.anchor.axis) < 0) e.negate(); S.anchor.axis = e; S.anchor.axisFrom = 'lesion'; }
    }
    refineAxis();
    return true;
  }
  // the guide axis at the scale of the guide: PCA of the bone in the outer-cortex slab under the guide footprint
  // (12 mm deep, 30 mm each way along the first guess, 20 mm across). A stroke painted at a slant, or the 16 mm PCA
  // on a tall symphysis / thin ramus, can leave the axis far from the bone's run; the slab PCA follows the arch (chin,
  // body) or the ramus. Kept only when it stays within 60° of the first guess (the stroke says which way the resection runs).
  function refineAxis() {
    if (!S.anchor || !S.red || !S.mask) return;
    const { p, n, axis } = S.anchor, u0 = axis.clone().sub(n.clone().multiplyScalar(axis.dot(n))).normalize(), v0 = V().crossVectors(n, u0), r = S.red;
    const c = p.clone(), ci = G.indexOf(r, [c.x, c.y, c.z]), rad = r.sp.map(sp => Math.ceil(36 / sp)), pts = [];
    for (let k = Math.max(0, Math.round(ci[2] - rad[2])); k <= Math.min(r.nz - 1, ci[2] + rad[2]); k += 2)
      for (let j = Math.max(0, Math.round(ci[1] - rad[1])); j <= Math.min(r.ny - 1, ci[1] + rad[1]); j += 2)
        for (let i = Math.max(0, Math.round(ci[0] - rad[0])); i <= Math.min(r.nx - 1, ci[0] + rad[0]); i += 2) {
          if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
          const q = V(...G.worldOf(r, i, j, k)).sub(c), dn = q.dot(n);
          if (dn < -12 || dn > 6 || Math.abs(q.dot(u0)) > 30 || Math.abs(q.dot(v0)) > 20) continue;
          pts.push(q);
        }
    if (pts.length < 60) return;
    const m = pts.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / pts.length), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    pts.forEach(q => { const d = [q.x - m.x, q.y - m.y, q.z - m.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; });
    let e = u0.clone();
    for (let it = 0; it < 40; it++) e = V(C[0][0] * e.x + C[0][1] * e.y + C[0][2] * e.z, C[1][0] * e.x + C[1][1] * e.y + C[1][2] * e.z, C[2][0] * e.x + C[2][1] * e.y + C[2][2] * e.z).normalize();
    e.sub(n.clone().multiplyScalar(e.dot(n))).normalize();
    if (e.lengthSq() < 0.5 || Math.abs(e.dot(u0)) < 0.5) return;
    if (e.dot(u0) < 0) e.negate();
    S.anchor.axis = e; S.anchor.axisFrom = (S.anchor.axisFrom || 'pca') + '+slab';
  }
  const lFields = [['from', 'Lezyon başlangıcı', -45, 45, 0.5, 'mm'], ['to', 'Lezyon bitişi', -45, 45, 0.5, 'mm'], ['margin', 'Güvenlik payı', 0, 15, 0.5, 'mm']];
  $('lesCtl').innerHTML = lFields.map(([k, t, mn, mx, st]) => `<div class="ctl"><div class="ctl-row"><label for="l_${k}">${t}</label><output id="lo_${k}"></output></div><input type="range" id="l_${k}" min="${mn}" max="${mx}" step="${st}"></div>`).join('');
  function syncLesion() {
    lFields.forEach(([k, , , , , unit]) => { $('l_' + k).value = S.lesion[k]; $('lo_' + k).textContent = `${fmt(S.lesion[k])} ${unit}`; });
    $('resType').value = S.lesion.condyle || ''; $('resTypeHint').hidden = !S.lesion.condyle;
    $('lesStatus').textContent = !S.anchor ? '' : S.lesion.ok ? `${xl('Sınır onaylandı')}${S.lesion.by ? ' · ' + S.lesion.by : ''}.` : 'Sınır onayı bekliyor (7. adım).';
  }
  lFields.forEach(([k]) => $('l_' + k).addEventListener('input', e => { S.lesion[k] = +e.target.value; unapprove(S.lesion); syncLesion(); updateLesionPart(); renderAppr(); render(); emit('parts'); emit('changed'); }));
  syncLesion();

  // ---------- guide generation (voxel CSG on a grid aligned with the guide frame) ----------
  // generic voxel guide builder: ctx = { P, u, v, n, g, pls:[{p,N,w}], scs:[{sc,dir,entry}], bone(q) -> bool }
  // which guide edge (+v or −v) is the upper one (patient superior, +z in LPS); the stop flags map onto them
  function stopSides(g, v) {
    const upPos = v.z >= 0, out = { pos: !!(upPos ? g.stopT : g.stopB), neg: !!(upPos ? g.stopB : g.stopT) };
    // posterior stop (ramus): only on a frame whose v axis runs front to back (LPS +y = posterior)
    if (g.stopP && Math.abs(v.y) > 0.5) { if (v.y > 0) out.pos = true; else out.neg = true; }
    return out;
  }
  async function buildGuide(ctx) {
    const t0 = performance.now();
    const { g, P, u, v, n, pls, scs } = ctx, boneAt = ctx.bone, h = ctx.h || 0.4, T = {};
    const maxSleeve = Math.max(0, ...scs.map(s => s.sc.sleeveH));
    // optional stops: lips past the upper / lower guide edge that reach around the bone edge (crest, lower border)
    const sUp = stopSides(g, v), anyStop = sUp.pos || sUp.neg, stopX = anyStop ? (g.stopL || 6) : 0, stopZ = anyStop ? (g.stopD || 5) : 0, vc = g.vc || 0;
    // wrap depth at a position along the guide: the hand / global value, capped by the automatic per-position profile
    // (g.wrapU = [[uu, depth], ...]) where the bone's widest level is shallower towards an end of the guide
    const wrapOf = uu => { const pr = g.wrapU; if (!pr || !pr.length) return g.wrap; if (uu <= pr[0][0]) return Math.min(g.wrap, pr[0][1]); for (let a = 1; a < pr.length; a++) if (uu <= pr[a][0]) { const t = (uu - pr[a - 1][0]) / ((pr[a][0] - pr[a - 1][0]) || 1); return Math.min(g.wrap, pr[a - 1][1] + t * (pr[a][1] - pr[a - 1][1])); } return Math.min(g.wrap, pr[pr.length - 1][1]); };
    const uc = g.uc || 0;
    const lo = [uc - g.L / 2 - 4, vc - g.W / 2 - 4 - stopX, -Math.max(g.wrap + 10, 30) - Math.max(0, g.L / 2 - 15) * 0.6], hi = [uc + g.L / 2 + 4, vc + g.W / 2 + 4 + stopX, g.clear + g.wall + Math.max(maxSleeve, g.bridge) + 6];
    const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1, N = nx * ny * nz, nxy = nx * ny;
    const toWorld = (a, b, c) => { const x = lo[0] + a * h, y = lo[1] + b * h, z = lo[2] + c * h; return [P.x + u.x * x + v.x * y + n.x * z, P.y + u.y * x + v.y * y + n.y * z, P.z + u.z * x + v.z * y + n.z * z]; };
    if (ctx.field && ctx.field.prepare) { const cs = []; for (const a of [0, nx - 1]) for (const b of [0, ny - 1]) for (const c of [0, nz - 1]) cs.push(toWorld(a, b, c)); ctx.field.prepare(cs); }
    // bone in the local grid
    // (ctx.field, when given, is the bone density behind ctx.bone (bone = field > 0.5): it places the surface between grid nodes)
    const B = new Uint8Array(N), qv = new THREE.Vector3(), soft = ctx.field ? new Float32Array(N) : null;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const z = lo[2] + k * h, y = lo[1] + j * h, bx = P.x + v.x * y + n.x * z, by = P.y + v.y * y + n.y * z, bz = P.z + v.z * y + n.z * z, r = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        const x = lo[0] + i * h; qv.set(bx + u.x * x, by + u.y * x, bz + u.z * x);
        if (soft) { const f = ctx.field(qv); soft[r + i] = f; if (f > 0.5) B[r + i] = 1; } else if (boneAt(qv)) B[r + i] = 1;
      }
    }
    T.bone = performance.now() - t0; await sleep();
    // solid = bone plus every void the outside cannot reach; d = signed distance to its surface (outside > 0), lightly smoothed
    // as the server does; the guide is the level set of a few such fields (shell band, box, slots, sleeves) combined with
    // min / max, so every plane in the design stays a plane and the mesh below can be marched on exact distances
    const O = G.exterior(B, nx, ny, nz), Bs = new Uint8Array(N); for (let i = 0; i < N; i++) Bs[i] = O[i] ? 0 : 1;
    const D = G.edt(Bs, nx, ny, nz); T.edt = performance.now() - t0;
    await sleep();
    const dist = new Float32Array(N); for (let i = 0; i < N; i++) dist[i] = Bs[i] ? -h / 2 : D[i] * h - h / 2;
    // within a voxel and a half of the surface the distance comes from the density itself, (0.5 - density) / |gradient|,
    // which places the surface to a fraction of a voxel instead of the voxel the node-to-node distance lands in
    if (soft) {
      const near = 1.5 * h, g2 = 1 / (2 * h), fade = 0.5 * h;
      for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const id = i + nx * (j + ny * k), de = dist[id]; if (de > near || (Bs[id] && soft[id] <= 0.5)) continue;
        const gx = (soft[id + 1] - soft[id - 1]) * g2, gy = (soft[id + nx] - soft[id - nx]) * g2, gz = (soft[id + nxy] - soft[id - nxy]) * g2, gm = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gm < 0.05) continue;
        const sd = Math.max(-near, Math.min(near, (0.5 - soft[id]) / gm)), wgt = de <= near - fade ? 1 : (near - de) / fade;
        dist[id] = de + wgt * (sd - de);
      }
    }
    const dd = G.blur(dist, nx, ny, nz);
    // periosteum allowance (soft tissue left on the bone) adds to the clearance
    const c = g.clear + (g.peri || 0), w = g.wall, gap = ctx.gap || splitGap(g, pls), cw = c + w;
    const colTopBone = new Float32Array(nx * ny).fill(-Infinity);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (Bs[i + nx * (j + ny * k)]) colTopBone[i + nx * j] = lo[2] + k * h;
    // the wrap depth follows the bone: on a curved jaw the bone drops away from the guide plane towards the guide
    // ends, so the depth limit is measured from the top of the bone at each position along the guide (never above
    // the plane through the anchor)
    const topU = new Float32Array(nx).fill(0);
    for (let i = 0; i < nx; i++) {
      let t = -Infinity;
      for (let j = 0; j < ny; j++) if (Math.abs(lo[1] + j * h - vc) <= g.W / 2) t = Math.max(t, colTopBone[i + nx * j]);
      topU[i] = t === -Infinity ? 0 : Math.min(0, t);
    }
    const win = Math.max(1, Math.round(1.5 / h)), wrapAt = new Float32Array(nx);
    for (let i = 0; i < nx; i++) { let m = 0; for (let a = Math.max(0, i - win); a <= Math.min(nx - 1, i + win); a++) m = Math.min(m, topU[a]); wrapAt[i] = m - wrapOf(lo[0] + i * h); }
    // ---- insertion direction and the seatable envelope ----
    // The guide is put on along one direction d (a cone of up to 40° around n). Along d the bone surface has a visible
    // part (nothing above it along d) and a hidden part under its own overhangs: tooth crowns over the alveolar bone,
    // the lower border curving in, the lingual side of a thin bone. The shell is built on the envelope = bone plus its
    // shadow along d (every undercut filled), so it is one connected sheet that lifts off along d by construction, and
    // it is kept only where real bone is within `skirt` of it, so it stops at the silhouette instead of hanging down
    // beside a deep undercut. d is chosen per build: the direction that sees the most bone surface under the guide
    // footprint, with a small cost per degree of tilt so the seating normal wins a near tie (ctx.seatDir forces one).
    const seatCand = [];
    for (let tilt = 0; tilt <= 40; tilt += 10) for (let az = 0; az < (tilt ? 360 : 1); az += 45) { const tr = tilt * Math.PI / 180, ar = az * Math.PI / 180; seatCand.push({ tilt, az, d: [Math.sin(tr) * Math.cos(ar), Math.sin(tr) * Math.sin(ar), Math.cos(tr)] }); }
    const basis2 = d => { const t = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], a = [t[1] * d[2] - t[2] * d[1], t[2] * d[0] - t[0] * d[2], t[0] * d[1] - t[1] * d[0]], l = Math.hypot(a[0], a[1], a[2]) || 1; const ea = a.map(x => x / l); return [ea, [d[1] * ea[2] - d[2] * ea[1], d[2] * ea[0] - d[0] * ea[2], d[0] * ea[1] - d[1] * ea[0]]]; };
    // projection of the grid onto the plane normal to d, in voxel units (i, j, k) so that an axis-aligned d maps every
    // column to its own cell: the top of the bone per cell. `st` > 1 samples every st-th voxel (direction scoring)
    function projection(d, st = 1) {
      const [ea, eb] = basis2(d), cell = st;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const x of [0, nx - 1]) for (const y of [0, ny - 1]) for (const z of [0, nz - 1]) { const a = x * ea[0] + y * ea[1] + z * ea[2], b = x * eb[0] + y * eb[1] + z * eb[2]; amin = Math.min(amin, a); amax = Math.max(amax, a); bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); }
      const na = Math.floor((amax - amin) / cell) + 2, nb = Math.floor((bmax - bmin) / cell) + 2, top = new Float32Array(na * nb).fill(-Infinity);
      const ea0 = ea[0] / cell, ea1 = ea[1] / cell, ea2 = ea[2] / cell, eb0 = eb[0] / cell, eb1 = eb[1] / cell, eb2 = eb[2] / cell, a0 = amin / cell - 0.5, b0 = bmin / cell - 0.5;
      const cellOf = (i, j, k) => Math.floor(i * ea0 + j * ea1 + k * ea2 - a0) + na * Math.floor(i * eb0 + j * eb1 + k * eb2 - b0);
      const tOf = (i, j, k) => (i * d[0] + j * d[1] + k * d[2]) * h;
      for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) {
        const r = nx * (j + ny * k), ca = j * ea1 + k * ea2 - a0, cb = j * eb1 + k * eb2 - b0, ct = (j * d[1] + k * d[2]) * h;
        for (let i = 0; i < nx; i += st) { if (!Bs[r + i]) continue; const ci = Math.floor(i * ea0 + ca) + na * Math.floor(i * eb0 + cb), t = i * d[0] * h + ct; if (t > top[ci]) top[ci] = t; }
      }
      return { d, ea, eb, cell: cell * h, na, nb, top, cellOf, tOf };
    }
    // bone surface under the guide footprint (a little beyond the box, so a direction is judged on what the guide can reach)
    const surf = [], surfSt = h < 0.6 ? 2 : 1;
    for (let k = 1; k < nz - 1; k += surfSt) for (let j = 1; j < ny - 1; j += surfSt) for (let i = 1; i < nx - 1; i += surfSt) {
      const id = i + nx * (j + ny * k); if (!Bs[id]) continue;
      if (Bs[id - 1] && Bs[id + 1] && Bs[id - nx] && Bs[id + nx] && Bs[id - nxy] && Bs[id + nxy]) continue;
      if (Math.abs(lo[0] + i * h - uc) > g.L / 2 + 2 || Math.abs(lo[1] + j * h - vc) > g.W / 2 + 2 || lo[2] + k * h < wrapAt[i] - 2) continue;
      surf.push(id);
    }
    const visCount = (pj, tol) => { let vis = 0; for (const id of surf) { const i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0; if (pj.top[pj.cellOf(i, j, k)] - pj.tOf(i, j, k) <= tol) vis++; } return vis; };
    let seatPick = null, seatBest = -Infinity;
    const forced = ctx.seatDir && seatCand.find(cd => cd.tilt === ctx.seatDir.tilt && cd.az === ctx.seatDir.az);
    for (const cd of forced ? [forced] : seatCand) {
      const pj = projection(cd.d, surfSt), score = visCount(pj, 1.5 * pj.cell) * (1 - 0.005 * cd.tilt);
      if (score > seatBest) { seatBest = score; seatPick = cd; }
    }
    const prj = projection(seatPick.d, 1), seatDir = { tilt: seatPick.tilt, az: seatPick.az, d: seatPick.d, visible: 0, hidden: 0 };
    { const vis = visCount(prj, 1.5 * h), a = surfSt * surfSt * h * h; seatDir.visible = vis * a; seatDir.hidden = (surf.length - vis) * a; }
    // envelope = bone + its shadow along d; its distance field (dE) carries the shell, dd (real bone) the clearance checks
    const E = new Uint8Array(N), tTop = new Float32Array(N); let nShadow = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k), tp = prj.top[prj.cellOf(i, j, k)];
      tTop[id] = tp - prj.tOf(i, j, k);
      if (Bs[id]) E[id] = 1; else if (tTop[id] > 0.5 * h) { E[id] = 2; nShadow++; }
    }
    // the shadow is one voxel wider across d than the silhouette (not deeper, not higher): a wall standing beside a
    // silhouette then keeps a voxel plus the clearance from it, and the seating sweep (one-voxel cells) sees the two apart
    if (nShadow) {
      const { ea, eb } = prj, nb4 = [[ea[0], ea[1], ea[2]], [-ea[0], -ea[1], -ea[2]], [eb[0], eb[1], eb[2]], [-eb[0], -eb[1], -eb[2]]].map(q => q.map(Math.round));
      const add = [];
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const id = i + nx * (j + ny * k); if (E[id]) continue;
        for (const [di, dj, dk] of nb4) { const i2 = i + di, j2 = j + dj, k2 = k + dk; if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= nx || j2 >= ny || k2 >= nz) continue; if (E[i2 + nx * (j2 + ny * k2)] === 2) { add.push(id); break; } }
      }
      for (const id of add) E[id] = 3;
    }
    let ddE = dd;
    if (nShadow) {
      const DE = G.edt(E, nx, ny, nz), distE = new Float32Array(N);
      for (let i = 0; i < N; i++) distE[i] = E[i] ? -h / 2 : DE[i] * h - h / 2;
      // the density refinement applies where the envelope surface is the bone surface itself (not a shadow face)
      if (soft) { for (let i = 0; i < N; i++) if (!E[i] || Bs[i]) { if (Math.abs(distE[i] - (Bs[i] ? -h / 2 : D[i] * h - h / 2)) < 0.5 * h) distE[i] = dist[i]; } }
      ddE = G.blur(distE, nx, ny, nz);
    }
    T.env = performance.now() - t0; await sleep();
    // planes in guide-frame coordinates: signed distance = a*uu + b*vv + c*nn - e
    const toF = (p, N_) => { const l = Math.hypot(N_.x, N_.y, N_.z); if (!(l > 1e-9) || !isFinite(l)) return null; const a = N_.dot(u) / l, b = N_.dot(v) / l, cc = N_.dot(n) / l, dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z; return { a, b, c: cc, e: a * (dx * u.x + dy * u.y + dz * u.z) + b * (dx * v.x + dy * v.y + dz * v.z) + cc * (dx * n.x + dy * n.y + dz * n.z) }; };
    // the saw slot is centred on pSlot (the plane shifted towards the defect when the kerf lies on the resected side)
    const slots = pls.map(pw => { const f = toF(pw.pSlot || pw.p, pw.N); return f && pw.w > 0 ? Object.assign(f, { half: pw.w / 2 }) : null; }).filter(Boolean);
    const gp = gap && { A: toF(gap.A.p, gap.A.N), B: toF(gap.B.p, gap.B.N), ta: gap.A.w / 2 + g.flange, tb: gap.B.w / 2 + g.flange };
    const F = new Float32Array(N).fill(h * 4);
    const bridgeLo = cw - 0.5, bridgeHi = cw + 2.5, skirt = g.skirt == null ? 3 : g.skirt;
    // the bridge (the rib that carries the body across the saw slots) runs along the body's own +v / -v edge at each
    // position along the guide: on a bone curved across v the box edge lies off the body, so a rib there would float
    const edgeV = new Float32Array(nx).fill(NaN);
    for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      const e0 = new Float32Array(nx).fill(NaN);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const vv = lo[1] + j * h; for (let i = 0; i < nx; i++) { if (F[i + nx * (j + ny * k)] >= 0) continue; const e = e0[i]; if (Number.isNaN(e) || (g.side > 0 ? vv > e : vv < e)) e0[i] = vv; } }
      // smoothed along u (the rib must not step), never beyond the box edge
      for (let i = 0; i < nx; i++) { let m = NaN, cnt = 0, sum = 0; for (let q = Math.max(0, i - win); q <= Math.min(nx - 1, i + win); q++) if (!Number.isNaN(e0[q])) { cnt++; sum += e0[q]; m = Number.isNaN(m) ? e0[q] : (g.side > 0 ? Math.min(m, e0[q]) : Math.max(m, e0[q])); } edgeV[i] = cnt ? m : NaN; }
    }
    for (let k = 0; k < nz; k++) {
      const nn = lo[2] + k * h;
      for (let j = 0; j < ny; j++) {
        const vv = lo[1] + j * h, av = Math.abs(vv - vc), sd = vv > vc ? sUp.pos : sUp.neg, band = sd && av > g.W / 2 - 2;
        for (let i = 0; i < nx; i++) {
          const id = i + nx * (j + ny * k), uu = lo[0] + i * h, d = dd[id], dE = ddE[id];
          const ev = edgeV[i], eT = pass === 0 || Number.isNaN(ev) ? 1e3 : (g.side > 0 ? ev - g.bridge - vv : vv - ev - g.bridge);
          const outer = Math.abs(uu - uc) - g.L / 2;
          if (outer > 0 || dE > bridgeHi + h) { F[id] = Math.max(outer, dE - bridgeHi); continue; }
          // box: guide length and width, depth below the wrap line (stops: a lip past the edge, only off the bone's shadow)
          const shadow = colTopBone[i + nx * j] > nn;
          let box = Math.max(outer, av - g.W / 2, wrapAt[i] - nn);
          if (band && shadow) box = Math.max(box, h);
          if (sd) {
            const stop = (band && !shadow) ? Math.max(outer, av - g.W / 2 - stopX, wrapAt[i] - stopZ - nn) : 1e3;
            box = Math.min(box, stop);
          }
          let shell = Math.max(c - dE, dE - cw);
          if (pass === 1) for (const s of slots) shell = Math.max(shell, s.half - Math.abs(s.a * uu + s.b * vv + s.c * nn - s.e));   // (pass 0 finds the body edge without the slots, so the rib does not dip into them)
          const bridge = Math.max(bridgeLo - dE, dE - bridgeHi, eT);
          // near real bone: the envelope point under this voxel is bone, or a shadow face within `skirt` of bone
          F[id] = Math.max(box, d - dE - skirt, Math.min(shell, bridge));
        }
      }
    }
    }
    // the body as one region of the footprint (cells of the projection along d): small islands cut off by the
    // silhouette or the box are dropped and reported, larger ones stay and count as pieces
    const dropped = [];
    {
      const nc = prj.na * prj.nb, fp = new Uint8Array(nc), lab = new Int32Array(nc).fill(-1), own = new Int32Array(N).fill(-1);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const id = i + nx * (j + ny * k); if (F[id] < 0) { const ci = prj.cellOf(i, j, k); fp[ci] = 1; own[id] = ci; } }
      const comps2 = [], q = new Int32Array(nc);
      for (let s0 = 0; s0 < nc; s0++) {
        if (!fp[s0] || lab[s0] >= 0) continue;
        const L = comps2.length; let head = 0, tail = 0; q[tail++] = s0; lab[s0] = L; let size = 0;
        while (head < tail) {
          const cI = q[head++]; size++; const a = cI % prj.na, b = (cI / prj.na) | 0;
          for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a2 = a + da, b2 = b + db; if (a2 < 0 || b2 < 0 || a2 >= prj.na || b2 >= prj.nb) continue; const c2 = a2 + prj.na * b2; if (fp[c2] && lab[c2] < 0) { lab[c2] = L; q[tail++] = c2; } }
        }
        comps2.push({ L, size, area: size * prj.cell * prj.cell });
      }
      const main = comps2.reduce((a, b) => (b.size > a.size ? b : a), comps2[0] || { L: -1, size: 0 });
      const drop = new Set(comps2.filter(cm => cm !== main && cm.area < 50).map(cm => cm.L));
      if (ctx.debugFp) ctx.debugFp({ fp, lab, na: prj.na, nb: prj.nb, comps: comps2, main });
      if (drop.size) { for (let id = 0; id < N; id++) if (own[id] >= 0 && drop.has(lab[own[id]])) F[id] = h; comps2.forEach(cm => { if (drop.has(cm.L)) dropped.push(+cm.area.toFixed(1)); }); }
    }
    // screw sleeves (added) and drill holes (removed)
    const screwInfo = [], axes = [];
    for (const s of scs) {
      if (!s.entry) { screwInfo.push({ s, ok: false }); continue; }
      // the hole is the drill plus the material profile's sleeve fit
      const out = s.dir.clone().negate(), R = s.sc.D / 2, r = (s.sc.d + (g.fit || 0)) / 2, top = cw + s.sc.sleeveH;
      const e0 = s.entry.clone().sub(P), el = [e0.dot(u), e0.dot(v), e0.dot(n)], ol = [out.dot(u), out.dot(v), out.dot(n)];
      // a sleeve is only added where the guide body is: the body must be present along the sleeve axis just above the
      // clearance (bone that drops away under a guide end, the silhouette, or outside the box leave none), or the
      // sleeve would float free of the shell; such a screw is reported instead
      // (the shell may stand up to `skirt` off the bone where the envelope's shadow face carries it, so the body is
      // looked for over the clearance band plus that allowance; the sleeve reaches down to the entry in any case)
      const ie = Math.max(0, Math.min(nx - 1, Math.round((el[0] - lo[0]) / h)));
      let onN = 0, onHit = 0;
      { const [pa, pb] = basis2(ol), ts = Math.max(0.2, h / 2); for (let t = c + 0.3; t <= cw - 0.3 + 1e-9; t += ts) onN++; for (let t = c + 0.3; t <= cw - 0.3 + skirt + 1e-9; t += ts) for (const [sa, sb] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { const x = el[0] + ol[0] * t + (pa[0] * sa + pb[0] * sb) * R, y = el[1] + ol[1] * t + (pa[1] * sa + pb[1] * sb) * R, z = el[2] + ol[2] * t + (pa[2] * sa + pb[2] * sb) * R, i = Math.round((x - lo[0]) / h), j = Math.round((y - lo[1]) / h), k = Math.round((z - lo[2]) / h); if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) { const q = i + nx * (j + ny * k); if (F[q] < 0 || (ddE[q] > c - h && ddE[q] <= cw + h && slots.some(sl => Math.abs(sl.a * x + sl.b * y + sl.c * z - sl.e) < sl.half + h))) onHit++; } } }
      const onBody = onN > 0 && onHit >= 0.5 * 5 * onN;
      if (!onBody) { screwInfo.push({ s, ok: false, noBody: true, depth: el[2] - wrapAt[ie] }); continue; }
      // only the grid cells within R of the drill axis (the hole runs through the whole grid)
      const rng = [0, 1, 2].map(a => { const p1 = el[a] - ol[a] * 400, p2 = el[a] + ol[a] * 400; return [Math.max(0, Math.floor((Math.min(p1, p2) - R - lo[a]) / h) - 1), Math.min([nx, ny, nz][a] - 1, Math.ceil((Math.max(p1, p2) + R - lo[a]) / h) + 1)]; });
      const info = { s, ok: true }; axes.push({ el, ol, R, r, top, rng, info });
      // screw path through bone; distance to every saw slot is measured from the slot edge (half width w/2 around pSlot)
      // to the screw surface: the drill (radius d/2) inside the slot is critical, the sleeve (radius D/2) within
      // 0.5 mm is a warning
      // cutGap: bone between the hole (radius d/2) and the planned cut plane p (the osteotomy face), over the part of the
      // hole that runs in bone
      let inBone = 0, crossesPlane = false, exitAt = null, slotGap = Infinity, cutGap = Infinity;
      for (let t = 0; t <= s.sc.len; t += 0.25) {
        const q = s.entry.clone().add(s.dir.clone().multiplyScalar(t)), bone = boneAt(q);
        if (bone) inBone += 0.25; else if (exitAt === null && t > 1) exitAt = t;
        for (const pw of pls) {
          const dq = q.clone().sub(pw.pSlot || pw.p), a = dq.dot(pw.N); if (dq.lengthSq() - a * a > SLOT_REACH * SLOT_REACH) continue;
          const dist = Math.abs(a); if (dist < pw.w / 2 + s.sc.d / 2) crossesPlane = true; slotGap = Math.min(slotGap, dist - pw.w / 2 - s.sc.D / 2);
          if (bone) cutGap = Math.min(cutGap, Math.abs(q.clone().sub(pw.p).dot(pw.N)) - s.sc.d / 2);
        }
      }
      screwInfo.push(Object.assign(info, { inBone: Math.min(inBone, s.sc.len), crossesPlane, slotGap, exitAt, cutGap }));
    }
    const radialAt = (A, i, j, k) => {
      const qa = lo[0] + i * h - A.el[0], qb = lo[1] + j * h - A.el[1], qc = lo[2] + k * h - A.el[2], t = qa * A.ol[0] + qb * A.ol[1] + qc * A.ol[2];
      const ra = qa - t * A.ol[0], rb = qb - t * A.ol[1], rc = qc - t * A.ol[2];
      return [Math.sqrt(ra * ra + rb * rb + rc * rc), t];
    };
    // the sleeve keeps clear of the envelope (bone and its shadow along the insertion direction) like the shell does;
    // the part of the cylinder that would stand in the shadow is left out and, when that is more than a tenth, reported
    for (const A of axes) {
      let all = 0, shaded = 0;
      for (let k = A.rng[2][0]; k <= A.rng[2][1]; k++) for (let j = A.rng[1][0]; j <= A.rng[1][1]; j++) for (let i = A.rng[0][0]; i <= A.rng[0][1]; i++) {
        const [rad, t] = radialAt(A, i, j, k); if (rad > A.R + h) continue;
        const id = i + nx * (j + ny * k), cyl = Math.max(rad - A.R, -1 - t, t - A.top);
        if (cyl < 0 && dd[id] > c) { all++; if (ddE[id] <= c) shaded++; }
        F[id] = Math.min(F[id], Math.max(cyl, c - dd[id], c - ddE[id]));
      }
      if (all && shaded > 0.1 * all) A.info.shadowed = +(shaded / all).toFixed(2);
    }
    for (const A of axes) for (let k = A.rng[2][0]; k <= A.rng[2][1]; k++) for (let j = A.rng[1][0]; j <= A.rng[1][1]; j++) for (let i = A.rng[0][0]; i <= A.rng[0][1]; i++) {
      const rad = radialAt(A, i, j, k)[0]; if (rad > A.r + h) continue;
      const id = i + nx * (j + ny * k); F[id] = Math.max(F[id], A.r - rad);
    }
    if (gp) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (F[id] >= 0) continue;
      const uu = lo[0] + i * h, vv = lo[1] + j * h, nn = lo[2] + k * h;
      F[id] = Math.max(F[id], Math.min(gp.A.a * uu + gp.A.b * vv + gp.A.c * nn - gp.A.e - gp.ta, -(gp.B.a * uu + gp.B.b * vv + gp.B.c * nn - gp.B.e) - gp.tb));
    }
    // the surface must close inside the grid
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) { const id = i + nx * (j + ny * k); if (F[id] < h) F[id] = h; }
    T.screws = performance.now() - t0; await sleep();
    // drop specks left by slots and holes (under 1 % of the main body or 1 mm³); count real pieces
    const Gm = new Uint8Array(N); for (let i = 0; i < N; i++) if (F[i] < 0) Gm[i] = 1;
    const cc = G.components(Gm, nx, ny, nz, 1), big = cc.comps.length ? cc.comps[0].size : 0, minSize = Math.max(big * 0.01, 1 / (h * h * h));
    const comps = cc.comps.filter(cm => cm.size >= minSize), keepL = new Set(comps.map(cm => cm.label));
    for (let i = 0; i < N; i++) if (Gm[i] && !keepL.has(cc.labels[i])) { Gm[i] = 0; F[i] = h; }
    let vol = 0, contact = 0, undercutCols = 0, bvLo = Infinity, bvHi = -Infinity;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (!Gm[id]) continue;
      vol++; const d = dd[id], vv = lo[1] + j * h; if (vv < bvLo) bvLo = vv; if (vv > bvHi) bvHi = vv;
      if (d > c && d <= bridgeHi) {
        if (d <= cw && d <= c + h) contact++;
        // bone above this voxel along the insertion direction (more than a voxel and a half: the silhouette itself is not an undercut)
        if (tTop[id] > 1.5 * h) undercutCols++;
      }
    }
    T.field = performance.now() - t0; await sleep();
    const net = G.marchTets(F, nx, ny, nz, 0);
    // winding follows the grid -> world map, which is a reflection when (u, v, n) is left-handed
    if (u.dot(new THREE.Vector3().crossVectors(v, n)) < 0) { const ix = net.indices; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
    const mesh = meshFromNets(net, toWorld, mat(COLORS.guide));
    T.mesh = performance.now() - t0;
    const seat = window.Seat && !ctx.fast ? Seat.analyze({ Gm, B, D, nx, ny, nz, h, lo, clear: c }) : null;
    const wrapProfile = []; for (let i = 0; i < nx; i += Math.max(1, Math.round(1 / h))) wrapProfile.push([+(lo[0] + i * h).toFixed(2), +wrapAt[i].toFixed(2)]);
    return { mesh, result: { wrapProfile, pieces: comps.length, contact: contact * h * h, undercut: undercutCols * h * h, volume: vol * h * h * h, screwInfo, pls, seat, seatDir, dropped, bodyW: vol ? +(bvHi - bvLo + h).toFixed(1) : 0, bodyV: vol ? [+bvLo.toFixed(1), +bvHi.toFixed(1)] : null, ms: performance.now() - t0, T },
      grid: { Gm, B, F, nx, ny, nz, h, lo, P: P.clone(), u: u.clone(), v: v.clone(), n: n.clone(), edgeV, wrapAt } };
  }
  // two separate guides: nothing between the outermost cuts except a capture flange beyond each slot
  function splitGap(g, pls) {
    if (!g.split || pls.length < 2) return null;
    const pl = pls.slice().sort((a, b) => a.off - b.off), A = pl[0], B = pl[pl.length - 1], dir = B.p.clone().sub(A.p).normalize();
    const NA = A.N.clone(), NB = B.N.clone(); if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
    return { A: { p: A.p, N: NA, w: A.w }, B: { p: B.p, N: NB, w: B.w } };
  }
  // ---------- automatic body size from the bone under the guide ----------
  // Cross-sections of the bone in the guide frame at positions uu along u: in the (v, n) plane, the bone's top
  // (largest nn), its extent across v at each depth level and the "widest level" (the depth below the top where the
  // extent across v is largest). A shell wrapped deeper than that level reaches under the bone's edge and the guide can
  // no longer be lifted off along n (the same idea as fibula.js localSection). field(q) is the bone density (> 0.5 = bone).
  function boneSections(P, u, v, n, field, uList, opts = {}) {
    const st = opts.step || 0.5, vHalf = opts.vHalf || 21, v0 = opts.vc || 0, nLo = -(opts.deep || 32), nHi = opts.above || 6, q = new THREE.Vector3(), out = [];
    const nN = Math.round((nHi - nLo) / st) + 1;
    for (const uu of uList) {
      const vmin = new Float32Array(nN).fill(Infinity), vmax = new Float32Array(nN).fill(-Infinity);
      let top = -Infinity, vTop = 0;
      for (let vv = v0 - vHalf; vv <= v0 + vHalf + 1e-9; vv += st) {
        for (let k = 0; k < nN; k++) {
          const nn = nLo + k * st;
          q.set(P.x + u.x * uu + v.x * vv + n.x * nn, P.y + u.y * uu + v.y * vv + n.y * nn, P.z + u.z * uu + v.z * vv + n.z * nn);
          if (field(q) > 0.5) { if (vv < vmin[k]) vmin[k] = vv; if (vv > vmax[k]) vmax[k] = vv; if (nn > top) { top = nn; vTop = vv; } }
        }
      }
      if (top === -Infinity) { out.push({ uu, empty: true }); continue; }
      // extent across v per level, from the top down; the widest level = mean of the levels within 3 % of the maximum
      let maxW = 0; const rows = [];
      for (let k = nN - 1; k >= 0; k--) { const nn = nLo + k * st; if (nn > top || vmin[k] === Infinity) continue; const w = vmax[k] - vmin[k] + st; rows.push([nn, w, vmin[k], vmax[k]]); if (w > maxW) maxW = w; }
      const eq = rows.filter(r => r[1] >= 0.97 * maxW), nEq = eq.reduce((s, r) => s + r[0], 0) / eq.length;
      const lo = Math.min(...eq.map(r => r[2])), hi = Math.max(...eq.map(r => r[3]));
      out.push({ uu, top, vTop, depth: top - nEq, width: maxW, vLo: lo, vHi: hi, vc: (lo + hi) / 2 });
    }
    return out;
  }
  // body size for a guide frame over the span [uA, uB] (mm along u): W and its lateral centre vc from the bone extent at
  // the widest level, the wrap depth per position (0.8 of the depth to the widest level, never below 2 mm) and the bone
  // top per position. Hand-set values are kept (prefs.W / prefs.wrap false).
  function sizeBody(frame, field, uA, uB, g, prefs = { W: true, wrap: true }) {
    const { P, u, v, n } = frame, step = Math.max(3, (uB - uA) / 10), us = [];
    for (let x = uA; x <= uB + 1e-6; x += step) us.push(+x.toFixed(2));
    if (us[us.length - 1] < uB - 0.5) us.push(uB);
    const secs = boneSections(P, u, v, n, field, us).filter(s => !s.empty);
    const out = { secs, W: g.W, vc: g.vc || 0, wrap: g.wrap, wrapU: null, ok: secs.length > 0 };
    if (!secs.length) return out;
    const cw = g.clear + (g.peri || 0) + g.wall;
    if (prefs.W) {
      // the body covers the bone's extent across v (worst case over the span) plus the shell on both edges
      const lo = Math.min(...secs.map(s => s.vLo)), hi = Math.max(...secs.map(s => s.vHi));
      out.W = Math.max(10, Math.min(40, Math.round(hi - lo + 2 * cw + 2)));
      out.vc = Math.round((lo + hi) / 2 * 2) / 2;
    }
    if (prefs.wrap) {
      const dOf = s => Math.max(2, Math.min(20, Math.round(s.depth * 0.8 * 2) / 2));
      out.wrapU = secs.map(s => [s.uu, dOf(s)]);
      out.wrap = Math.max(...out.wrapU.map(x => x[1]));
    }
    return out;
  }
  // the frame of one piece of a two-piece guide: at the cut's point on the bone surface (found along the guide normal),
  // the local bone axis and surface normal (frameAt), u pointing into the kept bone
  function cutFrame(pw, keepDir, n0) {
    // the cut's point on the bone surface, found along the seating normal; a cut past the angle of the jaw meets no bone
    // on the guide axis itself (the bone turns up into the ramus), so the search climbs the cut plane sideways (±40 mm)
    // and, failing that, steps a little into the kept bone
    // Of the bone the plane meets, the piece sits on the most prominent point along the guide normal (the crest of the
    // buccal face the body is wrapped from, as buildGuide measures its wrap from the bone's top), nearer the guide
    // axis on a near tie; a point on the rounded lower border or up on the alveolar slope would give the piece a
    // normal turned away from the face its screws must enter.
    // (a cut turned far from the guide axis, as one across the chin for a guide on the body, can have the guide normal
    // nearly along its own normal (within acos(CUT_STEEP)): a walk straight down the guide normal would leave the plane
    // and meet the bone of the resected side, so for such a cut the search walks down the guide normal as seen in the
    // cut plane and steps into the kept bone along the cut normal)
    const vAx = V().crossVectors(n0, pw.N).normalize(); if (vAx.lengthSq() < 1e-6) return null;
    const steep = Math.abs(pw.N.dot(n0)) > CUT_STEEP, nP = steep ? V().crossVectors(vAx, pw.N).normalize() : n0.clone(); if (nP.dot(n0) < 0) nP.negate();
    const kIn = steep ? pw.N.clone().multiplyScalar(Math.sign(pw.N.dot(keepDir)) || 1) : keepDir;
    let q = null, qScore = -Infinity;
    for (const kk of [0, 3, 6]) {
      for (let vv = -40; vv <= 40; vv += 2) {
        const top = pw.p.clone().addScaledVector(vAx, vv).addScaledVector(kIn, kk).addScaledVector(nP, 20);
        for (let t = 0; t < 70; t += 0.25) { const c = top.clone().addScaledVector(nP, -t); if (boneAt(c)) { const sc = -t - 0.15 * Math.abs(vv); if (sc > qScore) { qScore = sc; q = c; } break; } }
      }
      if (q) break;
    }
    if (!q) return null;
    const f = frameAt(q, n0);
    // the piece's normal is the bone surface normal where it sits (the density gradient over a few millimetres, so a
    // cut on the turned face of the chin or at the angle gets a frame tangent to that face, not the body's), the
    // ball-centre blend of frameAt when the gradient is flat; the piece is put on from the same side as the whole
    // guide, so it keeps within PIECE_TURN deg of the guide normal (a long resection across the chin has its far stump
    // facing up to 70-90 deg away from the guide's face: a tighter limit leaves the piece tilted against its own bone,
    // its columns miss the stump turning away and no screw finds bone past that cut)
    let nn = f.n.clone();
    { const gr = V(), st = 1.5, e = V(); for (const off of [[0, 0, 0], [0, 0, 2], [0, 0, -2], [0, 2, 0], [0, -2, 0], [2, 0, 0], [-2, 0, 0]]) { const c = q.clone().add(V(...off)); e.set(boneField(c.clone().add(V(st, 0, 0))) - boneField(c.clone().add(V(-st, 0, 0))), boneField(c.clone().add(V(0, st, 0))) - boneField(c.clone().add(V(0, -st, 0))), boneField(c.clone().add(V(0, 0, st))) - boneField(c.clone().add(V(0, 0, -st)))); gr.add(e); } if (gr.lengthSq() > 1e-4) { gr.negate().normalize(); if (gr.dot(n0) < 0) gr.negate(); nn = gr.multiplyScalar(0.7).addScaledVector(n0, 0.3).normalize(); } }
    const cs = Math.max(-1, Math.min(1, nn.dot(n0))), th = Math.acos(cs), lim = deg(PIECE_TURN);
    if (th > lim) { const t = lim / th; nn = n0.clone().multiplyScalar(Math.sin((1 - t) * th)).addScaledVector(f.n, Math.sin(t * th)).normalize(); }
    // the piece axis: of the directions across the kept half of the tangent plane, the one along which the bone itself
    // runs furthest from the cut: stepping along the direction, bone must stay within the column under the step point
    // (up to 14 mm below the surface along the normal, a little to either side). At the angle of the jaw this is up
    // the ramus, where the local PCA axis (body and ramus in one ball) points anywhere between; on a curved jaw it is
    // along the arch (a run up the alveolar face to the teeth ends at the crest, a run across the surface from a cut
    // placed obliquely ends where the bone turns under)
    // (the search starts square to the cut, into the kept bone: a cut proposed across the bone has the bone running on
    // along its normal; what the screws need is distance from the cut on bone, so each direction scores the run times
    // its component along the cut normal, up to PIECE_GAIN mm (the bridge plus the far screw stage), the one nearest
    // square to the cut winning a tie: the bone turning away (up the ramus past a cut at the angle) still wins where
    // the run along the normal is short, and a long run nearly along the cut (up the chin past a cut across it) does
    // not, since it gains no distance from the slot)
    const kd = pw.N.clone().multiplyScalar(Math.sign(pw.N.dot(keepDir)) || 1);
    let k0 = kd.clone().sub(nn.clone().multiplyScalar(kd.dot(nn)));
    if (k0.lengthSq() < 1e-6) k0 = f.axis.clone().sub(nn.clone().multiplyScalar(f.axis.dot(nn)));
    if (k0.lengthSq() < 1e-6) return null;
    k0.normalize();
    const runOf = dir => {
      const side = V().crossVectors(nn, dir).normalize(); let run = 0;
      for (let st = 1; st <= 20; st++) {
        const c = q.clone().addScaledVector(dir, 2 * st); let hit = false;
        for (const sv of [0, 4, -4]) for (let t = 4; t >= -14 && !hit; t -= 1) if (boneAt(c.clone().addScaledVector(side, sv).addScaledVector(nn, t))) hit = true;
        if (!hit) break; run += 2;
      }
      return run;
    };
    let u = k0, bestRun = -1;
    for (let a = -80; a <= 80; a += 10) { const dir = k0.clone().applyAxisAngle(nn, deg(a)), run = Math.min(runOf(dir) * Math.max(0, dir.dot(kd)), PIECE_GAIN) - 0.05 * Math.abs(a); if (run > bestRun) { bestRun = run; u = dir; } }
    u = u.clone().sub(nn.clone().multiplyScalar(u.dot(nn))).normalize();
    return { P: q, u, v: V().crossVectors(nn, u), n: nn };
  }
  // angle (degrees) between the local bone axes at the first and last cut: a guide spanning the angle of the jaw (body
  // and ramus) has no single frame that fits both ends
  function cutsAngle() {
    if (!S.anchor || S.planes.length < 2) return 0;
    const pls = planesWorld().sort((a, b) => a.off - b.off), { u, n } = frameAxes();
    const fa = cutFrame(pls[0], u.clone().negate(), n), fb = cutFrame(pls[pls.length - 1], u, n);
    if (!fa || !fb) return 0;
    return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(fa.u.dot(fb.u)))));
  }
  // one call for any layout: split = 2 builds two guides, each on its own frame at its cut (body and ramus side), and
  // merges them into one mesh / one result (pieces, contact, undercut, screws; seat = the worse of the two); every other
  // layout is one buildGuide on the given frame
  let guideBuilds = 0;   // (counted for the tests: the fit's confirmed guide is not built a second time)
  async function buildGuideSet(ctx) {
    guideBuilds++;
    const g = ctx.g, pls = ctx.pls;
    if (!(g.split === 2 && pls.length >= 2)) return buildGuide(ctx);
    const sorted = pls.slice().sort((a, b) => (a.off ?? a.p.dot(ctx.u)) - (b.off ?? b.p.dot(ctx.u)));
    const A = sorted[0], B = sorted[sorted.length - 1], mid = (A.p.dot(ctx.u) + B.p.dot(ctx.u)) / 2;
    const pf = pieceFrames(), fa = pf ? pf.a : cutFrame(A, ctx.u.clone().negate(), ctx.n), fb = pf ? pf.b : cutFrame(B, ctx.u, ctx.n);
    if (!fa || !fb) return buildGuide(Object.assign({}, ctx, { g: Object.assign({}, g, { split: 1 }) }));
    const parts = [], meshes = [], infos = [], withBar = !!g.bar, defS = screwDef(), E = withBar ? resEnds() : null;
    // each piece is trimmed at the capture flange past its own slot, as the single guide with a gap is (splitGap)
    const gap = splitGap({ split: 1 }, [A, B]);
    for (const [fr, side] of [[fa, -1], [fb, 1]]) {
      // this piece: the cuts and screws on its side of the defect middle
      const myPls = pls.filter(p => Math.sign(p.p.dot(ctx.u) - mid) === side || sorted.length === 2 && p === (side < 0 ? A : B));
      const myScs = ctx.scs.filter(s => s.sc.part ? s.sc.part === side : s.entry && Math.sign(s.entry.clone().sub(ctx.P).dot(ctx.u) - mid) === side);
      const cut = side < 0 ? A : B, half = cut.w / 2 + Math.abs(cut.shift || 0);
      // extent along the piece's own u: the capture flange past the slot on the defect side, the screws on the kept side
      let reach = 10;
      for (const s of myScs) reach = Math.max(reach, (s.entry ? s.entry.clone().sub(fr.P).dot(fr.u) : s.sc.part ? s.sc.u : 0) + s.sc.D / 2 + 2);
      const back0 = half + g.flange;
      let back = back0;
      // (a longer reach behind the slot (pieceBack) lengthens the box towards the defect only: the anchor, width and
      // depth stay those of the piece's own span)
      const pieceAt = (reach, back) => {
        const L0 = Math.min(100, Math.max(16, Math.ceil(reach + back0))), cShift = (reach - back0) / 2;
        const L = back > back0 ? Math.min(100, Math.ceil(reach + back)) : L0, uc = back > back0 ? -(back - back0) / 2 : 0;
        const Pc = fr.P.clone().addScaledVector(fr.u, cShift);
        // the piece's anchor lies on the bone surface at its centre (walk down the normal), so the wrap is measured from the bone
        let Pq = null; const top = Pc.clone().addScaledVector(fr.n, 20);
        for (let t = 0; t < 70; t += 0.25) { const c = top.clone().addScaledVector(fr.n, -t); if (boneAt(c)) { Pq = c; break; } }
        const frame = { P: Pq || Pc, u: fr.u, v: fr.v, n: fr.n };
        const auto = S.gAuto || AUTO_DEFAULT, sz = ctx.field ? sizeBody(frame, ctx.field, -L0 / 2, L0 / 2, g, { W: !!auto.W, wrap: !!auto.wrap }) : { W: g.W, vc: 0, wrap: g.wrap, wrapU: null };
        return { frame, gi: Object.assign({}, g, { split: 0, L, uc, W: sz.W, vc: sz.vc, wrap: Math.min(g.wrap, sz.wrap), wrapU: sz.wrapU }) };
      };
      let { frame, gi } = pieceAt(reach, back);
      { const bk = pieceBack(cut, fr, g, gi, frame.P.clone().sub(fr.P).dot(fr.n)); if (bk > back + 0.5) { back = bk; ({ frame, gi } = pieceAt(reach, back)); } }
      // (the connecting bar's lug stands on the piece like a screw sleeve, the drill through it; when the screws leave
      // no room for it the piece reaches a lug's width further along its kept bone)
      let lug = withBar ? placeLug(frame, gi, cut, myScs, E, defS, false) : null;
      if (withBar && !lug) { const w = pieceAt(reach + BAR.lugD + 1, back), l2 = placeLug(w.frame, w.gi, cut, myScs, E, defS, false); if (l2) { ({ frame, gi } = w); lug = l2; } }
      if (withBar && !lug) lug = placeLug(frame, gi, cut, myScs, E, defS, true);
      const o = await buildGuide(Object.assign({}, ctx, frame, { g: gi, pls: myPls, scs: lug ? myScs.concat([lug]) : myScs, gap }));
      const li = lug && o.result.screwInfo.find(i => i.s === lug);
      parts.push({ frame, g: gi, pls: myPls, scs: myScs, gap, result: o.result, grid: o.grid, wrapProfile: o.result.wrapProfile, side, lug, lugOk: !!(li && li.ok) });
      meshes.push(o.mesh); infos.push(...o.result.screwInfo);
    }
    // merged mesh (two bodies), screws back in their original order, the seat as the worse of the two pieces
    const mesh = mergeMeshes(meshes, mat(COLORS.guide));
    const screwInfo = ctx.scs.map(s => infos.find(i => i.s === s) || { s, ok: false, noBody: true });
    const seats = parts.map(p => p.result.seat).filter(Boolean);
    let seat = null;
    if (seats.length === 2 && seats.every(s => s.ok)) {
      const worse = seats[0].free <= seats[1].free ? seats[0] : seats[1];
      seat = Object.assign({}, worse, { free: Math.min(seats[0].free, seats[1].free), worstSlide: seats.reduce((a, b) => (b.worstSlide.r < a.worstSlide.r ? b : a)).worstSlide, worstRot: seats.reduce((a, b) => (b.worstRot.r < a.worstRot.r ? b : a)).worstRot, parts: seats });
    } else if (seats.length) seat = seats.find(s => s.ok) || seats[0];
    const sum = k => parts.reduce((s, p) => s + p.result[k], 0);
    const result = { pieces: sum('pieces'), contact: sum('contact'), undercut: sum('undercut'), volume: sum('volume'), screwInfo, pls, seat, wrapProfile: parts[0].wrapProfile, parts, ms: sum('ms'), T: parts[0].result.T };
    // the connecting bar: a separate part, built only for the guide that is shown (the fit ladder asks for the route only)
    let barMesh = null;
    if (withBar) { result.bar = barPlan(parts, g); if (result.bar.ok && !ctx.noBarMesh) barMesh = buildBarMesh(result.bar.spec, 0.4); }
    return { mesh, result, barMesh, grid: Object.assign(parts[0].grid, { parts: parts.map(p => p.grid) }) };
  }
  // how far a piece reaches behind its cut point (along -u, into the defect) so that the slot runs out through both
  // edges of its body and the capture flange past it is whole: a stump on the curve of the chin has its cut oblique to
  // the piece axis, and a body ending square to u there cuts the slot off at a corner and leaves the part past the slot
  // a loose second body (the rib along the body edge never crosses the slot). Measured over the bone top and the rib
  // (deeper down the flange past the slot hangs from it); the flange planes of the gap trim the longer body back to the
  // flange. fr: the cut frame; dn: the piece anchor's height above it; at most PIECE_BACK_MAX mm.
  function pieceBack(cut, fr, g, gi, dn) {
    const pc = cut.pSlot || cut.p, keep = Math.sign(fr.P.clone().sub(pc).dot(cut.N)) || 1, Nd = cut.N.clone().multiplyScalar(-keep);
    const a = Nd.dot(fr.u), b = Nd.dot(fr.v), c = Nd.dot(fr.n), e = pc.clone().sub(fr.P).dot(Nd), t = cut.w / 2 + g.flange, vc = gi.vc || 0;
    let back = cut.w / 2 + Math.abs(cut.shift || 0) + g.flange;
    if (a > -0.2) return back;
    for (const vv of [vc - gi.W / 2, vc + gi.W / 2]) for (const nn of [dn, dn + g.clear + g.wall + g.bridge]) back = Math.max(back, (b * vv + c * nn - t - e) / a);
    return Math.min(back, PIECE_BACK_MAX);
  }
  function mergeMeshes(meshes, material) {
    let np = 0, ni = 0;
    meshes.forEach(m => { np += m.geometry.attributes.position.count; ni += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count; });
    const pos = new Float32Array(np * 3), idx = new Uint32Array(ni); let po = 0, io = 0;
    for (const m of meshes) {
      const p = m.geometry.attributes.position.array, c = m.geometry.attributes.position.count, ix = m.geometry.index && m.geometry.index.array;
      pos.set(p, po * 3);
      if (ix) for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + po; else for (let i = 0; i < c; i++) idx[io + i] = i + po;
      io += ix ? ix.length : c; po += c; m.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeVertexNormals();
    return new THREE.Mesh(geo, material);
  }
  // two binary STL buffers -> one (the production STL of a two-frame guide comes from two server calls)
  function mergeStl(a, b) {
    const ca = new DataView(a.buffer, a.byteOffset).getUint32(80, true), cb = new DataView(b.buffer, b.byteOffset).getUint32(80, true);
    const out = new Uint8Array(84 + (ca + cb) * 50); out.set(a.subarray(0, 84)); new DataView(out.buffer).setUint32(80, ca + cb, true);
    out.set(a.subarray(84, 84 + ca * 50), 84); out.set(b.subarray(84, 84 + cb * 50), 84 + ca * 50);
    return out;
  }
  // ---------- connecting bar between the two guides of a long resection (split 2 with g.bar) ----------
  // Each piece carries a lug: a boss like a screw sleeve (BAR.lugD wide, one millimetre higher than the screw sleeves),
  // towards the piece's inferior edge on its kept side of the slot, with a drill through it (a lug's width more piece
  // when the screws leave no room; round a screw sleeve as a last resort). The bar is a separate part: a pad on
  // each lug (the same hole through it) and a rod of radius BAR.r between the pads. The rod runs below the jaw where it
  // can (inferior), else beside or behind it, buccally only when nothing else is free, always clear of the whole bone (the
  // bar goes on before the cuts, so the resected piece is still there) and of both guide pieces. Pinned or screwed
  // through the pads before the cuts it holds the two stumps where they are; it comes off after the cuts. The server
  // builds the same bar from the same spec (path, radius, pads) with exact solids (yolmed_server.build_bar).
  const BAR = { r: 2, padR: 3.5, padT: 4, gap: 0.3, lugD: 7, clearBone: 1.5, clearGuide: 0.8, maxD: 60, color: 0xc08a2e };
  function placeLug(fr, gi, cut, scs, E, def, onScrew = true) {
    const R = BAR.lugD / 2, H = def.sleeveH + 1, sInf = -(Math.sign(fr.v.z) || 1), vc = gi.vc || 0;
    const uc = gi.uc || 0, body = screwBodyOn(fr, uc - gi.L / 2, uc + gi.L / 2, gi.W, vc, gi.wrap, gi.wrapU, 0); if (!body) return null;
    const pc = cut.pSlot || cut.p, keep = Math.sign(fr.P.clone().sub(pc).dot(cut.N)) || 1;
    const ents = scs.filter(s => s.entry).map(s => { const q = s.entry.clone().sub(fr.P); return { uu: q.dot(fr.u), vv: q.dot(fr.v), R: s.sc.D / 2, r: s.sc.d / 2 }; });
    // candidates over the whole piece on its kept side of the slot: the inferior lanes first, then the farther from the
    // slot (the more bone under the lug). The lug may merge with a screw sleeve (both are part of the guide; the lug is a
    // millimetre higher, so the pad above it clears the sleeve) but each drill hole stays outside the other boss.
    const cands = [], half = gi.W / 2 - R - 1.5;
    for (let vv = vc - half; vv <= vc + half + 1e-6; vv += 1) for (let uu = uc - gi.L / 2 + R + 0.5; uu <= uc + gi.L / 2 - R - 0.5 + 1e-6; uu += 1) {
      const q = fr.P.clone().addScaledVector(fr.u, uu).addScaledVector(fr.v, vv), sd = q.clone().sub(pc).dot(cut.N) * keep;
      if (sd - cut.w / 2 - R < SCREW_SLOT_GAP) continue;
      if (ents.some(e => Math.hypot(e.uu - uu, e.vv - vv) < Math.max(e.R + def.d / 2, R + e.r) + 0.8)) continue;
      cands.push({ uu, vv, cost: -Math.round(sInf * (vv - vc)) * 100 - Math.min(sd, 30) });
    }
    cands.sort((a, b) => a.cost - b.cost);
    for (const { uu, vv } of cands) {
      const top = fr.P.clone().addScaledVector(fr.u, uu).addScaledVector(fr.v, vv).addScaledVector(fr.n, 20);
      let entry = null; for (let t = 0; t < 60; t += 0.2) { const q = top.clone().addScaledVector(fr.n, -t); if (boneAt(q)) { entry = q; break; } }
      if (!entry || !onBody(body, uu, vv, entry.clone().sub(fr.P).dot(fr.n))) continue;
      if (entry.clone().sub(pc).dot(cut.N) * keep - cut.w / 2 - R < SCREW_SLOT_GAP) continue;
      if (E && resectedAt(entry, E, 2)) continue;
      if (!padRoom(entry, fr.n, H, false, gi)) continue;
      return { sc: { d: def.d, D: BAR.lugD, sleeveH: H, len: 0, lug: true }, dir: fr.n.clone().negate(), entry, uu, vv };
    }
    // no free spot: the lug goes round a screw sleeve of the piece (same axis, a millimetre higher), the one whose pad
    // has the most room around it, then the most inferior; the guide screw there passes through the bar's pad as well
    const host = onScrew && scs.filter(sc => sc.entry && sc.dir).map(sc => { const q = sc.entry.clone().sub(fr.P); return { sc, uu: q.dot(fr.u), vv: q.dot(fr.v), room: padRoom(sc.entry, sc.dir.clone().negate(), Math.max(H, sc.sc.sleeveH + 1), true, gi) }; })
      .filter(h => !(E && resectedAt(h.sc.entry, E, 2))).sort((x, y) => Math.min(y.room, 6) - Math.min(x.room, 6) || sInf * (y.vv - x.vv))[0];
    if (host) return { sc: { d: host.sc.sc.d, D: Math.max(BAR.lugD, host.sc.sc.D + 2), sleeveH: Math.max(H, host.sc.sc.sleeveH + 1), len: 0, lug: true, onScrew: true }, dir: host.sc.dir.clone(), entry: host.sc.entry.clone(), uu: host.uu, vv: host.vv };
    return null;
  }
  // room for the bar's pad above a lug at `entry` (sleeve height H, axis `ax` out of the bone): the bone distance at the
  // pad centre; as a test, enough for the pad and a rod leaving it (BAR.padR + BAR.r + BAR.clearBone)
  function padRoom(entry, ax, H, value, g = S.g) {
    const cw = g.clear + (g.peri || 0) + g.wall, d = boneDist(entry.clone().addScaledVector(ax, cw + H + BAR.gap + BAR.padT / 2));
    return value ? d : d >= BAR.padR + BAR.r + BAR.clearBone;
  }
  // distance (mm) from a point to the nearest bone voxel of the whole planning bone (resected piece included), from one
  // distance transform of the work mask per segmentation
  let bdCache = { mask: null, d: null };
  function boneDist(q) {
    const r = S.red; if (!r || !S.mask) return Infinity;
    if (bdCache.mask !== S.mask) bdCache = { mask: S.mask, d: G.edt(S.mask, r.nx, r.ny, r.nz, r.sp) };
    const ix = G.indexOf(r, [q.x, q.y, q.z]), i = Math.round(ix[0]), j = Math.round(ix[1]), k = Math.round(ix[2]);
    if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) return Infinity;
    return bdCache.d[i + r.nx * (j + r.ny * k)] - Math.max(...r.sp) / 2;
  }
  // a guide voxel of either piece within rad of q (the pieces' own grids, a ball of 15 probes)
  const BALL = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], ...[[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]].map(a => a.map(x => x / Math.sqrt(3)))];
  function guideNear(q, rad, grids) {
    for (const gr of grids) {
      const d = q.clone().sub(gr.P), x = d.dot(gr.u), y = d.dot(gr.v), z = d.dot(gr.n);
      for (const b of BALL) {
        const i = Math.round((x + b[0] * rad - gr.lo[0]) / gr.h), j = Math.round((y + b[1] * rad - gr.lo[1]) / gr.h), k = Math.round((z + b[2] * rad - gr.lo[2]) / gr.h);
        if (i >= 0 && j >= 0 && k >= 0 && i < gr.nx && j < gr.ny && k < gr.nz && gr.Gm[i + gr.nx * (j + gr.ny * k)]) return true;
      }
    }
    return false;
  }
  // the rod's path between the two pads: straight when that is free, else out from both pads by d mm along one
  // direction across the chord, across, and back; of the free paths the cheapest (length, plus a penalty for passing
  // buccally over the defect or over the teeth). Returns { path, w, d, route, clear } or null.
  function barRoute(pads, grids, cw) {
    // the rod meets each pad near its top (the attach point; the pad centre for a pad of the usual height)
    const att = p => p.c.clone().addScaledVector(p.axis, Math.max(0, p.T / 2 - BAR.r - 0.2));
    const PA = att(pads[0]), PB = att(pads[1]), ch = PB.clone().sub(PA), len = ch.length(); if (len < 2) return null;
    const e1 = ch.clone().divideScalar(len), upW = V(0, 0, 1);
    let a = upW.clone().addScaledVector(e1, -e1.z); if (a.lengthSq() < 1e-4) a = V(1, 0, 0).addScaledVector(e1, -e1.x); a.normalize();
    const b = V().crossVectors(e1, a), outW = pads[0].axis.clone().add(pads[1].axis).normalize();
    const needB = BAR.r + BAR.clearBone, needG = BAR.r + BAR.clearGuide, nearG = cw + 12 + BAR.r;
    // the rod ends on each pad's rim, towards the next point of the path (the hole in the middle stays free)
    const rim = (p, next) => { const a = att(p); let t = next.clone().sub(a); t.addScaledVector(p.axis, -t.dot(p.axis)); if (t.lengthSq() < 1e-6) t = V().crossVectors(p.axis, e1); return a.addScaledVector(t.normalize(), p.hole + BAR.r + 0.4); };
    const pathOf = (w, d) => { const A1 = w ? PA.clone().addScaledVector(w, d) : PB, B1 = w ? PB.clone().addScaledVector(w, d) : PA; return w ? [rim(pads[0], A1), A1, B1, rim(pads[1], B1)] : [rim(pads[0], PB), rim(pads[1], PA)]; };
    const free = path => {
      let minB = Infinity;
      for (let s = 0; s + 1 < path.length; s++) {
        const p0 = path[s], seg = path[s + 1].clone().sub(p0), sl = seg.length(), n = Math.max(1, Math.ceil(sl / 0.5));
        for (let k = 0; k <= n; k++) {
          const q = p0.clone().addScaledVector(seg, k / n);
          if (q.distanceTo(PA) < BAR.padR + 0.5 || q.distanceTo(PB) < BAR.padR + 0.5) continue;
          const db = boneDist(q); if (db < needB) return -1;
          minB = Math.min(minB, db);
          if (db < nearG && guideNear(q, needG, grids)) return -1;
        }
      }
      return minB;
    };
    let best = null;
    const consider = (w, d) => {
      const path = pathOf(w, d), c = free(path); if (c < 0) return false;
      let L = 0; for (let s = 0; s + 1 < path.length; s++) L += path[s].distanceTo(path[s + 1]);
      const cost = L + (w ? 30 * Math.max(0, w.dot(outW) - 0.3) + 40 * Math.max(0, w.dot(upW) - 0.3) : 0);
      if (!best || cost < best.cost) best = { path, w, d, cost, len: L, clear: c - BAR.r };
      return true;
    };
    consider(null, 0);
    for (let k = 0; k < 12; k++) {
      const ph = k * Math.PI / 6, w = a.clone().multiplyScalar(-Math.cos(ph)).addScaledVector(b, Math.sin(ph));   // k = 0: inferior
      for (let d = 4; d <= BAR.maxD; d += 2) if (consider(w, d)) break;
    }
    if (!best) return null;
    const w = best.w, route = !w ? 'direct' : w.z < -0.5 ? 'inferior' : w.dot(outW) > 0.5 ? 'buccal' : w.z > 0.5 ? 'superior' : w.dot(outW) < -0.5 ? 'lingual' : 'side';
    return { path: best.path, w, d: best.d, len: best.len, route, clear: best.clear };
  }
  // the bar of a two-piece layout: pads on both lugs, the rod's route; ok only when both lugs stand on their piece
  function barPlan(parts, g) {
    const out = { ok: false, why: null, lugs: parts.map(p => !!p.lugOk) };
    if (parts.length !== 2) { out.why = 'pieces'; return out; }
    if (!parts.every(p => p.lug && p.lugOk)) { out.why = 'lug'; return out; }
    const cw = g.clear + (g.peri || 0) + g.wall;
    // a pad clear of the bone: its rim and axis sampled from the bottom (on the lug) to the top
    const padFree = pd => {
      const a = Math.abs(pd.axis.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), e1 = V().crossVectors(pd.axis, a).normalize(), e2 = V().crossVectors(pd.axis, e1);
      for (let h = -pd.T / 2; h <= pd.T / 2 + 1e-6; h += 1) for (let k = 0; k <= 8; k++) {
        const q = pd.c.clone().addScaledVector(pd.axis, h); if (k < 8) q.addScaledVector(e1, pd.R * Math.cos(k * Math.PI / 4)).addScaledVector(e2, pd.R * Math.sin(k * Math.PI / 4));
        if (boneDist(q) < 0.5) return false;
      }
      return true;
    };
    const grids = parts.map(p => Object.assign({}, p.grid, { h: p.grid.h }));
    // the pads grow upwards (a taller pad on the same lug, part of the bar) until the rod finds a free way out of a
    // hollow between the bone and the guide
    let rt = null, pads = null, padOk = false;
    for (const ext of [0, 4, 8, 12]) {
      pads = parts.map(p => { const L = p.lug, ax = L.dir.clone().negate(), T = BAR.padT + ext; return { c: L.entry.clone().addScaledVector(ax, cw + L.sc.sleeveH + BAR.gap + T / 2), axis: ax, R: BAR.padR, T, hole: (L.sc.d + (g.fit || 0)) / 2 + 0.1 }; });
      if (!pads.every(padFree)) continue;
      padOk = true; rt = barRoute(pads, grids, cw); if (rt) break;
    }
    if (!rt) { out.why = padOk ? 'route' : 'lug'; return out; }
    return Object.assign(out, { ok: true, route: rt.route, len: rt.len, clear: rt.clear, d: rt.d, spec: { path: rt.path, r: BAR.r, pads } });
  }
  // signed distance to the bar (negative inside): rod capsules and pads united, the pad holes taken out
  function barSdf(spec) {
    const segs = []; for (let i = 0; i + 1 < spec.path.length; i++) segs.push([spec.path[i], spec.path[i + 1]]);
    const pads = spec.pads.map(p => ({ c: p.c, a: p.axis.clone().normalize(), R: p.R, T: p.T, hole: p.hole }));
    return (x, y, z) => {
      let f = Infinity;
      for (const [A, B] of segs) {
        const bx = B.x - A.x, by = B.y - A.y, bz = B.z - A.z, px = x - A.x, py = y - A.y, pz = z - A.z, l2 = bx * bx + by * by + bz * bz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / l2)) : 0, dx = px - t * bx, dy = py - t * by, dz = pz - t * bz;
        f = Math.min(f, Math.sqrt(dx * dx + dy * dy + dz * dz) - spec.r);
      }
      const cyl = pads.map(p => { const dx = x - p.c.x, dy = y - p.c.y, dz = z - p.c.z, t = dx * p.a.x + dy * p.a.y + dz * p.a.z; return [Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - t * t)), t]; });
      pads.forEach((p, i) => { f = Math.min(f, Math.max(cyl[i][0] - p.R, Math.abs(cyl[i][1]) - p.T / 2)); });
      pads.forEach((p, i) => { f = Math.max(f, -Math.max(cyl[i][0] - p.hole, Math.abs(cyl[i][1]) - (p.T / 2 + 1))); });
      return f;
    };
  }
  // the bar as a closed mesh: the distance field on a grid aligned with the bar's plane, marched once (as the guide)
  function buildBarMesh(spec, h = 0.4) {
    const P0 = spec.path[0], P1 = spec.path[spec.path.length - 1], e1 = P1.clone().sub(P0).normalize();
    let e2 = spec.path.length > 2 ? spec.path[1].clone().sub(P0) : V().crossVectors(spec.pads[0].axis, e1);
    e2.addScaledVector(e1, -e2.dot(e1)); if (e2.lengthSq() < 1e-6) e2 = Math.abs(e1.z) < 0.9 ? V(0, 0, 1).addScaledVector(e1, -e1.z) : V(1, 0, 0).addScaledVector(e1, -e1.x); e2.normalize();
    const e3 = V().crossVectors(e1, e2), m = Math.max(spec.r, ...spec.pads.map(p => Math.max(p.R, p.T / 2 + 1))) + 2 * h + 1;
    const pts = spec.path.concat(spec.pads.map(p => p.c)), co = q => { const d = q.clone().sub(P0); return [d.dot(e1), d.dot(e2), d.dot(e3)]; };
    const lo = [0, 1, 2].map(a => Math.min(...pts.map(q => co(q)[a])) - m), hi = [0, 1, 2].map(a => Math.max(...pts.map(q => co(q)[a])) + m);
    const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
    const sdf = barSdf(spec), F = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = lo[0] + i * h, b = lo[1] + j * h, c = lo[2] + k * h, id = i + nx * (j + ny * k);
      F[id] = (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) ? h : sdf(P0.x + e1.x * a + e2.x * b + e3.x * c, P0.y + e1.y * a + e2.y * b + e3.y * c, P0.z + e1.z * a + e2.z * b + e3.z * c);
    }
    const net = G.marchTets(F, nx, ny, nz, 0);
    const toW = (a, b, c) => { const x = lo[0] + a * h, y = lo[1] + b * h, z = lo[2] + c * h; return [P0.x + e1.x * x + e2.x * y + e3.x * z, P0.y + e1.y * x + e2.y * y + e3.y * z, P0.z + e1.z * x + e2.z * y + e3.z * z]; };
    return meshFromNets(net, toW, mat(BAR.color));
  }
  // the server request for the bar: its spec and the bone mask around it (the server measures the bar's clearance
  // from the full-resolution bone)
  function barRequest(spec, c) {
    const { vol } = c, arr = q => [q.x, q.y, q.z], pts = spec.path.concat(spec.pads.map(p => p.c));
    const wlo = [0, 1, 2].map(a => Math.min(...pts.map(q => arr(q)[a])) - 8), whi = [0, 1, 2].map(a => Math.max(...pts.map(q => arr(q)[a])) + 8), ix = [];
    for (const x of [wlo[0], whi[0]]) for (const y of [wlo[1], whi[1]]) for (const z of [wlo[2], whi[2]]) ix.push(G.indexOf(vol, [x, y, z]));
    const dims = [vol.nx, vol.ny, vol.nz], lo = [0, 1, 2].map(a => Math.max(0, Math.floor(Math.min(...ix.map(q => q[a]))))), hi = [0, 1, 2].map(a => Math.min(dims[a] - 1, Math.ceil(Math.max(...ix.map(q => q[a])))));
    const [nx, ny, nz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), req = { kind: 'bar', resolution: 0.2, bar: { path: spec.path.map(arr), r: spec.r, pads: spec.pads.map(p => ({ c: arr(p.c), axis: arr(p.axis), R: p.R, T: p.T, hole: p.hole })) } };
    if (nx < 2 || ny < 2 || nz < 2 || nx * ny * nz > 60e6) return req;
    const mask = new Uint8Array(nx * ny * nz), cut = c.thr == null ? 0.5 : 0.05;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (c.thr != null && vol.hu[lo[0] + i + vol.nx * (lo[1] + j + vol.ny * (lo[2] + k))] < c.thr) continue;
      if (fieldAt(c.red, c.F, G.worldOf(vol, lo[0] + i, lo[1] + j, lo[2] + k)) > cut) mask[i + nx * (j + ny * k)] = 1;
    }
    let bin = ''; for (let i = 0; i < mask.length; i += 0x8000) bin += String.fromCharCode.apply(null, mask.subarray(i, i + 0x8000));
    return Object.assign(req, { crop: { nx, ny, nz, sp: vol.sp.slice(), origin: G.worldOf(vol, ...lo), axes: vol.axes.map(q => q.slice()) }, mask_b64: btoa(bin) });
  }
  // every edit bumps ver; a built guide is shown only if it is at least as new as the one on screen
  const live = { ver: 0, shown: 0, running: false, dirty: false, planes: false, resAt: 0 };
  async function regenerate() {
    // (nothing to build yet: a rebuild scheduled before a resection region is chosen must not leave "busy" on screen)
    if (!S.anchor) { busy(false); return; }
    if (!S.guideOn) {
      // cuts only: no guide until the user asks for one
      live.shown = live.ver; S.liveScrews = null; S.result = null; S.grid = null;
      setPart('guide', null, null); setPart('bar', null, null); rebuildElementParts(planesWorld(), []); showResected();
      applyExplode(); updatePanels(); busy(false); render(); emit('parts'); emit('changed');
      return;
    }
    const ver = live.ver;
    busy(true, pipeGuide ? 'Guide üretiliyor… 4/4' : 'Guide üretiliyor…'); await sleep();
    const pls = planesWorld(), scs = screwsWorld();
    let out = takeFit();
    if (out && out.result.bar && out.result.bar.ok && S.g.bar) out.barMesh = buildBarMesh(out.result.bar.spec, 0.4);
    if (!out) out = await buildGuideSet(Object.assign({ g: S.g, P: S.anchor.p, pls, scs, bone: boneAt, field: guideField() }, frameAxes()));
    if (ver < live.shown) { disposeObj(out.mesh); if (out.barMesh) disposeObj(out.barMesh); return; }
    live.shown = ver; S.liveScrews = null;
    setPart('guide', 'Guide', out.mesh, COLORS.guide);
    setPart('bar', out.barMesh ? 'Bağlantı köprüsü' : null, out.barMesh, BAR.color);
    S.result = out.result; S.grid = out.grid; simplifyMesh(out.mesh);
    // automatic width = the width of the body that was actually built (the box only bounds it): shown in the controls
    // and used by the screw / cut checks; the lateral centre follows. Hand-set widths are left alone.
    if (S.gAuto.W && S.g.split !== 2 && out.result.bodyV && out.result.bodyW > 0) {
      const bw = Math.max(10, Math.min(40, Math.ceil(out.result.bodyW))), bc = Math.round((out.result.bodyV[0] + out.result.bodyV[1]) / 2 * 2) / 2;
      if (bw < S.g.W - 1 || Math.abs(bc - (S.g.vc || 0)) > 1) { S.g.W = Math.min(S.g.W, bw); S.g.vc = bc; if (S.autoSize) S.autoSize.bodyW = out.result.bodyW; syncGuideInputs(); }
    }
    const screwInfo = out.result.screwInfo;
    rebuildElementParts(pls, screwInfo); showResected();
    applyExplode(); updatePanels(); if (ver === live.ver) busy(false); render();
    emit('parts'); emit('changed');
  }

  // ---------- planes / screws as scene parts ----------
  function clearElementParts() { Object.keys(parts).filter(k => k.startsWith('plane') || k.startsWith('screw')).forEach(k => setPart(k, null, null)); }
  function rebuildElementParts(pls, screwInfo) {
    clearElementParts();
    pls.forEach((pw, i) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(Math.max(S.g.W, 26) * 0.8, 48), new THREE.MeshBasicMaterial({ color: COLORS.plane, transparent: true, opacity: S.sel === 'p' + i ? 0.38 : 0.2, side: THREE.DoubleSide, depthWrite: false }));
      m.position.copy(pw.p); m.quaternion.setFromUnitVectors(V(0, 0, 1), pw.N);
      setPart('plane' + i, `Kesi ${i + 1}`, m, COLORS.plane);
    });
    screwInfo.forEach((si, i) => {
      if (!si.ok) return;
      const L = si.s.sc.len, m = new THREE.Mesh(new THREE.CylinderGeometry(si.s.sc.d / 2 * 0.9, si.s.sc.d / 2 * 0.9, L, 20), mat(COLORS.screw, { emissive: S.sel === 's' + i ? 0x333333 : 0 }));
      m.position.copy(si.s.entry.clone().add(si.s.dir.clone().multiplyScalar(L / 2)));
      m.quaternion.setFromUnitVectors(V(0, 1, 0), si.s.dir.clone().negate());
      m.userData.dir = si.s.dir.clone();
      setPart('screw' + i, `Vida ${i + 1}`, m, COLORS.screw);
    });
  }
  function applyExplode() {
    if (!S.anchor) return;
    const e = S.explode, n = S.anchor.n;
    Object.values(parts).forEach(pt => {
      pt.obj.position.copy(pt.base);
      if (pt.id === 'guide') pt.obj.position.add(n.clone().multiplyScalar(e));
      if (pt.id === 'resected' || pt.id === 'lesion') pt.obj.position.add(n.clone().multiplyScalar(-0.6 * e));
      if (pt.id.startsWith('screw')) pt.obj.position.add(n.clone().multiplyScalar(e)).add(pt.obj.userData.dir.clone().multiplyScalar(-1.4 * e));
    });
  }

  // ---------- panels ----------
  function updatePanels() {
    renderParts(); renderElements(); renderMeasures(); renderChecks(); renderJSON(); renderAppr(); syncLesion();
  }
  // one scene list: visibility, opacity and isolate per part
  function setOpacity(pt, a) {
    pt.opacity = a;
    pt.obj.traverse(c => { if (!c.material) return; const m = c.material; if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity; m.opacity = m.userData.baseOpacity * a; m.transparent = m.opacity < 1; m.depthWrite = m.opacity >= 1 && m.userData.baseOpacity >= 1; m.needsUpdate = true; });
  }
  function renderParts() {
    const row = pt => { const own = partNames[partKey(pt.id)], nm = esc(own || pt.label); return `<li><label><input type="checkbox" data-p="${pt.id}" ${pt.visible ? 'checked' : ''}><i style="background:#${pt.color.toString(16).padStart(6, '0')}"></i><span class="pname" data-rn="${pt.id}" tabindex="0" title="Adını değiştirmek için çift tıklayın (F2)"${own ? ' translate="no"' : ''}>${nm}</span></label><input type="range" min="0.1" max="1" step="0.05" value="${pt.opacity ?? 1}" data-o="${pt.id}" aria-label="${nm} saydamlığı" title="Saydamlık"><button class="ghost sm" data-iso="${pt.id}" title="Yalnız bunu göster" aria-label="${nm}: yalnız bunu göster"><svg class="i"><use href="#i-eye"/></svg></button></li>`; };
    // grouped so a long list reads by role: anatomy, the cuts, the guide and its screws, the reconstruction
    const GROUPS = [['Anatomi', id => /^(bone|resected|mirror|lesion|lesionPaint|postop|ctx_|layer)/.test(id)], ['Plan', id => /^(plane|anchor)/.test(id)], ['Guide', id => /^(guide|screw)/.test(id)], ['Rekonstrüksiyon', id => /^(grafts|implants|plate)/.test(id)], ['Diğer', () => true]];
    const all = Object.values(parts), seen = new Set();
    $('parts').innerHTML = GROUPS.map(([name, test]) => { const mine = all.filter(pt => !seen.has(pt.id) && test(pt.id)); mine.forEach(pt => seen.add(pt.id)); return mine.length ? `<li class="grp">${name}</li>` + mine.map(row).join('') : ''; }).join('');
    const vis = all.filter(pt => pt.visible).map(pt => pt.id), gOnly = all.every(pt => pt.visible === (/guide/.test(pt.id) || pt.id.startsWith('screw')));
    $('showAll').setAttribute('aria-pressed', String(vis.length === all.length)); $('guideOnly').setAttribute('aria-pressed', String(!!all.length && gOnly && vis.length < all.length));
    $('parts').querySelectorAll('input[type=checkbox]').forEach(el => el.addEventListener('change', () => { const pt = parts[el.dataset.p]; pt.visible = el.checked; pt.obj.visible = el.checked; render(); }));
    $('parts').querySelectorAll('input[type=range]').forEach(el => el.addEventListener('input', () => { setOpacity(parts[el.dataset.o], +el.value); render(); }));
    $('parts').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      Object.values(parts).forEach(pt => { pt.visible = pt.id === b.dataset.iso; pt.obj.visible = pt.visible; });
      renderParts(); fitTo(parts[b.dataset.iso].obj); render();
    }));
    $('parts').querySelectorAll('[data-rn]').forEach(el => {
      el.addEventListener('dblclick', e => { e.preventDefault(); editPartName(el); });
      el.addEventListener('keydown', e => { if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); editPartName(el); } });
    });
  }
  // layer names: the user may rename any row of the layer list. The names are display labels kept with the plan
  // (PlanExt.names) but outside the plan hash and the approval stamps (web/audit.js planHash): a name moves no geometry,
  // so renaming never drops an approval. An empty name goes back to the default one.
  function renamePart(id, name) {
    const pt = parts[id]; if (!pt) return false;
    const k = partKey(id), v = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if ((partNames[k] || '') === (v === pt.label ? '' : v)) return false;
    if (!v || v === pt.label) delete partNames[k]; else partNames[k] = v;
    renderParts(); emit('changed'); return true;
  }
  const partName = id => (parts[id] ? partNames[partKey(id)] || parts[id].label : '');
  function editPartName(el) {
    const id = el.dataset.rn, pt = parts[id]; if (!pt || el.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'pname-in'; inp.maxLength = 60; inp.value = partName(id); inp.setAttribute('aria-label', xl('Katman adı'));
    let done = false;
    const end = ok => { if (done) return; done = true; if (!(ok && renamePart(id, inp.value))) renderParts(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
    inp.addEventListener('blur', () => end(true));
    inp.addEventListener('click', e => e.preventDefault());   // a click in the field does not toggle the row's checkbox
    el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
  }
  (window.PlanExt = window.PlanExt || {}).names = {
    label: 'Katman adları',
    get: () => (Object.keys(partNames).length ? Object.assign({}, partNames) : undefined),
    set(x) {
      Object.keys(partNames).forEach(k => delete partNames[k]);
      if (x && typeof x === 'object' && !Array.isArray(x)) Object.entries(x).slice(0, 200).forEach(([k, v]) => { if (typeof v === 'string' && v.trim()) partNames[String(k).slice(0, 40)] = v.trim().slice(0, 60); });
      renderParts();
    },
  };
  // a new scan starts with the default names (a reopened plan brings its own through PlanExt.names)
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring) && Object.keys(partNames).length) PlanExt.names.set(null); });
  // cuts are edited in the resection step, screws in their own step; approval happens only in the review step
  const DF = k => t => (window.DateFmt ? DateFmt[k](t) : k === 'time' ? new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleString('tr-TR'));   // dates.js: the interface language
  const apprText = o => o.ok ? `${xl('Onaylı')}${o.by ? ' · ' + esc(o.by) : ''}${o.at ? ' · ' + DF('time')(o.at) : ''}. ${xl('Değişiklik onayı kaldırır.')}` : 'Sistem önerisi; cerrah onayı İnceleme ve onay adımında verilir.';
  function renderElements() {
    const btn = (k, o, i, name) => `<button class="el ${S.sel === k + i ? 'on' : ''}" data-s="${k}${i}" aria-pressed="${S.sel === k + i}">${name} ${i + 1}<span class="dot ${o.ok ? 'ok' : ''}" title="${o.ok ? 'Onaylı' : 'Onay bekliyor'}"><span class="sr-only">${o.ok ? 'onaylı' : 'onay bekliyor'}</span></span></button>`;
    $('plList').innerHTML = S.planes.map((p, i) => btn('p', p, i, 'Kesi')).join('');
    $('scList').innerHTML = S.screws.map((s, i) => btn('s', s, i, 'Vida')).join('');
    ['plList', 'scList'].forEach(id => $(id).querySelectorAll('button').forEach(b => b.addEventListener('click', () => select(b.dataset.s))));
    const isP = S.sel && S.sel[0] === 'p', i = S.sel ? +S.sel.slice(1) : -1, o = !S.sel ? null : isP ? S.planes[i] : S.screws[i];
    $('plProps').innerHTML = S.planes.length ? '' : '<p class="hint">Henüz kesi yok.</p>';
    $('scProps').innerHTML = S.screws.length ? '' : (S.guideOn ? '<p class="hint">Vida yok.</p>' : '<p class="hint">Vidalar guide ile birlikte konur.</p>');
    if (S.sel && !o) S.sel = null;
    if (!o) return;
    const box = $(isP ? 'plProps' : 'scProps');
    const fields = isP ? [['off', 'Konum (guide ekseni boyunca)', -80, 80, 0.5, 'mm'], ['yaw', 'Yatay açı', -89, 89, 0.5, '°'], ['pitch', 'Dikey açı', -89, 89, 0.5, '°'], ['w', 'Yuva genişliği (testere + tolerans)', 0.6, 2.5, 0.1, 'mm']]
      : [['u', 'Konum (eksen boyunca)', -80, 80, 0.5, 'mm'], ['v', 'Konum (yanal)', -15, 15, 0.5, 'mm'], ['tiltU', 'Eğim (eksen yönünde)', -89, 89, 1, '°'], ['tiltV', 'Eğim (yanal)', -89, 89, 1, '°'],
         ['d', 'Matkap çapı', 1.2, 4, 0.1, 'mm'], ['D', 'Kovan dış çapı', 3, 8, 0.1, 'mm'], ['sleeveH', 'Kovan yüksekliği', 0, 12, 0.5, 'mm'], ['len', 'Vida boyu', 6, 40, 1, 'mm']];
    box.innerHTML = `<h3 class="sub">${isP ? 'Kesi' : 'Vida'} ${i + 1}</h3>` + fields.map(([k, t, mn, mx, st, unit]) => `<div class="ctl"><div class="ctl-row"><label for="f_${k}">${t}</label><output id="o_${k}">${fmt(o[k], st < 1 ? 1 : 0)} ${unit}</output></div><input type="range" id="f_${k}" min="${mn}" max="${mx}" step="${st}" value="${o[k]}"></div>`).join('') +
      `<p class="hint">${apprText(o)}</p><p class="hint more">3B görünümde kesiyi ya da vidayı tutup sürükleyebilir, tutamaçla da taşıyabilirsiniz (W taşı, E döndür).</p>` +
      `<div class="btns end"><button id="delEl" class="sm"><svg class="i"><use href="#i-trash"/></svg>${isP ? 'Kesiyi sil' : 'Vidayı sil'}</button></div>`;
    fields.forEach(([k, , , , st, unit]) => $('f_' + k).addEventListener('input', e => { o[k] = +e.target.value; if (!isP && /^(u|v|tilt)/.test(k)) o.hand = 1; unapprove(o); $('o_' + k).textContent = `${fmt(o[k], st < 1 ? 1 : 0)} ${unit}`; schedule(isP, true); }));
    $('delEl').addEventListener('click', () => { (isP ? S.planes : S.screws).splice(i, 1); S.sel = null; unapproveAll(); schedule(isP); });
  }
  function renderMeasures() {
    const R = S.result; if (!R) { $('measures').innerHTML = ''; return; }
    const { u } = frameAxes();
    // one card per cut and screw instead of four-column tables, which do not fit the panel
    const rows = R.pls.map((pw, i) => `<div class="rowcard"><b>Kesi ${i + 1}</b><span class="v">${fmt(pw.off)} mm</span><small>eğim ${fmt(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(pw.N.dot(u))))))}° · yuva ${fmt(pw.w)} mm</small></div>`).join('');
    const srows = R.screwInfo.map((si, i) => si.ok ? `<div class="rowcard"><b>Vida ${i + 1}</b><span class="v">Ø ${fmt(si.s.sc.d)} mm</span><small>kemikte ${fmt(si.inBone)} / ${fmt(si.s.sc.len)} mm · yüzey açısı ${fmt(THREE.MathUtils.radToDeg(si.s.dir.angleTo(S.anchor.n.clone().negate())))}°</small></div>` : `<div class="rowcard warn"><b>Vida ${i + 1}</b><span class="v">kemiğe ulaşmıyor</span></div>`).join('');
    const sorted = R.pls.slice().sort((a, b) => a.off - b.off);
    $('measures').innerHTML = `<h3 class="sub">Kesiler</h3><p class="hint more">Konum guide ekseni boyuncadır. Eğim kesinin guide eksenine dik konumdan sapmasıdır.</p><div>${rows || '<p class="empty">Kesi yok</p>'}</div>
      <h3 class="sub">Vidalar</h3><div>${srows || '<p class="empty">Vida yok</p>'}</div>
      <h3 class="sub">Rezeksiyon ve guide</h3>
      <dl class="kv"><dt>Rezeksiyon boyu (eksende)</dt><dd>${sorted.length >= 2 ? fmt(sorted.at(-1).off - sorted[0].off) + ' mm' : '–'}</dd><dt>Rezeke parça hacmi</dt><dd>${S.resectedVolume ? fmt(S.resectedVolume / 1000, 2) + ' cm³' : '–'}</dd><dt>Guide temas alanı (yaklaşık)</dt><dd>${fmt(R.contact, 0)} mm²</dd><dt>Guide hacmi</dt><dd>${fmt(R.volume / 1000, 2)} cm³</dd></dl>
      ${R.seat && R.seat.ok ? '<h3 class="sub">Takma ve stabilite</h3>' : ''}
      ${R.seat && R.seat.ok ? `<dl class="kv"><dt>Takma yönü</dt><dd>${R.seat.free ? (R.seat.best.tilt ? fmt(R.seat.best.tilt, 0) + '° eğik' : 'dik') : 'yok'}</dd><dt>Uygun yönler</dt><dd>${R.seat.free}/${R.seat.dirs.length}</dd><dt>Kayma direnci (en zayıf)</dt><dd>%${fmt(R.seat.worstSlide.r * 100, 0)}</dd><dt>Dönme direnci (en zayıf)</dt><dd>%${fmt(R.seat.worstRot.r * 100, 0)} · ${({ u: 'eksen', v: 'yanal', n: 'oturma' })[R.seat.worstRot.axis]}</dd></dl>` : ''}
      <p class="hint" style="color:var(--faint)">Hesaplama süresi ${fmt(R.ms / 1000, 1)} sn</p>`;
  }
  function renderChecks() {
    const R = S.result, out = [];
    if (!R) { $('checks').innerHTML = ''; $('checksInfo').innerHTML = ''; $('chkInfo').hidden = $('chkSum').hidden = true; return; }
    const want = S.g.split && S.planes.length >= 2 ? 2 : 1;
    // every cut slot and screw sleeve has to be on the guide body, or the guide guides nothing there
    if (S.anchor) {
      const { u, v } = frameAxes(), half = S.g.L / 2, bc = bonelessCut();
      // (two guides on their own frames: each piece is sized around its cut, the common length does not apply)
      if (S.g.split !== 2) planesWorld().forEach((pw, i) => {
        if (bc === i) return;   // a cut past the condyle meets no bone: the guide need not reach it
        const uc0 = S.g.uc || 0, un = Math.max(0.2, Math.abs(pw.N.dot(u))), ext = Math.abs(pw.off - uc0) + S.g.W / 2 * Math.abs(pw.N.dot(v)) / un;
        if (Math.abs(pw.off - uc0) > half - 1) out.push(['crit', 'Kritik', `Kesi ${i + 1} guide gövdesinin dışında (${fmt(pw.off, 1)} mm, guide ±${fmt(half, 1)} mm); guide'ı uzatın ya da iki guide seçin.`, 'p' + i]);
        else if (ext > half) out.push(['warn', 'Uyarı', `Kesi ${i + 1} yuvası guide'ın bir kenarında dışarı taşıyor; guide'ı biraz uzatın.`, 'p' + i]);
      });
      S.screws.forEach((sc, i) => {
        if (!sc) return;
        if (S.g.split !== 2 && (Math.abs(sc.u - (S.g.uc || 0)) + sc.D / 2 > half + 0.5 || Math.abs(sc.v - (S.g.vc || 0)) > S.g.W / 2)) out.push(['crit', 'Kritik', `Vida ${i + 1} guide gövdesinin dışında; guide'ı uzatın ya da vidayı içeri alın.`, 's' + i]);
      });
      // a cut through no bone guides nothing (a condylar resection: only the cut nearest the kept bone is a real cut)
      const E0 = resEnds(), realCuts = E0 && E0.condyle ? [S.planes.indexOf(E0.A.pl)] : S.planes.map((_, i) => i);
      cutMisses().forEach(i => { if (realCuts.includes(i)) out.push(['crit', 'Kritik', `Kesi ${i + 1} kemiği kesmiyor (kesi düzleminde kemik yok); kesiyi kemiğin üstüne taşıyın ya da rezeksiyon sınırını kısaltın.`, 'p' + i]); });
      // screws the automatic placement could not put anywhere, and a guide with none
      liveDrops().forEach(d => out.push(['crit', 'Kritik', (DROP_MSG[d.why] || DROP_MSG.none)(d.cut + 1), 'p' + d.cut]));
      if (S.guideOn && !S.screws.length) out.push(['crit', 'Kritik', 'Guide\'da vida yok; guide kemiğe sabitlenemez. Vida ekleyin.', 'guide']);
      // two guides: each piece is fixed on its own (the piece on the resected side of a condylar resection holds none)
      else if (S.guideOn && S.g.split === 2 && S.planes.length >= 2) {
        [-1, 1].forEach((part, k) => {
          if (E0 && E0.condyle) { const f = pieceFrames(); if (f && (part < 0 ? f.A : f.B).pl !== E0.A.pl) return; }
          if (!S.screws.some(sc => sc.part === part)) out.push(['crit', 'Kritik', `Guide ${k + 1} parçasında vida yok; o parça kemiğe sabitlenemez. Vida ekleyin ya da tek guide seçin.`, 'guide']);
        });
      }
      else if (S.guideOn && S.g.split !== 2 && S.planes.length >= 2 && !(E0 && E0.condyle)) {
        const pl = planesWorld().sort((x, y) => x.off - y.off), mid = (pl[0].off + pl[pl.length - 1].off) / 2, sides = new Set(S.screws.map(sc => Math.sign(sc.u - mid)));
        if (S.screws.length && sides.size < 2) out.push(['warn', 'Uyarı', 'Vidalar yalnız bir uçta; guide öbür uçta kemiğe sabitlenmiyor. Öbür kesinin ötesine vida ekleyin.', 'guide']);
      }
      // a cut that runs along the bone instead of across it leaves no stump face and no bone for the screws past it
      if (S.planes.length >= 2) {
        const f = pieceFrames();
        if (f) [[f.A, f.a], [f.B, f.b]].forEach(([cut, fr]) => {
          const a = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(fr.u.dot(cut.N)))));
          if (a > CUT_ALONG_DEG) out.push(['warn', 'Uyarı', `Kesi ${S.planes.indexOf(cut.pl) + 1} kemik boyunca uzanıyor (kemiğin yönüne ${fmt(a, 0)}° eğik); güdükte vida için kemik kalmaz. Kesiyi kemiğe dik çevirin ("Kesileri aralık + güvenlik payına göre koy" kesileri kemiğe dik önerir).`, 'p' + S.planes.indexOf(cut.pl)]);
        });
      }
      // graft-to-stump gap at each end: the half slot the saw takes from the stump (0 when the kerf lies on the resected side)
      const E = resEnds();
      if (E) {
        const ends = [E.A].concat(E.B && !E.B.virtual ? [E.B] : []), g1 = fmt(stumpGap(ends[0])), g2 = ends[1] ? fmt(stumpGap(ends[1])) : null, mx = Math.max(...ends.map(stumpGap));
        // literature: gaps of ~2.5 mm went with non-union (1.3 mm healed); > 1 mm a warning, >= 2.5 mm critical
        if (mx >= 2.5) out.push(['crit', 'Kritik', g2 == null ? `Greft ile güdük arasında planlı aralık ${g1} mm (hata eşiği 2,5 mm); kaynamama riski. Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.` : `Greft ile güdük arasında planlı aralık: kesi 1 ucunda ${g1} mm, kesi 2 ucunda ${g2} mm (hata eşiği 2,5 mm); kaynamama riski. Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.`, 'guide']);
        else if (mx > 1.0) out.push(['warn', 'Uyarı', g2 == null ? `Greft ile güdük arasında planlı aralık ${g1} mm (eşik 1,0 mm). Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.` : `Greft ile güdük arasında planlı aralık: kesi 1 ucunda ${g1} mm, kesi 2 ucunda ${g2} mm (eşik 1,0 mm). Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.`, 'guide']);
        else if (S.g.kerfSide) out.push(['info', 'Bilgi', g2 == null ? `Greft ile güdük arasında planlı aralık: kesi ucunda ${g1} mm (testere payı rezeke tarafta).` : `Greft ile güdük arasında planlı aralık: kesi 1 ucunda ${g1} mm, kesi 2 ucunda ${g2} mm (testere payı rezeke tarafta).`, 'guide']);
        else out.push(['info', 'Bilgi', g2 == null ? `Greft ile güdük arasında planlı aralık: kesi ucunda ${g1} mm (testere payı kesi düzlemine ortalı).` : `Greft ile güdük arasında planlı aralık: kesi 1 ucunda ${g1} mm, kesi 2 ucunda ${g2} mm (testere payı kesi düzlemine ortalı).`, 'guide']);
      }
      // the automatic body size and the fit ladder: what was measured and what was tried
      const az = S.autoSize;
      if (az && S.gAuto.W && S.gAuto.wrap) out.push(['info', 'Bilgi', `Guide gövdesi kemiğe göre boyutlandı: kemik yüksekliği ${fmt(az.height, 0)} mm → genişlik ${fmt(S.g.W, 0)} mm, en geniş düzeye derinlik ${fmt(az.depth, 1)} mm → sarma ${fmt(S.g.wrap, 1)} mm (${az.n} kesit).`, 'guide']);
      else if (az && S.gAuto.W) out.push(['info', 'Bilgi', `Guide gövdesi kemiğe göre boyutlandı: kemik yüksekliği ${fmt(az.height, 0)} mm → genişlik ${fmt(S.g.W, 0)} mm (${az.n} kesit).`, 'guide']);
      else if (az && S.gAuto.wrap) out.push(['info', 'Bilgi', `Guide sarması kemiğe göre seçildi: en geniş düzeye derinlik ${fmt(az.depth, 1)} mm → sarma ${fmt(S.g.wrap, 1)} mm (${az.n} kesit).`, 'guide']);
      // the insertion direction the body was built for (per piece in the two-guide layout), the bone surface left in
      // its shadow, islands dropped from the footprint and the width of the body that was actually built
      const sdParts = R.parts ? R.parts.map(p => p.result) : [R];
      sdParts.forEach((pr, i) => {
        const sd = pr.seatDir; if (!sd) return;
        const many = sdParts.length > 1, k = i + 1, tot = sd.visible + sd.hidden, hid = fmt(tot > 0 ? 100 * sd.hidden / tot : 0, 0), bw = fmt(pr.bodyW || 0, 0), tl = fmt(sd.tilt, 0), azm = fmt(sd.az, 0);
        out.push(['info', 'Bilgi', many
          ? (sd.tilt ? `Guide ${k} gövdesi takma yönüne göre kuruldu: ${tl}° eğik (azimut ${azm}°); kemik yüzeyinin %${hid}'i bu yönde gölgede kalıyor (gövde oraya girmiyor). Kurulan gövde genişliği ${bw} mm.` : `Guide ${k} gövdesi takma yönüne göre kuruldu: oturma normaline dik; kemik yüzeyinin %${hid}'i bu yönde gölgede kalıyor (gövde oraya girmiyor). Kurulan gövde genişliği ${bw} mm.`)
          : (sd.tilt ? `Guide gövdesi takma yönüne göre kuruldu: ${tl}° eğik (azimut ${azm}°); kemik yüzeyinin %${hid}'i bu yönde gölgede kalıyor (gövde oraya girmiyor). Kurulan gövde genişliği ${bw} mm.` : `Guide gövdesi takma yönüne göre kuruldu: oturma normaline dik; kemik yüzeyinin %${hid}'i bu yönde gölgede kalıyor (gövde oraya girmiyor). Kurulan gövde genişliği ${bw} mm.`), 'guide']);
        if (pr.dropped && pr.dropped.length) { const nd = pr.dropped.length, ad = fmt(pr.dropped.reduce((a, b) => a + b, 0), 0); out.push(['info', 'Bilgi', many ? `Guide ${k} gövdesinden ${nd} küçük ada (toplam ${ad} mm², her biri 50 mm² altında) kaldırıldı: silüetin ya da kutunun dışında kalıyordu.` : `Guide gövdesinden ${nd} küçük ada (toplam ${ad} mm², her biri 50 mm² altında) kaldırıldı: silüetin ya da kutunun dışında kalıyordu.`, 'guide']); }
      });
      if (bc != null && S.planes.length >= 2 && S.g.split !== 2) {
        const pl = planesWorld().sort((x, y) => x.off - y.off), other = S.planes.indexOf((pl[0].pl === S.planes[bc] ? pl[pl.length - 1] : pl[0]).pl);
        out.push(['info', 'Bilgi', `Kesi ${bc + 1} kalan tarafında kemikle karşılaşmıyor (kondil ötesi); bütün vidalar kesi ${other + 1} tarafında, guide tek parça.`, 'guide']);
      }
      if (S.fitLog && S.fitLog.some(x => x.step !== 'screws' && x.step !== 'kept')) {
        const kept = S.fitLog.find(x => x.step === 'kept'), L = S.fitLog.filter(x => x.step !== 'screws' && x.step !== 'kept'), last = L[L.length - 1], first = L[0], n1 = L.filter(x => x.step === 'wrap').length, lo = fmt(Math.min(...L.map(x => x.wrap)), 1);
        const scFail = S.fitLog.filter(x => x.step === 'screws' && x.split !== 2), scMax = scFail.length ? Math.max(...scFail.map(x => x.screws)) : 0;
        if (scMax && last.ok && last.split === 2) out.push(['info', 'Bilgi', `Otomatik uyum: tek parça düzeninde ${scMax} vidanın altında kemik ya da guide gövdesi yoktu; iki guide düzeninde her vida kendi parçasının kemiğinde.`, 'guide']);
        const w0 = fmt(first.wrap, 1), w1 = fmt(last.wrap, 1), ang = fmt(S.fitAngle || 0, 0), fl = fmt(last.flange, 1);
        if (last.ok && last.step === 'wrap' && last.wrap < first.wrap) out.push(['info', 'Bilgi', `Otomatik uyum: sarma ${w0} mm ile takılamadı; ${w1} mm ile takılabiliyor.`, 'guide']);
        else if (last.ok && last.step !== 'wrap' && last.step !== 'long' && last.split === 2) out.push(['info', 'Bilgi', last.step === 'flange' ? `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide, her kesi kendi kemik ekseninde (eksenler arası ${ang}°), kesi ötesi kenar ${fl} mm, sarma ${w1} mm ile takılabiliyor.` : `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide, her kesi kendi kemik ekseninde (eksenler arası ${ang}°), sarma ${w1} mm ile takılabiliyor.`, 'guide']);
        else if (last.ok && last.step !== 'wrap' && last.step !== 'long') out.push(['info', 'Bilgi', last.step === 'flange' ? `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide (ortak eksen), kesi ötesi kenar ${fl} mm, sarma ${w1} mm ile takılabiliyor.` : `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide (ortak eksen), sarma ${w1} mm ile takılabiliyor.`, 'guide']);
        if (!last.ok && kept) {
          const kw = fmt(kept.wrap, 1), ks = String(kept.screws), kp = String(kept.pieces), kq = String(kept.want);
          const lay = xl(kept.split === 2 ? 'iki guide (kendi eksenlerinde)' : kept.split ? 'iki guide (ortak eksen)' : 'tek parça');
          out.push(['info', 'Bilgi', kept.pieces !== kept.want ? `Otomatik uyum: en yakın deneme tutuldu: ${lay}, sarma ${kw} mm; ${kp} parça (beklenen ${kq}), ${ks} vida sorunlu.` : kept.free === 0 ? `Otomatik uyum: en yakın deneme tutuldu: ${lay}, sarma ${kw} mm; takma yönü yok, ${ks} vida sorunlu.` : `Otomatik uyum: en yakın deneme tutuldu: ${lay}, sarma ${kw} mm; gövde oturuyor, ${ks} vida sorunlu.`, 'guide']);
        }
        if (!last.ok) out.push(['warn', 'Uyarı', L.some(x => x.step === 'flange') ? `Otomatik uyum: ${L.length} deneme (sarma ${w0} → ${lo} mm, iki guide ve kısa kenar dahil) takılabilir guide vermedi; kesileri ya da guide eksenini değiştirin.` : L.some(x => x.step !== 'wrap') ? `Otomatik uyum: ${L.length} deneme (sarma ${w0} → ${lo} mm, iki guide dahil) takılabilir guide vermedi; kesileri ya da guide eksenini değiştirin.` : `Otomatik uyum: ${L.length} deneme (sarma ${w0} → ${lo} mm) takılabilir guide vermedi; kesileri ya da guide eksenini değiştirin.`, 'guide']);
      }
    }
    if (!R.pieces) out.push(['crit', 'Kritik', 'Guide oluşmadı (boş); guide merkezini, duvar ve boşluk değerlerini kontrol edin.', 'guide']);
    if (R.pieces > want) out.push(['crit', 'Kritik', want === 1 ? `Guide ${R.pieces} parçaya bölünüyor (beklenen ${want}); köprüyü genişletin ya da kesileri taşıyın.` : `Guide ${R.pieces} parçaya bölünüyor (beklenen ${want}); her guide'ın kendi vidası ve yeterli boyu olmalı.`, 'guide']);
    if (want === 2 && R.pieces < 2) out.push(['crit', 'Kritik', 'İki guide seçili ama guide ayrılmadı; dış kesiler birbirine yaklaşıyor olabilir. Kesileri ya da guide boyunu kontrol edin.', 'guide']);
    if (want === 2) {
      const g = splitGap(S.g, R.pls), cnt = [0, 0];
      if (g) R.screwInfo.forEach((si, i) => {
        if (!si.ok) return;
        const e = si.s.entry, a = e.clone().sub(g.A.p).dot(g.A.N), b = e.clone().sub(g.B.p).dot(g.B.N);
        if (si.s.sc.part) cnt[si.s.sc.part < 0 ? 0 : 1]++;
        else if (a < 0) cnt[0]++; else if (b > 0) cnt[1]++;
        else out.push(['crit', 'Kritik', `Vida ${i + 1} iki guide arasındaki rezeksiyon boşluğunda; hiçbir guide'ı sabitlemiyor.`, 's' + i]);
      });
      // (a condylar resection: the piece on the resected side holds no screw, as above; only the kept one must)
      const Ec = resEnds(), pw2 = planesWorld().sort((x, y) => x.off - y.off), need = Ec && Ec.condyle ? [pw2[0].pl === Ec.A.pl, pw2[pw2.length - 1].pl === Ec.A.pl] : [true, true];
      if (g && ((need[0] && cnt[0] < 1) || (need[1] && cnt[1] < 1))) out.push(['crit', 'Kritik', `İki guide düzeninde her guide en az bir vidayla sabitlenmeli (şu an ${cnt[0]} + ${cnt[1]}).`, 'guide']);
    }
    const st = R.seat;
    if (st && st.ok) {
      if (!st.free) out.push(['crit', 'Kritik', `Guide hiçbir yönde takılamıyor; en iyi yönde bile ${fmt(st.best.block, 0)} mm² kemik guide'ın üstünde kalıyor. Sarma derinliğini azaltın ya da guide'ı taşıyın.`, 'guide']);
      else if (st.best.tilt > 0) out.push(['warn', 'Uyarı', `Guide dik oturtulamıyor; yalnız yaklaşık ${st.best.tilt}° eğik takılabilir (${st.free}/${st.dirs.length} yön uygun). Ameliyatta takma yönü açıklanmalı.`, 'guide']);
      const sw = st.worstSlide, along = Math.abs(sw.dir[0]) > Math.abs(sw.dir[1]);
      if (sw.r < 0.05) out.push(['warn', 'Uyarı', along ? `Vidalar takılmadan önce guide kemik ekseni boyunca kayabilir: temasın yalnız %${fmt(sw.r * 100, 0)}'i direnç gösteriyor. Belirgin bir anatomik çıkıntıya taşımayı ya da sarmayı artırmayı düşünün.` : `Vidalar takılmadan önce guide yanal yönde kayabilir: temasın yalnız %${fmt(sw.r * 100, 0)}'i direnç gösteriyor. Belirgin bir anatomik çıkıntıya taşımayı ya da sarmayı artırmayı düşünün.`, 'guide']);
      const wr = st.worstRot;
      if (wr.r < 0.05) out.push(['warn', 'Uyarı', wr.axis === 'u' ? `Guide kemik ekseni etrafında dönebilir: temasın yalnız %${fmt(wr.r * 100, 0)}'i direnç gösteriyor.` : wr.axis === 'v' ? `Guide yanal eksen etrafında dönebilir: temasın yalnız %${fmt(wr.r * 100, 0)}'i direnç gösteriyor.` : `Guide oturma ekseni etrafında dönebilir: temasın yalnız %${fmt(wr.r * 100, 0)}'i direnç gösteriyor.`, 'guide']);
    } else if (R.undercut > 4) out.push(['crit', 'Kritik', `Guide kemiğin altına sarıyor (${fmt(R.undercut, 0)} mm² alttan kesik); oturtulup çıkarılamaz. Sarma derinliğini azaltın.`, 'guide']);
    if (R.contact < 150) out.push(['warn', 'Uyarı', `Temas alanı ${fmt(R.contact, 0)} mm²; oturma belirsiz olabilir (örnek eşik 150 mm²). Sarmayı artırın ya da guide'ı daha geniş bir kemik yüzeyine taşıyın.`, 'guide']);
    R.screwInfo.forEach((si, i) => {
      if (!si.ok && si.noBody) out.push(['crit', 'Kritik', `Vida ${i + 1} altında guide gövdesi yok: kemik girişi guide'ın sarma sınırının ${fmt(Math.max(0, -(si.depth || 0)), 1)} mm altında ya da gövdenin dışında; kovan boşlukta kalırdı. Vidayı kaydırın ya da sarmayı artırın.`, 's' + i]);
      else if (!si.ok) out.push(['crit', 'Kritik', `Vida ${i + 1} kemiğe ulaşmıyor; vidayı kemiğin üstüne kaydırın.`, 's' + i]);
      else {
        if (si.crossesPlane) out.push(['crit', 'Kritik', `Vida ${i + 1} matkap yolu (Ø${fmt(si.s.sc.d)}) kesi yuvasıyla kesişiyor; vidayı yuvadan uzaklaştırın.`, 's' + i]);
        else if (si.slotGap < 0.5) out.push(['warn', 'Uyarı', `Vida ${i + 1} kovanı (Ø${fmt(si.s.sc.D)}) kesi yuvasına ${fmt(Math.max(0, si.slotGap))} mm yaklaşıyor (en az 0,5 mm); testere yoluna değebilir. Vidayı yuvadan uzaklaştırın.`, 's' + i]);
        if (si.exitAt !== null && si.exitAt < si.s.sc.len) out.push(['warn', 'Uyarı', `Vida ${i + 1} ${fmt(si.exitAt)} mm'de kemikten çıkıyor, seçilen boydan kısa; vida boyunu kısaltın ya da vidayı kaydırın.`, 's' + i]);
        // hole checks: bone along the hole, and the bone bridge between the hole and the cut (>= SCREW_CUT_GAP, our own inference)
        if (si.inBone < SCREW_MIN_DEPTH) out.push(['warn', 'Uyarı', `Vida ${i + 1} deliği boyunca yalnız ${fmt(si.inBone)} mm kemik var (en az ${SCREW_MIN_DEPTH} mm); vida tutmayabilir. Vidayı daha kalın kemiğe kaydırın.`, 's' + i]);
        if (!si.crossesPlane && Number.isFinite(si.cutGap) && si.cutGap < SCREW_CUT_GAP) out.push([si.cutGap < SCREW_CUT_WARN ? 'warn' : 'info', si.cutGap < SCREW_CUT_WARN ? 'Uyarı' : 'Bilgi', si.cutGap < SCREW_CUT_WARN ? `Vida ${i + 1} deliği kesiye ${fmt(Math.max(0, si.cutGap))} mm; ${SCREW_CUT_GAP} mm kesin kural değil, önerilen eşiktir, ${SCREW_CUT_WARN} mm altında kemik köprüsü kırılabilir. Vidayı kesiden uzaklaştırın.` : `Vida ${i + 1} deliği kesiye ${fmt(Math.max(0, si.cutGap))} mm; ${SCREW_CUT_GAP} mm önerilen bir eşiktir, kesin kural değildir. İsterseniz vidayı biraz uzaklaştırın.`, 's' + i]);
        if (si.shadowed) out.push(['warn', 'Uyarı', `Vida ${i + 1} kovanının %${fmt(si.shadowed * 100, 0)}'i takma yönünde kemiğin gölgesine girer; o kısım bırakıldı. Vidayı kaydırın ya da eğimini azaltın.`, 's' + i]);
      }
    });
    R.pls.forEach((pw, i) => R.pls.forEach((pq, j) => { if (j > i && Math.abs(pw.off - pq.off) < 3 && Math.abs(pw.N.dot(pq.N)) > 0.95) out.push(['warn', 'Uyarı', `Kesi ${i + 1} ve ${j + 1} birbirine çok yakın.`, 'p' + i]); }));
    if (window.Fibula) Fibula.checks().forEach(c => out.push([c[0], c[1], c[2], c[3] || 'fib']));
    (window.ExtraChecks || []).forEach(f => f().forEach(c => out.push(c)));
    out.push(...gateChecks());
    S.crit = out.filter(o => o[0] === 'crit').length;
    S.checkList = out.slice();
    const rank = { crit: 0, warn: 1, ok: 2 }, infos = out.filter(o => o[0] === 'info'), main = out.filter(o => o[0] !== 'info').sort((a, b) => (rank[a[0]] ?? 3) - (rank[b[0]] ?? 3));
    if (!main.length) main.push(['ok', 'Uygun', 'Tüm kontroller geçti.']);
    // the row's link is an inner element: a list item keeps its listitem role (axe "list", AR-10)
    const li = ([c, t, m, ref]) => ref ? `<li class="${c}"><div class="go" data-go="${ref}" title="İlgili öğeye git" tabindex="0" role="button"><b>${t}</b><span>${esc(m)}</span></div></li>` : `<li class="${c}"><b>${t}</b><span>${esc(m)}</span></li>`;
    const n = c => out.filter(o => o[0] === c).length;
    $('chkSum').innerHTML = n('crit') || n('warn') ? (n('crit') ? `<span class="tag crit">${n('crit')} kritik</span>` : '') + (n('warn') ? `<span class="tag warn">${n('warn')} uyarı</span>` : '') + (infos.length ? `<span class="tag">${infos.length} bilgi</span>` : '') : '';
    $('chkSum').hidden = !$('chkSum').innerHTML;
    $('checks').innerHTML = main.map(li).join('');
    $('checksInfo').innerHTML = infos.map(li).join('');
    $('chkInfoN').textContent = infos.length || '';
    $('chkInfo').hidden = !infos.length;
    // the same warnings inside the step they belong to
    const stepOf = ref => ref === 'guide' ? 'guide' : ref === 'fib' ? 'fib' : ref === 'lesion' || /^p\d/.test(ref) ? 'res' : /^s\d/.test(ref) ? 'scr' : ref === 'anat' ? 'anat' : 'data';
    document.querySelectorAll('.stepwarn').forEach(box => {
      const mine = S.checkList.filter(o => o[3] && o[0] !== 'ok' && o[0] !== 'info' && stepOf(o[3]) === box.dataset.for);
      box.innerHTML = mine.length ? `<ul class="checks">${mine.map(li).join('')}</ul>` : '';
    });
    document.querySelectorAll('.checks li > [data-go]').forEach(el => { el.addEventListener('click', () => goTo(el.dataset.go)); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(el.dataset.go); } }); });
    updateMarkers();
  }
  // Checks that hold the approval and the package back on what goes to the printer (E1, E3): a production STL the server
  // reports as not watertight or in more pieces than the layout has, and a plate whose path could not be completed
  // (plate.js: Plate.critical() when it lists its own blocking findings, else its path's `ok`)
  function gateChecks() {
    const out = [], P = S.prod && S.prod.key === prodKey() ? S.prod : null, fp = S.fib && S.fib.prod && S.fib.guide && S.fib.prod.key === S.fib.guide.key ? S.fib.prod : null;
    const bad = (P && (!P.watertight || P.bodies > (S.g.split ? 2 : 1) || (P.bar && !P.bar.watertight))) || (fp && (!fp.watertight || fp.bodies > 1));
    if (bad) out.push(['crit', 'Kritik', "Üretim STL'i su geçirmez değil ya da beklenenden fazla parçalı (guide, köprü ya da fibula guide'ı); bu dosyalar basılamaz. Guide'ı değiştirip üretim STL'ini yeniden alın.", 'guide']);
    // what the server itself refuses to call printable (P5, P6, E3): a screw it gave no sleeve and no hole, a grid
    // coarser than the preview's, an open mesh. A coarser grid that is still finer than the preview is information.
    [[P, ''], [fp, 'Fibula guide\'ı: ']].forEach(([x, pre]) => {
      if (!x || !x.issues) return;
      const n0 = out.filter(o => o[0] === 'crit').length;
      x.screwNos.forEach(n => out.push(n > 0 ? ['crit', 'Kritik', pre + `Vida ${n} üretim STL'inde yok: sunucu bu vidaya kovan ve delik açamadı. Vidayı kaydırıp üretim STL'ini yeniden alın.`, 's' + (n - 1)]
        : ['crit', 'Kritik', pre + `Bir vida (köprü bağlantısı ya da fibula vidası) üretim STL'inde yok: sunucu ona kovan ve delik açamadı. Guide'ı değiştirip üretim STL'ini yeniden alın.`, pre ? 'fib' : 'guide']));
      if (x.issues.some(i => i.code === 'not_manifold') && x.watertight !== false) out.push(['crit', 'Kritik', pre + `Sunucu üretim STL'inin ağını kapalı bulmadı (manifold dışı kenar); bu dosya basılamaz. Üretim STL'ini yeniden alın.`, pre ? 'fib' : 'guide']);
      const co = x.issues.find(i => i.code === 'resolution_coarsened');
      if (co) out.push(co.coarser_than_preview ? ['crit', 'Kritik', pre + `Üretim STL'inin ızgarası ${fmt(co.used_mm, 2)} mm'ye kabalaştırıldı (istenen ${fmt(co.requested_mm, 2)} mm); önizlemeden kaba, delik ve yuvalar planı tutmayabilir. Guide'ı küçültüp üretim STL'ini yeniden alın.`, pre ? 'fib' : 'guide']
        : ['info', 'Bilgi', pre + `Üretim STL'inin ızgarası ${fmt(co.used_mm, 2)} mm'ye kabalaştırıldı (istenen ${fmt(co.requested_mm, 2)} mm); önizlemeden yine ince.`, pre ? 'fib' : 'guide']);
      // anything else the server counts against printing, said once
      if (x.productionOk === false && !bad && out.filter(o => o[0] === 'crit').length === n0) out.push(['crit', 'Kritik', pre + `Sunucu üretim STL'ini basılabilir bulmadı; üretim STL'ini yeniden alın.`, pre ? 'fib' : 'guide']);
    });
    if (window.Plate && Plate.params && Plate.params().on && typeof Plate.critical !== 'function') {
      const pl = Plate.get && Plate.get();
      if (pl && pl.ok === false) out.push(['crit', 'Kritik', 'Plak hattı kalan kemik boyunca tamamlanamadı (kemik yüzeyinden çıktı ya da kendi üstüne döndü); bu plak onaylanamaz ve pakete girmez. Plak yüksekliğini ya da uzantısını değiştirin veya plak planını kapatın.', 'guide']);
    }
    return out;
  }
  function renderJSON() {
    if (!S.anchor) { $('json').textContent = ''; return; }
    const r2 = x => Math.round(x * 100) / 100, vv = q => [r2(q.x), r2(q.y), r2(q.z)];
    $('json').textContent = JSON.stringify({ guide_merkezi_mm: vv(S.anchor.p), oturma_yonu: vv(S.anchor.n), guide: S.g,
      lezyon: S.lesion, kesiler: S.planes, vidalar: S.screws }, null, 2);
  }
  function pending() {
    const p = [];
    if (!S.lesion.ok) p.push('Rezeksiyon aralığı');
    S.planes.forEach((o, i) => { if (!o.ok) p.push(`Kesi ${i + 1}`); });
    S.screws.forEach((o, i) => { if (!o.ok) p.push(`Vida ${i + 1}`); });
    if (window.Fibula && Fibula.active() && !Fibula.approved()) p.push('Fibula planı');
    (window.PendingHooks || []).forEach(f => { try { f().forEach(x => p.push(x)); } catch (e) { /* optional gate */ } });
    return p;
  }
  const initials = n => (n || '').split(/\s+/).filter(w => w && !/^(dr|prof|doç|doc|op|uzm)\.?$/i.test(w)).map(w => w[0].toLocaleUpperCase('tr-TR')).slice(0, 2).join('') || '?';
  const badge = o => o.ok ? `<span class="badge" title="${esc(o.by || '')}${o.at ? ' · ' + DF('dateTime')(o.at) : ''}"><span class="ini">${esc(initials(o.by))}</span>${o.at ? DF('time')(o.at) : ''}</span>` : '';
  function approveItem(ref) {
    const name = $('surgeon').value.trim();
    const o = ref === 'lesion' ? S.lesion : ref[0] === 'p' ? S.planes[+ref.slice(1)] : ref[0] === 's' ? S.screws[+ref.slice(1)] : null;
    const isOk = ref === 'fib' ? Fibula.approved() : o && o.ok;
    if (!isOk && !name) { $('apprMsg').textContent = 'Önce onaylayan cerrahın adını yazın.'; $('surgeon').focus(); return; }
    $('apprMsg').textContent = '';
    if (ref === 'fib') { if ($('fibApprove').disabled) { $('apprMsg').textContent = 'Fibula planı kritik kontrol varken ya da fibula guide\'ı hazır değilken onaylanamaz.'; return; } $('fibApprove').click(); return; }
    if (!o) return;
    if (!o.ok && (S.checkList || []).some(c => c[0] === 'crit' && c[3] === ref)) { $('apprMsg').textContent = 'Bu öğede kritik kontrol var; önce düzeltin.'; return; }
    o.ok ? unapprove(o) : stamp(o);
    renderElements(); syncLesion(); renderAppr(); renderJSON(); emit('changed');
  }
  // the package lock as renderAppr last set it: the top bar status (ui.js) reads this instead of counting on its own, so it
  // never shows "Onay bekliyor (1)" over an open package or "Onaylı plan" over a locked one; every lock change is announced
  let lock = { ready: false, pend: 0 };
  function lockNow(l) { const was = lock; lock = l; if (was.ready !== l.ready || was.pend !== l.pend) emit('lock', l); }
  function renderAppr() {
    if (!S.anchor) { $('appr').innerHTML = '<li class="sum"><span class="hint">Rezeksiyon bölgesi seçilince onaylanacak öğeler burada listelenir.</span></li>'; $('expZip').disabled = true; syncOne(); lockNow({ ready: false, pend: 0 }); return; }
    const qcCrit = S.qc.some(q => q[0] === 'crit');
    const row = (ref, name, o, sub) => `<li><button class="go" data-go="${ref}"><span class="nm">${name}</span><small>${sub || ''}</small></button><span class="act">${badge(o)} <button data-ap="${ref}">${o.ok ? 'Kaldır' : '<svg class="i"><use href="#i-check"/></svg>Onayla'}</button></span></li>`;
    const L = S.lesion, R = S.result;
    const plSub = (p, i) => `${fmt(p.off)} mm · ${fmt(p.yaw)}° / ${fmt(p.pitch)}°`;
    const scSub = (sc, i) => { const si = R && R.screwInfo[i]; return `${fmt(sc.d)} mm × ${fmt(sc.len, 0)} mm${si && si.ok ? ' · kemikte ' + fmt(si.inBone) + ' mm' : ''}`; };
    const fib = window.Fibula && Fibula.active();
    $('appr').innerHTML =
      `<li class="sum"><button class="go" data-go="data"><span class="nm">Görüntü kalitesi</span></button><span class="tag ${qcCrit ? 'crit' : 'ok'}">${qcCrit ? 'Kritik' : 'Uygun'}</span></li>` +
      row('lesion', 'Rezeksiyon aralığı', L, `${fmt(L.from)} – ${fmt(L.to)} mm, güvenlik payı ${fmt(L.margin)} mm`) +
      S.planes.map((p, i) => row('p' + i, `Kesi ${i + 1}`, p, plSub(p, i))).join('') +
      S.screws.map((sc, i) => row('s' + i, `Vida ${i + 1}`, sc, scSub(sc, i))).join('') +
      (fib ? row('fib', 'Fibula planı ve guide\'ı', { ok: Fibula.approved(), by: S.fib.plan.by, at: S.fib.plan.at }, `${S.fib.plan.n} segment`) : '') +
      `<li class="sum"><button class="go" data-go="checks"><span class="nm">Otomatik kontroller</span></button><span class="tag ${S.crit ? 'crit' : 'ok'}">${S.crit ? S.crit + ' kritik' : 'Geçti'}</span></li>`;
    $('appr').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.go)));
    $('appr').querySelectorAll('[data-ap]').forEach(b => b.addEventListener('click', () => approveItem(b.dataset.ap)));
    const missing = pending(), name = $('surgeon').value.trim();
    const ready = !missing.length && !S.crit && !qcCrit && name && S.result;
    $('expZip').disabled = !ready; syncOne(); lockNow({ ready: !!ready, pend: missing.length });
    if (S.prod && S.prod.key !== prodKey()) $('prodMsg').textContent = 'Plan değişti; üretim STL\'ini yeniden alın.';
    const why = [];
    if (!name) why.push(xl('onaylayan cerrahın adı girilmedi'));
    if (S.crit || qcCrit) why.push(xl(`${S.crit + (qcCrit ? 1 : 0)} kritik kontrol var`));
    if (missing.length) why.push(`${xl('onay bekleyen:')} ${missing.map(xl).join(', ')}`);
    $('expMsg').textContent = ready ? xl('Plan onaylı; paket hazır.') : `${xl('Paket için:')} ${[!name && xl('cerrah adı'), (S.crit || qcCrit) && xl(`${S.crit + (qcCrit ? 1 : 0)} kritik kontrol`), missing.length && xl(`${missing.length} onay`)].filter(Boolean).join(', ') || xl('guide gerekli')}. ${xl('Rapor taslak alınabilir.')}`;
    $('expMsg').title = $('expZip').title = ready ? '' : `${xl('Üretim paketi için:')} ${why.join('; ') || xl('guide henüz üretilmedi')}.`;
  }
  // ---------- navigation from checks, review rows and 3D markers to the item ----------
  const STEP_OF = { data: 'st1', anat: 'st2', lesion: 'st3', res: 'st3', fib: 'st4', guide: 'st5', scr: 'st6' };
  function refPos(ref) {
    if (!S.anchor) return null;
    if (ref === 'guide' || ref === 'lesion') return S.anchor.p.clone();
    if (/^p\d/.test(ref)) { const pw = planesWorld()[+ref.slice(1)]; return pw ? pw.p : null; }
    if (/^s\d/.test(ref)) { const sc = S.screws[+ref.slice(1)]; if (!sc) return null; const sw = screwWorld(sc); return sw.entry || null; }
    return null;
  }
  function goTo(ref) {
    if (ref === 'checks') { if (window.UI) UI.openTab('pChk'); return; }
    const step = /^p\d/.test(ref) ? 'st3' : /^s\d/.test(ref) ? 'st6' : STEP_OF[ref];
    if (step && window.UI) UI.openStep(step, true);
    if (/^[ps]\d/.test(ref)) select(ref);
    if (ref === 'fib' && window.Fibula && Fibula.active()) Fibula.setView('f');
    const q = refPos(ref);
    if (q) { const d = camera.position.clone().sub(controls.target); controls.target.copy(q); camera.position.copy(q).add(d); controls.update(); render(); }
  }
  // warning markers over the items in the 3D view
  const pv = V();
  function updateMarkers() {
    const box = $('markers'); if (!box) return;
    const list = (S.checkList || []).filter(o => (o[0] === 'crit' || o[0] === 'warn') && o[3] && refPos(o[3]));
    const worst = {}; list.forEach(o => { if (!worst[o[3]] || o[0] === 'crit') worst[o[3]] = o; });
    const showMain = !camera.layers.isEnabled(1) || S.split;
    box.innerHTML = showMain ? Object.values(worst).map(o => `<span class="mk ${o[0]}" data-go="${o[3]}" title="${esc(o[2])}">${o[3] === 'guide' ? 'Guide' : o[3][0] === 'p' ? 'Kesi ' + (+o[3].slice(1) + 1) : o[3][0] === 's' ? 'Vida ' + (+o[3].slice(1) + 1) : 'Sınır'}</span>`).join('') : '';
    box.querySelectorAll('.mk').forEach(el => {
      // the marker sits right over its item: a press on it is handed to the 3D view so the item can still be dragged
      // from there; a plain click (no movement) goes to the item as before
      el.addEventListener('pointerdown', e => { if (e.button === 0 && e.isTrusted) renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', e)); });
      el.addEventListener('click', () => { if (!dd.moved) goTo(el.dataset.go); });
    });
    placeMarkers();
  }
  function placeMarkers() {
    const box = $('markers'); if (!box || !box.children.length) return;
    const rect = renderer.domElement.getBoundingClientRect(), host = box.getBoundingClientRect(), w = S.split ? rect.width / 2 : rect.width;
    box.querySelectorAll('.mk[data-go]').forEach(el => {
      const q = refPos(el.dataset.go); if (!q) { el.hidden = true; return; }
      pv.copy(q).project(camera);
      const vis = pv.z < 1 && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1;
      el.hidden = !vis;
      el.style.left = (rect.left - host.left + (pv.x + 1) / 2 * w) + 'px'; el.style.top = (rect.top - host.top + (1 - pv.y) / 2 * rect.height - 8) + 'px';
    });
    if (window.Measure) Measure.place();
  }

  // ---------- interactions ----------
  // Live preview: cut discs and screws follow the value at once, a coarse guide (0.8 mm grid, no seating
  // analysis) is rebuilt as fast as the machine allows, and the full guide, resection and checks follow
  // once the value rests.
  let timer = null, rebuildPending = false;   // rebuildPending: a scheduled guide / resection rebuild has not finished yet
  // W25: the rebuild jobs (and "Guide oluştur") run one at a time. clearTimeout cannot stop a callback that already
  // runs, and fitWrap tries wrap / split / screw values on S.g while it waits: a second rebuild started meanwhile
  // would build (and show) a guide from those trial values. A job that finds a newer edit queued leaves the work to it.
  let jobLock = Promise.resolve();
  function exclusive(fn) { const run = jobLock.then(fn); jobLock = run.catch(() => {}); return run; }
  // resolves once no rebuild is scheduled or running (tests and callers that must read a finished state)
  async function settled() { for (let i = 0; i < 2400 && rebuildPending; i++) await new Promise(r => setTimeout(r, 25)); await jobLock; }
  let previewRaf = 0;
  function previewElements() {
    if (!previewRaf) previewRaf = requestAnimationFrame(() => { previewRaf = 0; previewNow(); });
  }
  function previewNow() {
    if (!S.anchor) return;
    emit('livePlanes');
    const pls = planesWorld(), info = S.guideOn && !S.screwRefit ? screwsWorld().map(s => ({ s, ok: !!s.entry })) : [];
    S.liveScrews = info;
    rebuildElementParts(pls, info); applyExplode(); emit('preview'); render();
  }
  function schedule(planesChanged, liveEdit) {
    live.ver++;
    if (planesChanged) live.planes = live.resDirty = true;
    if (!liveEdit) renderElements();
    previewElements();
    // while dragging only the cut discs and screws move; the resected piece and the guide follow on release
    clearTimeout(timer); rebuildPending = true;
    // an edit that dropped an approval locks the package (and turns the status from "Onaylı plan") at once, not when the
    // rebuild ends seconds later (the download itself also waits for the rebuild)
    if (!$('expZip').disabled && pending().length) renderAppr();
    timer = setTimeout(() => exclusive(async () => { if (timer !== t) return; live.jobs = (live.jobs || 0) + 1; try {
      if (live.resDirty) { live.planes = live.resDirty = false; busy(true, 'Rezeksiyon güncelleniyor…'); await sleep(); await rebuildResection(); }
      if (S.screwRefit) { S.screwRefit = false; if (S.guideOn && S.anchor) { placeScrews(); S.sel = null; renderElements(); } }
      await regenerate();
      // after a re-fit the message says what the final guide does, not what the trial builds did
      if (S.fitReport) {
        const f = S.fitReport, R = S.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1; S.fitReport = null;
        const ok = R && R.pieces === want && !(R.seat && R.seat.ok && !R.seat.free);
        if ($('guideStat')) $('guideStat').textContent = ok ? (f.split ? `Guide yeni konuma göre yeniden şekillendi (sarma ${fmt(S.g.wrap, 1)} mm, iki parça).` : `Guide yeni konuma göre yeniden şekillendi (sarma ${fmt(S.g.wrap, 1)} mm).`) : 'Bu konumda guide kemiğe takılamıyor; açıyı ya da konumu değiştirin veya sarma derinliğini düşürün.';
      }
      // a new angle or size: the guide is re-formed to seat on the bone where it now lies (wrap depth, one or two pieces)
      if (S.refit) {
        S.refit = false;
        const R = S.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1;
        if (S.guideOn && R && (R.pieces !== want || (R.seat && R.seat.ok && !R.seat.free) || floatingScrews(R).length)) {
          busy(true, 'Guide yeni açıda kemiğe oturtuluyor…'); await sleep();
          const f = await fitWrap(); if (f) S.fitReport = f;
          // what the fit could not mend: a placed screw the built guide has no body under is removed and reported
          if (dropFloating()) await regenerate();
        } else if (S.guideOn && R && $('guideStat')) $('guideStat').textContent = 'Guide yeni konumda kemiğe oturuyor.';
      }
    } finally { if (timer === t) rebuildPending = false; } }), liveEdit ? 400 : 120);
    const t = timer;
  }
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', async e => {
    const usedGizmo = gz.used; gz.used = false;
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || usedGizmo) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const rw = S.split ? rect.width / 2 : rect.width;
    if (e.clientX - rect.left > rw) return;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    if (window.SegEdit && SegEdit.tool()) return;
    if (window.Lesion && Lesion.active()) return;
    if (window.Masks && Masks.tool()) return;
    if (!camera.layers.isEnabled(0)) return;   // fibula-only view: Fibula handles the clicks
    if (window.Tools && Tools.click(e, ray)) return;
    if (S.mode === 'orbit') {
      // click a screw or a cut disc to select it (screws first: they sit inside the discs)
      const els = Object.values(parts).filter(pt => pt.visible && /^(screw|plane)\d/.test(pt.id));
      const hits = ray.intersectObjects(els.map(pt => pt.obj), false);
      const h = hits.find(x => els.find(pt => pt.obj === x.object).id.startsWith('screw')) || hits[0];
      if (h) { const id = els.find(pt => pt.obj === h.object).id; select((id.startsWith('screw') ? 's' : 'p') + id.replace(/\D/g, '')); return; }
      // the guide body: select it to turn it with the ring
      const gh = parts.guide && parts.guide.visible && S.guideOn && ray.intersectObject(parts.guide.obj, true)[0];
      if (gh) { if (S.sel) select(null); S.guideSel = true; syncGizmo(); emit('guideSel', true); }
      else if (S.guideSel) { S.guideSel = false; syncGizmo(); emit('guideSel', false); }
      return;
    }
    const hit = ray.intersectObjects(pickTargets(), false)[0];
    if (hit) pickHit(hit);
  });
  const pickTargets = () => ['bone', 'resected', 'guide'].filter(k => parts[k] && parts[k].visible).map(k => parts[k].obj);
  // Keyboard alternative to the click in the region / screw modes (AR-7, WCAG 2.1.1): the focused 3D view turns with
  // the arrow keys (ui.js); Enter takes the surface under the middle of the view (the ring marks it). A miss right in
  // the middle looks outward in small rings (a U-shaped jaw is open at its centre) before it gives up.
  function centreHit() {
    const t = pickTargets(); if (!t.length) return null;
    for (let r = 0; r <= 0.3001; r += 0.03) for (let a = 0, n = r ? 16 : 1; a < n; a++) {
      mouse.set(r * Math.cos(2 * Math.PI * a / n), r * Math.sin(2 * Math.PI * a / n)); ray.setFromCamera(mouse, camera);
      const h = ray.intersectObjects(t, false)[0]; if (h) return h;
    }
    return null;
  }
  renderer.domElement.addEventListener('keydown', e => {
    if ((e.key !== 'Enter' && e.key !== ' ') || (S.mode !== 'anchor' && S.mode !== 'screw') || e.ctrlKey || e.metaKey || e.altKey || !camera.layers.isEnabled(0)) return;
    e.preventDefault();
    const h = centreHit();
    if (h) pickHit(h); else alertMsg('Görünümün ortasında kemik ya da guide yok; görünümü ok tuşlarıyla çevirip yeniden deneyin.');
  });
  function pickHit(hit) {
    if (S.mode === 'anchor') {
      const nrm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (nrm.dot(ray.ray.direction) > 0) nrm.negate();
      setAnchor(hit.point.clone(), nrm);
      setMode('orbit'); suggest();
      if (S.autoAfter) { S.autoAfter = false; autoPrep(); }
    } else if (S.mode === 'screw' && S.anchor) {
      const { u, v } = frameAxes(), d = hit.point.clone().sub(S.anchor.p);
      const sc = Object.assign({ u: Math.round(d.dot(u) * 2) / 2, v: Math.round(d.dot(v) * 2) / 2, tiltU: 0, tiltV: 0, ok: false, hand: 1 }, screwDef());
      // two guides: the screw holds the piece on its side of the defect and is written in that piece's frame
      if (S.g.split === 2 && S.planes.length >= 2) { const pl = planesWorld().sort((x, y) => x.off - y.off); reframe(sc, Math.sign(sc.u - (pl[0].off + pl[pl.length - 1].off) / 2) || 1); }
      S.screws.push(sc);
      S.sel = 's' + (S.screws.length - 1); setMode('orbit'); schedule(false);
    }
  }
  // ---------- 3D handles: drag the selected cut or screw along / around the guide axes ----------
  // x = along the bone (u), y = lateral (v), z = seating normal (n). A cut moves only along x and turns
  // about y and z; a screw moves in x/y (it always starts on the bone surface) and tilts about x and y.
  const gizmo = THREE.TransformControls ? new THREE.TransformControls(camera, renderer.domElement) : null;
  const proxy = new THREE.Object3D(); scene.add(proxy);
  const gz = { mode: 'translate', start: null, used: false };
  if (gizmo) {
    gizmo.setSize(0.8); gizmo.setSpace('local'); scene.add(gizmo);
    gizmo.addEventListener('change', render);
    gizmo.addEventListener('dragging-changed', e => {
      controls.enabled = !e.value;
      if (e.value) { gz.used = true; gz.start = gizmoStart(); return; }
      const moved = gz.start && gz.start.moved, wasGuide = gz.start && gz.start.guide; gz.start = null;
      if (moved) schedule(wasGuide || (S.sel && S.sel[0] === 'p'), false); syncGizmo();
    });
    gizmo.addEventListener('objectChange', () => { if (gz.start) gizmoApply(); });
  }
  function selObj() {
    if (!S.sel || !S.anchor) return null;
    const isP = S.sel[0] === 'p', i = +S.sel.slice(1), o = isP ? S.planes[i] : S.screws[i];
    return o ? { isP, i, o } : null;
  }
  function syncGizmo() {
    if (!gizmo) return;
    const so = selObj(), fib = S.split || (window.Fibula && Fibula.active && Fibula.active() && camera.layers.isEnabled(1));
    // the guide itself: a ring about its seating normal turns it on the bone (Guide ekseni dönüşü)
    if (S.guideSel && !(S.guideOn && S.anchor && parts.guide)) S.guideSel = false;
    if (S.guideSel && !fib) {
      $('gizmoSeg').hidden = true; $('dragBox').hidden = true;
      if (gz.start) return;
      const { u, v, n } = frameAxes();
      proxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n)); proxy.position.copy(S.anchor.p); proxy.updateMatrixWorld();
      gizmo.setMode('rotate'); gizmo.showX = false; gizmo.showY = false; gizmo.showZ = true; gizmo.attach(proxy); render(); return;
    }
    $('gizmoSeg').hidden = !so; $('dragBox').hidden = !(so && so.isP);
    if (!so || fib) { gizmo.detach(); render(); return; }
    if (gz.start) return;
    const { P, u, v, n } = so.isP ? Object.assign({ P: S.anchor.p }, frameAxes()) : screwFrame(so.o);
    proxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    if (so.isP) proxy.position.copy(planesWorld()[so.i].p);
    else { const sw = screwWorld(so.o); proxy.position.copy(sw.entry || P.clone().add(u.clone().multiplyScalar(so.o.u)).add(v.clone().multiplyScalar(so.o.v))); }
    proxy.updateMatrixWorld();
    gizmo.setMode(gz.mode);
    const t = gz.mode === 'translate';
    gizmo.showX = so.isP ? t : true;
    gizmo.showY = so.isP ? !t : true;
    gizmo.showZ = so.isP && !t;
    gizmo.attach(proxy); render();
  }
  function gizmoStart() {
    if (S.guideSel) { const { u, v } = frameAxes(); return { guide: true, q0: proxy.quaternion.clone(), rot0: S.g.rot, u0: u, v0: v, key: String(S.g.rot) }; }
    const so = selObj(); if (!so) return null;
    const o = so.o, st = { so, p0: proxy.position.clone(), q0: proxy.quaternion.clone(), o0: Object.assign({}, o), key: [o.off, o.yaw, o.pitch, o.u, o.v, o.tiltU, o.tiltV].join() };
    if (so.isP) st.N0 = planesWorld()[so.i].N.clone(); else st.d0 = screwWorld(so.o).dir.clone();
    return st;
  }
  const clampR = (x, a, b, st) => Math.max(a, Math.min(b, Math.round(x / st) * st));
  const wrap180 = r => { r = Math.round(((r + 180) % 360 + 360) % 360 - 180); return r === -180 ? 180 : r; };
  // the cuts stay where they are in the jaw while the guide turns or moves around the bone: they are written again
  // in the new guide frame. A cut almost parallel to the new guide axis cannot be written that way and turns with it.
  function keepCuts(change) {
    const before = planesWorld().map(w => ({ p: w.p.clone(), N: w.N.clone() })), p0 = S.anchor.p.clone(), u0 = frameAxes().u;
    change();
    const { u, v, n } = frameAxes(); let turned = 0;
    S.planes.forEach((pl, i) => {
      let { p: c, N } = before[i]; if (N.dot(u) < 0) N = N.clone().negate();
      if (N.dot(u) < 0.2) { turned++; return; }
      pl.off = Math.max(-CUT_OFF_MAX, Math.min(CUT_OFF_MAX, N.dot(c.clone().sub(S.anchor.p)) / N.dot(u)));
      pl.yaw = THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))); pl.pitch = THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n)))));
      // a cut with its reference point on the bone keeps that point
      if (pl.pv || pl.pn) { const d = c.clone().sub(S.anchor.p); pl.pv = +d.dot(v).toFixed(1); pl.pn = +d.dot(n).toFixed(1); }
    });
    // the lesion range is measured along the guide axis from the anchor
    const sh = p0.clone().addScaledVector(u0, (S.lesion.from + S.lesion.to) / 2).sub(S.anchor.p).dot(u) - (S.lesion.from + S.lesion.to) / 2;
    S.lesion.from += sh; S.lesion.to += sh;
    S.cutsTurned = turned;
    return turned;
  }
  // automatic screws whose sleeve the built guide has no body under (hand-set screws are the surgeon's and stay)
  function floatingScrews(R) { return R && R.screwInfo ? R.screwInfo.filter(si => !si.ok && si.noBody && si.s && si.s.sc && !si.s.sc.hand) : []; }
  function dropFloating() {
    const bad = new Set(floatingScrews(S.result).map(si => si.s.sc)); if (!bad.size) return false;
    const pls = planesWorld(); S.screwDrops = S.screwDrops || [];
    S.screws.forEach(sc => {
      if (!bad.has(sc)) return;
      // (a screw on a piece frame holds that piece; one on the guide frame the end past its nearest cut)
      const pw = sc.part ? (pieceFrames() || {})[sc.part < 0 ? 'A' : 'B'] : pls.reduce((b, x) => (!b || Math.abs(x.off - sc.u) < Math.abs(b.off - sc.u) ? x : b), null);
      if (!pw) return;
      const side = sc.part || Math.sign(sc.u - pw.off) || 1, same = o => (sc.part ? o.part === sc.part : !o.part && Math.sign(o.u - pw.off) === side);
      if (!S.screwDrops.some(d => d.pl === pw.pl && d.side === side)) S.screwDrops.push({ pl: pw.pl, cut: Math.max(0, S.planes.indexOf(pw.pl)), side, part: !!sc.part, want: S.screws.filter(same).length, why: 'noBody' });
    });
    S.screws = S.screws.filter(sc => !bad.has(sc));
    return true;
  }
  function afterGuideMove() {
    unapproveAll(); updateLesionPart();
    if (S.guideOn && S.screws.length) S.screwRefit = true;
    S.refit = true; syncGuideInputs(); schedule(true, true);
  }
  function setGuideRot(r) {
    r = wrap180(r); if (r === S.g.rot || !S.anchor) return false;
    keepCuts(() => { S.g.rot = r; }); afterGuideMove(); return true;
  }
  // move the guide around the bone (buccal face towards the lower border or the crest): the anchor turns about the bone
  // axis through the centre of the bone cross-section and lands on the surface in that direction
  function boneCentre(p, a) {
    const r = S.red, ix = [-18, 18].flatMap(dx => [-18, 18].flatMap(dy => [-18, 18].map(dz => G.indexOf(r, [p.x + dx, p.y + dy, p.z + dz]))));
    const lo = [0, 1, 2].map(k => Math.max(0, Math.floor(Math.min(...ix.map(q => q[k]))))), hi = [0, 1, 2].map(k => Math.min([r.nx, r.ny, r.nz][k] - 1, Math.ceil(Math.max(...ix.map(q => q[k])))));
    const c = V(); let cnt = 0; const q = V();
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      if (!S.mask[i + r.nx * (j + r.ny * k)]) continue;
      q.set(...G.worldOf(r, i, j, k)).sub(p); const along = q.dot(a);
      if (Math.abs(along) > 2 || q.lengthSq() - along * along > 18 * 18) continue;
      c.add(q); cnt++;
    }
    return cnt > 10 ? c.multiplyScalar(1 / cnt).add(p) : null;
  }
  function setGuideRoll(r) {
    r = wrap180(r); if (!S.anchor || r === (S.g.roll || 0)) return false;
    const an = S.anchor, base = an.base || { p: an.p.clone(), n: an.n.clone() };
    const a = an.axis.clone().sub(base.n.clone().multiplyScalar(an.axis.dot(base.n))).normalize();
    if (!base.c) base.c = boneCentre(base.p, a) || base.p.clone().addScaledVector(base.n, -6);
    const n1 = base.n.clone().applyAxisAngle(a, deg(r)).normalize();
    let p1 = null; const q = V();
    for (let t = 30; t > 0; t -= 0.25) { q.copy(base.c).addScaledVector(n1, t); if (boneAt(q)) { p1 = q.clone().addScaledVector(n1, 0.25); break; } }
    if (!p1) { if ($('guideStat')) $('guideStat').textContent = 'Bu yönde kemik yüzeyi bulunamadı; guide yerinde bırakıldı.'; return false; }
    keepCuts(() => { an.base = base; an.p = p1; an.n = n1; an.axis = a; S.g.roll = r; });
    showAnchor(); afterGuideMove(); return true;
  }
  function gizmoApply() {
    if (gz.start.guide) {
      const { q0, rot0, u0, v0 } = gz.start, dq = proxy.quaternion.clone().multiply(q0.clone().invert()), nu = u0.clone().applyQuaternion(dq);
      if (setGuideRot(rot0 + THREE.MathUtils.radToDeg(Math.atan2(nu.dot(v0), nu.dot(u0))))) gz.start.moved = true;
      return;
    }
    const { so, p0, q0, o0 } = gz.start, o = so.o, { u, v, n } = so.isP ? frameAxes() : screwFrame(o);
    const d = proxy.position.clone().sub(p0), dq = proxy.quaternion.clone().multiply(q0.clone().invert());
    if (so.isP) {
      if (gz.mode === 'translate') o.off = clampR(o0.off + d.dot(u), -CUT_OFF_MAX, CUT_OFF_MAX, 0.5);
      else {
        const N = gz.start.N0.clone().applyQuaternion(dq);
        o.yaw = clampR(THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))), -89, 89, 0.5);
        o.pitch = clampR(THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n))))), -89, 89, 0.5);
      }
    } else {
      if (gz.mode === 'translate') { o.u = clampR(o0.u + d.dot(u), -80, 80, 0.5); o.v = clampR(o0.v + d.dot(v), -40, 40, 0.5); }
      else {
        const D = gz.start.d0.clone().applyQuaternion(dq), a = Math.asin(Math.max(-1, Math.min(1, -D.dot(u))));
        o.tiltU = clampR(THREE.MathUtils.radToDeg(a), -89, 89, 1);
        o.tiltV = clampR(THREE.MathUtils.radToDeg(Math.atan2(D.dot(v), -D.dot(n))), -89, 89, 1);
      }
    }
    const key = [o.off, o.yaw, o.pitch, o.u, o.v, o.tiltU, o.tiltV].join();
    if (key === gz.start.key) return;
    gz.start.key = key; gz.start.moved = true;
    if (!so.isP) o.hand = 1;                                       // a screw the surgeon moved stays where it is
    unapprove(o); syncSliders(o); schedule(so.isP, true);
  }
  function syncSliders(o) {
    ['off', 'yaw', 'pitch', 'u', 'v', 'tiltU', 'tiltV'].forEach(k => { const el = $('f_' + k); if (el && o[k] !== undefined) { el.value = o[k]; const out = $('o_' + k); if (out) out.textContent = `${fmt(o[k], +el.step < 1 ? 1 : 0)} ${/yaw|pitch|tilt/.test(k) ? '°' : 'mm'}`; } });
  }
  function setGizmoMode(m) { gz.mode = m; $('gzT').setAttribute('aria-pressed', m === 'translate'); $('gzR').setAttribute('aria-pressed', m === 'rotate'); syncGizmo(); }
  $('gzT').addEventListener('click', () => setGizmoMode('translate'));
  $('gzR').addEventListener('click', () => setGizmoMode('rotate'));
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'w' || e.key === 'W') setGizmoMode('translate');
    else if (e.key === 'e' || e.key === 'E') setGizmoMode('rotate');
    else if (e.key === 'Escape' && S.mode !== 'orbit') { S.autoAfter = false; setMode('orbit'); }
    else if (e.key === 'Escape' && S.sel && !gz.start) select(null);
    else if (e.key === 'Escape' && S.guideSel && !gz.start) { S.guideSel = false; syncGizmo(); }
  });
  // ---------- direct drag on the model: grab a cut disc or a screw and slide it ----------
  // A cut slides along the bone ("Kemik boyunca": the mandibular arch, the cut stays at the same angle to the
  // bone at every point) or along the straight guide axis; a screw slides on the bone surface under the pointer.
  const dd = { on: null, moved: false, x: 0, y: 0 };
  const dragAxis = () => ($('dragAxis') ? $('dragAxis').value : 'bone');
  function pickAt(e) {
    const rect = renderer.domElement.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    if (e.clientX - rect.left > rw) return null;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(mouse, camera); return ray;
  }
  // nearest arch point to a world point and the arch direction there (horizontal, oriented along +u)
  function archAt(q, u) {
    const a = window.Reformat && Reformat.arch && Reformat.arch(); if (!a || a.pts.length < 3) return null;
    let bi = 0, bd = Infinity;
    a.pts.forEach((c, i) => { const d = (c.x - q.x) ** 2 + (c.y - q.y) ** 2; if (d < bd) { bd = d; bi = i; } });
    if (bd > 30 * 30) return null;
    const c = a.pts[bi], t = V(-c.ny, c.nx, 0).normalize(); if (t.dot(u) < 0) t.negate();
    return { c: V(c.x, c.y, q.z), t };
  }
  // a cut through point c with normal N, written in the guide frame (off, yaw, pitch)
  function planeFrom(c, N, o) {
    const { u, v, n } = frameAxes(); if (N.dot(u) < 0) N = N.clone().negate();
    const yaw = THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))), pitch = THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n)))));
    const off = N.dot(c.clone().sub(S.anchor.p)) / (N.dot(u) || 1e-6);
    o.off = clampR(off, -CUT_OFF_MAX, CUT_OFF_MAX, 0.5); o.yaw = clampR(yaw, -89, 89, 0.5); o.pitch = clampR(pitch, -89, 89, 0.5);
  }
  // the cut disc or screw under the pointer, when a direct drag may start there
  function pickElement(e) {
    if (e.button !== 0 || S.mode !== 'orbit' || !S.anchor || (window.SegEdit && SegEdit.tool()) || (window.Lesion && Lesion.active()) || (window.Masks && Masks.tool())) return null;
    if (window.Fibula && Fibula.active && Fibula.active() && camera.layers.isEnabled(1)) return null;
    const r = pickAt(e); if (!r) return null;
    const els = Object.values(parts).filter(pt => pt.visible && /^(screw|plane)\d/.test(pt.id));
    const hits = r.intersectObjects(els.map(pt => pt.obj), false);
    const h = hits.find(x => els.find(pt => pt.obj === x.object).id.startsWith('screw')) || hits[0];
    return h ? els.find(pt => pt.obj === h.object).id : null;
  }
  // the gizmo of the selected element reaches over its neighbours: a press on another cut or screw grabs that
  // element, not the handle (the gizmo's own listener runs after this capture-phase one and finds itself disabled for this press)
  renderer.domElement.addEventListener('pointerdown', e => {
    if (!gizmo || !gizmo.enabled || gizmo.dragging || !gizmo.axis) return;
    const id = pickElement(e); if (!id) return;
    const sel = S.sel && (S.sel[0] === 'p' ? 'plane' : 'screw') + S.sel.slice(1);
    if (id !== sel) { gizmo.enabled = false; gizmo.axis = null; dd.gizmoOff = true; }
  }, true);
  renderer.domElement.addEventListener('pointerdown', e => {
    if (dd.gizmoOff) { dd.gizmoOff = false; gizmo.enabled = true; }
    if (e.button !== 0 || S.mode !== 'orbit' || !S.anchor || (gizmo && (gizmo.dragging || gizmo.axis)) || (window.SegEdit && SegEdit.tool()) || (window.Lesion && Lesion.active()) || (window.Masks && Masks.tool())) return;
    if (window.Fibula && Fibula.active && Fibula.active() && camera.layers.isEnabled(1)) return;
    const r = pickAt(e); if (!r) return;
    const els = Object.values(parts).filter(pt => pt.visible && /^(screw|plane)\d/.test(pt.id));
    const hits = r.intersectObjects(els.map(pt => pt.obj), false);
    const h = hits.find(x => els.find(pt => pt.obj === x.object).id.startsWith('screw')) || hits[0];
    if (!h) return;
    const id = els.find(pt => pt.obj === h.object).id, isP = id.startsWith('plane'), i = +id.replace(/\D/g, ''), o = isP ? S.planes[i] : S.screws[i];
    if (!o) return;
    dd.on = { isP, i, o, key: '' }; dd.moved = false; dd.x = e.clientX; dd.y = e.clientY;
    if (isP) {
      // keep the cut's angle relative to the bone direction where it is now
      const pw = planesWorld()[i], { u } = frameAxes(), a = dragAxis() === 'bone' && archAt(pw.p, u);
      dd.on.t0 = a ? a.t : null; dd.on.N0 = pw.N.clone();
    }
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', e => {
    if (!dd.on) return;
    if (!dd.moved && Math.hypot(e.clientX - dd.x, e.clientY - dd.y) < 4) return;
    if (!dd.moved) { dd.moved = true; select((dd.on.isP ? 'p' : 's') + dd.on.i); }
    const r = pickAt(e); if (!r) return;
    // the bone under the pointer, or the guide where it covers the bone (a screw dragged along the body)
    const targets = ['bone', 'resected', 'guide'].filter(k => parts[k] && parts[k].visible).map(k => parts[k].obj);
    const hit = r.intersectObjects(targets, false)[0]; if (!hit) return;
    const { o, isP } = dd.on, { u, v } = frameAxes(), d = hit.point.clone().sub(S.anchor.p);
    if (isP) {
      const a = dragAxis() === 'bone' && archAt(hit.point, u);
      // the bone direction turned by some angle about the vertical: turn the cut by the same angle
      if (a && dd.on.t0) planeFrom(a.c, dd.on.N0.clone().applyAxisAngle(V(0, 0, 1), Math.atan2(dd.on.t0.x * a.t.y - dd.on.t0.y * a.t.x, dd.on.t0.dot(a.t))), o);
      else o.off = clampR(d.dot(u), -CUT_OFF_MAX, CUT_OFF_MAX, 0.5);
    } else {
      // a screw on a piece of the two-guide layout is written in that piece's frame
      const fr = screwFrame(o), q = hit.point.clone().sub(fr.P);
      o.u = clampR(q.dot(fr.u), -80, 80, 0.5); o.v = clampR(q.dot(fr.v), -40, 40, 0.5);
    }
    const key = [o.off, o.yaw, o.pitch, o.u, o.v].join();
    if (key === dd.on.key) return;
    dd.on.key = key; if (!isP) o.hand = 1; unapprove(o); syncSliders(o); syncGizmo(); schedule(isP, true);
  });
  const ddEnd = e => {
    if (!dd.on) return;
    const { isP } = dd.on, moved = dd.moved; dd.on = null; controls.enabled = true;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (x) {}
    if (!moved) return;
    // a cut dragged over the screws: put the screws (and the guide length) back outside the cuts
    if (isP && S.planes.length > 1) {
      const { u, v } = frameAxes(), pls = planesWorld().sort((x, y) => x.off - y.off), cross = (pw, vv) => pw.off - vv * pw.N.dot(v) / Math.max(0.2, pw.N.dot(u));
      if (S.screws.some(sc => sc.u > cross(pls[0], sc.v) - pls[0].w / 2 - 2 && sc.u < cross(pls[pls.length - 1], sc.v) + pls[pls.length - 1].w / 2 + 2)) placeScrews();
    }
    schedule(isP, false);
  };
  renderer.domElement.addEventListener('pointerup', ddEnd);
  renderer.domElement.addEventListener('pointercancel', ddEnd);
  bus.addEventListener('select', syncGizmo);
  bus.addEventListener('parts', syncGizmo);
  bus.addEventListener('planApplied', syncGizmo);

  // picks (cut region, screw sites, brush strokes) are made on the mandible: with the fibula-only view on, the view goes back to the mandible
  // and says so, instead of the click landing on the leg and opening the fibula step
  function mandibleView() {
    if (!(window.Fibula && Fibula.view && Fibula.view() === 'f')) return false;
    Fibula.setView('m');
    alertMsg('Seçim mandibulada yapılır: 3B görünüm mandibulaya alındı.');
    return true;
  }
  function setMode(m) {
    if (m !== 'orbit') mandibleView();
    S.mode = m;
    $('modeBadge').hidden = m === 'orbit';
    $('modeBadge').textContent = m === 'anchor' ? 'Rezeksiyon bölgesinin ortasında kemik yüzeyine tıklayın (guide buraya oturur) · Klavye: 3B görünümde ok tuşlarıyla çevirin, Enter ortadaki noktayı seçer'
      : m === 'screw' ? 'Vida yeri için guide üzerine tıklayın · Klavye: 3B görünümde ok tuşlarıyla çevirin, Enter ortadaki noktaya vida koyar' : $('modeBadge').textContent;
    if (m === 'anchor' || m === 'screw') $('stage').setAttribute('data-kbpick', S.split ? 'half' : ''); else $('stage').removeAttribute('data-kbpick');   // the ring in the middle of the view (keyboard pick)
  }
  // ---------- click / brush modes (cut region, screw site, bone pick, marking and lesion brushes, ...) ----------
  // Every tool that takes over the clicks on the model shows the mode bar over the view: what the clicks do now,
  // which step it was started from and a button that ends it (Esc does the same). Each module registers how it
  // ends its own mode; changing the step ends every mode, so none is left running behind a closed panel.
  const modeEnders = [];
  function onEndModes(f, o) { modeEnders.push({ f, view: !!(o && o.view) }); }
  function endModes(o) {
    const step = !!(o && o.step);
    S.autoAfter = false; if (S.mode !== 'orbit') setMode('orbit');
    modeEnders.forEach(m => { if (step && m.view) return; try { m.f(); } catch (e) { console.error(e); } });
    if (!step || !(window.Measure && Measure.active())) $('modeBadge').hidden = true;
  }
  {
    const badge = $('modeBadge'), bar = $('modeBar'), from = $('modeFrom');
    const sync = () => {
      const was = !bar.hidden; bar.hidden = badge.hidden;
      if (!bar.hidden && !was) {
        // the step the mode was started from (the open one), so it is clear where it came from
        const sm = document.querySelector('details.step[open] > summary'), n = sm && sm.querySelector('.n');
        const t = sm ? [...sm.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join('').replace(/\s+/g, ' ').trim() : '';
        $('modeStep').textContent = t ? `${n ? n.textContent + ' · ' : ''}${t}` : ''; from.hidden = !t || !!(window.Measure && Measure.active());   // measuring is a view tool, not a step's
      }
    };
    new MutationObserver(sync).observe(badge, { attributes: true, attributeFilter: ['hidden'] }); sync();
    $('modeExit').addEventListener('click', () => endModes());
  }
  function fitTo(obj) {
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(V()), r = box.getSize(V()).length() / 2;
    controls.target.copy(c);
    const dir = S.anchor ? S.anchor.n.clone().add(V(0, 0, 0.6)).normalize() : V(0.3, -1, 0.6).normalize();
    const vf = deg(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    camera.position.copy(c).add(dir.multiplyScalar(r / Math.sin(Math.min(vf, hf) / 2) * 1.05)); controls.update(); render();
  }

  // ---------- preset demo case ----------
  function presetCase() {
    const bone = parts.bone.obj, box = new THREE.Box3().setFromObject(bone), c = box.getCenter(V());
    let from, dirv, lesion, g;
    S.presetRay = null;
    if (S.kind === 'mandible') {
      from = V(c.x, box.min.y - 40, box.min.z + 11); dirv = V(0, 1, 0);
      lesion = { from: -8, to: 8, margin: 3 };
      g = { rot: 0, L: 40, W: 22, wrap: 5, wall: 2.5, clear: 0.3, bridge: 4, side: -1 };
    } else if (S.kind === 'leg') {
      from = V(-12, box.min.y - 40, box.max.z - 70); dirv = V(0, 1, 0);
      lesion = { from: -1, to: 3, margin: 3 };
      g = { rot: 0, L: 44, W: 20, wrap: 6, wall: 2.5, clear: 0.3, bridge: 4, side: 1 };
    } else return;
    // sample defaults only; the region is picked on the model (or by 'Otomatik hazırla', which uses this spot)
    S.presetRay = { from, dirv };
    Object.assign(S.g, g); syncGuideInputs(); Object.assign(S.lesion, lesion); syncLesion();
    setTimeout(() => fitTo(parts.bone.obj), 50);
  }

  // ---------- controls wiring ----------
  const gFields = [['rot', 'Yüzeyde döndür', -180, 180, 1, '°'], ['roll', 'Kemik etrafında kaydır', -180, 180, 1, '°'], ['L', 'Uzunluk', 16, 160, 1, 'mm'], ['W', 'Genişlik', 10, 40, 1, 'mm'], ['wrap', 'Sarma derinliği', 2, 20, 0.5, 'mm'], ['wall', 'Duvar kalınlığı', 1.5, 5, 0.1, 'mm'], ['clear', 'Kemik aralığı', 0, 1, 0.05, 'mm'], ['bridge', 'Köprü genişliği', 2, 10, 0.5, 'mm'], ['flange', 'Kesi ötesi kenar', 2, 8, 0.5, 'mm'], ['peri', 'Periost payı', 0, 1, 0.05, 'mm']];
  $('gCtl').innerHTML = gFields.map(([k, t, mn, mx, st]) => `<div class="ctl" id="gc_${k}"><div class="ctl-row"><label for="g_${k}">${t}</label><output id="go_${k}"></output></div><input type="range" id="g_${k}" min="${mn}" max="${mx}" step="${st}"></div>`).join('') +
    '<h3 class="sub">Gövde</h3><details class="sub-d" id="secGFine"><summary>İnce ayar: duvar, aralık, periost</summary><div class="col" id="gFine"></div></details>';
  // placement first, then body size; wall and clearances rarely change, so they sit folded at the end
  ['L', 'W', 'wrap', 'bridge', 'flange'].forEach(k => $('gCtl').insertBefore($('gc_' + k), $('secGFine')));
  ['wall', 'clear', 'peri'].forEach(k => $('gFine').appendChild($('gc_' + k)));
  $('gc_peri').insertAdjacentHTML('beforeend', '<p class="hint more" data-for="g_peri">Periost kalınlığı kemik aralığına eklenir.</p>');
  function syncGuideInputs() {
    if ($('gScrewD')) { const d = S.screws.length ? S.screws[0].d : screwDef().d; $('gScrewD').value = d; $('gScrewDO').textContent = `${fmt(d)} mm`; }
    if ($('gRoll3')) { $('gRoll3').value = S.g.roll || 0; $('gRoll3O').textContent = `${fmt(S.g.roll || 0, 0)}°`; }
    if ($('gRot3')) { $('gRot3').value = S.g.rot; $('gRot3O').textContent = `${fmt(S.g.rot, 0)}°`; $('gRotBox').hidden = !S.guideOn; }
    gFields.forEach(([k, , , , st, unit]) => { $('g_' + k).value = S.g[k]; $('go_' + k).textContent = `${fmt(S.g[k], st < 1 ? (st < 0.1 ? 2 : 1) : 0)} ${unit}`; });
    $('g_side').value = String(S.g.side); $('g_split').value = String(S.g.split || 0);
    if ($('g_kerf')) $('g_kerf').value = String(S.g.kerfSide ? 1 : 0);
    // values still chosen from the bone are marked on their control
    ['L', 'W', 'wrap'].forEach(k => { const el = $('gc_' + k); if (el && el.classList) el.classList.toggle('auto', !!S.gAuto[k]); });
    $('g_stopT').checked = !!S.g.stopT; $('g_stopB').checked = !!S.g.stopB; $('stopBox').hidden = !(S.g.stopT || S.g.stopB || S.g.stopP); if ($('g_stopP')) $('g_stopP').checked = !!S.g.stopP; if ($('g_bar')) $('g_bar').checked = !!S.g.bar;
    ['stopL', 'stopD'].forEach(k => { $('g_' + k).value = S.g[k]; $('go_' + k).textContent = `${fmt(S.g[k], 1)} mm`; });
    $('gc_flange').hidden = !S.g.split; $('gc_bridge').hidden = !!S.g.split; $('g_side').closest('.ctl').hidden = !!S.g.split;
  }
  // the screws stay on the guide: a turned guide axis re-places them once the value rests, a shorter or narrower
  // guide pulls them back inside its body
  function clampScrews() {
    if (S.g.split === 2) return;                    // each piece has its own frame and extent (buildGuideSet)
    const half = S.g.L / 2;
    S.screws.forEach(sc => {
      const mu = Math.max(0, half - sc.D / 2 - 0.5), mv = Math.max(0, S.g.W / 2 - sc.D / 2 - 0.5), vc = S.g.vc || 0;
      if (Math.abs(sc.u) > mu) { sc.u = Math.sign(sc.u) * Math.floor(mu * 2) / 2; unapprove(sc); }
      if (Math.abs(sc.v - vc) > mv) { sc.v = vc + Math.sign(sc.v - vc) * Math.floor(mv * 2) / 2; unapprove(sc); }
    });
  }
  gFields.forEach(([k]) => $('g_' + k).addEventListener('input', e => {
    if (k === 'rot') { setGuideRot(+e.target.value); return; }
    if (k === 'roll') { setGuideRoll(+e.target.value); return; }
    S.g[k] = +e.target.value; unapproveAll();   // every guide body setting changes what was approved
    // a value set by hand stays: the automatic sizing and the fit ladder leave it alone from now on
    if (k === 'L' || k === 'W' || k === 'wrap') { S.gAuto[k] = 0; if (k === 'wrap') S.g.wrapU = null; if (k === 'W') S.g.vc = 0; }
    if (k === 'L' || k === 'W') S.refit = true;   // ('rot' and 'roll' returned above: setGuideRot / setGuideRoll do their own refit)
    if ((k === 'L' || k === 'W') && S.guideOn) clampScrews();
    syncGuideInputs(); schedule(false, true);
  }));
  $('g_side').addEventListener('change', e => { S.g.side = +e.target.value; unapproveAll(); schedule(false); });
  $('gRot3').addEventListener('input', e => setGuideRot(+e.target.value));
  $('gRoll3').addEventListener('input', e => setGuideRoll(+e.target.value));
  // one drill diameter for every guide screw (and for screws placed later); each screw can still be changed on its own
  $('gScrewD').addEventListener('input', e => {
    const d = Math.round(+e.target.value * 10) / 10; $('gScrewDO').textContent = `${fmt(d)} mm`;
    // (W19) this case's default for screws placed later, not the built-in table; each sleeve keeps its wall around the
    // new drill, so a smaller drill gives a smaller sleeve again (2 -> 4 -> 2 mm ends where it started)
    S.drillD = d;
    S.screws.forEach(c => { c.D = Math.max(Math.round((d + 2) * 10) / 10, Math.round((c.D - c.d + d) * 10) / 10); c.d = d; unapprove(c); });
    if (S.screws.length) schedule(false, true);
  });
  $('gScrewD').addEventListener('change', () => { if (S.screws.length) { schedule(false); emit('changed'); } });
  ['stopT', 'stopB', 'stopP'].forEach(k => $('g_' + k).addEventListener('change', e => { S.g[k] = e.target.checked ? 1 : 0; if (k === 'stopP') S.gAuto.stopP = 0; syncGuideInputs(); unapproveAll(); schedule(false); }));
  // the connecting bar is the surgeon's call once touched: the automatic two-guide proposal leaves it alone from then on
  $('g_bar').addEventListener('change', e => { S.g.bar = e.target.checked ? 1 : 0; S.gAuto.bar = 0; syncGuideInputs(); unapproveAll(); schedule(false); });
  [['stopL', 'mm'], ['stopD', 'mm']].forEach(([k, un]) => $('g_' + k).addEventListener('input', e => { S.g[k] = +e.target.value; $('go_' + k).textContent = `${fmt(S.g[k], 1)} ${un}`; schedule(false, true); }));
  $('g_split').addEventListener('change', e => {
    const was = S.g.split; S.g.split = +e.target.value; S.gAuto.split = 0;
    if ((was === 2) !== (S.g.split === 2) && S.anchor && S.planes.length && S.guideOn && placeScrews()) alertMsg('Elle yerleştirilen vidalar yeni guide düzenine taşındı; konumlarını kontrol edip yeniden onaylayın.');
    syncGuideInputs(); unapproveAll(); schedule(false);
  });
  // where the saw slot lies: on the resected side (the graft meets the stump flush) or centred on the planned plane
  if ($('g_kerf')) $('g_kerf').addEventListener('change', e => { S.g.kerfSide = +e.target.value ? 1 : 0; unapproveAll(); if (S.anchor && S.planes.length && S.guideOn) placeScrews(); schedule(true); });
  // the controls' automatic marks are reset with a new plan
  $('gAutoReset') && $('gAutoReset').addEventListener('click', () => { Object.assign(S.gAuto, AUTO_DEFAULT); if (S.anchor && S.planes.length) { placeScrews(); S.sel = null; } S.refit = true; syncGuideInputs(); schedule(false); });
  $('resType').addEventListener('change', async e => {
    const side = e.target.value || null;
    if (side && window.Ref && !Ref.get()) await Ref.compute(false);
    if (side && !(window.Ref && Ref.get() && Ref.get().cond[side])) { alertMsg('Kondil bulunamadı; Anatomi adımında kondili elle seçin.'); e.target.value = S.lesion.condyle || ''; return; }
    S.lesion.condyle = side; unapprove(S.lesion); syncLesion(); schedule(true);
  });
  syncGuideInputs();

  $('segMode').addEventListener('change', e => { const ai = e.target.value === 'ai'; $('aiBox').hidden = !ai; $('thrBox').hidden = ai; if (!ai && S.red) segment(false); });
  $('aiRun').addEventListener('click', async () => { if (!S.red) return; const before = S.labels; await segmentAI(); if (S.labels !== before) { unapproveAll(); renderAppr(); } });   // a new bone segmentation invalidates every approval
  $('suggest').addEventListener('click', suggest);
  $('perSide').addEventListener('change', () => { if (S.anchor && S.planes.length) { placeScrews(); S.sel = null; schedule(false); } });
  let surgTimer = null;
  $('surgeon').addEventListener('input', () => { renderAppr(); clearTimeout(surgTimer); surgTimer = setTimeout(() => emit('changed'), 800); });
  $('expZip').addEventListener('click', () => exportPackage());
  bus.addEventListener('parts', syncOne);
  $('oneStl').querySelectorAll('[data-one]').forEach(b => b.addEventListener('click', () => exportOne(b.dataset.one)));
  $('expSrv').addEventListener('click', () => productionSTL());
  $('expRep').addEventListener('click', () => exportReport());
  $('thr').addEventListener('input', e => { $('thrO').textContent = e.target.value + ' HU'; });
  $('thr').addEventListener('change', () => { unapproveAll(); segment(false); });
  $('serSel').addEventListener('change', e => switchSeries(+e.target.value));
  $('pickAnchor').addEventListener('click', () => { S.autoAfter = false; if (S.red) setMode('anchor'); });
  $('resRemove').addEventListener('click', () => { S.resRemoved = !S.resRemoved; showResected(); syncSeq(); renderParts(); render(); emit('changed'); });
  $('guideMake').addEventListener('click', makeGuide);
  $('autoPrep').addEventListener('click', autoPrep);
  $('gMake2').addEventListener('click', makeGuide);
  $('guideDel').addEventListener('click', deleteGuide); $('guideDel2').addEventListener('click', deleteGuide);
  $('planReset').addEventListener('click', resetPlan);
  ['parts', 'changed', 'volume', 'planApplied'].forEach(t => bus.addEventListener(t, syncSeq));
  $('addPlane').addEventListener('click', () => { if (!S.anchor) return; S.planes.push({ off: 0, yaw: 0, pitch: 0, w: 1.2 }); S.sel = 'p' + (S.planes.length - 1); schedule(true); });
  $('addScrew').addEventListener('click', () => { if (!S.anchor) return; if (!S.guideOn) { alertMsg('Önce 3. adımda "Guide oluştur"a basın.'); return; } setMode('screw'); });
  $('explode').addEventListener('input', e => { S.explode = +e.target.value; $('explodeO').textContent = fmt(S.explode, 0) + ' mm'; applyExplode(); render(); });
  $('showAll').addEventListener('click', () => { Object.values(parts).forEach(pt => { pt.visible = true; pt.obj.visible = true; }); renderParts(); render(); });
  $('guideOnly').addEventListener('click', () => { Object.values(parts).forEach(pt => { pt.visible = /guide/.test(pt.id) || pt.id.startsWith('screw'); pt.obj.visible = pt.visible; }); renderParts(); if (parts.guide) fitTo(parts.guide.obj); });
  $('fit').addEventListener('click', () => { if (parts.bone) fitTo(parts.bone.obj); });
  // the sample replaces the whole case: a plan (cuts, screws, guide, fibula plan) is lost and "undo" does not bring it back, so ask first
  const planned = () => !!(S.anchor || S.planes.length || S.screws.length || (window.Fibula && Fibula.active && Fibula.active()));
  const sampleClick = name => { if (loadBlocked()) return; if (planned() && !confirm('Örnek vaka yüklensin mi? Mevcut plan (kesiler, vidalar, guide) silinir.')) return; loadSample(name); };
  $('sampleM').addEventListener('click', () => sampleClick('mandible'));
  $('sampleL').addEventListener('click', () => sampleClick('leg'));
  $('dicomDir').addEventListener('change', e => { if (e.target.files.length) loadDicom([...e.target.files]); });
  $('dicomFiles').addEventListener('change', e => { if (e.target.files.length) loadDicom([...e.target.files]); });
  stage.addEventListener('dragover', e => e.preventDefault());
  // dropped folders are walked (dataTransfer.files does not enter them); a dropped zip is opened by readDicom
  // a plan file (plan.json from a package) dropped on the view opens that plan (on its own series / sample)
  stage.addEventListener('drop', async e => {
    e.preventDefault();
    const dropped = [...e.dataTransfer.files];
    if (dropped.length === 1 && /\.json$/i.test(dropped[0].name)) {
      if (loadBlocked()) return;
      if (planned() && !confirm('Plan dosyası açılınca mevcut plan (kesiler, vidalar, guide) silinir. Devam edilsin mi?')) return;
      try { await openPlan(JSON.parse(await dropped[0].text())); emit('changed'); } catch (err) { busy(false); alertMsg(`${xl('Vaka açılamadı:')} ${err.message}`); }
      return;
    }
    const files = window.Unzip ? await Unzip.fromDrop(e.dataTransfer) : dropped; if (files.length) loadDicom(files);
  });

  // ---------- export: STL + report + plan, packed as .zip (STL alone is not an allowed download type) ----------
  function stlOf(mesh) {
    const g = mesh.geometry, P = g.attributes.position.array, I = g.index.array, nt = I.length / 3;
    const buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
    new TextEncoder().encodeInto('Yolmed guide studio STL (LPS mm)', new Uint8Array(buf, 0, 80));
    dv.setUint32(80, nt, true);
    const a = V(), b = V(), c = V(), nr = V();
    for (let t = 0, o = 84; t < nt; t++, o += 50) {
      a.fromArray(P, I[3 * t] * 3); b.fromArray(P, I[3 * t + 1] * 3); c.fromArray(P, I[3 * t + 2] * 3);
      nr.subVectors(c, b).cross(V().subVectors(a, b)).normalize();
      [nr, a, b, c].forEach((q, k) => { dv.setFloat32(o + k * 12, q.x, true); dv.setFloat32(o + k * 12 + 4, q.y, true); dv.setFloat32(o + k * 12 + 8, q.z, true); });
    }
    return new Uint8Array(buf);
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  // stored (uncompressed) zip; zipBytes for callers that need the bytes synchronously (3MF inside the package)
  function zipBytes(files) {
    const enc = new TextEncoder(), chunks = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, off, true);
      chunks.push(new Uint8Array(h.buffer), name, data); central.push(new Uint8Array(cd.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, x) => s + x.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((n, a) => n + a.length, 0)); let k = 0;
    all.forEach(a => { out.set(a, k); k += a.length; });
    return out;
  }
  const zip = files => new Blob([zipBytes(files)]);
  function reportHTML() {
    // rapor.html is a Turkish document (lang="tr") in either interface language: Turkish dates
    const miss = pending(), draft = miss.length || S.crit, when = new Date().toLocaleString('tr-TR');
    const st = o => o.ok ? `Onaylı${o.by ? ' · ' + esc(o.by) : ''}${o.at ? ' · ' + new Date(o.at).toLocaleString('tr-TR') : ''}` : 'Bekliyor';
    const li = arr => arr.map(([, t, m]) => `<li><b>${t}:</b> ${esc(m)}</li>`).join('');
    const checks = [...$('checks').querySelectorAll('li'), ...$('checksInfo').querySelectorAll('li')].map(l => `<li>${esc(l.innerText.replace(/\n/g, ' '))}</li>`).join('');
    const R = S.result, gp = [['Uzunluk', S.g.L, 'mm'], ['Genişlik', S.g.W, 'mm'], ['Sarma derinliği', S.g.wrap, 'mm'], ['Duvar', S.g.wall, 'mm'], ['Kemik boşluğu', S.g.clear, 'mm'], ['Köprü', S.g.bridge, 'mm'], ['Eksen dönüşü', S.g.rot, '°']];
    return `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Guide planı raporu</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1c2421}h1{font-size:22px}h2{font-size:16px;margin-top:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccd;padding:4px 6px;text-align:left}.st{display:inline-block;padding:4px 10px;border-radius:6px;font-weight:600;background:${draft ? '#fbf0dc;color:#a06200' : '#e5f2ea;color:#2f7d4f'}}small{color:#5c6964}</style>
<h1>Hastaya özel guide planı</h1><p><span class="st">${draft ? 'TASLAK' : 'ONAYLI PLAN'}</span> · ${esc(when)}${$('surgeon').value.trim() ? ' · Onaylayan: ' + esc($('surgeon').value.trim()) : ''}</p>
${draft ? `<p>Onay bekleyen: ${esc(miss.join(', ') || '-')}${S.crit ? ` · ${S.crit} kritik kontrol` : ''}</p>` : ''}
<h2>Vaka</h2><p>${esc(caseLine())}</p><p>Segmentasyon: ${esc(S.segMethod)}</p>
<h2>Görüntü kalite kontrolü</h2><ul>${li(S.qc)}</ul>
<h2>Rezeksiyon aralığı</h2><p>Lezyon ${fmt(S.lesion.from)} ile ${fmt(S.lesion.to)} mm arası, güvenlik payı ${fmt(S.lesion.margin)} mm · ${st(S.lesion)}</p>
<h2>Kesi düzlemleri</h2><table><tr><th>Kesi</th><th>Konum</th><th>Yatay açı</th><th>Dikey açı</th><th>Yuva</th><th>Durum</th></tr>${S.planes.map((p, i) => `<tr><td>${i + 1}</td><td>${fmt(p.off)} mm</td><td>${fmt(p.yaw)}°</td><td>${fmt(p.pitch)}°</td><td>${fmt(p.w)} mm</td><td>${st(p)}</td></tr>`).join('')}</table>
<h2>Vidalar</h2><table><tr><th>Vida</th><th>Konum (eksen, yanal)</th><th>Eğim</th><th>Matkap / kovan</th><th>Boy</th><th>Kemik içinde</th><th>Durum</th></tr>${S.screws.map((s, i) => { const si = R && R.screwInfo[i]; return `<tr><td>${i + 1}</td><td>${fmt(s.u)}, ${fmt(s.v)} mm</td><td>${fmt(s.tiltU, 0)}°, ${fmt(s.tiltV, 0)}°</td><td>${fmt(s.d)} / ${fmt(s.D)} mm</td><td>${fmt(s.len, 0)} mm</td><td>${si && si.ok ? fmt(si.inBone) + ' mm' : '-'}</td><td>${st(s)}</td></tr>`; }).join('')}</table>
<h2>Guide gövdesi</h2><table>${gp.map(([k, v, u]) => `<tr><td>${k}</td><td>${fmt(v)} ${u}</td></tr>`).join('')}${R ? `<tr><td>Temas alanı</td><td>${fmt(R.contact, 0)} mm²</td></tr><tr><td>Hacim</td><td>${fmt(R.volume / 1000, 2)} cm³</td></tr>` : ''}</table>
${S.prod && S.prod.key === prodKey() ? `<p>Üretim STL'i sunucuda yüzey tabanlı boolean ile üretildi: ${S.prod.watertight ? 'su geçirmez' : 'su geçirmez değil'}, ${S.prod.bodies} parça, ${fmt(S.prod.volume / 1000, 2)} cm³${S.prod.resolution ? `, ızgara ${fmt(S.prod.resolution, 2)} mm` : ''} (guide_uretim.stl).${S.prod.productionOk === false ? ' <b>Sunucu bu STL\'i basılabilir bulmadı.</b>' : ''}</p>` : '<p>Üretim STL\'i alınmadı; guide.stl 0,4 mm voksel önizlemesidir.</p>'}
<h2>Otomatik kontroller</h2><ul>${checks}</ul>${window.Fibula ? Fibula.reportHTML() : ''}
<h2>Koordinatlar</h2><p>Guide merkezi ${S.anchor ? [S.anchor.p.x, S.anchor.p.y, S.anchor.p.z].map(x => fmt(x)).join(', ') : '-'} mm (DICOM hasta koordinatı, LPS). STL dosyaları aynı koordinatlardadır; BT ile üst üste açılabilir.</p>
<p><small>${esc(swLine(t => t))}</small></p>
<p><small>Araştırma prototipi çıktısıdır, klinik kullanım için doğrulanmamıştır. Guide 0,4 mm voksel çözünürlüğünde üretilmiştir.</small></p></html>`;
  }
  async function offer(filename, blob) {
    const api = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (api) {
      try { await api.save({ filename, data: blob }); $('expMsg').textContent = `${filename} kaydedildi.`; }
      catch (e) { $('expMsg').textContent = e.code === 'declined' ? 'Kaydetme iptal edildi.' : `${xl('Dosya kaydedilemedi')} (${e.code || e.message}).`; }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // ---------- production STL on the server (surface booleans with Manifold) ----------
  // c = { vol, red, F, thr (HU, or null for AI masks), g, P, u, v, n, pls:[{p,N,w}], scs:[{sc,dir,entry}] }
  function guideRequest(c) {
    const { vol, g } = c, arr = q => [q.x, q.y, q.z];
    const top = g.clear + g.wall + Math.max(g.bridge, 0, ...c.scs.map(s => s.sc.sleeveH)) + 6;
    const ss = stopSides(g, c.v), sx = ss.pos || ss.neg ? (g.stopL || 6) : 0, sz = ss.pos || ss.neg ? (g.stopD || 5) : 0;
    const deep = Math.max(g.wrap + 4, ...(c.wrapProfile || []).map(q => 4 - q[1])) + sz, R = Math.hypot(Math.abs(g.uc || 0) + g.L / 2 + 4, Math.abs(g.vc || 0) + g.W / 2 + 4 + sx, Math.max(deep, top)) + 6, ic = G.indexOf(vol, arr(c.P)), dims = [vol.nx, vol.ny, vol.nz];
    const lo = [0, 1, 2].map(a => Math.max(0, Math.floor(ic[a] - R / vol.sp[a]))), hi = [0, 1, 2].map(a => Math.min(dims[a] - 1, Math.ceil(ic[a] + R / vol.sp[a])));
    const [nx, ny, nz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1);
    if (nx < 2 || ny < 2 || nz < 2) throw new Error('Guide bölgesi hacmin dışında.');
    const mask = new Uint8Array(nx * ny * nz), cut = c.thr == null ? 0.5 : 0.05;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const hu = vol.hu[lo[0] + i + vol.nx * (lo[1] + j + vol.ny * (lo[2] + k))];
      if (c.thr != null && hu < c.thr) continue;
      if (fieldAt(c.red, c.F, G.worldOf(vol, lo[0] + i, lo[1] + j, lo[2] + k)) > cut) mask[i + nx * (j + ny * k)] = 1;
    }
    let bin = ''; for (let i = 0; i < mask.length; i += 0x8000) bin += String.fromCharCode.apply(null, mask.subarray(i, i + 0x8000));
    return {
      crop: { nx, ny, nz, sp: vol.sp.slice(), origin: G.worldOf(vol, ...lo), axes: vol.axes.map(a => a.slice()) }, mask_b64: btoa(bin),
      frame: { p: arr(c.P), u: arr(c.u), v: arr(c.v), n: arr(c.n) }, g: Object.assign(clone(c.g), { clear: c.g.clear + (c.g.peri || 0) }), resolution: 0.2,
      planes: c.pls.map(pl => ({ p: arr(pl.pSlot || pl.p), N: arr(pl.N), w: pl.w })),
      gap: (gp => gp && { A: { p: arr(gp.A.p), N: arr(gp.A.N), w: gp.A.w }, B: { p: arr(gp.B.p), N: arr(gp.B.N), w: gp.B.w }, flange: c.g.flange })(c.gap || splitGap(c.g, c.pls)),
      screws: c.scs.filter(s => s.entry).map(s => ({ entry: arr(s.entry), dir: arr(s.dir), d: s.sc.d + (c.g.fit || 0), D: s.sc.D, sleeveH: s.sc.sleeveH })),
      wrap_profile: c.wrapProfile || null,
      stops: ss.pos || ss.neg ? { pos: ss.pos ? [g.stopL || 6, g.stopD || 5] : null, neg: ss.neg ? [g.stopL || 6, g.stopD || 5] : null } : null,
      // the insertion direction the preview body was built for: the server builds its envelope along the same one
      seat_dir: c.seatDir ? { tilt: c.seatDir.tilt, az: c.seatDir.az } : null,
    };
  }
  async function serverGuide(c, outer) {
    const url = serverUrl(); if (!url) throw new Error('Bu işlem sunucu gerektirir; yayındaki sitede (sguide.up.railway.app) çalışır. Pakette önizleme STL\'i vardır.');
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 180000);
    if (outer) outer.addEventListener('abort', () => ac.abort());
    let res;
    try { res = await sfetch(url + '/guide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guideRequest(c)), signal: ac.signal }); }
    catch (e) { if (outer && outer.aborted) throw new Error('Üretim STL\'i iptal edildi.'); throw new Error(`Sunucuya ulaşılamadı. Pakette önizleme STL'i vardır.`); }
    finally { clearTimeout(to); }
    const js = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${xl('Sunucu hatası:')} ${js.error || res.status}`);
    const bin = atob(js.stl_b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return Object.assign({ stl: u8, watertight: js.watertight, bodies: js.bodies, volume: js.volume_mm3, faces: js.faces, ms: js.ms }, prodReply(js, c.scs.filter(s => s.entry)));
  }
  // what the server says about printing this STL (P5, P6, E3): production_ok, why not (issues: screw_no_body with the
  // index of the request's screw, resolution_coarsened, not_manifold), its grid and its version. A reply without
  // production_ok (an older server) is judged by watertight alone. screwNos: the plan's screw numbers (1-based) of the
  // screws the server could not give a body; a screw that is not one of the plan's (the bar's lug, a fibula screw) is 0.
  function prodReply(js, sent) {
    const issues = Array.isArray(js.issues) ? js.issues.filter(i => i && typeof i.code === 'string') : [];
    const ok = typeof js.production_ok === 'boolean' ? js.production_ok : !!js.watertight;
    const screwNos = issues.filter(i => i.code === 'screw_no_body').map(i => { const s = sent && sent[i.screw]; return s ? S.screws.indexOf(s.sc) + 1 : 0; });
    return { productionOk: ok, issues, screwsMissing: Number.isFinite(js.screws_missing) ? js.screws_missing : screwNos.length, screwNos,
      resolution: Number.isFinite(js.resolution) ? js.resolution : null, requestedResolution: Number.isFinite(js.requested_resolution) ? js.requested_resolution : null, version: typeof js.version === 'string' ? js.version : null };
  }
  async function serverBar(spec, outer) {
    const url = serverUrl(); if (!url) throw new Error('Bu işlem sunucu gerektirir; yayındaki sitede (sguide.up.railway.app) çalışır. Pakette önizleme STL\'i vardır.');
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 180000);
    if (outer) outer.addEventListener('abort', () => ac.abort());
    let res;
    try { res = await sfetch(url + '/guide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(barRequest(spec, { vol: S.vol, red: S.red, F: S.maskF, thr: segThr() })), signal: ac.signal }); }
    catch (e) { if (outer && outer.aborted) throw new Error('Üretim STL\'i iptal edildi.'); throw new Error(`Sunucuya ulaşılamadı. Pakette önizleme STL'i vardır.`); }
    finally { clearTimeout(to); }
    const js = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${xl('Sunucu hatası:')} ${js.error || res.status}`);
    const bin = atob(js.stl_b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { stl: u8, watertight: js.watertight, bodies: js.bodies, volume: js.volume_mm3, clear: js.bone_clear_mm, inBone: js.in_bone_verts };
  }
  const prodKey = () => JSON.stringify([S.source && S.source.fp, S.g, S.anchor && vec(S.anchor.p), S.anchor && vec(S.anchor.n), S.planes.map(p => [p.off, p.yaw, p.pitch, p.w]), S.screws.map(s => [s.u, s.v, s.tiltU, s.tiltV, s.d, s.D, s.sleeveH, s.part || 0]), S.segMethod, $('thr').value, [...S.selected].sort((a, b) => a - b), window.SegEdit ? SegEdit.key() : '']);
  const segThr = () => (/^Eşik/.test(S.segMethod) && !(window.SegEdit && SegEdit.edited()) ? +$('thr').value : null);
  async function productionSTL() {
    if (!parts.guide || !S.anchor) return;
    const ac = new AbortController();
    const nSt = 1 + (S.result && S.result.bar && S.result.bar.ok ? 1 : 0) + (S.fib && S.fib.guide && window.Fibula ? 1 : 0), bo = { bar: true, cancel: () => ac.abort(), max: 180 };
    let stN = 0; const stage = t => busy(true, `${t} ${++stN}/${nSt}`, bo);
    stage('Sunucuda üretim STL\'i hazırlanıyor…'); await sleep();
    try {
      let r;
      if (S.result && S.result.parts && S.result.parts.length === 2) {
        // a two-frame guide: one server call per piece on its own frame, the two STLs joined into one file
        const rs = [];
        for (const pt of S.result.parts) rs.push(await serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: segThr(), g: pt.g, P: pt.frame.P, pls: pt.pls, gap: pt.gap, scs: pt.lug ? pt.scs.concat([pt.lug]) : pt.scs, wrapProfile: pt.wrapProfile, seatDir: pt.result.seatDir }, pt.frame), ac.signal));
        r = { stl: mergeStl(rs[0].stl, rs[1].stl), watertight: rs.every(x => x.watertight), bodies: rs.reduce((s, x) => s + x.bodies, 0), volume: rs.reduce((s, x) => s + x.volume, 0), faces: rs.reduce((s, x) => s + x.faces, 0), ms: rs.reduce((s, x) => s + x.ms, 0),
          productionOk: rs.every(x => x.productionOk), issues: rs.flatMap((x, k) => x.issues.map(i => Object.assign({ piece: k + 1 }, i))), screwsMissing: rs.reduce((s, x) => s + x.screwsMissing, 0), screwNos: rs.flatMap(x => x.screwNos),
          resolution: Math.max(...rs.map(x => x.resolution || 0)) || null, requestedResolution: rs[0].requestedResolution, version: rs[0].version };
      } else r = await serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: segThr(), g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), wrapProfile: S.result && S.result.wrapProfile, seatDir: S.result && S.result.seatDir }, frameAxes()), ac.signal);
      // the connecting bar: a separate part, its own server call (exact solids; the server also measures its bone clearance)
      if (S.result && S.result.bar && S.result.bar.ok) stage('Sunucuda bağlantı köprüsü hazırlanıyor…');
      if (S.result && S.result.bar && S.result.bar.ok) r.bar = await serverBar(S.result.bar.spec, ac.signal);
      S.prod = Object.assign(r, { key: prodKey() });
      $('prodMsg').textContent = `${xl("Üretim STL'i hazır:")} ${r.watertight ? xl('su geçirmez') : xl('SU GEÇİRMEZ DEĞİL')}, ${xl(`${r.bodies} parça`)}${r.bodies > (S.g.split ? 2 : 1) ? ' ' + xl("(BEKLENENDEN FAZLA PARÇA, guide'ı kontrol edin)") : ''}, ${fmt(r.volume / 1000, 2)} cm³, ${xl(`${r.faces} üçgen`)}. ${xl('Pakete guide_uretim.stl olarak eklenir.')}`;
      const pw = prodWhy(r); if (pw) $('prodMsg').textContent += ' ' + pw;
      if (r.bar) $('prodMsg').textContent += ` ${xl("Köprü STL'i:")} ${r.bar.watertight ? xl('su geçirmez') : xl('SU GEÇİRMEZ DEĞİL')}${r.bar.clear != null ? ', ' + xl(`kemiğe en yakın ${fmt(r.bar.clear)} mm`) : ''}. ${xl('Pakete kopru_uretim.stl olarak eklenir.')}`;
      if (S.fib && S.fib.guide && window.Fibula && !ac.signal.aborted) try { stage('Sunucuda fibula guide\'ı hazırlanıyor…'); await Fibula.production(ac.signal); } catch (e) { $('prodMsg').textContent += ` Fibula guide'ı: ${e.message}`; }
    } catch (e) { S.prod = null; $('prodMsg').textContent = e.message; }
    busy(false);
    renderChecks(); renderAppr();
  }
  // the server's reasons not to print an STL, in words (the production message, the checks, the reports)
  function prodWhy(r) {
    if (!r || !r.issues) return '';
    const out = [];
    if (r.productionOk === false) out.push(xl('SUNUCU: BU STL BASILAMAZ.'));
    const nos = (r.screwNos || []).filter(n => n > 0), other = (r.screwNos || []).length - nos.length;
    if (nos.length) out.push(xl(`Vida ${nos.join(', ')} üretim STL'inde yok (kovan ve delik açılamadı).`));
    if (other) out.push(xl(`${other} vida (köprü bağlantısı ya da fibula) üretim STL'inde yok.`));
    const co = r.issues.find(i => i.code === 'resolution_coarsened');
    if (co) out.push(co.coarser_than_preview ? xl(`Izgara ${fmt(co.used_mm, 2)} mm'ye kabalaştırıldı (istenen ${fmt(co.requested_mm, 2)} mm), önizlemeden kaba.`) : xl(`Izgara ${fmt(co.used_mm, 2)} mm'ye kabalaştırıldı (istenen ${fmt(co.requested_mm, 2)} mm).`));
    if (r.issues.some(i => i.code === 'not_manifold')) out.push(xl('Ağ kapalı değil (manifold dışı kenar).'));
    return out.join(' ');
  }
  async function exportPackage() {
    if (!parts.guide || $('expZip').disabled) return;   // (the button's own gate: approvals, critical checks, surgeon)
    // an edit was made moments ago and the guide / resection is still being rebuilt: the files would not match the approved plan
    if (rebuildPending) {
      busy(true, 'Guide güncelleniyor…');
      for (let i = 0; i < 1200 && rebuildPending; i++) await new Promise(r => setTimeout(r, 50));
      busy(false);
      if (rebuildPending || $('expZip').disabled) { alertMsg('Plan yeni değişti; guide güncellenip onaylar yenilenmeden paket alınamaz.'); return; }
    }
    // the plate is planned but has no computed path (a stale state): recompute once, and warn if the plate files are still missing
    if (window.Plate && Plate.missing()) { try { await Plate.update(); } catch (e) { /* warned below */ } }
    const plateMissing = !!(window.Plate && Plate.missing());
    const prod = S.prod && S.prod.key === prodKey() ? S.prod : null;
    const files = [{ name: prod ? 'guide_onizleme.stl' : 'guide.stl', data: stlOf(parts.guide.obj) }, { name: 'kemik_kalan.stl', data: stlOf(parts.bone.obj) }];
    const fg = fullBoneGeo(); if (fg) files.push({ name: 'kemik_tam.stl', data: stlOf(new THREE.Mesh(fg)) });
    if (prod) files.unshift({ name: 'guide_uretim.stl', data: prod.stl });
    // the connecting bar is printed as its own part
    if (prod && prod.bar) files.push({ name: 'kopru_uretim.stl', data: prod.bar.stl }); else if (parts.bar) files.push({ name: 'kopru.stl', data: stlOf(parts.bar.obj) });
    if (window.Fibula) Fibula.exportFiles(files);
    (window.ExportHooks || []).forEach(f => { try { f(files); } catch (e) { /* optional files */ } });
    if (parts.resected) files.push({ name: 'rezeke_parca.stl', data: stlOf(parts.resected.obj) });
    // plan.json is the whole plan (planOf), so the package can be opened again (dropped on the view, D2); the short
    // summary that used to be the file stays in it under `ozet`
    let summary = null; try { summary = JSON.parse($('json').textContent || 'null'); } catch (e) { /* none yet */ }
    files.push({ name: 'plan.json', data: JSON.stringify(Object.assign(planOf(), { ozet: summary, software: swInfo() }), null, 2) }, { name: 'rapor.html', data: reportHTML() });
    let pdfFailed = false;
    if (window.Report) try { files.push({ name: 'cerrahi_rapor.pdf', data: new Uint8Array(await (await Report.build()).arrayBuffer()) }); } catch (e) { pdfFailed = true; console.warn('pdf report', e); }   // the HTML report is still in the package
    await offer('guide_paketi.zip', zip(files));
    if (pdfFailed) alertMsg('UYARI: PDF rapor oluşturulamadı; pakette yalnız HTML rapor var.');
    if (plateMissing) alertMsg('UYARI: Plak planlı ama plak hattı hesaplanamadı; pakette plak dosyaları YOK. Plak bölümünü kontrol edip paketi yeniden alın.');
    emit('exported');
  }
  // single files from the Teslim step: bone models any time, the guide only once the plan is ready for production
  async function exportOne(kind) {
    const prod = S.prod && S.prod.key === prodKey() ? S.prod : null;
    if (kind === 'full') { const g = fullBoneGeo(); if (g) await offer('kemik_tam.stl', new Blob([stlOf(new THREE.Mesh(g))])); }
    else if (kind === 'bone' && parts.bone) await offer('kemik_kalan.stl', new Blob([stlOf(parts.bone.obj)]));
    else if (kind === 'res' && parts.resected) await offer('rezeke_parca.stl', new Blob([stlOf(parts.resected.obj)]));
    else if (kind === 'guide' && parts.guide && !$('expZip').disabled) await offer(prod ? 'guide_uretim.stl' : 'guide.stl', new Blob([prod ? prod.stl : stlOf(parts.guide.obj)]));
  }
  function syncOne() {
    const b = k => $('oneStl').querySelector(`[data-one="${k}"]`);
    b('full').disabled = !S.maskF; b('bone').disabled = !parts.bone; b('res').disabled = !parts.resected; b('guide').disabled = !parts.guide || $('expZip').disabled;
  }
  async function exportReport() { if (S.anchor) await offer('guide_raporu.html', new Blob([reportHTML()])); }

  // ---------- plan state: serialise / restore (case store, versions, undo) ----------
  const vec = q => [q.x, q.y, q.z].map(x => Math.round(x * 1000) / 1000);
  const unit = q => [q.x, q.y, q.z].map(x => x + 0);
  const clone = o => JSON.parse(JSON.stringify(o));
  function planOf() {
    const r = S.red;
    return {
      schema: 1, source: S.source ? clone(S.source) : null,
      seg: { thr: +$('thr').value, method: S.segMethod || '', sel: r ? S.comps.filter(c => S.selected.has(c.label)).map(c => G.worldOf(r, ...c.centroid).map(x => Math.round(x * 10) / 10)) : [] },
      // the frame's unit vectors are kept at full precision: rounded to 1e-3 and renormalised on reading they no longer
      // match the approval signatures (itemSig compares them to 1e-4), and every approval dropped on reopen or undo
      anchor: S.anchor ? { p: vec(S.anchor.p), n: unit(S.anchor.n), axis: unit(S.anchor.axis), ...(S.anchor.base ? { base: { p: vec(S.anchor.base.p), n: unit(S.anchor.base.n), c: vec(S.anchor.base.c) } } : {}) } : null,
      g: clone(S.g), gAuto: clone(S.gAuto), lesion: clone(S.lesion), planes: clone(S.planes), screws: clone(S.screws),
      perSide: +$('perSide').value || 2, guideOn: !!S.guideOn, resRemoved: !!S.resRemoved, surgeon: $('surgeon').value.trim(), fibula: S.fib ? clone(S.fib.plan) : null,
      measures: clone(S.measures || []), ext: window.PlanExt ? Object.fromEntries(Object.entries(PlanExt).map(([k, f]) => [k, f.get()])) : {},
      // the studio version that wrote the plan (not part of the approval hash: audit.js leaves it out)
      software: { studio: studioVersion() },
    };
  }
  // which software made the plan and the files (traceability): the studio's version from the server's config.js and the
  // production server's version from its /guide reply (only while that STL still matches the plan)
  function studioVersion() { return typeof window.YOLMED_VERSION === 'string' && window.YOLMED_VERSION ? window.YOLMED_VERSION : null; }
  function swInfo() {
    const p = S.prod && S.prod.key === prodKey() ? S.prod : null;
    return { studio: studioVersion(), guide_server: (p && p.version) || null };
  }
  // the "Yazılım sürümü" line of the reports (t: the translation; rapor.html is always Turkish)
  function swLine(t = xl) {
    const v = swInfo();
    return `${t('Yazılım sürümü:')} ${v.studio || t('bilinmiyor (sunucusuz önizleme)')}${v.guide_server && v.guide_server !== v.studio ? ` · ${t('üretim sunucusu')} ${v.guide_server}` : ''}`;
  }
  async function applyPlan(plan) {
    S.restoring = true; S.autoAnchor = false;
    try {
      const t0 = Number(plan.seg && plan.seg.thr), thr = Number.isFinite(t0) ? Math.max(120, Math.min(800, Math.round(t0 / 10) * 10)) : 250;
      if (plan.seg && typeof plan.seg.method === 'string' && /^Yapay zeka/.test(plan.seg.method) && !/^Yapay zeka/.test(S.segMethod || ''))
        alertMsg('Bu plan yapay zeka segmentasyonuyla yapılmıştı; şimdi eşikle açıldı. Kemik modeli ve guide kayıttakinden farklı olabilir.');
      if (+$('thr').value !== thr) { $('thr').value = thr; $('thrO').textContent = thr + ' HU'; await segment(false); }
      if (plan.seg && plan.seg.sel && plan.seg.sel.length && S.red) {
        const want = new Set();
        plan.seg.sel.forEach(w => { let best = null, bd = 15; S.comps.forEach(c => { const d = V(...G.worldOf(S.red, ...c.centroid)).distanceTo(V(...w)); if (d < bd) { bd = d; best = c; } }); if (best) want.add(best.label); });
        if (want.size) S.selected = want;
        renderComps();
      }
      // a vector saved at full precision is already unit: kept bit for bit (renormalising moves its last digits, and the
      // approval signatures and the plan hash would no longer match); a 1e-3 vector of an older plan is normalised
      const unitOf = q => (Math.abs(q.lengthSq() - 1) < 1e-12 ? q : q.normalize());
      const v3 = a => (Array.isArray(a) && a.length === 3 && a.every(x => Number.isFinite(+x)) ? V(+a[0], +a[1], +a[2]) : null);
      const an = plan.anchor && { p: v3(plan.anchor.p), n: v3(plan.anchor.n), axis: v3(plan.anchor.axis) };
      S.anchor = an && an.p && an.n && an.n.lengthSq() > 1e-6 && an.axis && an.axis.lengthSq() > 1e-6 && an.axis.clone().normalize().cross(an.n.clone().normalize()).lengthSq() > 1e-4
        ? { p: an.p, n: unitOf(an.n), axis: unitOf(an.axis) } : null;
      const ab = S.anchor && plan.anchor.base && { p: v3(plan.anchor.base.p), n: v3(plan.anchor.base.n), c: v3(plan.anchor.base.c) };
      if (ab && ab.p && ab.c && ab.n && ab.n.lengthSq() > 1e-6) S.anchor.base = { p: ab.p, n: unitOf(ab.n), c: ab.c };
      const num = (o, keys, d) => { const r = {}; keys.forEach(k => { const v = Number(o && o[k]); r[k] = Number.isFinite(v) ? v : d[k]; }); return r; };
      const who = o => ({ ok: !!(o && o.ok), ...(o && o.ok && typeof o.by === 'string' ? { by: o.by.slice(0, 120) } : {}), ...(o && o.ok && typeof o.at === 'string' ? { at: o.at.slice(0, 40) } : {}), ...(o && o.ok && typeof o.sig === 'string' ? { sig: o.sig.slice(0, 32) } : {}) });
      const G0 = G_DEFAULT;
      Object.assign(S.g, num(plan.g, Object.keys(G0), G0));
      // plans saved before the kerf setting existed had the slot centred on the plane: keep them as they were approved
      if (!plan.g || plan.g.kerfSide === undefined) S.g.kerfSide = 0;
      S.g.kerfSide = S.g.kerfSide ? 1 : 0;
      S.g.wrapU = Array.isArray(plan.g && plan.g.wrapU) ? plan.g.wrapU.slice(0, 64).map(x => [Number(x[0]), Number(x[1])]).filter(x => x.every(Number.isFinite) && x[1] >= 1 && x[1] <= 20) : null;
      if (S.g.wrapU && S.g.wrapU.length < 2) S.g.wrapU = null;
      const ga = plan.gAuto && typeof plan.gAuto === 'object' ? plan.gAuto : {};
      Object.keys(AUTO_DEFAULT).forEach(k => { S.gAuto[k] = ga[k] === undefined ? 1 : (ga[k] ? 1 : 0); });
      // keep every value inside the range its control allows (a hand-edited or damaged plan cannot hang the app)
      const clampTo = (o, k, a, b) => { o[k] = Math.max(a, Math.min(b, o[k])); };
      gFields.forEach(([k, , a, b]) => clampTo(S.g, k, a, b));
      clampTo(S.g, 'vc', -15, 15);
      S.g.side = S.g.side < 0 ? -1 : 1; S.g.split = S.g.split === 2 ? 2 : S.g.split ? 1 : 0; clampTo(S.g, 'fit', -0.5, 0.5);
      S.g.stopT = S.g.stopT ? 1 : 0; S.g.stopB = S.g.stopB ? 1 : 0; clampTo(S.g, 'stopL', 2, 15); clampTo(S.g, 'stopD', 1, 15);
      S.g.stopP = S.g.stopP ? 1 : 0; S.g.bar = S.g.bar ? 1 : 0;
      const L0 = { from: -6, to: 6, margin: 3 }, pl = plan.lesion || {};
      S.lesion = Object.assign(num(pl, ['from', 'to', 'margin'], L0), who(pl), { condyle: pl.condyle === 'R' || pl.condyle === 'L' ? pl.condyle : null });
      const P0 = { off: 0, yaw: 0, pitch: 0, w: 1.2 }, C0 = Object.assign({ u: 0, v: 0, tiltU: 0, tiltV: 0 }, SCREW_DEFAULT.mandible);
      // pv / pn: the cut's point moved within its plane (a cut turned with the bone, cutAlongBone). The plane is the same
      // without them, but the cut point is where the defect, the graft ends and the plan hash start from: keep them
      const dropKey = p => [p.off, p.yaw, p.pitch, p.pv, p.pn].join('|'), drops = (S.screwDrops || []).filter(d => d.pl).map(d => Object.assign({}, d, { key: dropKey(d.pl) }));
      S.planes = (Array.isArray(plan.planes) ? plan.planes : []).slice(0, 8).map(p => Object.assign(num(p, Object.keys(P0), P0), who(p),
        ...['pv', 'pn'].map(k => (p && p[k] !== undefined && p[k] !== null ? { [k]: Number(p[k]) } : {}))));
      // a side the automatic placement left without a screw stays reported while the same cut is there (liveDrops then
      // compares with the restored screws), and is gone with that cut (W7)
      S.screwDrops = drops.map(d => { const pl = S.planes.find(p => dropKey(p) === d.key); if (!pl) return null; d.pl = pl; delete d.key; return d; }).filter(Boolean);
      // older versions could save an empty (null) screw when no position reached bone: drop it, re-place the screws
      const rawScrews = (Array.isArray(plan.screws) ? plan.screws : []).slice(0, 16), lostScrew = rawScrews.some(c => !c || typeof c !== 'object');
      // part: the piece frame (two-guide layout) a screw's (u, v, tilts) are written in; without it the screw would be read
      // in the guide frame and land somewhere else (between the cuts) while still looking approved (W1)
      S.screws = rawScrews.filter(c => c && typeof c === 'object').map(c => Object.assign(num(c, Object.keys(C0), C0), who(c), c.plate === true ? { plate: true } : {}, c.hand === 1 || c.hand === true ? { hand: 1 } : {}, c.part === -1 || c.part === 1 ? { part: c.part } : {}));
      S.planes.forEach(p => { clampTo(p, 'off', -80, 80); ['pv', 'pn'].forEach(k => { if (p[k] !== undefined) { if (typeof p[k] !== 'number' || !isFinite(p[k])) delete p[k]; else clampTo(p, k, -80, 80); } }); clampTo(p, 'yaw', -89, 89); clampTo(p, 'pitch', -89, 89); clampTo(p, 'w', 0.6, 2.5); });
      S.screws.forEach(c => { if (c.part !== -1 && c.part !== 1) delete c.part; clampTo(c, 'u', -80, 80); clampTo(c, 'v', -40, 40); clampTo(c, 'tiltU', -89, 89); clampTo(c, 'tiltV', -89, 89); clampTo(c, 'd', 0.5, 6); clampTo(c, 'D', c.d, 12); clampTo(c, 'sleeveH', 0, 20); clampTo(c, 'len', 2, 40); });
      ['from', 'to'].forEach(k => clampTo(S.lesion, k, -45, 45)); clampTo(S.lesion, 'margin', 0, 15);
      // approvals whose stamp does not match the restored values (edited after approval, or saved before stamps were bound)
      let unbound = 0;
      [[S.lesion, 'l']].concat(S.planes.map(p => [p, 'p']), S.screws.map(c => [c, 's'])).forEach(([o, k]) => { if (o.ok && o.sig !== itemSig(o, k)) { unapprove(o); unbound++; } else if (!o.ok) delete o.sig; });
      if (unbound) alertMsg(xl(`Plandaki ${unbound} öğe onayı kayıtlı değerlerle eşleşmiyor (onaydan sonra değiştirilmiş ya da eski sürümde kaydedilmiş); bu öğeleri yeniden onaylayın.`));
      if (plan.perSide === 1 || plan.perSide === 2) $('perSide').value = String(plan.perSide);
      // plans from before the explicit 'Guide oluştur' step always had a guide when they had screws
      S.guideOn = typeof plan.guideOn === 'boolean' ? plan.guideOn : S.screws.length > 0; S.resRemoved = !!plan.resRemoved;
      $('surgeon').value = typeof plan.surgeon === 'string' ? plan.surgeon : '';
      if (S.sel && !(S.sel[0] === 'p' ? S.planes : S.screws)[+S.sel.slice(1)]) S.sel = null;
      if (lostScrew && S.anchor && S.planes.length) { placeScrews(); alertMsg('Planda boş bir vida kaydı vardı; vidalar yeniden yerleştirildi. Kontrol edip onaylayın.'); }
      syncGuideInputs(); syncLesion(); showAnchor(); updateLesionPart(); if (S.anchor && S.mode === 'anchor') setMode('orbit');
      if (!S.anchor) { ['guide', 'bar', 'resected', 'lesion'].forEach(id => setPart(id, null, null)); clearElementParts(); S.result = null; }
      const ext = plan.ext || {};
      // one damaged extension must not stop the rest of the plan from opening
      const setExt = async k => { try { await PlanExt[k].set(ext[k] || null); } catch (e) { console.warn('plan ext', k, e); try { await PlanExt[k].set(null); } catch (x) {} } };
      if (window.PlanExt) for (const k in PlanExt) if (PlanExt[k].pre) await setExt(k);
      await rebuildBone(false);
      if (window.Fibula) { try { await Fibula.apply(plan.fibula || null); } catch (e) { console.warn('plan fibula', e); alertMsg('Plandaki fibula bölümü okunamadı.'); } }
      if (window.PlanExt) for (const k in PlanExt) if (!PlanExt[k].pre) await setExt(k);
      if (!S.anchor) { updatePanels(); render(); }
      emit('planApplied', plan);
    } finally { S.restoring = false; S.autoAnchor = true; }
  }
  // open a stored plan: load its volume first when it is a built-in sample; DICOM needs the user to pick the series
  async function openPlan(plan) {
    // a package's plan.json or a plan kept under `plan` by another tool; anything else is not a plan
    if (plan && typeof plan === 'object' && !plan.schema && plan.plan && typeof plan.plan === 'object') plan = plan.plan;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !(plan.schema || plan.planes || plan.anchor)) throw new Error(xl('dosya bir plan değil'));
    const src = plan.source;
    if (src && src.type === 'sample' && !(S.source && S.source.fp === src.fp)) { S.autoAnchor = false; S.restoring = true; await loadSample(src.name); }
    else if (src && src.type === 'dicom' && !(S.source && S.source.fp === src.fp)) {
      S.pendingPlan = plan;
      alertMsg(`${xl('Bu vaka')} "${src.name}" ${xl(`serisine (${src.slices || '?'} kesit) ait. Planı açmak için aynı DICOM serisini yükleyin.`)}`);
      return false;
    }
    await applyPlan(plan); return true;
  }
  // every call to the server goes through auth.js: it carries the access token and asks for it again on a 401 (G2)
  function sfetch(u, o) { return window.ServerAuth ? ServerAuth.fetch(u, o) : fetch(u, o); }
  function serverUrl() { return ($('aiUrl').value || '').trim().replace(/\/+$/, ''); }
  function select(sel) { if (sel) S.guideSel = false; S.sel = sel; emit('select', sel); renderElements(); rebuildElementParts(S.result ? S.result.pls : planesWorld(), S.result ? S.result.screwInfo : []); applyExplode(); render(); }
  window.Studio = { renamePart, partName, guideBuilds: () => guideBuilds, mandibleView, endModes, onEndModes, startLoad, loadStopped, loadBusy: () => committing, LOAD_CANCELLED, renderComps, setGuideRot, setGuideRoll, planFromLesion, fitWrap, anchorFromLesion, placeScrews, caseLine, renderParts, resEnds, splitGap, cutMisses, evalScrew, resectedAt, resectedNear, resPiece, boneTrack, cutAlongBone, bestScrew,
    boneSections, sizeBody, autoBody, buildGuideSet, cutsAngle, cutFrame, pieceFrames, pieceBody, screwBodyOn, pieceWrapTop, frameAt, stumpGap, mergeStl, mergeMeshes, AUTO_DEFAULT, G_DEFAULT, unapproveAll, pendingList: pending, gizmo, proxy, syncGizmo, live, camF, ctlF, setSplit, resize, goTo, refPos, approveItem, renderChecks, updateMarkers, placeMarkers, renderElements, esc, ray, toWorldRed, setMode, rebuildBone, segment, S, parts, buildGuide, boneAtIn, meshFromNets, applyExplode, renderer, bus, emit, render, scene, camera, controls, renderer, V, fmt, planOf, applyPlan, openPlan, frameAxes, planesWorld, screwWorld, schedule, select, serverUrl, alertMsg, busy, boneAt, unapprove, mat, setPart, COLORS, fitTo, rebuildResection, regenerate, updatePanels, sleep, fieldAt, serverGuide, guideRequest, stlOf, offer, zip, zipBytes, G, segThr, screwsWorld, deg, readSample, readDicom, stamp, clone, renderAppr, setVolume, boneField, simplifyMesh, BAR, barPlan, barSdf, buildBarMesh, placeLug, longCase, axisOffBone, ramusAxis, stopSides, LONG_MM, CUT_OFF_MAX, prodKey, serverBar, guideField, lockState: () => lock, bonelessCut, reframe, exclusive, settled, makeGuide, prodReply, prodWhy, gateChecks, swInfo, swLine, sfetch, reportHTML };
  bus.addEventListener('planeDragged', () => { renderElements(); schedule(true, true); });
  // messages assembled at run time are written in the language that was active: write them again when it changes
  if (window.addEventListener) window.addEventListener('langchange', () => { try { renderChecks(); renderAppr(); syncLesion(); } catch (e) { /* no case open yet */ } });
  emit('ready');

  try { await loadSample('mandible'); } catch (e) { busy(false); alertMsg('Örnek vaka açılamadı: ' + e.message); }
})();
