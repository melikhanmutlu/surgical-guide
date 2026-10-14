"""Shared helpers of the server regression tests (ported from the Denetim 3 audit suite, audit/denetim3/sunucu/tests).

Every test starts its own yolmed_server on a free port with a database in a temporary folder (never in the checkout), and
switches the environment's YOLMED_TOKEN / YOLMED_ALLOWED_ORIGINS off unless the test sets them.
"""
import base64
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
import yolmed_server  # noqa: E402
from test_yolmed_server import synthetic_case, contains  # noqa: E402,F401  (the repo's own fixture + point-in-mesh)

SCRATCH = tempfile.mkdtemp(prefix="sg_server_tests_")
yolmed_server.Handler.log_message = lambda *a, **k: None     # quiet test output


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def start_server(web=True, name="db", token="", allow_origin=""):
    port = free_port()
    db = os.path.join(SCRATCH, f"{name}_{port}_{int(time.time() * 1000)}.sqlite")
    srv = yolmed_server.make_server("127.0.0.1", port, db, web=os.path.join(REPO, "web") if web else None,
                                    token=token, allow_origin=allow_origin)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{port}", db, port


def stop_server(srv):
    srv.shutdown(); srv.server_close()
    # the class-level settings go back to "off" for the next test module
    yolmed_server.Handler.token = None
    yolmed_server.Handler.allowed_origins = frozenset()


def call(base, method, path, obj=None, raw=None, headers=None, timeout=600):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def J(res):
    st, _, b = res
    try:
        return st, json.loads(b)
    except ValueError:
        return st, {"_raw": b[:300].decode("latin-1")}


def raw_http(port, data, timeout=10, read=True):
    """Send raw bytes, return (status_code or None, full response bytes). None = connection closed without reply."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        s.sendall(data)
        if not read:
            return s
        chunks = []
        while True:
            try:
                c = s.recv(65536)
            except (ConnectionResetError, socket.timeout):
                break
            if not c:
                break
            chunks.append(c)
        resp = b"".join(chunks)
        code = int(resp.split(b" ", 2)[1]) if resp.startswith(b"HTTP/") else None
        return code, resp
    finally:
        if read:
            s.close()


def strict_json(b):
    """Parse like a browser's JSON.parse would: NaN / Infinity are not JSON."""
    def bad(c):
        raise ValueError(f"non-standard JSON constant {c}")
    return json.loads(b, parse_constant=bad)


def base_guide_request(sp=0.3, resolution=0.2):
    """The repo test's synthetic bone (cylinder r=8 mm along x, oblique crop) with 2 slots + 2 screws."""
    crop, mask = synthetic_case(sp)
    return {
        "crop": crop, "mask_b64": base64.b64encode(mask.tobytes()).decode(),
        "frame": {"p": [0, 0, 8], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]},
        "g": {"L": 30, "W": 16, "wrap": 4, "wall": 3, "clear": 0.3, "bridge": 3, "side": 1},
        "planes": [{"p": [-6, 0, 0], "N": [1, 0, 0], "w": 1.2},
                   {"p": [6, 0, 0], "N": [0.966, 0, 0.259], "w": 1.2}],
        "screws": [{"entry": [-11, 0, 8], "dir": [0, 0, -1], "d": 2.0, "D": 5.0, "sleeveH": 5.0},
                   {"entry": [11, -2, 7.75], "dir": [0, 0.25, -0.97], "d": 2.0, "D": 5.0, "sleeveH": 4.0}],
        "resolution": resolution,
    }


def tiny_guide_request():
    """Smallest valid request (fast): 30 x 20 x 20 voxel crop at 1 mm with a bar of bone, coarse resolution."""
    nx, ny, nz = 30, 20, 20
    m = np.zeros((nz, ny, nx), np.uint8)
    m[6:14, 6:14, :] = 1
    crop = {"nx": nx, "ny": ny, "nz": nz, "sp": [1, 1, 1], "origin": [-15, -10, -10],
            "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}
    return {"crop": crop, "mask_b64": base64.b64encode(m.tobytes()).decode(),
            "frame": {"p": [0, 0, 4], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]},
            "g": {"L": 16, "W": 10, "wrap": 2, "wall": 2, "clear": 0.3, "bridge": 2, "side": 1},
            "planes": [{"p": [0, 0, 0], "N": [1, 0, 0], "w": 1.0}], "screws": [], "resolution": 0.5}
