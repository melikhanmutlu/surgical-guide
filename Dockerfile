FROM python:3.12-slim
WORKDIR /app
# GIT_SHA: the commit being built (Railway passes RAILWAY_GIT_COMMIT_SHA at runtime too); shown in /health, replies and STL headers
ARG GIT_SHA=unknown
# MALLOC_ARENA_MAX=2: request threads share two malloc arenas, so the heap a guide job frees can be trimmed back to the OS
# (seg_server.release_memory) instead of staying resident per thread (tests/server/test_memory.py)
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 MALLOC_ARENA_MAX=2 HOST=0.0.0.0 YOLMED_WEB=/app/web YOLMED_DB=/data/yolmed_cases.sqlite \
    GIT_SHA=${GIT_SHA}
COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt
# the service runs as an unprivileged user; /data is the case store (mount a volume there so cases survive redeploys)
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin yolmed && mkdir -p /data && chown yolmed:yolmed /data
COPY surgiguide ./surgiguide
COPY seg_server.py yolmed_server.py docker-entrypoint.sh ./
COPY web ./web
# a volume mounted at /data by the platform is owned by root: the entrypoint (root) hands it to the service user and
# then runs the server as that user (setpriv); started as a non-root user it runs the server directly
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
# Railway sets PORT
CMD ["python", "yolmed_server.py", "--backend", "threshold"]
