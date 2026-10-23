/* Accuracy metrics (plan Faz 0.1): surface-to-surface distances (mean, RMS, HD95, max, share within a tolerance),
   plane angle and offset, rigid transforms split into a rotation angle and a translation, and the rigid fit of point
   pairs (Kabsch) with a plain ICP on top. Pure functions on plain arrays: no DOM, no three.js, so the page, a worker,
   the unit tests and the real-CT audit all measure with the same code.
   A mesh is { positions: Float32Array|number[] (x,y,z,...), indices?: Uint32Array|number[] }; without indices it is
   a point cloud. Distances are in the mesh units (mm). */
'use strict';
var Metrics = (function () {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.sqrt(dot(a, a));
  const unit = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const r2d = 180 / Math.PI;

  // closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5); returns the squared distance
  function triDist2(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    let q;
    if (d1 <= 0 && d2 <= 0) q = a;
    else {
      const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) q = b;
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
        else {
          const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
          if (d6 >= 0 && d5 <= d6) q = c;
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
              else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
            }
          }
        }
      }
    }
    const d = sub(p, q); return dot(d, d);
  }

  // a uniform grid over the target's triangles (or points) for nearest queries; cell ~ the mean edge length
  function index(mesh) {
    const P = mesh.positions, I = mesh.indices, nv = P.length / 3;
    const items = [];      // each item: [x0,y0,z0, x1,..., x2,...] (a point repeats itself)
    if (I && I.length) for (let t = 0; t < I.length; t += 3) { const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2]; items.push([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]); }
    else for (let v = 0; v < nv; v++) items.push([P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
    if (!items.length) return null;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], edge = 0;
    for (const it of items) {
      for (let q = 0; q < it.length; q += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], it[q + a]); hi[a] = Math.max(hi[a], it[q + a]); }
      if (it.length === 9) edge += Math.hypot(it[3] - it[0], it[4] - it[1], it[5] - it[2]);
    }
    const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    let cell = edge ? 2 * edge / items.length : ext / Math.cbrt(items.length);
    cell = Math.max(cell, ext / 200, 1e-6);
    const dims = [0, 1, 2].map(a => Math.max(1, Math.ceil((hi[a] - lo[a]) / cell) + 1));
    const grid = new Map(), key = (i, j, k) => i + dims[0] * (j + dims[1] * k);
    const cOf = (x, a) => Math.max(0, Math.min(dims[a] - 1, Math.floor((x - lo[a]) / cell)));
    items.forEach((it, n) => {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let q = 0; q < it.length; q += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], it[q + a]); mx[a] = Math.max(mx[a], it[q + a]); }
      for (let k = cOf(mn[2], 2); k <= cOf(mx[2], 2); k++) for (let j = cOf(mn[1], 1); j <= cOf(mx[1], 1); j++) for (let i = cOf(mn[0], 0); i <= cOf(mx[0], 0); i++) {
        const kk = key(i, j, k); let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(n);
      }
    });
    return { items, grid, lo, cell, dims, key, cOf };
  }
  // distance from p to the indexed surface: rings of cells around p until the ring is farther than the best hit
  function nearest(ix, p) {
    const { items, grid, cell, dims, key, cOf } = ix, ci = [cOf(p[0], 0), cOf(p[1], 1), cOf(p[2], 2)];
    let best = Infinity; const seen = new Set();
    const maxR = Math.max(dims[0], dims[1], dims[2]);
    for (let r = 0; r <= maxR; r++) {
      // the closest point of any cell in ring r is at least (r - 1) cells away (p may sit anywhere inside its own cell)
      if (r > 1 && (r - 1) * cell > Math.sqrt(best)) break;
      for (let k = ci[2] - r; k <= ci[2] + r; k++) { if (k < 0 || k >= dims[2]) continue;
        for (let j = ci[1] - r; j <= ci[1] + r; j++) { if (j < 0 || j >= dims[1]) continue;
          for (let i = ci[0] - r; i <= ci[0] + r; i++) { if (i < 0 || i >= dims[0]) continue;
            if (Math.max(Math.abs(i - ci[0]), Math.abs(j - ci[1]), Math.abs(k - ci[2])) !== r) continue;
            const l = grid.get(key(i, j, k)); if (!l) continue;
            for (const n of l) {
              if (seen.has(n)) continue; seen.add(n);
              const it = items[n];
              const d2 = it.length === 9 ? triDist2(p, [it[0], it[1], it[2]], [it[3], it[4], it[5]], [it[6], it[7], it[8]]) : (p[0] - it[0]) ** 2 + (p[1] - it[1]) ** 2 + (p[2] - it[2]) ** 2;
              if (d2 < best) best = d2;
            }
          }
        }
      }
    }
    return Math.sqrt(best);
  }
  const quantile = (sorted, q) => { if (!sorted.length) return NaN; const x = q * (sorted.length - 1), a = Math.floor(x), b = Math.min(sorted.length - 1, a + 1); return sorted[a] + (x - a) * (sorted[b] - sorted[a]); };
  // summary of a list of distances; tol: the share of distances within tol (default 2 mm, plan target >= 98 %)
  function summary(ds, tol = 2) {
    const s = Float64Array.from(ds).sort(); let sum = 0, sq = 0, inTol = 0;
    for (const d of s) { sum += d; sq += d * d; if (d <= tol) inTol++; }
    const n = s.length;
    return { n, mean: n ? sum / n : NaN, rms: n ? Math.sqrt(sq / n) : NaN, median: quantile(s, 0.5), p95: quantile(s, 0.95), hd95: quantile(s, 0.95), p99: quantile(s, 0.99), max: n ? s[n - 1] : NaN, within: n ? inTol / n : NaN, tol };
  }
  // one-way distances from the vertices of `from` (every `step`-th) to the surface `to`
  function distances(from, to, step = 1) {
    const ix = index(to); if (!ix) return [];
    const P = from.positions, out = [];
    for (let v = 0; v < P.length / 3; v += step) out.push(nearest(ix, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]));
    return out;
  }
  // surface distance A -> B, or both ways ({ab, ba, sym}) with symmetric = true; HD95 of the symmetric set is the
  // larger of the two one-way 95th percentiles (the usual definition)
  function surfaceDistance(A, B, opt = {}) {
    const tol = opt.tol == null ? 2 : opt.tol, step = opt.step || 1;
    const ab = summary(distances(A, B, step), tol);
    if (!opt.symmetric) return ab;
    const ba = summary(distances(B, A, step), tol), all = summary(distances(A, B, step).concat(distances(B, A, step)), tol);
    all.hd95 = Math.max(ab.p95, ba.p95); all.max = Math.max(ab.max, ba.max);
    return { ab, ba, sym: all };
  }

  // planes as { p: point, n: normal }: the angle between them (unsigned normals, 0..90°) and how far plane b's point
  // lies from plane a along a's normal
  const planeAngle = (a, b) => Math.acos(Math.min(1, Math.abs(dot(unit(a.n), unit(b.n))))) * r2d;
  const planeOffset = (a, b) => Math.abs(dot(sub(b.p, a.p), unit(a.n)));

  // rigid transform as { R: 3x3 rows, t: [3] } (x' = R x + t), or a 4x4 row-major / three.js column-major array (flag)
  function asRT(T, colMajor) {
    if (T.R) return T;
    const e = T.elements || T, m = (r, c) => colMajor || T.elements ? e[c * 4 + r] : e[r * 4 + c];
    return { R: [[m(0, 0), m(0, 1), m(0, 2)], [m(1, 0), m(1, 1), m(1, 2)], [m(2, 0), m(2, 1), m(2, 2)]], t: [m(0, 3), m(1, 3), m(2, 3)] };
  }
  // the rotation angle (axis-angle, degrees), its axis, the translation and its length; about: the point the rotation is
  // read about (the translation is then that point's displacement, so a rotation about a bone's own centre is no shift)
  function decompose(T, opt = {}) {
    const { R, t } = asRT(T, opt.colMajor), tr = R[0][0] + R[1][1] + R[2][2];
    const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
    let axis = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
    if (len(axis) < 1e-9) axis = [0, 0, 1];
    axis = unit(axis);
    let sh = t.slice();
    if (opt.about) { const c = opt.about, Rc = [dot(R[0], c), dot(R[1], c), dot(R[2], c)]; sh = [Rc[0] + t[0] - c[0], Rc[1] + t[1] - c[1], Rc[2] + t[2] - c[2]]; }
    return { angle: ang * r2d, axis, translation: sh, shift: len(sh) };
  }
  const apply = (T, p) => { const { R, t } = asRT(T); return [dot(R[0], p) + t[0], dot(R[1], p) + t[1], dot(R[2], p) + t[2]]; };
  // axis-angle (degrees) to a rotation matrix (tests and phantoms)
  function rotation(axis, deg) {
    const [x, y, z] = unit(axis), a = deg / r2d, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
    return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
  }

  // symmetric 3x3 eigen decomposition (Jacobi), vectors as columns sorted by value, descending
  function eigSym(A) {
    const a = A.map(r => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 60; it++) {
      let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-15) break;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
    return [0, 1, 2].map(i => ({ val: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.val - x.val);
  }
  // best rigid transform taking points src[i] onto dst[i] (least squares, no scaling): Kabsch through the quaternion
  // form (Horn 1987), which needs only a symmetric 4x4 eigenvector and cannot return a reflection
  function kabsch(src, dst, w) {
    const n = src.length; let W = 0; const cs = [0, 0, 0], cd = [0, 0, 0];
    for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; W += wi; for (let a = 0; a < 3; a++) { cs[a] += wi * src[i][a]; cd[a] += wi * dst[i][a]; } }
    for (let a = 0; a < 3; a++) { cs[a] /= W; cd[a] /= W; }
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1, p = sub(src[i], cs), q = sub(dst[i], cd); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += wi * p[r] * q[c]; }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz], [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
    const q = eig4max(N), [q0, q1, q2, q3] = q;
    const R = [[q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
      [2 * (q1 * q2 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1)],
      [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3]];
    const t = [cd[0] - dot(R[0], cs), cd[1] - dot(R[1], cs), cd[2] - dot(R[2], cs)];
    let rss = 0; for (let i = 0; i < n; i++) { const p = apply({ R, t }, src[i]); rss += (w ? w[i] : 1) * ((p[0] - dst[i][0]) ** 2 + (p[1] - dst[i][1]) ** 2 + (p[2] - dst[i][2]) ** 2); }
    return { R, t, rms: Math.sqrt(rss / W) };
  }
  // eigenvector of the largest eigenvalue of a symmetric 4x4 (Jacobi)
  function eig4max(M) {
    const a = M.map(r => r.slice()), v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let it = 0; it < 100; it++) {
      let p = 0, q = 1, m = 0;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.abs(a[i][j]) > m) { m = Math.abs(a[i][j]); p = i; q = j; }
      if (m < 1e-15) break;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
    let b = 0; for (let i = 1; i < 4; i++) if (a[i][i] > a[b][b]) b = i;
    return [v[0][b], v[1][b], v[2][b], v[3][b]];
  }
  const compose = (A, B) => {            // A after B
    const a = asRT(A), b = asRT(B), R = [0, 1, 2].map(r => [0, 1, 2].map(c => a.R[r][0] * b.R[0][c] + a.R[r][1] * b.R[1][c] + a.R[r][2] * b.R[2][c]));
    return { R, t: apply(a, b.t) };
  };
  // point-to-point ICP of the cloud `src` (array of [x,y,z]) onto the surface/cloud `dst` (a mesh); returns the transform
  // taking src onto dst, the final RMS and the iterations. init: a starting transform. Pairs farther than `reject` mm
  // (after the first iterations) are left out.
  function icp(src, dst, opt = {}) {
    const ix = index(dst); if (!ix) return null;
    const P = dst.positions, cloud = []; for (let v = 0; v < P.length / 3; v++) cloud.push([P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
    const pts = index({ positions: P });                // nearest vertex for the pairing
    const nearestPt = p => { const { items, grid, cell, dims, key, cOf } = pts, ci = [cOf(p[0], 0), cOf(p[1], 1), cOf(p[2], 2)]; let best = Infinity, bi = -1;
      for (let r = 0; r <= Math.max(...dims); r++) { if (r > 1 && (r - 1) * cell > Math.sqrt(best)) break;
        for (let k = ci[2] - r; k <= ci[2] + r; k++) { if (k < 0 || k >= dims[2]) continue; for (let j = ci[1] - r; j <= ci[1] + r; j++) { if (j < 0 || j >= dims[1]) continue; for (let i = ci[0] - r; i <= ci[0] + r; i++) { if (i < 0 || i >= dims[0]) continue;
          if (Math.max(Math.abs(i - ci[0]), Math.abs(j - ci[1]), Math.abs(k - ci[2])) !== r) continue; const l = grid.get(key(i, j, k)); if (!l) continue;
          for (const n of l) { const it = items[n], d2 = (p[0] - it[0]) ** 2 + (p[1] - it[1]) ** 2 + (p[2] - it[2]) ** 2; if (d2 < best) { best = d2; bi = n; } } } } } }
      return bi; };
    let T = opt.init ? asRT(opt.init) : { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }, prev = Infinity, it = 0, rms = Infinity;
    const iters = opt.iters || 50, reject = opt.reject || Infinity;
    for (; it < iters; it++) {
      const a = [], b = [];
      for (const p of src) { const q = apply(T, p), bi = nearestPt(q); if (bi < 0) continue; const c = cloud[bi]; if (it > 2 && Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) > reject) continue; a.push(q); b.push(c); }
      if (a.length < 3) break;
      const step = kabsch(a, b); T = compose(step, T); rms = step.rms;
      if (Math.abs(prev - rms) < (opt.tol || 1e-6)) { it++; break; }
      prev = rms;
    }
    return { R: T.R, t: T.t, rms, iters: it };
  }

  return { surfaceDistance, distances, summary, planeAngle, planeOffset, decompose, apply, rotation, compose, kabsch, icp, eigSym, triDist2 };
})();
if (typeof window !== 'undefined') window.Metrics = Metrics;
if (typeof self !== 'undefined') self.Metrics = Metrics;
