"""Yolmed planning service: segmentation + case store + production guide STL (hospital network only).

    python yolmed_server.py --backend threshold --port 8800 --db ./yolmed_cases.sqlite

Endpoints (JSON unless noted; CORS incl. Access-Control-Allow-Private-Network)
  GET  /health                          (unchanged from seg_server.py)
  POST /segment?...                     (unchanged from seg_server.py: int16 HU body -> uint8 labels)
  GET  /cases                           -> [{id, name, kind, fingerprint, updated_at, n_versions}] newest first
  POST /cases {name, kind, fingerprint} -> {id}
  GET  /cases/{id}                      -> {id, name, kind, fingerprint, draft, updated_at}
  PUT  /cases/{id}/draft {plan}         -> {ok: true, updated_at}
  GET  /cases/{id}/versions             -> [{n, note, author, created_at}] newest first
  POST /cases/{id}/versions {plan, note, author} -> {n}     (immutable, n = 1, 2, 3 ... per case)
  GET  /cases/{id}/versions/{n}         -> {n, plan, note, author, created_at}
  POST /guide {crop, mask_b64, frame, g, planes, screws, gap?, wrap_profile?, stops?, seat_dir?, resolution?}
       -> {stl_b64, watertight, volume_mm3, faces, bodies, pieces, seat_dir, ms, ...}
       The production STL is the browser preview's guide (web/app.js buildGuide) on a 0.2 mm grid: g carries the
       preview's body (L, W, vc, uc, wrap, wrapU, wall, clear, bridge, side, skirt), planes the saw slots (already on
       the kerf side), wrap_profile the preview's wrap line and seat_dir its insertion direction; all optional fields
       may be left out (older clients), the server then derives them from the bone itself.

The case store holds plan JSON only, never image data.
Research prototype. Not a medical device; every guide must be reviewed by a qualified team.
"""
import argparse
import base64
import contextlib
import datetime
import io
import json
import math
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse, unquote

import numpy as np
from scipy import ndimage as ndi

import seg_server  # /health and /segment are served by seg_server.Handler, unchanged

