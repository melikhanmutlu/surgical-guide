#!/usr/bin/env bash
# Resection sweep, one command: starts the local server, runs the browser sweep (sample + real CT), the pipeline sweep
# (--demo phantom + real CT) and the summary (tarama.csv + matris.md).
#   SG_REPO=/home/user/surgical-guide DATA=<dir with m_bone/ and f_125/ (one DICOM series each)> OUT=<out dir> bash run_sweep.sh
#   ONLY="app pipe sum"          # steps (default all): app = browser sweep, pipe = run_pipeline.py sweep, sum = summary
#   DATASETS=sample,real         # browser datasets; PIPE_DATASETS=demo,real
#   REGIONS=... LENGTHS=... SIDES=...   # grid filters (see sweep.js); PIPE_LENGTHS=20,45,80
#   PORT=8870 BASE=http://127.0.0.1:$PORT (an already running server is reused)
#   VERI=<dir with mandibula_anon.zip + fibula_anon.zip>: when DATA/m_bone or DATA/f_125 is missing the series are unzipped
#   into DATA (series '0.625mm Bone' and '1.25mm' only; DATA should be a scratch folder, never the audit folder)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SG_REPO="${SG_REPO:-$(cd "$HERE/../.." && pwd)}"
SCRATCH="${SCRATCH:-${TMPDIR:-/tmp}/sweep_scratch}"
DATA="${DATA:-$SCRATCH/ct}"
OUT="${OUT:-$SCRATCH/out}"
PORT="${PORT:-8870}"
export BASE="${BASE:-http://127.0.0.1:$PORT}"
export SG_REPO OUT
export MAND_DIR="${MAND_DIR:-$DATA/m_bone}" FIB_DIR="${FIB_DIR:-$DATA/f_125}"
export CDN_CACHE="${CDN_CACHE:-$SCRATCH/cdn}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PW_MODULE="${PW_MODULE:-/opt/node-tools/node_modules/playwright}"
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$SCRATCH/db" "$OUT" "$CDN_CACHE"
ONLY="${ONLY:-app pipe sum}"
DATASETS="${DATASETS:-sample,real}"
PIPE_DATASETS="${PIPE_DATASETS:-demo,real}"

# real CT series from the zips when needed
if { [[ "$DATASETS" == *real* ]] || [[ "$PIPE_DATASETS" == *real* ]]; } && { [ ! -d "$MAND_DIR" ] || [ ! -d "$FIB_DIR" ]; }; then
  if [ -n "${VERI:-}" ]; then
    echo "unzipping the real CT series into $DATA"
    python3 -I "$HERE/extract_series.py" --zip "$VERI/mandibula_anon.zip" --series "0.625mm Bone" --out "$MAND_DIR"
    python3 -I "$HERE/extract_series.py" --zip "$VERI/fibula_anon.zip" --series "1.25mm" --out "$FIB_DIR"
  else
    echo "real CT series not found ($MAND_DIR, $FIB_DIR) and VERI not set; running without the real dataset"
    DATASETS="${DATASETS//real/}"; DATASETS="${DATASETS//,,/,}"; DATASETS="${DATASETS#,}"; DATASETS="${DATASETS%,}"
    PIPE_DATASETS="${PIPE_DATASETS//real/}"; PIPE_DATASETS="${PIPE_DATASETS//,,/,}"; PIPE_DATASETS="${PIPE_DATASETS#,}"; PIPE_DATASETS="${PIPE_DATASETS%,}"
  fi
fi
export DATASETS PIPE_DATASETS

start_server() {
  if curl -s -o /dev/null -w '%{http_code}' "$BASE/health" | grep -q 200; then return; fi
  ( cd "$SG_REPO" && exec python3 yolmed_server.py --host 127.0.0.1 --port "$PORT" --db "$SCRATCH/db/cases_$(date +%s).sqlite" --web "$SG_REPO/web" >> "$SCRATCH/server.log" 2>&1 ) &
  SERVER_PID=$!
  for i in $(seq 1 60); do curl -s -o /dev/null "$BASE/health" && break; sleep 0.5; done
}
SERVER_PID=""
for s in $ONLY; do
  case $s in
    app)  start_server; echo "=== browser sweep ($DATASETS) ==="; node "$HERE/sweep.js" ;;
    pipe) echo "=== pipeline sweep ($PIPE_DATASETS) ==="; python3 "$HERE/pipeline_sweep.py" --repo "$SG_REPO" --out "$OUT/pipe" --datasets "$PIPE_DATASETS" --mand-dir "$MAND_DIR" --fib-dir "$FIB_DIR" ${PIPE_LENGTHS:+--lengths "$PIPE_LENGTHS"} ${REGIONS:+--regions "$REGIONS"} ${SIDES:+--sides "$SIDES"} ;;
    sum)  echo "=== summary ==="; python3 "$HERE/summarize.py" --out "$OUT" ;;
    *) echo "unknown step $s" ;;
  esac
done
[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
echo "done -> $OUT"
