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
      const rest = comps.slice(1).concat(pieces).sort((a, b) => b.size - a.size);
      return Object.assign(res, { comps: rest, picked: fit.c.label, status: 'split', ratio, vol: fit.v, ext: fit.e, box: fit.c.box, before: { vol, ext } });
    }
    sepr.restore(top.label);
    res.status = 'failed'; res.before = { vol, ext };
    return res;
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
  return { LIM, RATIOS, assess, pickMandible, boneWarnings, mandibleLike, tooBig, extMm, boxOf };
})();
