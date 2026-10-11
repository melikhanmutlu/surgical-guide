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
    """Mandibular centreline from one condyle to the other, parametrised by arc length s (0 = midline, + = patient left):
    the body arch (the lowest body_height mm of the bone, polar bins around its centre) continued up each ramus (slab
    centroids of the lateral bone above the body band, posterior of the angle) to the top of the condyle. s_body = (s at
    the right angle, s at the left angle): between them the arch is the body, beyond them the rami (ramus_mm = their
    lengths), so a resection anywhere on the mandible (symphysis to condyle) is plannable."""

    def __init__(self, vol, mask, body_height=24.0, bin_deg=2.0, ramus=True):
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
        self.center = c
        self.s_body = (float(s[0]), float(s[-1]))
        self.ramus_mm = (0.0, 0.0)
        if ramus:
            right, left = self._ramus(P, pts[0], -1, z0 + body_height), self._ramus(P, pts[-1], +1, z0 + body_height)
            chain = right[::-1] + [pts] + left
            pts = np.concatenate([np.atleast_2d(q) for q in chain], 0)
            seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
            s2 = np.concatenate([[0], np.cumsum(seg)])
            s2 -= s2[len(right)]                                        # s unchanged on the body: s_body[0] at the right angle
            s = s2 + self.s_body[0]
            self.ramus_mm = (float(self.s_body[0] - s[0]), float(s[-1] - self.s_body[1]))
        self.s = np.arange(s.min(), s.max(), 0.5)
        self.pts = np.stack([np.interp(self.s, s, pts[:, i]) for i in range(3)], 1)

    @staticmethod
    def _ramus(P, angle_pt, side, z_from, slab=3.0, min_pts=12):
        """Centreline of one ramus as a list of points from the angle upwards: in slabs of `slab` mm above the body band,
        the centroid of the bone lateral of the midline (side * (x - angle x) > -12) and no more than 12 mm anterior of the
        angle (the alveolar process and the teeth of the body lie anterior); stops at the first empty slab (condyle top)."""
        out, z = [], z_from
        while z < P[:, 2].max():
            sel = (P[:, 2] >= z) & (P[:, 2] < z + slab) & (side * (P[:, 0] - angle_pt[0]) > -12) & (P[:, 1] > angle_pt[1] - 12)
            if sel.sum() < min_pts:
                break
            out.append(P[sel].mean(0)); z += slab
        if len(out) >= 3:
            out = list(ndi.gaussian_filter1d(np.array(out), 1.0, axis=0, mode="nearest"))
        return out

    def on_ramus(self, s):
        """True where s lies beyond the body (on a ramus)."""
        return (s < self.s_body[0] - 1e-6) | (s > self.s_body[1] + 1e-6)

    def point(self, s):
        return np.stack([np.interp(s, self.s, self.pts[:, i]) for i in range(3)], -1)

    def tangent(self, s, ds=2.0):
        return _unit(self.point(s + ds) - self.point(s - ds))

    def buccal(self, s, t=None):
        """Unit vector perpendicular to the arch, pointing outwards (buccal): horizontal on the body; on a ramus (tangent
        rising) the lateral direction away from the midline, made perpendicular to the tangent."""
        t = self.tangent(s) if t is None else t
        p = self.point(s)
        if abs(t[2]) < 0.6:
            n = _unit(np.cross(t, UP))
            if np.dot(n, p - self.center) < 0:
                n = -n
            return n
        lat = np.array([np.sign(p[0] - self.center[0]) or 1.0, 0.0, 0.0])
        n = lat - np.dot(lat, t) * t
        if np.linalg.norm(n) < 1e-6:
            n = np.cross(t, UP)
        return _unit(n)

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


KERF_SIDES = ("resected", "centre")      # where the mandible saw slot lies relative to the planned cut plane (web/app.js kerfSide 1 / 0)
STUMP_GAP_WARN = 1.0                     # mm per end (web/osteo.js LIM.gap)


def choose_segments(arch, s_a, s_b, tol_mm=2.5, min_len=20.0, max_n=4):
    """Segment count from the defect, the same rule as web/fibula.js segmentChoice: a defect shorter than one segment is
    one segment; otherwise the fewest segments that keep every segment >= min_len and follow the arch within tol_mm; if
    no count reaches the tolerance, the count with the smallest deviation among those that keep every segment >= min_len
    (fewer segments on a tie within 0.5 mm; a short segment is never traded for a smaller deviation).
    Returns (knots, dev, n, decision) with the table of candidates in `decision`."""
    arc = s_b - s_a
    table = []
    for n in range(1, max_n + 1):
        k, dev = optimise_segments(arch, s_a, s_b, n)
        lens = [float(np.linalg.norm(arch.point(b) - arch.point(a))) for a, b in zip(k[:-1], k[1:])]
        table.append(dict(n=n, knots=k, dev=float(dev), min_len=min(lens)))
        if min(lens) < min_len:                                      # more segments only get shorter
            break
    ok_len = [r for r in table if r["min_len"] >= min_len - 1e-9]
    if arc < min_len:
        pick, reason = table[0], "short"
    elif any(r["dev"] <= tol_mm for r in ok_len):
        pick, reason = next(r for r in ok_len if r["dev"] <= tol_mm), "dev"
    elif ok_len:
        pick = ok_len[0]
        for r in ok_len[1:]:
            if r["dev"] < pick["dev"] - 0.5:
                pick = r
        reason = "len"
    else:
        pick, reason = table[0], "short"
    decision = dict(reason=reason, n=pick["n"], candidates=[dict(n=r["n"], deviation_mm=round(r["dev"], 2), shortest_segment_mm=round(r["min_len"], 1)) for r in table])
    return pick["knots"], pick["dev"], pick["n"], decision


