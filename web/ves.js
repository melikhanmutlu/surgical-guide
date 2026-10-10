/* Vessel and pedicle plan for the fibula flap: donor leg and recipient side, the peroneal vessels drawn along the
   posteromedial fibula from their origin, a perforator with its skin paddle on the lateral leg, and the pedicle
   check: does the pedicle from the graft's proximal end (where the vessels leave it) reach the recipient vessels?
   Vessel positions are anatomical estimates on a non-contrast CT; the surgeon confirms them (Doppler / CTA). */
'use strict';
window.Vessels = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, G, fmt, bus } = St, $ = id => document.getElementById(id);
  const DEF = { donor: null, recip: null, origin: 70, perf: null, padL: 80, padW: 40, rp: null };
  let P = Object.assign({}, DEF), last = null, picking = false, timer = null;
  const legGrp = new THREE.Group(), mGrp = new THREE.Group(); St.scene.add(legGrp, mGrp);
  const side = s => (s === 'L' ? 'sol' : 'sağ');

  const fib = () => (window.Fibula && Fibula.active() ? Fibula.state() : null);
  // fibula local -> leg world (s along the bone, proximal positive)
  function legFrame(F) {
    const c = F.c, [a, e2, e3] = c.FA, off = s => c.off[Math.min(c.off.length - 1, Math.max(0, Math.round(s - c.smin)))];
    const at = (s, y = 0, z = 0) => { const o = off(s); return c.FC.clone().addScaledVector(a, s).addScaledVector(e2, y + o[0]).addScaledVector(e3, z + o[1]); };
    const lat = e2.clone(), post = e3.clone().multiplyScalar(Math.sign(e3.y) || 1);   // e2 runs tibia -> fibula (lateral); LPS +y is posterior
    return { a, lat, post, at, smin: c.smin, smax: c.smax, R: c.FR };
  }
  // first air voxel walking out from the bone (the skin)
  function skinFrom(F, p, dir) {
    const r = F.red;
    for (let t = 4; t < 120; t += 0.5) {
      const q = p.clone().addScaledVector(dir, t), ix = G.indexOf(r, [q.x, q.y, q.z]).map(Math.round);
      if (ix.some((x, k) => x < 0 || x >= [r.nx, r.ny, r.nz][k])) return q;
      if (r.hu[ix[0] + r.nx * (ix[1] + r.ny * ix[2])] < -400) return q;
    }
    return null;
  }
  // recipient vessel estimate: facial artery notch, ~25 mm in front of the gonial angle and 10 mm below it
  function defaultRecipient(s) {
    if (!S.mask || !S.red) return null;
    const r = S.red, ref = window.Ref && Ref.get(), mid = ref ? q => q[0] * ref.n[0] + q[1] * ref.n[1] + q[2] * ref.n[2] - ref.d : null;
    let cx = 0, cnt = 0; if (!mid) for (let v = 0; v < S.mask.length; v += 7) if (S.mask[v]) { cx += G.worldOf(r, v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0)[0]; cnt++; }
    const sd = q => (mid ? mid(q) : q[0] - cx / cnt);
    let best = null, bv = -Infinity;
    for (let v = 0; v < S.mask.length; v++) {
      if (!S.mask[v]) continue;
      const q = G.worldOf(r, v % r.nx, ((v / r.nx) | 0) % r.ny, (v / (r.nx * r.ny)) | 0), d = sd(q);
      if (s === 'R' ? d > -20 : d < 20) continue;        // LPS: patient right is -x
      const score = q[1] - q[2]; if (score > bv) { bv = score; best = q; }
    }
    return best ? [best[0], best[1] - 25, best[2] - 10].map(x => Math.round(x * 10) / 10) : null;
  }

  function compute() {
    last = null;
    const st = fib(); if (!st || !st.F || !st.F.c || !st.last || !st.last.segs.length) return null;
    const F = st.F, L = legFrame(F), segs = st.last.segs;
    if (!P.donor) P.donor = F.c.FC.x > 0 ? 'L' : 'R';
    if (!P.recip) { const E = St.resEnds(); P.recip = E && E.B.p.x > (E.A.p.x) ? 'L' : 'R'; }
    const rp = P.rp || defaultRecipient(P.recip);
    const sProx = segs[segs.length - 1].s1, sDist = segs[0].s0, sOrigin = L.smax - P.origin;
    if (P.perf == null) P.perf = Math.round((sDist + sProx) / 2 - L.smin);   // start over the middle of the graft
    const sPerf = L.smin + P.perf;
    const exit = segs[segs.length - 1].P1.clone();              // the graft's proximal end sits at this end of the defect
    const avail = sOrigin - sProx, need = rp ? exit.distanceTo(V(...rp)) : null;
    const perfSeg = segs.findIndex(g => sPerf >= g.s0 && sPerf <= g.s1);
    // vessel line: posteromedial to the bone, from the origin to the distal end
    const pm = L.post.clone().sub(L.lat).normalize(), path = [];
    for (let s = Math.min(sOrigin, L.smax); s >= L.smin + 20; s -= 8) path.push(L.at(s).addScaledVector(pm, L.R + 3));
    // perforator through the posterior crural septum to the lateral skin; skin paddle centred on it
    const pf0 = L.at(sPerf).addScaledVector(pm, L.R + 3), septum = L.lat.clone().add(L.post.clone().multiplyScalar(0.35)).normalize();
    const skin = skinFrom(F, L.at(sPerf), septum);
    last = { L, rp, exit, avail, need, sProx, sDist, sOrigin, sPerf, perfSeg, path, pf0, skin, septum, segs };
    return last;
  }

  // ---------- drawing ----------
  const clear = g => { while (g.children.length) { const c = g.children.pop(); c.traverse(x => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); }); } };
  const line = (pts, color, dashed) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts), m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, depthTest: false, transparent: true }) : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); l.renderOrder = 8; return l;
  };
  const ball = (p, color, r = 1.6) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })); m.position.copy(p); m.renderOrder = 9; return m; };
  function draw() {
    clear(legGrp); clear(mGrp);
    const R = last; if (!R) { St.render(); return; }
    const L = R.L;
    if (R.path.length > 1) legGrp.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(R.path), R.path.length * 2, 1.4, 8, false), new THREE.MeshStandardMaterial({ color: 0xc8323c, roughness: 0.5 })));
    legGrp.add(ball(L.at(R.sOrigin).addScaledVector(L.post.clone().sub(L.lat).normalize(), L.R + 3), 0xc8323c, 2.2));
    if (R.skin) {
      legGrp.add(line([R.pf0, R.skin], 0xff6b6b));
      const w = V().crossVectors(R.septum, L.a).normalize(), pts = [];
      for (let k = 0; k <= 64; k++) { const t = k / 64 * Math.PI * 2; pts.push(R.skin.clone().addScaledVector(L.a, Math.cos(t) * P.padL / 2).addScaledVector(w, Math.sin(t) * P.padW / 2).addScaledVector(R.septum, 1)); }
      legGrp.add(line(pts, 0xf2a65a)); legGrp.add(ball(R.skin, 0xff6b6b, 1.8));
    }
    legGrp.traverse(o => o.layers.set(1));
    // mandible side: where the pedicle leaves the graft and where it must reach
    mGrp.add(ball(R.exit, 0xc8323c, 2));
    if (R.rp) { const rp = V(...R.rp); mGrp.add(ball(rp, 0xc8323c, 2.2)); mGrp.add(line([R.exit, rp], 0xc8323c, true)); }
    St.render();
  }
  // labels next to the 3D markers
  const labels = document.createElement('div'); labels.className = 'markers'; document.querySelector('.stagewrap').appendChild(labels);
  const pv = V();
  function place() {
    const R = last, cam = St.camera, rect = St.renderer.domElement.getBoundingClientRect(), host = labels.getBoundingClientRect(), w = S.split ? rect.width / 2 : rect.width;
    if (!R || (cam.layers.isEnabled(1) && !S.split)) {
      // leg view: label the perforator and the vessel origin
      if (!R || !cam.layers.isEnabled(1)) { labels.innerHTML = ''; return; }
      const items = [[R.skin, 'Perforatör / deri adası'], [R.L.at(R.sOrigin), 'Peroneal arter çıkışı']].filter(x => x[0]);
      labels.innerHTML = items.map(([p, t]) => { pv.copy(p).project(cam); if (!(pv.z < 1 && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1)) return ''; return `<span class="mk ref ves" style="left:${rect.left - host.left + (pv.x + 1) / 2 * rect.width + 10}px;top:${rect.top - host.top + (1 - pv.y) / 2 * rect.height - 10}px">${t}</span>`; }).join('');
      return;
    }
    const items = [[R.exit, 'Pedikül çıkışı']].concat(R.rp ? [[V(...R.rp), 'Alıcı damar']] : []);
    labels.innerHTML = items.map(([p, t]) => { pv.copy(p).project(cam); if (!(pv.z < 1 && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1)) return ''; return `<span class="mk ref ves" style="left:${rect.left - host.left + (pv.x + 1) / 2 * w + 10}px;top:${rect.top - host.top + (1 - pv.y) / 2 * rect.height - 10}px">${t}</span>`; }).join('');
  }
  if (window.UI) { const f = UI.onRender; UI.onRender = (...a) => { if (f) f(...a); place(); }; }

  // ---------- recipient point by clicking ----------
  const prevTools = window.Tools;
  window.Tools = {
    click(e, ray) {
      if (picking) {
        const t = ['bone', 'resected'].filter(k => St.parts[k] && St.parts[k].visible).map(k => St.parts[k].obj), h = ray.intersectObjects(t, false)[0];
        if (!h) return true;
        P.rp = h.point.toArray().map(x => Math.round(x * 10) / 10); picking = false; $('modeBadge').hidden = true; changed(); return true;
      }
      return prevTools ? prevTools.click(e, ray) : false;
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && picking) { picking = false; $('modeBadge').hidden = true; } });

  // ---------- summary, checks, report ----------
  function summary() {
    const R = last; if (!R) return null;
    return { verici_bacak: side(P.donor), alici_taraf: side(P.recip), pedikul_mevcut_mm: Math.round(R.avail), pedikul_gerekli_mm: R.need == null ? null : Math.round(R.need),
      perforator_distalden_mm: P.perf, perforator_segmenti: R.perfSeg >= 0 ? R.perfSeg + 1 : null, deri_adasi_mm: [P.padL, P.padW], arter_cikisi_fibula_basindan_mm: P.origin,
      alici_nokta: R.rp, alici_nokta_tahmini: !P.rp };
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const R = last, out = []; if (!R) return out;
    if (R.avail < 0) out.push(['crit', 'Kritik', 'Greftin proksimal ucu peroneal arter çıkışının üstünde; greft distale kaydırılmalı.', 'fib']);
    else if (R.need != null && R.avail < R.need) out.push(['crit', 'Kritik', `Pedikül yetmiyor: ${fmt(R.avail, 0)} mm mevcut, alıcı damara ${fmt(R.need, 0)} mm gerekli. Greft dizilimini ters çevirin, distal korunan boyu azaltın ya da ven grefti planlayın.`, 'fib']);
    else if (R.need != null && R.avail < R.need + 15) out.push(['warn', 'Uyarı', `Pedikül payı az: ${fmt(R.avail, 0)} mm mevcut, ${fmt(R.need, 0)} mm gerekli (gerilimsiz anastomoz için ≥ 15 mm pay önerilir).`, 'fib']);
    if (R.perfSeg < 0) out.push(['warn', 'Uyarı', 'Perforatör greft segmentlerinin dışında kalıyor; deri adası kemikle birlikte taşınamaz.', 'fib']);
    if (!R.rp) out.push(['info', 'Bilgi', 'Alıcı damar noktası bulunamadı; elle seçin.', 'fib']);
    const st = fib(); if (st && P.donor && (st.F.c.FC.x > 0 ? 'L' : 'R') !== P.donor) out.push(['info', 'Bilgi', `Verici bacak ${side(P.donor)} seçili, BT'deki fibula ${side(st.F.c.FC.x > 0 ? 'L' : 'R')} tarafta görünüyor.`, 'fib']);
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(330); d.h2('Damar ve pedikül planı');
    d.table(['Ölçü', 'Değer'], [['Verici bacak / alıcı taraf', `${s.verici_bacak} / ${s.alici_taraf}`], ['Pedikül (mevcut / gerekli)', `${s.pedikul_mevcut_mm} / ${s.pedikul_gerekli_mm ?? '–'} mm`], ['Perforatör', `distal uçtan ${s.perforator_distalden_mm} mm${s.perforator_segmenti ? `, segment ${s.perforator_segmenti}` : ', greft dışında'}`], ['Deri adası', `${s.deri_adasi_mm[0]} × ${s.deri_adasi_mm[1]} mm`], ['Peroneal arter çıkışı', `fibula başından ${s.arter_cikisi_fibula_basindan_mm} mm (tahmini)`]], [0.45, 0.55]);
    d.text('Damar konumları kontrastsız BT üzerinde anatomik tahmindir; perforatör Doppler ya da BT anjiyografi ile doğrulanmalıdır.', { size: 20, color: '#5b646e' });
  });
  (window.ExportHooks = window.ExportHooks || []).push(files => { const s = summary(); if (s) files.push({ name: 'damar_pedikul_plani.json', data: JSON.stringify(s, null, 2) }); });

  // ---------- panel ----------
  const F = [['perf', 'Perforatör (distal uçtan)', 40, 300, 1, 'mm'], ['padL', 'Deri adası boyu', 30, 200, 5, 'mm'], ['padW', 'Deri adası eni', 15, 90, 5, 'mm'], ['origin', 'Arter çıkışı', 30, 120, 1, 'mm']];
  function render() {
    const st = fib(), s = summary();
    if (!st) { $('vesBox').innerHTML = ''; return; }
    if (!$('vsDonor')) {
      $('vesBox').innerHTML = `<h3 class="sub">Damar ve pedikül</h3>
        <div class="ctl"><label for="vsDonor" class="lbl2">Verici bacak</label><select id="vsDonor" data-seg><option value="R">Sağ bacak</option><option value="L">Sol bacak</option></select></div>
        <div class="ctl"><label for="vsRecip" class="lbl2">Alıcı taraf (boyun)</label><select id="vsRecip" data-seg><option value="R">Sağ</option><option value="L">Sol</option></select></div>
        ${F.map(([k, t, mn, mx, stp, un]) => `<div class="ctl"><div class="ctl-row"><label for="vs_${k}">${t}</label><output id="vso_${k}"></output></div><input type="range" id="vs_${k}" min="${mn}" max="${mx}" step="${stp}"></div>`).join('')}
        <div class="btns"><button id="vsPick"><svg class="i"><use href="#i-target"/></svg>Alıcı damar noktasını seç</button><button id="vsAuto">Tahmini noktaya dön</button></div>
        <dl class="kv" id="vsSum"></dl>
        <p class="hint more">Kırmızı: peroneal damarlar ve pedikül. Turuncu: deri adası. Damar konumları kontrastsız BT'de tahminidir; Doppler ya da BT anjiyografi ile doğrulayın.</p>`;
      $('vsDonor').addEventListener('change', e => { P.donor = e.target.value; changed(); });
      $('vsRecip').addEventListener('change', e => { P.recip = e.target.value; P.rp = null; changed(); });
      F.forEach(([k, , , , , un]) => $('vs_' + k).addEventListener('input', e => { P[k] = +e.target.value; $('vso_' + k).textContent = `${P[k]} ${un}`; later(); St.emit('changed'); }));
      $('vsPick').addEventListener('click', () => { if (window.SegEdit) SegEdit.off(); if (window.Measure && Measure.active()) $('toolMeasure').click(); picking = true; const mb = $('modeBadge'); mb.hidden = false; mb.textContent = 'Alıcı damar noktasına (ör. fasiyal arter çentiği) mandibula görünümünde tıklayın. Vazgeçmek için Esc.'; if (window.Fibula && Fibula.view() !== 'm') $('scM').click(); });
      $('vsAuto').addEventListener('click', () => { P.rp = null; changed(); });
    }
    $('vsDonor').value = P.donor || 'R'; $('vsRecip').value = P.recip || 'R';
    F.forEach(([k, , , , , un]) => { if (document.activeElement !== $('vs_' + k)) $('vs_' + k).value = P[k]; $('vso_' + k).textContent = `${P[k]} ${un}`; });
    $('vsAuto').disabled = !P.rp;
    $('vsSum').innerHTML = s ? `<dt>Pedikül</dt><dd>${s.pedikul_mevcut_mm} mm mevcut · ${s.pedikul_gerekli_mm ?? '–'} mm gerekli</dd><dt>Pedikül çıkışı</dt><dd>greftin proksimal ucu</dd><dt>Perforatör</dt><dd>${s.perforator_segmenti ? 'segment ' + s.perforator_segmenti : 'greft dışında'}</dd><dt>Alıcı nokta</dt><dd>${s.alici_nokta_tahmini ? 'tahmini' : 'elle seçildi'}</dd>` : '<dt>Durum</dt><dd>fibula planı bekleniyor</dd>';
  }
  function update() { try { compute(); } catch (e) { last = null; } draw(); render(); St.renderChecks(); St.renderAppr(); }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 250); };
  function changed() { update(); St.emit('changed'); }

  // a stored plan is untrusted input: keep only known keys, with the default's type
  const clean = x => { const o = Object.assign({}, DEF); if (x && typeof x === 'object') for (const k in DEF) { if (!(k in x)) continue; const d = DEF[k], v = x[k];
    if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n)) o[k] = n; } else if (typeof d === 'boolean') o[k] = !!v; else if (typeof d === 'string') { if (typeof v === 'string') o[k] = v.slice(0, 60); } else if (v === null) o[k] = null;
    else if (typeof v === 'string') o[k] = v.slice(0, 8); else if (Number.isFinite(v)) o[k] = v;
    else if (Array.isArray(v) && v.length <= 4 && v.every(Number.isFinite)) o[k] = v.slice(); } return o; };
  (window.PlanExt = window.PlanExt || {}).ves = {
    label: 'Damar ve pedikül planı',
    get: () => (fib() ? Object.assign({}, P) : null),
    set(x) { P = clean(x); ['donor', 'recip'].forEach(k => { if (P[k] !== 'R' && P[k] !== 'L') P[k] = null; }); if (P.rp && P.rp.length !== 3) P.rp = null; update(); },
  };
  bus.addEventListener('changed', () => { if (!S.restoring) later(); });
  bus.addEventListener('parts', () => { if (!S.restoring) later(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { P = Object.assign({}, DEF); last = null; draw(); render(); } });
  render();
  return { summary, compute, get: () => last, params: () => P, update };
})();
