#!/bin/sh
# Runs every unit suite in this folder against the audited checkout (SG_REPO, default /home/user/surgical-guide).
# Prints one summary line per suite; full logs go to a temporary folder (printed at the end).
#   bash run_all.sh
cd "$(dirname "$0")" || exit 1
LOG=$(mktemp -d)
for t in test_geom.mjs test_seat.mjs test_guide.mjs test_guide_mesh.mjs test_codecs.mjs test_unzip.mjs test_modules.mjs test_i18n.mjs test_i18n_cover.mjs test_i18n_order.mjs test_ui_static.mjs test_xss.mjs test_state.mjs test_load.mjs test_adaptive.mjs test_longres.mjs test_reopen.mjs test_plate.mjs test_fibplan.mjs test_d4_app.mjs; do
  node "$t" > "$LOG/$t.log" 2>&1; rc=$?
  printf '== %-20s rc=%s  %s\n' "$t" "$rc" "$(grep -E 'passed, [0-9]+ failed' "$LOG/$t.log" | tail -1)"
done
python3 -I test_surgiguide.py > "$LOG/test_surgiguide.log" 2>&1; rc=$?
printf '== %-20s rc=%s  %s\n' test_surgiguide.py "$rc" "$(grep -E '^Ran |^(OK|FAILED)' "$LOG/test_surgiguide.log" | tr '\n' ' ')"
echo "logs: $LOG"
