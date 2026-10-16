"""Access token, CORS, security headers, HEAD, health (D4 G2, G3, G4, C4-C6).

    python3 tests/server/test_http_security.py -v          (fast)
"""
import json
import os
import stat
import unittest

import numpy as np

from common import J, call, raw_http, start_server, stop_server, tiny_guide_request, yolmed_server

TOKEN = "s3cret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
SEG_Q = "/segment?nx=12&ny=10&nz=8&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"


class Token(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, cls.db, cls.port = start_server(token=TOKEN)

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def test_protected_endpoints_need_the_token(self):
        hu = np.zeros((8, 10, 12), np.int16).tobytes()
        for method, path, body in (("GET", "/cases", None), ("POST", "/cases", {"name": "x"}), ("GET", "/cases/abc", None),
                                   ("PUT", "/cases/abc/draft", {"plan": {}}), ("GET", "/cases/abc/versions", None),
                                   ("POST", "/guide", tiny_guide_request())):
            st, h, b = call(self.base, method, path, body)
            self.assertEqual(st, 401, (method, path, st, b[:100]))
            self.assertIn("Bearer", h.get("WWW-Authenticate", ""))
            st, h, b = call(self.base, method, path, body, headers={"Authorization": "Bearer wrong"})
            self.assertEqual(st, 401, (method, path))
        st, h, b = call(self.base, "POST", SEG_Q, raw=hu, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 401)

    def test_token_opens_them(self):
        st, r = J(call(self.base, "POST", "/cases", {"name": "with token"}, headers=AUTH))
        self.assertEqual(st, 200, r)
        st, lst = J(call(self.base, "GET", "/cases", headers=AUTH))
        self.assertEqual(st, 200)
        self.assertIn(r["id"], [c["id"] for c in lst])
        st, h, b = call(self.base, "POST", SEG_Q, raw=np.zeros((8, 10, 12), np.int16).tobytes(),
                        headers=dict(AUTH, **{"Content-Type": "application/octet-stream"}))
        self.assertEqual(st, 200)
        st, r = J(call(self.base, "POST", "/guide", tiny_guide_request(), headers=AUTH))
        self.assertEqual(st, 200, r.get("error"))

    def test_health_static_and_preflight_stay_open(self):
        st, h, b = call(self.base, "GET", "/health")
        self.assertEqual(st, 200)
        st, h, b = call(self.base, "GET", "/index.html")
        self.assertEqual(st, 200)
        st, h, b = call(self.base, "GET", "/config.js")
        self.assertEqual(st, 200)
        self.assertIn(b"YOLMED_AUTH = true", b)
        st, h, b = call(self.base, "OPTIONS", "/cases")
        self.assertEqual(st, 204)

    def test_401_drains_a_large_upload(self):
        """The client can read the 401 although it is still sending its body."""
        body = b"x" * (3 * 1024 * 1024)
        code, resp = raw_http(self.port, b"POST /guide HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
        self.assertEqual(code, 401, resp[:200])


class Cors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, cls.db, cls.port = start_server(allow_origin="https://studio.example, http://localhost:8000")

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def test_allowed_origin_gets_cors(self):
        st, h, _ = call(self.base, "OPTIONS", "/cases", headers={"Origin": "https://studio.example", "Access-Control-Request-Method": "PUT"})
        self.assertEqual(st, 204)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "https://studio.example")
        self.assertIn("Authorization", h.get("Access-Control-Allow-Headers", ""))
        self.assertIn("Origin", h.get("Vary", ""))
        # private network only when configured
        self.assertNotIn("Access-Control-Allow-Private-Network", h)
        st, h, _ = call(self.base, "GET", "/health", headers={"Origin": "http://localhost:8000"})
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:8000")

    def test_other_origin_gets_none(self):
        st, h, _ = call(self.base, "GET", "/cases", headers={"Origin": "http://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_private_network_when_configured(self):
        yolmed_server.Handler.private_network = True
        try:
            st, h, _ = call(self.base, "OPTIONS", "/cases", headers={"Origin": "https://studio.example", "Access-Control-Request-Private-Network": "true"})
            self.assertEqual(h.get("Access-Control-Allow-Private-Network"), "true")
            st, h, _ = call(self.base, "OPTIONS", "/cases", headers={"Origin": "http://evil.example", "Access-Control-Request-Private-Network": "true"})
            self.assertNotIn("Access-Control-Allow-Private-Network", h)
        finally:
            yolmed_server.Handler.private_network = False


class Headers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, cls.db, cls.port = start_server()

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def test_csp_names_the_hosts_the_studio_loads_from(self):
        """Every external script / stylesheet of web/index.html and the codec CDN of web/codecs.js is allowed by the CSP."""
        import re
        st, h, b = call(self.base, "GET", "/")
        csp = dict(p.strip().split(" ", 1) for p in h["Content-Security-Policy"].split(";"))
        html = b.decode()
        for src in re.findall(r'<script[^>]+src="(https://[^"]+)"', html):
            host = re.match(r"https://[^/]+", src).group(0)
            self.assertIn(host, csp["script-src"], src)
        for href in re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="(https://[^"]+)"', html):
            self.assertIn(re.match(r"https://[^/]+", href).group(0), csp["style-src"], href)
        self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>\s*\S", "inline script: the CSP blocks it")
        with open(os.path.join(os.path.dirname(yolmed_server.__file__), "web", "codecs.js")) as f:
            codecs = f.read()
        cdn = re.search(r"cdn: '(https://[^/]+)", codecs).group(1)
        self.assertIn(cdn, csp["script-src"]); self.assertIn(cdn, csp["connect-src"])
        self.assertEqual(csp["frame-ancestors"], "'none'")
        self.assertEqual(h.get("X-Frame-Options"), "DENY")

    def test_hsts_only_behind_https(self):
        st, h, _ = call(self.base, "GET", "/health")
        self.assertNotIn("Strict-Transport-Security", h)
        st, h, _ = call(self.base, "GET", "/health", headers={"X-Forwarded-Proto": "https"})
        self.assertIn("max-age=", h.get("Strict-Transport-Security", ""))

    def test_head(self):
        for path in ("/", "/health", "/index.html"):
            code, resp = raw_http(self.port, b"HEAD " + path.encode() + b" HTTP/1.1\r\nHost: x\r\n\r\n")
            self.assertEqual(code, 200, (path, resp[:200]))
            head, _, body = resp.partition(b"\r\n\r\n")
            self.assertEqual(body, b"", path)
            self.assertIn(b"Content-Length:", head)

    def test_health_reports_version_and_store(self):
        st, r = J(call(self.base, "GET", "/health"))
        self.assertEqual(st, 200)
        self.assertEqual(r["store"], "ok")
        self.assertTrue(r["version"])

    def test_health_fails_when_the_store_is_not_writable(self):
        if not hasattr(os, "geteuid") or os.geteuid() == 0:
            # root writes through file modes (and Windows has no file modes for this): simulate with a store whose check fails
            orig = yolmed_server.Handler.store.check
            yolmed_server.Handler.store.check = lambda: (False, "disk full")
            try:
                st, r = J(call(self.base, "GET", "/health"))
            finally:
                yolmed_server.Handler.store.check = orig
        else:
            os.chmod(self.db, stat.S_IRUSR)
            try:
                st, r = J(call(self.base, "GET", "/health"))
            finally:
                os.chmod(self.db, stat.S_IRUSR | stat.S_IWUSR)
        self.assertEqual(st, 503)
        self.assertEqual(r["store"], "error")

    def test_store_check_detects_read_only_database(self):
        import sqlite3
        st = yolmed_server.CaseStore(self.db + "_ro.sqlite")
        self.assertEqual(st.check(), (True, None))
        st.path = "file:" + self.db + "_ro.sqlite?mode=ro"
        orig = sqlite3.connect
        try:
            sqlite3.connect = lambda p, timeout=5: orig(p, timeout=timeout, uri=True)
            ok, err = st.check()
        finally:
            sqlite3.connect = orig
        self.assertFalse(ok)

    def test_access_log_goes_to_stdout(self):
        import io
        import sys
        import seg_server
        h = seg_server.Handler.__new__(seg_server.Handler)
        h.client_address = ("127.0.0.1", 1)
        out, err = io.StringIO(), io.StringIO()
        so, se = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            seg_server.Handler.log_message(h, '"%s" %s', "GET / HTTP/1.1", "200")
            seg_server.Handler.log_error(h, "code %d", 404)
        finally:
            sys.stdout, sys.stderr = so, se
        self.assertIn("GET / HTTP/1.1", out.getvalue())
        self.assertIn("code 404", out.getvalue())
        self.assertEqual(err.getvalue(), "")

    def test_guide_answer_carries_version(self):
        st, r = J(call(self.base, "POST", "/guide", tiny_guide_request()))
        self.assertEqual(st, 200)
        self.assertEqual(r["version"], json.loads(call(self.base, "GET", "/health")[2])["version"])
        self.assertIn("production_ok", r)


if __name__ == "__main__":
    unittest.main()
