/* Axial / coronal / sagittal slice views of the full-resolution CT with the plan drawn on top:
   bone, resected piece, lesion and guide contours (mesh ∩ slice), cut planes with their real slot width,
   screw paths, and a shared crosshair. Cut lines can be dragged on the slice to move the cut (square to itself); the
   selected cut has a round handle on its line that turns it in the slice plane (about the slice's normal axis). */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
(function () {
  const St = window.Studio; if (!St) return;
  const S = St.S, V = St.V, $ = id => document.getElementById(id);
  const VIEWS = [
    { id: 'ax', name: 'Aksiyel', axis: 2, ix: 0, iy: 1, flipY: false, lab: ['R', 'L', 'A', 'P'] },
    { id: 'co', name: 'Koronal', axis: 1, ix: 0, iy: 2, flipY: true, lab: ['R', 'L', 'S', 'I'] },
    { id: 'sa', name: 'Sagittal', axis: 0, ix: 1, iy: 2, flipY: true, lab: ['A', 'P', 'S', 'I'] },
  ];
  const WINDOWS = { bone: { L: 500, W: 2000 }, soft: { L: 40, W: 400 }, wide: { L: 300, W: 3000 } };
  const CONTOURS = [['bone', '#e9d9a6', []], ['resected', '#ff8a4c', []], ['lesion', '#ff5c5c', [4, 3]], ['guide', '#5aa8ff', []]];
  const st = { cur: [0, 0, 0], win: WINDOWS.bone, mode: '3d', max: null, cache: new Map(), drag: null, hover: null };
  const views = {};

  // ---------- geometry helpers (index space of the full-resolution volume) ----------
  const dims = () => [S.vol.nx, S.vol.ny, S.vol.nz];
  const toIdx = w => G.indexOf(S.vol, w);
  const toWorld = ix => G.worldOf(S.vol, ix[0], ix[1], ix[2]);
  // a view can be replaced by a reformat (panoramic, oblique): v.custom = { size(v), draw(v, ctx, T, dpr), wheel(v, n), pick(v, x, y) },
  // and optionally a position for the slice slider: range { min, max }, pos() -> number, setPos(x)
  function imgSize(v) { if (v.custom) return v.custom.size(v); const d = dims(), sp = S.vol.sp; return { W: d[v.ix], H: d[v.iy], sx: sp[v.ix], sy: sp[v.iy] }; }
  function idxToImg(v, ix) { const d = dims(); return [ix[v.ix], v.flipY ? d[v.iy] - 1 - ix[v.iy] : ix[v.iy]]; }
  function imgToIdx(v, x, y) { const d = dims(), ix = st.cur.slice(); ix[v.ix] = x; ix[v.iy] = v.flipY ? d[v.iy] - 1 - y : y; return ix; }
  function xf(v) {   // image pixel -> canvas pixel
    const c = v.canvas, { W, H, sx, sy } = imgSize(v), s = Math.min(c.width / (W * sx), c.height / (H * sy)) * v.zoom;
    const ox = (c.width - W * sx * s) / 2 + v.pan[0], oy = (c.height - H * sy * s) / 2 + v.pan[1];
    return { s, sx, sy, ox, oy, fx: x => ox + x * sx * s, fy: y => oy + y * sy * s, ix: X => (X - ox) / (sx * s), iy: Y => (Y - oy) / (sy * s) };
  }

  // ---------- slice image ----------
  function sliceImage(v) {
    const vol = S.vol, d = dims(), k = Math.round(Math.min(d[v.axis] - 1, Math.max(0, st.cur[v.axis])));
    const key = `${v.id}|${k}|${st.win.L}|${st.win.W}`;
    if (v.imgKey === key) return v.off;
    const { W, H } = imgSize(v);
    if (!v.off || v.off.width !== W || v.off.height !== H) { v.off = document.createElement('canvas'); v.off.width = W; v.off.height = H; }
    const ctx = v.off.getContext('2d'), im = ctx.createImageData(W, H), px = im.data, hu = vol.hu, nx = vol.nx, nxy = vol.nx * vol.ny;
    const lo = st.win.L - st.win.W / 2, sc = 255 / st.win.W;
    const ix = [0, 0, 0]; ix[v.axis] = k;
    for (let y = 0; y < H; y++) {
      ix[v.iy] = v.flipY ? H - 1 - y : y;
      for (let x = 0; x < W; x++) {
        ix[v.ix] = x;
        let g = (hu[ix[0] + nx * ix[1] + nxy * ix[2]] - lo) * sc; g = g < 0 ? 0 : g > 255 ? 255 : g;
        const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = g; px[o + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0); v.imgKey = key;
    return v.off;
  }

  // ---------- mesh vertices in index space, cached per geometry ----------
  function idxVerts(pt) {
    const o = pt.obj, g = o.geometry, key = pt.id;
    const m = new THREE.Matrix4().compose(pt.base, o.quaternion, o.scale), sig = g.uuid + m.elements.join(',');
    const c = st.cache.get(key);
    if (c && c.sig === sig) return c;
    const P = g.attributes.position.array, out = new Float32Array(P.length), q = new THREE.Vector3();
    for (let i = 0; i < P.length; i += 3) { q.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m); const ix = toIdx([q.x, q.y, q.z]); out[i] = ix[0]; out[i + 1] = ix[1]; out[i + 2] = ix[2]; }
    const idx = g.index ? g.index.array : null, r = { sig, P: out, I: idx };
    st.cache.set(key, r); return r;
  }
  // triangles per slice along one axis (built once per mesh and axis): a slice visits only the triangles that reach it
  // instead of the whole mesh (a CT bone model has a million or more), so painting and scrolling stay fluid
  function buckets(r, a) {
    r.bk = r.bk || [];
    if (r.bk[a]) return r.bk[a];
    const { P, I } = r, D = dims()[a], n = I ? I.length : P.length / 3, cnt = new Int32Array(D + 1);
    const vtx = t => I ? I[t] : t, span = t => { const A = P[vtx(t) * 3 + a], B = P[vtx(t + 1) * 3 + a], C = P[vtx(t + 2) * 3 + a]; return [Math.max(0, Math.floor(Math.min(A, B, C))), Math.min(D - 1, Math.floor(Math.max(A, B, C)))]; };
    for (let t = 0; t < n; t += 3) { const [lo, hi] = span(t); for (let k = lo; k <= hi; k++) cnt[k + 1]++; }
    for (let k = 0; k < D; k++) cnt[k + 1] += cnt[k];
    const list = new Int32Array(cnt[D]), fill = cnt.slice(0, D);
    for (let t = 0; t < n; t += 3) { const [lo, hi] = span(t); for (let k = lo; k <= hi; k++) list[fill[k]++] = t; }
    return (r.bk[a] = { start: cnt, list });
  }
  // the contour of a mesh on a slice as line segments in image coordinates; the last slice per axis is kept, so a
  // redraw that does not change the slice (painting, dragging a cut, zoom) only strokes it
  function segments(v, r) {
    const a = v.axis, s = st.cur[a];
    r.segs = r.segs || [];
    const c = r.segs[a]; if (c && c.s === s && c.ix === v.ix && c.flip === v.flipY) return c.xy;
    const { P, I } = r, vtx = t => I ? I[t] : t, H = dims()[v.iy], out = [], pts = [];
    const visit = t => {
      const A = vtx(t) * 3, B = vtx(t + 1) * 3, C = vtx(t + 2) * 3;
      const da = P[A + a] - s, db = P[B + a] - s, dc = P[C + a] - s;
      if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) return;
      pts.length = 0;
      const edge = (X, Y, dx, dy) => { if ((dx > 0) !== (dy > 0)) { const u = dx / (dx - dy); pts.push(P[X + v.ix] + u * (P[Y + v.ix] - P[X + v.ix]), P[X + v.iy] + u * (P[Y + v.iy] - P[X + v.iy])); } };
      edge(A, B, da, db); edge(B, C, db, dc); edge(C, A, dc, da);
      if (pts.length < 4) return;
      out.push(pts[0], v.flipY ? H - 1 - pts[1] : pts[1], pts[2], v.flipY ? H - 1 - pts[3] : pts[3]);
    };
    // (a triangle reaching s is listed under floor(s): its own span runs from floor(min) to floor(max))
    if (s >= 0 && s < dims()[a]) { const b = buckets(r, a), k = Math.floor(s); for (let q = b.start[k]; q < b.start[k + 1]; q++) visit(b.list[q]); }
    else { const n = I ? I.length : P.length / 3; for (let t = 0; t < n; t += 3) visit(t); }
    const xy = new Float32Array(out);
    r.segs[a] = { s, ix: v.ix, flip: v.flipY, xy };
    return xy;
  }
  function contour(v, pt, T, ctx) {
    const xy = segments(v, idxVerts(pt));
    ctx.beginPath();
    for (let q = 0; q < xy.length; q += 4) { ctx.moveTo(T.fx(xy[q]), T.fy(xy[q + 1])); ctx.lineTo(T.fx(xy[q + 2]), T.fy(xy[q + 3])); }
    ctx.stroke();
  }
  // a world-space plane through p with normal N, as a line on this slice (clipped to the image)
  function planeLine(v, p, N) {
    const { W, H } = imgSize(v);
    const f = (x, y) => { const w = toWorld(imgToIdx(v, x, y)); return (w[0] - p.x) * N.x + (w[1] - p.y) * N.y + (w[2] - p.z) * N.z; };
    const f00 = f(0, 0), fx = f(1, 0) - f00, fy = f(0, 1) - f00, out = [];
    if (Math.abs(fx) < 1e-9 && Math.abs(fy) < 1e-9) return null;
    for (const [x0, y0, x1, y1] of [[0, 0, W - 1, 0], [0, H - 1, W - 1, H - 1], [0, 0, 0, H - 1], [W - 1, 0, W - 1, H - 1]]) {
      const a = f00 + fx * x0 + fy * y0, b = f00 + fx * x1 + fy * y1;
      if ((a > 0) !== (b > 0) || a === 0) { const u = a / (a - b); out.push([x0 + u * (x1 - x0), y0 + u * (y1 - y0)]); }
    }
    if (out.length < 2) return null;
    const mmPerUnit = Math.hypot(fx, fy);   // |grad f| in mm of distance per image pixel... used for the slot width
    return { a: out[0], b: out[1], grad: [fx, fy], g: mmPerUnit };
  }

  // ---------- drawing ----------
  function draw(v) {
    const c = v.canvas, ctx = c.getContext('2d');
    const dpr = Math.min(devicePixelRatio, 2), w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (!S.vol) return;
    if (v.custom) { ctx.imageSmoothingEnabled = true; v.custom.draw(v, ctx, xf(v), dpr); wlLabel(ctx, w, h, dpr); return; }
    const T = xf(v), { W, H } = imgSize(v);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sliceImage(v), T.ox, T.oy, W * T.sx * T.s, H * T.sy * T.s);
    ctx.lineWidth = 1.4 * dpr;
    for (const [id, col, dash] of CONTOURS) {
      const pt = St.parts[id]; if (!pt || !pt.visible || !pt.obj.geometry) continue;
      ctx.strokeStyle = col; ctx.setLineDash(dash.map(x => x * dpr)); contour(v, pt, T, ctx);
    }
    ctx.setLineDash([]);
    // cut planes: drawn at their real slot width
    if (S.anchor) {
      St.planesWorld().forEach((pw, i) => {
        const L = planeLine(v, pw.p, pw.N); if (!L) return;
        const sel = S.sel === 'p' + i, px = pw.w * T.s;   // slot width in canvas px (T.s = canvas px per mm)
        ctx.strokeStyle = sel ? 'rgba(255,80,60,.55)' : 'rgba(255,80,60,.35)'; ctx.lineWidth = Math.max(2 * dpr, px);
        ctx.beginPath(); ctx.moveTo(T.fx(L.a[0]), T.fy(L.a[1])); ctx.lineTo(T.fx(L.b[0]), T.fy(L.b[1])); ctx.stroke();
        ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = (sel ? 1.8 : 1.1) * dpr;
        ctx.beginPath(); ctx.moveTo(T.fx(L.a[0]), T.fy(L.a[1])); ctx.lineTo(T.fx(L.b[0]), T.fy(L.b[1])); ctx.stroke();
        const mx = (L.a[0] + L.b[0]) / 2, my = (L.a[1] + L.b[1]) / 2;
        // the cut line's angle in this slice (to the image's horizontal, 0-180°)
        const ang = ((Math.atan2(-(L.b[1] - L.a[1]) * T.sy, (L.b[0] - L.a[0]) * T.sx) * 180 / Math.PI) % 180 + 180) % 180;
        label(ctx, `K${i + 1} · ${St.fmt(ang, 1)}°`, T.fx(mx) + 4 * dpr, T.fy(my) - 4 * dpr, '#ff8a70', dpr);
        v.lines = v.lines || []; v.lines.push({ i, L });
        if (sel) {
          const k = turnKnob(v, pw, L, T, dpr);
          if (k) {
            ctx.fillStyle = '#ff5a3c'; ctx.beginPath(); ctx.arc(k.PX, k.PY, 2.5 * dpr, 0, 2 * Math.PI); ctx.fill();
            ctx.strokeStyle = '#ff5a3c'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = 2 * dpr;
            ctx.beginPath(); ctx.arc(k.X, k.Y, 6 * dpr, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
            v.knob = k;
          }
        }
      });
      // screws: path projected (dashed), solid where it passes through this slice, ring at the crossing
      (S.liveScrews || (S.result ? S.result.screwInfo : [])).forEach((si, i) => {
        if (!si.ok) return;
        const e = toIdx([si.s.entry.x, si.s.entry.y, si.s.entry.z]), tip = si.s.entry.clone().add(si.s.dir.clone().multiplyScalar(si.s.sc.len)), t2 = toIdx([tip.x, tip.y, tip.z]);
        const A = idxToImg(v, e), B = idxToImg(v, t2), a = v.axis, s = st.cur[a];
        ctx.strokeStyle = 'rgba(220,230,235,.55)'; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(T.fx(A[0]), T.fy(A[1])); ctx.lineTo(T.fx(B[0]), T.fy(B[1])); ctx.stroke(); ctx.setLineDash([]);
        const da = e[a] - s, db = t2[a] - s;
        if ((da > 0) !== (db > 0)) {
          const u = da / (da - db), x = A[0] + u * (B[0] - A[0]), y = A[1] + u * (B[1] - A[1]), r = si.s.sc.d / 2 * T.s;
          ctx.strokeStyle = '#f2f5f7'; ctx.lineWidth = 1.6 * dpr; ctx.beginPath(); ctx.arc(T.fx(x), T.fy(y), Math.max(r, 2.5 * dpr), 0, 2 * Math.PI); ctx.stroke();
          label(ctx, `V${i + 1}`, T.fx(x) + 6 * dpr, T.fy(y) + 12 * dpr, '#f2f5f7', dpr);
        } else if (Math.abs(da) < 1.5 / S.vol.sp[a] && Math.abs(db) < 1.5 / S.vol.sp[a]) {
          ctx.strokeStyle = '#f2f5f7'; ctx.lineWidth = Math.max(1.5 * dpr, si.s.sc.d * T.s);
          ctx.beginPath(); ctx.moveTo(T.fx(A[0]), T.fy(A[1])); ctx.lineTo(T.fx(B[0]), T.fy(B[1])); ctx.stroke();
          label(ctx, `V${i + 1}`, T.fx(A[0]) + 6 * dpr, T.fy(A[1]) - 6 * dpr, '#f2f5f7', dpr);
        }
      });
    }
    (window.SliceOverlays || []).forEach(f => { try { f(v, ctx, T, dpr, overlayAPI()); } catch (e) { /* overlay errors never break the slice view */ } });
    // crosshair
    const cp = idxToImg(v, st.cur);
    ctx.strokeStyle = 'rgba(80,220,200,.55)'; ctx.lineWidth = 1 * dpr; ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(T.fx(cp[0]), T.fy(0)); ctx.lineTo(T.fx(cp[0]), T.fy(H)); ctx.moveTo(T.fx(0), T.fy(cp[1])); ctx.lineTo(T.fx(W), T.fy(cp[1])); ctx.stroke(); ctx.setLineDash([]);
    // labels
    const k = Math.round(st.cur[v.axis]), wpos = toWorld(st.cur);
    label(ctx, `${v.name} · ${k + 1}/${dims()[v.axis]} · ${St.fmt(wpos[v.axis === 2 ? 2 : v.axis === 1 ? 1 : 0], 1)} mm`, 8 * dpr, 16 * dpr, '#cfd8d4', dpr);
    label(ctx, v.lab[0], 6 * dpr, h / 2, '#8fa39b', dpr); label(ctx, v.lab[1], w - 40 * dpr, h / 2, '#8fa39b', dpr);   // (clear of the slice slider)
    label(ctx, v.lab[2], w / 2, 30 * dpr, '#8fa39b', dpr); label(ctx, v.lab[3], w / 2, h - 8 * dpr, '#8fa39b', dpr);
    wlLabel(ctx, w, h, dpr);
    brushCursor(v, ctx, T, dpr);
  }
  // the brush tools (bone brush / eraser, lesion brush, marking) show their size at the pointer: a thin circle of the
  // brush radius at this view's zoom, with a small cross in the middle; outline only, so the image under it stays visible
  function brushCursor(v, ctx, T, dpr) {
    const h = st.hover, B = h && h.v === v.id && !v.custom ? brushOf() : null;
    if (!B) { if (v.canvas.style.cursor === 'none') v.canvas.style.cursor = 'crosshair'; return; }   // the tool was ended (Esc) without a move
    const r = B.r * T.s, a = Math.min(4 * dpr, r * 0.5);   // T.s = canvas px per mm
    ctx.setLineDash([]);
    for (const [col, lw] of [['rgba(0,0,0,.55)', 2.5 * dpr], [B.color, 1 * dpr]]) {   // a dark rim under the line keeps it visible on bright bone
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      ctx.arc(h.X, h.Y, r, 0, 2 * Math.PI);
      ctx.moveTo(h.X - a, h.Y); ctx.lineTo(h.X + a, h.Y); ctx.moveTo(h.X, h.Y - a); ctx.lineTo(h.X, h.Y + a);
      ctx.stroke();
    }
  }
  // window / level readout (Shift + drag changes it)
  function wlLabel(ctx, w, h, dpr) { label(ctx, `P ${Math.round(st.win.W)} · S ${Math.round(st.win.L)}`, 8 * dpr, h - 8 * dpr, '#8fa39b', dpr); }
  // overlays drawn by other modules (measurements, segmentation edits, reference lines)
  const overlayAPI = () => ({ toIdx, idxToImg, label, st, dims, contour, planeLine });
  function label(ctx, t, x, y, col, dpr) { t = xl(t); ctx.font = `${12 * dpr}px "IBM Plex Mono", monospace`; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(t, x + dpr, y + dpr); ctx.fillStyle = col; ctx.fillText(t, x, y); }

  let raf = 0;
  function redraw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (st.mode === '3d') return; VIEWS.forEach(v => { v.lines = []; v.knob = null; syncBar(v); if (!v.cell.hidden && v.canvas.clientWidth) draw(v); }); }); }

  // ---------- slice position: one slider per view, kept in step with the wheel, the keys and the shared cursor ----------
  // the position a view's slider shows: the slice index of a standard view, or the offset of a reformat (null: none)
  function barState(v) {
    if (!S.vol) return null;
    if (v.custom) return v.custom.range && v.custom.pos ? { min: v.custom.range.min, max: v.custom.range.max, val: v.custom.pos() } : null;
    const n = dims()[v.axis]; return { min: 0, max: n - 1, val: Math.round(Math.min(n - 1, Math.max(0, st.cur[v.axis]))) };
  }
  function setPos(v, x) {
    const b = barState(v); if (!b) return;
    x = Math.round(Math.min(b.max, Math.max(b.min, x)));
    if (v.custom) { v.custom.setPos(x); redraw(); return; }
    const ix = st.cur.slice(); ix[v.axis] = x; setCursor(ix);
  }
  // one step as the wheel takes it (n slices, or n mm on a reformat)
  function stepSlice(v, n) {
    if (!S.vol) return;
    if (v.custom) { v.custom.wheel(v, n); redraw(); return; }
    const ix = st.cur.slice(); ix[v.axis] += n; setCursor(ix);
  }
  function syncBar(v) {
    const el = v.bar; if (!el) return;
    const b = barState(v); el.hidden = !b; if (!b) return;
    el.min = b.min; el.max = b.max; el.value = b.val;
    const t = v.custom ? `${b.val > 0 ? '+' : ''}${b.val} mm` : `${b.val + 1}/${b.max + 1}`;
    el.setAttribute('aria-valuetext', t); el.title = xl('Kesit') + ' ' + t;
  }
  // keys on a focused slice view (a click focuses it): arrows one slice (Shift: 5), Page Up / Down 10, Home / End the
  // first and the last slice
  function sliceKey(v, e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !S.vol) return false;
    const k = e.key, f = e.shiftKey ? 5 : 1, b = barState(v);
    if (k === 'ArrowUp' || k === 'ArrowRight') stepSlice(v, f);
    else if (k === 'ArrowDown' || k === 'ArrowLeft') stepSlice(v, -f);
    else if (k === 'PageUp') stepSlice(v, 10);
    else if (k === 'PageDown') stepSlice(v, -10);
    else if (k === 'Home' && b) setPos(v, b.min);
    else if (k === 'End' && b) setPos(v, b.max);
    else return false;
    return true;
  }
  function makeBar(v) {
    const el = document.createElement('input'); el.type = 'range'; el.className = 'slicebar'; el.step = 1; el.hidden = true;
    el.setAttribute('aria-label', 'Kesit konumu');
    el.addEventListener('input', () => setPos(v, +el.value));
    el.addEventListener('wheel', e => { if (!S.vol) return; e.preventDefault(); stepSlice(v, Math.sign(e.deltaY) * (e.shiftKey ? 5 : 1)); }, { passive: false });
    // the slider's own keys move one step as well; Home / End and Page keys go through the same path as on the view
    el.addEventListener('keydown', e => { if (/^(PageUp|PageDown|Home|End)$/.test(e.key) && sliceKey(v, e)) e.preventDefault(); });
    v.cell.appendChild(el); v.bar = el;
  }

  // ---------- 3D cursor ----------
  const cursor3d = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x29c5b0 }));
  cursor3d.visible = false; St.scene.add(cursor3d);
  function setCursor(ix, redraw3d = true) {
    const d = dims(); st.cur = ix.map((x, a) => Math.min(d[a] - 1, Math.max(0, x)));
    const w = toWorld(st.cur); cursor3d.position.set(w[0], w[1], w[2]); cursor3d.visible = st.mode !== '3d';
    if (redraw3d) St.render();
    redraw();
  }
  function jumpTo(world) { if (S.vol) setCursor(toIdx([world.x, world.y, world.z])); }

  // ---------- turning a cut on a slice ----------
  // the slice's normal axis in world space (the index axis the view looks along)
  function sliceAxis(v) { const ix = st.cur.slice(), a = V(...toWorld(ix)); ix[v.axis] += 1; return V(...toWorld(ix)).sub(a).normalize(); }
  // the pivot (the point of the cut line on this slice nearest to the cut point) and the round handle 70 px along the
  // line from it, inside the image; null when the line is too short to hold it
  function turnKnob(v, pw, L, T, dpr) {
    const P = idxToImg(v, toIdx([pw.p.x, pw.p.y, pw.p.z])), dx = L.b[0] - L.a[0], dy = L.b[1] - L.a[1], ll = dx * dx + dy * dy;
    if (ll < 1e-9) return null;
    const t = Math.max(0, Math.min(1, ((P[0] - L.a[0]) * dx + (P[1] - L.a[1]) * dy) / ll)), px = L.a[0] + t * dx, py = L.a[1] + t * dy;
    const PX = T.fx(px), PY = T.fy(py), ex = [T.fx(L.a[0]), T.fy(L.a[1])], fx = [T.fx(L.b[0]), T.fy(L.b[1])];
    // towards the longer end of the line
    const end = Math.hypot(fx[0] - PX, fx[1] - PY) >= Math.hypot(ex[0] - PX, ex[1] - PY) ? fx : ex, len = Math.hypot(end[0] - PX, end[1] - PY);
    if (len < 24 * dpr) return null;
    const r = Math.min(70 * dpr, len - 8 * dpr);
    return { i: +S.sel.slice(1), PX, PY, X: PX + (end[0] - PX) / len * r, Y: PY + (end[1] - PY) / len * r, pivot: V(...toWorld(imgToIdx(v, px, py))) };
  }
  function knobAt(v, X, Y) { const k = v.knob, dpr = Math.min(devicePixelRatio, 2); return k && Math.hypot(k.X - X, k.Y - Y) < 9 * dpr ? k : null; }
  function startTurn(v, k) {
    const pw = St.planesWorld()[k.i], o = S.planes[k.i]; if (!pw || !o) return null;
    const A = sliceAxis(v);
    return { kind: 'turn', v, i: k.i, A, c0: k.pivot, st: { o0: Object.assign({}, o), N0: pw.N.clone(), p0: pw.p.clone() }, a0: null, key: '' };
  }
  function dragTurn(d, X, Y) {
    const T = xf(d.v), q = V(...toWorld(imgToIdx(d.v, T.ix(X), T.iy(Y)))), a = q.sub(d.c0); a.addScaledVector(d.A, -a.dot(d.A));
    if (a.lengthSq() < 1e-4) return;
    if (!d.a0) { d.a0 = a.normalize(); return; }
    a.normalize();
    const ang = Math.round(Math.atan2(d.A.dot(V().crossVectors(d.a0, a)), d.a0.dot(a)) * 180 / Math.PI * 2) / 2, o = S.planes[d.i];
    if (!St.turnCut(o, d.st, d.A, d.c0, ang)) return;
    const key = [o.off, o.yaw, o.pitch, o.pv, o.pn].join(); if (key === d.key) return;
    d.key = key; d.moved = true; St.unapprove(o); St.emit('planeDragged', d.i); redraw();
  }

  // ---------- interaction ----------
  function hitLine(v, X, Y) {
    const T = xf(v), dpr = Math.min(devicePixelRatio, 2);
    for (const { i, L } of v.lines || []) {
      const ax = T.fx(L.a[0]), ay = T.fy(L.a[1]), bx = T.fx(L.b[0]), by = T.fy(L.b[1]);
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(ax + t * dx - X, ay + t * dy - Y) < 7 * dpr) return i;
    }
    return -1;
  }
  function bind(v) {
    const c = v.canvas, dpr = () => Math.min(devicePixelRatio, 2);
    const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr()]; };
    c.addEventListener('wheel', e => {
      if (!S.vol) return; e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const [X, Y] = at(e), T = xf(v), x0 = T.ix(X), y0 = T.iy(Y);
        v.zoom = Math.min(20, Math.max(0.5, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        const T2 = xf(v); v.pan[0] += X - T2.fx(x0); v.pan[1] += Y - T2.fy(y0); redraw(); return;
      }
      if (v.custom) { v.custom.wheel(v, Math.sign(e.deltaY) * (e.shiftKey ? 5 : 1)); redraw(); return; }
      const ix = st.cur.slice(); ix[v.axis] += Math.sign(e.deltaY) * (e.shiftKey ? 5 : 1); setCursor(ix);
    }, { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.tabIndex = 0;
    c.addEventListener('keydown', e => { if (sliceKey(v, e)) { e.preventDefault(); e.stopPropagation(); } });
    c.addEventListener('pointerdown', e => {
      if (c.focus) try { c.focus({ preventScroll: true }); } catch (x) {}
      if (!S.vol) return; c.setPointerCapture(e.pointerId);
      const [X, Y] = at(e);
      if (e.button === 1 || e.button === 2) { st.drag = { kind: 'pan', v, X, Y, pan: v.pan.slice() }; return; }
      if (e.shiftKey) { st.drag = { kind: 'wl', v, X, Y, L: st.win.L, W: st.win.W }; return; }
      if (v.custom) { const T = xf(v); st.drag = { kind: 'custom', v }; v.custom.pick(v, T.ix(X), T.iy(Y)); return; }
      if (S.mode === 'anchor' && St.anchorFromSlice) { const T = xf(v); if (St.anchorFromSlice(toWorld(imgToIdx(v, T.ix(X), T.iy(Y))))) return; }
      if (window.Canal && Canal.active()) { const T = xf(v); Canal.pick(toWorld(imgToIdx(v, T.ix(X), T.iy(Y)))); return; }
      if (window.Measure && Measure.active()) { const T = xf(v); Measure.pick(V(...toWorld(imgToIdx(v, T.ix(X), T.iy(Y)))), null); return; }
      const hd = handleAt(v, X, Y); if (hd) { st.drag = { kind: 'handle', v, h: hd }; c.style.cursor = 'grabbing'; return; }
      const P = painter(); if (P) { const T = xf(v); st.drag = { kind: 'paint', v, P }; P.paint(toWorld(imgToIdx(v, T.ix(X), T.iy(Y))), v.axis, true); return; }
      const kn = knobAt(v, X, Y);
      if (kn) { const d = startTurn(v, kn); if (d) { st.drag = d; dragTurn(d, kn.X, kn.Y); c.style.cursor = 'grabbing'; return; } }
      const li = hitLine(v, X, Y);
      if (li >= 0) { st.drag = { kind: 'plane', v, i: li }; St.select('p' + li); c.style.cursor = 'grabbing'; return; }
      st.drag = { kind: 'cursor', v }; moveCursor(v, X, Y);
    });
    c.addEventListener('pointermove', e => {
      const [X, Y] = at(e), d = st.drag;
      const brush = !v.custom && brushOf();
      if (brush || st.hover) { st.hover = brush ? { v: v.id, X, Y } : null; redraw(); }
      if (!d) { c.style.cursor = brush ? 'none' : handleAt(v, X, Y) || knobAt(v, X, Y) || hitLine(v, X, Y) >= 0 ? 'grab' : 'crosshair'; return; }
      if (d.kind === 'turn') { dragTurn(d, X, Y); return; }
      if (d.kind === 'handle') { const T = xf(v); d.h.drag(toWorld(imgToIdx(v, T.ix(X), T.iy(Y)))); redraw(); return; }
      if (d.kind === 'pan') { v.pan[0] = d.pan[0] + X - d.X; v.pan[1] = d.pan[1] + Y - d.Y; redraw(); }
      else if (d.kind === 'cursor') moveCursor(v, X, Y);
      else if (d.kind === 'wl') { const k = 1 / Math.min(devicePixelRatio, 2); st.win = { L: Math.round(d.L - (Y - d.Y) * 2 * k), W: Math.max(10, Math.round(d.W + (X - d.X) * 4 * k)) }; customWin(); redraw(); }
      else if (d.kind === 'custom') { const T = xf(v); v.custom.pick(v, T.ix(X), T.iy(Y)); }
      else if (d.kind === 'plane') dragPlane(v, d.i, X, Y);
      else if (d.kind === 'paint') { const T = xf(v); d.P.paint(toWorld(imgToIdx(v, T.ix(X), T.iy(Y))), v.axis, false); }
    });
    const end = () => { if (st.drag && st.drag.kind === 'handle' && st.drag.h.end) st.drag.h.end(); if (st.drag && st.drag.kind === 'plane') { St.unapprove(S.planes[st.drag.i]); St.schedule(true); if (St.syncGizmo) St.syncGizmo(); } if (st.drag && st.drag.kind === 'turn' && st.drag.moved) { St.schedule(true); if (St.syncGizmo) St.syncGizmo(); } if (st.drag && st.drag.kind === 'paint') st.drag.P.strokeEnd(); st.drag = null; c.style.cursor = brushOf() ? 'none' : 'crosshair'; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (st.hover && st.hover.v === v.id) { st.hover = null; redraw(); } });
    c.addEventListener('dblclick', () => { st.max = st.max === v.id ? null : v.id; layout(); });
  }
  // draggable handles other modules draw on the slices (guide angle): { hit(v, X, Y, T, api) -> bool, drag(world), end() }
  function handleAt(v, X, Y) { if (v.custom || !S.vol) return null; const T = xf(v); return (window.SliceHandles || []).find(h => { try { return h.hit(v, X, Y, T, overlayAPI()); } catch (e) { return false; } }) || null; }
  // slice painting tools: lesion brush, segmentation brush / eraser
  const painter = () => (window.Masks && Masks.tool() ? Masks : window.Lesion && Lesion.active() ? Lesion : window.SegEdit && SegEdit.active() ? SegEdit : null);
  // the active brush's radius (mm) and colour, or null (no brush tool, or one that only clicks)
  const brushOf = () => { const P = painter(); return P && P.brush ? P.brush() : null; };
  function moveCursor(v, X, Y) { const T = xf(v); setCursor(imgToIdx(v, T.ix(X), T.iy(Y))); }
  // the cut moves square to itself until it passes through the pointer (its point on the bone moves along its normal;
  // the same range as the slider, the 3D handles and a stored plan: moveCutTo refuses a cut past CUT_OFF_MAX)
  function dragPlane(v, i, X, Y) {
    const T = xf(v), q = V(...toWorld(imgToIdx(v, T.ix(X), T.iy(Y)))), pw = St.planesWorld()[i], { u } = St.frameAxes();
    if (Math.abs(u.dot(pw.N)) < 0.2) return;
    const c = pw.p.clone().addScaledVector(pw.N, q.sub(pw.p).dot(pw.N));
    if (!St.moveCutTo(S.planes[i], c, pw.N)) return;
    St.unapprove(S.planes[i]);
    St.emit('planeDragged', i); redraw();
  }

  // ---------- layout: 3D only, or 3D + three slices (double-click a view to enlarge it) ----------
  function layout() {
    const box = $('views'); box.dataset.mode = st.mode; box.dataset.max = st.max || '';
    $('vm3d').setAttribute('aria-pressed', st.mode === '3d'); $('vmQuad').setAttribute('aria-pressed', st.mode === 'quad'); $('vmStrip').setAttribute('aria-pressed', st.mode === 'strip');
    try { localStorage.setItem('gs.layout', st.mode); } catch (e) {}
    $('winBox').hidden = st.mode === '3d';
    cursor3d.visible = st.mode !== '3d' && !!S.vol;
    VIEWS.forEach(v => { v.cell.hidden = st.mode === '3d' || (st.max && st.max !== v.id); });
    $('cell3d').hidden = st.mode !== '3d' && st.max && st.max !== '3d';
    requestAnimationFrame(() => { VIEWS.forEach(v => { v.imgKey = null; }); redraw(); St.render(); });
  }
  VIEWS.forEach(v => { v.cell = $('cell_' + v.id); v.canvas = v.cell.querySelector('canvas'); v.zoom = 1; v.pan = [0, 0]; bind(v); makeBar(v); new ResizeObserver(redraw).observe(v.canvas); });
  try { const m = localStorage.getItem('gs.layout'); if (m === 'strip' || m === 'quad') { st.mode = m; requestAnimationFrame(layout); } } catch (e) {}
  $('cell3d').addEventListener('dblclick', e => { if (st.mode !== '3d' && e.target.tagName === 'CANVAS') { st.max = st.max === '3d' ? null : '3d'; layout(); } });
  $('vm3d').addEventListener('click', () => { st.mode = '3d'; st.max = null; layout(); });
  $('vmQuad').addEventListener('click', () => { st.mode = 'quad'; st.max = null; layout(); });
  $('vmStrip').addEventListener('click', () => { st.mode = 'strip'; st.max = null; layout(); });
  $('win').addEventListener('change', e => { if (WINDOWS[e.target.value]) st.win = WINDOWS[e.target.value]; redraw(); });
  // a dragged window shows as "custom" in the preset list
  function customWin() {
    const sel = $('win'); let o = sel.querySelector('option[value="custom"]');
    if (!o) { o = document.createElement('option'); o.value = 'custom'; sel.appendChild(o); }
    o.textContent = xl(`Özel (P ${Math.round(st.win.W)} / S ${Math.round(st.win.L)})`); sel.value = 'custom';
  }
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.key === 'k' || e.key === 'K') { st.mode = { '3d': 'strip', strip: 'quad', quad: '3d' }[st.mode]; st.max = null; layout(); }
  });

  // ---------- follow the app ----------
  St.bus.addEventListener('volume', () => {
    st.cache.clear(); VIEWS.forEach(v => { v.imgKey = null; v.zoom = 1; v.pan = [0, 0]; });
    // a new case opens the slices on the bone model (the mandible), not the middle of the scan (the skull base on a
    // head CT)
    const d = dims(), b = St.parts.bone && new THREE.Box3().setFromObject(St.parts.bone.obj), c = b && !b.isEmpty() && b.getCenter(new THREE.Vector3());
    setCursor(S.anchor ? toIdx([S.anchor.p.x, S.anchor.p.y, S.anchor.p.z]) : c ? toIdx([c.x, c.y, c.z]) : d.map(x => (x - 1) / 2));
  });
  St.bus.addEventListener('parts', () => { if (S.anchor && !st.placed) { st.placed = true; jumpTo(S.anchor.p); } redraw(); });
  St.bus.addEventListener('preview', redraw);
  St.bus.addEventListener('planApplied', () => { st.cache.clear(); if (S.anchor) jumpTo(S.anchor.p); });
  St.bus.addEventListener('select', e => {
    const sel = e.detail; if (!sel || !S.anchor || st.drag) return;
    if (sel[0] === 'p') { const pw = St.planesWorld()[+sel.slice(1)]; if (pw) jumpTo(pw.p); }
    else { const s = S.screws[+sel.slice(1)]; if (s) { const sw = St.screwWorld(s); if (sw.entry) jumpTo(sw.entry); } }
  });
  // one slice through world point w, drawn off screen with the plan overlays, zoomed around w (report images)
  function capture(id, w, o = {}) {
    const v = VIEWS.find(x => x.id === id); if (!v || !S.vol) return null;
    const W = o.w || 640, H = o.h || 640, keep = { canvas: v.canvas, zoom: v.zoom, pan: v.pan, lines: v.lines, custom: v.custom, cur: st.cur.slice() };
    const c = document.createElement('canvas'); c.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px`; document.body.appendChild(c);
    try {
      const dpr = Math.min(devicePixelRatio, 2); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      v.canvas = c; v.custom = null; v.lines = []; v.zoom = o.zoom || 3; v.pan = [0, 0];
      const ix = toIdx([w.x, w.y, w.z]); st.cur = ix.map((x, k) => Math.max(0, Math.min(dims()[k] - 1, Math.round(x))));
      const T = xf(v), [px, py] = idxToImg(v, ix); v.pan = [c.width / 2 - T.fx(px), c.height / 2 - T.fy(py)];
      draw(v); return c.toDataURL('image/jpeg', 0.9);
    } catch (e) { return null; } finally { Object.assign(v, { canvas: keep.canvas, zoom: keep.zoom, pan: keep.pan, lines: keep.lines, custom: keep.custom }); st.cur = keep.cur; c.remove(); }
  }
  window.MPR = { layout, setCursor, jumpTo, state: st, redraw, views: VIEWS, xf, label, toIdx, toWorld, capture, setPos, stepSlice, sliceAxis, turnKnob, startTurn, dragTurn, dragPlane, imgToIdx, idxToImg };
})();