MAX_BODY = 256 * 1024 * 1024
BODY_BASE_S = 20                        # seconds allowed to send a body, plus size / BODY_MIN_RATE
BODY_MIN_RATE = 2e6                    # bytes per second a client must sustain
MAX_PLAN_BODY = 4 * 1024 * 1024       # case and version requests carry only plan JSON
MAX_CROP = 128e6                      # voxels in a guide crop (a 100 mm guide at 0.3 mm is ~100 M)
MAX_GRID = 40e6                       # guide grid cells (~2 GB peak at this size)
MAX_PLANES = 64                       # saw slots / screws in one guide (a guide has a handful; each one costs a boolean)
MAX_SCREWS = 64
DRAIN_MAX = 32 * 1024 * 1024          # an over-size upload is read (and discarded) up to this much after the 413, so the client can read it
MAX_TEXT = 2000                       # kind, fingerprint, note, author
GUIDE_SLOTS = threading.BoundedSemaphore(int(os.environ.get("YOLMED_GUIDE_JOBS", "1")))


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------------------------- case store
class CaseStore:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, fingerprint TEXT,
        draft TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions (
        case_id TEXT NOT NULL REFERENCES cases(id), n INTEGER NOT NULL, plan TEXT NOT NULL,
        note TEXT, author TEXT, created_at TEXT NOT NULL, PRIMARY KEY (case_id, n));
    CREATE TRIGGER IF NOT EXISTS versions_no_update BEFORE UPDATE ON versions
        BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON versions
        BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
    """

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        with self._conn() as c:
            c.executescript(self.SCHEMA)

    @contextlib.contextmanager
    def _conn(self):
        """A connection that commits (or rolls back) and is closed again: `with sqlite3.connect()` alone only ends the transaction."""
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    def list_cases(self):
        with self._conn() as c:
            rows = c.execute("""SELECT c.id, c.name, c.kind, c.fingerprint, c.updated_at,
                                (SELECT COUNT(*) FROM versions v WHERE v.case_id = c.id) AS n_versions
                                FROM cases c ORDER BY c.updated_at DESC, c.rowid DESC""").fetchall()
        return [dict(r) for r in rows]

    def create_case(self, name, kind, fingerprint):
        t = now_iso()
        with self.lock, self._conn() as c:
            while True:
                cid = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")
                if not c.execute("SELECT 1 FROM cases WHERE id=?", (cid,)).fetchone():
                    break
            c.execute("INSERT INTO cases (id, name, kind, fingerprint, draft, created_at, updated_at) "
                      "VALUES (?,?,?,?,NULL,?,?)", (cid, name, kind, fingerprint, t, t))
        return cid

    def get_case(self, cid):
        with self._conn() as c:
            r = c.execute("SELECT id, name, kind, fingerprint, draft, updated_at FROM cases WHERE id=?",
                          (cid,)).fetchone()
        if r is None:
            raise HttpError(404, f"case not found: {cid}")
        d = dict(r)
        d["draft"] = json.loads(d["draft"]) if d["draft"] is not None else None
        return d

    def put_draft(self, cid, plan):
        t = now_iso()
        with self.lock, self._conn() as c:
            cur = c.execute("UPDATE cases SET draft=?, updated_at=? WHERE id=?", (json.dumps(plan), t, cid))
            if cur.rowcount == 0:
                raise HttpError(404, f"case not found: {cid}")
        return t

    def list_versions(self, cid):
        self.get_case(cid)
        with self._conn() as c:
            rows = c.execute("SELECT n, note, author, created_at FROM versions WHERE case_id=? ORDER BY n DESC",
                             (cid,)).fetchall()
        return [dict(r) for r in rows]

    def add_version(self, cid, plan, note, author):
        t = now_iso()
        with self.lock, self._conn() as c:
            if not c.execute("SELECT 1 FROM cases WHERE id=?", (cid,)).fetchone():
                raise HttpError(404, f"case not found: {cid}")
            n = c.execute("SELECT COALESCE(MAX(n), 0) + 1 FROM versions WHERE case_id=?", (cid,)).fetchone()[0]
            c.execute("INSERT INTO versions (case_id, n, plan, note, author, created_at) VALUES (?,?,?,?,?,?)",
                      (cid, n, json.dumps(plan), note, author, t))
            c.execute("UPDATE cases SET updated_at=? WHERE id=?", (t, cid))
        return n

    def get_version(self, cid, n):
        self.get_case(cid)
        with self._conn() as c:
            r = c.execute("SELECT n, plan, note, author, created_at FROM versions WHERE case_id=? AND n=?",
                          (cid, n)).fetchone()
        if r is None:
            raise HttpError(404, f"version not found: {cid} v{n}")
        d = dict(r)
        d["plan"] = json.loads(d["plan"])
        return d


# --------------------------------------------------------------------------------------------- guide
# The production guide is the browser preview's design (web/app.js buildGuide) evaluated on a finer grid: the same
# level-set field (shell on the seatable envelope along the insertion direction, kept near real bone, per-position wrap
# and bridge edge, saw slots, screw sleeves clear of the envelope, drill holes, two-guide gap, island and speck removal)
# at `resolution` mm (0.2 instead of the preview's 0.4) and marched once, so the STL is closed by construction and has
# the same body, slots, sleeves and holes as the preview on any bone. A two-frame guide (split 2) is two requests, one
# per piece frame, exactly as the preview builds it. Frame coordinates: uu along the guide (u), vv across (v),
# nn = seating normal (n); every grid array is indexed [i, j, k] = (uu, vv, nn).
SEAT_CANDS = [(0, 0)] + [(t, a) for t in (10, 20, 30, 40) for a in range(0, 360, 45)]   # insertion directions tried (tilt, azimuth)
MAX_FULL_GRID = 90e6      # cells of the frame-aligned bone grid before the depth crop (5 bytes each)


def _unit(a):
    a = np.asarray(a, float)
    n = np.linalg.norm(a)
    if not np.isfinite(n) or n < 1e-9:
        raise HttpError(400, "zero-length direction vector")
    return a / n


def _check_ranges(vals):
    for k, (v, lo, hi) in vals.items():
        if not (math.isfinite(v) and lo <= v <= hi):
            raise HttpError(400, f"{k} must be within [{lo}, {hi}] (got {v})")


def _jsround(x):
    """JavaScript Math.round (half towards +inf), for the neighbour offsets of the envelope widening."""
    return np.floor(np.asarray(x, float) + 0.5).astype(int)


def _blur121(a):
    """Separable [1 2 1]/4 blur with clamped edges (web/geom.js blur)."""
    k = np.array([0.25, 0.5, 0.25], np.float32)
    out = ndi.convolve1d(a, k, axis=0, mode="nearest")
    out = ndi.convolve1d(out, k, axis=1, mode="nearest")
    return ndi.convolve1d(out, k, axis=2, mode="nearest")


def _shift_mask(m, off):
    """out[x] = m[x + off] (False outside the array)."""
    out = np.zeros_like(m)
    src, dst = [slice(None)] * 3, [slice(None)] * 3
    for ax, o in enumerate(off):
        n = m.shape[ax]
        if abs(o) >= n:
            return out
        if o > 0:
            src[ax], dst[ax] = slice(o, n), slice(0, n - o)
        elif o < 0:
            src[ax], dst[ax] = slice(0, n + o), slice(-o, n)
    out[tuple(dst)] = m[tuple(src)]
    return out


def _seat_vec(tilt, az):
    tr, ar = math.radians(tilt), math.radians(az)
    return np.array([math.sin(tr) * math.cos(ar), math.sin(tr) * math.sin(ar), math.cos(tr)])


def _basis2(d):
    """Two unit vectors spanning the plane normal to d (web/app.js basis2)."""
    d = np.asarray(d, float)
    t = np.array([0.0, 0, 1]) if abs(d[2]) < 0.9 else np.array([1.0, 0, 0])
    a = np.cross(t, d)
    a = a / (np.linalg.norm(a) or 1.0)
    return a, np.cross(d, a)


class _Projection:
    """The grid seen along an insertion direction d (frame coordinates, index units): every voxel maps to a cell of the
    plane normal to d (cells `st` voxels wide, so an axis-aligned d maps each column to its own cell) and to its height
    t along d (mm); top[cell] = the highest bone of the cell (web/app.js projection)."""

    def __init__(self, d, shape, r, st=1):
        nx, ny, nz = shape
        self.d, self.r, self.st, self.cell = np.asarray(d, float), r, st, st * r
        ea, eb = _basis2(d)
        cor = np.array([[x, y, z] for x in (0, nx - 1) for y in (0, ny - 1) for z in (0, nz - 1)], float)
        a, b = cor @ ea, cor @ eb
        self.na, self.nb = int(math.floor((a.max() - a.min()) / st)) + 2, int(math.floor((b.max() - b.min()) / st)) + 2
        self.ea, self.eb, self.ea_raw, self.eb_raw = ea / st, eb / st, ea, eb
        self.a0, self.b0 = a.min() / st - 0.5, b.min() / st - 0.5
        self.top = None

    def cells(self, i, j, k):
        a = np.floor(i * self.ea[0] + j * self.ea[1] + k * self.ea[2] - self.a0).astype(np.int32)
        b = np.floor(i * self.eb[0] + j * self.eb[1] + k * self.eb[2] - self.b0).astype(np.int32)
        return a + self.na * b

    def t(self, i, j, k):
        return (i * self.d[0] + j * self.d[1] + k * self.d[2]) * self.r

    def top_of(self, bone):
        """Highest bone (mm along d) per cell, from every st-th voxel of each axis."""
        nx, ny, nz = bone.shape
        top = np.full(self.na * self.nb, -np.inf, np.float64)
        for i in range(0, nx, self.st):
            m = bone[i, ::self.st, ::self.st]
            if not m.any():
                continue
            j, k = np.nonzero(m)
            j, k = (j * self.st).astype(float), (k * self.st).astype(float)
            np.maximum.at(top, self.cells(float(i), j, k), self.t(float(i), j, k))
        self.top = top
        return top


def _weld(verts, tris, eps=1e-4):
    """Collapse vertices closer than eps (sub-micron slivers that would merge in a float32 STL anyway) and drop the
    faces that become degenerate."""
    from scipy.spatial import cKDTree
    pairs = cKDTree(verts).query_pairs(eps, output_type="ndarray")
    if len(pairs) == 0:
        return verts, tris, 0
    parent = np.arange(len(verts))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a, b in pairs:
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    rep = np.array([root(a) for a in range(len(verts))])
    t = rep[tris]
    t = t[(t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])]
    used, inv = np.unique(t, return_inverse=True)
    return verts[used], inv.reshape(-1, 3), len(pairs)


def _pairs(val, name, nmax=2000):
    try:
        arr = np.asarray(val, float).reshape(-1, 2)
    except (TypeError, ValueError):
        raise HttpError(400, f"{name} must be a list of [u, value] pairs")
    if not 1 <= len(arr) <= nmax or not np.all(np.isfinite(arr)):
        raise HttpError(400, f"{name} must be a list of 1..{nmax} finite [u, value] pairs")
    return arr


def build_guide(req):
    import manifold3d as m3d
    import trimesh
    from skimage.measure import marching_cubes

    t0 = time.perf_counter()
    T = {}
    crop, fr, g = req["crop"], req["frame"], req["g"]
    cnx, cny, cnz = int(crop["nx"]), int(crop["ny"]), int(crop["nz"])
    sp = np.asarray(crop["sp"], float)
    corg = np.asarray(crop["origin"], float)
    axes = np.asarray(crop["axes"], float).reshape(3, 3)       # rows: i, j, k unit vectors
    if cnx * cny * cnz > MAX_CROP:
        raise HttpError(422, f"crop too large ({cnx}x{cny}x{cnz}); at most {int(MAX_CROP)} voxels")
    raw = base64.b64decode(req["mask_b64"])
    if len(raw) != cnx * cny * cnz:
        raise HttpError(400, f"mask has {len(raw)} bytes, expected nx*ny*nz = {cnx * cny * cnz}")
    mask = np.frombuffer(raw, np.uint8).reshape(cnz, cny, cnx) > 0
    r = float(req.get("resolution") or 0.2)
    if not (0.05 <= r <= 2.0):
        raise HttpError(400, "resolution must be within [0.05, 2] mm")

    L, W = float(g["L"]), float(g["W"])
    wrap, wall, clear = float(g["wrap"]), float(g["wall"]), float(g["clear"])
    bridge, side = float(g["bridge"]), (1.0 if float(g.get("side", 1)) >= 0 else -1.0)
    vc = float(g.get("vc", 0) or 0)                      # lateral (v) centre of the body relative to the frame origin
    uc = float(g.get("uc", 0) or 0)                      # centre along the guide
    skirt = 3.0 if g.get("skirt") is None else float(g["skirt"])   # the shell is kept within this distance of real bone
    _check_ranges({"L": (L, 5, 200), "W": (W, 3, 100), "wrap": (wrap, 0, 40), "wall": (wall, 0.5, 10), "clear": (clear, 0, 3),
                   "bridge": (bridge, 0, 30), "vc": (vc, -50, 50), "uc": (uc, -100, 100), "skirt": (skirt, 0, 30)})
    # optional per-position wrap depth ([[uu, depth], ...], the automatic sizing's profile): the depth at uu is the
    # smaller of g.wrap and the profile's value
    wrap_u = None
    if g.get("wrapU"):
        wrap_u = _pairs(g["wrapU"], "g.wrapU")
        if wrap_u[:, 1].min() < 0 or wrap_u[:, 1].max() > 40:
            raise HttpError(400, "g.wrapU depths must be within [0, 40]")
        wrap_u = wrap_u[np.argsort(wrap_u[:, 0], kind="stable")]
    planes, screws = req.get("planes") or [], req.get("screws") or []
    if len(planes) > MAX_PLANES or len(screws) > MAX_SCREWS:
        raise HttpError(400, f"at most {MAX_PLANES} planes and {MAX_SCREWS} screws per guide")
    for pl in planes:
        _check_ranges({"plane w": (float(pl["w"]), 0.1, 10)})
    for s_ in screws:
        _check_ranges({"screw d": (float(s_["d"]), 0.5, 10), "screw D": (float(s_["D"]), float(s_["d"]), 15), "sleeveH": (float(s_["sleeveH"]), 0, 30)})
    gap = req.get("gap")
    if gap:
        if not isinstance(gap, dict) or not all(isinstance(gap.get(k), dict) for k in ("A", "B")):
            raise HttpError(400, "gap needs plane records A and B")
        _check_ranges({"flange": (float(gap.get("flange", 3.0)), 0, 20),
                       "gap A w": (float(gap["A"].get("w", 1.0)), 0.1, 10), "gap B w": (float(gap["B"].get("w", 1.0)), 0.1, 10)})
    if min(cnx, cny, cnz) < 2 or len(sp) != 3 or not np.all(np.isfinite(sp)) or np.any(sp <= 0):
        raise HttpError(400, "invalid crop grid")
    cw = clear + wall
    bridge_lo, bridge_hi = cw - 0.5, cw + 2.5
    # optional depth limit along the guide ([uu, nn] pairs, nn <= 0): the preview's own wrap line (bone top per
    # position minus the wrap depth), so the production body ends exactly where the preview's does
    prof = req.get("wrap_profile")
    if prof:
        prof = _pairs(prof, "wrap_profile")
        if len(prof) < 2 or np.any(np.diff(prof[:, 0]) <= 0) or prof[:, 1].min() < -(wrap + 80) or prof[:, 1].max() > 0:
            raise HttpError(400, "wrap_profile values out of range")
    else:
        prof = None
    # optional stops past the +v / -v guide edge: [length beyond the edge, extra depth]
    stops = req.get("stops") or {}
    stop = {}
    for key in ("pos", "neg"):
        st_ = stops.get(key)
        if st_:
            sl_, sd_ = float(st_[0]), float(st_[1])
            _check_ranges({"stop length": (sl_, 0, 30), "stop depth": (sd_, 0, 30)})
            stop[key] = (sl_, sd_)
    ext_pos, ext_neg = stop.get("pos", (0, 0))[0], stop.get("neg", (0, 0))[0]
    dstop = max([sd_ for _, sd_ in stop.values()] or [0.0])
    # optional insertion direction (the one the preview chose), so both use the same envelope
    forced = None
    sd_req = req.get("seat_dir")
    if sd_req is not None:
        if not isinstance(sd_req, dict):
            raise HttpError(400, "seat_dir must be {tilt, az}")
        try:
            cand = (int(round(float(sd_req["tilt"]))), int(round(float(sd_req["az"]))) % 360)
        except (KeyError, TypeError, ValueError):
            raise HttpError(400, "seat_dir must be {tilt, az} in degrees")
        if cand in SEAT_CANDS:
            forced = cand

    # guide frame (orthonormalised; keep the given v direction so `side` keeps its meaning)
    p = np.asarray(fr["p"], float)
    n = _unit(fr["n"])
    u = _unit(np.asarray(fr["u"], float) - np.dot(fr["u"], n) * n)
    v = np.cross(n, u)
    if np.dot(v, fr["v"]) < 0:
        v = -v
    R = np.column_stack([u, v, n])                      # world = p + R @ (uu, vv, nn)

    def to_f(x):
        return R.T @ (np.asarray(x, float) - p)

    # bone: everything not reachable from outside the crop counts as bone (closed cavities filled)
    filled = ndi.binary_fill_holes(mask)
    del mask
    T["fill"] = time.perf_counter() - t0

    # frame-aligned isotropic grid with the preview's extents (grid nodes shifted by an irrational fraction of a voxel
    # so no node lies exactly on a round-numbered design plane). A guide too large for the cell budget at the requested
    # resolution is built at the next coarser one (reported in the answer) rather than refused.
    max_sleeve = max([float(s["sleeveH"]) for s in screws] or [0.0])
    lo = np.array([uc - L / 2 - 4, vc - W / 2 - 4 - ext_neg, -max(wrap + 10, 30) - max(0.0, L / 2 - 15) * 0.6])
    hi = np.array([uc + L / 2 + 4, vc + W / 2 + 4 + ext_pos, cw + max(max_sleeve, bridge) + 6])
    A = (axes * sp[:, None]).T                          # columns: world step per crop i, j, k
    Ainv = np.linalg.inv(A)
    P = np.array([[0, 0, 1], [0, 1, 0], [1, 0, 0]], float)
    # light smoothing of the voxel mask (sigma = half a crop voxel) gives a density whose 0.5 level is the bone surface,
    # between grid nodes
    src = ndi.gaussian_filter(filled.astype(np.float32), 0.5)
    del filled
    r_req = r
    for _attempt in range(8):
        glo = lo - r * 0.41421356
        nx, ny, nz = (int(math.ceil(x)) + 1 for x in (hi - glo) / r)
        if nx * ny * nz > MAX_FULL_GRID:
            r = round(r * 1.25, 4)
            continue
        # resample the filled bone mask onto the grid (output index (i, j, k) -> crop (k, j, i))
        mat = P @ Ainv @ R * r
        off = P @ Ainv @ (p - corg + R @ glo)
        soft = np.empty((nx, ny, nz), np.float32)
        step = max(1, int(8e6 // (ny * nz)))
        for i0 in range(0, nx, step):
            i1 = min(nx, i0 + step)
            soft[i0:i1] = ndi.affine_transform(src, mat, off + mat[:, 0] * i0, output_shape=(i1 - i0, ny, nz), order=1, cval=0.0, prefilter=False)
        bone = ndi.binary_fill_holes(soft >= 0.5)       # solid = bone plus every void the outside cannot reach
        UU = (glo[0] + r * np.arange(nx)).astype(np.float32)
        VV = (glo[1] + r * np.arange(ny)).astype(np.float32)
        NN = (glo[2] + r * np.arange(nz)).astype(np.float32)
        # top of the bone per column (sub-voxel: where the density crosses 0.5 above the top bone node), -inf without bone
        has = bone.any(axis=2)
        kmax = np.where(has, nz - 1 - np.argmax(bone[:, :, ::-1], axis=2), 0)
        ii, jj = np.nonzero(has)
        kk = kmax[ii, jj]
        s0 = soft[ii, jj, kk]
        s1 = np.where(kk + 1 < nz, soft[ii, jj, np.minimum(kk + 1, nz - 1)], 0.0)
        frac = np.where((s0 > 0.5) & (s1 < 0.5), np.clip((s0 - 0.5) / np.maximum(s0 - s1, 1e-6), 0, 1), 0.0)
        col_top = np.full((nx, ny), -np.inf, np.float32)
        col_top[ii, jj] = NN[kk] + frac * r
        del has, kmax, ii, jj, kk, s0, s1, frac
        # the wrap depth follows the bone: the depth limit per position along the guide is measured from the top of the
        # bone there (never above the plane through the anchor), smoothed over 1.5 mm, minus the wrap depth there
        in_w = np.abs(VV - vc) <= W / 2
        top_u = np.where(in_w[None, :], col_top, -np.inf).max(axis=1) if in_w.any() else np.full(nx, -np.inf, np.float32)
        top_u = np.where(np.isfinite(top_u), np.minimum(0.0, top_u), 0.0).astype(np.float32)
        win = max(1, int(round(1.5 / r)))
        if prof is not None:
            wrap_at = np.interp(UU, prof[:, 0], prof[:, 1]).astype(np.float32)
        else:
            wrap_of = np.full(nx, wrap, np.float32) if wrap_u is None else np.minimum(wrap, np.interp(UU, wrap_u[:, 0], wrap_u[:, 1])).astype(np.float32)
            wrap_at = ndi.minimum_filter1d(np.minimum(0.0, top_u), 2 * win + 1, mode="nearest") - wrap_of
        foot = (np.abs(UU - uc) <= L / 2 + 1)[:, None] & (np.abs(VV - vc) <= W / 2 + 1)[None, :]
        if not np.any(foot & (col_top >= wrap_at.min() - 1)):
            raise HttpError(422, "no bone inside the guide footprint")
        # nothing below the deepest wrap line (plus the stops and the distance band) reaches the body: drop that depth
        k_lo = max(0, int(math.floor((wrap_at.min() - dstop - (bridge_hi + skirt + 3) - glo[2]) / r)))
        if k_lo:
            soft, bone, NN = np.ascontiguousarray(soft[:, :, k_lo:]), np.ascontiguousarray(bone[:, :, k_lo:]), NN[k_lo:]
            glo = glo + np.array([0, 0, k_lo * r])
            nz -= k_lo
        if nx * ny * nz > MAX_GRID:
            del soft, bone
            r = round(r * 1.25, 4)
            continue
        break
    else:
        raise HttpError(422, "guide grid too large; increase resolution value")
    del src
    if nz < 4:
        raise HttpError(422, "guide grid too shallow")
    T["resample"] = time.perf_counter() - t0

    # signed distance to the bone surface (outside > 0; -r/2 on bone nodes); within 1.5 voxels of the surface it comes
    # from the density itself, (0.5 - density) / |gradient|, which places the surface to a fraction of a voxel
    dist = (ndi.distance_transform_edt(~bone, sampling=r) - r / 2).astype(np.float32)
    dist[bone] = -r / 2
    dist_raw = dist.copy()

    def refine(d_arr):
        near, g2, fade = 1.5 * r, 1 / (2 * r), 0.5 * r
        for i in range(1, nx - 1):
            de = d_arr[i, 1:-1, 1:-1]
            s = soft[i, 1:-1, 1:-1]
            gx = (soft[i + 1, 1:-1, 1:-1] - soft[i - 1, 1:-1, 1:-1]) * g2
            gy = (soft[i, 2:, 1:-1] - soft[i, :-2, 1:-1]) * g2
            gz = (soft[i, 1:-1, 2:] - soft[i, 1:-1, :-2]) * g2
            gm = np.sqrt(gx * gx + gy * gy + gz * gz)
            sel = (de <= near) & ~(bone[i, 1:-1, 1:-1] & (s <= 0.5)) & (gm >= 0.05)
            if not sel.any():
                continue
            sd = np.clip((0.5 - s) / np.maximum(gm, 1e-6), -near, near)
            wgt = np.where(de <= near - fade, 1.0, (near - de) / fade)
            d_arr[i, 1:-1, 1:-1] = np.where(sel, de + wgt * (sd - de), de)
    refine(dist)
    dd = _blur121(dist)
    T["edt"] = time.perf_counter() - t0

    # ---- insertion direction and the seatable envelope ----
    # The guide is put on along one direction d (a cone of up to 40 deg around n). The shell is built on the envelope =
    # bone plus its shadow along d (every undercut filled), so it lifts off along d by construction, and it is kept only
    # where real bone is within `skirt` of it. d is the candidate that sees the most bone surface under the footprint
    # (small cost per degree of tilt), or the one the request names (the preview's choice).
    st = max(1, int(round(0.8 / r)))
    inner = bone[1:-1, 1:-1, 1:-1]
    surf = inner & ~(bone[:-2, 1:-1, 1:-1] & bone[2:, 1:-1, 1:-1] & bone[1:-1, :-2, 1:-1] & bone[1:-1, 2:, 1:-1] & bone[1:-1, 1:-1, :-2] & bone[1:-1, 1:-1, 2:])
    sub = np.zeros_like(surf)
    sub[::st, ::st, ::st] = True
    surf &= sub
    del sub, inner
    si, sj, sk = np.nonzero(surf)
    si, sj, sk = si + 1, sj + 1, sk + 1
    keep = (np.abs(UU[si] - uc) <= L / 2 + 2) & (np.abs(VV[sj] - vc) <= W / 2 + 2) & (NN[sk] >= wrap_at[si] - 2)
    si, sj, sk = si[keep].astype(float), sj[keep].astype(float), sk[keep].astype(float)
    del surf, keep

    def vis_count(prj, tol):
        return int(np.count_nonzero(prj.top[prj.cells(si, sj, sk)] - prj.t(si, sj, sk) <= tol)) if len(si) else 0
    pick, best = None, -np.inf
    for tilt, az in ([forced] if forced else SEAT_CANDS):
        prj = _Projection(_seat_vec(tilt, az), (nx, ny, nz), r, st)
        prj.top_of(bone)
        score = vis_count(prj, 1.5 * prj.cell) * (1 - 0.005 * tilt)
        if score > best:
            best, pick = score, (tilt, az)
    prj = _Projection(_seat_vec(*pick), (nx, ny, nz), r, 1)
    prj.top_of(bone)
    vis = vis_count(prj, 1.5 * r)
    seat_dir = {"tilt": pick[0], "az": pick[1], "visible_mm2": round(vis * st * st * r * r, 1), "hidden_mm2": round((len(si) - vis) * st * st * r * r, 1), "forced": bool(forced)}
    del si, sj, sk
    # envelope = bone + its shadow along d (1 bone, 2 shadow, 3 the shadow widened by one voxel across d)
    E = np.zeros((nx, ny, nz), np.uint8)
    J, K = np.mgrid[0:ny, 0:nz]
    J, K = J.astype(float), K.astype(float)
    for i in range(nx):
        tt = prj.top[prj.cells(float(i), J, K)] - prj.t(float(i), J, K)
        E[i] = np.where(bone[i], 1, np.where(tt > 0.5 * r, 2, 0))
    n_shadow = int(np.count_nonzero(E == 2))
    if n_shadow:
        ea, eb = prj.ea_raw, prj.eb_raw
        add = np.zeros((nx, ny, nz), bool)
        sh = E == 2
        for q in (ea, -ea, eb, -eb):
            add |= _shift_mask(sh, tuple(_jsround(q)))
        add &= E == 0
        E[add] = 3
        del add, sh
        dist_e = (ndi.distance_transform_edt(E == 0, sampling=r) - r / 2).astype(np.float32)
        dist_e[E > 0] = -r / 2
        # the density refinement applies where the envelope surface is the bone surface itself (not a shadow face)
        sel = ((E == 0) | bone) & (np.abs(dist_e - dist_raw) < 0.5 * r)
        dist_e[sel] = dist[sel]
        del sel
        dde = _blur121(dist_e)
        del dist_e
    else:
        dde = dd
    del dist, dist_raw, soft
    T["env"] = time.perf_counter() - t0

    # ---- the field: F < 0 is guide (assembled slab by slab along the guide, so the memory stays at a few arrays) ----
    VV2, NN2 = VV[:, None], NN[None, :]
    av2 = np.abs(VV2 - vc).astype(np.float32)
    box_v = (av2 - W / 2).astype(np.float32)                         # (ny, 1)
    if stop:
        # stops: a lip past the edge, only off the bone's shadow along n (it rests on the bone edge, never under its bulge)
        pos_j = VV > vc
        sd_j = np.zeros(ny, bool)
        stop_x, stop_z = np.zeros(ny, np.float32), np.zeros(ny, np.float32)
        if "pos" in stop:
            sd_j |= pos_j; stop_x[pos_j], stop_z[pos_j] = stop["pos"]
        if "neg" in stop:
            sd_j |= ~pos_j; stop_x[~pos_j], stop_z[~pos_j] = stop["neg"]
        band_j = (sd_j & (np.abs(VV - vc) > W / 2 - 2))[:, None]
        sd2, stop_x2, stop_z2 = sd_j[:, None], stop_x[:, None], stop_z[:, None]
    slots = []
    for pl in planes:
        Nf = R.T @ _unit(pl["N"])
        e = float(Nf @ to_f(pl["p"]))
        half = float(pl["w"]) / 2
        if half > 0:
            slots.append((Nf, e, half))

    def slab(i, with_slots, e_t):
        """The field of slab i: the box (length, width, wrap line, stops), the shell band on the envelope (cut by the
        slots) or the bridge band inside the body edge, everything within `skirt` of real bone."""
        outer = abs(UU[i] - uc) - L / 2
        dde_i, dd_i = dde[i], dd[i]
        far = (outer > 0) | (dde_i > bridge_hi + r)
        box = np.maximum(np.maximum(outer, box_v), wrap_at[i] - NN2)
        if stop:
            shadow = col_top[i][:, None] > NN2
            box = np.where(band_j & shadow, np.maximum(box, r), box)
            sv = np.where(band_j & ~shadow, np.maximum(np.maximum(outer, av2 - W / 2 - stop_x2), wrap_at[i] - stop_z2 - NN2), 1e3)
            box = np.where(sd2, np.minimum(box, sv), box)
        shell = np.maximum(clear - dde_i, dde_i - cw)
        if with_slots:
            for Nf, e, half in slots:
                shell = np.maximum(shell, half - np.abs(Nf[0] * UU[i] + Nf[1] * VV2 + Nf[2] * NN2 - e))
        br = np.maximum(bridge_lo - dde_i, dde_i - bridge_hi)
        if e_t is not None:
            br = np.maximum(br, e_t)
        f = np.maximum(np.maximum(box, dd_i - dde_i - skirt), np.minimum(shell, br))
        return np.where(far, np.maximum(outer, dde_i - bridge_hi), f).astype(np.float32)
    # pass 0 (no slots, no bridge limit) finds the body's own +v / -v edge per position along the guide: the bridge (the
    # rib across the saw slots) runs `bridge` wide inside that edge, not the box edge, so it never floats
    e0 = np.full(nx, np.nan)
    for i in range(nx):
        rows = (slab(i, False, None) < 0).any(axis=1)
        if rows.any():
            e0[i] = VV[rows].max() if side > 0 else VV[rows].min()
    if side > 0:
        edge_v = ndi.minimum_filter1d(np.where(np.isnan(e0), np.inf, e0), 2 * win + 1, mode="nearest")
    else:
        edge_v = ndi.maximum_filter1d(np.where(np.isnan(e0), -np.inf, e0), 2 * win + 1, mode="nearest")
    # pass 1: saw slots (centred on the plane given, cut from the shell only) and the bridge inside the body edge
    F = np.empty((nx, ny, nz), np.float32)
    for i in range(nx):
        if np.isfinite(edge_v[i]):
            e_t = ((edge_v[i] - bridge - VV2) if side > 0 else (VV2 - edge_v[i] - bridge)).astype(np.float32)
        else:
            e_t = np.float32(1e3)
        F[i] = slab(i, True, e_t)
    del e0
    # the body as one region of the footprint (cells of the projection along d): small islands cut off by the silhouette
    # or the box are dropped and reported, larger ones stay and count as pieces
    fp = np.zeros(prj.na * prj.nb, bool)
    for i in range(nx):
        ins = F[i] < 0
        if ins.any():
            fp[prj.cells(float(i), J, K)[ins]] = True
    lab, nlab = ndi.label(fp.reshape(prj.nb, prj.na))
    dropped_islands = []
    if nlab > 1:
        sizes = np.bincount(lab.ravel())[1:]
        main = int(np.argmax(sizes)) + 1
        areas = sizes * prj.cell * prj.cell
        drop = [k + 1 for k in range(nlab) if k + 1 != main and areas[k] < 50]
        if drop:
            drop_cell = np.isin(lab.ravel(), drop)
            for i in range(nx):
                dm = drop_cell[prj.cells(float(i), J, K)] & (F[i] < 0)
                if dm.any():
                    F[i][dm] = r
            dropped_islands = [round(float(areas[k - 1]), 1) for k in drop]
    del fp, lab, J, K
    T["field"] = time.perf_counter() - t0

    # ---- screw sleeves (added, clear of bone and envelope) and drill holes (removed) ----
    screw_info, axes_ = [], []
    for s in screws:
        dirf = R.T @ _unit(s["dir"])
        el = to_f(s["entry"])
        ol = -dirf
        Rr, rr, top = float(s["D"]) / 2, float(s["d"]) / 2, cw + float(s["sleeveH"])
        # a sleeve is only added where the guide body is: the body must be present along the sleeve axis just above the
        # clearance, or the sleeve would float free of the shell; such a screw is reported instead
        # (the shell may stand up to `skirt` off the bone where the envelope's shadow face carries it, so the body is
        # looked for over the clearance band plus that allowance, as the preview does)
        pa, pb = _basis2(ol)
        step_t = max(0.2, r / 2)
        cnt = 5 * len(np.arange(clear + 0.3, cw - 0.3 + 1e-9, step_t))
        ts = np.arange(clear + 0.3, cw - 0.3 + skirt + 1e-9, step_t)
        hit = 0
        for t_ in ts:
            for sa, sb in ((0, 0), (0.6, 0), (-0.6, 0), (0, 0.6), (0, -0.6)):
                q = el + ol * t_ + (pa * sa + pb * sb) * Rr
                idx = np.floor((q - glo) / r + 0.5).astype(int)
                if np.all(idx >= 0) and idx[0] < nx and idx[1] < ny and idx[2] < nz:
                    i_, j_, k_ = idx
                    if F[i_, j_, k_] < 0:
                        hit += 1
                    elif clear - r < dde[i_, j_, k_] <= cw + r and any(abs(Nf @ q - e) < half + r for Nf, e, half in slots):
                        hit += 1
        if not (cnt and hit >= 0.5 * cnt):
            screw_info.append({"ok": False, "no_body": True})
            continue
        # the grid box around the axis (through the whole grid)
        rng = []
        for a in range(3):
            p1, p2 = el[a] - ol[a] * 400, el[a] + ol[a] * 400
            rng.append((max(0, int(math.floor((min(p1, p2) - Rr - glo[a]) / r)) - 1), min((nx, ny, nz)[a] - 1, int(math.ceil((max(p1, p2) + Rr - glo[a]) / r)) + 1)))
        info = {"ok": True}
        screw_info.append(info)
        axes_.append((el, ol, Rr, rr, top, rng, info))

    def radial(el, ol, rng):
        sl = tuple(slice(a, b + 1) for a, b in rng)
        qa, qb, qc = UU[sl[0]][:, None, None] - el[0], VV[sl[1]][None, :, None] - el[1], NN[sl[2]][None, None, :] - el[2]
        t_ = qa * ol[0] + qb * ol[1] + qc * ol[2]
        rad = np.sqrt(np.maximum(qa * qa + qb * qb + qc * qc - t_ * t_, 0.0))
        return sl, rad.astype(np.float32), t_.astype(np.float32)
    for el, ol, Rr, rr, top, rng, info in axes_:
        sl, rad, t_ = radial(el, ol, rng)
        cyl = np.maximum(np.maximum(rad - Rr, -1 - t_), t_ - top)
        d_s, de_s = dd[sl], dde[sl]
        in_cyl = (rad <= Rr + r)
        body = (cyl < 0) & (d_s > clear)
        n_all = int(np.count_nonzero(body))
        shaded = int(np.count_nonzero(body & (de_s <= clear)))
        F[sl] = np.where(in_cyl, np.minimum(F[sl], np.maximum(np.maximum(cyl, clear - d_s), clear - de_s)), F[sl])
        if n_all and shaded > 0.1 * n_all:
            info["shadowed"] = round(shaded / n_all, 2)
        del rad, t_, cyl, in_cyl, body
    for el, ol, Rr, rr, top, rng, info in axes_:
        sl, rad, t_ = radial(el, ol, rng)
        F[sl] = np.where(rad <= rr + r, np.maximum(F[sl], rr - rad), F[sl])
        del rad, t_
    # two separate guides: nothing between the outermost cuts beyond a capture flange past each slot
    if gap:
        fl = float(gap.get("flange", 3.0))
        NA, NB = R.T @ _unit(gap["A"]["N"]), R.T @ _unit(gap["B"]["N"])
        eA, eB = float(NA @ to_f(gap["A"]["p"])), float(NB @ to_f(gap["B"]["p"]))
        ta, tb = float(gap["A"].get("w", 1.0)) / 2 + fl, float(gap["B"].get("w", 1.0)) / 2 + fl
        for i in range(nx):
            dA = NA[0] * UU[i] + NA[1] * VV2 + NA[2] * NN2 - eA - ta
            dB = -(NB[0] * UU[i] + NB[1] * VV2 + NB[2] * NN2 - eB) - tb
            Fi = F[i]
            F[i] = np.where(Fi < 0, np.maximum(Fi, np.minimum(dA, dB)), Fi)
    # the surface must close inside the grid
    for sl in ((0,), (-1,), (slice(None), 0), (slice(None), -1), (slice(None), slice(None), 0), (slice(None), slice(None), -1)):
        F[sl] = np.maximum(F[sl], r)
    T["screws"] = time.perf_counter() - t0

    # drop specks left by slots and holes (under 1 % of the main body or 1 mm3, the preview's rule); count real pieces
    lab, nlab = ndi.label(F < 0)
    if nlab == 0:
        raise HttpError(422, "no guide body inside the footprint")
    sizes = np.bincount(lab.ravel())[1:]
    big = int(sizes.max())
    min_size = max(0.01 * big, 1.0 / (r * r * r))
    small = [k + 1 for k in range(nlab) if sizes[k] < min_size]
    if small:
        F[np.isin(lab, small)] = r
    pieces = nlab - len(small)
    del lab
    inside = F < 0
    vol_vox = int(np.count_nonzero(inside))
    contact = int(np.count_nonzero(inside & (dd > clear) & (dd <= cw) & (dd <= clear + r)))
    any_j = inside.any(axis=(0, 2))
    body_v = [round(float(VV[any_j].min()), 1), round(float(VV[any_j].max()), 1)] if any_j.any() else None
    del inside, any_j, dd, dde, E, bone
    T["speck"] = time.perf_counter() - t0

    # ---- one marching cubes of the field ----
    F[np.abs(F) < 2e-3] = 2e-3                      # values exactly at the level create coincident / non-manifold verts
    verts, faces, _, _ = marching_cubes(F, 0.0, spacing=(r, r, r), allow_degenerate=True)
    del F
    verts = (verts + glo).astype(np.float64)
    faces = faces.astype(np.int64)
    tri = verts[faces]
    signed = float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6)
    if signed < 0:                                   # skimage winding depends on gradient direction; we want outward CCW
        faces = faces[:, ::-1]
    del tri
    manifold = False
    man = m3d.Manifold(m3d.Mesh(np.ascontiguousarray(verts, dtype=np.float32), np.ascontiguousarray(faces, dtype=np.uint32)))
    if man.status() == m3d.Error.NoError and man.volume() > 0:
        # merge co-planar / near-flat triangles (surfaces move <= 10 um): the planar faces of the design become few
        # triangles, the bone-fitted surfaces keep their detail
        man = man.simplify(0.01)
        mesh = man.to_mesh64() if hasattr(man, "to_mesh64") else man.to_mesh()
        verts = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
        faces = np.asarray(mesh.tri_verts, dtype=np.int64)
        manifold = True
    T["mc"] = time.perf_counter() - t0

    verts = verts @ R.T + p                          # frame -> world (LPS, mm)
    if np.linalg.det(R) < 0:
        faces = faces[:, ::-1]
    verts, faces, welded = _weld(verts, faces)
    buf = io.BytesIO()
    trimesh.Trimesh(verts, faces, process=False).export(buf, file_type="stl")
    # validate what the client actually gets: the float32 STL, vertices merged by exact position
    tm = trimesh.load(io.BytesIO(buf.getvalue()), file_type="stl")
    edges_ok = bool(len(faces)) and np.all(np.unique(tm.edges_sorted, axis=0, return_counts=True)[1] == 2)
    watertight = bool(tm.is_watertight and tm.is_winding_consistent and edges_ok and tm.volume > 0)
    bodies = int(tm.body_count) if len(faces) else 0
    T["export"] = time.perf_counter() - t0
    return {
        "stl_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "watertight": watertight,
        "manifold": manifold,
        "volume_mm3": float(tm.volume),
        "faces": int(len(tm.faces)),
        "bodies": bodies,
        "pieces": int(pieces),
        "ms": int(round((time.perf_counter() - t0) * 1000)),
        "dropped_fragments": len(small),
        "dropped_islands_mm2": dropped_islands,
        "welded_vertices": int(welded),
        "grid": [nx, ny, nz],
        "resolution": r,
        "requested_resolution": r_req,
        "seat_dir": seat_dir,
        "screws": screw_info,
        "contact_mm2": round(contact * r * r, 1),
        "field_volume_mm3": round(vol_vox * r * r * r, 1),
        "body_v": body_v,
        "stage_ms": {k: int(round(v * 1000)) for k, v in T.items()},
    }


# --------------------------------------------------------------------------------------------- HTTP
CASE_RE = re.compile(r"^/cases/([A-Za-z0-9_-]+)(/draft|/versions(?:/(\d+))?)?/?$")


class Handler(seg_server.Handler):
    store = None
    timeout = 60          # seconds a client may stall while sending; ends half-open connections

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-Structures")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _body(self, limit=MAX_PLAN_BODY):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "bad Content-Length")
        if n < 0:
            raise HttpError(400, "bad Content-Length")
        if n > limit:
            self._unread = n          # answered with 413 first, then drained (see _dispatch)
            raise HttpError(413, "request too large")
        # an overall deadline (not just a per-read timeout) so a client trickling bytes cannot hold a job slot
        deadline = time.monotonic() + BODY_BASE_S + n / BODY_MIN_RATE
        chunks, got = [], 0
        while got < n:
            if time.monotonic() > deadline:
                raise HttpError(408, "request body too slow")
            try:   # each read may stall only briefly, so a silent or trickling client frees the job slot quickly
                self.connection.settimeout(max(0.5, min(5.0, deadline - time.monotonic())))
                chunk = self.rfile.read1(min(1 << 20, n - got))
            except OSError:
                raise HttpError(408, "request body too slow")
            if not chunk:
                raise HttpError(400, "request body ended early")
            chunks.append(chunk); got += len(chunk)

        def _no_const(c):
            raise ValueError(f"{c} is not valid JSON")
        try:
            obj = json.loads(b"".join(chunks) or b"null", parse_constant=_no_const)
        except ValueError as e:
            raise HttpError(400, f"invalid JSON: {e}")
        if not isinstance(obj, dict):
            raise HttpError(400, "JSON object expected")
        return obj

    def _drain(self):
        """After a 413: read and discard the rest of the upload (at most DRAIN_MAX, a few seconds), so a client that is still
        sending can finish and read the 413 instead of a connection reset; then close."""
        self.close_connection = True
        left = min(getattr(self, "_unread", 0), DRAIN_MAX)
        end = time.monotonic() + 10
        try:
            while left > 0 and time.monotonic() < end:
                self.connection.settimeout(1.0)
                chunk = self.rfile.read1(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            pass

    @staticmethod
    def _text(b, key, required=False):
        """A short string field of a request, or None; anything else is a 400 (not a database error)."""
        v = b.get(key)
        if v is None and not required:
            return None
        if not isinstance(v, str) or len(v) > MAX_TEXT:
            raise HttpError(400, f"{key} must be text of at most {MAX_TEXT} characters")
        return v

    def _dispatch(self, method):
        path = urlparse(self.path).path
        try:
            st = self.store
            if path in ("/cases", "/cases/"):
                if method == "GET":
                    return self._json(200, st.list_cases())
                if method == "POST":
                    b = self._body()
                    name = b.get("name")
                    if not isinstance(name, str) or not name.strip():
                        raise HttpError(400, "name required")
                    return self._json(200, {"id": st.create_case(name, self._text(b, "kind"), self._text(b, "fingerprint"))})
                raise HttpError(405, "method not allowed")
            m = CASE_RE.match(path)
            if m:
                cid, sub, vn = m.group(1), m.group(2), m.group(3)
                if sub is None and method == "GET":
                    return self._json(200, st.get_case(cid))
                if sub == "/draft" and method == "PUT":
                    b = self._body()
                    if "plan" not in b:
                        raise HttpError(400, "plan required")
                    return self._json(200, {"ok": True, "updated_at": st.put_draft(cid, b["plan"])})
                if sub == "/versions" and method == "GET":
                    return self._json(200, st.list_versions(cid))
                if sub == "/versions" and method == "POST":
                    b = self._body()
                    if b.get("plan") is None:
                        raise HttpError(400, "plan required")
                    return self._json(200, {"n": st.add_version(cid, b["plan"], self._text(b, "note"), self._text(b, "author"))})
                if vn is not None and method == "GET":
                    if len(vn) > 9:
                        raise HttpError(404, "no such version")
                    return self._json(200, st.get_version(cid, int(vn)))
                raise HttpError(405, "method not allowed")
            if path == "/guide" and method == "POST":
                # take the job slot before reading the (large) body, so waiting requests hold no memory
                if not GUIDE_SLOTS.acquire(timeout=120):
                    raise HttpError(503, "guide service busy, try again")
                try:
                    return self._json(200, build_guide(self._body(MAX_BODY)))
                except (KeyError, TypeError, ValueError, IndexError, OverflowError) as e:
                    raise HttpError(400, f"bad guide request: {type(e).__name__}: {e}")
                finally:
                    GUIDE_SLOTS.release()
            raise HttpError(404, f"not found: {path}")
        except HttpError as e:
            self._json(e.code, {"error": e.msg})
            if e.code == 413:
                self._drain()
            return
        except (TypeError, AttributeError, RecursionError, OverflowError) as e:   # wrong JSON shapes in a request body
            return self._json(400, {"error": f"bad request: {type(e).__name__}"})
        except Exception as e:  # keep the server alive, report the failure as JSON
            import traceback; traceback.print_exc()   # the details stay in the server log, not in the response
            return self._json(500, {"error": "internal error"})

    web_root = None   # optional: serve the studio (web/) from the same origin

    def _static(self, path):
        root = os.path.realpath(self.web_root)
        if path == "/config.js":     # tells the studio that this server is its case store and STL service
            body = b"window.YOLMED_SERVER = location.origin;\n"
            ctype = "application/javascript"
        else:
            path = unquote(path)         # %2E, %20 ... : file names with spaces or dots; the root check below stays the guard
            if "\x00" in path:
                raise HttpError(404, "not found")
            f = os.path.realpath(os.path.join(root, (path.lstrip("/") or "index.html")))
            if os.path.isdir(f):
                f = os.path.join(f, "index.html")
            if not (f == root or f.startswith(root + os.sep)) or not os.path.isfile(f):
                raise HttpError(404, f"not found: {path}")
            with open(f, "rb") as fh:
                body = fh.read()
            ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache"); self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return super().do_GET()
        if self.web_root and not (path.startswith("/cases") or path in ("/guide", "/segment")):
            try:
                return self._static(path)
            except HttpError as e:
                return self._json(e.code, {"error": e.msg})
        return self._dispatch("GET")

    def do_POST(self):
        if urlparse(self.path).path == "/segment":
            return super().do_POST()
        return self._dispatch("POST")

    def do_PUT(self):
        return self._dispatch("PUT")


def make_server(host, port, db, backend="threshold", web=None):
    Handler.backend = backend
    Handler.store = CaseStore(db)
    Handler.web_root = web
    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["threshold", "totalseg"], default="threshold")
    # environment variables let a hosting platform (Railway, Docker) configure the service
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8800)))
    ap.add_argument("--db", default=os.environ.get("YOLMED_DB", "./yolmed_cases.sqlite"))
    ap.add_argument("--web", default=os.environ.get("YOLMED_WEB"), help="serve the studio from this folder (e.g. ./web)")
    a = ap.parse_args()
    if os.path.dirname(a.db):
        os.makedirs(os.path.dirname(a.db), exist_ok=True)
    srv = make_server(a.host, a.port, a.db, a.backend, a.web)
    print(f"yolmed service ({a.backend}, db={a.db}) on http://{a.host}:{a.port}")
    srv.serve_forever()
