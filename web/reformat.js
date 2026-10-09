/* Reformatted slice views that can replace any of the three slice cells:
   - Panoramic: the CT resampled on a curved surface along the mandibular arch (the arch is fitted to the bone mask
     in the axial plane), averaged over a 6 mm slab like a panoramic radiograph; the wheel moves the surface
     buccally or lingually. Cut planes are drawn where they cross the surface.
   - Oblique: a slice perpendicular to the selected cut plane (horizontal axis = cut normal, vertical = superior
     within the cut), so the cut is a vertical line with its real slot width; the wheel moves the slice sideways.
   Clicking either view moves the shared 3D cursor, so the standard slices follow. */
'use strict';
window.Reformat = (function () {
  const St = window.Studio; if (!St || !window.MPR) return null;
  const { S, V } = St, $ = id => document.getElementById(id);
  const PX = 0.5, SLAB = 6;
  let arch = null, archKey = '';

  // trilinear CT value at a world point (full-resolution volume)
  function huAt(w) {
    const vol = S.vol, ix = G.indexOf(vol, w), i = Math.floor(ix[0]), j = Math.floor(ix[1]), k = Math.floor(ix[2]);
    if (i < 0 || j < 0 || k < 0 || i >= vol.nx - 1 || j >= vol.ny - 1 || k >= vol.nz - 1) return -1000;
    const a = ix[0] - i, b = ix[1] - j, c = ix[2] - k, nx = vol.nx, nxy = vol.nx * vol.ny, o = i + nx * j + nxy * k, H = vol.hu;
    const c00 = H[o] * (1 - a) + H[o + 1] * a, c10 = H[o + nx] * (1 - a) + H[o + nx + 1] * a, c01 = H[o + nxy] * (1 - a) + H[o + nxy + 1] * a, c11 = H[o + nxy + nx] * (1 - a) + H[o + nxy + nx + 1] * a;
    return (c00 * (1 - b) + c10 * b) * (1 - c) + (c01 * (1 - b) + c11 * b) * c;
  }
  function paint(img, W, H, f) {
    const cv = img.cv && img.cv.width === W && img.cv.height === H ? img.cv : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const g = cv.getContext('2d'), im = g.createImageData(W, H), px = im.data, win = MPR.state.win, lo = win.L - win.W / 2, sc = 255 / win.W;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = (f(x, y) - lo) * sc; v = v < 0 ? 0 : v > 255 ? 255 : v; const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255; }
    g.putImageData(im, 0, 0); img.cv = cv; return cv;
  }
  // where a plane (p, N) crosses the image: zero crossings of the signed distance, row by row
  function crossings(W, H, world, p, N) {
    const pts = [];
    for (let y = 0; y < H; y += 2) {
      let prev = null;
      for (let x = 0; x < W; x++) {
        const q = world(x, y); if (!q) { prev = null; continue; }
        const f = (q.x - p.x) * N.x + (q.y - p.y) * N.y + (q.z - p.z) * N.z;
        if (prev !== null && (prev > 0) !== (f > 0)) pts.push([x - f / (f - prev), y]);
        prev = f;
      }
    }
    return pts;
  }

  // ---------- panoramic ----------
  // arch: bone voxels projected on the axial plane, median radius per 2° from a centre between the rami
  function fitArch() {
    const r = S.red, m = S.mask, P = [];
    let zmin = Infinity, zmax = -Infinity;
    for (let v = 0; v < m.length; v += 2) { if (!m[v]) continue; const w = G.worldOf(r, v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0); P.push(w); if (w[2] < zmin) zmin = w[2]; if (w[2] > zmax) zmax = w[2]; }
    if (P.length < 100) return null;
    const cx = P.reduce((s, p) => s + p[0], 0) / P.length, ys = P.map(p => p[1]).sort((a, b) => a - b), cy = ys[Math.floor(ys.length * 0.97)];
    // LPS: anterior is -y; angle 0 points anterior, positive towards patient left (+x)
    const bins = new Map();
    P.forEach(p => { const dx = p[0] - cx, dy = cy - p[1], a = Math.round(Math.atan2(dx, dy) * 180 / Math.PI / 2) * 2; if (Math.abs(a) > 100) return; if (!bins.has(a)) bins.set(a, []); bins.get(a).push(Math.hypot(dx, dy)); });
    let pts = [...bins.keys()].sort((a, b) => a - b).filter(a => bins.get(a).length > 8).map(a => { const L = bins.get(a).sort((x, y) => x - y), rr = L[L.length >> 1], t = a * Math.PI / 180; return [cx + rr * Math.sin(t), cy - rr * Math.cos(t)]; });
    if (pts.length < 10) return null;
    for (let it = 0; it < 3; it++) pts = pts.map((p, i) => i && i < pts.length - 1 ? [(pts[i - 1][0] + 2 * p[0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * p[1] + pts[i + 1][1]) / 4] : p);
    // resample every PX mm, with the outward normal in the axial plane
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1], out = [];
    for (let s = 0, j = 0; s <= L; s += PX) {
      while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1), x = pts[j][0] + f * (pts[j + 1][0] - pts[j][0]), y = pts[j][1] + f * (pts[j + 1][1] - pts[j][1]);
      const tx = pts[j + 1][0] - pts[j][0], ty = pts[j + 1][1] - pts[j][1], tl = Math.hypot(tx, ty) || 1;
      let nx = ty / tl, ny = -tx / tl; if ((x - cx) * nx + (y - cy) * ny < 0) { nx = -nx; ny = -ny; }   // outward = buccal
      out.push({ x, y, nx, ny });
    }
    return { pts: out, L, z0: zmin - 4, z1: zmax + 4 };
  }
  const pano = {
    name: 'Panoramik', depth: 0, img: {},
    ensure() { const k = S.mask ? S.mask.length + ':' + St.parts.bone?.obj.geometry.uuid : ''; if (k !== archKey) { archKey = k; arch = S.mask ? fitArch() : null; pano.img = {}; } return arch; },
    size() { const a = pano.ensure(); return a ? { W: a.pts.length, H: Math.ceil((a.z1 - a.z0) / PX), sx: PX, sy: PX } : { W: 10, H: 10, sx: 1, sy: 1 }; },
    world(x, y, dd = 0) { const a = arch, c = a && a.pts[Math.round(x)]; if (!c) return null; const z = a.z1 - y * PX, d = pano.depth + dd; return V(c.x + c.nx * d, c.y + c.ny * d, z); },
    draw(v, ctx, T, dpr) {
      const a = pano.ensure(); if (!a) { MPR.label(ctx, 'Panoramik: kemik bulunamadı', 8 * dpr, 16 * dpr, '#cfd8d4', dpr); return; }
      const { W, H } = pano.size(), win = MPR.state.win, key = `${archKey}|${pano.depth}|${win.L}|${win.W}`;
      if (pano.img.key !== key) {
        const n = 7, w = q => [q.x, q.y, q.z];
        paint(pano.img, W, H, (x, y) => { let s = 0; for (let k = 0; k < n; k++) { const q = pano.world(x, y, (k / (n - 1) - 0.5) * SLAB); s += huAt(w(q)); } return s / n; });
        pano.img.key = key;
      }
      ctx.drawImage(pano.img.cv, T.ox, T.oy, W * T.sx * T.s, H * T.sy * T.s);
      if (S.anchor) St.planesWorld().forEach((pw, i) => line(ctx, T, dpr, crossings(W, H, (x, y) => pano.world(x, y), pw.p, pw.N), `K${i + 1}`, S.sel === 'p' + i));
      cursorMark(ctx, T, dpr, (x, y) => pano.world(x, y), W, H);
      MPR.label(ctx, `Panoramik · ${pano.depth > 0 ? '+' : ''}${pano.depth} mm ${pano.depth >= 0 ? 'bukkal' : 'lingual'}`, 8 * dpr, 16 * dpr, '#cfd8d4', dpr);
      MPR.label(ctx, `yay ${Math.round(a.L)} mm · kalınlık ${SLAB} mm`, 8 * dpr, 32 * dpr, '#8fa39b', dpr);
      MPR.label(ctx, 'Sağ', 6 * dpr, ctx.canvas.height / 2, '#8fa39b', dpr); MPR.label(ctx, 'Sol', ctx.canvas.width - 28 * dpr, ctx.canvas.height / 2, '#8fa39b', dpr);
    },
    wheel(v, n) { pano.depth = Math.max(-15, Math.min(15, pano.depth + n)); },
    pick(v, x, y) { const q = pano.world(x, y); if (q) MPR.setCursor(MPR.toIdx([q.x, q.y, q.z])); },
  };

  // ---------- oblique: perpendicular to the selected cut ----------
  const OB = 70;   // field of view (mm)
  const obl = {
    name: 'Kesiye dik', off: 0, img: {},
    frame() {
      if (!S.anchor || !S.planes.length) return null;
      const i = S.sel && S.sel[0] === 'p' && S.planes[+S.sel.slice(1)] ? +S.sel.slice(1) : 0, pw = St.planesWorld()[i];
      let up = V(0, 0, 1).sub(pw.N.clone().multiplyScalar(pw.N.z)); if (up.lengthSq() < 0.05) up = S.anchor.n.clone().sub(pw.N.clone().multiplyScalar(S.anchor.n.dot(pw.N)));
      up.normalize(); const side = V().crossVectors(pw.N, up);
      // centre the slice in the bone under the cut: the guide anchor sits on the bone surface, so walk inwards
      // along the seating normal and take the middle of the bone met there
      const n = S.anchor.n, top = pw.p.clone().addScaledVector(n, 5); let a = null, b = null;
      for (let t = 0; t < 45; t += 0.4) { const q = top.clone().addScaledVector(n, -t); if (St.boneAt(q)) { if (a === null) a = t; b = t; } }
      const mid = a === null ? pw.p.clone() : top.clone().addScaledVector(n, -(a + b) / 2);
      mid.sub(pw.N.clone().multiplyScalar(mid.clone().sub(pw.p).dot(pw.N)));
      return { i, pw, e1: pw.N.clone(), e2: up, e3: side, c: mid.addScaledVector(side, obl.off) };
    },
    size() { return { W: Math.round(OB / 0.35), H: Math.round(OB / 0.35), sx: 0.35, sy: 0.35 }; },
    world(F, x, y) { const h = 0.35; return F.c.clone().addScaledVector(F.e1, (x - OB / 0.7) * h).addScaledVector(F.e2, (OB / 0.7 - y) * h); },
    draw(v, ctx, T, dpr) {
      const F = obl.frame(); if (!F) { MPR.label(ctx, 'Kesiye dik: önce kesi ekleyin', 8 * dpr, 16 * dpr, '#cfd8d4', dpr); return; }
      const { W, H } = obl.size(), win = MPR.state.win, key = JSON.stringify([F.c, F.e1, F.e2, win.L, win.W, S.vol.nx]);
      if (obl.img.key !== key) { paint(obl.img, W, H, (x, y) => { const q = obl.world(F, x, y); return huAt([q.x, q.y, q.z]); }); obl.img.key = key; }
      ctx.drawImage(obl.img.cv, T.ox, T.oy, W * T.sx * T.s, H * T.sy * T.s);
      St.planesWorld().forEach((pw, i) => {
        const pts = crossings(W, H, (x, y) => obl.world(F, x, y), pw.p, pw.N);
        if (i === F.i && pts.length) { const xs = pts[0][0]; ctx.fillStyle = 'rgba(255,80,60,.3)'; ctx.fillRect(T.fx(xs - pw.w / 2 / 0.35), T.fy(0), pw.w * T.s, H * T.sy * T.s); }
        line(ctx, T, dpr, pts, `K${i + 1}`, i === F.i);
      });
      cursorMark(ctx, T, dpr, (x, y) => obl.world(F, x, y), W, H);
      MPR.label(ctx, `Kesi ${F.i + 1}'e dik · yanal ${obl.off > 0 ? '+' : ''}${obl.off} mm`, 8 * dpr, 16 * dpr, '#cfd8d4', dpr);
      MPR.label(ctx, 'Üst', ctx.canvas.width / 2, 30 * dpr, '#8fa39b', dpr);
    },
    wheel(v, n) { obl.off = Math.max(-30, Math.min(30, obl.off + n)); },
    pick(v, x, y) { const F = obl.frame(); if (!F) return; const q = obl.world(F, x, y); MPR.setCursor(MPR.toIdx([q.x, q.y, q.z])); },
  };

  function line(ctx, T, dpr, pts, lab, sel) {
    if (pts.length < 2) return;
    ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = (sel ? 1.8 : 1.1) * dpr; ctx.beginPath();
    pts.forEach(([x, y], k) => { const X = T.fx(x), Y = T.fy(y); if (k && Math.abs(y - pts[k - 1][1]) > 4) ctx.moveTo(X, Y); else if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.stroke(); const m = pts[pts.length >> 1]; MPR.label(ctx, lab, T.fx(m[0]) + 4 * dpr, T.fy(m[1]), '#ff8a70', dpr);
  }
  // the shared 3D cursor, when it lies within 1.5 mm of this surface
  function cursorMark(ctx, T, dpr, world, W, H) {
    const c = V(...MPR.toWorld(MPR.state.cur)); let best = null, bd = 1.5;
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) { const q = world(x, y); if (!q) continue; const d = q.distanceTo(c); if (d < bd) { bd = d; best = [x, y]; } }
    if (!best) return;
    ctx.strokeStyle = 'rgba(80,220,200,.9)'; ctx.lineWidth = 1.2 * dpr; ctx.beginPath(); ctx.arc(T.fx(best[0]), T.fy(best[1]), 6 * dpr, 0, 2 * Math.PI); ctx.stroke();
  }

  // ---------- a mode menu on each slice cell ----------
  const MODES = { std: null, pano, obl };
  MPR.views.forEach(v => {
    const sel = document.createElement('select'); sel.className = 'cellmode'; sel.setAttribute('aria-label', 'Kesit türü');
    sel.innerHTML = `<option value="std">${v.name}</option><option value="pano">Panoramik</option><option value="obl">Kesiye dik</option>`;
    v.cell.appendChild(sel);
    sel.addEventListener('change', () => { v.custom = MODES[sel.value]; v.zoom = 1; v.pan = [0, 0]; v.imgKey = null; try { localStorage.setItem('gs.cell.' + v.id, sel.value); } catch (e) {} MPR.redraw(); });
    try { const m = localStorage.getItem('gs.cell.' + v.id); if (m && MODES[m]) { sel.value = m; v.custom = MODES[m]; } } catch (e) {}
  });
  // the panoramic image is keyed on the bone mesh and window; the oblique one follows every plan change
  const dirty = () => { obl.img = {}; MPR.redraw(); };
  ['parts', 'select', 'planApplied'].forEach(e => St.bus.addEventListener(e, dirty));
  St.bus.addEventListener('volume', () => { archKey = ''; pano.img = {}; pano.depth = 0; obl.off = 0; dirty(); });
  St.bus.addEventListener('preview', () => { obl.img = {}; MPR.redraw(); });
  return { pano, obl, arch: () => pano.ensure() };
})();
