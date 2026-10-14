"""Unit tests for surgiguide/plan.py and surgiguide/guides.py (offline pipeline used by run_pipeline.py / seg_server.py).
Synthetic inputs only: the package's own mandible phantom at 1 mm and hand-made cylinder fibulae. The audited checkout is
imported read-only (no bytecode is written into it).

    python3 -I test_surgiguide.py          (SG_REPO overrides the checkout path)
"""
import os
import sys
import unittest

sys.dont_write_bytecode = True
REPO = os.environ.get("SG_REPO") or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
sys.path.insert(0, REPO)

import numpy as np                                   # noqa: E402
from scipy import ndimage as ndi                     # noqa: E402
from surgiguide import plan as P, guides as Gd, phantom  # noqa: E402
from surgiguide.volume import Volume                 # noqa: E402


def mandible():
    vol = phantom.mandible_phantom(spacing=(1.0, 1.0, 1.0))
    m = vol.array > 250
    lab, n = ndi.label(m)
    m = lab == (np.argmax(ndi.sum(m, lab, range(1, n + 1))) + 1)   # drop the hyoid distractor
    return vol, m


def cylinder(radius=7.0, length=200.0, tilt=(0.05, 0.02), h=0.5):
    """Straight cylinder along a slightly tilted axis, voxel mask on an axis-aligned grid (spacing h)."""
    a = np.array([tilt[0], tilt[1], 1.0]); a /= np.linalg.norm(a)
    R = radius + 6
    shape = (int((length + 20) / h), int(2 * R / h) + 4 + int(length * abs(tilt[1]) / h), int(2 * R / h) + 4 + int(length * abs(tilt[0]) / h))
    origin = np.array([-R - 2 - length * max(0, -tilt[0]), -R - 2 - length * max(0, -tilt[1]), -10.0])
    vol = Volume(np.zeros(shape, np.float32), (h, h, h), origin)
    z, y, x = np.meshgrid(*(np.arange(n) for n in shape), indexing="ij")
    pts = vol.index_to_physical(np.stack([x, y, z], -1).reshape(-1, 3)).reshape(shape + (3,))
    t = pts @ a
    radial = np.linalg.norm(pts - t[..., None] * a, axis=-1)
    m = (radial <= radius) & (t >= 0) & (t <= length)
    return vol, m, a


ARCH = None


def arch():
    global ARCH
    if ARCH is None:
        vol, m = mandible()
        ARCH = (vol, m, P.Arch(vol, m))
    return ARCH


class TestArch(unittest.TestCase):
    def test_midline_and_direction(self):
        _, _, A = arch()
        self.assertLess(abs(A.point(0.0)[0]), 1.5, "s = 0 is at the midline (x ~ 0)")
        self.assertGreater(A.point(30.0)[0], 10, "+s goes to patient left (+x in LPS)")
        self.assertLess(A.point(-30.0)[0], -10)

    def test_arc_length_parametrisation(self):
        _, _, A = arch()
        ss = np.arange(-30, 30.01, 0.5)
        steps = np.linalg.norm(np.diff(A.point(ss), axis=0), axis=1)
        self.assertTrue(np.all(np.abs(steps - 0.5) < 0.05), f"0.5 mm in s is 0.5 mm along the curve (max err {np.abs(steps - 0.5).max():.3f})")

    def test_buccal_points_outward_and_is_horizontal_unit(self):
        _, _, A = arch()
        for s in (-35, -10, 0, 10, 35):
            b = A.buccal(s)
            self.assertAlmostEqual(float(np.linalg.norm(b)), 1.0, places=6)
            self.assertLess(abs(b[2]), 1e-9)
            self.assertGreater(np.dot(b, A.point(s) - A.center), 0)
            self.assertLess(abs(np.dot(b, A.tangent(s))), 1e-6)

    def test_arch_continues_up_both_rami_to_the_condyles(self):
        _, _, A = arch()
        lo, hi = A.s_body
        self.assertLess(lo, -40); self.assertGreater(hi, 40)
        self.assertGreater(A.ramus_mm[0], 25, "right ramus on the arch: " + str(A.ramus_mm))
        self.assertGreater(A.ramus_mm[1], 25, "left ramus on the arch")
        self.assertAlmostEqual(A.s[0], lo - A.ramus_mm[0], delta=0.6); self.assertAlmostEqual(A.s[-1], hi + A.ramus_mm[1], delta=0.6)
        for sign, end in ((-1, lo), (1, hi)):
            top = A.point(end + sign * A.ramus_mm[0 if sign < 0 else 1] - 1)
            self.assertGreater(top[2], A.point(end)[2] + 20, "the ramus end is well above the angle")
            self.assertGreater(sign * top[0], 30, "on the patient's side")
            t = A.tangent(end + sign * 15)
            self.assertGreater(sign * t[2], 0.7, "the tangent climbs the ramus with s running away from the chin: " + str(t))
            self.assertTrue(A.on_ramus(end + sign * 5)); self.assertFalse(A.on_ramus(end - sign * 5))
        self.assertFalse(A.on_ramus(0.0))

    def test_buccal_on_the_ramus_is_lateral_unit_and_perpendicular_to_the_tangent(self):
        _, _, A = arch()
        for sign, end in ((-1, A.s_body[0]), (1, A.s_body[1])):
            s = end + sign * 15
            b, t = A.buccal(s), A.tangent(s)
            self.assertAlmostEqual(np.linalg.norm(b), 1.0, places=6)
            self.assertLess(abs(np.dot(b, t)), 0.05)
            self.assertGreater(sign * b[0], 0.9, "points away from the midline: " + str(b))

    def test_closest_s_inverts_point(self):
        _, _, A = arch()
        for s in (-25.0, 0.0, 17.5):
            self.assertLess(abs(A.closest_s(A.point(s)) - s), 0.51)


