"""Virtual surgical planning for fibula free flap mandibular reconstruction.

Automates the parts of the published Blender workflow that are done by hand:
  * orientation        -> DICOM patient coordinates + PCA of the fibula (no manual alignment)
  * arch / defect      -> mandibular arch centreline extracted from the segmentation
  * graft positioning  -> number of segments and their break points optimised to follow the native arch
  * osteotomy planes   -> mandible cut planes, wedge (bisector) planes between segments, and their
                          transfer to the fibula, spaced so neighbouring cuts never intersect in bone
"""
import numpy as np
from scipy import ndimage as ndi
from scipy.optimize import minimize

UP = np.array([0.0, 0.0, 1.0])


def _unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def _points(vol, mask, step=1):
    idx = np.argwhere(mask[::step, ::step, ::step]) * step          # (z, y, x)
    return vol.index_to_physical(idx[:, ::-1])


class Arch:
    """Mandibular arch centreline, parametrised by arc length s (0 = midline, + = patient left)."""

    def __init__(self, vol, mask, body_height=24.0, bin_deg=2.0):
        P = _points(vol, mask)
        ext = np.ptp(P, axis=0)
        if ext[0] > 160 or ext[2] > 130:        # skull / spine joined to the mandible: the arch would be fitted to the wrong bone
            raise ValueError(f"mask is {ext[0]:.0f} x {ext[1]:.0f} x {ext[2]:.0f} mm; a mandible is at most ~160 x 130 x 130 mm. "
                             "Segment the mandible alone (segment.mandible_bone) or use --segmenter totalseg")
        z0 = P[:, 2].min()
        body = P[P[:, 2] < z0 + body_height]
        c = body.mean(0)
        theta = np.degrees(np.arctan2(body[:, 0] - c[0], -(body[:, 1] - c[1])))
        bins = np.arange(-180, 180 + bin_deg, bin_deg)
        which = np.digitize(theta, bins)
        cent, ang = [], []
        for b in np.unique(which):
            sel = which == b
            if sel.sum() >= 15:
                cent.append(body[sel].mean(0)); ang.append(theta[sel].mean())
        order = np.argsort(ang)
        pts = ndi.gaussian_filter1d(np.array(cent)[order], 1.5, axis=0, mode="nearest")
        ang = np.array(ang)[order]
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        s = np.concatenate([[0], np.cumsum(seg)])
        s -= np.interp(0.0, ang, s)                                     # s = 0 at the midline
        self.s = np.arange(s.min(), s.max(), 0.5)
        self.pts = np.stack([np.interp(self.s, s, pts[:, i]) for i in range(3)], 1)
        self.center = c

    def point(self, s):
        return np.stack([np.interp(s, self.s, self.pts[:, i]) for i in range(3)], -1)

    def tangent(self, s, ds=2.0):
        return _unit(self.point(s + ds) - self.point(s - ds))

    def buccal(self, s, t=None):
        """Horizontal unit vector perpendicular to the arch, pointing outwards (buccal)."""
        t = self.tangent(s) if t is None else t
        n = _unit(np.cross(t, UP))
        if np.dot(n, self.point(s) - self.center) < 0:
            n = -n
        return n

    def closest_s(self, q):
        from scipy.spatial import cKDTree
        return self.s[cKDTree(self.pts).query(q)[1]]


def _max_deviation(arch, knots):
    dev = 0.0
    for a, b in zip(knots[:-1], knots[1:]):
        ss = np.linspace(a, b, 40)
        p, A, B = arch.point(ss), arch.point(a), arch.point(b)
        d = _unit(B - A)
        r = (p - A) - np.outer((p - A) @ d, d)
        dev = max(dev, np.linalg.norm(r, axis=1).max())
    return dev


