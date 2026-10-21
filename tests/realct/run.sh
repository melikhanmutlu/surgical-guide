#!/usr/bin/env bash
# Real-CT audit: plan the anonymised real case end to end in the browser (e2e scenario B), then measure the production
# STLs it delivers and compare them with the reviewed baseline (tools/realct_audit.py). ~40-60 min.
#   bash tests/realct/run.sh                    run, audit, report to $OUT/rapor.md; exit 1 when not printable or changed
#   WRITE_BASELINE=1 bash tests/realct/run.sh   after a reviewed guide change: make this run's STLs the new reference
#   KANIT=<dir of an earlier run> bash tests/realct/run.sh   audit an earlier run without running the browser again
# The anonymised CT and the baseline live outside the repository (VERI, BASELINE); without the CT the audit is skipped.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
AUDIT=/mnt/project-files/surgical-guide-prototype/audit
export VERI="${VERI:-$AUDIT/denetim3/veri}"
BASELINE="${BASELINE:-$AUDIT/denetim6/realct_taban}"
OUT="${OUT:-${TMPDIR:-/tmp}/yolmed-realct/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
if [ -z "${KANIT:-}" ]; then
  [ -f "$VERI/mandibula_anon.zip" ] || { echo "anonim gerçek BT yok ($VERI); denetim atlandı"; exit 0; }
  export KANIT="$OUT/kanit"
  REPO="$REPO" PORT="${PORT:-8846}" ONLY=B E2E_SCRATCH="$OUT/e2e" bash "$REPO/tests/web/e2e/run_all.sh" | tee "$OUT/e2e.log"
  grep -q '^FAIL' "$OUT/e2e.log" && echo "UYARI: e2e senaryosunda başarısız adım var (e2e.log)"
fi
args=("$KANIT" --baseline "$BASELINE" --report "$OUT/rapor.md" --json "$OUT/sonuc.json")
[ "${WRITE_BASELINE:-0}" = 1 ] && args+=(--write-baseline)
python3 -I "$REPO/tools/realct_audit.py" "${args[@]}"; rc=$?
echo "rapor: $OUT/rapor.md"
exit $rc
