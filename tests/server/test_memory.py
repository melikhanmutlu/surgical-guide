"""Resident memory of the hosted service (Railway bills RAM by the GB-month): the service starts without the DICOM
readers, and a finished guide / segmentation job hands its freed heap back to the OS; fast.

    python3 tests/server/test_memory.py -v

Measured in the Docker image (2026-10-21): at start 81 -> 40 MB anonymous + 86 -> 26 MB mapped library; after one
/guide 237 -> 124 MB, after three 271 -> 122 MB.
"""
import os
import subprocess
import sys
import textwrap
import time
import unittest

import numpy as np

from common import J, REPO, call, start_server, stop_server, tiny_guide_request
import seg_server  # noqa: E402  (on the path through common)


class Startup(unittest.TestCase):
    def test_server_does_not_import_dicom_readers(self):
        """SimpleITK (~45 MB resident + ~60 MB mapped) and pydicom are only for reading DICOM files and the
        TotalSegmentator backend; the hosted service (threshold backend) never needs them."""
        code = "import sys, yolmed_server; print(sorted(m for m in ('SimpleITK', 'pydicom') if m in sys.modules))"
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "[]")

    def test_dicom_reader_still_works(self):
        """Volume.from_file / to_sitk import SimpleITK themselves."""
        from surgiguide.volume import Volume
        v = Volume(np.zeros((3, 4, 5), np.float32), (1, 1, 2), (0, 0, 0))
        img = v.to_sitk()
        self.assertEqual(img.GetSize(), (5, 4, 3))


@unittest.skipUnless(sys.platform.startswith("linux") and getattr(seg_server, "_LIBC", True) is not None, "glibc only")
class Trim(unittest.TestCase):
    def test_release_memory_returns_freed_heap(self):
        """Fragmented free heap (one live object per ~100 kB, as a finished job leaves it) stays resident until
        malloc_trim; release_memory gives it back."""
        code = textwrap.dedent("""
            import seg_server
            def anon():
                for l in open('/proc/self/status'):
                    if l.startswith('RssAnon'):
                        return int(l.split()[1]) // 1024
            keep, junk = [], []
            for i in range(150000):
                (keep if i % 100 == 0 else junk).append(bytearray(1000))
            del junk
            a = anon()
            ok = seg_server.release_memory()
            print(a, anon(), ok)
        """)
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO, capture_output=True, text=True, timeout=120,
                             env=dict(os.environ, MALLOC_ARENA_MAX="2"))
        self.assertEqual(out.returncode, 0, out.stderr)
        before, after, ok = out.stdout.split()
        self.assertEqual(ok, "True")
        self.assertGreater(int(before) - int(after), 50, out.stdout)   # ~150 MB allocated, ~148 MB freed


class JobsTrim(unittest.TestCase):
    """/guide and /segment call release_memory once the job is answered (also after a failed request)."""

    @classmethod
    def setUpClass(cls):
        cls.calls = 0
        cls.orig = seg_server.release_memory

        def counting():
            cls.calls += 1
            return cls.orig()
        seg_server.release_memory = counting
        cls.srv, cls.base, _, _ = start_server(web=False, name="memory")

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.srv)
        seg_server.release_memory = cls.orig

    def wait_calls(self, want, limit=5.0):
        """release_memory runs in the handler's `finally`, after the answer is written: the client can read the answer
        before the call (a loaded machine, denetim 2026-10-23), so the count is awaited for a moment, not read at once."""
        t_end = time.time() + limit
        while self.calls < want and time.time() < t_end:
            time.sleep(0.02)
        return self.calls

    def test_guide(self):
        n = self.calls
        st, r = J(call(self.base, "POST", "/guide", tiny_guide_request()))
        self.assertEqual(st, 200, r)
        self.assertEqual(self.wait_calls(n + 1), n + 1)

    def test_bad_guide(self):
        n = self.calls
        st, _ = J(call(self.base, "POST", "/guide", {"crop": 1}))
        self.assertEqual(st, 400)
        self.assertEqual(self.wait_calls(n + 1), n + 1)

    def test_segment(self):
        n = self.calls
        body = np.full((8, 10, 12), 1500, "<i2").tobytes()
        st, _, _ = call(self.base, "POST", "/segment?nx=12&ny=10&nz=8&sp=1,1,1&origin=0,0,0&axes=1,0,0,0,1,0,0,0,1",
                        raw=body, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(st, 200)
        self.assertEqual(self.wait_calls(n + 1), n + 1)

    def test_cases_do_not_trim(self):
        n = self.calls
        st, _ = J(call(self.base, "GET", "/cases"))
        self.assertEqual(st, 200)
        self.assertEqual(self.calls, n)


if __name__ == "__main__":
    unittest.main()
