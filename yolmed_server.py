"""Yolmed planning service: the studio's case store, production guide STL and segmentation, one HTTP server.

    python yolmed_server.py --backend threshold --port 8800 --db ./yolmed_cases.sqlite [--web ./web]

Endpoints (JSON unless noted). With YOLMED_TOKEN set every endpoint but /health and the static files needs
`Authorization: Bearer <token>`; cross-origin pages need YOLMED_ALLOWED_ORIGINS (seg_server.py lists the settings).
  GET  /health                          -> {backend, structures, version, store}  (503 when the case store is not writable)
  POST /segment?...                     (seg_server.py: int16 HU body -> uint8 labels)
  GET  /cases                           -> [{id, name, kind, fingerprint, updated_at, n_versions}] newest first
  POST /cases {name, kind, fingerprint} -> {id}                       (name: 1..200 characters)
  GET  /cases/{id}                      -> {id, name, kind, fingerprint, draft, updated_at}
  PUT  /cases/{id}/draft {plan}         -> {ok: true, updated_at}
  GET  /cases/{id}/versions             -> [{n, note, author, created_at}] newest first
  POST /cases/{id}/versions {plan, note, author} -> {n}     (immutable, n = 1, 2, 3 ... per case; author <= 200 characters)
  GET  /cases/{id}/versions/{n}         -> {n, plan, note, author, created_at}
  POST /guide {crop, mask_b64, frame, g, planes, screws, gap?, wrap_profile?, stops?, seat_dir?, resolution?}
       -> {stl_b64, watertight, production_ok, issues, screws, resolution, requested_resolution, volume_mm3, faces, bodies,
           pieces, seat_dir, version, ms, ...}
       The production STL is the browser preview's guide (web/app.js buildGuide) on a 0.2 mm grid: g carries the
       preview's body (L, W, vc, uc, wrap, wrapU, wall, clear, bridge, side, skirt), planes the saw slots (already on
       the kerf side), wrap_profile the preview's wrap line and seat_dir its insertion direction; all optional fields
       may be left out (older clients), the server then derives them from the bone itself.
       production_ok is false when the STL must not be printed as it is: issues lists why (screw_no_body: a screw got
       no sleeve and no hole; resolution_coarsened: the grid is coarser than asked; not_manifold: the mesh is not closed).
  POST /guide {kind: "bar", bar: {path, r, pads}, crop?, mask_b64?}
       -> {stl_b64, watertight, volume_mm3, faces, bodies, bone_clear_mm, in_bone_verts, ms}
       The connecting bar between the two guides of a long resection (web/app.js barPlan), a separate part.
  POST /guide?job=<id> ...               the same, with its progress kept under <id> (8..64 letters, digits, - or _) while it runs
  GET  /guide/progress?job=<id>         -> {f, stage}  (f: share of the build done, 0..1; stage "queue" while it waits for
                                           the job slot; {f: null, stage: "none"} before it arrives and once it answered)

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
import sys
import threading
import time
import traceback
from urllib.parse import parse_qs, urlparse, unquote

import numpy as np
from scipy import ndimage as ndi

import seg_server  # the HTTP base (headers, auth, uploads) and /health, /segment
from seg_server import HttpError
from surgiguide.version import VERSION

MAX_CROP = 128e6                      # voxels in a guide crop (a 100 mm guide at 0.3 mm is ~100 M)
MAX_BODY = int(MAX_CROP * 4 / 3) + 8 * 1024 * 1024   # a /guide request: the crop's mask in base64 plus the plan fields
MAX_PLAN_BODY = 4 * 1024 * 1024       # case and version requests carry only plan JSON
MAX_GRID = 40e6                       # guide grid cells (~2 GB peak at this size)
MAX_PLANES = 64                       # saw slots / screws in one guide (a guide has a handful; each one costs a boolean)
MAX_SCREWS = 64
MAX_TEXT = 2000                       # kind, fingerprint, note
MAX_NAME = 200                        # case name, version author (listed in every GET /cases / history)
PREVIEW_RES = 0.4                     # mm: the browser preview's grid; a production grid coarser than this is not production
GUIDE_SLOTS = threading.BoundedSemaphore(int(os.environ.get("YOLMED_GUIDE_JOBS", "1")))
# progress of the running /guide jobs (POST /guide?job=<id>, polled with GET /guide/progress?job=<id>): the share of the
# build done, by stage. GUIDE_STAGE_END: the share of the build time at the end of each stage, measured on the anonymised
# real CT sample at 0.2 mm (fill 0.3 s, resample 2.3, distance 4.3, envelope 4, print checks 1.4, ... of 15.5 s); stages that run in a loop
# report within themselves, so the bar moves on real work, not on a clock (the two distance transforms are single calls:
# the bar waits on each for a few seconds)
GUIDE_STAGES = ("fill", "resample", "edt", "env", "field", "screws", "print_checks", "speck", "mc", "export")
GUIDE_STAGE_END = (0.02, 0.17, 0.445, 0.705, 0.73, 0.76, 0.85, 0.855, 0.90, 1.0)
GUIDE_JOB_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
GUIDE_JOBS_MAX = 256
GUIDE_JOBS = {}
GUIDE_JOBS_LOCK = threading.Lock()


def _job_set(job, f, stage):
    if not job:
        return
    with GUIDE_JOBS_LOCK:
        if job not in GUIDE_JOBS and len(GUIDE_JOBS) >= GUIDE_JOBS_MAX:
            GUIDE_JOBS.pop(min(GUIDE_JOBS, key=lambda k: GUIDE_JOBS[k]["t"]))
        GUIDE_JOBS[job] = {"f": round(min(1.0, max(0.0, f)), 4), "stage": stage, "t": time.time()}


def _job_get(job):
    with GUIDE_JOBS_LOCK:
        j = GUIDE_JOBS.get(job)
        return None if j is None else {"f": j["f"], "stage": j["stage"]}


def _job_drop(job):
    with GUIDE_JOBS_LOCK:
        GUIDE_JOBS.pop(job, None)


def _stage_marker(progress):
    """mark(stage, frac): `frac` of `stage` is done (1 = the stage has ended); reported as the share of the whole build,
    never lower than before (a grid coarsened for the cell budget resamples again inside the same share)."""
    done = [0.0]

    def mark(stage, frac=1.0):
        if progress is None:
            return
        i = GUIDE_STAGES.index(stage)
        a = GUIDE_STAGE_END[i - 1] if i else 0.0
        done[0] = max(done[0], round(a + (GUIDE_STAGE_END[i] - a) * min(1.0, max(0.0, frac)), 4))
        progress(done[0], stage)
    return mark


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
    CREATE TABLE IF NOT EXISTS health (k INTEGER PRIMARY KEY, t TEXT);
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

    def check(self):
        """Health: the database answers and takes a write (rolled back; a full disk / read-only volume fails here)."""
        try:
            c = sqlite3.connect(self.path, timeout=5)
            try:
                c.execute("BEGIN IMMEDIATE")
                c.execute("SELECT COUNT(*) FROM cases").fetchone()
                c.execute("INSERT OR REPLACE INTO health (k, t) VALUES (1, ?)", (now_iso(),))
                c.execute("ROLLBACK")
            finally:
                c.close()
            return True, None
        except sqlite3.Error as e:
            return False, str(e)

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
            cur = c.execute("UPDATE cases SET draft=?, updated_at=? WHERE id=?", (json.dumps(plan, allow_nan=False), t, cid))
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
                      (cid, n, json.dumps(plan, allow_nan=False), note, author, t))
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


BAR_SEGMENTS = 64                                       # facets around the bar's round solids


def _frame_to(axis):
    """3x3 rotation taking +z to the unit vector `axis`."""
    a = _unit(axis)
    t = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0.0, 1, 0])
    x = np.cross(t, a)
    x /= np.linalg.norm(x)
    return np.column_stack([x, np.cross(a, x), a])


def build_bar(req):
    """The connecting bar between the two guides of a long resection (web/app.js barPlan / buildBarMesh), from the same
    spec the preview builds it from: a rod of radius r along `path` (capsules between consecutive points) and a pad per
    lug (cylinder of radius R and thickness T about `axis`, centred on `c`) with the pin hole (radius `hole`) through it.
    Built with exact solids (Manifold), so the STL is closed by construction. When the request carries the bone mask
    around the bar (crop + mask_b64, as a guide request), the bar's clearance from the full-resolution bone is measured:
    bone_clear_mm = the smallest distance from the bar's surface to bone (mm, surface points against bone voxel centres less
    half a voxel), in_bone_verts = surface points inside a bone voxel."""
    import manifold3d as m3d
    import trimesh

    t0 = time.perf_counter()
    bar = req.get("bar")
    if not isinstance(bar, dict):
        raise HttpError(400, "bar must be {path, r, pads}")
    try:
        path = np.asarray(bar["path"], float).reshape(-1, 3)
        rad = float(bar["r"])
        pads = [(np.asarray(p["c"], float).reshape(3), np.asarray(p["axis"], float).reshape(3), float(p["R"]), float(p["T"]), float(p["hole"])) for p in bar.get("pads") or []]
    except (KeyError, TypeError, ValueError):
        raise HttpError(400, "bar must be {path: [[x, y, z], ...], r, pads: [{c, axis, R, T, hole}]}")
    if not 2 <= len(path) <= 16 or not np.all(np.isfinite(path)) or len(pads) > 4:
        raise HttpError(400, "bar path must have 2..16 finite points, at most 4 pads")
    _check_ranges({"bar r": (rad, 0.5, 6)})
    for c, a, R_, T_, h_ in pads:
        _check_ranges({"pad R": (R_, 1, 15), "pad T": (T_, 0.5, 25), "pad hole": (h_, 0.1, R_ - 0.3)})
        if not (np.all(np.isfinite(c)) and np.all(np.isfinite(a))):
            raise HttpError(400, "pad centre and axis must be finite")
    if float(np.linalg.norm(path.max(0) - path.min(0))) > 300:
        raise HttpError(422, "bar longer than 300 mm")
    sph = m3d.Manifold.sphere(rad, BAR_SEGMENTS)
    solids = []
    for a, b in zip(path[:-1], path[1:]):
        solids.append(m3d.Manifold.batch_hull([sph.translate(tuple(a)), sph.translate(tuple(b))]))
    holes = []
    for c, ax, R_, T_, h_ in pads:
        M = np.column_stack([_frame_to(ax), c])
        solids.append(m3d.Manifold.cylinder(T_, R_, R_, BAR_SEGMENTS, True).transform(M))
        holes.append(m3d.Manifold.cylinder(T_ + 2, h_, h_, BAR_SEGMENTS, True).transform(M))
    man = m3d.Manifold.batch_boolean(solids, m3d.OpType.Add)
    if holes:
        man = m3d.Manifold.batch_boolean([man] + holes, m3d.OpType.Subtract)
    if man.status() != m3d.Error.NoError or man.is_empty():
        raise HttpError(422, "bar solid could not be built")
    mesh = man.to_mesh64() if hasattr(man, "to_mesh64") else man.to_mesh()
    verts = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts, dtype=np.int64)
    verts, faces, _ = _weld(verts, faces)
    verts, faces, repair = _repair_mesh(verts, faces)
    data = _stl_bytes(verts, faces, f"YOLMED bar {VERSION}")
    tm, watertight = _mesh_check(data)
    out = {
        "stl_b64": base64.b64encode(data).decode("ascii"),
        "watertight": watertight, "production_ok": watertight, "issues": [] if watertight else [{"code": "not_manifold"}],
        "version": VERSION, "repair": repair,
        "manifold": True, "volume_mm3": float(tm.volume), "faces": int(len(tm.faces)), "bodies": int(tm.body_count), "pieces": int(tm.body_count),
        "bone_clear_mm": None, "in_bone_verts": None,
    }
    # clearance from the bone the request carries (the crop's voxel centres; a vertex in a bone voxel counts as inside)
    if req.get("crop") and req.get("mask_b64"):
        crop = req["crop"]
        cnx, cny, cnz = int(crop["nx"]), int(crop["ny"]), int(crop["nz"])
        if cnx * cny * cnz > MAX_CROP:
            raise HttpError(422, "crop too large")
        try:
            raw = base64.b64decode(req["mask_b64"], validate=True)
        except (TypeError, ValueError):
            raise HttpError(400, "mask_b64 is not base64")
        if len(raw) != cnx * cny * cnz:
            raise HttpError(400, f"mask has {len(raw)} bytes, expected nx*ny*nz = {cnx * cny * cnz}")
        mask = np.frombuffer(raw, np.uint8).reshape(cnz, cny, cnx) > 0
        sp = np.asarray(crop["sp"], float)
        axes = np.asarray(crop["axes"], float).reshape(3, 3)
        A = (axes * sp[:, None]).T
        # the bar's surface: its vertices plus uniform samples (a long rod has vertices only at its ends), deterministic
        pts = np.vstack([np.asarray(tm.vertices), trimesh.sample.sample_surface(tm, int(min(200000, max(5000, tm.area * 8))), seed=0)[0]])
        ijk = np.linalg.solve(A, (pts - np.asarray(crop["origin"], float)).T).T     # crop (i, j, k) per surface point
        idx = np.floor(ijk + 0.5).astype(int)
        inside = np.all((idx >= 0) & (idx < [cnx, cny, cnz]), axis=1)
        if mask.any():
            dist = ndi.distance_transform_edt(~mask, sampling=(sp[2], sp[1], sp[0]))
            d = np.full(len(idx), np.inf)
            d[inside] = dist[idx[inside, 2], idx[inside, 1], idx[inside, 0]]
            inb = np.zeros(len(idx), bool)
            inb[inside] = mask[idx[inside, 2], idx[inside, 1], idx[inside, 0]]
            out["in_bone_verts"] = int(np.count_nonzero(inb))
            fin = d[np.isfinite(d)]
            out["bone_clear_mm"] = round(float(max(0.0, fin.min() - 0.5 * sp.max())), 2) if len(fin) else None
        else:
            out["in_bone_verts"] = 0
    out["ms"] = int(round((time.perf_counter() - t0) * 1000))
    return out


def _vec(x, n=3):
    return isinstance(x, (list, tuple)) and len(x) == n and all(isinstance(c, (int, float)) and not isinstance(c, bool) for c in x)


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _validate_guide(req):
    """The shape of a /guide request, checked before any work: a wrong field is a 400 that names it (anything that still
    fails later is a server error, logged with its traceback)."""
    def need(ok, msg):
        if not ok:
            raise HttpError(400, msg)
    crop, fr, g = req.get("crop"), req.get("frame"), req.get("g")
    need(isinstance(crop, dict), "crop must be {nx, ny, nz, sp, origin, axes}")
    need(all(isinstance(crop.get(k), int) and not isinstance(crop.get(k), bool) for k in ("nx", "ny", "nz")), "crop.nx, ny, nz must be integers")
    need(_vec(crop.get("sp")) and _vec(crop.get("origin")), "crop.sp and crop.origin must be 3 numbers")
    ax = crop.get("axes")
    need(isinstance(ax, (list, tuple)) and len(ax) == 3 and all(_vec(a) for a in ax), "crop.axes must be 3 rows of 3 numbers")
    need(abs(np.linalg.det(np.asarray(ax, float))) > 1e-6, "crop.axes must be independent directions")
    need(isinstance(req.get("mask_b64"), str), "mask_b64 must be a base64 string")
    ms = req.get("mask_scale")
    need(ms is None or (isinstance(ms, int) and not isinstance(ms, bool) and 1 <= ms <= 255), "mask_scale must be an integer 1..255")
    need(isinstance(fr, dict) and all(_vec(fr.get(k)) for k in ("p", "u", "v", "n")), "frame must be {p, u, v, n}, 3 numbers each")
    need(isinstance(g, dict) and all(_num(g.get(k)) for k in ("L", "W", "wrap", "wall", "clear", "bridge")),
         "g needs the numbers L, W, wrap, wall, clear, bridge")
    need(all(g.get(k) is None or _num(g.get(k)) for k in ("side", "vc", "uc", "skirt")), "g.side, vc, uc, skirt must be numbers")
    planes, screws = req.get("planes") or [], req.get("screws") or []
    need(isinstance(planes, list) and all(isinstance(p, dict) and _vec(p.get("p")) and _vec(p.get("N")) and _num(p.get("w")) for p in planes),
         "planes must be a list of {p, N, w}")
    need(isinstance(screws, list) and all(isinstance(s, dict) and _vec(s.get("entry")) and _vec(s.get("dir")) and all(_num(s.get(k)) for k in ("d", "D", "sleeveH"))
                                          for s in screws), "screws must be a list of {entry, dir, d, D, sleeveH}")
    gap = req.get("gap")
    if gap:
        need(isinstance(gap, dict) and all(isinstance(gap.get(k), dict) and _vec(gap[k].get("p")) and _vec(gap[k].get("N")) for k in ("A", "B")),
             "gap needs plane records A and B ({p, N, w})")
    stops = req.get("stops")
    need(stops is None or (isinstance(stops, dict) and all(stops.get(k) is None or _vec(stops.get(k), 2) for k in ("pos", "neg"))),
         "stops must be {pos: [length, depth] | null, neg: ...}")
    need(req.get("resolution") is None or _num(req.get("resolution")), "resolution must be a number")
    sd = req.get("seat_dir")
    need(sd is None or (isinstance(sd, dict) and _num(sd.get("tilt")) and _num(sd.get("az"))), "seat_dir must be {tilt, az} in degrees")


def _repair_mesh(verts, faces):
    """Make the mesh what a float32 STL reader sees and clean it: vertices at their float32 positions merged, faces that
    collapse (repeated corners) and duplicate faces removed, and flat closed slivers (components of no volume,
    left where two surface sheets touch after the simplification) dropped. Returns (verts, faces, report)."""
    import trimesh
    rep = {}
    v32 = np.asarray(verts, np.float32)
    uv, inv = np.unique(v32, axis=0, return_inverse=True)
    f = inv.reshape(-1)[np.asarray(faces)]
    keep = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    rep["degenerate_faces"] = int(np.count_nonzero(~keep))
    f = f[keep]          # (a flat face on three distinct corners stays: it closes the surface between them)
    # faces on the same three corners: a repeated face is kept once, a face and its reversed twin close nothing and both go
    key = np.sort(f, axis=1)
    _, inv_k, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    inv_k = inv_k.reshape(-1)
    drop = np.zeros(len(f), bool)
    for g in np.nonzero(cnt > 1)[0]:
        idx = np.nonzero(inv_k == g)[0]
        rot = [tuple(np.roll(f[i], -int(np.argmin(f[i])))) for i in idx]       # orientation-preserving canonical order
        fwd = [i for i, t in zip(idx, rot) if t == rot[0]]
        rev = [i for i, t in zip(idx, rot) if t != rot[0]]
        net = len(fwd) - len(rev)
        keep = (fwd if net > 0 else rev)[:1] if net else []
        drop[idx] = True
        drop[keep] = False
    rep["duplicate_faces"] = int(np.count_nonzero(drop))
    f = f[~drop]
    tm = trimesh.Trimesh(uv.astype(np.float64), f, process=False)
    slivers = 0
    if len(f):
        parts = trimesh.graph.connected_components(tm.face_adjacency, nodes=np.arange(len(f)), min_len=1)
        if len(parts) > 1:
            drop = []
            for comp in parts:
                sub = tm.submesh([comp], append=True, repair=False)
                if abs(float(sub.volume)) < 1e-2 and float(sub.area) < 1.0:
                    drop.extend(comp)
                    slivers += 1
            if drop:
                m = np.ones(len(f), bool)
                m[np.asarray(drop)] = False
                f = f[m]
    rep["slivers"] = slivers
    used, inv2 = np.unique(f, return_inverse=True)
    return uv.astype(np.float64)[used], inv2.reshape(-1, 3), rep


def _stl_bytes(verts, faces, title):
    """Binary STL with a header naming the software version (never starting with 'solid')."""
    import trimesh
    buf = io.BytesIO()
    trimesh.Trimesh(verts, faces, process=False).export(buf, file_type="stl")
    data = bytearray(buf.getvalue())
    data[:80] = title.encode("ascii", "replace")[:80].ljust(80, b" ")
    return bytes(data)


def _mesh_check(data):
    """What the client gets, checked as a slicer would read it: the float32 STL, vertices merged by exact position."""
    import trimesh
    tm = trimesh.load(io.BytesIO(data), file_type="stl")
    n = len(tm.faces)
    edges_ok = bool(n) and np.all(np.unique(tm.edges_sorted, axis=0, return_counts=True)[1] == 2)
    return tm, bool(n and tm.is_watertight and tm.is_winding_consistent and edges_ok and tm.volume > 0)


# ---- print checks on the finished guide field (thread "Guide STL kalitesi", 2026-10-21) ----
# What keeps a watertight STL from working on the table, measured on the grid the STL is cut from:
#   thin_wall    a patch of guide wall thinner than PRINT_MIN_WALL mm (a ball of that diameter does not fit), larger
#                than PRINT_THIN_PATCH_MM3: breaks in printing or in the hand. Edges and corners of a thick body also
#                lose voxels to the ball; only voxels at least one voxel deep inside the body count, so a sharp edge is
#                not a thin wall
#   bone_overlap guide material inside the bone: the guide cannot sit where it was planned
#   undercut     guide material in the bone's shadow along the insertion direction: it cannot be put on along it
PRINT_MIN_WALL = 1.0      # mm, the thinnest wall a resin print of a cutting guide keeps (sample value; clinical team)
PRINT_TOL_MM3 = 1.0       # mm3 of guide in bone / in the shadow tolerated (a few cells of meshing noise)
# a thin patch this large is a wall, not the feathered rim where the shell meets the wrap line (on a real CT guide the
# rim's largest thin patch was 1 mm3, spread along the edge)
PRINT_THIN_PATCH_MM3 = 2.0


def _ball(rad):
    k = int(math.ceil(rad))
    z, y, x = np.mgrid[-k:k + 1, -k:k + 1, -k:k + 1]
    return (x * x + y * y + z * z) <= rad * rad + 1e-9


def print_checks(inside, bone, shadow, r):
    """inside: guide cells (bool grid), bone: solid bone cells, shadow: cells under bone along the insertion direction
    (or None), r: grid step in mm. Returns {thin_wall_mm3, bone_overlap_mm3, undercut_mm3, min_wall_mm}."""
    v3 = r * r * r
    out = {"bone_overlap_mm3": round(float(np.count_nonzero(inside & bone)) * v3, 2),
           "undercut_mm3": round(float(np.count_nonzero(inside & shadow)) * v3, 2) if shadow is not None else 0.0,
           "thin_wall_mm3": 0.0, "thin_patch_mm3": 0.0, "min_wall_mm": PRINT_MIN_WALL}
    idx = np.nonzero(inside.any(axis=(1, 2)))[0], np.nonzero(inside.any(axis=(0, 2)))[0], np.nonzero(inside.any(axis=(0, 1)))[0]
    if not all(len(a) for a in idx):
        return out
    pad = int(math.ceil(PRINT_MIN_WALL / r)) + 2
    sl = tuple(slice(max(0, a[0] - pad), a[-1] + pad + 1) for a in idx)
    g = np.pad(inside[sl], pad)
    ball = _ball(PRINT_MIN_WALL / 2 / r)
    opened = ndi.binary_dilation(ndi.binary_erosion(g, ball), ball)
    core = ndi.binary_erosion(g, ndi.generate_binary_structure(3, 1))
    thin = g & ~opened & core
    # isolated voxels are meshing noise; a thin wall is a patch
    lab, n = ndi.label(thin, ndi.generate_binary_structure(3, 3))
    if n:
        sizes = np.bincount(lab.ravel())[1:]
        out["thin_wall_mm3"] = round(float(sizes[sizes * v3 >= 0.2].sum()) * v3, 2)
        out["thin_patch_mm3"] = round(float(sizes.max()) * v3, 2)
    return out


def build_guide(req, progress=None):
    """progress(f, stage), optional: called as the build goes on (f = share done, 0..1)."""
    import manifold3d as m3d
    from skimage.measure import marching_cubes

    if req.get("kind") == "bar":
        return build_bar(req)
    _validate_guide(req)
    mark = _stage_marker(progress)
    t0 = time.perf_counter()
    T = {}
    crop, fr, g = req["crop"], req["frame"], req["g"]
    cnx, cny, cnz = int(crop["nx"]), int(crop["ny"]), int(crop["nz"])
    sp = np.asarray(crop["sp"], float)
    corg = np.asarray(crop["origin"], float)
    axes = np.asarray(crop["axes"], float).reshape(3, 3)       # rows: i, j, k unit vectors
    if cnx * cny * cnz > MAX_CROP:
        raise HttpError(422, f"crop too large ({cnx}x{cny}x{cnz}); at most {int(MAX_CROP)} voxels")
    if min(cnx, cny, cnz) < 2:
        raise HttpError(400, "invalid crop grid")
    try:
        raw = base64.b64decode(req["mask_b64"], validate=True)
    except ValueError:
        raise HttpError(400, "mask_b64 is not base64")
    if len(raw) != cnx * cny * cnz:
        raise HttpError(400, f"mask has {len(raw)} bytes, expected nx*ny*nz = {cnx * cny * cnz}")
    # the mask: 0/1 bone cells, or with mask_scale the bone occupancy of each cell (value / mask_scale, 0.5 = on the
    # threshold's surface): the studio sends the CT values as a ramp around the threshold, so the surface lies between
    # cells instead of on their faces (no slice-thick terraces on the bone-contact surface)
    scale = req.get("mask_scale")
    if scale:
        occ = np.frombuffer(raw, np.uint8).reshape(cnz, cny, cnx).astype(np.float32) * np.float32(1 / scale)
        mask = occ >= 0.5
    else:
        occ = None
        mask = np.frombuffer(raw, np.uint8).reshape(cnz, cny, cnx) > 0
    del raw
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
    if occ is not None:
        # closed cavities count as bone (as for the 0/1 mask); elsewhere the occupancy stands
        occ[filled & ~mask] = 1.0
    del mask
    T["fill"] = time.perf_counter() - t0
    mark("fill")

    # frame-aligned isotropic grid with the preview's extents (grid nodes shifted by an irrational fraction of a voxel
    # so no node lies exactly on a round-numbered design plane). A guide too large for the cell budget at the requested
    # resolution is built at the next coarser one (reported in the answer) rather than refused.
    max_sleeve = max([float(s["sleeveH"]) for s in screws] or [0.0])
    lo = np.array([uc - L / 2 - 4, vc - W / 2 - 4 - ext_neg, -max(wrap + 10, 30) - max(0.0, L / 2 - 15) * 0.6])
    hi = np.array([uc + L / 2 + 4, vc + W / 2 + 4 + ext_pos, cw + max(max_sleeve, bridge) + 6])
    # grow the box around both ends of every sleeve (a tilted or wide sleeve near an edge would otherwise be clipped and
    # capped by the grid); grown by whole grid steps so the nodes stay where the preview puts them
    for s in screws:
        el = to_f(s["entry"])
        ol = -(R.T @ _unit(s["dir"]))
        m = float(s["D"]) / 2 + 2
        for q in (el, el + ol * (cw + float(s["sleeveH"]))):
            lo = np.where(q - m < lo, lo - np.ceil((lo - (q - m)) / r) * r, lo)
            hi = np.where(q + m > hi, hi + np.ceil(((q + m) - hi) / r) * r, hi)
    A = (axes * sp[:, None]).T                          # columns: world step per crop i, j, k
    Ainv = np.linalg.inv(A)
    P = np.array([[0, 0, 1], [0, 1, 0], [1, 0, 0]], float)
    # light smoothing of the voxel mask (sigma = half a crop voxel) gives a density whose 0.5 level is the bone surface,
    # between grid nodes
    src = ndi.gaussian_filter(filled.astype(np.float32) if occ is None else occ, 0.5)
    del filled, occ
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
            mark("resample", 0.8 * i1 / nx)
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
    mark("resample")

    # signed distance to the bone surface (outside > 0; -r/2 on bone nodes); within 1.5 voxels of the surface it comes
    # from the density itself, (0.5 - density) / |gradient|, which places the surface to a fraction of a voxel
    dist = (ndi.distance_transform_edt(~bone, sampling=r) - r / 2).astype(np.float32)
    dist[bone] = -r / 2
    dist_raw = dist.copy()
    mark("edt", 0.9)

    def refine(d_arr):
        near, g2, fade = 1.5 * r, 1 / (2 * r), 0.5 * r
        for i in range(1, nx - 1):
            if i % 16 == 0:
                mark("edt", 0.9 + 0.06 * i / nx)
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
    mark("edt")

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
    cands = [forced] if forced else SEAT_CANDS
    for ci, (tilt, az) in enumerate(cands):
        mark("env", 0.05 * ci / len(cands))
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
    mark("env", 0.05)
    for i in range(nx):
        if i % 16 == 0:
            mark("env", 0.05 + 0.05 * i / nx)
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
        mark("env", 0.85)
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
    mark("env")

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
    BR_OFF = np.float32(1e3)
    e0 = np.full(nx, np.nan)
    for i in range(nx):
        rows = (slab(i, False, BR_OFF) < 0).any(axis=1)
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
    mark("field")

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
        """The grid box around a screw axis (it runs through the whole grid, so a tilted screw's box is most of it), a few
        slabs at a time so the float64 temporaries stay ~100 MB: yields (slices, radial distance, position along the axis)."""
        (a0, a1), (b0, b1), (c0, c1) = rng
        qb, qc = VV[b0:b1 + 1][None, :, None] - el[1], NN[c0:c1 + 1][None, None, :] - el[2]
        step = max(1, int(2e6 // max(1, (b1 - b0 + 1) * (c1 - c0 + 1))))
        for i0 in range(a0, a1 + 1, step):
            i1 = min(a1 + 1, i0 + step)
            qa = UU[i0:i1][:, None, None] - el[0]
            t_ = qa * ol[0] + qb * ol[1] + qc * ol[2]
            rad = np.sqrt(np.maximum(qa * qa + qb * qb + qc * qc - t_ * t_, 0.0))
            yield (slice(i0, i1), slice(b0, b1 + 1), slice(c0, c1 + 1)), rad.astype(np.float32), t_.astype(np.float32)
    for el, ol, Rr, rr, top, rng, info in axes_:
        n_all = shaded = 0
        for sl, rad, t_ in radial(el, ol, rng):
            cyl = np.maximum(np.maximum(rad - Rr, -1 - t_), t_ - top)
            d_s, de_s = dd[sl], dde[sl]
            in_cyl = (rad <= Rr + r)
            body = (cyl < 0) & (d_s > clear)
            n_all += int(np.count_nonzero(body))
            shaded += int(np.count_nonzero(body & (de_s <= clear)))
            F[sl] = np.where(in_cyl, np.minimum(F[sl], np.maximum(np.maximum(cyl, clear - d_s), clear - de_s)), F[sl])
        if n_all and shaded > 0.1 * n_all:
            info["shadowed"] = round(shaded / n_all, 2)
    for el, ol, Rr, rr, top, rng, info in axes_:
        for sl, rad, t_ in radial(el, ol, rng):
            F[sl] = np.where(rad <= rr + r, np.maximum(F[sl], rr - rad), F[sl])
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
    mark("screws")

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
    pc = print_checks(inside, bone, (E == 2) if n_shadow else None, r)
    T["print_checks"] = time.perf_counter() - t0
    mark("print_checks")
    vol_vox = int(np.count_nonzero(inside))
    contact = int(np.count_nonzero(inside & (dd > clear) & (dd <= cw) & (dd <= clear + r)))
    any_j = inside.any(axis=(0, 2))
    body_v = [round(float(VV[any_j].min()), 1), round(float(VV[any_j].max()), 1)] if any_j.any() else None
    del inside, any_j, dd, dde, E, bone
    T["speck"] = time.perf_counter() - t0
    mark("speck")

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
    mark("mc")

    verts = verts @ R.T + p                          # frame -> world (LPS, mm)
    if np.linalg.det(R) < 0:
        faces = faces[:, ::-1]
    verts, faces, welded = _weld(verts, faces)
    verts, faces, repair = _repair_mesh(verts, faces)
    data = _stl_bytes(verts, faces, f"YOLMED guide {VERSION} grid {r:g} mm")
    tm, watertight = _mesh_check(data)
    bodies = int(tm.body_count) if len(faces) else 0
    T["export"] = time.perf_counter() - t0
    mark("export")
    # what keeps this STL from being printed as it is (the studio blocks the package and says why)
    issues = []
    for k, si in enumerate(screw_info):
        si["index"] = k
        if si.get("no_body"):
            issues.append({"code": "screw_no_body", "screw": k})
    if r > r_req + 1e-9:
        issues.append({"code": "resolution_coarsened", "requested_mm": r_req, "used_mm": r, "coarser_than_preview": bool(r > PREVIEW_RES + 1e-9)})
    if not watertight:
        issues.append({"code": "not_manifold"})
    if pc["thin_patch_mm3"] > PRINT_THIN_PATCH_MM3:
        issues.append({"code": "thin_wall", "mm3": pc["thin_wall_mm3"], "min_wall_mm": PRINT_MIN_WALL})
    if pc["bone_overlap_mm3"] > PRINT_TOL_MM3:
        issues.append({"code": "bone_overlap", "mm3": pc["bone_overlap_mm3"]})
    if pc["undercut_mm3"] > PRINT_TOL_MM3:
        issues.append({"code": "undercut", "mm3": pc["undercut_mm3"]})
    blocking = [i for i in issues if i["code"] != "resolution_coarsened" or i["coarser_than_preview"]]
    return {
        "stl_b64": base64.b64encode(data).decode("ascii"),
        "watertight": watertight,
        "manifold": manifold,
        "production_ok": not blocking,
        "issues": issues,
        "version": VERSION,
        "volume_mm3": float(tm.volume),
        "faces": int(len(tm.faces)),
        "bodies": bodies,
        "pieces": int(pieces),
        "ms": int(round((time.perf_counter() - t0) * 1000)),
        "dropped_fragments": len(small),
        "dropped_islands_mm2": dropped_islands,
        "welded_vertices": int(welded),
        "repair": repair,
        "grid": [nx, ny, nz],
        "resolution": r,
        "requested_resolution": r_req,
        "seat_dir": seat_dir,
        "screws": screw_info,
        "screws_missing": sum(1 for si in screw_info if si.get("no_body")),
        "print_checks": pc,
        "contact_mm2": round(contact * r * r, 1),
        "field_volume_mm3": round(vol_vox * r * r * r, 1),
        "body_v": body_v,
        "stage_ms": {k: int(round(v * 1000)) for k, v in T.items()},
    }


# --------------------------------------------------------------------------------------------- HTTP
CASE_RE = re.compile(r"^/cases/([A-Za-z0-9_-]+)(/draft|/versions(?:/(\d+))?)?/?$")
GUIDE_ERRORS = (KeyError, TypeError, ValueError, IndexError, OverflowError, AttributeError)


def _finite_float(s):
    """JSON numbers that overflow (1e999) would be stored as Infinity, which no browser can read back: refused."""
    x = float(s)
    if not math.isfinite(x):
        raise ValueError(f"number out of range: {s[:40]}")
    return x


def _no_const(c):
    raise ValueError(f"{c} is not valid JSON")


class Handler(seg_server.Handler):
    store = None
    web_root = None   # optional: serve the studio (web/) from the same origin

    def _body(self, limit=MAX_PLAN_BODY):
        raw = self._read_body(limit)
        try:
            obj = json.loads(raw or b"null", parse_constant=_no_const, parse_float=_finite_float)
        except ValueError as e:
            raise HttpError(400, f"invalid JSON: {str(e)[:200]}")
        except RecursionError:
            raise HttpError(400, "invalid JSON: nested too deeply")
        finally:
            del raw
        if not isinstance(obj, dict):
            raise HttpError(400, "JSON object expected")
        return obj

    @staticmethod
    def _text(b, key, required=False, limit=MAX_TEXT):
        """A short string field of a request, or None; anything else is a 400 (not a database error)."""
        v = b.get(key)
        if v is None and not required:
            return None
        if not isinstance(v, str) or len(v) > limit or (required and not v.strip()):
            raise HttpError(400, f"{key} must be text of 1 to {limit} characters" if required else f"{key} must be text of at most {limit} characters")
        return v

    def _dispatch(self, method):
        path = urlparse(self.path).path
        try:
            st = self.store
            if path.startswith("/cases") or path in ("/guide", "/guide/progress"):
                self._require_auth()
            if path in ("/cases", "/cases/"):
                if method == "GET":
                    return self._json(200, st.list_cases())
                if method == "POST":
                    b = self._body()
                    name = self._text(b, "name", required=True, limit=MAX_NAME)
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
                    return self._json(200, {"n": st.add_version(cid, b["plan"], self._text(b, "note"), self._text(b, "author", limit=MAX_NAME))})
                if vn is not None and method == "GET":
                    if len(vn) > 9:
                        raise HttpError(404, "no such version")
                    return self._json(200, st.get_version(cid, int(vn)))
                raise HttpError(405, "method not allowed")
            if path == "/guide/progress" and method == "GET":
                job = parse_qs(urlparse(self.path).query).get("job", [""])[0]
                if not GUIDE_JOB_RE.match(job):
                    raise HttpError(400, "job must be 8 to 64 letters, digits, - or _")
                # a job not (yet / any more) running answers {stage: "none"} rather than a 404: the studio polls from the
                # moment it starts the upload, and a 404 there would be a console error on every production STL
                return self._json(200, _job_get(job) or {"f": None, "stage": "none"})
            if path == "/guide" and method == "POST":
                # optional ?job=<id>: the build's progress can be polled at GET /guide/progress?job=<id> while it runs
                job = parse_qs(urlparse(self.path).query).get("job", [""])[0]
                if job and not GUIDE_JOB_RE.match(job):
                    raise HttpError(400, "job must be 8 to 64 letters, digits, - or _")
                req = self._body(MAX_BODY)
                _job_set(job, 0.0, "queue")
                # the job slot is taken only now, with the whole body in hand: a slow upload never holds the guide service
                if not GUIDE_SLOTS.acquire(timeout=seg_server.JOB_WAIT_S):
                    _job_drop(job)
                    raise HttpError(503, "guide service busy, try again")
                try:
                    _job_set(job, 0.0, "start")
                    out = build_guide(req, (lambda f, st: _job_set(job, f, st)) if job else None)
                except GUIDE_ERRORS:
                    # a request shape the validation let through: the client sees a short, generic answer, the log the details
                    traceback.print_exc()
                    raise HttpError(400, "bad guide request (fields missing or of the wrong type)")
                finally:
                    del req
                    _job_drop(job)
                    GUIDE_SLOTS.release()
                self._release_upload()
                return self._json(200, out)
            raise HttpError(404, f"not found: {path[:200]}")
        except HttpError as e:
            return self._error(e)
        except (TypeError, AttributeError, RecursionError, OverflowError):   # wrong JSON shapes in a request body
            traceback.print_exc()
            return self._error(HttpError(400, "bad request"))
        except Exception:  # keep the server alive, report the failure as JSON
            traceback.print_exc()   # the details stay in the server log, not in the response
            return self._error(HttpError(500, "internal error"))
        finally:
            self._release_upload()
            if path == "/guide":
                seg_server.release_memory()

    def health(self):
        code, body = super().health()
        ok, err = self.store.check() if self.store else (True, None)
        body["store"] = "ok" if ok else "error"
        if not ok:
            print(f"health: case store not writable: {err}", file=sys.stderr, flush=True)
            code = 503
        return code, body

    def _static(self, path):
        root = os.path.realpath(self.web_root)
        if path == "/config.js":     # tells the studio that this server is its case store and STL service
            body = ("window.YOLMED_SERVER = location.origin;\nwindow.YOLMED_VERSION = %s;\nwindow.YOLMED_AUTH = %s;\n"
                    % (json.dumps(VERSION), "true" if self.token else "false")).encode()
            ctype = "application/javascript; charset=utf-8"
        else:
            path = unquote(path)         # %2E, %20 ... : file names with spaces or dots; the root check below stays the guard
            if "\x00" in path:
                raise HttpError(404, "not found")
            f = os.path.realpath(os.path.join(root, (path.lstrip("/") or "index.html")))
            if os.path.isdir(f):
                f = os.path.join(f, "index.html")
            if not (f == root or f.startswith(root + os.sep)) or not os.path.isfile(f):
                raise HttpError(404, f"not found: {path[:200]}")
            with open(f, "rb") as fh:
                body = fh.read()
            ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
        self._send(200, body, ctype, (("Cache-Control", "no-cache"),))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return super().do_GET()
        if self.web_root and not (path.startswith("/cases") or path in ("/guide", "/guide/progress", "/segment")):
            try:
                return self._static(path)
            except HttpError as e:
                return self._error(e)
        return self._dispatch("GET")

    def do_POST(self):
        if urlparse(self.path).path == "/segment":
            return super().do_POST()
        return self._dispatch("POST")

    def do_PUT(self):
        return self._dispatch("PUT")


def make_server(host, port, db, backend="threshold", web=None, token=None, allow_origin=None):
    """token / allow_origin: None keeps the environment's YOLMED_TOKEN / YOLMED_ALLOWED_ORIGINS ("" switches them off)."""
    Handler.backend = backend
    Handler.store = CaseStore(db)
    Handler.web_root = web
    if token is not None:
        Handler.token = token or None
    if allow_origin is not None:
        Handler.allowed_origins = seg_server._origins(allow_origin)
    return seg_server.Server((host, port), Handler)


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
    print(f"yolmed service {VERSION} ({a.backend}, db={a.db}, token {'required' if Handler.token else 'off'}, "
          f"cross-origin {','.join(sorted(Handler.allowed_origins)) or 'off'}) on http://{a.host}:{a.port}", flush=True)
    if not Handler.token and a.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: YOLMED_TOKEN is not set: the case store and /guide, /segment are open to anyone who can reach this "
              "address", file=sys.stderr, flush=True)
    srv.serve_forever()