class TestSegments(unittest.TestCase):
    def test_more_segments_follow_the_arch_better(self):
        _, _, A = arch()
        k1, d1 = P.optimise_segments(A, -30, 30, 1)
        k3, d3 = P.optimise_segments(A, -30, 30, 3)
        self.assertEqual(len(k3), 4)
        self.assertAlmostEqual(k3[0], -30); self.assertAlmostEqual(k3[-1], 30)
        self.assertTrue(np.all(np.diff(k3) > 0), "knots strictly increasing")
        self.assertLess(d3, d1 / 2, f"3 segments deviate less ({d3:.2f}) than 1 ({d1:.2f})")

    def test_max_deviation_zero_for_straight_chord(self):
        class Line:
            def point(self, s): return np.stack([s, 0 * s, 0 * s], -1) if np.ndim(s) else np.array([s, 0.0, 0.0])
        self.assertLess(P._max_deviation(Line(), np.array([0.0, 10.0, 25.0])), 1e-9)


class TestFibula(unittest.TestCase):
    def test_pca_frame_radius_and_extent(self):
        vol, m, a = cylinder()
        F = P.Fibula(vol, m, side="right")
        self.assertGreater(float(np.dot(F.axes[:, 0], a)), 0.9999, "long axis recovered, pointing up (distal -> proximal)")
        self.assertTrue(np.allclose(F.axes.T @ F.axes, np.eye(3), atol=1e-9), "orthonormal")
        self.assertAlmostEqual(float(np.linalg.det(F.axes)), 1.0, places=9)
        self.assertLess(F.axes[0, 1], 0, "right leg: lateral axis points to -x")
        self.assertLess(abs(F.radius - 7.0), 0.6, f"radius {F.radius:.2f}")
        self.assertLess(abs((F.s_max - F.s_min) - 200.0), 1.5)
        self.assertGreater(P.Fibula(vol, m, side="left").axes[0, 1], 0)


