"""Resection sweep over the Python pipeline (run_pipeline.py): the same region x length x side grid as the browser sweep,
expressed in the pipeline's own arch coordinate (--resect-from / --resect-to, mm from the midline, + = patient left).

    python3 pipeline_sweep.py --repo <SG_REPO> --out <dir> --datasets demo,real --mand-dir <series dir> --fib-dir <series dir>
        [--lengths 20,45,80] [--regions symphysis,...] [--sides L,R] [--timeout 900]

Per dataset the arch extent is measured once with the pipeline's own classes (segment.mandible_bone + plan.Arch) and cached
in <out>/arch_<dataset>.json; regions are placed on it the way sweep_page.js places them on the browser's arch model.
The ramus and the condyle lie outside the pipeline's arch band (it has no ramus model): those cells are run anyway and the
pipeline's answer is recorded. --side (donor leg) is set to the resection side. Outputs: <out>/runs/<id>.json and <out>/<id>/
(plan.json, log, previews of failing runs as jpg), <out>/tarama_pipe.csv. STL/GLB outputs are measured (trimesh) and deleted.
"""
import argparse
import csv
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REGIONS = ["symphysis", "parasymphysis", "body", "angle", "ramus", "condyle"]
COLS = ["dataset", "region", "side", "len", "id", "status", "rc", "seconds", "error", "resect_from", "resect_to", "arch_sMin", "arch_sMax", "in_arch",
        "n_segments", "seg_lens", "seg_min", "dev_mm", "angle_max", "fibula_fits", "mand_vol_cm3", "fib_len_mm", "fib_rad_mm",
        "guide_fib_watertight", "guide_fib_bodies", "guide_fib_vol_mm3", "guide_ma_watertight", "guide_ma_bodies", "guide_mb_watertight", "guide_mb_bodies", "guides_watertight_flag",
        "n_warnings", "warnings", "shots"]


