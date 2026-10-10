/* Dental implant plan on the fibula grafts: implant cylinders (diameter, length, axis) placed on a graft segment,
   by default along the occlusal direction. Bone coverage is sampled on the implant surface and 1 mm outside it
   in the transplanted graft and the remaining mandible, so dehiscence, thin walls, implants on an osteotomy line
   and crowded implants are flagged. The plan is saved with the case (PlanExt). */
'use strict';
window.Implants = (function () {
  const St = window.Studio; if (!St || !window.Fibula) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id), deg = THREE.MathUtils.degToRad, r2d = THREE.MathUtils.radToDeg;
  const COLOR = 0x9aa3ad, DEF = { d: 4.0, len: 10, tb: 0, tm: 0 };
  // sample thresholds; the clinical team sets the final values
  const LIM = { cov: 0.95, covCrit: 0.75, wall: 0.8, joint: 1.5, gap: 3, tilt: 25 };
  let list = [], sel = -1, picking = false, last = [], timer = null, msgText = '';

  const fib = () => (Fibula.active() ? Fibula.state() : null);
  // remaining mandible: bone field minus the resected piece
  function mandBone(q) {
    if (!St.boneAt(q)) return false;
    if (!S.resMask) return true;
    const r = S.red, ix = G.indexOf(r, [q.x, q.y, q.z]).map(Math.round);
    if (ix.some((x, k) => x < 0 || x >= [r.nx, r.ny, r.nz][k])) return true;
    return !S.resMask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])];
  }
  function inBone(q, segs) { for (let i = 0; i < segs.length; i++) if (Fibula.graftBone(i, q)) return true; return mandBone(q); }

  // implant frame on its segment: occlusal axis tilted bucco-lingually (about the segment axis) and mesio-distally
  function geom(im, st) {
    const segs = st.last.segs, g = segs[Math.min(segs.length - 1, im.seg)], vup = st.last.D.vup, FR = st.F.c.FR;
    const x = g.x, up = vup.clone().sub(x.clone().multiplyScalar(vup.dot(x))).normalize(), side = V().crossVectors(x, up);
    const ax = up.clone().applyAxisAngle(x, deg(im.tb)).applyAxisAngle(side, deg(im.tm)).normalize();
    const c = g.P0.clone().addScaledVector(x, Math.max(0, Math.min(g.L, im.t)));
    const top = c.clone().addScaledVector(ax, FR + 15); let entry = null;
    for (let t = 0; t < FR + 35; t += 0.2) { const q = top.clone().addScaledVector(ax, -t); if (Fibula.graftBone(g.i, q)) { entry = q; break; } }
    return { g, ax, entry, x, up };
  }
  function evaluate(im, st) {
    const G0 = geom(im, st), segs = st.last.segs; if (!G0.entry) return Object.assign(G0, { ok: false });
    const { ax, entry, g } = G0, [e1, e2] = (() => { const t = Math.abs(ax.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), a = V().crossVectors(ax, t).normalize(); return [a, V().crossVectors(ax, a)]; })();
    let n = 0, inS = 0, inW = 0; const q = V();
    for (let t = 0.5; t <= im.len + 1e-6; t += 0.5) for (let k = 0; k < 12; k++) {
      const a = k / 12 * 2 * Math.PI, rd = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const base = entry.clone().addScaledVector(ax, -t); n++;
      if (inBone(q.copy(base).addScaledVector(rd, im.d / 2), segs)) inS++;
      if (inBone(q.copy(base).addScaledVector(rd, im.d / 2 + 1), segs)) inW++;
    }
    const mid = entry.clone().addScaledVector(ax, -im.len / 2), apex = entry.clone().addScaledVector(ax, -im.len);
    // closest osteotomy plane of this segment (the implant body must stay clear of the bone junction)
    const dj = Math.min(...[[g.P0, g.N0], [g.P1, g.N1]].map(([p, N]) => Math.min(...[entry, mid, apex].map(z => Math.abs(z.clone().sub(p).dot(N))))) ) - im.d / 2;
    return Object.assign(G0, { ok: true, cov: inS / n, wall: inW / n, joint: dj, tilt: r2d(ax.angleTo(st.last.D.vup)), apex });
  }
  function compute() {
    const st = fib(); last = [];
    if (!st || !st.last) return;
    list.forEach(im => { try { last.push(evaluate(im, st)); } catch (e) { last.push({ ok: false }); } });
    last.forEach((a, i) => { a.near = Infinity; last.forEach((b, j) => { if (i !== j && a.ok && b.ok) a.near = Math.min(a.near, a.entry.distanceTo(b.entry) - list[i].d / 2 - list[j].d / 2); }); });
  }

  // ---------- 3D ----------
  function draw() {
    if (!last.length) { St.setPart('implants', null, null); St.render(); return; }
    const grp = new THREE.Group();
    last.forEach((r, i) => {
      if (!r.ok) return; const im = list[i];
      const m = new THREE.Mesh(new THREE.CylinderGeometry(im.d / 2, im.d / 2 * 0.85, im.len, 24), St.mat(COLOR, { metalness: 0.45, roughness: 0.35, emissive: i === sel ? 0x333333 : 0 }));
      m.position.copy(r.entry.clone().addScaledVector(r.ax, -im.len / 2)); m.quaternion.setFromUnitVectors(V(0, 1, 0), r.ax); m.userData.impl = i; grp.add(m);
      // prosthetic axis above the platform
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([r.entry, r.entry.clone().addScaledVector(r.ax, 12)]), new THREE.LineDashedMaterial({ color: 0x5b646e, dashSize: 1.5, gapSize: 1 }));
      l.computeLineDistances(); grp.add(l);
    });
    St.setPart('implants', 'İmplantlar', grp, COLOR); St.renderParts(); St.render();
  }

  // ---------- picking on a graft ----------
  const prevTools = window.Tools;
  window.Tools = {
    click(e, ray) {
      if (picking) {
        const gp = St.parts.grafts; if (!gp) return true;
        const h = ray.intersectObjects(gp.obj.children.filter(c => c.isMesh), false)[0]; if (!h) return true;
        const st = fib(), seg = h.object.userData.seg, g = st && st.last.segs[seg]; if (!g) return true;
        add({ seg, t: Math.round(h.point.clone().sub(g.P0).dot(g.x) * 2) / 2 });
        picking = false; $('modeBadge').hidden = true; return true;
      }
      return prevTools ? prevTools.click(e, ray) : false;
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && picking) { picking = false; $('modeBadge').hidden = true; } });

  // next implant: the longest free stretch on any lower segment, keeping clear of the segment ends
  function freeSpot() {
    const st = fib(); if (!st || !st.last) return null;
    let best = null;
    st.last.segs.forEach((g, i) => {
      const taken = list.filter(im => im.seg === i).map(im => im.t).sort((a, b) => a - b), pts = [0, ...taken, g.L];
      for (let k = 0; k < pts.length - 1; k++) { const room = pts[k + 1] - pts[k]; if (!best || room > best.room) best = { seg: i, t: (pts[k] + pts[k + 1]) / 2, room }; }
    });
    return best && { seg: best.seg, t: Math.round(best.t * 2) / 2 };
  }
  // ---------- automatic placement ----------
  // tooth positions every PITCH mm along the graft that carries the teeth (the upper barrel when there is one), clear
  // of the segment ends; at each position the widest and longest catalogue implant that passes every check is kept,
  // shifting up to 3 mm along the segment to stay off the plate screws. Positions where nothing fits are left out.
  const AUTO = { pitch: 7.5, d: [4.8, 4.1, 3.75, 3.3], len: [13, 11.5, 10, 8.5, 7], screwGap: 1.5, max: 6 };
  function plateScrews() {
    const R = window.Plate && Plate.get(); if (!R) return [];
    return R.holes.filter(h => h.usable).map(h => ({ a: h.p, b: h.p.clone().addScaledVector(h.n, -(h.len || 12)) }));
  }
  function segDist(a0, a1, b0, b1) {
    let m = Infinity; const p = V(), q = V();
    for (let i = 0; i <= 12; i++) { p.copy(a0).lerp(a1, i / 12); for (let j = 0; j <= 12; j++) m = Math.min(m, p.distanceTo(q.copy(b0).lerp(b1, j / 12))); }
    return m;
  }
  function passes(r, im, scr) {
    if (!r.ok || r.cov < LIM.cov || r.wall < LIM.wall || r.joint < LIM.joint) return false;
    return scr.every(c => segDist(r.entry, r.apex, c.a, c.b) >= im.d / 2 + AUTO.screwGap);
  }
  function autoPlace() {
    const st = fib(); if (!st || !st.last) return 0;
    const segs = st.last.segs, top = segs.some(g => g.barrel) ? segs.filter(g => g.barrel) : segs, scr = plateScrews(), out = [];
    for (const g of top) {
      const m = LIM.joint + AUTO.d[0] / 2 + 1, room = g.L - 2 * m; if (room < 0) continue;
      const k = Math.floor(room / AUTO.pitch) + 1, start = (g.L - (k - 1) * AUTO.pitch) / 2;
      for (let j = 0; j < k && out.length < AUTO.max; j++) {
        const t0 = start + j * AUTO.pitch; let pick = null;
        for (const d of AUTO.d) { for (const len of AUTO.len) { for (const dt of [0, 1.5, -1.5, 3, -3]) {
          const t = Math.round((t0 + dt) * 2) / 2; if (t < d / 2 + LIM.joint || t > g.L - d / 2 - LIM.joint) continue;
          const im = Object.assign({}, DEF, { seg: g.i, t, d, len }); let r; try { r = evaluate(im, st); } catch (e) { continue; }
          if (out.some(o => Math.abs(o.t - t) < (o.d + d) / 2 + LIM.gap && o.seg === g.i)) continue;
          if (passes(r, im, scr)) { pick = im; break; }
        } if (pick) break; } if (pick) break; }
        if (pick) out.push(pick);
      }
    }
    list = out; sel = list.length - 1; changed();
    return { placed: out.length, tried: top.reduce((a, g) => a + Math.max(0, Math.floor((g.L - 2 * (LIM.joint + AUTO.d[0] / 2 + 1)) / AUTO.pitch) + 1), 0) };
  }
  function add(at) { if (!at) return; list.push(Object.assign({}, DEF, at)); sel = list.length - 1; changed(); }

  // ---------- checks, report, export ----------
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [];
    last.forEach((r, i) => {
      const nm = `İmplant ${i + 1}`;
      if (!r.ok) { out.push(['crit', 'Kritik', `${nm} greft kemiğine ulaşmıyor; konumunu ya da eğimini değiştirin.`, 'fib']); return; }
      if (r.cov < LIM.covCrit) out.push(['crit', 'Kritik', `${nm} yüzeyinin yalnız %${fmt(r.cov * 100, 0)}'i kemikte; implant greftten taşıyor.`, 'fib']);
      else if (r.cov < LIM.cov) out.push(['warn', 'Uyarı', `${nm} yüzeyinin %${fmt(r.cov * 100, 0)}'i kemikte (örnek eşik %${LIM.cov * 100}); dehisens ya da perforasyon olabilir.`, 'fib']);
      if (r.wall < LIM.wall) out.push(['warn', 'Uyarı', `${nm} çevresinde 1 mm kemik duvarı yüzeyin yalnız %${fmt(r.wall * 100, 0)}'inde var; daha ince implant ya da eğim düşünün.`, 'fib']);
      if (r.joint < LIM.joint) out.push(['warn', 'Uyarı', `${nm} osteotomi hattına ${fmt(Math.max(0, r.joint))} mm yakın (örnek eşik ${fmt(LIM.joint)} mm).`, 'fib']);
      if (r.near < LIM.gap) out.push(['warn', 'Uyarı', `${nm} komşu implanta ${fmt(Math.max(0, r.near))} mm yakın; implantlar arası en az ${LIM.gap} mm önerilir.`, 'fib']);
      if (r.tilt > LIM.tilt) out.push(['info', 'Bilgi', `${nm} oklüzal yönden ${fmt(r.tilt, 0)}° eğik; açılı abutment gerekebilir.`, 'fib']);
    });
    return out;
  });
  function summary() {
    if (!last.length) return null;
    return last.map((r, i) => ({ no: i + 1, segment: list[i].seg + 1, konum_mm: list[i].t, cap_mm: list[i].d, boy_mm: list[i].len, egim_deg: [list[i].tb, list[i].tm],
      kemik_ortusu: r.ok ? +r.cov.toFixed(2) : null, duvar_1mm: r.ok ? +r.wall.toFixed(2) : null, osteotomiye_mm: r.ok ? +r.joint.toFixed(1) : null,
      platform_lps_mm: r.ok ? r.entry.toArray().map(x => +x.toFixed(2)) : null, apeks_lps_mm: r.ok ? r.apex.toArray().map(x => +x.toFixed(2)) : null, eksen: r.ok ? r.ax.toArray().map(x => +x.toFixed(4)) : null }));
  }
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(300); d.h2('Dental implant planı');
    d.table(['İmplant', 'Segment / konum', 'Çap × boy', 'Eğim', 'Kemik örtüsü', '1 mm duvar'], s.map(x => [`İmplant ${x.no}`, `${x.segment} / ${fmt(x.konum_mm)} mm`, `${fmt(x.cap_mm)} × ${fmt(x.boy_mm)} mm`, `${x.egim_deg[0]}° / ${x.egim_deg[1]}°`, x.kemik_ortusu == null ? '–' : `%${fmt(x.kemik_ortusu * 100, 0)}`, x.duvar_1mm == null ? '–' : `%${fmt(x.duvar_1mm * 100, 0)}`]), [0.15, 0.2, 0.17, 0.14, 0.17, 0.17]);
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'implant_plani.json', data: JSON.stringify(s, null, 2) }); });

  // ---------- panel ----------
  const F = [['t', 'Konum (baştan)', 0, 60, 0.5, 'mm'], ['d', 'Çap', 3, 6, 0.1, 'mm'], ['len', 'Boy', 6, 16, 0.5, 'mm'], ['tb', 'Eğim (bukkal-lingual)', -89, 89, 1, '°'], ['tm', 'Eğim (mezial-distal)', -89, 89, 1, '°']];
  function render() {
    const box = $('implBox'); if (!box) return;
    const st = fib();
    if (!st || !st.last) { box.innerHTML = ''; return; }
    if (box.contains(document.activeElement) && document.activeElement.type === 'range') { renderTable(); return; }
    if (sel >= list.length) sel = list.length - 1;
    const im = list[sel], segs = st.last.segs;
    box.innerHTML = `<h3 class="sub">Dental implant</h3>
      <div class="btns"><button id="imAuto" class="accent"><svg class="i"><use href="#i-spark"/></svg>Otomatik yerleştir</button><button id="imPick"><svg class="i"><use href="#i-target"/></svg>Grefte tıkla</button></div>
      <p class="hint" id="imMsg">${msgText}</p>
      <div class="el-row"><div class="el-list" id="imList" role="group" aria-label="İmplantlar">${list.map((x, i) => `<button class="el ${i === sel ? 'on' : ''}" data-i="${i}" aria-pressed="${i === sel}">İmplant ${i + 1}</button>`).join('')}</div><button id="imAdd" class="ghost sm" title="İmplant ekle"><svg class="i"><use href="#i-plus"/></svg>İmplant</button></div>
      ${im ? `<div class="ctl"><label for="imSeg" class="lbl2">Hangi segment</label><select id="imSeg">${segs.map((g, i) => `<option value="${i}" ${i === im.seg ? 'selected' : ''}>Segment ${i + 1}${g.barrel ? ' (üst)' : ''} · ${fmt(g.L)} mm</option>`).join('')}</select></div>
      ${F.map(([k, t, mn, mx, stp, un]) => `<div class="ctl"><div class="ctl-row"><label for="im_${k}">${t}</label><output id="imo_${k}">${fmt(im[k], stp < 1 ? 1 : 0)} ${un}</output></div><input type="range" id="im_${k}" min="${mn}" max="${k === 't' ? Math.ceil(segs[Math.min(im.seg, segs.length - 1)].L) : mx}" step="${stp}" value="${im[k]}"></div>`).join('')}
      <div class="btns"><button id="imDel" class="sm"><svg class="i"><use href="#i-trash"/></svg>İmplantı sil</button></div>` : ''}
      <div id="imTbl"></div>
      <p class="hint more">İmplant ekseni varsayılan olarak oklüzal yöndedir. Kemik örtüsü implant yüzeyinde, duvar 1 mm dışında greft ve kalan mandibula içinde örneklenir.</p>`;
    renderTable();
    $('imAdd').addEventListener('click', () => add(freeSpot()));
    $('imAuto').addEventListener('click', () => {
      if (list.length && !confirm('Mevcut implantlar silinip otomatik yerleşimle değiştirilsin mi?')) return;
      St.busy(true, 'İmplantlar yerleştiriliyor…');
      setTimeout(() => { try { const r = autoPlace(); msgText = r.placed ? `${r.placed} implant yerleştirildi${r.tried > r.placed ? `; ${r.tried - r.placed} diş konumunda kontrolleri geçen implant bulunamadı` : ''}. Çap ve boy greft kalınlığına göre seçildi, plak vidalarından uzak tutuldu.` : 'Greft üzerinde kontrolleri geçen implant konumu bulunamadı.'; render(); } finally { St.busy(false); } }, 30);
    });
    $('imPick').addEventListener('click', () => { picking = true; const mb = $('modeBadge'); mb.hidden = false; mb.textContent = 'İmplant yeri için mandibula görünümünde bir fibula greftine tıklayın. Vazgeçmek için Esc.'; if (Fibula.view() !== 'm') $('scM').click(); });
    box.querySelectorAll('#imList button').forEach(b => b.addEventListener('click', () => { sel = +b.dataset.i; render(); draw(); }));
    if (!im) return;
    $('imSeg').addEventListener('change', e => { im.seg = +e.target.value; im.t = Math.min(im.t, segs[im.seg].L / 2); changed(); });
    F.forEach(([k, , , , stp, un]) => { const el = $('im_' + k);
      el.addEventListener('input', () => { im[k] = +el.value; $('imo_' + k).textContent = `${fmt(im[k], stp < 1 ? 1 : 0)} ${un}`; update(); });
      el.addEventListener('change', () => { el.blur(); changed(); }); });
    $('imDel').addEventListener('click', () => { list.splice(sel, 1); sel = list.length - 1; changed(); });
  }
  function renderTable() {
    const el = $('imTbl'); if (!el) return;
    el.innerHTML = last.length ? `<div class="tbl"><table><thead><tr><th>İmplant</th><th>Örtü</th><th>1 mm duvar</th><th>Osteotomiye</th></tr></thead><tbody>${last.map((r, i) => r.ok ? `<tr><td>${i + 1}</td><td>%${fmt(r.cov * 100, 0)}</td><td>%${fmt(r.wall * 100, 0)}</td><td>${fmt(Math.max(0, r.joint))} mm</td></tr>` : `<tr><td>${i + 1}</td><td colspan="3">kemiğe ulaşmıyor</td></tr>`).join('')}</tbody></table></div>` : '';
  }
  function update() { compute(); draw(); renderTable(); St.renderChecks(); }
  function changed() { update(); render(); St.emit('changed'); }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { update(); render(); }, 250); };

  (window.PlanExt = window.PlanExt || {}).impl = {
    label: 'Dental implant planı',
    get: () => (list.length ? list.map(x => Object.assign({}, x)) : null),
    set(x) { list = Array.isArray(x) ? x.map(y => Object.assign({}, DEF, y)) : []; sel = list.length - 1; update(); render(); },
  };
  ['parts', 'fibGuide'].forEach(e => bus.addEventListener(e, () => { if (!S.restoring) later(); }));
  bus.addEventListener('changed', () => { if (!S.restoring && !$('implBox').contains(document.activeElement)) later(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { list = []; sel = -1; last = []; draw(); render(); } });
  render();
  return { summary, list: () => list, get: () => last, add, freeSpot, update, autoPlace };
})();