class TestPlan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, _, cls.A = arch()
        vol, m, _ = cylinder(length=260.0)
        cls.F = P.Fibula(vol, m)

    def test_plan_geometry(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=3, kerf=1.0)
        segs = p["segments"]
        self.assertEqual(len(segs), 3); self.assertEqual(p["n_segments"], 3)
        for g in segs:
            R = g["R"]
            self.assertTrue(np.allclose(R.T @ R, np.eye(3), atol=1e-9))
            chord = g["P_end"] - g["P_start"]
            self.assertAlmostEqual(g["length_mm"], float(np.linalg.norm(chord)), places=9)
            self.assertTrue(np.allclose(R[:, 0], chord / np.linalg.norm(chord)), "fibula axis maps to the segment chord")
            self.assertAlmostEqual(g["fib_end"] - g["fib_start"], g["length_mm"], places=9)
            for key in ("n_start_fib", "n_end_fib"):
                self.assertAlmostEqual(float(np.linalg.norm(g[key])), 1.0, places=9)
        for a, b in zip(segs[:-1], segs[1:]):
            self.assertTrue(np.allclose(a["n_end_fib"] @ a["R"].T, b["n_start_fib"] @ b["R"].T), "shared wedge plane, same mandible normal")
            self.assertGreaterEqual(b["fib_start"] - a["fib_end"], p["kerf"] + 1.0, "cuts of neighbours are kept apart")
        self.assertAlmostEqual(segs[0]["fib_start"] - self.F.s_min, 70.0, places=6, msg="distal margin")
        self.assertTrue(np.allclose(p["points"][0], self.A.point(-25)))

    def test_ramus_resection_is_plannable_and_its_guides_are_built(self):
        A = self.A
        s0 = A.s_body[1] + 4
        p = P.make_plan(A, self.F, s0, s0 + 30)
        self.assertGreaterEqual(p["n_segments"], 1)
        self.assertGreater(p["points"][-1][2], p["points"][0][2] + 20, "the defect climbs the ramus")
        self.assertFalse(any("outside" in w for w in p["warnings"]))
        for which in (0, 1):
            vol, m, _ = arch()
            mesh, plane, rep = Gd.mandible_guide(vol, m, A, p, which, h=0.5)
            self.assertGreater(len(mesh.faces), 100, rep)
            self.assertIn("seat", rep)
        with self.assertRaises(ValueError) as cm:
            P.make_plan(A, self.F, A.s[-1] - 10, A.s[-1] + 30)
        self.assertIn("condyle to condyle", str(cm.exception))

    def test_wedge_spacing_keeps_cuts_from_crossing_inside_bone(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=3, kerf=1.0)
        r = self.F.radius
        for a, b in zip(p["segments"][:-1], p["segments"][1:]):
            n0, n1 = a["n_end_fib"], b["n_start_fib"]
            # worst case across the bone cross-section (radius r): the two planes must not meet
            for ang in np.linspace(0, 2 * np.pi, 72, endpoint=False):
                q = np.array([0.0, r * np.cos(ang), r * np.sin(ang)])
                s_end = a["fib_end"] - (q[1:] @ n0[1:]) / n0[0]
                s_start = b["fib_start"] - (q[1:] @ n1[1:]) / n1[0]
                self.assertGreater(s_start - s_end, p["kerf"], "segment n+1 starts after segment n ends at every rim point")

    def test_automatic_segment_count_respects_min_length_and_tolerance(self):
        p = P.make_plan(self.A, self.F, -30, 30, n_segments=None, tol_mm=2.5, min_len=20.0)
        self.assertTrue(all(g["length_mm"] >= 20.0 for g in p["segments"]))
        self.assertTrue(p["max_deviation_mm"] <= 2.5 or p["n_segments"] == 4 or min(g["length_mm"] for g in p["segments"]) < 40)
        short = P.make_plan(self.A, self.F, -8, 8, n_segments=None, min_len=20.0)
        self.assertEqual(short["n_segments"], 1, "a 16 mm defect falls back to one segment even below min_len")

    def test_fibula_too_short_is_flagged(self):
        vol, m, _ = cylinder(length=150.0)
        F = P.Fibula(vol, m)
        p = P.make_plan(self.A, F, -30, 30, n_segments=3)
        self.assertFalse(p["fibula_fits"]); self.assertGreater(p["fibula_overflow_mm"], 0)
        ok = P.make_plan(self.A, self.F, -15, 15, n_segments=1)
        self.assertTrue(ok["fibula_fits"]); self.assertEqual(ok["fibula_overflow_mm"], 0)

    def test_summary(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=2)
        s = P.plan_summary(p, self.F)
        self.assertEqual(s["n_segments"], 2); self.assertEqual(len(s["segments"]), 2)
        self.assertEqual(s["segments"][0]["fibula_from_distal_tip_mm"], 70.0)
        self.assertEqual(s["defect_arc_length_mm"], 50.0)


