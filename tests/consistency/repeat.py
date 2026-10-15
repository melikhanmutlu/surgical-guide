"""Repeatability across browser runs of the same scenario (fresh page each): plan JSON, planes, screws, fibula
segments, guide STL bytes / volume / Hausdorff against run 1.
    python3 repeat.py <out.json> <run1> <run2> ..."""
import hashlib
import json
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gmetrics as gm  # noqa: E402


def flat(o, pre=""):
    """flatten numbers in nested json (for max-abs-diff); strings compared for equality."""
    out = {}
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("at", "t", "seconds", "ms", "wall_ms", "console", "stl", "data", "_hist"):
                continue
            out.update(flat(v, f"{pre}.{k}"))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            out.update(flat(v, f"{pre}[{i}]"))
    else:
        out[pre] = o
    return out


def maxdiff(a, b):
    fa, fb = flat(a), flat(b)
    keys = set(fa) | set(fb)
    worst, wk, mism = 0.0, None, []
    for k in keys:
        x, y = fa.get(k), fb.get(k)
        if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool):
            d = abs(float(x) - float(y))
            if d > worst:
                worst, wk = d, k
        elif x != y:
            mism.append(k)
    return worst, wk, sorted(mism)[:20]


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None


def main(out, runs):
    D = [gm.load_run(r) for r in runs]
    res = dict(runs=runs, n=len(runs))
    sel = lambda d: dict(plan=d.get("plan"), planes=d.get("planes"), screws=d.get("screws"), frame=d.get("frame"), g=d.get("g"),
                         result={k: v for k, v in (d.get("result") or {}).items() if k != "seat"},
                         fib=None if not d.get("fib") else dict(segs=d["fib"].get("segs"), plan=d["fib"].get("plan"), guide=None if not d["fib"].get("guide") else
                                                                 dict(planes=d["fib"]["guide"]["planes"], screws=d["fib"]["guide"]["screws"], g=d["fib"]["guide"]["g"])))
    base = sel(D[0])
    rows = []
    for r, d in zip(runs[1:], D[1:]):
        cur = sel(d)
        row = dict(run=r, plan_identical=json.dumps(base["plan"], sort_keys=True) == json.dumps(cur["plan"], sort_keys=True))
        for k in ("plan", "planes", "screws", "frame", "result", "fib"):
            w, wk, mism = maxdiff(base[k], cur[k])
            row[f"{k}_maxdiff"] = w; row[f"{k}_worst_key"] = wk; row[f"{k}_mismatch"] = mism
        rows.append(row)
    res["pairs"] = rows
    stl = {}
    for name in ("m_guide_preview.stl", "m_guide_server.stl", "f_guide_preview.stl", "f_guide_server.stl"):
        p1 = os.path.join(runs[0], name)
        if not os.path.exists(p1):
            continue
        G1 = gm.GuideMesh(p1)
        items = []
        for r in runs[1:]:
            pk = os.path.join(r, name)
            if not os.path.exists(pk):
                items.append(dict(run=r, missing=True)); continue
            same = sha(pk) == sha(p1)
            if same:
                items.append(dict(run=r, identical_bytes=True, hausdorff=0.0, mean=0.0, vol_diff_pct=0.0))
            else:
                Gk = gm.GuideMesh(pk)
                items.append(dict(run=r, identical_bytes=False, **gm.hausdorff(Gk, G1)))
        stl[name] = dict(volume_r1=G1.quality["volume"], runs=items)
    res["stl"] = stl
    with open(out, "w") as fh:
        json.dump(gm.strip(res), fh, indent=1)
    print(json.dumps({k: (v if k != "pairs" else [{kk: vv for kk, vv in p.items() if not kk.endswith("mismatch")} for p in v]) for k, v in res.items() if k != "stl"}, indent=1)[:3000])
    print(json.dumps({k: [{kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in it.items() if kk != "run"} for it in v["runs"]] for k, v in stl.items()}, indent=0))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
