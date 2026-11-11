"""Pads and bounded saw slots in the production guide (plan 2026-10-30, steps 5 and 6), as the studio's preview kernel
(gkernel.js) builds them. Fast, no server.

  * g.pads: the inner surface touches the bone only on round pads (radius padR) just past each saw slot on the kept
    side, elsewhere it stands `relief` mm further off; without pads the guide is unchanged.
  * planes[].clip: a slot exists only where every half-space N.(x - p) >= -t holds (the marginal resection's upright
    slots stop at the horizontal one); a slot without clip runs through the whole guide as before.

    python3 tests/server/test_pads_clip.py -v
"""
import copy
import unittest

import numpy as np

from common import yolmed_server as Y
from test_slot_boss import flat_request, mesh, solid_at


class PadsAndClip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plain = Y.build_guide(flat_request())
        rq = flat_request()
        rq["g"].update({"pads": 1, "padR": 3, "relief": 1})
        cls.pads = Y.build_guide(rq)
        rq = flat_request()
        # the slot exists only for y >= 0 (half-space +y through the origin)
        rq["planes"][0]["clip"] = [{"p": [0, 0, 0], "N": [0, 1, 0], "t": 0}]
        cls.clip = Y.build_guide(rq)

    def test_pads_lift_the_inner_surface_off_the_bone_except_on_the_pads(self):
        tm0, tm1 = mesh(self.plain), mesh(self.pads)
        self.assertTrue(tm1.is_watertight)
        # the pad centres: past the slot (half 0.4 + bossW 2 + padR 3 + 1 = 6.4 mm) at v = +-max(padR + 1, W / 4) = +-4, on the guide side (side +1) of the cut
        on_pad = [[6.4, 4, 0.3 + 0.9], [6.4, -4, 0.3 + 0.9]]
        off_pad = [[6.4, 0, 0.3 + 0.9], [10.5, 4, 0.3 + 0.9]]
        self.assertTrue(solid_at(tm0, on_pad + off_pad).all(), 'the plain guide touches everywhere')
        self.assertTrue(solid_at(tm1, on_pad).all(), 'the pads touch the bone')
        self.assertFalse(solid_at(tm1, off_pad).any(), 'between the pads the guide stands off the bone')
        # 2 mm over the bone (past the relief) the body is there again
        self.assertTrue(solid_at(tm1, [[6.4, 0, 0.3 + 2.0], [10.5, 4, 0.3 + 2.0]]).all())
        self.assertLess(self.pads["volume_mm3"], self.plain["volume_mm3"])

    def test_a_clipped_slot_stops_at_its_bound(self):
        tm0, tm2 = mesh(self.plain), mesh(self.clip)
        self.assertTrue(tm2.is_watertight)
        mid_neg, mid_pos = [[0, -3, 0.3 + 1.0]], [[0, 3, 0.3 + 1.0]]
        self.assertFalse(solid_at(tm0, mid_neg + mid_pos).any(), 'the plain slot is open across the whole guide')
        self.assertFalse(solid_at(tm2, mid_pos).any(), 'the clipped slot is open where the clip holds')
        self.assertTrue(solid_at(tm2, mid_neg).all(), 'and closed past its bound')

    def test_piece_pads_on_the_kept_side_and_never_relieved_everywhere(self):
        """K3 F1: one piece of a two-piece guide has its body on the uc side of its slot (here the slot at the -u end,
        uc = +9). The old side rule (away from uc) put the pads past the slot on the defect side, off the body, and
        relieved the whole inner surface: the guide touched the bone nowhere. g.padSide = +1 puts them on +u (the kept
        bone); pads off the body are not built, and with fewer than 2 left no relief is applied."""
        def piece(**gx):
            rq = flat_request()
            rq["g"].update({"uc": 9}, **gx)
            return Y.build_guide(rq)
        plain, side, old_rule = piece(), piece(pads=1, padSide=1), piece(pads=1)
        tp, ts = mesh(plain), mesh(side)
        self.assertTrue(ts.is_watertight)
        # the pads at u = 0.4 + bossW 2 + padR 4 + 1 = 7.4, v = +-max(padR + 1, W / 4) = +-5 (the body is 6 each side)
        on_pad = [[7.4, 4.5, 0.3 + 0.6], [7.4, -4.5, 0.3 + 0.6]]
        off_pad = [[15, 0, 0.3 + 0.6], [4, 0, 0.3 + 0.6]]
        self.assertTrue(solid_at(ts, on_pad).all(), 'the pads touch the bone')
        self.assertFalse(solid_at(ts, off_pad).any(), 'elsewhere the guide stands off the bone')
        self.assertTrue(solid_at(tp, off_pad).all())
        # the inner surface comes as close to the bone as without pads (the clearance), not relief mm further off
        self.assertAlmostEqual(ts.vertices[:, 2].min(), tp.vertices[:, 2].min(), delta=0.1)
        # the old rule (no padSide) puts the pads off this body: none is built and the guide is the plain guide
        self.assertEqual(old_rule["stl_b64"], plain["stl_b64"])
        self.assertEqual((side["pads"], old_rule["pads"]), (2, 0))

    def test_pads_that_do_not_fit_on_a_short_body_leave_it_unrelieved(self):
        """K3 F1: a body ending less than ~7.4 mm + padR past its slot has no room for the pads: no relief at all."""
        rq = flat_request()
        rq["g"]["L"] = 12
        plain = Y.build_guide(copy.deepcopy(rq))
        rq["g"]["pads"] = 1
        out = Y.build_guide(rq)
        self.assertEqual(out["stl_b64"], plain["stl_b64"], 'the inner surface as without pads')
        self.assertEqual(out["pads"], 0)
        self.assertEqual(self.pads["pads"], 2)

    def test_validation(self):
        rq = flat_request()
        rq["planes"][0]["clip"] = [{"p": [0, 0], "N": [0, 1, 0]}]
        with self.assertRaises(Y.HttpError):
            Y._validate_guide(rq)

    def test_bad_pad_wing_and_clip_numbers_are_a_400(self):
        """K3 F3 / F4: these used to raise ValueError / TypeError / OverflowError (a 500) or pass by truthiness."""
        bad = [("g", "padR", "abc"), ("g", "padR", [3]), ("g", "padR", 10 ** 400), ("g", "relief", {}), ("g", "relief", "x"),
               ("g", "pads", "no"), ("g", "pads", 2), ("g", "padSide", 2), ("g", "padSide", "1"), ("g", "L", 10 ** 400),
               ("g", "vc", float("nan")), ("g", "uc", float("inf")),
               ("wing", None, [-(10 ** 400), 5]), ("wing", None, [-5, float("inf")]), ("wing", None, [-5.0, 38.5]),
               ("clip", None, [{"p": [0, 0, 0], "N": [0, 1, 0], "t": 10 ** 400}])]
        for where, k, val in bad:
            rq = flat_request()
            if where == "g":
                rq["g"][k] = val
            else:
                rq["planes"][0][where] = val
            with self.assertRaises(Y.HttpError, msg=(where, k, val)) as e:
                Y.build_guide(rq)
            self.assertEqual(e.exception.code, 400)
        # still accepted: pads as bool or 0/1, padSide -1/0/1, a wing up to W/2 + 32 mm off g.vc (W 12 here: 38)
        for gx, wing in [({"pads": True, "padSide": -1}, [-38.0, 38.0]), ({"pads": 0, "padSide": 0, "vc": 2}, [-36.0, 40.0])]:
            rq = flat_request()
            rq["g"].update(gx)
            rq["planes"][0]["wing"] = wing
            Y._validate_guide(rq)


if __name__ == "__main__":
    unittest.main()
