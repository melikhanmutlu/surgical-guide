"""Summary of a sweep: <out>/tarama.csv (browser + pipeline rows, one per run, with OK / warn / fail verdicts) and
<out>/matris.md (region x length x side matrices per dataset, failure-pattern tables).

    python3 summarize.py --out <sweep out dir>

Verdicts (browser rows):
  mand_guide  fail: run not finished, no plan, guide pieces != expected (1, or 2 with 'iki guide'), no seating direction,
              or any critical check on the guide / cuts / screws; warn: any warning there; else OK
  fib_plan    fail: no fibula plan, or a critical segment check (segment < 20 mm, fibula too short, distal reserve);
              warn: cut angle / deviation / osteotomy warnings; else OK
  fib_guide   fail: no fibula guide, > 1 piece, no seating direction, or a critical fibula screw check; warn: contact / wrap lowered
  approval    fail (blocked): any critical check or image-quality critical, i.e. the package can never be approved as planned;
              else OK (item approvals and names are the surgeon's part, not counted)
Pipeline rows: fail = non-zero exit, warn = finished with warnings, OK otherwise.
"""
import argparse
import collections
import csv
import json
import os
import re

REGIONS = ["symphysis", "parasymphysis", "body", "angle", "ramus", "condyle"]
TR = {"symphysis": "simfiz", "parasymphysis": "parasimfiz", "body": "lateral gövde", "angle": "angulus", "ramus": "ramus", "condyle": "kondil dahil"}
SYM = {"OK": "✓", "warn": "~", "fail": "✗", "-": "·"}


def verdicts(r):
    status, checks = r["status"], r.get("checks", "")
    items = [c.strip() for c in checks.split(" | ") if c.strip()]
    crit = [c[6:] for c in items if c.startswith("crit: ")]
    warn = [c[6:] for c in items if c.startswith("warn: ")]
    fib_crit_plan = [c for c in crit if re.search(r"Fibula segmenti|Fibula yetmiyor|Distal korunan", c)]
    fib_crit_guide = [c for c in crit if re.search(r"Fibula guide|Fibula vidası", c)]
    fib_warn_plan = [c for c in warn if re.search(r"Fibula segmenti|sapıyor|Osteotomi|Fibula:", c)]
    fib_warn_guide = [c for c in warn if re.search(r"Fibula guide", c)]
    m_crit = [c for c in crit if c not in fib_crit_plan and c not in fib_crit_guide]
    m_warn = [c for c in warn if c not in fib_warn_plan and c not in fib_warn_guide and "Perforatör" not in c]
    want = 2 if r.get("split") == "1" else 1
    num = lambda k: (float(r[k]) if r.get(k) not in ("", None) else None)
    if status != "done" or r.get("plan_ok") != "1" or num("m_pieces") is None:
        mg = "fail"
    elif num("m_pieces") != want or num("m_seat_free") == 0 or m_crit:
        mg = "fail"
    else:
        mg = "warn" if m_warn else "OK"
    if r.get("f_active") != "1" or r.get("f_n") in ("", None) or not r.get("f_seg_lens"):
        fp = "fail"
    elif fib_crit_plan or (num("f_seg_min") is not None and num("f_seg_min") < 20):
        fp = "fail"
    else:
        fp = "warn" if fib_warn_plan else "OK"
    if r.get("f_active") != "1":
        fg = "fail"
    elif num("f_guide_pieces") is None or num("f_guide_pieces") != 1 or num("f_guide_seat_free") == 0 or fib_crit_guide:
        fg = "fail"
    else:
        fg = "warn" if fib_warn_guide else "OK"
    ap = "fail" if (status != "done" or r.get("approval_blocked") == "1") else "OK"
    return dict(v_mand_guide=mg, v_fib_plan=fp, v_fib_guide=fg, v_approval=ap, m_crit_msgs=" | ".join(m_crit), m_warn_msgs=" | ".join(m_warn),
                f_crit_msgs=" | ".join(fib_crit_plan + fib_crit_guide), f_warn_msgs=" | ".join(fib_warn_plan + fib_warn_guide))


