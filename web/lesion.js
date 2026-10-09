/* Lesion painting on the slices: the surgeon paints the lesion (any slice, any view) and the cuts and screws are
   planned from it: cut positions and angles clear the painted region by the safety margin while removing as little
   bone as possible (Studio.planFromLesion). The painted voxels live on the 0.8 mm working grid, show as a red
   overlay on the slices and a red body in 3D, and are part of the plan (saved, versioned, undoable). */
'use strict';
window.Lesion = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const COLOR = 0xd9363e;
  let tool = null, mask = null, radius = 4, stroke = null, lastPaint = null;

  const n = () => S.red ? S.red.nx * S.red.ny * S.red.nz : 0;
  const ensure = () => { const N = n(); if (!mask || mask.length !== N) mask = new Uint8Array(N); };
  const count = () => { let c = 0; if (mask) for (let i = 0; i < mask.length; i++) c += mask[i]; return c; };
  function points() {
    const out = [], r = S.red; if (!mask || !r) return out;
    for (let v = 0; v < mask.length; v++) if (mask[v]) out.push(V(...G.worldOf(r, v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0)));
    return out;
  }

  // ---------- painting: a disc in the slice plane ----------
  function stamp(world, axis, erase) {
    ensure();
    const r = S.red, c = G.indexOf(r, world), dim = [r.nx, r.ny, r.nz], rad = r.sp.map(s => Math.ceil(radius / s));
    if (axis != null) rad[axis] = 0;
    const lo = c.map((x, a) => Math.max(0, Math.round(x) - rad[a])), hi = c.map((x, a) => Math.min(dim[a] - 1, Math.round(x) + rad[a]));
    let changed = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const d = [(i - c[0]) * r.sp[0], (j - c[1]) * r.sp[1], (k - c[2]) * r.sp[2]]; if (axis != null) d[axis] = 0;
      if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > radius * radius) continue;
      const v = i + r.nx * (j + r.ny * k);
      if (erase ? mask[v] : !mask[v]) { mask[v] = erase ? 0 : 1; changed++; }
    }
    return changed;
  }
  function paint(world, axis, first) {
    if (!tool || !S.red) return;
    if (first) stroke = { n: 0 };
    if (!stroke) return;
    stroke.n += stamp(world, axis, tool === 'erase'); lastPaint = { p: world, axis };
    if (window.MPR) MPR.redraw();
  }
  function strokeEnd() {
    const s = stroke; stroke = null; lastPaint = null;
    if (s && s.n) changed(); else if (window.MPR) MPR.redraw();
  }
  function changed() { build(); status(); St.emit('changed'); if (window.MPR) MPR.redraw(); }

  // ---------- 3D body ----------
  function build() {
    const r = S.red;
    if (!r || !count()) { St.setPart('lesionPaint', null, null); return; }
    let b = [Infinity, Infinity, Infinity, -1, -1, -1];
    const f = new Float32Array(mask.length);
    for (let v = 0; v < mask.length; v++) if (mask[v]) {
      f[v] = 1; const i = v % r.nx, j = ((v / r.nx) | 0) % r.ny, k = (v / (r.nx * r.ny)) | 0;
      b = [Math.min(b[0], i), Math.min(b[1], j), Math.min(b[2], k), Math.max(b[3], i), Math.max(b[4], j), Math.max(b[5], k)];
    }
    const bb = [b[0] - 2, b[1] - 2, b[2] - 2, b[3] + 2, b[4] + 2, b[5] + 2].map((x, a) => Math.max(0, Math.min([r.nx, r.ny, r.nz][a % 3] - 1, x)));
    const m = St.meshFromNets(G.surfaceNets(f, r.nx, r.ny, r.nz, 0.5, bb), St.toWorldRed, new THREE.MeshStandardMaterial({ color: COLOR, roughness: 0.7, transparent: true, opacity: 0.55, depthWrite: false }));
    m.renderOrder = 4;
    St.setPart('lesionPaint', 'Lezyon (boyanan)', m, COLOR);
  }

  // ---------- slices: painted voxels red, brush outline while painting ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    if (!S.red || (!mask && !lastPaint)) return;
    const r = S.red, k = Math.round(G.indexOf(r, G.worldOf(S.vol, ...A.st.cur))[v.axis]);
    if (mask && k >= 0 && k < [r.nx, r.ny, r.nz][v.axis]) {
      const a1 = v.ix, a2 = v.iy, d1 = [r.nx, r.ny, r.nz][a1], d2 = [r.nx, r.ny, r.nz][a2], ix = [0, 0, 0]; ix[v.axis] = k;
      const sx = r.sp[a1] / S.vol.sp[a1] * T.sx * T.s, sy = r.sp[a2] / S.vol.sp[a2] * T.sy * T.s;
      ctx.fillStyle = 'rgba(217,54,62,.42)';
      for (let b = 0; b < d2; b++) for (let a = 0; a < d1; a++) {
        ix[a1] = a; ix[a2] = b; if (!mask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])]) continue;
        const im = A.idxToImg(v, A.toIdx(G.worldOf(r, ...ix)));
        ctx.fillRect(T.fx(im[0]) - sx / 2, T.fy(im[1]) - sy / 2, sx + 0.5, sy + 0.5);
      }
    }
    if (lastPaint && lastPaint.axis === v.axis) {
      const im = A.idxToImg(v, A.toIdx(lastPaint.p));
      ctx.strokeStyle = tool === 'erase' ? '#e5e8eb' : '#ff6b6b'; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(T.fx(im[0]), T.fy(im[1]), radius / S.vol.sp[v.ix] * T.sx * T.s, 0, 2 * Math.PI); ctx.stroke();
    }
  });

  // ---------- panel ----------
  function setTool(t) {
    tool = tool === t ? null : t;
    if (tool) {
      if (window.SegEdit) SegEdit.off();
      if (window.Measure && Measure.active()) $('toolMeasure').click();
      // painting happens on the slices: make sure they are on screen
      if ($('vm3d') && $('vm3d').getAttribute('aria-pressed') === 'true') $('vmStrip').click();
    }
    document.querySelectorAll('#lsTools [data-t]').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === tool));
    const b = $('modeBadge');
    if (tool) { b.hidden = false; b.textContent = `Lezyon ${tool === 'erase' ? 'silgisi' : 'fırçası'}: kesitlerde lezyonun üzerine sürükleyin. İlk ve son göründüğü kesitleri de boyayın. Bitirmek için Esc.`; }
    else if (/^Lezyon/.test(b.textContent)) b.hidden = true;
  }
  function status() {
    const c = count(), r = S.red, vol = r ? c * r.sp[0] * r.sp[1] * r.sp[2] / 1000 : 0;
    let ext = '';
    if (c && S.anchor) { const { u } = St.frameAxes(), o = points().map(q => q.sub(S.anchor.p).dot(u)); ext = ` · eksende ${fmt(Math.max(...o) - Math.min(...o))} mm`; }
    $('lsStat').textContent = c ? `Boyanan lezyon ${fmt(vol, 2)} cm³${ext}.` : 'Henüz lezyon boyanmadı.';
    $('lsPlan').disabled = !c; $('lsClear').disabled = !c;
  }
  async function plan() {
    const pts = points(); if (!pts.length) return;
    St.busy(true, 'Kesi ve vidalar lezyona göre hesaplanıyor…'); await St.sleep();
    try {
      // the guide is centred over the lesion
      if (!St.anchorFromLesion(pts)) { if (!S.anchor) { St.busy(false); St.alertMsg('Lezyonun üzerinde kemik yüzeyi bulunamadı; "Rezeksiyon bölgesini modelde seç" ile guide merkezini seçin.'); return; } }
      St.planFromLesion(pts);
    } finally { St.busy(false); }
    status();
  }
  $('lesPaint').innerHTML = `<h3 class="sub">Lezyonu işaretle</h3>
    <span class="seg" id="lsTools" role="group" aria-label="Lezyon aracı">
      <button data-t="paint" aria-pressed="false"><svg class="i"><use href="#i-brush"/></svg>Boya</button>
      <button data-t="erase" aria-pressed="false"><svg class="i"><use href="#i-eraser"/></svg>Sil</button>
    </span>
    <div class="ctl"><div class="ctl-row"><label for="lsRad">Fırça yarıçapı</label><output id="lsRadO">4 mm</output></div><input type="range" id="lsRad" min="1" max="12" step="0.5" value="4"></div>
    <div class="btns"><button class="primary" id="lsPlan" disabled><svg class="i"><use href="#i-spark"/></svg>Lezyondan kesi ve vida öner</button><button id="lsClear" disabled>Temizle</button></div>
    <p class="hint" id="lsStat"></p>
    <p class="hint">Kesiler boyanan bölgeyi güvenlik payı kadar dışarıda bırakır; açı, en az kemik alınacak şekilde 30°'ye kadar seçilir.</p>`;
  document.querySelectorAll('#lsTools [data-t]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
  $('lsRad').addEventListener('input', e => { radius = +e.target.value; $('lsRadO').textContent = `${fmt(radius, 1)} mm`; });
  $('lsPlan').addEventListener('click', plan);
  $('lsClear').addEventListener('click', () => { mask = null; changed(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && tool) setTool(tool); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { mask = null; St.setPart('lesionPaint', null, null); status(); } });
  bus.addEventListener('changed', () => { if (!stroke) status(); });

  // ---------- plan storage (run-length encoded) ----------
  function rle(a) { const out = []; let cur = 0, run = 0; for (let i = 0; i < a.length; i++) { if (a[i] === cur) run++; else { out.push(run.toString(36)); cur ^= 1; run = 1; } } out.push(run.toString(36)); return out.join(','); }
  function unrle(s, N) { const a = new Uint8Array(N); let p = 0, cur = 0; String(s).split(',').forEach(t => { const r = parseInt(t, 36) || 0; if (cur) a.fill(1, p, Math.min(N, p + r)); p += r; cur ^= 1; }); return a; }
  (window.PlanExt = window.PlanExt || {}).lesionPaint = {
    label: 'Boyanan lezyon',
    get: () => (count() ? { dims: [S.red.nx, S.red.ny, S.red.nz], m: rle(mask) } : null),
    set(x) {
      mask = x && S.red && Array.isArray(x.dims) && x.dims.join() === [S.red.nx, S.red.ny, S.red.nz].join() && typeof x.m === 'string' ? unrle(x.m, n()) : null;
      build(); status(); if (window.MPR) MPR.redraw();
    },
  };
  status();

  return { active: () => !!tool, tool: () => tool, paint, strokeEnd, points, setTool, plan, off: () => { if (tool) setTool(tool); } };
})();
