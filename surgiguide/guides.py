"""Cutting guide generation by voxel CSG on an oriented local grid.

Every guide is: bone-hugging shell (offset by `clearance`, thickness `wall`, on one side of the bone
so it can be seated and removed) minus saw slots (kerf-compensated) minus screw holes, plus a rail
/ bridge that keeps the pieces between slots connected. A single marching cubes pass at the end
gives a watertight STL, so no fragile mesh booleans are needed.
"""
import numpy as np
from scipy import ndimage as ndi
from .meshing import LocalGrid


def _hole(local, p, d, r):
    v = local - p
    t = v @ d
    return (np.linalg.norm(v - t[..., None] * d, axis=-1) <= r) & (t > -2.0)


DROP_WARN_MM3 = 1.0            # a guide piece smaller than this is voxel dust; anything larger that is dropped is reported


def _slot_width(k, h):
    """Width of a saw slot on a grid of voxel size h: whole voxels, never narrower than the blade (kerf k). A slot of exactly
    k mm covers 3 or 4 voxels of 0.3 mm = 0.9 or 1.2 mm after meshing; 0.9 mm would jam a 1.0 mm blade."""
    return float(np.ceil(k / h - 1e-6) * h)


def _largest(name, g, h):
    """Keep the largest connected piece; report what (if anything) was dropped. A dropped piece of more than DROP_WARN_MM3
    is a guide part that is lost (a rail section, a screw collar, a shell island): rep['warning'] says so."""
    lab, n = ndi.label(g)
    if n > 1:
        sizes = ndi.sum(g, lab, range(1, n + 1))
        g = lab == (np.argmax(sizes) + 1)
        gone = np.sort(sizes)[:-1] * h ** 3
        dropped = float(gone.sum())
    else:
        dropped, gone = 0.0, np.zeros(0)
    rep = dict(name=name, pieces_before_cleanup=int(n), dropped_islands_mm3=round(dropped, 1))
    big = gone[gone > DROP_WARN_MM3]
    if len(big):
        rep["warning"] = (f"{name}: {len(big)} disconnected guide part(s) of {big.sum():.0f} mm3 in total ({big.max():.0f} mm3 at most) "
                          "were dropped (normally the strip over the wedge between two slots; if a rail, screw collar or shell part is missing in the STL, this is why)")
    return g, rep


def fibula_guide(vol, mask, fib, plan, h=0.3, clearance=0.3, wall=2.5, rail=3.0,
                 screw_d=2.2, margin=8.0):
    segs = plan["segments"]
    s0, s1 = segs[0]["fib_start"] - margin, segs[-1]["fib_end"] + margin
    R = fib.radius + clearance + wall + rail + 2
    grid = LocalGrid(fib.c, fib.axes, (s0 - 2, -R, -R), (s1 + 2, R, R), h)
    bone = grid.sample_mask(vol, mask)
    dout = ndi.distance_transform_edt(~bone) * h
    L = grid.local
    s, r2, r3 = L[..., 0], L[..., 1], L[..., 2]
    span = (s >= s0) & (s <= s1)
    shell = span & (dout > clearance) & (dout <= clearance + wall) & (r2 >= -0.5)
    top = span & (dout > clearance + wall - 0.5) & (dout <= clearance + wall + rail) & (np.abs(r3) <= 3) & (r2 > 0)
    guide = shell | top
    k = plan.get("slot_w", plan["kerf"])                                  # slot width (the blade when not set apart)
    sw = _slot_width(k, h)
    planes, faces = [], []
    for g in segs:
        for sp, n, sign in ((g["fib_start"], g["n_start_fib"], -1), (g["fib_end"], g["n_end_fib"], +1)):
            n = n / np.linalg.norm(n) * np.sign(n[0])
            p = np.array([sp, 0, 0]) + sign * (k / 2) * n                  # kerf falls outside the graft
            d = sign * ((L - [sp, 0, 0]) @ n)                              # distance from the graft face, > 0 outside the graft
            slot = (d >= 0) & (d <= sw) & (dout <= clearance + wall + 0.05)
            guide &= ~slot
            planes.append((p, n)); faces.append((np.array([sp, 0, 0]), n, sign))
    # screw holes (web/fibula.js autoScrews): two on a segment of STUMP_MIN mm or more, one on a shorter one, at least
    # three in all; each hole (45 deg about the axis) is kept SCREW_SLOT_GAP mm clear of every slot over the bone,
    # moved towards the segment middle when it is not, and dropped (reported) when no position is clear
    holes, dropped = fibula_screw_sites(segs, faces, sw, screw_d, fib.radius)
    d45 = np.array([0, np.cos(np.radians(45)), np.sin(np.radians(45))])
    for s in holes:
        guide &= ~_hole(L, np.array([s, 0, 0]), d45, screw_d / 2)
    guide, rep = _largest("fibula_guide", guide, h)
    rep["slot_mm"] = round(sw, 2); rep["screws"] = len(holes)
    if sw - plan["kerf"] > 0.3 + 1e-9:
        rep["slot_note"] = f"fibula_guide: the slot is {sw:.2f} mm on the {h} mm grid, {sw - plan['kerf']:.2f} mm wider than the {plan['kerf']:.2f} mm blade (at most 0.3 mm advised)"
    if dropped:
        rep["warning"] = (rep.get("warning", "") + (" " if rep.get("warning") else "")
                          + f"fibula_guide: no screw position clear of the slots on segment(s) {', '.join(str(i + 1) for i in dropped)}; place those screws by hand")
    return grid.mesh(guide), planes, rep


