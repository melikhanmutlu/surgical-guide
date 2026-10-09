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
  function reduce(vol, target = 0.8) {
    const f = vol.sp.map(s => Math.max(1, Math.round(target / s)));
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
    return { labels, comps };
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
  function dt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  }
  function edt(feature, nx, ny, nz) {
    const D = new Float64Array(feature.length);
    for (let i = 0; i < D.length; i++) D[i] = feature[i] ? 0 : INF;
    const n = Math.max(nx, ny, nz), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const pass = (len, count, idx) => {
      for (let c = 0; c < count; c++) {
        for (let q = 0; q < len; q++) f[q] = D[idx(c, q)];
        dt1d(f, len, d, v, z);
        for (let q = 0; q < len; q++) D[idx(c, q)] = d[q];
      }
    };
    pass(nx, ny * nz, (c, q) => q + nx * c);
    pass(ny, nx * nz, (c, q) => (c % nx) + nx * (q + ny * ((c / nx) | 0)));
    pass(nz, nx * ny, (c, q) => c + nx * ny * q);
    const out = new Float32Array(D.length);
    for (let i = 0; i < D.length; i++) out[i] = Math.sqrt(D[i]);
    return out;
  }

  // separable [1 2 1]/4 blur of a 0/1 mask -> Float32 field
  function blur(mask, nx, ny, nz) {
    let a = Float32Array.from(mask), b = new Float32Array(a.length);
    const strides = [1, nx, nx * ny], dims = [nx, ny, nz];
    for (let ax = 0; ax < 3; ax++) {
      const s = strides[ax], n = dims[ax];
      for (let i = 0; i < a.length; i++) {
        const c = ax === 0 ? i % nx : ax === 1 ? ((i / nx) | 0) % ny : (i / (nx * ny)) | 0;
        const l = c > 0 ? a[i - s] : a[i], r = c < n - 1 ? a[i + s] : a[i];
        b[i] = 0.25 * l + 0.5 * a[i] + 0.25 * r;
      }
      [a, b] = [b, a];
    }
    return a;
  }

  // ---------- surface nets ----------
  // field (nx*ny*nz), inside = field > level. Returns {positions: Float32Array (grid coords), indices: Uint32Array}
  function surfaceNets(field, nx, ny, nz, level = 0.5) {
    const vid = new Int32Array(nx * ny * nz).fill(-1), pos = [], idx = [];
    const nxy = nx * ny;
    const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const val = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const q = corner[c]; val[c] = field[(i + q[0]) + nx * ((j + q[1]) + ny * (k + q[2]))] - level;
        if (val[c] > 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of edges) {
        if ((val[a] > 0) === (val[b] > 0)) continue;
        const t = val[a] / (val[a] - val[b]), A = corner[a], B = corner[b];
        sx += A[0] + t * (B[0] - A[0]); sy += A[1] + t * (B[1] - A[1]); sz += A[2] + t * (B[2] - A[2]); n++;
      }
      vid[i + nx * (j + ny * k)] = pos.length / 3;
      pos.push(i + sx / n, j + sy / n, k + sz / n);
    }
    const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, d, c, a, c, b); else idx.push(a, b, c, a, c, d); };
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const v0 = i + nx * (j + ny * k), here = field[v0] > level;
      // edge along +x from (i,j,k): shared by cubes (i, j-1..j, k-1..k)
      if (j > 0 && k > 0 && here !== (field[v0 + 1] > level))
        quad(vid[v0], vid[v0 - nx], vid[v0 - nx - nxy], vid[v0 - nxy], !here);
      if (i > 0 && k > 0 && here !== (field[v0 + nx] > level))
        quad(vid[v0], vid[v0 - nxy], vid[v0 - 1 - nxy], vid[v0 - 1], !here);
      if (i > 0 && j > 0 && here !== (field[v0 + nxy] > level))
        quad(vid[v0], vid[v0 - 1], vid[v0 - 1 - nx], vid[v0 - nx], !here);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  }

  return { worldOf, indexOf, reduce, threshold, components, exterior, edt, blur, surfaceNets };
})();