def optimise_segments(arch, s_a, s_b, n):
    """Choose interior break points that minimise the worst chord-to-arch deviation."""
    if n == 1:
        knots = np.array([s_a, s_b])
        return knots, _max_deviation(arch, knots)
    L = s_b - s_a

    def unpack(x):
        w = np.exp(np.concatenate([[0.0], x]))                       # positive segment weights
        return s_a + np.concatenate([[0], np.cumsum(w / w.sum())]) * L

    def cost(x):
        k = unpack(x)
        return _max_deviation(arch, k) + 0.02 * np.ptp(np.diff(k))   # prefer similar lengths on ties

    res = minimize(cost, np.zeros(n - 1), method="Nelder-Mead", options={"xatol": 1e-3, "fatol": 1e-3})
    k = unpack(res.x)
    return k, _max_deviation(arch, k)


class Fibula:
    """Fibula frame from PCA: a = long axis (distal -> proximal), e2 = lateral, e3 = a x e2."""

    def __init__(self, vol, mask, side="right"):
        P = _points(vol, mask)
        self.c = P.mean(0)
        _, _, vt = np.linalg.svd(P - self.c, full_matrices=False)
        a = vt[0] if vt[0][2] > 0 else -vt[0]
        lateral = np.array([-1.0, 0, 0]) if side == "right" else np.array([1.0, 0, 0])
        e2 = _unit(lateral - np.dot(lateral, a) * a)
        self.axes = np.stack([a, e2, np.cross(a, e2)], 1)               # columns
        loc = (P - self.c) @ self.axes
        self.s_min, self.s_max = loc[:, 0].min(), loc[:, 0].max()
        self.radius = np.percentile(np.linalg.norm(loc[:, 1:], axis=1), 99.5)

    def to_world(self, local):
        return self.c + np.asarray(local) @ self.axes.T


def make_plan(arch, fibula, s_a, s_b, n_segments=None, tol_mm=2.5, min_len=20.0,
              kerf=1.0, distal_margin=70.0, proximal_margin=60.0, roll_deg=0.0):
    """Return the plan dict. s_a < s_b are arch positions (mm from midline) of the two mandible cuts."""
    if not (np.isfinite(s_a) and np.isfinite(s_b)) or s_b - s_a < 5.0:
        raise ValueError(f"resection range must be finite and at least 5 mm long (got {s_a} .. {s_b})")
    if s_a < arch.s[0] - 1e-6 or s_b > arch.s[-1] + 1e-6:
        raise ValueError(f"resection {s_a:.1f} .. {s_b:.1f} mm lies outside the detected mandible arch ({arch.s[0]:.1f} .. {arch.s[-1]:.1f} mm)")
    if n_segments is None:                                           # automatic choice
        best = None
        for n in range(1, 5):
            k, dev = optimise_segments(arch, s_a, s_b, n)
            lens = [np.linalg.norm(arch.point(b) - arch.point(a)) for a, b in zip(k[:-1], k[1:])]
            if min(lens) < min_len:                                  # segments too short to survive
                break
            best = (k, dev, n)
            if dev <= tol_mm:
                break
        if best is None:
            best = (*optimise_segments(arch, s_a, s_b, 1), 1)
        knots, dev, n_segments = best
    else:
        knots, dev = optimise_segments(arch, s_a, s_b, n_segments)

    P = arch.point(knots)
    d = _unit(np.diff(P, axis=0))
    T_a, T_b = arch.tangent(s_a), arch.tangent(s_b)
    normals = [T_a] + [_unit(d[i - 1] + d[i]) for i in range(1, n_segments)] + [T_b]

    segs, s_cursor = [], fibula.s_min + distal_margin
    prev_end_normal_f = None
    roll = np.radians(roll_deg)
    for i in range(n_segments):
        x = d[i]
        b = arch.buccal((knots[i] + knots[i + 1]) / 2, t=x)
        b = _unit(b - np.dot(b, x) * x)
        b = np.cos(roll) * b + np.sin(roll) * np.cross(x, b)
        R = np.stack([x, b, np.cross(x, b)], 1)                         # fibula local -> mandible
        n0f, n1f = R.T @ normals[i], R.T @ normals[i + 1]               # plane normals, fibula local
        if prev_end_normal_f is not None:                               # keep cuts apart inside bone
            tilt = lambda n: np.linalg.norm(n[1:]) / abs(n[0])
            # Spacing between two grafts along the fibula: the two kerfs (one slot outside each graft face) plus the tilt of the
            # cut faces over the fibula radius, plus 1 mm. With upright cuts and kerf = 1 mm that is exactly 2 slots wide, i.e. no
            # bone is left between the slots: the grafts are cut with two adjacent saw passes and no waste wedge remains. This is
            # the same formula as web/fibula.js (a margin would change the fibula length needed in both); left as it is.
            s_cursor += kerf + 1.0 + fibula.radius * (tilt(prev_end_normal_f) + tilt(n0f))
        L = float(np.linalg.norm(P[i + 1] - P[i]))
        segs.append(dict(index=i, length_mm=L, fib_start=s_cursor, fib_end=s_cursor + L,
                         n_start_fib=n0f, n_end_fib=n1f, R=R, P_start=P[i], P_end=P[i + 1],
                         angle_start_deg=float(np.degrees(np.arccos(min(1, abs(n0f[0]))))),
                         angle_end_deg=float(np.degrees(np.arccos(min(1, abs(n1f[0])))))))
        s_cursor += L
        prev_end_normal_f = n1f
    overflow = s_cursor - (fibula.s_max - proximal_margin)
    warnings = plan_warnings(segs, dev, n_segments, tol_mm, min_len, overflow, s_b - s_a)
    return dict(knots=knots, points=P, normals=normals, segments=segs, max_deviation_mm=float(dev),
                n_segments=n_segments, kerf=kerf, fibula_fits=bool(overflow <= 0),
                fibula_overflow_mm=float(max(0, overflow)), defect_arc_mm=float(s_b - s_a), warnings=warnings)


