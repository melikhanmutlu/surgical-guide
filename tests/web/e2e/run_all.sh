#!/usr/bin/env bash
# Denetim 3 · e2e: yerel sunucuyu başlatır, tüm senaryoları sırayla (tek tarayıcı) çalıştırır, kanit/tablo.md üretir.
#   REPO=/home/user/surgical-guide PORT=8840 bash run_all.sh            # hepsi (gerçek BT dahil, ~60-90 dk)
#   ONLY="A1 A2" bash run_all.sh                                         # seçili senaryolar (A1 A2 A3 C D F E Y3 B)
#   D_LIVE=0 bash run_all.sh                                              # canlı site duman testini atla
#   KANIT=/başka/yer bash run_all.sh                                      # kanıt klasörü (varsayılan ../kanit, depoda yok sayılır)
#   YOLMED_TOKEN=gizli bash run_all.sh                                    # sunucu erişim anahtarıyla; tarayıcı anahtarı diyaloğa yazar
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-/home/user/surgical-guide}"
PORT="${PORT:-8840}"
export E2E_SCRATCH="${E2E_SCRATCH:-${TMPDIR:-/tmp}/yolmed-e2e}"
export BASE="http://127.0.0.1:${PORT}"
export NODE_PATH="${NODE_PATH:-/opt/node-tools/node_modules}"
mkdir -p "$E2E_SCRATCH/db"
DB="$E2E_SCRATCH/db/cases_run_$(date +%s).sqlite"
export KANIT="${KANIT:-$HERE/../kanit}"
[ -n "${YOLMED_TOKEN:-}" ] && export E2E_TOKEN="$YOLMED_TOKEN"
export SERVER_CMD="cd '$REPO' && PYTHONDONTWRITEBYTECODE=1 YOLMED_TOKEN='${YOLMED_TOKEN:-}' exec python3 yolmed_server.py --host 127.0.0.1 --port $PORT --db '$DB' --web '$REPO/web' >> '$E2E_SCRATCH/server.log' 2>&1"
start_server() {
  if curl -s -o /dev/null -w '%{http_code}' "$BASE/health" | grep -q 200; then
    export SERVER_PID="$(pgrep -f "yolmed_server.py.*--port $PORT" | head -1)"; return; fi
  bash -c "$SERVER_CMD" & export SERVER_PID=$!
  for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/health" && break; sleep 0.5; done
}
ONLY="${ONLY:-A1 A2 A3 C D F E Y3 B}"
for s in $ONLY; do
  start_server
  case $s in
    A1) f=A1_flow.js ;; A2) f=A2_persist.js ;; A3) f=A3_i18n_ui.js ;; B) f=B_real.js ;; C) f=C_edge.js ;; D) f=D_small_live.js ;; F) f=F_small_screen.js ;; E) f=E_roll.js ;; Y3) f=Y3_plate_undo.js ;;
    *) echo "bilinmeyen senaryo $s"; continue ;;
  esac
  echo "=== $s ($f) ==="
  t0=$(date +%s)
  timeout 7200 node "$HERE/$f" 2>&1 | grep -E '^(PASS|FAIL|INFO|==)'
  echo "--- $s $(( $(date +%s) - t0 )) s"
done
start_server
node "$HERE/tablo.js"
