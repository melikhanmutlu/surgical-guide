"""Production STL (yolmed_server.build_guide) against the browser preview (web/app.js buildGuide) on the same plan.

tests/preview_dump.mjs builds the preview in node for each case and writes the very request(s) the studio sends to
/guide; this test builds those requests with the server's geometry and compares the two meshes: volume, two-sided
surface distance (median, 95th percentile, maximum = Hausdorff), piece count, and that the server is watertight and
deterministic (same request -> same SHA-256). Synthetic bone and the built-in sample case only; a real series is
compared when --real <dicom folder> is given (nothing of it is stored in the repository).

    python3 tests/test_server_preview.py [--cases bar,sample,arc,arc_split2] [--real <dir> --cells body:L:45,angle:L:60]
                                         [--out <dir>] [--keep]

Expected differences (why the thresholds are not zero): the preview runs on a 0.4 mm grid over the 0.8 mm work volume
(its bone surface is the blurred work mask), the server on a 0.2 mm grid over the full-resolution voxel mask, so the two
bodies differ by a fraction of a millimetre over the bone-fitted surfaces and by up to a voxel or two where a silhouette
or the wrap line is quantised differently.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

THR = {"p95": 0.6, "max": 3.0, "vol": 0.15}      # mm, mm, relative (synthetic bone and the sample: measured 0.2-0.45 / 1-2.4 / 4-5 %)
# A real CT differs more, for reasons outside the guide design: the preview's bone is the 0.8 mm work mask (teeth and the
# alveolar crest merge into one blob, thin plates vanish), the server's the full-resolution threshold mask within the
# request's halo around the planning bone (so a body ends 1-2 mm later at a bone-component boundary). Measured on the
# anonymised mandible (body L 45, angle L 60): p95 0.8-1.2 mm, Hausdorff 4.7-4.9 mm, volume within 1.5 %.
THR_REAL = {"p95": 1.5, "max": 6.0, "vol": 0.15}


def load_stl(data):
    import trimesh
    return trimesh.load(io.BytesIO(data), file_type="stl")


def surface_points(mesh, per_mm2=60, seed=0):
    """Dense point cloud of a surface: its vertices plus uniform samples (deterministic)."""
    import trimesh
    n = int(max(20000, mesh.area * per_mm2))
    pts, _ = trimesh.sample.sample_surface(mesh, n, seed=seed)
    return np.vstack([np.asarray(mesh.vertices), pts])


def distances(a, b):
    """Distance from every point of a to the point set b (b dense enough that this approximates point-to-surface)."""
    from scipy.spatial import cKDTree
    d, _ = cKDTree(b).query(a, workers=-1)
    return d


def stats(d):
    return {"p50": float(np.percentile(d, 50)), "p95": float(np.percentile(d, 95)), "p99": float(np.percentile(d, 99)), "max": float(d.max())}


def compare(name, out, build):
    import trimesh
    meta = json.load(open(os.path.join(out, name + "_meta.json")))
    reqs = json.load(open(os.path.join(out, name + "_reqs.json")))
    preview = load_stl(open(os.path.join(out, name + "_preview.stl"), "rb").read())
    pieces, parts, info = [], [], []
    for k, req in enumerate(reqs):
        t = time.perf_counter()
        r1 = build(req)
        r2 = build(req)
        sha1, sha2 = hashlib.sha256(r1["stl_b64"].encode()).hexdigest(), hashlib.sha256(r2["stl_b64"].encode()).hexdigest()
        m = load_stl(base64.b64decode(r1["stl_b64"]))
        parts.append(m)
        info.append({"piece": k, "ms": r1["ms"], "faces": r1["faces"], "bodies": r1["bodies"], "pieces": r1["pieces"], "watertight": r1["watertight"], "manifold": r1["manifold"],
                     "deterministic": sha1 == sha2, "seat_dir": r1["seat_dir"], "screws": r1["screws"], "dropped_islands": r1["dropped_islands_mm2"], "grid": r1["grid"], "wall_s": round(time.perf_counter() - t, 1)})
        pieces.append(r1)
    server = trimesh.util.concatenate(parts) if len(parts) > 1 else parts[0]
    sp, pp = surface_points(server), surface_points(preview)
    d_ps, d_sp = distances(pp, sp), distances(sp, pp)            # preview -> server, server -> preview
    res = {
        "case": name, "split": meta["split"], "preview": {"volume": float(preview.volume), "faces": int(len(preview.faces)), "pieces": meta["pieces"], "seat": meta.get("seatDir") or [p["seatDir"] for p in meta["parts"] or []]},
        "server": {"volume": float(server.volume), "faces": int(len(server.faces)), "bodies": int(sum(i["bodies"] for i in info)), "watertight": all(i["watertight"] for i in info), "deterministic": all(i["deterministic"] for i in info), "seat": [i["seat_dir"] for i in info]},
        "vol_ratio": float(server.volume / preview.volume) if preview.volume else None,
        "preview_to_server_mm": stats(d_ps), "server_to_preview_mm": stats(d_sp),
        "hausdorff_mm": float(max(d_ps.max(), d_sp.max())), "pieces_info": info,
    }
    return res, meta


def verdict(res):
    bad = []
    thr = THR_REAL if res["case"].startswith("real_") else THR
    if not res["server"]["watertight"]:
        bad.append("not watertight")
    if not res["server"]["deterministic"]:
        bad.append("not deterministic")
    want = 2 if res["split"] else 1
    if res["server"]["bodies"] != want:
        bad.append(f"bodies {res['server']['bodies']} != {want}")
    if res["preview"]["pieces"] != want:
        bad.append(f"preview pieces {res['preview']['pieces']} != {want} (plan not comparable)")
    p95 = max(res["preview_to_server_mm"]["p95"], res["server_to_preview_mm"]["p95"])
    if p95 > thr["p95"]:
        bad.append(f"p95 {p95:.2f} > {thr['p95']}")
    if res["hausdorff_mm"] > thr["max"]:
        bad.append(f"hausdorff {res['hausdorff_mm']:.2f} > {thr['max']}")
    if res["vol_ratio"] is None or abs(res["vol_ratio"] - 1) > thr["vol"]:
        bad.append(f"volume ratio {res['vol_ratio']}")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", default="bar,sample,arc,arc_split2")
    ap.add_argument("--real", default=None, help="folder with one DICOM series (compared, never stored)")
    ap.add_argument("--cells", default="body:L:45,angle:L:60")
    ap.add_argument("--out", default=None); ap.add_argument("--keep", action="store_true")
    ap.add_argument("--skip-dump", action="store_true", help="reuse the dump already in --out")
    a = ap.parse_args()
    node = shutil.which("node")
    if not node:
        print("SKIP: node not found (the preview is built in node)"); return 0
    out = a.out or tempfile.mkdtemp(prefix="server_preview_")
    os.makedirs(out, exist_ok=True)
    if not a.skip_dump:
        cmd = [node, os.path.join(HERE, "preview_dump.mjs"), out, "--cases", a.cases]
        if a.real:
            cmd += ["--real", a.real, "--cells", a.cells]
        print("$ " + " ".join(cmd), flush=True)
        p = subprocess.run(cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=3600)
        print(p.stdout)
        if p.returncode != 0:
            print(f"FAIL: preview dump exited {p.returncode}"); return 1
    import yolmed_server
    names = [x for x in a.cases.split(",") if x] + ([f"real_{c.replace(':', '_')}" for c in a.cells.split(",") if c] if a.real else [])
    names = [n for n in names if os.path.exists(os.path.join(out, n + "_reqs.json"))]
    failed, table = 0, []
    for name in names:
        res, meta = compare(name, out, yolmed_server.build_guide)
        bad = verdict(res)
        json.dump(res, open(os.path.join(out, name + "_compare.json"), "w"), indent=1)
        a_, b_ = res["preview_to_server_mm"], res["server_to_preview_mm"]
        line = (f"{name:22s} split {res['split']}  vol preview {res['preview']['volume']:8.0f} server {res['server']['volume']:8.0f} mm3 ({res['vol_ratio']:.3f})  "
                f"preview->server p50 {a_['p50']:.2f} p95 {a_['p95']:.2f} max {a_['max']:.2f}  server->preview p50 {b_['p50']:.2f} p95 {b_['p95']:.2f} max {b_['max']:.2f}  "
                f"bodies {res['server']['bodies']} watertight {res['server']['watertight']} deterministic {res['server']['deterministic']} seat {res['preview']['seat']} / {res['server']['seat']}  "
                f"server {sum(i['ms'] for i in res['pieces_info'])} ms, {res['server']['faces']} faces")
        print(("OK   " if not bad else "FAIL ") + line + ("" if not bad else "  <- " + "; ".join(bad)), flush=True)
        table.append(line)
        failed += bool(bad)
    if not names:
        print("FAIL: no cases were dumped"); return 1
    print(f"{len(names) - failed} of {len(names)} cases within thresholds (synthetic: p95 <= {THR['p95']} mm, Hausdorff <= {THR['max']} mm; real CT: p95 <= {THR_REAL['p95']} mm, Hausdorff <= {THR_REAL['max']} mm; volume within {THR['vol'] * 100:.0f} %)")
    if a.keep or a.out:
        print("outputs:", out)
    else:
        shutil.rmtree(out, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