SCREW_SLOT_GAP = 2.0           # mm between a screw hole and a saw slot (web/app.js, web/fibula.js)
STUMP_MIN = 25.0               # mm: a segment this long gets two screws (surgiguide.plan.STUMP_MIN)


def fibula_screw_sites(segs, faces, slot_w, screw_d, radius):
    """Positions along the fibula axis of the guide screw holes: per segment 2 (length >= STUMP_MIN) or 1, at least 3
    in all (extra ones on the longest segments). A hole along the 45 deg direction through the axis point s is clear
    when, over the bone (|t| <= radius), it keeps slot/2 + screw_d/2 + SCREW_SLOT_GAP from every slot plane (centred
    slot_w/2 outside its graft face). Returns (positions, indices of segments with a screw that found no clear spot)."""
    want = [2 if g["length_mm"] >= STUMP_MIN else 1 for g in segs]
    while sum(want) < 3 and segs:
        i = max(range(len(segs)), key=lambda k: segs[k]["length_mm"] / (want[k] + 1))
        want[i] += 1
    d45 = np.array([0, np.cos(np.radians(45)), np.sin(np.radians(45))])
    ts = np.linspace(-radius, radius, 25)

    def clear(s):
        pts = np.array([s, 0, 0]) + ts[:, None] * d45
        for p0, n, sign in faces:
            c = p0 + sign * (slot_w / 2) * n
            if np.min(np.abs((pts - c) @ n)) < slot_w / 2 + screw_d / 2 + SCREW_SLOT_GAP:
                return False
        return True

    out, dropped = [], []
    for i, g in enumerate(segs):
        a, b = g["fib_start"], g["fib_end"]
        mid, L = (a + b) / 2, b - a
        goals = [mid] if want[i] == 1 else [a + L * (j + 0.5) / want[i] for j in range(want[i])]
        for s0 in goals:
            # nearest clear position to the goal, searched outwards in 0.5 mm steps inside the segment
            cand = sorted(np.arange(a + 2, b - 2 + 1e-9, 0.5), key=lambda s: abs(s - s0))
            got = next((s for s in cand if clear(s) and all(abs(s - q) >= screw_d + 4 for q in out)), None)
            if got is None:
                dropped.append(i)
            else:
                out.append(float(got))
    return out, sorted(set(dropped))