class TestGuides(unittest.TestCase):
    def test_hole_and_largest(self):
        L = np.stack(np.meshgrid(np.arange(-5, 5.01, 0.5), np.arange(-5, 5.01, 0.5), np.arange(-5, 5.01, 0.5), indexing="ij"), -1)
        h = Gd._hole(L, np.zeros(3), np.array([0, 0, 1.0]), 1.0)
        self.assertTrue(h[10, 10, 15]); self.assertFalse(h[13, 10, 15], "1.5 mm off axis is outside r = 1")
        self.assertFalse(h[10, 10, 0], "more than 2 mm behind the start point is not drilled")
        g = np.zeros((10, 10, 10), bool); g[1:4, 1:4, 1:4] = True; g[6:8, 6:8, 6:8] = True
        out, rep = Gd._largest("x", g, 0.5)
        self.assertEqual(int(out.sum()), 27); self.assertEqual(rep["pieces_before_cleanup"], 2)
        self.assertAlmostEqual(rep["dropped_islands_mm3"], 1.0)

    def test_fibula_guide_clearance_slots_and_single_piece(self):
        vol, m, _ = cylinder(length=260.0)
        F = P.Fibula(vol, m)
        _, _, A = arch()
        p = P.make_plan(A, F, -25, 25, n_segments=2, kerf=1.0)
        mesh, planes, rep = Gd.fibula_guide(vol, m, F, p, h=0.3, clearance=0.3, wall=2.5)
        # the shell strip between the two tilted slots of a closing wedge is cut through where the slots meet above the
        # bone rim (spacing is computed at the bone radius, the guide wall is further out), leaving small side islands
        # that _largest drops and reports; they lie over the discarded wedge, so the kept guide is one piece
        self.assertLess(rep["dropped_islands_mm3"], 0.02 * mesh.volume, rep)
        self.assertEqual(len(mesh.split(only_watertight=False)), 1)
        self.assertEqual(len(planes), 4)
        self.assertTrue(mesh.is_watertight)
        loc = (mesh.vertices - F.c) @ F.axes
        rad = np.linalg.norm(loc[:, 1:], axis=1)
        mid = (p["segments"][0]["fib_start"] + p["segments"][0]["fib_end"]) / 2
        inner = rad[(np.abs(loc[:, 0] - mid) < 4) & (rad < F.radius + 1.5)]
        self.assertGreater(inner.size, 20)
        gap = float(np.median(inner)) - 7.0
        print(f"    fibula guide inner surface: median {gap:.2f} mm from the bone (design 0.30)")
        self.assertLess(abs(gap - 0.3), 0.2, f"clearance {gap:.2f}")
        # kerf slot: no guide vertex lies strictly inside a slot (|dist to plane| < kerf/2 - h) within the wall
        for pt, n in planes:
            d = np.abs((loc - pt) @ n)
            self.assertFalse(np.any((d < 0.5 - 0.3) & (rad < F.radius + 2.5)), "slot is open through the wall (the rail above it stays, by design)")

    def test_shell_offset_quantisation_matches_browser_finding(self):
        # the same shell rule (dout = EDT * h > clearance) at h = 0.4 / clearance 0.3 puts the inner face on the bone
        # (see B-1 for app.js); at h = 0.3 the rule happens to give 0.3. Measured on a flat slab, analytic surface at z = 0.
        def inner_face(h, c):
            z = np.arange(-4, 6, h) + h / 2 * 0.37            # arbitrary grid phase
            bone = z <= 0
            dout = ndi.distance_transform_edt(~bone) * h
            shell = (dout > c) & (dout <= c + 2.5)
            i = np.argmax(shell)
            return (z[i - 1] + z[i]) / 2                       # marching-cubes 0.5 iso between voxels
        self.assertLess(abs(inner_face(0.3, 0.3) - 0.3), 0.16)
        self.assertLess(inner_face(0.4, 0.3), 0.15, "h = 0.4: clearance collapses to ~0")


