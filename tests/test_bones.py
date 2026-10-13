"""Bones that a threshold joins: surgiguide/bones.py (watershed with neck / core merging) and the pipeline wrappers
segment.mandible_bone / segment.fibula_bone, on synthetic volumes only.

    python3 tests/test_bones.py
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from surgiguide import bones, segment  # noqa: E402
from surgiguide.volume import Volume  # noqa: E402

SP = (1.0, 1.0, 1.0)


def rod(shape, axis, a, b, t0, t1, r):
    """Solid cylinder along `axis` ('z' | 'y' | 'x') through (a, b), t0..t1, radius r; array (z, y, x)."""
    z, y, x = np.indices(shape)
    t, u, v = {"z": (z, y, x), "y": (y, z, x), "x": (x, z, y)}[axis]
    return (t >= t0) & (t <= t1) & ((u - a) ** 2 + (v - b) ** 2 <= r * r)


def leg_ct(shape=(260, 60, 120)):
    """HU volume (z, y, x) of two lower legs (tibia r 9 and fibula r 5, joined by a 2 mm plate; right leg at x = 35 with
    the fibula lateral at x = 19, left leg at x = 85 with the fibula at x = 101) and a CT table plate; bone 700 HU."""
    z, y, x = np.indices(shape)
    m = np.zeros(shape, bool)
    for x0, sign in ((35, -1), (85, 1)):
        m |= rod(shape, "z", 30, x0, 5, 255, 9)                            # tibia
        m |= rod(shape, "z", 30, x0 + sign * 16, 5, 255, 5)                # fibula, lateral
        lo, hi = sorted((x0 + sign * 9 - sign * 3, x0 + sign * 13))
        m |= (z >= 120) & (z <= 132) & (x >= lo) & (x <= hi) & (y >= 29) & (y <= 31)    # thin contact between them
    m |= (y >= 48) & (y <= 52)                                              # table: a plate under the legs
    return Volume(np.where(m, 700.0, -1000.0).astype(np.float32), SP, (0, 0, 0))


class Separate(unittest.TestCase):
    def test_two_rods_with_a_bridge(self):
        shape = (60, 60, 100)
        m = rod(shape, "x", 30, 14, 10, 90, 9) | rod(shape, "x", 30, 34, 10, 90, 5)
        z, y, x = np.indices(shape)
        m |= (x >= 44) & (x <= 56) & (y >= 21) & (y <= 31) & (z >= 29) & (z <= 31)
        self.assertEqual(segment.ndi.label(m)[1], 1)
        lab = bones.Separator(m, SP).run(0.45)
        ids = [i for i in np.unique(lab) if i]
        self.assertEqual(len(ids), 2)
        self.assertEqual(int((lab > 0).sum()), int(m.sum()), "every voxel belongs to a piece")
        ps = bones.pieces(lab, SP, min_vox=100)
        thin = min(ps, key=lambda p: p["radius"])
        self.assertAlmostEqual(thin["radius"], 5, delta=1.2)
        self.assertGreater(thin["len"], 75)

    def test_one_bone_stays_whole(self):
        shape = (60, 80, 80)
        m = rod(shape, "x", 30, 30, 5, 75, 8) | rod(shape, "y", 30, 40, 30, 75, 6)
        lab = bones.Separator(m, SP).run(0.45)
        self.assertEqual(len([i for i in np.unique(lab) if i]), 1)

    def test_anisotropic_voxels(self):
        shape = (60, 60, 100)
        m = rod(shape, "x", 30, 14, 10, 90, 9)
        coarse = m[::2]                                              # 2 mm in z: same bone, half the slices
        lab = bones.Separator(coarse, (1.0, 1.0, 2.0)).run(0.45)
        self.assertEqual(len([i for i in np.unique(lab) if i]), 1)


class Mandible(unittest.TestCase):
    def test_mandible_sized_component_is_untouched(self):
        shape = (90, 120, 130)
        z, y, x = np.indices(shape)
        m = np.zeros(shape, bool)
        for a in range(180, 361, 3):
            cy, cx = 100 + 42 * np.sin(np.radians(a)), 65 + 42 * np.cos(np.radians(a))
            m |= (z - 40) ** 2 + (y - cy) ** 2 + (x - cx) ** 2 <= 49
        out, info = bones.pick_mandible(m, SP)
        self.assertEqual(info["status"], "whole")
        self.assertTrue((out == m).all())

    def test_too_big_and_unseparable_is_reported(self):
        m = rod((150, 150, 150), "z", 75, 75, 0, 149, 40)
        out, info = bones.pick_mandible(m, SP)
        self.assertEqual(info["status"], "failed")
        self.assertIn("warning", info)
        self.assertTrue((out == m).all(), "a failed cut returns the whole component, never part of it")

    def test_plan_rejects_a_skull_sized_mask(self):
        from surgiguide import plan
        vol = Volume(np.zeros((220, 150, 150), np.float32), SP, (0, 0, 0))
        m = np.zeros(vol.array.shape, bool)
        m[:, 40:110, 5:145] = True          # 140 mm wide, 220 mm tall: skull + spine
        with self.assertRaises(ValueError):
            plan.Arch(vol, m)


class Fibula(unittest.TestCase):
    def test_fibula_beside_tibia_not_table_not_whole_leg(self):
        vol = leg_ct()
        for side in ("right", "left"):
            m, info = segment.fibula_bone(vol, side=side, hu=250.0)
            self.assertEqual(info["status"], "ok", info)
            zz, yy, xx = np.nonzero(m)
            self.assertAlmostEqual(info["radius_mm"], 5, delta=1.5)
            self.assertGreater(info["length_mm"], 200)
            # the fibula is the lateral rod of the donor leg (right: x = 19, left: x = 101); the table is never taken
            self.assertAlmostEqual(xx.mean(), 19 if side == "right" else 101, delta=1.5)
            self.assertLess(m.sum() * 1e-3, 25, "a rod of r 5 and ~250 mm, not the whole leg")

    def test_explicit_component_keeps_the_old_behaviour(self):
        vol = leg_ct()
        m = segment.threshold_bone(vol, component=2)
        self.assertTrue(m.any())


if __name__ == "__main__":
    unittest.main(verbosity=2)
