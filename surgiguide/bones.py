"""Which bone is the planning bone: separating bones that a threshold joins (mirror of web/geom.js G.separator,
web/bones.js and web/fibula.js, same limits).

A bone threshold joins everything that touches. In a head CT the skull, the upper jaw (through the teeth), the mandible
(jaw joint) and the cervical spine are one component of 400-600 cm3; in a leg CT tibia, fibula and foot are one piece per
leg and the CT table is a component of its own. The pieces are found with a watershed on the distance transform: every
local maximum is a bone core, and two cores are one bone when the neck between them is at least `ratio` times as thick
as the thinner core (a bone is thick everywhere; a joint or a tooth contact is a thin neck). The cores grow back over the
whole mask, so each piece keeps its full surface.
"""
from array import array

import numpy as np
from scipy import ndimage as ndi

# limits in mm / cm3 for an adult mandible (bone mask with teeth); generous on purpose
MANDIBLE_LIM = dict(vol=(20.0, 200.0), width=(85.0, 150.0), depth=(60.0, 130.0), height=108.0, z_over_x=1.3)
MANDIBLE_RATIOS = (0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65)
FIBULA_RADIUS = (2.5, 12.0)                   # mm: slenderest / thickest radius a fibula can have
FIBULA_LENGTH = (120.0, 500.0)                # mm: shortest / longest fibula (CT table rails are 800 mm and more)
FIBULA_RATIOS = (0.45, 0.5, 0.4, 0.55, 0.35, 0.6)


def _flood_order(edt, cmask):
    """The flood's visiting order (bone voxels, thickest first) and the distances as a flat float array: the same for every
    ratio, so a Separator computes them once (D4 P16: compact arrays instead of whole-box Python lists, ~12 B per voxel)."""
    order = np.flatnonzero(cmask.ravel())
    order = order[np.argsort(-edt.ravel()[order], kind="stable")].tolist()
    return order, array("d", edt.ravel().astype(np.float64).tobytes())


def _flood(edt, cmask, ratio, pre=None):
    """Watershed with neck / core merging on a padded coarse grid; int32 labels (0 = outside), pieces numbered by root.
    pre: _flood_order(edt, cmask), when the caller floods the same grid at several ratios."""
    shape = edt.shape
    ny, nx = shape[1], shape[2]
    order, D = pre or _flood_order(edt, cmask)
    nb = (-1, 1, -nx, nx, -nx * ny, nx * ny)
    lab = array("l", bytes(array("l").itemsize * cmask.size))
    parent, peak = [0], [0.0]

    def find(r):
        while parent[r] != r:
            parent[r] = parent[parent[r]]
            r = parent[r]
        return r

    for v in order:
        d = D[v]
        roots, best, bd = [], 0, -1.0
        for o in nb:
            u = v + o
            if not lab[u]:
                continue
            r = find(lab[u])
            if r not in roots:
                roots.append(r)
            if D[u] > bd:
                bd, best = D[u], r
        if not roots:
            parent.append(len(parent)); peak.append(d); lab[v] = len(parent) - 1
            continue
        top = max(roots, key=lambda q: peak[q])
        for r in roots:
            if r != top and d >= ratio * peak[r]:
                parent[r] = top
        lab[v] = find(best)
    out = np.zeros(cmask.size, np.int32)
    for v in order:
        out[v] = find(lab[v])
    return out.reshape(shape)