def arch_extent(repo, dataset, mand_dir, cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    sys.path.insert(0, repo)
    from surgiguide import phantom, segment, plan as planning
    from surgiguide.volume import Volume
    t0 = time.time()
    vol = phantom.mandible_phantom() if dataset == "demo" else Volume.from_dicom_dir(mand_dir)
    mask, info = segment.mandible_bone(vol, hu=250.0)
    arch = planning.Arch(vol, mask)
    body = getattr(arch, "s_body", (float(arch.s[0]), float(arch.s[-1])))
    out = dict(sMin=float(arch.s[0]), sMax=float(arch.s[-1]), bodyMin=float(body[0]), bodyMax=float(body[1]),
               seg=dict((k, (float(v) if isinstance(v, (int, float)) else str(v))) for k, v in info.items()), seconds=time.time() - t0)
    json.dump(out, open(cache, "w"), indent=1)
    del vol, mask, arch
    return out


def cell(arch, region, side, length):
    """(s_a, s_b) of the resection and whether it lies inside the detected arch. The body regions sit on the body arch
    (bodyMin .. bodyMax, the angles; older arch files without a body extent: the whole arch); the ramus at 45 % of the
    way from the angle to the condyle, the condyle cell ends 2 mm below the arch end (open towards the condyle)."""
    sign = 1 if side == "L" else -1
    s_end = arch["sMax"] if sign > 0 else arch["sMin"]
    s_ang = arch.get("bodyMax" if sign > 0 else "bodyMin", s_end)
    half = abs(s_ang)
    if region == "condyle":
        b = s_end - sign * 2
        a, b = sorted([b, b - sign * length])
        return round(a, 1), round(b, 1), bool(a >= arch["sMin"] and b <= arch["sMax"])
    c = {"symphysis": sign * 4, "parasymphysis": sign * 0.30 * half, "body": sign * 0.62 * half, "angle": s_ang - sign * 6,
         "ramus": s_ang + 0.45 * (s_end - s_ang)}[region]
    a, b = sorted([c - length / 2, c + length / 2])
    return round(a, 1), round(b, 1), bool(a >= arch["sMin"] and b <= arch["sMax"])


def stl_info(path):
    if not os.path.exists(path):
        return None
    import trimesh
    m = trimesh.load(path, force="mesh")
    parts = m.split(only_watertight=False)
    return dict(watertight=bool(m.is_watertight), bodies=int(len(parts)) or 1, volume=float(abs(m.volume)) if m.is_watertight else None, faces=int(len(m.faces)))


def run_cell(a, dataset, region, side, length, arch):
    rid = f"{dataset}_{region}_{side}_{length}"
    jf = os.path.join(a.out, "runs", rid + ".json")
    if os.path.exists(jf) and not a.force:
        return json.load(open(jf))
    s_a, s_b, inside = cell(arch, region, side, length)
    rdir = os.path.join(a.out, rid)
    shutil.rmtree(rdir, ignore_errors=True); os.makedirs(rdir, exist_ok=True)
    cmd = [sys.executable, os.path.join(a.repo, "run_pipeline.py"), "--resect-from", str(s_a), "--resect-to", str(s_b), "--side", "left" if side == "L" else "right", "--out", rdir]
    cmd += ["--demo"] if dataset == "demo" else ["--mandible-dicom", a.mand_dir, "--fibula-dicom", a.fib_dir, "--segmenter", "threshold"]
    t0 = time.time()
    rec = dict(dataset=dataset, region=region, side=side, len=length, id=rid, resect_from=s_a, resect_to=s_b, arch_sMin=round(arch["sMin"], 1), arch_sMax=round(arch["sMax"], 1), in_arch=int(inside), cmd=" ".join(cmd))
    try:
        with open(os.path.join(rdir, "log.txt"), "w") as fh:
            p = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, cwd=a.repo, timeout=a.timeout, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1", MPLBACKEND="Agg"))
        rec["rc"] = p.returncode
    except subprocess.TimeoutExpired:
        rec["rc"] = -9; rec["error"] = f"timeout {a.timeout} s"
    rec["seconds"] = round(time.time() - t0, 1)
    log = open(os.path.join(rdir, "log.txt"), errors="replace").read()
    rec["log_tail"] = log[-1500:]
    warns = [l[len("WARNING: "):].strip() for l in log.splitlines() if l.startswith("WARNING: ")]
    if rec["rc"] != 0 and "error" not in rec:
        m = re.findall(r"^(\w+(?:Error|Exception)): (.*)$", log, re.M)
        rec["error"] = (m[-1][0] + ": " + m[-1][1]) if m else ("rc " + str(rec["rc"]) + ": " + log.strip().splitlines()[-1][:200] if log.strip() else "no output")
    pj = os.path.join(rdir, "plan.json")
    if os.path.exists(pj):
        plan = json.load(open(pj))
        rec["plan"] = plan
        segs = plan.get("segments", [])
        rec["n_segments"] = plan.get("n_segments"); rec["seg_lens"] = [s["length_mm"] for s in segs]
        rec["seg_min"] = min(rec["seg_lens"]) if segs else None
        rec["angle_max"] = max([max(s["start_cut_angle_deg"], s["end_cut_angle_deg"]) for s in segs]) if segs else None
        rec["dev_mm"] = plan.get("max_graft_to_arch_deviation_mm"); rec["fibula_fits"] = plan.get("fibula_length_sufficient")
        rec["guides_watertight_flag"] = plan.get("guides_watertight")
        warns = sorted(set(warns) | set(plan.get("warnings", [])) | set(plan.get("plan_warnings", [])))
    rec["warnings"] = warns; rec["n_warnings"] = len(warns)
    for k, v in (("mand_vol_cm3", r"mandible: \w+ \(([\d.]+) cm3"), ("fib_len_mm", r"fibula: \w+ \([\d.]+ cm3, length_mm (\d+)"), ("fib_rad_mm", r"radius_mm (\d+) mm")):
        m = re.search(v, log)
        if m:
            rec[k] = float(m.group(1))
    for key, name in (("guide_fib", "guide_fibula.stl"), ("guide_ma", "guide_mandible_a.stl"), ("guide_mb", "guide_mandible_b.stl")):
        try:
            rec[key] = stl_info(os.path.join(rdir, name))
        except Exception as e:
            rec[key] = dict(error=str(e)[:200])
    rec["status"] = "fail" if rec["rc"] != 0 else ("warn" if warns else "ok")
    # previews of failing / warning runs as jpg; big outputs go
    rec["shots"] = []
    if rec["status"] != "ok":
        try:
            from PIL import Image
            for png, tag in (("2_mandible_guides.png", "mand"), ("3_fibula_guide.png", "fib"), ("1_plan_mandible.png", "plan")):
                src = os.path.join(rdir, png)
                if os.path.exists(src):
                    dst = os.path.join(a.out, "ekran", f"{rid}_{tag}.jpg"); os.makedirs(os.path.dirname(dst), exist_ok=True)
                    Image.open(src).convert("RGB").save(dst, quality=60); rec["shots"].append(os.path.basename(dst))
        except Exception as e:
            rec["shot_error"] = str(e)[:200]
    for f in glob.glob(os.path.join(rdir, "*")):
        if not f.endswith(("plan.json", "log.txt")):
            (shutil.rmtree if os.path.isdir(f) else os.remove)(f)
    json.dump(rec, open(jf, "w"), indent=1)
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=os.environ.get("SG_REPO", os.path.abspath(os.path.join(HERE, "..", ".."))))
    ap.add_argument("--out", required=True); ap.add_argument("--datasets", default="demo,real")
    ap.add_argument("--mand-dir", default=os.environ.get("MAND_DIR")); ap.add_argument("--fib-dir", default=os.environ.get("FIB_DIR"))
    ap.add_argument("--lengths", default="20,45,80"); ap.add_argument("--regions", default=",".join(REGIONS)); ap.add_argument("--sides", default="L,R")
    ap.add_argument("--timeout", type=int, default=900); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    os.makedirs(os.path.join(a.out, "runs"), exist_ok=True)
    lengths = [int(x) for x in a.lengths.split(",") if x]; regions = [x for x in a.regions.split(",") if x]; sides = [x for x in a.sides.split(",") if x]
    rows = []
    for dataset in a.datasets.split(","):
        if not dataset:
            continue
        if dataset == "real" and not (a.mand_dir and os.path.isdir(a.mand_dir) and a.fib_dir and os.path.isdir(a.fib_dir)):
            print("real dataset skipped: --mand-dir / --fib-dir missing", flush=True); continue
        print(f"[{dataset}] arch extent", flush=True)
        arch = arch_extent(a.repo, dataset, a.mand_dir, os.path.join(a.out, f"arch_{dataset}.json"))
        print(f"  arch s = {arch['sMin']:.1f} .. {arch['sMax']:.1f} mm ({arch.get('seconds', 0):.0f} s)", flush=True)
        for region in regions:
            for length in lengths:
                for side in sides:
                    rec = run_cell(a, dataset, region, side, length, arch)
                    rows.append(rec)
                    print(f"  {rec['id']}: {rec['status']} rc={rec.get('rc')} {rec.get('seconds')}s n={rec.get('n_segments')} segs={rec.get('seg_lens')} warn={rec.get('n_warnings')} {rec.get('error', '')[:120]}", flush=True)
    with open(os.path.join(a.out, "tarama_pipe.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            flat = dict(r)
            for key in ("guide_fib", "guide_ma", "guide_mb"):
                g = r.get(key) or {}
                flat[key + "_watertight"] = "" if not g or "error" in g else int(g["watertight"]); flat[key + "_bodies"] = g.get("bodies", "")
                if key == "guide_fib":
                    flat["guide_fib_vol_mm3"] = round(g["volume"]) if g.get("volume") else ""
            flat["warnings"] = " | ".join(r.get("warnings", [])); flat["shots"] = " ".join(r.get("shots", [])); flat["seg_lens"] = json.dumps(r.get("seg_lens"))
            w.writerow(flat)
    print("done ->", a.out, flush=True)


if __name__ == "__main__":
    main()
