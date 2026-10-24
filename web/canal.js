/* Inferior alveolar canal and tooth roots (plan 1.4). The bone model fills the canal (a closed tube of soft tissue inside
   the bone is filled with the bone, app.js fineField), so a screw path across it looked like solid bone: guide and plate
   screws were checked against the far cortex only. Here the surgeon marks the canal on the slices or the 3D view: a click
   at the mental foramen, one at the mandibular foramen (more clicks in between bend the path), and the path between two
   clicks follows the darkest tube inside the bone (a least-cost path on the 0.8 mm grid, cost rising with HU). A root is
   marked with two clicks (crown side, apex) and taken as a capsule. A guide or plate screw nearer than SAFE mm to the
   canal, or through a root, is critical; automatic guide screws stop SAFE mm short of the canal (app.js fitScrewLen).
   Both are part of the plan (PlanExt.canal); a plan without them is saved as before. The distances are sample values;
   the clinical team sets them. */
'use strict';
var xl = s => (window.I18N ? I18N.t(s) : s);
window.Canal = (function () {
  const St = window.Studio; if (!St) return null;
  const { S, V, G, fmt, bus, scene } = St, $ = id => document.getElementById(id);
  const R_CANAL = 1.5, SAFE = 2, R_ROOT = 2.5, MARGIN = 6, COLOR = 0xf2c94c, ROOT_COLOR = 0xf4efe2;
  S.canals = S.canals || []; S.roots = S.roots || [];
  let mode = null, keys = [], cur = -1;
  const r2 = x => Math.round(x * 100) / 100, arr = q => (Array.isArray(q) ? q.slice() : [q.x, q.y, q.z]).map(r2);

  // ---------- the path between two clicks: least cost through the bone, cheap where the CT is dark ----------
  function trace(a, b) {
    const r = S.red, m = S.mask; if (!r || !r.hu) return [a, b];
    const ia = G.indexOf(r, a), ib = G.indexOf(r, b), pad = [0, 1, 2].map(k => Math.ceil(MARGIN / r.sp[k]));
    const lo = [0, 1, 2].map(k => Math.max(0, Math.floor(Math.min(ia[k], ib[k])) - pad[k])), hi = [0, 1, 2].map(k => Math.min([r.nx, r.ny, r.nz][k] - 1, Math.ceil(Math.max(ia[k], ib[k])) + pad[k]));
    const n = [0, 1, 2].map(k => hi[k] - lo[k] + 1), N = n[0] * n[1] * n[2], nxy = n[0] * n[1];
    if (N > 2e6 || N < 8) return [a, b];   // (clicks far apart: add a point in between)
    // the bone filled across the path's main direction (slice by slice: the canal runs out of the box at both ends, so
    // in 3D its inside reaches the outside), cost = 1 + ((HU + 200) / 250)², outside the bone 60
    const d = [0, 1, 2].map(k => Math.abs(ib[k] - ia[k])), ax = d.indexOf(Math.max(...d)), [p, q] = [0, 1, 2].filter(k => k !== ax);
    const idx = (i, j, k) => i + n[0] * (j + n[1] * k), at = c => [c % n[0], ((c / n[0]) | 0) % n[1], (c / nxy) | 0];
    const bone = new Uint8Array(N);
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) if (m && m[(lo[0] + i) + r.nx * ((lo[1] + j) + r.ny * (lo[2] + k))]) bone[idx(i, j, k)] = 1;
    const inside = new Uint8Array(N), seen = new Uint8Array(n[p] * n[q]), qu = new Int32Array(n[p] * n[q]);
    for (let s = 0; s < n[ax]; s++) {
      seen.fill(0); let h = 0, t = 0;
      const cell = (u, w) => { const c = [0, 0, 0]; c[ax] = s; c[p] = u; c[q] = w; return idx(c[0], c[1], c[2]); };
      const push = (u, w) => { const c = u + n[p] * w; if (seen[c] || bone[cell(u, w)]) return; seen[c] = 1; qu[t++] = c; };
      for (let u = 0; u < n[p]; u++) { push(u, 0); push(u, n[q] - 1); } for (let w = 0; w < n[q]; w++) { push(0, w); push(n[p] - 1, w); }
      while (h < t) { const c = qu[h++], u = c % n[p], w = (c / n[p]) | 0; if (u > 0) push(u - 1, w); if (u < n[p] - 1) push(u + 1, w); if (w > 0) push(u, w - 1); if (w < n[q] - 1) push(u, w + 1); }
      for (let c = 0; c < n[p] * n[q]; c++) if (!seen[c]) inside[cell(c % n[p], (c / n[p]) | 0)] = 1;
    }
    const cost = new Float32Array(N);
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
      const c = idx(i, j, k), hu = Math.max(-200, Math.min(1600, r.hu[(lo[0] + i) + r.nx * ((lo[1] + j) + r.ny * (lo[2] + k))]));
      cost[c] = inside[c] ? 1 + ((hu + 200) / 250) ** 2 : 60;
    }
    const cl = (x, k) => Math.max(0, Math.min(n[k] - 1, Math.round(x - lo[k])));
    const s0 = idx(cl(ia[0], 0), cl(ia[1], 1), cl(ia[2], 2)), s1 = idx(cl(ib[0], 0), cl(ib[1], 1), cl(ib[2], 2));
    // Dijkstra, 26 neighbours, a binary heap
    const D = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const hp = [], hk = [];
    const hpush = (c, v) => { hp.push(c); hk.push(v); let i = hp.length - 1; while (i) { const pa = (i - 1) >> 1; if (hk[pa] <= hk[i]) break; [hp[pa], hp[i]] = [hp[i], hp[pa]]; [hk[pa], hk[i]] = [hk[i], hk[pa]]; i = pa; } };
    const hpop = () => { const c = hp[0], lc = hp.pop(), lk = hk.pop(); if (hp.length) { hp[0] = lc; hk[0] = lk; let i = 0; for (;;) { const l = 2 * i + 1, rr = l + 1; let s = i; if (l < hp.length && hk[l] < hk[s]) s = l; if (rr < hp.length && hk[rr] < hk[s]) s = rr; if (s === i) break; [hp[s], hp[i]] = [hp[i], hp[s]]; [hk[s], hk[i]] = [hk[i], hk[s]]; i = s; } } return c; };
    const nb = []; for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj || dk) nb.push([di, dj, dk, Math.hypot(di * r.sp[0], dj * r.sp[1], dk * r.sp[2])]);
    D[s0] = 0; hpush(s0, 0);
    while (hp.length) {
      const c = hpop(); if (done[c]) continue; done[c] = 1; if (c === s1) break;
      const [i, j, k] = at(c);
      for (const [di, dj, dk, len] of nb) {
        const x = i + di, y = j + dj, z = k + dk; if (x < 0 || y < 0 || z < 0 || x >= n[0] || y >= n[1] || z >= n[2]) continue;
        const e = idx(x, y, z); if (done[e]) continue;
        const v = D[c] + len * (cost[c] + cost[e]) / 2; if (v < D[e]) { D[e] = v; from[e] = c; hpush(e, v); }
      }
    }
    if (!done[s1]) return [a, b];
    const path = []; for (let c = s1; c >= 0; c = from[c]) { const [i, j, k] = at(c); path.push(G.worldOf(r, lo[0] + i, lo[1] + j, lo[2] + k)); }
    path.reverse(); path[0] = a.slice(); path[path.length - 1] = b.slice();
    return resample(smooth(path), 1);
  }
  const smooth = P => P.map((x, i) => { if (!i || i === P.length - 1) return x; const w = P.slice(Math.max(0, i - 2), i + 3); return [0, 1, 2].map(k => w.reduce((s, q) => s + q[k], 0) / w.length); });
  function resample(P, step) {
    const out = [P[0]]; let carry = 0;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      for (let t = step - carry; t < L; t += step) out.push([0, 1, 2].map(k => a[k] + (b[k] - a[k]) * t / L));
      carry = (carry + L) % step;
    }
    out.push(P[P.length - 1]); return out.map(arr);
  }

  // ---------- distances ----------
  // the shortest distance between segments a0-a1 and b0-b1 (arrays or vectors)
  function segSeg(a0, a1, b0, b1) {
    const A = V(...arr(a0)), B = V(...arr(b0)), u = V(...arr(a1)).sub(A), v = V(...arr(b1)).sub(B), w = A.clone().sub(B);
    const a = u.dot(u), b = u.dot(v), c = v.dot(v), d = u.dot(w), e = v.dot(w), D = a * c - b * b;
    let s, t;
    if (a < 1e-12 && c < 1e-12) return w.length();
    if (a < 1e-12) { s = 0; t = Math.max(0, Math.min(1, e / c)); }
    else if (c < 1e-12) { t = 0; s = Math.max(0, Math.min(1, -d / a)); }
    else {
      s = D > 1e-12 ? Math.max(0, Math.min(1, (b * e - c * d) / D)) : 0;
      t = (b * s + e) / c;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -d / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - d) / a)); }
    }
    return A.addScaledVector(u, s).sub(B.addScaledVector(v, t)).length();
  }
  // a screw (entry, direction, length, radius) to the nearest canal wall: mm (Infinity with no canal)
  function canalClear(entry, dir, len, rad) {
    const b = V(...arr(entry)).addScaledVector(dir, len); let m = Infinity;
    for (const c of S.canals) for (let i = 1; i < c.pts.length; i++) m = Math.min(m, segSeg(entry, b, c.pts[i - 1], c.pts[i]));
    return m - R_CANAL - rad;
  }
  // the roots a screw passes through: their numbers (from 1)
  function rootsHit(entry, dir, len, rad) {
    const b = V(...arr(entry)).addScaledVector(dir, len), out = [];
    S.roots.forEach((rt, i) => { if (segSeg(entry, b, rt.a, rt.b) < rt.r + rad) out.push(i + 1); });
    return out;
  }
  // the longest whole-mm length that keeps SAFE mm to the canal (null: no limit)
  function maxLen(entry, dir, len, rad) {
    if (!S.canals.length || canalClear(entry, dir, len, rad) >= SAFE) return null;
    let L = Math.floor(len); while (L > 0 && canalClear(entry, dir, L, rad) < SAFE) L--;
    return L;
  }

  // ---------- suggestion (plan B1): the canal found as a long thin dark tube inside the bone ----------
  // Inside the planning bone (0.8 mm grid: cells the bone encloses) the canal is a run of dark cells (under TUBE_HU: soft
  // tissue, where cancellous bone is brighter). Dark groups that
  // are long (TUBE_LEN mm or more end to end) and thin (volume / length at most TUBE_AREA mm²) are canal candidates;
  // blobs of marrow are neither. The two longest give a suggestion each: the path is traced between the group's two
  // farthest cells like a hand-marked canal. A suggestion is shown apart and counts for nothing until the surgeon
  // accepts it. (Sample values, set on the phantom.)
  function insideOf(r, m) {
    const { nx, ny, nz } = r, at = (i, j, k) => i + nx * (j + ny * k);
    // the inside of the bone: cells the bone encloses in a slice of any of the three orientations (the canal is a hole
    // in the threshold mask that opens at the foramina, so it is enclosed across its course, not along it)
    const inside = new Uint8Array(nx * ny * nz), dims = [nx, ny, nz];
    for (const ax of [0, 1, 2]) {
      const [p, q] = [0, 1, 2].filter(k => k !== ax), np = dims[p], nq = dims[q], seen = new Uint8Array(np * nq), qu = new Int32Array(np * nq);
      for (let s2 = 0; s2 < dims[ax]; s2++) {
        seen.fill(0); let h = 0, t = 0;
        const cell = (u, w) => { const c = [0, 0, 0]; c[ax] = s2; c[p] = u; c[q] = w; return at(c[0], c[1], c[2]); };
        const push = (u, w) => { const c = u + np * w; if (seen[c] || m[cell(u, w)]) return; seen[c] = 1; qu[t++] = c; };
        for (let u = 0; u < np; u++) { push(u, 0); push(u, nq - 1); } for (let w = 0; w < nq; w++) { push(0, w); push(np - 1, w); }
        while (h < t) { const c = qu[h++], u = c % np, w = (c / np) | 0; if (u > 0) push(u - 1, w); if (u < np - 1) push(u + 1, w); if (w > 0) push(u, w - 1); if (w < nq - 1) push(u, w + 1); }
        for (let c = 0; c < np * nq; c++) if (!seen[c]) { const e = cell(c % np, (c / np) | 0); if (!m[e]) inside[e] = 1; }
      }
    }
    return inside;
  }
  const TUBE_HU = 300, TUBE_LEN = 20, TUBE_AREA = 15;
  S.canalSuggest = S.canalSuggest || [];
  function tubes() {
    const r = S.red, m = S.mask; if (!r || !r.hu || !m) return [];
    const { nx, ny, nz } = r, nxy = nx * ny, at = (i, j, k) => i + nx * (j + ny * k), vox = r.sp[0] * r.sp[1] * r.sp[2];
    const inside = insideOf(r, m);
    const dark = new Uint8Array(nx * ny * nz), list = [];
    for (let id = 0; id < dark.length; id++) if (inside[id] && r.hu[id] < TUBE_HU) { dark[id] = 1; list.push(id); }
    const seen = new Uint8Array(dark.length), out = [];
    for (const s0 of list) {
      if (seen[s0]) continue; const q = [s0]; seen[s0] = 1; const cells = [];
      while (q.length) { const c = q.pop(); cells.push(c); const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0;
        for (let c2 = -1; c2 <= 1; c2++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const x = i + a, y = j + b, z = k + c2; if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue; const e = at(x, y, z); if (dark[e] && !seen[e]) { seen[e] = 1; q.push(e); } } }
      if (cells.length * vox < 10) continue;
      // the two farthest cells: from any cell the farthest, then the farthest from that one
      const W = cells.map(c => G.worldOf(r, c % nx, ((c / nx) | 0) % ny, (c / nxy) | 0)), far = p => W.reduce((b, w) => (Math.hypot(w[0] - p[0], w[1] - p[1], w[2] - p[2]) > Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) ? w : b), p);
      const a = far(W[0]), b = far(a), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (L < TUBE_LEN || cells.length * vox / L > TUBE_AREA) continue;
      out.push({ a: a.map(r2), b: b.map(r2), len: r2(L), area: r2(cells.length * vox / L) });
    }
    return out.sort((x, y) => y.len - x.len);
  }
  function suggest() {
    const cand = tubes(); S.canalSuggest = [];
    // the longest tube on each side of the bone's left-right middle (one canal per side; a second tube on a side is
    // usually a piece of the same canal)
    const r = S.red; let sx = 0, n = 0;
    for (let v = 0; v < S.mask.length; v++) if (S.mask[v]) { sx += v % r.nx; n++; }
    const cxW = G.worldOf(r, n ? sx / n : r.nx / 2, 0, 0)[0], seen = new Set();
    for (const t of cand) {
      const side = (t.a[0] + t.b[0]) / 2 < cxW ? -1 : 1; if (seen.has(side)) continue;
      const pts = trace(t.a, t.b); if (pts.length >= 3) { S.canalSuggest.push({ keys: [t.a, t.b], pts }); seen.add(side); }
      if (seen.size === 2) break;
    }
    draw(); render(); return { candidates: cand, suggestions: S.canalSuggest.length };
  }
  // ---------- root suggestion (plan B5) ----------
  // A root is dense (dentin, ROOT_HU and up) and lies deeper than ROOT_DEPTH mm inside the bone, where the cortex is
  // not; it is a short upright post (ROOT_LEN to ROOT_MAX mm along its axis, within ROOT_TILT° of the bone's up-down axis,
  // at most ROOT_AREA mm² of cross-section). The cortex of the lower border is a flat plate and the teeth crowns stand
  // outside the bone: neither passes. Suggestions are shown apart and count for nothing until accepted, so a false
  // one makes no critical row. (Sample values, set on the phantom.)
  const ROOT_HU = 1650, ROOT_DEPTH = 1.5, ROOT_LEN = 6, ROOT_TILT = 35, ROOT_AREA = 20, ROOT_CROWN = 20, ROOT_MAX = 20, ENAMEL_HU = 2500;
  S.rootSuggest = S.rootSuggest || [];
  function rootCands() {
    const r = S.red, m = S.mask; if (!r || !r.hu || !m) return [];
    const { nx, ny, nz, sp } = r, nxy = nx * ny, N = nx * ny * nz, vox = sp[0] * sp[1] * sp[2], inside = insideOf(r, m);
    const feat = new Uint8Array(N); for (let v = 0; v < N; v++) feat[v] = m[v] || inside[v] ? 0 : 1;
    const D = G.edt(feat, nx, ny, nz, sp), dense = new Uint8Array(N);
    for (let v = 0; v < N; v++) if (!feat[v] && D[v] >= ROOT_DEPTH && r.hu[v] >= ROOT_HU) dense[v] = 1;
    const up = r.axes && r.axes[2] ? G.worldOf(r, 0, 0, 1).map((x, i) => x - G.worldOf(r, 0, 0, 0)[i]) : [0, 0, 1], ul = Math.hypot(...up), U = up.map(x => x / ul);
    const seen = new Uint8Array(N), out = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!dense[s0] || seen[s0]) continue;
      const q = [s0], cells = []; seen[s0] = 1;
      while (q.length) { const c = q.pop(); cells.push(c); const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / nxy) | 0;
        for (let c2 = -1; c2 <= 1; c2++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const x = i + a, y = j + b, z = k + c2; if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue; const e = x + nx * (y + ny * z); if (dense[e] && !seen[e]) { seen[e] = 1; q.push(e); } } }
      if (cells.length * vox < 8) continue;
      const W = cells.map(c => G.worldOf(r, c % nx, ((c / nx) | 0) % ny, (c / nxy) | 0));
      const ctr = [0, 1, 2].map(a => W.reduce((t, w) => t + w[a], 0) / W.length);
      // the extent along the up-down axis and the spread across it
      let lo = Infinity, hi = -Infinity; const tp = W.map(w => { const d = (w[0] - ctr[0]) * U[0] + (w[1] - ctr[1]) * U[1] + (w[2] - ctr[2]) * U[2]; if (d < lo) lo = d; if (d > hi) hi = d; return d; });
      const L = hi - lo + sp[2]; if (L < ROOT_LEN || L > ROOT_MAX || cells.length * vox / L > ROOT_AREA) continue;
      // the axis: the line through the means of the top and the bottom thirds; its tilt from up-down
      const third = (f) => { const S3 = W.filter((w, i) => f(tp[i])); return [0, 1, 2].map(a => S3.reduce((t, w) => t + w[a], 0) / S3.length); };
      const top = third(d => d > hi - L / 3), bot = third(d => d < lo + L / 3), ax = top.map((x, i) => x - bot[i]), al = Math.hypot(...ax);
      const tilt = Math.acos(Math.min(1, Math.abs(ax[0] * U[0] + ax[1] * U[1] + ax[2] * U[2]) / al)) * 180 / Math.PI;
      if (tilt > ROOT_TILT) continue;
      // a tooth's root carries a crown: enamel (ENAMEL_HU and up, denser than any cortex) in the bone over its top,
      // at most ROOT_CROWN mm higher (over a ramus, a condylar neck or a coronoid process there is none)
      const ti = G.indexOf(r, top).map(Math.round); let crown = false;
      for (let dj = -2; dj <= 2 && !crown; dj++) for (let di = -2; di <= 2 && !crown; di++) { const i = ti[0] + di, j = ti[1] + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue; for (let k = 0; k < nz; k++) { const e = i + nx * (j + ny * k); if (!m[e] || r.hu[e] < ENAMEL_HU) continue; const w = G.worldOf(r, i, j, k), d = (w[0] - top[0]) * U[0] + (w[1] - top[1]) * U[1] + (w[2] - top[2]) * U[2]; if (d > 0 && d <= ROOT_CROWN) { crown = true; break; } } }
      if (!crown) continue;
      // the ends: the thirds' means carried out to the top and the bottom of the group
      const pr = p => (p[0] - ctr[0]) * U[0] + (p[1] - ctr[1]) * U[1] + (p[2] - ctr[2]) * U[2], end = (c0, t) => c0.map((x, i) => r2(x + U[i] * (t - pr(c0))));
      out.push({ a: end(top, hi), b: end(bot, lo), len: r2(L), tilt: r2(tilt), vol: r2(cells.length * vox) });
    }
    return out.sort((x, y) => x.a[0] - y.a[0]);
  }
  function suggestRoots() { const c = rootCands(); S.rootSuggest = c.map(x => ({ a: x.a, b: x.b, r: R_ROOT })); draw(); render(); return { candidates: c, suggestions: S.rootSuggest.length }; }
  function acceptRoots() { S.rootSuggest.forEach(x => S.roots.push(x)); S.rootSuggest = []; changed(); }
  function dropRoots() { S.rootSuggest = []; draw(); render(); }

  function acceptSuggest() { S.canalSuggest.forEach(c => S.canals.push({ keys: c.keys, pts: c.pts })); S.canalSuggest = []; changed(); }
  function dropSuggest() { S.canalSuggest = []; draw(); render(); }

  // ---------- picking ----------
  function pick(p) {
    if (!mode) return false;
    const w = arr(p);
    if (mode === 'root') {
      keys.push(w);
      if (keys.length === 2) { S.roots.push({ a: keys[0], b: keys[1], r: R_ROOT }); keys = []; changed(); hint(xl('Kök eklendi. Sonraki kök için kuron tarafına tıklayın; bitirmek için Esc.')); }
      else { hint(xl('Kök: şimdi apekse tıklayın.')); draw(); }
      return true;
    }
    if (cur < 0) { S.canals.push({ keys: [w], pts: [w] }); cur = S.canals.length - 1; }
    else {
      const c = S.canals[cur], last = c.keys[c.keys.length - 1];
      c.keys.push(w); c.pts = c.pts.concat(trace(last, w).slice(1));
    }
    const nk = S.canals[cur].keys.length;
    hint(nk < 2 ? xl('Kanal: mandibular foramene tıklayın (aradaki noktalar yolu büker). Bitirmek için Esc.') : xl(`Kanal ${cur + 1}: ${nk} nokta, ${fmt(pathLen(S.canals[cur].pts), 0)} mm. Devam edin ya da Esc ile bitirin.`));
    changed(); return true;
  }
  const pathLen = P => P.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - P[i][0], q[1] - P[i][1], q[2] - P[i][2]), 0);
  function setMode(m) {
    if (mode === 'canal' && cur >= 0 && S.canals[cur] && S.canals[cur].keys.length < 2) { S.canals.splice(cur, 1); changed(); }
    mode = mode === m ? null : m; keys = []; cur = -1;
    if (mode) { if (window.SegEdit) SegEdit.off(); if (window.Measure && Measure.active()) $('toolMeasure').click(); if (window.Lesion) Lesion.off(); }
    hint(mode === 'canal' ? xl('Kanal: mental foramene tıklayın (kesitte ya da 3B görünümde).') : mode === 'root' ? xl('Kök: kuron tarafına (alveol kreti) tıklayın.') : '');
    render();
  }
  let mine = '';
  function hint(t) { const b = $('modeBadge'); if (!b) return; if (mode && t) { b.hidden = false; b.textContent = mine = t; } else if (b.textContent === mine) b.hidden = true; }
  function changed() { draw(); render(); St.emit('changed'); if (St.renderChecks && S.result) St.renderChecks(); }

  // ---------- drawing ----------
  const group = new THREE.Group(); group.name = 'canal'; scene.add(group);
  const cMat = new THREE.MeshStandardMaterial({ color: COLOR, roughness: 0.5, transparent: true, opacity: 0.85 });
  const rMat = new THREE.MeshStandardMaterial({ color: ROOT_COLOR, roughness: 0.6, transparent: true, opacity: 0.7 });
  const sMat = new THREE.MeshStandardMaterial({ color: 0x7fb3ff, roughness: 0.5, transparent: true, opacity: 0.6 });
  function draw() {
    while (group.children.length) { const c = group.children.pop(); c.geometry.dispose(); }
    for (const c of S.canals) {
      if (c.pts.length < 2) { const m = new THREE.Mesh(new THREE.SphereGeometry(R_CANAL, 12, 8), cMat); m.position.set(...c.pts[0]); group.add(m); continue; }
      const curve = new THREE.CatmullRomCurve3(c.pts.map(q => V(...q)));
      group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, c.pts.length * 2), R_CANAL, 10, false), cMat));
    }
    for (const rt of S.roots) {
      const a = V(...rt.a), b = V(...rt.b), L = a.distanceTo(b), m = new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(rt.r, L, 4, 12) : new THREE.CylinderGeometry(rt.r, rt.r, L, 12), rMat);
      m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()); group.add(m);
    }
    for (const k of keys) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), rMat); m.position.set(...k); group.add(m); }
    for (const rt of S.rootSuggest || []) { const a = V(...rt.a), b = V(...rt.b), L = a.distanceTo(b); if (L < 0.1) continue; const g = new THREE.CylinderGeometry(rt.r * 0.6, rt.r * 0.6, L, 10); const ms = new THREE.Mesh(g, sMat); ms.position.copy(a.clone().add(b).multiplyScalar(0.5)); ms.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()); group.add(ms); }
    for (const c of S.canalSuggest || []) { const curve = new THREE.CatmullRomCurve3(c.pts.map(q => V(...q))); group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, c.pts.length * 2), R_CANAL * 0.7, 8, false), sMat)); }
    if (window.MPR) MPR.redraw();
    St.render();
  }
  (window.SliceOverlays = window.SliceOverlays || []).push((v, ctx, T, dpr, A) => {
    const near = p => Math.abs(A.toIdx(p)[v.axis] - A.st.cur[v.axis]) * S.vol.sp[v.axis] < 2;
    const pt = p => { const [x, y] = A.idxToImg(v, A.toIdx(p)); return [T.fx(x), T.fy(y)]; };
    ctx.fillStyle = '#f2c94c';
    for (const c of S.canals) c.pts.forEach(p => { if (!near(p)) return; const [x, y] = pt(p); ctx.beginPath(); ctx.arc(x, y, 2.5 * dpr, 0, 2 * Math.PI); ctx.fill(); });
    ctx.strokeStyle = '#7fb3ff'; ctx.lineWidth = 1.5 * dpr;
    for (const c of S.canalSuggest || []) c.pts.forEach(p => { if (!near(p)) return; const [x, y] = pt(p); ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, 2 * Math.PI); ctx.stroke(); });
    ctx.strokeStyle = '#7fb3ff'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
    for (const rt of S.rootSuggest || []) { const a = pt(rt.a), b = pt(rt.b); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.strokeStyle = '#f4efe2'; ctx.lineWidth = 2 * dpr;
    for (const rt of S.roots) { const a = pt(rt.a), b = pt(rt.b); ctx.setLineDash(near(rt.a) || near(rt.b) ? [] : [4 * dpr, 3 * dpr]); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    ctx.setLineDash([]);
  });

  // ---------- panel ----------
  function render() {
    const host = $('canalBox'); if (!host) return;
    host.innerHTML = `<h3 class="sub">${xl('Sinir kanalı ve kökler')}</h3>
      <p class="hint more">${xl(`Kanalı işaretleyin: mental foramene, sonra mandibular foramene tıklayın; yol aradaki koyu tüpü izler. Kanala ${SAFE} mm'den yakın ya da kökü geçen vida kritiktir.`)}</p>
      <div class="btns"><button id="cnCanal" aria-pressed="${mode === 'canal'}">${xl('Kanal işaretle')}</button><button id="cnRoot" aria-pressed="${mode === 'root'}">${xl('Kök işaretle')}</button><button id="cnSuggest">${xl('Kanal öner')}</button><button id="cnRootSug">${xl('Kök öner')}</button></div>
      ${(S.canalSuggest || []).length ? `<p class="hint">${xl(`Önerilen kanal (mavi): ${S.canalSuggest.length} taraf. Kesitlerde kontrol edin; kabul edilmeden kontrol sayılmaz.`)}</p><div class="btns"><button id="cnAccept">${xl('Öneriyi kabul et')}</button><button id="cnDrop" class="link">${xl('Öneriyi sil')}</button></div>` : ''}
      ${(S.rootSuggest || []).length ? `<p class="hint">${xl(`Önerilen kökler (mavi): ${S.rootSuggest.length}. Kesitlerde kontrol edin; kabul edilmeden vidalar bunlara karşı kontrol edilmez.`)}</p><div class="btns"><button id="cnRootAcc">${xl('Kökleri kabul et')}</button><button id="cnRootDrop" class="link">${xl('Öneriyi sil')}</button></div>` : ''}
      ${S.canals.length || S.roots.length ? `<div class="tbl"><table><tbody>${S.canals.map((c, i) => `<tr><td>${xl('Kanal')} ${i + 1}</td><td>${fmt(pathLen(c.pts), 0)} mm</td><td><button class="link" data-cdel="${i}">${xl('Sil')}</button></td></tr>`).join('')}${S.roots.map((rt, i) => `<tr><td>${xl('Kök')} ${i + 1}</td><td>${fmt(Math.hypot(rt.b[0] - rt.a[0], rt.b[1] - rt.a[1], rt.b[2] - rt.a[2]), 0)} mm</td><td><button class="link" data-rdel="${i}">${xl('Sil')}</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${xl('Kanal işaretlenmedi; vidalar kanala karşı kontrol edilmiyor.')}</p>`}`;
    $('cnCanal').addEventListener('click', () => setMode('canal'));
    $('cnRoot').addEventListener('click', () => setMode('root'));
    $('cnSuggest').addEventListener('click', async () => { St.busy(true, xl('Kanal aranıyor…')); await St.sleep(); try { const r = suggest(); if (!r.suggestions) St.alertMsg(xl('Bu BT\'de kanal biçiminde (uzun, ince, koyu) bir yol bulunamadı; kanalı elle işaretleyin.')); } finally { St.busy(false); } });
    $('cnRootSug').addEventListener('click', async () => { St.busy(true, xl('Kökler aranıyor…')); await St.sleep(); try { const r = suggestRoots(); if (!r.suggestions) St.alertMsg(xl('Bu BT\'de kök biçiminde (kemiğin içinde dik, yoğun) bir yapı bulunamadı; kökleri elle işaretleyin.')); } finally { St.busy(false); } });
    if ($('cnRootAcc')) { $('cnRootAcc').addEventListener('click', acceptRoots); $('cnRootDrop').addEventListener('click', dropRoots); }
    if ($('cnAccept')) { $('cnAccept').addEventListener('click', acceptSuggest); $('cnDrop').addEventListener('click', dropSuggest); }
    host.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', () => { S.canals.splice(+b.dataset.cdel, 1); cur = -1; changed(); }));
    host.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', () => { S.roots.splice(+b.dataset.rdel, 1); changed(); }));
  }

  // ---------- checks ----------
  function plateScrews() {
    const R = window.Plate && Plate.get && Plate.get(), Pp = window.Plate && Plate.params ? Plate.params() : null; if (!R || !Pp || !Pp.on) return [];
    return R.holes.map((h, i) => ({ h, i })).filter(({ h }) => h.usable && h.len && h.region !== 'defect').map(({ h, i }) => ({ no: i + 1, entry: h.p, dir: h.n.clone().negate().normalize(), len: h.len, rad: (Pp.d || 2) / 2 }));
  }
  function findings() {
    const out = { guide: [], plate: [] };
    if (!S.canals.length && !S.roots.length) return out;
    (St.screwsWorld ? St.screwsWorld() : []).forEach((w, i) => {
      if (!w.entry) return;
      const rad = w.sc.d / 2, cl = S.canals.length ? canalClear(w.entry, w.dir, w.sc.len, rad) : Infinity, roots = rootsHit(w.entry, w.dir, w.sc.len, rad);
      if (cl < SAFE || roots.length) out.guide.push({ i, cl, roots, fit: cl < SAFE ? maxLen(w.entry, w.dir, w.sc.len, rad) : null });
    });
    plateScrews().forEach(s => {
      const cl = S.canals.length ? canalClear(s.entry, s.dir, s.len, s.rad) : Infinity, roots = rootsHit(s.entry, s.dir, s.len, s.rad);
      if (cl < SAFE || roots.length) out.plate.push({ no: s.no, cl, roots });
    });
    return out;
  }
  const SCREW_LEN_MIN = 6;
  // plan A5, the gate: a case without a marked canal has screws nobody checked against it. Until the canal is marked or
  // the surgeon says it was checked on the slices ("Kanal kontrol edildi", tied to the screws as they are: a moved,
  // added or longer screw asks again) the package stays locked.
  const r1 = x => Math.round(x * 2) / 2;
  function screwKey() {
    const g = S.guideOn && St.screwsWorld ? St.screwsWorld().filter(w => w.entry).map(w => [w.entry.x, w.entry.y, w.entry.z, w.dir.x * 10, w.dir.y * 10, w.dir.z * 10, w.sc.len].map(r1)) : [];
    const p = plateScrews().map(q => [q.entry.x, q.entry.y, q.entry.z, q.len].map(r1));
    return g.length || p.length ? JSON.stringify([g, p]) : null;
  }
  function gate() {
    if (S.canals.length || (window.Ankle && Ankle.on && Ankle.on()) || S.kind !== 'dicom') return null;
    const k = screwKey(); if (!k || S.canalChecked === k) return null;
    return S.canalChecked ? 'changed' : 'unmarked';
  }
  (window.ExtraChecks = window.ExtraChecks || []).push(() => {
    const out = [], f = findings(), gt = gate();
    if (gt) out.push(['crit', 'Kritik', (gt === 'changed' ? xl('Vidalar kanal kontrolünden sonra değişti; alt alveoler sinir kanalına karşı yeniden kontrol edilmedi.') : xl('Alt alveoler sinir kanalı işaretlenmedi; guide ve plak vidaları kanala karşı kontrol edilmedi.')) + ' ' + xl('Kanalı kesitlerde işaretleyin ya da kesitlerde kontrol edip onaylayın.'), 'guide', [['canalMark', 'Kanalı işaretle'], ['canalOk', 'Kanal kontrol edildi']]]);
    f.guide.forEach(g => {
      if (g.cl < SAFE) out.push(['crit', 'Kritik', xl(`Vida ${g.i + 1} alt alveoler sinir kanalına ${fmt(Math.max(0, g.cl), 1)} mm (en az ${SAFE} mm).`) + ' ' + xl('Vidayı kısaltın ya da kanaldan uzağa taşıyın.'), 's' + g.i, g.fit != null && g.fit >= SCREW_LEN_MIN ? [['canalLen', 'Vidayı kanaldan önce bitir']] : undefined]);
      g.roots.forEach(k => out.push(['crit', 'Kritik', xl(`Vida ${g.i + 1} diş kökünü geçiyor (kök ${k}).`) + ' ' + xl('Vidayı kökler arasına taşıyın.'), 's' + g.i]));
    });
    f.plate.forEach(p => {
      if (p.cl < SAFE) out.push(['crit', 'Kritik', xl(`Plak vidası (delik ${p.no}) alt alveoler sinir kanalına ${fmt(Math.max(0, p.cl), 1)} mm (en az ${SAFE} mm).`) + ' ' + xl('Bu deliği boş bırakın ya da daha kısa vida seçin.'), 'plate']);
      p.roots.forEach(k => out.push(['crit', 'Kritik', xl(`Plak vidası (delik ${p.no}) diş kökünü geçiyor (kök ${k}).`) + ' ' + xl('Bu deliği boş bırakın.'), 'plate']));
    });
    return out.map(r => (r[4] === undefined ? r.slice(0, 4) : r));
  });
  (window.FixHooks = window.FixHooks || {}).canalOk = async () => { S.canalChecked = screwKey(); render(); St.emit('changed'); };
  FixHooks.canalMark = async () => { if (window.UI && UI.openStep) UI.openStep('st6'); if (mode !== 'canal') setMode('canal'); };
  // the fix: every guide screw too near the canal ends SAFE mm short of it (not below SCREW_LEN_MIN)
  FixHooks.canalLen = async () => {
    findings().guide.forEach(g => {
      if (g.fit == null || g.fit < SCREW_LEN_MIN) return;
      const sc = S.screws[g.i]; if (sc && sc.len > g.fit) { sc.len = g.fit; if (St.unapprove) St.unapprove(sc); }
    });
    St.emit('changed'); St.schedule(true);
  };

  // ---------- plan ----------
  (window.PlanExt = window.PlanExt || {}).canal = {
    get: () => (S.canals.length || S.roots.length || S.canalChecked ? JSON.parse(JSON.stringify(Object.assign({ canals: S.canals, roots: S.roots }, S.canalChecked ? { checked: S.canalChecked } : {}))) : undefined),
    set: v => {
      const ok = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
      S.canals = v && Array.isArray(v.canals) ? v.canals.filter(c => c && Array.isArray(c.pts) && c.pts.length && c.pts.every(ok)).map(c => ({ keys: (c.keys || []).filter(ok), pts: c.pts })) : [];
      S.roots = v && Array.isArray(v.roots) ? v.roots.filter(rt => rt && ok(rt.a) && ok(rt.b)).map(rt => ({ a: rt.a, b: rt.b, r: Number.isFinite(rt.r) && rt.r > 0.5 && rt.r < 6 ? rt.r : R_ROOT })) : [];
      S.canalChecked = v && typeof v.checked === 'string' && v.checked.length < 20000 ? v.checked : null;
      mode = null; keys = []; cur = -1; draw(); render();
    },
  };
  bus.addEventListener('volume', e => { if (!(e.detail && e.detail.restoring)) { S.canals = []; S.roots = []; S.canalChecked = null; S.canalSuggest = []; S.rootSuggest = []; mode = null; keys = []; cur = -1; draw(); render(); } });

  // ---------- wiring: 3D clicks (the Tools chain), slices (mpr.js), Esc ----------
  const prevTools = window.Tools;
  window.Tools = {
    click(e, ray) {
      if (mode) {
        const targets = Object.values(St.parts).filter(pt => pt.visible && pt.obj.isMesh && /^bone/.test(pt.id)).map(pt => pt.obj);
        const h = ray.intersectObjects(targets, false)[0]; if (h) pick(h.point); return true;
      }
      return prevTools ? prevTools.click(e, ray) : false;
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && mode) setMode(mode); });
  St.onEndModes(() => { if (mode) setMode(mode); });
  render();
  return { active: () => !!mode, mode: () => mode, setMode, pick, trace, segSeg, canalClear, rootsHit, maxLen, findings, gate, screwKey, tubes, suggest, acceptSuggest, dropSuggest, rootCands, suggestRoots, acceptRoots, dropRoots, R_CANAL, SAFE, R_ROOT };
})();
