/* Error propagation (plan D3): how far the reconstruction can end up from the plan when the saw plays in the guide
   slots and the guide seats with its clearance. Monte Carlo over a chain of cut faces, from the fixed stump towards
   the free end (the condyle side):
   - each cut face: the blade lies in a slot g = slot - blade wider than itself and d deep, so its offset c (at the slot
     middle) and tilt t = tan(angle) satisfy |c| + (d / 2) |t| <= g / 2 (the blade's edges stay in the slot); the face
     moves by c along its normal and turns by t about a random axis in the face through the slot middle
   - the guide's seat: a shift of up to `clear` mm and a turn of up to clear / (guide length / 2) rad, shared by all cuts
     of that guide
   A point after face k moves with every face up to k (small-angle sum). A point on a face at distance r from the slot
   middle moves up to max(g / 2, r g / d) from that face alone: the analytic value the test checks.
   The model and its inputs are sample assumptions (the seat model especially): a range for the report, not a measurement. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.ErrProp = (function () {
  const N_RUNS = 4000;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]), unit = a => { const l = len(a) || 1; return mul(a, 1 / l); };
  // a small fast generator, seeded, so a report shows the same range each time
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  // two unit vectors spanning the face
  function basis(N) { const a = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], u = unit(cross(N, a)); return [u, cross(N, u)]; }
  // (c, t) uniform in the diamond |c| + (d / 2) |t| <= g / 2
  function diamond(g, d, R) {
    if (!(g > 0)) return [0, 0];
    for (;;) { const c = (R() * 2 - 1) * g / 2, t = (R() * 2 - 1) * g / d; if (Math.abs(c) + d / 2 * Math.abs(t) <= g / 2) return [c, t]; }
  }
  // a direction uniform in the unit ball, scaled
  function ball(R, s) { for (;;) { const v = [R() * 2 - 1, R() * 2 - 1, R() * 2 - 1]; if (dot(v, v) <= 1) return mul(v, s); } }
  const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0;

  // spec: { faces: [{ p, N, g, d, guide }], guides: { id: { clear, half } }, points: [{ name, p, after, face?, r? }] }
  //   after: index of the last face the point follows (-1: none); face / r: a rim point of that face at distance r from
  //   its slot middle in a random direction in the face (the face's own end deviation)
  function propagate(spec, o = {}) {
    const n = o.n || N_RUNS, R = rng(o.seed || 12345), faces = spec.faces || [], guides = spec.guides || {}, pts = spec.points || [];
    const B = faces.map(f => basis(unit(f.N))), out = pts.map(() => []);
    for (let it = 0; it < n; it++) {
      const seat = {};
      for (const id in guides) { const G = guides[id]; seat[id] = { s: ball(R, G.clear || 0), w: ball(R, (G.clear || 0) / Math.max(G.half || 1, 1)) }; }
      // each face's rigid motion: translation T and small rotation w about the face's point
      const mv = faces.map((f, k) => {
        const N = unit(f.N), [c, t] = diamond(f.g, f.d, R), a = R() * 2 * Math.PI, [u, v] = B[k];
        let w = mul(add(mul(u, Math.cos(a)), mul(v, Math.sin(a))), t), T = mul(N, c);
        const st = f.guide != null && seat[f.guide];
        if (st) { w = add(w, st.w); T = add(T, st.s); }
        return { p: f.p, T, w };
      });
      pts.forEach((q, j) => {
        let p = q.p;
        if (q.face != null) { const [u, v] = B[q.face], a = R() * 2 * Math.PI; p = add(faces[q.face].p, mul(add(mul(u, Math.cos(a)), mul(v, Math.sin(a))), q.r || 0)); }
        let dsp = [0, 0, 0];
        for (let k = 0; k <= q.after && k < mv.length; k++) dsp = add(dsp, add(mv[k].T, cross(mv[k].w, sub(p, mv[k].p))));
        out[j].push(len(dsp));
      });
    }
    return pts.map((q, j) => { const a = out[j].sort((x, y) => x - y); return { name: q.name, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a[a.length - 1] || 0 }; });
  }
  // the analytic largest move of a rim point at r from the slot middle, from its own face's play alone
  const rimMax = (g, d, r) => (g > 0 ? Math.max(g / 2, r * g / d) : 0);

  // ---------- the plan as a chain ----------
  // mandible cuts (ordered along the axis: cut 1 is the fixed stump, the last cut the free end's stump), between them
  // the graft ends from the fibula plan (each graft end is a cut made in the fibula guide), and the condyle on the free
  // side when the symmetry reference found it. The mandible guide is one guide (or two in the two-guide layout).
  function fromPlan() {
    const St = window.Studio; if (!St || !St.S.anchor || St.S.planes.length < 2) return null;
    const S = St.S, g0 = S.g, depth = St.slotDepth(g0), pls = St.planesWorld().slice().sort((a, b) => a.off - b.off);
    const faces = [], points = [], guides = { m: { clear: g0.clear || 0, half: (g0.L || 36) / 2 } };
    if (g0.split === 2) guides.m2 = { clear: g0.clear || 0, half: (g0.L || 36) / 2 };
    const rimM = Math.max(5, (g0.W || 22) / 2);   // the guide's width follows the bone height: half of it is the rim
    const face = (p, N, w, blade, d, guide) => faces.push({ p: p.toArray ? p.toArray() : p, N: N.toArray ? N.toArray() : N, g: Math.max(0, w - blade), d, guide });
    face(pls[0].p, pls[0].N, pls[0].w, g0.blade, depth, 'm');
    points.push({ name: xl('Kesi 1 yüzeyi'), after: 0, face: 0, r: rimM, p: faces[0].p });
    const fib = window.Fibula && Fibula.active() && Fibula.state ? Fibula.state().last : null;
    if (fib && fib.segs && fib.segs.length && S.fib && S.fib.guide && S.fib.guide.ctx) {
      const fg = S.fib.guide.ctx.g, fd = St.slotDepth(fg), fw = Fibula.slotOf(), rimF = 7;
      guides.f = { clear: fg.clear || 0, half: (fg.L || 60) / 2 };
      fib.segs.filter(s => !s.barrel).forEach(s => {
        [[s.P0, s.N0, 'başlangıç'], [s.P1, s.N1, 'bitiş']].forEach(([P, N, w]) => {
          face(P, N, fw, g0.blade, fd, 'f');
          points.push({ name: xl(`Segment ${s.i + 1} ${w} ucu`), after: faces.length - 1, face: faces.length - 1, r: rimF, p: faces[faces.length - 1].p });
        });
      });
    }
    const last = pls[pls.length - 1];
    face(last.p, last.N, last.w, g0.blade, depth, g0.split === 2 ? 'm2' : 'm');
    points.push({ name: xl(`Kesi ${pls.length} yüzeyi`), after: faces.length - 1, face: faces.length - 1, r: rimM, p: faces[faces.length - 1].p });
    const ref = window.Ref && Ref.get && Ref.get(), cond = ref && ref.cond;
    if (cond && (cond.R || cond.L)) {
      // the condyle on the free (last cut's) side
      const side = ['R', 'L'].filter(k => cond[k]).map(k => ({ k, p: cond[k], d: len(sub(cond[k], faces[faces.length - 1].p)) })).sort((a, b) => a.d - b.d)[0];
      points.push({ name: xl(side.k === 'R' ? 'Sağ kondil' : 'Sol kondil'), after: faces.length - 1, p: side.p });
    }
    return { faces, guides, points };
  }
  function run() { const sp = fromPlan(); return sp ? { spec: sp, res: propagate(sp) } : null; }

  (window.ReportSections = window.ReportSections || []).push(d => {
    const r = run(); if (!r) return;
    const St = window.Studio, fmt = St.fmt;
    if (d.keep) d.keep(330); d.h2('Hata yayılımı (öngörü)');
    d.text('Yuvadaki testere boşluğu ve guide oturma boşluğundan beklenen sapma aralığı (Monte Carlo; model örnek varsayımlara dayanır, ölçüm değildir).', { size: 20 });
    d.table(['Nokta', 'Ortanca', '%95', 'En çok'], r.res.map(x => [x.name, `${fmt(x.p50, 2)} mm`, `${fmt(x.p95, 2)} mm`, `${fmt(x.max, 2)} mm`]), [0.4, 0.2, 0.2, 0.2]);
  });
  return { propagate, rimMax, fromPlan, run, N_RUNS };
})();
