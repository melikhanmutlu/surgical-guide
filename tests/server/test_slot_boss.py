"""Saw slot rim (plan 1.3): with g.boss deeper than the wall the production guide is raised to `boss` mm over its inner
surface within bossW mm of each slot side, so the blade is guided over that depth; the slot itself stays open through
the rim; without boss (or boss <= wall, old plans) the guide is the same as before. Fast, no server.

    python3 tests/server/test_slot_boss.py -v
"""
import base64
import copy
import io
import unittest

import numpy as np
import trimesh

from common import yolmed_server as Y


def flat_request(boss=None):
    """Bone below z = 0 (1 mm cells), one saw slot across x = 0 (plane normal +x, 0.8 mm wide)."""
    nx, ny, nz = 40, 24, 24
    org = np.array([-20.0, -12.0, -14.0])
    z = org[2] + np.arange(nz)[:, None, None]
    m = np.broadcast_to((z <= 0), (nz, ny, nx)).astype(np.uint8)
    g = {"L": 24, "W": 12, "wrap": 2, "wall": 2, "clear": 0.3, "bridge": 2, "side": 1}
    if boss is not None:
        g.update({"boss": boss, "bossW": 2})
    return {"crop": {"nx": nx, "ny": ny, "nz": nz, "sp": [1.0] * 3, "origin": org.tolist(), "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
            "mask_b64": base64.b64encode(np.ascontiguousarray(m).tobytes()).decode(),
            "frame": {"p": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]},
            "g": g, "planes": [{"p": [0, 0, 0], "N": [1, 0, 0], "w": 0.8}], "screws": [], "resolution": 0.2}


def mesh(out):
    return trimesh.load(io.BytesIO(base64.b64decode(out["stl_b64"])), file_type="stl")


def solid_at(tm, pts):
    """Inside test by counting the crossings of a ray along +z (+ a small skew) with the triangles (no rtree needed)."""
    T = tm.triangles
    out = []
    for p in np.asarray(pts, float):
        d = np.array([1e-3, 2e-3, 1.0])
        e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]
        h = np.cross(np.broadcast_to(d, e2.shape), e2)
        a = np.einsum("ij,ij->i", e1, h)
        ok = np.abs(a) > 1e-12
        f = np.where(ok, 1 / np.where(ok, a, 1), 0)
        s = p - T[:, 0]
        u = f * np.einsum("ij,ij->i", s, h)
        q = np.cross(s, e1)
        v = f * (q @ d)
        t = f * np.einsum("ij,ij->i", e2, q)
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
        out.append(hit.sum() % 2 == 1)
    return np.array(out)


class SlotBoss(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plain = Y.build_guide(flat_request())
        cls.boss = Y.build_guide(flat_request(5.0))

    def test_rim_raises_the_guide_beside_the_slot(self):
        tm0, tm1 = mesh(self.plain), mesh(self.boss)
        self.assertTrue(tm1.is_watertight)
        # 1.2 mm beside the slot (within the 2 mm rim), 4 mm over the inner surface (clear 0.3 + 4): rim only
        beside = [[1.2, 0, 0.3 + 4.0], [-1.2, 0, 0.3 + 4.0]]
        self.assertFalse(solid_at(tm0, beside).any())
        self.assertTrue(solid_at(tm1, beside).all())
        # the guided depth: the rim's top stands boss - wall = 3 mm over the plain wall's top (both on the same bone surface)
        def top_at(tm, x0, x1):     # the highest upward-facing triangle centre over x0 <= |x| <= x1
            c, up = tm.triangles_center, tm.face_normals[:, 2] > 0.9
            return c[up & (np.abs(c[:, 0]) >= x0) & (np.abs(c[:, 0]) <= x1) & (np.abs(c[:, 1]) < 5)][:, 2].max()
        top, wall_top = top_at(tm1, 0.5, 2.3), top_at(tm0, 4, 9)
        self.assertAlmostEqual(top - wall_top, 3.0, delta=0.25)
        # away from the slot (8 mm off) the wall is unchanged
        self.assertFalse(solid_at(tm1, [[8, 0, 0.3 + 4.0]]).any())
        self.assertGreater(self.boss["volume_mm3"], self.plain["volume_mm3"])

    def test_slot_stays_open_through_the_rim(self):
        tm1 = mesh(self.boss)
        # in the slot (x = 0) at every depth of the rim: no material
        pts = [[0, y, z] for y in (-3, 0, 3) for z in (0.6, 1.5, 2.5, 3.5, 4.5)]
        self.assertFalse(solid_at(tm1, pts).any())

    def test_boss_up_to_the_wall_changes_nothing(self):
        same = Y.build_guide(flat_request(2.0))      # boss 2 = wall 2: no rim
        self.assertEqual(same["stl_b64"], self.plain["stl_b64"])

    def test_flange_carries_the_rim_past_the_edge(self):
        """plan A3: g.slotFlange carries the rim 3 mm past the body edge (W/2 = 6), the slot open through it; the same
        field as the preview kernel (gkernel.js)."""
        q = flat_request(5.0); q["g"]["slotFlange"] = 3.0
        out = Y.build_guide(q); tm = mesh(out)
        self.assertTrue(tm.is_watertight)
        past = [[1.2, 8.0, 0.3 + 2.0], [-1.2, -8.0, 0.3 + 2.0]]
        self.assertFalse(solid_at(mesh(self.boss), past).any())
        self.assertTrue(solid_at(tm, past).all())
        self.assertFalse(solid_at(tm, [[1.2, 10.0, 2.3], [8.0, 8.0, 2.3], [0.0, 8.0, 1.5], [0.0, 8.0, 3.5]]).any())

    def test_bad_boss_is_a_400(self):
        q = flat_request(5.0)
        q["g"]["boss"] = "high"
        with self.assertRaises(Y.HttpError) as e:
            Y.build_guide(q)
        self.assertEqual(e.exception.code, 400)
        q = flat_request(40.0)
        with self.assertRaises(Y.HttpError):
            Y.build_guide(copy.deepcopy(q))


if __name__ == "__main__":
    unittest.main()
