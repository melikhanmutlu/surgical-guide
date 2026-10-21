"""Progress of a production guide build (the studio's bar while the server makes the STL): POST /guide?job=<id> keeps
the build's share done under <id>, GET /guide/progress?job=<id> reads it; fast.

    python3 tests/server/test_guide_progress.py -v
"""
import threading
import time
import unittest

from common import J, base_guide_request, call, start_server, stop_server, tiny_guide_request
import yolmed_server  # noqa: E402  (on the path through common)


class BuildProgress(unittest.TestCase):
    def test_build_reports_every_stage_in_order_and_ends_at_one(self):
        seen = []
        out = yolmed_server.build_guide(base_guide_request(), lambda f, st: seen.append((f, st)))
        self.assertTrue(out["watertight"])
        stages = [st for _, st in seen]
        # every stage reports, in build order (a stage may report several times from inside its loop)
        order = [s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s]
        self.assertEqual(order, list(yolmed_server.GUIDE_STAGES))
        fs = [f for f, _ in seen]
        self.assertTrue(all(0 <= f <= 1 for f in fs), fs)
        self.assertEqual(fs[-1], 1.0)
        self.assertGreater(len([f for f in fs if 0 < f < 1]), 8, "the bar moves between the stages, not only at the end")
        # never backwards (a grid that is coarsened restarts its resample inside the same stage share only)
        self.assertEqual(fs, sorted(fs))

    def test_no_callback_no_change(self):
        a = yolmed_server.build_guide(tiny_guide_request())
        b = yolmed_server.build_guide(tiny_guide_request(), lambda f, st: None)
        self.assertEqual(a["stl_b64"], b["stl_b64"])


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, _, _ = start_server(name="progress")

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def test_queued_running_then_gone(self):
        job = "test-job-0001"
        res = {}
        # hold the only job slot: the request waits in the queue and says so
        self.assertTrue(yolmed_server.GUIDE_SLOTS.acquire(timeout=5))
        released = False
        try:
            th = threading.Thread(target=lambda: res.update(r=J(call(self.base, "POST", f"/guide?job={job}", tiny_guide_request()))))
            th.start()
            st, p = None, None
            for _ in range(200):
                st, p = J(call(self.base, "GET", f"/guide/progress?job={job}"))
                if p.get("stage") != "none":
                    break
                time.sleep(0.05)
            self.assertEqual((st, p), (200, {"f": 0.0, "stage": "queue"}))
        finally:
            yolmed_server.GUIDE_SLOTS.release(); released = True
        th.join(120)
        self.assertTrue(released)
        self.assertEqual(res["r"][0], 200, res["r"][1])
        # answered: the job is gone (200, not 404: the studio's polls must not log console errors)
        st, p = J(call(self.base, "GET", f"/guide/progress?job={job}"))
        self.assertEqual((st, p), (200, {"f": None, "stage": "none"}))

    def test_bad_job_ids(self):
        for q in ("", "?job=", "?job=short", "?job=" + "x" * 65, "?job=a%20b%20c%20d%20e"):
            st, p = J(call(self.base, "GET", "/guide/progress" + q))
            self.assertEqual(st, 400, (q, p))
        st, p = J(call(self.base, "POST", "/guide?job=bad/id", tiny_guide_request()))
        self.assertEqual(st, 400, p)

    def test_unknown_job_is_json_not_the_studio_page(self):
        st, h, b = call(self.base, "GET", "/guide/progress?job=never-started")
        self.assertEqual(st, 200)
        self.assertIn("application/json", h.get("Content-Type", ""))
        self.assertEqual(J((st, h, b))[1], {"f": None, "stage": "none"})

    def test_job_table_is_bounded(self):
        for i in range(yolmed_server.GUIDE_JOBS_MAX + 20):
            yolmed_server._job_set(f"bulk-job-{i:05d}", 0.5, "edt")
        try:
            self.assertLessEqual(len(yolmed_server.GUIDE_JOBS), yolmed_server.GUIDE_JOBS_MAX)
        finally:
            for i in range(yolmed_server.GUIDE_JOBS_MAX + 20):
                yolmed_server._job_drop(f"bulk-job-{i:05d}")


class Auth(unittest.TestCase):
    def test_progress_needs_the_token_like_guide(self):
        srv, base, _, _ = start_server(name="progress_tok", token="sekret-token-123")
        try:
            st, p = J(call(base, "GET", "/guide/progress?job=never-started"))
            self.assertEqual(st, 401, p)
            st, p = J(call(base, "GET", "/guide/progress?job=never-started", headers={"Authorization": "Bearer sekret-token-123"}))
            self.assertEqual(st, 200, p)
        finally:
            stop_server(srv)


if __name__ == "__main__":
    unittest.main()
