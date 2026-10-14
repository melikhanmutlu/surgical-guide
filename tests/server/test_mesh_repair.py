"""The STL repair of the production guide (D4 E3) and the version stamp in the STL header; fast, no server.

    python3 tests/server/test_mesh_repair.py -v
"""
import unittest

import numpy as np
import trimesh

from common import yolmed_server


def box():
    b = trimesh.creation.box((10, 8, 6))
    return np.asarray(b.vertices, float), np.asarray(b.faces), b


class MeshRepair(unittest.TestCase):
    def test_sliver_on_an_edge_is_removed(self):
        """A flat closed sliver hanging on an edge of the body (as left on real CT where two surface sheets touch after the
        simplification) makes that edge non-manifold; the repair drops it and the STL is closed again."""
        v, f, b = box()
        e = b.edges_unique[0]
        p0, p1 = v[e[0]], v[e[1]]
        mid = (p0 + p1) / 2
        out = mid - b.centroid
        out /= np.linalg.norm(out)
        q1, q2 = mid + out * 0.05, mid + out * 0.05 + np.cross(out, p1 - p0) * 1e-5
        nv = len(v)
        a, bb, c, d = e[0], e[1], nv, nv + 1
        v2 = np.vstack([v, [q1, q2]])
        f2 = np.vstack([f, [[a, bb, c], [a, c, d], [a, d, bb], [bb, d, c]]])
        _, cnt = np.unique(trimesh.Trimesh(v2, f2, process=False).edges_sorted, axis=0, return_counts=True)
        self.assertTrue(np.any(cnt > 2), "the fixture should have a non-manifold edge")
        self.assertFalse(yolmed_server._mesh_check(yolmed_server._stl_bytes(v2, f2, "x"))[1])
        vr, fr, rep = yolmed_server._repair_mesh(v2, f2)
        self.assertEqual(rep["slivers"], 1, rep)
        tm, ok = yolmed_server._mesh_check(yolmed_server._stl_bytes(vr, fr, "x"))
        self.assertTrue(ok)
        self.assertAlmostEqual(tm.volume, 480.0, places=3)

    def test_repeated_and_degenerate_faces(self):
        v, f, _ = box()
        # a repeated face is kept once, a collapsed face dropped
        vr, fr, rep = yolmed_server._repair_mesh(v, np.vstack([f, [f[0]], [[0, 0, 1]]]))
        self.assertEqual((rep["duplicate_faces"], rep["degenerate_faces"]), (1, 1), rep)
        self.assertTrue(yolmed_server._mesh_check(yolmed_server._stl_bytes(vr, fr, "x"))[1])
        # a face with its reversed twin: both go (the hole they leave is reported by the check, never hidden)
        vr, fr, rep = yolmed_server._repair_mesh(v, np.vstack([f, [f[0][::-1]]]))
        self.assertEqual(rep["duplicate_faces"], 2, rep)
        self.assertFalse(yolmed_server._mesh_check(yolmed_server._stl_bytes(vr, fr, "x"))[1])

    def test_vertices_merged_at_float32_positions(self):
        """Two vertices that only a float32 STL makes one (1e-9 mm apart) are merged before the check, as a slicer would."""
        v, f, _ = box()
        v2 = np.vstack([v, v[3] + 1e-9])
        f2 = f.copy(); f2[f2 == 3] = len(v)          # every face of corner 3 uses the twin vertex ...
        f2[0][f2[0] == len(v)] = 3                  # ... except one
        vr, fr, rep = yolmed_server._repair_mesh(v2, f2)
        self.assertEqual(len(vr), 8)
        self.assertTrue(yolmed_server._mesh_check(yolmed_server._stl_bytes(vr, fr, "x"))[1])

    def test_header_names_the_version(self):
        v, f, _ = box()
        data = yolmed_server._stl_bytes(v, f, "YOLMED guide " + yolmed_server.VERSION)
        self.assertTrue(data[:80].startswith(b"YOLMED guide " + yolmed_server.VERSION.encode()))
        self.assertNotEqual(data[:5].lower(), b"solid")
        self.assertEqual(len(data), 84 + 50 * len(f))


if __name__ == "__main__":
    unittest.main()
