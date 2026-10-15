"""Collect metrics.json / repeat json / pipeline_metrics.json into tutarlilik.csv (one row per metric x dataset x guide).
    python3 summarize.py --cfg datasets.json --out <tutarlilik.csv>
datasets.json: {"<dataset label>": {"type": "browser", "run": <run dir>, "repeat": <repeat json>, "ref": "app"|"ct"},
                "<label>": {"type": "pipeline", "file": <pipeline_metrics.json>, "ref": ...}}
ref = primary bone reference for the fit numbers ('app' = the segmented voxel model, the true surface of the synthetic
phantoms; 'ct' = CT HU iso-surface at the threshold, the reference for real CT)."""
import argparse
import csv
import json
import math

TH = dict(rep_mm=0.1, ang=1.0, pos=0.5, gap_tol=0.2, band=0.8, interf=1.0, width_tol=0.1, blocked=0.03, inbone=0.5, plane_clear=1.0, wall_tol=0.2,
          hd_p99=0.5)
rows = []


def add(ds, mid, metric, guide, variant, value, threshold, ok, note=""):
    if isinstance(value, float):
        value = round(value, 4)
    rows.append(dict(dataset=ds, metric_id=mid, metric=metric, guide=guide, variant=variant, value=value, threshold=threshold,
                     result="" if ok is None else ("GEÇTİ" if ok else "KALDI"), note=note))


def mx(xs):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and math.isnan(x))]
    return max(xs) if xs else None


def slot_clean(x):
    """a slot whose one wall is much smaller than the other has merged with a neighbouring slot (fibula wedge):
    take angle / offset from the large wall and drop the width."""
    w = x.get("walls") or {}
    p, n = w.get("pos"), w.get("neg")
    if p and n and min(p["area"], n["area"]) < 0.6 * max(p["area"], n["area"]):
        big = p if p["area"] > n["area"] else n
        want = x["w_planned"] / 2 * (1 if big is p else -1)
        return dict(x, angle_deg=big["angle_deg"], centre_offset=big["offset"] - want, width=None, _merged=True)
    return x


