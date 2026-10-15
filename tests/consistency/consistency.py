"""Guide consistency harness (ported from the Denetim 3/4 audits): the browser preview guide, the production STL the
server builds from the same request, and the Python pipeline, measured against the bone and against each other.

    python3 tests/consistency/consistency.py                       # synthetic part: built-in sample + phantom
    python3 tests/consistency/consistency.py --reps 3 --edges      # + edge cases on the sample
    python3 tests/consistency/consistency.py --mandible-ct <dir> --fibula-ct <dir>   # + a real series (one per folder)

Steps (sequential, one browser at a time; nothing is written into the repository):
  1. start yolmed_server.py from the repo on 127.0.0.1:<port> with its DB in <work>
  2. built-in sample: <reps> fresh browser runs -> repeat.py + analyze_run.py on run 1
  3. synthetic phantom: pipeline_run.py (run_pipeline.py --demo x <reps>), then the same phantom DICOM in the browser
  4. real CT (optional), edge cases (optional)
  5. summarize.py -> <work>/tutarlilik.csv; exit 1 when any row fails (KALDI), 0 otherwise
Needs Playwright (PW_MODULE, default /opt/node-tools/node_modules/playwright) with Chromium (PLAYWRIGHT_BROWSERS_PATH,
default /opt/pw-browsers); without them it prints SKIP and exits 0 unless --strict. CDN scripts come from the
repository's vendored copies or one curl download into <work>/cdn (--cdn: an existing cache folder).
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = None   # set in main(): section images go under <work>/kesitler
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"))

# painted lesions (world mm). sample mandible: body centre line y = -38 + 0.0145 x^2 (z = 0); right ramus from (46,-7.3,0)
BODY = [[x, round(-38 + 0.0145 * x * x, 3), 0] for x in range(20, 47, 2)]
_d = (0.0, 0.35 / 1.0595, 1 / 1.0595)
RAMUS = lambda a, b: [[46.0, round(-7.3 + s * _d[1], 3), round(s * _d[2], 3)] for s in range(a, b + 1, 2)]
PHANTOM_LESION = [[x, round(-38 + 0.0145 * x * x, 3), 0] for x in range(16, 31, 2)]
REAL_LESION = [[18.0 + i, round(-48 + 1.6667 * i, 4), -70.0] for i in range(10)]
E1 = dict(mandible="sample", fibula="sample", lesion=dict(points=BODY + RAMUS(0, 10), radius=5))
EDGES = {"e1_long": E1,
         "e2_condyle": dict(mandible="sample", fibula="sample", condyle="R", lesion=dict(points=RAMUS(10, 30), radius=5)),
         "e3_thr200": dict(mandible="sample", fibula="sample", thr=200),
         "e3_thr350": dict(mandible="sample", fibula="sample", thr=350),
         "e4_fib1": dict(E1, fibN=1), "e4_fib2": dict(E1, fibN=2), "e4_fib3": dict(E1, fibN=3),
         "e5_split": dict(mandible="sample", fibula="sample", split=1)}


def sh(cmd, log, timeout=3600, cwd=None):
    t0 = time.time()
    with open(log, "w") as fh:
        rc = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, env=ENV, timeout=timeout, cwd=cwd).returncode
    print(f"  rc={rc} {time.time() - t0:.0f}s  {' '.join(cmd[:3])} ... -> {log}", flush=True)
    return rc


def browser(a, name, sc):
    out = os.path.join(a.work, "runs", name)
    sh(["node", os.path.join(HERE, "driver.mjs"), "--port", str(a.port), "--out", out, "--cdn", a.cdn, "--scenario", json.dumps(sc)],
       os.path.join(a.work, f"{name}.log"), timeout=1800)
    return out


def analyze(a, run, img=True):
    cmd = [sys.executable, os.path.join(HERE, "analyze_run.py"), run] + (["--img", os.path.join(a.work, "kesitler")] if img and a.images else [])
    sh(cmd, run + "_an.log", timeout=3600)


def series(a, name, sc, reps):
    runs = [browser(a, f"{name}_r{i + 1}", sc) for i in range(reps)]
    analyze(a, runs[0])
    if reps > 1:
        sh([sys.executable, os.path.join(HERE, "repeat.py"), os.path.join(a.work, "runs", f"repeat_{name}.json")] + runs, os.path.join(a.work, f"repeat_{name}.log"))
    return runs[0], (os.path.join(a.work, "runs", f"repeat_{name}.json") if reps > 1 else None)


def playwright_ok():
    pw = os.environ.get("PW_MODULE", "/opt/node-tools/node_modules/playwright")
    browsers = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    return os.path.exists(os.path.join(pw, "index.mjs")) and os.path.isdir(browsers) and any(n.startswith("chromium") for n in os.listdir(browsers))


def failed_rows(csv_path):
    import csv
    with open(csv_path, newline="") as fh:
        return [r for r in csv.DictReader(fh) if r["result"] == "KALDI"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=REPO); ap.add_argument("--work", default=None, help="scratch folder (default: a new temporary one)")
    ap.add_argument("--cdn", default=None); ap.add_argument("--mandible-ct"); ap.add_argument("--fibula-ct"); ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--port", type=int, default=8861); ap.add_argument("--edges", action="store_true"); ap.add_argument("--images", action="store_true", help="section images (matplotlib)")
    ap.add_argument("--strict", action="store_true", help="fail instead of skipping when Playwright / Chromium are missing")
    ap.add_argument("--keep", action="store_true", help="keep the temporary work folder when everything passed")
    a = ap.parse_args()
    if not playwright_ok():
        print("SKIP consistency: Playwright with Chromium not found (PW_MODULE / PLAYWRIGHT_BROWSERS_PATH)", flush=True)
        sys.exit(1 if a.strict else 0)
    import shutil
    import tempfile
    tmp = not a.work
    a.work = os.path.abspath(a.work or tempfile.mkdtemp(prefix="yolmed-consistency-"))
    a.cdn = os.path.abspath(a.cdn or os.path.join(a.work, "cdn")); a.repo = os.path.abspath(a.repo)
    os.makedirs(os.path.join(a.work, "runs"), exist_ok=True)
    print("work folder:", a.work, flush=True)
    srv = subprocess.Popen([sys.executable, "yolmed_server.py", "--host", "127.0.0.1", "--port", str(a.port), "--db", os.path.join(a.work, "db.sqlite"), "--web", os.path.join(a.repo, "web")],
                           cwd=a.repo, env=dict(ENV, YOLMED_TOKEN="", YOLMED_ALLOWED_ORIGINS=""), stdout=open(os.path.join(a.work, "server.log"), "w"), stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{a.port}/", timeout=2); break
            except Exception:
                time.sleep(1)
        cfg = {}
        print("[1] sample", flush=True)
        r, rep = series(a, "sample", {}, a.reps)
        cfg["1-örnek vaka"] = dict(type="browser", run=r, repeat=rep, ref="app")
        print("[2] phantom pipeline", flush=True)
        pipe = os.path.abspath(os.path.join(a.work, "pipe", "default"))
        sh([sys.executable, os.path.join(HERE, "pipeline_run.py"), "--repo", a.repo, "--out", pipe, "--reps", str(a.reps)], os.path.join(a.work, "pipe_default.log"), timeout=7200)
        cfg["2-fantom pipeline"] = dict(type="pipeline", file=os.path.join(pipe, "pipeline_metrics.json"), ref="app")
        print("[2b] phantom in the browser", flush=True)
        ph = dict(mandible=dict(dicom=os.path.join(pipe, "r1", "dicom_head")), fibula=dict(dicom=os.path.join(pipe, "r1", "dicom_leg")),
                  lesion=dict(points=PHANTOM_LESION, radius=5))
        r, rep = series(a, "phantom", ph, a.reps)
        cfg["2-fantom tarayıcı"] = dict(type="browser", run=r, repeat=rep, ref="app")
        if a.mandible_ct and a.fibula_ct:
            print("[3] real CT", flush=True)
            rc = dict(mandible=dict(dicom=a.mandible_ct), fibula=dict(dicom=a.fibula_ct), lesion=dict(points=REAL_LESION, radius=5))
            r, rep = series(a, "real", rc, max(1, min(a.reps, 3)))
            cfg["3-gerçek BT"] = dict(type="browser", run=r, repeat=rep, ref="ct")
        if a.edges:
            print("[4] edge cases", flush=True)
            for name, sc in EDGES.items():
                run = browser(a, name, sc); analyze(a, run)
                cfg[f"9-{name}"] = dict(type="browser", run=run, ref="app")
            for n in (1, 4):
                p = os.path.abspath(os.path.join(a.work, "pipe", f"seg{n}"))
                sh([sys.executable, os.path.join(HERE, "pipeline_run.py"), "--repo", a.repo, "--out", p, "--reps", "1", "--extra", f"--segments {n}"],
                   os.path.join(a.work, f"pipe_seg{n}.log"), timeout=3600)
                cfg[f"9-pipeline {n} segment"] = dict(type="pipeline", file=os.path.join(p, "pipeline_metrics.json"), ref="app")
        cfgp = os.path.join(a.work, "datasets.json")
        json.dump(cfg, open(cfgp, "w"), indent=1)
        out = os.path.join(a.work, "tutarlilik.csv")
        rc = sh([sys.executable, os.path.join(HERE, "summarize.py"), "--cfg", cfgp, "--out", out], os.path.join(a.work, "summarize.log"))
    finally:
        srv.terminate()
    if rc or not os.path.exists(out):
        print("FAIL: summarize.py did not run (see", os.path.join(a.work, "summarize.log") + ")"); sys.exit(1)
    bad = failed_rows(out)
    for r in bad:
        print(f"KALDI  {r['dataset']} | {r['metric']} | {r['guide']} {r['variant']}: {r['value']} (eşik {r['threshold']}) {r['note']}")
    print(f"{len(bad)} failing rows -> {out}")
    if tmp and not bad and not a.keep:
        shutil.rmtree(a.work, ignore_errors=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
