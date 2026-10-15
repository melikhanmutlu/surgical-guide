"""Full metric set for one browser run directory (written by driver.mjs) -> <run>/metrics.json (+ section images).
    python3 analyze_run.py <run_dir> [--quick] [--img <dir>]"""
import argparse
import json
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gmetrics as gm  # noqa: E402


def ang(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = abs(a @ b) / np.linalg.norm(a) / np.linalg.norm(b)
    return float(np.degrees(np.arccos(min(1.0, c))))


def guide_block(run, gd, pre, thr, frame, planes, screws, g, resection, img_dir=None, label=""):
    """all metrics for one guide (mandible 'm' or fibula 'f'): preview and server variants."""
    clear, wall = float(g["clear"]) + float(g.get("peri") or 0), float(g["wall"])
    out = dict(clear=clear, wall=wall)
    refs = gm.bone_refs(run, gd, thr)
    variants = {"preview": os.path.join(run, f"{pre}_guide_preview.stl")}
    if gd.get("server") and gd["server"].get("ok"):
        variants["server"] = os.path.join(run, f"{pre}_guide_server.stl")
        out["server_reply"] = {k: v for k, v in gd["server"].items() if k != "stl"}
    elif gd.get("server"):
        out["server_reply"] = gd["server"]
    meshes = {}
    for name, path in variants.items():
        G = gm.GuideMesh(path)
        meshes[name] = G
        r = dict(quality=G.quality)
        r["fit"] = {}
        for b in ("ct", "app"):
            f = gm.fit_metrics(G, refs[b], clear, wall)
            r["fit"][b] = f
        sd = r["fit"]["ct"]["_sd"]
        r["seat_ct"] = gm.seat_metrics(G, refs["ct"], frame, sd)
        r["slots"] = gm.slot_metrics(G, refs["ct"], planes, clear, wall)
        r["wall"] = gm.wall_metrics(G, wall, r["fit"]["ct"]["_inner"] | r["fit"]["app"]["_inner"], screws)
        # screw path vs the segmented bone (app field: cortex + marrow); the HU-threshold surface misses cancellous
        # bone below the threshold (sample at 350 HU: marrow ~330-350 HU), so it is kept only for information
        r["screws"] = gm.screw_metrics(G, refs["app"], screws, planes, clear, wall, resection)
        r["screws_ct"] = gm.screw_metrics(G, refs["ct"], screws, planes, clear, wall, resection)
        out[name] = r
    if "server" in meshes:
        out["preview_vs_server"] = gm.hausdorff(meshes["preview"], meshes["server"])
    if img_dir:
        try:
            section_images(meshes, refs, frame, planes, img_dir, label)
        except Exception as e:  # images are evidence only
            out["img_error"] = repr(e)
    return out, meshes, refs


def section_images(meshes, refs, frame, planes, img_dir, label):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    os.makedirs(img_dir, exist_ok=True)
    P, u, v, n = (np.asarray(frame[k], float) for k in ("P", "u", "v", "n"))
    cuts = [("u0", P, u, v, n)]
    # one section across the guide body between the anchor and the first cut, one through the first slot along it
    if planes:
        p0 = np.asarray(planes[0]["p"], float)
        mid = P + 0.5 * ((p0 - P) @ u) * u
        cuts = [("body", mid, u, v, n), ("slot1", p0 + 3 * v * 0, v, u, n)]
    cols = {"preview": "#2a9d8f", "server": "#3c82dc"}
    for name, o, N, e1, e2 in cuts:
        fig, ax = plt.subplots(figsize=(6.4, 5.2), dpi=130)
        for b, c, ls in (("ct", "#7a5c00", "-"), ("app", "#c08a00", "--")):
            sec = refs[b].mesh.section(plane_origin=o, plane_normal=N)
            if sec is not None:
                for ent in sec.discrete:
                    q = ent - o
                    ax.plot(q @ e1, q @ e2, ls, color=c, lw=1.0, label=f"kemik ({b})")
        for k, G in meshes.items():
            sec = G.am.section(plane_origin=o, plane_normal=N)
            if sec is not None:
                for ent in sec.discrete:
                    q = ent - o
                    ax.plot(q @ e1, q @ e2, "-", color=cols.get(k, "k"), lw=1.0, label=f"guide {k}")
        h, l_ = ax.get_legend_handles_labels()
        uniq = dict(zip(l_, h))
        ax.legend(uniq.values(), uniq.keys(), fontsize=7, loc="best")
        ax.set_aspect("equal"); ax.set_title(f"{label} kesit: {name}", fontsize=9); ax.grid(alpha=0.3)
        ax.set_xlabel("mm"); ax.set_ylabel("mm (oturma normali)")
        fig.tight_layout(); fig.savefig(os.path.join(img_dir, f"{label}_{name}.png")); plt.close(fig)


def fib_match(d, fblk_meshes=None):
    """fibula segments <-> mandible defect: transplanted cut planes, lengths, wedge, overlap, margins, slot faces."""
    f = d["fib"]
    if not f.get("segs"):
        return {"error": "no segment plan"}
    F = f["F"]
    a, e2, e3 = (np.asarray(x, float) for x in F["FA"])
    FC = np.asarray(F["FC"], float)
    FR, smin, smax = F["FR"], F["smin"], F["smax"]
    kerf = float(f["plan"]["kerf"])
    toFib = lambda s, y, z: FC + a * s + e2 * y + e3 * z
    dirFib = lambda v: (a * v[0] + e2 * v[1] + e3 * v[2]) / np.linalg.norm(a * v[0] + e2 * v[1] + e3 * v[2])
    D = f["D"]
    A, B = D["A"], D["B"]
    NA, NB = np.asarray(D["NA"]), np.asarray(D["NB"])
    segs = f["segs"]
    out = dict(n=len(segs), lengths=[s["L"] for s in segs], defect_line_L=D["L"], kerf=kerf, mandible_w=[A["w"], B["w"]])
    rows = []
    for k, s in enumerate(segs):
        M = np.asarray(s["M"], float).reshape(4, 4).T            # three.js elements are column-major
        o = f["offMid"][k]
        Ps, Pe = toFib(s["s0"], o[0], o[1]), toFib(s["s1"], o[0], o[1])
        N0f, N1f = dirFib(s["n0"]), dirFib(s["n1"])
        m = lambda p: (M @ np.r_[p, 1.0])[:3]
        R = M[:3, :3]
        rows.append(dict(seg=k, L=s["L"], chord=float(np.linalg.norm(np.asarray(s["P1"]) - np.asarray(s["P0"]))),
                         map_start_err=float(np.linalg.norm(m(Ps) - np.asarray(s["P0"]))), map_end_err=float(np.linalg.norm(m(Pe) - np.asarray(s["P1"]))),
                         map_start_ang=ang(R @ N0f, s["N0"]), map_end_ang=ang(R @ N1f, s["N1"]), fib_len=float(np.linalg.norm(Pe - Ps)), a0=s["a0"], a1=s["a1"]))
    out["segments"] = rows
    lower = [s for s in segs if not s["barrel"]]
    # ends against the mandible cut planes (the graft ends sit in the cut planes' centre)
    s0, sl = lower[0], lower[-1]
    # (against the planned plane = the stump face; p is the slot centre, w/2 off it when the kerf lies on the resected side)
    face = lambda pl: np.asarray(pl.get("plane", pl["p"]))
    out["end_A"] = dict(angle_deg=ang(s0["N0"], A["N"]), offset_mm=float((np.asarray(s0["P0"]) - face(A)) @ np.asarray(A["N"]) / np.linalg.norm(A["N"])))
    if not B.get("virtual"):
        out["end_B"] = dict(angle_deg=ang(sl["N1"], B["N"]), offset_mm=float((np.asarray(sl["P1"]) - face(B)) @ np.asarray(B["N"]) / np.linalg.norm(B["N"])))
    # gap between the graft end and the mandible stump face: the part of the slot behind the planned plane (web/app.js
    # stumpGap: w/2 - |shift|; 0 when the slot lies on the resected side, kerfSide 1; w/2 when centred on the plane)
    xa = np.asarray(s0["x"]); xb = np.asarray(sl["x"])
    gap = lambda w, pl: max(0.0, w / 2 - abs(float(pl.get("shift") or 0)))
    out["stump_gap_A_mm"] = float(gap(A["w"], A) / max(0.2, abs(xa @ NA)))
    out["stump_gap_B_mm"] = None if B.get("virtual") else float(gap(B["w"], B) / max(0.2, abs(xb @ NB)))
    out["stump_gap_A_kerf_mm"] = float(gap(kerf, A) / max(0.2, abs(xa @ NA)))
    joints = []
    for i in range(len(lower) - 1):
        g1, g2 = lower[i], lower[i + 1]
        joints.append(dict(joint=i + 1, plane_angle_deg=ang(g1["N1"], g2["N0"]), plane_offset_mm=float((np.asarray(g2["P0"]) - np.asarray(g1["P1"])) @ np.asarray(g1["N1"])),
                           point_gap_mm=float(np.linalg.norm(np.asarray(g2["P0"]) - np.asarray(g1["P1"]))),
                           wedge_fib_deg=ang(dirFib(g1["n1"]), dirFib(g2["n0"])), bend_mand_deg=ang(g1["x"], g2["x"])))
    out["joints"] = joints
    # overlap on the fibula and the knee / ankle margins, along the fibula surface (radius FR) with the kerf outside
    th = np.linspace(0, 2 * np.pi, 72, endpoint=False)

    def s_at(s_axis, nloc, o):
        Nf = dirFib(nloc)
        return s_axis - FR * (np.cos(th) * (Nf @ e2) + np.sin(th) * (Nf @ e3)) / (Nf @ a)
    gaps = []
    ordered = sorted(segs, key=lambda s: s["s0"])
    for i in range(len(ordered) - 1):
        g1, g2 = ordered[i], ordered[i + 1]
        e = s_at(g1["s1"], g1["n1"], None) + kerf
        b = s_at(g2["s0"], g2["n0"], None) - kerf
        gaps.append(float((b - e).min()))
    out["fib_min_gap_between_segments_mm"] = min(gaps) if gaps else None
    dist = float((s_at(ordered[0]["s0"], ordered[0]["n0"], None) - kerf).min() - smin)
    prox = float(smax - (s_at(ordered[-1]["s1"], ordered[-1]["n1"], None) + kerf).max())
    out["distal_margin_mm"], out["proximal_margin_mm"] = dist, prox
    out["distal_setting_mm"] = f["plan"]["distal"]
    vb = F.get("volBounds")
    if vb:
        zlo, zhi = min(vb[0][2], vb[1][2]), max(vb[0][2], vb[1][2])
        ends = [toFib(smin, 0, 0), toFib(smax, 0, 0)]
        out["fibula_touches_scan_end"] = bool(min(abs(ends[0][2] - zlo), abs(ends[0][2] - zhi), abs(ends[1][2] - zlo), abs(ends[1][2] - zhi)) < 4.0)
    # fibula guide slot faces: measured inner wall vs the segment end plane, then carried into the mandible by M
    if fblk_meshes and f.get("guide"):
        gplanes = f["guide"]["planes"]
        res = {}
        for vname, G in fblk_meshes.items():
            rows2 = []
            for k, s in enumerate(segs):
                for end, idx, out_sign in (("start", 2 * k, -1), ("end", 2 * k + 1, 1)):
                    pl = gplanes[idx]
                    p, N = np.asarray(pl["p"], float), np.asarray(pl["N"], float)
                    walls = slot_walls(G, p, N, pl["w"])
                    sh = float(pl.get("shift") or 0)
                    if sh:   # p is the slot centre, the graft face (the inner wall) lies -shift from it
                        inner, want = walls.get("pos" if -sh > 0 else "neg"), -sh
                    else:
                        inner = walls.get("pos" if out_sign < 0 else "neg")
                        want = (kerf / 2) * (1 if out_sign < 0 else -1)
                    r = dict(seg=k, end=end, w_planned=pl["w"])
                    if inner:
                        r.update(inner_offset_err_mm=inner["offset"] - want, inner_angle_deg=inner["angle_deg"],
                                 width=(walls["pos"]["offset"] - walls["neg"]["offset"]) if walls.get("pos") and walls.get("neg") else None)
                        # carry the measured inner face into the mandible and compare with the mandible plane / joint plane
                        M = np.asarray(s["M"], float).reshape(4, 4).T
                        c = inner["centroid"]; nn = inner["normal"]
                        cm = (M @ np.r_[c, 1.0])[:3]; nm = M[:3, :3] @ nn
                        tgt_p, tgt_n = (np.asarray(s["P0"]), np.asarray(s["N0"])) if end == "start" else (np.asarray(s["P1"]), np.asarray(s["N1"]))
                        r.update(mand_angle_deg=ang(nm, tgt_n), mand_offset_mm=float((cm - tgt_p) @ tgt_n / np.linalg.norm(tgt_n)))
                    rows2.append(r)
            res[vname] = rows2
        out["fib_slots"] = res
    return out


def slot_walls(G, p, N, w):
    m = G.am
    N = N / np.linalg.norm(N)
    fc, fn, fa = m.triangles_center, m.face_normals, m.area_faces
    s = (fc - p) @ N
    par = np.abs(fn @ N) > 0.9
    walls = {}
    for side, sel in (("pos", par & (s > 0.05) & (s < w / 2 + 0.6) & ((fn @ N) < 0)), ("neg", par & (s < -0.05) & (s > -w / 2 - 0.6) & ((fn @ N) > 0))):
        if sel.sum() < 10:
            continue
        P, A = fc[sel], fa[sel]
        c = (P * A[:, None]).sum(0) / A.sum()
        _, _, vt = np.linalg.svd((P - c) * np.sqrt(A)[:, None], full_matrices=False)
        nn = vt[2] * np.sign(vt[2] @ N)
        walls[side] = dict(offset=float((c - p) @ N), angle_deg=float(np.degrees(np.arccos(min(1.0, abs(nn @ N))))), centroid=c, normal=nn)
    return walls


def analyze(run, quick=False, img_dir=None, label=None):
    d = gm.load_run(run)
    label = label or os.path.basename(run.rstrip("/"))
    out = dict(run=run, scenario=d.get("scenario"), checks=d.get("checks"), plan_planes=d.get("planes"), g=d.get("g"), result=d.get("result"),
               guideStat=d.get("guideStat"), console=d.get("console"), seconds=d.get("seconds"))
    if d.get("guide"):
        res = d.get("resEnds")
        resection = (res["A"], res["B"]) if res else None
        sinfo = d["result"]["screwInfo"] if d.get("result") else d.get("screws")
        if not quick:
            blk, meshes, refs = guide_block(run, d["guide"], "m", d["thr"], d["frame"], d["planes"], sinfo, d["g"], resection, img_dir, label + "_mand")
            # a two-guide layout is two bodies in one STL (preview and production alike)
            blk["expect_bodies"] = 2 if d["guide"].get("split") else 1
            out["mandible"] = blk
            # the connecting bar: its own part and server call
            bp, bs = os.path.join(run, "m_bar_preview.stl"), os.path.join(run, "m_bar_server.stl")
            if os.path.exists(bp) and os.path.exists(bs):
                Bp, Bs = gm.GuideMesh(bp), gm.GuideMesh(bs)
                out["bar"] = dict(preview_vs_server=gm.hausdorff(Bp, Bs), quality=dict(preview=Bp.quality, server=Bs.quality), server_reply={k: v for k, v in d["bar"]["server"].items() if k != "stl"})
        out["mandible_null_screws"] = sum(1 for s in (d.get("plan", {}).get("screws") or []) if not s)
    if d.get("fib"):
        fmesh = None
        fg = d["fib"].get("guide")
        if fg and not quick:
            blk, fmesh, _ = guide_block(run, fg, "f", 250, fg["frame"], fg["planes"], fg["result"]["screwInfo"], fg["g"], None, img_dir, label + "_fib")
            out["fibula_guide"] = blk
        out["fib_match"] = fib_match(d, fmesh)
        out["fib_checks"] = d["fib"].get("checks")
        out["osteo"] = d.get("osteo")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("run"); ap.add_argument("--quick", action="store_true"); ap.add_argument("--img")
    ap.add_argument("--screws-only", action="store_true", help="recompute only the screw metrics in an existing metrics.json")
    a = ap.parse_args()
    if a.screws_only:
        res = json.load(open(os.path.join(a.run, "metrics.json")))
        d = gm.load_run(a.run)
        jobs = []
        if d.get("guide") and res.get("mandible"):
            rs = d.get("resEnds")
            jobs.append((res["mandible"], d["guide"], "m", d["thr"], d["planes"], d["result"]["screwInfo"], d["g"], (rs["A"], rs["B"]) if rs else None))
        fg = (d.get("fib") or {}).get("guide")
        if fg and res.get("fibula_guide"):
            jobs.append((res["fibula_guide"], fg, "f", 250, fg["planes"], fg["result"]["screwInfo"], fg["g"], None))
        for blk, gd, pre, thr, planes, sinfo, g, resection in jobs:
            refs = gm.bone_refs(a.run, gd, thr)
            clear, wall = float(g["clear"]) + float(g.get("peri") or 0), float(g["wall"])
            for var in ("preview", "server"):
                if var in blk:
                    G = gm.GuideMesh(os.path.join(a.run, f"{pre}_guide_{var}.stl"))
                    blk[var]["screws"] = gm.screw_metrics(G, refs["app"], sinfo, planes, clear, wall, resection)
                    blk[var]["screws_ct"] = gm.screw_metrics(G, refs["ct"], sinfo, planes, clear, wall, resection)
    else:
        res = analyze(a.run, a.quick, a.img)
    with open(os.path.join(a.run, "metrics.json"), "w") as fh:
        json.dump(gm.strip(res), fh, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    print("ok", a.run)