def guide_rows(ds, guide, blk, ref, expect_bodies=1, screws_expected=True, app_seat_free=None):
    clear, wall = blk["clear"], blk["wall"]
    for var in ("server", "preview"):
        r = blk.get(var)
        if not r:
            if var == "server":
                add(ds, "8", "sunucu üretim STL'i alınabildi", guide, var, json.dumps(blk.get("server_reply")), "ok", False)
            continue
        f = r["fit"][ref]
        add(ds, "2", f"iç yüzey-kemik aralığı medyanı (ref={ref})", guide, var, f["gap_median"], f"{clear}±{TH['gap_tol']} mm", f["gap_median"] is not None and abs(f["gap_median"] - clear) <= TH["gap_tol"],
            f"p5 {f['gap_p5']:.2f} / p95 {f['gap_p95']:.2f} mm" if f["gap_p5"] is not None else "")
        add(ds, "2", f"temas alanı oranı (aralık {clear}±0.2 mm) (ref={ref})", guide, var, f["in_band_frac"], f"≥ {TH['band']}", f["in_band_frac"] >= TH["band"], f"iç yüzey {f['inner_area_mm2']:.0f} mm²")
        add(ds, "2", f"girişim alanı (kemiğe >0.1 mm gömülme) (ref={ref})", guide, var, f["interference_area_mm2"], f"≤ {TH['interf']} mm²", f["interference_area_mm2"] <= TH["interf"], f"en derin {f['min_sdist']:.2f} mm")
        other = "ct" if ref == "app" else "app"
        fo = r["fit"][other]
        add(ds, "2", f"(bilgi) aralık medyanı / girişim (ref={other})", guide, var, fo["gap_median"], "-", None, f"girişim {fo['interference_area_mm2']:.1f} mm², en derin {fo['min_sdist']:.2f} mm")
        s = r.get("seat_ct") or {}
        if s:
            ok = bool(s.get("any_free"))
            if not ok and ref == "app" and app_seat_free is not None and app_seat_free > 0:
                ok = None   # synthetic data: the HU-iso surface lies ~0.2 mm outside the true surface; app's own analysis disagrees
            elif not ok and ref == "app" and app_seat_free is None:
                ok = None
            add(ds, "3", "takılabilir: en az bir yönde alttan kesik yok (ref=ct)" + ("" if ok is not None or s.get("any_free") else " – sentetik veride ct referansı ≈0,2 mm dışa yanlı, doğrulanmadı"), guide, var, f"{s['free_coarse']}/{s['n_coarse']}", "≥ 1 serbest yön", ok,
                f"ince tarama {s['free_fine']}/{s['n_fine']} (≤60°), serbest koni {s['free_cone_deg']}°, en az engel {s.get('min_blocked_mm2', 0):.1f} mm²")
            add(ds, "3", "(bilgi) nominal takma ekseninde (n) en derin alttan kesik (ref=ct)", guide, var, s.get("max_overhang_n_mm"), f"≤ {clear} mm (aralık)", None,
                f"n yönünde engel alanı {s.get('normal_blocked_mm2', 0):.1f} mm²")
        sl = [slot_clean(x) for x in (r.get("slots") or [])]
        merged = [x for x in sl if x.get("_merged")]
        if sl:
            add(ds, "4", "yuva açısı (plan düzlemine göre, en kötü)", guide, var, mx([x.get("angle_deg") for x in sl]), f"≤ {TH['ang']}°", (mx([x.get("angle_deg") for x in sl]) or 99) <= TH["ang"])
            add(ds, "4", "yuva merkez kayması (en kötü)", guide, var, mx([abs(x["centre_offset"]) for x in sl if x.get("centre_offset") is not None]), f"≤ {TH['pos']} mm", (mx([abs(x["centre_offset"]) for x in sl if x.get("centre_offset") is not None]) or 99) <= TH["pos"])
            if merged:
                add(ds, "4", "(bilgi) komşu yuvayla birleşen yuva (bir duvar kısa; açı uzun duvardan)", guide, var, len(merged), "-", None, "aradaki kama dokusu da kesildiği için yuvalar birleşiyor")
            werr = mx([abs(x["width"] - x["w_planned"]) for x in sl if x.get("width") is not None])
            add(ds, "4", "yuva genişliği hatası |ölçülen-ayar| (en kötü)", guide, var, werr, f"≤ {TH['width_tol']} mm", werr is not None and werr <= TH["width_tol"],
                "genişlikler " + ", ".join(f"{x['width']:.2f}/{x['w_planned']}" for x in sl if x.get("width") is not None))
            bl = mx([x["open"]["blocked_frac"] for x in sl if x.get("open")])
            add(ds, "4", "yuva kabuk boyunca açık mı (kapalı kalan oran)", guide, var, bl, f"≤ {TH['blocked']}", bl is not None and bl <= TH["blocked"])
        sc = r.get("screws") or []
        if screws_expected:
            nulls = sum(1 for x in sc if x.get("null"))
            add(ds, "5", "boş/null vida", guide, var, nulls, "0", nulls == 0, f"{len(sc)} vida")
            good = [x for x in sc if not x.get("null")]
            if good:
                add(ds, "5", "vida ekseni kemikte (en kötü oran)", guide, var, min(x["in_bone_frac"] for x in good), f"≥ {TH['inbone']}", min(x["in_bone_frac"] for x in good) >= TH["inbone"])
                add(ds, "5", "delik guide gövdesinde açık (kapalı kalan oran)", guide, var, mx([x["hole_blocked_frac"] for x in good]), "≤ 0.01",
                    mx([x["hole_blocked_frac"] for x in good]) <= 0.01,
                    f"(bilgi) kovan halkası malzeme oranı en az {min(x.get('sleeve_material_frac', 1) for x in good):.2f}; eğik vidada halka ekseni boyunca girişten ölçüldüğü için düşük çıkabilir")
                pcs = [x["min_plane_clearance_mm"] for x in good if x.get("min_plane_clearance_mm") is not None]
                if pcs:
                    add(ds, "5", "vida-kesi yuvası arası en kısa mesafe", guide, var, min(pcs), f"≥ {TH['plane_clear']} mm", min(pcs) >= TH["plane_clear"])
                ir = [x.get("in_resection_frac") for x in good if x.get("in_resection_frac") is not None]
                if ir:
                    add(ds, "5", "vida yolu rezeksiyon bölgesinde (oran)", guide, var, mx(ir), "0", mx(ir) == 0)
        q = r["quality"]
        add(ds, "6", "su geçirmez + manifold + tutarlı sarım", guide, var, f"wt={q['watertight']} nm={q['nonmanifold_edges']} wind={q['winding_consistent']} deg={q['degenerate_faces']}", "hepsi doğru, 0",
            q["watertight"] and q["nonmanifold_edges"] == 0 and q["winding_consistent"] and q["degenerate_faces"] == 0 and q["volume_signed"] > 0)
        add(ds, "6", "parça sayısı", guide, var, q["bodies"], str(expect_bodies), q["bodies"] == expect_bodies)
        w = r.get("wall") or {}
        if "wall_p1" in w:
            add(ds, "6", "kabuk duvarı kalınlığı p1 (iç yüzey, kenardan ≥1.5 mm)", guide, var, w["wall_p1"], f"≥ {wall}-{TH['wall_tol']} mm", w["wall_p1"] >= wall - TH["wall_tol"], f"medyan {w['wall_median']:.2f}, en az {w['wall_min']:.2f} mm")
        if "thin_lt1mm_area_mm2" in w:
            add(ds, "6", "(bilgi) <1 mm ince kenar alanı (kovanlar hariç)", guide, var, w["thin_lt1mm_area_mm2"], "-", None, f"yüzeyin %{100 * w['thin_lt1mm_frac']:.1f}'i")
    if blk.get("preview_vs_server"):
        h = blk["preview_vs_server"]
        add(ds, "8", "önizleme ↔ sunucu STL Hausdorff (maks / p99 / ort.)", guide, "preview-server", h["hausdorff"], f"p99 ≤ {TH['hd_p99']} mm (öneri)", h["p99"] <= TH["hd_p99"], f"p99 {h['p99']:.2f}, ort {h['mean']:.2f} mm, hacim farkı %{h['vol_diff_pct']:.1f}")


