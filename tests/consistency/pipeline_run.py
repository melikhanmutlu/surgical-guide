"""Dataset 2: the Python pipeline (run_pipeline.py --demo). Runs it N times (repeatability), rebuilds the plan in
process (to get the planes, which plan.json does not store) and measures its guides with the same metrics as the
browser guides.
    python3 pipeline_run.py [--repo <checkout>] --out <dir> [--reps 5] [--segments N] [--tag name]"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gmetrics as gm  # noqa: E402


class ArrCrop(gm.Crop):
    def __init__(self, arr_zyx, sp, origin, direction, lo, hi):
        self.sp = np.asarray(sp, float)
        self.axes = np.asarray(direction, float).reshape(3, 3).T          # rows = i, j, k unit vectors
        lo = np.maximum(np.asarray(lo, int), 0); hi = np.minimum(np.asarray(hi, int), np.array(arr_zyx.shape[::-1]) - 1)
        self.origin = np.asarray(origin, float) + (lo * self.sp) @ self.axes
        self.a = arr_zyx[lo[2]:hi[2] + 1, lo[1]:hi[1] + 1, lo[0]:hi[0] + 1].astype(np.float32)
        self.dims = list(self.a.shape[::-1])


def refs_for(vol, mask, bbox, thr, pad=8):
    lo = np.floor(vol.physical_to_index(bbox[0] - pad)).astype(int); hi = np.ceil(vol.physical_to_index(bbox[1] + pad)).astype(int)
    lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
    hu = ArrCrop(vol.array, vol.spacing, vol.origin, vol.direction, lo, hi)
    mk = ArrCrop(mask.astype(np.float32), vol.spacing, vol.origin, vol.direction, lo, hi)
    from scipy import ndimage as ndi
    near = ndi.binary_dilation(mk.a > 0.5, iterations=1)
    ct = gm.Bone(hu, float(thr), np.where(near, hu.a, -1024.0).astype(np.float32), -1024.0, name="ct")
    app = gm.Bone(mk, 0.5, None, 0.0, name="app")
    return {"ct": ct, "app": app}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def run_once(repo, out, extra):
    os.makedirs(out, exist_ok=True)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    t0 = time.time()
    p = subprocess.run([sys.executable, "run_pipeline.py", "--demo", "--out", out] + extra, cwd=repo, env=env, capture_output=True, text=True)
    open(os.path.join(out, "pipeline.log"), "w").write(p.stdout + "\n" + p.stderr)
    return p.returncode, time.time() - t0


def measure(repo, out, extra_args):
    """rebuild the plan in process with the same arguments and measure the STL files the run wrote."""
    sys.path.insert(0, repo)
    from surgiguide.volume import Volume
    from surgiguide import segment, plan as planning, guides
    a = dict(hu=250.0, fibula_component=2, resect_from=-15.0, resect_to=40.0, segments=None, side="right", kerf=1.0, clearance=0.3, wall=2.5)
    it = iter(extra_args)
    for k in it:
        a[k.lstrip("-").replace("-", "_")] = type(a.get(k.lstrip("-").replace("-", "_"), 0.0) or 0.0)(next(it)) if k != "--side" else next(it)
    if a["segments"] is not None:
        a["segments"] = int(a["segments"])
    vm, vf = Volume.from_dicom_dir(os.path.join(out, "dicom_head")), Volume.from_dicom_dir(os.path.join(out, "dicom_leg"))
    mm = segment.threshold_bone(vm, hu=a["hu"], component=1)
    fm = segment.threshold_bone(vf, hu=a["hu"], component=int(a["fibula_component"]))
    arch = planning.Arch(vm, mm)
    fib = planning.Fibula(vf, fm, side=a["side"])
    p = planning.make_plan(arch, fib, a["resect_from"], a["resect_to"], n_segments=a["segments"], kerf=a["kerf"])
    fg, fplanes, frep = guides.fibula_guide(vf, fm, fib, p, clearance=a["clearance"], wall=a["wall"])
    mg = [guides.mandible_guide(vm, mm, arch, p, w, clearance=a["clearance"], wall=a["wall"]) for w in (0, 1)]
    k = p["kerf"]
    res = dict(plan_summary=planning.plan_summary(p, fib), args=a)
    # regenerated vs written STL (same process inputs -> should be identical)
    regen = {}
    for name, m in (("guide_fibula.stl", fg), ("guide_mandible_a.stl", mg[0][0]), ("guide_mandible_b.stl", mg[1][0])):
        f = gm.GuideMesh(os.path.join(out, name))
        regen[name] = dict(vol_file=f.quality["volume"], vol_regen=float(abs(m.volume)), faces_file=f.quality["faces"], faces_regen=int(len(m.faces)))
    res["regen_vs_file"] = regen
    guides_out = {}
    # mandible guides: frame u = into retained bone, n = buccal (the shell side), slot on the resected side of the cut
    for w, (m, plane, rep) in enumerate(mg):
        P = p["points"][0] if w == 0 else p["points"][-1]
        T = p["normals"][0] if w == 0 else p["normals"][-1]
        s = p["knots"][0] if w == 0 else p["knots"][-1]
        keep = -T if w == 0 else T
        b = arch.buccal(s, t=T)
        frame = dict(P=P.tolist(), u=keep.tolist(), v=np.cross(keep, b).tolist(), n=b.tolist())
        # the slot as the pipeline cuts it: rep["slot_mm"] wide (the blade rounded up to whole voxels, guides._slot_width),
        # on the resected side of the plane (u in [-sw, 0]) or centred on it (kerf_side "centre")
        sw = float(rep.get("slot_mm") or k)
        u_slot = 0.0 if rep.get("kerf_side") == "centre" else -sw / 2
        planes = [dict(p=(P + u_slot * keep).tolist(), N=keep.tolist(), w=sw, plane=P.tolist(), shift=u_slot)]
        stump = dict(p=P.tolist(), N=keep.tolist())
        # holes: (reach-6, 0, +-6) in (keep, b, keep x b) along +b; a 10 mm screw drilled along -b
        ax = np.stack([keep, b, np.cross(keep, b)], 1)
        holes = []
        for wz in (-6.0, 6.0):
            c = P + ax @ np.array([16.0 - 6, 0, wz])
            holes.append(dict(c=c, d=-b))
        guides_out[f"mandible_{'ab'[w]}"] = dict(path=os.path.join(out, f"guide_mandible_{'ab'[w]}.stl"), vol=vm, mask=mm, frame=frame, planes=planes, holes=holes, stump=stump, rep=rep)
    # fibula guide: frame u = fibula axis, n = lateral (shell side)
    A = fib.axes
    # guides.fibula_guide returns each plane k/2 outside its graft face; the slot it cuts is sw = rep["slot_mm"] wide,
    # from the face outwards (centre sw/2 outside the face). Start faces (even index) open towards -n, end faces towards +n.
    fsw = float(frep.get("slot_mm") or k)
    fplanes_w = []
    for i, (pp, nn) in enumerate(fplanes):
        sign = -1 if i % 2 == 0 else 1
        face = pp - sign * (k / 2) * nn
        fplanes_w.append(dict(p=(fib.c + A @ (face + sign * (fsw / 2) * nn)).tolist(), N=(A @ nn).tolist(), w=fsw, plane=(fib.c + A @ face).tolist(), shift=sign * fsw / 2))
    # screw holes where the pipeline drills them: guides.fibula_screw_sites (clear of the slots), 45 deg about the axis
    faces = []
    for g in p["segments"]:
        for sp_, n_, sign in ((g["fib_start"], g["n_start_fib"], -1), (g["fib_end"], g["n_end_fib"], 1)):
            n_ = n_ / np.linalg.norm(n_) * np.sign(n_[0]); faces.append((np.array([sp_, 0, 0]), n_, sign))
    sites, _ = guides.fibula_screw_sites(p["segments"], faces, fsw, 2.2, fib.radius)
    dl = np.array([0, np.cos(np.radians(45)), np.sin(np.radians(45))])
    holes = [dict(c=fib.c + A @ np.array([s_, 0, 0]), d=-(A @ dl)) for s_ in sites]
    guides_out["fibula"] = dict(path=os.path.join(out, "guide_fibula.stl"), vol=vf, mask=fm, frame=dict(P=fib.c.tolist(), u=A[:, 0].tolist(), v=A[:, 2].tolist(), n=A[:, 1].tolist()), planes=fplanes_w, holes=holes, rep=frep)
    for name, gd in guides_out.items():
        G = gm.GuideMesh(gd["path"])
        refs = refs_for(gd["vol"], gd["mask"], (G.pts.min(0), G.pts.max(0)), a["hu"])
        r = dict(quality=G.quality, cleanup=gd["rep"], fit={})
        for bname in ("ct", "app"):
            r["fit"][bname] = gm.fit_metrics(G, refs[bname], a["clearance"], a["wall"])
        r["seat_ct"] = gm.seat_metrics(G, refs["ct"], gd["frame"], r["fit"]["ct"]["_sd"])
        r["slots"] = gm.slot_metrics(G, refs["ct"], gd["planes"], a["clearance"], a["wall"])
        r["wall"] = gm.wall_metrics(G, a["wall"], r["fit"]["ct"]["_inner"] | r["fit"]["app"]["_inner"], [])
        # holes: entry where the hole axis meets bone coming from outside, then 10 mm of screw
        hs = []
        for h in gd["holes"]:
            c, d = np.asarray(h["c"]), np.asarray(h["d"]) / np.linalg.norm(h["d"])
            ts = np.arange(-30, 5, 0.1)
            inside = refs["ct"].inside(c[None] + ts[:, None] * d)
            first = np.flatnonzero(inside)
            if not first.size:
                hs.append(dict(entry=None)); continue
            e = c + ts[first[0]] * d
            sc = dict(entry=e.tolist(), dir=d.tolist(), sc=dict(len=10.0, d=2.2, D=2.2 + 0.01, sleeveH=0.0))
            hm = gm.screw_metrics(G, refs["ct"], [sc], gd["planes"], a["clearance"], a["wall"])[0]
            hs.append({k2: v for k2, v in hm.items() if k2 not in ("sleeve_material_frac",)})
        r["holes"] = hs
        guides_out[name]["metrics"] = r
    res["guides"] = {k2: v["metrics"] for k2, v in guides_out.items()}
    # fibula <-> mandible: segment lengths, slot inner faces on the fibula guide vs the segment ends (fibula frame)
    segs = p["segments"]
    G = gm.GuideMesh(guides_out["fibula"]["path"])
    rows = []
    sys.path.insert(0, HERE)
    from analyze_run import slot_walls, ang
    for i, g in enumerate(segs):
        for end, sp_, nl, sign in (("start", g["fib_start"], g["n_start_fib"], -1), ("end", g["fib_end"], g["n_end_fib"], 1)):
            nl = nl / np.linalg.norm(nl) * np.sign(nl[0])
            pl = fplanes_w[2 * i + (0 if end == "start" else 1)]
            walls = slot_walls(G, np.asarray(pl["p"]), np.asarray(pl["N"]), fsw)
            inner = walls.get("pos" if -pl["shift"] > 0 else "neg")   # the wall on the graft face, -shift from the slot centre
            r = dict(seg=i, end=end, w_planned=fsw)
            if inner:
                want = -pl["shift"]
                r.update(inner_offset_err_mm=inner["offset"] - want, inner_angle_deg=inner["angle_deg"],
                         width=(walls["pos"]["offset"] - walls["neg"]["offset"]) if walls.get("pos") and walls.get("neg") else None)
                # carry to the mandible: fibula local -> mandible = P_start + (local - [s0,0,0]) @ R.T
                loc = (inner["centroid"] - fib.c) @ A
                cm = g["P_start"] + (loc - np.array([g["fib_start"], 0, 0])) @ g["R"].T
                nm = g["R"] @ (A.T @ inner["normal"])
                tgt_p = g["P_start"] if end == "start" else g["P_end"]
                tgt_n = p["normals"][i] if end == "start" else p["normals"][i + 1]
                r.update(mand_angle_deg=ang(nm, tgt_n), mand_offset_mm=float((cm - tgt_p) @ tgt_n))
            rows.append(r)
    th = np.linspace(0, 2 * np.pi, 72, endpoint=False)

    def s_at(s_axis, nl):
        nl = nl / np.linalg.norm(nl)
        return s_axis - fib.radius * (np.cos(th) * nl[1] + np.sin(th) * nl[2]) / nl[0]
    gaps = [float(((s_at(segs[i + 1]["fib_start"], segs[i + 1]["n_start_fib"]) - k) - (s_at(segs[i]["fib_end"], segs[i]["n_end_fib"]) + k)).min()) for i in range(len(segs) - 1)]
    vz = (vf.origin[2], vf.origin[2] + vf.spacing[2] * (vf.array.shape[0] - 1))
    ends = [fib.to_world([fib.s_min, 0, 0]), fib.to_world([fib.s_max, 0, 0])]
    res["fib_match"] = dict(n=len(segs), lengths=[g["length_mm"] for g in segs], chords=[float(np.linalg.norm(g["P_end"] - g["P_start"])) for g in segs],
                            fib_slots=rows, fib_min_gap_between_segments_mm=min(gaps) if gaps else None,
                            distal_margin_mm=float((s_at(segs[0]["fib_start"], segs[0]["n_start_fib"]) - k).min() - fib.s_min),
                            proximal_margin_mm=float(fib.s_max - (s_at(segs[-1]["fib_end"], segs[-1]["n_end_fib"]) + k).max()),
                            fibula_fits=p["fibula_fits"], stump_gap_mm=0.0,
                            fibula_touches_scan_end=bool(min(abs(e[2] - z) for e in ends for z in vz) < 4.0),
                            wedge=[dict(joint=i + 1, wedge_fib_deg=ang(segs[i]["n_end_fib"], segs[i + 1]["n_start_fib"]),
                                        bend_mand_deg=ang(segs[i]["P_end"] - segs[i]["P_start"], segs[i + 1]["P_end"] - segs[i + 1]["P_start"])) for i in range(len(segs) - 1)])
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(HERE))); ap.add_argument("--out", required=True)
    ap.add_argument("--reps", type=int, default=1); ap.add_argument("--extra", default="", help="extra run_pipeline args, e.g. '--segments 3'")
    ap.add_argument("--measure-only", action="store_true")
    a = ap.parse_args()
    a.out = os.path.abspath(a.out)   # run_pipeline runs with cwd = repo: a relative --out would land inside the repo
    extra = a.extra.split() if a.extra else []
    summary = dict(extra=extra, runs=[])
    for i in range(1, a.reps + 1):
        d = os.path.join(a.out, f"r{i}")
        if not a.measure_only:
            rc, sec = run_once(a.repo, d, extra)
        else:
            rc, sec = 0, None
        stl = {f: sha(os.path.join(d, f)) for f in sorted(os.listdir(d)) if f.endswith(".stl")}
        plan = json.load(open(os.path.join(d, "plan.json"))) if os.path.exists(os.path.join(d, "plan.json")) else None
        summary["runs"].append(dict(dir=d, rc=rc, seconds=sec, sha=stl, plan=plan))
        print("run", i, rc, sec, flush=True)
    r1 = summary["runs"][0]["dir"]
    # repeatability across runs
    if a.reps > 1:
        rep = {}
        for f in ("guide_fibula.stl", "guide_mandible_a.stl", "guide_mandible_b.stl"):
            G1 = gm.GuideMesh(os.path.join(r1, f))
            rows = []
            for r in summary["runs"][1:]:
                Gk = gm.GuideMesh(os.path.join(r["dir"], f))
                rows.append(dict(identical_bytes=r["sha"][f] == summary["runs"][0]["sha"][f], **gm.hausdorff(Gk, G1)))
            rep[f] = rows
        rep["plan_identical"] = all(r["plan"] == summary["runs"][0]["plan"] for r in summary["runs"])
        summary["repeat"] = rep
    summary["metrics"] = measure(a.repo, r1, extra)
    with open(os.path.join(a.out, "pipeline_metrics.json"), "w") as fh:
        json.dump(gm.strip(summary), fh, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    print("ok")
