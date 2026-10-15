#!/usr/bin/env python3
"""End-to-end: DICOM (head/neck CT + lower leg CT) -> segmentation -> plan -> guide STLs.

Examples
  # synthetic phantoms (no patient data needed)
  python run_pipeline.py --demo --out outputs/demo

  # real data
  python run_pipeline.py --mandible-dicom /data/neckCT --fibula-dicom /data/legCTA \
      --resect-from -10 --resect-to 45 --side right --segmenter totalseg --out outputs/case01
"""
import argparse
import json
import os
import sys
import time
import numpy as np
import trimesh

from surgiguide.volume import Volume, write_dicom_series
from surgiguide import phantom, segment, plan as planning, guides, render
from surgiguide.meshing import volume_mask_mesh
from surgiguide.version import info as version_info


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.1f}s] {msg}", flush=True)


WARNINGS = []


def warn(msg):
    """A problem the surgeon must see: printed at once, listed again at the end and written to plan.json (never silent)."""
    WARNINGS.append(msg)
    print("WARNING: " + msg, flush=True)


def seg(vol, structure, args, component):
    if args.segmenter == "totalseg":
        # the volume read above (the chosen series), never the whole DICOM folder: with several series in it
        # TotalSegmentator would segment whichever it picks
        return segment.totalseg_bone(vol, structure, dicom_dir=None, fast=args.fast)
    if structure == "mandible":          # skull / upper jaw / spine joined to the mandible are cut off (surgiguide/bones.py)
        mask, info = segment.mandible_bone(vol, hu=args.hu)
    elif component is None:              # leg CT: the slender bone beside the tibia on the donor side, not the table or the whole leg
        mask, info = segment.fibula_bone(vol, hu=args.hu, side=args.side)
        if args.side == "auto":
            args.side = info["side"]
        log(f"fibula: {info['side']} leg ({'lateral to its tibia' if info.get('side_from') == 'tibia' else 'by the scanner x: not checked against a tibia'})")
    else:                                # explicit --fibula-component N: the old size-rank choice
        return segment.threshold_bone(vol, hu=args.hu, component=component)
    extra = "".join(f", {k} {info[k]:.0f} mm" for k in ("length_mm", "radius_mm") if k in info)
    log(f"{structure}: {info['status']} ({info['volume_cm3']:.1f} cm3{extra})")
    if info.get("note"):
        log(info["note"])
    if info.get("warning"):
        warn(info["warning"])
    return mask


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="generate synthetic DICOM phantoms and use them")
    ap.add_argument("--mandible-dicom"); ap.add_argument("--fibula-dicom")
    ap.add_argument("--mandible-series", help="series description (substring) or UID to read from --mandible-dicom, e.g. 'Bone'; default: the series with most slices")
    ap.add_argument("--fibula-series", help="same for --fibula-dicom")
    ap.add_argument("--segmenter", choices=["threshold", "totalseg"], default="threshold")
    ap.add_argument("--fast", action="store_true", help="TotalSegmentator --fast")
    ap.add_argument("--hu", type=float, default=250.0, help="bone threshold (threshold segmenter)")
    ap.add_argument("--fibula-component", type=int, default=None,
                    help="threshold segmenter: size rank of the fibula component (old behaviour). Default: automatic, "
                         "the slender bone beside the tibia on the --side leg (CT table, tibia and foot are never taken)")
    ap.add_argument("--resect-from", type=float, default=-15.0, help="arch position mm (+ = patient left)")
    ap.add_argument("--resect-to", type=float, default=40.0)
    ap.add_argument("--segments", type=int, default=None, help="number of fibula segments (default: auto)")
    ap.add_argument("--side", choices=["right", "left", "auto"], default="right",
                    help="donor leg (auto: the leg of a one-leg scan, told by the tibia). The fibula of the other leg is never used: "
                         "the run stops when the asked leg has none")
    ap.add_argument("--kerf", type=float, default=1.0, help="saw blade thickness (bone one cut takes), mm")
    ap.add_argument("--slot-width", type=float, default=None,
                    help="guide saw slot width, mm (default: the kerf, as before; never narrower than the blade; blade + 0.1-0.3 mm is advised)")
    ap.add_argument("--kerf-side", choices=["resected", "centre"], default="resected",
                    help="mandible saw slot relative to the planned cut plane: 'resected' = the slot lies on the resected side and the graft meets "
                         "the stump flush (gap 0, default, the browser's default too); 'centre' = centred on the plane, kerf/2 lost from each stump")
    ap.add_argument("--clearance", type=float, default=0.3); ap.add_argument("--wall", type=float, default=2.5)
    ap.add_argument("--out", default="outputs/run")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    summary = {"software": version_info()}
    try:
        run(a, summary)
    except (RuntimeError, ValueError, FileNotFoundError) as e:
        # a stop with a reason (wrong leg, no bone, a plan outside the bone ...): said plainly, and plan.json records it
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        summary.update(error=str(e), warnings=list(WARNINGS))
        with open(os.path.join(a.out, "plan.json"), "w") as f:
            json.dump(summary, f, indent=2)
        return 2
    return 0


