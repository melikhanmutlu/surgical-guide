"""Which bone is the planning bone: separating bones that a threshold joins (mirror of web/geom.js G.separator,
web/bones.js and web/fibula.js, same limits).

A bone threshold joins everything that touches. In a head CT the skull, the upper jaw (through the teeth), the mandible
(jaw joint) and the cervical spine are one component of 400-600 cm3; in a leg CT tibia, fibula and foot are one piece per
leg and the CT table is a component of its own. The pieces are found with a watershed on the distance transform: every
local maximum is a bone core, and two cores are one bone when the neck between them is at least `ratio` times as thick
as the thinner core (a bone is thick everywhere; a joint or a tooth contact is a thin neck). The cores grow back over the
whole mask, so each piece keeps its full surface.
"""
import numpy as np
from scipy import ndimage as ndi

# limits in mm / cm3 for an adult mandible (bone mask with teeth); generous on purpose
MANDIBLE_LIM = dict(vol=(20.0, 200.0), width=(85.0, 150.0), depth=(60.0, 130.0), height=108.0, z_over_x=1.3)
MANDIBLE_RATIOS = (0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65)
FIBULA_RADIUS = (2.5, 12.0)                   # mm: slenderest / thickest radius a fibula can have
FIBULA_LENGTH = (120.0, 500.0)                # mm: shortest / longest fibula (CT table rails are 800 mm and more)
FIBULA_RATIOS = (0.45, 0.5, 0.4, 0.55, 0.35, 0.6)


def _flood(edt, cmask, ratio):
    """Watershed with neck / core merging on a padded coarse grid; int32 labels (0 = outside), pieces numbered by root."""
    shape = edt.shape
    ny, nx = shape[1], shape[2]
    order = np.flatnonzero(cmask.ravel())
    order = order[np.argsort(-edt.ravel()[order], kind="stable")].tolist()
    D = edt.ravel().tolist()
    nb = (-1, 1, -nx, nx, -nx * ny, nx * ny)
    lab = [0] * cmask.size
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
    """Distance transform of one mask (z, y, x), computed once; run(ratio) cuts it at a neck / core thickness ratio."""

    def __init__(self, mask, spacing, work_mm=1.0):
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

    def run(self, ratio):
        """int32 labels with the shape of the input mask; pieces numbered 1.. by size, 0 outside the mask."""
        lab = _flood(self.edt, self.cmask, ratio)[1:-1, 1:-1, 1:-1]
        fz, fy, fx = self.f
        nz, ny, nx = self.native.shape
        up = np.repeat(np.repeat(np.repeat(lab, fz, 0), fy, 1), fx, 2)[:nz, :ny, :nx]
        up = np.where(self.native, up, 0)
        miss = self.native & (up == 0)
        if miss.any():                                           # thin native voxels the coarse grid dropped: nearest piece
            idx = ndi.distance_transform_edt(up == 0, return_distances=False, return_indices=True)
            up = np.where(miss, up[tuple(idx)], up)
        ids, counts = np.unique(up[up > 0], return_counts=True)
        rank = np.zeros(int(up.max()) + 1, np.int32)
        rank[ids[np.argsort(-counts, kind="stable")]] = np.arange(1, len(ids) + 1)
        out = np.zeros(self.shape, np.int32)
        out[self.box] = rank[up]
        return out


