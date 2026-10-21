"""Real-CT audit: measure the production STLs of one end-to-end run and compare them with a reviewed baseline.

The B scenario (tests/web/e2e/B_real.js) plans a case on the anonymised real CT and writes the files the surgeon
would get to <kanit>/real/. This tool reads them and answers two questions:
  1. Can these files be printed?  watertight, expected body count, the server's print checks (thin wall, guide in
     bone, guide in the bone's shadow along the insertion direction), server verdict, STL up to date with the plan
  2. Did the guide change?        volume, triangle count, surface roughness (median distance of a vertex from the
     mean of its neighbours along its normal, per mean edge length: voxel steps and slice terraces raise it; real CT
     2026-10-21: 0.031 with binary-mask surfaces, 0.026 with the HU-ramp surface; a 1 mm voxel sphere 0.14), surface
     distance to the baseline STL
Fails (exit 1) on (1) always and on (2) unless --allow-drift. A drift is not wrong by itself: after a reviewed change
to the guide, rerun with --write-baseline to make the new STLs the reference.

  python3 -I tools/realct_audit.py <kanit dir> --baseline <dir> [--report out.md] [--write-baseline] [--allow-drift]

Only geometry and numbers are read or written: the STLs carry no patient data (the CT is the anonymised copy).
"""
import argparse, json, os, shutil, sys
import numpy as np
import trimesh
from scipy.spatial import cKDTree

FILES = {"guide_uretim.stl": "guide_uretim_meta.json", "fibula_guide_uretim.stl": "fibula_guide_uretim_meta.json"}
SHARP_DEG = 30.0          # an edge between faces bent more than this counts as sharp
VOL_TOL = 0.10            # relative volume change that counts as drift
ROUGH_TOL = (1.15, 0.003) # drift when roughness > baseline * 1.15 and > baseline + 0.003
DIST_MEAN_TOL = 0.03      # mm, mean surface distance to the baseline that counts as drift (the same plan gives a
                          # byte-identical STL; the HU-ramp surface change of 2026-10-21 moved it 0.03-0.07 mm)
DIST_P95_TOL = 0.15       # mm
SAMPLES = 60000


def metrics(path, seed=0):
    tm = trimesh.load_mesh(path, file_type="stl", process=True)
    ang = np.degrees(tm.face_adjacency_angles) if len(tm.face_adjacency) else np.zeros(0)
    try: bodies = len(tm.split(only_watertight=False))
    except Exception: bodies = -1
    return tm, {"faces": int(len(tm.faces)), "watertight": bool(tm.is_watertight), "bodies": int(bodies),
                "volume_mm3": round(float(tm.volume), 1) if tm.is_watertight else None,
                "extent_mm": [round(float(x), 2) for x in tm.extents],
                "sharp_share": round(float(np.mean(ang > SHARP_DEG)) if len(ang) else 0.0, 4),
                "roughness": roughness(tm),
                "mean_bend_deg": round(float(ang.mean()) if len(ang) else 0.0, 2)}


def roughness(tm):
    v, n = tm.vertices, tm.vertex_normals
    e = tm.edges_unique
    deg = np.bincount(e.ravel(), minlength=len(v)).astype(float)
    acc = np.zeros_like(v)
    np.add.at(acc, e[:, 0], v[e[:, 1]]); np.add.at(acc, e[:, 1], v[e[:, 0]])
    ok = deg > 0
    lap = np.abs(np.einsum("ij,ij->i", v[ok] - acc[ok] / deg[ok, None], n[ok]))
    el = float(tm.edges_unique_length.mean()) if len(e) else 1.0
    return round(float(np.median(lap) / el), 4) if len(lap) else 0.0


def _to_surface(p, tm, k=12):
    """Distance from points p to the surface of tm: exact point-triangle distance over the k triangles with the nearest
    centroids (dense meshes, so the closest triangle is among them)."""
    v, f = trimesh.remesh.subdivide_to_size(tm.vertices, tm.faces, max_edge=0.5, max_iter=12)
    tri = v[f]   # long, thin triangles of flat areas split so a near centroid means a near triangle
    _, idx = cKDTree(tri.mean(1)).query(p, k=k)
    q = np.repeat(p, k, axis=0)
    c = trimesh.triangles.closest_point(tri[idx.ravel()], q)
    return np.linalg.norm(c - q, axis=1).reshape(-1, k).min(1)


def distance(a, b, n=SAMPLES, seed=0):
    """Symmetric surface distance between two meshes (mm): points sampled on each, distance to the other surface."""
    pa, _ = trimesh.sample.sample_surface(a, n, seed=seed)
    pb, _ = trimesh.sample.sample_surface(b, n, seed=seed + 1)
    d = np.concatenate([_to_surface(pa, b), _to_surface(pb, a)])
    return {"mean_mm": round(float(d.mean()), 3), "p95_mm": round(float(np.percentile(d, 95)), 3), "max_mm": round(float(d.max()), 3)}


