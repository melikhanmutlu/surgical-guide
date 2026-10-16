"""Input validation, limits, path traversal, case store integrity and headers of yolmed_server.py (ported from the
Denetim 3 audit suite; the expectations follow the fixes of Denetim 3 and 4).

    python3 tests/server/test_server_audit.py -v

Fast tests only (no heavy /guide geometry: test_guide_quality.py; slow clients: test_slow.py; auth / CORS / CSP:
test_http_security.py).
"""
import base64
import copy
import json
import math
import sqlite3
import threading
import time
import unittest

from common import (J, call, raw_http, start_server, stop_server, strict_json, tiny_guide_request, yolmed_server, np)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, cls.db, cls.port = start_server()

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def new_case(self, name="audit"):
        st, r = J(call(self.base, "POST", "/cases", {"name": name, "kind": "mandible", "fingerprint": "fp"}))
        self.assertEqual(st, 200, r)
        return r["id"]


# ------------------------------------------------------------------------------------------ body parsing
class T1_BodyParsing(Base):
    def test_malformed_json_400(self):
        st, r = J(call(self.base, "POST", "/cases", raw=b'{"name": "x",'))
        self.assertEqual(st, 400, r)

    def test_json_array_400(self):
        st, r = J(call(self.base, "POST", "/cases", raw=b'["name"]'))
        self.assertEqual(st, 400, r)

    def test_empty_body_400(self):
        st, r = J(call(self.base, "POST", "/cases", raw=b""))
        self.assertEqual(st, 400, r)

    def test_non_utf8_400(self):
        st, r = J(call(self.base, "POST", "/cases", raw=b'{"name": "\xff\xfe"}'))
        self.assertEqual(st, 400, r)

    def test_bad_content_length_400(self):
        for cl in (b"abc", b"-5"):
            code, resp = raw_http(self.port, b"POST /cases HTTP/1.1\r\nHost: x\r\nContent-Length: " + cl + b"\r\n\r\n{}")
            self.assertEqual(code, 400, (cl, resp[:200]))

    def test_plan_body_over_limit_413_header_only(self):
        n = yolmed_server.MAX_PLAN_BODY + 1
        code, resp = raw_http(self.port, b"POST /cases HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % n)
        self.assertEqual(code, 413, resp[:200])

    def test_plan_body_over_limit_413_real_body(self):
        cid = self.new_case()
        big = {"plan": {"blob": "x" * yolmed_server.MAX_PLAN_BODY}}
        try:
            st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", big))
        except OSError as e:          # server answers 413 and closes without draining the upload
            self.fail(f"client could not read the 413: {type(e).__name__}: {e}")
        self.assertEqual(st, 413, r)

    def test_plan_body_just_under_limit_ok(self):
        cid = self.new_case()
        pad = yolmed_server.MAX_PLAN_BODY - 200
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", {"plan": {"blob": "y" * pad}}))
        self.assertEqual(st, 200, r)
        st, c = J(call(self.base, "GET", f"/cases/{cid}"))
        self.assertEqual(len(c["draft"]["blob"]), pad)

    def test_guide_body_over_max_body_413(self):
        n = yolmed_server.MAX_BODY + 1
        code, resp = raw_http(self.port, b"POST /guide HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % n)
        self.assertEqual(code, 413, resp[:200])

    def test_deeply_nested_json_is_400_not_500(self):
        depth = 200000                                      # 400 kB, well under MAX_PLAN_BODY
        raw = b'{"plan": ' + b"[" * depth + b"]" * depth + b"}"
        cid = self.new_case()
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", raw=raw))
        self.assertEqual(st, 400, (st, r))

    def test_nan_in_plan_rejected_or_stored_as_valid_json(self):
        """Python's json accepts NaN/Infinity; browsers' JSON.parse does not. A case that stores NaN can no
        longer be opened by the studio."""
        cid = self.new_case("nan case")
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", raw=b'{"plan": {"x": NaN, "y": Infinity}}'))
        if st == 400:
            return
        st, h, b = call(self.base, "GET", f"/cases/{cid}")
        strict_json(b)                                     # raises -> test fails

    def test_overflowing_number_rejected(self):
        """D4 P8: 1e999 parses to inf and would be stored as Infinity, which JSON.parse refuses: 400, nothing stored."""
        cid = self.new_case("inf case")
        for raw in (b'{"plan": {"x": 1e999}}', b'{"plan": {"x": -1e400}}'):
            st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", raw=raw))
            self.assertEqual(st, 400, r)
        st, r = J(call(self.base, "POST", f"/cases/{cid}/versions", raw=b'{"plan": {"n": 1e999}}'))
        self.assertEqual(st, 400, r)
        st, h, b = call(self.base, "GET", f"/cases/{cid}")
        self.assertIsNone(strict_json(b)["draft"])

    def test_nan_in_version_poisons_history(self):
        cid = self.new_case("nan version")
        st, r = J(call(self.base, "POST", f"/cases/{cid}/versions", raw=b'{"plan": {"a": -Infinity}, "note": "n"}'))
        if st == 400:
            return
        st, h, b = call(self.base, "GET", f"/cases/{cid}/versions/{r['n']}")
        strict_json(b)


# ------------------------------------------------------------------------------------------ /cases fields
class T2_CaseFields(Base):
    def test_name_validation(self):
        for body in ({}, {"name": ""}, {"name": "   "}, {"name": 123}, {"name": None}, {"name": ["a"]}):
            st, r = J(call(self.base, "POST", "/cases", body))
            self.assertEqual(st, 400, (body, st, r))

    def test_extra_fields_ignored(self):
        st, r = J(call(self.base, "POST", "/cases", {"name": "x", "evil": {"$where": 1}, "id": "chosen"}))
        self.assertEqual(st, 200, r)
        self.assertNotEqual(r["id"], "chosen")

    def test_kind_object_is_400_not_500(self):
        st, r = J(call(self.base, "POST", "/cases", {"name": "x", "kind": {"a": 1}, "fingerprint": [1, 2]}))
        self.assertEqual(st, 400, (st, r))

    def test_version_note_object_is_400_not_500(self):
        cid = self.new_case()
        st, r = J(call(self.base, "POST", f"/cases/{cid}/versions", {"plan": {}, "note": {"x": 1}, "author": ["a"]}))
        self.assertEqual(st, 400, (st, r))

    def test_plan_required(self):
        cid = self.new_case()
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", {"nope": 1}))
        self.assertEqual(st, 400, r)
        st, r = J(call(self.base, "POST", f"/cases/{cid}/versions", {"plan": None}))
        self.assertEqual(st, 400, r)

    def test_huge_version_number_is_404_not_500(self):
        cid = self.new_case()
        st, r = J(call(self.base, "GET", f"/cases/{cid}/versions/99999999999999999999999"))
        self.assertEqual(st, 404, (st, r))

    def test_unknown_methods(self):
        cid = self.new_case()
        st, _, _ = call(self.base, "DELETE", f"/cases/{cid}")
        self.assertEqual(st, 405)
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/versions/1", {"plan": {}}))
        self.assertEqual(st, 405)
        st, r = J(call(self.base, "PUT", "/cases", {"name": "x"}))
        self.assertEqual(st, 405)

    def test_sql_injection_like_ids_404(self):
        for p in ("/cases/x'%20OR%201=1--", "/cases/%27", "/cases/a b", "/cases/" + "a" * 5000):
            st, r = J(call(self.base, "GET", p.replace(" ", "%20")))
            self.assertEqual(st, 404, (p[:40], st, r))
        st, lst = J(call(self.base, "GET", "/cases"))
        self.assertEqual(st, 200)

    def test_name_and_author_limits(self):
        """D3 L-14 / D4 P11: a case name (listed in every GET /cases) and a version author are at most 200 characters."""
        st, r = J(call(self.base, "POST", "/cases", {"name": "N" * 3_000_000}))
        self.assertEqual(st, 400, r)
        st, r = J(call(self.base, "POST", "/cases", {"name": "N" * (yolmed_server.MAX_NAME + 1)}))
        self.assertEqual(st, 400, r)
        st, r = J(call(self.base, "POST", "/cases", {"name": "N" * yolmed_server.MAX_NAME}))
        self.assertEqual(st, 200, r)
        st, r = J(call(self.base, "POST", f"/cases/{r['id']}/versions", {"plan": {}, "author": "A" * (yolmed_server.MAX_NAME + 1)}))
        self.assertEqual(st, 400, r)


# ------------------------------------------------------------------------------------------ versions
class T3_VersionIntegrity(Base):
    def test_concurrent_versions_contiguous(self):
        cid = self.new_case("concurrency")
        out, errs = [], []

        def post(i):
            try:
                st, r = J(call(self.base, "POST", f"/cases/{cid}/versions", {"plan": {"i": i}, "note": str(i), "author": "t"}))
            except OSError as e:                          # a refused / reset connection is a failure too, not a lost thread
                st, r = None, repr(e)
            (out if st == 200 else errs).append((i, r))
        ths = [threading.Thread(target=post, args=(i,)) for i in range(40)]
        [t.start() for t in ths]; [t.join() for t in ths]
        self.assertFalse(errs, errs[:3])
        ns = sorted(r["n"] for _, r in out)
        self.assertEqual(ns, list(range(1, 41)))
        for i, r in out:                                  # each n holds the plan its request sent
            st, v = J(call(self.base, "GET", f"/cases/{cid}/versions/{r['n']}"))
            self.assertEqual(v["plan"], {"i": i})
        st, lst = J(call(self.base, "GET", "/cases"))
        self.assertEqual({c["id"]: c["n_versions"] for c in lst}[cid], 40)

    def test_versions_immutable_at_db_level(self):
        cid = self.new_case("immut")
        call(self.base, "POST", f"/cases/{cid}/versions", {"plan": {"a": 1}})
        c = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.DatabaseError):
            c.execute("UPDATE versions SET plan='{}' WHERE case_id=?", (cid,))
        with self.assertRaises(sqlite3.DatabaseError):
            c.execute("DELETE FROM versions WHERE case_id=?", (cid,))
        c.close()
        st, v = J(call(self.base, "GET", f"/cases/{cid}/versions/1"))
        self.assertEqual(v["plan"], {"a": 1})

    def test_draft_does_not_touch_versions(self):
        cid = self.new_case("draft")
        call(self.base, "POST", f"/cases/{cid}/versions", {"plan": {"v": 1}})
        call(self.base, "PUT", f"/cases/{cid}/draft", {"plan": {"d": 2}})
        st, vs = J(call(self.base, "GET", f"/cases/{cid}/versions"))
        self.assertEqual([v["n"] for v in vs], [1])
        st, v = J(call(self.base, "GET", f"/cases/{cid}/versions/1"))
        self.assertEqual(v["plan"], {"v": 1})

    def test_draft_lost_update_is_silent(self):
        """Informational (design): two writers on one draft, last write wins, no conflict detection."""
        cid = self.new_case("lost update")
        call(self.base, "PUT", f"/cases/{cid}/draft", {"plan": {"by": "A"}})
        st, r = J(call(self.base, "PUT", f"/cases/{cid}/draft", {"plan": {"by": "B"}}))
        self.assertEqual(st, 200)
        st, c = J(call(self.base, "GET", f"/cases/{cid}"))
        self.assertEqual(c["draft"], {"by": "B"})


# ------------------------------------------------------------------------------------------ static + traversal
class T4_StaticTraversal(Base):
    def get_raw(self, path):
        return raw_http(self.port, b"GET " + path + b" HTTP/1.1\r\nHost: x\r\n\r\n")

    def test_index_and_config(self):
        st, h, b = call(self.base, "GET", "/")
        self.assertEqual(st, 200); self.assertIn(b"<html", b.lower()[:2000])
        st, h, b = call(self.base, "GET", "/config.js")
        self.assertEqual(st, 200); self.assertIn(b"YOLMED_SERVER", b)

    def test_traversal_blocked(self):
        for p in (b"/../yolmed_server.py", b"/../../etc/passwd", b"/..%2fyolmed_server.py", b"/%2e%2e/yolmed_server.py",
                  b"//etc/passwd", b"/./../README.md", b"/web/../../etc/hostname", b"/..\\yolmed_server.py",
                  b"/" + b"../" * 30 + b"etc/passwd", b"/%2e%2e%2f%2e%2e%2fetc%2fpasswd"):
            code, resp = self.get_raw(p)
            self.assertEqual(code, 404, (p, resp[:120]))
            self.assertNotIn(b"root:", resp); self.assertNotIn(b"import ", resp)

    def test_absolute_path_join(self):
        # os.path.join(root, "/etc/passwd") would escape; lstrip("/") prevents it
        code, resp = self.get_raw(b"/%2Fetc/passwd")
        self.assertEqual(code, 404)

    def test_raw_nul_byte_gets_a_response(self):
        code, resp = self.get_raw(b"/index.html\x00.js")
        self.assertIsNotNone(code, "connection dropped without an HTTP response (unhandled ValueError)")
        self.assertEqual(code, 404)

    def test_percent_encoded_static_name_served(self):
        """Functional: URL-encoded static paths are not decoded (e.g. a file name with a space or %2E)."""
        st, _, _ = call(self.base, "GET", "/index%2Ehtml")
        self.assertEqual(st, 200)

    def test_case_paths_with_dotdot(self):
        for p in (b"/cases/../index.html", b"/cases/..%2f..%2fetc", b"/cases/abc/../../x/versions/1"):
            code, resp = self.get_raw(p)
            self.assertIn(code, (404, 405), (p, resp[:120]))
            self.assertNotIn(b"<html", resp.lower())


# ------------------------------------------------------------------------------------------ /guide validation
class T5_GuideValidation(Base):
    def post(self, req):
        return J(call(self.base, "POST", "/guide", req))

    def expect(self, req, codes=(400,), label=""):
        st, r = self.post(req)
        self.assertIn(st, codes, (label, st, r))
        self.assertIn("error", r, (label, r))
        return st, r

    def test_tiny_valid_request_ok(self):
        st, r = self.post(tiny_guide_request())
        self.assertEqual(st, 200, r)
        self.assertTrue(r["watertight"]); self.assertEqual(r["bodies"], 1)

    def test_missing_fields(self):
        base = tiny_guide_request()
        for path in (("crop",), ("mask_b64",), ("frame",), ("g",), ("g", "L"), ("g", "wall"), ("frame", "n"),
                     ("crop", "nx"), ("crop", "sp"), ("crop", "axes")):
            req = copy.deepcopy(base)
            d = req
            for k in path[:-1]:
                d = d[k]
            del d[path[-1]]
            self.expect(req, label=path)

    def test_wrong_types(self):
        base = tiny_guide_request()
        for mut in (lambda q: q.update(g=[1, 2]), lambda q: q.update(crop="abc"), lambda q: q.update(planes="abc"),
                    lambda q: q.update(screws=[1]), lambda q: q["g"].update(L="wide"), lambda q: q.update(mask_b64=5),
                    lambda q: q.update(planes=[{"p": [0, 0], "N": [1, 0, 0], "w": 1}])):
            req = copy.deepcopy(base); mut(req)
            self.expect(req, label=str(mut))

    def test_stops_as_list_is_400_not_500(self):
        req = tiny_guide_request(); req["stops"] = [1, 2]
        self.expect(req, label="stops list")

    def test_gap_as_list_is_400_not_500(self):
        req = tiny_guide_request(); req["gap"] = [1, 2]
        self.expect(req, label="gap list")

    def test_wrap_profile_dict_is_400_not_500(self):
        req = tiny_guide_request(); req["wrap_profile"] = {"a": 1}
        self.expect(req, label="wrap_profile dict")

    def test_non_finite(self):
        base = tiny_guide_request()
        for mut in (lambda q: q["g"].update(L=float("nan")), lambda q: q["g"].update(wall=float("inf")),
                    lambda q: q["frame"].update(n=[0, 0, float("nan")]), lambda q: q["crop"].update(sp=[1, float("nan"), 1]),
                    lambda q: q.update(resolution=float("nan")), lambda q: q["planes"][0].update(w=float("nan")),
                    lambda q: q["planes"][0].update(N=[float("inf"), 0, 0])):
            req = copy.deepcopy(base); mut(req)
            raw = json.dumps(req).encode()                    # json.dumps writes NaN / Infinity literals
            st, r = J(call(self.base, "POST", "/guide", raw=raw))
            self.assertEqual(st, 400, (str(mut), st, r))

    def test_nan_frame_origin(self):
        req = tiny_guide_request(); req["frame"]["p"] = [float("nan"), 0, 0]
        st, r = J(call(self.base, "POST", "/guide", raw=json.dumps(req).encode()))
        self.assertIn(st, (400, 422), r)

    def test_nan_plane_point_rejected(self):
        req = tiny_guide_request(); req["planes"][0]["p"] = [float("nan"), 0, 0]
        st, r = J(call(self.base, "POST", "/guide", raw=json.dumps(req).encode()))
        self.assertEqual(st, 400, (st, {k: r.get(k) for k in ("error", "watertight", "bodies", "volume_mm3")}))

    def test_nan_screw_entry_rejected(self):
        req = tiny_guide_request()
        req["screws"] = [{"entry": [float("nan"), 0, 6], "dir": [0, 0, -1], "d": 2, "D": 4, "sleeveH": 3}]
        st, r = J(call(self.base, "POST", "/guide", raw=json.dumps(req).encode()))
        self.assertEqual(st, 400, (st, r))

    def test_out_of_range(self):
        base = tiny_guide_request()
        for mut in (lambda q: q["g"].update(L=1000), lambda q: q["g"].update(L=1), lambda q: q["g"].update(wall=0.1),
                    lambda q: q["g"].update(clear=5), lambda q: q["g"].update(wrap=-1), lambda q: q["g"].update(bridge=99),
                    lambda q: q["planes"][0].update(w=0), lambda q: q["planes"][0].update(w=50),
                    lambda q: q.update(resolution=0.01), lambda q: q.update(resolution=5),
                    lambda q: q.update(screws=[{"entry": [0, 0, 6], "dir": [0, 0, -1], "d": 3, "D": 2, "sleeveH": 3}]),
                    lambda q: q.update(screws=[{"entry": [0, 0, 6], "dir": [0, 0, 0], "d": 2, "D": 4, "sleeveH": 3}]),
                    lambda q: q.update(stops={"pos": [50, 1]}), lambda q: q.update(gap={"A": {}, "B": {}, "flange": 99}),
                    lambda q: q["crop"].update(sp=[1, 0, 1]), lambda q: q["crop"].update(nx=1, ny=1, nz=1)):
            req = copy.deepcopy(base); mut(req)
            st, r = self.post(req)
            self.assertEqual(st, 400, (str(mut), st, r))

    def test_gap_plane_width_unchecked(self):
        """gap.A/B.w is not range-checked (planes[].w is)."""
        req = tiny_guide_request()
        req["gap"] = {"A": {"p": [-3, 0, 0], "N": [1, 0, 0], "w": -1e6}, "B": {"p": [3, 0, 0], "N": [1, 0, 0], "w": 1}}
        st, r = self.post(req)
        self.assertEqual(st, 400, (st, r.get("error"), r.get("bodies")))

    def test_mask_errors(self):
        req = tiny_guide_request(); req["mask_b64"] = "!!!notbase64"
        self.expect(req, label="bad b64")
        req = tiny_guide_request(); req["mask_b64"] = base64.b64encode(b"\x01" * 10).decode()
        self.expect(req, label="short mask")

    def test_max_crop_422_before_decoding(self):
        req = tiny_guide_request(); req["crop"].update(nx=10000, ny=10000, nz=10)
        t = time.perf_counter()
        st, r = self.post(req)
        self.assertEqual(st, 422, r); self.assertLess(time.perf_counter() - t, 2)

    def test_negative_dims_product_positive(self):
        req = tiny_guide_request(); req["crop"].update(nx=-30, ny=-20)
        self.expect(req, label="negative dims")

    def test_singular_axes(self):
        req = tiny_guide_request(); req["crop"]["axes"] = [[0, 0, 0]] * 3
        self.expect(req, codes=(400, 422), label="singular axes")

    def test_max_grid_422(self):
        req = tiny_guide_request()
        req["screws"] = [{"entry": [3000, 3000, 3000], "dir": [0, 0, -1], "d": 2, "D": 4, "sleeveH": 3}]
        st, r = self.post(req)
        self.assertEqual(st, 422, (st, r))

    def test_far_screw_gives_floating_sleeve(self):
        """Informational: a screw 300 mm off the guide is accepted; the response reports 2 bodies."""
        req = tiny_guide_request()
        req["screws"] = [{"entry": [0, 0, 300], "dir": [0, 0, -1], "d": 2, "D": 4, "sleeveH": 3}]
        st, r = self.post(req)
        print(f"\n  [info] far screw: HTTP {st}, bodies {r.get('bodies')}, watertight {r.get('watertight')}")
        self.assertEqual(st, 200)

    def test_max_grid_overflow(self):
        """Screw entry far away: np.prod(shape) wraps in int64 and skips the MAX_GRID check, but numpy then refuses
        the allocation -> 400. Harmless; accepted as 400 or 422."""
        req = tiny_guide_request()
        req["screws"] = [{"entry": [1e7, 1e7, 1e7], "dir": [0, 0, -1], "d": 2, "D": 4, "sleeveH": 3}]
        st, r = self.post(req)
        self.assertIn(st, (400, 422), (st, r))

    def test_no_bone_422(self):
        req = tiny_guide_request(); req["frame"]["p"] = [500, 500, 500]
        st, r = self.post(req)
        self.assertEqual(st, 422, r)

    def test_many_planes_cost(self):
        """Resource: plane / screw counts are unbounded. Records time for 400 slots on the tiny case."""
        req = tiny_guide_request()
        req["planes"] = [{"p": [-7 + 14 * i / 399, 0, 0], "N": [1, 0.01 * (i % 7), 0], "w": 0.1} for i in range(400)]
        t = time.perf_counter()
        st, r = self.post(req)
        dt = time.perf_counter() - t
        print(f"\n  [info] 400 planes on tiny case: HTTP {st} in {dt:.1f} s")
        self.assertIn(st, (200, 400, 422))


# ------------------------------------------------------------------------------------------ /segment
class T6_Segment(Base):
    Q = "/segment?nx=12&ny=10&nz=8&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"

    def test_ok(self):
        hu = np.full((8, 10, 12), -1000, np.int16); hu[2:6, 3:7, 4:9] = 1200
        st, h, b = call(self.base, "POST", self.Q, raw=hu.tobytes(), headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 200); self.assertEqual(len(b), 960)

    def test_size_mismatch_400(self):
        st, h, b = call(self.base, "POST", self.Q, raw=b"\0" * 100, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 400)

    def test_missing_params_400(self):
        for q in ("/segment", "/segment?nx=2&ny=2&nz=2", "/segment?nx=2&ny=2&nz=2&sp=1,1,1&origin=0,0,0&axes=1,2",
                  "/segment?nx=a&ny=2&nz=2&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"):
            st, h, b = call(self.base, "POST", q, raw=b"\0" * 16, headers={"Content-Type": "application/octet-stream"})
            self.assertEqual(st, 400, (q, st))

    def test_over_max_voxels_rejected_without_reading(self):
        q = "/segment?nx=1024&ny=1024&nz=1024&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"
        code, resp = raw_http(self.port, b"POST " + q.encode() + b" HTTP/1.1\r\nHost: x\r\nContent-Length: 2147483648\r\n\r\n")
        self.assertEqual(code, 400)

    def test_negative_dims_400(self):
        q = "/segment?nx=-2&ny=-2&nz=2&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"
        st, h, b = call(self.base, "POST", q, raw=b"\0" * 16, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 400)

    def test_errors_are_json(self):
        st, h, b = call(self.base, "POST", self.Q, raw=b"\0" * 10, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 400)
        self.assertIn("error", json.loads(b))

    def test_compute_error_is_500_json(self):
        """D4 P21: a failing segmentation (here a backend that raises) answers 500 JSON instead of closing the connection."""
        import seg_server
        orig = seg_server.run_threshold
        seg_server.run_threshold = lambda vol: (_ for _ in ()).throw(MemoryError("simulated"))
        try:
            hu = np.zeros((8, 10, 12), np.int16)
            st, h, b = call(self.base, "POST", self.Q, raw=hu.tobytes(), headers={"Content-Type": "application/octet-stream"})
        finally:
            seg_server.run_threshold = orig
        self.assertEqual(st, 500)
        self.assertEqual(json.loads(b), {"error": "internal error"})


# ------------------------------------------------------------------------------------------ CORS / headers / leaks
class T7_CorsHeaders(Base):
    def test_preflight_same_origin_only(self):
        """D4 G3: no CORS grant (and no private-network grant) for a foreign page unless configured (test_http_security)."""
        for p in ("/cases", "/guide", "/segment", "/cases/abc/draft"):
            st, h, _ = call(self.base, "OPTIONS", p, headers={"Origin": "http://evil.example", "Access-Control-Request-Private-Network": "true"})
            self.assertEqual(st, 204)
            self.assertNotIn("Access-Control-Allow-Origin", h)
            self.assertNotIn("Access-Control-Allow-Private-Network", h)

    def test_500_does_not_leak_internals(self):
        st, r = J(call(self.base, "POST", "/cases", {"name": "x", "kind": {"a": 1}}))
        if st == 500:
            self.assertNotRegex(r.get("error", ""), r"(sqlite|Error binding|Traceback|/home/|/app/)", r)

    def test_static_security_headers(self):
        st, h, _ = call(self.base, "GET", "/index.html")
        self.assertEqual(st, 200)
        self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(h.get("X-Frame-Options"), "DENY")
        self.assertIn("frame-ancestors 'none'", h.get("Content-Security-Policy", ""))
        self.assertEqual(h.get("Referrer-Policy"), "no-referrer")

    def test_guide_error_hides_internals(self):
        """D4 P10: a guide request that fails inside the geometry answers a generic 400 (details only in the server log)."""
        req = tiny_guide_request(); req["crop"] = "x"
        st, r = J(call(self.base, "POST", "/guide", req))
        self.assertEqual(st, 400)
        self.assertNotRegex(r["error"], r"(KeyError|TypeError|Traceback|'frame')")


class ThresholdComponents(unittest.TestCase):
    """seg_server.run_threshold ranks the bone components by voxel count (np.bincount since the external audit)."""

    def test_largest_component_first(self):
        import types
        import seg_server
        a = np.full((30, 30, 30), -1000, np.int16)
        a[2:6, 2:6, 2:6] = 1200       # 64 voxels
        a[10:20, 10:20, 10:20] = 1200  # 1000 voxels
        a[24:28, 2:12, 2:5] = 1200     # 120 voxels
        out, st = seg_server.run_threshold(types.SimpleNamespace(array=a), keep=6)
        self.assertEqual(len(st), 3)
        self.assertEqual([int((out == k).sum()) for k in (1, 2, 3)], [1000, 120, 64])


if __name__ == "__main__":
    unittest.main()
