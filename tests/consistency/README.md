# Guide consistency harness

Ported from the Denetim 3/4 audits (`audit/denetim3/tutarlilik/harness`). It measures the guides the studio makes
(browser preview, the production STL the server builds from the same request, and the Python pipeline's guides)
against the bone and against each other, and writes one CSV row per metric (`tutarlilik.csv`, `KALDI` = failed).

```sh
sh tests/run_all.sh slow                                     # runs it as the "consistency" suite (sample + phantom, 2 runs)
python3 tests/consistency/consistency.py                     # the same, by hand; --keep keeps the work folder
python3 tests/consistency/consistency.py --edges --reps 3    # + edge cases (long resection, condyle, thresholds, split)
python3 tests/consistency/consistency.py --mandible-ct <dir> --fibula-ct <dir>   # + a real series (one per folder)
```

Exit code 1 when any row fails. Needs Playwright (`PW_MODULE`, default `/opt/node-tools/node_modules/playwright`) and
Chromium (`PLAYWRIGHT_BROWSERS_PATH`, default `/opt/pw-browsers`); without them the suite prints SKIP. Patient data is
never read unless given with `--mandible-ct` / `--fibula-ct`, and nothing is written into the repository.

| file | does |
|---|---|
| `consistency.py` | runs everything below in order, then `summarize.py` |
| `driver.mjs` | one fresh browser page per run (scenario JSON, see the file head); writes `run.json` and the STLs |
| `page_helpers.js` | evaluated in the page (`window.H`): plan, slots, screws, guides, and the production request(s) exactly as `productionSTL` sends them (one per piece of a two-guide layout, the bar separately, the preview's seating direction) |
| `gmetrics.py` | metrics: gap / contact / interference, seating sweep, slot angle / centre / width / opening, wall, screws, STL quality, Hausdorff |
| `analyze_run.py` | all metrics for one browser run -> `metrics.json` |
| `repeat.py` | repeatability across runs (plan and STL bytes) |
| `pipeline_run.py` | `run_pipeline.py --demo` N times and its guides measured the same way |
| `summarize.py` | -> `tutarlilik.csv`; thresholds in `TH` |

Expectations follow the current design: the mandible saw slot lies on the resected side (`kerfSide: 1`, the slot centre
`pSlot` is w/2 off the plane, the stump gap is `w/2 - |shift|` = 0); the fibula guide's slots lie outside the graft faces
and are as wide as the plan's slot (`slotW`, never narrower than the blade); the pipeline's slot is `rep.slot_mm` wide
(the blade rounded up to whole voxels) and its fibula holes are where `surgiguide.guides.fibula_screw_sites` drills them;
a two-guide layout is two bodies; a pipeline piece dropped with a warning is reported, not failed.
