"""Pipeline pieces added for the real-data audit: series choice, the working grid the bone is chosen on (same rule as the browser),
maxilla trimming, plan warnings, dropped guide parts and saw slot width. Synthetic volumes only.

    python3 tests/test_pipeline.py
"""
import os
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "web", "unit"))
from surgiguide import bones, guides, plan as P, segment   # noqa: E402
from surgiguide.volume import Volume, write_dicom_series   # noqa: E402


class Series(unittest.TestCase):
    def test_choice_by_description_and_default(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as d2:
            write_dicom_series(Volume(np.zeros((6, 8, 8), np.float32), (1, 1, 1), (0, 0, 0)), d, "0.625mm Bone")
            write_dicom_series(Volume(np.zeros((9, 8, 8), np.float32), (1, 1, 1), (0, 0, 0)), d2, "5mm Stnd")
            for f in os.listdir(d2):                  # both series in one folder (the files are named by slice number)
                os.rename(os.path.join(d2, f), os.path.join(d, "b_" + f))
            self.assertEqual(Volume.from_dicom_dir(d).array.shape[0], 9, "default: the series with most slices")
            self.assertEqual(Volume.from_dicom_dir(d, "bone").array.shape[0], 6, "substring of the description, any case")
            with self.assertRaises(FileNotFoundError) as e:
                Volume.from_dicom_dir(d, "nothing")
            self.assertIn("5mm Stnd", str(e.exception), "the message lists the series that exist")


class WorkGrid(unittest.TestCase):
    def test_block_average_like_the_browser(self):
        vol = Volume(np.zeros((40, 100, 100), np.float32), (0.48, 0.48, 0.625), (10.0, 20.0, 30.0))
        W = segment.Work(vol)
        self.assertEqual(W.F, [1.0, 2.0, 2.0])                      # round(0.8 / 0.48) = 2, round(0.8 / 0.625) = 1
        self.assertEqual(W.array.shape, (40, 50, 50))
        np.testing.assert_allclose(W.spacing, (0.96, 0.96, 0.625))
        np.testing.assert_allclose(W.world([[0, 0, 0]])[0], vol.index_to_physical([0.5, 0.5, 0.0]))   # centre of the first block

    def test_block_mean(self):
        a = np.zeros((4, 8, 8), np.float32)
        a[:, :2, :2] = 400.0                                       # one block of 2 x 2 voxels
        W = segment.Work(Volume(a, (0.4, 0.4, 0.8), (0, 0, 0)))
        self.assertEqual(W.F, [1.0, 2.0, 2.0])
        self.assertEqual(int(W.array[0, 0, 0]), 400); self.assertEqual(int(W.array[0, 0, 1]), 0)

    def test_even_resampling_when_too_many_voxels(self):
        vol = Volume(np.random.default_rng(1).normal(100, 10, (60, 90, 90)).astype(np.float32), (1.0, 1.0, 1.0), (0, 0, 0))
        W = segment.Work(vol, max_vox=30000)
        self.assertLessEqual(W.array.size, 30000)
        self.assertTrue(all(F > 1 for F in W.F))
        self.assertAlmostEqual(W.spacing[0] / W.spacing[2], 1.0, places=6)      # an even grid
        self.assertAlmostEqual(float(W.array.mean()), 100, delta=2)


def ball(shape, c, r):
    z, y, x = np.indices(shape)
    return (z - c[0]) ** 2 + (y - c[1]) ** 2 + (x - c[2]) ** 2 <= r * r


def rod(shape, p0, p1, r):
    z, y, x = np.indices(shape)
    a, b = np.array(p0, float), np.array(p1, float)
    d = b - a
    t = np.clip(((np.stack([z, y, x], -1) - a) @ d) / (d @ d), 0, 1)
    return np.linalg.norm(np.stack([z, y, x], -1) - (a + t[..., None] * d), axis=-1) <= r


class Maxilla(unittest.TestCase):
    SH = (110, 130, 130)

    def arch(self):
        m = np.zeros(self.SH, bool)
        for a in range(180, 361, 3):
            m |= ball(self.SH, (40, 100 + 42 * np.sin(np.radians(a)), 65 + 42 * np.cos(np.radians(a))), 7)
        return m

    def test_central_column_above_the_occlusal_plane_is_cut_off_condyles_stay(self):
        m = self.arch()
        arch_vol = int(m.sum())
        col = rod(self.SH, (40, 58, 65), (64, 60, 65), 2.2) | ball(self.SH, (72, 62, 65), 6)          # premaxilla column: neck + blob
        con = [rod(self.SH, (40, 100, x), (64, 100, x), 2.2) | ball(self.SH, (72, 100, x), 6) for x in (23, 107)]   # condyles
        piece = m | col | con[0] | con[1]
        info = dict(status="split", ratio=0.45, volume_cm3=piece.sum() / 1000.0)
        out, i2 = bones.trim_maxilla(piece, (1.0, 1.0, 1.0), (0, 0, 0), lambda g: np.asarray(g, float) * 1.0, info)
        self.assertGreater(i2["trimmed_cm3"], 0.5)
        self.assertIn("maxilla", i2["note"])
        self.assertFalse(out[72, 62, 65], "the central blob is gone")
        self.assertTrue(out[72, 100, 23] and out[72, 100, 107], "lateral blobs (condyles) stay")
        self.assertGreater(int(out.sum()), 0.97 * arch_vol, "the arch itself is untouched")

    def test_whole_pieces_and_pieces_without_a_candidate_are_untouched(self):
        m = self.arch()
        out, info = bones.trim_maxilla(m, (1.0, 1.0, 1.0), (0, 0, 0), lambda g: np.asarray(g, float), dict(status="whole", volume_cm3=1.0))
        self.assertTrue((out == m).all())
        out, info = bones.trim_maxilla(m, (1.0, 1.0, 1.0), (0, 0, 0), lambda g: np.asarray(g, float),
                                       dict(status="split", ratio=0.45, volume_cm3=m.sum() / 1000.0))
        self.assertTrue((out == m).all())
        self.assertEqual(info.get("trimmed_cm3", 0.0), 0.0)


class Plans(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from test_surgiguide import mandible, cylinder      # the audit's own fixtures
        vol, m = mandible()
        cls.A = P.Arch(vol, m)
        fv, fm, _ = cylinder(length=260.0)
        cls.F = P.Fibula(fv, fm)

    def test_clean_plan_has_no_warnings(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=2)
        self.assertEqual(p["warnings"], [], p["warnings"])
        self.assertEqual(P.plan_summary(p, self.F)["plan_warnings"], [])

    def test_short_segments_and_deviation_are_reported_not_silent(self):
        p = P.make_plan(self.A, self.F, -20, 20, n_segments=4)                 # 4 x 10 mm
        self.assertTrue(any("segment 1 is" in w and "below" in w for w in p["warnings"]), p["warnings"])
        p = P.make_plan(self.A, self.F, -30, 30, n_segments=1)                 # a single chord over a 60 mm arc
        self.assertGreater(p["max_deviation_mm"], 2.5)
        self.assertTrue(any("deviation" in w and "tolerance" in w for w in p["warnings"]), p["warnings"])

    def test_automatic_choice_that_leaves_the_tolerance_says_so(self):
        p = P.make_plan(self.A, self.F, -20, 20)       # 2 segments would be < 20 mm: one chord is taken, 5 mm off the arch
        self.assertEqual(p["n_segments"], 1)
        self.assertTrue(any("deviation" in w for w in p["warnings"]), p["warnings"])

    def test_ramus_and_angle_resections_lie_on_the_arch(self):
        A = self.A
        for s_a, s_b in ((A.s_body[1] - 20, A.s_body[1] + 25), (A.s_body[0] - 30, A.s_body[0] - 5), (A.s_body[1] + 2, A.s[-1] - 2)):
            p = P.make_plan(A, self.F, s_a, s_b)
            self.assertTrue(all(g["length_mm"] >= 19.0 for g in p["segments"]) or p["segment_decision"]["reason"] == "short", p["segments"])
            self.assertGreater(len(p["segments"]), 0)

    def test_automatic_count_takes_the_smallest_deviation_when_the_tolerance_is_out_of_reach(self):
        _, dev, n, d = P.choose_segments(self.A, -40, 40, 0.01, 20.0)
        ok = [c for c in d["candidates"] if c["shortest_segment_mm"] >= 20.0]
        self.assertEqual(d["reason"], "len")
        self.assertLessEqual(dev, min(c["deviation_mm"] for c in ok) + 0.5)
        self.assertLessEqual(n, 4)

    def test_oblique_cut_is_reported(self):
        segs = [dict(index=0, length_mm=30.0, angle_start_deg=10.0, angle_end_deg=41.0)]
        w = P.plan_warnings(segs, 1.0, 1, 2.5, 20.0, 0.0, 30.0)
        self.assertEqual(len(w), 1)
        self.assertIn("41 deg", w[0])

    def test_short_fibula_is_reported(self):
        self.assertTrue(any("too short" in w for w in P.plan_warnings([], 1.0, 1, 2.5, 20.0, 12.5, 30.0)))


class GuideParts(unittest.TestCase):
    def test_dropped_part_warns_dust_does_not(self):
        g = np.zeros((30, 30, 30), bool)
        g[2:12, 2:12, 2:12] = True                    # main piece
        g[20:23, 20:23, 20:23] = True                 # 27 voxels
        _, rep = guides._largest("x", g, 0.5)         # 3.4 mm3 dropped
        self.assertIn("warning", rep)
        self.assertIn("dropped", rep["warning"])
        g[20:23, 20:23, 20:23] = False
        g[25, 25, 25] = True                          # one voxel: 0.125 mm3
        _, rep = guides._largest("x", g, 0.5)
        self.assertNotIn("warning", rep)

    def test_slot_is_never_narrower_than_the_blade(self):
        for h in (0.2, 0.25, 0.3, 0.35, 0.4):
            for k in (0.8, 0.9, 1.0, 1.2, 1.5):
                w = guides._slot_width(k, h)
                self.assertGreaterEqual(w, k - 1e-9, (h, k))
                self.assertLess(w, k + h, (h, k))
        self.assertAlmostEqual(guides._slot_width(1.0, 0.3), 1.2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