def norm(msg):
    """a check message with its numbers removed, so the same pattern groups"""
    return re.sub(r"\d+([.,]\d+)?", "#", msg).strip()


def matrix(rows, lengths, key_fn, header, legend):
    out = [header, "", legend, "", "| bölge | taraf | " + " | ".join(f"{l} mm" for l in lengths) + " |", "|---|---|" + "---|" * len(lengths)]
    for reg in REGIONS:
        for side in ("L", "R"):
            cells = []
            for l in lengths:
                r = next((x for x in rows if x["region"] == reg and x["side"] == side and int(x["len"]) == l), None)
                cells.append(key_fn(r) if r else "·")
            if any(c != "·" for c in cells):
                out.append(f"| {TR[reg]} | {'sol' if side == 'L' else 'sağ'} | " + " | ".join(cells) + " |")
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    app_csv, pipe_csv = os.path.join(a.out, "tarama_app.csv"), os.path.join(a.out, "pipe", "tarama_pipe.csv")
    app = list(csv.DictReader(open(app_csv, encoding="utf-8"))) if os.path.exists(app_csv) else []
    pipe = list(csv.DictReader(open(pipe_csv, encoding="utf-8"))) if os.path.exists(pipe_csv) else []
    # one row per id (a rerun replaces the earlier row)
    app = list({r["id"]: r for r in app}.values()); pipe = list({r["id"]: r for r in pipe}.values())
    for r in app:
        r.update(verdicts(r)); r["tool"] = "app"
    for r in pipe:
        r["tool"] = "pipeline"; r["v_pipeline"] = {"ok": "OK"}.get(r["status"], r["status"])
    cols = ["tool"] + [c for c in (list(app[0].keys()) if app else [])] + [c for c in (list(pipe[0].keys()) if pipe else []) if c not in (app[0].keys() if app else [])]
    cols = list(dict.fromkeys(c for c in cols if c != "tool"))
    with open(os.path.join(a.out, "tarama.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["tool"] + cols, extrasaction="ignore"); w.writeheader()
        for r in sorted(app, key=lambda x: (x["dataset"], REGIONS.index(x["region"]), x["side"], int(x["len"]))) + sorted(pipe, key=lambda x: (x["dataset"], REGIONS.index(x["region"]), x["side"], int(x["len"]))):
            w.writerow(r)
    md = ["# Tarama matrisi", ""]
    md.append("Hücre: `M P G A` = mandibula guide'ı · fibula planı · fibula guide'ı · onay; ✓ uygun, ~ uyarı, ✗ başarısız/engelli, · koşulmadı.")
    for ds in sorted(set(r["dataset"] for r in app)):
        rows = [r for r in app if r["dataset"] == ds]
        lengths = sorted(set(int(r["len"]) for r in rows))
        md += [""] + matrix(rows, lengths, lambda r: " ".join(SYM[r[k]] for k in ("v_mand_guide", "v_fib_plan", "v_fib_guide", "v_approval")),
                            f"## Uygulama · {ds} ({len(rows)} koşu)",
                            "Sayılar: " + ", ".join(f"{k.replace('v_', '')} ✓ {sum(1 for r in rows if r[k] == 'OK')} / ~ {sum(1 for r in rows if r[k] == 'warn')} / ✗ {sum(1 for r in rows if r[k] == 'fail')}" for k in ("v_mand_guide", "v_fib_plan", "v_fib_guide", "v_approval")))
        # detail matrix: pieces / seat / fibula segments
        md += [""] + matrix(rows, lengths, lambda r: f"L{r['g_L']}{'·2g' if r.get('split') == '1' else ''}{'+k' if (r.get('bar') or 'yok').split(':')[0] != 'yok' else ''} p{r['m_pieces']} s{r['m_seat_free']}/{r['m_seat_dirs']} · f{r['f_n']}:{r['f_seg_min']} g{r['f_guide_pieces']}/{r['f_guide_seat_free']}" if r["status"] == "done" else r["status"],
                            f"### {ds} · ayrıntı", "L = guide boyu (2g: iki guide, +k: bağlantı köprüsü), p = parça, s = uygun takma yönü / denenen; f = segment sayısı : en kısa segment mm, g = fibula guide parçası / uygun yön")
        # patterns
        pat = collections.defaultdict(list)
        for r in rows:
            for k in ("m_crit_msgs", "f_crit_msgs"):
                for m in filter(None, r[k].split(" | ")):
                    pat[("crit", norm(m))].append(r)
            for k in ("m_warn_msgs", "f_warn_msgs"):
                for m in filter(None, r[k].split(" | ")):
                    pat[("warn", norm(m))].append(r)
        md += ["", f"### {ds} · en sık kontrol mesajları", "", "| tür | mesaj (sayılar #) | koşu | bölgeler | boylar |", "|---|---|---|---|---|"]
        for (kind, m), rs in sorted(pat.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:25]:
            regs = collections.Counter(TR[r["region"]] for r in rs); lens = sorted(set(int(r["len"]) for r in rs))
            md.append(f"| {kind} | {m[:110]} | {len(rs)} | {', '.join(f'{k} {v}' for k, v in regs.most_common())} | {', '.join(map(str, lens))} |")
        # by length / region fail rates
        md += ["", f"### {ds} · boya ve bölgeye göre ✗ oranı (mandibula guide'ı / fibula planı / fibula guide'ı)", "", "| | " + " | ".join(f"{l} mm" for l in lengths) + " |", "|---|" + "---|" * len(lengths)]
        for reg in REGIONS:
            rr = [r for r in rows if r["region"] == reg]
            if not rr:
                continue
            cells = []
            for l in lengths:
                x = [r for r in rr if int(r["len"]) == l]
                cells.append("·" if not x else "/".join(f"{sum(1 for r in x if r[k] == 'fail')}/{len(x)}" for k in ("v_mand_guide", "v_fib_plan", "v_fib_guide")))
            md.append(f"| {TR[reg]} | " + " | ".join(cells) + " |")
        md += ["", "Süreler (medyan, sn): " + ", ".join(f"{k} {sorted(float(r[k]) for r in rows if r.get(k))[len([r for r in rows if r.get(k)]) // 2]:.1f}" for k in ("t_load_m_s", "t_plan_s", "t_load_f_s", "t_fib_s", "t_total_s") if any(r.get(k) for r in rows))]
    for ds in sorted(set(r["dataset"] for r in pipe)):
        rows = [r for r in pipe if r["dataset"] == ds]
        lengths = sorted(set(int(r["len"]) for r in rows))
        md += [""] + matrix(rows, lengths, lambda r: f"{SYM[r['v_pipeline']] if r['v_pipeline'] in SYM else r['v_pipeline']} n{r['n_segments'] or '-'}:{r['seg_min'] or '-'}" + (f" wt{r['guide_fib_watertight']}{r['guide_ma_watertight']}{r['guide_mb_watertight']} b{r['guide_fib_bodies']}{r['guide_ma_bodies']}{r['guide_mb_bodies']}" if r.get("guide_fib_bodies") else "") + (f" ({r['error'][:40]})" if r.get("error") else ""),
                            f"## Pipeline · {ds} ({len(rows)} koşu)", "✓ uyarısız, ~ uyarılı, ✗ hata; n = segment sayısı : en kısa segment (mm); wt = su geçirmez (fibula, mand a, mand b), b = gövde sayısı")
        pat = collections.Counter()
        for r in rows:
            for m in filter(None, r["warnings"].split(" | ")):
                pat[norm(m)] += 1
            if r.get("error"):
                pat["HATA " + norm(r["error"])] += 1
        md += ["", "| mesaj | koşu |", "|---|---|"] + [f"| {m[:140]} | {n} |" for m, n in pat.most_common(20)]
    open(os.path.join(a.out, "matris.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    print(f"{len(app)} app rows, {len(pipe)} pipeline rows -> tarama.csv, matris.md")


if __name__ == "__main__":
    main()
