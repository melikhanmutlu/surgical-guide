/* Segmentation correction on top of the automatic bone mask: brush (add), eraser, 3D scissors (lasso through
   the view) and one-click cleanups (metal / tooth enamel, small fragments). Edits are stored as add / delete
   voxel sets on the 0.8 mm working grid, so a new threshold keeps them, and they are part of the plan
   (saved, versioned, undoable). */
'use strict';
window.SegEdit = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const NAMES = { brush: 'Fırça', erase: 'Silgi', scissors: 'Makas' };
  let tool = null, add = null, del = null, radius = 3, boneOnly = true, stroke = null, lastPaint = null;

  const n = () => S.red ? S.red.nx * S.red.ny * S.red.nz : 0;
  function ensure() { const N = n(); if (!add || add.length !== N) { add = new Uint8Array(N); del = new Uint8Array(N); } }
  const count = a => { let c = 0; if (a) for (let i = 0; i < a.length; i++) c += a[i]; return c; };
  const edited = () => !!(add && (add.indexOf(1) >= 0 || del.indexOf(1) >= 0));

  // ---------- painting: a disc in the slice (axis given) or a ball in 3D ----------
  function stamp(world, axis, erase) {
    ensure();
    const r = S.red, c = G.indexOf(r, world), dim = [r.nx, r.ny, r.nz], rad = r.sp.map(s => Math.ceil(radius / s));
    if (axis != null) rad[axis] = 0;
    const lo = c.map((x, a) => Math.max(0, Math.round(x) - rad[a])), hi = c.map((x, a) => Math.min(dim[a] - 1, Math.round(x) + rad[a]));
    const thr = Math.min(+$('thr').value, 250) - 100;
    let changed = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const d2 = ((i - c[0]) * r.sp[0]) ** 2 + ((j - c[1]) * r.sp[1]) ** 2 + ((k - c[2]) * r.sp[2]) ** 2;
      if (axis == null ? d2 > radius * radius : d2 - (([i, j, k][axis] - c[axis]) * r.sp[axis]) ** 2 > radius * radius) continue;
      const v = i + r.nx * (j + r.ny * k);
      if (erase) { if (S.mask[v] || add[v]) { del[v] = 1; add[v] = 0; S.mask[v] = 0; changed++; } }
      else if (!S.mask[v] && (!boneOnly || r.hu[v] >= thr)) { add[v] = 1; del[v] = 0; S.mask[v] = 1; changed++; }
    }
    return changed;
  }
  function paint(world, axis, first) {
    if (!tool || tool === 'scissors' || !S.red) return;
    if (first) stroke = { n: 0 };
    if (!stroke) return;
    stroke.n += stamp(world, axis, tool === 'erase'); lastPaint = { p: world, axis };
    if (window.MPR) MPR.redraw();
  }
  async function strokeEnd() {
    const s = stroke; stroke = null; lastPaint = null;
    if (!s) return;
    if (s.n) await commit(`${tool === 'erase' ? 'Silgi' : 'Fırça'}: ${s.n} voksel`);
    else if (window.MPR) MPR.redraw();
  }
  async function commit(msg) {
    // the bone changed under every approved step
    if (St.unapproveAll) St.unapproveAll();
    await St.rebuildBone(false);
    status(msg); St.emit('changed'); if (window.MPR) MPR.redraw();
  }

  // ---------- 3D brush / eraser (orbit is off while the tool is on; hold Alt to orbit) ----------
  const cv = St.renderer.domElement, mouse = new THREE.Vector2();
  function hit3D(e) {
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    if (e.clientX - rect.left > rw) return null;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const t = ['bone', 'resected'].filter(k => St.parts[k] && St.parts[k].visible).map(k => St.parts[k].obj);
    const h = St.ray.intersectObjects(t, false)[0]; if (!h) return null;
    // the eraser bites below the surface, the brush builds on top of it
    const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (nrm.dot(St.ray.ray.direction) > 0) nrm.negate();
    return h.point.clone().addScaledVector(nrm, tool === 'erase' ? -radius * 0.5 : radius * 0.3);
  }
  let down3 = false;
  cv.addEventListener('pointerdown', e => {
    if (!tool || e.altKey || e.button !== 0) return;
    if (tool === 'scissors') { e.preventDefault(); lassoStart(e); return; }
    const p = hit3D(e); if (!p) return;
    down3 = true; cv.setPointerCapture(e.pointerId); paint(p.toArray(), null, true); marker(p);
  });
  cv.addEventListener('pointermove', e => {
    if (lasso) { lassoMove(e); return; }
    if (!down3) return;
    const p = hit3D(e); if (p) { paint(p.toArray(), null, false); marker(p); }
  });
  cv.addEventListener('pointerup', e => {
    if (lasso) { lassoEnd(e); return; }
    if (!down3) return; down3 = false; clearMarkers(); strokeEnd();
  });
  const mk = new THREE.Group(); St.scene.add(mk);
  function marker(p) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color: tool === 'erase' ? 0xe5484d : 0x46c98b, transparent: true, opacity: 0.35, depthTest: false }));
    m.position.copy(p); mk.add(m); St.render();
  }
  function clearMarkers() { while (mk.children.length) { const c = mk.children.pop(); c.geometry.dispose(); c.material.dispose(); } St.render(); }
  document.addEventListener('keydown', e => { if (e.key === 'Alt' && tool) St.controls.enabled = true; });
  document.addEventListener('keyup', e => { if (e.key === 'Alt' && tool) St.controls.enabled = false; });

  // ---------- scissors: lasso on the 3D view removes every bone voxel whose projection falls inside ----------
  let lasso = null;
  const lc = document.createElement('canvas'); lc.className = 'lasso'; lc.hidden = true;
  document.querySelector('.stagewrap').appendChild(lc);
  function lassoStart(e) {
    const rect = cv.getBoundingClientRect(), host = lc.parentElement.getBoundingClientRect();
    lc.style.left = (rect.left - host.left) + 'px'; lc.style.top = (rect.top - host.top) + 'px';
    lc.width = rect.width; lc.height = rect.height; lc.style.width = rect.width + 'px'; lc.style.height = rect.height + 'px'; lc.hidden = false;
    lasso = { pts: [[e.clientX - rect.left, e.clientY - rect.top]], rect, keep: e.shiftKey }; cv.setPointerCapture(e.pointerId); drawLasso();
  }
  function lassoMove(e) { const p = [e.clientX - lasso.rect.left, e.clientY - lasso.rect.top], q = lasso.pts[lasso.pts.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 3) { lasso.pts.push(p); drawLasso(); } }
  function drawLasso() {
    const c = lc.getContext('2d'); c.clearRect(0, 0, lc.width, lc.height);
    c.strokeStyle = '#ffd23f'; c.lineWidth = 1.5; c.setLineDash([6, 4]); c.fillStyle = 'rgba(255,210,63,.08)';
    c.beginPath(); lasso.pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.fill(); c.stroke();
  }
  async function lassoEnd() {
    const L = lasso; lasso = null; lc.hidden = true;
    if (L.pts.length < 3) return;
    ensure();
    const r = S.red, cam = St.camera, w = S.split ? L.rect.width / 2 : L.rect.width, h = L.rect.height, P = L.pts, q = new THREE.Vector3();
    const inside = (x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    let cut = 0;
    for (let k = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      const v = i + r.nx * (j + r.ny * k); if (!S.mask[v]) continue;
      q.fromArray(G.worldOf(r, i, j, k)).project(cam);
      const sx = (q.x + 1) / 2 * w, sy = (1 - q.y) / 2 * h, inn = q.z < 1 && inside(sx, sy);
      if (inn !== L.keep) { del[v] = 1; add[v] = 0; cut++; }
    }
    if (cut) await commit(`Makas: ${cut} voksel çıkarıldı`); else status('Seçilen alanda kemik yok.');
  }

  // ---------- cleanups ----------
  async function metal() {
    if (!S.red) return; ensure();
    const r = S.red, T = +$('seMetal').value, nxy = r.nx * r.ny, hot = new Uint8Array(n());
    for (let v = 0; v < hot.length; v++) if (r.hu[v] >= T) hot[v] = 1;
    let cut = 0;
    for (let v = 0; v < hot.length; v++) {
      if (!S.mask[v]) continue;
      const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / nxy) | 0;
      let near = hot[v];
      for (let dk = -1; dk <= 1 && !near; dk++) for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1 && !near; di++) {
        const a = i + di, b = j + dj, c = k + dk;
        if (a >= 0 && b >= 0 && c >= 0 && a < r.nx && b < r.ny && c < r.nz && hot[a + r.nx * (b + r.ny * c)]) near = 1;
      }
      if (near) { del[v] = 1; add[v] = 0; cut++; }
    }
    if (cut) await commit(`${T} HU üstü (metal, diş minesi): ${cut} voksel çıkarıldı`); else status(`${T} HU üstünde kemik vokseli yok.`);
  }
  async function fragments() {
    if (!S.red) return; ensure();
    const r = S.red, min = Math.round(+$('seFrag').value * 1000 / (r.sp[0] * r.sp[1] * r.sp[2]));
    const { labels, comps } = G.components(S.mask, r.nx, r.ny, r.nz, 1), small = new Set(comps.filter(c => c.size < min).map(c => c.label));
    let cut = 0;
    if (small.size) for (let v = 0; v < labels.length; v++) if (small.has(labels[v])) { del[v] = 1; add[v] = 0; cut++; }
    if (cut) await commit(`${small.size} küçük parça (${cut} voksel) çıkarıldı`); else status('Küçük parça yok.');
  }
  async function reset() { if (!edited()) return; add = del = null; await commit('Düzeltmeler kaldırıldı'); }

  // ---------- slices: added voxels green, removed red, brush outline while painting ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    if (!add || !S.red || !edited() && !lastPaint) return;
    const r = S.red, k = Math.round(G.indexOf(r, G.worldOf(S.vol, ...A.st.cur))[v.axis]);
    if (k >= 0 && k < [r.nx, r.ny, r.nz][v.axis] && edited()) {
      const a1 = v.ix, a2 = v.iy, d1 = [r.nx, r.ny, r.nz][a1], d2 = [r.nx, r.ny, r.nz][a2], ix = [0, 0, 0]; ix[v.axis] = k;
      const sx = r.sp[a1] / S.vol.sp[a1] * T.sx * T.s, sy = r.sp[a2] / S.vol.sp[a2] * T.sy * T.s;
      for (let b = 0; b < d2; b++) for (let a = 0; a < d1; a++) {
        ix[a1] = a; ix[a2] = b; const vv = ix[0] + r.nx * (ix[1] + r.ny * ix[2]);
        if (!add[vv] && !del[vv]) continue;
        const im = A.idxToImg(v, A.toIdx(G.worldOf(r, ...ix)));
        ctx.fillStyle = add[vv] ? 'rgba(70,201,139,.45)' : 'rgba(229,72,77,.45)';
        ctx.fillRect(T.fx(im[0]) - sx / 2, T.fy(im[1]) - sy / 2, sx + 0.5, sy + 0.5);
      }
    }
    if (lastPaint && lastPaint.axis === v.axis) {
      const im = A.idxToImg(v, A.toIdx(lastPaint.p));
      ctx.strokeStyle = tool === 'erase' ? '#e5484d' : '#46c98b'; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(T.fx(im[0]), T.fy(im[1]), radius * T.s, 0, 2 * Math.PI); ctx.stroke();
    }
  });

  // ---------- plan storage: run-length encoded voxel sets ----------
  // content hash of both edit sets, so any change (not only a change in size) invalidates the production STL
  function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  function rle(a) { const out = []; let cur = 0, run = 0; for (let i = 0; i < a.length; i++) { if (a[i] === cur) run++; else { out.push(run.toString(36)); cur ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); }
  function unrle(s, N) { const a = new Uint8Array(N); let p = 0, cur = 0; s.split(',').forEach(t => { const r = parseInt(t, 36); if (cur) a.fill(1, p, Math.min(N, p + r)); p += r; cur ^= 1; }); return a; }
  (window.PlanExt = window.PlanExt || {}).seg = {
    label: 'Segmentasyon düzeltmesi', pre: true,
    get: () => edited() ? { dims: [S.red.nx, S.red.ny, S.red.nz], add: rle(add), del: rle(del) } : null,
    set(x) {
      if (!x || !S.red || x.dims.join() !== [S.red.nx, S.red.ny, S.red.nz].join()) add = del = null;
      else { add = unrle(x.add, n()); del = unrle(x.del, n()); }
      status(); if (window.MPR) MPR.redraw();
    },
  };

  // ---------- panel ----------
  function setTool(t) {
    tool = tool === t ? null : t;
    if (tool && window.Measure && Measure.active()) $('toolMeasure').click();
    if (tool && window.Lesion) Lesion.off();
    St.controls.enabled = !tool; cv.style.cursor = tool ? 'crosshair' : '';
    document.querySelectorAll('#seTools [data-t]').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === tool));
    const b = $('modeBadge');
    if (tool) { b.hidden = false; b.textContent = tool === 'scissors' ? 'Makas: 3B görünümde çıkarılacak bölgeyi çevreleyin (Shift: içini tut). Döndürmek için Alt. Bitirmek için Esc.' : `${NAMES[tool]}: kesitlerde ya da 3B görünümde sürükleyin. Döndürmek için Alt basılı tutun. Bitirmek için Esc.`; }
    else if (!(window.Measure && Measure.active())) b.hidden = true;
  }
  function status(msg) {
    const a = count(add), d = count(del), vox = S.red ? S.red.sp[0] * S.red.sp[1] * S.red.sp[2] / 1000 : 0;
    $('seStat').innerHTML = (msg ? `<b>${St.esc(msg.replace(/\.$/, ''))}.</b> ` : '') + (a || d ? `Toplam: +${fmt(a * vox, 2)} cm³ eklendi, −${fmt(d * vox, 2)} cm³ çıkarıldı.` : 'Düzeltme yok; otomatik segmentasyon kullanılıyor.');
    $('seReset').disabled = !(a || d);
  }
  $('segEdit').innerHTML = `<details class="sub-d"><summary>Kemik modelini elle düzelt (gerekirse)</summary>
    <p class="hint">Otomatik kemik modeli hatalıysa kullanın. Fırça eksik kemiği ekler, Silgi fazlasını siler (kesitlerde ya da 3B'de sürükleyin), Makas 3B'de çevrelediğiniz bölgeyi keser.</p>
    <span class="seg" id="seTools" role="group" aria-label="Düzeltme aracı">
      <button data-t="brush" aria-pressed="false"><svg class="i"><use href="#i-brush"/></svg>Fırça</button>
      <button data-t="erase" aria-pressed="false"><svg class="i"><use href="#i-eraser"/></svg>Silgi</button>
      <button data-t="scissors" aria-pressed="false"><svg class="i"><use href="#i-scissors"/></svg>Makas</button>
    </span>
    <div class="ctl"><div class="ctl-row"><label for="seRad">Fırça yarıçapı</label><output id="seRadO">3 mm</output></div><input type="range" id="seRad" min="1" max="12" step="0.5" value="3"></div>
    <label class="chk"><input type="checkbox" id="seBone" checked> Fırça yalnız kemik yoğunluğunu boyasın</label>
    <div class="ctl"><div class="ctl-row"><label for="seMetal">Metal / diş minesi eşiği</label><output id="seMetalO">2000 HU</output></div><input type="range" id="seMetal" min="1200" max="3500" step="50" value="2000"></div>
    <div class="ctl"><div class="ctl-row"><label for="seFrag">En küçük parça</label><output id="seFragO">0,5 cm³</output></div><input type="range" id="seFrag" min="0.1" max="5" step="0.1" value="0.5"></div>
    <div class="btns"><button id="seMetalRun"><svg class="i"><use href="#i-spark"/></svg>Metal ve dişleri temizle</button><button id="seFragRun">Küçük parçaları sil</button></div>
    <div class="btns"><button id="seReset"><svg class="i"><use href="#i-x"/></svg>Düzeltmeleri kaldır</button></div>
    <p class="hint" id="seStat"></p></details>`;
  document.querySelectorAll('#seTools [data-t]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
  $('seRad').addEventListener('input', e => { radius = +e.target.value; $('seRadO').textContent = `${fmt(radius, 1)} mm`; });
  $('seMetal').addEventListener('input', e => { $('seMetalO').textContent = `${e.target.value} HU`; });
  $('seFrag').addEventListener('input', e => { $('seFragO').textContent = `${fmt(+e.target.value, 1)} cm³`; });
  $('seBone').addEventListener('change', e => { boneOnly = e.target.checked; });
  const guard = f => async () => { if (!S.red) return; await f(); };
  $('seMetalRun').addEventListener('click', guard(metal));
  $('seFragRun').addEventListener('click', guard(fragments));
  $('seReset').addEventListener('click', guard(reset));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && tool) setTool(tool); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { add = del = null; status(); } });
  status();

  return { active: () => !!tool && tool !== 'scissors', tool: () => tool, paint, strokeEnd, applyTo(m) { if (!add || add.length !== m.length) return; for (let v = 0; v < m.length; v++) { if (del[v]) m[v] = 0; else if (add[v]) m[v] = 1; } },
    hasAdditions: () => !!(add && add.indexOf(1) >= 0), edited, key: () => edited() ? hash(rle(add)) + ':' + hash(rle(del)) : '', setTool, off: () => { if (tool) setTool(tool); }, metal, fragments, reset };
})();