def run(a, summary):
    log(f"surgiguide {summary['software']['version']}")

    if a.demo:
        log("generating synthetic CT phantoms and writing them as DICOM series")
        a.mandible_dicom = os.path.join(a.out, "dicom_head"); a.fibula_dicom = os.path.join(a.out, "dicom_leg")
        write_dicom_series(phantom.mandible_phantom(), a.mandible_dicom, "HEAD PHANTOM")
        write_dicom_series(phantom.leg_phantom(), a.fibula_dicom, "LEG PHANTOM")

    log("reading DICOM")
    vm, vf = Volume.from_dicom_dir(a.mandible_dicom, a.mandible_series), Volume.from_dicom_dir(a.fibula_dicom, a.fibula_series)
    log(f"segmenting ({a.segmenter})")
    mm = seg(vm, "mandible", a, 1)
    fm = seg(vf, "fibula", a, a.fibula_component)
    if a.side == "auto":
        raise RuntimeError("--side auto needs the automatic fibula picker (threshold segmenter, no --fibula-component); give --side right / left")
    mand_mesh, fib_mesh = volume_mask_mesh(vm, mm), volume_mask_mesh(vf, fm)
    mand_mesh.export(os.path.join(a.out, "mandible.stl")); fib_mesh.export(os.path.join(a.out, "fibula.stl"))
    log(f"meshes: mandible {len(mand_mesh.faces)} faces, fibula {len(fib_mesh.faces)} faces")

    log("planning")
    arch = planning.Arch(vm, mm)
    fib = planning.Fibula(vf, fm, side=a.side)
    p = planning.make_plan(arch, fib, a.resect_from, a.resect_to, n_segments=a.segments, kerf=a.kerf, kerf_side=a.kerf_side, slot_w=a.slot_width)
    summary.update(planning.plan_summary(p, fib), donor_side=a.side)
    print(json.dumps(summary, indent=2))
    for w in p.get("warnings", []):
        warn("plan: " + w)
    log(f"graft-to-stump gap: {p['stump_gap_mm'][0]:.2f} mm at each end (planned slot {p['slot_w']:.2f} mm, blade {p['kerf']:.2f} mm, on the {p['kerf_side']} side of the cut plane)")
    if p.get("segment_decision"):
        d = p["segment_decision"]
        why = {"short": "defect shorter than one segment", "dev": "fewest segments within the deviation tolerance",
               "len": "smallest deviation among the counts that keep every segment long enough"}[d["reason"]]
        log(f"segment count {d['n']} ({why}); candidates: "
            + ", ".join(f"{c['n']}: shortest {c['shortest_segment_mm']} mm / deviation {c['deviation_mm']} mm" for c in d["candidates"]))

    log("generating guides")
    fg, fplanes, frep = guides.fibula_guide(vf, fm, fib, p, clearance=a.clearance, wall=a.wall)
    mg = [guides.mandible_guide(vm, mm, arch, p, w, clearance=a.clearance, wall=a.wall) for w in (0, 1)]
    fg.export(os.path.join(a.out, "guide_fibula.stl"))
    for i, (m, _, _) in enumerate(mg):
        m.export(os.path.join(a.out, f"guide_mandible_{'ab'[i]}.stl"))
    summary["guides"] = [frep] + [r for _, _, r in mg]
    # the slot the STL really has (whole voxels of the guide grid, never narrower than the blade), not only the planned one
    log("guide slots: " + ", ".join(f"{r['name']} {r['slot_mm']:.2f} mm" for r in summary["guides"] if "slot_mm" in r)
        + f" (planned {p['slot_w']:.2f} mm, rounded up to whole voxels of the guide grid)")
    for r in summary["guides"]:
        if r.get("wall"):
            log(f"{r['name']}: wall 1st percentile {r['wall']['wall_p1_mm']:.1f} mm, {r['wall']['thin_mm2']:.0f} mm2 thinner than the minimum "
                f"(rim / staircase), {r['wall']['held_parts']} part(s) held by thin wall only")
        st = r.get("seat")
        if st and st.get("ok"):
            log(f"{r['name']}: seat check {st['free_directions']}/{st['directions']} directions free, best tilt {st['best_tilt_deg']:.0f} deg, "
                f"{st['blocked_mm2_along_normal']:.0f} mm2 of bone over the guide along its seating normal")
        if r.get("slot_note"):
            warn(r["slot_note"])
        if r.get("note"):
            log(r["note"])
        if r.get("warning"):
            warn(r["warning"])
    if WARNINGS:
        summary["warnings"] = list(WARNINGS)
    summary["guides_watertight"] = bool(fg.is_watertight and all(m.is_watertight for m, _, _ in mg))

    log("virtual surgery: resection + transplanted grafts")
    kept, _ = guides.resected_mandible(vm, mm, arch, p)
    kept_mesh = volume_mask_mesh(vm, kept); kept_mesh.export(os.path.join(a.out, "mandible_resected.stl"))
    seg_fib, seg_mand = guides.fibula_segments(vf, fm, fib, p)
    trimesh.util.concatenate(seg_mand).export(os.path.join(a.out, "grafts_in_mandible.stl"))
    trimesh.util.concatenate(seg_fib).export(os.path.join(a.out, "grafts_in_fibula.stl"))

    with open(os.path.join(a.out, "plan.json"), "w") as f:
        json.dump(summary, f, indent=2)

    # one coloured scene per patient frame for interactive viewing
    def colored(m, rgba, faces=40000):
        m = m.copy()
        if len(m.faces) > faces:
            try:
                m = m.simplify_quadric_decimation(face_count=faces)
            except Exception:
                pass
        m.visual.face_colors = rgba
        return m
    scene_m = trimesh.Scene([colored(kept_mesh, [230, 224, 205, 255])] +
                            [colored(s, [214, 120, 80, 255]) for s in seg_mand] +
                            [colored(m, [60, 130, 220, 255]) for m, _, _ in mg])
    yup = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])   # LPS z-up -> glTF y-up
    scene_m.apply_transform(yup)
    scene_m.export(os.path.join(a.out, "scene_mandible.glb"), include_normals=True)
    scene_f = trimesh.Scene([colored(fib_mesh, [230, 224, 205, 255]), colored(fg, [60, 130, 220, 255])] +
                            [colored(s, [214, 120, 80, 255]) for s in seg_fib])
    scene_f.apply_transform(yup)
    scene_f.export(os.path.join(a.out, "scene_fibula.glb"), include_normals=True)

    log("rendering previews")
    bone, graft, guide = "#e6e0cd", "#d67850", "#3c82dc"
    render.render(os.path.join(a.out, "1_plan_mandible.png"),
                  [(kept_mesh, bone, 1)] + [(s, graft, 1) for s in seg_mand],
                  "Plan: resected mandible + fibula grafts", view=(35, -110))
    render.render(os.path.join(a.out, "2_mandible_guides.png"),
                  [(mand_mesh, bone, 1)] + [(m, guide, 1) for m, _, _ in mg],
                  "Mandible cutting guides", view=(20, -120))
    # crop the fibula view to the guide region
    lo, hi = fg.bounds
    fib_crop = fib_mesh.slice_plane(lo - 15, [0, 0, 1]).slice_plane(hi + 15, [0, 0, -1])
    render.render(os.path.join(a.out, "3_fibula_guide.png"), [(fib_crop, bone, 1), (fg, guide, 1)],
                  "Fibula cutting guide (lateral view)", view=(15, 165))
    if WARNINGS:
        print(f"{len(WARNINGS)} WARNING(S):", flush=True)
        for w in WARNINGS:
            print("  - " + w, flush=True)
    log(f"done -> {a.out}")


if __name__ == "__main__":
    sys.exit(main())