def pieces(lab, spacing, origin_idx=(0, 0, 0), min_vox=50):
    """Stats of every piece of a label array (z, y, x): volume (cm3), extent along the grid axes (x, y, z mm), centre
    (physical mm from the volume's index 0), PCA axis, length (sqrt(12 l1)), radius (2 sqrt(l2)) and elongation."""
    sx, sy, sz = spacing
    out = []
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        m = lab[sl] == k
        n = int(m.sum())
        if n < min_vox:
            continue
        P = (np.argwhere(m) + [s.start + o for s, o in zip(sl, origin_idx)]) * np.array([sz, sy, sx])
        P = P[:, ::-1]                                           # (x, y, z) mm
        c = P.mean(0)
        w, v = np.linalg.eigh(np.cov((P - c).T))
        ax = v[:, 2] if v[2, 2] >= 0 else -v[:, 2]
        out.append(dict(label=k, n=n, vol=n * sx * sy * sz / 1000.0, centroid=c, axis=ax,
                        ext=((sl[2].stop - sl[2].start) * sx, (sl[1].stop - sl[1].start) * sy, (sl[0].stop - sl[0].start) * sz),
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


def pick_mandible(mask, spacing, origin_idx=(0, 0, 0), up=1):
    """mask: the largest threshold component (z, y, x), cropped to its box at origin_idx; spacing (sx, sy, sz).
    Returns (mask, info). info['status']: 'whole' (mandible-sized already), 'split' (cut, mandible-like piece taken) or
    'failed' (nothing fits: the whole component is returned and info['warning'] says why that is not a mandible)."""
    sx, sy, sz = spacing
    vol = float(mask.sum() * sx * sy * sz / 1000.0)
    zz, yy, xx = (np.nonzero(mask.any(axis=a))[0] for a in ((1, 2), (0, 2), (0, 1)))
    ext = ((xx[-1] - xx[0] + 1) * sx, (yy[-1] - yy[0] + 1) * sy, (zz[-1] - zz[0] + 1) * sz)
    if not too_big_for_mandible(vol, ext):
        return mask, dict(status="whole", volume_cm3=vol, extent_mm=ext)
    sep = Separator(mask, spacing)
    cz = np.argwhere(mask)[:, 0].mean() * sz                     # height of the component's centre of mass
    for ratio in MANDIBLE_RATIOS:
        lab = sep.run(ratio)
        fits = [p for p in pieces(lab, spacing, origin_idx, 50)
                if mandible_like(p["vol"], p["ext"]) and (p["centroid"][2] - (cz + origin_idx[0] * sz)) * up < 0]
        if fits:
            best = max(fits, key=lambda p: p["vol"])
            return lab == best["label"], dict(status="split", ratio=ratio, volume_cm3=best["vol"], extent_mm=best["ext"], before_cm3=vol)
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


def pick_fibula(comps, spacing, side="right"):
    """comps: [(mask crop (z, y, x), origin_idx)] of the largest threshold components. Returns (index of comp, mask of the
    fibula in that comp's crop, info). info['status']: 'ok' | 'failed' (no tibia partner found: the longest slender piece
    is returned and info['warning'] says so). Right leg = smaller x (patient right is -x in LPS)."""
    sx, sy, sz = spacing
    allp = []
    for i, (m, o) in enumerate(comps):
        for p in pieces(m.astype(np.int32), spacing, o, 200):
            p.update(comp=i, lab=None, sep=None)
            allp.append(p)
    found, longp = fibula_candidates(allp)
    warn = None
    # leg-like pieces (long and thick: tibia + fibula + foot, pelvis, femur, the table) that are more than the fibulas found
    # beside them were not looked into: cut them (a clean leg CT has as many fibulas as thick pieces, and is left alone)
    thick = sorted({p["comp"] for p in longp if p["radius"] > FIBULA_RADIUS[1] and p["len"] >= 150})
    if len(thick) > len(found):
        seps = {i: Separator(comps[i][0], spacing) for i in thick}
        rest = [p for p in allp if p["comp"] not in seps]
        best = (0, None, None)
        for ratio in FIBULA_RATIOS:
            ps, labs = list(rest), {}
            for i, sp in seps.items():
                labs[i] = sp.run(ratio)
                for p in pieces(labs[i], spacing, comps[i][1], 200):
                    p.update(comp=i, lab=labs[i], sep=ratio)
                    ps.append(p)
            f2, _ = fibula_candidates(ps)
            if len(f2) > best[0]:
                best = (len(f2), f2, ratio)
            if len(f2) >= len(thick):
                break
        if best[1]:
            found = best[1]
        elif not found:
            warn = ("fibula: tibia and fibula are joined in the threshold mask and could not be separated; "
                    "the longest slender piece is used and is probably the whole lower leg")
            found = sorted([p for p in longp if FIBULA_LENGTH[0] <= p["len"] <= FIBULA_LENGTH[1]], key=lambda p: p["radius"])[:1] or sorted(longp, key=lambda p: -p["len"])[:1]
    if not found:
        raise RuntimeError("no long bone (fibula) found in the leg CT")
    # the fibula is the longest slender bone with a tibia beside it (arms and ribs are shorter); both legs: choose the side by x
    found = sorted(found, key=lambda p: (-p["len"], p["radius"]))
    found = [p for p in found if p["len"] >= 0.7 * found[0]["len"]]
    if len(found) >= 2:
        xs = [p["centroid"][0] for p in found]
        mid = 0.5 * (min(xs) + max(xs))
        pick = ([p for p in found if (p["centroid"][0] < mid) == (side == "right")] or found)[0]
    else:
        pick = found[0]
    if pick["lab"] is None:
        mask = comps[pick["comp"]][0].copy()
    else:
        mask = pick["lab"] == pick["label"]
    if pick["radius"] > FIBULA_RADIUS[1]:
        warn = ((warn + "; ") if warn else "") + f"fibula radius {pick['radius']:.0f} mm is above {FIBULA_RADIUS[1]:.0f} mm: this is not a fibula"
    info = dict(status="ok" if warn is None else "failed", volume_cm3=pick["vol"], length_mm=pick["len"], radius_mm=pick["radius"], candidates=len(found))
    if warn:
        info["warning"] = warn
    return pick["comp"], mask, info