def make_plan(arch, fibula, s_a, s_b, n_segments=None, tol_mm=2.5, min_len=20.0,
              kerf=1.0, distal_margin=70.0, proximal_margin=60.0, roll_deg=0.0, kerf_side="resected"):
    """Return the plan dict. s_a < s_b are arch positions (mm from midline) of the two mandible cuts.
    kerf_side: "resected" = the slot lies on the resected side of the plane, the graft meets the stump flush (gap 0);
    "centre" = the slot is centred on the plane, half the kerf is lost from each stump (gap kerf / 2 per end)."""
    if kerf_side not in KERF_SIDES:
        raise ValueError(f"kerf_side must be one of {KERF_SIDES} (got {kerf_side!r})")
    if not (np.isfinite(s_a) and np.isfinite(s_b)) or s_b - s_a < 5.0:
        raise ValueError(f"resection range must be finite and at least 5 mm long (got {s_a} .. {s_b})")
    if s_a < arch.s[0] - 1e-6 or s_b > arch.s[-1] + 1e-6:
        body = getattr(arch, "s_body", (arch.s[0], arch.s[-1]))
        raise ValueError(f"resection {s_a:.1f} .. {s_b:.1f} mm lies outside the detected mandible ({arch.s[0]:.1f} .. {arch.s[-1]:.1f} mm "
                         f"from condyle to condyle; body {body[0]:.1f} .. {body[1]:.1f} mm)")
    decision = None
    if n_segments is None:                                           # automatic choice
        knots, dev, n_segments, decision = choose_segments(arch, s_a, s_b, tol_mm, min_len)
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
    stump_gap = 0.0 if kerf_side == "resected" else kerf / 2
    warnings = plan_warnings(segs, dev, n_segments, tol_mm, min_len, overflow, s_b - s_a, decision, stump_gap, kerf_side)
    return dict(knots=knots, points=P, normals=normals, segments=segs, max_deviation_mm=float(dev),
                n_segments=n_segments, kerf=kerf, kerf_side=kerf_side, stump_gap_mm=[stump_gap, stump_gap], segment_decision=decision,
                fibula_fits=bool(overflow <= 0),
                fibula_overflow_mm=float(max(0, overflow)), defect_arc_mm=float(s_b - s_a), warnings=warnings)


ANGLE_WARN = 35.0               # deg: a cut this oblique is hard to saw and to fit (web/fibula.js ANGLE_WARN)


def plan_warnings(segs, dev, n_segments, tol_mm, min_len, overflow, arc, decision=None, stump_gap=0.0, kerf_side="resected"):
    """What the plan does outside its own tolerances (web/fibula.js reports the same as critical): never silent."""
    w = []
    if dev > tol_mm:
        w.append(f"graft-to-arch deviation {dev:.2f} mm is above the {tol_mm:.1f} mm tolerance "
                 f"({n_segments} segment(s) for a {arc:.0f} mm defect); more or shorter segments follow the arch better")
    short_defect = decision is not None and decision["reason"] == "short" and n_segments == 1
    if short_defect:
        w.append(f"the defect ({arc:.1f} mm along the arch) is shorter than one {min_len:.0f} mm segment: one segment planned, it cannot be made longer")
    for g in segs:
        if g["length_mm"] < min_len and not short_defect:
            w.append(f"segment {g['index'] + 1} is {g['length_mm']:.1f} mm long, below the {min_len:.0f} mm a segment needs to keep its blood supply and fixation")
        a = max(g["angle_start_deg"], g["angle_end_deg"])
        if a > ANGLE_WARN:
            w.append(f"segment {g['index'] + 1}: a cut is {a:.0f} deg off the fibula axis (more than {ANGLE_WARN:.0f} deg)")
    if decision is not None and decision["reason"] == "len":
        w.append(f"segment count {n_segments} chosen for the smallest deviation among the counts that keep every segment >= {min_len:.0f} mm; no count reaches the {tol_mm:.1f} mm deviation target "
                 + "(" + ", ".join(f"{c['n']}: shortest {c['shortest_segment_mm']} mm, deviation {c['deviation_mm']} mm" for c in decision["candidates"]) + ")")
    if stump_gap > STUMP_GAP_WARN:
        w.append(f"graft-to-stump gap {stump_gap:.2f} mm per end (kerf {kerf_side}) is above {STUMP_GAP_WARN:.1f} mm")
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
                kerf_mm=plan["kerf"], kerf_side=plan.get("kerf_side", "resected"),
                graft_to_stump_gap_mm=[round(x, 2) for x in plan.get("stump_gap_mm", [0.0, 0.0])],
                segment_decision=plan.get("segment_decision"),
                fibula_length_sufficient=plan["fibula_fits"], plan_warnings=list(plan.get("warnings", [])),
                mandible_cut_points_mm=[[round(v, 1) for v in plan["points"][0]],
                                        [round(v, 1) for v in plan["points"][-1]]],
                segments=rows)