def fibmatch_rows(ds, fm, pipeline=False):
    if not fm or fm.get("error"):
        add(ds, "7", "fibula planı", "fibula", "plan", (fm or {}).get("error", "yok"), "-", False)
        return
    add(ds, "7", "segment sayısı / boyları (mm)", "fibula", "plan", f"{fm['n']}: " + ", ".join(f"{x:.1f}" for x in fm["lengths"]), "-", None)
    if not pipeline:
        segs = fm["segments"]
        add(ds, "7", "fibula→mandibula taşıma tutarlılığı (nokta / açı)", "fibula", "plan", mx([max(x["map_start_err"], x["map_end_err"]) for x in segs]), "≤ 0.5 mm, ≤ 1°",
            mx([max(x["map_start_err"], x["map_end_err"]) for x in segs]) <= TH["pos"] and mx([max(x["map_start_ang"], x["map_end_ang"]) for x in segs]) <= TH["ang"])
        ea = [fm["end_A"]] + ([fm["end_B"]] if fm.get("end_B") else [])
        add(ds, "7", "greft uçları ↔ mandibula kesi düzlemleri (açı / konum)", "fibula", "plan", mx([abs(x["offset_mm"]) for x in ea]), "≤ 0.5 mm, ≤ 1°",
            mx([abs(x["offset_mm"]) for x in ea]) <= TH["pos"] and mx([x["angle_deg"] for x in ea]) <= TH["ang"], f"açı en kötü {mx([x['angle_deg'] for x in ea]):.2f}°")
        gaps = [fm["stump_gap_A_mm"], fm.get("stump_gap_B_mm")]
        add(ds, "7", "greft ucu ile mandibula güdüğü arası boşluk (yuvanın düzlem arkasında kalan kısmı, uç başına)", "fibula", "plan", mx(gaps), f"≤ {TH['pos']} mm", mx(gaps) <= TH["pos"],
            f"toplam ≈ {sum(x for x in gaps if x):.2f} mm; testere {fm['kerf']} mm alınırsa uç başına {fm['stump_gap_A_kerf_mm']:.2f} mm")
        for j in fm["joints"]:
            add(ds, "7", f"eklem {j['joint']}: komşu segment yüzleri (açı / konum)", "fibula", "plan", j["plane_offset_mm"], "≤ 0.5 mm, ≤ 1°", abs(j["plane_offset_mm"]) <= TH["pos"] and j["plane_angle_deg"] <= TH["ang"] and j["point_gap_mm"] <= TH["pos"],
                f"açı {j['plane_angle_deg']:.2f}°, kama (fibula) {j['wedge_fib_deg']:.1f}° / büküm (mandibula) {j['bend_mand_deg']:.1f}°")
    else:
        for w in fm.get("wedge", []):
            add(ds, "7", f"eklem {w['joint']}: kama (fibula) / büküm (mandibula)", "fibula", "plan", w["wedge_fib_deg"], "|fark| ≤ 1°", abs(w["wedge_fib_deg"] - w["bend_mand_deg"]) <= TH["ang"], f"büküm {w['bend_mand_deg']:.2f}°")
        add(ds, "7", "greft ucu ile mandibula güdüğü arası boşluk", "fibula", "plan", fm.get("stump_gap_mm"), f"≤ {TH['pos']} mm", True, "kerf rezeke tarafta; greft boyu = güdükler arası mesafe")
    if fm.get("fib_min_gap_between_segments_mm") is not None:
        add(ds, "7", "fibulada segmentler çakışmıyor (yuvalar dahil en dar ara)", "fibula", "plan", fm["fib_min_gap_between_segments_mm"], "≥ 0 mm", fm["fib_min_gap_between_segments_mm"] >= 0)
    note = "fibula taramanın ucuna değiyor: gerçek diz/ayak bileği payı doğrulanamaz" if fm.get("fibula_touches_scan_end") else ""
    add(ds, "7", "distal (ayak bileği) payı, yuva dahil", "fibula", "plan", fm["distal_margin_mm"], "≥ 60 mm", fm["distal_margin_mm"] >= 60, note)
    add(ds, "7", "proksimal (diz) payı, yuva dahil", "fibula", "plan", fm["proximal_margin_mm"], "≥ 60 mm", fm["proximal_margin_mm"] >= 60, note)
    fs = fm.get("fib_slots") or {}
    if isinstance(fs, list):
        fs = {"pipeline": fs}
    for var, rws in fs.items():
        good = [x for x in rws if "inner_offset_err_mm" in x]
        if not good:
            add(ds, "7", "fibula guide yuvası iç yüzü bulunamadı", "fibula", var, len(rws), "-", False)
            continue
        add(ds, "7", "fibula guide yuva iç yüzü ↔ segment ucu (konum / açı)", "fibula", var, mx([abs(x["inner_offset_err_mm"]) for x in good]), "≤ 0.5 mm, ≤ 1°",
            mx([abs(x["inner_offset_err_mm"]) for x in good]) <= TH["pos"] and mx([x["inner_angle_deg"] for x in good]) <= TH["ang"], f"açı en kötü {mx([x['inner_angle_deg'] for x in good]):.2f}°")
        mo = [x for x in good if "mand_offset_mm" in x]
        if mo:
            add(ds, "7", "yuva iç yüzü mandibulaya taşınınca ↔ mandibula düzlemi", "fibula", var, mx([abs(x["mand_offset_mm"]) for x in mo]), "≤ 0.5 mm, ≤ 1°",
                mx([abs(x["mand_offset_mm"]) for x in mo]) <= TH["pos"] and mx([x["mand_angle_deg"] for x in mo]) <= TH["ang"], f"açı en kötü {mx([x['mand_angle_deg'] for x in mo]):.2f}°")
        # planned slot width: the plan's slot (never narrower than the blade, web/fibula.js slotOf), else the blade
        ws = [(x["width"], x.get("w_planned", fm.get("kerf"))) for x in good if x.get("width")]
        if ws and var != "pipeline" and all(wp is not None for _, wp in ws):   # pipeline: merged neighbouring slots; metric 4
            werr = mx([abs(w - wp) for w, wp in ws])
            add(ds, "7", "fibula guide yuva genişliği (ayar = planlı yuva)", "fibula", var, werr, f"|w-ayar| ≤ {TH['width_tol']} mm",
                werr <= TH["width_tol"], "genişlikler " + ", ".join(f"{w:.2f}/{wp:.2f}" for w, wp in ws))


