"""Production /guide STL quality, slot and hole geometry, determinism, GUIDE_SLOTS queueing (ported from the Denetim 3
audit suite) and the STL repair of D4 E3.

    python3 tests/server/test_guide_quality.py -v          (slow: ~10 guide builds)

Geometry: the repo test's synthetic bone (cylinder r = 8 mm along world x, oblique crop, closed cavity),
frame p = (0, 0, 8), u = x, v = y, n = z; clearance 0.3, wall 3 -> shell between r = 8.3 and 11.3 mm.
"""
import base64
import copy
import hashlib
import io
import json
import os
import threading
import time
import unittest

import numpy as np
import trimesh

from common import J, call, start_server, stop_server, base_guide_request, contains, SCRATCH, yolmed_server
from stl_check import check
R0, CLEAR, WALL = 8.0, 0.3, 3.0
MID = R0 + CLEAR + WALL / 2           # mid-wall radius 9.8 (below the bridge band, which starts at r = 10.8)
RESULTS = {}


def load(r):
    return trimesh.load(io.BytesIO(base64.b64decode(r["stl_b64"])), file_type="stl")


def ring_on_plane(p, N, offset, radius=MID, phis=np.radians(np.arange(-40, 41, 5))):
    """Points of the circle r = radius (around world x) that lie on the plane (p, N) shifted by offset along N."""
    N = np.asarray(N, float) / np.linalg.norm(N)
    pts = []
    for ph in phis:
        y, z = radius * np.sin(ph), radius * np.cos(ph)
        # solve N . ((x, y, z) - p) = offset for x
        x = p[0] + (offset - N[1] * (y - p[1]) - N[2] * (z - p[2])) / N[0]
        pts.append([x, y, z])
    return np.array(pts)


