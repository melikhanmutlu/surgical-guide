/* Malleolar fracture (ankle) case type, milestone 1: the bones and fracture fragments of an ankle CT, a virtual
   reduction (each piece moved and turned back into place by hand), measurements of the reduction (displacement, contact,
   gap, overlap with the neighbouring bone), the reduced model as STL (to pre-bend a plate on a printed model) and a
   package once the plan is approved.

   Pieces are the bone components of the threshold mask (or the layers of "Bitişik kemikleri ayır" when touching bones
   were split). Each piece is shown as its own mesh inside a pivot at its centre c; a reduction is a rigid motion
   p' = q (p - c) + c + t, saved with the plan (PlanExt.ankle) and undoable. The reduction is a surgeon's decision:
   the module measures it, it never calls it right. Research prototype, not for clinical use. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Ankle = (function () {
  const St = window.Studio; if (!St || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const on = () => CaseType.get() === 'ankle';
  const PALETTE = [0xe0a03a, 0x4f8fe6, 0x9b6ad6, 0x2bb0b0, 0xd46a9a, 0x46c98b, 0xc9a227, 0x7f8c99], FIXED = 0xd8d2c8;
  // sample thresholds (our engineering assumptions, not from the literature); the clinical team sets the final values
  const LIM = { overlapWarn: 0.5, overlapCrit: 1.0, gapWarn: 2.0, contact: 0.8, near: 4, minCm3: 0.2 };
  const CLASSES = ['', 'Weber A', 'Weber B', 'Weber C', 'İzole medial malleol', 'Bimalleoler', 'Trimalleoler', 'Diğer'];
  let pieces = [], built = '', sel = -1, metrics = [], pend = null, buildJob = null;
  let meta = { side: '', cls: '' }, red = { ok: false }, autoSide = '';
  const hex = c => '#' + c.toString(16).padStart(6, '0');

  // ---------- pieces from the segmentation ----------
  const r3 = q => [q.x, q.y, q.z].map(x => Math.round(x * 10) / 10);
  // anatomical names (a guess shown as such; each name can be changed in the panel):
  // - outside the body: a piece whose voxels mostly lie within 3 mm of air (in the axial plane) is a splint, cast or
  //   table, not bone ("Atel / dış nesne": hidden, not measured, not exported). Bone lies under soft tissue.
  // - tibia and fibula: the two longest remaining pieces (the larger is the tibia); the ankle level is the fibula's
  //   distal end (the end away from the scan edge the shafts leave by)
  // - pieces further than ROI_MM above the ankle level (knee, femur, patella on a long scan) or DIST_MM below it
  //   (midfoot) are "Diğer kemik"
  // - talus: the largest piece left near the ankle (over 5 cm³); the rest are fragments named by where they lie
  const MAXP = 12, THR_ANKLE = 300, THR_MAND = 250, ROI_MM = 100, DIST_MM = 20, NAMES = ['Tibia', 'Fibula', 'Talus', 'Lateral malleol', 'Medial malleol', 'Posterior malleol', 'Diğer kemik', 'Atel / dış nesne'];
  const roleOf = n => ({ Tibia: 'tibia', Fibula: 'fibula', Talus: 'talus', 'Diğer kemik': 'other', 'Atel / dış nesne': 'out' })[n] || 'frag';
  function names(list) {
    const r = S.red, hu = r.hu, A = Math.max(1, Math.round(3 / r.sp[0]));
    const ext = new Map(list.map(p => [p.label, [Infinity, -Infinity, 0, 0]]));
    const air = v => hu && hu[v] < -500;
    for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) {
      const e = ext.get(S.labels[v]); if (!e) continue; if (k < e[0]) e[0] = k; if (k > e[1]) e[1] = k;
      e[2]++; if ((i >= A && air(v - A)) || (i + A < r.nx && air(v + A)) || (j >= A && air(v - A * r.nx)) || (j + A < r.ny && air(v + A * r.nx))) e[3]++;
    }
    list.forEach(p => { const e = ext.get(p.label); p.kLo = e[0]; p.kHi = e[1]; p.airFrac = e[2] ? e[3] / e[2] : 0; p.role = ''; });
    list.forEach(p => { if (p.airFrac > 0.5) { p.name = 'Atel / dış nesne'; p.role = 'out'; } });
    const len = p => (p.kHi - p.kLo) * r.sp[2];
    const shafts = list.filter(p => !p.role && len(p) > 25).sort((a, b) => len(b) - len(a)).slice(0, 2).sort((a, b) => b.size - a.size);
    const tib = shafts[0] || null, fib = shafts[1] || null;
    if (tib) { tib.name = 'Tibia'; tib.role = 'tibia'; }
    if (fib) { fib.name = 'Fibula'; fib.role = 'fibula'; }
    // the ankle level (slice index): the distal end of the fibula (or of the tibia without one)
    // up = towards the knee in slice order; pieces wholly above kA + ROI_MM or wholly below kA - DIST_MM (the midfoot)
    // are left as "Diğer kemik": malleolar fragments, talus and plafond reach above the fibula tip
    const sh = fib || tib; let kA = null, up = 1;
    if (sh) { up = sh.kLo <= (r.nz - 1 - sh.kHi) ? -1 : 1; kA = up > 0 ? sh.kLo : sh.kHi; }
    const roi = ROI_MM / r.sp[2], dist = DIST_MM / r.sp[2];
    const far = p => (up > 0 ? p.kLo > kA + roi || p.kHi < kA - dist : p.kHi < kA - roi || p.kLo > kA + dist);
    list.forEach(p => { if (!p.role && kA != null && far(p)) { p.name = 'Diğer kemik'; p.role = 'other'; } });
    const rest = list.filter(p => !p.role).sort((a, b) => b.size - a.size);
    const tal = rest[0] && rest[0].cm3 > 5 && (!tib || rest[0].cm3 > 0.08 * tib.cm3) ? rest[0] : null;
    if (tal) { tal.name = 'Talus'; tal.role = 'talus'; }
    const lat = tib && fib ? V().subVectors(fib.c, tib.c).setZ(0).normalize() : null;
    let n = 0;
    list.filter(p => !p.role).forEach(p => {
      p.role = 'frag';
      if (tib && fib && lat) {
        const dF = Math.hypot(p.c.x - fib.c.x, p.c.y - fib.c.y), dT = Math.hypot(p.c.x - tib.c.x, p.c.y - tib.c.y), d = V().subVectors(p.c, tib.c);
        if (dF < dT) { p.name = 'Lateral malleol'; return; }
        if (-d.dot(lat) > 8) { p.name = 'Medial malleol'; return; }
        if (d.y > 6) { p.name = 'Posterior malleol'; return; }
      }
      p.name = `Parça ${++n}`;
    });
    // the side of the ankle: the fibula is lateral, a right ankle has it on the patient's right (-x in LPS)
    return tib && fib ? (fib.c.x < tib.c.x ? 'R' : 'L') : '';
  }
  const sigOf = () => S.labels && S.comps ? S.comps.map(c => `${c.label}:${c.size}`).join(',') + '|' + S.red.nx + 'x' + S.red.ny + 'x' + S.red.nz : '';

  async function build() {
    if (!on() || !S.red || !S.labels || !S.comps) return;
    const sig = sigOf(); if (sig === built && pieces.length) { show(); return; }
    const job = buildJob = {}, r = S.red, vox = r.sp[0] * r.sp[1] * r.sp[2] / 1000;
    drop();
    const list = S.comps.filter(c => c.size * vox >= LIM.minCm3).slice(0, MAXP).map(c => ({ label: c.label, size: c.size, cm3: c.size * vox, c: V(...G.worldOf(r, ...c.centroid)) }));
    const side = autoSide = names(list);
    if (!meta.side && side) meta.side = side;
    St.busy(true, xl('Kırık parçaları hazırlanıyor…')); await St.sleep();
    try {
      // one pass for every piece's bounding box; each piece is then meshed and measured on its own box only
      const box = new Map(list.map(p => [p.label, [r.nx, r.ny, r.nz, -1, -1, -1]]));
      for (let k = 0, v = 0; k < r.nz; k++) for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++, v++) {
        const b = box.get(S.labels[v]); if (!b) continue;
        if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
      }
      let fi = 0;
      for (const p of list) {
        const b = box.get(p.label), PAD = 6, lo = [0, 1, 2].map(a => Math.max(0, b[a] - PAD)), hi = [0, 1, 2].map(a => Math.min([r.nx, r.ny, r.nz][a] - 1, b[a + 3] + PAD));
        const [cx, cy, cz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), m = new Uint8Array(cx * cy * cz);
        for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) { const row = lo[0] + r.nx * (lo[1] + j + r.ny * (lo[2] + k)), o = cx * (j + cy * k); for (let i = 0; i < cx; i++) if (S.labels[row + i] === p.label) m[o + i] = 1; }
        const crop = { m: m.slice(), lo, nx: cx, ny: cy, nz: cz };
        const net = await St.blurNetsOf(m, cx, cy, cz);
        if (job !== buildJob) return;
        p.color = p.role === 'frag' ? PALETTE[fi++ % PALETTE.length] : FIXED;
        const mat = new T.MeshStandardMaterial({ color: p.color, roughness: 0.7, metalness: 0, side: T.DoubleSide });
        p.mesh = St.meshFromNets(net, (x, y, z) => St.toWorldRed(x + lo[0], y + lo[1], z + lo[2]), mat); p.mesh.position.copy(p.c).negate(); p.mesh.userData.ankle = p;
        p.pivot = new T.Group(); p.pivot.add(p.mesh); p.t = V(); p.q = new T.Quaternion(); place(p);
        p.sdf = await sdfOf(crop);
        if (job !== buildJob) return;
      }
      pieces = list; built = sig; sel = pieces.findIndex(p => p.role === 'frag');
      pieces.forEach((p, i) => St.setPart('ank' + i, p.name, p.pivot, p.color));
      if (pend) { const x = pend; pend = null; restore(x); }
      show(); measure(); render(); St.renderParts(); St.emit('changed');
    } finally { if (job === buildJob) { buildJob = null; St.busy(false); } }
  }
  function drop() { Object.keys(St.parts).filter(k => /^ank\d/.test(k)).forEach(k => St.setPart(k, null, null)); pieces = []; built = ''; sel = -1; metrics = []; attach(); }
  // signed distance (mm, outside > 0) of a piece on its bounding box + 6 voxels (4.8 mm): the measurements sample it
  async function sdfOf(c) {
    const r = S.red, { nx, ny, nz } = c;
    let d = null; const p = St.bg && St.bg('ank', { op: 'sdf', mask: c.m, nx, ny, nz, sp: r.sp });
    if (p) try { d = await p; } catch (e) { /* the worker failed: in the page */ }
    if (!d) { await St.sleep(); d = G.sdf(c.m, nx, ny, nz, r.sp); }
    return { d, lo: c.lo, nx, ny, nz };
  }
  // trilinear sample of a piece's distance at a world point in the piece's own (CT) position; far away = +Infinity
  function sdfAt(p, q) {
    const s = p.sdf, x = G.indexOf(S.red, [q.x, q.y, q.z]), f = [x[0] - s.lo[0], x[1] - s.lo[1], x[2] - s.lo[2]], n = [s.nx, s.ny, s.nz];
    if (f.some((v, k) => v < 0 || v > n[k] - 1)) return Infinity;
    const i0 = f.map((v, k) => Math.min(n[k] - 2, Math.floor(v))), w = f.map((v, k) => v - i0[k]);
    let out = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const wt = (dx ? w[0] : 1 - w[0]) * (dy ? w[1] : 1 - w[1]) * (dz ? w[2] : 1 - w[2]);
      if (wt) out += wt * s.d[i0[0] + dx + s.nx * (i0[1] + dy + s.ny * (i0[2] + dz))];
    }
    return out;
  }

  // ---------- the rigid motion of a piece ----------
  function place(p) { p.pivot.position.copy(p.c).add(p.t); p.pivot.quaternion.copy(p.q); p.pivot.updateMatrixWorld(true); }
  const moved = p => p.t.lengthSq() > 1e-8 || Math.abs(p.q.w) < 1 - 1e-10;
  const angleOf = q => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
  const toWorld = (p, q0) => q0.clone().sub(p.c).applyQuaternion(p.q).add(p.c).add(p.t);
  const toOwn = (p, w) => w.clone().sub(p.c).sub(p.t).applyQuaternion(p.q.clone().invert()).add(p.c);
  function unapprove() { if (red.ok) red = { ok: false }; }
  // a piece moved by the gizmo, the API or a restored plan; edit = a user change (drops the approval, one history step)
  function setMotion(i, t, q, edit = true) {
    const p = pieces[i]; if (!p) return;
    p.t.copy(t); p.q.copy(q).normalize(); place(p);
    if (edit) { unapprove(); measure(); render(); St.emit('changed'); }
    St.render();
  }
  function reset(i) { if (i == null) pieces.forEach((p, k) => setMotion(k, V(), new T.Quaternion(), false)); else setMotion(i, V(), new T.Quaternion(), false); unapprove(); measure(); render(); St.emit('changed'); }

  // ---------- measurements ----------
  // For every piece, its surface (up to ~3000 vertices, area-weighted) is moved to its reduced position and sampled in
  // the distance field of every other piece (taken back into that piece's own position). Near = within LIM.near mm.
  // The partner is the piece with the largest near area (the other side of the fracture, or the joint partner).
  // contact: area within ±LIM.contact mm; gap: area-weighted mean distance over the near area outside the partner;
  // overlap: deepest point of the surface inside the partner.
  function measure() {
    metrics = pieces.map((p, i) => {
      if (p.role === 'out') return { i, name: p.name, role: p.role, moved: moved(p), dist: p.t.length(), ang: angleOf(p.q), partner: -1, contact: 0, gap: null, over: 0, overWith: -1 };
      const g = p.mesh.geometry, P = g.attributes.position.array, I = g.index.array, nv = P.length / 3, area = new Float32Array(nv);
      const a = V(), b = V(), c = V();
      for (let t = 0; t < I.length; t += 3) { a.fromArray(P, I[t] * 3); b.fromArray(P, I[t + 1] * 3); c.fromArray(P, I[t + 2] * 3); const A = b.sub(a).cross(c.sub(a)).length() / 6; area[I[t]] += A; area[I[t + 1]] += A; area[I[t + 2]] += A; }
      const step = Math.max(1, Math.floor(nv / 3000)), per = pieces.map(() => ({ near: 0, contact: 0, gapSum: 0, gapA: 0, over: 0 }));
      const q0 = V();
      for (let v = 0; v < nv; v += step) {
        q0.fromArray(P, v * 3); const w = toWorld(p, q0), A = area[v] * step;
        pieces.forEach((o, j) => {
          if (j === i || o.role === 'out') return;
          const s = sdfAt(o, toOwn(o, w)); if (!(s < LIM.near)) return;
          const m = per[j]; m.near += A; if (Math.abs(s) <= LIM.contact) m.contact += A;
          if (s > 0) { m.gapSum += s * A; m.gapA += A; } else if (-s > m.over) m.over = -s;
        });
      }
      let best = -1; per.forEach((m, j) => { if (j !== i && m.near > 0 && (best < 0 || m.near > per[best].near)) best = j; });
      const m = best >= 0 ? per[best] : null;
      return { i, name: p.name, role: p.role, moved: moved(p), dist: p.t.length(), ang: angleOf(p.q), partner: best,
        contact: m ? m.contact : 0, gap: m && m.gapA ? m.gapSum / m.gapA : null, over: Math.max(0, ...per.map((x, j) => (j === i ? 0 : x.over))),
        overWith: per.reduce((k, x, j) => (j !== i && x.over > (k < 0 ? 0 : per[k].over) ? j : k), -1) };
    });
  }
  function checks() {
    if (!on() || !pieces.length) return [];
    const out = [];
    metrics.forEach(m => {
      if (m.role !== 'frag') return;
      const with_ = m.overWith >= 0 ? pieces[m.overWith].name : '';
      if (m.over >= LIM.overlapCrit) out.push(['crit', 'Kritik', xl(`${m.name}, ${with_} ile ${fmt(m.over, 1)} mm iç içe geçiyor; iki kemik aynı yeri dolduramaz. Parçayı geri çekin.`), 'ank']);
      else if (m.over >= LIM.overlapWarn) out.push(['warn', 'Uyarı', xl(`${m.name}, ${with_} ile ${fmt(m.over, 1)} mm iç içe; kırık yüzeyleri ezilmiş olabilir, kontrol edin.`), 'ank']);
      if (m.gap != null && m.gap > LIM.gapWarn && m.partner >= 0) out.push(['warn', 'Uyarı', xl(`${m.name} ile ${pieces[m.partner].name} arasında ortalama ${fmt(m.gap, 1)} mm aralık var.`), 'ank']);
    });
    if (!pieces.some(moved)) out.push(['info', 'Bilgi', xl('Henüz hiçbir parça taşınmadı; redükte model BT\'deki konumla aynı.'), 'ank']);
    return out;
  }
  // the checks list while the case is an ankle (app.js renderChecks hands over when there is no mandible guide)
  function renderChecks() {
    const out = checks();
    (window.ExtraChecks || []).forEach(f => { try { f().forEach(c => out.push(c)); } catch (e) { /* optional */ } });
    S.crit = out.filter(o => o[0] === 'crit').length; S.checkList = out.slice();
    const rank = { crit: 0, warn: 1, ok: 2 }, infos = out.filter(o => o[0] === 'info'), main = out.filter(o => o[0] !== 'info').sort((a, b) => (rank[a[0]] ?? 3) - (rank[b[0]] ?? 3));
    if (!main.length) main.push(['ok', 'Uygun', 'Tüm kontroller geçti.']);
    const li = ([c, t, m]) => `<li class="${c}"><b>${t}</b><span>${esc(m)}</span></li>`, n = c => out.filter(o => o[0] === c).length;
    if ($('checks')) $('checks').innerHTML = main.map(li).join('');
    if ($('checksInfo')) $('checksInfo').innerHTML = infos.map(li).join('');
    if ($('chkInfoN')) $('chkInfoN').textContent = infos.length || '';
    if ($('chkInfo')) $('chkInfo').hidden = !infos.length;
    if ($('chkSum')) { $('chkSum').innerHTML = (n('crit') ? `<span class="tag crit">${n('crit')} kritik</span>` : '') + (n('warn') ? `<span class="tag warn">${n('warn')} uyarı</span>` : ''); $('chkSum').hidden = !$('chkSum').innerHTML; }
    const box = $('ankWarn'); if (box) { const mine = out.filter(o => o[3] === 'ank' && (o[0] === 'crit' || o[0] === 'warn')); box.innerHTML = mine.length ? `<ul class="checks">${mine.map(li).join('')}</ul>` : ''; }
  }

  // ---------- 3D: which model is shown, the gizmo, picking a piece ----------
  const anatOpen = () => !!($('st2') && $('st2').open);
  function show() {
    if (!on() || !pieces.length) return;
    const frag = !anatOpen(), b = St.parts.bone;
    if (b) { b.visible = !frag; b.obj.visible = !frag; }
    pieces.forEach((p, i) => { const pt = St.parts['ank' + i]; if (pt) { pt.visible = frag && p.role !== 'out'; pt.obj.visible = pt.visible; } });
    attach(); St.renderParts(); St.render();
  }
  let tc = null, dragging = false;
  if (T.TransformControls) {
    tc = new T.TransformControls(St.camera, St.renderer.domElement);
    tc.setSize(0.8); tc.setSpace('world'); tc.visible = false; tc.enabled = false; St.scene.add(tc);
    tc.addEventListener('change', () => St.render());
    tc.addEventListener('dragging-changed', e => {
      dragging = e.value; St.controls.enabled = !e.value;
      if (!e.value && sel >= 0 && pieces[sel]) { const p = pieces[sel]; p.t.copy(p.pivot.position).sub(p.c); p.q.copy(p.pivot.quaternion); unapprove(); measure(); render(); St.emit('changed'); }
    });
    tc.addEventListener('objectChange', () => { const p = pieces[sel]; if (p) { p.t.copy(p.pivot.position).sub(p.c); p.q.copy(p.pivot.quaternion); renderMotion(); } });
  }
  const redOpen = () => !!($('stRed') && $('stRed').open);
  function attach() {
    if (!tc) return;
    const p = on() && redOpen() && !anatOpen() ? pieces[sel] : null;
    if (p) { tc.attach(p.pivot); tc.visible = tc.enabled = true; } else { tc.detach(); tc.visible = tc.enabled = false; }
    St.render();
  }
  function setMode(m) { if (tc) tc.setMode(m); ['ankT', 'ankR'].forEach(id => $(id) && $(id).setAttribute('aria-pressed', String((id === 'ankT') === (m === 'translate')))); }
  document.addEventListener('keydown', e => {
    if (!on() || !redOpen() || sel < 0) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'w' || e.key === 'W') setMode('translate'); else if (e.key === 'e' || e.key === 'E') setMode('rotate');
  });
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = on() && redOpen() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null;
    if (!d || dragging || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4 || !pieces.length) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const h = St.ray.intersectObjects(pieces.map(p => p.mesh).filter(m => m.parent && m.parent.visible), false)[0];
    if (h) choose(pieces.indexOf(h.object.userData.ankle));
  });
  function choose(i) { sel = i; attach(); render(); }
  // a piece's name (and with it its role) chosen by hand: fragments are measured and coloured, a splint is left out
  function rename(i, name, edit = true) {
    const p = pieces[i]; if (!p || !name) return;
    p.name = String(name).slice(0, 40); p.role = roleOf(p.name);
    const frag = pieces.filter(x => x.role === 'frag');
    p.color = p.role === 'frag' ? PALETTE[frag.indexOf(p) % PALETTE.length] : FIXED; p.mesh.material.color.setHex(p.color);
    const pt = St.parts['ank' + i]; if (pt) { pt.label = p.name; pt.color = p.color; }
    if (edit) { unapprove(); measure(); show(); render(); St.emit('changed'); }
  }

  // ---------- panel ----------
  function renderMotion() {
    const p = pieces[sel], box = $('ankMotion'); if (!box) return;
    if (!p) { box.innerHTML = ''; return; }
    const e = new T.Euler().setFromQuaternion(p.q, 'XYZ'), d = THREE.MathUtils.radToDeg, m = metrics[sel];
    box.innerHTML = `<dl class="kv"><dt>${xl('Öteleme (x, y, z)')}</dt><dd>${[p.t.x, p.t.y, p.t.z].map(x => fmt(x, 1)).join(' / ')} mm</dd>
      <dt>${xl('Dönme (x, y, z)')}</dt><dd>${[e.x, e.y, e.z].map(x => fmt(d(x), 1)).join(' / ')}°</dd>
      <dt>${xl('Toplam')}</dt><dd>${fmt(p.t.length(), 1)} mm · ${fmt(angleOf(p.q), 1)}°</dd>
      <dt>${xl('Hacim')}</dt><dd>${fmt(p.cm3, 1)} cm³</dd>
      <dt>${xl('Komşu kemik')}</dt><dd>${m && m.partner >= 0 ? esc(pieces[m.partner].name) : '–'}</dd>
      <dt>${xl('Temas alanı')}</dt><dd>${m && m.partner >= 0 ? fmt(m.contact, 0) + ' mm²' : '–'}</dd></dl>`;
  }
  function render() {
    const box = $('ankBody'); if (!box) return;
    if (!pieces.length) { box.innerHTML = `<p class="hint">${xl('Parçalar BT yüklenip kemik ayrılınca burada listelenir.')}</p>`; renderAppr(); return; }
    const row = (p, i) => { const m = metrics[i] || {};
      return `<tr class="${i === sel ? 'on' : ''}"><td><button class="link" data-sel="${i}"><i class="dot" style="background:${hex(p.color)}"></i>${esc(p.name)}</button></td>
        <td>${m.moved ? `${fmt(m.dist, 1)} · ${fmt(m.ang, 0)}°` : '–'}</td><td>${m.gap != null ? fmt(m.gap, 1) : '–'}</td><td>${m.over ? fmt(m.over, 1) : '0'}</td></tr>`; };
    box.innerHTML = `<div class="tbl"><table><thead><tr><th>${xl('Parça')}</th><th title="${xl('Öteleme (mm) ve dönme (°)')}">${xl('Hareket')}</th><th title="${xl('Komşu kemiğe ortalama aralık (mm)')}">${xl('Aralık')}</th><th title="${xl('Komşu kemiğin içine giren en derin nokta (mm)')}">${xl('Çakışma')}</th></tr></thead>
      <tbody>${pieces.map(row).join('')}</tbody></table></div>
      <p class="hint more">${xl('Hareket: parçanın BT\'deki konumundan öteleme (mm) ve dönme. Aralık: komşu kemiğe 4 mm\'den yakın yüzeyin ortalama uzaklığı (mm). Çakışma: komşunun içine giren en derin nokta (mm). Eşikler örnektir; klinik ekip belirler.')}</p>
      <h3 class="sub">${xl('Seçili parça')}: ${pieces[sel] ? esc(pieces[sel].name) : '–'}</h3>
      ${pieces[sel] ? `<div class="ctl"><label for="ankName" class="lbl2">${xl('Ad')}</label><select id="ankName">${(NAMES.includes(pieces[sel].name) ? NAMES : [pieces[sel].name, ...NAMES]).map(n => `<option value="${esc(n)}" ${n === pieces[sel].name ? 'selected' : ''}>${esc(xl(n))}</option>`).join('')}</select></div>` : ''}
      <span class="seg tools" role="group" aria-label="${xl('Taşıma aracı')}"><button id="ankT" aria-pressed="${!tc || tc.mode === 'translate'}">${xl('Taşı (W)')}</button><button id="ankR" aria-pressed="${!!tc && tc.mode === 'rotate'}">${xl('Döndür (E)')}</button></span>
      <div id="ankMotion" class="col"></div>
      <div class="btns"><button id="ankReset" class="sm" ${pieces[sel] && moved(pieces[sel]) ? '' : 'disabled'}>${xl('Parçayı BT konumuna döndür')}</button><button id="ankResetAll" class="ghost sm" ${pieces.some(moved) ? '' : 'disabled'}>${xl('Tümünü sıfırla')}</button></div>
      <p class="hint more">${xl('Parçayı 3B görünümde tıklayarak ya da listeden seçin; okları sürükleyerek taşıyın, halkalarla döndürün. Ölçümler fare bırakılınca yenilenir.')}</p>`;
    box.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('click', () => choose(+b.dataset.sel)));
    if ($('ankName')) $('ankName').addEventListener('change', e => rename(sel, e.target.value));
    $('ankT').addEventListener('click', () => setMode('translate')); $('ankR').addEventListener('click', () => setMode('rotate'));
    $('ankReset').addEventListener('click', () => reset(sel)); $('ankResetAll').addEventListener('click', () => reset(null));
    renderMotion(); renderAppr(); renderChecks();
  }
  function renderMeta() {
    const box = $('ankCase'); if (!box) return;
    box.innerHTML = `<div class="ctl"><label for="ankSide" class="lbl2">${xl('Taraf')}</label><select id="ankSide"><option value="">${xl('Bilinmiyor')}</option><option value="R">${xl('Sağ ayak bileği')}</option><option value="L">${xl('Sol ayak bileği')}</option></select></div>
      <div class="ctl"><label for="ankCls" class="lbl2">${xl('Kırık tipi')}</label><select id="ankCls">${CLASSES.map(c => `<option value="${esc(c)}">${c ? esc(xl(c)) : xl('Seçilmedi')}</option>`).join('')}</select></div>
      <p class="hint more">${xl('Taraf fibulanın konumundan önerilir. Kırık tipi cerrahın seçimidir; uygulama sınıflama yapmaz.')}</p>`;
    $('ankSide').value = meta.side; $('ankCls').value = meta.cls;
    $('ankSide').addEventListener('change', e => { meta.side = e.target.value; unapprove(); St.emit('changed'); renderAppr(); });
    $('ankCls').addEventListener('change', e => { meta.cls = e.target.value; unapprove(); St.emit('changed'); renderAppr(); });
  }

  // ---------- approval (step "İnceleme ve onay") ----------
  const initials = n => (n || '').split(/\s+/).filter(w => w && !/^(dr|prof|doç|doc|op|uzm)\.?$/i.test(w)).map(w => w[0].toLocaleUpperCase('tr-TR')).slice(0, 2).join('') || '?';
  function renderAppr() {
    const box = $('ankAppr'); if (!box) return;
    if (!on() || !pieces.length) { box.innerHTML = ''; return; }
    const crit = checks().some(c => c[0] === 'crit'), qcCrit = (S.qc || []).some(q => q[0] === 'crit'), nMoved = pieces.filter(moved).length;
    box.innerHTML = `<h3 class="sub">${xl('Öğe onayları')}</h3><ul class="review">
      <li class="sum"><button class="go" data-ank-go="st1"><span class="nm">${xl('Görüntü kalitesi')}</span></button><span class="tag ${qcCrit ? 'crit' : 'ok'}">${qcCrit ? 'Kritik' : 'Uygun'}</span></li>
      <li><button class="go" data-ank-go="stRed"><span class="nm">${xl('Redüksiyon')}</span><small>${xl(`${nMoved} parça taşındı`)}${meta.cls ? ' · ' + esc(xl(meta.cls)) : ''}</small></button>
        <span class="act">${red.ok ? `<span class="badge" title="${esc(red.by || '')}"><span class="ini">${esc(initials(red.by))}</span></span>` : ''} <button id="ankOk">${red.ok ? 'Kaldır' : 'Onayla'}</button></span></li>
      <li class="sum"><button class="go" data-ank-go="checks"><span class="nm">${xl('Otomatik kontroller')}</span></button><span class="tag ${crit ? 'crit' : 'ok'}">${crit ? 'Kritik' : 'Geçti'}</span></li></ul>
      <p class="hint" id="ankApprMsg"></p>`;
    box.querySelectorAll('[data-ank-go]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.ankGo; if (id === 'checks') St.goTo('data'); else if ($(id)) $(id).open = true; }));
    $('ankOk').addEventListener('click', approve);
  }
  function approve() {
    const name = $('surgeon').value.trim(), msg = t => { if ($('ankApprMsg')) $('ankApprMsg').textContent = xl(t); };
    if (red.ok) { red = { ok: false }; renderAppr(); St.emit('changed'); return; }
    if (!name) { msg('Önce onaylayan cerrahın adını yazın.'); $('surgeon').focus(); return; }
    if (checks().some(c => c[0] === 'crit')) { msg('Redüksiyonda kritik kontrol var; önce düzeltin.'); return; }
    red = { ok: true, by: name, at: new Date().toISOString(), sig: sig() };
    renderAppr(); St.emit('changed');
  }
  // the approval is bound to what was approved: the pieces' motions and the case data
  function sig() {
    const t = JSON.stringify([meta, pieces.map(p => [r3(p.c), [p.t.x, p.t.y, p.t.z].map(x => Math.round(x * 1000) / 1000), [p.q.x, p.q.y, p.q.z, p.q.w].map(x => Math.round(x * 1e5) / 1e5)])]);
    let a = 0x811c9dc5; for (let i = 0; i < t.length; i++) a = Math.imul(a ^ t.charCodeAt(i), 16777619);
    return (a >>> 0).toString(16).padStart(8, '0');
  }
  (window.PendingHooks = window.PendingHooks || []).push(() => (on() && pieces.length && !red.ok ? ['Redüksiyon'] : []));

  // ---------- outputs ----------
  // the reduced model: every piece's mesh moved to its reduced position, one STL in patient coordinates (LPS mm)
  function bakedMesh(list) {
    const ms = list.map(p => { p.pivot.updateMatrixWorld(true); const g = p.mesh.geometry.clone(); g.applyMatrix4(p.mesh.matrixWorld); return new T.Mesh(g); });
    return St.mergeMeshes(ms, new T.MeshBasicMaterial());
  }
  const fileName = s => String(s).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'parca';
  const kept = () => pieces.filter(p => p.role !== 'out');
  function reducedStl() { const m = bakedMesh(kept()), out = St.stlOf(m); m.geometry.dispose(); return out; }
  function pieceFiles() {
    const used = new Set();
    return kept().map(p => { let n = fileName(p.name); while (used.has(n)) n += '_2'; used.add(n); const m = bakedMesh([p]), data = St.stlOf(m); m.geometry.dispose(); return { name: `parcalar/${n}_redukte.stl`, data }; });
  }
  function reportHTML() {
    const A = window.Audit, h = A ? A.planHash() : '', st = r => { const s = A ? A.status(r, h) : { state: 'none' }; return s.state === 'valid' ? `${xl('Onaylı')} · ${esc(s.e.name)}` : s.state === 'stale' ? xl('Plan değişti') : xl('Bekliyor'); };
    const rows = metrics.filter(m => m.role !== 'out').map(m => `<tr><td>${esc(m.name)}</td><td>${fmt(pieces[m.i].cm3, 1)}</td><td>${m.moved ? `${fmt(m.dist, 1)} mm · ${fmt(m.ang, 1)}°` : '–'}</td><td>${m.partner >= 0 ? esc(pieces[m.partner].name) : '–'}</td><td>${m.partner >= 0 ? fmt(m.contact, 0) : '–'}</td><td>${m.gap != null ? fmt(m.gap, 1) : '–'}</td><td>${fmt(m.over, 1)}</td></tr>`).join('');
    const ck = checks().map(c => `<li><b>${esc(xl(c[1]))}</b> ${esc(c[2])}</li>`).join('');
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${xl('Malleol kırığı redüksiyon raporu')}</title>
      <style>body{font:14px/1.5 Inter,system-ui,sans-serif;color:#14181c;max-width:900px;margin:32px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d5dadf;padding:6px 8px;text-align:left}small,.m{color:#5b646e}</style></head><body>
      <h1>${xl('Malleol kırığı redüksiyon raporu')}</h1><p class="m">${xl('Araştırma prototipi · klinik kullanım için değil')}</p>
      <p>${esc(St.caseLine ? St.caseLine() : '')}</p>
      <p>${xl('Taraf')}: ${meta.side === 'R' ? xl('Sağ ayak bileği') : meta.side === 'L' ? xl('Sol ayak bileği') : xl('Bilinmiyor')} · ${xl('Kırık tipi')}: ${meta.cls ? esc(xl(meta.cls)) : xl('Seçilmedi')}</p>
      <h2>${xl('Parçalar ve redüksiyon')}</h2><table><tr><th>${xl('Parça')}</th><th>cm³</th><th>${xl('Hareket')}</th><th>${xl('Komşu')}</th><th>${xl('Temas mm²')}</th><th>${xl('Aralık mm')}</th><th>${xl('Çakışma mm')}</th></tr>${rows}</table>
      <h2>${xl('Kontroller')}</h2><ul>${ck || `<li>${xl('Tüm kontroller geçti.')}</li>`}</ul>
      <h2>${xl('Onay')}</h2><p>${xl('Redüksiyon')}: ${red.ok ? `${xl('Onaylı')} · ${esc(red.by)} · ${esc(red.at)}` : xl('Bekliyor')}</p>
      <p>${xl('Mühendis (teknik)')}: ${st('eng')}<br>${xl('Cerrah (klinik)')}: ${st('sur')}</p><p class="m"><small>${xl('Plan özeti (SHA-256):')} ${h}</small></p>
      <p class="m"><small>${xl('Redükte model, parçaların planlanan konumdaki yüzeyleridir (LPS, mm). Plak ön bükme ve eğitim için; doğruluk klinik olarak doğrulanmadı.')}</small></p></body></html>`;
  }
  const packReady = () => { const A = window.Audit; if (!A || !on() || !pieces.length) return false; const h = A.planHash(); return red.ok && A.status('eng', h).ok && A.status('sur', h).ok && !S.crit; };
  function renderOut() {
    const box = $('ankOut'); if (!box) return;
    const ready = packReady(), why = [];
    if (!pieces.length) why.push(xl('parça yok'));
    else { if (!red.ok) why.push(xl('redüksiyon onayı')); const A = window.Audit, h = A ? A.planHash() : ''; if (A && !A.status('eng', h).ok) why.push(xl('mühendis onayı')); if (A && !A.status('sur', h).ok) why.push(xl('cerrah onayı')); if (S.crit) why.push(xl(`${S.crit} kritik kontrol`)); }
    box.innerHTML = `<ol class="deliver">
      <li><div><b>${xl('Redükte model STL\'i')}</b><p class="hint">${xl('Bütün parçalar planlanan konumda, tek dosya. Plak ön bükme için basılabilir; onay gerektirmez.')}</p></div><button id="ankStl" ${pieces.length ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>${xl('İndir')}</button></li>
      <li><div><b>${xl('Parça STL\'leri')}</b><p class="hint">${xl('Her parça ayrı dosya (redükte konumda), .zip içinde.')}</p></div><button id="ankParts" ${pieces.length ? '' : 'disabled'}>${xl('İndir')}</button></li>
      <li><div><b>${xl('Rapor')}</b><p class="hint">${xl('Parçalar, ölçümler, kontroller ve onaylar.')}</p></div><button id="ankRep" ${pieces.length ? '' : 'disabled'}>HTML</button></li>
      <li><div><b>${xl('Paket')}</b><p class="hint" id="ankPackMsg">${ready ? xl('Plan onaylı; paket hazır.') : `${xl('Paket için:')} ${why.join(', ')}.`}</p></div><button class="primary" id="ankPack" ${ready ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>${xl('İndir')}</button></li></ol>`;
    const name = () => fileName($('caseName').value.trim() || 'malleol');
    $('ankStl').addEventListener('click', () => St.offer(`${name()}_redukte_model.stl`, new Blob([reducedStl()])));
    $('ankParts').addEventListener('click', () => St.offer(`${name()}_parcalar.zip`, St.zip(pieceFiles())));
    $('ankRep').addEventListener('click', () => St.offer(`${name()}_rapor.html`, new Blob([reportHTML()], { type: 'text/html' })));
    $('ankPack').addEventListener('click', () => { if (!packReady()) return; St.offer(`${name()}_paket.zip`, St.zip(packFiles())); St.emit('exported'); });
  }
  function packFiles() {
    const files = [{ name: 'redukte_model.stl', data: reducedStl() }, ...pieceFiles(), { name: 'plan.json', data: JSON.stringify(St.planOf(), null, 2) }, { name: 'rapor.html', data: reportHTML() }];
    // the approval log (audit.js); the other export hooks write mandible files (navigation of cuts and screws)
    const extra = []; (window.ExportHooks || []).forEach(f => { try { f(extra); } catch (e) { /* optional */ } });
    extra.filter(f => f.name === 'onay_kaydi.json').forEach(f => files.push(f));
    return files;
  }

  // ---------- plan ----------
  function restore(x) {
    meta = { side: x && ['R', 'L'].includes(x.side) ? x.side : meta.side, cls: x && CLASSES.includes(x.cls) ? x.cls : '' };
    const num = a => Array.isArray(a) && a.every(v => Number.isFinite(+v)) ? a.map(Number) : null;
    pieces.forEach((p, i) => setMotion(i, V(), new T.Quaternion(), false));
    (x && Array.isArray(x.pieces) ? x.pieces : []).slice(0, MAXP).forEach(s => {
      const c = num(s.c), t = num(s.t), q = num(s.q); if (!c || c.length !== 3 || !t || t.length !== 3 || !q || q.length !== 4) return;
      let best = -1, bd = 5; pieces.forEach((p, i) => { const d = p.c.distanceTo(V(...c)); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      const tt = V(...t.map(v => Math.max(-60, Math.min(60, v)))), qq = new T.Quaternion(...q); if (qq.lengthSq() < 1e-6) return;
      setMotion(best, tt, qq, false);
      if (typeof s.name === 'string' && s.name.trim() && s.name !== pieces[best].name) rename(best, s.name, false);
    });
    const r = x && x.red;
    red = r && r.ok && typeof r.by === 'string' ? { ok: true, by: r.by.slice(0, 120), at: typeof r.at === 'string' ? r.at.slice(0, 40) : '', sig: typeof r.sig === 'string' ? r.sig : '' } : { ok: false };
    if (red.ok && red.sig !== sig()) { red = { ok: false }; St.alertMsg(xl('Redüksiyon onayı kayıtlı parça konumlarıyla eşleşmiyor; yeniden onaylayın.')); }
    measure(); renderMeta(); render(); renderOut();
  }
  (window.PlanExt = window.PlanExt || {}).ankle = {
    label: 'Malleol redüksiyonu',
    get: () => (on() ? { side: meta.side, cls: meta.cls, red: red.ok ? { ok: true, by: red.by, at: red.at, sig: red.sig } : { ok: false },
      pieces: pieces.map(p => ({ c: r3(p.c), name: p.name, t: [p.t.x, p.t.y, p.t.z].map(x => Math.round(x * 1000) / 1000), q: [p.q.x, p.q.y, p.q.z, p.q.w].map(x => Math.round(x * 1e6) / 1e6) })) } : null),
    set(x) { if (!x) { if (pieces.length) restore(null); else { meta = { side: '', cls: '' }; red = { ok: false }; } return; } if (x && !on()) CaseType.set('ankle', true); if (!pieces.length || buildJob) { pend = x; return; } restore(x); },
  };

  // ---------- wiring ----------
  bus.addEventListener('bone', () => { if (on()) build(); else if (pieces.length) drop(); });
  // a new volume is a new case: its pieces come with the 'bone' event that came just before (the side found there is kept)
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { meta = { side: autoSide, cls: '' }; red = { ok: false }; } renderMeta(); render(); });
  bus.addEventListener('caseType', () => {
    // a built-in sample of the other case type is swapped for this type's sample (nothing planned on it yet)
    const isAnkle = n => /^ankle/.test(n);
    if (!S.restoring && S.source && S.source.type === 'sample' && isAnkle(S.source.name) !== on() && !S.anchor && !pieces.some(moved) && St.loadSample) {
      drop(); St.loadSample(St.sampleFor ? St.sampleFor(on() ? 'ankle' : 'mandible') : on() ? 'ankle' : 'mandible').catch(e => St.alertMsg(String(e.message || e))); return;
    }
  });
  // bone threshold: ankle joint spaces are narrow, at 250 HU the tibia, talus and fibula of a real CT fuse into one
  // piece (2026-10-21 anonymised ankle CT); 300 HU keeps them apart. Only the other type's default is changed, so a
  // threshold set by hand (or by an opened plan) stays.
  function thrForType() {
    const e = $('thr'); if (!e) return false;
    const want = on() ? THR_ANKLE : THR_MAND, other = on() ? THR_MAND : THR_ANKLE;
    if (+e.value !== other) return false;
    e.value = String(want); if ($('thrO')) $('thrO').textContent = want + ' HU'; return true;
  }
  thrForType();
  bus.addEventListener('caseType', () => {
    // a loaded CT (not a sample, which is swapped above) is segmented again at the new threshold when nothing is planned
    if (thrForType() && !S.restoring && S.red && S.source && S.source.type !== 'sample' && !S.anchor && !pieces.some(moved) && St.segment) St.segment(false);
  });
  bus.addEventListener('caseType', () => { if (on()) { renderMeta(); build(); } else { drop(); const b = St.parts.bone; if (b) { b.visible = true; b.obj.visible = true; St.renderParts(); } } render(); renderOut(); });
  let tmo = null;
  ['changed', 'planApplied', 'lock'].forEach(ev => bus.addEventListener(ev, () => { if (!on()) return; clearTimeout(tmo); tmo = setTimeout(() => { renderAppr(); renderOut(); renderChecks(); }, 120); }));
  ['st2', 'stRed', 'st7', 'stAnkOut'].forEach(id => $(id) && $(id).addEventListener('toggle', () => { if (!on()) return; show(); if (id === 'stAnkOut') renderOut(); }));
  renderMeta(); render(); renderOut();

  const planned = () => on() && pieces.length > 0;
  // for ui.js: step completion and the top bar while the case is an ankle
  function status() {
    const A = window.Audit, h = A && pieces.length ? A.planHash() : '', both = !!(A && pieces.length && A.status('eng', h).ok && A.status('sur', h).ok);
    return { done: { stRed: pieces.length > 0 && pieces.some(moved) && !checks().some(c => c[0] === 'crit'), st7: red.ok && both && !S.crit, stAnkOut: false }, ready: red.ok && both && !S.crit, pend: (red.ok ? 0 : 1) + (A && pieces.length && !A.status('eng', h).ok ? 1 : 0) + (A && pieces.length && !A.status('sur', h).ok ? 1 : 0) };
  }
  return { on, planned, status, renderChecks, checks, pieces: () => pieces, metrics: () => metrics, select: choose, rename, _names: names, setMotion, reset, measure, reducedStl, pieceFiles, reportHTML, packFiles, packReady, approve, build, meta: () => meta, approved: () => red.ok, LIM };
})();
