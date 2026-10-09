/* Anatomical reference: the midsagittal plane (found automatically as the plane that best maps the bone onto its own
   mirror image), a mirrored ghost of the healthy side over the defect side as the reconstruction target, and the
   condyles (found automatically, re-pickable by clicking) with their distances and asymmetry. */
'use strict';
window.Ref = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const MIRROR = 0x8e9aa6;
  // ref = { n:[x,y,z], d, score, cond:{R:[..], L:[..]}, manual:{R,L} }, view = what is shown
  let ref = null, picking = null, built = null;
  const view = { mirror: true, plane: false, defectOnly: true };

  // ---------- bone surface sample on the working grid ----------
  function surfacePoints(max = 6000) {
    const r = S.red, m = S.mask, nx = r.nx, nxy = r.nx * r.ny, out = [];
    let all = 0;
    for (let v = 0; v < m.length; v++) {
      if (!m[v]) continue;
      const i = v % nx, j = ((v / nx) | 0) % r.ny, k = (v / nxy) | 0;
      if (i && j && k && i < nx - 1 && j < r.ny - 1 && k < r.nz - 1 && m[v - 1] && m[v + 1] && m[v - nx] && m[v + nx] && m[v - nxy] && m[v + nxy]) continue;
      all++; out.push(v);
    }
    const step = Math.max(1, Math.floor(out.length / max)), P = [];
    for (let t = 0; t < out.length; t += step) { const v = out[t]; P.push(G.worldOf(r, v % nx, ((v / nx) | 0) % r.ny, (v / nxy) | 0)); }
    return P;
  }
  // fraction of mirrored points that land in bone
  function scorer(P) {
    const r = S.red, m = S.mask, a = r.axes, sp = r.sp, o = r.origin;
    return (n, d) => {
      let hit = 0;
      for (const p of P) {
        const s = 2 * (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d), q0 = p[0] - s * n[0] - o[0], q1 = p[1] - s * n[1] - o[1], q2 = p[2] - s * n[2] - o[2];
        const i = Math.round((q0 * a[0][0] + q1 * a[0][1] + q2 * a[0][2]) / sp[0]), j = Math.round((q0 * a[1][0] + q1 * a[1][1] + q2 * a[1][2]) / sp[1]), k = Math.round((q0 * a[2][0] + q1 * a[2][1] + q2 * a[2][2]) / sp[2]);
        if (i >= 0 && j >= 0 && k >= 0 && i < r.nx && j < r.ny && k < r.nz && m[i + r.nx * (j + r.ny * k)]) hit++;
      }
      return hit / P.length;
    };
  }
  const nOf = (yaw, roll) => { const a = yaw * Math.PI / 180, b = roll * Math.PI / 180; return [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)]; };
  // coarse-to-fine search around the patient's left-right axis (LPS x) through the centroid
  function findPlane() {
    const P = surfacePoints(), f = scorer(P);
    const c = P.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map(x => x / P.length);
    let best = { yaw: 0, roll: 0, off: 0, s: -1 };
    const search = (yr, ys, or, os, around) => {
      for (let yaw = around.yaw - yr; yaw <= around.yaw + yr + 1e-6; yaw += ys) for (let roll = around.roll - yr; roll <= around.roll + yr + 1e-6; roll += ys) {
        const n = nOf(yaw, roll), d0 = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
        for (let off = around.off - or; off <= around.off + or + 1e-6; off += os) { const s = f(n, d0 + off); if (s > best.s) best = { yaw, roll, off, s }; }
      }
    };
    search(12, 3, 12, 2, best); search(3, 1, 2, 0.5, Object.assign({}, best)); search(1, 0.25, 0.5, 0.25, Object.assign({}, best));
    const n = nOf(best.yaw, best.roll);
    return { n, d: n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + best.off, score: best.s, yaw: best.yaw, roll: best.roll };
  }
  // condyle = the most posterior of the highest bone points on each side, away from the midline
  function findCondyles(pl) {
    const r = S.red, m = S.mask, nx = r.nx, nxy = r.nx * r.ny, side = { R: [], L: [] };
    for (let v = 0; v < m.length; v++) {
      if (!m[v]) continue;
      const p = G.worldOf(r, v % nx, ((v / nx) | 0) % r.ny, (v / nxy) | 0), s = p[0] * pl.n[0] + p[1] * pl.n[1] + p[2] * pl.n[2] - pl.d;
      if (Math.abs(s) > 20) side[s < 0 ? 'R' : 'L'].push(p);   // LPS: +x is patient left
    }
    const out = {};
    for (const k of ['R', 'L']) {
      const A = side[k]; if (!A.length) continue;
      let zmax = -Infinity; A.forEach(p => { if (p[2] > zmax) zmax = p[2]; });
      const top = A.filter(p => p[2] > zmax - 8);
      let post = top[0]; top.forEach(p => { if (p[1] > post[1]) post = p; });
      const near = top.filter(p => (p[0] - post[0]) ** 2 + (p[1] - post[1]) ** 2 + (p[2] - post[2]) ** 2 < 36);
      out[k] = near.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map(x => Math.round(x / near.length * 100) / 100);
    }
    return out;
  }
  async function compute(keepManual) {
    if (!S.mask || !S.red) return;
    St.busy(true, 'Orta sagittal düzlem ve kondiller bulunuyor…'); await St.sleep();
    try {
      const pl = findPlane(), cond = findCondyles(pl), man = keepManual && ref && ref.manual || {};
      ref = { n: pl.n.map(x => +x.toFixed(5)), d: +pl.d.toFixed(2), score: +pl.score.toFixed(3), cond: Object.assign(cond, man), manual: man };
    } finally { St.busy(false); }
    update(); St.emit('changed');
  }

  // ---------- 3D: mirrored ghost, plane, condyle markers ----------
  const grp = new THREE.Group(); grp.renderOrder = 5; St.scene.add(grp);
  const reflect = () => { const [a, b, c] = ref.n, d = ref.d; return new THREE.Matrix4().set(1 - 2 * a * a, -2 * a * b, -2 * a * c, 2 * d * a, -2 * a * b, 1 - 2 * b * b, -2 * b * c, 2 * d * b, -2 * a * c, -2 * b * c, 1 - 2 * c * c, 2 * d * c, 0, 0, 0, 1); };
  function defectSide() {
    if (!S.anchor) return 0;
    const { u } = St.frameAxes(), c = S.anchor.p.clone().addScaledVector(u, (S.lesion.from + S.lesion.to) / 2);
    return Math.sign(c.x * ref.n[0] + c.y * ref.n[1] + c.z * ref.n[2] - ref.d) || 1;
  }
  function buildMirror() {
    const bone = St.parts.bone; if (!ref || !bone || !view.mirror) { St.setPart('mirror', null, null); built = null; return; }
    const key = bone.obj.geometry.uuid + JSON.stringify([ref.n, ref.d, view.defectOnly, defectSide()]);
    if (built === key && St.parts.mirror) return;
    const g = bone.obj.geometry.clone(); g.userData = {}; g.applyMatrix4(reflect()); g.computeVertexNormals();
    const side = defectSide(), clip = view.defectOnly && side ? [new THREE.Plane(V(...ref.n).multiplyScalar(side), -ref.d * side)] : [];
    const m = St.mat(MIRROR, { transparent: true, opacity: 0.38, depthWrite: false, clippingPlanes: clip });
    St.setPart('mirror', 'Ayna görüntüsü (sağlam taraf)', new THREE.Mesh(g, m), MIRROR); built = key;
    St.emit('parts');
  }
  function draw() {
    while (grp.children.length) { const c = grp.children.pop(); c.geometry.dispose(); c.material.dispose(); }
    if (!ref) return;
    if (view.plane && St.parts.bone) {
      const b = new THREE.Box3().setFromObject(St.parts.bone.obj), s = b.getSize(V()).length() * 0.7, c = b.getCenter(V()), n = V(...ref.n);
      const q = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color: 0x8e6fd6, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      q.position.copy(c.addScaledVector(n, ref.d - c.dot(n))); q.quaternion.setFromUnitVectors(V(0, 0, 1), n); grp.add(q);
    }
    for (const k of ['R', 'L']) {
      const p = ref.cond[k]; if (!p) continue;
      const s = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0x8e6fd6, depthTest: false, transparent: true }));
      s.position.set(...p); s.renderOrder = 9; grp.add(s);
    }
  }
  // condyle labels follow the camera
  const labels = document.createElement('div'); labels.className = 'markers'; document.querySelector('.stagewrap').appendChild(labels);
  const pv = V();
  function place() {
    const cam = St.camera, rect = St.renderer.domElement.getBoundingClientRect(), host = labels.getBoundingClientRect(), w = S.split ? rect.width / 2 : rect.width;
    const vis = !cam.layers.isEnabled(1) || S.split;
    labels.innerHTML = !ref || !vis ? '' : ['R', 'L'].filter(k => ref.cond[k]).map(k => {
      pv.set(...ref.cond[k]).project(cam); if (!(pv.z < 1 && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1)) return '';
      return `<span class="mk ref" style="left:${rect.left - host.left + (pv.x + 1) / 2 * w + 10}px;top:${rect.top - host.top + (1 - pv.y) / 2 * rect.height - 10}px">Kondil ${k === 'R' ? 'sağ' : 'sol'}</span>`;
    }).join('');
  }
  if (window.UI) { const f = UI.onRender; UI.onRender = (...a) => { if (f) f(...a); place(); }; }

  // ---------- slices: midline and condyles ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    if (!ref) return;
    const pl = St.parts.mirror; if (pl && pl.visible && A.contour) { ctx.strokeStyle = 'rgba(190,200,210,.9)'; ctx.setLineDash([2 * dpr, 3 * dpr]); ctx.lineWidth = 1.2 * dpr; A.contour(v, pl, T, ctx); ctx.setLineDash([]); }
    if (A.planeLine) {
      const n = V(...ref.n), L = A.planeLine(v, n.clone().multiplyScalar(ref.d), n);
      if (L) { ctx.strokeStyle = 'rgba(142,111,214,.8)'; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([8 * dpr, 4 * dpr]); ctx.beginPath(); ctx.moveTo(T.fx(L.a[0]), T.fy(L.a[1])); ctx.lineTo(T.fx(L.b[0]), T.fy(L.b[1])); ctx.stroke(); ctx.setLineDash([]); }
    }
    for (const k of ['R', 'L']) {
      const p = ref.cond[k]; if (!p) continue;
      const ix = A.toIdx(p); if (Math.abs(ix[v.axis] - A.st.cur[v.axis]) * S.vol.sp[v.axis] > 4) continue;
      const [x, y] = A.idxToImg(v, ix); ctx.strokeStyle = '#a58cf0'; ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath(); ctx.arc(T.fx(x), T.fy(y), 5 * dpr, 0, 2 * Math.PI); ctx.stroke();
      A.label(ctx, `Kondil ${k === 'R' ? 'sağ' : 'sol'}`, T.fx(x) + 8 * dpr, T.fy(y) - 6 * dpr, '#c4b2ff', dpr);
    }
  });

  // ---------- picking a condyle by hand ----------
  const prevTools = window.Tools;
  window.Tools = {
    click(e, ray) {
      if (picking) {
        const t = ['bone', 'resected'].filter(k => St.parts[k] && St.parts[k].visible).map(k => St.parts[k].obj), h = ray.intersectObjects(t, false)[0];
        if (!h) return true;
        ref.cond[picking] = h.point.toArray().map(x => Math.round(x * 100) / 100); ref.manual = Object.assign({}, ref.manual, { [picking]: ref.cond[picking] });
        picking = null; $('modeBadge').hidden = true; update(); St.emit('changed'); return true;
      }
      return prevTools ? prevTools.click(e, ray) : false;
    },
  };

  // ---------- metrics ----------
  function metrics() {
    if (!ref) return null;
    const n = V(...ref.n), { R, L } = ref.cond, out = { tilt: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(n.x)))), score: ref.score };
    if (R && L) {
      const a = V(...R), b = V(...L), dR = Math.abs(a.dot(n) - ref.d), dL = Math.abs(b.dot(n) - ref.d);
      // mirror the left condyle onto the right side: what is left is the asymmetry
      const bm = b.clone().addScaledVector(n, -2 * (b.dot(n) - ref.d)), diff = bm.sub(a);
      Object.assign(out, { inter: a.distanceTo(b), dR, dL, dz: diff.z, dy: diff.y, asym: diff.length() });
    }
    return out;
  }
  function update() {
    draw(); buildMirror(); render(); St.render();
    if (window.MPR) MPR.redraw();
  }
  function render() {
    const M = metrics();
    $('refBox').innerHTML = `<h3 class="sub">Referans ve simetri</h3>
      ${ref ? `<dl class="kv">
        <dt>Orta sagittal düzlem</dt><dd>${fmt(M.tilt, 1)}° eğik · ayna uyumu %${fmt(M.score * 100, 0)}</dd>
        ${M.inter !== undefined ? `<dt>Kondiller arası</dt><dd>${fmt(M.inter)} mm</dd>
        <dt>Orta düzleme uzaklık</dt><dd>sağ ${fmt(M.dR)} · sol ${fmt(M.dL)} mm</dd>
        <dt>Kondil asimetrisi</dt><dd>${fmt(M.asym)} mm (dikey ${fmt(M.dz)}, ön-arka ${fmt(M.dy)})</dd>` : '<dt>Kondiller</dt><dd>bulunamadı; elle seçin</dd>'}
      </dl>
      <label class="chk"><input type="checkbox" id="rfMirror" ${view.mirror ? 'checked' : ''}> Sağlam tarafın ayna görüntüsünü göster</label>
      <label class="chk"><input type="checkbox" id="rfDefect" ${view.defectOnly ? 'checked' : ''}> Yalnız defekt tarafında</label>
      <label class="chk"><input type="checkbox" id="rfPlane" ${view.plane ? 'checked' : ''}> Orta düzlemi göster</label>
      <div class="btns"><button data-pk="R"><svg class="i"><use href="#i-target"/></svg>Sağ kondili seç</button><button data-pk="L"><svg class="i"><use href="#i-target"/></svg>Sol kondili seç</button></div>
      <div class="btns"><button id="rfRun">Yeniden hesapla</button></div>
      <p class="hint">Ayna görüntüsü rekonstrüksiyon için hedef konturdur. Kesitlerde kesikli gri çizgi olarak da görünür.</p>`
      : `<p class="hint">Orta sagittal düzlem, kemiğin kendi ayna görüntüsüne en iyi oturduğu düzlem olarak bulunur.</p><div class="btns"><button id="rfRun" ${S.mask ? '' : 'disabled'}><svg class="i"><use href="#i-target"/></svg>Simetri ve kondilleri bul</button></div>`}`;
    $('rfRun').addEventListener('click', () => compute(false));
    if (!ref) return;
    $('rfMirror').addEventListener('change', e => { view.mirror = e.target.checked; update(); });
    $('rfDefect').addEventListener('change', e => { view.defectOnly = e.target.checked; built = null; update(); });
    $('rfPlane').addEventListener('change', e => { view.plane = e.target.checked; update(); });
    $('refBox').querySelectorAll('[data-pk]').forEach(b => b.addEventListener('click', () => {
      picking = b.dataset.pk; const mb = $('modeBadge'); mb.hidden = false; mb.textContent = `${picking === 'R' ? 'Sağ' : 'Sol'} kondilin tepesine 3B görünümde tıklayın. Vazgeçmek için Esc.`;
    }));
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && picking) { picking = null; $('modeBadge').hidden = true; } });

  // ---------- plan, events, checks, report ----------
  (window.PlanExt = window.PlanExt || {}).ref = {
    label: 'Simetri ve kondil referansı',
    get: () => ref ? JSON.parse(JSON.stringify(ref)) : null,
    set(x) { ref = x ? JSON.parse(JSON.stringify(x)) : null; built = null; update(); },
  };
  let lastBone = null, auto = false;
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { ref = null; auto = true; built = null; } update(); });
  bus.addEventListener('parts', () => {
    const b = St.parts.bone; if (!b) return;
    if (auto && !S.restoring) { auto = false; compute(false); return; }
    if (b.obj.geometry.uuid !== lastBone) { lastBone = b.obj.geometry.uuid; buildMirror(); }
  });
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const M = metrics(), out = [];
    if (M && M.asym !== undefined && M.asym > 4) out.push(['info', 'Bilgi', `Kondiller ${fmt(M.asym)} mm asimetrik; ayna görüntüsünü hedef alırken bunu hesaba katın.`, 'anat']);
    const E = M && ref && St.resEnds();
    if (E && !E.condyle) {
      // a segment resection must not take a condyle; a condylar resection is chosen explicitly
      for (const k of ['R', 'L']) { const p = ref.cond[k]; if (!p) continue; const q = V(...p);
        if (q.clone().sub(E.A.p).dot(E.A.N) > 0 && q.clone().sub(E.B.p).dot(E.B.N) < 0 && q.distanceTo(S.anchor.p) < 70) out.push(['warn', 'Uyarı', `${k === 'R' ? 'Sağ' : 'Sol'} kondil rezeksiyon bölgesinde kalıyor; kondil dahil rezeksiyon tipini seçin.`, 'lesion']); }
    }
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push((d) => {
    const M = metrics(); if (!M) return;
    d.h2('Simetri ve kondiller');
    d.table(['Ölçü', 'Değer'], [['Orta sagittal düzlem eğimi', `${fmt(M.tilt, 1)}°`], ['Ayna uyumu', `%${fmt(M.score * 100, 0)}`]].concat(M.inter !== undefined ? [['Kondiller arası mesafe', `${fmt(M.inter)} mm`], ['Orta düzleme uzaklık (sağ / sol)', `${fmt(M.dR)} / ${fmt(M.dL)} mm`], ['Kondil asimetrisi', `${fmt(M.asym)} mm`]] : []), [0.6, 0.4]);
  });
  render();
  return { compute, metrics, get: () => ref, reflect: () => ref && reflect(), view, place };
})();