class Separator:
    """Distance transform of one mask (z, y, x), computed once; run(ratio) cuts it at a neck / core thickness ratio.
    work_mm: cut on a coarser grid of about this voxel size (0 = the mask's own grid, as the browser does; the pipeline hands it
    the 0.8 mm working grid, so no coarsening is needed)."""

    def __init__(self, mask, spacing, work_mm=0.0):
        sx, sy, sz = spacing
        self.shape = mask.shape
        zz, yy, xx = (np.nonzero(mask.any(axis=a))[0] for a in ((1, 2), (0, 2), (0, 1)))
        self.box = (slice(zz[0], zz[-1] + 1), slice(yy[0], yy[-1] + 1), slice(xx[0], xx[-1] + 1))
        self.native = mask[self.box]
        self.f = tuple(max(1, int(round(work_mm / s))) for s in (sz, sy, sx))
        fz, fy, fx = self.f
        z, y, x = (-(-n // f) for n, f in zip(self.native.shape, self.f))
        pad = np.zeros((z * fz, y * fy, x * fx), bool)
        pad[:self.native.shape[0], :self.native.shape[1], :self.native.shape[2]] = self.native
        # a coarse voxel is bone when most of its block is; one voxel of background all round
        self.cmask = np.pad(pad.reshape(z, fz, y, fy, x, fx).mean(axis=(1, 3, 5)) > 0.5, 1)
        self.edt = ndi.distance_transform_edt(self.cmask, sampling=(sz * fz, sy * fy, sx * fx)).astype(np.float32)

    def run_coarse(self, ratio):
        """Coarse-grid labels (no padding, root numbers, 0 = outside): everything the pieces' statistics need, at a fraction of
        the cost of lifting them to the native grid."""
        if getattr(self, "_pre", None) is None:
            self._pre = _flood_order(self.edt, self.cmask)
        return _flood(self.edt, self.cmask, ratio, self._pre)[1:-1, 1:-1, 1:-1]

    def lift(self, coarse, label=None):
        """Native-grid labels (shape of the input mask's box) from coarse labels: a native voxel takes the label of its coarse
        voxel, or of the nearest labelled coarse voxel when the coarse grid dropped it (thin bone). With `label`: the boolean
        mask of that one piece."""
        fz, fy, fx = self.f
        nz, ny, nx = self.native.shape
        idx = ndi.distance_transform_edt(coarse == 0, return_distances=False, return_indices=True)
        filled = coarse[tuple(idx)]                              # every coarse voxel takes the nearest piece
        if label is not None:
            up = np.repeat(np.repeat(np.repeat(filled == label, fz, 0), fy, 1), fx, 2)[:nz, :ny, :nx]
            return up & self.native
        up = np.repeat(np.repeat(np.repeat(filled, fz, 0), fy, 1), fx, 2)[:nz, :ny, :nx]
        return np.where(self.native, up, 0)

    def run(self, ratio):
        """int32 labels with the shape of the input mask; pieces numbered 1.. by size, 0 outside the mask."""
        up = self.lift(self.run_coarse(ratio))
        ids, counts = np.unique(up[up > 0], return_counts=True)
        rank = np.zeros(int(up.max()) + 1, np.int32)
        rank[ids[np.argsort(-counts, kind="stable")]] = np.arange(1, len(ids) + 1)
        out = np.zeros(self.shape, np.int32)
        out[self.box] = rank[up]
        return out


def pieces(lab, spacing, origin_idx=(0, 0, 0), min_vox=50, step=(1, 1, 1), world=None):
    """Stats of every piece of a label array (z, y, x): volume (cm3), extent along the grid axes (x, y, z mm), centre (mm),
    PCA axis, length (sqrt(12 l1)), radius (2 sqrt(l2)) and elongation.
    spacing (sx, sy, sz): voxel size of the grid the array lives on (or was coarsened from); origin_idx (z, y, x): index of
    the array's first voxel in that grid; step (z, y, x): grid voxels per array voxel (a coarse array); world: optional map
    from (n, 3) grid index (x, y, z, float) to patient mm (default: index * spacing), used for centre and axis."""
    sx, sy, sz = spacing
    fz, fy, fx = step
    out = []
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        m = lab[sl] == k
        n = int(m.sum())
        if n < min_vox:
            continue
        I = np.argwhere(m) + [s.start for s in sl]                # (z, y, x) in array voxels
        G = ((I + 0.5) * [fz, fy, fx] - 0.5 + list(origin_idx))[:, ::-1]      # (x, y, z) grid index of the voxel centres
        P = world(G) if world is not None else G * np.array([sx, sy, sz])
        c = P.mean(0)
        w, v = np.linalg.eigh(np.cov((P - c).T))
        ax = v[:, 2] if v[2, 2] >= 0 else -v[:, 2]
        out.append(dict(label=k, n=n, vol=n * fz * fy * fx * sx * sy * sz / 1000.0, centroid=c, axis=ax, slices=sl,
                        ext=((sl[2].stop - sl[2].start) * fx * sx, (sl[1].stop - sl[1].start) * fy * sy, (sl[0].stop - sl[0].start) * fz * sz),
                        len=float(np.sqrt(12 * w[2])), radius=float(2 * np.sqrt(max(w[1], 0))),
                        elong=float(np.sqrt(w[2] / max(w[1], 1e-6)))))
    return out


def mandible_like(vol, ext):
    L = MANDIBLE_LIM
    return (L["vol"][0] <= vol <= L["vol"][1] and L["width"][0] <= ext[0] <= L["width"][1]
            and L["depth"][0] <= ext[1] <= L["depth"][1] and ext[2] <= L["height"] and ext[2] <= L["z_over_x"] * ext[0])


def too_big_for_mandible(vol, ext):
    L = MANDIBLE_LIM
    return vol > L["vol"][1] or ext[2] > L["height"] or ext[0] > L["width"][1] or ext[1] > L["depth"][1]


def trimmed_height(m, sz_mm, frac=0.005):
    """Up-down extent without the thinnest 0.5 % of the voxels at each end (a few teeth or a spicule of the neighbour bone
    that stayed attached must not make a whole mandible look too tall). m: boolean (z, y, x)."""
    h = m.reshape(m.shape[0], -1).sum(axis=1)
    cut = h.sum() * frac
    lo, hi, a, z = 0, len(h) - 1, 0, 0
    while lo < hi and a + h[lo] <= cut:
        a += h[lo]; lo += 1
    while hi > lo and z + h[hi] <= cut:
        z += h[hi]; hi -= 1
    return (hi - lo + 1) * sz_mm


def pick_mandible(mask, spacing, origin_idx=(0, 0, 0), world=None, scan_z=None):
    """mask: the largest threshold component (z, y, x) of the working grid, cropped to its box at origin_idx; spacing
    (sx, sy, sz) of that grid; world: grid index (x, y, z) -> patient mm (z up); scan_z: (z index of the first and last slice
    of the scan) to tell a piece cut off by the scan range. Mirror of web/bones.js pickMandible.
    Returns (mask or None, info). info['status']: 'whole' (mandible-sized already), 'split' (cut, mandible-like piece taken)
    or 'failed' (nothing fits: the whole component is returned and info['warning'] says why that is not a mandible).
    For 'split' the returned mask is the piece (same shape as `mask`)."""
    sx, sy, sz = spacing
    vol = float(mask.sum() * sx * sy * sz / 1000.0)
    zz, yy, xx = (np.nonzero(mask.any(axis=a))[0] for a in ((1, 2), (0, 2), (0, 1)))
    ext = ((xx[-1] - xx[0] + 1) * sx, (yy[-1] - yy[0] + 1) * sy, (zz[-1] - zz[0] + 1) * sz)
    if not too_big_for_mandible(vol, ext):
        return mask, dict(status="whole", volume_cm3=vol, extent_mm=ext)
    sep = Separator(mask, spacing)
    f = sep.f
    box0 = [b.start for b in sep.box]
    org = tuple(o + b for o, b in zip(origin_idx, box0))         # index of the box's first voxel in the working grid
    cz = (world(np.argwhere(mask)[:, ::-1] + np.array(origin_idx)[::-1])[:, 2].mean() if world is not None
          else (np.argwhere(mask)[:, 0].mean() + origin_idx[0]) * sz)
    for ratio in MANDIBLE_RATIOS:
        coarse = sep.run_coarse(ratio)
        ps = pieces(coarse, spacing, org, 50, step=f, world=world)
        fits = []
        for p in ps:
            if not p["centroid"][2] < cz:                        # the mandible is in the lower half (vault and skull base above)
                continue
            e = list(p["ext"])
            if e[2] <= MANDIBLE_LIM["height"] * 1.25:
                sub = np.repeat(np.repeat(np.repeat(coarse[p["slices"]] == p["label"], f[0], 0), f[1], 1), f[2], 2)
                e[2] = trimmed_height(sub, sz)
            if mandible_like(p["vol"], e):
                # first / last slice of the piece (inclusive) against the scan's first / last slice (web/bones.js box[2] <= 0, box[5] >= nz - 1)
                touches = scan_z is not None and (p["slices"][0].start * f[0] + org[0] <= scan_z[0] or p["slices"][0].stop * f[0] - 1 + org[0] >= scan_z[1])
                fits.append((touches, -p["vol"], p, e))
        if fits:
            touches, _, best, e = min(fits, key=lambda t: (t[0], t[1]))
            piece = np.zeros(mask.shape, bool)
            piece[sep.box] = sep.lift(coarse, best["label"])
            return piece, dict(status="split", ratio=ratio, volume_cm3=best["vol"], extent_mm=tuple(e), before_cm3=vol, before_extent_mm=ext)
    warn = (f"mandible: the largest bone component is {vol:.0f} cm3 and {ext[2]:.0f} mm tall (skull / spine joined) and no piece "
            "of it looks like a mandible; the whole component is used and the plan will not be reliable")
    return mask, dict(status="failed", volume_cm3=vol, extent_mm=ext, warning=warn)


def fibula_candidates(ps):
    """Slender long pieces with a thicker, parallel, comparably long piece (the tibia) beside them; sets p['tibia']."""
    longp = [p for p in ps if p["len"] >= 80 and p["elong"] >= 3]
    out = []
    for c in longp:
        if not (FIBULA_LENGTH[0] <= c["len"] <= FIBULA_LENGTH[1]) or c["elong"] < 5 or not (FIBULA_RADIUS[0] <= c["radius"] <= FIBULA_RADIUS[1]):
            continue

        def apart(o, c=c):
            d = o["centroid"] - c["centroid"]
            return float(np.linalg.norm(d - np.dot(d, c["axis"]) * c["axis"]))
        part = [o for o in longp if o is not c and o["radius"] >= 1.3 * c["radius"] and o["len"] >= 0.6 * c["len"]
                and abs(float(np.dot(o["axis"], c["axis"]))) >= 0.9 and apart(o) <= 80]
        if part:
            c["tibia"] = min(part, key=apart)
            out.append(c)
    return out, longp


def leg_of(p):
    """'right' or 'left': the leg of a fibula candidate from its tibia (the fibula is lateral; LPS +x = patient left)."""
    return "right" if p["centroid"][0] < p["tibia"]["centroid"][0] else "left"


def pick_fibula(comps, spacing, side="right", world=None):
    """comps: [(mask crop (z, y, x), origin_idx)] of the largest threshold components of the working grid (at most 6, largest
    first; mirror of web/fibula.js load()), spacing (sx, sy, sz) of that grid, world: grid index (x, y, z) -> patient mm.
    Returns (index of comp, mask of the fibula in that comp's crop, info). info['status']: 'ok' | 'failed' (no tibia partner
    found: the longest slender piece is returned and info['warning'] says so). side: 'right' | 'left' | 'auto' (the leg of a
    one-leg scan). The leg of a candidate is told by its tibia (the fibula is lateral to it); RuntimeError when the asked leg
    has no fibula, never a bone of the other leg. info['side'] is the leg used."""
    allp = []
    for i, (m, o) in enumerate(comps):
        for p in pieces(m.astype(np.int32), spacing, o, 200, world=world):
            p.update(comp=i, lab=None, sep=None)
            allp.append(p)
    found, longp = fibula_candidates(allp)
    if not longp:
        raise RuntimeError("no long bone (fibula) found in the leg CT")
    warn, ratio_used = None, None
    # leg-like pieces (long and thick: tibia + fibula + foot, pelvis, femur, the table) that are more than the fibulas found
    # beside them were not looked into: cut them (a clean leg CT has as many fibulas as thick pieces, and is left alone)
    thick = sorted({p["comp"] for p in longp if p["radius"] > FIBULA_RADIUS[1] and p["len"] >= 150})
    if len(thick) > len(found):
        seps = {i: Separator(comps[i][0], spacing) for i in thick}
        rest = [p for p in allp if p["comp"] not in seps]
        best = (0, None, None)
        for ratio in FIBULA_RATIOS:
            cut = []
            for i, sp in seps.items():
                lab = sp.run(ratio)
                for p in pieces(lab, spacing, comps[i][1], 100, world=world):
                    p.update(comp=i, lab=lab, sep=ratio)
                    cut.append(p)
            f2, _ = fibula_candidates(rest + sorted(cut, key=lambda p: -p["n"])[:80])
            if len(f2) > best[0]:
                best = (len(f2), f2, ratio)
            if len(f2) >= len(thick):
                break
        # the cut is taken only when it finds more fibulas than the plain threshold pieces (web/fibula.js: best.n > first.length)
        if best[1] and best[0] > len(found):
            found, ratio_used = best[1], best[2]
        elif not found:
            warn = ("fibula: tibia and fibula are joined in the threshold mask and could not be separated; "
                    "the longest slender piece is used and is probably the whole lower leg")
            found = sorted([p for p in longp if FIBULA_LENGTH[0] <= p["len"] <= FIBULA_LENGTH[1]], key=lambda p: p["radius"])[:1] or sorted(longp, key=lambda p: -p["len"])[:1]
    if not found:
        found = sorted(longp, key=lambda p: p["radius"])[:1]
        warn = ((warn + "; ") if warn else "") + "fibula: no slender long bone with a tibia beside it was found; the slenderest long piece is used"
    # a piece that is the tibia of another candidate is not a fibula (with one leg's tibia and fibula fused, the other leg's
    # tibia is slender next to that fused leg and would pass as a fibula)
    partners = {id(p["tibia"]) for p in found if p.get("tibia") is not None}
    found = [p for p in found if id(p) not in partners] or found
    # the fibula is the longest slender bone with a tibia beside it (arms and ribs are shorter)
    found = sorted(found, key=lambda p: (-p["len"], p["radius"]))
    found = [p for p in found if p["len"] >= 0.7 * found[0]["len"]]
    # the leg: a fibula lies lateral to its tibia (LPS: patient right is -x), as web/fibula.js legSide. A bone of the other
    # leg is never returned: with no fibula on the asked side the pipeline stops and says why.
    sided = [p for p in found if p.get("tibia") is not None]
    if sided:
        legs = {id(p): leg_of(p) for p in sided}
        if side == "auto":
            sides = sorted(set(legs.values()))
            if len(sides) > 1:
                raise RuntimeError("fibula: the scan holds both legs; choose the donor leg (--side right / left)")
            side = sides[0]
        mine = [p for p in sided if legs[id(p)] == side]
        if not mine:
            other = sorted(set(legs.values()))
            raise RuntimeError(f"fibula: no fibula of the {side} leg was found; the candidates lie lateral to a tibia of the "
                               f"{' and '.join(other)} leg. On the {side} leg tibia and fibula may be joined in the threshold mask "
                               f"(try another --hu or series), or the {side} leg is not in the scan (check --side)")
        pick = mine[0]
    else:
        # no tibia beside any candidate (warned above): the leg cannot be told apart, the scanner x decides as before
        if len(found) >= 2:
            xs = [p["centroid"][0] for p in found]
            mid = 0.5 * (min(xs) + max(xs))
            pick = ([p for p in found if (p["centroid"][0] < mid) == (side != "left")] or found)[0]
        else:
            pick = found[0]
        warn = ((warn + "; ") if warn else "") + "fibula: no tibia beside the candidate, so its leg (side) could not be checked"
        if side == "auto":
            side = "right" if pick["centroid"][0] < 0 else "left"
    if pick["lab"] is None:
        mask = comps[pick["comp"]][0].copy()
    else:
        mask = pick["lab"] == pick["label"]
    if pick["radius"] > FIBULA_RADIUS[1]:
        warn = ((warn + "; ") if warn else "") + f"fibula radius {pick['radius']:.0f} mm is above {FIBULA_RADIUS[1]:.0f} mm: this is not a fibula"
    info = dict(status="ok" if warn is None else "failed", volume_cm3=pick["vol"], length_mm=pick["len"], radius_mm=pick["radius"],
                candidates=len(found), side_x_mm=float(pick["centroid"][0]), cut_ratio=ratio_used, side=side,
                side_from="tibia" if pick.get("tibia") is not None else "scanner x")
    if warn:
        info["warning"] = warn
    return pick["comp"], mask, info


def trim_maxilla(piece, spacing, origin_idx, world, info, max_frac=0.2):
    """Cut maxilla remnants off a mandible piece that was cut out of a skull component (status 'split'): the upper jaw stays
    attached to the mandible through the teeth and the first cut leaves a premaxilla / tooth column standing above the
    occlusal plane. The piece is cut once more at the next neck ratio; a part is dropped when all of this holds: it is small
    (at most `max_frac` of the piece), it starts above the occlusal plane (the height of the piece's widest axial slice, plus
    5 mm; the mandibular body and teeth end there, only rami rise above it) and it is central (its centre lies in the middle
    60 % of the width: condyles and coronoid processes are lateral). info gains 'trimmed_cm3' (and 'note' when something went).
    Returns (mask, info)."""
    if info.get("status") != "split" or info["ratio"] not in MANDIBLE_RATIOS[:-1]:
        return piece, info
    sx, sy, sz = spacing
    ratio = MANDIBLE_RATIOS[MANDIBLE_RATIOS.index(info["ratio"]) + 1]
    sep = Separator(piece, spacing)
    f = sep.f
    org = tuple(o + b.start for o, b in zip(origin_idx, sep.box))
    coarse = sep.run_coarse(ratio)
    ps = pieces(coarse, spacing, org, 20, step=f, world=world)
    if len(ps) < 2:
        return piece, info
    total = sum(p["vol"] for p in ps)
    box = piece[sep.box]
    area = box.reshape(box.shape[0], -1).sum(axis=1).astype(float)
    k = max(1, int(round(3.0 / sz)))
    area = np.convolve(area, np.ones(2 * k + 1) / (2 * k + 1), mode="same")
    kz = np.arange(len(area))
    zw = world(np.stack([np.zeros_like(kz), np.zeros_like(kz), kz + org[0]], 1).astype(float))[:, 2]
    lo = int(len(area) * 0.15); hi = int(len(area) * 0.75)
    k_occ = lo + int(np.argmax(area[lo:hi]))
    z_occ = zw[k_occ] + 5.0
    x_lo, x_hi = (box.any(axis=(0, 1)).nonzero()[0][[0, -1]]) * sx
    drop = []
    for p in ps:
        if p["vol"] > max_frac * total:
            continue
        zs = zw[[p["slices"][0].start * f[0], min(len(zw) - 1, p["slices"][0].stop * f[0] - 1)]]
        # centre of the piece along the grid x axis, in mm from the piece's box start
        xs = (np.nonzero((coarse == p["label"]).any(axis=(0, 1)))[0].mean() * f[2] + 0.5 * f[2]) * sx
        frac = xs / max(x_hi - x_lo + sx, 1e-6)
        if zs.min() >= z_occ and 0.2 <= frac <= 0.8:
            drop.append(p["label"])
    if not drop:
        return piece, dict(info, trimmed_cm3=0.0)
    lab = sep.lift(coarse)
    keep = (lab > 0) & ~np.isin(lab, drop)
    out = np.zeros(piece.shape, bool)
    out[sep.box] = keep
    cut = float(piece.sum() - out.sum()) * sx * sy * sz / 1000.0
    return out, dict(info, trimmed_cm3=cut, volume_cm3=info["volume_cm3"] - cut,
                     note=f"mandible: {cut:.1f} cm3 of maxilla remnant (a central bone column above the occlusal plane) was cut off the planning bone")
