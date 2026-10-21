"""Production guide checks added after a user printed-looking guide had slice terraces on its bone-contact surface
(thread "Guide STL kalitesi", 2026-10-21); fast, no server.

  - mask_scale: a request that carries the CT as an occupancy ramp gives an intaglio on the true bone surface + the
    clearance, without the terraces of a 0/1 mask (a sloped bone surface on 1 mm cells)
  - print_checks: thin walls (only where the body is thinner than PRINT_MIN_WALL, not on the edges of a thick body),
    guide material inside bone, guide material in the bone's shadow along the insertion direction

    python3 tests/server/test_print_checks.py -v
"""
import base64
import io
import unittest

import numpy as np
import trimesh

from common import yolmed_server as Y

SLOPE = 0.12


def sloped_request(soft, sp=1.0):
    """Bone below the plane z = SLOPE * x on 1 mm cells; the CT's partial volume is a linear ramp over +-1 mm."""
    nx, ny, nz = 40, 24, 24
    org = np.array([-20.0, -12.0, -14.0])
    z = org[2] + sp * np.arange(nz)[:, None, None]
    x = org[0] + sp * np.arange(nx)[None, None, :]
    d = np.broadcast_to((z - SLOPE * x) / np.sqrt(1 + SLOPE ** 2), (nz, ny, nx))
    if soft:
        occ = np.clip(0.5 - d / 2.0, 0, 1)
        m = np.round(occ * 255).astype(np.uint8)
        m[(occ >= 0.5) & (m < 128)] = 128
    else:
        m = (d <= 0).astype(np.uint8)
    q = {"crop": {"nx": nx, "ny": ny, "nz": nz, "sp": [sp] * 3, "origin": org.tolist(), "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
         "mask_b64": base64.b64encode(np.ascontiguousarray(m).tobytes()).decode(),
         "frame": {"p": [0, 0, 0], "u": [1, 0, 0], "v": [0, 1, 0], "n": [0, 0, 1]},
         "g": {"L": 24, "W": 12, "wrap": 2, "wall": 2, "clear": 0.3, "bridge": 2, "side": 1},
         "planes": [], "screws": [], "resolution": 0.2}
    if soft:
        q["mask_scale"] = 255
    return q


def intaglio_offsets(out):
    """Distances from the true bone plane of the guide's bone-facing triangles (centre of the body)."""
    tm = trimesh.load(io.BytesIO(base64.b64decode(out["stl_b64"])), file_type="stl")
    n = np.array([-SLOPE, 0, 1]) / np.sqrt(1 + SLOPE ** 2)
    c = tm.triangles_center
    d, fn = c @ n, tm.face_normals @ n
    sel = (d < 1.0) & (fn < -0.9) & (np.abs(c[:, 0]) < 9) & (np.abs(c[:, 1]) < 4)
    return d[sel]


class SoftMask(unittest.TestCase):
    def test_occupancy_mask_removes_the_terraces(self):
        b, s = Y.build_guide(sloped_request(False)), Y.build_guide(sloped_request(True))
        db, ds = intaglio_offsets(b), intaglio_offsets(s)
        self.assertGreater(len(ds), 20)
        # the 0/1 mask: steps of a cell along the slope (spread ~0.3 mm); the ramp: within 0.1 mm of clear (0.3 mm)
        self.assertGreater(db.std(), 0.15, db.std())
        self.assertLess(ds.std(), 0.06, ds.std())
        self.assertLess(abs(ds.mean() - 0.3), 0.06, ds.mean())
        self.assertTrue(s["production_ok"], s["issues"])

    def test_mask_scale_is_checked(self):
        q = sloped_request(True)
        for bad in (0, 256, 2.5, "255", True):
            q["mask_scale"] = bad
            with self.assertRaises(Y.HttpError):
                Y.build_guide(q)


class PrintChecks(unittest.TestCase):
    r = 0.2

    def grid(self):
        return np.zeros((60, 60, 60), bool)

    def test_thin_sheet_is_a_thin_wall(self):
        g = self.grid()
        g[10:50, 10:50, 30:33] = True                  # 0.6 mm sheet, 8 x 8 mm
        pc = Y.print_checks(g, self.grid(), None, self.r)
        self.assertGreater(pc["thin_patch_mm3"], Y.PRINT_THIN_PATCH_MM3, pc)

    def test_thick_block_edges_are_not_thin_walls(self):
        g = self.grid()
        g[10:50, 10:50, 20:40] = True                  # 8 x 8 x 4 mm block: only its edges lose voxels to the ball
        pc = Y.print_checks(g, self.grid(), None, self.r)
        self.assertLessEqual(pc["thin_patch_mm3"], Y.PRINT_THIN_PATCH_MM3, pc)

    def test_wall_at_the_limit_passes(self):
        g = self.grid()
        g[10:50, 10:50, 30:36] = True                  # 1.2 mm sheet
        pc = Y.print_checks(g, self.grid(), None, self.r)
        self.assertLessEqual(pc["thin_patch_mm3"], Y.PRINT_THIN_PATCH_MM3, pc)

    def test_overlap_and_undercut_volumes(self):
        g, bone, sh = self.grid(), self.grid(), self.grid()
        g[10:20, 10:20, 10:20] = True
        bone[15:25, 10:20, 10:20] = True               # 5 x 10 x 10 cells shared
        sh[10:12, 10:20, 10:20] = True                 # 2 x 10 x 10 cells in the shadow
        pc = Y.print_checks(g, bone, sh, self.r)
        self.assertAlmostEqual(pc["bone_overlap_mm3"], 500 * 0.008, places=2)
        self.assertAlmostEqual(pc["undercut_mm3"], 200 * 0.008, places=2)

    def test_reply_carries_the_checks(self):
        out = Y.build_guide(sloped_request(True))
        self.assertEqual(set(out["print_checks"]), {"thin_wall_mm3", "thin_patch_mm3", "bone_overlap_mm3", "undercut_mm3", "min_wall_mm"})
        self.assertFalse([i for i in out["issues"] if i["code"] in ("thin_wall", "bone_overlap", "undercut")])


if __name__ == "__main__":
    unittest.main()
