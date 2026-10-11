/* Injected into the Guide Studio page by sweep.js (window.SW). Read-only helpers around window.Studio:
   an arch model of the loaded mandible (same idea as surgiguide/plan.py Arch: body band, polar bins, arc length s with
   s = 0 at the midline and + = patient left), a region -> anchor + lesion bounds step that drives the app exactly the way
   a user would (anchor on the buccal surface, 'Rezeksiyon sınırı' sliders, 'Kesileri sınıra göre koy', 'Otomatik planla'),
   and an extraction of everything the app reports (plan, guide result, checks, approval gate, fibula plan and guide).
   Nothing here changes how the app plans. */
'use strict';
window.SW = (function () {
  const St = window.Studio, S = St.S, $ = id => document.getElementById(id), V = St.V;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const v3 = q => (q ? [+q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2)] : null);

  // idle = busy overlay hidden, no fibula guide build running, the shown guide is the newest; stable for `ms`
  async function idle(ms = 1500, timeout = 180000) {
    const t0 = performance.now(); let since = null;
    while (performance.now() - t0 < timeout) {
      const fib = window.Fibula && Fibula.building && Fibula.building();
      const live = St.live, guideOk = !S.guideOn || live.shown >= live.ver;
      const ok = $('busy').hidden && !fib && guideOk;
      if (ok) { if (since === null) since = performance.now(); if (performance.now() - since >= ms) return true; }
      else since = null;
      await sleep(150);
    }
    throw new Error('timeout waiting for idle: ' + $('busyText').textContent);
  }

  // ---------- arch model of the planning bone ----------
  function arch(bodyHeight = 24, binDeg = 2) {
    const r = S.red, m = S.mask, step = 2, P = [];
    let zmin = Infinity;
    for (let k = 0; k < r.nz; k += step) for (let j = 0; j < r.ny; j += step) for (let i = 0; i < r.nx; i += step) {
      if (!m[i + r.nx * (j + r.ny * k)]) continue;
      const w = G.worldOf(r, i, j, k); P.push(w); if (w[2] < zmin) zmin = w[2];
    }
    const body = P.filter(w => w[2] < zmin + bodyHeight);
    const c = body.reduce((a, w) => [a[0] + w[0], a[1] + w[1], a[2] + w[2]], [0, 0, 0]).map(x => x / body.length);
    const theta = body.map(w => Math.atan2(w[0] - c[0], -(w[1] - c[1])) * 180 / Math.PI);
    const bins = new Map();
    body.forEach((w, i) => { const b = Math.floor(theta[i] / binDeg); if (!bins.has(b)) bins.set(b, { n: 0, s: [0, 0, 0], a: 0 }); const q = bins.get(b); q.n++; q.a += theta[i]; q.s[0] += w[0]; q.s[1] += w[1]; q.s[2] += w[2]; });
    let cent = [...bins.values()].filter(q => q.n >= 15).map(q => ({ ang: q.a / q.n, p: q.s.map(x => x / q.n) })).sort((a, b) => a.ang - b.ang);
    // light smoothing of the centre line
    const pts = cent.map((q, i) => { const a = cent[Math.max(0, i - 1)].p, b = cent[Math.min(cent.length - 1, i + 1)].p; return [0, 1, 2].map(k => (a[k] + q.p[k] + b[k]) / 3); });
    const ang = cent.map(q => q.ang), s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
    // s = 0 at the midline (theta = 0)
    let s0 = 0; for (let i = 1; i < ang.length; i++) if (ang[i - 1] <= 0 && ang[i] >= 0) { const t = (0 - ang[i - 1]) / ((ang[i] - ang[i - 1]) || 1); s0 = s[i - 1] + t * (s[i] - s[i - 1]); break; }
    const ss = s.map(x => x - s0);
    return { s: ss, pts, ang, sMin: ss[0], sMax: ss[ss.length - 1], center: c, zmin, nBody: body.length, nAll: P.length, bodyHeight };
  }
  function archPoint(A, s) {
    s = Math.max(A.sMin, Math.min(A.sMax, s));
    let i = 1; while (i < A.s.length - 1 && A.s[i] < s) i++;
    const t = (s - A.s[i - 1]) / ((A.s[i] - A.s[i - 1]) || 1), a = A.pts[i - 1], b = A.pts[i];
    return V(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]));
  }
  function archTangent(A, s, ds = 3) { return archPoint(A, s + ds).sub(archPoint(A, s - ds)).normalize(); }
  async function ensureRef() {
    if (window.Ref && !Ref.get()) { try { await Ref.compute(false); } catch (e) { /* no reference: ramus / condyle regions fall back to the bone top */ } }
    return window.Ref && Ref.get();
  }
  // highest bone point on one side of the arch centre (fallback condyle)
  function topOfSide(A, sign) {
    const r = S.red, m = S.mask; let best = null, bz = -Infinity;
    for (let k = 0; k < r.nz; k += 2) for (let j = 0; j < r.ny; j += 2) for (let i = 0; i < r.nx; i += 2) {
      if (!m[i + r.nx * (j + r.ny * k)]) continue; const w = G.worldOf(r, i, j, k);
      if ((w[0] - A.center[0]) * sign > 15 && w[2] > bz) { bz = w[2]; best = V(...w); }
    }
    return best;
  }
  // region centre, the direction the lesion runs in, and notes. side: 'L' (patient left, +x, +s) or 'R'
  async function regionCentre(A, region, side, len) {
    const sign = side === 'L' ? 1 : -1, sEnd = sign > 0 ? A.sMax : A.sMin, half = Math.abs(sEnd);
    const ref = await ensureRef(), cond = ref && ref.cond && ref.cond[side] ? V(...ref.cond[side]) : null;
    const note = [];
    if (!cond) note.push('kondil bulunamadı');
    const G0 = archPoint(A, sEnd - sign * 4);                              // posterior end of the body band (angle)
    const C = cond || topOfSide(A, sign) || G0.clone().add(V(0, 0, 50));
    const ram = C.clone().sub(G0), ramL = ram.length(), ramD = ram.clone().normalize();
    let s = null, p, dir;
    if (region === 'symphysis') s = sign * 4;
    else if (region === 'parasymphysis') s = sign * 0.30 * half;
    else if (region === 'body') s = sign * 0.62 * half;
    else if (region === 'angle') s = sEnd - sign * 6;
    if (s !== null) { p = archPoint(A, s); dir = archTangent(A, s).multiplyScalar(sign); }
    else if (region === 'ramus') { p = G0.clone().addScaledVector(ramD, 0.45 * ramL); dir = ramD.clone(); }
    else if (region === 'condyle') { p = G0.clone().addScaledVector(ramD, Math.max(0.3 * ramL, ramL - (len / 2 + 4))); dir = ramD.clone(); }
    else throw new Error('unknown region ' + region);
    return { p, dir, s, sEnd, half, ramL, cond: v3(cond), condFound: !!cond, G0: v3(G0), note };
  }
  function setRange(id, v) { const e = $(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }

  // drive the app: anchor on the buccal surface over the region centre, lesion bounds, cuts, resected piece, guide
  async function setRegion(region, side, len, margin = 3) {
    const out = { region, side, len, margin, t: {} }, t0 = performance.now();
    const A = arch(); out.arch = { sMin: +A.sMin.toFixed(1), sMax: +A.sMax.toFixed(1), zmin: +A.zmin.toFixed(1), nBody: A.nBody, nAll: A.nAll, center: A.center.map(x => +x.toFixed(1)) };
    const rc = await regionCentre(A, region, side, len);
    out.centre = { p: v3(rc.p), dir: v3(rc.dir), s: rc.s === null ? null : +rc.s.toFixed(1), sEnd: +rc.sEnd.toFixed(1), ramL: +rc.ramL.toFixed(1), cond: rc.cond, condFound: rc.condFound, note: rc.note };
    out.t.arch = performance.now() - t0;
    // a short stroke of points through the region centre: the app centres the guide on them (anchorFromLesion) and the
    // guide axis follows the local bone axis (setAnchor PCA)
    const h = Math.min(8, len / 2), pts = [-1, -0.5, 0, 0.5, 1].map(f => rc.p.clone().addScaledVector(rc.dir, f * h));
    if (!St.anchorFromLesion(pts)) { out.ok = false; out.why = 'anchor: no bone surface over the region'; return out; }
    out.anchor = { p: v3(S.anchor.p), n: v3(S.anchor.n), axis: v3(S.anchor.axis) };
    out.axisDotDir = +Math.abs(St.frameAxes().u.dot(rc.dir)).toFixed(3);
    // lesion bounds along the guide axis, as the surgeon sets them on the sliders (clamped by the controls to ±45)
    setRange('l_from', -len / 2); setRange('l_to', len / 2); setRange('l_margin', margin);
    out.lesion = { from: S.lesion.from, to: S.lesion.to, margin: S.lesion.margin };
    if (region === 'condyle') {
      const el = $('resType'); el.value = side; el.dispatchEvent(new Event('change'));
      await sleep(600);
      try { await idle(1200, 60000); } catch (e) { out.condyleNote = 'not idle after resType: ' + e.message; }
      out.condyle = S.lesion.condyle; out.condyleAlert = ($('alert') && !$('alert').hidden) ? $('alert').textContent : null;
      if (!S.lesion.condyle) out.note = (out.note || []).concat(['resType rejected (condyle not found)']);
    }
    out.t.anchor = performance.now() - t0;
    $('suggest').click(); await sleep(300); await idle(1200);
    out.t.suggest = performance.now() - t0;
    $('autoPrep').click(); await sleep(500); await idle(2500);
    out.t.guide = performance.now() - t0;
    out.ok = true; out.guideStat = $('guideStat').textContent;
    return out;
  }

  // ---------- extraction ----------
  const planeJ = p => ({ off: +(+p.off).toFixed(2), yaw: p.yaw, pitch: p.pitch, w: p.w });
  function seatJ(st) {
    if (!st) return null; if (!st.ok) return { ok: false };
    return { ok: true, area: +st.area.toFixed(0), free: st.free, ndirs: st.dirs.length, bestTilt: st.best.tilt, bestBlock: +st.best.block.toFixed(1), worstSlide: +st.worstSlide.r.toFixed(3), worstRot: +st.worstRot.r.toFixed(3), rotAxis: st.worstRot.axis };
  }
  function resultJ(R) {
    if (!R) return null;
    return { pieces: R.pieces, contact: +R.contact.toFixed(0), undercut: +R.undercut.toFixed(1), volume: +R.volume.toFixed(0), ms: +R.ms.toFixed(0), seat: seatJ(R.seat), adapt: R.adapt || null,
      screwInfo: R.screwInfo.map(si => ({ ok: si.ok, inBone: si.ok ? +si.inBone.toFixed(1) : null, len: si.s && si.s.sc ? si.s.sc.len : null, crossesPlane: !!si.crossesPlane, slotGap: si.ok && Number.isFinite(si.slotGap) ? +si.slotGap.toFixed(2) : null, exitAt: si.exitAt == null ? null : +si.exitAt.toFixed(1) })) };
  }
  function fitStats() {
    if (!window.Fit) return null;
    try { const keep = Fit.view.map; Fit.view.map = 'gap'; Fit.refresh(); const st = JSON.parse(JSON.stringify(Fit.stats())); Fit.view.map = keep; Fit.refresh(); return st; }
    catch (e) { return { error: String(e) }; }
  }
  function extract() {
    const out = { t: new Date().toISOString(), kind: S.kind, source: S.source && { type: S.source.type, name: S.source.name }, thr: +$('thr').value, segMethod: S.segMethod,
      red: S.red ? { dims: [S.red.nx, S.red.ny, S.red.nz], sp: S.red.sp } : null, guideOn: S.guideOn, guideStat: $('guideStat').textContent,
      lesion: Object.assign({}, S.lesion), g: Object.assign({}, S.g), crit: S.crit, qc: (S.qc || []).map(q => q.slice(0, 3)), checks: (S.checkList || []).map(c => c.slice(0, 4)) };
    if (S.anchor) {
      out.anchor = { p: v3(S.anchor.p), n: v3(S.anchor.n) };
      out.planes = S.planes.map(planeJ); out.planesWorld = St.planesWorld().map(p => ({ p: v3(p.p), N: v3(p.N), off: +p.off.toFixed(2) }));
      out.screws = S.screws.map(sc => sc && { u: sc.u, v: sc.v, tiltU: sc.tiltU, tiltV: sc.tiltV, d: sc.d, len: sc.len });
      out.result = resultJ(S.result); out.resectedVolume = S.resectedVolume || 0;
      const E = St.resEnds(); out.resEnds = E ? { A: v3(E.A.p), B: v3(E.B.p), L: +E.A.p.distanceTo(E.B.p).toFixed(1), condyle: E.condyle } : null;
      out.pending = St.pendingList();
      out.expZipDisabled = $('expZip').disabled; out.expTitle = $('expZip').title; out.expMsg = $('expMsg').textContent; out.pill = $('readyPill').textContent;
    }
    if (window.Fibula && Fibula.active()) {
      const st = Fibula.state(), F = st.F, c = st.last, P0 = Fibula.plan ? null : null;
      const plan = S.fib.plan;
      out.fib = { label: F.label, FR: +F.c.FR.toFixed(2), smin: +F.c.smin.toFixed(1), smax: +F.c.smax.toFixed(1), ncands: F.cands.length, cands: F.cands.map(x => ({ len: +x.len.toFixed(0), rad: +x.rad.toFixed(1), tibia: !!x.tibia })), warn: F.warn || [],
        plan: { n: plan.n, knots: plan.knots, kerf: plan.kerf, distal: plan.distal, mirror: plan.mirror }, checks: Fibula.checks().map(x => x.slice(0, 3)), msg: $('fibMsg').textContent, guideFail: !!S.fib.guideFail };
      if (c) out.fib.res = { L: +c.D.L.toFixed(1), nmid: c.D.nmid, dev: +c.dev.toFixed(2), proxLeft: +c.proxLeft.toFixed(1), used: +c.used.toFixed(1), segs: c.segs.map(g => ({ i: g.i, L: +g.L.toFixed(1), a0: +g.a0.toFixed(1), a1: +g.a1.toFixed(1), crest: +g.crest.toFixed(1), s0: +g.s0.toFixed(1) })) };
      const fg = S.fib.guide;
      if (fg) out.fib.guide = { g: Object.assign({}, fg.ctx.g), result: resultJ(fg.result), nscrews: fg.ctx.scs.length, nullEntry: fg.ctx.scs.filter(s => !s.entry).length };
    }
    out.fit = fitStats();
    if (window.Osteo && Osteo.get && Osteo.get()) { try { out.osteo = Osteo.summary(); } catch (e) { out.osteo = { error: String(e) }; } }
    return out;
  }
  // camera on the mandible guide (or the resection) for a screenshot; returns the canvas rect in page pixels
  function frameMandible(zoom = 1.3) {
    const obj = (St.parts.guide && St.parts.guide.obj) || (St.parts.resected && St.parts.resected.obj) || St.parts.bone.obj;
    if (window.Fibula && Fibula.active()) Fibula.setView('m');
    St.fitTo(obj);
    const d = St.camera.position.clone().sub(St.controls.target).multiplyScalar(zoom); St.camera.position.copy(St.controls.target).add(d); St.controls.update(); St.render();
    const r = St.renderer.domElement.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function frameFibula() {
    if (!(window.Fibula && Fibula.active())) return null;
    Fibula.setView('f'); St.render();
    const r = St.renderer.domElement.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return { idle, arch, setRegion, extract, frameMandible, frameFibula, sleep };
})();
