"""End-to-end test for yolmed_server.py: starts the server on a free port, exercises /health, /segment,
every /cases endpoint and /guide with a synthetic bone (oblique crop, closed inner cavity).

    python test_yolmed_server.py
"""
import base64
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yolmed_server  # noqa: E402


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def call(base, method, path, obj=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers or {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def J(res):
    return res[0], json.loads(res[2])


def contains(tm, pts):
    """Point-in-mesh by ray parity (Moller-Trumbore, numpy only; trimesh.contains needs rtree)."""
    tri = tm.triangles
    v0, e1, e2 = tri[:, 0], tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    out = []
    for pt in np.asarray(pts, float):
        votes = 0
        for dvec in ([0.3141, 0.7071, 0.6332], [-0.577, 0.211, 0.789], [0.123, -0.913, 0.389]):
            dvec = np.asarray(dvec) / np.linalg.norm(dvec)
            h = np.cross(dvec, e2); a = np.einsum("ij,ij->i", e1, h)
            ok = np.abs(a) > 1e-12; f = np.zeros_like(a); f[ok] = 1 / a[ok]
            sv = pt - v0; u = f * np.einsum("ij,ij->i", sv, h)
            q = np.cross(sv, e1); v = f * (q @ dvec); t = f * np.einsum("ij,ij->i", e2, q)
            hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
            votes += hit.sum() % 2
        out.append(votes >= 2)
    return np.array(out)


def rot_z(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def synthetic_case(sp=0.3):
    """Bone: cylinder along world x, radius 8 mm, with a closed spherical cavity (must count as bone).
    Crop: ~40 x 30 x 40 mm, axes rotated 12 deg about z and 5 deg about x (oblique acquisition)."""
    Rc = rot_z(np.radians(12)) @ np.array([[1, 0, 0], [0, np.cos(.087), -np.sin(.087)], [0, np.sin(.087), np.cos(.087)]])
    axes = Rc.T                                  # rows = i, j, k unit vectors
    nx, ny, nz = int(40 / sp), int(30 / sp), int(40 / sp)
    center = np.array([nx, ny, nz]) * sp / 2
    origin = -(Rc @ center)
    k, j, i = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing="ij")
    ijk = np.stack([i, j, k], -1) * sp
    w = ijk @ Rc.T + origin                       # world coords
    rr = np.hypot(w[..., 1], w[..., 2])
    bone = (rr <= 8.0) & ~((w[..., 0] ** 2 + w[..., 1] ** 2 + w[..., 2] ** 2) <= 3.0 ** 2)
    crop = {"nx": nx, "ny": ny, "nz": nz, "sp": [sp] * 3, "origin": origin.tolist(), "axes": axes.tolist()}
    return crop, bone.astype(np.uint8)


def main():
    tmp = tempfile.mkdtemp(prefix="yolmed_test_", dir=os.path.dirname(os.path.abspath(__file__)))
    db = os.path.join(tmp, "cases.sqlite")
    port = free_port()
    srv = yolmed_server.make_server("127.0.0.1", port, db)
    th = threading.Thread(target=srv.serve_forever, daemon=True); th.start()
    base = f"http://127.0.0.1:{port}"
    try:
        # ---- unchanged endpoints
        st, h, b = call(base, "GET", "/health")
        assert st == 200 and json.loads(b)["backend"] == "threshold"
        assert h["Access-Control-Allow-Private-Network"] == "true"
        st, h, _ = call(base, "OPTIONS", "/cases")
        assert st == 204 and "PUT" in h["Access-Control-Allow-Methods"]
        hu = np.full((8, 10, 12), -1000, np.int16); hu[2:6, 3:7, 4:9] = 1200
        st, h, b = call(base, "POST", "/segment?nx=12&ny=10&nz=8&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1",
                        raw=hu.tobytes(), headers={"Content-Type": "application/octet-stream"})
        lab = np.frombuffer(b, np.uint8).reshape(8, 10, 12)
        assert st == 200 and (lab > 0).sum() == 4 * 4 * 5 and json.loads(h["X-Structures"])[0]["label"] == 1
        print("health/segment OK")

        # ---- case store
        st, r = J(call(base, "POST", "/cases", {"name": "Hasta A - mandibula", "kind": "mandible", "fingerprint": "fp1"}))
        assert st == 200 and isinstance(r["id"], str); a = r["id"]
        time.sleep(0.01)
        st, r = J(call(base, "POST", "/cases", {"name": "Hasta B", "kind": "fibula", "fingerprint": "fp2"})); b_id = r["id"]
        st, lst = J(call(base, "GET", "/cases"))
        assert [c["id"] for c in lst] == [b_id, a] and lst[0]["n_versions"] == 0
        assert set(lst[0]) == {"id", "name", "kind", "fingerprint", "updated_at", "n_versions"}
        st, c = J(call(base, "GET", f"/cases/{a}"))
        assert c["draft"] is None and c["name"] == "Hasta A - mandibula" and c["updated_at"].endswith("Z")
        plan = {"planes": [{"p": [0, 0, 0], "N": [1, 0, 0]}], "segments": 2, "not": "çğış"}
        st, r = J(call(base, "PUT", f"/cases/{a}/draft", {"plan": plan})); assert r["ok"] is True
        st, c = J(call(base, "GET", f"/cases/{a}")); assert c["draft"] == plan and c["updated_at"] == r["updated_at"]
        st, lst = J(call(base, "GET", "/cases")); assert lst[0]["id"] == a       # newest first by update
        st, r1 = J(call(base, "POST", f"/cases/{a}/versions", {"plan": plan, "note": "ilk", "author": "dr x"}))
        st, r2 = J(call(base, "POST", f"/cases/{a}/versions", {"plan": {"v": 2}, "note": "ikinci", "author": "dr y"}))
        assert (r1["n"], r2["n"]) == (1, 2)
        st, r3 = J(call(base, "POST", f"/cases/{b_id}/versions", {"plan": {"x": 1}, "note": "", "author": "z"}))
        assert r3["n"] == 1
        st, vs = J(call(base, "GET", f"/cases/{a}/versions"))
        assert [v["n"] for v in vs] == [2, 1] and set(vs[0]) == {"n", "note", "author", "created_at"}
        st, v1 = J(call(base, "GET", f"/cases/{a}/versions/1")); assert v1["plan"] == plan and v1["note"] == "ilk"
        st, lst = J(call(base, "GET", "/cases")); assert {c["id"]: c["n_versions"] for c in lst} == {a: 2, b_id: 1}
        for path, m, body in [(f"/cases/nope", "GET", None), (f"/cases/nope/draft", "PUT", {"plan": {}}),
                              (f"/cases/nope/versions", "GET", None), (f"/cases/nope/versions", "POST", {"plan": {}}),
                              (f"/cases/{a}/versions/9", "GET", None), ("/nothing", "GET", None)]:
            st, r = J(call(base, m, path, body)); assert st == 404 and "error" in r, (path, st, r)
        st, r = J(call(base, "PUT", f"/cases/{a}/versions/1", {"plan": {}})); assert st == 405   # immutable
        print("cases OK")

        # ---- guide
        crop, mask = synthetic_case()
        cw = 0.3 + 3.0
        req = {
            "crop": crop, "mask_b64": base64.b64encode(mask.tobytes()).decode(),
            "frame": {"p": [0, 0, 8], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]},
            "g": {"L": 30, "W": 16, "wrap": 4, "wall": 3, "clear": 0.3, "bridge": 3, "side": 1},
            "planes": [{"p": [-6, 0, 0], "N": [1, 0, 0], "w": 1.2},
                       {"p": [6, 0, 0], "N": [0.966, 0, 0.259], "w": 1.2}],
            "screws": [{"entry": [-11, 0, 8], "dir": [0, 0, -1], "d": 2.0, "D": 5.0, "sleeveH": 5.0},
                       {"entry": [11, -2, 7.75], "dir": [0, 0.25, -0.97], "d": 2.0, "D": 5.0, "sleeveH": 4.0}],
            "resolution": 0.2,
        }
        t = time.perf_counter()
        st, r = J(call(base, "POST", "/guide", req))
        wall_ms = (time.perf_counter() - t) * 1000
        assert st == 200, r
        print(f"guide: server {r['ms']} ms, round-trip {wall_ms:.0f} ms, stages {r['stage_ms']}, grid {r['grid']}")
        print(f"guide: faces {r['faces']}, volume {r['volume_mm3']:.1f} mm3, bodies {r['bodies']}, "
              f"watertight {r['watertight']}, dropped {r['dropped_fragments']}, STL {len(r['stl_b64']) * 3 // 4 / 1e6:.1f} MB")
        assert r["watertight"] is True and r["bodies"] == 1
        tm = trimesh.load(io.BytesIO(base64.b64decode(r["stl_b64"])), file_type="stl")
        assert tm.is_watertight and tm.body_count == 1 and abs(tm.volume - r["volume_mm3"]) < 1e-3 * r["volume_mm3"]
        lo, hi = tm.bounds
        assert lo[0] >= -15.01 and hi[0] <= 15.01, tm.bounds              # |uu| <= L/2
        assert lo[1] >= -8.01 and hi[1] <= 8.01, tm.bounds                # |vv| <= W/2
        assert lo[2] >= 8 - 4 - 0.01, tm.bounds                           # nn >= -wrap
        R0 = 8.0
        probes = {
            "shell mid-wall (x=0)":            ([0, 0, R0 + 0.3 + 1.5], True),
            "clearance gap (x=0)":             ([0, 0, R0 + 0.1], False),
            "outside wall (x=0)":              ([0, 0, R0 + cw + 0.5], False),
            "slot 1, shell part (vv=0)":       ([-6, 0, R0 + 1.8], False),
            "slot 1, bridge part (vv=6.5)":      ([-6, 6.5, np.sqrt((R0 + cw + 1.0) ** 2 - 6.5 ** 2)], True),
            "drill hole axis in sleeve":       ([-11, 0, R0 + cw + 2.0], False),
            "sleeve wall":                     ([-11 + 2.0, 0, R0 + cw + 2.0], True),
            "sleeve does not enter clearance": ([-11 + 2.0, 0, R0 + 0.1], False),
            "beyond L/2":                      ([15.5, 0, R0 + 1.8], False),
        }
        inside = contains(tm, np.array([p for p, _ in probes.values()], float))
        for (name, (_, want)), got in zip(probes.items(), inside):
            assert bool(got) == want, f"probe '{name}': expected {want}, got {got}"
        print("guide geometry probes OK")
        # two separate guides: nothing between the cuts beyond a 3 mm flange, one body per side
        req2 = dict(req, gap={"A": req["planes"][0], "B": req["planes"][1], "flange": 3.0})
        st, r2 = J(call(base, "POST", "/guide", req2))
        assert st == 200 and r2["watertight"] is True and r2["bodies"] == 2, (st, r2.get("bodies"))
        tm2 = trimesh.load(io.BytesIO(base64.b64decode(r2["stl_b64"])), file_type="stl")
        got = contains(tm2, np.array([[-1, 0, R0 + 0.3 + 1.5], [-6 + 0.6 + 1.5, 0, R0 + 0.3 + 1.5], [-11 + 2.0, 0, R0 + cw + 2.0]], float))
        assert list(map(bool, got)) == [False, True, True], got
        print(f"split guide OK: bodies {r2['bodies']}, volume {r2['volume_mm3']:.1f} mm3")
        st, r = J(call(base, "POST", "/guide", {"crop": crop})); assert st == 400 and "error" in r
        # ---- access password
        yolmed_server.PASSWORD = "s3cret"
        try:
            assert call(base, "GET", "/health")[0] == 200
            st, h, _ = call(base, "GET", "/cases"); assert st == 401 and "Basic" in h["WWW-Authenticate"]
            assert call(base, "POST", "/guide", {"crop": crop})[0] == 401
            bad = "Basic " + base64.b64encode(b"x:wrong").decode()
            assert call(base, "GET", "/cases", headers={"Authorization": bad})[0] == 401
            ok = "Basic " + base64.b64encode(b"x:s3cret").decode()
            assert call(base, "GET", "/cases", headers={"Authorization": ok})[0] == 200
        finally:
            yolmed_server.PASSWORD = None
        print("auth OK")
    finally:
        srv.shutdown(); srv.server_close()
        os.remove(db)
        os.rmdir(tmp)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