def warn_rows(ds, m):
    """metric 9: do the app's own warnings agree with what was measured?"""
    res = m.get("result") or {}
    seat = res.get("seat") or {}
    crit_seat = any(c[0] == "crit" and "takılamıyor" in c[2] for c in m.get("checks", []))
    meas = (m.get("mandible") or {}).get("server", {}).get("seat_ct") or (m.get("mandible") or {}).get("preview", {}).get("seat_ct")
    if meas is not None and seat:
        ok = (not meas["any_free"]) == crit_seat
        add(ds, "9", "uyarı ↔ ölçüm: takılamama", "mandibula", "uyarı", f"uygulama serbest {seat.get('free')}/{seat.get('ndirs')}, kritik={crit_seat}", "ölçümle aynı yönde", ok,
            f"ölçülen serbest {meas['free_coarse']}/{meas['n_coarse']}")
    sc = (m.get("mandible") or {}).get("server", {}).get("screws") or []
    warned = [c[2] for c in m.get("checks", []) if c[0] in ("warn", "crit") and "Vida" in c[2] and "kemikten çıkıyor" in c[2]]
    bad = [i + 1 for i, x in enumerate(sc) if not x.get("null") and x.get("in_bone_frac", 1) < 0.95]
    if sc:
        add(ds, "9", "uyarı ↔ ölçüm: vida kemikten çıkıyor", "mandibula", "uyarı", f"uyarı {len(warned)}, ölçülen {len(bad)}", "sayılar eşit", len(warned) == len(bad),
            ("ölçülen vidalar " + ", ".join(map(str, bad))) if bad else "")
    pv = (m.get("mandible") or {}).get("preview", {}).get("fit", {}).get("app")
    if pv:
        warned_fit = any("aralık" in c[2].lower() or "sıkı" in c[2].lower() for c in m.get("checks", []))
        add(ds, "9", "uyarı ↔ ölçüm: önizleme aralığı ayardan sapıyor", "mandibula", "uyarı", f"uyarı={warned_fit}, ölçülen medyan {pv['gap_median']:.2f} mm", "sapma varsa uyarı", warned_fit or abs(pv["gap_median"] - m["mandible"]["clear"]) <= TH["gap_tol"])


