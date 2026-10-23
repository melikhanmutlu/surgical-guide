#!/bin/sh
# Every automated test of the repository; synthetic volumes and the built-in sample only, no patient data.
#   sh tests/run_all.sh          fast suites (~5 min on 4 cores; what CI runs)
#   sh tests/run_all.sh slow     the slow ones: slow-client timing, guide-quality stress, STL vs browser preview,
#                                browser unit suites, the guide consistency harness on the sample + phantom
#                                (tests/consistency; Playwright + Chromium, skipped without them) (~60-90 min)
#   sh tests/run_all.sh all      both
# Each suite runs under SUITE_TIMEOUT seconds (default 1200). Exits 1 when any suite fails; prints a summary.
# The browser end-to-end scenarios (tests/web/e2e, Playwright) are separate: see tests/web/e2e/README.md.
# The real-CT audit (anonymised real case end to end, production STLs vs a reviewed baseline) is separate too:
# bash tests/realct/run.sh (tools/realct_audit.py).
cd "$(dirname "$0")/.." || exit 1
MODE="${1:-fast}"
TO="${SUITE_TIMEOUT:-1200}"
export PYTHONDONTWRITEBYTECODE=1
fail=0; summary=""
suite() {   # suite <name> <command...>
  name=$1; shift
  echo "=== $name"
  t0=$(date +%s)
  timeout "$TO" "$@"; rc=$?
  dt=$(( $(date +%s) - t0 ))
  [ "$rc" = 0 ] || fail=1
  summary="$summary
  $( [ "$rc" = 0 ] && echo "ok  " || echo "FAIL" ) $name (rc=$rc, ${dt}s)"
}
if [ "$MODE" = fast ] || [ "$MODE" = all ]; then
  suite separate.mjs        node tests/test_separate.mjs
  suite unit/runner         node tests/web/unit/test_runner.mjs
  suite unit/ankle          node tests/web/unit/test_ankle.mjs
  suite unit/ankguide       node tests/web/unit/test_ankguide.mjs
  suite bones               python3 tests/test_bones.py
  suite pipeline            python3 tests/test_pipeline.py
  suite server/http         python3 tests/server/test_http_security.py
  suite server/mesh_repair  python3 tests/server/test_mesh_repair.py
  suite server/print_checks python3 tests/server/test_print_checks.py
  suite server/audit        python3 tests/server/test_server_audit.py
  suite server/memory       python3 tests/server/test_memory.py
  suite server/guide_progress python3 tests/server/test_guide_progress.py
  suite server/slot_boss    python3 tests/server/test_slot_boss.py
  suite yolmed_server       python3 test_yolmed_server.py
  suite unit/surgiguide     python3 -I tests/web/unit/test_surgiguide.py
  suite ct_samples          python3 -I tests/test_ct_samples.py
  suite realct_audit        python3 tests/test_realct_audit.py
fi
if [ "$MODE" = slow ] || [ "$MODE" = all ]; then
  suite server/slow_clients python3 tests/server/test_slow.py
  suite server/guide_quality python3 tests/server/test_guide_quality.py
  suite server_preview      python3 tests/test_server_preview.py
  # ~25 browser unit suites, each under its own limit inside: one SUITE_TIMEOUT for all of them ran out on a loaded
  # 4-core machine (Denetim 4 verification), so the wrapper gets three
  TO0=$TO; TO=$(( TO * 3 )); suite unit/all sh tests/web/unit/run_all.sh; TO=$TO0
  # preview, production STL and pipeline guides against the bone and each other (synthetic data, 2 runs each)
  TO0=$TO; TO=$(( TO * 4 )); suite consistency python3 tests/consistency/consistency.py --reps 2 --port "${CONSISTENCY_PORT:-8861}"; TO=$TO0
fi
echo "=== summary ($MODE)$summary"
exit $fail
