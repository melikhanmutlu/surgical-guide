#!/bin/sh
# Runs every unit suite in this folder against this checkout (SG_REPO overrides the checkout path).
# Prints one summary line per suite; full logs go to a temporary folder (printed at the end). Exits 1 when any suite
# fails or runs longer than SUITE_TIMEOUT seconds (default 900), so CI and tests/run_all.sh see the failure.
#   sh run_all.sh
cd "$(dirname "$0")" || exit 1
LOG=$(mktemp -d)
TO="${SUITE_TIMEOUT:-900}"
fail=0
for t in test_runner.mjs test_mainflow.mjs test_geom.mjs test_seat.mjs test_guide.mjs test_guide_mesh.mjs test_codecs.mjs test_unzip.mjs test_modules.mjs test_i18n.mjs test_i18n_cover.mjs test_i18n_order.mjs test_ui_static.mjs test_xss.mjs test_state.mjs test_load.mjs test_adaptive.mjs test_longres.mjs test_reopen.mjs test_layer_names.mjs test_plate.mjs test_fibplan.mjs test_d5_fib.mjs test_d7_open.mjs test_flow.mjs test_flow2.mjs test_d6_gemini.mjs test_d4_app.mjs test_d4_app2.mjs test_d4_last.mjs test_auth_prod.mjs test_ankle.mjs test_ankle_real.mjs test_ankle_m1.mjs test_anklm.mjs test_ankmirror.mjs test_ankscrew.mjs test_ankguide.mjs test_ankguide_m6.mjs test_ankle_m7.mjs test_refcmp.mjs test_guide_export.mjs test_quality_gate.mjs test_progress.mjs test_metrics.mjs test_slot.mjs test_legqc.mjs test_metalqc.mjs test_editprod.mjs test_brushcursor.mjs test_canal.mjs test_jaw.mjs test_clinical.mjs test_fibcurve.mjs test_errprop.mjs test_postop.mjs test_slicenav.mjs; do
  timeout "$TO" node "$t" > "$LOG/$t.log" 2>&1; rc=$?
  [ "$rc" = 0 ] || fail=1
  printf '== %-20s rc=%s  %s\n' "$t" "$rc" "$(grep -E 'passed, [0-9]+ failed' "$LOG/$t.log" | tail -1)"
done
timeout "$TO" python3 -I test_surgiguide.py > "$LOG/test_surgiguide.log" 2>&1; rc=$?
[ "$rc" = 0 ] || fail=1
printf '== %-20s rc=%s  %s\n' test_surgiguide.py "$rc" "$(grep -E '^Ran |^(OK|FAILED)' "$LOG/test_surgiguide.log" | tr '\n' ' ')"
echo "logs: $LOG"
[ "$fail" = 0 ] && echo "ALL UNIT SUITES PASSED" || echo "SOME UNIT SUITES FAILED"
exit $fail