def repeat_rows(ds, rep):
    pairs = rep["pairs"]
    add(ds, "1", "plan JSON aynı (tüm çalıştırmalar)", "tümü", "plan", all(p["plan_identical"] for p in pairs), "aynı", all(p["plan_identical"] for p in pairs), f"{rep['n']} çalıştırma")
    for k, lab in (("planes", "kesi düzlemleri"), ("screws", "vida konum/eksen"), ("fib", "fibula segment boy/açı"), ("result", "guide sonuç sayıları")):
        v = mx([p.get(f"{k}_maxdiff") for p in pairs])
        mism = sorted(set(sum([p.get(f"{k}_mismatch", []) for p in pairs], [])))
        add(ds, "1", f"{lab}: en büyük fark", "tümü", "plan", v, f"≤ {TH['rep_mm']} (mm/° )", (v or 0) <= TH["rep_mm"] and not mism, ("eşleşmeyen: " + ", ".join(mism[:5])) if mism else "")
    for name, it in rep.get("stl", {}).items():
        hd = mx([x.get("hausdorff") for x in it["runs"]])
        same = all(x.get("identical_bytes") for x in it["runs"])
        add(ds, "1", f"STL tekrar: Hausdorff maks ({name})", "mandibula" if name.startswith("m_") else "fibula", "server" if "server" in name else "preview", hd, f"≤ {TH['rep_mm']} mm", hd is not None and hd <= TH["rep_mm"],
            ("bayt bayt aynı" if same else "baytlar farklı") + f", hacim {it['volume_r1']:.1f} mm³")


