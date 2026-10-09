/* Guide fit view: a colour map on the guide surface for the gap to bone (bone-facing side) or the wall thickness,
   and the seating analysis in 3D: the insertion direction as an arrow and the bone that blocks it as red points.
   Works on the voxel grid the guide was built on (S.grid for the mandible guide, S.fib.guide.grid for the fibula
   guide), so the numbers match the guide that is shown. */
'use strict';
window.Fit = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const view = { map: 'none', seat: false };
  let stats = { m: null, f: null }, done = { m: '', f: '' }, timer = null;
  const seatGrp = new THREE.Group(); seatGrp.renderOrder = 6; St.scene.add(seatGrp);

  // trilinear sample of a grid array at local coordinates (mm, guide frame)
  function sampler(grid, A) {
    const { nx, ny, nz, h, lo } = grid, nxy = nx * ny;
    return (x, y, z) => {
      const fx = (x - lo[0]) / h, fy = (y - lo[1]) / h, fz = (z - lo[2]) / h, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
      if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return null;
      const a = fx - i, b = fy - j, c = fz - k, o = i + nx * j + nxy * k;
      const c00 = A[o] * (1 - a) + A[o + 1] * a, c10 = A[o + nx] * (1 - a) + A[o + nx + 1] * a, c01 = A[o + nxy] * (1 - a) + A[o + nxy + 1] * a, c11 = A[o + nxy + nx] * (1 - a) + A[o + nxy + nx + 1] * a;
      return (c00 * (1 - b) + c10 * b) * (1 - c) + (c01 * (1 - b) + c11 * b) * c;
    };
  }
  // colour ramps: gap 0 (red, touching) -> design gap (green) -> 1.5 mm and more (blue, no contact); wall thin (red) -> design (green)
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const RED = [0.84, 0.19, 0.15], YEL = [0.95, 0.75, 0.2], GRN = [0.2, 0.68, 0.4], BLU = [0.25, 0.5, 0.9], NEU = [0.78, 0.8, 0.83];
  function gapColor(g, design) { if (g <= design) return lerp3(RED, GRN, Math.max(0, g) / Math.max(design, 1e-3)); return lerp3(GRN, BLU, Math.min(1, (g - design) / 1.2)); }
  function wallColor(t, min, want) { if (t <= min) return RED; if (t >= want) return GRN; return lerp3(YEL, GRN, (t - min) / Math.max(want - min, 1e-3)); }

  function paint(mesh, grid, g, mode) {
    const geo = mesh.geometry, P = geo.attributes.position.array, n = P.length / 3;
    if (mode === 'none') { if (geo.attributes.color) geo.deleteAttribute('color'); mesh.material.vertexColors = false; mesh.material.needsUpdate = true; return null; }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const N = geo.attributes.normal.array, col = new Float32Array(n * 3);
    if (!grid.D) grid.D = G.edt(grid.B, grid.nx, grid.ny, grid.nz);
    const dB = sampler(grid, grid.D), inG = sampler(grid, grid.Gm), { P: O, u, v, n: w, h } = grid;
    const design = g.clear + (g.peri || 0), minWall = window.Mfg && Mfg.get().prof ? Mfg.get().minWall : 1.5;
    const loc = (x, y, z) => { const dx = x - O.x, dy = y - O.y, dz = z - O.z; return [dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z, dx * w.x + dy * w.y + dz * w.z]; };
    let inner = 0, inBand = 0, tight = 0, thin = 0, minT = Infinity, cnt = 0;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = loc(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      let c = NEU;
      const d = dB(x, y, z);
      if (mode === 'gap') {
        // bone-facing surface: closer to bone than half the wall; distance to the nearest bone voxel centre minus half a voxel
        if (d != null && d * h < design + g.wall / 2 + h) { const gap = Math.max(0, d * h - h / 2); c = gapColor(gap, design); inner++; if (Math.abs(gap - design) <= 0.25) inBand++; if (gap < design - 0.25) tight++; }
      } else {
        // wall: march into the material (the side where the guide field is above one half) until it ends
        const nx = N[3 * i], ny = N[3 * i + 1], nz = N[3 * i + 2], nl = [nx * u.x + ny * u.y + nz * u.z, nx * v.x + ny * v.y + nz * v.z, nx * w.x + ny * w.y + nz * w.z];
        const a = inG(x + nl[0] * 0.3, y + nl[1] * 0.3, z + nl[2] * 0.3), b = inG(x - nl[0] * 0.3, y - nl[1] * 0.3, z - nl[2] * 0.3);
        if (a == null || b == null) { col.set(c, 3 * i); continue; }
        const s = a > b ? 1 : -1; let t = 0.2;
        for (; t < 12; t += 0.2) { const q = inG(x + s * nl[0] * t, y + s * nl[1] * t, z + s * nl[2] * t); if (q == null || q < 0.5) break; }
        c = wallColor(t, minWall, g.wall); cnt++; if (t < minT) minT = t; if (t <= minWall) thin++;
      }
      col.set(c, 3 * i);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mesh.material.vertexColors = true; mesh.material.color.setHex(0xffffff); mesh.material.needsUpdate = true;
    return mode === 'gap' ? { mode, inner, inBand: inner ? inBand / inner : 0, tight: inner ? tight / inner : 0, design } : { mode, minT, thin: cnt ? thin / cnt : 0, minWall };
  }
  // the fibula guide mesh keeps its own colour; restore it when the map is turned off
  function restore(mesh, hex) { if (!mesh.material.vertexColors) mesh.material.color.setHex(hex); }

  // ---------- seating in 3D ----------
  function drawSeat() {
    while (seatGrp.children.length) { const c = seatGrp.children.pop(); c.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    if (!view.seat) { St.render(); return; }
    const add = (grid, seat, layer) => {
      if (!grid || !seat || !seat.ok) return;
      const { P, u, v, n } = grid, W = l => P.clone().addScaledVector(u, l[0]).addScaledVector(v, l[1]).addScaledVector(n, l[2]);
      const d = u.clone().multiplyScalar(seat.best.d[0]).addScaledVector(v, seat.best.d[1]).addScaledVector(n, seat.best.d[2]).normalize();
      const ok = seat.free > 0, start = P.clone().addScaledVector(d, 34);
      const arrow = new THREE.ArrowHelper(d.clone().negate(), start, 24, ok ? 0x1d7a50 : 0xb42318, 6, 3.5);
      arrow.traverse(o => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } o.renderOrder = 10; o.layers.set(layer); });
      seatGrp.add(arrow);
      if (seat.blockPts && seat.blockPts.length) {
        const pos = new Float32Array(seat.blockPts.length * 3); seat.blockPts.forEach((p, i) => pos.set(W(p).toArray(), 3 * i));
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xe0312b, size: 1.6, sizeAttenuation: true, depthTest: false, transparent: true }));
        pts.renderOrder = 9; pts.layers.set(layer); seatGrp.add(pts);
      }
    };
    add(S.grid, S.result && S.result.seat, 0);
    if (S.fib && S.fib.guide) add(S.fib.guide.grid, S.fib.guide.result && S.fib.guide.result.seat, 1);
    St.render();
  }

  // ---------- refresh when a guide is rebuilt ----------
  function refresh() {
    const gm = St.parts.guide && St.parts.guide.obj, fg = S.fib && S.fib.guide;
    const km = gm && S.grid ? gm.uuid + view.map + S.g.clear + (S.g.peri || 0) : '', kf = fg && fg.grid ? fg.mesh.uuid + view.map : '';
    // the coarse live preview has no grid of its own: leave it plain
    if (km !== done.m) { done.m = km; stats.m = gm && S.grid && gm.geometry.attributes.position.count > 0 && S.result && S.grid.Gm ? paint(gm, S.grid, S.g, view.map) : null; if (gm && view.map === 'none') restore(gm, St.COLORS.guide); }
    if (kf !== done.f) { done.f = kf; stats.f = fg && fg.grid ? paint(fg.mesh, fg.grid, fg.ctx.g, view.map) : null; if (fg && view.map === 'none') restore(fg.mesh, St.COLORS.fguide); }
    drawSeat(); renderStats(); legend();
  }
  function legend() {
    let el = $('fitLegend');
    if (!el) { el = document.createElement('div'); el.id = 'fitLegend'; el.className = 'fitlegend'; document.querySelector('.stagewrap').appendChild(el); }
    el.hidden = view.map === 'none';
    const design = S.g.clear + (S.g.peri || 0), minWall = window.Mfg && Mfg.get().prof ? Mfg.get().minWall : 1.5;
    el.innerHTML = view.map === 'gap' ? `<b>Kemiğe aralık</b><i style="background:linear-gradient(90deg,#d6302a,#33ad66 45%,#4080e6)"></i><span><em>0</em><em>${fmt(design, 2)} mm (plan)</em><em>≥ ${fmt(design + 1.2, 1)}</em></span>`
      : view.map === 'wall' ? `<b>Duvar kalınlığı</b><i style="background:linear-gradient(90deg,#d6302a 0 20%,#f2bf33 20%,#33ad66)"></i><span><em>≤ ${fmt(minWall)}</em><em>${fmt(S.g.wall)} mm</em></span>` : '';
  }
  function statTxt(s) {
    if (!s) return '–';
    return s.mode === 'gap' ? `iç yüzeyin %${fmt(s.inBand * 100, 0)}'i plan aralığında, %${fmt(s.tight * 100, 0)}'i daha yakın` : `en ince ${fmt(s.minT)} mm, %${fmt(s.thin * 100, 0)}'i en ince duvarın altında`;
  }
  function renderStats() { const el = $('fitStats'); if (!el) return; el.innerHTML = view.map === 'none' ? '' : `<dt>Mandibula guide'ı</dt><dd>${statTxt(stats.m)}</dd>${stats.f ? `<dt>Fibula guide'ı</dt><dd>${statTxt(stats.f)}</dd>` : ''}`; }
  function render() {
    const box = $('fitBox'); if (!box) return;
    const st = S.result && S.result.seat;
    box.innerHTML = `<h3 class="sub">Oturma ve uyum</h3>
      <div class="ctl"><label for="fitMap" class="lbl2">Guide renk haritası</label><select id="fitMap"><option value="none">Yok</option><option value="gap">Kemiğe aralık</option><option value="wall">Duvar kalınlığı</option></select></div>
      <label class="chk"><input type="checkbox" id="fitSeat" ${view.seat ? 'checked' : ''}> Takma yönünü ve engelleyen kemiği göster</label>
      <dl class="kv" id="fitStats"></dl>
      ${st && st.ok ? `<dl class="kv"><dt>Takma yönü</dt><dd>${st.free ? (st.best.tilt ? fmt(st.best.tilt, 0) + '° eğik' : 'dik') : 'yok'} · ${st.free}/${st.dirs.length} yön uygun</dd>${st.best.block > 0 ? `<dt>Engelleyen kemik</dt><dd>${fmt(st.best.block, 0)} mm²</dd>` : ''}</dl>` : ''}
      <p class="hint">Ok guide'ın takılacağı yönü gösterir (yeşil: takılabilir, kırmızı: takılamaz). Kırmızı noktalar bu yönde guide'ın üstünde kalan kemiktir. Periost payı Guide gövdesi ayarlarındadır ve kemik boşluğuna eklenir.</p>`;
    $('fitMap').value = view.map;
    $('fitMap').addEventListener('change', e => { view.map = e.target.value; St.busy(true, 'Renk haritası hesaplanıyor…'); setTimeout(() => { try { refresh(); } finally { St.busy(false); St.render(); } }, 20); });
    $('fitSeat').addEventListener('change', e => { view.seat = e.target.checked; drawSeat(); });
    renderStats();
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    if (!stats.m && !(S.result && S.result.seat && S.result.seat.ok)) return;
    if (d.keep) d.keep(260); d.h2('Guide oturma ve uyum');
    const rows = [];
    const st = S.result && S.result.seat;
    if (st && st.ok) rows.push(['Takma yönü', `${st.free ? (st.best.tilt ? fmt(st.best.tilt, 0) + '° eğik' : 'dik') : 'takılamıyor'} (${st.free}/${st.dirs.length} yön uygun)`]);
    rows.push(['Kemik boşluğu + periost payı', `${fmt(S.g.clear, 2)} + ${fmt(S.g.peri || 0, 2)} mm`]);
    if (stats.m) rows.push([stats.m.mode === 'gap' ? 'Kemiğe aralık' : 'Duvar kalınlığı', statTxt(stats.m)]);
    d.table(['Ölçü', 'Değer'], rows, [0.4, 0.6]);
  });
  let t2 = null;
  ['parts', 'fibGuide', 'planApplied'].forEach(e => bus.addEventListener(e, () => { clearTimeout(t2); t2 = setTimeout(() => { if (view.map !== 'none' || view.seat) refresh(); render(); }, 60); }));
  render();
  return { view, refresh, stats: () => stats };
})();