class GuideQuality(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, _, cls.port = start_server(web=False, name="guide")
        cls.req = base_guide_request()
        t = time.perf_counter()
        st, cls.r = J(call(cls.base, "POST", "/guide", cls.req))
        cls.wall_s = time.perf_counter() - t
        assert st == 200, cls.r
        cls.tm = load(cls.r)
        RESULTS["base"] = {k: cls.r[k] for k in ("watertight", "volume_mm3", "faces", "bodies", "ms", "dropped_fragments",
                                                  "welded_vertices", "grid", "stage_ms")}

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)
        with open(os.path.join(SCRATCH, "guide_quality_results.json"), "w") as f:
            json.dump(RESULTS, f, indent=1)
        print("\n" + json.dumps(RESULTS, indent=1))

    def test_1_stl_quality(self):
        q = check(self.tm, samples=1500)
        RESULTS["base_stl"] = q
        self.assertTrue(self.r["watertight"])
        self.assertTrue(q["watertight"] and q["winding_consistent"] and q["manifold_edges"], q)
        self.assertEqual(q["bodies"], 1)
        self.assertGreater(q["volume_mm3"], 0)                     # outward normals
        self.assertAlmostEqual(q["volume_mm3"], self.r["volume_mm3"], delta=1e-3 * self.r["volume_mm3"])
        # median inward-ray thickness ~ shell wall; p1/p5 are informational (sleeve walls are (D-d)/2 = 1.5 mm by
        # design and rays near rims / slot edges are short)
        self.assertAlmostEqual(q["wall_med"], WALL, delta=0.15 * WALL, msg=q)

    def test_2_slots_present_and_kerf_width(self):
        for pl in self.req["planes"]:
            w = pl["w"]
            for off in (0.0, w / 2 - 0.1, -(w / 2 - 0.1)):
                inside = contains(self.tm, ring_on_plane(pl["p"], pl["N"], off))
                self.assertFalse(inside.any(), f"material inside slot {pl} at offset {off}: {inside.sum()} pts")
            for off in (w / 2 + 0.4, -(w / 2 + 0.4)):            # just outside the kerf there is wall
                inside = contains(self.tm, ring_on_plane(pl["p"], pl["N"], off))
                self.assertTrue(inside.mean() > 0.8, f"no wall beside slot {pl} at offset {off}: {inside.mean():.2f}")

    def test_3_holes_and_sleeves(self):
        for s in self.req["screws"]:
            e, d = np.asarray(s["entry"], float), np.asarray(s["dir"], float)
            d /= np.linalg.norm(d)
            out = -d                                              # sleeve goes outwards
            ts = np.linspace(-1.0, CLEAR + WALL + s["sleeveH"] - 0.5, 15)
            axis_pts = e[None] + ts[:, None] * out
            self.assertFalse(contains(self.tm, axis_pts).any(), f"hole blocked on axis of {s}")
            # perpendicular basis
            a = np.cross(d, [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
            mid = e + out * (CLEAR + WALL + s["sleeveH"] / 2)
            ang = np.linspace(0, 2 * np.pi, 12, endpoint=False)
            inner = mid + (s["d"] / 2 - 0.1) * (np.cos(ang)[:, None] * a + np.sin(ang)[:, None] * b)
            ring = mid + ((s["d"] + s["D"]) / 4) * (np.cos(ang)[:, None] * a + np.sin(ang)[:, None] * b)
            self.assertFalse(contains(self.tm, inner).any(), f"hole narrower than d for {s}")
            self.assertTrue(contains(self.tm, ring).all(), f"sleeve wall missing for {s}")

    def test_4_deterministic(self):
        st, r2 = J(call(self.base, "POST", "/guide", self.req))
        self.assertEqual(st, 200)
        h1 = hashlib.sha256(base64.b64decode(self.r["stl_b64"])).hexdigest()
        h2 = hashlib.sha256(base64.b64decode(r2["stl_b64"])).hexdigest()
        RESULTS["determinism"] = {"same_sha256": h1 == h2, "vol1": self.r["volume_mm3"], "vol2": r2["volume_mm3"]}
        self.assertEqual(h1, h2)

    def test_5_split_guides(self):
        req = dict(self.req, gap={"A": self.req["planes"][0], "B": self.req["planes"][1], "flange": 3.0})
        st, r = J(call(self.base, "POST", "/guide", req))
        self.assertEqual(st, 200, r)
        q = check(load(r), samples=600)
        RESULTS["split"] = {"bodies": r["bodies"], "watertight": r["watertight"], "stl": q}
        self.assertTrue(q["watertight"] and q["manifold_edges"] and q["winding_consistent"])
        self.assertEqual(q["bodies"], 2)

    def test_6_close_slots_and_screws(self):
        """Stress: 3 slots (two 3 mm apart, one oblique) and 3 screws, one 2.5 mm from a slot."""
        req = copy.deepcopy(self.req)
        req["planes"] = [{"p": [-8, 0, 0], "N": [1, 0, 0], "w": 1.0}, {"p": [-5, 0, 0], "N": [1, 0, 0.1], "w": 1.0},
                         {"p": [7, 0, 0], "N": [0.9, 0.2, 0.3], "w": 1.4}]
        req["screws"].append({"entry": [-2.5, 1, 7.9], "dir": [0, 0, -1], "d": 1.6, "D": 4.0, "sleeveH": 3})
        st, r = J(call(self.base, "POST", "/guide", req))
        self.assertEqual(st, 200, r)
        q = check(load(r), samples=600)
        RESULTS["stress"] = {"bodies": r["bodies"], "watertight": r["watertight"], "dropped": r["dropped_fragments"], "stl": q}
        self.assertTrue(r["watertight"] and q["watertight"] and q["manifold_edges"])
        self.assertEqual(q["bodies"], 1)

    def test_7_guide_slots_serialise(self):
        """3 concurrent requests with YOLMED_GUIDE_JOBS=1: all succeed, run one after another (no 503 below 120 s)."""
        res = []

        def go(i):
            t0 = time.perf_counter()
            st, r = J(call(self.base, "POST", "/guide", self.req))
            res.append((i, st, r.get("ms"), time.perf_counter() - t0, r.get("volume_mm3")))
        t = time.perf_counter()
        ths = [threading.Thread(target=go, args=(i,)) for i in range(3)]
        [x.start() for x in ths]; [x.join() for x in ths]
        total = time.perf_counter() - t
        RESULTS["concurrency"] = {"total_s": round(total, 1), "per_request": res}
        self.assertTrue(all(st == 200 for _, st, *_ in res), res)
        server_ms = sum(r[2] for r in res) / 1000
        self.assertGreater(total, 0.9 * server_ms, "requests overlapped although GUIDE_SLOTS = 1")
        self.assertEqual(len({round(r[4], 6) for r in res}), 1)


if __name__ == "__main__":
    unittest.main()