class TestSegmentChoiceAndKerf(unittest.TestCase):
    """choose_segments (the table and the rule of web/fibula.js segmentChoice) and the kerf-side setting."""
    @classmethod
    def setUpClass(cls):
        cls.vol, cls.m, cls.A = arch()
        cls.vol_f, cls.m_f, _ = cylinder(length=320.0); cls.F = P.Fibula(cls.vol_f, cls.m_f)

    def test_short_defect_is_one_segment_with_a_warning_not_a_critical(self):
        knots, dev, n, d = P.choose_segments(self.A, -8, 8, 2.5, 20.0)
        self.assertEqual(n, 1); self.assertEqual(d["reason"], "short"); self.assertEqual(len(knots), 2)
        self.assertEqual(d["candidates"][0]["n"], 1); self.assertIn("shortest_segment_mm", d["candidates"][0])
        p = P.make_plan(self.A, self.F, -8, 8)
        self.assertEqual(p["n_segments"], 1); self.assertEqual(p["segment_decision"]["reason"], "short")
        w = p["warnings"]
        self.assertTrue(any("shorter than one 20 mm segment" in x for x in w), w)
        self.assertFalse(any("below the 20 mm" in x for x in w), "no per-segment short warning on top: " + str(w))

    def test_never_a_segment_under_min_len_when_another_count_avoids_it(self):
        # an unreachable tolerance: the rule falls back to the most segments that keep every segment >= 20 mm
        knots, dev, n, d = P.choose_segments(self.A, -30, 30, 0.01, 20.0)
        self.assertEqual(d["reason"], "len")
        lens = [float(np.linalg.norm(self.A.point(b) - self.A.point(a))) for a, b in zip(knots[:-1], knots[1:])]
        self.assertTrue(all(x >= 20.0 - 1e-6 for x in lens), lens)
        ok = [c for c in d["candidates"] if c["shortest_segment_mm"] >= 20.0]
        # the smallest deviation among the counts that keep every segment >= 20 mm (fewer segments on a tie within 0.5 mm)
        self.assertLessEqual(dev, min(c["deviation_mm"] for c in ok) + 0.5)
        self.assertTrue(all(c["deviation_mm"] >= dev - 0.5 for c in ok if c["n"] < n), "a smaller count only loses by > 0.5 mm: " + str(ok))
        self.assertTrue(any(c["shortest_segment_mm"] < 20.0 for c in d["candidates"]), "the table shows the rejected count too: " + str(d))
        p = P.make_plan(self.A, self.F, -30, 30, tol_mm=0.01)
        self.assertTrue(any("smallest deviation among the counts" in x for x in p["warnings"]), p["warnings"])
        # a reachable tolerance (just above the deviation of the first count that keeps every segment >= 20 mm): the
        # fewest segments within it
        tol = ok[0]["deviation_mm"] + 0.05
        _, dev2, n2, d2 = P.choose_segments(self.A, -30, 30, tol, 20.0)
        self.assertEqual(d2["reason"], "dev"); self.assertLessEqual(dev2, tol); self.assertEqual(n2, ok[0]["n"])

    def test_pick_segments_mirrors_the_web_rule_stump_preference_and_tie(self):
        row = lambda n, lens, dev: dict(n=n, lens=lens, dev=dev, min_len=min(lens))
        self.assertEqual((P.SEG_ERR, P.STUMP_MIN, P.DEV_TIE), (15, 25.0, 0.5))
        self.assertTrue(P.lens_ok([25, 20, 25]) and P.lens_ok([22]) and not P.lens_ok([24, 30, 25]) and not P.lens_ok([30, 19, 30]))
        # the same tables as tests/web/unit/test_adaptive.mjs (segmentChoice)
        r, why = P.pick_segments([row(1, [70], 6), row(2, [22, 48], 2), row(3, [26, 20, 26], 1)], 70, 3.0)
        self.assertEqual((r["n"], why), (3, "dev"))
        r, why = P.pick_segments([row(1, [50], 6), row(2, [22, 28], 2)], 50, 3.0)
        self.assertEqual((r["n"], why), (2, "dev"))
        r, why = P.pick_segments([row(1, [141.5], 26.3), row(2, [13.3, 128], 27.7), row(3, [24.7, 60, 55], 7.8), row(4, [17.9, 40, 40, 40], 4.9)], 141.5, 3.0)
        self.assertEqual((r["n"], why), (3, "len"), "a 24.7 mm stump segment is not traded for a 26 mm deviation")
        r, _ = P.pick_segments([row(1, [80], 9), row(2, [22, 58], 4.0), row(3, [26, 28, 26], 4.3)], 80, 3.0)
        self.assertEqual(r["n"], 3, "stump-acceptable within 0.5 mm preferred")
        r, _ = P.pick_segments([row(1, [80], 9), row(2, [22, 58], 4.0), row(3, [26, 28, 26], 4.6)], 80, 3.0)
        self.assertEqual(r["n"], 2)
        r, _ = P.pick_segments([row(1, [60], 5), row(2, [30, 30], 4.7), row(3, [20, 20, 20], 4.6)], 60, 3.0)
        self.assertEqual(r["n"], 1, "deviations within 0.5 mm: fewer segments")

    def test_length_bands_and_gap_error(self):
        def pw(lens, gap=0.0):
            segs = [dict(index=i, length_mm=x, angle_start_deg=0.0, angle_end_deg=0.0) for i, x in enumerate(lens)]
            return P.plan_warnings(segs, 0.0, len(lens), 3.0, 20.0, -1.0, sum(lens), None, gap, "centre")
        w = pw([14.0, 40.0])
        self.assertTrue(any(x.startswith("ERROR") and "15 mm" in x for x in w), w)
        w = pw([18.0, 40.0])
        self.assertFalse(any(x.startswith("ERROR") for x in w), w); self.assertTrue(any("15-20 mm" in x for x in w), w)
        w = pw([22.0, 30.0, 40.0])
        self.assertTrue(any("meets a stump" in x for x in w), w); self.assertFalse(any(x.startswith("ERROR") for x in w))
        self.assertFalse(any("meets a stump" in x for x in pw([22.0])), "a single segment touches both stumps: no stump rule")
        self.assertTrue(any(x.startswith("ERROR") and "gap" in x for x in pw([30.0, 30.0], 2.5)))
        self.assertFalse(any(x.startswith("ERROR") for x in pw([30.0, 30.0], 1.2)))
        self.assertTrue(any("above 1.0 mm" in x for x in pw([30.0, 30.0], 1.2)))
        # between two grafts the gap is 0 by construction (both faces cut to one plane): reported, not checked (D4 P19)
        self.assertEqual(P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=1.0)["joint_gap_mm"], [0.0])

    def test_slot_width_separate_from_the_blade(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=1.0)
        self.assertEqual(p["slot_w"], 1.0, "default: the slot is the blade, as before")
        q = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=0.6, slot_w=0.8, kerf_side="centre")
        self.assertAlmostEqual(q["slot_w"], 0.8); self.assertEqual(q["stump_gap_mm"], [0.4, 0.4])
        a, b = q["segments"][0], q["segments"][1]
        self.assertGreaterEqual(b["fib_start"] - a["fib_end"], 0.8 + 1.0 - 1e-6, "segments spaced by the slot + 1 mm")
        self.assertFalse(any("wider than the" in x for x in q["warnings"]), q["warnings"])
        wide = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=0.6, slot_w=1.2)
        self.assertTrue(any("wider than the" in x for x in wide["warnings"]), wide["warnings"])
        self.assertAlmostEqual(P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=1.0, slot_w=0.5)["slot_w"], 1.0, msg="never narrower than the blade")
        fg, planes, rep = Gd.fibula_guide(self.vol_f, self.m_f, self.F, q, h=0.5)
        self.assertAlmostEqual(rep["slot_mm"], Gd._slot_width(0.8, 0.5)); self.assertGreater(rep["slot_mm"], Gd._slot_width(0.6, 0.5) - 1e-9)
        self.assertGreaterEqual(rep["screws"], 3, "at least three guide screws")

    def test_fibula_screw_sites_two_per_long_segment_three_in_all_clear_of_slots(self):
        def segs_faces(lens, gap=2.0, tilt=0.0):
            segs, faces, s = [], [], 0.0
            n = np.array([np.cos(tilt), np.sin(tilt), 0.0])
            for i, L in enumerate(lens):
                segs.append(dict(index=i, length_mm=L, fib_start=s, fib_end=s + L))
                faces += [(np.array([s, 0, 0]), n, -1), (np.array([s + L, 0, 0]), n, +1)]
                s += L + gap
            return segs, faces
        segs, faces = segs_faces([30.0, 22.0])
        pos, dropped = Gd.fibula_screw_sites(segs, faces, 1.0, 2.2, 7.0)
        self.assertEqual(dropped, []); self.assertEqual(len(pos), 3, pos)
        self.assertEqual(sum(1 for s in pos if 0 <= s <= 30), 2, "two on the 30 mm segment")
        for s in pos:
            self.assertTrue(all(abs(s - f[0][0] - f[2] * 0.5) >= 0.5 + 1.1 + 2.0 - 1e-9 for f in faces), "hole clear of every slot")
        segs, faces = segs_faces([40.0])
        self.assertEqual(len(Gd.fibula_screw_sites(segs, faces, 1.0, 2.2, 7.0)[0]), 3, "a single segment still gets three")
        # a segment fully under oblique slots: no clear position, reported instead of drilled through a slot
        segs, faces = segs_faces([12.0, 40.0], tilt=np.radians(70))
        pos, dropped = Gd.fibula_screw_sites(segs, faces, 1.0, 2.2, 7.0)
        self.assertIn(0, dropped)

    def test_kerf_side_sets_the_stump_gap_and_the_slot_position(self):
        p = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=1.0)
        self.assertEqual(p["kerf_side"], "resected"); self.assertEqual(p["stump_gap_mm"], [0.0, 0.0])
        c = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=1.0, kerf_side="centre")
        self.assertEqual(c["stump_gap_mm"], [0.5, 0.5])
        self.assertEqual(P.plan_summary(c, self.F)["graft_to_stump_gap_mm"], [0.5, 0.5])
        with self.assertRaises(ValueError):
            P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf_side="left")
        big = P.make_plan(self.A, self.F, -25, 25, n_segments=2, kerf=2.4, kerf_side="centre")
        self.assertTrue(any("graft-to-stump gap 1.20 mm" in w for w in big["warnings"]), big["warnings"])
        # the guide's slot: flush = the slot lies on the resected side of the planned plane (plane point moved back by
        # half a slot), centred = the plane point is the stump face itself
        for which in (0, 1):
            m_res, pl_res, rep_res = Gd.mandible_guide(self.vol, self.m, self.A, p, which, h=0.5)
            m_cen, pl_cen, rep_cen = Gd.mandible_guide(self.vol, self.m, self.A, c, which, h=0.5)
            keep = pl_res[1]
            P0 = np.asarray(p["points"][0] if which == 0 else p["points"][-1])
            self.assertLess(float((pl_res[0] - P0) @ keep), -0.4, "flush: slot centre behind the stump face")
            self.assertAlmostEqual(float((pl_cen[0] - P0) @ keep), 0.0, places=6)
            self.assertEqual(rep_res["stump_gap_mm"], 0.0); self.assertEqual(rep_cen["stump_gap_mm"], 0.5)
            self.assertIn("free_directions", rep_res["seat"])
            # the slot is open where it is planned: no guide vertex deep inside it (whole shell thickness, near the plane)
            sw = Gd._slot_width(1.0, 0.5)
            for mesh, lo, hi in ((m_res, -sw, 0.0), (m_cen, -sw / 2, sw / 2)):
                u = (mesh.vertices - P0) @ keep
                near_pl = np.linalg.norm(mesh.vertices - P0 - np.outer(u, keep), axis=1) < 10
                self.assertFalse(np.any((u > lo + 0.3) & (u < hi - 0.3) & near_pl), f"slot {lo}..{hi} is open")
            # and shell material stands on the kept side right past the flush slot (u > 0) and past the centred slot (u > sw/2)
            u_r = (m_res.vertices - P0) @ keep
            self.assertTrue(np.any((u_r > 0.2) & (u_r < 1.0)), "guide wall right behind the stump face")

    def test_seat_check_shell_past_the_equator_cannot_be_lifted(self):
        # cylinder bone along x (radius 8), a 2.5 mm shell at 0.3 mm clearance; seating normal = local axis 1 (+y)
        h = 0.5
        z, y, x = np.meshgrid(np.arange(-12, 12.01, h), np.arange(-12, 12.01, h), np.arange(0, 20.01, h), indexing="ij")
        r = np.hypot(y, z)
        bone = r <= 8
        upper = (r > 8.3) & (r <= 10.8) & (y >= 1)                        # ends 1 mm above the widest level
        deep = (r > 8.3) & (r <= 10.8) & (y >= -5)                        # 5 mm past it: hooked under the bone
        a = Gd.seat_check(upper, bone, h, axis=1, clearance=0.3)
        b = Gd.seat_check(deep, bone, h, axis=1, clearance=0.3)
        self.assertTrue(a["ok"] and b["ok"]); self.assertEqual(a["directions"], 33)
        self.assertGreater(a["free_directions"], 10, a); self.assertLessEqual(a["best_tilt_deg"], 10.0)
        self.assertEqual(b["free_directions"], 0, b); self.assertGreater(b["blocked_mm2_along_normal"], 20)
        self.assertEqual(Gd.seat_check(np.zeros_like(bone), bone, h)["ok"], False)



if __name__ == "__main__":
    unittest.main(verbosity=2)
