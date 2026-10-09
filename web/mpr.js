/* Axial / coronal / sagittal slice views of the full-resolution CT with the plan drawn on top:
   bone, resected piece, lesion and guide contours (mesh ∩ slice), cut planes with their real slot width,
   screw paths, and a shared crosshair. Cut lines can be dragged on the slice to move the cut. */
'use strict';
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
  const st = { cur: [0, 0, 0], win: WINDOWS.bone, mode: '3d', max: null, cache: new Map(), drag: null };
  const views = {};

  // ---------- geometry helpers (index space of the full-resolution volume) ----------
  const dims = () => [S.vol.nx, S.vol.ny, S.vol.nz];
  const toIdx = w => G.indexOf(S.vol, w);
  const toWorld = ix => G.worldOf(S.vol, ix[0], ix[1], ix[2]);
  function imgSize(v) { const d = dims(), sp = S.vol.sp; return { W: d[v.ix], H: d[v.iy], sx: sp[v.ix], sy: sp[v.iy] }; }
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
  function contour(v, pt, T, ctx) {
    const { P, I } = idxVerts(pt), a = v.axis, s = st.cur[a], n = I ? I.length : P.length / 3;
    const vtx = t => I ? I[t] : t;
    ctx.beginPath();
    const pts = [];
    for (let t = 0; t < n; t += 3) {
      const A = vtx(t) * 3, B = vtx(t + 1) * 3, C = vtx(t + 2) * 3;
      const da = P[A + a] - s, db = P[B + a] - s, dc = P[C + a] - s;
      if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
      pts.length = 0;
      const edge = (X, Y, dx, dy) => { if ((dx > 0) !== (dy > 0)) { const u = dx / (dx - dy); pts.push([P[X + v.ix] + u * (P[Y + v.ix] - P[X + v.ix]), P[X + v.iy] + u * (P[Y + v.iy] - P[X + v.iy])]); } };
      edge(A, B, da, db); edge(B, C, db, dc); edge(C, A, dc, da);
      if (pts.length < 2) continue;
      const H = dims()[v.iy], y0 = v.flipY ? H - 1 - pts[0][1] : pts[0][1], y1 = v.flipY ? H - 1 - pts[1][1] : pts[1][1];
      ctx.moveTo(T.fx(pts[0][0]), T.fy(y0)); ctx.lineTo(T.fx(pts[1][0]), T.fy(y1));
    }
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
        label(ctx, `K${i + 1}`, T.fx(mx) + 4 * dpr, T.fy(my) - 4 * dpr, '#ff8a70', dpr);
        v.lines = v.lines || []; v.lines.push({ i, L });
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
    label(ctx, v.lab[0], 6 * dpr, h / 2, '#8fa39b', dpr); label(ctx, v.lab[1], w - 14 * dpr, h / 2, '#8fa39b', dpr);
    label(ctx, v.lab[2], w / 2, 30 * dpr, '#8fa39b', dpr); label(ctx, v.lab[3], w / 2, h - 8 * dpr, '#8fa39b', dpr);
  }
  // overlays drawn by other modules (measurements, segmentation edits, reference lines)
  const overlayAPI = () => ({ toIdx, idxToImg, label, st, dims, contour, planeLine });
  function label(ctx, t, x, y, col, dpr) { ctx.font = `${12 * dpr}px "IBM Plex Mono", monospace`; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(t, x + dpr, y + dpr); ctx.fillStyle = col; ctx.fillText(t, x, y); }

  let raf = 0;
  function redraw() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (st.mode === '3d') return; VIEWS.forEach(v => { v.lines = []; if (!v.cell.hidden && v.canvas.clientWidth) draw(v); }); }); }

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
      const ix = st.cur.slice(); ix[v.axis] += Math.sign(e.deltaY) * (e.shiftKey ? 5 : 1); setCursor(ix);
    }, { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      if (!S.vol) return; c.setPointerCapture(e.pointerId);
      const [X, Y] = at(e);
      if (e.button === 1 || e.button === 2) { st.drag = { kind: 'pan', v, X, Y, pan: v.pan.slice() }; return; }
      if (window.Measure && Measure.active()) { const T = xf(v); Measure.pick(V(...toWorld(imgToIdx(v, T.ix(X), T.iy(Y)))), null); return; }
      if (window.SegEdit && SegEdit.active()) { const T = xf(v); st.drag = { kind: 'paint', v }; SegEdit.paint(toWorld(imgToIdx(v, T.ix(X), T.iy(Y))), v.axis, true); return; }
      const li = hitLine(v, X, Y);
      if (li >= 0) { st.drag = { kind: 'plane', v, i: li }; St.select('p' + li); c.style.cursor = 'grabbing'; return; }
      st.drag = { kind: 'cursor', v }; moveCursor(v, X, Y);
    });
    c.addEventListener('pointermove', e => {
      const [X, Y] = at(e), d = st.drag;
      if (!d) { c.style.cursor = hitLine(v, X, Y) >= 0 ? 'grab' : 'crosshair'; return; }
      if (d.kind === 'pan') { v.pan[0] = d.pan[0] + X - d.X; v.pan[1] = d.pan[1] + Y - d.Y; redraw(); }
      else if (d.kind === 'cursor') moveCursor(v, X, Y);
      else if (d.kind === 'plane') dragPlane(v, d.i, X, Y);
      else if (d.kind === 'paint') { const T = xf(v); SegEdit.paint(toWorld(imgToIdx(v, T.ix(X), T.iy(Y))), v.axis, false); }
    });
    const end = () => { if (st.drag && st.drag.kind === 'plane') { St.unapprove(S.planes[st.drag.i]); St.schedule(true); } if (st.drag && st.drag.kind === 'paint') SegEdit.strokeEnd(); st.drag = null; c.style.cursor = 'crosshair'; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => { st.max = st.max === v.id ? null : v.id; layout(); });
  }
  function moveCursor(v, X, Y) { const T = xf(v); setCursor(imgToIdx(v, T.ix(X), T.iy(Y))); }
  function dragPlane(v, i, X, Y) {
    const T = xf(v), w = toWorld(imgToIdx(v, T.ix(X), T.iy(Y))), q = V(...w), pw = St.planesWorld()[i], { u } = St.frameAxes();
    const un = u.dot(pw.N); if (Math.abs(un) < 0.2) return;
    const off = Math.round(q.clone().sub(S.anchor.p).dot(pw.N) / un * 2) / 2;
    S.planes[i].off = Math.max(-30, Math.min(30, off)); St.unapprove(S.planes[i]);
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
  VIEWS.forEach(v => { v.cell = $('cell_' + v.id); v.canvas = v.cell.querySelector('canvas'); v.zoom = 1; v.pan = [0, 0]; bind(v); new ResizeObserver(redraw).observe(v.canvas); });
  try { const m = localStorage.getItem('gs.layout'); if (m === 'strip' || m === 'quad') { st.mode = m; requestAnimationFrame(layout); } } catch (e) {}
  $('cell3d').addEventListener('dblclick', e => { if (st.mode !== '3d' && e.target.tagName === 'CANVAS') { st.max = st.max === '3d' ? null : '3d'; layout(); } });
  $('vm3d').addEventListener('click', () => { st.mode = '3d'; st.max = null; layout(); });
  $('vmQuad').addEventListener('click', () => { st.mode = 'quad'; st.max = null; layout(); });
  $('vmStrip').addEventListener('click', () => { st.mode = 'strip'; st.max = null; layout(); });
  $('win').addEventListener('change', e => { st.win = WINDOWS[e.target.value]; redraw(); });
  document.addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.key === 'k' || e.key === 'K') { st.mode = { '3d': 'strip', strip: 'quad', quad: '3d' }[st.mode]; st.max = null; layout(); }
  });

  // ---------- follow the app ----------
  St.bus.addEventListener('volume', () => {
    st.cache.clear(); VIEWS.forEach(v => { v.imgKey = null; v.zoom = 1; v.pan = [0, 0]; });
    const d = dims(); setCursor(S.anchor ? toIdx([S.anchor.p.x, S.anchor.p.y, S.anchor.p.z]) : d.map(x => (x - 1) / 2));
  });
  St.bus.addEventListener('parts', () => { if (S.anchor && !st.placed) { st.placed = true; jumpTo(S.anchor.p); } redraw(); });
  St.bus.addEventListener('preview', redraw);
  St.bus.addEventListener('planApplied', () => { st.cache.clear(); if (S.anchor) jumpTo(S.anchor.p); });
  St.bus.addEventListener('select', e => {
    const sel = e.detail; if (!sel || !S.anchor || st.drag) return;
    if (sel[0] === 'p') { const pw = St.planesWorld()[+sel.slice(1)]; if (pw) jumpTo(pw.p); }
    else { const s = S.screws[+sel.slice(1)]; if (s) { const sw = St.screwWorld(s); if (sw.entry) jumpTo(sw.entry); } }
  });
  window.MPR = { layout, setCursor, jumpTo, state: st, redraw, views: VIEWS, xf };
})();
