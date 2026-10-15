#!/bin/sh
# Runs the service as the unprivileged user "yolmed" (Dockerfile). A volume mounted at /data is root-owned on most
# platforms (Railway): as root, give the case-store folder to that user first, then drop privileges for good.
set -e
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$(dirname "${YOLMED_DB:-/data/yolmed_cases.sqlite}")"
    chown yolmed:yolmed "$(dirname "${YOLMED_DB:-/data/yolmed_cases.sqlite}")"
    for f in "${YOLMED_DB:-/data/yolmed_cases.sqlite}"*; do [ -e "$f" ] && chown yolmed:yolmed "$f"; done
    exec setpriv --reuid=yolmed --regid=yolmed --init-groups --inh-caps=-all -- "$@"
fi
exec "$@"
