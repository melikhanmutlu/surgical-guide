/* Which bone is the planning bone. A bone threshold joins everything that touches: in a head CT the skull, the upper
   jaw (through the teeth), the mandible (jaw joint) and the cervical spine are often ONE component of 400-600 cm³. This
   module checks whether the largest component can be a mandible at all (size and extent); when it cannot, it cuts the
   component at its thin necks (G.separator: watershed on the distance transform) and picks the piece that is built like
   a mandible. Nothing is guessed silently: when no piece fits, the caller gets status 'failed' and shows a warning.
   Pure functions on the working grid (no DOM), so they run in node tests too. */
'use strict';
window.Bones = (function () {
  // limits in mm / cm³ for an adult mandible (bone mask with teeth); generous on purpose
  const LIM = {
    vol: [20, 200],            // cm³
    width: [85, 150],          // bigonial / bicondylar, left-right
    depth: [60, 130],          // chin to condyle, front-back
    height: 108,               // chin to condyle tip, up-down
    zOverX: 1.3,               // a mandible is wider than it is tall; a vertebral column is the opposite
    warnVol: 250,              // a planning bone above this is certainly more than a mandible
  };
  // neck / core thickness ratios tried from the most merging one; the first with a mandible-like piece wins
  const RATIOS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65];

  const cm3 = sp => sp[0] * sp[1] * sp[2] / 1000;
  const extMm = (box, sp) => [(box[3] - box[0] + 1) * sp[0], (box[4] - box[1] + 1) * sp[1], (box[5] - box[2] + 1) * sp[2]];
  function boxOf(labels, nx, ny, nz, label) {
    const b = [nx, ny, nz, -1, -1, -1];
    for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) if (labels[v] === label) {
      if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
    }
    return b;
  }
  // extents are along the grid axes; for an axial scan these are left-right, front-back and up-down
  const mandibleLike = (vol, e) => vol >= LIM.vol[0] && vol <= LIM.vol[1] && e[0] >= LIM.width[0] && e[0] <= LIM.width[1] && e[1] >= LIM.depth[0] && e[1] <= LIM.depth[1] && e[2] <= LIM.height && e[2] <= LIM.zOverX * e[0];
  const tooBig = (vol, e) => vol > LIM.vol[1] || e[2] > LIM.height || e[0] > LIM.width[1] || e[1] > LIM.depth[1];
  // up-down extent without the thinnest 0.5 % of the voxels at each end (a few teeth or a spicule of the neighbour bone
  // that stayed attached must not make a whole mandible look too tall)
  function trimmedHeight(labels, red, c) {
    const { nx, ny, sp } = red, b = c.box, h = new Float64Array(b[5] - b[2] + 1);
    for (let k = b[2]; k <= b[5]; k++) for (let j = b[1]; j <= b[4]; j++) for (let i = b[0]; i <= b[3]; i++) if (labels[i + nx * (j + ny * k)] === c.label) h[k - b[2]]++;
    let lo = 0, hi = h.length - 1, a = 0, z = 0; const cut = c.size * 0.005;
    while (lo < hi && a + h[lo] <= cut) a += h[lo++];
    while (hi > lo && z + h[hi] <= cut) z += h[hi--];
    return (hi - lo + 1) * sp[2];
  }
  const touchesZ = (box, nz) => box[2] <= 0 || box[5] >= nz - 1;

  // is the largest component too big (or too wide / tall) for a mandible, i.e. does it need cutting?
  function assess(red, labels, comps) {
    if (!comps.length) return { cut: false };
    const { nx, ny, nz, sp } = red, box = boxOf(labels, nx, ny, nz, comps[0].label), vol = comps[0].size * cm3(sp), ext = extMm(box, sp);
    return { cut: tooBig(vol, ext), vol, ext, box };
  }
  // red: working grid {nx,ny,nz,sp}; labels/comps/count from G.components (labels is edited in place when the largest
  // component is cut: its voxels get the labels of the pieces, numbered after `count`).
  // Returns { comps (all, largest first; the cut component replaced by its pieces), picked (label), status, ratio, vol, ext, box, warn }
  //   status: 'whole'  the largest component already is mandible-sized: nothing is changed
  //           'split'  it was too large, was cut and `picked` is the mandible-like piece
  //           'failed' it was too large and no piece is mandible-like: nothing is changed, `picked` stays the largest
  function pickMandible(red, labels, comps, count) {
    const { nx, ny, nz, sp } = red, vox = cm3(sp), res = { comps, picked: comps.length ? comps[0].label : null, status: 'whole', ratio: 0 };
    if (!comps.length) return res;
    const top = comps[0], a = assess(red, labels, comps), vol = a.vol, ext = a.ext;
    Object.assign(res, { vol, ext, box: a.box });
    if (!a.cut) return res;
    const up = red.axes && red.axes[2] && red.axes[2][2] < 0 ? -1 : 1, sepr = G.separator(labels, nx, ny, nz, sp, { label: top.label });
    for (const ratio of RATIOS) {
      const pieces = sepr.run({ ratio, base: count, out: labels, minSize: 50 });
      // the mandible is in the lower half of a head-and-neck component (vault and skull base are above it)
      const lower = c => (c.centroid[2] - top.centroid[2]) * up < 0;
      const fit = pieces.map(c => ({ c, v: c.size * vox, e: extMm(c.box, sp) }))
        .filter(x => lower(x.c) && mandibleLike(x.v, [x.e[0], x.e[1], x.e[2] <= LIM.height * 1.25 ? trimmedHeight(labels, red, x.c) : x.e[2]]))
        .sort((a, b) => (touchesZ(a.c.box, nz) - touchesZ(b.c.box, nz)) || b.v - a.v)[0];
      if (!fit) continue;
      const rec = mirrorRecover(red, labels, fit.c.label, pieces);
      const rest = comps.slice(1).concat(pieces).sort((a, b) => b.size - a.size);
      return Object.assign(res, { comps: rest, picked: fit.c.label, status: 'split', ratio, vol: fit.c.size * vox, ext: extMm(fit.c.box, sp), box: fit.c.box, before: { vol, ext }, recovered: rec });
    }
    sepr.restore(top.label);
    res.status = 'failed'; res.before = { vol, ext };
    return res;
  }

  // ---------- one side of the mandible left on the neighbour bone ----------
  // The cut at the thin necks can hand a whole ramus with its condyle to the skull piece (on a real CT the right ramus
  // above the angle went with the skull: the mandible matched its mirror image 46 %, the condyle was found at the cut
  // end, a body resection near it was planned as a ramus case). The healthy side says what is missing: the mandible's
  // midsagittal plane is found as Ref finds it (the plane that maps the bone surface best onto itself); when the surface
  // maps poorly onto its mirror image (under MIRROR_FIT_OK within MIRROR_TOL mm), every piece touching the mandible is cut finer (MIRROR_RATIO) and a sub-piece is given to the mandible when
  // it touches it and MIRROR_FIT of its voxels mirror onto mandible bone (within MIRROR_TOL mm), repeated while pieces
  // are added (the condylar head after the ramus). A piece of the skull base, the maxilla or a vertebra mirrors onto no
  // mandible and stays. The result must still be built like a mandible, else nothing is changed.
  const MIRROR_FIT_OK = 0.8, MIRROR_RATIO = 0.65, MIRROR_FIT = 0.6, MIRROR_TOL = 2, MIRROR_TOUCH = 20, MIRROR_ADD_MAX = 25;
  function surfaceOf(red, labels, label, max) {
    const { nx, ny, nz } = red, nxy = nx * ny, out = [];
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1, v = 1 + nx * (j + ny * k); i < nx - 1; i++, v++) {
      if (labels[v] !== label) continue;
      if (labels[v - 1] === label && labels[v + 1] === label && labels[v - nx] === label && labels[v + nx] === label && labels[v - nxy] === label && labels[v + nxy] === label) continue;
      out.push([i, j, k]);
    }
    const step = Math.max(1, Math.floor(out.length / max)), P = [];
    for (let t = 0; t < out.length; t += step) P.push(out[t]);
    return P;
  }
  // world <-> index for a grid with optional axes/origin (G.worldOf / G.indexOf when the grid has them)
  const toW = (red, i, j, k) => (red.axes && window.G ? G.worldOf(red, i, j, k) : [i * red.sp[0], j * red.sp[1], k * red.sp[2]]);
  const toI = (red, w) => (red.axes && window.G ? G.indexOf(red, w) : [w[0] / red.sp[0], w[1] / red.sp[1], w[2] / red.sp[2]]);
  function midPlane(red, labels, label) {
    const P = surfaceOf(red, labels, label, 5000).map(([i, j, k]) => toW(red, i, j, k)), { nx, ny, nz } = red;
    if (P.length < 50) return null;
    const c = P.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map(x => x / P.length);
    const f = (n, d) => {
      let hit = 0;
      for (const p of P) {
        const s = 2 * (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d), ix = toI(red, [p[0] - s * n[0], p[1] - s * n[1], p[2] - s * n[2]]);
        const i = Math.round(ix[0]), j = Math.round(ix[1]), k = Math.round(ix[2]);
        if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && labels[i + nx * (j + ny * k)] === label) hit++;
      }
      return hit / P.length;
    };
    const nOf = (yaw, roll) => { const a = yaw * Math.PI / 180, b = roll * Math.PI / 180; return [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)]; };
    let best = { yaw: 0, roll: 0, off: 0, s: -1 };
    const search = (yr, ys, or, os, at) => {
      for (let yaw = at.yaw - yr; yaw <= at.yaw + yr + 1e-6; yaw += ys) for (let roll = at.roll - yr; roll <= at.roll + yr + 1e-6; roll += ys) {
        const n = nOf(yaw, roll), d0 = n[0] * c[0] + n[1] * c[1] + n[2] * c[2];
        for (let off = at.off - or; off <= at.off + or + 1e-6; off += os) { const s = f(n, d0 + off); if (s > best.s) best = { yaw, roll, off, s }; }
      }
    };
    search(12, 3, 12, 2, best); search(3, 1, 2, 0.5, Object.assign({}, best)); search(1, 0.25, 0.5, 0.25, Object.assign({}, best));
    const n = nOf(best.yaw, best.roll);
    return { n, d: n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + best.off, score: best.s };
  }
  function mirrorRecover(red, labels, picked, pieces, opt = {}) {
    const { nx, ny, nz, sp } = red, nxy = nx * ny, vox = cm3(sp);
    const pl = midPlane(red, labels, picked); if (!pl) return null;
    // the mandible as it stands, and the voxel offsets within MIRROR_TOL mm (the mirrored point may miss by that much)
    const M = new Uint8Array(labels.length); for (let v = 0; v < M.length; v++) if (labels[v] === picked) M[v] = 1;
    const rr = [0, 1, 2].map(a => Math.floor(MIRROR_TOL / sp[a])), offs = [];
    for (let c = -rr[2]; c <= rr[2]; c++) for (let b = -rr[1]; b <= rr[1]; b++) for (let a = -rr[0]; a <= rr[0]; a++) if ((a * sp[0]) ** 2 + (b * sp[1]) ** 2 + (c * sp[2]) ** 2 <= MIRROR_TOL * MIRROR_TOL + 1e-9) offs.push([a, b, c]);
    const n = pl.n, d = pl.d;
    const mirrorsAt = (i, j, k) => {
      const p = toW(red, i, j, k), s = 2 * (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d);
      const q = toI(red, [p[0] - s * n[0], p[1] - s * n[1], p[2] - s * n[2]]), qi = Math.round(q[0]), qj = Math.round(q[1]), qk = Math.round(q[2]);
      for (const [a, b, c] of offs) { const x = qi + a, y = qj + b, z = qk + c; if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && M[x + nx * (y + ny * z)]) return true; }
      return false;
    };
    const mirrors = v => mirrorsAt(v % nx, ((v / nx) | 0) % ny, (v / nxy) | 0);
    // only a mandible that maps poorly onto its mirror image (within MIRROR_TOL) is searched (cutting the neighbours
    // finer costs seconds on a head CT): a whole real mandible maps about 82 %
    const S0 = surfaceOf(red, labels, picked, 8000), fit = S0.length ? S0.filter(([i, j, k]) => mirrorsAt(i, j, k)).length / S0.length : 1;
    if (fit >= (opt.fit || MIRROR_FIT_OK)) return { score: pl.score, fit, added: 0 };
    // the pieces touching the mandible
    const touch = new Set();
    for (let v = nxy; v < labels.length - nxy; v++) {
      if (!M[v]) continue;
      for (const w of [v - 1, v + 1, v - nx, v + nx, v - nxy, v + nxy]) { const l = labels[w]; if (l && l !== picked) touch.add(l); }
    }
    const subs = [];
    for (const l of touch) {
      const sepr = G.separator(labels, nx, ny, nz, sp, { label: l }); if (sepr.empty) continue;
      const lab = new Int32Array(labels.length), parts = sepr.run({ ratio: MIRROR_RATIO, out: lab, minSize: 1 }), byL = new Map();
      parts.forEach(c => byL.set(c.label, { from: l, vs: [], fit: null }));
      for (let v = 0; v < lab.length; v++) if (lab[v]) byL.get(lab[v]).vs.push(v);
      byL.forEach(x => subs.push(x));
    }
    let added = 0, changed = true;
    while (changed) {
      changed = false;
      for (const x of subs) {
        if (x.done || x.vs.length * vox > MIRROR_ADD_MAX - added) continue;
        let t = 0; for (const v of x.vs) if (M[v - 1] || M[v + 1] || M[v - nx] || M[v + nx] || M[v - nxy] || M[v + nxy]) { if (++t >= MIRROR_TOUCH) break; }
        if (t < MIRROR_TOUCH) continue;
        if (x.fit === null) { let h = 0; for (const v of x.vs) if (mirrors(v)) h++; x.fit = h / x.vs.length; }
        if (x.fit < MIRROR_FIT) continue;
        x.done = true; changed = true; added += x.vs.length * vox;
        for (const v of x.vs) M[v] = 1;
      }
    }
    if (!added) return { score: pl.score, fit, added: 0 };
    // still a mandible? (volume and extents of the grown piece)
    const b = [nx, ny, nz, -1, -1, -1]; let cnt = 0;
    for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) if (M[v]) { cnt++; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k; }
    const e = extMm(b, sp);
    if (!mandibleLike(cnt * vox, [e[0], e[1], e[2] <= LIM.height * 1.25 ? Math.min(e[2], LIM.height) : e[2]])) return { score: pl.score, fit, added: 0, refused: true };
    // hand the voxels over; the pieces' sizes follow
    const gained = new Map();
    for (const x of subs) if (x.done) { for (const v of x.vs) labels[v] = picked; gained.set(x.from, (gained.get(x.from) || 0) + x.vs.length); }
    pieces.forEach(c => { if (c.label === picked) { c.size = cnt; c.box = b; } else if (gained.has(c.label)) c.size -= gained.get(c.label); });
    return { score: pl.score, fit, added: Math.round(added * 10) / 10 };
  }

  // checks of the CHOSEN planning bone (any selection, also a hand-picked or layer one); [] when plausible
  // mask: 0/1 over the grid. Returns [{ code, vol, ext }]
  function boneWarnings(red, mask) {
    const { nx, ny, nz, sp } = red, b = [nx, ny, nz, -1, -1, -1]; let n = 0;
    for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) if (mask[v]) {
      n++; if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k; if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
    }
    if (!n) return [];
    const vol = n * cm3(sp), ext = extMm(b, sp), out = [];
    if (vol > LIM.warnVol) out.push({ code: 'big', vol, ext });
    if (b[5] >= nz - 1 || b[2] <= 0) out.push({ code: 'edge', vol, ext });   // cut off by the scan range: skull / spine, not a mandible
    return out;
  }
  // ---------- the upper jaw joined through closed teeth (plan B3) ----------
  // With the teeth closed the threshold mask runs from the mandible through the teeth into the maxilla; the neck cut
  // above keeps it (on the real sample CT the "mandible" held ~38 cm³ of maxilla, palate and nasal walls). A watershed
  // alone cuts the wrong teeth (an upper incisor overlaps the lower one). The surgeon sets the occlusal plane (the height
  // where the upper and lower teeth meet, from the lowest point of the bone); the bone below it marks the mandible,
  // the bone on the midline above it the maxilla, and Masks splits the rest along the contact (G.splitSeeds).
  // Heights are up-down along the grid (an axial scan), the midline is the left-right middle of the lowest JAW.slab mm
  // (the chin and both lower borders). Example values, not validated thresholds.
  const JAW = { band: 3, mid: 20, slab: 15, suspectMid: 6, suspectH: 58, suspectVol: 0.5, guess: 0.48, min: 25, max: 70 };
  function jawFrame(red, mask) {
    const { nx, ny, nz, sp } = red, nxy = nx * ny, up = red.axes && red.axes[2] && red.axes[2][2] < 0 ? -1 : 1;
    let k0 = nz, k1 = -1;
    for (let k = 0; k < nz; k++) { const o = k * nxy; for (let v = 0; v < nxy; v++) if (mask[o + v]) { if (k < k0) k0 = k; if (k > k1) k1 = k; break; } }
    if (k1 < 0) return null;
    const h = k => (up > 0 ? k - k0 : k1 - k) * sp[2], H = (k1 - k0) * sp[2];
    let sx = 0, n = 0;
    for (let k = k0; k <= k1; k++) { if (h(k) > JAW.slab) continue; const o = k * nxy; for (let v = 0; v < nxy; v++) if (mask[o + v]) { sx += v % nx; n++; } }
    return { up, k0, k1, H, h, cx: sx / n };
  }
  // the occlusal plane to start from (the user moves it): JAW.guess of the bone's height (the real sample: 47 of 98 mm)
  function jawGuess(red, mask) { const f = jawFrame(red, mask); return f ? Math.round(Math.min(JAW.max, Math.max(JAW.min, JAW.guess * f.H)) * 2) / 2 : null; }
  // seeds for Masks: 1 = mandible (below occ - band), 2 = maxilla (above occ + band, within JAW.mid mm of the midline)
  function jawSeeds(red, mask, occ, opt = {}) {
    const f = jawFrame(red, mask); if (!f) return null;
    const { nx, ny, sp } = red, nxy = nx * ny, band = opt.band ?? JAW.band, mid = opt.mid ?? JAW.mid, seeds = new Uint8Array(mask.length);
    let n1 = 0, n2 = 0;
    for (let k = f.k0; k <= f.k1; k++) {
      const hk = f.h(k), o = k * nxy, lo = hk < occ - band, hi = hk > occ + band; if (!lo && !hi) continue;
      for (let v = 0; v < nxy; v++) {
        if (!mask[o + v]) continue;
        if (lo) { seeds[o + v] = 1; n1++; } else if (Math.abs(v % nx - f.cx) * sp[0] < mid) { seeds[o + v] = 2; n2++; }
      }
    }
    return n1 && n2 ? { seeds, n1, n2, H: f.H } : null;
  }
  // bone on the midline higher than a mandible's symphysis with its incisors: the maxilla is probably still attached
  function maxillaSuspect(red, mask) {
    const f = jawFrame(red, mask); if (!f) return null;
    const { nx, ny, sp } = red, nxy = nx * ny; let n = 0, top = 0;
    for (let k = f.k0; k <= f.k1; k++) {
      const hk = f.h(k); if (hk <= JAW.suspectH) continue;
      const o = k * nxy; for (let v = 0; v < nxy; v++) if (mask[o + v] && Math.abs(v % nx - f.cx) * sp[0] < JAW.suspectMid) { n++; if (hk > top) top = hk; }
    }
    const vol = n * cm3(sp);
    return vol >= JAW.suspectVol ? { vol, top } : null;
  }

  return { LIM, RATIOS, assess, pickMandible, boneWarnings, mandibleLike, tooBig, extMm, boxOf, midPlane, mirrorRecover, JAW, jawFrame, jawGuess, jawSeeds, maxillaSuspect };
})();
