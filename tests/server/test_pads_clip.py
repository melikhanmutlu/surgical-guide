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

    def test_validation(self):
        rq = flat_request()
        rq["planes"][0]["clip"] = [{"p": [0, 0], "N": [0, 1, 0]}]
        with self.assertRaises(Y.HttpError):
            Y._validate_guide(rq)


if __name__ == "__main__":
    unittest.main()
