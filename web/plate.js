/* Reconstruction plate: a plate line walked along the outer bone surface (remaining bone plus fibula grafts, or the
   intact contour when there is no graft), a swept plate with holes at the system's spacing, holes too close to a cut
   marked unusable, guide screws placed on plate holes (pre-drilled holes then match the pre-bent plate), and a
   pre-bending model STL. */
'use strict';
window.Plate = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, fmt, bus } = St, $ = id => document.getElementById(id);
  const COLOR = 0xb8c2cc;
  const SYSTEMS = {
    recon24: { name: '2.4 rekonstrüksiyon', w: 7, t: 2.5, pitch: 8, d: 2.4 },
    mini20: { name: '2.0 mini', w: 5, t: 1.0, pitch: 6, d: 2.0 },
    custom: { name: 'Özel' },
  };
  // screw lengths each system offers (mm); a hole gets the shortest that passes the far cortex by 1 mm
  const LENS = { recon24: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24], mini20: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], custom: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] };
  const JOINT_GAP = 3;
  const DEF = { on: false, sys: 'recon24', h: 0, ext: 25, w: 7, t: 2.5, pitch: 8, d: 2.4, shift: 0 };
  let P = Object.assign({}, DEF), last = null, timer = null;

  // ---------- surface walk ----------
  function targets() {
    const out = [], pt = St.parts;
    if (pt.bone) out.push([pt.bone.obj, 'bone']);
    if (pt.grafts && pt.grafts.obj.children.length) pt.grafts.obj.children.forEach(c => c.isMesh && out.push([c, 'graft']));
    else if (pt.resected) out.push([pt.resected.obj, 'defect']);
    return out;
  }
  const rc = new THREE.Raycaster();
  function snap(q, n, T) {
    for (const lift of [10, 22]) {
      rc.set(q.clone().addScaledVector(n, lift), n.clone().negate()); rc.far = lift + 14;
      // graft meshes hold the whole fibula piece and are cut to length by clipping planes: skip the clipped-away part
      const h = rc.intersectObjects(T.map(t => t[0]), false).find(x => !clipped(x));
      if (!h) continue;
      const nn = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (nn.dot(n) < 0) nn.negate();
      return { p: h.point.clone(), n: nn, kind: T.find(t => t[0] === h.object)[1] };
    }
    return null;
  }
  const clipped = h => { const cp = h.object.material && h.object.material.clippingPlanes; return !!cp && cp.some(pl => pl.distanceToPoint(h.point) < -0.05); };
  // walk from s along dir until stop(point, length) is true
  function walk(s, dir, T, stop) {
    const out = []; let cur = s, d = dir.clone(), len = 0;
    for (let i = 0; i < 160; i++) {
      d.sub(cur.n.clone().multiplyScalar(d.dot(cur.n))).normalize();
      // a short step first; across the saw gap between bone and graft, longer steps bridge it
      let nx = null; for (const st of [1.5, 3, 5]) { nx = snap(cur.p.clone().addScaledVector(d, st), cur.n, T); if (nx) break; }
      if (!nx) return { pts: out, ok: false };
      const step = nx.p.distanceTo(cur.p); if (step < 0.2) return { pts: out, ok: false };
      d = nx.p.clone().sub(cur.p).normalize(); nx.n.lerp(cur.n, 0.5).normalize();
      len += step; cur = nx; out.push(cur);
      if (stop(cur.p, len)) return { pts: out, ok: true };
    }
    return { pts: out, ok: false };
  }
  function compute() {
    last = null;
    if (!P.on || !S.anchor || !St.parts.bone) return null;
    const E = St.resEnds(); if (!E) return null;
    const T = targets(), { u, v, n } = St.frameAxes();
    const { A, B } = E;
    // start inside the defect: the anchor, or the middle of the two ends when the cuts have moved off it
    const ea = A.p.clone().sub(S.anchor.p).dot(u), eb = B.p.clone().sub(S.anchor.p).dot(u), shift = 0 > Math.min(ea, eb) + 2 && 0 < Math.max(ea, eb) - 2 ? 0 : (ea + eb) / 2;
    const s0 = snap(S.anchor.p.clone().addScaledVector(u, shift).addScaledVector(v, P.h), n, T); if (!s0) return null;
    const out = q => q.clone().sub(A.p).dot(A.N) < -(A.w / 2 + P.ext);
    const toA = A.p.clone().sub(s0.p).dot(u) < 0 ? u.clone().negate() : u.clone();
    const wa = walk(s0, toA, T, q => out(q));
    const wb = E.condyle ? walk(s0, toA.clone().negate(), T, q => q.distanceTo(B.p) < 10)
      : walk(s0, toA.clone().negate(), T, q => q.clone().sub(B.p).dot(B.N) > B.w / 2 + P.ext);
    let raw = wa.pts.reverse().concat([s0], wb.pts);
    if (raw.length < 4) return null;
    // smooth, then resample every 1 mm
    raw = raw.map((q, i) => { const a = raw.slice(Math.max(0, i - 2), i + 3); const p = V(), nn = V(); a.forEach(x => { p.add(x.p); nn.add(x.n); }); return { p: p.multiplyScalar(1 / a.length), n: nn.normalize(), kind: q.kind }; });
    const cum = [0]; for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + raw[i].p.distanceTo(raw[i - 1].p));
    const L = cum[cum.length - 1], path = [];
    for (let s = 0, j = 0; s <= L; s += 1) {
      while (j < raw.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1), a = raw[j], b = raw[j + 1];
      path.push({ s, p: a.p.clone().lerp(b.p, f), n: a.n.clone().lerp(b.n, f).normalize(), kind: f < 0.5 ? a.kind : b.kind });
    }
    path.forEach((q, i) => { const a = path[Math.max(0, i - 1)].p, b = path[Math.min(path.length - 1, i + 1)].p; q.t = b.clone().sub(a).normalize(); q.n.sub(q.t.clone().multiplyScalar(q.n.dot(q.t))).normalize(); });
    // holes at the plate's spacing, centred on the defect; a hole within 3 mm of a slot edge or of a joint between
    // two fibula segments is not usable
    const pls = St.planesWorld(), mid = L / 2 + P.shift, holes = [], fl = graftPlan(), lower = fl ? fl.segs.filter(g => !g.barrel) : [];
    const joints = lower.slice(1).map(g => ({ p: g.P0, N: g.N0 })), kerf = fl ? (Fibula.plan().kerf || 1) : 0;
    const k0 = Math.ceil((0 - mid) / P.pitch + 0.5), k1 = Math.floor((L - mid) / P.pitch - 0.5);
    for (let k = k0; k <= k1; k++) {
      const s = mid + k * P.pitch, q = path[Math.min(path.length - 1, Math.round(s))];
      const dCut = Math.min(Infinity, ...pls.map(pw => Math.abs(q.p.clone().sub(pw.p).dot(pw.N)) - pw.w / 2 - P.d / 2));
      const sa = q.p.clone().sub(A.p).dot(A.N), region = sa < -A.w / 2 ? 'A' : E.condyle || q.p.clone().sub(B.p).dot(B.N) <= B.w / 2 ? 'defect' : 'B';
      const dJoint = Math.min(Infinity, ...joints.filter(J => q.p.distanceTo(J.p) < 30).map(J => Math.abs(q.p.clone().sub(J.p).dot(J.N)) - kerf / 2 - P.d / 2));
      const h = { s, p: q.p.clone(), n: q.n.clone(), t: q.t.clone(), region, kind: q.kind, dCut, dJoint, usable: dCut >= 3 && dJoint >= JOINT_GAP, why: dCut < 3 ? 'cut' : dJoint < JOINT_GAP ? 'joint' : null };
      h.seg = region === 'defect' && lower.length ? segOf(lower, h.p) : null;
      Object.assign(h, screwFor(h, fl));
      holes.push(h);
    }
    // bending: how much the plate turns, in the plate plane and out of it
    let inPlane = 0, outPlane = 0;
    for (let i = 4; i < path.length; i += 4) { const a = path[i - 4], b = path[i]; const tb = V().crossVectors(a.t, a.n); inPlane += Math.abs(Math.asin(Math.max(-1, Math.min(1, b.t.dot(tb))))); outPlane += Math.abs(Math.asin(Math.max(-1, Math.min(1, b.t.dot(a.n))))); }
    last = { path, holes, L, ok: wa.ok && wb.ok, E, bend: { inPlane: THREE.MathUtils.radToDeg(inPlane), outPlane: THREE.MathUtils.radToDeg(outPlane) } };
    return last;
  }

  // the fibula plan when grafts are shown (plate holes then also avoid the graft joints)
  function graftPlan() {
    if (!window.Fibula || !Fibula.active() || !St.parts.grafts || !St.parts.grafts.obj.children.length) return null;
    const st = Fibula.state(); return st && st.last && st.last.segs.length ? st.last : null;
  }
  // graft segment that holds point p: between its two end planes, else the one whose axis passes closest
  function segOf(segs, p) {
    const inside = segs.find(g => p.clone().sub(g.P0).dot(g.N0) >= 0 && p.clone().sub(g.P1).dot(g.N1) <= 0);
    if (inside) return inside.i;
    let best = null, bd = Infinity;
    segs.forEach(g => { const t = Math.max(0, Math.min(g.L, p.clone().sub(g.P0).dot(g.x))), d = p.distanceTo(g.P0.clone().addScaledVector(g.x, t)); if (d < bd) { bd = d; best = g.i; } });
    return best;
  }
  // bone under a hole: remaining mandible (without the resected piece) or a graft segment
  function boneHere(q, fl) {
    if (fl) for (let i = 0; i < fl.segs.length; i++) if (Fibula.graftBone(i, q)) return true;
    if (!fl && !S.resRemoved) return St.boneAt(q);
    if (!St.boneAt(q)) return false;
    if (!S.resMask) return true;
    const r = S.red, ix = G.indexOf(r, [q.x, q.y, q.z]).map(Math.round);
    if (ix.some((x, k) => x < 0 || x >= [r.nx, r.ny, r.nz][k])) return true;
    return !S.resMask[ix[0] + r.nx * (ix[1] + r.ny * ix[2])];
  }
  // bicortical screw: walk into the bone along the hole axis until 2 mm of no bone follow; length = far cortex + 1 mm,
  // rounded up to the system's lengths. No exit within 30 mm: monocortical, the longest standard length is proposed.
  function screwFor(h, fl) {
    const dir = h.n.clone().negate(), q = V(); let entry = null, lastIn = null, out = 0, t = -1;
    for (; t <= 30; t += 0.25) {
      if (boneHere(q.copy(h.p).addScaledVector(dir, t), fl)) { if (entry === null) entry = t; lastIn = t; out = 0; }
      else if (entry !== null && (out += 0.25) >= 2) break;
    }
    if (entry === null) return { len: null, thick: 0, bi: false };
    const bi = t <= 30, need = Math.max(0, lastIn) + 1, L = LENS[P.sys] || LENS.custom;
    return { len: L.find(x => x >= need) || L[L.length - 1], thick: lastIn - entry, bi: bi && need <= L[L.length - 1] };
  }

  // ---------- plate mesh ----------
  function plateMesh(R) {
    const pos = [], idx = [], gap = 0.15, w = P.w / 2, path = R.path;
    path.forEach(q => {
      const b = V().crossVectors(q.t, q.n).normalize();
      [[-w, gap], [w, gap], [w, gap + P.t], [-w, gap + P.t]].forEach(([x, y]) => { const c = q.p.clone().addScaledVector(b, x).addScaledVector(q.n, y); pos.push(c.x, c.y, c.z); });
    });
    for (let i = 0; i < path.length - 1; i++) for (let k = 0; k < 4; k++) {
      const a = i * 4 + k, b = i * 4 + (k + 1) % 4, c = a + 4, d = b + 4; idx.push(a, c, b, b, c, d);
    }
    const e = (path.length - 1) * 4; idx.push(0, 1, 2, 0, 2, 3, e, e + 2, e + 1, e, e + 3, e + 2);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  function draw() {
    const R = last;
    if (!R) { St.setPart('plate', null, null); return; }
    const grp = new THREE.Group(), body = new THREE.Mesh(plateMesh(R), St.mat(COLOR, { metalness: 0.5, roughness: 0.35 }));
    body.name = 'plateBody'; grp.add(body);
    R.holes.forEach(h => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(P.d / 2 + 0.25, P.d / 2 + 0.25, P.t + 0.3, 20), new THREE.MeshStandardMaterial({ color: h.usable ? (h.matched ? 0x2a9d8f : 0x30363c) : 0xc0504d, roughness: 0.6 }));
      m.position.copy(h.p.clone().addScaledVector(h.n, 0.15 + P.t / 2)); m.quaternion.setFromUnitVectors(V(0, 1, 0), h.n); grp.add(m);
    });
    St.setPart('plate', `Plak (${SYSTEMS[P.sys].name})`, grp, COLOR);
    if (St.renderParts) St.renderParts();
    St.render();
  }
  async function update() {
    try { compute(); } catch (e) { last = null; }
    if (last) markMatched();
    draw(); renderSum(); St.renderChecks(); St.renderAppr(); if (window.MPR) MPR.redraw();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(update, 350); };

  // ---------- guide screws on plate holes ----------
  function screwFromHole(h, base) {
    const { u, v, n } = St.frameAxes(), d = h.p.clone().sub(S.anchor.p), dir = h.n.clone().negate();
    const a = Math.asin(Math.max(-1, Math.min(1, -dir.dot(u)))), b = Math.atan2(dir.dot(v), -dir.dot(n));
    return Object.assign({}, base, { u: Math.round(d.dot(u) * 10) / 10, v: Math.round(d.dot(v) * 10) / 10, tiltU: Math.round(THREE.MathUtils.radToDeg(a)), tiltV: Math.round(THREE.MathUtils.radToDeg(b)), ok: false, plate: true });
  }
  function footprint(h) { const { u, v } = St.frameAxes(), d = h.p.clone().sub(S.anchor.p); return Math.abs(d.dot(u)) <= S.g.L / 2 - 2 && Math.abs(d.dot(v)) <= S.g.W / 2 - 2; }
  function placeScrews() {
    if (!last) return;
    const base = S.screws[0] ? (({ d, D, sleeveH, len }) => ({ d, D, sleeveH, len }))(S.screws[0]) : { d: 2.0, D: 5, sleeveH: 5, len: 10 };
    const pick = reg => last.holes.filter(h => h.region === reg && h.usable && footprint(h)).sort((x, y) => x.dCut - y.dCut).slice(0, 2);
    const hs = [...pick('A'), ...pick('B')];
    if (!hs.length) { msg('Guide alanında kullanılabilir plak deliği yok. Guide\'ı uzatın ya da plak yüksekliğini guide üzerine getirin.'); return; }
    S.screws = hs.map(h => screwFromHole(h, base)); S.sel = null;
    msg(`${hs.length} guide vidası plak deliklerine yerleştirildi. Ameliyatta bu deliklerden açılan yuvalar ön bükülmüş plağın delikleriyle eşleşir.`);
    St.schedule(false);
  }
  function markMatched() {
    const sw = St.screwsWorld();
    last.holes.forEach(h => { h.matched = sw.some(s => s.entry && s.entry.distanceTo(h.p) < 1.5); });
  }

  // ---------- files ----------
  function mergedSTL(objs) {
    const pos = [], idx = [];
    objs.forEach(o => {
      o.updateMatrixWorld(true);
      const g = o.geometry, Pa = g.attributes.position.array, I = g.index ? g.index.array : null, base = pos.length / 3, M = o.parent && o.parent.isGroup ? o.matrix : new THREE.Matrix4(), q = V();
      for (let i = 0; i < Pa.length; i += 3) { q.set(Pa[i], Pa[i + 1], Pa[i + 2]).applyMatrix4(M); pos.push(q.x, q.y, q.z); }
      if (I) for (let i = 0; i < I.length; i++) idx.push(base + I[i]); else for (let i = 0; i < Pa.length / 3; i++) idx.push(base + i);
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    return St.stlOf({ geometry: g });
  }
  function bendModel() {
    const pt = St.parts, objs = [pt.bone.obj];
    if (pt.grafts && pt.grafts.obj.children.length) pt.grafts.obj.children.forEach(c => c.isMesh && objs.push(c));
    else if (pt.resected) objs.push(pt.resected.obj);
    return mergedSTL(objs);
  }
  const plateSTL = () => { const b = St.parts.plate && St.parts.plate.obj.getObjectByName('plateBody'); return b ? St.stlOf(b) : null; };
  (window.ExportHooks = window.ExportHooks || []).push(files => {
    if (!last) return;
    const s = summary();
    files.push({ name: 'plak_bukme_modeli.stl', data: bendModel() }, { name: 'plak_sablonu.stl', data: plateSTL() }, { name: 'plak_plani.json', data: JSON.stringify(s, null, 2) }, { name: 'plak_vidalari.csv', data: screwCSV(s) });
  });

  // ---------- summary, checks, report ----------
  function summary() {
    if (!last) return null;
    const cnt = r => last.holes.filter(h => h.region === r && h.usable).length;
    return { sistem: SYSTEMS[P.sys].name, genislik_mm: P.w, kalinlik_mm: P.t, delik_araligi_mm: P.pitch, uzunluk_mm: Math.round(last.L), holes: last.holes.length,
      kullanilabilir: { A: cnt('A'), defekt: cnt('defect'), B: cnt('B') }, kesiye_yakin: last.holes.filter(h => !h.usable).length,
      bukme_deg: { kalinlik_yonunde: Math.round(last.bend.outPlane), kenar_yonunde: Math.round(last.bend.inPlane) },
      guide_ile_eslesen: last.holes.filter(h => h.matched).length, greft_eklemine_yakin: last.holes.filter(h => h.why === 'joint').length,
      vida_listesi: screwList(),
      delikler: last.holes.map((h, i) => ({ no: i + 1, bolge: h.region, segment: h.seg == null ? null : h.seg + 1, kullanilabilir: h.usable, neden: h.why === 'cut' ? 'kesiye yakın' : h.why === 'joint' ? 'greft eklemine yakın' : null,
        kesiye_mm: +h.dCut.toFixed(1), eklem_mm: Number.isFinite(h.dJoint) ? +h.dJoint.toFixed(1) : null, vida_boyu_mm: h.usable ? h.len : null, kemik_kalinligi_mm: +h.thick.toFixed(1), bikortikal: h.usable && h.len ? h.bi : null,
        konum: h.p.toArray().map(x => +x.toFixed(2)), eksen: h.n.clone().negate().toArray().map(x => +x.toFixed(4)) })) };
  }
  // usable holes grouped by screw length: [[length, count], ...]
  function screwList() {
    const m = new Map(); last.holes.forEach(h => { if (h.usable && h.len) m.set(h.len, (m.get(h.len) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([boy_mm, adet]) => ({ boy_mm, adet }));
  }
  const screwText = s => s.vida_listesi.length ? s.vida_listesi.map(x => `${x.adet} × ${fmt(x.boy_mm, 0)} mm`).join(', ') : '–';
  function screwCSV(s) {
    return 'delik;bolge;segment;vida_boyu_mm;kemik_kalinligi_mm;bikortikal;x;y;z\n' + s.delikler.filter(h => h.kullanilabilir).map(h => [h.no, h.bolge, h.segment || '', h.vida_boyu_mm || '', h.kemik_kalinligi_mm, h.bikortikal ? 'evet' : 'hayir', ...h.konum].join(';')).join('\n') + '\n';
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    if (!P.on || !S.anchor) return [];
    if (!last) return [['warn', 'Uyarı', 'Plak hattı kemik yüzeyinde izlenemedi; plak yüksekliğini değiştirin.', 'guide']];
    const out = [], need = last.E.condyle ? ['A'] : ['A', 'B'];
    need.forEach(r => { const c = last.holes.filter(h => h.region === r && h.usable).length; if (c < 3) out.push(['warn', 'Uyarı', `Plak ${r === 'A' ? 'birinci' : 'ikinci'} kalan segmentte ${c} vidaya yer bırakıyor; en az 3 önerilir (plak uzantısını artırın).`, 'guide']); });
    if (!last.ok) out.push(['warn', 'Uyarı', 'Plak hattı istenen uzunluğa ulaşmadan kemik yüzeyinden çıktı.', 'guide']);
    const fl = graftPlan();
    if (fl) fl.segs.filter(g => !g.barrel).forEach(g => { const c = last.holes.filter(h => h.seg === g.i && h.usable).length; if (c < 2) out.push(['warn', 'Uyarı', `Plak greft segmenti ${g.i + 1} üzerinde ${c} vidaya yer bırakıyor; her segmente en az 2 vida önerilir (delik dizisini kaydırın ya da segment boyunu değiştirin).`, 'guide']); });
    const mono = last.holes.filter(h => h.usable && h.len && !h.bi).length, none = last.holes.filter(h => h.usable && !h.len).length;
    if (mono) out.push(['info', 'Bilgi', `${mono} plak deliğinde karşı korteks 30 mm içinde bulunamadı ya da standart boydan uzun; bu vidalar monokortikal kalır.`, 'guide']);
    if (none) out.push(['warn', 'Uyarı', `${none} kullanılabilir plak deliğinin altında kemik yok.`, 'guide']);
    const m = last.holes.filter(h => h.matched).length, gs = S.screws.length;
    if (gs && m < gs && S.screws.some(s => s.plate)) out.push(['info', 'Bilgi', `${gs} guide vidasından ${m} tanesi plak deliğiyle çakışıyor.`, 'guide']);
    return out;
  });
  (window.ReportSections = window.ReportSections || []).push(d => {
    const s = summary(); if (!s) return;
    if (d.keep) d.keep(380); d.h2('Plak');
    d.table(['Özellik', 'Değer'], [['Sistem', `${s.sistem} · ${fmt(s.genislik_mm)} × ${fmt(s.kalinlik_mm)} mm · ${fmt(s.delik_araligi_mm)} mm aralık`], ['Uzunluk / delik', `${s.uzunluk_mm} mm · ${s.holes} delik`], ['Kullanılabilir delik', `kalan 1: ${s.kullanilabilir.A} · defekt: ${s.kullanilabilir.defekt} · kalan 2: ${s.kullanilabilir.B}`], ['Kesiye yakın (boş bırakılacak)', `${s.kesiye_yakin}`], ['Toplam bükme', `kalınlık yönünde ${s.bukme_deg.kalinlik_yonunde}° · kenar yönünde ${s.bukme_deg.kenar_yonunde}°`], ['Guide vidalarıyla eşleşen delik', `${s.guide_ile_eslesen}`], ['Greft eklemine yakın (boş bırakılacak)', `${s.greft_eklemine_yakin}`], ['Vida boyları (bikortikal)', screwText(s)], ['Not', 'Vida boyları kemik modelinden ölçülür; sinir kanalı ve diş kökleri ayrıca kontrol edilmelidir.']], [0.34, 0.66]);
  });

  // ---------- slices: plate cross-section where it meets the slice ----------
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const body = last && St.parts.plate && St.parts.plate.visible && St.parts.plate.obj.getObjectByName('plateBody');
    if (!body || !A.contour) return;
    ctx.strokeStyle = '#c9d2db'; ctx.lineWidth = 2 * dpr; A.contour(v, { id: 'plateBody', obj: body, base: body.position }, T, ctx);
  });

  // ---------- panel ----------
  function msg(t) { const el = $('plMsg'); if (el) el.textContent = t; }
  const F = [['h', 'Plak yüksekliği', -15, 15, 0.5, 'mm'], ['ext', 'Kesi ötesi uzantı', 10, 45, 1, 'mm'], ['shift', 'Delik kaydırma', -4, 4, 0.5, 'mm'], ['w', 'Plak genişliği', 3, 10, 0.5, 'mm'], ['t', 'Plak kalınlığı', 0.6, 3.5, 0.1, 'mm'], ['pitch', 'Delik aralığı', 4, 12, 0.5, 'mm'], ['d', 'Plak vida çapı', 1.5, 3, 0.1, 'mm']];
  function render() {
    const s = summary();
    $('plateBox').innerHTML = `<h3 class="sub">Plak</h3>
      <label class="chk"><input type="checkbox" id="plOn" ${P.on ? 'checked' : ''}> Plak planla</label>
      ${P.on ? `<div class="ctl"><label for="plSys" class="lbl2">Plak sistemi</label><select id="plSys">${Object.entries(SYSTEMS).map(([k, x]) => `<option value="${k}" ${P.sys === k ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div>
      ${F.filter(f => P.sys === 'custom' || !['w', 't', 'pitch'].includes(f[0])).map(([k, t, mn, mx, st, un]) => `<div class="ctl"><div class="ctl-row"><label for="pl_${k}">${t}</label><output id="plo_${k}">${fmt(P[k], st < 1 ? 1 : 0)} ${un}</output></div><input type="range" id="pl_${k}" min="${mn}" max="${mx}" step="${st}" value="${P[k]}"></div>`).join('')}
      <div id="plSum">${sumHTML(s)}</div>
      <div class="btns"><button id="plScrews" ${s ? '' : 'disabled'}><svg class="i"><use href="#i-target"/></svg>Vidaları plağa hizala</button></div>
      <div class="btns"><button id="plBend" class="ghost" ${s ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>Bükme modeli STL</button><button id="plTpl" class="ghost" ${s ? '' : 'disabled'}><svg class="i"><use href="#i-download"/></svg>Plak şablonu STL</button></div>
      <p class="hint more">Kırmızı delikler kesiye ya da greft eklemine 3 mm'den yakındır, boş bırakılır. Yeşil delikler guide vidalarıyla eşleşir. Vida boyu her delikte karşı kortekse göre ölçülür; sinir kanalı ayrıca kontrol edilmelidir.</p><p class="hint" id="plMsg"></p>` : '<p class="hint more">Plak hattı kalan kemik ve greftlerin dış yüzeyini izler; guide vidaları plak deliklerine yerleştirilebilir.</p>'}`;
    wire();
  }
  const sumHTML = s => s ? `<dl class="kv"><dt>Uzunluk</dt><dd>${s.uzunluk_mm} mm · ${s.holes} delik</dd><dt>Kullanılabilir</dt><dd>${s.kullanilabilir.A} · ${s.kullanilabilir.defekt} · ${s.kullanilabilir.B}</dd><dt>Kesiye yakın</dt><dd>${s.kesiye_yakin} delik boş kalır</dd><dt>Bükme</dt><dd>${s.bukme_deg.kalinlik_yonunde}° yüzeye · ${s.bukme_deg.kenar_yonunde}° kenara</dd><dt>Guide ile eşleşen</dt><dd>${s.guide_ile_eslesen}</dd>${s.greft_eklemine_yakin ? `<dt>Greft eklemine yakın</dt><dd>${s.greft_eklemine_yakin} delik boş kalır</dd>` : ''}<dt>Vidalar</dt><dd>${screwText(s)}</dd></dl>` : `<p class="hint">${S.anchor ? 'Plak hattı bulunamadı; yüksekliği değiştirin.' : 'Önce rezeksiyon bölgesini ve kesileri belirleyin.'}</p>`;
  function renderSum() {
    if (!$('plSum')) return;
    const s = summary(); $('plSum').innerHTML = sumHTML(s);
    ['plScrews', 'plBend', 'plTpl'].forEach(id => { $(id).disabled = !s; });
  }
  function wire() {
    $('plOn').addEventListener('change', e => { P.on = e.target.checked; changed(); });
    if (!P.on) return;
    $('plSys').addEventListener('change', e => { P.sys = e.target.value; if (P.sys !== 'custom') Object.assign(P, SYSTEMS[P.sys], { name: undefined }); delete P.name; changed(); });
    F.forEach(([k, , , , st, un]) => { const el = $('pl_' + k); if (!el) return; el.addEventListener('input', e => { P[k] = +e.target.value; $('plo_' + k).textContent = `${fmt(P[k], st < 1 ? 1 : 0)} ${un}`; later(); St.emit('changed'); }); });
    $('plScrews').addEventListener('click', placeScrews);
    $('plBend').addEventListener('click', () => St.offer('plak_bukme_modeli.stl', new Blob([bendModel()])));
    $('plTpl').addEventListener('click', () => St.offer('plak_sablonu.stl', new Blob([plateSTL()])));
  }
  function changed() { render(); update(); St.emit('changed'); }

  // a stored plan is untrusted input: keep only known keys, with the default's type
  const clean = x => { const o = Object.assign({}, DEF); if (x && typeof x === 'object') for (const k in DEF) { if (!(k in x)) continue; const d = DEF[k], v = x[k];
    if (typeof d === 'number') { const n = Number(v); if (Number.isFinite(n)) o[k] = n; } else if (typeof d === 'boolean') o[k] = !!v; else if (typeof d === 'string') { if (typeof v === 'string') o[k] = v.slice(0, 60); } else if (v === null) o[k] = null;
    else if (typeof v === 'string') o[k] = v.slice(0, 8); else if (Number.isFinite(v)) o[k] = v;
    else if (Array.isArray(v) && v.length <= 4 && v.every(Number.isFinite)) o[k] = v.slice(); } return o; };
  (window.PlanExt = window.PlanExt || {}).plate = {
    label: 'Plak planı',
    get: () => P.on ? Object.assign({}, P) : null,
    set(x) { P = clean(x); if (!(P.sys in SYSTEMS)) P.sys = DEF.sys; render(); update(); },
  };
  bus.addEventListener('parts', () => { if (P.on && !S.restoring) later(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { P = Object.assign({}, DEF); last = null; draw(); render(); } });
  render();
  return { summary, compute, update, placeScrews, get: () => last, params: () => P };
})();
