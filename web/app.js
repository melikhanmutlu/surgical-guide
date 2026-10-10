/* Guide studio: DICOM -> bone model -> guide placement -> editable cut slots / screw sleeves -> inspection. */
'use strict';
(async function () {
  const $ = id => document.getElementById(id);
  const fmt = (x, d = 1) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : Number(x)).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sleep = () => new Promise(r => setTimeout(r, 0));
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const deg = THREE.MathUtils.degToRad;
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const COLORS = { bone: 0xddd5bd, resected: 0xd67850, guide: 0x3c82dc, fguide: 0x2a9d8f, screw: 0x8c959c, plane: 0xe0533d, anchor: 0x22a06b, lesion: 0x8e6fd6 };
  // busy indicator; long server jobs get a running bar, elapsed time and a cancel button
  let busyTick = null, busyCancelFn = null;
  const busy = (on, text, opt = {}) => {
    $('busy').hidden = !on; if (text) $('busyText').textContent = text;
    $('busyBar').hidden = !(on && opt.bar); $('busyBar').classList.remove('det'); $('busyBar').firstElementChild.style.width = ''; $('busyCancel').hidden = !(on && opt.cancel); busyCancelFn = on ? opt.cancel || null : null;
    clearInterval(busyTick);
    if (on && opt.bar) { const t0 = Date.now(); busyTick = setInterval(() => { $('busyText').textContent = `${text} ${Math.round((Date.now() - t0) / 1000)} sn${opt.max ? ' / en çok ' + opt.max + ' sn' : ''}`; }, 1000); }
  };
  // determinate bar for file loading: percentage and, once the rate is known, the time left
  const etaText = s => s < 60 ? `${Math.max(1, Math.round(s))} sn` : `${Math.floor(s / 60)} dk ${Math.round(s % 60)} sn`;
  function progress() {
    const t0 = performance.now(); let last = -1e9;
    clearInterval(busyTick); $('busy').hidden = false; $('busyBar').hidden = false; $('busyBar').classList.add('det'); $('busyCancel').hidden = true;
    return async (f, text) => {
      const now = performance.now(); if (now - last < 120 && f < 1) return; last = now;
      f = Math.max(0, Math.min(1, f)); const el = (now - t0) / 1000, eta = f > 0.03 && el > 0.8 && f < 1 ? el * (1 - f) / f : null;
      $('busyBar').firstElementChild.style.width = (f * 100).toFixed(1) + '%';
      $('busyText').textContent = `${text} %${Math.floor(f * 100)}${eta !== null ? ` · yaklaşık ${etaText(eta)} kaldı` : ''}`;
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

  // ---------- case state ----------
  const S = {
    vol: null, red: null, labels: null, comps: [], selected: new Set(), mask: null,
    anchor: null,             // {p:Vector3, n:Vector3, axis:Vector3}
    g: { rot: 0, roll: 0, L: 36, W: 22, wrap: 6, wall: 2.5, clear: 0.3, bridge: 4, side: 1, split: 0, flange: 3, peri: 0, fit: 0, stopT: 0, stopB: 0, stopL: 6, stopD: 5 },
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
  async function loadDicom(files) {
    const r = await readDicom(files);
    if (r.error) { busy(false); alertMsg(r.error); return; }
    S.source = r.source; scan = r.scan;
    if (S.pendingPlan && S.pendingPlan.source && S.pendingPlan.source.fp === r.source.fp) S.autoAnchor = false;
    await setVolume(r.vol, r.label, 'dicom');
  }
  // DICOM files -> { vol, label, source } or { error }
  async function readDicom(files) {
    if (!window.dicomParser) return { error: 'DICOM okuyucu yüklenemedi.' };
    const zipName = files.length === 1 && /\.zip$/i.test(files[0].name) ? files[0].name.replace(/\.zip$/i, '') : null;
    // one bar across the stages: unzip (if any) 30 %, reading the files, then decoding the chosen series
    const prog = progress(), hasZip = window.Unzip && (files.some(f => /\.zip$/i.test(f.name || '')) || (await Promise.all(files.slice(0, 50).map(f => Unzip.isZip(f).catch(() => false)))).some(Boolean));
    const zw = hasZip ? 0.3 : 0, pw = (1 - zw) * 0.55, dw = 1 - zw - pw;
    await prog(0, 'Dosyalar okunuyor…');
    if (hasZip) {
      try {
        const x = await Unzip.expand(files, (i, n) => prog(zw * i / n, `Zip açılıyor (${i}/${n})…`));
        files = x.files;
        if (x.skipped.length) alertMsg(`Zip içinde ${x.skipped.length} dosya açılamadı ve atlandı (şifreli, desteklenmeyen sıkıştırma ya da çok iç içe): ${x.skipped.slice(0, 3).join(', ')}${x.skipped.length > 3 ? '…' : ''}`);
      } catch (e) { return { error: 'Zip açılamadı: ' + e.message }; }
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
    if (!slices.length) { const u = Object.keys(unsup); return { error: u.length ? `Bu aktarım sözdizimi desteklenmiyor: ${u.map(t => window.DicomCodecs ? DicomCodecs.name(t) : t).join(', ')}.` : multi ? 'Çok çerçeveli (enhanced) DICOM henüz desteklenmiyor; seriyi tek kesitli dosyalar olarak dışa aktarın.' : 'Görüntü içeren DICOM bulunamadı.' }; }
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
      catch (e) { return { error: `Kesit ${k + 1} okunamadı: ${e.message || e}` }; }
      const el = ds.elements.x7fe00010, signed = ds.uint16('x00280103') === 1;
      const slope = parseFloat(ds.string('x00281053') || '1'), icpt = parseFloat(ds.string('x00281052') || '0');
      let px;
      if (window.DicomCodecs) {
        try { px = await DicomCodecs.decode(ds); }
        catch (e) { return { error: `Kesit ${k + 1} açılamadı: ${e.message}` }; }
        if (px.length < rows * cols) return { error: `Kesit ${k + 1} boyutu seriyle uyuşmuyor.` };
      } else {
        const buf = ds.byteArray.buffer.slice(ds.byteArray.byteOffset + el.dataOffset, ds.byteArray.byteOffset + el.dataOffset + rows * cols * 2);
        px = signed ? new Int16Array(buf) : new Uint16Array(buf);
      }
      for (let i = 0; i < rows * cols; i++) hu[k * rows * cols + i] = Math.max(-1024, Math.min(32000, px[i] * slope + icpt));
      await prog(p0 + dw * (k + 1) / ser.length, `${what} (${k + 1} / ${ser.length})…`);
    }
    return { source, vol: { hu, nx: cols, ny: rows, nz: ser.length, sp: [ps[1], ps[0], dz], origin: ser[0].ipp,
      axes: [[r.x, r.y, r.z], [c.x, c.y, c.z], [nrm.x, nrm.y, nrm.z]], meta }, label: `${zipName || ((ser[0].path || '').includes('/') ? ser[0].path.split('/')[0] : 'DICOM')}${groups.length > 1 && source.name ? ' · ' + source.name : ''} · ${ser.length} kesit${skipped ? `, ${skipped} dosya atlandı` : ''}` };
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
    const prog = progress(); await prog(0, 'Seri açılıyor…');
    const r = await decodeSeries(scan.groups[i], prog, 0, 1, scan);
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
    $('caseMsg').hidden = true;
    S.vol = vol; S.kind = kind;
    busy(true, 'Hacim küçültülüyor…'); await sleep();
    S.red = G.reduce(vol, 0.8);
    $('caseInfo').innerHTML = `<dt>Vaka</dt><dd>${esc(label)}</dd><dt>Boyut</dt><dd>${vol.nx}×${vol.ny}×${vol.nz}</dd><dt>Voksel</dt><dd>${vol.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd><dt>Çalışma ızgarası</dt><dd>${S.red.sp.map(s => fmt(s, 2)).join(' × ')} mm</dd>`;
    S.qc = qualityCheck(vol); renderQC();
    S.anchor = null; S.planes = []; S.screws = []; S.sel = null; S.result = null; S.guideOn = false; S.resRemoved = false; unapprove(S.lesion);
    if (S.autoAnchor !== false) { S.lesion.condyle = null; S.g.split = 0; syncGuideInputs(); syncLesion(); }
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
    if (m.modality && m.modality !== 'CT') out.push(['crit', 'Kritik', `Modalite ${m.modality}; BT serisi gerekli.`]);
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
    if (m.ts && /^1\.2\.840\.10008\.1\.2\.4\.(50|51|81|91)$/.test(m.ts) && window.DicomCodecs) out.push(['warn', 'Uyarı', `${DicomCodecs.name(m.ts)}: kayıplı sıkıştırma; kemik sınırı birkaç HU kayabilir.`]);
    if (m.tilt > 1) out.push(['crit', 'Kritik', `Gantry eğimi ${fmt(m.tilt)}°; hacim eğik örneklenmiş, guide kemiğe oturmayabilir. Eğimsiz (0°) ya da eğimi düzeltilmiş seri kullanın.`]);
    let mn = Infinity, metal = 0, n = 0;
    for (let i = 0; i < vol.hu.length; i += 7) { const v = vol.hu[i]; if (v < mn) mn = v; if (v > 2500) metal++; n++; }
    if (mn > -900) out.push(['warn', 'Uyarı', `En düşük değer ${mn} HU; HU kalibrasyonu (rescale) şüpheli.`]);
    if (metal / n > 1e-4) out.push(['warn', 'Uyarı', 'Metal artefaktı olabilir (> 2500 HU bölgeler); segmentasyonu kontrol edin.']);
    if (m.series > 1) out.push(['info', 'Bilgi', m.picked ? `${m.series} seri bulundu; seçilen seri kullanıldı.` : `${m.series} seri bulundu; en çok kesitli seri kullanıldı.`]);
    out.push(['info', 'Bilgi', `Kapsam ${fmt(vol.nz * dz, 0)} mm${m.kernel ? `, kernel ${m.kernel}` : ''}.`]);
    return out;
  }
  function renderQC() { $('qc').innerHTML = S.qc.map(([c, t, m]) => `<li class="${c}"><b>${t}</b><span>${m}</span></li>`).join(''); }

  // ---------- segmentation ----------
  async function segment(autoSelect) {
    busy(true, 'Kemik segmentasyonu (eşik + bileşen ayırma)…'); await sleep();
    const r = S.red, thr = +$('thr').value;
    const m = G.threshold(r, thr);
    const { labels, comps } = G.components(m, r.nx, r.ny, r.nz, 200);
    S.labels = labels; S.comps = comps.slice(0, 8); S.compNames = null; S.segMethod = `Eşik ${thr} HU (tarayıcı)`;
    // painted layer marks (Masks) split the threshold mask into layers and choose the planning bone
    const split = window.Masks ? Masks.relabel() : false;
    if (!split && (autoSelect || ![...S.selected].some(l => S.comps.find(c => c.label === l)))) S.selected = new Set(S.comps.length ? [S.comps[0].label] : []);
    renderComps();
    await rebuildBone(true);
  }
  function renderComps() {
    if (window.Masks) { Masks.renderList(); return; }
    const vox = S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000;
    $('comps').innerHTML = S.comps.map((c, i) => `<label class="comp"><input type="checkbox" data-l="${c.label}" ${S.selected.has(c.label) ? 'checked' : ''}> ${S.compNames ? S.compNames[c.label] || 'Yapı ' + (i + 1) : 'Yapı ' + (i + 1)} <span>${fmt(c.size * vox)} cm³</span></label>`).join('') || '<p class="hint">Eşiğin üstünde yapı bulunamadı.</p>';
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
      if (!res.ok) throw new Error(`sunucu ${res.status} döndü`);
      const lab = new Uint8Array(await res.arrayBuffer()), names = JSON.parse(res.headers.get('X-Structures') || '[]');
      if (lab.length !== r.hu.length) throw new Error('etiket hacmi boyutu uyuşmuyor');
      const labels = Int32Array.from(lab), comps = names.map(s => ({ label: s.label, size: 0, centroid: [0, 0, 0] }));
      for (let v = 0; v < labels.length; v++) { const c = comps.find(cc => cc.label === labels[v]); if (c) c.size++; }
      S.labels = labels; S.comps = comps.filter(c => c.size > 0); S.compNames = Object.fromEntries(names.map(s => [s.label, s.name]));
      S.selected = new Set(S.comps.slice(0, 1).map(c => c.label)); S.segMethod = `Yapay zeka sunucusu (${url})`;
      $('caseMsg').hidden = true; renderComps(); await rebuildBone(true);
    } catch (e) {
      busy(false); alertMsg(ac.signal.aborted ? 'Segmentasyon iptal edildi.' : `Segmentasyon sunucusuna ulaşılamadı (${e.message}). Eşik yöntemiyle devam edebilirsiniz.`);
    }
  }
  async function rebuildBone(frame) {
    busy(true, 'Yüzey modeli oluşturuluyor…'); await sleep();
    const r = S.red, m = new Uint8Array(S.labels.length);
    for (let i = 0; i < m.length; i++) m[i] = S.selected.has(S.labels[i]) ? 1 : 0;
    if (window.SegEdit) SegEdit.applyTo(m);
    S.mask = m; S.maskF = G.blur(m, r.nx, r.ny, r.nz);
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
      const aT = A.w / 2 + A.N.dot(A.p), bT = -B.w / 2 + B.N.dot(B.p);
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
      : `Guide hazır · ${S.screws.length} vida` + (f.split ? ' · iki parça (kavisli kemik)' : '') + (f.wrap < (S.kind === 'leg' ? 6 : 5) ? ` · sarma ${fmt(f.wrap, 1)} mm'ye indirildi` : '');
    syncSeq();
  }
  // one button: region (sample spot, painted lesion, or one click on the model), cuts, resected piece removed, guide
  async function autoPrep() {
    if (!S.red || !parts.bone) return;
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
      S.anchor = { p: p.clone(), n, axis: e };
    } else S.anchor = { p: p.clone(), n, axis: Math.abs(n.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0) };
    S.g.roll = 0;
    showAnchor();
  }
  // guide frame: u along the bone axis (rotated by g.rot about n), v = n x u, n = seating normal
  function frameAxes() {
    const { n, axis } = S.anchor;
    let u = axis.clone().sub(n.clone().multiplyScalar(axis.dot(n))).normalize();
    u.applyAxisAngle(n, deg(S.g.rot));
    const v = V().crossVectors(n, u);
    return { u, v, n };
  }
  function planesWorld() {
    const { u, v, n } = frameAxes();
    return S.planes.map(pl => {
      const N = u.clone().applyAxisAngle(n, deg(pl.yaw));
      N.applyAxisAngle(V().crossVectors(n, N).normalize(), deg(pl.pitch)).normalize();
      return { pl, off: pl.off, w: pl.w, N, p: S.anchor.p.clone().add(u.clone().multiplyScalar(pl.off)) };
    });
  }
  function screwsWorld() { return S.screws.map(screwWorld); }
  function screwWorld(sc) {
    const { u, v, n } = frameAxes();
    {
      const dir = n.clone().negate().applyAxisAngle(v, deg(sc.tiltU)).applyAxisAngle(u, deg(sc.tiltV)).normalize();
      // entry = first bone voxel met when walking down -n from above the guide
      const top = S.anchor.p.clone().add(u.clone().multiplyScalar(sc.u)).add(v.clone().multiplyScalar(sc.v)).add(n.clone().multiplyScalar(20));
      let entry = null;
      for (let t = 0; t < 60; t += 0.2) { const q = top.clone().add(n.clone().multiplyScalar(-t)); if (boneAt(q)) { entry = q; break; } }
      return { sc, dir, entry };
    }
  }
  function boneAt(q) { return boneAtIn(S.red, S.maskF, q); }
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
  function screwScore(sc, pls) {
    const s = screwWorld(sc); if (!s.entry) return -Infinity;
    let inBone = 0, cross = false;
    for (let t = 0; t <= sc.len; t += 0.25) {
      const q = s.entry.clone().add(s.dir.clone().multiplyScalar(t));
      if (boneAt(q)) inBone += 0.25;
      for (const pw of pls) if (Math.abs(q.clone().sub(pw.p).dot(pw.N)) <= pw.w / 2 + 1.5) cross = true;
    }
    return 100 * inBone / sc.len - (cross ? 1000 : 0) - 0.15 * (Math.abs(sc.tiltU) + Math.abs(sc.tiltV));
  }
  function suggest() {
    if (!S.anchor) return;
    const L = S.lesion, a = Math.min(L.from, L.to) - L.margin, b = Math.max(L.from, L.to) + L.margin;
    S.planes = [{ off: a, yaw: 0, pitch: 0, w: 1.2, ok: false }, { off: b, yaw: 0, pitch: 0, w: 1.2, ok: false }];
    if (S.guideOn) placeScrews(); else S.screws = [];
    unapprove(S.lesion); S.sel = null;
    updateLesionPart(); schedule(true);
  }
  // screws outside the two outer cuts (one or two per side, 'Vida / taraf'), each at the tilt that stays longest in bone
  // without crossing a cut; the guide is made long enough to hold them
  function placeScrews() {
    const def = SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom, per = +($('perSide') ? $('perSide').value : 1) || 1, gap = 7;
    const { u, v } = frameAxes(), pls = planesWorld().sort((x, y) => x.off - y.off);
    if (pls.length < 1) { S.screws = []; return; }
    const ends = pls.length > 1 ? [[pls[0], -1], [pls[pls.length - 1], 1]] : [[pls[0], -1], [pls[0], 1]];
    const sv = per === 2 ? Math.max(2, Math.min(5, S.g.W / 2 - def.D / 2 - 1.5)) : 0, vs = per === 2 ? [-sv, sv] : [0];
    const pos = [];
    for (const [pw, side] of ends) for (const vv of vs) {
      // where the cut crosses this screw's lateral line, then the gap outward
      const t = pw.off - vv * pw.N.dot(v) / Math.max(0.2, pw.N.dot(u));
      pos.push({ u: Math.round((t + side * (gap + pw.w / 2)) * 2) / 2, v: vv });
    }
    S.g.L = Math.min(100, Math.max(16, Math.ceil(2 * Math.max(...pos.map(p => Math.abs(p.u))) + def.D + 2)));
    syncGuideInputs();
    const pw = planesWorld();
    S.screws = pos.map(({ u: uu, v: vv }) => {
      // straight screw unless a tilt scores better; if the spot has no bone under it (a turned guide axis on a
      // curved jaw), slide it sideways within the guide until it finds bone; with none at all it stays and the
      // screw checks report it
      const lim = Math.max(0, S.g.W / 2 - def.D / 2 - 0.5), dvs = [0];
      for (let d = 1; d <= 2 * lim; d++) dvs.push(d / 2, -d / 2);
      let first = null;
      for (const dv of dvs) {
        const v0 = Math.max(-lim, Math.min(lim, vv + dv));
        let best = Object.assign({ u: uu, v: v0, tiltU: 0, tiltV: 0, ok: false }, def), bs = screwScore(best, pw);
        if (!Number.isFinite(bs)) bs = -Infinity;
        for (let tu = -20; tu <= 20; tu += 5) for (let tv = -20; tv <= 20; tv += 5) {
          const sc = Object.assign({ u: uu, v: v0, tiltU: tu, tiltV: tv, ok: false }, def), sc2 = screwScore(sc, pw);
          if (Number.isFinite(sc2) && sc2 > bs) { bs = sc2; best = sc; }
        }
        if (!first) first = best;
        if (bs > 50) return best;
      }
      return first;
    });
  }
  // a painted lesion (world points) -> lesion extent, and cuts that clear it by the safety margin at the angle that
  // removes the least bone (up to 30°, small penalty per degree so a straight cut wins a near tie)
  function planFromLesion(pts) {
    if (!S.anchor || !pts.length) return null;
    const { u, v, n } = frameAxes(), A0 = S.anchor.p, L = S.lesion, w = 1.2, clear = L.margin + w / 2;
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
  async function fitWrap() {
    if (!S.anchor) return null;
    const w0 = S.g.wrap, test = async (h = 0.8) => { const o = await buildGuide(Object.assign({ g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), bone: boneAt, h }, frameAxes())); const R = o.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1; return R.pieces === want && (!R.seat || !R.seat.ok || R.seat.free > 0); };
    // coarse grid first, then confirm at the resolution of the final guide
    const okAt = async () => (await test()) && (await test(0.4));
    // start from the usual depth (an earlier plan may have lowered it), never below 2 mm (the bridge needs it)
    const top = Math.max(w0, S.kind === 'leg' ? 6 : 5);
    let ok = false, split = false;
    for (let w = top; !ok && w >= 2; w--) { S.g.wrap = w; ok = await okAt(); }
    // a long resection on a curved jaw: two separate guides, one on each side, sit on straighter bone
    if (!ok && !S.g.split && S.planes.length >= 2) {
      S.g.split = 1;
      for (let w = top; !ok && w >= 2; w--) { S.g.wrap = w; ok = await okAt(); }
      if (ok) split = true; else S.g.split = 0;
    }
    if (!ok) S.g.wrap = top;
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
    setAnchor(hit.point.clone(), nrm); return true;
  }
  const lFields = [['from', 'Lezyon başlangıcı', -45, 45, 0.5, 'mm'], ['to', 'Lezyon bitişi', -45, 45, 0.5, 'mm'], ['margin', 'Güvenlik payı', 0, 15, 0.5, 'mm']];
  $('lesCtl').innerHTML = lFields.map(([k, t, mn, mx, st]) => `<div class="ctl"><div class="ctl-row"><label for="l_${k}">${t}</label><output id="lo_${k}"></output></div><input type="range" id="l_${k}" min="${mn}" max="${mx}" step="${st}"></div>`).join('');
  function syncLesion() {
    lFields.forEach(([k, , , , , unit]) => { $('l_' + k).value = S.lesion[k]; $('lo_' + k).textContent = `${fmt(S.lesion[k])} ${unit}`; });
    $('resType').value = S.lesion.condyle || ''; $('resTypeHint').hidden = !S.lesion.condyle;
    $('lesStatus').textContent = !S.anchor ? '' : S.lesion.ok ? `Sınır onaylandı${S.lesion.by ? ' · ' + S.lesion.by : ''}.` : 'Sınır onayı bekliyor (7. adım).';
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
    const sUp = stopSides(g, v), stopX = g.stopT || g.stopB ? (g.stopL || 6) : 0, stopZ = g.stopT || g.stopB ? (g.stopD || 5) : 0;
    const lo = [-g.L / 2 - 4, -g.W / 2 - 4 - stopX, -Math.max(g.wrap + 10, 30) - Math.max(0, g.L / 2 - 15) * 0.6], hi = [g.L / 2 + 4, g.W / 2 + 4 + stopX, g.clear + g.wall + Math.max(maxSleeve, g.bridge) + 6];
    const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1, N = nx * ny * nz;
    const world = (a, b, c) => P.clone().add(u.clone().multiplyScalar(lo[0] + a * h)).add(v.clone().multiplyScalar(lo[1] + b * h)).add(n.clone().multiplyScalar(lo[2] + c * h));
    const toWorld = (a, b, c) => { const q = world(a, b, c); return [q.x, q.y, q.z]; };
    // bone in the local grid
    const B = new Uint8Array(N);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (boneAt(world(i, j, k))) B[i + nx * (j + ny * k)] = 1;
    T.bone = performance.now() - t0; await sleep();
    const O = G.exterior(B, nx, ny, nz), D = G.edt(B, nx, ny, nz); T.edt = performance.now() - t0;
    await sleep();
    // periosteum allowance (soft tissue left on the bone) adds to the clearance
    const c = g.clear + (g.peri || 0), w = g.wall, Gm = new Uint8Array(N), gap = splitGap(g, pls);
    let undercutCols = 0, contact = 0;
    const colTopBone = new Float32Array(nx * ny).fill(-Infinity);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (B[i + nx * (j + ny * k)]) colTopBone[i + nx * j] = lo[2] + k * h;
    // the wrap depth follows the bone: on a curved jaw the bone drops away from the guide plane towards the guide
    // ends, so the depth limit is measured from the top of the bone at each position along the guide (never above
    // the plane through the anchor)
    const topU = new Float32Array(nx).fill(0);
    for (let i = 0; i < nx; i++) {
      let t = -Infinity;
      for (let j = 0; j < ny; j++) if (Math.abs(lo[1] + j * h) <= g.W / 2) t = Math.max(t, colTopBone[i + nx * j]);
      topU[i] = t === -Infinity ? 0 : Math.min(0, t);
    }
    const win = Math.max(1, Math.round(1.5 / h)), wrapAt = new Float32Array(nx);
    for (let i = 0; i < nx; i++) { let m = 0; for (let a = Math.max(0, i - win); a <= Math.min(nx - 1, i + win); a++) m = Math.min(m, topU[a]); wrapAt[i] = m - g.wrap; }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k), d = D[id] * h;
      if (!O[id]) continue;
      const uu = lo[0] + i * h, vv = lo[1] + j * h, nn = lo[2] + k * h;
      // a stop side: the shell continues past the edge by stopL and deeper by stopD
      // (only where no bone lies above in the seating direction, so a stop rests on the bone edge without an undercut)
      const sd = vv > 0 ? sUp.pos : sUp.neg;
      if (Math.abs(uu) > g.L / 2) continue;
      const band = sd && Math.abs(vv) > g.W / 2 - 2, shadow = colTopBone[i + nx * j] > nn;
      const inBox = Math.abs(vv) <= g.W / 2 && nn >= wrapAt[i] && !(band && shadow);
      const inStop = band && Math.abs(vv) <= g.W / 2 + stopX && nn >= wrapAt[i] - stopZ && !shadow;
      if (!inBox && !inStop) continue;
      const inShell = d > c && d <= c + w;
      const edge = g.side > 0 ? vv >= g.W / 2 - g.bridge : vv <= -g.W / 2 + g.bridge;
      const inBridge = edge && d > c + w - 0.5 && d <= c + w + 2.5;
      if (!inShell && !inBridge) continue;
      const q = world(i, j, k);
      if (gap && q.clone().sub(gap.A.p).dot(gap.A.N) > gap.A.w / 2 + g.flange && q.clone().sub(gap.B.p).dot(gap.B.N) < -gap.B.w / 2 - g.flange) continue;
      let cut = false;
      if (d <= c + w + 0.05) for (const pw of pls) if (Math.abs(q.clone().sub(pw.p).dot(pw.N)) <= pw.w / 2) { cut = true; break; }
      if (cut) continue;
      Gm[id] = 1;
      if (inShell && d <= c + h) contact++;
      if (colTopBone[i + nx * j] > nn) undercutCols++;
    }
    // screw sleeves (added) and drill holes (removed)
    const screwInfo = [];
    for (const s of scs) {
      if (!s.entry) { screwInfo.push({ s, ok: false }); continue; }
      // the hole is the drill plus the material profile's sleeve fit
      const out = s.dir.clone().negate(), R = s.sc.D / 2, r = (s.sc.d + (g.fit || 0)) / 2, top = c + w + s.sc.sleeveH;
      const e0 = s.entry.clone().sub(P), el = [e0.dot(u), e0.dot(v), e0.dot(n)], ol = [out.dot(u), out.dot(v), out.dot(n)];
      // only the grid cells within R of the drill axis (the hole runs through the whole grid)
      const rng = [0, 1, 2].map(a => { const p1 = el[a] - ol[a] * 400, p2 = el[a] + ol[a] * 400; return [Math.max(0, Math.floor((Math.min(p1, p2) - R - lo[a]) / h) - 1), Math.min([nx, ny, nz][a] - 1, Math.ceil((Math.max(p1, p2) + R - lo[a]) / h) + 1)]; });
      for (let k = rng[2][0]; k <= rng[2][1]; k++) for (let j = rng[1][0]; j <= rng[1][1]; j++) for (let i = rng[0][0]; i <= rng[0][1]; i++) {
        const qa = lo[0] + i * h - el[0], qb = lo[1] + j * h - el[1], qc = lo[2] + k * h - el[2];
        const t = qa * ol[0] + qb * ol[1] + qc * ol[2];
        const ra = qa - t * ol[0], rb = qb - t * ol[1], rc = qc - t * ol[2], radial = Math.sqrt(ra * ra + rb * rb + rc * rc);
        if (radial > R) continue;
        const id = i + nx * (j + ny * k);
        if (radial <= r) { Gm[id] = 0; continue; }
        if (t >= -1 && t <= top && O[id] && D[id] * h > c) Gm[id] = 1;
      }
      // screw path through bone
      let inBone = 0, crossesPlane = false, exitAt = null;
      for (let t = 0; t <= s.sc.len; t += 0.25) {
        const q = s.entry.clone().add(s.dir.clone().multiplyScalar(t));
        if (boneAt(q)) inBone += 0.25; else if (exitAt === null && t > 1) exitAt = t;
        for (const pw of pls) if (Math.abs(q.clone().sub(pw.p).dot(pw.N)) <= pw.w / 2 + 0.5) crossesPlane = true;
      }
      screwInfo.push({ s, ok: true, inBone: Math.min(inBone, s.sc.len), crossesPlane, exitAt });
    }
    if (gap) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k); if (!Gm[id]) continue;
      const q = world(i, j, k); if (q.clone().sub(gap.A.p).dot(gap.A.N) > gap.A.w / 2 + g.flange && q.clone().sub(gap.B.p).dot(gap.B.N) < -gap.B.w / 2 - g.flange) Gm[id] = 0;
    }
    T.screws = performance.now() - t0; await sleep();
    // drop specks left by slots and holes; count real pieces
    const cc = G.components(Gm, nx, ny, nz, 1), big = cc.comps.length ? cc.comps[0].size * 0.01 : 0;
    const comps = cc.comps.filter(cm => cm.size >= big), keepL = new Set(comps.map(cm => cm.label));
    for (let i = 0; i < N; i++) if (Gm[i] && !keepL.has(cc.labels[i])) Gm[i] = 0;
    const mesh = meshFromNets(G.surfaceNets(G.blur(Gm, nx, ny, nz), nx, ny, nz, 0.5), toWorld, mat(COLORS.guide));
    let vol = 0; for (let i = 0; i < N; i++) vol += Gm[i];
    T.mesh = performance.now() - t0;
    const seat = window.Seat && !ctx.fast ? Seat.analyze({ Gm, B, D, nx, ny, nz, h, lo, clear: c }) : null;
    const wrapProfile = []; for (let i = 0; i < nx; i += Math.max(1, Math.round(1 / h))) wrapProfile.push([+(lo[0] + i * h).toFixed(2), +wrapAt[i].toFixed(2)]);
    return { mesh, result: { wrapProfile, pieces: comps.length, contact: contact * h * h, undercut: undercutCols * h * h, volume: vol * h * h * h, screwInfo, pls, seat, ms: performance.now() - t0, T },
      grid: { Gm, B, nx, ny, nz, h, lo, P: P.clone(), u: u.clone(), v: v.clone(), n: n.clone() } };
  }
  // two separate guides: nothing between the outermost cuts except a capture flange beyond each slot
  function splitGap(g, pls) {
    if (!g.split || pls.length < 2) return null;
    const pl = pls.slice().sort((a, b) => a.off - b.off), A = pl[0], B = pl[pl.length - 1], dir = B.p.clone().sub(A.p).normalize();
    const NA = A.N.clone(), NB = B.N.clone(); if (NA.dot(dir) < 0) NA.negate(); if (NB.dot(dir) < 0) NB.negate();
    return { A: { p: A.p, N: NA, w: A.w }, B: { p: B.p, N: NB, w: B.w } };
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
    const out = await buildGuide(Object.assign({ g: S.g, P: S.anchor.p, pls, scs, bone: boneAt }, frameAxes()));
    if (ver < live.shown) { disposeObj(out.mesh); return; }
    live.shown = ver; S.liveScrews = null;
    setPart('guide', 'Guide', out.mesh, COLORS.guide);
    S.result = out.result; S.grid = out.grid;
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
    const row = pt => `<li><label><input type="checkbox" data-p="${pt.id}" ${pt.visible ? 'checked' : ''}><i style="background:#${pt.color.toString(16).padStart(6, '0')}"></i><span>${pt.label}</span></label><input type="range" min="0.1" max="1" step="0.05" value="${pt.opacity ?? 1}" data-o="${pt.id}" aria-label="${pt.label} saydamlığı" title="Saydamlık"><button class="ghost sm" data-iso="${pt.id}" title="Yalnız bunu göster" aria-label="${pt.label}: yalnız bunu göster"><svg class="i"><use href="#i-eye"/></svg></button></li>`;
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
  const apprText = o => o.ok ? `Onaylı${o.by ? ' · ' + esc(o.by) : ''}${o.at ? ' · ' + new Date(o.at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''}. Değişiklik onayı kaldırır.` : 'Sistem önerisi; cerrah onayı İnceleme ve onay adımında verilir.';
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
      : [['u', 'Konum (eksen boyunca)', -45, 45, 0.5, 'mm'], ['v', 'Konum (yanal)', -15, 15, 0.5, 'mm'], ['tiltU', 'Eğim (eksen yönünde)', -89, 89, 1, '°'], ['tiltV', 'Eğim (yanal)', -89, 89, 1, '°'],
         ['d', 'Matkap çapı', 1.2, 4, 0.1, 'mm'], ['D', 'Kovan dış çapı', 3, 8, 0.1, 'mm'], ['sleeveH', 'Kovan yüksekliği', 0, 12, 0.5, 'mm'], ['len', 'Vida boyu', 6, 40, 1, 'mm']];
    box.innerHTML = `<h3 class="sub">${isP ? 'Kesi' : 'Vida'} ${i + 1}</h3>` + fields.map(([k, t, mn, mx, st, unit]) => `<div class="ctl"><div class="ctl-row"><label for="f_${k}">${t}</label><output id="o_${k}">${fmt(o[k], st < 1 ? 1 : 0)} ${unit}</output></div><input type="range" id="f_${k}" min="${mn}" max="${mx}" step="${st}" value="${o[k]}"></div>`).join('') +
      `<p class="hint">${apprText(o)}</p><p class="hint more">3B görünümde kesiyi ya da vidayı tutup sürükleyebilir, tutamaçla da taşıyabilirsiniz (W taşı, E döndür).</p>` +
      `<div class="btns end"><button id="delEl" class="sm"><svg class="i"><use href="#i-trash"/></svg>${isP ? 'Kesiyi sil' : 'Vidayı sil'}</button></div>`;
    fields.forEach(([k, , , , st, unit]) => $('f_' + k).addEventListener('input', e => { o[k] = +e.target.value; unapprove(o); $('o_' + k).textContent = `${fmt(o[k], st < 1 ? 1 : 0)} ${unit}`; schedule(isP, true); }));
    $('delEl').addEventListener('click', () => { (isP ? S.planes : S.screws).splice(i, 1); S.sel = null; schedule(isP); });
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
      planesWorld().forEach((pw, i) => {
        const un = Math.max(0.2, Math.abs(pw.N.dot(u))), ext = Math.abs(pw.off) + S.g.W / 2 * Math.abs(pw.N.dot(v)) / un;
        if (Math.abs(pw.off) > half - 1) out.push(['crit', 'Kritik', `Kesi ${i + 1} guide gövdesinin dışında (${fmt(pw.off, 1)} mm, guide ±${fmt(half, 1)} mm); guide'ı uzatın ya da iki guide seçin.`, 'p' + i]);
        else if (ext > half) out.push(['warn', 'Uyarı', `Kesi ${i + 1} yuvası guide'ın bir kenarında dışarı taşıyor; guide'ı biraz uzatın.`, 'p' + i]);
      });
      S.screws.forEach((sc, i) => {
        if (!sc) return;
        if (Math.abs(sc.u) + sc.D / 2 > half + 0.5 || Math.abs(sc.v) > S.g.W / 2) out.push(['crit', 'Kritik', `Vida ${i + 1} guide gövdesinin dışında; guide'ı uzatın ya da vidayı içeri alın.`, 's' + i]);
      });
    }
    if (!R.pieces) out.push(['crit', 'Kritik', 'Guide oluşmadı (boş); guide merkezini, duvar ve boşluk değerlerini kontrol edin.', 'guide']);
    if (R.pieces > want) out.push(['crit', 'Kritik', `Guide ${R.pieces} parçaya bölünüyor (beklenen ${want}); ${want === 1 ? 'köprüyü genişletin ya da kesileri taşıyın' : 'her guide\'ın kendi vidası ve yeterli boyu olmalı'}.`, 'guide']);
    if (want === 2 && R.pieces < 2) out.push(['crit', 'Kritik', 'İki guide seçili ama guide ayrılmadı; dış kesiler birbirine yaklaşıyor olabilir. Kesileri ya da guide boyunu kontrol edin.', 'guide']);
    if (want === 2) {
      const g = splitGap(S.g, R.pls), cnt = [0, 0];
      if (g) R.screwInfo.forEach((si, i) => {
        if (!si.ok) return;
        const e = si.s.entry, a = e.clone().sub(g.A.p).dot(g.A.N), b = e.clone().sub(g.B.p).dot(g.B.N);
        if (a < 0) cnt[0]++; else if (b > 0) cnt[1]++;
        else out.push(['crit', 'Kritik', `Vida ${i + 1} iki guide arasındaki rezeksiyon boşluğunda; hiçbir guide'ı sabitlemiyor.`, 's' + i]);
      });
      if (g && (cnt[0] < 1 || cnt[1] < 1)) out.push(['crit', 'Kritik', `İki guide düzeninde her guide en az bir vidayla sabitlenmeli (şu an ${cnt[0]} + ${cnt[1]}).`, 'guide']);
    }
    const st = R.seat;
    if (st && st.ok) {
      if (!st.free) out.push(['crit', 'Kritik', `Guide hiçbir yönde takılamıyor; en iyi yönde bile ${fmt(st.best.block, 0)} mm² kemik guide'ın üstünde kalıyor. Sarma derinliğini azaltın ya da guide'ı taşıyın.`, 'guide']);
      else if (st.best.tilt > 0) out.push(['warn', 'Uyarı', `Guide dik oturtulamıyor; yalnız yaklaşık ${st.best.tilt}° eğik takılabilir (${st.free}/${st.dirs.length} yön uygun). Ameliyatta takma yönü açıklanmalı.`, 'guide']);
      const sw = st.worstSlide, along = Math.abs(sw.dir[0]) > Math.abs(sw.dir[1]) ? 'kemik ekseni boyunca' : 'yanal yönde';
      if (sw.r < 0.05) out.push(['warn', 'Uyarı', `Vidalar takılmadan önce guide ${along} kayabilir: temasın yalnız %${fmt(sw.r * 100, 0)}'i direnç gösteriyor. Belirgin bir anatomik çıkıntıya taşımayı ya da sarmayı artırmayı düşünün.`, 'guide']);
      const wr = st.worstRot, rn = { u: 'kemik ekseni', v: 'yanal eksen', n: 'oturma ekseni' }[wr.axis];
      if (wr.r < 0.05) out.push(['warn', 'Uyarı', `Guide ${rn} etrafında dönebilir: temasın yalnız %${fmt(wr.r * 100, 0)}'i direnç gösteriyor.`, 'guide']);
    } else if (R.undercut > 4) out.push(['crit', 'Kritik', `Guide kemiğin altına sarıyor (${fmt(R.undercut, 0)} mm² alttan kesik); oturtulup çıkarılamaz. Sarma derinliğini azaltın.`, 'guide']);
    if (R.contact < 150) out.push(['warn', 'Uyarı', `Temas alanı ${fmt(R.contact, 0)} mm²; oturma belirsiz olabilir (örnek eşik 150 mm²).`, 'guide']);
    R.screwInfo.forEach((si, i) => {
      if (!si.ok) out.push(['crit', 'Kritik', `Vida ${i + 1} kemiğe ulaşmıyor.`, 's' + i]);
      else {
        if (si.crossesPlane) out.push(['crit', 'Kritik', `Vida ${i + 1} kesi hattından geçiyor.`, 's' + i]);
        if (si.exitAt !== null && si.exitAt < si.s.sc.len) out.push(['warn', 'Uyarı', `Vida ${i + 1} ${fmt(si.exitAt)} mm'de kemikten çıkıyor (bikortikal mi?).`, 's' + i]);
      }
    });
    R.pls.forEach((pw, i) => R.pls.forEach((pq, j) => { if (j > i && Math.abs(pw.off - pq.off) < 3 && Math.abs(pw.N.dot(pq.N)) > 0.95) out.push(['warn', 'Uyarı', `Kesi ${i + 1} ve ${j + 1} birbirine çok yakın.`, 'p' + i]); }));
    if (window.Fibula) Fibula.checks().forEach(c => out.push([c[0], c[1], c[2], c[3] || 'fib']));
    (window.ExtraChecks || []).forEach(f => f().forEach(c => out.push(c)));
    S.crit = out.filter(o => o[0] === 'crit').length;
    S.checkList = out.slice();
    const rank = { crit: 0, warn: 1, ok: 2 }, infos = out.filter(o => o[0] === 'info'), main = out.filter(o => o[0] !== 'info').sort((a, b) => (rank[a[0]] ?? 3) - (rank[b[0]] ?? 3));
    if (!main.length) main.push(['ok', 'Uygun', 'Tüm kontroller geçti.']);
    const li = ([c, t, m, ref]) => `<li class="${c}"${ref ? ` data-go="${ref}" title="İlgili öğeye git" tabindex="0" role="button"` : ''}><b>${t}</b><span>${m}</span></li>`;
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
    if (!name) why.push('onaylayan cerrahın adı girilmedi');
    if (S.crit || qcCrit) why.push(`${S.crit + (qcCrit ? 1 : 0)} kritik kontrol var`);
    if (missing.length) why.push(`onay bekleyen: ${missing.join(', ')}`);
    $('expMsg').textContent = ready ? 'Plan onaylı; paket hazır.' : `Paket için: ${[!name && 'cerrah adı', (S.crit || qcCrit) && `${S.crit + (qcCrit ? 1 : 0)} kritik kontrol`, missing.length && `${missing.length} onay`].filter(Boolean).join(', ') || 'guide gerekli'}. Rapor taslak alınabilir.`;
    $('expMsg').title = $('expZip').title = ready ? '' : `Üretim paketi için: ${why.join('; ') || 'guide henüz üretilmedi'}.`;
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
  let timer = null;
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
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (live.resDirty) { live.planes = live.resDirty = false; busy(true, 'Rezeksiyon güncelleniyor…'); await sleep(); await rebuildResection(); }
      if (S.screwRefit) { S.screwRefit = false; if (S.guideOn && S.anchor) { placeScrews(); S.sel = null; renderElements(); } }
      await regenerate();
      // after a re-fit the message says what the final guide does, not what the trial builds did
      if (S.fitReport) {
        const f = S.fitReport, R = S.result, want = S.g.split && S.planes.length >= 2 ? 2 : 1; S.fitReport = null;
        const ok = R && R.pieces === want && !(R.seat && R.seat.ok && !R.seat.free);
        if ($('guideStat')) $('guideStat').textContent = ok ? `Guide yeni konuma göre yeniden şekillendi (sarma ${fmt(S.g.wrap, 1)} mm${f.split ? ', iki parça' : ''}).` : 'Bu konumda guide kemiğe takılamıyor; açıyı ya da konumu değiştirin veya sarma derinliğini düşürün.';
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
    }, liveEdit ? 400 : 120);
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
      S.screws.push(Object.assign({ u: Math.round(d.dot(u) * 2) / 2, v: Math.round(d.dot(v) * 2) / 2, tiltU: 0, tiltV: 0, ok: false }, SCREW_DEFAULT[S.kind] || SCREW_DEFAULT.dicom));
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
      if (gz.mode === 'translate') { o.u = clampR(o0.u + d.dot(u), -45, 45, 0.5); o.v = clampR(o0.v + d.dot(v), -15, 15, 0.5); }
      else {
        const D = gz.start.d0.clone().applyQuaternion(dq), a = Math.asin(Math.max(-1, Math.min(1, -D.dot(u))));
        o.tiltU = clampR(THREE.MathUtils.radToDeg(a), -89, 89, 1);
        o.tiltV = clampR(THREE.MathUtils.radToDeg(Math.atan2(D.dot(v), -D.dot(n))), -89, 89, 1);
      }
    }
    const key = [o.off, o.yaw, o.pitch, o.u, o.v, o.tiltU, o.tiltV].join();
    if (key === gz.start.key) return;
    gz.start.key = key; gz.start.moved = true;
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
    const targets = ['bone', 'resected'].filter(k => parts[k] && parts[k].visible).map(k => parts[k].obj);
    const hit = r.intersectObjects(targets, false)[0]; if (!hit) return;
    const { o, isP } = dd.on, { u, v } = frameAxes(), d = hit.point.clone().sub(S.anchor.p);
    if (isP) {
      const a = dragAxis() === 'bone' && archAt(hit.point, u);
      // the bone direction turned by some angle about the vertical: turn the cut by the same angle
      if (a && dd.on.t0) planeFrom(a.c, dd.on.N0.clone().applyAxisAngle(V(0, 0, 1), Math.atan2(dd.on.t0.x * a.t.y - dd.on.t0.y * a.t.x, dd.on.t0.dot(a.t))), o);
      else o.off = clampR(d.dot(u), -45, 45, 0.5);
    } else { o.u = clampR(d.dot(u), -45, 45, 0.5); o.v = clampR(d.dot(v), -15, 15, 0.5); }
    const key = [o.off, o.yaw, o.pitch, o.u, o.v].join();
    if (key === dd.on.key) return;
    dd.on.key = key; unapprove(o); syncSliders(o); syncGizmo(); schedule(isP, true);
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

  function setMode(m) {
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
  const gFields = [['rot', 'Yüzeyde döndür', -180, 180, 1, '°'], ['roll', 'Kemik etrafında kaydır', -180, 180, 1, '°'], ['L', 'Uzunluk', 16, 100, 1, 'mm'], ['W', 'Genişlik', 10, 40, 1, 'mm'], ['wrap', 'Sarma derinliği', 2, 20, 0.5, 'mm'], ['wall', 'Duvar kalınlığı', 1.5, 5, 0.1, 'mm'], ['clear', 'Kemik aralığı', 0, 1, 0.05, 'mm'], ['bridge', 'Köprü genişliği', 2, 10, 0.5, 'mm'], ['flange', 'Kesi ötesi kenar', 2, 8, 0.5, 'mm'], ['peri', 'Periost payı', 0, 1, 0.05, 'mm']];
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
    $('g_side').value = String(S.g.side); $('g_split').value = String(S.g.split ? 1 : 0);
    $('g_stopT').checked = !!S.g.stopT; $('g_stopB').checked = !!S.g.stopB; $('stopBox').hidden = !(S.g.stopT || S.g.stopB);
    ['stopL', 'stopD'].forEach(k => { $('g_' + k).value = S.g[k]; $('go_' + k).textContent = `${fmt(S.g[k], 1)} mm`; });
    $('gc_flange').hidden = !S.g.split; $('gc_bridge').hidden = !!S.g.split; $('g_side').closest('.ctl').hidden = !!S.g.split;
  }
  // the screws stay on the guide: a turned guide axis re-places them once the value rests, a shorter or narrower
  // guide pulls them back inside its body
  function clampScrews() {
    const half = S.g.L / 2;
    S.screws.forEach(sc => {
      const mu = Math.max(0, half - sc.D / 2 - 0.5), mv = Math.max(0, S.g.W / 2 - sc.D / 2 - 0.5);
      if (Math.abs(sc.u) > mu) { sc.u = Math.sign(sc.u) * Math.floor(mu * 2) / 2; unapprove(sc); }
      if (Math.abs(sc.v) > mv) { sc.v = Math.sign(sc.v) * Math.floor(mv * 2) / 2; unapprove(sc); }
    });
  }
  gFields.forEach(([k]) => $('g_' + k).addEventListener('input', e => {
    if (k === 'rot') { setGuideRot(+e.target.value); return; }
    if (k === 'roll') { setGuideRoll(+e.target.value); return; }
    S.g[k] = +e.target.value;
    if (k === 'rot') { unapproveAll(); updateLesionPart(); if (S.guideOn && S.screws.length) S.screwRefit = true; }
    if (k === 'rot' || k === 'L' || k === 'W') S.refit = true;
    if ((k === 'L' || k === 'W') && S.guideOn) clampScrews();
    syncGuideInputs(); schedule(k === 'rot', true);
  }));
  $('g_side').addEventListener('change', e => { S.g.side = +e.target.value; schedule(false); });
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
  $('g_split').addEventListener('change', e => { S.g.split = +e.target.value; syncGuideInputs(); unapproveAll(); schedule(false); });
  $('resType').addEventListener('change', async e => {
    const side = e.target.value || null;
    if (side && window.Ref && !Ref.get()) await Ref.compute(false);
    if (side && !(window.Ref && Ref.get() && Ref.get().cond[side])) { alertMsg('Kondil bulunamadı; Anatomi adımında kondili elle seçin.'); e.target.value = S.lesion.condyle || ''; return; }
    S.lesion.condyle = side; unapprove(S.lesion); syncLesion(); schedule(true);
  });
  syncGuideInputs();

  $('segMode').addEventListener('change', e => { const ai = e.target.value === 'ai'; $('aiBox').hidden = !ai; $('thrBox').hidden = ai; if (!ai && S.red) segment(false); });
  $('aiRun').addEventListener('click', () => { if (S.red) segmentAI(); });
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
  $('sampleM').addEventListener('click', () => loadSample('mandible'));
  $('sampleL').addEventListener('click', () => loadSample('leg'));
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
      catch (e) { $('expMsg').textContent = e.code === 'declined' ? 'Kaydetme iptal edildi.' : `Dosya kaydedilemedi (${e.code || e.message}).`; }
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
      planes: c.pls.map(pl => ({ p: arr(pl.p), N: arr(pl.N), w: pl.w })),
      gap: (gp => gp && { A: { p: arr(gp.A.p), N: arr(gp.A.N), w: gp.A.w }, B: { p: arr(gp.B.p), N: arr(gp.B.N), w: gp.B.w }, flange: c.g.flange })(splitGap(c.g, c.pls)),
      screws: c.scs.filter(s => s.entry).map(s => ({ entry: arr(s.entry), dir: arr(s.dir), d: s.sc.d + (c.g.fit || 0), D: s.sc.D, sleeveH: s.sc.sleeveH })),
      wrap_profile: c.wrapProfile || null,
      stops: ss.pos || ss.neg ? { pos: ss.pos ? [g.stopL || 6, g.stopD || 5] : null, neg: ss.neg ? [g.stopL || 6, g.stopD || 5] : null } : null,
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
    if (!res.ok) throw new Error(`Sunucu hatası: ${js.error || res.status}`);
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
      const r = await serverGuide(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: segThr(), g: S.g, P: S.anchor.p, pls: planesWorld(), scs: screwsWorld(), wrapProfile: S.result && S.result.wrapProfile }, frameAxes()), ac.signal);
      S.prod = Object.assign(r, { key: prodKey() });
      $('prodMsg').textContent = `Üretim STL'i hazır: ${r.watertight ? 'su geçirmez' : 'SU GEÇİRMEZ DEĞİL'}, ${r.bodies} parça${r.bodies > (S.g.split ? 2 : 1) ? ' (BEKLENENDEN FAZLA PARÇA, guide\'ı kontrol edin)' : ''}, ${fmt(r.volume / 1000, 2)} cm³, ${r.faces} üçgen. Pakete guide_uretim.stl olarak eklenir.`;
      if (S.fib && S.fib.guide && window.Fibula && !ac.signal.aborted) try { await Fibula.production(ac.signal); } catch (e) { $('prodMsg').textContent += ` Fibula guide'ı: ${e.message}`; }
    } catch (e) { S.prod = null; $('prodMsg').textContent = e.message; }
    busy(false);
  }
  async function exportPackage() {
    if (!parts.guide) return;
    const prod = S.prod && S.prod.key === prodKey() ? S.prod : null;
    const files = [{ name: prod ? 'guide_onizleme.stl' : 'guide.stl', data: stlOf(parts.guide.obj) }, { name: 'kemik_kalan.stl', data: stlOf(parts.bone.obj) }];
    const fg = fullBoneGeo(); if (fg) files.push({ name: 'kemik_tam.stl', data: stlOf(new THREE.Mesh(fg)) });
    if (prod) files.unshift({ name: 'guide_uretim.stl', data: prod.stl });
    if (window.Fibula) Fibula.exportFiles(files);
    (window.ExportHooks || []).forEach(f => { try { f(files); } catch (e) { /* optional files */ } });
    if (parts.resected) files.push({ name: 'rezeke_parca.stl', data: stlOf(parts.resected.obj) });
    files.push({ name: 'plan.json', data: $('json').textContent }, { name: 'rapor.html', data: reportHTML() });
    if (window.Report) try { files.push({ name: 'cerrahi_rapor.pdf', data: new Uint8Array(await (await Report.build()).arrayBuffer()) }); } catch (e) { /* the HTML report is still in the package */ }
    await offer('guide_paketi.zip', zip(files));
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
      g: clone(S.g), lesion: clone(S.lesion), planes: clone(S.planes), screws: clone(S.screws),
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
      const G0 = { rot: 0, roll: 0, L: 36, W: 22, wrap: 6, wall: 2.5, clear: 0.3, bridge: 4, side: 1, split: 0, flange: 3, peri: 0, fit: 0, stopT: 0, stopB: 0, stopL: 6, stopD: 5 };
      Object.assign(S.g, num(plan.g, Object.keys(G0), G0));
      // keep every value inside the range its control allows (a hand-edited or damaged plan cannot hang the app)
      const clampTo = (o, k, a, b) => { o[k] = Math.max(a, Math.min(b, o[k])); };
      gFields.forEach(([k, , a, b]) => clampTo(S.g, k, a, b));
      S.g.side = S.g.side < 0 ? -1 : 1; S.g.split = S.g.split ? 1 : 0; clampTo(S.g, 'fit', -0.5, 0.5);
      S.g.stopT = S.g.stopT ? 1 : 0; S.g.stopB = S.g.stopB ? 1 : 0; clampTo(S.g, 'stopL', 2, 15); clampTo(S.g, 'stopD', 1, 15);
      const L0 = { from: -6, to: 6, margin: 3 }, pl = plan.lesion || {};
      S.lesion = Object.assign(num(pl, ['from', 'to', 'margin'], L0), who(pl), { condyle: pl.condyle === 'R' || pl.condyle === 'L' ? pl.condyle : null });
      const P0 = { off: 0, yaw: 0, pitch: 0, w: 1.2 }, C0 = Object.assign({ u: 0, v: 0, tiltU: 0, tiltV: 0 }, SCREW_DEFAULT.mandible);
      S.planes = (Array.isArray(plan.planes) ? plan.planes : []).slice(0, 8).map(p => Object.assign(num(p, Object.keys(P0), P0), who(p)));
      // older versions could save an empty (null) screw when no position reached bone: drop it, re-place the screws
      const rawScrews = (Array.isArray(plan.screws) ? plan.screws : []).slice(0, 16), lostScrew = rawScrews.some(c => !c || typeof c !== 'object');
      S.screws = rawScrews.filter(c => c && typeof c === 'object').map(c => Object.assign(num(c, Object.keys(C0), C0), who(c)));
      S.planes.forEach(p => { clampTo(p, 'off', -45, 45); clampTo(p, 'yaw', -89, 89); clampTo(p, 'pitch', -89, 89); clampTo(p, 'w', 0.6, 2.5); });
      S.screws.forEach(c => { clampTo(c, 'u', -45, 45); clampTo(c, 'v', -15, 15); clampTo(c, 'tiltU', -89, 89); clampTo(c, 'tiltV', -89, 89); clampTo(c, 'd', 0.5, 6); clampTo(c, 'D', c.d, 12); clampTo(c, 'sleeveH', 0, 20); clampTo(c, 'len', 2, 40); });
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
      alertMsg(`Bu vaka "${src.name}" serisine (${src.slices || '?'} kesit) ait. Planı açmak için aynı DICOM serisini yükleyin.`);
      return false;
    }
    await applyPlan(plan); return true;
  }
  function serverUrl() { return ($('aiUrl').value || '').trim().replace(/\/+$/, ''); }
  function select(sel) { if (sel) S.guideSel = false; S.sel = sel; emit('select', sel); renderElements(); rebuildElementParts(S.result ? S.result.pls : planesWorld(), S.result ? S.result.screwInfo : []); applyExplode(); render(); }
  window.Studio = { renderComps, setGuideRot, setGuideRoll, planFromLesion, fitWrap, anchorFromLesion, placeScrews, caseLine, renderParts, resEnds, splitGap, unapproveAll, pendingList: pending, gizmo, proxy, syncGizmo, live, camF, ctlF, setSplit, resize, goTo, refPos, approveItem, renderChecks, updateMarkers, placeMarkers, renderElements, esc, ray, toWorldRed, setMode, rebuildBone, segment, S, parts, buildGuide, boneAtIn, meshFromNets, applyExplode, renderer, bus, emit, render, scene, camera, controls, renderer, V, fmt, planOf, applyPlan, openPlan, frameAxes, planesWorld, screwWorld, schedule, select, serverUrl, alertMsg, busy, boneAt, unapprove, mat, setPart, COLORS, fitTo, rebuildResection, regenerate, updatePanels, sleep, fieldAt, serverGuide, guideRequest, stlOf, offer, zip, zipBytes, G, segThr, screwsWorld, deg, readSample, readDicom, stamp, clone, renderAppr };
  bus.addEventListener('planeDragged', () => { renderElements(); schedule(true, true); });
  emit('ready');

  try { await loadSample('mandible'); } catch (e) { busy(false); alertMsg('Örnek vaka açılamadı: ' + e.message); }
})();
