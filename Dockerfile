FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 HOST=0.0.0.0 YOLMED_WEB=/app/web YOLMED_DB=/data/yolmed_cases.sqlite
COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt
COPY surgiguide ./surgiguide
COPY seg_server.py yolmed_server.py ./
COPY web ./web
# Railway sets PORT; mount a volume at /data so cases survive redeploys
CMD ["python", "yolmed_server.py", "--backend", "threshold"]
