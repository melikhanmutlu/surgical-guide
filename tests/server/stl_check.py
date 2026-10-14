"""STL quality metrics for the server tests (ported from the Denetim 3 audit; no rtree/embree needed).

    python3 stl_check.py file1.stl [file2.stl ...]          # prints one JSON line per file

Metrics
  watertight / winding_consistent  trimesh after merging vertices by exact position (what a slicer sees)
  manifold_edges                   every undirected edge is shared by exactly two faces
  bodies                           connected components (face adjacency)
  volume_mm3                       signed volume (> 0 means outward normals)
  wall_p1 / wall_p5 / wall_med     inward ray thickness at random surface samples (mm): a ray from each sample
                                   along -normal to the first opposite surface. Rays near sharp edges give small
                                   values, so the 1st percentile is the "min wall" estimate, not the absolute min.
"""
import json
import sys

import numpy as np
import trimesh


def _first_hit(origins, dirs, tri, max_t=30.0):
    """Nearest positive ray/triangle hit per ray (Moller-Trumbore, AABB prefilter per ray)."""
    v0 = tri[:, 0]; e1 = tri[:, 1] - v0; e2 = tri[:, 2] - v0
    tmin_, tmax_ = tri.min(1), tri.max(1)
    out = np.full(len(origins), np.inf)
    for i, (o, d) in enumerate(zip(origins, dirs)):
        a, b = o, o + d * max_t
        lo, hi = np.minimum(a, b) - 1e-6, np.maximum(a, b) + 1e-6
        cand = np.nonzero(np.all((tmax_ >= lo) & (tmin_ <= hi), axis=1))[0]
        if not len(cand):
            continue
        E1, E2, V0 = e1[cand], e2[cand], v0[cand]
        h = np.cross(d, E2); det = np.einsum("ij,ij->i", E1, h)
        ok = np.abs(det) > 1e-12
        f = np.zeros_like(det); f[ok] = 1.0 / det[ok]
        s = o - V0; u = f * np.einsum("ij,ij->i", s, h)
        q = np.cross(s, E1); v = f * (q @ d); t = f * np.einsum("ij,ij->i", E2, q)
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-4)
        if hit.any():
            out[i] = t[hit].min()
    return out


def check(path_or_mesh, samples=1500, seed=0, wall=True):
    tm = path_or_mesh if isinstance(path_or_mesh, trimesh.Trimesh) else trimesh.load(path_or_mesh, file_type="stl")
    _, counts = np.unique(tm.edges_sorted, axis=0, return_counts=True)
    r = {
        "faces": int(len(tm.faces)),
        "vertices": int(len(tm.vertices)),
        "watertight": bool(tm.is_watertight),
        "winding_consistent": bool(tm.is_winding_consistent),
        "manifold_edges": bool(len(counts) and np.all(counts == 2)),
        "nonmanifold_edges": int(np.sum(counts != 2)),
        "bodies": int(tm.body_count),
        "volume_mm3": round(float(tm.volume), 2),
        "area_mm2": round(float(tm.area), 1),
        "bounds": np.round(tm.bounds, 2).tolist(),
    }
    if wall and len(tm.faces):
        rng = np.random.default_rng(seed)
        pts, fi = trimesh.sample.sample_surface(tm, samples, seed=int(rng.integers(1 << 31)))
        n = tm.face_normals[fi]
        th = _first_hit(pts - n * 1e-3, -n, tm.triangles)
        th = th[np.isfinite(th)]
        if len(th):
            r.update(wall_p1=round(float(np.percentile(th, 1)), 3), wall_p5=round(float(np.percentile(th, 5)), 3),
                     wall_med=round(float(np.median(th)), 3), wall_rays=int(len(th)))
    return r


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps({"file": p, **check(p)}), flush=True)
