"""Segmentation service for the guide studio, and the HTTP base every Yolmed endpoint shares (yolmed_server.py serves
/health and /segment through this Handler).

The studio sends the (down-sampled) CT volume, the service answers with a label volume and the structure names. Meant for a
hospital network; when it is reachable from the internet (the hosted demo) set YOLMED_TOKEN (see README, "Security").

    python seg_server.py --backend totalseg --port 8800     # AI (TotalSegmentator / nnU-Net)
    python seg_server.py --backend threshold --port 8800    # no-GPU fallback for testing

Protocol
  GET  /health   -> {"backend": ..., "structures": [...], "version": ...}
  POST /segment?nx=&ny=&nz=&sp=sx,sy,sz&origin=x,y,z&axes=9 numbers&structures=mandible,fibula
       body: int16 little-endian HU, x fastest (index = i + nx*(j + ny*k))
       -> body: uint8 labels in the same layout; header X-Structures: [{"label":1,"name":"mandible"}, ...]

Shared HTTP behaviour (environment variables, all optional)
  YOLMED_TOKEN                 every /segment, /cases* and /guide request needs `Authorization: Bearer <token>` (401 otherwise);
                               /health and the studio's static files stay open
  YOLMED_ALLOWED_ORIGINS       comma-separated origins (https://host:port) whose pages may call this server from another
                               origin (CORS); "*" = any. Default: none (same-origin only: the studio served by this server)
  YOLMED_ALLOW_PRIVATE_NETWORK 1 = answer Chrome's Private-Network preflight for the allowed origins (a public page that calls a
                               server inside the hospital network); off by default
  YOLMED_CSP_CONNECT           extra origins the studio may fetch from (e.g. a separate segmentation server), space-separated
  YOLMED_UPLOADS               request bodies held in memory at once (default 6); YOLMED_BODY_MAX_S overall upload limit (600 s)
"""
import argparse
import hmac
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
from scipy import ndimage as ndi

from surgiguide.volume import Volume
from surgiguide import segment as seg
from surgiguide.version import VERSION

MAX_VOXELS = 256 * 1024 * 1024 // 2   # int16 volume of at most 256 MB
SEG_SLOTS = threading.BoundedSemaphore(int(os.environ.get("YOLMED_SEG_JOBS", "1")))
JOB_WAIT_S = 120                      # how long a fully received request queues for its job slot before a 503
NAMES_TR = {"mandible": "Mandibula", "fibula": "Fibula"}

# Uploads. A request body is read completely before the request queues for a job slot, so a slow or stalled client holds
# only its own upload, never the guide / segmentation service. The rules: at least BODY_WINDOW_BYTES in every
# BODY_WINDOW_S seconds (~25 kB/s, 0.2 Mbit/s: a trickling client is cut within seconds of a window), and the whole body
# within BODY_MAX_S (a 60 MB guide request needs ~1 Mbit/s). UPLOAD_SLOTS bounds the bodies held in memory at once.
BODY_WINDOW_S = 10.0
BODY_WINDOW_BYTES = 256 * 1024
BODY_MAX_S = float(os.environ.get("YOLMED_BODY_MAX_S", "600"))
UPLOAD_SLOTS = threading.BoundedSemaphore(int(os.environ.get("YOLMED_UPLOADS", "6")))
UPLOAD_WAIT_S = 30
DRAIN_MAX = 32 * 1024 * 1024          # an unread upload is read (and discarded) up to this much after an early error answer
WRITE_MIN_RATE = 64 * 1024            # bytes per second a client must read an answer at (large STL / label answers)

# Content-Security-Policy of every answer (the studio's page is the one that matters): its own files, three.js /
# dicom-parser / the DICOM codecs from jsDelivr (the codecs are WebAssembly), the Google fonts stylesheet. Inline style
# attributes are used by the studio's templates; there are no inline scripts.
CSP_BASE = {
    "default-src": "'self'",
    "script-src": "'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'",
    "style-src": "'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src": "'self' https://fonts.gstatic.com data:",
    "img-src": "'self' data: blob:",
    "connect-src": "'self' https://cdn.jsdelivr.net",
    "worker-src": "'self' blob:",
    "object-src": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
    "frame-ancestors": "'none'",
}


def _csp(extra_connect=""):
    d = dict(CSP_BASE)
    if extra_connect.strip():
        d["connect-src"] += " " + " ".join(extra_connect.split())
    return "; ".join(f"{k} {v}" for k, v in d.items())


