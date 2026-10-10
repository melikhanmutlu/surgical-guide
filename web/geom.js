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
  return { worldOf, indexOf, reduce, threshold, components, exterior, edt, blur, surfaceNets, splitSeeds };
})();