def mandible_guide(vol, mask, arch, plan, which, h=0.3, clearance=0.3, wall=2.5,
                   reach=16.0, flange=5.0, screw_d=2.2):
    """which = 0 (cut at s_a) or 1 (cut at s_b)."""
    P = plan["points"][0] if which == 0 else plan["points"][-1]
    T = plan["normals"][0] if which == 0 else plan["normals"][-1]
    s = plan["knots"][0] if which == 0 else plan["knots"][-1]
    keep = -T if which == 0 else T                                     # into retained bone
    b = arch.buccal(s, t=T)
    axes = np.stack([keep, b, np.cross(keep, b)], 1)
    grid = LocalGrid(P, axes, (-flange - 3, -16, -24), (reach + 3, 22, 24), h)
    bone = grid.sample_mask(vol, mask)
    dout = ndi.distance_transform_edt(~bone) * h
    L = grid.local
    u, v, w = L[..., 0], L[..., 1], L[..., 2]
    span = (u >= -flange) & (u <= reach)
    # the shell lies on the buccal face only where nothing is above it along the seating direction (+v): a shell voxel
    # with bone further out in its (u, w) column would wrap under the bone's widest level, the guide could not be lifted
    # off, and on a real jaw such voxels form islands (lingual side of the crest, under the inferior border) that only
    # get dropped. seen_out = bone anywhere at a larger v in the same column (axis 1 of the (w, v, u) arrays).
    outer = np.flip(np.cumsum(np.flip(bone, axis=1), axis=1), axis=1) > 0
    over = np.zeros_like(bone); over[:, :-1, :] = outer[:, 1:, :]
    shell = span & (dout > clearance) & (dout <= clearance + wall) & (v >= -0.5) & ~over
    k = plan.get("slot_w", plan["kerf"])                               # slot width (the blade when not set apart)
    sw = _slot_width(k, h)
    # where the slot lies relative to the planned plane (u = 0, the stump face): on the resected side (u in [-sw, 0], the
    # graft meets the stump flush) or centred on the plane (u in [-sw/2, sw/2], half the kerf lost from the stump);
    # the same setting as web/app.js kerfSide (plan["kerf_side"], default "resected")
    centred = plan.get("kerf_side", "resected") == "centre"
    u_slot = 0.0 if centred else -sw / 2                             # slot centre along u (u > 0 = kept bone)
    slot = (np.abs(u - u_slot) <= sw / 2 + 1e-9) & (dout <= clearance + wall + 0.05)
    wz = w[shell & (np.abs(u - u_slot) <= 4)]
    w_lo = wz.min() if wz.size else -10
    bridge = (np.abs(u - u_slot) <= 4) & (w <= w_lo + 4) & (dout > clearance + wall - 0.5) & \
             (dout <= clearance + wall + 2.5) & (v >= -0.5) & ~over
    guide = (shell & ~slot) | bridge
    for wz0 in (-6.0, 6.0):
        guide &= ~_hole(L, np.array([reach - 6, 0, wz0]), np.array([0, 1.0, 0]), screw_d / 2)
    plane = (P + u_slot * keep, keep)
    guide, rep = _largest(f"mandible_guide_{which}", guide, h)
    rep["kerf_side"] = "centre" if centred else "resected"
    rep["stump_gap_mm"] = round(float(k / 2 if centred else 0.0), 2)
    # can the guide be lifted off along the buccal normal (local axis 1) or a direction within 40 deg of it?
    rep["seat"] = seat_check(guide, bone, h, axis=1, clearance=clearance)
    if rep["seat"]["ok"] and rep["seat"]["free_directions"] == 0:
        rep["warning"] = (rep.get("warning", "") + (" " if rep.get("warning") else "")
                          + f"mandible_guide_{which}: cannot be lifted off the bone along any direction within 40 deg of the buccal normal "
                          f"(best direction still has {rep['seat']['best_block_mm2']:.0f} mm2 of bone over the guide); the shell reaches under "
                          "the bone's widest level (undercut): reduce the grid depth / reach or move the cut")
    elif rep["seat"]["ok"] and rep["seat"]["best_tilt_deg"] > 0:
        rep["note"] = (f"mandible_guide_{which}: seats only tilted ({rep['seat']['best_tilt_deg']:.0f} deg from the buccal normal, "
                       f"{rep['seat']['free_directions']}/{rep['seat']['directions']} directions free)")
    return grid.mesh(guide), plane, rep


