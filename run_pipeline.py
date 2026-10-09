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
import time
import numpy as np
import trimesh

from surgiguide.volume import Volume, write_dicom_series
from surgiguide import phantom, segment, plan as planning, guides, render
from surgiguide.meshing import volume_mask_mesh


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.1f}s] {msg}", flush=True)


def seg(vol, structure, args, dicom_dir, component):
    if args.segmenter == "totalseg":
        return segment.totalseg_bone(vol, structure, dicom_dir=dicom_dir, fast=args.fast)
    return segment.threshold_bone(vol, hu=args.hu, component=component)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="generate synthetic DICOM phantoms and use them")
    ap.add_argument("--mandible-dicom"); ap.add_argument("--fibula-dicom")
    ap.add_argument("--segmenter", choices=["threshold", "totalseg"], default="threshold")
    ap.add_argument("--fast", action="store_true", help="TotalSegmentator --fast")
    ap.add_argument("--hu", type=float, default=250.0, help="bone threshold (threshold segmenter)")
    ap.add_argument("--fibula-component", type=int, default=2,
                    help="threshold segmenter: size rank of the fibula component (tibia is usually 1)")
    ap.add_argument("--resect-from", type=float, default=-15.0, help="arch position mm (+ = patient left)")
    ap.add_argument("--resect-to", type=float, default=40.0)
    ap.add_argument("--segments", type=int, default=None, help="number of fibula segments (default: auto)")
    ap.add_argument("--side", choices=["right", "left"], default="right", help="donor leg")
    ap.add_argument("--kerf", type=float, default=1.0, help="saw blade thickness + tolerance, mm")
    ap.add_argument("--clearance", type=float, default=0.3); ap.add_argument("--wall", type=float, default=2.5)
    ap.add_argument("--out", default="outputs/run")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    if a.demo:
        log("generating synthetic CT phantoms and writing them as DICOM series")
        a.mandible_dicom = os.path.join(a.out, "dicom_head"); a.fibula_dicom = os.path.join(a.out, "dicom_leg")
        write_dicom_series(phantom.mandible_phantom(), a.mandible_dicom, "HEAD PHANTOM")
        write_dicom_series(phantom.leg_phantom(), a.fibula_dicom, "LEG PHANTOM")

    log("reading DICOM")
    vm, vf = Volume.from_dicom_dir(a.mandible_dicom), Volume.from_dicom_dir(a.fibula_dicom)
    log(f"segmenting ({a.segmenter})")
    mm = seg(vm, "mandible", a, a.mandible_dicom, 1)
    fm = seg(vf, "fibula", a, a.fibula_dicom, a.fibula_component)
    mand_mesh, fib_mesh = volume_mask_mesh(vm, mm), volume_mask_mesh(vf, fm)
    mand_mesh.export(os.path.join(a.out, "mandible.stl")); fib_mesh.export(os.path.join(a.out, "fibula.stl"))
    log(f"meshes: mandible {len(mand_mesh.faces)} faces, fibula {len(fib_mesh.faces)} faces")

    log("planning")
    arch = planning.Arch(vm, mm)
    fib = planning.Fibula(vf, fm, side=a.side)
    p = planning.make_plan(arch, fib, a.resect_from, a.resect_to, n_segments=a.segments, kerf=a.kerf)
    summary = planning.plan_summary(p, fib)
    print(json.dumps(summary, indent=2))

    log("generating guides")
    fg, fplanes, frep = guides.fibula_guide(vf, fm, fib, p, clearance=a.clearance, wall=a.wall)
    mg = [guides.mandible_guide(vm, mm, arch, p, w, clearance=a.clearance, wall=a.wall) for w in (0, 1)]
    fg.export(os.path.join(a.out, "guide_fibula.stl"))
    for i, (m, _, _) in enumerate(mg):
        m.export(os.path.join(a.out, f"guide_mandible_{'ab'[i]}.stl"))
    summary["guides"] = [frep] + [r for _, _, r in mg]
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
    log(f"done -> {a.out}")


if __name__ == "__main__":
    main()
