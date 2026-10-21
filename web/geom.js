/* Geometry kernel for the guide studio: volumes, segmentation, distance transforms, surface nets.
   All world coordinates are DICOM patient coordinates (LPS, mm). */
'use strict';
const G = (() => {
  const INF = 1e20;

  // ---------- volume ----------
  // vol = { hu: Int16Array, nx, ny, nz, sp:[sx,sy,sz], origin:[x,y,z], axes:[[ix],[jy],[kz]] (unit vectors of i,j,k) }
  function worldOf(vol, i, j, k) {
    const a = vol.axes, s = vol.sp, o = vol.origin;
    return [o[0] + a[0][0] * i * s[0] + a[1][0] * j * s[1] + a[2][0] * k * s[2],
            o[1] + a[0][1] * i * s[0] + a[1][1] * j * s[1] + a[2][1] * k * s[2],
            o[2] + a[0][2] * i * s[0] + a[1][2] * j * s[1] + a[2][2] * k * s[2]];
  }
  function indexOf(vol, p) {
    const d = [p[0] - vol.origin[0], p[1] - vol.origin[1], p[2] - vol.origin[2]], a = vol.axes, s = vol.sp;
    return [(d[0] * a[0][0] + d[1] * a[0][1] + d[2] * a[0][2]) / s[0],
            (d[0] * a[1][0] + d[1] * a[1][1] + d[2] * a[1][2]) / s[1],
            (d[0] * a[2][0] + d[1] * a[2][1] + d[2] * a[2][2]) / s[2]];
  }

  // block-average to ~target mm voxels (keeps memory and meshing time sane in the browser)
  // working grid: whole-voxel binning towards `target` mm, unless that leaves more than maxVox voxels (a large
  // thin-slice study); then an even spacing that fits, sampled trilinearly, so the browser does not run out of memory
  function reduce(vol, target = 0.8, maxVox = 60e6) {
    const f = vol.sp.map(s => Math.max(1, Math.round(target / s)));
    if (Math.floor(vol.nx / f[0]) * Math.floor(vol.ny / f[1]) * Math.floor(vol.nz / f[2]) > maxVox) return resample(vol, Math.cbrt(vol.nx * vol.sp[0] * vol.ny * vol.sp[1] * vol.nz * vol.sp[2] / maxVox) * 1.01);
    const nx = Math.floor(vol.nx / f[0]), ny = Math.floor(vol.ny / f[1]), nz = Math.floor(vol.nz / f[2]);
    const hu = new Int16Array(nx * ny * nz), cnt = f[0] * f[1] * f[2];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let c = 0; c < f[2]; c++) for (let b = 0; b < f[1]; b++) {
        let idx = (i * f[0]) + vol.nx * ((j * f[1] + b) + vol.ny * (k * f[2] + c));
        for (let a = 0; a < f[0]; a++) s += vol.hu[idx + a];
      }
      hu[i + nx * (j + ny * k)] = s / cnt;
    }
    const sp = vol.sp.map((s, d) => s * f[d]);
    const origin = worldOf(vol, (f[0] - 1) / 2, (f[1] - 1) / 2, (f[2] - 1) / 2);
    return { hu, nx, ny, nz, sp, origin, axes: vol.axes };
  }

  function resample(vol, t) {
    const F = vol.sp.map(s => Math.max(1, t / s)), nx = Math.floor(vol.nx / F[0]), ny = Math.floor(vol.ny / F[1]), nz = Math.floor(vol.nz / F[2]);
    const hu = new Int16Array(nx * ny * nz), NX = vol.nx, NXY = vol.nx * vol.ny, src = vol.hu;
    const axis = (n, Fd, N) => { const i0 = new Int32Array(n), w = new Float32Array(n); for (let i = 0; i < n; i++) { const x = Math.min(N - 1, Math.max(0, (i + 0.5) * Fd - 0.5)), a = Math.min(N - 2, Math.floor(x)); i0[i] = Math.max(0, a); w[i] = N > 1 ? x - i0[i] : 0; } return { i0, w }; };
    const X = axis(nx, F[0], vol.nx), Y = axis(ny, F[1], vol.ny), Z = axis(nz, F[2], vol.nz);
    for (let k = 0; k < nz; k++) {
      const z0 = Z.i0[k] * NXY, z1 = Math.min(vol.nz - 1, Z.i0[k] + 1) * NXY, wz = Z.w[k];
      for (let j = 0; j < ny; j++) {
        const y0 = Y.i0[j] * NX, y1 = Math.min(vol.ny - 1, Y.i0[j] + 1) * NX, wy = Y.w[j], o = nx * (j + ny * k);
        for (let i = 0; i < nx; i++) {
          const x0 = X.i0[i], x1 = Math.min(vol.nx - 1, x0 + 1), wx = X.w[i];
          const c00 = src[z0 + y0 + x0] + (src[z0 + y0 + x1] - src[z0 + y0 + x0]) * wx, c10 = src[z0 + y1 + x0] + (src[z0 + y1 + x1] - src[z0 + y1 + x0]) * wx;
          const c01 = src[z1 + y0 + x0] + (src[z1 + y0 + x1] - src[z1 + y0 + x0]) * wx, c11 = src[z1 + y1 + x0] + (src[z1 + y1 + x1] - src[z1 + y1 + x0]) * wx;
          const c0 = c00 + (c10 - c00) * wy, c1 = c01 + (c11 - c01) * wy;
          hu[o + i] = c0 + (c1 - c0) * wz;
        }
      }
    }
    const sp = vol.sp.map((s, d) => s * F[d]);
    const origin = worldOf(vol, (F[0] - 1) / 2, (F[1] - 1) / 2, (F[2] - 1) / 2);
    return { hu, nx, ny, nz, sp, origin, axes: vol.axes };
  }

  // ---------- segmentation ----------
  function threshold(red, thr) {
    const m = new Uint8Array(red.hu.length);
    for (let i = 0; i < m.length; i++) m[i] = red.hu[i] > thr ? 1 : 0;
    return m;
  }
  // 6-connected components; returns {labels, comps:[{label,size,centroid}]} sorted by size
  function components(mask, nx, ny, nz, minSize = 50) {
    const labels = new Int32Array(mask.length), queue = new Int32Array(mask.length), comps = [];
    let next = 0;
    const nxy = nx * ny;
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || labels[s]) continue;
      next++; let head = 0, tail = 0, cx = 0, cy = 0, cz = 0;
      queue[tail++] = s; labels[s] = next;
      while (head < tail) {
        const v = queue[head++], i = v % nx, j = ((v / nx) | 0) % ny, k = (v / nxy) | 0;
        cx += i; cy += j; cz += k;
        if (i > 0 && mask[v - 1] && !labels[v - 1]) { labels[v - 1] = next; queue[tail++] = v - 1; }
        if (i < nx - 1 && mask[v + 1] && !labels[v + 1]) { labels[v + 1] = next; queue[tail++] = v + 1; }
        if (j > 0 && mask[v - nx] && !labels[v - nx]) { labels[v - nx] = next; queue[tail++] = v - nx; }
        if (j < ny - 1 && mask[v + nx] && !labels[v + nx]) { labels[v + nx] = next; queue[tail++] = v + nx; }
        if (k > 0 && mask[v - nxy] && !labels[v - nxy]) { labels[v - nxy] = next; queue[tail++] = v - nxy; }
        if (k < nz - 1 && mask[v + nxy] && !labels[v + nxy]) { labels[v + nxy] = next; queue[tail++] = v + nxy; }
      }
      if (tail >= minSize) comps.push({ label: next, size: tail, centroid: [cx / tail, cy / tail, cz / tail] });
    }
    comps.sort((a, b) => b.size - a.size);
    return { labels, comps, count: next };
  }
  // flood fill from the grid border through empty voxels: true = connected to the outside
  function exterior(mask, nx, ny, nz) {
    const out = new Uint8Array(mask.length), queue = new Int32Array(mask.length), nxy = nx * ny;
    let tail = 0, head = 0;
    const push = v => { if (!mask[v] && !out[v]) { out[v] = 1; queue[tail++] = v; } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
    while (head < tail) {
      const v = queue[head++], i = v % nx, j = ((v / nx) | 0) % ny, k = (v / nxy) | 0;
      if (i > 0) push(v - 1); if (i < nx - 1) push(v + 1);
      if (j > 0) push(v - nx); if (j < ny - 1) push(v + nx);
      if (k > 0) push(v - nxy); if (k < nz - 1) push(v + nxy);
    }
    return out;
  }

  // ---------- Euclidean distance transform (Felzenszwalb & Huttenlocher), distance to nearest feature voxel ----------
  function dt1d(f, n, d, v, z, s) {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let t = ((f[q] + s * s * q * q) - (f[v[k]] + s * s * v[k] * v[k])) / (2 * s * s * (q - v[k]));
      while (t <= z[k]) { k--; t = ((f[q] + s * s * q * q) - (f[v[k]] + s * s * v[k] * v[k])) / (2 * s * s * (q - v[k])); }
      k++; v[k] = q; z[k] = t; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = s * s * (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  // sp = voxel size per axis (mm); omitted: voxel units
  function edt(feature, nx, ny, nz, sp = [1, 1, 1]) {
    const D = new Float64Array(feature.length);
    for (let i = 0; i < D.length; i++) D[i] = feature[i] ? 0 : INF;
    const n = Math.max(nx, ny, nz), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const pass = (len, count, idx, s) => {
      for (let c = 0; c < count; c++) {
        for (let q = 0; q < len; q++) f[q] = D[idx(c, q)];
        dt1d(f, len, d, v, z, s);
        for (let q = 0; q < len; q++) D[idx(c, q)] = d[q];
      }
    };
    pass(nx, ny * nz, (c, q) => q + nx * c, sp[0]);
    pass(ny, nx * nz, (c, q) => (c % nx) + nx * (q + ny * ((c / nx) | 0)), sp[1]);
    pass(nz, nx * ny, (c, q) => c + nx * ny * q, sp[2]);
    const out = new Float32Array(D.length);
    for (let i = 0; i < D.length; i++) out[i] = Math.sqrt(D[i]);
    return out;
  }

  // signed distance (mm) of a 0/1 mask: outside > 0, inside < 0, about 0 on the boundary between a bone voxel and the
  // first voxel outside (each side is measured to the other side's nearest voxel centre, less half a voxel)
  function sdf(mask, nx, ny, nz, sp = [1, 1, 1]) {
    const N = mask.length, inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1;
    const out = edt(mask, nx, ny, nz, sp), inn = edt(inv, nx, ny, nz, sp), h = Math.min(sp[0], sp[1], sp[2]) / 2, r = new Float32Array(N);
    for (let i = 0; i < N; i++) r[i] = mask[i] ? -(inn[i] - h) : out[i] - h;
    return r;
  }
  // separable [1 2 1]/4 blur of a 0/1 mask -> Float32 field
  function blur(mask, nx, ny, nz) {
    // separable [1 2 1]/4 along x, y, z (edges clamp)
    let a = Float32Array.from(mask), b = new Float32Array(a.length);
    const nxy = nx * ny;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const r = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) { const v = r + i; b[v] = 0.25 * a[i > 0 ? v - 1 : v] + 0.5 * a[v] + 0.25 * a[i < nx - 1 ? v + 1 : v]; }
    }
    [a, b] = [b, a];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const r = nx * (j + ny * k), lo = j > 0 ? -nx : 0, hi = j < ny - 1 ? nx : 0;
      for (let i = 0; i < nx; i++) { const v = r + i; b[v] = 0.25 * a[v + lo] + 0.5 * a[v] + 0.25 * a[v + hi]; }
    }
    [a, b] = [b, a];
    for (let k = 0; k < nz; k++) {
      const lo = k > 0 ? -nxy : 0, hi = k < nz - 1 ? nxy : 0, r = nxy * k;
      for (let v = r; v < r + nxy; v++) b[v] = 0.25 * a[v + lo] + 0.5 * a[v] + 0.25 * a[v + hi];
    }
    return b;
  }

  // ---------- surface nets ----------
  // field (nx*ny*nz), inside = field > level. Returns {positions: Float32Array (grid coords), indices: Uint32Array}
  // box = [i0, j0, k0, i1, j1, k1] limits the cells looked at (inclusive voxel range); default the whole grid
  function surfaceNets(field, nx, ny, nz, level = 0.5, box) {
    const nxy = nx * ny;
    const i0 = box ? Math.max(0, box[0]) : 0, j0 = box ? Math.max(0, box[1]) : 0, k0 = box ? Math.max(0, box[2]) : 0;
    const i1 = box ? Math.min(nx - 1, box[3]) : nx - 1, j1 = box ? Math.min(ny - 1, box[4]) : ny - 1, k1 = box ? Math.min(nz - 1, box[5]) : nz - 1;
    const vid = new Int32Array(nx * ny * nz);   // vertex index + 1 (0 = none)
    let pos = new Float32Array(1 << 16), np = 0, idx = new Uint32Array(1 << 17), ni = 0;
    const off = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
    const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const val = new Float32Array(8);
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) {
      const r = nx * (j + ny * k);
      for (let i = i0; i < i1; i++) {
        const v0 = r + i;
        let mask = 0;
        for (let c = 0; c < 8; c++) { const x = field[v0 + off[c]] - level; val[c] = x; if (x > 0) mask |= 1 << c; }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = edges[e][0], b = edges[e][1];
          if ((val[a] > 0) === (val[b] > 0)) continue;
          const t = val[a] / (val[a] - val[b]), A = corner[a], B = corner[b];
          sx += A[0] + t * (B[0] - A[0]); sy += A[1] + t * (B[1] - A[1]); sz += A[2] + t * (B[2] - A[2]); n++;
        }
        if (np + 3 > pos.length) { const q = new Float32Array(pos.length * 2); q.set(pos); pos = q; }
        vid[v0] = np / 3 + 1;
        pos[np++] = i + sx / n; pos[np++] = j + sy / n; pos[np++] = k + sz / n;
      }
    }
    const quad = (a, b, c, d, flip) => {
      if (!a || !b || !c || !d) return;
      if (ni + 6 > idx.length) { const q = new Uint32Array(idx.length * 2); q.set(idx); idx = q; }
      a--; b--; c--; d--;
      if (flip) { idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; }
      else { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
    };
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) {
      const r = nx * (j + ny * k);
      for (let i = i0; i < i1; i++) {
        const v0 = r + i, here = field[v0] > level;
        // edge along +x from (i,j,k): shared by cubes (i, j-1..j, k-1..k)
        if (j > j0 && k > k0 && here !== (field[v0 + 1] > level))
          quad(vid[v0], vid[v0 - nx], vid[v0 - nx - nxy], vid[v0 - nxy], !here);
        if (i > i0 && k > k0 && here !== (field[v0 + nx] > level))
          quad(vid[v0], vid[v0 - nxy], vid[v0 - 1 - nxy], vid[v0 - 1], !here);
        if (i > i0 && j > j0 && here !== (field[v0 + nxy] > level))
          quad(vid[v0], vid[v0 - 1], vid[v0 - 1 - nx], vid[v0 - nx], !here);
      }
    }
    return { positions: pos.slice(0, np), indices: idx.slice(0, ni) };
  }

  // ---------- marching tetrahedra: a closed, 2-manifold surface (what a printable STL needs) ----------
  // field: Float32Array (nx*ny*nz), inside = field < level, linear interpolation along the cube edges, so a plane that
  // is linear in the field (a slot wall, the guide box) comes out exactly where it belongs. Every cube is cut into the
  // six Kuhn tetrahedra around its main diagonal, so two neighbouring cubes always agree on the diagonal of the face
  // they share; vertices are shared per grid edge, and crossings are kept 1 % of an edge away from the grid nodes so no
  // two vertices can coincide. The outer layer of nodes must lie outside (field >= level) for a closed surface.
  // Returns { positions (grid coordinates), indices (CCW seen from outside, field increasing outwards) }.
  const KUHN = (() => { const t = []; [[1, 2, 4], [1, 4, 2], [2, 1, 4], [2, 4, 1], [4, 1, 2], [4, 2, 1]].forEach(([a, b]) => t.push([0, a, a | b, 7])); return t; })();
  function marchTets(field, nx, ny, nz, level = 0) {
    const nxy = nx * ny, off = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
    // vertex index + 1 per (lower node, edge direction mask). A cube layer k only meets the nodes of layers k and k+1,
    // so two node layers are kept (ring buffer), not the whole grid: 32 B per voxel was ~100 MB per guide rebuild on a
    // long guide grid (Denetim 4 W18)
    const vid = new Int32Array(2 * nxy * 8);
    let pos = new Float32Array(1 << 16), np = 0, idx = new Uint32Array(1 << 17), ni = 0;
    const val = new Float32Array(8), ins = [0, 0, 0, 0], outs = [0, 0, 0, 0];
    let ci = 0, cj = 0, ck = 0, v0 = 0;
    const edge = (x, y) => {   // x < y (as cube-corner codes, y a superset of x)
      const nd = v0 + off[x], key = ((((nd / nxy) | 0) & 1) * nxy + nd % nxy) * 8 + (y ^ x);
      let id = vid[key];
      if (id) return id - 1;
      let t = val[x] / (val[x] - val[y]); if (t < 0.01) t = 0.01; else if (t > 0.99) t = 0.99;
      if (np + 3 > pos.length) { const q = new Float32Array(pos.length * 2); q.set(pos); pos = q; }
      const ax = ci + (x & 1), ay = cj + ((x >> 1) & 1), az = ck + (x >> 2), bx = ci + (y & 1), by = cj + ((y >> 1) & 1), bz = ck + (y >> 2);
      pos[np] = ax + t * (bx - ax); pos[np + 1] = ay + t * (by - ay); pos[np + 2] = az + t * (bz - az);
      id = np / 3; np += 3; vid[key] = id + 1;
      return id;
    };
    const cx = c => ci + (c & 1), cy = c => cj + ((c >> 1) & 1), cz = c => ck + (c >> 2);
    const emit = (a, b, c, rx, ry, rz) => {   // triangle a,b,c wound so that its normal points along (rx, ry, rz)
      const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
      const ux = pos[3 * b] - ax, uy = pos[3 * b + 1] - ay, uz = pos[3 * b + 2] - az, wx = pos[3 * c] - ax, wy = pos[3 * c + 1] - ay, wz = pos[3 * c + 2] - az;
      const d = (uy * wz - uz * wy) * rx + (uz * wx - ux * wz) * ry + (ux * wy - uy * wx) * rz;
      if (ni + 3 > idx.length) { const q = new Uint32Array(idx.length * 2); q.set(idx); idx = q; }
      if (d >= 0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; } else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; }
    };
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) {
      if (j === 0 && k > 0) { const b = ((k + 1) & 1) * nxy * 8; vid.fill(0, b, b + nxy * 8); }   // layer k+1 reuses layer k-1's slot
      const r = nx * (j + ny * k);
      for (let i = 0; i < nx - 1; i++) {
        v0 = r + i; ci = i; cj = j; ck = k;
        let neg = 0;
        for (let c = 0; c < 8; c++) { const x = field[v0 + off[c]] - level; val[c] = x; if (x < 0) neg++; }
        if (neg === 0 || neg === 8) continue;
        for (let t = 0; t < 6; t++) {
          const tt = KUHN[t]; let a = 0, b = 0;
          for (let q = 0; q < 4; q++) { if (val[tt[q]] < 0) ins[a++] = tt[q]; else outs[b++] = tt[q]; }
          if (a === 0 || b === 0) continue;
          if (a === 1) {
            const p = ins[0], e1 = edge(Math.min(p, outs[0]), Math.max(p, outs[0])), e2 = edge(Math.min(p, outs[1]), Math.max(p, outs[1])), e3 = edge(Math.min(p, outs[2]), Math.max(p, outs[2]));
            emit(e1, e2, e3, (cx(outs[0]) + cx(outs[1]) + cx(outs[2])) / 3 - cx(p), (cy(outs[0]) + cy(outs[1]) + cy(outs[2])) / 3 - cy(p), (cz(outs[0]) + cz(outs[1]) + cz(outs[2])) / 3 - cz(p));
          } else if (a === 3) {
            const p = outs[0], e1 = edge(Math.min(p, ins[0]), Math.max(p, ins[0])), e2 = edge(Math.min(p, ins[1]), Math.max(p, ins[1])), e3 = edge(Math.min(p, ins[2]), Math.max(p, ins[2]));
            emit(e1, e2, e3, cx(p) - (cx(ins[0]) + cx(ins[1]) + cx(ins[2])) / 3, cy(p) - (cy(ins[0]) + cy(ins[1]) + cy(ins[2])) / 3, cz(p) - (cz(ins[0]) + cz(ins[1]) + cz(ins[2])) / 3);
          } else {
            const a1 = ins[0], a2 = ins[1], b1 = outs[0], b2 = outs[1];
            const e1 = edge(Math.min(a1, b1), Math.max(a1, b1)), e2 = edge(Math.min(a1, b2), Math.max(a1, b2)), e3 = edge(Math.min(a2, b2), Math.max(a2, b2)), e4 = edge(Math.min(a2, b1), Math.max(a2, b1));
            const rx = (cx(b1) + cx(b2) - cx(a1) - cx(a2)) / 2, ry = (cy(b1) + cy(b2) - cy(a1) - cy(a2)) / 2, rz = (cz(b1) + cz(b2) - cz(a1) - cz(a2)) / 2;
            // one winding decision for the whole quad (two triangles on the e1-e3 diagonal)
            const ax = pos[3 * e1], ay = pos[3 * e1 + 1], az = pos[3 * e1 + 2];
            const ux = pos[3 * e2] - ax, uy = pos[3 * e2 + 1] - ay, uz = pos[3 * e2 + 2] - az, wx = pos[3 * e3] - ax, wy = pos[3 * e3 + 1] - ay, wz = pos[3 * e3 + 2] - az;
            const d = (uy * wz - uz * wy) * rx + (uz * wx - ux * wz) * ry + (ux * wy - uy * wx) * rz;
            if (ni + 6 > idx.length) { const q = new Uint32Array(idx.length * 2); q.set(idx); idx = q; }
            if (d >= 0) { idx[ni++] = e1; idx[ni++] = e2; idx[ni++] = e3; idx[ni++] = e1; idx[ni++] = e3; idx[ni++] = e4; }
            else { idx[ni++] = e1; idx[ni++] = e3; idx[ni++] = e2; idx[ni++] = e1; idx[ni++] = e4; idx[ni++] = e3; }
          }
        }
      }
    }
    return { positions: pos.slice(0, np), indices: idx.slice(0, ni) };
  }

  // ---------- quadric edge-collapse decimation of a closed mesh ----------
  // Marching tetrahedra triangulates smooth areas far finer than the shape needs. Edges are collapsed (cheapest first, by
  // the summed squared distance of the new point to the planes of the faces around it) while that error stays under tol²;
  // an edge is only collapsed when the link condition holds (the two ends share exactly the two apex vertices) and no
  // neighbouring face flips or turns into a sliver, so a closed 2-manifold stays one. tol is in the units of the positions.
  function* decimateGen(net, tol, minQ = 0.1) {
    const P = Float64Array.from(net.positions), nv = P.length / 3, F = Int32Array.from(net.indices), nf = F.length / 3;
    const alive = new Uint8Array(nf).fill(1), vAlive = new Uint8Array(nv).fill(1), ver = new Int32Array(nv), Q = new Float64Array(nv * 10), vf = new Array(nv);
    for (let v = 0; v < nv; v++) vf[v] = [];
    const nrm = (a, b, c, out) => {   // unit normal (out) and area*2 of the triangle with vertices a, b, c
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2], wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
      const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx, l = Math.sqrt(x * x + y * y + z * z);
      if (l > 0) { out[0] = x / l; out[1] = y / l; out[2] = z / l; } else { out[0] = out[1] = out[2] = 0; }
      return l;
    };
    const n3 = [0, 0, 0], n3b = [0, 0, 0];
    for (let f = 0; f < nf; f++) {
      if ((f & 16383) === 16383) yield;
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2]; vf[a].push(f); vf[b].push(f); vf[c].push(f);
      if (nrm(a, b, c, n3) === 0) continue;
      const A = n3[0], B = n3[1], C = n3[2], D = -(A * P[3 * a] + B * P[3 * a + 1] + C * P[3 * a + 2]);
      const q = [A * A, A * B, A * C, A * D, B * B, B * C, B * D, C * C, C * D, D * D];
      for (const v of [a, b, c]) for (let k = 0; k < 10; k++) Q[10 * v + k] += q[k];
    }
    // cost of collapsing a-b: best of the two ends, the midpoint and the quadric optimum
    const tq = new Float64Array(10), best = [0, 0, 0];
    const qerr = (x, y, z) => tq[0] * x * x + 2 * tq[1] * x * y + 2 * tq[2] * x * z + 2 * tq[3] * x + tq[4] * y * y + 2 * tq[5] * y * z + 2 * tq[6] * y + tq[7] * z * z + 2 * tq[8] * z + tq[9];
    function cost(a, b) {
      for (let k = 0; k < 10; k++) tq[k] = Q[10 * a + k] + Q[10 * b + k];
      const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2], bx = P[3 * b], by = P[3 * b + 1], bz = P[3 * b + 2];
      let e = qerr(ax, ay, az); best[0] = ax; best[1] = ay; best[2] = az;
      const eb = qerr(bx, by, bz); if (eb < e) { e = eb; best[0] = bx; best[1] = by; best[2] = bz; }
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2, em = qerr(mx, my, mz); if (em < e) { e = em; best[0] = mx; best[1] = my; best[2] = mz; }
      const m00 = tq[0], m01 = tq[1], m02 = tq[2], m11 = tq[4], m12 = tq[5], m22 = tq[7];
      const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
      if (Math.abs(det) > 1e-9) {
        const r0 = -tq[3], r1 = -tq[6], r2 = -tq[8];
        const x = (r0 * (m11 * m22 - m12 * m12) - m01 * (r1 * m22 - m12 * r2) + m02 * (r1 * m12 - m11 * r2)) / det;
        const y = (m00 * (r1 * m22 - m12 * r2) - r0 * (m01 * m22 - m12 * m02) + m02 * (m01 * r2 - r1 * m02)) / det;
        const z = (m00 * (m11 * r2 - r1 * m12) - m01 * (m01 * r2 - r1 * m02) + r0 * (m01 * m12 - m11 * m02)) / det;
        // stay near the edge: an optimum far outside it is a sign of a near-singular system
        if (Math.hypot(x - mx, y - my, z - mz) <= Math.hypot(bx - ax, by - ay, bz - az)) { const eo = qerr(x, y, z); if (eo < e) { e = eo; best[0] = x; best[1] = y; best[2] = z; } }
      }
      return e;
    }
    // binary min-heap of edge records (error, a, b, version of a, version of b); the heap itself holds record numbers
    let hn = 0, rn = 0, cap = 1 << 16, hE = new Float64Array(cap), hA = new Int32Array(cap), hB = new Int32Array(cap), hVa = new Int32Array(cap), hVb = new Int32Array(cap), heap = new Int32Array(cap);
    function push(e, a, b) {
      if (rn === cap) { const g = (o, T) => { const q = new T(cap * 2); q.set(o); return q; }; hE = g(hE, Float64Array); hA = g(hA, Int32Array); hB = g(hB, Int32Array); hVa = g(hVa, Int32Array); hVb = g(hVb, Int32Array); heap = g(heap, Int32Array); cap *= 2; }
      const r = rn++; hE[r] = e; hA[r] = a; hB[r] = b; hVa[r] = ver[a]; hVb[r] = ver[b];
      let i = hn++; while (i > 0) { const p = (i - 1) >> 1; if (hE[heap[p]] <= e) break; heap[i] = heap[p]; i = p; } heap[i] = r;
    }
    function pop() {   // removes the minimum; its record number stays readable in `top`
      const r = heap[--hn]; if (hn === 0) return; const e = hE[r]; let i = 0;
      for (;;) { const l = 2 * i + 1; if (l >= hn) break; let m = l; if (l + 1 < hn && hE[heap[l + 1]] < hE[heap[l]]) m = l + 1; if (hE[heap[m]] >= e) break; heap[i] = heap[m]; i = m; }
      heap[i] = r;
    }
    // edges: every vertex pair that shares a face, once (sorted unique keys)
    const keys = new Float64Array(3 * nf);
    for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) { const a = F[3 * f + k], b = F[3 * f + (k + 1) % 3]; keys[3 * f + k] = Math.min(a, b) * nv + Math.max(a, b); }
    keys.sort();
    for (let i = 0; i < keys.length; i++) { if ((i & 16383) === 16383) yield; if (i && keys[i] === keys[i - 1]) continue; const a = Math.floor(keys[i] / nv), b = keys[i] - a * nv; push(cost(a, b), a, b); }
    const tol2 = tol * tol, live = v => { const l = vf[v]; let w = 0; for (let i = 0; i < l.length; i++) if (alive[l[i]]) l[w++] = l[i]; l.length = w; return l; };
    const shared = [], nA = new Set(), nB = new Set(), nbr = [];
    // quality of triangle (a, b, c) with the vertex `moved` put at (x, y, z); returns [cos to old normal, quality]
    const px = [0, 0, 0];
    function check(f, v, x, y, z) {
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      nrm(a, b, c, n3);
      const ox = P[3 * v], oy = P[3 * v + 1], oz = P[3 * v + 2], oldQ = quality(a, b, c);
      P[3 * v] = x; P[3 * v + 1] = y; P[3 * v + 2] = z;
      const l = nrm(a, b, c, n3b), cosd = n3[0] * n3b[0] + n3[1] * n3b[1] + n3[2] * n3b[2], q = quality(a, b, c);
      P[3 * v] = ox; P[3 * v + 1] = oy; P[3 * v + 2] = oz;
      return l > 0 && cosd > 0.5 && q >= Math.min(minQ, oldQ * 0.9);
    }
    function quality(a, b, c) {   // 4*sqrt(3)*area / sum of squared edge lengths (1 = equilateral)
      const e = (p, q) => { const x = P[3 * p] - P[3 * q], y = P[3 * p + 1] - P[3 * q + 1], z = P[3 * p + 2] - P[3 * q + 2]; return x * x + y * y + z * z; };
      const s = e(a, b) + e(b, c) + e(c, a); return s > 0 ? 2 * Math.sqrt(3) * nrm(a, b, c, px) / s : 0;
    }
    let collapsed = 0;
    let spin = 0;
    while (hn > 0) {
      if ((++spin & 4095) === 0) yield;
      const top = heap[0], e = hE[top], a = hA[top], b = hB[top], va = hVa[top], vb = hVb[top]; pop();
      if (e > tol2) break;
      if (!vAlive[a] || !vAlive[b] || ver[a] !== va || ver[b] !== vb) continue;
      const fa = live(a), fb = live(b);
      shared.length = 0; for (const f of fa) if (F[3 * f] === b || F[3 * f + 1] === b || F[3 * f + 2] === b) shared.push(f);
      if (shared.length !== 2) continue;
      // link condition: the only vertices adjacent to both ends are the apexes of the two faces on the edge
      nA.clear(); nB.clear();
      for (const f of fa) for (let k = 0; k < 3; k++) { const w = F[3 * f + k]; if (w !== a && w !== b) nA.add(w); }
      for (const f of fb) for (let k = 0; k < 3; k++) { const w = F[3 * f + k]; if (w !== a && w !== b) nB.add(w); }
      let common = 0; for (const w of nA) if (nB.has(w)) common++;
      if (common !== 2) continue;
      cost(a, b); const x = best[0], y = best[1], z = best[2];
      let ok = true;
      for (const f of fa) { if (f === shared[0] || f === shared[1]) continue; if (!check(f, a, x, y, z)) { ok = false; break; } }
      if (ok) for (const f of fb) { if (f === shared[0] || f === shared[1]) continue; if (!check(f, b, x, y, z)) { ok = false; break; } }
      if (!ok) continue;
      // collapse b into a at (x, y, z)
      P[3 * a] = x; P[3 * a + 1] = y; P[3 * a + 2] = z;
      alive[shared[0]] = 0; alive[shared[1]] = 0;
      for (const f of fb) { if (!alive[f]) continue; for (let k = 0; k < 3; k++) if (F[3 * f + k] === b) F[3 * f + k] = a; vf[a].push(f); }
      vAlive[b] = 0; vf[b] = []; for (let k = 0; k < 10; k++) Q[10 * a + k] += Q[10 * b + k];
      ver[a]++; collapsed++;
      nbr.length = 0; for (const f of live(a)) for (let k = 0; k < 3; k++) { const w = F[3 * f + k]; if (w !== a && nbr.indexOf(w) < 0) nbr.push(w); }
      for (const w of nbr) push(cost(a, w), a, w);
    }
    // compact
    const map = new Int32Array(nv).fill(-1); let m = 0, nfo = 0;
    for (let f = 0; f < nf; f++) if (alive[f]) { nfo++; for (let k = 0; k < 3; k++) { const v = F[3 * f + k]; if (map[v] < 0) map[v] = m++; } }
    const pos = new Float32Array(3 * m), idx = new Uint32Array(3 * nfo);
    for (let v = 0; v < nv; v++) if (map[v] >= 0) { pos[3 * map[v]] = P[3 * v]; pos[3 * map[v] + 1] = P[3 * v + 1]; pos[3 * map[v] + 2] = P[3 * v + 2]; }
    for (let f = 0, o = 0; f < nf; f++) if (alive[f]) { idx[o++] = map[F[3 * f]]; idx[o++] = map[F[3 * f + 1]]; idx[o++] = map[F[3 * f + 2]]; }
    return { positions: pos, indices: idx, collapsed };
  }
  // the same, run to the end in one go; decimateGen is a generator that yields now and then so a caller can run it in slices
  function decimate(net, tol, minQ) { const it = decimateGen(net, tol, minQ); for (;;) { const r = it.next(); if (r.done) return r.value; } }


  // seeded split of a bone mask (Mimics "Split Mask"): every voxel of the domain goes to the seed that reaches it with
  // the cheapest path; a step into dense bone costs 1, a step through low density (the thin contact between teeth, a
  // joint) costs up to 1 + W, so the border between two layers settles in the contact surface. Dial's bucket queue on
  // the domain's bounding box. seeds: 0 none, 1..255 layer; returns { lab (Uint8, full grid), box }.
  function splitSeeds(red, dom, seeds, lo = 250, hi = 1100, W = 12) {
    const { nx, ny, nz, hu } = red, N = nx * ny * nz;
    let b = [nx, ny, nz, -1, -1, -1];
    for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) if (dom[v]) {
      if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
    }
    const lab = new Uint8Array(N); if (b[3] < 0) return { lab, box: null };
    const sx = b[3] - b[0] + 1, sy = b[4] - b[1] + 1, sz = b[5] - b[2] + 1, M = sx * sy * sz;
    const dist = new Uint16Array(M).fill(65535), sl = new Uint8Array(M), done = new Uint8Array(M), cost = new Uint8Array(M);
    const C = W + 2, buckets = Array.from({ length: C }, () => []);
    const full = (i, j, k) => (i + b[0]) + nx * ((j + b[1]) + ny * (k + b[2]));
    for (let k = 0, m = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++, m++) {
      const v = full(i, j, k); if (!dom[v]) continue;
      cost[m] = 1 + Math.round(W * Math.min(1, Math.max(0, (hi - hu[v]) / (hi - lo))));
      if (seeds[v]) { dist[m] = 0; sl[m] = seeds[v]; buckets[0].push(m); }
    }
    let d = 0, left = buckets[0].length;
    const sxy = sx * sy;
    while (left > 0) {
      const q = buckets[d % C];
      if (!q.length) { d++; continue; }
      const m = q.pop(); left--;
      if (done[m] || dist[m] !== Math.min(d, 65535)) continue;
      done[m] = 1;
      const i = m % sx, j = ((m / sx) | 0) % sy, k = (m / sxy) | 0;
      for (let a = 0; a < 6; a++) {
        let n;
        if (a === 0) { if (i === 0) continue; n = m - 1; } else if (a === 1) { if (i === sx - 1) continue; n = m + 1; }
        else if (a === 2) { if (j === 0) continue; n = m - sx; } else if (a === 3) { if (j === sy - 1) continue; n = m + sx; }
        else if (a === 4) { if (k === 0) continue; n = m - sxy; } else { if (k === sz - 1) continue; n = m + sxy; }
        if (!cost[n] || done[n]) continue;
        const nd = Math.min(65534, d + cost[n]);
        if (nd < dist[n]) { dist[n] = nd; sl[n] = sl[m]; buckets[nd % C].push(n); left++; }
      }
    }
    for (let k = 0, m = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++, m++) if (sl[m]) lab[full(i, j, k)] = sl[m];
    return { lab, box: b };
  }

  // ---------- separating bones that touch (thresholded CT joins bones across thin necks: teeth, joints, ankle) ----------
  // Watershed on the distance transform of the mask. Every local maximum of the distance to the outside is a bone core;
  // two cores are one bone when the neck between them is as thick as `ratio` times the thinner core's thickness (a bone
  // is thick everywhere, a joint or a tooth contact is a thin neck). The cores then grow back over the whole mask, so each
  // piece keeps its full surface and the neck is cut where it is thinnest. Deterministic, linear time per run.
  //   sep = separator(mask, nx, ny, nz, sp, { label })   voxel is in the mask when mask[v] === label (any non-zero when omitted)
  //   sep.run({ ratio, h, base, out, minSize })           writes base + 1.. into out (default: a new whole-grid Int32Array) and
  //                                                       returns comps [{label,size,centroid,peak,box:[i0,j0,k0,i1,j1,k1]}] by size;
  //                                                       the EDT is computed once, runs with other ratios are cheap
  //   sep.restore(value)                                  puts `value` back into every mask voxel of the last `out`
  // peak = largest distance to the outside in the piece (mm, thickness / 2)
  function separator(mask, nx, ny, nz, sp = [1, 1, 1], opt = {}) {
    const lbl = opt.label, nxy = nx * ny;
    let x0 = nx, y0 = ny, z0 = nz, x1 = -1, y1 = -1, z1 = -1;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const r = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) if (lbl === undefined ? mask[r + i] : mask[r + i] === lbl) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; if (k < z0) z0 = k; if (k > z1) z1 = k; }
    }
    if (x1 < 0) return { run: () => [], restore: () => {}, empty: true };
    const cx = x1 - x0 + 3, cy = y1 - y0 + 3, cz = z1 - z0 + 3, cxy = cx * cy, N = cx * cy * cz;   // 1 voxel of background all round
    const cm = new Uint8Array(N), feat = new Uint8Array(N); feat.fill(1);
    let nm = 0;
    for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const w = mask[i + nx * (j + ny * k)];
      if (lbl === undefined ? w : w === lbl) { const c = (i - x0 + 1) + cx * ((j - y0 + 1) + cy * (k - z0 + 1)); cm[c] = 1; feat[c] = 0; nm++; }
    }
    const D = edt(feat, cx, cy, cz, sp);
    // counting sort of the mask voxels by distance, thickest first
    const q = Math.min(sp[0], sp[1], sp[2]) / 16; let maxD = 0;
    for (let v = 0; v < N; v++) if (cm[v] && D[v] > maxD) maxD = D[v];
    const NL = Math.ceil(maxD / q) + 2, cnt = new Int32Array(NL + 1), lev = v => NL - 1 - Math.round(D[v] / q);
    for (let v = 0; v < N; v++) if (cm[v]) cnt[lev(v) + 1]++;
    for (let l = 0; l < NL; l++) cnt[l + 1] += cnt[l];
    const order = new Int32Array(nm);
    for (let v = 0; v < N; v++) if (cm[v]) order[cnt[lev(v)]++] = v;
    const nb = [-1, 1, -cx, cx, -cxy, cxy], full = v => (v % cx + x0 - 1) + nx * ((((v / cx) | 0) % cy) + y0 - 1 + ny * (((v / cxy) | 0) + z0 - 1));
    let lastOut = null;
    function run(o = {}) {
      const ratio = o.ratio == null ? 0.5 : o.ratio, h = o.h == null ? 0 : o.h, base = o.base || 0, minSize = o.minSize || 1;
      const out = o.out || new Int32Array(mask.length); lastOut = out;
      const lab = new Int32Array(N), parent = [0], peak = [0];       // component id 1.. (0 = none)
      const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
      const roots = [];
      for (let t = 0; t < nm; t++) {
        const v = order[t], d = D[v];
        let best = 0, bd = -1; roots.length = 0;
        for (let a = 0; a < 6; a++) {
          const u = v + nb[a]; if (!lab[u]) continue;
          const r = find(lab[u]); if (roots.indexOf(r) < 0) roots.push(r);
          if (D[u] > bd) { bd = D[u]; best = r; }
        }
        if (!roots.length) { parent.push(parent.length); peak.push(d); lab[v] = parent.length - 1; continue; }
        // the core with the highest peak wins; a core whose neck here is thick enough joins it
        let top = roots[0]; for (const r of roots) if (peak[r] > peak[top]) top = r;
        for (const r of roots) if (r !== top && (peak[r] - d < h || d >= ratio * peak[r])) parent[r] = top;
        lab[v] = find(best);
      }
      const map = new Int32Array(parent.length), info = [];
      for (let t = 0; t < nm; t++) {
        const v = order[t], r = find(lab[v]);
        if (!map[r]) { map[r] = info.length + 1; info.push({ size: 0, cx: 0, cy: 0, cz: 0, peak: peak[r], box: [nx, ny, nz, -1, -1, -1] }); }
        const c = info[map[r] - 1]; c.size++;
        const i = v % cx + x0 - 1, j = ((v / cx) | 0) % cy + y0 - 1, k = ((v / cxy) | 0) + z0 - 1, bx = c.box;
        c.cx += i; c.cy += j; c.cz += k;
        if (i < bx[0]) bx[0] = i; if (j < bx[1]) bx[1] = j; if (k < bx[2]) bx[2] = k; if (i > bx[3]) bx[3] = i; if (j > bx[4]) bx[4] = j; if (k > bx[5]) bx[5] = k;
        out[i + nx * (j + ny * k)] = base + map[r];
      }
      const comps = [];
      info.forEach((c, id) => { if (c.size >= minSize) comps.push({ label: base + id + 1, size: c.size, centroid: [c.cx / c.size, c.cy / c.size, c.cz / c.size], peak: c.peak, box: c.box }); });
      comps.sort((a, b) => b.size - a.size);
      comps.ids = info.length;      // label numbers used: base + 1 .. base + ids
      return comps;
    }
    const restore = value => { if (lastOut) for (let t = 0; t < nm; t++) lastOut[full(order[t])] = value; };
    return { run, restore, N: nm };
  }
  // one-shot: whole-grid labels of the pieces of `mask` (nonzero voxels), like components()
  function separate(mask, nx, ny, nz, sp, opt = {}) {
    const sepr = separator(mask, nx, ny, nz, sp), labels = new Int32Array(mask.length);
    return { labels, comps: sepr.run({ ...opt, out: labels }) };
  }
  return { worldOf, indexOf, reduce, threshold, components, separator, separate, exterior, edt, sdf, blur, surfaceNets, marchTets, decimate, decimateGen, splitSeeds };
})();
