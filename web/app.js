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
  let busyTick = null, busyCancelFn = null;
  const busy = (on, text, opt = {}) => {
    $('busy').hidden = !on; if (text) $('busyText').textContent = text;
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
  function progress(ctl) {
    const t0 = performance.now(); let last = -1e9;
    clearInterval(busyTick); $('busy').hidden = false; $('busyBar').hidden = false; $('busyBar').classList.add('det'); $('busyCancel').hidden = !ctl;
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
  const stamp = o => { o.ok = true; o.by = $('surgeon').value.trim(); o.at = new Date().toISOString(); };
  const unapprove = o => { o.ok = false; delete o.by; delete o.at; };
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
  async function loadSample(name) {
    busy(true, 'Örnek vaka indiriliyor…');
    const vol = await readSample(name);
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
      ser = hit || groups.find(g => !seriesInfo(g).warn) || groups[0];
    }
    const sc = { groups, zipName, skipped }, res = await decodeSeries(ser, prog, zw + pw, dw, sc);
    if (!res.error) res.scan = sc;
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
    const { groups, zipName, skipped } = sc, bySeries = Object.fromEntries(groups.map(g => [g[0].series, g]));
    sc.cur = groups.indexOf(ser);
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
    return { source, vol: { hu, nx: cols, ny: rows, nz: ser.length, sp: [ps[1], ps[0], dz], origin: ser[0].ipp,
      axes: [[r.x, r.y, r.z], [c.x, c.y, c.z], [nrm.x, nrm.y, nrm.z]], meta }, label: `${zipName || ((ser[0].path || '').includes('/') ? ser[0].path.split('/')[0] : 'DICOM')}${groups.length > 1 && source.name ? ' · ' + source.name : ''} · ${xl(`${ser.length} kesit`)}${skipped ? xl(`, ${skipped} dosya atlandı`) : ''}` };
  }
  const dstr = (ds, tag) => (ds.string(tag) || '').replace(/\0/g, '').trim();
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
    if (S.anchor && !confirm('Başka seri açılınca kesiler ve guide silinir. Devam edilsin mi?')) { renderSeries(); return; }
    if (loadBlocked()) { renderSeries(); return; }
    const ctl = startLoad(), prog = progress(ctl); let r;
    try { await prog(0, 'Seri açılıyor…'); r = await decodeSeries(scan.groups[i], prog, 0, 1, scan); } catch (e) { if (e !== LOAD_CANCELLED) { if (loadCtl === ctl) loadCtl = null; throw e; } }
    if (loadStopped(ctl) || !r) { renderSeries(); return; }
    if (loadCtl === ctl) loadCtl = null;
    if (r.error) { busy(false); alertMsg(r.error); renderSeries(); return; }
    S.source = r.source; await setVolume(r.vol, r.label, 'dicom');
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
    try { return await setVolumeNow(vol, label, kind); } finally { committing = false; }
  }
  async function setVolumeNow(vol, label, kind) {
    $('caseMsg').hidden = true;
    S.vol = vol; S.kind = kind;
    busy(true, 'Hacim küçültülüyor…'); await sleep();
    S.red = G.reduce(vol, 0.8);
    $('caseInfo').innerHTML = `<dt>Vaka</dt><dd>${esc(label)}</dd><dt>Boyut</dt><dd>${vol.nx}×${vol.ny}×${vol.nz}</dd><dt>Voksel</dt><dd>${vol.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd><dt>Çalışma ızgarası</dt><dd>${S.red.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd>`;
    S.qcBase = qualityCheck(vol); S.segWarn = []; syncQC();
    S.anchor = null; S.planes = []; S.screws = []; S.sel = null; S.result = null; S.guideOn = false; S.resRemoved = false; unapprove(S.lesion);
    // a new volume is a new patient: the previous case's guide settings and lesion bounds must not carry over (a plan restore keeps its own)
    if (S.autoAnchor !== false) { Object.assign(S.g, G_DEFAULT, { wrapU: null }); Object.assign(S.gAuto, AUTO_DEFAULT); S.fitLog = []; S.autoSize = null; Object.assign(S.lesion, { from: -6, to: 6, margin: 3, condyle: null }); syncGuideInputs(); syncLesion(); }
    ['guide', 'resected', 'anchor', 'lesion'].forEach(id => setPart(id, null, null));
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
    busy(true, 'Kemik segmentasyonu (eşik + bileşen ayırma)…'); await sleep();
    const r = S.red, thr = +$('thr').value;
    const m = G.threshold(r, thr);
    const { labels, comps, count } = G.components(m, r.nx, r.ny, r.nz, 200);
    S.labels = labels; S.comps = comps.slice(0, 8); S.compNames = null; S.segMethod = `Eşik ${thr} HU (tarayıcı)`; S.segInfo = null;
    let pick = comps.length ? comps[0].label : null;
    // a head CT's threshold mask is one piece (skull + upper jaw + mandible + spine): cut it at its thin necks and take
    // the piece that is built like a mandible; when none is, keep the largest and say so (see segChecks)
    if (window.Bones && Bones.assess(r, labels, comps).cut) {
      busy(true, 'Bitişik kemikler ayrılıyor (kafatası, çene, omurga)…'); await sleep();
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
      const res = await fetch(`${url}/segment?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: r.hu, signal: ac.signal });
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
    busy(true, 'Yüzey modeli oluşturuluyor…'); await sleep();
    const r = S.red, m = new Uint8Array(S.labels.length);
    for (let i = 0; i < m.length; i++) m[i] = S.selected.has(S.labels[i]) ? 1 : 0;
    if (window.SegEdit) SegEdit.applyTo(m);
    S.mask = m; S.maskF = G.blur(m, r.nx, r.ny, r.nz);
    S.segWarn = segChecks(); syncQC();
    await rebuildResection();
    if (frame && parts.bone) fitTo(parts.bone.obj);
    if (S.kind && !S.anchor && S.autoAnchor !== false) presetCase();
    else if (S.anchor) await regenerate();
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
  async function rebuildResection(opts = {}) {
    const r = S.red, nxy = r.nx * r.ny;
    let resMask = null, box = null, best = null;
    const E = resEnds();
    if (E) {
      const { A, B } = E;
      // a condylar resection runs from the cut to the condyle: search a ball around that span, keep the piece at the condyle
      const ap = E.condyle ? A.p.clone().lerp(B.p, 0.5) : S.anchor.p, R = E.condyle ? A.p.distanceTo(B.p) / 2 + 35 : 70, c = G.indexOf(r, [ap.x, ap.y, ap.z]);
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
        let bd = Infinity;
        const near = E.condyle ? B.p : ap;
        comps.forEach(cm => { const d = V(...G.worldOf(r, ...cm.centroid)).distanceTo(near); if (d < bd) { bd = d; best = cm; } });
        resMask = new Uint8Array(cand.length); box = [Infinity, Infinity, Infinity, -1, -1, -1];
        for (let v = 0; v < cand.length; v++) if (labels[v] === best.label) {
          resMask[v] = 1; const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / nxy) | 0;
          if (i < box[0]) box[0] = i; if (j < box[1]) box[1] = j; if (k < box[2]) box[2] = k; if (i > box[3]) box[3] = i; if (j > box[4]) box[4] = j; if (k > box[5]) box[5] = k;
        }
      }
    }
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
      return { A: Object.assign({}, A, { N }), B: { p: c, N: dir, w: 0, off: A.off, virtual: true }, condyle: side };
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
    const key = JSON.stringify([S.anchor.p.toArray(), S.anchor.n.toArray(), S.anchor.axis.toArray(), S.g.rot, S.g.W, S.planes.map(p => [p.off, p.yaw, p.pitch])]);
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
  async function makeGuide() {
    if (!S.anchor || !S.planes.length) { alertMsg('Önce kesileri belirleyin.'); return; }
    S.guideOn = true; placeScrews(); S.sel = null;
    busy(true, 'Rezeksiyon güncelleniyor…'); await sleep(); await rebuildResection();
    busy(true, 'Guide oluşturuluyor…'); await sleep();
    const f = await fitWrap();
    $('guideStat').textContent = !f ? '' : !f.ok ? 'Guide bu yerleşimde takılamıyor; kesileri ya da ayarları kontrol edin.'
      : `Guide hazır · ${S.screws.length} vida` + (f.split ? (S.g.split === 2 ? ' · iki parça, her kesi kendi ekseninde (açı bölgesi)' : ' · iki parça (kavisli kemik)') : '') + (f.wrap < (S.kind === 'leg' ? 6 : 5) ? ` · sarma ${fmt(f.wrap, 1)} mm'ye indirildi` : '');
    syncSeq();
  }
  // one button: region (sample spot, painted lesion, or one click on the model), cuts, resected piece removed, guide
  async function autoPrep() {
    if (!S.red || !parts.bone) return;
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
    if (S.anchor && !confirm('Kesiler, guide ve vidalar silinip baştan başlanacak. Emin misiniz?')) return;
    S.anchor = null; S.planes = []; S.screws = []; S.sel = null; S.result = null; S.grid = null; S.guideOn = false; S.resRemoved = false;
    Object.assign(S.gAuto, AUTO_DEFAULT); S.g.wrapU = null; S.g.vc = 0; S.fitLog = []; S.autoSize = null;
    unapproveAll(); $('guideStat').textContent = '';
    if (window.Lesion && Lesion.clear) Lesion.clear();
    ['guide', 'resected', 'anchor', 'lesion'].forEach(id => setPart(id, null, null)); clearElementParts();
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
  let pfCache = { key: null, frames: null };
  function pieceFrames() {
    if (!S.anchor || S.planes.length < 2) return null;
    const key = JSON.stringify([S.anchor.p.toArray(), S.anchor.n.toArray(), S.anchor.axis.toArray(), S.g.rot, S.g.kerfSide, S.planes.map(p => [p.off, p.yaw, p.pitch, p.w])]);
    if (pfCache.key === key) return pfCache.frames;
    const pls = planesWorld().sort((a, b) => a.off - b.off), { u, n } = frameAxes();
    const a = cutFrame(pls[0], u.clone().negate(), n), b = cutFrame(pls[pls.length - 1], u, n);
    pfCache = { key, frames: a && b ? { a, b, A: pls[0], B: pls[pls.length - 1] } : null };
    return pfCache.frames;
  }
  // the frame a screw's (u, v) refers to: its piece's frame in the two-guide layout (sc.part = -1 / 1), else the guide frame
  function screwFrame(sc) {
    if (S.g.split === 2 && sc.part) { const f = pieceFrames(); if (f) return sc.part < 0 ? f.a : f.b; }
    return Object.assign({ P: S.anchor.p }, frameAxes());
  }
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
    const { A, B } = E;
    if (E.condyle) return q.clone().sub(A.p).dot(A.N) > -m;
    const dir = B.p.clone().sub(A.p).normalize(), NA = A.N.clone(), NB = B.N.clone();
    if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
    return q.clone().sub(A.p).dot(NA) > -m && q.clone().sub(B.p).dot(NB) < m;
  }
  // One screw position judged against the bone: the entry on bone with the sleeve over the guide body, the drill path
  // in bone for at least SCREW_MIN_DEPTH mm (the whole screw length preferred), at least SCREW_SLOT_GAP mm between the
  // sleeve and every saw slot and no bone of the resected region on the path. Returns null when the position is
  // unusable (the reason counted in `why`), else { score, inBone, slotGap }: more bone scores higher, tilt lower.
  const SCREW_SLOT_GAP = 2, SCREW_MIN_DEPTH = 4, SCREW_GAP_MIN = 5, SCREW_GAP_MAX = 15, SCREW_GAP_FAR = 22, SCREW_WRAP_SAFE = 4, L_MAX = 160;
  // The guide body a screw must stand on, for evalScrew: frame = the body's frame, top(uu) = the bone's crest level at
  // uu (relative to frame.P, the level the shell's wrap depth is measured from), crestV(uu) = the lane of that crest,
  // wrap = the wrap depth, cB = clearance under the shell. The fit ladder may still lower the wrap to 2 mm after the
  // screws are placed, so a screw is accepted only within SCREW_WRAP_SAFE mm of the crest level (never deeper than the
  // wrap), and only on a lane the body reaches: walking from the crest to the lane, no column may turn back under
  // itself (an overhang stops the body, as in buildGuide's vLoU / vHiU band).
  function bodyOf(frame, secs, wrap, ref = 0) {
    if (!secs || !secs.length) return null;
    const near = uu => { let b = secs[0]; for (const s of secs) if (Math.abs(s.uu - uu) < Math.abs(b.uu - uu)) b = s; return b; };
    return { frame, wrap, cB: S.g.clear + (S.g.peri || 0), top: uu => Math.min(ref, near(uu).top), crestV: uu => near(uu).vTop, cache: new Map() };
  }
  // the bone column at (uu, vv) of a frame: [top, exit] along n (exit = where the bone ends below the top), or null
  function boneColumn(f, uu, vv, from = 20, to = -45) {
    const q = f.P.clone().addScaledVector(f.u, uu).addScaledVector(f.v, vv), c = V();
    let top = null;
    for (let t = from; t >= to; t -= 0.5) { c.copy(q).addScaledVector(f.n, t); const b = boneAt(c); if (top === null) { if (b) top = t; } else if (!b) return [top, t]; }
    return top === null ? null : [top, to];
  }
  function onBody(body, uu, vv, depth) {
    const key = uu + '|' + vv; if (body.cache.has(key)) return body.cache.get(key);
    const lim = body.top(uu) - Math.min(body.wrap, SCREW_WRAP_SAFE);
    let ok = depth >= lim + 0.5;
    if (ok) {
      const v0 = body.crestV(uu), step = vv > v0 ? 1 : -1;
      for (let x = v0; ok && (step > 0 ? x <= vv : x >= vv); x += step) {
        const col = boneColumn(body.frame, uu, x, 20, lim - 2);
        if (col && col[1] > lim + body.cB + 1) ok = false;             // the shell would lie under bone here
      }
    }
    body.cache.set(key, ok);
    return ok;
  }
  function evalScrew(sc, pls, body, E, why) {
    const s = screwWorld(sc); if (!s.entry) { if (why) why.noBone++; return null; }
    let below = 0;
    if (body) {
      const depth = s.entry.clone().sub(body.frame.P).dot(body.frame.n);
      if (!onBody(body, sc.u, sc.v, depth)) { if (why) why.noBody++; return null; }
      below = Math.max(0, body.top(sc.u) - depth);
    }
    let inBone = 0, slotGap = Infinity, res = false;
    const q = V(), d = V();
    for (let t = 0; t <= sc.len; t += 0.25) {
      q.copy(s.entry).addScaledVector(s.dir, t);
      if (boneAt(q)) { inBone += 0.25; if (!res && resectedAt(q, E, SCREW_SLOT_GAP)) res = true; }
      for (const pw of pls) slotGap = Math.min(slotGap, Math.abs(d.copy(q).sub(pw.pSlot || pw.p).dot(pw.N)) - pw.w / 2 - sc.D / 2);
    }
    if (res) { if (why) why.resected++; return null; }
    if (slotGap < SCREW_SLOT_GAP) { if (why) why.nearSlot++; return null; }
    if (inBone < SCREW_MIN_DEPTH) { if (why) why.shallow++; return null; }
    inBone = Math.min(inBone, sc.len);
    return { inBone, slotGap, score: 10 * inBone - 0.15 * (Math.abs(sc.tiltU) + Math.abs(sc.tiltV)) - 1.5 * below };
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
  function bestScrew(def, uAt, side, scale, vLane, vc, lim, pls, body, E, taken, why, extra = {}) {
    const mk = (uu, vv, tu, tv) => Object.assign({ u: uu, v: vv, tiltU: tu, tiltV: tv, ok: false }, def, extra);
    const clear = sc => taken.every(o => (o.part || 0) !== (sc.part || 0) || Math.hypot(o.u - sc.u, o.v - sc.v) >= Math.max(o.D, sc.D) + 1);
    const pen = (dist, vv) => Math.max(0, dist - 7) + 0.3 * Math.abs(vv - vLane);
    const tilts = [[0, 0]], more = [];
    for (let tu = -20; tu <= 20; tu += 10) for (let tv = -20; tv <= 20; tv += 10) if (tu || tv) more.push([tu, tv]);
    const grid = (d0, d1, tl, w) => {
      const out = [];
      for (let dist = d0; dist <= d1; dist += 1) for (let k = -Math.floor(lim); k <= Math.floor(lim); k++) for (const [tu, tv] of tl) {
        const vv = vc + k, uu = Math.round((uAt(vv) + side * dist * scale) * 2) / 2, sc = mk(uu, vv, tu, tv);
        if (!clear(sc)) continue;
        const r = evalScrew(sc, pls, body, E, w); if (r) out.push({ sc, score: r.score - pen(dist, vv), dist });
      }
      return out.sort((a, b) => b.score - a.score);
    };
    let first = grid(SCREW_GAP_MIN, SCREW_GAP_MAX, tilts, why);
    if (!first.length) first = grid(SCREW_GAP_MIN, SCREW_GAP_MAX, more, null);
    if (!first.length) first = grid(SCREW_GAP_MAX + 1, SCREW_GAP_FAR, tilts.concat(more), null);
    let best = first[0] || null;
    // fine tilt around the best few
    for (const c of first.slice(0, 5)) for (let tu = -20; tu <= 20; tu += 5) for (let tv = -20; tv <= 20; tv += 5) {
      if (tu === c.sc.tiltU && tv === c.sc.tiltV) continue;
      const sc = mk(c.sc.u, c.sc.v, tu, tv), r = evalScrew(sc, pls, body, E, null);
      if (r && r.score - pen(c.dist, sc.v) > best.score) best = { sc, score: r.score - pen(c.dist, sc.v), dist: c.dist };
    }
    return best ? best.sc : null;
  }
  // automatic body: width and lateral centre from the bone's extent under the guide, wrap depth per position from the
  // bone's widest level (sizeBody); hand-set values (S.gAuto false) are left alone. Returns the sizing (secs for the checks).
  function autoBody(uA, uB) {
    if (!S.anchor || !S.maskF) return null;
    const auto = S.gAuto, fr = Object.assign({ P: S.anchor.p }, frameAxes());
    if (!auto.W && !auto.wrap) { S.g.wrapU = null; return null; }
    const sz = sizeBody(fr, boneField, uA, uB, S.g, { W: !!auto.W, wrap: !!auto.wrap });
    if (!sz.ok) return sz;
    if (auto.W) { S.g.W = sz.W; S.g.vc = sz.vc; }
    if (auto.wrap) { S.g.wrapU = sz.wrapU; S.g.wrap = Math.max(2, Math.min(20, sz.wrap)); } else S.g.wrapU = null;
    S.autoSize = { W: sz.W, vc: sz.vc, wrap: sz.wrap, depth: Math.min(...sz.secs.map(s => s.depth)), height: Math.max(...sz.secs.map(s => s.vHi - s.vLo)), n: sz.secs.length };
    return sz;
  }
  function suggest() {
    if (!S.anchor) return;
    const L = S.lesion, a = Math.min(L.from, L.to) - L.margin, b = Math.max(L.from, L.to) + L.margin;
    S.planes = [{ off: a, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: b, yaw: 0, pitch: 0, w: 1.2, ok: false }];
    if (S.guideOn) placeScrews(); else S.screws = [];
    unapprove(S.lesion); S.sel = null;
    updateLesionPart(); schedule(true);
  }
  // Screws outside the two outer cuts (one or two per side, 'Vida / taraf'), each where the drill reaches the most bone
  // (bestScrew: along the axis 5-15 mm past the slot, across the body, tilted up to 20°), never on the resected side,
  // never within 2 mm of a slot. A side with no usable position gets no screw and a critical check says why
  // (S.screwDrops). Screws the surgeon placed or moved (sc.hand) are kept and the automatic ones fill up around them.
  // The guide is made long enough to hold the screws and the slots (up to L_MAX, from the plan, no fixed 100 mm).
  function placeScrews() {
    const def = SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom, per = +($('perSide') ? $('perSide').value : 1) || 1;
    const { u, v, n } = frameAxes(), pls0 = planesWorld().sort((x, y) => x.off - y.off);
    S.screwDrops = [];
    if (pls0.length < 1) { S.screws = []; return; }
    const hand = S.screws.filter(sc => sc && sc.hand);
    // body width, lateral centre and wrap depth from the bone over the span the screws may need
    const span = [pls0[0].off - SCREW_GAP_MAX - pls0[0].w - def.D, pls0[pls0.length - 1].off + SCREW_GAP_MAX + pls0[pls0.length - 1].w + def.D];
    const sz = autoBody(Math.min(span[0], -8), Math.max(span[1], 8));
    const pls = planesWorld().sort((x, y) => x.off - y.off), vc = S.g.vc || 0, E = resEnds();
    // two guides on their own frames (angle region): each piece's screws lie along its own bone axis past its cut
    if (S.g.split === 2 && pls.length >= 2) { const sp = splitScrews(pls, per, def, E, hand.filter(sc => sc.part)); if (sp) { S.screws = sp; setLength(pls); return; } }
    // the ends to hold: both outer cuts, or (one cut) both sides of it; a condylar resection keeps bone on one side only
    let ends = pls.length > 1 ? [[pls[0], -1], [pls[pls.length - 1], 1]] : [[pls[0], -1], [pls[0], 1]];
    if (E && E.condyle) { const A = pls.find(p => p.pl === E.A.pl) || pls[0]; ends = [[A, Math.sign(-E.A.N.dot(u)) || -1]]; }
    const perEnd = E && E.condyle ? Math.max(per, 2) : per;
    const sv = perEnd === 2 ? Math.max(2, Math.min(5, S.g.W / 2 - def.D / 2 - 1.5)) : 0, lanes = perEnd === 2 ? [vc - sv, vc + sv] : [vc];
    const lim = Math.max(0, S.g.W / 2 - def.D / 2 - 0.5);
    // the body the screws stand on (bone crest per position from the sections, else none)
    const body = bodyOf(Object.assign({ P: S.anchor.p }, frameAxes()), sz && sz.secs, S.g.wrap, 0);
    const out = hand.filter(sc => !sc.part);
    for (const [pw, side] of ends) {
      // the u of the slot edge on lane vv (slot centre shifted by kerfSide, tilted cuts cross each lane elsewhere)
      const cu = Math.max(0.2, Math.abs(pw.N.dot(u))), scale = 1 / cu;
      const uAt = vv => pw.off + (pw.shift || 0) * Math.sign(pw.N.dot(u) || 1) - vv * pw.N.dot(v) / Math.max(0.2, pw.N.dot(u)) + side * pw.w / 2 * scale;
      const have = out.filter(sc => Math.sign(sc.u - uAt(sc.v)) === side).length;
      for (let k = have; k < perEnd; k++) {
        const why = { noBone: 0, noBody: 0, resected: 0, nearSlot: 0, shallow: 0 };
        const best = bestScrew(def, uAt, side, scale, lanes[k % lanes.length], vc, lim, pls, body, E, out, why);
        if (best) out.push(best); else S.screwDrops.push({ cut: Math.max(0, S.planes.indexOf(pw.pl)), side, why: screwWhy(why) });
      }
    }
    S.screws = out;
    setLength(pls);
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
  function splitScrews(pls, per, def, E, hand) {
    const f = pieceFrames(); if (!f) return null;
    const out = hand.slice(), lanes = per === 2 ? [-4, 4] : [0];
    for (const [cut, fr, part] of [[f.A, f.a, -1], [f.B, f.b, 1]]) {
      if (E && E.condyle && cut.pl !== E.A.pl) continue;             // the piece on the resected side holds no screw
      const c = fr.u.dot(cut.N), cu = Math.max(0.2, Math.abs(c)), scale = 1 / cu, d0 = (cut.pSlot || cut.p).clone().sub(fr.P).dot(cut.N), vN = fr.v.dot(cut.N);
      const uAt = vv => (d0 - vv * vN) / (c || 0.2) + cut.w / 2 * scale;
      // the piece's own body: sections along its axis; its anchor lies on the bone near the middle of the screw span
      const us = []; for (let x = 2; x <= SCREW_GAP_FAR + 6; x += 3) us.push(x);
      const secs = boneSections(fr.P, fr.u, fr.v, fr.n, boneField, us).filter(sx => !sx.empty);
      const mid = secs.find(sx => sx.uu >= 8) || secs[secs.length - 1];
      const body = bodyOf(fr, secs, S.g.wrap, mid ? mid.top : 0);
      const have = out.filter(sc => sc.part === part).length;
      for (let k = have; k < per; k++) {
        const why = { noBone: 0, noBody: 0, resected: 0, nearSlot: 0, shallow: 0 };
        const best = bestScrew(def, uAt, 1, scale, lanes[k % lanes.length], 0, 6, pls, body, E, out, why, { part });
        if (best) out.push(best); else S.screwDrops.push({ cut: Math.max(0, S.planes.indexOf(cut.pl)), side: part, why: screwWhy(why) });
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
  // checks. The "ok" criterion is the expected piece count and at least one free insertion direction.
  async function fitWrap() {
    if (!S.anchor) return null;
    const auto = S.gAuto, w0 = S.g.wrap, f0 = S.g.flange, s0 = S.g.split, log = [];
    // the rung that came closest when none fits (kept at the end): the right piece count first, then a free seating
    // direction, then the fewest failed screws; `onlyScrews` marks a rung whose body sits but whose screws fail
    let best = null, onlyScrews = false;
    const test = async (h = 0.8) => {
      const o = await buildGuideSet(Object.assign({ g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), bone: boneAt, field: boneField, h }, frameAxes())); const R = o.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1; disposeObj(o.mesh);
      const bad = R.screwInfo.filter(si => !si.ok), scOk = !bad.length, piecesOk = R.pieces === want, seatFree = !R.seat || !R.seat.ok || R.seat.free > 0;
      if (!scOk) log.push({ step: 'screws', split: S.g.split, wrap: S.g.wrap, flange: S.g.flange, ok: false, screws: bad.length });
      const score = (piecesOk ? 1000 : 0) + (seatFree ? 100 : 0) - bad.length - (h > 0.5 ? 0.5 : 0);
      if (!best || score > best.score) best = { score, wrap: S.g.wrap, split: S.g.split, flange: S.g.flange, pieces: R.pieces, want, free: R.seat && R.seat.ok ? R.seat.free : null, screws: bad.length };
      onlyScrews = piecesOk && seatFree && !scOk;
      return piecesOk && (h > 0.5 || seatFree) && scOk;
    };
    // coarse grid first, then confirm at the resolution of the final guide
    const okAt = async () => (await test()) && (await test(0.4));
    // start from the usual depth (an earlier plan may have lowered it), never below 2 mm (the bridge needs it)
    const top = auto.wrap ? Math.max(w0, S.kind === 'leg' ? 6 : 5) : w0, wMin = auto.wrap ? 2 : w0;
    // a rung whose body sits in one piece with a free direction and fails only on its screws is not mended by a
    // shallower wrap (the screws keep their spots), so that ladder ends there
    const ladder = async step => { let ok = false; for (let w = top; !ok && w >= wMin; w--) { S.g.wrap = w; onlyScrews = false; ok = await okAt(); log.push({ step, split: S.g.split, wrap: w, flange: S.g.flange, ok }); if (!ok && onlyScrews) break; } return ok; };
    let ok = await ladder('wrap'), split = false;
    // a long resection on a curved jaw: two separate guides, one on each side, sit on straighter bone
    if (!ok && auto.split && !S.g.split && S.planes.length >= 2 && S.bonelessCut == null) {
      const ang = cutsAngle();
      // the screws follow the layout: on two frames each piece holds its own, on one frame they sit beside the cuts
      const layout = sp => { S.g.split = sp; placeScrews(); };
      layout(ang > 20 ? 2 : 1); S.fitAngle = ang;
      ok = await ladder('split');
      if (!ok && auto.split) { layout(S.g.split === 2 ? 1 : 2); ok = await ladder('split'); }
      // the capture flange past each slot shortened: each guide reaches less far around the curve
      if (!ok && S.g.flange > 2) { S.g.flange = 2; ok = await ladder('flange'); if (!ok) S.g.flange = f0; }
      if (ok) split = true; else layout(s0);
    }
    // nothing fits: keep the rung that came closest (its layout, flange and wrap) rather than the first one
    if (!ok && best) {
      if (auto.split && best.split !== S.g.split && S.planes.length >= 2) { S.g.split = best.split; placeScrews(); }
      if (auto.wrap) S.g.wrap = best.wrap; S.g.flange = best.flange;
      log.push({ step: 'kept', split: S.g.split, wrap: S.g.wrap, flange: S.g.flange, ok: false, pieces: best.pieces, want: best.want, free: best.free, screws: best.screws });
    } else if (!ok) S.g.wrap = top;
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
    const upPos = v.z >= 0;
    return { pos: !!(upPos ? g.stopT : g.stopB), neg: !!(upPos ? g.stopB : g.stopT) };
  }
  async function buildGuide(ctx) {
    const t0 = performance.now();
    const { g, P, u, v, n, pls, scs } = ctx, boneAt = ctx.bone, h = ctx.h || 0.4, T = {};
    const maxSleeve = Math.max(0, ...scs.map(s => s.sc.sleeveH));
    // optional stops: lips past the upper / lower guide edge that reach around the bone edge (crest, lower border)
    const sUp = stopSides(g, v), stopX = g.stopT || g.stopB ? (g.stopL || 6) : 0, stopZ = g.stopT || g.stopB ? (g.stopD || 5) : 0, vc = g.vc || 0;
    // wrap depth at a position along the guide: the hand / global value, capped by the automatic per-position profile
    // (g.wrapU = [[uu, depth], ...]) where the bone's widest level is shallower towards an end of the guide
    const wrapOf = uu => { const pr = g.wrapU; if (!pr || !pr.length) return g.wrap; if (uu <= pr[0][0]) return Math.min(g.wrap, pr[0][1]); for (let a = 1; a < pr.length; a++) if (uu <= pr[a][0]) { const t = (uu - pr[a - 1][0]) / ((pr[a][0] - pr[a - 1][0]) || 1); return Math.min(g.wrap, pr[a - 1][1] + t * (pr[a][1] - pr[a - 1][1])); } return Math.min(g.wrap, pr[pr.length - 1][1]); };
    const uc = g.uc || 0;
    const lo = [uc - g.L / 2 - 4, vc - g.W / 2 - 4 - stopX, -Math.max(g.wrap + 10, 30) - Math.max(0, g.L / 2 - 15) * 0.6], hi = [uc + g.L / 2 + 4, vc + g.W / 2 + 4 + stopX, g.clear + g.wall + Math.max(maxSleeve, g.bridge) + 6];
    const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1, N = nx * ny * nz, nxy = nx * ny;
    const toWorld = (a, b, c) => { const x = lo[0] + a * h, y = lo[1] + b * h, z = lo[2] + c * h; return [P.x + u.x * x + v.x * y + n.x * z, P.y + u.y * x + v.y * y + n.y * z, P.z + u.z * x + v.z * y + n.z * z]; };
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
    const c = g.clear + (g.peri || 0), w = g.wall, gap = splitGap(g, pls), cw = c + w;
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
      const ie = Math.max(0, Math.min(nx - 1, Math.round((el[0] - lo[0]) / h)));
      let onN = 0, onHit = 0;
      { const [pa, pb] = basis2(ol); for (let t = c + 0.3; t <= cw - 0.3 + 1e-9; t += Math.max(0.2, h / 2)) for (const [sa, sb] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { const x = el[0] + ol[0] * t + (pa[0] * sa + pb[0] * sb) * R, y = el[1] + ol[1] * t + (pa[1] * sa + pb[1] * sb) * R, z = el[2] + ol[2] * t + (pa[2] * sa + pb[2] * sb) * R, i = Math.round((x - lo[0]) / h), j = Math.round((y - lo[1]) / h), k = Math.round((z - lo[2]) / h); onN++; if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) { const q = i + nx * (j + ny * k); if (F[q] < 0 || (ddE[q] > c - h && ddE[q] <= cw + h && slots.some(sl => Math.abs(sl.a * x + sl.b * y + sl.c * z - sl.e) < sl.half + h))) onHit++; } } }
      const onBody = onN > 0 && onHit >= 0.5 * onN;
      if (!onBody) { screwInfo.push({ s, ok: false, noBody: true, depth: el[2] - wrapAt[ie] }); continue; }
      // only the grid cells within R of the drill axis (the hole runs through the whole grid)
      const rng = [0, 1, 2].map(a => { const p1 = el[a] - ol[a] * 400, p2 = el[a] + ol[a] * 400; return [Math.max(0, Math.floor((Math.min(p1, p2) - R - lo[a]) / h) - 1), Math.min([nx, ny, nz][a] - 1, Math.ceil((Math.max(p1, p2) + R - lo[a]) / h) + 1)]; });
      const info = { s, ok: true }; axes.push({ el, ol, R, r, top, rng, info });
      // screw path through bone; distance to every saw slot is measured from the slot edge (half width w/2 around pSlot)
      // to the screw surface: the drill (radius d/2) inside the slot is critical, the sleeve (radius D/2) within
      // 0.5 mm is a warning
      let inBone = 0, crossesPlane = false, exitAt = null, slotGap = Infinity;
      for (let t = 0; t <= s.sc.len; t += 0.25) {
        const q = s.entry.clone().add(s.dir.clone().multiplyScalar(t));
        if (boneAt(q)) inBone += 0.25; else if (exitAt === null && t > 1) exitAt = t;
        for (const pw of pls) { const dist = Math.abs(q.clone().sub(pw.pSlot || pw.p).dot(pw.N)); if (dist < pw.w / 2 + s.sc.d / 2) crossesPlane = true; slotGap = Math.min(slotGap, dist - pw.w / 2 - s.sc.D / 2); }
      }
      screwInfo.push(Object.assign(info, { inBone: Math.min(inBone, s.sc.len), crossesPlane, slotGap, exitAt }));
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
    const st = opts.step || 0.5, vHalf = opts.vHalf || 21, nLo = -(opts.deep || 32), nHi = opts.above || 6, q = new THREE.Vector3(), out = [];
    const nN = Math.round((nHi - nLo) / st) + 1;
    for (const uu of uList) {
      const vmin = new Float32Array(nN).fill(Infinity), vmax = new Float32Array(nN).fill(-Infinity);
      let top = -Infinity, vTop = 0;
      for (let vv = -vHalf; vv <= vHalf + 1e-9; vv += st) {
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
    const vAx = V().crossVectors(n0, pw.N).normalize(); if (vAx.lengthSq() < 1e-6) return null;
    const steps = [0]; for (let d = 2; d <= 40; d += 2) steps.push(d, -d);
    let q = null;
    outer: for (const kk of [0, 3, 6]) for (const vv of steps) {
      const top = pw.p.clone().addScaledVector(vAx, vv).addScaledVector(keepDir, kk).addScaledVector(n0, 20);
      for (let t = 0; t < 70; t += 0.25) { const c = top.clone().addScaledVector(n0, -t); if (boneAt(c)) { q = c; break outer; } }
    }
    if (!q) return null;
    const f = frameAt(q, n0);
    // the piece is put on from the same side as the whole guide: its normal keeps within 30 deg of the guide normal
    let nn = f.n.clone(); const cs = Math.max(-1, Math.min(1, nn.dot(n0))), th = Math.acos(cs), lim = deg(30);
    if (th > lim) { const t = lim / th; nn = n0.clone().multiplyScalar(Math.sin((1 - t) * th)).addScaledVector(f.n, Math.sin(t * th)).normalize(); }
    // the piece axis: of the directions across the kept half of the tangent plane, the one along which the bone surface
    // runs furthest from the cut (followed step by step within 10 mm of the last level); at the angle of the jaw this
    // is up the ramus, where the local PCA axis (body and ramus in one ball) points anywhere between
    let k0 = keepDir.clone().sub(nn.clone().multiplyScalar(keepDir.dot(nn)));
    if (k0.lengthSq() < 1e-6) k0 = f.axis.clone().sub(nn.clone().multiplyScalar(f.axis.dot(nn)));
    if (k0.lengthSq() < 1e-6) return null;
    k0.normalize();
    const runOf = dir => { let c = q.clone(), run = 0; for (let st = 0; st < 15; st++) { const nx0 = c.clone().addScaledVector(dir, 2), top = nx0.clone().addScaledVector(nn, 10); let hit = null; for (let t = 0; t <= 20; t += 0.5) { const w = top.clone().addScaledVector(nn, -t); if (boneAt(w)) { hit = w; break; } } if (!hit) break; c = hit; run += 2; } return run; };
    let u = k0, bestRun = -1;
    for (let a = -80; a <= 80; a += 10) { const dir = k0.clone().applyAxisAngle(nn, deg(a)), run = runOf(dir) - 0.01 * Math.abs(a); if (run > bestRun) { bestRun = run; u = dir; } }
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
  async function buildGuideSet(ctx) {
    const g = ctx.g, pls = ctx.pls;
    if (!(g.split === 2 && pls.length >= 2)) return buildGuide(ctx);
    const sorted = pls.slice().sort((a, b) => (a.off ?? a.p.dot(ctx.u)) - (b.off ?? b.p.dot(ctx.u)));
    const A = sorted[0], B = sorted[sorted.length - 1], mid = (A.p.dot(ctx.u) + B.p.dot(ctx.u)) / 2;
    const pf = pieceFrames(), fa = pf ? pf.a : cutFrame(A, ctx.u.clone().negate(), ctx.n), fb = pf ? pf.b : cutFrame(B, ctx.u, ctx.n);
    if (!fa || !fb) return buildGuide(Object.assign({}, ctx, { g: Object.assign({}, g, { split: 1 }) }));
    const parts = [], meshes = [], infos = [];
    for (const [fr, side] of [[fa, -1], [fb, 1]]) {
      // this piece: the cuts and screws on its side of the defect middle
      const myPls = pls.filter(p => Math.sign(p.p.dot(ctx.u) - mid) === side || sorted.length === 2 && p === (side < 0 ? A : B));
      const myScs = ctx.scs.filter(s => s.sc.part ? s.sc.part === side : s.entry && Math.sign(s.entry.clone().sub(ctx.P).dot(ctx.u) - mid) === side);
      const cut = side < 0 ? A : B, half = cut.w / 2 + Math.abs(cut.shift || 0);
      // extent along the piece's own u: the capture flange past the slot on the defect side, the screws on the kept side
      let reach = 10;
      for (const s of myScs) reach = Math.max(reach, (s.entry ? s.entry.clone().sub(fr.P).dot(fr.u) : s.sc.part ? s.sc.u : 0) + s.sc.D / 2 + 2);
      const back = half + g.flange, L = Math.min(100, Math.max(16, Math.ceil(reach + back))), cShift = (reach - back) / 2;
      const Pc = fr.P.clone().addScaledVector(fr.u, cShift);
      // the piece's anchor lies on the bone surface at its centre (walk down the normal), so the wrap is measured from the bone
      let Pq = null; const top = Pc.clone().addScaledVector(fr.n, 20);
      for (let t = 0; t < 70; t += 0.25) { const c = top.clone().addScaledVector(fr.n, -t); if (boneAt(c)) { Pq = c; break; } }
      const frame = { P: Pq || Pc, u: fr.u, v: fr.v, n: fr.n };
      const auto = S.gAuto || AUTO_DEFAULT, sz = ctx.field ? sizeBody(frame, ctx.field, -L / 2, L / 2, g, { W: !!auto.W, wrap: !!auto.wrap }) : { W: g.W, vc: 0, wrap: g.wrap, wrapU: null };
      const gi = Object.assign({}, g, { split: 0, L, W: sz.W, vc: sz.vc, wrap: Math.min(g.wrap, sz.wrap), wrapU: sz.wrapU });
      const o = await buildGuide(Object.assign({}, ctx, frame, { g: gi, pls: myPls, scs: myScs }));
      parts.push({ frame, g: gi, pls: myPls, scs: myScs, result: o.result, grid: o.grid, wrapProfile: o.result.wrapProfile, side });
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
    return { mesh, result, grid: Object.assign(parts[0].grid, { parts: parts.map(p => p.grid) }) };
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
  // every edit bumps ver; a built guide is shown only if it is at least as new as the one on screen
  const live = { ver: 0, shown: 0, running: false, dirty: false, planes: false, resAt: 0 };
  async function regenerate() {
    if (!S.anchor) return;
    if (!S.guideOn) {
      // cuts only: no guide until the user asks for one
      live.shown = live.ver; S.liveScrews = null; S.result = null; S.grid = null;
      setPart('guide', null, null); rebuildElementParts(planesWorld(), []); showResected();
      applyExplode(); updatePanels(); busy(false); render(); emit('parts'); emit('changed');
      return;
    }
    const ver = live.ver;
    busy(true, 'Guide üretiliyor…'); await sleep();
    const pls = planesWorld(), scs = screwsWorld();
    const out = await buildGuideSet(Object.assign({ g: S.g, P: S.anchor.p, pls, scs, bone: boneAt, field: boneField }, frameAxes()));
    if (ver < live.shown) { disposeObj(out.mesh); return; }
    live.shown = ver; S.liveScrews = null;
    setPart('guide', 'Guide', out.mesh, COLORS.guide);
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
    const row = pt => `<li><label><input type="checkbox" data-p="${pt.id}" ${pt.visible ? 'checked' : ''}><i style="background:#${pt.color.toString(16).padStart(6, '0')}"></i><span>${esc(pt.label)}</span></label><input type="range" min="0.1" max="1" step="0.05" value="${pt.opacity ?? 1}" data-o="${pt.id}" aria-label="${esc(pt.label)} saydamlığı" title="Saydamlık"><button class="ghost sm" data-iso="${pt.id}" title="Yalnız bunu göster" aria-label="${esc(pt.label)}: yalnız bunu göster"><svg class="i"><use href="#i-eye"/></svg></button></li>`;
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
  }
  // cuts are edited in the resection step, screws in their own step; approval happens only in the review step
  const apprText = o => o.ok ? `${xl('Onaylı')}${o.by ? ' · ' + esc(o.by) : ''}${o.at ? ' · ' + new Date(o.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''}. ${xl('Değişiklik onayı kaldırır.')}` : 'Sistem önerisi; cerrah onayı İnceleme ve onay adımında verilir.';
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
    const fields = isP ? [['off', 'Konum (guide ekseni boyunca)', -45, 45, 0.5, 'mm'], ['yaw', 'Yatay açı', -89, 89, 0.5, '°'], ['pitch', 'Dikey açı', -89, 89, 0.5, '°'], ['w', 'Yuva genişliği (testere + tolerans)', 0.6, 2.5, 0.1, 'mm']]
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
      const { u, v } = frameAxes(), half = S.g.L / 2;
      // (two guides on their own frames: each piece is sized around its cut, the common length does not apply)
      if (S.g.split !== 2) planesWorld().forEach((pw, i) => {
        if (S.bonelessCut === i) return;   // a cut past the condyle meets no bone: the guide need not reach it
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
      (S.screwDrops || []).forEach(d => out.push(['crit', 'Kritik', (DROP_MSG[d.why] || DROP_MSG.none)(d.cut + 1), 'p' + d.cut]));
      if (S.guideOn && !S.screws.length) out.push(['crit', 'Kritik', 'Guide\'da vida yok; guide kemiğe sabitlenemez. Vida ekleyin.', 'guide']);
      else if (S.guideOn && S.g.split !== 2 && S.planes.length >= 2 && !(E0 && E0.condyle)) {
        const pl = planesWorld().sort((x, y) => x.off - y.off), mid = (pl[0].off + pl[pl.length - 1].off) / 2, sides = new Set(S.screws.map(sc => Math.sign(sc.u - mid)));
        if (S.screws.length && sides.size < 2) out.push(['warn', 'Uyarı', 'Vidalar yalnız bir uçta; guide öbür uçta kemiğe sabitlenmiyor. Öbür kesinin ötesine vida ekleyin.', 'guide']);
      }
      // graft-to-stump gap at each end: the half slot the saw takes from the stump (0 when the kerf lies on the resected side)
      const E = resEnds();
      if (E) {
        const ends = [E.A].concat(E.B && !E.B.virtual ? [E.B] : []), g1 = fmt(stumpGap(ends[0])), g2 = ends[1] ? fmt(stumpGap(ends[1])) : null, mx = Math.max(...ends.map(stumpGap));
        if (mx > 1.0) out.push(['warn', 'Uyarı', g2 == null ? `Greft ile güdük arasında planlı aralık ${g1} mm (eşik 1,0 mm). Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.` : `Greft ile güdük arasında planlı aralık: kesi 1 ucunda ${g1} mm, kesi 2 ucunda ${g2} mm (eşik 1,0 mm). Kesi yuvasını daraltın ya da testere payını rezeke tarafa alın.`, 'guide']);
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
      if (S.bonelessCut != null && S.planes.length >= 2) out.push(['info', 'Bilgi', S.bonelessCut ? 'Kesi 2 kalan tarafında kemikle karşılaşmıyor (kondil ötesi); bütün vidalar kesi 1 tarafında, guide tek parça.' : 'Kesi 1 kalan tarafında kemikle karşılaşmıyor (kondil ötesi); bütün vidalar kesi 2 tarafında, guide tek parça.', 'guide']);
      if (S.fitLog && S.fitLog.some(x => x.step !== 'screws' && x.step !== 'kept')) {
        const kept = S.fitLog.find(x => x.step === 'kept'), L = S.fitLog.filter(x => x.step !== 'screws' && x.step !== 'kept'), last = L[L.length - 1], first = L[0], n1 = L.filter(x => x.step === 'wrap').length, lo = fmt(Math.min(...L.map(x => x.wrap)), 1);
        const scFail = S.fitLog.filter(x => x.step === 'screws' && x.split !== 2), scMax = scFail.length ? Math.max(...scFail.map(x => x.screws)) : 0;
        if (scMax && last.ok && last.split === 2) out.push(['info', 'Bilgi', `Otomatik uyum: tek parça düzeninde ${scMax} vidanın altında kemik ya da guide gövdesi yoktu; iki guide düzeninde her vida kendi parçasının kemiğinde.`, 'guide']);
        const w0 = fmt(first.wrap, 1), w1 = fmt(last.wrap, 1), ang = fmt(S.fitAngle || 0, 0), fl = fmt(last.flange, 1);
        if (last.ok && last.step === 'wrap' && last.wrap < first.wrap) out.push(['info', 'Bilgi', `Otomatik uyum: sarma ${w0} mm ile takılamadı; ${w1} mm ile takılabiliyor.`, 'guide']);
        else if (last.ok && last.step !== 'wrap' && last.split === 2) out.push(['info', 'Bilgi', last.step === 'flange' ? `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide, her kesi kendi kemik ekseninde (eksenler arası ${ang}°), kesi ötesi kenar ${fl} mm, sarma ${w1} mm ile takılabiliyor.` : `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide, her kesi kendi kemik ekseninde (eksenler arası ${ang}°), sarma ${w1} mm ile takılabiliyor.`, 'guide']);
        else if (last.ok && last.step !== 'wrap') out.push(['info', 'Bilgi', last.step === 'flange' ? `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide (ortak eksen), kesi ötesi kenar ${fl} mm, sarma ${w1} mm ile takılabiliyor.` : `Otomatik uyum: tek parça hiçbir sarmada takılamadı (${n1} deneme); iki guide (ortak eksen), sarma ${w1} mm ile takılabiliyor.`, 'guide']);
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
      if (g && (cnt[0] < 1 || cnt[1] < 1)) out.push(['crit', 'Kritik', `İki guide düzeninde her guide en az bir vidayla sabitlenmeli (şu an ${cnt[0]} + ${cnt[1]}).`, 'guide']);
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
    if (R.contact < 150) out.push(['warn', 'Uyarı', `Temas alanı ${fmt(R.contact, 0)} mm²; oturma belirsiz olabilir (örnek eşik 150 mm²).`, 'guide']);
    R.screwInfo.forEach((si, i) => {
      if (!si.ok && si.noBody) out.push(['crit', 'Kritik', `Vida ${i + 1} altında guide gövdesi yok: kemik girişi guide'ın sarma sınırının ${fmt(Math.max(0, -(si.depth || 0)), 1)} mm altında ya da gövdenin dışında; kovan boşlukta kalırdı. Vidayı kaydırın ya da sarmayı artırın.`, 's' + i]);
      else if (!si.ok) out.push(['crit', 'Kritik', `Vida ${i + 1} kemiğe ulaşmıyor.`, 's' + i]);
      else {
        if (si.crossesPlane) out.push(['crit', 'Kritik', `Vida ${i + 1} matkap yolu (Ø${fmt(si.s.sc.d)}) kesi yuvasıyla kesişiyor.`, 's' + i]);
        else if (si.slotGap < 0.5) out.push(['warn', 'Uyarı', `Vida ${i + 1} kovanı (Ø${fmt(si.s.sc.D)}) kesi yuvasına ${fmt(Math.max(0, si.slotGap))} mm yaklaşıyor (en az 0,5 mm); testere yoluna değebilir.`, 's' + i]);
        if (si.exitAt !== null && si.exitAt < si.s.sc.len) out.push(['warn', 'Uyarı', `Vida ${i + 1} ${fmt(si.exitAt)} mm'de kemikten çıkıyor (bikortikal mi?).`, 's' + i]);
        if (si.shadowed) out.push(['warn', 'Uyarı', `Vida ${i + 1} kovanının %${fmt(si.shadowed * 100, 0)}'i takma yönünde kemiğin gölgesine girer; o kısım bırakıldı. Vidayı kaydırın ya da eğimini azaltın.`, 's' + i]);
      }
    });
    R.pls.forEach((pw, i) => R.pls.forEach((pq, j) => { if (j > i && Math.abs(pw.off - pq.off) < 3 && Math.abs(pw.N.dot(pq.N)) > 0.95) out.push(['warn', 'Uyarı', `Kesi ${i + 1} ve ${j + 1} birbirine çok yakın.`, 'p' + i]); }));
    if (window.Fibula) Fibula.checks().forEach(c => out.push([c[0], c[1], c[2], c[3] || 'fib']));
    (window.ExtraChecks || []).forEach(f => f().forEach(c => out.push(c)));
    S.crit = out.filter(o => o[0] === 'crit').length;
    S.checkList = out.slice();
    const rank = { crit: 0, warn: 1, ok: 2 }, infos = out.filter(o => o[0] === 'info'), main = out.filter(o => o[0] !== 'info').sort((a, b) => (rank[a[0]] ?? 3) - (rank[b[0]] ?? 3));
    if (!main.length) main.push(['ok', 'Uygun', 'Tüm kontroller geçti.']);
    const li = ([c, t, m, ref]) => `<li class="${c}"${ref ? ` data-go="${ref}" title="İlgili öğeye git" tabindex="0" role="button"` : ''}><b>${t}</b><span>${esc(m)}</span></li>`;
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
    document.querySelectorAll('.checks li[data-go]').forEach(el => { el.addEventListener('click', () => goTo(el.dataset.go)); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTo(el.dataset.go); } }); });
    updateMarkers();
  }
  function renderJSON() {
    if (!S.anchor) { $('json').textContent = ''; return; }
    const r2 = x => Math.round(x * 100) / 100, vv = q => [r2(q.x), r2(q.y), r2(q.z)];
    $('json').textContent = JSON.stringify({ guide_merkezi_mm: vv(S.anchor.p), oturma_yonu: vv(S.anchor.n), guide: S.g,
      lezyon: S.lesion, kesiler: S.planes, vidalar: S.screws }, null, 2);
  }
  function pending() {
    const p = [];
    if (!S.lesion.ok) p.push('Rezeksiyon sınırı');
    S.planes.forEach((o, i) => { if (!o.ok) p.push(`Kesi ${i + 1}`); });
    S.screws.forEach((o, i) => { if (!o.ok) p.push(`Vida ${i + 1}`); });
    if (window.Fibula && Fibula.active() && !Fibula.approved()) p.push('Fibula planı');
    (window.PendingHooks || []).forEach(f => { try { f().forEach(x => p.push(x)); } catch (e) { /* optional gate */ } });
    return p;
  }
  const initials = n => (n || '').split(/\s+/).filter(w => w && !/^(dr|prof|doç|doc|op|uzm)\.?$/i.test(w)).map(w => w[0].toLocaleUpperCase('tr-TR')).slice(0, 2).join('') || '?';
  const badge = o => o.ok ? `<span class="badge" title="${esc(o.by || '')}${o.at ? ' · ' + new Date(o.at).toLocaleString('tr-TR') : ''}"><span class="ini">${esc(initials(o.by))}</span>${o.at ? new Date(o.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''}</span>` : '';
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
  function renderAppr() {
    if (!S.anchor) { $('appr').innerHTML = '<li class="sum"><span class="hint">Rezeksiyon bölgesi seçilince onaylanacak öğeler burada listelenir.</span></li>'; $('expZip').disabled = true; syncOne(); return; }
    const qcCrit = S.qc.some(q => q[0] === 'crit');
    const row = (ref, name, o, sub) => `<li><button class="go" data-go="${ref}"><span class="nm">${name}</span><small>${sub || ''}</small></button><span class="act">${badge(o)} <button data-ap="${ref}">${o.ok ? 'Kaldır' : '<svg class="i"><use href="#i-check"/></svg>Onayla'}</button></span></li>`;
    const L = S.lesion, R = S.result;
    const plSub = (p, i) => `${fmt(p.off)} mm · ${fmt(p.yaw)}° / ${fmt(p.pitch)}°`;
    const scSub = (sc, i) => { const si = R && R.screwInfo[i]; return `${fmt(sc.d)} mm × ${fmt(sc.len, 0)} mm${si && si.ok ? ' · kemikte ' + fmt(si.inBone) + ' mm' : ''}`; };
    const fib = window.Fibula && Fibula.active();
    $('appr').innerHTML =
      `<li class="sum"><button class="go" data-go="data"><span class="nm">Görüntü kalitesi</span></button><span class="tag ${qcCrit ? 'crit' : 'ok'}">${qcCrit ? 'Kritik' : 'Uygun'}</span></li>` +
      row('lesion', 'Rezeksiyon sınırı', L, `${fmt(L.from)} – ${fmt(L.to)} mm, pay ${fmt(L.margin)} mm`) +
      S.planes.map((p, i) => row('p' + i, `Kesi ${i + 1}`, p, plSub(p, i))).join('') +
      S.screws.map((sc, i) => row('s' + i, `Vida ${i + 1}`, sc, scSub(sc, i))).join('') +
      (fib ? row('fib', 'Fibula planı ve guide\'ı', { ok: Fibula.approved(), by: S.fib.plan.by, at: S.fib.plan.at }, `${S.fib.plan.n} segment`) : '') +
      `<li class="sum"><button class="go" data-go="checks"><span class="nm">Otomatik kontroller</span></button><span class="tag ${S.crit ? 'crit' : 'ok'}">${S.crit ? S.crit + ' kritik' : 'Geçti'}</span></li>`;
    $('appr').querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.go)));
    $('appr').querySelectorAll('[data-ap]').forEach(b => b.addEventListener('click', () => approveItem(b.dataset.ap)));
    const missing = pending(), name = $('surgeon').value.trim();
    const ready = !missing.length && !S.crit && !qcCrit && name && S.result;
    $('expZip').disabled = !ready; syncOne();
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
    box.querySelectorAll('.mk').forEach(el => el.addEventListener('click', () => goTo(el.dataset.go)));
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
    timer = setTimeout(async () => { try {
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
        if (S.guideOn && R && (R.pieces !== want || (R.seat && R.seat.ok && !R.seat.free))) {
          busy(true, 'Guide yeni açıda kemiğe oturtuluyor…'); await sleep();
          const f = await fitWrap(); if (f) S.fitReport = f;
        } else if (S.guideOn && R && $('guideStat')) $('guideStat').textContent = 'Guide yeni konumda kemiğe oturuyor.';
      }
    } finally { if (timer === t) rebuildPending = false; } }, liveEdit ? 400 : 120);
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
    const targets = ['bone', 'resected', 'guide'].filter(k => parts[k] && parts[k].visible).map(k => parts[k].obj);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return;
    if (S.mode === 'anchor') {
      const nrm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (nrm.dot(ray.ray.direction) > 0) nrm.negate();
      setAnchor(hit.point.clone(), nrm);
      setMode('orbit'); suggest();
      if (S.autoAfter) { S.autoAfter = false; autoPrep(); }
    } else if (S.mode === 'screw' && S.anchor) {
      const { u, v } = frameAxes(), d = hit.point.clone().sub(S.anchor.p);
      S.screws.push(Object.assign({ u: Math.round(d.dot(u) * 2) / 2, v: Math.round(d.dot(v) * 2) / 2, tiltU: 0, tiltV: 0, ok: false, hand: 1 }, SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom));
      S.sel = 's' + (S.screws.length - 1); setMode('orbit'); schedule(false);
    }
  });
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
    const { u, v, n } = frameAxes();
    proxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    if (so.isP) proxy.position.copy(planesWorld()[so.i].p);
    else { const sw = screwWorld(so.o); proxy.position.copy(sw.entry || S.anchor.p.clone().add(u.clone().multiplyScalar(so.o.u)).add(v.clone().multiplyScalar(so.o.v))); }
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
      pl.off = Math.max(-45, Math.min(45, N.dot(c.clone().sub(S.anchor.p)) / N.dot(u)));
      pl.yaw = THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))); pl.pitch = THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n)))));
    });
    // the lesion range is measured along the guide axis from the anchor
    const sh = p0.clone().addScaledVector(u0, (S.lesion.from + S.lesion.to) / 2).sub(S.anchor.p).dot(u) - (S.lesion.from + S.lesion.to) / 2;
    S.lesion.from += sh; S.lesion.to += sh;
    S.cutsTurned = turned;
    return turned;
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
    const { so, p0, q0, o0 } = gz.start, o = so.o, { u, v, n } = frameAxes();
    const d = proxy.position.clone().sub(p0), dq = proxy.quaternion.clone().multiply(q0.clone().invert());
    if (so.isP) {
      if (gz.mode === 'translate') o.off = clampR(o0.off + d.dot(u), -45, 45, 0.5);
      else {
        const N = gz.start.N0.clone().applyQuaternion(dq);
        o.yaw = clampR(THREE.MathUtils.radToDeg(Math.atan2(N.dot(v), N.dot(u))), -89, 89, 0.5);
        o.pitch = clampR(THREE.MathUtils.radToDeg(-Math.asin(Math.max(-1, Math.min(1, N.dot(n))))), -89, 89, 0.5);
      }
    } else {
      if (gz.mode === 'translate') { o.u = clampR(o0.u + d.dot(u), -80, 80, 0.5); o.v = clampR(o0.v + d.dot(v), -15, 15, 0.5); }
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
    o.off = clampR(off, -45, 45, 0.5); o.yaw = clampR(yaw, -89, 89, 0.5); o.pitch = clampR(pitch, -89, 89, 0.5);
  }
  renderer.domElement.addEventListener('pointerdown', e => {
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
      else o.off = clampR(d.dot(u), -45, 45, 0.5);
    } else { o.u = clampR(d.dot(u), -80, 80, 0.5); o.v = clampR(d.dot(v), -15, 15, 0.5); }
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
    $('modeBadge').textContent = m === 'anchor' ? 'Rezeksiyon bölgesinin ortasında kemik yüzeyine tıklayın (guide buraya oturur)' : m === 'screw' ? 'Vida yeri için guide üzerine tıklayın' : $('modeBadge').textContent;
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
    if ($('gScrewD')) { const d = S.screws.length ? S.screws[0].d : (SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom).d; $('gScrewD').value = d; $('gScrewDO').textContent = `${fmt(d)} mm`; }
    if ($('gRoll3')) { $('gRoll3').value = S.g.roll || 0; $('gRoll3O').textContent = `${fmt(S.g.roll || 0, 0)}°`; }
    if ($('gRot3')) { $('gRot3').value = S.g.rot; $('gRot3O').textContent = `${fmt(S.g.rot, 0)}°`; $('gRotBox').hidden = !S.guideOn; }
    gFields.forEach(([k, , , , st, unit]) => { $('g_' + k).value = S.g[k]; $('go_' + k).textContent = `${fmt(S.g[k], st < 1 ? (st < 0.1 ? 2 : 1) : 0)} ${unit}`; });
    $('g_side').value = String(S.g.side); $('g_split').value = String(S.g.split || 0);
    if ($('g_kerf')) $('g_kerf').value = String(S.g.kerfSide ? 1 : 0);
    // values still chosen from the bone are marked on their control
    ['L', 'W', 'wrap'].forEach(k => { const el = $('gc_' + k); if (el && el.classList) el.classList.toggle('auto', !!S.gAuto[k]); });
    $('g_stopT').checked = !!S.g.stopT; $('g_stopB').checked = !!S.g.stopB; $('stopBox').hidden = !(S.g.stopT || S.g.stopB);
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
    if (k === 'rot') { unapproveAll(); updateLesionPart(); if (S.guideOn && S.screws.length) S.screwRefit = true; }
    if (k === 'rot' || k === 'L' || k === 'W') S.refit = true;
    if ((k === 'L' || k === 'W') && S.guideOn) clampScrews();
    syncGuideInputs(); schedule(k === 'rot', true);
  }));
  $('g_side').addEventListener('change', e => { S.g.side = +e.target.value; unapproveAll(); schedule(false); });
  $('gRot3').addEventListener('input', e => setGuideRot(+e.target.value));
  $('gRoll3').addEventListener('input', e => setGuideRoll(+e.target.value));
  // one drill diameter for every guide screw (and for screws placed later); each screw can still be changed on its own
  $('gScrewD').addEventListener('input', e => {
    const d = Math.round(+e.target.value * 10) / 10; $('gScrewDO').textContent = `${fmt(d)} mm`;
    Object.values(SCREW_DEFAULT).forEach(x => { x.d = d; x.D = Math.max(x.D, Math.round((d + 2) * 10) / 10); });
    S.screws.forEach(c => { c.d = d; c.D = Math.max(c.D, Math.round((d + 2) * 10) / 10); unapprove(c); });
    if (S.screws.length) schedule(false, true);
  });
  $('gScrewD').addEventListener('change', () => { if (S.screws.length) { schedule(false); emit('changed'); } });
  ['stopT', 'stopB'].forEach(k => $('g_' + k).addEventListener('change', e => { S.g[k] = e.target.checked ? 1 : 0; syncGuideInputs(); unapproveAll(); schedule(false); }));
  [['stopL', 'mm'], ['stopD', 'mm']].forEach(([k, un]) => $('g_' + k).addEventListener('input', e => { S.g[k] = +e.target.value; $('go_' + k).textContent = `${fmt(S.g[k], 1)} ${un}`; schedule(false, true); }));
  $('g_split').addEventListener('change', e => { const was = S.g.split; S.g.split = +e.target.value; S.gAuto.split = 0; if ((was === 2) !== (S.g.split === 2) && S.anchor && S.planes.length && S.guideOn) placeScrews(); syncGuideInputs(); unapproveAll(); schedule(false); });
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
  const sampleClick = name => { if (loadBlocked()) return; if (planned() && !confirm('Örnek vaka yüklenince mevcut plan (kesiler, vidalar, guide) silinir. Devam edilsin mi?')) return; loadSample(name); };
  $('sampleM').addEventListener('click', () => sampleClick('mandible'));
  $('sampleL').addEventListener('click', () => sampleClick('leg'));
  $('dicomDir').addEventListener('change', e => { if (e.target.files.length) loadDicom([...e.target.files]); });
  $('dicomFiles').addEventListener('change', e => { if (e.target.files.length) loadDicom([...e.target.files]); });
  stage.addEventListener('dragover', e => e.preventDefault());
  // dropped folders are walked (dataTransfer.files does not enter them); a dropped zip is opened by readDicom
  stage.addEventListener('drop', async e => { e.preventDefault(); const files = window.Unzip ? await Unzip.fromDrop(e.dataTransfer) : [...e.dataTransfer.files]; if (files.length) loadDicom(files); });

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
<h2>Rezeksiyon sınırı</h2><p>Lezyon ${fmt(S.lesion.from)} ile ${fmt(S.lesion.to)} mm arası, güvenlik payı ${fmt(S.lesion.margin)} mm · ${st(S.lesion)}</p>
<h2>Kesi düzlemleri</h2><table><tr><th>Kesi</th><th>Konum</th><th>Yatay açı</th><th>Dikey açı</th><th>Yuva</th><th>Durum</th></tr>${S.planes.map((p, i) => `<tr><td>${i + 1}</td><td>${fmt(p.off)} mm</td><td>${fmt(p.yaw)}°</td><td>${fmt(p.pitch)}°</td><td>${fmt(p.w)} mm</td><td>${st(p)}</td></tr>`).join('')}</table>
<h2>Vidalar</h2><table><tr><th>Vida</th><th>Konum (eksen, yanal)</th><th>Eğim</th><th>Matkap / kovan</th><th>Boy</th><th>Kemik içinde</th><th>Durum</th></tr>${S.screws.map((s, i) => { const si = R && R.screwInfo[i]; return `<tr><td>${i + 1}</td><td>${fmt(s.u)}, ${fmt(s.v)} mm</td><td>${fmt(s.tiltU, 0)}°, ${fmt(s.tiltV, 0)}°</td><td>${fmt(s.d)} / ${fmt(s.D)} mm</td><td>${fmt(s.len, 0)} mm</td><td>${si && si.ok ? fmt(si.inBone) + ' mm' : '-'}</td><td>${st(s)}</td></tr>`; }).join('')}</table>
<h2>Guide gövdesi</h2><table>${gp.map(([k, v, u]) => `<tr><td>${k}</td><td>${fmt(v)} ${u}</td></tr>`).join('')}${R ? `<tr><td>Temas alanı</td><td>${fmt(R.contact, 0)} mm²</td></tr><tr><td>Hacim</td><td>${fmt(R.volume / 1000, 2)} cm³</td></tr>` : ''}</table>
${S.prod && S.prod.key === prodKey() ? `<p>Üretim STL'i sunucuda yüzey tabanlı boolean ile üretildi: ${S.prod.watertight ? 'su geçirmez' : 'su geçirmez değil'}, ${S.prod.bodies} parça, ${fmt(S.prod.volume / 1000, 2)} cm³ (guide_uretim.stl).</p>` : '<p>Üretim STL\'i alınmadı; guide.stl 0,4 mm voksel önizlemesidir.</p>'}
<h2>Otomatik kontroller</h2><ul>${checks}</ul>${window.Fibula ? Fibula.reportHTML() : ''}
<h2>Koordinatlar</h2><p>Guide merkezi ${S.anchor ? [S.anchor.p.x, S.anchor.p.y, S.anchor.p.z].map(x => fmt(x)).join(', ') : '-'} mm (DICOM hasta koordinatı, LPS). STL dosyaları aynı koordinatlardadır; BT ile üst üste açılabilir.</p>
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
    const deep = Math.max(g.wrap + 4, ...(c.wrapProfile || []).map(q => 4 - q[1])) + sz, R = Math.hypot(g.L / 2 + 4, g.W / 2 + 4 + sx, Math.max(deep, top)) + 6, ic = G.indexOf(vol, arr(c.P)), dims = [vol.nx, vol.ny, vol.nz];
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
      gap: (gp => gp && { A: { p: arr(gp.A.p), N: arr(gp.A.N), w: gp.A.w }, B: { p: arr(gp.B.p), N: arr(gp.B.N), w: gp.B.w }, flange: c.g.flange })(splitGap(c.g, c.pls)),
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
    try { res = await fetch(url + '/guide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(guideRequest(c)), signal: ac.signal }); }
    catch (e) { if (outer && outer.aborted) throw new Error('Üretim STL\'i iptal edildi.'); throw new Error(`Sunucuya ulaşılamadı. Pakette önizleme STL'i vardır.`); }
    finally { clearTimeout(to); }
    const js = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${xl('Sunucu hatası:')} ${js.error || res.status}`);
    const bin = atob(js.stl_b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { stl: u8, watertight: js.watertight, bodies: js.bodies, volume: js.volume_mm3, faces: js.faces, ms: js.ms };
  }
  const prodKey = () => JSON.stringify([S.source && S.source.fp, S.g, S.anchor && vec(S.anchor.p), S.anchor && vec(S.anchor.n), S.planes.map(p => [p.off, p.yaw, p.pitch, p.w]), S.screws.map(s => [s.u, s.v, s.tiltU, s.tiltV, s.d, s.D, s.sleeveH]), S.segMethod, $('thr').value, [...S.selected].sort((a, b) => a - b), window.SegEdit ? SegEdit.key() : '']);
  const segThr = () => (/^Eşik/.test(S.segMethod) && !(window.SegEdit && SegEdit.edited()) ? +$('thr').value : null);
  async function productionSTL() {
    if (!parts.guide || !S.anchor) return;
    const ac = new AbortController();
    busy(true, 'Sunucuda üretim STL\'i hazırlanıyor…', { bar: true, cancel: () => ac.abort(), max: 180 }); await sleep();
    try {
      let r;
      if (S.result && S.result.parts && S.result.parts.length === 2) {
        // a two-frame guide: one server call per piece on its own frame, the two STLs joined into one file
        const rs = [];
        for (const pt of S.result.parts) rs.push(await serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: segThr(), g: pt.g, P: pt.frame.P, pls: pt.pls, scs: pt.scs, wrapProfile: pt.wrapProfile, seatDir: pt.result.seatDir }, pt.frame), ac.signal));
        r = { stl: mergeStl(rs[0].stl, rs[1].stl), watertight: rs.every(x => x.watertight), bodies: rs.reduce((s, x) => s + x.bodies, 0), volume: rs.reduce((s, x) => s + x.volume, 0), faces: rs.reduce((s, x) => s + x.faces, 0), ms: rs.reduce((s, x) => s + x.ms, 0) };
      } else r = await serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: segThr(), g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), wrapProfile: S.result && S.result.wrapProfile, seatDir: S.result && S.result.seatDir }, frameAxes()), ac.signal);
      S.prod = Object.assign(r, { key: prodKey() });
      $('prodMsg').textContent = `${xl("Üretim STL'i hazır:")} ${r.watertight ? xl('su geçirmez') : xl('SU GEÇİRMEZ DEĞİL')}, ${xl(`${r.bodies} parça`)}${r.bodies > (S.g.split ? 2 : 1) ? ' ' + xl("(BEKLENENDEN FAZLA PARÇA, guide'ı kontrol edin)") : ''}, ${fmt(r.volume / 1000, 2)} cm³, ${xl(`${r.faces} üçgen`)}. ${xl('Pakete guide_uretim.stl olarak eklenir.')}`;
      if (S.fib && S.fib.guide && window.Fibula && !ac.signal.aborted) try { await Fibula.production(ac.signal); } catch (e) { $('prodMsg').textContent += ` Fibula guide'ı: ${e.message}`; }
    } catch (e) { S.prod = null; $('prodMsg').textContent = e.message; }
    busy(false);
  }
  async function exportPackage() {
    if (!parts.guide) return;
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
    if (window.Fibula) Fibula.exportFiles(files);
    (window.ExportHooks || []).forEach(f => { try { f(files); } catch (e) { /* optional files */ } });
    if (parts.resected) files.push({ name: 'rezeke_parca.stl', data: stlOf(parts.resected.obj) });
    files.push({ name: 'plan.json', data: $('json').textContent }, { name: 'rapor.html', data: reportHTML() });
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
  const clone = o => JSON.parse(JSON.stringify(o));
  function planOf() {
    const r = S.red;
    return {
      schema: 1, source: S.source ? clone(S.source) : null,
      seg: { thr: +$('thr').value, method: S.segMethod || '', sel: r ? S.comps.filter(c => S.selected.has(c.label)).map(c => G.worldOf(r, ...c.centroid).map(x => Math.round(x * 10) / 10)) : [] },
      anchor: S.anchor ? { p: vec(S.anchor.p), n: vec(S.anchor.n), axis: vec(S.anchor.axis), ...(S.anchor.base ? { base: { p: vec(S.anchor.base.p), n: vec(S.anchor.base.n), c: vec(S.anchor.base.c) } } : {}) } : null,
      g: clone(S.g), gAuto: clone(S.gAuto), lesion: clone(S.lesion), planes: clone(S.planes), screws: clone(S.screws),
      perSide: +$('perSide').value || 2, guideOn: !!S.guideOn, resRemoved: !!S.resRemoved, surgeon: $('surgeon').value.trim(), fibula: S.fib ? clone(S.fib.plan) : null,
      measures: clone(S.measures || []), ext: window.PlanExt ? Object.fromEntries(Object.entries(PlanExt).map(([k, f]) => [k, f.get()])) : {},
    };
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
      const v3 = a => (Array.isArray(a) && a.length === 3 && a.every(x => Number.isFinite(+x)) ? V(+a[0], +a[1], +a[2]) : null);
      const an = plan.anchor && { p: v3(plan.anchor.p), n: v3(plan.anchor.n), axis: v3(plan.anchor.axis) };
      S.anchor = an && an.p && an.n && an.n.lengthSq() > 1e-6 && an.axis && an.axis.lengthSq() > 1e-6 && an.axis.clone().normalize().cross(an.n.clone().normalize()).lengthSq() > 1e-4
        ? { p: an.p, n: an.n.normalize(), axis: an.axis.normalize() } : null;
      const ab = S.anchor && plan.anchor.base && { p: v3(plan.anchor.base.p), n: v3(plan.anchor.base.n), c: v3(plan.anchor.base.c) };
      if (ab && ab.p && ab.c && ab.n && ab.n.lengthSq() > 1e-6) S.anchor.base = { p: ab.p, n: ab.n.normalize(), c: ab.c };
      const num = (o, keys, d) => { const r = {}; keys.forEach(k => { const v = Number(o && o[k]); r[k] = Number.isFinite(v) ? v : d[k]; }); return r; };
      const who = o => ({ ok: !!(o && o.ok), ...(o && o.ok && typeof o.by === 'string' ? { by: o.by.slice(0, 120) } : {}), ...(o && o.ok && typeof o.at === 'string' ? { at: o.at.slice(0, 40) } : {}) });
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
      const L0 = { from: -6, to: 6, margin: 3 }, pl = plan.lesion || {};
      S.lesion = Object.assign(num(pl, ['from', 'to', 'margin'], L0), who(pl), { condyle: pl.condyle === 'R' || pl.condyle === 'L' ? pl.condyle : null });
      const P0 = { off: 0, yaw: 0, pitch: 0, w: 1.2 }, C0 = Object.assign({ u: 0, v: 0, tiltU: 0, tiltV: 0 }, SCREW_DEFAULT.mandible);
      S.planes = (Array.isArray(plan.planes) ? plan.planes : []).slice(0, 8).map(p => Object.assign(num(p, Object.keys(P0), P0), who(p)));
      // older versions could save an empty (null) screw when no position reached bone: drop it, re-place the screws
      const rawScrews = (Array.isArray(plan.screws) ? plan.screws : []).slice(0, 16), lostScrew = rawScrews.some(c => !c || typeof c !== 'object');
      S.screws = rawScrews.filter(c => c && typeof c === 'object').map(c => Object.assign(num(c, Object.keys(C0), C0), who(c), c.plate === true ? { plate: true } : {}, c.hand === 1 || c.hand === true ? { hand: 1 } : {}));
      S.planes.forEach(p => { clampTo(p, 'off', -45, 45); clampTo(p, 'yaw', -89, 89); clampTo(p, 'pitch', -89, 89); clampTo(p, 'w', 0.6, 2.5); });
      S.screws.forEach(c => { if (c.part !== -1 && c.part !== 1) delete c.part; clampTo(c, 'u', -80, 80); clampTo(c, 'v', -15, 15); clampTo(c, 'tiltU', -89, 89); clampTo(c, 'tiltV', -89, 89); clampTo(c, 'd', 0.5, 6); clampTo(c, 'D', c.d, 12); clampTo(c, 'sleeveH', 0, 20); clampTo(c, 'len', 2, 40); });
      ['from', 'to'].forEach(k => clampTo(S.lesion, k, -45, 45)); clampTo(S.lesion, 'margin', 0, 15);
      if (plan.perSide === 1 || plan.perSide === 2) $('perSide').value = String(plan.perSide);
      // plans from before the explicit 'Guide oluştur' step always had a guide when they had screws
      S.guideOn = typeof plan.guideOn === 'boolean' ? plan.guideOn : S.screws.length > 0; S.resRemoved = !!plan.resRemoved;
      $('surgeon').value = typeof plan.surgeon === 'string' ? plan.surgeon : '';
      if (S.sel && !(S.sel[0] === 'p' ? S.planes : S.screws)[+S.sel.slice(1)]) S.sel = null;
      if (lostScrew && S.anchor && S.planes.length) { placeScrews(); alertMsg('Planda boş bir vida kaydı vardı; vidalar yeniden yerleştirildi. Kontrol edip onaylayın.'); }
      syncGuideInputs(); syncLesion(); showAnchor(); updateLesionPart(); if (S.anchor && S.mode === 'anchor') setMode('orbit');
      if (!S.anchor) { ['guide', 'resected', 'lesion'].forEach(id => setPart(id, null, null)); clearElementParts(); S.result = null; }
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
    const src = plan.source;
    if (src && src.type === 'sample' && !(S.source && S.source.fp === src.fp)) { S.autoAnchor = false; S.restoring = true; await loadSample(src.name); }
    else if (src && src.type === 'dicom' && !(S.source && S.source.fp === src.fp)) {
      S.pendingPlan = plan;
      alertMsg(`${xl('Bu vaka')} "${src.name}" ${xl(`serisine (${src.slices || '?'} kesit) ait. Planı açmak için aynı DICOM serisini yükleyin.`)}`);
      return false;
    }
    await applyPlan(plan); return true;
  }
  function serverUrl() { return ($('aiUrl').value || '').trim().replace(/\/+$/, ''); }
  function select(sel) { if (sel) S.guideSel = false; S.sel = sel; emit('select', sel); renderElements(); rebuildElementParts(S.result ? S.result.pls : planesWorld(), S.result ? S.result.screwInfo : []); applyExplode(); render(); }
  window.Studio = { mandibleView, startLoad, loadStopped, LOAD_CANCELLED, renderComps, setGuideRot, setGuideRoll, planFromLesion, fitWrap, anchorFromLesion, placeScrews, caseLine, renderParts, resEnds, splitGap, cutMisses, evalScrew, resectedAt, bestScrew,
    boneSections, sizeBody, autoBody, buildGuideSet, cutsAngle, cutFrame, frameAt, stumpGap, mergeStl, mergeMeshes, AUTO_DEFAULT, G_DEFAULT, unapproveAll, pendingList: pending, gizmo, proxy, syncGizmo, live, camF, ctlF, setSplit, resize, goTo, refPos, approveItem, renderChecks, updateMarkers, placeMarkers, renderElements, esc, ray, toWorldRed, setMode, rebuildBone, segment, S, parts, buildGuide, boneAtIn, meshFromNets, applyExplode, renderer, bus, emit, render, scene, camera, controls, renderer, V, fmt, planOf, applyPlan, openPlan, frameAxes, planesWorld, screwWorld, schedule, select, serverUrl, alertMsg, busy, boneAt, unapprove, mat, setPart, COLORS, fitTo, rebuildResection, regenerate, updatePanels, sleep, fieldAt, serverGuide, guideRequest, stlOf, offer, zip, zipBytes, G, segThr, screwsWorld, deg, readSample, readDicom, stamp, clone, renderAppr, setVolume, boneField, simplifyMesh };
  bus.addEventListener('planeDragged', () => { renderElements(); schedule(true, true); });
  // messages assembled at run time are written in the language that was active: write them again when it changes
  if (window.addEventListener) window.addEventListener('langchange', () => { try { renderAppr(); syncLesion(); } catch (e) { /* no case open yet */ } });
  emit('ready');

  try { await loadSample('mandible'); } catch (e) { busy(false); alertMsg('Örnek vaka açılamadı: ' + e.message); }
})();
