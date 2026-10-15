"""Guide consistency metrics (Denetim 3, task 6). Offline measurements on what driver.mjs extracted from one run:
guide meshes (browser preview STL, server production STL), bone volumes cropped around the guide (CT HU at full
resolution and the app's own 0.8 mm working field), planes, screws, frame and fibula plan.

Bone references
  'ct'  : CT HU iso-surface at the segmentation threshold (trilinear), restricted to the bone the app selected
          (app field > 0.05, the same restriction the server uses). This is the real bone.
  'app' : the app's working field iso 0.5 (what the browser guide is built against).
Everything is in world LPS mm. Only numpy / scipy / scikit-image / trimesh are used."""
import json
import os
import numpy as np
import trimesh
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.measure import marching_cubes

RNG_SEED = 1234


# ----------------------------------------------------------------------------------------------- volumes
class Crop:
    """A cropped volume in the app's index grid: world = origin + sum_a axes[a] * idx[a] * sp[a]."""

    def __init__(self, meta, run_dir):
        self.dims = meta["dims"]
        self.sp = np.asarray(meta["sp"], float)
        self.origin = np.asarray(meta["origin"], float)
        self.axes = np.asarray(meta["axes"], float)
        dt = np.int16 if meta["dtype"] == "int16" else np.float32
        nx, ny, nz = self.dims
        self.a = np.fromfile(os.path.join(run_dir, meta["data"]), dt).reshape(nz, ny, nx).astype(np.float32)

    def idx(self, w):
        d = np.asarray(w, float) - self.origin
        return (d @ self.axes.T) / self.sp            # (..., 3) as i, j, k

    def world(self, ijk):
        return self.origin + (np.asarray(ijk, float) * self.sp) @ self.axes

    def sample(self, w, arr=None, cval=0.0):
        arr = self.a if arr is None else arr
        ijk = self.idx(w).reshape(-1, 3)
        return ndi.map_coordinates(arr, [ijk[:, 2], ijk[:, 1], ijk[:, 0]], order=1, mode="constant", cval=cval).reshape(np.shape(w)[:-1])


class Bone:
    """Bone reference: inside test (trilinear iso), dense surface samples for distances, SDF grid for sweeps."""

    def __init__(self, crop, iso, arr=None, cval=0.0, spacing=0.04, name=""):
        self.crop, self.iso, self.arr, self.cval, self.name = crop, iso, (crop.a if arr is None else arr), cval, name
        a = self.arr
        if a.max() < iso:
            raise ValueError("no bone in crop")
        v, f, _, _ = marching_cubes(np.pad(a, 1, constant_values=cval), iso)
        v = v - 1.0
        world = crop.world(v[:, ::-1])
        self.mesh = trimesh.Trimesh(world, f, process=False)
        n = int(min(4e5, max(1e5, self.mesh.area / spacing ** 2)))
        pts, fi = trimesh.sample.sample_surface(self.mesh, n, seed=RNG_SEED)
        self.pts, self.fi = pts, fi
        self.tri = self.mesh.triangles
        self.tree = cKDTree(pts, leafsize=64)

    def inside(self, w):
        return self.crop.sample(w, self.arr, self.cval) >= self.iso

    def sdist(self, w):
        """signed distance (mm, negative inside bone) and nearest bone surface point."""
        w = np.asarray(w, float).reshape(-1, 3)
        d, q = exact_nearest(self.tree, self.fi, self.tri, w)
        s = np.where(self.inside(w), -d, d)
        return s, q

    def sdf_grid(self, lo, hi, h=0.25):
        """signed distance on a regular world-aligned grid (for the insertion sweep)."""
        shape = np.ceil((hi - lo) / h).astype(int) + 1
        gx, gy, gz = [lo[a] + h * np.arange(shape[a]) for a in range(3)]
        W = np.stack(np.meshgrid(gx, gy, gz, indexing="ij"), -1)
        occ = self.inside(W.reshape(-1, 3)).reshape(shape)
        sdf = (ndi.distance_transform_edt(~occ) - ndi.distance_transform_edt(occ)) * h
        return dict(lo=np.asarray(lo, float), h=h, sdf=sdf.astype(np.float32))


