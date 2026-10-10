/* Free measurements in the 3D view and on the slices: distance (2 points), angle (3 points, vertex in the middle)
   and bone thickness (1 point on the surface, measured inward along the surface normal through the bone mask).
   Measurements are part of the plan, so they are saved, versioned and undoable. */
'use strict';
window.Measure = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus, scene } = St, $ = id => document.getElementById(id);
  const NAMES = { dist: 'Mesafe', angle: 'Açı', thick: 'Kemik kalınlığı' }, NEED = { dist: 2, angle: 3, thick: 1 };
  let on = false, type = 'dist', pts = [];
  S.measures = S.measures || [];
  const group = new THREE.Group(); group.renderOrder = 10; scene.add(group);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true });
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true });
  const labels = document.createElement('div'); labels.className = 'markers'; labels.id = 'measLabels';
  document.querySelector('.stagewrap').appendChild(labels);

  const val = m => m.type === 'angle' ? `${fmt(m.value, 1)}°` : `${fmt(m.value, 1)} mm`;
  function compute(type, P) {
    if (type === 'dist') return { value: P[0].distanceTo(P[1]) };
    if (type === 'angle') { const a = P[0].clone().sub(P[1]), b = P[2].clone().sub(P[1]); return { value: THREE.MathUtils.radToDeg(a.angleTo(b)) }; }
    return null;
  }
  // thickness: walk inward from the picked surface point until the bone mask ends
  function thickness(p, n) {
    const dir = n.clone().negate().normalize(); let tin = null, tout = null;
    for (let t = -1; t <= 45; t += 0.15) {
      const inside = St.boneAt(p.clone().add(dir.clone().multiplyScalar(t)));
      if (inside && tin === null) tin = t;
      if (!inside && tin !== null && t - tin > 0.3) { tout = t; break; }
    }
    if (tin === null || tout === null) return null;
    const a = p.clone().add(dir.clone().multiplyScalar(tin)), b = p.clone().add(dir.clone().multiplyScalar(tout));
    return { pts: [a, b], value: a.distanceTo(b) };
  }
  function pick(p, n) {
    if (!on) return false;
    if (type === 'thick') {
      if (!n) { hint('Kalınlık 3B görünümde kemik yüzeyine tıklanarak ölçülür.'); return true; }
      const r = thickness(p, n);
      if (!r) { hint('Bu noktada kemik bulunamadı; kemik yüzeyine tıklayın.'); return true; }
      add({ type, pts: r.pts.map(q => q.toArray().map(x => Math.round(x * 100) / 100)), value: +r.value.toFixed(2) });
      return true;
    }
    pts.push(p.clone()); draw();
    if (pts.length === NEED[type]) { add({ type, pts: pts.map(q => q.toArray().map(x => Math.round(x * 100) / 100)), value: +compute(type, pts).value.toFixed(2) }); pts = []; }
    else hint(`${NAMES[type]}: ${pts.length}/${NEED[type]} nokta. ${type === 'angle' && pts.length === 1 ? 'Sonraki nokta açının köşesi.' : ''}`);
    return true;
  }
  function add(m) { S.measures.push(m); pts = []; hint(`${NAMES[m.type]} ${val(m)} eklendi. Yeni ölçüm için tıklamaya devam edin.`); render(); St.emit('changed'); }
  // the badge is shared with other tools: only hide it if it still shows our text
  let mine = '';
  function hint(t) { const b = $('modeBadge'); if (on) { b.hidden = false; b.textContent = mine = t; } else if (b.textContent === mine) b.hidden = true; }
  // 3D clicks come here first (Studio's picking hook)
  window.Tools = {
    click(e, ray) {
      if (!on) return false;
      const targets = Object.values(St.parts).filter(pt => pt.visible && pt.obj.isMesh && !/^(plane|lesion|anchor|mirror|guide|layer_)/.test(pt.id)).map(pt => pt.obj);
      const g = St.parts.grafts; if (g && g.visible) g.obj.traverse(c => { if (c.isMesh) targets.push(c); });
      const h = ray.intersectObjects(targets, false)[0];
      if (!h) return true;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (n.dot(ray.ray.direction) > 0) n.negate();
      pick(h.point.clone(), n); return true;
    },
  };
  function setOn(v) {
    on = v; pts = []; if (on && window.SegEdit) SegEdit.off(); if (on && window.Lesion) Lesion.off(); $('toolMeasure').setAttribute('aria-pressed', on);
    hint(`${NAMES[type]}: ${type === 'thick' ? 'kemik yüzeyine tıklayın' : 'noktalara tıklayın (3B ya da kesit)'}. Bitirmek için Esc.`);
    if (on && window.UI) UI.openTab('pMes');
    draw();
  }
  function setType(t) { type = t; document.querySelectorAll('#mType button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mt === t)); if (on) setOn(true); }
  // ---------- drawing ----------
  function draw() {
    while (group.children.length) { const c = group.children.pop(); c.geometry.dispose(); }
    const dot = q => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), dotMat); m.position.copy(q); m.renderOrder = 10; group.add(m); };
    const poly = P => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P), lineMat); l.renderOrder = 10; group.add(l); };
    S.measures.forEach(m => { const P = m.pts.map(a => V(...a)); poly(P); P.forEach(dot); });
    if (pts.length) { pts.forEach(dot); if (pts.length > 1) poly(pts); }
    labels.innerHTML = S.measures.map((m, i) => `<span class="mk meas" data-i="${i}">${val(m)}</span>`).join('');
    place(); St.render();
  }
  const pv = V();
  function place() {
    const cam = St.camera, rect = St.renderer.domElement.getBoundingClientRect(), host = labels.getBoundingClientRect(), w = S.split ? rect.width / 2 : rect.width;
    const vis = !cam.layers.isEnabled(1) || S.split;
    labels.querySelectorAll('.mk').forEach(el => {
      const m = S.measures[+el.dataset.i]; if (!m || !vis) { el.hidden = true; return; }
      const P = m.pts.map(a => V(...a)), c = m.type === 'angle' ? P[1] : P[0].clone().add(P[P.length - 1]).multiplyScalar(0.5);
      pv.copy(c).project(cam); el.hidden = !(pv.z < 1 && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1);
      el.style.left = (rect.left - host.left + (pv.x + 1) / 2 * w) + 'px'; el.style.top = (rect.top - host.top + (1 - pv.y) / 2 * rect.height) + 'px';
    });
  }
  function render() {
    draw();
    $('userMeasures').innerHTML = `<h3 class="sub">Serbest ölçümler</h3>
      <span class="seg" id="mType" role="group" aria-label="Ölçüm türü">${Object.keys(NAMES).map(k => `<button data-mt="${k}" aria-pressed="${k === type}">${NAMES[k]}</button>`).join('')}</span>
      <div class="btns"><button id="mToggle" class="${on ? '' : 'primary'}"><svg class="i"><use href="#i-ruler"/></svg>${on ? 'Ölçümü bitir' : 'Ölçmeye başla'}</button></div>
      ${S.measures.length ? `<div class="tbl"><table><thead><tr><th>#</th><th>Tür</th><th>Değer</th><th></th></tr></thead><tbody>${S.measures.map((m, i) => `<tr><td>${i + 1}</td><td>${NAMES[m.type]}</td><td>${val(m)}</td><td><button class="link" data-del="${i}" aria-label="Ölçüm ${i + 1}'i sil">Sil</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Mesafe ve açı için noktalara, kalınlık için kemik yüzeyine tıklayın. Kesitlerde de nokta seçilebilir.</p>'}
      <h3 class="sub">Plan ölçümleri</h3>`;
    $('userMeasures').querySelectorAll('[data-mt]').forEach(b => b.addEventListener('click', () => { setType(b.dataset.mt); render(); }));
    $('mToggle').addEventListener('click', () => { setOn(!on); render(); });
    $('userMeasures').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { S.measures.splice(+b.dataset.del, 1); render(); St.emit('changed'); }));
    if (window.MPR) MPR.redraw();
  }
  // ---------- slices: measurements projected on the slice; solid where they lie in it ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const all = S.measures.map(m => ({ m, P: m.pts })).concat(pts.length ? [{ m: null, P: pts.map(q => q.toArray()) }] : []);
    all.forEach(({ m, P }) => {
      const I = P.map(p => A.toIdx(p)), img = I.map(ix => A.idxToImg(v, ix)), near = I.every(ix => Math.abs(ix[v.axis] - A.st.cur[v.axis]) * S.vol.sp[v.axis] < 2);
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash(near ? [] : [4 * dpr, 3 * dpr]);
      ctx.beginPath(); img.forEach(([x, y], k) => k ? ctx.lineTo(T.fx(x), T.fy(y)) : ctx.moveTo(T.fx(x), T.fy(y))); ctx.stroke(); ctx.setLineDash([]);
      img.forEach(([x, y]) => { ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(T.fx(x), T.fy(y), 2.5 * dpr, 0, 2 * Math.PI); ctx.fill(); });
      if (m) { const c = img[m.type === 'angle' ? 1 : 0], d = img[img.length - 1]; A.label(ctx, val(m), T.fx((c[0] + d[0]) / 2) + 6 * dpr, T.fy((c[1] + d[1]) / 2) - 6 * dpr, '#ffd23f', dpr); }
    });
  });
  // ---------- wiring ----------
  $('toolMeasure').addEventListener('click', () => { setOn(!on); render(); });
  document.addEventListener('keydown', e => {
    const a = document.activeElement;
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'range') return;
    if (e.key === 'm' || e.key === 'M') { setOn(!on); render(); }
    else if (e.key === 'Escape' && on) { if (pts.length) { pts = []; draw(); } else { setOn(false); render(); } }
  });
  bus.addEventListener('planApplied', e => { S.measures = (e.detail && e.detail.measures || []).map(m => JSON.parse(JSON.stringify(m))); render(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { S.measures = []; render(); } });
  render();
  return { active: () => on, pick, place, render, list: () => S.measures };
})();
