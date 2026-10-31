/* Seating analysis of a guide on bone, on the guide's local voxel grid (x = u along bone, y = v lateral, z = n seating normal).
   1) Insertion: for candidate directions in a cone around n, project guide and bone onto the plane normal to the
      direction (cells one voxel wide); the guide can be lifted off along d only if no bone lies "above" guide material
      in any cell. Every voxel takes part: on a steep face a coarser cell would put the bone of the slope and the shell
      beside it in one cell and report a block that is not there. The block of a direction is the projected area (mm²)
      of the bone overhanging the guide: cells with any such bone × h², whatever the bone's thickness along d (a count of
      voxels × h² was neither an area nor stable against the grid step). A direction is free below FREE_MM2.
   2) Stability: contacts are guide voxels next to bone, with the bone's outward normal. A small motion m is resisted at a
      contact when it pushes into bone (m·normal clearly negative). We report the resisted share of contact area for
      in-plane slides and for rotations about u, v and n. */
'use strict';
window.Seat = (() => {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const FREE_MM2 = 2;
  const AXIS_REACH = 20;   // mm around the contact centroid searched for the least resisted axis along u   // projected overhang (mm²) tolerated as voxel noise: about a 1.4 mm square
  function basis(d) { const t = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], a = norm(cross(t, d)); return [a, cross(d, a)]; }

  function analyze({ Gm, B, D, nx, ny, nz, h, lo, clear }) {
    const t0 = performance.now(), N = nx * ny * nz, nxy = nx * ny;
    const pos = id => { const i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0; return [lo[0] + i * h, lo[1] + j * h, lo[2] + k * h]; };
    // ----- samples: every guide and bone voxel (as grid indices), contacts with the bone's outward normal -----
    let ng = 0, nb = 0;
    for (let id = 0; id < N; id++) { if (Gm[id]) ng++; else if (B[id]) nb++; }
    const gIds = new Int32Array(ng), bIds = new Int32Array(nb), contacts = [];
    ng = 0; nb = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k);
      if (Gm[id]) {
        gIds[ng++] = id;
        if (D[id] * h <= clear + 1.5 * h && i > 0 && j > 0 && k > 0 && i < nx - 1 && j < ny - 1 && k < nz - 1) {
          const g = norm([D[id + 1] - D[id - 1], D[id + nx] - D[id - nx], D[id + nxy] - D[id - nxy]]);
          contacts.push({ r: pos(id), n: g });
        }
      } else if (B[id]) bIds[nb++] = id;
    }
    const area = contacts.length * h * h;
    if (!contacts.length) return { ok: false, area: 0, ms: performance.now() - t0 };

    // ----- 1) insertion directions -----
    // projection in voxel units: cell = one voxel; an axis-aligned d maps every grid column to its own cell
    const tol = clear + h;
    function blocked(d, pts) {
      const [ea, eb] = basis(d);
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const x of [0, nx - 1]) for (const y of [0, ny - 1]) for (const z of [0, nz - 1]) { const a = x * ea[0] + y * ea[1] + z * ea[2], b = x * eb[0] + y * eb[1] + z * eb[2]; if (a < amin) amin = a; if (a > amax) amax = a; if (b < bmin) bmin = b; if (b > bmax) bmax = b; }
      const na = Math.floor(amax - amin) + 2, nbb = Math.floor(bmax - bmin) + 2, top = new Float32Array(na * nbb).fill(Infinity);
      const a0 = amin - 0.5, b0 = bmin - 0.5;
      for (let q = 0; q < gIds.length; q++) {
        const id = gIds[q], i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0;
        const ci = Math.floor(i * ea[0] + j * ea[1] + k * ea[2] - a0) + na * Math.floor(i * eb[0] + j * eb[1] + k * eb[2] - b0), t = (i * d[0] + j * d[1] + k * d[2]) * h;
        if (t < top[ci]) top[ci] = t;
      }
      let n = 0; const hit = new Uint8Array(na * nbb);
      for (let q = 0; q < bIds.length; q++) {
        const id = bIds[q], i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0;
        const ci = Math.floor(i * ea[0] + j * ea[1] + k * ea[2] - a0) + na * Math.floor(i * eb[0] + j * eb[1] + k * eb[2] - b0), m = top[ci];
        if (m !== Infinity && (i * d[0] + j * d[1] + k * d[2]) * h > m + tol) { if (!hit[ci]) { hit[ci] = 1; n++; } if (pts && pts.length < 4000) pts.push(pos(id)); }
      }
      return n * h * h;   // projected area (mm²) of the bone overhanging the guide along d
    }
    const dirs = [];
    for (let tilt = 0; tilt <= 40; tilt += 10) for (let az = 0; az < (tilt ? 360 : 1); az += 45) {
      const tr = tilt * Math.PI / 180, ar = az * Math.PI / 180;
      const d = norm([Math.sin(tr) * Math.cos(ar), Math.sin(tr) * Math.sin(ar), Math.cos(tr)]);
      dirs.push({ tilt, az, d, block: blocked(d) });
    }
    const free = dirs.filter(x => x.block < FREE_MM2), best = free.length ? free[0] : dirs.reduce((a, b) => (b.block < a.block ? b : a));
    // bone that overhangs the guide along the best direction (local grid coordinates), for the 3D view
    const blockPts = []; if (best.block > 0) blocked(best.d, blockPts);

    // ----- 2) stability against slides and rotations (before pins are placed) -----
    const c = contacts.reduce((s, q) => [s[0] + q.r[0], s[1] + q.r[1], s[2] + q.r[2]], [0, 0, 0]).map(x => x / contacts.length);
    const resisted = motion => { let r = 0; for (const q of contacts) { const m = motion(q.r), l = Math.hypot(m[0], m[1], m[2]); if (l > 1e-9 && dot(m, q.n) < -0.17 * l) r++; } return r / contacts.length; };
    const [ea, eb] = basis(best.d), slides = [];
    for (let az = 0; az < 360; az += 45) { const ar = az * Math.PI / 180, m = [0, 1, 2].map(k => Math.cos(ar) * ea[k] + Math.sin(ar) * eb[k]); slides.push({ az, dir: m, r: resisted(() => m) }); }
    const rots = [];
    [['u', [1, 0, 0]], ['v', [0, 1, 0]], ['n', [0, 0, 1]]].forEach(([name, w]) => [1, -1].forEach(sg => {
      const ww = w.map(x => x * sg); rots.push({ axis: name, sign: sg, r: resisted(r => cross(ww, [r[0] - c[0], r[1] - c[1], r[2] - c[2]])) });
    }));
    const worstSlide = slides.reduce((a, b) => (b.r < a.r ? b : a)), worstRot = rots.reduce((a, b) => (b.r < a.r ? b : a));
    // rotation about the bone axis (u) through the best point (plan A2): a shell on a round shaft turns about the
    // shaft's own axis, not about the contact centroid, which lies on the shell. The axis parallel to u is moved over a
    // 1 mm grid within ±AXIS_REACH mm of the centroid (in v and n), inside the bone (an axis outside it turns the guide
    // off the bone, which the hand pressing it on holds), and the least resisted position is kept.
    let axisU = null;
    const ci = Math.min(nx - 1, Math.max(0, Math.round((c[0] - lo[0]) / h)));
    for (let dy = -AXIS_REACH; dy <= AXIS_REACH; dy += 1) for (let dz = -AXIS_REACH; dz <= AXIS_REACH; dz += 1) for (const sg of [1, -1]) {
      const cy = c[1] + dy, cz = c[2] + dz, cj = Math.round((cy - lo[1]) / h), ck = Math.round((cz - lo[2]) / h); let r = 0;
      if (cj < 0 || ck < 0 || cj >= ny || ck >= nz || !B[ci + nx * (cj + ny * ck)]) continue;
      // m = sg·u × (q - axis point) = sg·[0, -(z - cz), y - cy]
      for (const q of contacts) { const my = -sg * (q.r[2] - cz), mz = sg * (q.r[1] - cy), l = Math.hypot(my, mz); if (l > 1e-9 && my * q.n[1] + mz * q.n[2] < -0.17 * l) r++; }
      r /= contacts.length;
      if (!axisU || r < axisU.r) axisU = { r, sign: sg, at: [c[0], cy, cz] };
    }
    return { ok: true, area, dirs, free: free.length, best, blockPts, slides, rots, worstSlide, worstRot, axisU, ms: performance.now() - t0 };
  }
  // ---------- the fit test (plan 2026-10-30): does the guide sit in one position only? ----------
  // The guide is moved on the computer by a small step, every way but the one it is put on along (d, held by the hand
  // and later by the screws' heads): slid T mm in the plane across d (8 directions) and turned A degrees about the bone
  // axis u, the lateral axis v and d itself, each about a few pivots (the contact centroid and points 5, 10, 15 mm
  // inside the bone below it, so a shell on a round shaft turning about the shaft's own axis is caught). A motion is
  // blocked when part of the guide's inner surface would go into bone. The guide is taken as pressed onto the bone: the
  // clearance is the allowance for periosteum and print, not play, so the inner surface stands for the bone surface.
  // The inner surface near a voxel p lies e = dist(p) - clear deeper in the guide; after the motion it is
  // dist(p') - e from the bone, and its approach is (clear + e) - dist(p') = dist(p) - dist(p'). An approach of more
  // than PEN mm over at least BLOCK_MM2 of surface blocks the motion. dist is the sub-voxel signed distance to the
  // bone surface (mm, outside > 0) that the guide itself is built on, read trilinearly, so the test is finer than a voxel.
  // A motion that nothing blocks is a free direction: the guide can sit off its planned place by that much. With the
  // screws in, a motion is also blocked when it moves a screw across its own axis by more than SCREW_PLAY mm.
  const FIT = { T: 0.5, A: 2, PEN: 0.05, BLOCK_MM2: 1, SCREW_PLAY: 0.1, PIVOTS: [0, 5, 10, 15] };
  function freeMoves({ Gm, dist, nx, ny, nz, h, lo, clear, d, screws }, opt = {}) {
    const o = Object.assign({}, FIT, opt), nxy = nx * ny, N = nx * ny * nz;
    d = norm(d || [0, 0, 1]);
    const at = (x, y, z) => {   // trilinear dist at a local position (mm); far outside the grid counts as clear of bone
      const fx = (x - lo[0]) / h, fy = (y - lo[1]) / h, fz = (z - lo[2]) / h;
      if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return 1e3;
      const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz)), a = fx - i, b = fy - j, c = fz - k, q = i + nx * (j + ny * k);
      const c00 = dist[q] * (1 - a) + dist[q + 1] * a, c10 = dist[q + nx] * (1 - a) + dist[q + nx + 1] * a;
      const c01 = dist[q + nxy] * (1 - a) + dist[q + nxy + 1] * a, c11 = dist[q + nxy + nx] * (1 - a) + dist[q + nxy + nx + 1] * a;
      return (c00 * (1 - b) + c10 * b) * (1 - c) + (c01 * (1 - b) + c11 * b) * c;
    };
    // the guide's inner surface: guide voxels within a voxel and a half of the clearance
    const P = [], E = [];
    for (let id = 0; id < N; id++) {
      if (!Gm[id] || dist[id] > clear + 1.5 * h) continue;
      const i = id % nx, j = ((id / nx) | 0) % ny, k = (id / nxy) | 0;
      P.push([lo[0] + i * h, lo[1] + j * h, lo[2] + k * h]); E.push(Math.max(0, dist[id] - clear));
    }
    if (!P.length) return { ok: false, n: 0 };
    const c0 = P.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]).map(x => x / P.length);
    const need = Math.max(1, Math.ceil(o.BLOCK_MM2 / (h * h)));
    // a motion as a map of points: x -> R (x - pivot) + pivot + t
    const rotM = (w, deg) => { const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), [x, y, z] = w, C = 1 - cs; return [[cs + x * x * C, x * y * C - z * sn, x * z * C + y * sn], [y * x * C + z * sn, cs + y * y * C, y * z * C - x * sn], [z * x * C - y * sn, z * y * C + x * sn, cs + z * z * C]]; };
    const apply = (m, q) => { if (m.t) return [q[0] + m.t[0], q[1] + m.t[1], q[2] + m.t[2]]; const r = [q[0] - m.c[0], q[1] - m.c[1], q[2] - m.c[2]], R = m.R; return [R[0][0] * r[0] + R[0][1] * r[1] + R[0][2] * r[2] + m.c[0], R[1][0] * r[0] + R[1][1] * r[1] + R[1][2] * r[2] + m.c[1], R[2][0] * r[0] + R[2][1] * r[1] + R[2][2] * r[2] + m.c[2]]; };
    function pen(m) {
      let n = 0, worst = 0;
      for (let q = 0; q < P.length; q++) { const p2 = apply(m, P[q]), x = E[q] + clear - at(p2[0], p2[1], p2[2]); if (x > o.PEN) n++; if (x > worst) worst = x; }
      return { blocked: n >= need, area: n * h * h, worst };
    }
    // with the screws in: a screw moved across its axis (at its entry and 10 mm down the drill) holds the guide
    const scr = (screws || []).filter(Boolean).map(s => ({ e: s.el, a: norm(s.ol) }));
    const heldByScrews = m => scr.some(s => [0, -10].some(t => { const p = [s.e[0] + s.a[0] * t, s.e[1] + s.a[1] * t, s.e[2] + s.a[2] * t], p2 = apply(m, p), dv = [p2[0] - p[0], p2[1] - p[1], p2[2] - p[2]], al = dot(dv, s.a); return Math.hypot(dv[0] - al * s.a[0], dv[1] - al * s.a[1], dv[2] - al * s.a[2]) > o.SCREW_PLAY; }));
    const [ea, eb] = basis(d), moves = [];
    for (let az = 0; az < 360; az += 45) {
      const ar = az * Math.PI / 180, dir = [0, 1, 2].map(k => Math.cos(ar) * ea[k] + Math.sin(ar) * eb[k]);
      moves.push({ kind: 'slide', az, dir, axis: Math.abs(dir[0]) >= Math.abs(dir[1]) ? 'u' : 'v', t: dir.map(x => x * o.T) });
    }
    for (const [axis, w] of [['u', [1, 0, 0]], ['v', [0, 1, 0]], ['d', d]]) for (const sg of [1, -1]) {
      const ww = w.map(x => x * sg), piv = axis === 'd' ? [0] : o.PIVOTS;
      // one rotation entry per axis and sense: free when the guide turns freely about any of the pivots
      const sub = piv.map(dep => ({ c: [c0[0] - d[0] * dep, c0[1] - d[1] * dep, c0[2] - d[2] * dep], R: rotM(norm(ww), o.A), dep }));
      moves.push({ kind: 'rot', axis, sign: sg, sub });
    }
    for (const m of moves) {
      if (m.kind === 'slide') { const r = pen(m); m.blocked = r.blocked; m.area = r.area; m.worst = r.worst; m.screwHeld = heldByScrews(m); }
      else {
        const rs = m.sub.map(sm => Object.assign(pen(sm), { dep: sm.dep, held: heldByScrews(sm) }));
        const free = rs.filter(r => !r.blocked);
        m.blocked = !free.length; m.area = Math.min(...rs.map(r => r.area)); m.worst = Math.min(...rs.map(r => r.worst));
        m.pivot = free.length ? free[0].dep : null;
        m.screwHeld = free.length ? free.every(r => r.held) : true;
        delete m.sub;
      }
      m.free = !m.blocked; m.freeScrewed = !m.blocked && !m.screwHeld;
    }
    const free = moves.filter(m => m.free), freeScrewed = moves.filter(m => m.freeScrewed);
    return { ok: true, n: P.length, T: o.T, A: o.A, moves, free: free.length, freeScrewed: freeScrewed.length, total: moves.length, screws: scr.length };
  }
  return { analyze, freeMoves, FIT, FREE_MM2 };
})();