def closest_on_tri(p, a, b, c):
    """closest points on triangles (a, b, c) to points p, all (n, 3) (Ericson, Real-Time Collision Detection 5.1.5)."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = np.einsum("ij,ij->i", ab, ap), np.einsum("ij,ij->i", ac, ap)
    bp = p - b
    d3, d4 = np.einsum("ij,ij->i", ab, bp), np.einsum("ij,ij->i", ac, bp)
    cp = p - c
    d5, d6 = np.einsum("ij,ij->i", ab, cp), np.einsum("ij,ij->i", ac, cp)
    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4
    den = va + vb + vc
    den = np.where(np.abs(den) < 1e-30, 1e-30, den)
    v = vb / den
    w = vc / den
    out = a + ab * v[:, None] + ac * w[:, None]                     # interior
    # edge / vertex regions (later assignments take precedence in the order of the reference algorithm)
    with np.errstate(divide="ignore", invalid="ignore"):
        m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
        t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); out[m] = (b + (c - b) * t[:, None])[m]
        m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
        t = d2 / (d2 - d6); out[m] = (a + ac * t[:, None])[m]
        m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
        t = d1 / (d1 - d3); out[m] = (a + ab * t[:, None])[m]
    m = (d6 >= 0) & (d5 <= d6); out[m] = c[m]
    m = (d3 >= 0) & (d4 <= d3); out[m] = b[m]
    m = (d1 <= 0) & (d2 <= 0); out[m] = a[m]
    return out


def exact_nearest(tree, fi, tri, w, k=8, chunk=200000, faces=False):
    """distance from points w to a mesh: k nearest surface samples give candidate faces, exact point-triangle distance."""
    D = np.empty(len(w)); Q = np.empty((len(w), 3)); FI = np.empty(len(w), int)
    for s0 in range(0, len(w), chunk):
        p = w[s0:s0 + chunk]
        _, ii = tree.query(p, k=k, workers=4)
        best = np.full(len(p), np.inf); bq = np.zeros((len(p), 3)); bf = np.zeros(len(p), int)
        for j in range(k):
            f = fi[ii[:, j]]
            q = closest_on_tri(p, tri[f, 0], tri[f, 1], tri[f, 2])
            dd = np.linalg.norm(p - q, axis=1)
            m = dd < best; best[m] = dd[m]; bq[m] = q[m]; bf[m] = f[m]
        D[s0:s0 + chunk] = best; Q[s0:s0 + chunk] = bq; FI[s0:s0 + chunk] = bf
    return (D, Q, FI) if faces else (D, Q)


def grid_sample(G, w):
    ijk = (np.asarray(w, float).reshape(-1, 3) - G["lo"]) / G["h"]
    return ndi.map_coordinates(G["sdf"], ijk.T, order=1, mode="constant", cval=1e3)


def bone_refs(run_dir, gd, thr, field_iso=0.5):
    hu = Crop(gd["hu"], run_dir)
    fld = Crop(gd["field"], run_dir)
    # restrict CT bone to the app's selected structure (field > 0.05 around it), like the server request does
    centres = hu.world(np.stack(np.meshgrid(np.arange(hu.dims[0]), np.arange(hu.dims[1]), np.arange(hu.dims[2]), indexing="ij"), -1).reshape(-1, 3))
    f_at = fld.sample(centres).reshape(hu.dims[0], hu.dims[1], hu.dims[2]).transpose(2, 1, 0)
    ct_arr = np.where(f_at > 0.05, hu.a, -1024.0).astype(np.float32)
    refs = {"ct": Bone(hu, float(thr), ct_arr, -1024.0, name="ct"), "app": Bone(fld, field_iso, None, 0.0, name="app")}
    return refs


# ----------------------------------------------------------------------------------------------- guide meshes
class GuideMesh:
    def __init__(self, path, spacing=0.1):
        raw = trimesh.load(path, process=False)
        self.raw = raw
        m = trimesh.Trimesh(raw.vertices, raw.faces, process=True)       # merge identical positions (STL soup)
        self.mesh = m
        q = stl_quality(m)
        self.quality = q
        # orientation for analysis: outward normals
        mm = m.copy()
        if q["volume_signed"] < 0:
            mm.invert()
        self.am = mm
        n = int(min(4e5, max(1e5, mm.area / spacing ** 2)))
        pts, fi = trimesh.sample.sample_surface(mm, n, seed=RNG_SEED)
        self.pts, self.nrm, self.fi = pts, mm.face_normals[fi], fi
        self.dA = mm.area / n
        self.tree = cKDTree(pts, leafsize=64)

        self.par = Parity(mm)

    def inside(self, w):
        """inside test by ray parity (closed meshes), plus the distance to the surface."""
        w = np.asarray(w, float).reshape(-1, 3)
        d, _ = exact_nearest(self.tree, self.fi, self.am.triangles, w, k=6)
        return self.par.inside(w), d


class Parity:
    """Point-in-mesh by counting crossings of a ray along a fixed skew direction; triangles binned in 2-D."""

    def __init__(self, mesh, b=0.5):
        rng = np.random.default_rng(7)
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        self.R = q
        V = mesh.vertices @ q
        self.T = V[mesh.faces]                     # (nf, 3, 3) rotated
        self.b = b
        lo2 = self.T[:, :, :2].min(1); hi2 = self.T[:, :, :2].max(1)
        self.o = lo2.min(0) - b
        i0 = np.floor((lo2 - self.o) / b).astype(int); i1 = np.floor((hi2 - self.o) / b).astype(int)
        self.nb = int(i1[:, 1].max()) + 2
        bins, tris = [], []
        span = (i1 - i0 + 1)
        for dx in range(int(span[:, 0].max())):
            for dy in range(int(span[:, 1].max())):
                m = (dx < span[:, 0]) & (dy < span[:, 1])
                t = np.flatnonzero(m)
                bins.append((i0[t, 0] + dx) * self.nb + (i0[t, 1] + dy)); tris.append(t)
        bins, tris = np.concatenate(bins), np.concatenate(tris)
        order = np.argsort(bins, kind="stable")
        self.bins, self.tris = bins[order], tris[order]

    def inside(self, w):
        P = np.asarray(w, float).reshape(-1, 3) @ self.R
        ij = np.floor((P[:, :2] - self.o) / self.b).astype(int)
        key = ij[:, 0] * self.nb + ij[:, 1]
        cnt = np.zeros(len(P), int)
        order = np.argsort(key, kind="stable"); ks = key[order]
        uk, starts = np.unique(ks, return_index=True)
        ends = np.append(starts[1:], len(ks))
        lo = np.searchsorted(self.bins, uk, "left"); hi = np.searchsorted(self.bins, uk, "right")
        for a, b_, l, h in zip(starts, ends, lo, hi):
            if h <= l:
                continue
            qi = order[a:b_]
            T = self.T[self.tris[l:h]]                 # (t, 3, 3)
            px, py, pz = P[qi, 0][:, None], P[qi, 1][:, None], P[qi, 2][:, None]
            x0, y0, z0 = T[:, 0, 0][None], T[:, 0, 1][None], T[:, 0, 2][None]
            x1, y1, z1 = T[:, 1, 0][None], T[:, 1, 1][None], T[:, 1, 2][None]
            x2, y2, z2 = T[:, 2, 0][None], T[:, 2, 1][None], T[:, 2, 2][None]
            e0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)
            e1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
            e2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)
            inn = ((e0 > 0) & (e1 > 0) & (e2 > 0)) | ((e0 < 0) & (e1 < 0) & (e2 < 0))
            area = e0 + e1 + e2
            area = np.where(np.abs(area) < 1e-18, 1e-18, area)
            z = (e1 * z0 + e2 * z1 + e0 * z2) / area      # barycentric z at the point
            cnt[qi] += (inn & (z > pz)).sum(1)
        return (cnt % 2) == 1


def stl_quality(m):
    e = m.edges_sorted
    _, c = np.unique(e, axis=0, return_counts=True)
    nonman = int((c != 2).sum())
    degenerate = int((m.area_faces < 1e-10).sum())
    # signed volume from the faces as stored (negative = inward winding)
    v = m.vertices[m.faces]
    vol = float(np.einsum("ij,ij->i", v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6.0)
    try:
        bodies = int(m.body_count)
    except Exception:
        bodies = -1
    return dict(faces=int(len(m.faces)), watertight=bool(m.is_watertight), winding_consistent=bool(m.is_winding_consistent),
                nonmanifold_edges=nonman, degenerate_faces=degenerate, volume_signed=vol, volume=abs(vol), bodies=bodies,
                euler=int(m.euler_number), area=float(m.area))


# ----------------------------------------------------------------------------------------------- metrics
def fit_metrics(G, bone, clear, wall):
    s, q = bone.sdist(G.pts)
    to_b = q - G.pts
    dist = np.linalg.norm(to_b, axis=1) + 1e-12
    # guide outward normal against the direction into the bone (q - p outside the bone, p - q inside it)
    facing = np.einsum("ij,ij->i", G.nrm, to_b / dist[:, None]) * np.sign(s + 1e-9)
    inner = (facing > 0.7) & (s < clear + wall / 2) & (s > -wall)
    gi = s[inner]
    band = np.abs(gi - clear) <= 0.2
    interf = s < -0.1
    res = dict(inner_area_mm2=float(inner.sum() * G.dA), gap_mean=float(gi.mean()) if gi.size else None,
               gap_median=float(np.median(gi)) if gi.size else None, gap_p5=float(np.percentile(gi, 5)) if gi.size else None,
               gap_p95=float(np.percentile(gi, 95)) if gi.size else None, in_band_frac=float(band.mean()) if gi.size else 0.0,
               contact_area_mm2=float(band.sum() * G.dA), interference_area_mm2=float(interf.sum() * G.dA),
               min_sdist=float(s.min()), p01_sdist=float(np.percentile(s, 0.1)))
    hist, edges = np.histogram(gi, bins=np.arange(-1.0, 2.01, 0.05)) if gi.size else (np.zeros(60), np.arange(-1.0, 2.01, 0.05))
    res["_hist"] = dict(counts=hist.tolist(), edges=edges.tolist())
    res["_sd"] = s
    res["_inner"] = inner
    return res


def frame_dirs(frame, fine=False):
    u, v, n = (np.asarray(frame[k], float) for k in ("u", "v", "n"))
    out = []
    tilts = range(0, 61, 10) if fine else range(0, 41, 10)
    for t in tilts:
        for az in (range(0, 360, 30) if fine else range(0, 360, 45)):
            if t == 0 and az > 0:
                continue
            tr, ar = np.radians(t), np.radians(az)
            d = np.sin(tr) * np.cos(ar) * u + np.sin(tr) * np.sin(ar) * v + np.cos(tr) * n
            out.append((t, az, d / np.linalg.norm(d)))
    return out


def seat_metrics(G, bone, frame, start_sd, tmax=15.0, step=0.25, pen=0.3, nsub=15000):
    """Translate the guide along each candidate direction; a direction is free when no guide surface point enters the
    bone deeper than `pen` mm within tmax mm. Points that already start inside the bone are left out (interference
    is reported by the fit metric)."""
    rng = np.random.default_rng(RNG_SEED)
    ok0 = start_sd > -0.1
    idx = np.flatnonzero(ok0)
    if idx.size > nsub:
        idx = rng.choice(idx, nsub, replace=False)
    P = G.pts[idx]
    lo, hi = G.pts.min(0) - 4, G.pts.max(0) + 4
    sg = bone.sdf_grid(lo, hi, 0.25)
    ts = np.arange(step, tmax + 1e-9, step)
    area_per = G.dA * ok0.sum() / max(1, idx.size)

    def blocked(d):
        hit = np.zeros(len(P), bool)
        for t in ts:
            q = P + t * d
            hit |= grid_sample(sg, q) < -pen
        return float(hit.sum() * area_per)

    # deepest overhang met when lifting along the app's insertion axis n (all points that start outside the bone)
    nax = np.asarray(frame["n"], float)
    deep = np.zeros(len(P))
    for t in ts:
        deep = np.maximum(deep, -grid_sample(sg, P + t * nax))
    max_overhang_n = float(deep.max())
    coarse = [(t, az, blocked(d)) for t, az, d in frame_dirs(frame)]
    fine = [(t, az, blocked(d)) for t, az, d in frame_dirs(frame, fine=True)]
    free_c = [x for x in coarse if x[2] < 2.0]
    free_f = [x for x in fine if x[2] < 2.0]
    # widest cone around n that is entirely free
    cone = 0
    for t in range(0, 61, 10):
        if all(x[2] < 2.0 for x in fine if x[0] == t):
            cone = t
        else:
            break
    return dict(max_overhang_n_mm=max_overhang_n, pen_mm=pen, free_coarse=len(free_c), n_coarse=len(coarse), free_fine=len(free_f), n_fine=len(fine), normal_blocked_mm2=coarse[0][2],
                min_blocked_mm2=min(x[2] for x in fine), free_cone_deg=cone, any_free=bool(free_f), coarse=coarse)


def slot_metrics(G, bone, planes, clear, wall, grid_step=0.25):
    """For each plane: walls of the slot (guide faces parallel to the plane near +-w/2), their angle and offset, the
    slot width, and whether the slot is open through the shell (no guide material at the slot centre wherever shell
    material lies beside the slot)."""
    out = []
    m = G.am
    fc, fn, fa = m.triangles_center, m.face_normals, m.area_faces
    for k, pl in enumerate(planes):
        p, N, w = np.asarray(pl["p"], float), np.asarray(pl["N"], float), float(pl["w"])
        N = N / np.linalg.norm(N)
        s = (fc - p) @ N
        par = np.abs(fn @ N) > 0.9
        res = dict(plane=k, w_planned=w)
        walls = {}
        for side, sel in (("pos", par & (s > 0.05) & (s < w / 2 + 0.6) & ((fn @ N) < 0)), ("neg", par & (s < -0.05) & (s > -w / 2 - 0.6) & ((fn @ N) > 0))):
            if sel.sum() < 10:
                walls[side] = None
                continue
            P, A = fc[sel], fa[sel]
            c = (P * A[:, None]).sum(0) / A.sum()
            X = (P - c) * np.sqrt(A)[:, None]
            _, _, vt = np.linalg.svd(X, full_matrices=False)
            nn = vt[2] * np.sign(vt[2] @ N)
            walls[side] = dict(offset=float((c - p) @ N), angle_deg=float(np.degrees(np.arccos(min(1.0, abs(nn @ N))))), area=float(A.sum()),
                               rms=float(np.sqrt(((((P - c) @ nn) ** 2) * A).sum() / A.sum())))
        res["walls"] = walls
        if walls.get("pos") and walls.get("neg"):
            res["width"] = walls["pos"]["offset"] - walls["neg"]["offset"]
            res["centre_offset"] = (walls["pos"]["offset"] + walls["neg"]["offset"]) / 2
            res["angle_deg"] = max(walls["pos"]["angle_deg"], walls["neg"]["angle_deg"])
        # open-through test on a grid in the plane
        t = np.cross(N, [0, 0, 1.0] if abs(N[2]) < 0.9 else [1.0, 0, 0]); e1 = t / np.linalg.norm(t); e2 = np.cross(N, e1)
        near = G.pts[np.abs((G.pts - p) @ N) < w / 2 + 1.5]
        if len(near) == 0:
            res["open"] = None
            out.append(res)
            continue
        a, b = (near - p) @ e1, (near - p) @ e2
        ga, gb = np.arange(a.min() - 1, a.max() + 1, grid_step), np.arange(b.min() - 1, b.max() + 1, grid_step)
        A_, B_ = np.meshgrid(ga, gb, indexing="ij")
        Q = p + A_.reshape(-1, 1) * e1 + B_.reshape(-1, 1) * e2
        sd, _ = bone.sdist(Q)
        zone = (sd > clear + 0.15) & (sd < clear + wall - 0.6)               # where the shell would be (below the bridge band)
        Q = Q[zone]
        side_off = w / 2 + 0.5
        in_p, _ = G.inside(Q + side_off * N)
        in_n, _ = G.inside(Q - side_off * N)
        beside = in_p | in_n
        in_0, d0 = G.inside(Q)
        blocked = in_0 & beside & (d0 > 0.05)
        res["open"] = dict(shell_beside_mm2=float(beside.sum() * grid_step ** 2), blocked_mm2=float(blocked.sum() * grid_step ** 2),
                           blocked_frac=float(blocked.sum() / max(1, beside.sum())))
        out.append(res)
    return out


def wall_metrics(G, wall, inner_mask=None, screws=(), nsub=20000, step=0.05, tmax=8.0):
    """Thickness along the inward normal (ray march with the parity inside test).
    wall_*: on the bone-facing inner surface (the shell wall the setting controls);
    thin_*: anywhere except sleeves / holes (feather edges where the shell is clipped)."""
    rng = np.random.default_rng(RNG_SEED)

    def march(idx):
        P, Nn = G.pts[idx], G.nrm[idx]
        th = np.full(len(P), np.nan)
        alive = np.ones(len(P), bool); entered = np.zeros(len(P), bool)
        for t in np.arange(step, tmax, step):
            ai = np.flatnonzero(alive)
            if not ai.size:
                break
            ins = G.par.inside(P[ai] - t * Nn[ai])
            entered[ai[ins]] = True
            leave = ai[(~ins) & entered[ai]]
            th[leave] = t; alive[leave] = False
        th[alive & entered] = tmax
        return th

    out = {}
    if inner_mask is not None and inner_mask.any():
        # interior of the bone-facing surface only (>= 1.5 mm from its rim): near the rim the shell is clipped by the
        # guide box at an angle and the thickness along the normal is that of the rim wedge (reported as thin_*)
        dr, _ = cKDTree(G.pts[~inner_mask]).query(G.pts[inner_mask], workers=4, distance_upper_bound=3.0)
        ii = np.flatnonzero(inner_mask)[dr >= 1.5]
        out["wall_interior_area_mm2"] = float(ii.size * G.dA)
        ii = rng.choice(ii, min(nsub, ii.size), replace=False)
        v = march(ii); v = v[np.isfinite(v)]
        out.update(wall_p1=float(np.percentile(v, 1)), wall_p5=float(np.percentile(v, 5)), wall_median=float(np.median(v)), wall_min=float(v.min()),
                   wall_frac_below=float((v < wall - 0.2).mean()))
    keep = np.ones(len(G.pts), bool)
    for s in screws:
        if not s or s.get("entry") is None:
            continue
        e, d = np.asarray(s["entry"], float), np.asarray(s["dir"], float); d = d / np.linalg.norm(d)
        r = G.pts - e; t = r @ d
        radial = np.linalg.norm(r - t[:, None] * d, axis=1)
        keep &= radial > float(s["sc"]["D"]) / 2 + 0.6
    ii = np.flatnonzero(keep)
    ii = rng.choice(ii, min(nsub, ii.size), replace=False)
    v = march(ii); v = v[np.isfinite(v)]
    out.update(all_p1=float(np.percentile(v, 1)), all_median=float(np.median(v)), thin_lt1mm_area_mm2=float((v < 1.0).mean() * keep.sum() * G.dA),
               thin_lt1mm_frac=float((v < 1.0).mean()), all_min=float(v.min()))
    out["_thin_pts"] = G.pts[ii][v < 1.0] if v.size == ii.size else None
    return out


def screw_metrics(G, bone, screws, planes, clear, wall, resection=None):
    out = []
    for k, s in enumerate(screws):
        r = dict(screw=k)
        if s is None or s.get("entry") is None or s.get("dir") is None:
            r.update(null=True)
            out.append(r)
            continue
        e, d = np.asarray(s["entry"], float), np.asarray(s["dir"], float)
        d = d / np.linalg.norm(d)
        sc = s["sc"]
        L, dd, D, sH = float(sc["len"]), float(sc["d"]), float(sc["D"]), float(sc["sleeveH"])
        ts = np.arange(0, L + 1e-9, 0.1)
        path = e + ts[:, None] * d
        inb = bone.inside(path)
        r.update(null=False, in_bone_frac=float(inb.mean()), first2mm_in_bone=bool(inb[ts <= 2.0].mean() > 0.8),
                 entry_sdist=float(bone.sdist(e[None])[0][0]))
        # hole through the guide: axis and 0.8 r ring above the bone must be free of material
        t_out = np.arange(0.4, clear + wall + sH + 1.0, 0.1)
        o = np.cross(d, [0, 0, 1.0] if abs(d[2]) < 0.9 else [1.0, 0, 0]); o /= np.linalg.norm(o); o2 = np.cross(d, o)
        ang = np.linspace(0, 2 * np.pi, 12, endpoint=False)
        ring = lambda rad, tt: (e - tt[:, None, None] * d + rad * (np.cos(ang)[None, :, None] * o + np.sin(ang)[None, :, None] * o2)).reshape(-1, 3)
        axis_pts = np.concatenate([e - t_out[:, None] * d, ring(0.8 * dd / 2, t_out)])
        ins, dist = G.inside(axis_pts)
        r["hole_blocked_frac"] = float((ins & (dist > 0.05)).mean())
        hs = np.arange(clear + 0.3, clear + wall + sH - 0.3, 0.2)
        ring_pts = ring((dd / 2 + D / 2) / 2, hs)
        ins2, _ = G.inside(ring_pts)
        r["sleeve_material_frac"] = float(ins2.mean())
        # distance from the screw (axis +- d/2) to each cut slot (plane +- w/2)
        cl = []
        for pl in planes:
            p, N, w = np.asarray(pl["p"], float), np.asarray(pl["N"], float), float(pl["w"])
            N = N / np.linalg.norm(N)
            full = np.concatenate([e - t_out[:, None] * d, path])
            cl.append(float(np.abs((full - p) @ N).min() - w / 2 - dd / 2 * np.sqrt(max(0.0, 1 - (d @ N) ** 2))))
        r["plane_clearance_mm"] = cl
        r["min_plane_clearance_mm"] = min(cl) if cl else None
        if resection:
            A, B = resection
            pa, na, wa = np.asarray(A["p"]), np.asarray(A["N"]), A["w"]
            pb, nb, wb = np.asarray(B["p"]), np.asarray(B["N"]), B["w"]
            sa, sb = (path - pa) @ na, (path - pb) @ nb
            inside_res = (sa > wa / 2) & (sb < -wb / 2) if not resection_virtual(B) else (sa > wa / 2)
            r["in_resection_frac"] = float(inside_res.mean())
        out.append(r)
    return out


def resection_virtual(B):
    return bool(B.get("virtual")) or B.get("w", 0) == 0


def hausdorff(GA, GB):
    dab, _ = exact_nearest(GB.tree, GB.fi, GB.am.triangles, GA.pts)
    dba, _ = exact_nearest(GA.tree, GA.fi, GA.am.triangles, GB.pts)
    return dict(hausdorff=float(max(dab.max(), dba.max())), p99=float(max(np.percentile(dab, 99), np.percentile(dba, 99))),
                mean=float((dab.mean() + dba.mean()) / 2), vol_diff_pct=float(100 * (GA.quality["volume"] - GB.quality["volume"]) / GB.quality["volume"]))


def load_run(run_dir):
    with open(os.path.join(run_dir, "run.json")) as f:
        return json.load(f)


def strip(o):
    """drop private arrays (keys starting with _) before writing JSON."""
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not k.startswith("_") or k == "_hist"}
    if isinstance(o, list):
        return [strip(v) for v in o]
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.bool_):
        return bool(o)
    return o
