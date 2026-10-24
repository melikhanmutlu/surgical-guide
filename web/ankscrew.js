/* Screw plan of the malleolar fracture (plan M4, M5): screws laid on the reduced (planned) position, their length
   suggested from the bone along the screw, and checks on the joint, the far cortex, the fracture and each other.

   A screw is held by the piece its entry is on (its anchor) in that piece's own coordinates, so it moves with the
   piece: entry E, direction d, diameter D, length L (mm, from the entry along d).
   - bone: every piece but the talus and splints, each in its planned position (ankle.js toWorld / sdfAt)
   - along the screw (0.25 mm steps): the runs inside bone; runs less than GAP mm apart are one (a fracture line or a
     thin canal is crossed), the first run is the bone the screw is in, its end the far cortex
   - suggested length: far cortex - tip mm (2 mm for the medial malleolus and a clicked screw, flush with the far
     cortex for the posterior and the syndesmosis screw), down to 2 mm steps, at most the template's maximum
   - articular surface: the bone's surface within NEAR mm of the talus (planned position)
   Templates (literature defaults; the surgeon chooses): medial malleolus 2 parallel Ø4.0 screws from 3 mm over the
   tip, 15° lateral of the long axis, 30 % of the fragment's anterior-posterior width (at most 6 mm) either side of its
   centre, at most 45 mm; posterior malleolus 2 Ø4.0 lag screws anterior to posterior at the fragment's height (3-15 mm
   over the plafond), 7 mm either side; syndesmosis 1 Ø3.5 screw 30 mm over the plafond (2-4 cm in the literature), parallel to the joint, from
   the fibula towards the tibia's centre (from the posterolateral fibula the 20-30° anterior aim), the gap between the
   bones up to 15 mm is crossed; or a click on a bone (entry there, straight in). Thresholds are sample values; the
   clinical team sets them.
   Research prototype, not for clinical use. */