def _origins(val):
    return frozenset(o.strip().rstrip("/") for o in (val or "").split(",") if o.strip())


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


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
    timeout = 60                        # seconds a client may stall while sending headers; ends half-open connections
    token = os.environ.get("YOLMED_TOKEN") or None
    allowed_origins = _origins(os.environ.get("YOLMED_ALLOWED_ORIGINS"))
    private_network = os.environ.get("YOLMED_ALLOW_PRIVATE_NETWORK", "").lower() in ("1", "true", "yes")
    csp = _csp(os.environ.get("YOLMED_CSP_CONNECT", ""))
    _head = False

    # ---------------------------------------------------------------- logging: access lines to stdout (stderr = errors)
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def log_error(self, fmt, *args):     # client-side problems (timeouts, 4xx): not server errors
        self.log_message(fmt, *args)

    # ---------------------------------------------------------------- headers on every answer
    def _hdr(self, name):
        h = getattr(self, "headers", None)
        return h.get(name) if h is not None else None

    def _origin_ok(self, origin):
        return bool(origin) and ("*" in self.allowed_origins or origin.rstrip("/") in self.allowed_origins)

    def _cors(self):
        """CORS only for the configured origins; same-origin pages (the studio served by this server) need none."""
        origin = self._hdr("Origin")
        if not self._origin_ok(origin):
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-Structures, X-Yolmed-Version")
        self.send_header("Access-Control-Max-Age", "600")
        if self.private_network and (self._hdr("Access-Control-Request-Private-Network") or "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _security(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", self.csp)
        self.send_header("X-Yolmed-Version", VERSION)
        if (self._hdr("X-Forwarded-Proto") or "").split(",")[0].strip().lower() == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000")

    def end_headers(self):
        self._security()
        self._cors()
        super().end_headers()

    # ---------------------------------------------------------------- answers
    def _write(self, body):
        """Write an answer body (nothing for HEAD). The socket timeout bounds the whole sendall, so it is sized to the body: a
        client reading at WRITE_MIN_RATE gets a 20 MB STL in full."""
        if self._head or not body:
            return
        try:
            self.connection.settimeout(max(self.timeout, len(body) / WRITE_MIN_RATE + 10))
            self.wfile.write(body)
        except OSError as e:          # the client went away or stopped reading: nothing to answer to
            self.close_connection = True
            self.log_message("answer not delivered: %s", e)
        finally:
            self.connection.settimeout(self.timeout)

    def _send(self, code, body, ctype, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self._write(body)

    def _json(self, code, obj, extra=()):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8", extra)

    def _error(self, e):
        """HttpError -> JSON answer; an upload the client is still sending is drained first, so it can read the answer."""
        extra = (("WWW-Authenticate", 'Bearer realm="yolmed"'),) if e.code == 401 else ()
        if getattr(self, "_unread", 0) > 0:
            self.close_connection = True
            self._json(e.code, {"error": e.msg}, extra)
            self._drain()
        else:
            self._json(e.code, {"error": e.msg}, extra)

    def send_error(self, code, message=None, explain=None):
        """Protocol errors of http.server (bad request line, 414, 501 ...) as JSON with the same headers."""
        try:
            short, _ = self.responses.get(code, ("error", ""))
        except AttributeError:
            short = "error"
        self.log_error("code %d, message %s", code, message)
        self.close_connection = True
        if not hasattr(self, "headers") or self.headers is None:
            self.headers = {}
        self._json(code, {"error": message or short})

    def _drain(self):
        """After an early answer: read and discard the rest of the upload (at most DRAIN_MAX, a few seconds), so a client
        still sending can finish and read the answer instead of a connection reset; then close."""
        self.close_connection = True
        left = min(getattr(self, "_unread", 0), DRAIN_MAX)
        end = time.monotonic() + 10
        try:
            while left > 0 and time.monotonic() < end:
                self.connection.settimeout(1.0)
                chunk = self.rfile.read1(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            pass
        self._unread = 0

    # ---------------------------------------------------------------- requests
    def _authorized(self):
        if not self.token:
            return True
        h = self._hdr("Authorization") or ""
        if not h[:7].lower() == "bearer ":
            return False
        return hmac.compare_digest(h[7:].strip().encode("utf-8", "replace"), self.token.encode("utf-8"))

    def _require_auth(self):
        if not self._authorized():
            self._unread = self._content_length(quiet=True)
            raise HttpError(401, "authentication required")

    def _content_length(self, quiet=False):
        try:
            n = int(self._hdr("Content-Length") or 0)
        except ValueError:
            if quiet:
                return 0
            raise HttpError(400, "bad Content-Length")
        if n < 0:
            if quiet:
                return 0
            raise HttpError(400, "bad Content-Length")
        return n

    def _read_body(self, limit):
        """The whole request body (a bytearray, one copy), under the upload rules above; 413 over `limit`, 408 too slow,
        503 when UPLOAD_SLOTS stay taken. The caller holds the upload slot (self._upload) until it is done with the body."""
        n = self._content_length()
        self._unread = n
        if n > limit:
            raise HttpError(413, "request too large")
        if not UPLOAD_SLOTS.acquire(timeout=UPLOAD_WAIT_S):
            raise HttpError(503, "server busy (uploads), try again")
        self._upload = True
        buf = bytearray(n)
        mv = memoryview(buf)
        got, t0 = 0, time.monotonic()
        win_t, win_got = t0, 0
        try:
            while got < n:
                now = time.monotonic()
                if now - t0 > BODY_MAX_S:
                    raise HttpError(408, f"request body not received within {BODY_MAX_S:.0f} s")
                if now - win_t >= BODY_WINDOW_S:
                    if got - win_got < BODY_WINDOW_BYTES:
                        raise HttpError(408, "request body too slow")
                    win_t, win_got = now, got
                try:
                    self.connection.settimeout(max(0.5, min(BODY_WINDOW_S, BODY_MAX_S - (now - t0))))
                    k = self.rfile.readinto1(mv[got:min(n, got + (1 << 20))])
                except OSError:
                    raise HttpError(408, "request body too slow")
                if not k:
                    self._unread = 0
                    raise HttpError(400, "request body ended early")
                got += k
                self._unread = n - got
        finally:
            mv.release()
            self.connection.settimeout(self.timeout)     # the answer is written with the normal (size-scaled) timeout
        return buf

    def _release_upload(self):
        if getattr(self, "_upload", False):
            self._upload = False
            UPLOAD_SLOTS.release()

    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers()

    def do_HEAD(self):
        self._head = True
        self.do_GET()

    def _method_not_allowed(self):
        self._json(405, {"error": "method not allowed"}, (("Allow", "GET, HEAD, POST, PUT, OPTIONS"),))

    do_DELETE = do_PATCH = _method_not_allowed

    def health(self):
        return 200, {"backend": self.backend, "structures": list(seg.TOTALSEG_TASKS), "version": VERSION}

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._json(404, {"error": "not found"})
        code, body = self.health()
        self._json(code, body, (("Cache-Control", "no-store"),))

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/segment":
            return self._json(404, {"error": "not found"})
        try:
            self._segment(u)
        except HttpError as e:
            self._error(e)
        except Exception:      # the computation failed (MemoryError, a backend error ...): answer, log the details
            traceback.print_exc()
            self._json(500, {"error": "internal error"})
        finally:
            self._release_upload()

    def _segment(self, u):
        self._require_auth()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            nx, ny, nz = int(q["nx"]), int(q["ny"]), int(q["nz"])
            sp = [float(x) for x in q["sp"].split(",")]
            origin = [float(x) for x in q["origin"].split(",")]
            axes = np.array([float(x) for x in q["axes"].split(",")]).reshape(3, 3)
            if len(sp) != 3 or len(origin) != 3 or not (np.all(np.isfinite(sp)) and np.all(np.isfinite(origin)) and np.all(np.isfinite(axes))):
                raise ValueError("sp and origin need 3 finite numbers, axes 9")
            n = self._content_length()
            if min(nx, ny, nz) < 1 or nx * ny * nz > MAX_VOXELS or n != 2 * nx * ny * nz:
                raise ValueError("Content-Length must be 2*nx*ny*nz bytes, at most %d voxels" % MAX_VOXELS)
        except (KeyError, ValueError, TypeError) as e:
            self._unread = self._content_length(quiet=True)
            raise HttpError(400, f"bad request: {e}")
        raw = self._read_body(2 * MAX_VOXELS)
        # one segmentation at a time (a request at the size limit needs ~3 GB); the slot is taken only now, with the body in hand
        if not SEG_SLOTS.acquire(timeout=JOB_WAIT_S):
            raise HttpError(503, "segmentation busy, try again")
        try:
            hu = np.frombuffer(raw, "<i2").reshape(nz, ny, nx).astype(np.float32)
            del raw
            self._release_upload()
            vol = Volume(hu, sp, origin, axes.T)   # axes rows are the i, j, k unit vectors
            if self.backend == "totalseg":
                wanted = [s for s in q.get("structures", "mandible").split(",") if s in seg.TOTALSEG_TASKS]
                labels, structs = run_totalseg(vol, wanted)
            else:
                labels, structs = run_threshold(vol)
            del vol, hu
        finally:
            SEG_SLOTS.release()
        self._send(200, np.ascontiguousarray(labels).tobytes(), "application/octet-stream",
                   (("X-Structures", json.dumps(structs, ensure_ascii=True)),))


def make_server(host, port, backend="threshold", allow_origin=None):
    Handler.backend = backend
    if allow_origin is not None:
        Handler.allowed_origins = _origins(allow_origin)
    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["threshold", "totalseg"], default="threshold")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--allow-origin", default=None,
                    help="origins of the studio pages that call this server (comma-separated; default YOLMED_ALLOWED_ORIGINS)")
    a = ap.parse_args()
    print(f"segmentation service {VERSION} ({a.backend}) on http://{a.host}:{a.port}", flush=True)
    make_server(a.host, a.port, a.backend, a.allow_origin).serve_forever()
