/* Masks and layers of the bone (Mimics' Threshold, Region Grow and Split Mask): the threshold mask can join bones
   that touch (closed teeth, the jaw joint). The surgeon marks each bone in its own colour on a few slices (or on the
   3D model) and the mask is split along the contact surface into Layer A, Layer B, ... One or more layers are the
   planning bone: cuts, resection, screws and the guide are computed from them only. The other layers are never
   deleted; they stay hidden and can be shown as context. Marks are part of the plan and survive a new threshold. */
'use strict';
window.Masks = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, fmt, bus } = St, $ = id => document.getElementById(id);
  const PALETTE = [0x46c98b, 0x4f8fe6, 0xe0a03a, 0x9b6ad6, 0x2bb0b0, 0xd46a9a], OTHER = 0x9aa5b1, BASE = 100000, MAXL = 6;
  const hex = c => '#' + c.toString(16).padStart(6, '0');
  let layers = defaults(), cur = 1, tool = null, radius = 3, seeds = null, seedRed = null, stroke = null, lastPaint = null;
  let planIdx = new Set([1]), active = false, msg = '';
  const ctxOn = new Set(); let ctxLabels = null;
  function defaults() { return [{ name: 'Kemik A', color: PALETTE[0] }, { name: 'Kemik B', color: PALETTE[1] }]; }

  const N = () => S.red ? S.red.nx * S.red.ny * S.red.nz : 0;
  function ensure() { if (!seeds || seedRed !== S.red || seeds.length !== N()) { seeds = new Uint8Array(N()); seedRed = S.red; } }
  const counts = () => { const c = new Array(MAXL + 1).fill(0); if (seeds && seedRed === S.red) for (let v = 0; v < seeds.length; v++) if (seeds[v]) c[seeds[v]]++; return c; };
  const hasSeeds = () => counts().some((x, i) => i && x);
  const isSplit = l => l >= BASE;

  // ---------- marking: a disc in the slice, a ball on the 3D model ----------
  function stamp(world, axis, erase) {
    ensure();
    const r = S.red, c = G.indexOf(r, world), dim = [r.nx, r.ny, r.nz], rad = r.sp.map(s => Math.ceil(radius / s));
    if (axis != null) rad[axis] = 0;
    const lo = c.map((x, a) => Math.max(0, Math.round(x) - rad[a])), hi = c.map((x, a) => Math.min(dim[a] - 1, Math.round(x) + rad[a]));
    const thr = +$('thr').value - 100; let changed = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const d = [(i - c[0]) * r.sp[0], (j - c[1]) * r.sp[1], (k - c[2]) * r.sp[2]]; if (axis != null) d[axis] = 0;
      if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > radius * radius) continue;
      const v = i + r.nx * (j + r.ny * k);
      if (erase) { if (seeds[v]) { seeds[v] = 0; changed++; } }
      else if (r.hu[v] >= thr && seeds[v] !== cur) { seeds[v] = cur; changed++; }
    }
    return changed;
  }
  function paint(world, axis, first) {
    if (!tool || !S.red) return;
    if (tool === 'pick') { if (first) pickAt(world, false); return; }
    if (first) stroke = { n: 0 };
    if (!stroke) return;
    stroke.n += stamp(world, axis, tool === 'erase'); lastPaint = { p: world, axis };
    if (window.MPR) MPR.redraw();
  }
  function strokeEnd() { stroke = null; lastPaint = null; status(); if (window.MPR) MPR.redraw(); }

  // ---------- region grow by click: the piece under the click becomes the planning bone (Shift adds it) ----------
  async function pickAt(world, add) {
    const r = S.red, c = G.indexOf(r, world).map(Math.round), votes = new Map();
    for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = c[0] + di, j = c[1] + dj, k = c[2] + dk;
      if (i < 0 || j < 0 || k < 0 || i >= r.nx || j >= r.ny || k >= r.nz) continue;
      const l = S.labels[i + r.nx * (j + r.ny * k)]; if (l > 0) votes.set(l, (votes.get(l) || 0) + 1);
    }
    if (!votes.size) { msg = 'Tıklanan yerde kemik yok.'; status(); return; }
    let label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (!S.comps.find(c => c.label === label)) {
      // a small piece outside the list: take it in as its own structure
      let size = 0; for (let v = 0; v < S.labels.length; v++) if (S.labels[v] === label) size++;
      S.comps.push({ label, size, centroid: c });
    }
    if (add) { if (S.selected.has(label) && S.selected.size > 1) S.selected.delete(label); else S.selected.add(label); }
    else S.selected = new Set([label]);
    msg = `Planlama kemiği: ${nameOf(label)}.`;
    await selectionChanged();
  }
  async function selectionChanged() {
    planIdx = new Set([...S.selected].filter(isSplit).map(l => l - BASE));
    if (St.unapproveAll) St.unapproveAll();
    await St.rebuildBone(false);
    renderList(); status(); St.emit('changed');
  }

  // ---------- the split ----------
  // called by Studio.segment() right after the threshold mask is labelled (S.labels holds the plain components)
  function relabel() {
    active = false;
    if (!seeds || seedRed !== S.red || !hasSeeds() || !S.labels) return false;
    const r = S.red, base = S.labels, touched = new Set();
    for (let v = 0; v < seeds.length; v++) if (seeds[v] && base[v] > 0) touched.add(base[v]);
    if (!touched.size) { msg = 'İşaretler eşiğin üstündeki kemiğe değmiyor.'; return false; }
    const dom = new Uint8Array(base.length); for (let v = 0; v < base.length; v++) if (base[v] > 0 && touched.has(base[v])) dom[v] = 1;
    const { lab } = G.splitSeeds(r, dom, seeds, +$('thr').value);
    const L = new Int32Array(base), acc = Array.from({ length: MAXL + 1 }, () => [0, 0, 0, 0]);
    for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) {
      const s = lab[v]; if (!s) continue;
      L[v] = BASE + s; const a = acc[s]; a[0] += i; a[1] += j; a[2] += k; a[3]++;
    }
    const split = [];
    acc.forEach((a, s) => { if (s && a[3] && layers[s - 1]) split.push({ label: BASE + s, size: a[3], centroid: [a[0] / a[3], a[1] / a[3], a[2] / a[3]] }); });
    if (!split.length) return false;
    const rest = S.comps.filter(c => !touched.has(c.label));
    S.labels = L; S.comps = split.concat(rest).slice(0, 12);
    S.compNames = {}; split.forEach(c => { S.compNames[c.label] = layers[c.label - BASE - 1].name; });
    rest.forEach((c, i) => { S.compNames[c.label] = `Diğer yapı ${i + 1}`; });
    S.segMethod += ' + katmanlara ayırma';
    let want = [...planIdx].map(i => BASE + i).filter(l => split.find(c => c.label === l));
    if (!want.length) want = [split[0].label];
    S.selected = new Set(want); planIdx = new Set(want.map(l => l - BASE));
    active = true; msg = `${split.length} katmana ayrıldı.`;
    return true;
  }
  async function run() {
    if (!S.red) return;
    if (!hasSeeds()) { msg = 'Önce kesitlerde ya da 3B modelde her kemiği kendi renginde işaretleyin.'; status(); return; }
    if (St.unapproveAll) St.unapproveAll();
    if ($('segMode').value !== 'thr') { $('segMode').value = 'thr'; $('aiBox').hidden = true; $('thrBox').hidden = false; }
    await St.segment(false);
    status(); St.emit('changed'); if (window.MPR) MPR.redraw();
  }
  async function clearAll() {
    seeds = null; msg = 'İşaretler temizlendi.';
    if (active) await St.segment(false); else { status(); if (window.MPR) MPR.redraw(); }
    St.emit('changed');
  }

  // ---------- hidden layers as context in 3D ----------
  const nameOf = l => (S.compNames && S.compNames[l]) || `Yapı ${S.comps.findIndex(c => c.label === l) + 1}`;
  const colorOf = l => isSplit(l) ? (layers[l - BASE - 1] || {}).color || OTHER : OTHER;
  function buildCtx(label) {
    const r = S.red, m = new Uint8Array(S.labels.length);
    let b = [r.nx, r.ny, r.nz, -1, -1, -1];
    for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) if (S.labels[v] === label) {
      m[v] = 1; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
    }
    if (b[3] < 0) return;
    const bb = [b[0] - 2, b[1] - 2, b[2] - 2, b[3] + 2, b[4] + 2, b[5] + 2].map((x, a) => Math.max(0, Math.min([r.nx, r.ny, r.nz][a % 3] - 1, x)));
    const mat = new THREE.MeshStandardMaterial({ color: colorOf(label), roughness: 0.75, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false });
    const mesh = St.meshFromNets(G.surfaceNets(G.blur(m, r.nx, r.ny, r.nz), r.nx, r.ny, r.nz, 0.5, bb), St.toWorldRed, mat);
    mesh.renderOrder = 2;
    St.setPart('ctx_' + label, nameOf(label) + ' (gizli katman)', mesh, colorOf(label));
  }
  function dropCtx() { Object.keys(St.parts).filter(k => k.startsWith('ctx_')).forEach(k => St.setPart(k, null, null)); }
  async function showCtx(label, on) {
    if (on) ctxOn.add(label); else ctxOn.delete(label);
    const pt = St.parts['ctx_' + label];
    if (on && !pt) { St.busy(true, `${nameOf(label)} gösteriliyor…`); await St.sleep(); try { buildCtx(label); } finally { St.busy(false); } }
    else if (pt) { pt.visible = on; pt.obj.visible = on; }
    St.renderParts(); St.render(); renderList();
  }
  // after every bone rebuild: labels may have changed; keep the shown context layers, never one that is planning bone
  bus.addEventListener('bone', () => {
    if (ctxLabels !== S.labels) { dropCtx(); ctxLabels = S.labels; [...ctxOn].forEach(l => { if (!S.comps.find(c => c.label === l)) ctxOn.delete(l); }); }
    [...ctxOn].forEach(l => { if (S.selected.has(l)) { ctxOn.delete(l); St.setPart('ctx_' + l, null, null); } else if (!St.parts['ctx_' + l]) buildCtx(l); });
    St.renderParts(); renderList();
  });

  // ---------- 3D marking / picking (orbit is off while a tool is on; hold Alt to orbit) ----------
  const cv = St.renderer.domElement, mouse = new THREE.Vector2();
  function hit3D(e) {
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    if (e.clientX - rect.left > rw) return null;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const t = Object.values(St.parts).filter(pt => pt.visible && (pt.id === 'bone' || pt.id === 'resected' || pt.id.startsWith('ctx_'))).map(pt => pt.obj);
    const h = St.ray.intersectObjects(t, false)[0]; if (!h) return null;
    const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (nrm.dot(St.ray.ray.direction) > 0) nrm.negate();
    return h.point.clone().addScaledVector(nrm, -Math.min(1.5, radius * 0.5));
  }
  let down3 = false;
  cv.addEventListener('pointerdown', e => {
    if (!tool || e.altKey || e.button !== 0) return;
    const p = hit3D(e); if (!p) return;
    if (tool === 'pick') { pickAt(p.toArray(), e.shiftKey); return; }
    down3 = true; cv.setPointerCapture(e.pointerId); paint(p.toArray(), null, true);
  });
  cv.addEventListener('pointermove', e => { if (!down3) return; const p = hit3D(e); if (p) paint(p.toArray(), null, false); });
  cv.addEventListener('pointerup', () => { if (!down3) return; down3 = false; strokeEnd(); });
  document.addEventListener('keydown', e => { if (e.key === 'Alt' && tool) St.controls.enabled = true; if (e.key === 'Escape' && tool) setTool(tool); });
  document.addEventListener('keyup', e => { if (e.key === 'Alt' && tool) St.controls.enabled = false; });

  // ---------- slices: split layers tinted, marks strong, brush outline ----------
  const rgba = (c, a) => `rgba(${c >> 16 & 255},${c >> 8 & 255},${c & 255},${a})`;
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const r = S.red; if (!r) return;
    const hasS = seeds && seedRed === r, showL = active && S.labels;
    if (!hasS && !showL && !lastPaint) return;
    const k = Math.round(G.indexOf(r, G.worldOf(S.vol, ...A.st.cur))[v.axis]);
    if (k >= 0 && k < [r.nx, r.ny, r.nz][v.axis] && (hasS || showL)) {
      const a1 = v.ix, a2 = v.iy, d1 = [r.nx, r.ny, r.nz][a1], d2 = [r.nx, r.ny, r.nz][a2], ix = [0, 0, 0]; ix[v.axis] = k;
      const sx = r.sp[a1] / S.vol.sp[a1] * T.sx * T.s, sy = r.sp[a2] / S.vol.sp[a2] * T.sy * T.s;
      const fillL = layers.map(L => rgba(L.color, 0.28)), fillS = layers.map(L => rgba(L.color, 0.8));
      for (let b = 0; b < d2; b++) for (let a = 0; a < d1; a++) {
        ix[a1] = a; ix[a2] = b; const vv = ix[0] + r.nx * (ix[1] + r.ny * ix[2]);
        const s = hasS ? seeds[vv] : 0, l = showL ? S.labels[vv] : 0;
        if (!s && !(l >= BASE)) continue;
        const f = s ? fillS[s - 1] : fillL[l - BASE - 1]; if (!f) continue;
        const im = A.idxToImg(v, A.toIdx(G.worldOf(r, ...ix)));
        ctx.fillStyle = f; ctx.fillRect(T.fx(im[0]) - sx / 2, T.fy(im[1]) - sy / 2, sx + 0.5, sy + 0.5);
      }
    }
    if (lastPaint && lastPaint.axis === v.axis) {
      const im = A.idxToImg(v, A.toIdx(lastPaint.p));
      ctx.strokeStyle = tool === 'erase' ? '#e5e8eb' : hex((layers[cur - 1] || layers[0]).color); ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(T.fx(im[0]), T.fy(im[1]), radius / S.vol.sp[v.ix] * T.sx * T.s, 0, 2 * Math.PI); ctx.stroke();
    }
  });

  // ---------- panels ----------
  function setTool(t, force) {
    tool = force ? t : tool === t ? null : t;
    if (tool) {
      if (S.mode !== 'orbit') St.setMode('orbit');
      if (window.SegEdit) SegEdit.off();
      if (window.Lesion) Lesion.off();
      if (window.Measure && Measure.active()) $('toolMeasure').click();
      if (tool !== 'pick' && $('vm3d') && $('vm3d').getAttribute('aria-pressed') === 'true') $('vmStrip').click();
    }
    St.controls.enabled = !tool; cv.style.cursor = tool ? 'crosshair' : '';
    document.querySelectorAll('#mkTools [data-t]').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === tool));
    const b = $('modeBadge');
    if (tool) {
      b.hidden = false;
      b.textContent = tool === 'pick' ? 'Planlama kemiğini seç: 3B modelde ya da kesitte kemiğe tıklayın (Shift: ekle/çıkar) · Esc ile bitir'
        : tool === 'erase' ? 'İşaret silgisi: kesitlerde ya da 3B modelde sürükleyin · döndürmek için Alt · Esc ile bitir'
          : `${layers[cur - 1].name} işaretleniyor: kesitlerde ya da 3B modelde sürükleyin · döndürmek için Alt · Esc ile bitir`;
    } else if (/^(Planlama kemiğini|İşaret silgisi|Katman|.* işaretleniyor)/.test(b.textContent)) b.hidden = true;
  }
  function renderLayers() {
    const c = counts(), vox = S.red ? S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000 : 0;
    $('mkLayers').innerHTML = layers.map((L, i) => `<li class="lay${cur === i + 1 ? ' on' : ''}">
      <label><input type="radio" name="mkCur" value="${i + 1}" ${cur === i + 1 ? 'checked' : ''} aria-label="${St.esc(L.name)} ile işaretle"><i style="background:${hex(L.color)}"></i>
      <input type="text" class="mk-name" data-n="${i + 1}" value="${St.esc(L.name)}" maxlength="40" aria-label="Kemik etiketi adı"></label>
      <span class="hu">${c[i + 1] ? fmt(c[i + 1] * vox, 2) + ' cm³ işaret' : 'işaret yok'}</span>
      ${layers.length > 1 ? `<button class="x" data-del="${i + 1}" title="Etiketi kaldır" aria-label="${St.esc(L.name)} etiketini kaldır">×</button>` : ''}</li>`).join('');
    $('mkLayers').querySelectorAll('input[type=radio]').forEach(el => el.addEventListener('change', () => { cur = +el.value; setTool('paint', true); renderLayers(); }));
    $('mkLayers').querySelectorAll('.mk-name').forEach(el => el.addEventListener('change', () => {
      const i = +el.dataset.n, nm = el.value.trim().slice(0, 40) || `Kemik ${String.fromCharCode(64 + i)}`;
      layers[i - 1].name = nm; if (S.compNames && S.compNames[BASE + i] !== undefined) S.compNames[BASE + i] = nm;
      renderList(); St.emit('changed');
    }));
    $('mkLayers').querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => {
      const i = +el.dataset.del; layers.splice(i - 1, 1);
      if (seeds) for (let v = 0; v < seeds.length; v++) { if (seeds[v] === i) seeds[v] = 0; else if (seeds[v] > i) seeds[v]--; }
      planIdx = new Set([...planIdx].filter(x => x !== i).map(x => (x > i ? x - 1 : x)));
      cur = Math.min(cur, layers.length); status(); if (window.MPR) MPR.redraw();
    }));
    $('mkAdd').disabled = layers.length >= MAXL;
  }
  function status() {
    renderLayers();
    const c = counts();
    $('mkStat').textContent = msg || (active ? 'Maske katmanlara ayrıldı. İşaret ekleyip yeniden ayırabilirsiniz.' : c.some((x, i) => i && x) ? 'İşaretler hazır; "Ayır"a basın.' : 'Henüz işaret yok.');
    $('mkRun').disabled = !hasSeeds(); $('mkClear').disabled = !hasSeeds() && !active;
    msg = '';
  }
  function renderList() {
    if (!S.red || !S.comps) { $('comps').innerHTML = ''; return; }
    const vox = S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000;
    $('comps').innerHTML = `<h3 class="sub">Planlama kemiği</h3>
      <p class="hint more">İşaretli parçalar planlama kemiğidir: kesi, rezeksiyon, vida ve guide yalnız bunlardan hesaplanır. Diğerleri silinmez, gizlenir; göz düğmesiyle açılıp kapanır.</p>
      <ul class="layers">` + (S.comps.map(c => { const sel = S.selected.has(c.label), on = ctxOn.has(c.label);
      return `<li class="lay"><label><input type="checkbox" data-l="${c.label}" ${sel ? 'checked' : ''}><i style="background:${hex(sel ? St.COLORS.bone : colorOf(c.label))}"></i>${St.esc(nameOf(c.label))}</label>
        <span class="hu">${fmt(c.size * vox)} cm³ <button class="eye" data-eye="${c.label}" aria-pressed="${sel || on}" ${sel ? 'disabled title="Planlama kemiği her zaman görünür"' : `title="${on ? 'Gizle' : 'Göster'}"`} aria-label="${St.esc(nameOf(c.label))} ${on ? 'gizle' : 'göster'}"><svg class="i"><use href="#i-eye"/></svg></button></span></li>`; }).join('')
      || '<li class="hint">Eşiğin üstünde yapı bulunamadı.</li>') + '</ul>';
    $('comps').querySelectorAll('input[data-l]').forEach(el => el.addEventListener('change', async () => {
      const l = +el.dataset.l;
      if (el.checked) S.selected.add(l); else if (S.selected.size > 1) S.selected.delete(l); else { el.checked = true; return; }
      if (el.checked) { ctxOn.delete(l); St.setPart('ctx_' + l, null, null); }
      await selectionChanged();
    }));
    $('comps').querySelectorAll('[data-eye]').forEach(el => el.addEventListener('click', () => showCtx(+el.dataset.eye, !ctxOn.has(+el.dataset.eye))));
  }

  $('maskBox').innerHTML = `<h3 class="sub">Bitişik kemikleri ayır</h3>
    <p class="hint more">Eşik maskesi birbirine değen kemikleri tek parça gösterebilir (dişler kapalıyken mandibula ile maksilla, fibula ile tibia). Her kemiği kendi renginde birkaç kesitte kısa vuruşlarla işaretleyip "Ayır"a basın: maske temas yüzeyinden katmanlara bölünür.</p>
    <ul class="layers mkl" id="mkLayers"></ul>
    <span class="seg tools" id="mkTools" role="group" aria-label="İşaret aracı">
      <button data-t="paint" aria-pressed="false"><svg class="i"><use href="#i-brush"/></svg>İşaretle</button>
      <button data-t="erase" aria-pressed="false"><svg class="i"><use href="#i-eraser"/></svg>Silgi</button>
      <button data-t="pick" aria-pressed="false"><svg class="i"><use href="#i-target"/></svg>Seç</button>
    </span>
    <div class="ctl"><div class="ctl-row"><label for="mkRad">Fırça yarıçapı</label><output id="mkRadO">3 mm</output></div><input type="range" id="mkRad" min="1" max="10" step="0.5" value="3"></div>
    <div class="btns grid2"><button class="primary" id="mkRun" disabled><svg class="i"><use href="#i-scissors"/></svg>Ayır</button><button id="mkAdd"><svg class="i"><use href="#i-plus"/></svg>Etiket ekle</button></div>
    <div class="btns end"><button id="mkClear" class="ghost danger sm" disabled>İşaretleri temizle</button></div>
    <p class="hint" id="mkStat"></p>
    <p class="hint more">"Seç": 3B modelde ya da kesitte bir kemiğe tıklayınca o parça planlama kemiği olur (bölge büyütme). Shift ile birden fazla parça seçilir.</p>`;
  document.querySelectorAll('#mkTools [data-t]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
  $('mkRad').addEventListener('input', e => { radius = +e.target.value; $('mkRadO').textContent = `${fmt(radius, 1)} mm`; });
  $('mkRun').addEventListener('click', run);
  $('mkClear').addEventListener('click', clearAll);
  $('mkAdd').addEventListener('click', () => {
    if (layers.length >= MAXL) return;
    const used = new Set(layers.map(L => L.color));
    layers.push({ name: `Kemik ${String.fromCharCode(65 + layers.length)}`, color: PALETTE.find(c => !used.has(c)) || OTHER });
    cur = layers.length; setTool('paint', true); status();
  });
  bus.addEventListener('volume', e => {
    if (tool) setTool(tool);
    if (!(e.detail && e.detail.restoring)) { seeds = null; active = false; layers = defaults(); cur = 1; planIdx = new Set([1]); ctxOn.clear(); }
    status(); renderList();
  });

  // ---------- plan storage: marks per layer (run-length encoded), names, colours, planning layers ----------
  function rle(a, val) { const out = []; let c = 0, run = 0; for (let i = 0; i < a.length; i++) { const b = a[i] === val ? 1 : 0; if (b === c) run++; else { out.push(run.toString(36)); c ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); }
  function unrle(s, n, val, into) { let p = 0, c = 0; String(s).split(',').forEach(t => { const r = parseInt(t, 36) || 0; if (c) into.fill(val, p, Math.min(n, p + r)); p += r; c ^= 1; }); }
  (window.PlanExt = window.PlanExt || {}).masks = {
    label: 'Katmanlar (ayırma)', pre: true,
    get: () => (hasSeeds() ? { dims: [S.red.nx, S.red.ny, S.red.nz], layers: layers.map(L => ({ name: L.name, color: L.color })), seeds: layers.map((L, i) => rle(seeds, i + 1)), plan: [...planIdx] } : null),
    async set(x) {
      const ok = x && S.red && Array.isArray(x.dims) && x.dims.join() === [S.red.nx, S.red.ny, S.red.nz].join() && Array.isArray(x.layers) && Array.isArray(x.seeds);
      const was = active;
      if (!ok) { seeds = null; layers = defaults(); planIdx = new Set([1]); if (was) await St.segment(false); status(); return; }
      layers = x.layers.slice(0, MAXL).map((L, i) => ({ name: typeof L.name === 'string' ? L.name.slice(0, 40) : `Kemik ${String.fromCharCode(65 + i)}`, color: Number.isFinite(+L.color) ? +L.color : PALETTE[i] }));
      seeds = new Uint8Array(N()); seedRed = S.red;
      x.seeds.slice(0, layers.length).forEach((s, i) => unrle(s, seeds.length, i + 1, seeds));
      planIdx = new Set((Array.isArray(x.plan) ? x.plan : [1]).map(Number).filter(i => i >= 1 && i <= layers.length));
      cur = 1; await St.segment(false); status(); if (window.MPR) MPR.redraw();
    },
  };
  status();

  return { relabel, renderList, run, active: () => active, tool: () => tool, paint, strokeEnd, setTool, pickAt, showCtx, off: () => { if (tool) setTool(tool); }, layers: () => layers };
})();