def pipeline_rows(ds, pm, ref):
    rep = pm.get("repeat")
    if rep:
        add(ds, "1", "plan.json aynı (tüm çalıştırmalar)", "tümü", "plan", rep["plan_identical"], "aynı", rep["plan_identical"])
        for name in ("guide_fibula.stl", "guide_mandible_a.stl", "guide_mandible_b.stl"):
            hd = mx([x["hausdorff"] for x in rep[name]])
            add(ds, "1", f"STL tekrar: Hausdorff maks ({name})", name, "pipeline", hd, f"≤ {TH['rep_mm']} mm", hd <= TH["rep_mm"], "bayt bayt aynı" if all(x["identical_bytes"] for x in rep[name]) else "baytlar farklı")
    M = pm["metrics"]
    for name, r in M["guides"].items():
        blk = dict(clear=M["args"]["clearance"], wall=M["args"]["wall"], server=dict(quality=r["quality"], fit=r["fit"], seat_ct=r["seat_ct"], slots=r["slots"], wall=r["wall"], screws=[]))
        guide_rows(ds, name, blk, ref, 1, screws_expected=False)
        for k, h in enumerate(r.get("holes", [])):
            if h.get("entry") is None and "in_bone_frac" not in h:
                add(ds, "5", f"delik {k + 1} ekseni kemiğe ulaşıyor", name, "pipeline", False, "evet", False)
                continue
            add(ds, "5", f"delik {k + 1}: eksen kemikte (10 mm vida) / delik açık", name, "pipeline", h["in_bone_frac"], f"≥ {TH['inbone']}, kapalı ≤0.01",
                h["in_bone_frac"] >= TH["inbone"] and h["hole_blocked_frac"] <= 0.01, f"delik kapalı oranı {h['hole_blocked_frac']:.2f}; kesiye mesafe {h.get('min_plane_clearance_mm', float('nan')):.1f} mm")
    for name, r in M["guides"].items():
        c = r.get("cleanup") or {}
        if "dropped_islands_mm3" in c:
            # a dropped piece is fine when the pipeline says so (surgiguide.guides._largest warns above DROP_WARN_MM3)
            warned = "dropped" in str(c.get("warning", ""))
            add(ds, "6", "temizlikte atılan parça hacmi (_largest)", name, "pipeline", c["dropped_islands_mm3"], "0 mm³ ya da uyarılı", c["dropped_islands_mm3"] <= 1.0 or warned,
                f"temizlik öncesi {c.get('pieces_before_cleanup')} parça; " + ("uyarı veriliyor" if warned else "uyarı verilmiyor"))
    fm = dict(M["fib_match"]); fm["kerf"] = M["args"]["kerf"]
    fibmatch_rows(ds, fm, pipeline=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cfg", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cfg = json.load(open(a.cfg))
    for ds, c in cfg.items():
        ref = c.get("ref", "app")
        if c["type"] == "browser":
            if c.get("repeat"):
                repeat_rows(ds, json.load(open(c["repeat"])))
            m = json.load(open(c["run"] + "/metrics.json"))
            if m.get("mandible"):
                guide_rows(ds, "mandibula", m["mandible"], ref, c.get("mand_bodies", m["mandible"].get("expect_bodies", 1)), app_seat_free=((m.get("result") or {}).get("seat") or {}).get("free"))
            if m.get("bar"):
                b = m["bar"]; h = b["preview_vs_server"]; q = b["quality"]["server"]
                add(ds, "8", "köprü: önizleme ↔ sunucu STL Hausdorff (maks / p99 / ort.)", "köprü", "preview-server", h["hausdorff"], f"p99 ≤ {TH['hd_p99']} mm (öneri)", h["p99"] <= TH["hd_p99"], f"p99 {h['p99']:.2f}, ort {h['mean']:.2f} mm, hacim farkı %{h['vol_diff_pct']:.1f}")
                add(ds, "6", "köprü su geçirmez + manifold, tek parça", "köprü", "server", f"wt={q['watertight']} nm={q['nonmanifold_edges']} parça={q['bodies']}", "hepsi doğru, 1",
                    q["watertight"] and q["nonmanifold_edges"] == 0 and q["bodies"] == 1)
            if m.get("fibula_guide"):
                guide_rows(ds, "fibula", m["fibula_guide"], ref, 1)
            if m.get("fib_match"):
                fibmatch_rows(ds, m["fib_match"])
            warn_rows(ds, m)
        elif c["type"] == "pipeline":
            pipeline_rows(ds, json.load(open(c["file"])), ref)
    with open(a.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(len(rows), "rows ->", a.out)