ANGLE_WARN = 35.0               # deg: a cut this oblique is hard to saw and to fit (web/fibula.js ANGLE_WARN)


def plan_warnings(segs, dev, n_segments, tol_mm, min_len, overflow, arc):
    """What the plan does outside its own tolerances (web/fibula.js reports the same as critical): never silent."""
    w = []
    if dev > tol_mm:
        w.append(f"graft-to-arch deviation {dev:.2f} mm is above the {tol_mm:.1f} mm tolerance "
                 f"({n_segments} segment(s) for a {arc:.0f} mm defect); more or shorter segments follow the arch better")
    for g in segs:
        if g["length_mm"] < min_len:
            w.append(f"segment {g['index'] + 1} is {g['length_mm']:.1f} mm long, below the {min_len:.0f} mm a segment needs to keep its blood supply and fixation")
        a = max(g["angle_start_deg"], g["angle_end_deg"])
        if a > ANGLE_WARN:
            w.append(f"segment {g['index'] + 1}: a cut is {a:.0f} deg off the fibula axis (more than {ANGLE_WARN:.0f} deg)")
    if overflow > 0:
        w.append(f"the fibula is {overflow:.1f} mm too short for this plan (distal / proximal safety margins included)")
    return w


def plan_summary(plan, fibula):
    rows = []
    for g in plan["segments"]:
        rows.append(dict(segment=g["index"] + 1, length_mm=round(g["length_mm"], 1),
                         fibula_from_distal_tip_mm=round(g["fib_start"] - fibula.s_min, 1),
                         start_cut_angle_deg=round(g["angle_start_deg"], 1),
                         end_cut_angle_deg=round(g["angle_end_deg"], 1)))
    return dict(n_segments=plan["n_segments"], defect_arc_length_mm=round(plan["defect_arc_mm"], 1),
                max_graft_to_arch_deviation_mm=round(plan["max_deviation_mm"], 2),
                kerf_mm=plan["kerf"], fibula_length_sufficient=plan["fibula_fits"], plan_warnings=list(plan.get("warnings", [])),
                mandible_cut_points_mm=[[round(v, 1) for v in plan["points"][0]],
                                        [round(v, 1) for v in plan["points"][-1]]],
                segments=rows)
