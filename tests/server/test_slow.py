"""Slow clients against the job slots (D3 Y6/Y7, D4 P2/P3/P7/P12; ported from the Denetim 3 audit suite).

    python3 tests/server/test_slow.py -v          (~1 min)

A request body is read in full before its request queues for the guide / segmentation slot, so a client that trickles
bytes (or declares a huge body and stalls) holds only its own upload; the trickler itself is cut by the minimum-rate rule
(seg_server.BODY_WINDOW_*); the socket timeout of the body read does not cut the answer (P3).
"""
import json
import socket
import threading
import time
import unittest

import numpy as np

from common import J, call, start_server, stop_server, tiny_guide_request, yolmed_server
import seg_server  # noqa: E402  (on the path once common is imported)


def trickle(port, path, n, stop, log, every=4.0, byte=b"0"):
    """Declares an n-byte body and sends one byte every `every` s (the D4 slothold attack); logs when the server closes."""
    s = socket.create_connection(("127.0.0.1", port), timeout=300)
    s.sendall(f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: {n}\r\n\r\n".encode())
    t0 = time.perf_counter()
    try:
        while not stop.is_set():
            s.sendall(byte)
            s.settimeout(every)
            try:
                data = s.recv(4096)
                if data or data == b"":
                    log.append((time.perf_counter() - t0, data[:40]))
                    return
            except socket.timeout:
                pass
    except OSError as e:
        log.append((time.perf_counter() - t0, repr(e)))
    finally:
        s.close()


class SlowClients(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.base, _, cls.port = start_server(web=False, name="slow")

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)

    def test_idle_header_connection_closed_by_timeout(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=200)
        s.sendall(b"GET /cases HTTP/1.1\r\n")
        t = time.perf_counter()
        data = s.recv(1024)                           # returns b"" when the server closes
        dt = time.perf_counter() - t
        s.close()
        self.assertLess(dt, 70)

    def _legit_behind(self, path, n, legit_path, legit_body, ctype="application/json"):
        stop, log = threading.Event(), []
        th = threading.Thread(target=trickle, args=(self.port, path, n, stop, log), daemon=True)
        th.start()
        time.sleep(1.5)
        t = time.perf_counter()
        st, h, b = call(self.base, "POST", legit_path, raw=legit_body, headers={"Content-Type": ctype}, timeout=300)
        dt = time.perf_counter() - t
        th.join(60); stop.set()
        return st, dt, log

    def test_big_declared_body_does_not_hold_guide_slot(self):
        """D4 P2: Content-Length near MAX_BODY, one byte every 4 s. The legitimate /guide is answered at once; the trickler
        is cut after one minimum-rate window (408), not after ~154 s."""
        st, dt, log = self._legit_behind("/guide", yolmed_server.MAX_BODY - 1, "/guide", json.dumps(tiny_guide_request()).encode())
        self.assertEqual(st, 200)
        self.assertLess(dt, 15, f"legitimate /guide waited {dt:.0f} s behind a trickling client")
        self.assertTrue(log, "the trickling client was never cut off")
        self.assertLess(log[0][0], 3 * seg_server.BODY_WINDOW_S + 5, log)
        self.assertIn(b"408", log[0][1] if isinstance(log[0][1], bytes) else b"", log)

    def test_big_declared_body_does_not_hold_segment_slot(self):
        n3 = 512
        q = f"/segment?nx={n3}&ny={n3}&nz={n3}&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1"
        hu = np.full((8, 10, 12), -1000, np.int16); hu[2:6, 3:7, 4:9] = 1200
        st, dt, log = self._legit_behind(q, 2 * n3 ** 3, "/segment?nx=12&ny=10&nz=8&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1",
                                         hu.tobytes(), "application/octet-stream")
        self.assertEqual(st, 200)
        self.assertLess(dt, 15, f"legitimate /segment waited {dt:.0f} s behind a trickling client")

    def test_idle_upload_does_not_delay_guide(self):
        """A client that sends /guide headers and then nothing: the legitimate request does not wait for it at all."""
        s = socket.create_connection(("127.0.0.1", self.port), timeout=300)
        s.sendall(b"POST /guide HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\n")
        time.sleep(1)
        t = time.perf_counter()
        st, r = J(call(self.base, "POST", "/guide", tiny_guide_request(), timeout=300))
        dt = time.perf_counter() - t
        s.close()
        self.assertEqual(st, 200)
        self.assertLess(dt, 10, f"one idle connection delayed guide production by {dt:.0f} s")

    def test_moderate_upload_rate_is_accepted(self):
        """D4 P7: an upload well below the old 2 MB/s floor (here ~0.5 MB/s) is read in full, not refused with 408."""
        body = json.dumps(dict(tiny_guide_request(), pad="x" * 1_500_000)).encode()
        s = socket.create_connection(("127.0.0.1", self.port), timeout=120)
        s.sendall(b"POST /guide HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body))
        t0 = time.perf_counter()
        for i in range(0, len(body), 64 * 1024):
            s.sendall(body[i:i + 64 * 1024]); time.sleep(0.12)
        data = b""
        while True:
            c = s.recv(1 << 16)
            if not c:
                break
            data += c
        s.close()
        self.assertTrue(data.startswith(b"HTTP/1.0 200") or data.startswith(b"HTTP/1.1 200"), (time.perf_counter() - t0, data[:120]))

    def test_slow_reader_gets_whole_answer(self):
        """D4 P3: a client that waits 7 s (longer than the old 5 s body-read timeout) before reading a large /segment answer
        still gets every byte."""
        n = 160
        body = np.full((n, n, n), -1000, np.int16).tobytes()
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
        s.connect(("127.0.0.1", self.port))
        s.sendall((f"POST /segment?nx={n}&ny={n}&nz={n}&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1 HTTP/1.1\r\nHost: x\r\n"
                   f"Content-Type: application/octet-stream\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
        time.sleep(7)
        got, s_ = b"", s
        s_.settimeout(60)
        while True:
            c = s_.recv(1 << 20)
            if not c:
                break
            got += c
        s.close()
        head, _, payload = got.partition(b"\r\n\r\n")
        self.assertIn(b" 200 ", head.split(b"\r\n")[0])
        self.assertEqual(len(payload), n ** 3)


if __name__ == "__main__":
    unittest.main()