'use strict';
window.AnkScrew = (function () {
  const St = window.Studio, A = window.Ankle; if (!St || !A || !window.CaseType) return null;
  const { S, V, fmt, bus, esc } = St, $ = id => document.getElementById(id), T = THREE;
  const xl = s => (window.I18N ? I18N.t(s) : s);
  const on = () => CaseType.get() === 'ankle';
  // sample thresholds (the clinical team sets them)
  const LIM = { step: 0.25, gap: 3, tip: 2, lenStep: 2, minLen: 10, maxLen: 120, over: 1, near: 3, joint: 2, clear: 1, purchase: 10, offBone: 1.5 };
  const KIND = {
    mm: { name: 'Medial malleol vidası', D: 4.0, max: 45, sp: 6, tip: 2, tilt: 15 },
    post: { name: 'Posterior malleol vidası', D: 4.0, max: 60, sp: 7, tip: 0 },
    synd: { name: 'Sindesmoz vidası', D: 3.5, max: 80, gap: 15, tip: 0 },
    click: { name: 'Vida', D: 3.5, max: 80, tip: 2 },
  };
  const DIAS = [2.7, 3.5, 4.0, 4.5];
  const COL = { ok: 0xb8c4d0, warn: 0xe0a03a, crit: 0xd9534f };
  let screws = [];        // { id, kind, piece, c, E, d, D, L }
  let seq = 0, picking = false, cache = null;

  const r3 = a => a.map(x => Math.round(x * 1000) / 1000);
  const anchor = s => A.pieces().find(p => p.name === s.piece && p.c.distanceTo(V(...s.c)) < 5) || A.pieces().find(p => p.c.distanceTo(V(...s.c)) < 5) || null;
  const bones = () => A.pieces().filter(p => p.role !== 'talus' && p.role !== 'out');
  const talus = () => A.pieces().find(p => p.role === 'talus') || null;
  const sdfW = (p, w) => A.sdfAt(p, A.toOwn(p, w));
  function inBone(x, list) { for (const b of list) if (sdfW(b, x) <= 0) return b; return null; }
  // a screw in the planned position: entry and unit direction in world coordinates
  function world(s) {
    const p = anchor(s); if (!p) return null;
    return { p, E: A.toWorld(p, V(...s.E)), d: V(...s.d).applyQuaternion(p.q).normalize() };
  }

  // ---------- along the screw ----------
  // runs inside bone from the entry: [{ a, b, piece }], merged over gaps < GAP mm; t0 = first bone, exit = the far cortex
  function march(E, d, list, gap = LIM.gap) {
    list = list || bones();
    const runs = [], x = V(); let cur = null;
    for (let t = 0; t <= LIM.maxLen; t += LIM.step) {
      x.copy(E).addScaledVector(d, t); const b = inBone(x, list);
      if (b) { if (cur && t - cur.b <= LIM.step + 1e-9) { cur.b = t; cur.hit.add(b); } else { cur = { a: t, b: t, hit: new Set([b]) }; runs.push(cur); } }
    }
    if (!runs.length) return { t0: null, exit: null, runs, pieces: [] };
    const m = [{ a: runs[0].a, b: runs[0].b, hit: new Set(runs[0].hit) }];
    for (let k = 1; k < runs.length; k++) { const last = m[m.length - 1]; if (runs[k].a - last.b < gap) { last.b = runs[k].b; runs[k].hit.forEach(h => last.hit.add(h)); } else m.push({ a: runs[k].a, b: runs[k].b, hit: new Set(runs[k].hit) }); }
    return { t0: m[0].a, exit: m[0].b, runs: m, pieces: [...m[0].hit] };
  }
  function suggest(s) {
    const w = world(s); if (!w) return null;
    const K = KIND[s.kind] || KIND.click, m = march(w.E, w.d, null, K.gap); if (m.exit == null) return null;
    const max = K.max;
    return Math.max(LIM.minLen, Math.min(max, Math.floor((m.exit - (K.tip ?? LIM.tip)) / LIM.lenStep) * LIM.lenStep));
  }
  // the articular surface in the planned position: bone mesh vertices within NEAR mm of the talus (world, flat array)
  function joint() {
    const tal = talus(); if (!tal) return null;
    const out = [], x = V();
    bones().forEach(p => {
      const P = p.mesh.geometry.attributes.position.array, step = Math.max(1, Math.floor(P.length / 3 / 15000));
      for (let v = 0; v < P.length / 3; v += step) { x.fromArray(P, 3 * v); const w = A.toWorld(p, x); if (sdfW(tal, w) < LIM.near) out.push(w.x, w.y, w.z); }
    });
    return new Float32Array(out);
  }
  const minTo = (J, x) => { let m = Infinity; for (let k = 0; k < J.length; k += 3) { const dx = J[k] - x.x, dy = J[k + 1] - x.y, dz = J[k + 2] - x.z, d = dx * dx + dy * dy + dz * dz; if (d < m) m = d; } return Math.sqrt(m); };
  // the shortest distance between two segments (P0 + s u, s in [0, 1]; Q0 + t v)
  function segDist(P0, P1, Q0, Q1) {
    const u = V().subVectors(P1, P0), v = V().subVectors(Q1, Q0), w = V().subVectors(P0, Q0);
    const a = u.dot(u), b = u.dot(v), c = v.dot(v), d = u.dot(w), e = v.dot(w), D = a * c - b * b;
    let sN, sD = D, tN, tD = D;
    if (D < 1e-9) { sN = 0; sD = 1; tN = e; tD = c; } else { sN = b * e - c * d; tN = a * e - b * d; if (sN < 0) { sN = 0; tN = e; tD = c; } else if (sN > sD) { sN = sD; tN = e + b; tD = c; } }
    if (tN < 0) { tN = 0; if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; } } else if (tN > tD) { tN = tD; if (-d + b < 0) sN = 0; else if (-d + b > a) sN = sD; else { sN = -d + b; sD = a; } }
    const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD, tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD;
    return V().copy(w).addScaledVector(u, sc).addScaledVector(v, -tc).length();
  }

  // ---------- analysis of every screw (cached on the screws and the pieces' motions) ----------
  const keyOf = () => JSON.stringify(screws) + JSON.stringify(A.pieces().map(p => [p.label, p.name, p.role, p.t.toArray(), p.q.toArray()]));
  function analyse() {
    const k = keyOf(); if (cache && cache.key === k) return cache.res;
    const J = screws.length ? joint() : null, tal = talus(), list = bones(), x = V();
    const res = screws.map(s => {
      const w = world(s); if (!w) return { s, lost: true };
      const m = march(w.E, w.d, list, (KIND[s.kind] || KIND.click).gap), L = s.L, r = s.D / 2;
      let talusIn = false, jd = Infinity; const hits = new Map();
      for (let t = 0; t <= L + 1e-9; t += LIM.step) {
        x.copy(w.E).addScaledVector(w.d, t);
        if (tal && sdfW(tal, x) <= 0) talusIn = true;
        if (J && J.length) jd = Math.min(jd, minTo(J, x));
        const b = inBone(x, list); if (b) hits.set(b, (hits.get(b) || 0) + LIM.step);
      }
      const order = [...hits.keys()], far = order[order.length - 1];
      return { s, w, m, talusIn, joint: J && J.length ? jd - r : null, pieces: order.map(p => p.name), purchase: order.length > 1 ? hits.get(far) : null, far: far ? far.name : null,
        tip: { P: w.E.clone(), Q: w.E.clone().addScaledVector(w.d, L) }, over: m.exit != null ? L - m.exit : null };
    });
    res.forEach((a, i) => { a.clear = null; if (a.lost) return; res.forEach((b, j) => { if (j === i || b.lost) return; const c = segDist(a.tip.P, a.tip.Q, b.tip.P, b.tip.Q) - (a.s.D + b.s.D) / 2; if (a.clear == null || c < a.clear.c) a.clear = { c, with: b.s.id }; }); });
    cache = { key: k, res }; return res;
  }
  const label = s => `${(KIND[s.kind] || KIND.click).name} ${screws.filter(z => z.kind === s.kind).indexOf(s) + 1}`;
  // every finding of every screw: { id, lvl, msg } (msg Turkish "Vida adı: …", translated where shown)
  function issues() {
    if (!on() || !screws.length) return [];
    const o = [], add = (a, lvl, msg) => o.push({ id: a.s.id, lvl, msg: `${label(a.s)}: ${msg}` });
    analyse().forEach(a => {
      if (a.lost) { add(a, 'warn', 'tutunduğu parça bulunamadı; vidayı yeniden yerleştirin.'); return; }
      if (a.talusIn) add(a, 'crit', 'eklemi geçip talusa giriyor.');
      else if (a.joint != null && a.joint < 0) add(a, 'crit', `eklem yüzeyini deliyor (eklem yüzeyinin ${fmt(-a.joint, 1)} mm içinde).`);
      else if (a.joint != null && a.joint < LIM.joint) add(a, 'warn', `eklem yüzeyine ${fmt(a.joint, 1)} mm yaklaşıyor (örnek eşik ${LIM.joint} mm).`);
      if (a.over != null && a.over > LIM.over) add(a, 'crit', `karşı korteksten ${fmt(a.over, 1)} mm taşıyor (örnek eşik ${LIM.over} mm); boyu kısaltın.`);
      if (a.m.t0 == null || a.m.t0 > LIM.offBone) add(a, 'warn', 'giriş noktası kemikte değil.');
      if (a.pieces.length < 2) add(a, 'warn', `kırık hattını geçmiyor (yalnız ${a.pieces.length ? a.pieces[0] : '–'} içinde).`);
      else if (a.purchase != null && a.purchase < LIM.purchase) add(a, 'warn', `karşı parçada (${a.far}) yalnız ${fmt(a.purchase, 0)} mm tutunuyor (örnek eşik ${LIM.purchase} mm).`);
      const w = a.clear && a.s.id < a.clear.with ? screws.find(z => z.id === a.clear.with) : null;
      if (w && a.clear.c < 0) add(a, 'crit', `${label(w)} ile çakışıyor.`);
      else if (w && a.clear.c < LIM.clear) add(a, 'warn', `${label(w)} ile arasında ${fmt(a.clear.c, 1)} mm kalıyor (örnek eşik ${LIM.clear} mm).`);
    });
    return o;
  }
  const checks = () => issues().map(i => [i.lvl, i.lvl === 'crit' ? 'Kritik' : 'Uyarı', xl(i.msg), 'ank']);
  (window.ExtraChecks = window.ExtraChecks || []).push(checks);

  // ---------- placing ----------
  // the first bone point from `start` along `dir` (world); the screw is held by that piece
  function add(kind, start, dir, D, opts) {
    const list = bones(), d = dir.clone().normalize(), x = V();
    for (let t = 0; t <= 100; t += LIM.step) {
      x.copy(start).addScaledVector(d, t); const p = inBone(x, list); if (!p) continue;
      const s = { id: ++seq, kind, piece: p.name, c: r3(p.c.toArray()), E: r3(A.toOwn(p, x).toArray()), d: r3(d.clone().applyQuaternion(p.q.clone().invert()).toArray()), D: D || (KIND[kind] || KIND.click).D, L: 0 };
      screws.push(s); s.L = (opts && opts.L) || suggest(s) || LIM.minLen;
      return s;
    }
    return null;
  }
  function surfPts(p) { const P = p.mesh.geometry.attributes.position.array, x = V(), o = []; for (let v = 0; v < P.length / 3; v++) { x.fromArray(P, 3 * v); o.push(A.toWorld(p, x)); } return o; }
  // the centre of a piece's surface in a horizontal slab (world, planned position)
  function slab(p, z, h = 2) {
    const P = p.mesh.geometry.attributes.position.array, x = V(), c = V(); let n = 0;
    for (let v = 0; v < P.length / 3; v++) { x.fromArray(P, 3 * v); const w = A.toWorld(p, x); if (Math.abs(w.z - z) <= h) { c.add(w); n++; } }
    return n ? c.multiplyScalar(1 / n) : null;
  }
  // a template: medial malleolus, posterior malleolus or syndesmosis; returns the screws laid, or a reason
  function template(kind) {
    const LMr = window.AnkLM && AnkLM.result(); if (!LMr || !LMr.red.ok) return { why: 'Eklem ölçüleri yok (tibia ve talus gerekli).' };
    const { L, lat, post, pz } = LMr.red, up = V(0, 0, 1), out = [];
    if (kind === 'mm') {
      if (!L.mmTip || !L.plafond) return { why: 'Medial malleol ucu bulunamadı.' };
      // centred on the fragment's anterior-posterior extent near the tip; the screws 30 % of that width either side
      const mf = A.pieces().find(p => p.role === 'frag' && /Medial/i.test(p.name)), tip = L.mmTip.clone().addScaledVector(up, 3);
      let c = 0, lo = 0, hi = 0;
      if (mf) { const ys = surfPts(mf).filter(w => Math.abs(w.z - tip.z) < 4).map(w => w.dot(post)); if (ys.length > 5) { lo = Math.min(...ys); hi = Math.max(...ys); c = (lo + hi) / 2 - tip.dot(post); } }
      const sp = hi > lo ? Math.min(KIND.mm.sp, 0.3 * (hi - lo)) : KIND.mm.sp, base = tip.clone().addScaledVector(post, c);
      const tl = Math.tan(KIND.mm.tilt * Math.PI / 180), dir = up.clone().addScaledVector(lat, tl).normalize();
      [-1, 1].forEach(sg => { const s = add('mm', base.clone().addScaledVector(post, sg * sp).addScaledVector(dir, -15), dir); if (s) out.push(s); });
    } else if (kind === 'post') {
      const pf = A.pieces().filter(p => p.role === 'frag').map(p => ({ p, w: slab(p, pz + 10, 8) })).filter(o => o.w).sort((a, b) => b.w.dot(post) - a.w.dot(post))[0];
      if (!pf || !/Posterior/i.test(pf.p.name) && pf.w.dot(post) < (L.plafond ? L.plafond.dot(post) : 0)) return { why: 'Posterior malleol parçası yok.' };
      const z = Math.min(pz + 15, Math.max(pz + 3, pf.w.z)), c = V(pf.w.x, pf.w.y, z);
      [-1, 1].forEach(sg => { const s = add('post', c.clone().addScaledVector(lat, sg * KIND.post.sp).addScaledVector(post, -60), post); if (s) out.push(s); });
    } else if (kind === 'synd') {
      // from the fibula towards the tibia's centre at the same height (parallel to the joint): from the posterolateral
      // fibula this is the 20-30° anterior aim of the literature
      const z = pz + 30, fib = A.pieces().filter(p => p.role === 'fibula' || /Lateral malleol/.test(p.name)).map(p => slab(p, z)).filter(Boolean)[0];
      const tib = A.pieces().filter(p => p.role === 'tibia').map(p => slab(p, z)).filter(Boolean)[0];
      if (!fib || !tib) return { why: 'Fibula bulunamadı.' };
      const dir = V(tib.x - fib.x, tib.y - fib.y, 0).normalize();
      const s = add('synd', V(fib.x, fib.y, z).addScaledVector(dir, -30), dir); if (s) out.push(s);
    }
    if (!out.length) return { why: 'Vida kemiğe yerleştirilemedi.' };
    changed(); return { screws: out };
  }
  function remove(id) { screws = screws.filter(s => s.id !== id); changed(); }
  function setScrew(id, k, v) {
    const s = screws.find(z => z.id === id); if (!s) return false;
    if (k === 'D' && DIAS.includes(+v)) s.D = +v;
    else if (k === 'L' && Number.isFinite(+v)) s.L = Math.max(LIM.minLen, Math.min(LIM.maxLen, +v));
    else if (k === 'auto') { const L = suggest(s); if (L) s.L = L; } else return false;
    changed(); return true;
  }
  function changed() { cache = null; St.emit('changed'); refresh(); }

  // ---------- drill guide (plan M6.2): sleeves along the planned screws of one piece ----------
  // the drill for each screw diameter (solid screws: 2.7 -> 2.0, 3.5 -> 2.5, 4.0 cancellous -> 2.5, 4.5 -> 3.2 mm); the
  // hole and the sleeve follow the cutting guide's material and sleeve choice (AnkGuide.holeOf)
  const DRILL = { 2.7: 2.0, 3.5: 2.5, 4.0: 2.5, 4.5: 3.2 };
  let dg = null;          // { key, piece, mesh, info, req }
  const dgKey = name => JSON.stringify(screws.filter(z => z.piece === name)) + JSON.stringify(window.AnkGuide && AnkGuide.state() ? [AnkGuide.state().prm.mat, AnkGuide.state().prm.sleeve] : null);
  const SLEEVE_H = 10;
  async function drillGuide(name) {
    const mine = screws.filter(s => s.piece === name), p = mine.length ? anchor(mine[0]) : null;
    if (!p) return { why: 'Bu parçada vida yok.' };
    const ent = mine.map(s => V(...s.E)), dirs = mine.map(s => V(...s.d).normalize());
    const P0 = ent.reduce((a, b) => a.add(b), V()).multiplyScalar(1 / ent.length), e = 0.6;
    // the seat normal: the bone's outward normal averaged over the entries
    const n = ent.reduce((acc, x) => acc.add(V(A.sdfAt(p, V(x.x + e, x.y, x.z)) - A.sdfAt(p, V(x.x - e, x.y, x.z)), A.sdfAt(p, V(x.x, x.y + e, x.z)) - A.sdfAt(p, V(x.x, x.y - e, x.z)), A.sdfAt(p, V(x.x, x.y, x.z + e)) - A.sdfAt(p, V(x.x, x.y, x.z - e))).normalize()), V());
    if (!(n.lengthSq() > 1e-6)) dirs.forEach(d => n.sub(d)); n.normalize();
    // the guide's centre on the bone surface under the entries' mean
    let P = null; const top = P0.clone().addScaledVector(n, 15); for (let t = 0; t < 40; t += 0.25) { const x = top.clone().addScaledVector(n, -t); if (A.sdfAt(p, x) <= 0) { P = x; break; } }
    P = P || P0;
    const ax = window.AnkGuide && AnkGuide.boneAxis ? AnkGuide.boneAxis(p) : V(0, 0, 1);
    let u = ax.clone().addScaledVector(n, -ax.dot(n)); if (u.lengthSq() < 0.05) u = V(1, 0, 0).addScaledVector(n, -n.x); u.normalize();
    const v = V().crossVectors(n, u).normalize();
    let su = 0, sv = 0; ent.forEach(x => { const d = V().subVectors(x, P); su = Math.max(su, Math.abs(d.dot(u))); sv = Math.max(sv, Math.abs(d.dot(v))); });
    const gq = window.AnkGuide ? AnkGuide.state() : null, prm = gq ? gq.prm : { mat: 'unset', sleeve: 'printed' };
    const mat = window.AnkGuide ? (AnkGuide.MAT[prm.mat] || AnkGuide.MAT.unset) : { clear: 0.3, fit: 0.1, minWall: 2.5 };
    const scs = mine.map((s, k) => { const h = window.AnkGuide ? AnkGuide.holeOf(DRILL[s.D] || 2.5, prm) : { d: (DRILL[s.D] || 2.5) + 0.1, D: (DRILL[s.D] || 2.5) + 2.5 }; return { entry: ent[k], dir: dirs[k], sc: { d: h.d, D: Math.max(h.D, h.d + 3), sleeveH: SLEEVE_H, len: s.L } }; });
    const g = Object.assign({}, St.G_DEFAULT, { L: Math.min(60, Math.max(20, 2 * su + 14)), W: Math.min(40, Math.max(16, 2 * sv + 14)), wrap: 5, wall: Math.max(3, mat.minWall), clear: mat.clear, fit: 0, uc: 0, vc: 0, split: 0, rot: 0, roll: 0, bar: 0, stopP: 0, stopT: 0, stopB: 0, wrapU: null, boss: 0 });
    const occ = x => { const sd = A.sdfAt(p, x); return sd === Infinity ? 0 : Math.max(0, Math.min(1, 0.5 - sd / 0.8)); };
    St.busy(true, xl('Matkap guide\'ı oluşturuluyor…'), { f: 0, restart: true }); await St.sleep();
    try {
      const r = await St.buildGuide({ g, P, u, v, n, pls: [], scs, bone: x => A.sdfAt(p, x) <= 0, field: occ, h: 0.4 });
      dg = { key: dgKey(name), piece: p, name, mesh: r.mesh, scs, req: { g, P, u, v, n, pls: [], scs, wrapProfile: r.result.wrapProfile, seatDir: r.result.seatDir, gap: null },
        info: { volume: r.result.volume, contact: r.result.contact, pieces: r.result.pieces, seat: r.result.seat, sleeves: r.result.screwInfo.map((si, k) => ({ id: mine[k].id, ok: !!si.ok, inBone: si.inBone || 0, d: scs[k].sc.d })) } };
      showDG(); St.emit('changed'); return { ok: true };
    } catch (e) { return { why: String(e.message || e) }; }
    finally { St.busy(false); render(); }
  }
  const dgLive = () => !!(dg && dg.key === dgKey(dg.name) && on() && A.pieces().includes(dg.piece));
  function showDG() {
    if (!dgLive()) { St.setPart('ankDrill', null, null); return; }
    const g = new T.Group(), m = dg.mesh; m.position.copy(dg.piece.c).negate(); g.add(m);
    const pv = dg.piece.pivot; if (pv) { g.position.copy(pv.position); g.quaternion.copy(pv.quaternion); }
    St.setPart('ankDrill', xl('Matkap guide\'ı'), g, 0x6aa84f); St.renderParts && St.renderParts();
  }
  // the guide's files, in the plan frame (moved with its piece, as the cutting guide)
  function drillFiles() {
    if (!dgLive()) return [];
    const stl = St.stlOf(dg.mesh), data = window.AnkGuide && AnkGuide.toPlan ? AnkGuide.toPlan(stl, dg.piece) : stl;
    return [{ name: 'guide/vida_matkap_guide_onizleme_BASMAYIN.stl', data }];
  }
  function drillChecks() {
    if (!on() || !dg) return [];
    if (!dgLive()) return [['warn', 'Uyarı', xl('Vidalar ya da parçalar değişti; matkap guide\'ını yeniden oluşturun.'), 'ank']];
    const o = [];
    dg.info.sleeves.forEach(sl => { const s = screws.find(z => z.id === sl.id); if (!sl.ok && s) o.push(['crit', 'Kritik', xl(`${label(s)}: kovanın altında guide gövdesi yok ya da kemiğe ulaşmıyor.`), 'ank']); });
    if (dg.info.pieces > 1) o.push(['warn', 'Uyarı', xl('Matkap guide\'ı birden fazla parçaya bölündü.'), 'ank']);
    if (dg.info.seat && dg.info.seat.ok && !dg.info.seat.free) o.push(['crit', 'Kritik', xl('Matkap guide\'ı hiçbir yönde takılamıyor.'), 'ank']);
    o.push(['warn', 'Uyarı', xl('Matkap guide\'ının yalnız tarayıcı önizlemesi var (dosya adı "BASMAYIN"); sunucuda üretim STL\'i bu sürümde yalnız kesi guide\'ı için alınır.'), 'ank']);
    return o;
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(drillChecks);

  // ---------- 3D: one cylinder per screw, coloured by its worst check ----------
  function show() {
    if (!on() || !screws.length) { St.setPart('ankScrews', null, null); St.renderParts && St.renderParts(); St.render(); return; }
    const g = new T.Group(), is = issues();
    analyse().forEach(a => {
      if (a.lost) return;
      const mine = is.filter(i => i.id === a.s.id), lvl = mine.some(i => i.lvl === 'crit') ? 'crit' : mine.length ? 'warn' : 'ok';
      const m = new T.Mesh(new T.CylinderGeometry(a.s.D / 2, a.s.D / 2, a.s.L, 16), new T.MeshStandardMaterial({ color: COL[lvl], roughness: 0.35, metalness: 0.6 }));
      m.position.copy(a.w.E).addScaledVector(a.w.d, a.s.L / 2); m.quaternion.setFromUnitVectors(V(0, 1, 0), a.w.d); m.userData.screw = a.s.id; g.add(m);
      const h = new T.Mesh(new T.CylinderGeometry(a.s.D * 0.9, a.s.D * 0.9, 2, 16), m.material.clone()); h.position.copy(a.w.E).addScaledVector(a.w.d, -1); h.quaternion.copy(m.quaternion); g.add(h);
    });
    St.setPart('ankScrews', xl('Vidalar'), g, COL.ok); St.renderParts && St.renderParts(); St.render();
  }
  const cv = St.renderer.domElement, mouse = new T.Vector2(); let down = null;
  cv.addEventListener('pointerdown', e => { down = picking && on() && e.button === 0 ? [e.clientX, e.clientY] : null; });
  cv.addEventListener('pointerup', e => {
    const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
    const rect = cv.getBoundingClientRect(), rw = S.split ? rect.width / 2 : rect.width;
    mouse.set(((e.clientX - rect.left) / rw) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    St.ray.setFromCamera(mouse, St.camera);
    const h = St.ray.intersectObjects(bones().filter(p => p.mesh.parent && p.mesh.parent.visible).map(p => p.mesh), false)[0]; if (!h) return;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
    picking = false; clickAt(h.point, n);
  });
  // a click: entry at the point, straight into the bone (against the surface normal)
  function clickAt(w, n) { const s = add('click', w.clone().addScaledVector(n, 3), n.clone().negate()); changed(); return s; }

  // ---------- panel ----------
  function render() {
    const box = $('ankScrewBox'); if (!box) return;
    if (!on()) { box.innerHTML = ''; return; }
    const res = screws.length ? analyse() : [];
    const rows = res.map(a => { const s = a.s; return `<tr><td>${esc(xl(label(s)))}</td><td>${esc(xl(s.piece))}</td>
      <td><select data-sd="${s.id}" aria-label="${xl('Çap')}">${DIAS.map(D => `<option value="${D}" ${D === s.D ? 'selected' : ''}>Ø${fmt(D, 1)}</option>`).join('')}</select></td>
      <td><input type="number" data-sl="${s.id}" min="${LIM.minLen}" max="${LIM.maxLen}" step="2" value="${s.L}" aria-label="${xl('Boy (mm)')}" style="width:4.5em"></td>
      <td>${a.lost || a.m.exit == null ? '–' : fmt(a.m.exit, 1)}</td><td>${a.lost ? '–' : esc(a.pieces.map(xl).join(' → '))}</td>
      <td><button class="link" data-sa="${s.id}">${xl('Öner')}</button> <button class="link" data-sx="${s.id}">${xl('Sil')}</button></td></tr>`; }).join('');
    box.innerHTML = `<p class="hint more">${xl('Vidalar redükte konumda planlanır ve girdikleri parçayla birlikte hareket eder. Boy önerisi: vida yönünde karşı kortekse kadar olan kemik eksi 2 mm, 2 mm adımlarla. Şablonlar literatürden örnektir; cerrah seçer.')}</p>
      <div class="btns"><button id="asMM">${xl('Medial malleol (2 vida)')}</button><button id="asPost">${xl('Posterior malleol (2 vida)')}</button><button id="asSynd">${xl('Sindesmoz')}</button>
      <button id="asPick" aria-pressed="${picking}">${picking ? xl('Kemiğe tıklayın…') : xl('Tıklayarak ekle')}</button></div>
      ${screws.length ? `<div class="btns">${[...new Set(screws.map(z => z.piece))].map(nm => `<button data-dg="${esc(nm)}">${xl('Matkap guide\'ı')}: ${esc(xl(nm))}</button>`).join('')}</div>${dgLive() ? `<p class="hint">${xl('Matkap guide\'ı')} (${esc(xl(dg.name))}): ${fmt(dg.info.volume / 1000, 1)} cm³ · ${xl('kovan')} ${dg.info.sleeves.filter(x => x.ok).length}/${dg.info.sleeves.length}</p>` : ''}` : ''}
      ${screws.length ? `<div class="tbl"><table><thead><tr><th>${xl('Vida')}</th><th>${xl('Giriş')}</th><th>${xl('Çap')}</th><th>${xl('Boy (mm)')}</th><th>${xl('Karşı korteks (mm)')}</th><th>${xl('Geçtiği parçalar')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">${xl('Henüz vida yok.')}</p>`}`;
    const tp = (id, k) => $(id) && $(id).addEventListener('click', () => { const r = template(k); if (r.why) St.alertMsg(xl(r.why)); });
    tp('asMM', 'mm'); tp('asPost', 'post'); tp('asSynd', 'synd');
    $('asPick') && $('asPick').addEventListener('click', () => { picking = !picking; render(); });
    box.querySelectorAll('[data-sd]').forEach(el => el.addEventListener('change', () => setScrew(+el.dataset.sd, 'D', el.value)));
    box.querySelectorAll('[data-sl]').forEach(el => el.addEventListener('change', () => setScrew(+el.dataset.sl, 'L', el.value)));
    box.querySelectorAll('[data-sa]').forEach(el => el.addEventListener('click', () => setScrew(+el.dataset.sa, 'auto')));
    box.querySelectorAll('[data-dg]').forEach(el => el.addEventListener('click', async () => { const r = await drillGuide(el.dataset.dg); if (r.why) St.alertMsg(xl(r.why)); }));
    box.querySelectorAll('[data-sx]').forEach(el => el.addEventListener('click', () => remove(+el.dataset.sx)));
  }
  function refresh() { render(); show(); showDG(); }

  (window.PlanExt = window.PlanExt || {}).ankScrews = {
    label: 'Malleol vidaları',
    get: () => (on() && screws.length ? JSON.parse(JSON.stringify(screws)) : null),
    set(x) {
      screws = []; seq = 0; cache = null;
      if (Array.isArray(x)) x.slice(0, 20).forEach(s => {
        if (!s || typeof s.piece !== 'string' || !KIND[s.kind] || ![s.c, s.E, s.d].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite))) return;
        screws.push({ id: ++seq, kind: s.kind, piece: s.piece.slice(0, 40), c: s.c.map(Number), E: s.E.map(Number), d: s.d.map(Number), D: DIAS.includes(+s.D) ? +s.D : KIND[s.kind].D, L: Math.max(LIM.minLen, Math.min(LIM.maxLen, +s.L || LIM.minLen)) });
      });
      refresh();
    },
  };
  let tmo = null;
  ['changed', 'ankPieces', 'planApplied'].forEach(ev => bus.addEventListener(ev, () => { if (!on()) return; clearTimeout(tmo); tmo = setTimeout(refresh, 150); }));
  bus.addEventListener('caseType', () => { if (!on()) { screws = []; picking = false; } refresh(); });
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { screws = []; seq = 0; } cache = null; });
  if ($('stAnkS')) $('stAnkS').addEventListener('toggle', () => { if (!$('stAnkS').open) picking = false; render(); });
  render();

  const done = () => screws.length > 0 && !checks().some(c => c[0] === 'crit');
  return { on, issues, drillGuide, drillFiles, drillChecks, drillInfo: () => (dgLive() ? dg : null), DRILL, template, add, clickAt, remove, set: setScrew, suggest, march, analyse, checks, screws: () => screws.map(s => Object.assign({}, s)), world, done, segDist, LIM, KIND, render };
})();