def seat_check(guide, bone, h, axis=1, clearance=0.3, max_tilt=40, tilt_step=10, az_step=45, tol=None):
    """Can the guide be lifted off the bone? The same sweep as web/seat.js: for directions in a cone around the seating
    normal (+ local axis `axis`), guide and bone voxels are projected onto the plane normal to the direction in cells of
    2h; a cell is blocked when bone lies further along the direction than the guide's nearest voxel there (plus a
    tolerance of clearance + h). Masks are LocalGrid arrays indexed (z, y, x). Returns the number of free directions
    (< 2 mm2 blocked), the best direction and its blocked area (mm2)."""
    tol = clearance + h if tol is None else tol
    # (x, y, z) local mm on the even-index lattice (one voxel per 2h cell, as seat.js samples it): a finer sampling
    # would put a shell voxel and the bone voxel diagonally next to it into one projection cell and call it blocked
    gi = np.argwhere(guide[::2, ::2, ::2])[:, ::-1].astype(np.float64) * (2 * h)
    bi = np.argwhere(bone[::2, ::2, ::2])[:, ::-1].astype(np.float64) * (2 * h)
    if not len(gi) or not len(bi):
        return dict(ok=False, directions=0, free_directions=0, best_tilt_deg=0.0, best_block_mm2=0.0)
    n0 = np.zeros(3); n0[axis] = 1.0
    t = np.array([0, 0, 1.0]) if abs(n0[2]) < 0.9 else np.array([1.0, 0, 0])
    e1 = np.cross(t, n0); e1 /= np.linalg.norm(e1); e2 = np.cross(n0, e1)
    cell = 2 * h
    dirs = [(0, 0)] + [(tilt, az) for tilt in range(tilt_step, max_tilt + 1, tilt_step) for az in range(0, 360, az_step)]
    out = []
    for tilt, az in dirs:
        tr, ar = np.radians(tilt), np.radians(az)
        d = np.cos(tr) * n0 + np.sin(tr) * (np.cos(ar) * e1 + np.sin(ar) * e2)
        a = np.cross(d, [0, 0, 1.0]) if abs(d[2]) < 0.9 else np.cross(d, [1.0, 0, 0])
        a /= np.linalg.norm(a); b = np.cross(d, a)

        def key(pts):
            return np.round(pts @ a / cell).astype(np.int64) * 100003 + np.round(pts @ b / cell).astype(np.int64)
        kg, tg = key(gi), gi @ d
        order = np.argsort(kg, kind="stable")
        kg_s, tg_s = kg[order], tg[order]
        uniq, first = np.unique(kg_s, return_index=True)
        top = np.minimum.reduceat(tg_s, first)                       # nearest guide voxel per cell along d
        kb, tb = key(bi), bi @ d
        idx = np.searchsorted(uniq, kb)
        idx[idx >= len(uniq)] = 0
        hit = uniq[idx] == kb
        blocked = hit & (tb > top[idx] + tol)
        out.append((tilt, az, float(blocked.sum() * cell * cell)))
    free = [o for o in out if o[2] < 2.0]
    best = free[0] if free else min(out, key=lambda o: o[2])
    return dict(ok=True, directions=len(out), free_directions=len(free), best_tilt_deg=float(best[0]), best_azimuth_deg=float(best[1]),
                best_block_mm2=round(best[2], 1), blocked_mm2_along_normal=round(out[0][2], 1))


def fibula_segments(vol, mask, fib, plan, h=0.4):
    """Graft meshes in fibula position and transplanted into the mandible."""
    out_fib, out_mand = [], []
    R = fib.radius + 2
    for g in plan["segments"]:
        grid = LocalGrid(fib.c, fib.axes, (g["fib_start"] - R, -R, -R), (g["fib_end"] + R, R, R), h)
        bone = grid.sample_mask(vol, mask)
        L = grid.local
        n0, n1 = g["n_start_fib"], g["n_end_fib"]
        keep = bone & (((L - [g["fib_start"], 0, 0]) @ n0) * np.sign(n0[0]) >= 0) & \
                      (((L - [g["fib_end"], 0, 0]) @ n1) * np.sign(n1[0]) <= 0)
        out_fib.append(grid.mesh(keep))
        Rm, Ps, lo, s0 = g["R"], g["P_start"], grid.lo, g["fib_start"]
        to_mand = lambda v, Rm=Rm, Ps=Ps, lo=lo, s0=s0: Ps + ((v + lo) - [s0, 0, 0]) @ Rm.T
        out_mand.append(_mesh_with(grid, keep, to_mand))
    return out_fib, out_mand


def _mesh_with(grid, m, to_world):
    from .meshing import mask_to_mesh
    return mask_to_mesh(m, (grid.h,) * 3, to_world, sigma=0.5, smooth_iter=5)


def resected_mandible(vol, mask, arch, plan):
    """Mandible with the planned segment removed (voxel resolution)."""
    idx = np.argwhere(mask)
    q = vol.index_to_physical(idx[:, ::-1])
    s = arch.closest_s(q)
    (Pa, Pb), (Ta, Tb) = (plan["points"][0], plan["points"][-1]), (plan["normals"][0], plan["normals"][-1])
    sa, sb = plan["knots"][0], plan["knots"][-1]
    inside = ((q - Pa) @ Ta > 0) & ((q - Pb) @ Tb < 0) & (s > sa - 20) & (s < sb + 20)
    out = mask.copy()
    out[tuple(idx[inside].T)] = False
    removed = np.zeros_like(mask)
    removed[tuple(idx[inside].T)] = True
    return out, removed
