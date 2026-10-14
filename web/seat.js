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
  const FREE_MM2 = 2;   // projected overhang (mm²) tolerated as voxel noise: about a 1.4 mm square
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
    return { ok: true, area, dirs, free: free.length, best, blockPts, slides, rots, worstSlide, worstRot, ms: performance.now() - t0 };
  }
  return { analyze, FREE_MM2 };
})();
