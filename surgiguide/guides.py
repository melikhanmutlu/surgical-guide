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


def _largest(name, g, h):
    """Keep the largest connected piece; report what (if anything) was dropped."""
    lab, n = ndi.label(g)
    if n > 1:
        sizes = ndi.sum(g, lab, range(1, n + 1))
        g = lab == (np.argmax(sizes) + 1)
        dropped = float((sizes.sum() - sizes.max()) * h ** 3)
    else:
        dropped = 0.0
    return g, dict(name=name, pieces_before_cleanup=int(n), dropped_islands_mm3=round(dropped, 1))


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
    k = plan["kerf"]
    planes = []
    for g in segs:
        for sp, n, sign in ((g["fib_start"], g["n_start_fib"], -1), (g["fib_end"], g["n_end_fib"], +1)):
            n = n / np.linalg.norm(n) * np.sign(n[0])
            p = np.array([sp, 0, 0]) + sign * (k / 2) * n                  # kerf falls outside the graft
            slot = (np.abs((L - p) @ n) <= k / 2) & (dout <= clearance + wall + 0.05)
            guide &= ~slot
            planes.append((p, n))
        mid = (g["fib_start"] + g["fib_end"]) / 2
        d = np.array([0, np.cos(np.radians(45)), np.sin(np.radians(45))])
        guide &= ~_hole(L, np.array([mid, 0, 0]), d, screw_d / 2)
    guide, rep = _largest("fibula_guide", guide, h)
    return grid.mesh(guide), planes, rep


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
    shell = span & (dout > clearance) & (dout <= clearance + wall) & (v >= -0.5)
    k = plan["kerf"]
    slot = (np.abs(u + k / 2) <= k / 2) & (dout <= clearance + wall + 0.05)  # kerf on resected side
    wz = w[shell & (np.abs(u + k / 2) <= 4)]
    w_lo = wz.min() if wz.size else -10
    bridge = (np.abs(u + k / 2) <= 4) & (w <= w_lo + 4) & (dout > clearance + wall - 0.5) & \
             (dout <= clearance + wall + 2.5) & (v >= -0.5)
    guide = (shell & ~slot) | bridge
    for wz0 in (-6.0, 6.0):
        guide &= ~_hole(L, np.array([reach - 6, 0, wz0]), np.array([0, 1.0, 0]), screw_d / 2)
    plane = (P - (k / 2) * keep, keep)
    guide, rep = _largest(f"mandible_guide_{which}", guide, h)
    return grid.mesh(guide), plane, rep


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