def audit(kanit, baseline, allow_drift=False):
    real = os.path.join(kanit, "real") if os.path.isdir(os.path.join(kanit, "real")) else kanit
    base = {}
    bj = os.path.join(baseline, "baseline.json") if baseline else None
    if bj and os.path.exists(bj):
        with open(bj) as f: base = json.load(f)
    rows, fails, drifts, out = [], [], [], {}
    for name, metaname in FILES.items():
        p = os.path.join(real, name)
        if not os.path.exists(p):
            fails.append(f"{name}: yok (üretim STL'i alınmadı)"); continue
        tm, m = metrics(p)
        meta = {}
        if os.path.exists(os.path.join(real, metaname)):
            with open(os.path.join(real, metaname)) as f: meta = json.load(f)
        m["print"] = meta.get("print"); m["issues"] = meta.get("issues"); m["productionOk"] = meta.get("productionOk")
        m["current"] = meta.get("current")
        b = base.get(name)
        want = b["bodies"] if b else 1
        # 1 · printable
        if not m["watertight"]: fails.append(f"{name}: su geçirmez değil")
        if m["bodies"] != want: fails.append(f"{name}: {m['bodies']} parça (beklenen {want})")
        if m["productionOk"] is False: fails.append(f"{name}: sunucu basılamaz dedi ({', '.join(m['issues'] or [])})")
        bad = [c for c in (m["issues"] or []) if c in ("thin_wall", "bone_overlap", "undercut", "not_manifold")]
        if bad: fails.append(f"{name}: baskı denetimi: {', '.join(bad)}")
        if m["print"] is None: fails.append(f"{name}: sunucu baskı denetimi sonucu yok")
        if m["current"] is False: fails.append(f"{name}: plan değiştikten sonra yeniden üretilmemiş")
        # 2 · changed against the baseline
        if b:
            bp = os.path.join(baseline, name)
            if os.path.exists(bp):
                m["distance"] = distance(tm, trimesh.load_mesh(bp, file_type="stl", process=True))
                if m["distance"]["mean_mm"] > DIST_MEAN_TOL or m["distance"]["p95_mm"] > DIST_P95_TOL:
                    drifts.append(f"{name}: yüzey tabandan ortalama {m['distance']['mean_mm']} mm, %95 {m['distance']['p95_mm']} mm uzak")
            if m["volume_mm3"] and b.get("volume_mm3") and abs(m["volume_mm3"] / b["volume_mm3"] - 1) > VOL_TOL:
                drifts.append(f"{name}: hacim {b['volume_mm3']} → {m['volume_mm3']} mm³")
            if b.get("roughness") is not None and m["roughness"] > b["roughness"] * ROUGH_TOL[0] and m["roughness"] > b["roughness"] + ROUGH_TOL[1]:
                drifts.append(f"{name}: yüzey pürüzlülüğü {b['roughness']} → {m['roughness']} (basamak ya da voksel izi arttı)")
        out[name] = m
        rows.append((name, m, b))
    ok = not fails and (allow_drift or not drifts)
    return {"ok": ok, "fails": fails, "drifts": drifts, "files": out, "had_baseline": bool(base)}, rows


def report(res, rows):
    L = ["# Gerçek BT denetimi", "", f"Sonuç: **{'GEÇTİ' if res['ok'] else 'KALDI'}**", ""]
    if not res["had_baseline"]: L += ["Taban çizgisi yok; yalnız basılabilirlik denetlendi.", ""]
    if res["fails"]: L += ["## Basılabilirlik hataları", ""] + [f"- {x}" for x in res["fails"]] + [""]
    if res["drifts"]: L += ["## Tabana göre değişen", ""] + [f"- {x}" for x in res["drifts"]] + [""]
    L += ["## Ölçümler", "", "| dosya | üçgen | su geçirmez | parça | hacim mm³ | pürüzlülük | tabana uzaklık (ort / %95) | baskı denetimi |", "|---|---|---|---|---|---|---|---|"]
    for name, m, b in rows:
        d = m.get("distance"); pc = m.get("print") or {}
        pcs = f"ince {pc.get('thin_patch_mm3', '?')} mm³, kemikte {pc.get('bone_overlap_mm3', '?')}, gölgede {pc.get('undercut_mm3', '?')}" if pc else "yok"
        bv = f" (taban {b['volume_mm3']})" if b and b.get("volume_mm3") else ""
        bs = f" (taban {b.get('roughness')})" if b else ""
        L.append(f"| {name} | {m['faces']} | {m['watertight']} | {m['bodies']} | {m['volume_mm3']}{bv} | {m['roughness']}{bs} | "
                 f"{(str(d['mean_mm']) + ' / ' + str(d['p95_mm'])) if d else '-'} | {pcs} |")
    return "\n".join(L) + "\n"


def write_baseline(kanit, baseline, res):
    real = os.path.join(kanit, "real") if os.path.isdir(os.path.join(kanit, "real")) else kanit
    os.makedirs(baseline, exist_ok=True)
    keep = {}
    for name, m in res["files"].items():
        shutil.copyfile(os.path.join(real, name), os.path.join(baseline, name))
        keep[name] = {k: m[k] for k in ("faces", "bodies", "volume_mm3", "sharp_share", "roughness", "extent_mm")}
    with open(os.path.join(baseline, "baseline.json"), "w") as f: json.dump(keep, f, indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("kanit"); ap.add_argument("--baseline"); ap.add_argument("--report")
    ap.add_argument("--write-baseline", action="store_true"); ap.add_argument("--allow-drift", action="store_true")
    ap.add_argument("--json")
    a = ap.parse_args()
    res, rows = audit(a.kanit, a.baseline, a.allow_drift)
    txt = report(res, rows)
    print(txt)
    if a.report:
        with open(a.report, "w") as f: f.write(txt)
    if a.json:
        with open(a.json, "w") as f: json.dump(res, f, indent=1)
    if a.write_baseline:
        if res["fails"]: sys.exit("basılabilirlik hatası varken taban çizgisi yazılmaz")
        write_baseline(a.kanit, a.baseline, res); print(f"taban çizgisi yazıldı: {a.baseline}")
        return 0
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
