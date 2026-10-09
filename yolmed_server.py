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
  POST /guide {crop, mask_b64, frame, g, planes, screws, resolution?}
       -> {stl_b64, watertight, volume_mm3, faces, bodies, ms, ...}

The case store holds plan JSON only, never image data.
Research prototype. Not a medical device; every guide must be reviewed by a qualified team.
"""
import argparse
import base64
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
from urllib.parse import urlparse

import numpy as np
from scipy import ndimage as ndi

import seg_server  # /health and /segment are served by seg_server.Handler, unchanged

MAX_BODY = 512 * 1024 * 1024


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

    def _conn(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        return c

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
def _unit(a):
    a = np.asarray(a, float)
    n = np.linalg.norm(a)
    if not np.isfinite(n) or n < 1e-9:
        raise HttpError(400, "zero-length direction vector")
    return a / n


def _frame_to(z_axis, origin):
    """3x4 transform mapping local +z to z_axis, local origin to origin."""
    z = _unit(z_axis)
    a = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0])
    x = _unit(np.cross(a, z))
    y = np.cross(z, x)
    return np.column_stack([x, y, z, np.asarray(origin, float)])


def _cyl(m3d, start, axis, length, radius, segments):
    c = m3d.Manifold.cylinder(float(length), float(radius), float(radius), int(segments))
    return c.transform(_frame_to(axis, start))


def _segments(radius, tol=0.005):
    if radius <= tol:
        return 16
    n = math.ceil(math.pi / math.acos(1.0 - tol / radius))
    return int(min(max(n, 48), 256))


def _mc_manifold(m3d, field, lo, r, sl):
    """Marching-cubes the region field<0 of field[sl] (padded so the surface is closed) into a Manifold.
    Vertex coordinates are in the (uu, vv, nn) guide frame."""
    from skimage.measure import marching_cubes
    sub = np.pad(field[sl], 1, constant_values=1e3).astype(np.float32)
    sub[np.abs(sub) < 2e-3] = 2e-3        # values exactly at the level create coincident / non-manifold verts
    if sub.min() >= 0:
        return m3d.Manifold()
    verts, faces, _, _ = marching_cubes(sub, 0.0, spacing=(r, r, r), allow_degenerate=True)
    offs = np.array([lo[a] + (sl[a].start - 1) * r for a in range(3)])
    verts = (verts + offs).astype(np.float32)
    faces = faces.astype(np.uint32)
    man = m3d.Manifold(m3d.Mesh(np.ascontiguousarray(verts), np.ascontiguousarray(faces)))
    if man.status() != m3d.Error.NoError:
        raise HttpError(500, f"level-set mesh is not manifold: {man.status()}")
    if man.volume() < 0:      # skimage winding depends on gradient direction; Manifold wants outward CCW
        man = m3d.Manifold(m3d.Mesh(np.ascontiguousarray(verts), np.ascontiguousarray(faces[:, ::-1])))
    # collapse marching-cubes slivers (surfaces move < 5 um) so later booleans see no near-degenerate faces
    return man.simplify(0.005)


def _weld(verts, tris, eps=1e-4):
    """Collapse vertices closer than eps (sub-micron boolean slivers that would merge in a float32 STL
    anyway) and drop the faces that become degenerate."""
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


def build_guide(req):
    import manifold3d as m3d
    import trimesh

    t0 = time.perf_counter()
    T = {}
    crop, fr, g = req["crop"], req["frame"], req["g"]
    nx, ny, nz = int(crop["nx"]), int(crop["ny"]), int(crop["nz"])
    sp = np.asarray(crop["sp"], float)
    corg = np.asarray(crop["origin"], float)
    axes = np.asarray(crop["axes"], float).reshape(3, 3)       # rows: i, j, k unit vectors
    raw = base64.b64decode(req["mask_b64"])
    if len(raw) != nx * ny * nz:
        raise HttpError(400, f"mask has {len(raw)} bytes, expected nx*ny*nz = {nx * ny * nz}")
    mask = np.frombuffer(raw, np.uint8).reshape(nz, ny, nx) > 0
    r = float(req.get("resolution") or 0.2)
    if not (0.05 <= r <= 2.0):
        raise HttpError(400, "resolution must be within [0.05, 2] mm")

    L, W = float(g["L"]), float(g["W"])
    wrap, wall, clear = float(g["wrap"]), float(g["wall"]), float(g["clear"])
    bridge, side = float(g["bridge"]), (1.0 if float(g.get("side", 1)) >= 0 else -1.0)
    cw = clear + wall
    bridge_lo, bridge_hi = cw - 0.5, cw + 2.5

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
    T["fill"] = time.perf_counter() - t0

    # region to mesh (frame coords): guide box + every sleeve, plus a margin
    surf = filled & ~ndi.binary_erosion(filled)
    kk, jj, ii = np.nonzero(surf)
    A = (axes * sp[:, None]).T                          # columns: world step per i, j, k
    bone_f = (np.stack([ii, jj, kk], 1) @ A.T + corg - p) @ R
    inside = ((np.abs(bone_f[:, 0]) <= L / 2 + 1) & (np.abs(bone_f[:, 1]) <= W / 2 + 1)
              & (bone_f[:, 2] >= -wrap - 1))
    if not inside.any():
        raise HttpError(422, "no bone inside the guide footprint")
    top = bone_f[inside, 2].max() + bridge_hi + 1.0
    lo = np.array([-L / 2, -W / 2, -wrap]) - 2 * r
    hi = np.array([L / 2, W / 2, top]) + 2 * r
    screws = req.get("screws") or []
    for s in screws:
        dirn = _unit(s["dir"])
        e0, e1 = np.asarray(s["entry"], float) + dirn, np.asarray(s["entry"], float) - (cw + float(s["sleeveH"])) * dirn
        for e in (to_f(e0), to_f(e1)):
            lo = np.minimum(lo, e - float(s["D"]) / 2 - 2 * r)
            hi = np.maximum(hi, e + float(s["D"]) / 2 + 2 * r)
    # distances up to bridge_hi must see all bone around the meshed region
    pad = bridge_hi + 1.0
    # grid nodes are shifted by an irrational fraction of a voxel so marching-cubes vertices never lie
    # exactly on the (usually round-numbered) box / slot / sleeve faces -> no coincident vertices
    glo, ghi = lo - pad - r * 0.41421356, hi + pad
    shape = tuple(int(math.ceil(x)) + 1 for x in (ghi - glo) / r)
    if np.prod(shape) > 80e6:
        raise HttpError(422, f"guide grid too large ({shape}); increase resolution value")

    # resample the filled bone mask onto the frame-aligned isotropic grid (output index -> crop k, j, i)
    Ainv = np.linalg.inv(A)
    P = np.array([[0, 0, 1], [0, 1, 0], [1, 0, 0]], float)
    mat = P @ Ainv @ R * r
    off = P @ Ainv @ (p - corg + R @ glo)
    # light smoothing of the voxel mask (sigma = half a crop voxel) removes most of the staircase
    soft = ndi.gaussian_filter(filled.astype(np.float32), 0.5)
    bone = ndi.affine_transform(soft, mat, off, output_shape=shape,
                                order=1, cval=0.0, prefilter=False) >= 0.5
    T["resample"] = time.perf_counter() - t0

    # unsigned distance from the bone surface outside the bone (-r/2 inside), lightly smoothed
    d = ndi.distance_transform_edt(~bone, sampling=r).astype(np.float32)
    d -= r / 2
    d[bone] = -r / 2
    d = ndi.gaussian_filter(d, 0.6)
    T["edt"] = time.perf_counter() - t0

    i0 = np.floor((lo - glo) / r).astype(int)
    i1 = np.ceil((hi - glo) / r).astype(int) + 1
    i0 = np.maximum(i0, 0)
    i1 = np.minimum(i1, shape)
    sl = tuple(slice(a, b) for a, b in zip(i0, i1))

    f_shell = np.maximum(clear - d, d - cw)              # < 0 inside the shell band
    shell = _mc_manifold(m3d, f_shell, glo, r, sl)
    del f_shell
    f_bridge = np.maximum(bridge_lo - d, d - bridge_hi)
    bridge_band = _mc_manifold(m3d, f_bridge, glo, r, sl)
    del f_bridge
    keep_out = _mc_manifold(m3d, d - clear, glo, r, sl) if screws else None   # bone + clearance
    T["mc"] = time.perf_counter() - t0

    BIG = float(np.linalg.norm(ghi - glo)) * 2 + 50
    zhi = hi[2] + 10
    # every limit in uu / vv / nn is applied by ONE final box intersection, so no coplanar faces meet
    box = m3d.Manifold.cube((L, W, zhi + wrap)).translate((-L / 2, -W / 2, -wrap))
    v0 = W / 2 - bridge if side > 0 else -W / 2 - BIG
    vslab = m3d.Manifold.cube((BIG, bridge + BIG, BIG)).translate((-BIG / 2, v0, -BIG / 2))

    # slots: thin slabs, cut from the shell only (the bridge keeps the guide in one piece)
    slabs = []
    for pl in req.get("planes") or []:
        Nf = R.T @ _unit(pl["N"])
        w = float(pl["w"])
        slab = m3d.Manifold.cube((BIG, BIG, w), center=True).transform(_frame_to(Nf, to_f(pl["p"])))
        slabs.append(slab)
    if slabs:
        shell = shell - m3d.Manifold.batch_boolean(slabs, m3d.OpType.Add)
    body = (shell + (bridge_band ^ vslab)) ^ box

    parts = [body]
    holes = []
    for s in screws:
        dirf = R.T @ _unit(s["dir"])
        ef = to_f(s["entry"])
        D, dd, sH = float(s["D"]), float(s["d"]), float(s["sleeveH"])
        seg = _segments(D / 2)
        sleeve = _cyl(m3d, ef + dirf * 1.0, -dirf, 1.0 + cw + sH, D / 2, seg)
        parts.append(sleeve - keep_out)
        segd = _segments(dd / 2)
        rc = dd / 2 / math.cos(math.pi / segd)          # circumscribed polygon: hole is never under-size
        holes.append(_cyl(m3d, ef + dirf * BIG / 2, -dirf, BIG, rc, segd))
    guide = m3d.Manifold.batch_boolean(parts, m3d.OpType.Add)
    if holes:
        guide = guide - m3d.Manifold.batch_boolean(holes, m3d.OpType.Add)
    T["boolean"] = time.perf_counter() - t0

    # drop marching-cubes specks and slivers left between close slots (< 1 mm^3 or < 1 % of the main body,
    # the same rule the browser preview uses); everything else is kept and counted
    comps = guide.decompose()
    big = max((c.volume() for c in comps), default=0.0)
    keep = [c for c in comps if c.volume() >= max(1.0, 0.01 * big)]
    dropped = len(comps) - len(keep)
    if dropped and keep:
        guide = m3d.Manifold.batch_boolean(keep, m3d.OpType.Add)
    guide = guide.simplify(0.01)                         # merge co-planar / near-flat triangles (<= 10 um)
    guide = guide.transform(np.column_stack([R, p]))     # frame -> world (LPS, mm)
    mesh = guide.to_mesh64() if hasattr(guide, "to_mesh64") else guide.to_mesh()
    verts = np.asarray(mesh.vert_properties)[:, :3]
    tris = np.asarray(mesh.tri_verts)
    verts, tris, welded = _weld(verts, tris)
    buf = io.BytesIO()
    trimesh.Trimesh(verts, tris, process=False).export(buf, file_type="stl")
    # validate what the client actually gets: the float32 STL, vertices merged by exact position
    tm = trimesh.load(io.BytesIO(buf.getvalue()), file_type="stl")
    edges_ok = bool(len(tris)) and np.all(np.unique(tm.edges_sorted, axis=0, return_counts=True)[1] == 2)
    watertight = bool(tm.is_watertight and tm.is_winding_consistent and edges_ok and tm.volume > 0)
    bodies = int(tm.body_count) if len(tris) else 0
    T["export"] = time.perf_counter() - t0
    return {
        "stl_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "watertight": watertight,
        "volume_mm3": float(tm.volume),
        "faces": int(len(tm.faces)),
        "bodies": bodies,
        "ms": int(round((time.perf_counter() - t0) * 1000)),
        "dropped_fragments": dropped,
        "welded_vertices": int(welded),
        "grid": list(shape),
        "stage_ms": {k: int(round(v * 1000)) for k, v in T.items()},
    }


# --------------------------------------------------------------------------------------------- HTTP
CASE_RE = re.compile(r"^/cases/([A-Za-z0-9_-]+)(/draft|/versions(?:/(\d+))?)?/?$")


class Handler(seg_server.Handler):
    store = None

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-Structures")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise HttpError(413, "request too large")
        try:
            obj = json.loads(self.rfile.read(n) or b"null")
        except ValueError as e:
            raise HttpError(400, f"invalid JSON: {e}")
        if not isinstance(obj, dict):
            raise HttpError(400, "JSON object expected")
        return obj

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
                    return self._json(200, {"id": st.create_case(name, b.get("kind"), b.get("fingerprint"))})
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
                    return self._json(200, {"n": st.add_version(cid, b["plan"], b.get("note"), b.get("author"))})
                if vn is not None and method == "GET":
                    return self._json(200, st.get_version(cid, int(vn)))
                raise HttpError(405, "method not allowed")
            if path == "/guide" and method == "POST":
                b = self._body()
                try:
                    return self._json(200, build_guide(b))
                except (KeyError, TypeError, ValueError, IndexError) as e:
                    raise HttpError(400, f"bad guide request: {type(e).__name__}: {e}")
            raise HttpError(404, f"not found: {path}")
        except HttpError as e:
            return self._json(e.code, {"error": e.msg})
        except Exception as e:  # keep the server alive, report the failure as JSON
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    web_root = None   # optional: serve the studio (web/) from the same origin

    def _static(self, path):
        root = os.path.realpath(self.web_root)
        if path == "/config.js":     # tells the studio that this server is its case store and STL service
            body = b"window.YOLMED_SERVER = location.origin;\n"
            ctype = "application/javascript"
        else:
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
        self.send_header("Cache-Control", "no-cache")
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
