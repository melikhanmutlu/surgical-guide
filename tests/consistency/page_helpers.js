/* Injected into the Guide Studio page by driver.mjs. Read-only helpers around window.Studio:
   waiting for the app to go idle and extracting the plan, the guides (browser preview + server production STL)
   and cropped bone volumes so consistency.py can measure them offline. Nothing here changes how the app plans. */
'use strict';
window.H = (function () {
  const St = window.Studio, S = St.S, $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const v3 = q => [q.x, q.y, q.z];
  function b64(u8) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // idle = busy overlay hidden, no fibula guide build running, the shown guide is the newest; stable for `ms`
  async function idle(ms = 2000, timeout = 900000) {
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
  // crop of a volume (Int16 HU or Float32 field) around a world-space box, in the volume's own index grid
  function crop(vol, arr, bmin, bmax, pad, ctor) {
    const corners = [];
    for (const x of [bmin[0] - pad, bmax[0] + pad]) for (const y of [bmin[1] - pad, bmax[1] + pad]) for (const z of [bmin[2] - pad, bmax[2] + pad]) corners.push(St.G.indexOf(vol, [x, y, z]));
    const dims = [vol.nx, vol.ny, vol.nz];
    const lo = [0, 1, 2].map(a => Math.max(0, Math.floor(Math.min(...corners.map(c => c[a]))))), hi = [0, 1, 2].map(a => Math.min(dims[a] - 1, Math.ceil(Math.max(...corners.map(c => c[a])))));
    const [nx, ny, nz] = [0, 1, 2].map(a => hi[a] - lo[a] + 1), out = new ctor(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const a = nx * (j + ny * k), b = lo[0] + vol.nx * (lo[1] + j + vol.ny * (lo[2] + k)); for (let i = 0; i < nx; i++) out[a + i] = arr[b + i]; }
    return { dims: [nx, ny, nz], lo, sp: vol.sp.slice(), origin: St.G.worldOf(vol, ...lo), axes: vol.axes.map(a => a.slice()), dtype: ctor === Int16Array ? 'int16' : 'float32', data: b64(new Uint8Array(out.buffer)) };
  }
  function bbox(geo) { geo.computeBoundingBox(); const b = geo.boundingBox; return [v3(b.min), v3(b.max)]; }
  function stlB64(mesh) { return b64(St.stlOf(mesh)); }
  // p = the saw slot's centre (pSlot: shifted w/2 towards the defect when the kerf lies on the resected side, kerfSide 1;
  // the fibula guide's slots lie outside the graft faces the same way), plane = the planned cut (the stump / graft face)
  const planeJ = p => ({ p: v3(p.pSlot || p.p), plane: v3(p.p), shift: p.pSlot ? p.pSlot.clone().sub(p.p).dot(p.N) : 0, N: v3(p.N), w: p.w, off: p.off });
  const screwJ = s => ({ entry: s.entry ? v3(s.entry) : null, dir: v3(s.dir), sc: Object.assign({}, s.sc) });
  function seatJ(st) {
    if (!st) return null; if (!st.ok) return { ok: false };
    return { ok: true, area: st.area, free: st.free, ndirs: st.dirs.length, best: { tilt: st.best.tilt, az: st.best.az, d: st.best.d, block: st.best.block },
      dirs: st.dirs.map(d => ({ tilt: d.tilt, az: d.az, d: d.d, block: d.block })), worstSlide: { r: st.worstSlide.r, dir: st.worstSlide.dir }, worstRot: { r: st.worstRot.r, axis: st.worstRot.axis } };
  }
  function resultJ(R) {
    if (!R) return null;
    return { pieces: R.pieces, contact: R.contact, undercut: R.undercut, volume: R.volume, seat: seatJ(R.seat), wrapProfile: R.wrapProfile,
      screwInfo: R.screwInfo.map(si => ({ ok: si.ok, inBone: si.inBone, crossesPlane: si.crossesPlane, exitAt: si.exitAt, entry: si.s && si.s.entry ? v3(si.s.entry) : null, dir: si.s ? v3(si.s.dir) : null, sc: si.s ? Object.assign({}, si.s.sc) : null })) };
  }
  // the app's own bone surface (surface nets of its field) restricted to a box around the guide
  function boneMesh(red, F, bmin, bmax, pad) {
    const corners = [];
    for (const x of [bmin[0] - pad, bmax[0] + pad]) for (const y of [bmin[1] - pad, bmax[1] + pad]) for (const z of [bmin[2] - pad, bmax[2] + pad]) corners.push(St.G.indexOf(red, [x, y, z]));
    const dims = [red.nx, red.ny, red.nz];
    const box = [0, 1, 2].map(a => Math.max(0, Math.floor(Math.min(...corners.map(c => c[a]))))).concat([0, 1, 2].map(a => Math.min(dims[a] - 1, Math.ceil(Math.max(...corners.map(c => c[a]))))));
    const m = St.meshFromNets(St.G.surfaceNets(F, red.nx, red.ny, red.nz, 0.5, box), (x, y, z) => St.G.worldOf(red, x, y, z), null);
    return stlB64(m);
  }
  async function serverSTL(c, raw) {
    try { const t0 = performance.now(); const r = await St.serverGuide(c); return Object.assign({ ok: true, stl: raw ? null : b64(r.stl), watertight: r.watertight, bodies: r.bodies, volume: r.volume, faces: r.faces, ms: r.ms, wall_ms: performance.now() - t0, productionOk: r.productionOk, resolution: r.resolution }, raw ? { raw: r.stl } : {}); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  // the production request(s) exactly as app.js productionSTL sends them: one per guide piece on its own frame (two-guide
  // layout, the pieces' STLs joined), the seating direction of the preview, the bar lug among a piece's screws
  async function productionSTL() {
    const R = S.result;
    if (R && R.parts && R.parts.length === 2) {
      const rs = [];
      for (const pt of R.parts) { const r = await serverSTL(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: pt.g, P: pt.frame.P, pls: pt.pls, scs: pt.lug ? pt.scs.concat([pt.lug]) : pt.scs, wrapProfile: pt.wrapProfile, seatDir: pt.result.seatDir }, pt.frame), true); if (!r.ok) return r; rs.push(r); }
      return { ok: true, stl: b64(St.mergeStl(rs[0].raw, rs[1].raw)), watertight: rs.every(x => x.watertight), bodies: rs.reduce((a, x) => a + x.bodies, 0), volume: rs.reduce((a, x) => a + x.volume, 0), faces: rs.reduce((a, x) => a + x.faces, 0), ms: rs.reduce((a, x) => a + x.ms, 0), pieces: 2 };
    }
    return serverSTL(Object.assign({ vol: S.vol, red: S.red, F: S.maskF, thr: St.segThr(), g: S.g, P: S.anchor.p, pls: St.planesWorld(), scs: St.screwsWorld(), wrapProfile: R && R.wrapProfile, seatDir: R && R.seatDir }, St.frameAxes()));
  }
  async function extract(opt = {}) {
    const out = { t: new Date().toISOString(), plan: St.planOf(), checks: (S.checkList || []).map(c => c.slice(0, 3)), qc: S.qc, thr: +$('thr').value, segMethod: S.segMethod, kind: S.kind, source: S.source,
      red: S.red ? { dims: [S.red.nx, S.red.ny, S.red.nz], sp: S.red.sp } : null, vol: S.vol ? { dims: [S.vol.nx, S.vol.ny, S.vol.nz], sp: S.vol.sp } : null, guideStat: $('guideStat') ? $('guideStat').textContent : '', volBounds: S.vol ? [St.G.worldOf(S.vol, 0, 0, 0), St.G.worldOf(S.vol, S.vol.nx - 1, S.vol.ny - 1, S.vol.nz - 1)] : null };
    if (S.anchor) {
      const f = St.frameAxes();
      out.frame = { P: v3(S.anchor.p), u: v3(f.u), v: v3(f.v), n: v3(f.n) };
      out.g = Object.assign({}, S.g); out.planes = St.planesWorld().map(planeJ); out.screws = St.screwsWorld().map(screwJ); out.result = resultJ(S.result);
      out.resectedVolume = S.resectedVolume; out.resEnds = (E => E && { A: planeJ(E.A), B: { p: v3(E.B.p), N: v3(E.B.N), w: E.B.w }, condyle: E.condyle })(St.resEnds());
    }
    if (S.anchor && St.parts.guide && S.guideOn) {
      const gm = St.parts.guide.obj, [bmin, bmax] = bbox(gm.geometry);
      out.guide = { stl: stlB64(gm), bbox: [bmin, bmax] };
      out.guide.hu = crop(S.vol, S.vol.hu, bmin, bmax, 8, Int16Array);
      out.guide.field = crop(S.red, S.maskF, bmin, bmax, 8, Float32Array);
      out.guide.bone = boneMesh(S.red, S.maskF, bmin, bmax, 6);
      out.guide.split = S.result && S.result.parts && S.result.parts.length === 2 ? 2 : 0;
      if (opt.server !== false) out.guide.server = await productionSTL();
      // the connecting bar of a two-guide layout: a separate part and server call (as app.js productionSTL)
      if (S.result && S.result.bar && S.result.bar.ok && St.parts.bar) {
        out.bar = { stl: stlB64(St.parts.bar.obj) };
        if (opt.server !== false && St.serverBar) try { const r = await St.serverBar(S.result.bar.spec); out.bar.server = { ok: true, stl: b64(r.stl), watertight: r.watertight, bodies: r.bodies, volume: r.volume, clear: r.clear }; } catch (e) { out.bar.server = { ok: false, error: String(e.message || e) }; }
      }
    }
    if (window.Fibula && Fibula.active()) {
      const st = Fibula.state(), F = st.F, c = st.last;
      out.fib = { plan: JSON.parse(JSON.stringify(Fibula.plan())), checks: Fibula.checks().map(x => x.slice(0, 3)), summary: Fibula.summary(),
        F: { label: F.label, smin: F.c.smin, smax: F.c.smax, FR: F.c.FR, FC: v3(F.c.FC), FA: F.c.FA.map(v3), red: { dims: [F.red.nx, F.red.ny, F.red.nz], sp: F.red.sp }, vol: { dims: [F.vol.nx, F.vol.ny, F.vol.nz], sp: F.vol.sp }, ncands: F.cands.length, volBounds: [St.G.worldOf(F.vol, 0, 0, 0), St.G.worldOf(F.vol, F.vol.nx - 1, F.vol.ny - 1, F.vol.nz - 1)], cands: F.cands.map(c => ({ len: c.len, rad: c.rad, C: v3(c.C), tibia: !!c.tibia })) } };
      if (c) {
        out.fib.D = { L: c.D.L, NA: v3(c.D.NA), NB: v3(c.D.NB), PA: v3(c.D.pts[0]), PB: v3(c.D.pts[c.D.pts.length - 1]), pts: c.D.pts.map(v3), up: v3(c.D.up), A: planeJ(c.D.A), B: c.D.B.virtual ? { p: v3(c.D.B.p), N: v3(c.D.B.N), w: c.D.B.w, virtual: true } : planeJ(c.D.B) };
        out.fib.dev = c.dev; out.fib.proxLeft = c.proxLeft; out.fib.used = c.used;
        out.fib.segs = c.segs.map(g => ({ i: g.i, L: g.L, s0: g.s0, s1: g.s1, barrel: g.barrel, a0: g.a0, a1: g.a1, crest: g.crest, x: v3(g.x), b: v3(g.b), z: v3(g.z), n0: v3(g.n0), n1: v3(g.n1), P0: v3(g.P0), P1: v3(g.P1), N0: v3(g.N0), N1: v3(g.N1), M: g.M.elements.slice() }));
        // centre-line offset used for each segment (fibula-local y, z) -- needed to place the fibula-side cut planes
        out.fib.offMid = c.segs.map(g => { const o = F.c.off; return o[Math.min(o.length - 1, Math.max(0, Math.round((g.s0 + g.s1) / 2 - F.c.smin)))]; });
      }
      const fg = S.fib.guide;
      if (fg) {
        const x = fg.ctx, [bmin, bmax] = bbox(fg.mesh.geometry);
        out.fib.guide = { stl: stlB64(fg.mesh), bbox: [bmin, bmax], g: Object.assign({}, x.g), frame: { P: v3(x.P), u: v3(x.u), v: v3(x.v), n: v3(x.n) }, planes: x.pls.map(planeJ), screws: x.scs.map(screwJ), result: resultJ(fg.result) };
        out.fib.guide.hu = crop(F.vol, F.vol.hu, bmin, bmax, 8, Int16Array);
        out.fib.guide.field = crop(F.red, F.c.Fm, bmin, bmax, 8, Float32Array);
        out.fib.guide.bone = boneMesh(F.red, F.c.Fm, bmin, bmax, 6);
        // (as fibula.js production(): the preview's seating direction goes with the request)
        if (opt.server !== false) out.fib.guide.server = await serverSTL({ vol: F.vol, red: F.red, F: F.c.Fm, thr: 250, g: x.g, P: x.P, u: x.u, v: x.v, n: x.n, pls: x.pls, scs: x.scs, wrapProfile: fg.result && fg.result.wrapProfile, seatDir: fg.result && fg.result.seatDir });
      }
    }
    if (window.Osteo && Osteo.get()) out.osteo = Osteo.summary();
    // the app's own fit colour map numbers (Fit module) for its preview guides, as a second opinion
    if (window.Fit && opt.fitmap !== false) {
      try {
        const keep = Fit.view.map, res = {};
        for (const m of ['gap', 'wall']) { Fit.view.map = m; Fit.refresh(); const st = Fit.stats(); res[m] = JSON.parse(JSON.stringify(st)); }
        Fit.view.map = keep; Fit.refresh(); out.fitmap = res;
      } catch (e) { out.fitmap = { error: String(e) }; }
    }
    return out;
  }
  return { idle, extract, b64, sleep, crop };
})();
