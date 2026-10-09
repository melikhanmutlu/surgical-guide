"""Segmentation service for the guide studio (runs on the hospital's GPU server, never on the public internet).

The studio sends the (down-sampled) CT volume, the service answers with a label volume and the
structure names. Patient data stays inside the hospital network.

    python seg_server.py --backend totalseg --port 8800     # AI (TotalSegmentator / nnU-Net)
    python seg_server.py --backend threshold --port 8800    # no-GPU fallback for testing

Protocol
  GET  /health   -> {"backend": ..., "structures": [...]}
  POST /segment?nx=&ny=&nz=&sp=sx,sy,sz&origin=x,y,z&axes=9 numbers&structures=mandible,fibula
       body: int16 little-endian HU, x fastest (index = i + nx*(j + ny*k))
       -> body: uint8 labels in the same layout; header X-Structures: [{"label":1,"name":"mandible"}, ...]
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
from scipy import ndimage as ndi

from surgiguide.volume import Volume
from surgiguide import segment as seg

NAMES_TR = {"mandible": "Mandibula", "fibula": "Fibula"}


def run_threshold(vol, hu=250.0, keep=6):
    mask = vol.array > hu
    mask = ndi.binary_closing(mask, ndi.generate_binary_structure(3, 1), iterations=1)
    lab, n = ndi.label(mask)
    if n == 0:
        return np.zeros(vol.array.shape, np.uint8), []
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1][:keep]
    out = np.zeros(vol.array.shape, np.uint8)
    structs = []
    for rank, idx in enumerate(order, start=1):
        out[lab == idx + 1] = rank
        structs.append({"label": rank, "name": f"Kemik {rank} (eşik)"})
    return out, structs


def run_totalseg(vol, structures):
    out = np.zeros(vol.array.shape, np.uint8)
    structs = []
    for rank, name in enumerate(structures, start=1):
        m = seg.totalseg_bone(vol, name)
        out[m & (out == 0)] = rank
        structs.append({"label": rank, "name": NAMES_TR.get(name, name)})
    return out, structs


class Handler(BaseHTTPRequestHandler):
    backend = "threshold"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-Structures")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            self.send_error(404); return
        body = json.dumps({"backend": self.backend, "structures": list(seg.TOTALSEG_TASKS)}).encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/segment":
            self.send_error(404); return
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            nx, ny, nz = int(q["nx"]), int(q["ny"]), int(q["nz"])
            sp = [float(x) for x in q["sp"].split(",")]
            origin = [float(x) for x in q["origin"].split(",")]
            axes = np.array([float(x) for x in q["axes"].split(",")]).reshape(3, 3)
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            hu = np.frombuffer(raw, "<i2").reshape(nz, ny, nx).astype(np.float32)
        except (KeyError, ValueError) as e:
            self.send_error(400, f"bad request: {e}"); return
        vol = Volume(hu, sp, origin, axes.T)   # axes rows are the i, j, k unit vectors
        if self.backend == "totalseg":
            wanted = [s for s in q.get("structures", "mandible").split(",") if s in seg.TOTALSEG_TASKS]
            labels, structs = run_totalseg(vol, wanted)
        else:
            labels, structs = run_threshold(vol)
        body = np.ascontiguousarray(labels).tobytes()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Structures", json.dumps(structs, ensure_ascii=True))
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["threshold", "totalseg"], default="threshold")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8800)
    a = ap.parse_args()
    Handler.backend = a.backend
    print(f"segmentation service ({a.backend}) on http://{a.host}:{a.port}")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
