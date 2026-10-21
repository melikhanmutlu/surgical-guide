"""Synthetic CT phantoms (mandible, lower leg) so the pipeline can be tested without patient data."""
import numpy as np
from .volume import Volume

AIR, SOFT, CORTICAL, CANCELLOUS = -1000.0, 40.0, 1400.0, 350.0


def _grid(shape, spacing, origin):
    nz, ny, nx = shape
    z, y, x = np.meshgrid(*(origin[i] + spacing[i] * np.arange(n) for i, n in ((2, nz), (1, ny), (0, nx))),
                          indexing="ij")
    return x, y, z


def _sweep(arr, x, y, z, path, cortex=2.0):
    """Paint an elliptical tube along path = [(p, t, n, a, b)] into arr (HU)."""
    origin = np.array([x[0, 0, 0], y[0, 0, 0], z[0, 0, 0]])
    spacing = np.array([x[0, 0, 1] - x[0, 0, 0], y[0, 1, 0] - y[0, 0, 0], z[1, 0, 0] - z[0, 0, 0]])
    for p, t, n, a, b in path:
        w = np.cross(t, n)
        r = max(a, b) + 1.5
        lo = np.maximum(np.floor((p - r - origin) / spacing).astype(int), 0)
        hi = np.ceil((p + r - origin) / spacing).astype(int) + 1
        sl = (slice(lo[2], hi[2]), slice(lo[1], hi[1]), slice(lo[0], hi[0]))
        d = np.stack([x[sl], y[sl], z[sl]], -1) - p
        sub = arr[sl]
        dt, dn, dw = d @ t, d @ n, d @ w
        slab = np.abs(dt) <= 0.6
        outer = slab & ((dn / a) ** 2 + (dw / b) ** 2 <= 1)
        inner = slab & ((dn / (a - cortex)) ** 2 + (dw / (b - cortex)) ** 2 <= 1)
        sub[outer & (sub < CANCELLOUS)] = CORTICAL
        sub[inner] = CANCELLOUS


def mandible_phantom(spacing=(0.6, 0.6, 0.6), seed=0):
    """U-shaped mandible (body + rami) in LPS: +x patient left, +y posterior, +z superior."""
    origin = np.array([-60.0, -50.0, -25.0])
    shape = (int(75 / spacing[2]), int(95 / spacing[1]), int(120 / spacing[0]))
    x, y, z = _grid(shape, spacing, origin)
    arr = np.full(shape, AIR, np.float32)
    arr[((x / 58) ** 2 + ((y + 5) / 48) ** 2) <= 1] = SOFT          # head/neck soft tissue
    up = np.array([0.0, 0.0, 1.0])
    path = []
    k = 0.0145
    for xs in np.arange(-46, 46.01, 0.8):                          # body: y = -38 + k x^2
        p = np.array([xs, -38 + k * xs ** 2, 0.0])
        t = np.array([1.0, 2 * k * xs, 0.0]); t /= np.linalg.norm(t)
        n = np.cross(up, t)
        path.append((p, t, n, 5.5, 12.0))
    for side in (-1, 1):                                           # rami: rise up and back
        base = np.array([side * 46, -38 + k * 46 ** 2, 0.0])
        t = np.array([0.0, 0.35, 1.0]); t /= np.linalg.norm(t)
        for s in np.arange(0, 42, 0.8):
            path.append((base + s * t, t, np.array([1.0, 0, 0]), 4.0, 14.0))
    _sweep(arr, x, y, z, path)
    # small distractor (hyoid) so the segmenter must pick the right component
    arr[((x / 12) ** 2 + ((y + 15) / 4) ** 2 + ((z + 20) / 3) ** 2) <= 1] = CORTICAL
    rng = np.random.default_rng(seed)
    arr += rng.normal(0, 25, arr.shape).astype(np.float32)
    return Volume(arr, spacing, origin)


def leg_phantom(spacing=(0.7, 0.7, 0.8), seed=1):
    """Right lower leg: tibia + slightly tilted fibula, 320 mm long; the fibula lateral to the tibia (patient right = -x in
    LPS), as on a real right leg."""
    origin = np.array([-55.0, -45.0, 0.0])
    shape = (int(320 / spacing[2]), int(90 / spacing[1]), int(110 / spacing[0]))
    x, y, z = _grid(shape, spacing, origin)
    arr = np.full(shape, AIR, np.float32)
    arr[((x / 52) ** 2 + (y / 43) ** 2) <= 1] = SOFT
    path_t, path_f = [], []
    for zs in np.arange(5, 315, 0.8):
        path_t.append((np.array([12.0, -8.0, zs]), np.array([0, 0, 1.0]), np.array([1.0, 0, 0]), 13.0, 11.0))
        ft = np.array([-0.04, 0.02, 1.0]); ft /= np.linalg.norm(ft)
        r = 7.0 + 1.5 * np.sin(zs / 320 * np.pi)                    # slightly thicker mid-shaft
        path_f.append((np.array([-20.0, 6.0, 0.0]) + (zs - 160) * ft + np.array([0, 0, 160]),
                       ft, np.array([1.0, 0, 0]), r, r * 0.85))
    _sweep(arr, x, y, z, path_t, cortex=3.0)
    _sweep(arr, x, y, z, path_f, cortex=2.0)
    rng = np.random.default_rng(seed)
    arr += rng.normal(0, 25, arr.shape).astype(np.float32)
    return Volume(arr, spacing, origin)


# ---------- ankle (malleolar fracture) ----------
def _rot(axis, deg):
    """Rotation matrix about a unit axis (Rodrigues)."""
    a = np.asarray(axis, float); a /= np.linalg.norm(a)
    t = np.radians(deg); K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * K @ K


# The displaced fragments of the ankle phantom: name, the side of a plane (point, normal; the fragment is where
# (p - point) . normal > 0) inside one bone, and the rigid displacement applied to it about its own centre
# (rotation axis, degrees, then translation in mm). Positions in LPS mm of a right ankle (medial = +x).
ANKLE_FRACTURES = [
    # Weber B: oblique lateral malleolus fracture at the syndesmosis, anteroinferior to posterosuperior; the distal
    # fragment slid proximally along the fracture (shortening), displaced laterally and turned externally
    dict(name="Lateral malleol", bone="fibula", point=(-24.0, 7.0, 46.0), normal=(0.0, 0.7, -1.0),
         axis=(0, 0, 1), deg=-8.0, move=(-1.5, 3.0, 0.2)),
    # transverse medial malleolus fracture at the level of the plafond, the tip tilted and pulled distally
    dict(name="Medial malleol", bone="tibia", point=(19.0, 0.0, 40.5), normal=(0.25, 0.0, -1.0),
         axis=(0, 1, 0), deg=12.0, move=(2.5, 0.0, -2.5)),
    # posterior malleolus: the posterior lip of the plafond, displaced posteriorly and proximally
    dict(name="Posterior malleol", bone="tibia", point=(0.0, 12.0, 44.0), normal=(0.0, 1.0, -0.35),
         axis=(1, 0, 0), deg=-6.0, move=(0.0, 1.8, 2.2)),
]


def _ankle_bones(p):
    """Value of each intact bone at points p (N, 3): dict name -> (inside, cortical) boolean arrays."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    out = {}
    # tibia: shaft (a 13, b 11) flaring to the metaphysis (a 20, b 19) at the plafond; the plafond arches up in the
    # sagittal plane (the talar dome sits 3 mm below it)
    zb = 41.0 + 3.0 * np.clip(1 - (y / 20.0) ** 2, 0, 1)
    s = np.clip((z - 41.0) / 34.0, 0, 1); s = s * s * (3 - 2 * s)
    a, b = 20.0 + (13.0 - 20.0) * s, 19.0 + (11.0 - 19.0) * s
    r = np.sqrt(((x - 8.0) / a) ** 2 + (y / b) ** 2)
    shaft = (r <= 1) & (z >= zb)
    # medial malleolus: a rounded block hanging from the medial plafond
    m = ((np.abs(x - 25.0) / 6.0) ** 2.5 + (np.abs(y + 1.0) / 9.0) ** 2.5 + (np.abs(z - 36.0) / 12.0) ** 2.5) <= 1
    med = m & (z <= 46.0) & (x >= 19.0)
    tib = shaft | med
    cort_t = tib & ((r > 1 - 2.2 / np.minimum(a, b)) | (z < zb + 1.8) | (med & ~shaft & (((np.abs(x - 25.0) / 4.4) ** 2.5 + (np.abs(y + 1.0) / 7.4) ** 2.5 + (np.abs(z - 36.0) / 10.4) ** 2.5) > 1)))
    out["tibia"] = (tib, cort_t)
    # fibula: shaft radius 7, the lateral malleolus widening to 9.5 and ending in a rounded tip at z = 15
    t = np.clip((65.0 - z) / 30.0, 0, 1); t = t * t * (3 - 2 * t)
    rf = 7.0 + 2.5 * t
    cx, cy = -24.0 - 1.0 * t, 6.0 + 2.0 * t
    rr = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    tip = np.where(z < 30.0, np.sqrt(np.clip(1 - ((30.0 - z) / 15.0) ** 2, 0, 1)), 1.0)
    fib = (rr <= rf * tip) & (z >= 15.0)
    out["fibula"] = (fib, fib & ((rr > rf * tip - 1.8) | (z < 16.5)))
    # talus: a body under the dome (3 mm joint space), medial and lateral gutters 3.5 mm wide
    zt = zb - 3.0
    e = ((np.abs(x - 1.5) / 13.5) ** 3 + (np.abs(y - 1.0) / 23.0) ** 3 + (np.abs(z - 26.0) / 16.0) ** 3) <= 1
    tal = e & (z <= zt)
    ei = ((np.abs(x - 1.5) / 11.5) ** 3 + (np.abs(y - 1.0) / 21.0) ** 3 + (np.abs(z - 26.0) / 14.0) ** 3) <= 1
    out["talus"] = (tal, tal & (~ei | (z > zt - 1.8)))
    return out


def ankle_phantom(spacing=(0.7, 0.7, 0.8), seed=2, displaced=True, gap=1.0):
    """Right ankle with a trimalleolar fracture (ANKLE_FRACTURES): distal tibia with the medial and posterior malleolus
    fragments, distal fibula with the lateral malleolus fragment, talus. Each fracture leaves a `gap` mm band of soft
    tissue so the fragments are separate bones at a bone threshold. displaced=False keeps the fragments in place
    (the reduction target). Returns (Volume, truth) where truth lists each fragment's centre and displacement."""
    origin = np.array([-45.0, -35.0, 5.0])
    shape = (int(105 / spacing[2]), int(75 / spacing[1]), int(90 / spacing[0]))
    x, y, z = _grid(shape, spacing, origin)
    P = np.stack([x.ravel(), y.ravel(), z.ravel()], -1)
    arr = np.full(P.shape[0], AIR, np.float32)
    arr[((P[:, 0] / 42.0) ** 2 + ((P[:, 1] - 3.0) / 34.0) ** 2) <= 1] = SOFT

    def frag_side(q, f):
        n = np.asarray(f["normal"], float); n /= np.linalg.norm(n)
        return (q - np.asarray(f["point"], float)) @ n

    def paint(q, mask_fn, bones):
        """HU of the intact anatomy at q, restricted to where mask_fn(bone, inside, q) is true."""
        hu = np.full(q.shape[0], np.nan, np.float32)
        for name, (inside, cort) in bones.items():
            sel = inside & mask_fn(name, q)
            hu[sel] = np.where(cort[sel], CORTICAL, CANCELLOUS)
        return hu

    # the intact bones minus every fragment (and minus the fracture band)
    bones = _ankle_bones(P)
    def keep_main(name, q):
        ok = np.ones(q.shape[0], bool)
        for f in ANKLE_FRACTURES:
            if f["bone"] == name:
                ok &= frag_side(q, f) < -gap / 2
        return ok
    hu = paint(P, keep_main, bones)
    truth = []
    for i, f in enumerate(ANKLE_FRACTURES):
        # the fragment's own region: its side of its plane, not inside a fragment listed before it
        def in_frag(name, q, f=f, i=i):
            if name != f["bone"]:
                return np.zeros(q.shape[0], bool)
            ok = frag_side(q, f) > gap / 2
            for g in ANKLE_FRACTURES[:i]:
                if g["bone"] == name:
                    ok &= frag_side(q, g) < -gap / 2
            return ok
        # the fragment's centre (in place), from the intact bone on a coarse sample of the grid
        Pc = P[::7]
        bc = _ankle_bones(Pc)
        sel = bc[f["bone"]][0] & in_frag(f["bone"], Pc)
        c = Pc[sel].mean(0)
        R = _rot(f["axis"], f["deg"]) if displaced else np.eye(3)
        tv = np.asarray(f["move"], float) if displaced else np.zeros(3)
        # p = R (q - c) + c + t  ->  q = R^T (p - c - t) + c
        Q = (P - c - tv) @ R + c
        hf = paint(Q, in_frag, _ankle_bones(Q))
        put = ~np.isnan(hf)
        hu[put] = np.where(np.isnan(hu[put]), hf[put], np.maximum(hu[put], hf[put]))
        truth.append(dict(name=f["name"], centre=[round(float(v), 2) for v in c], rot_axis=list(map(float, f["axis"])),
                          rot_deg=float(f["deg"]) if displaced else 0.0, move=[float(v) for v in tv]))
    bone = ~np.isnan(hu)
    arr[bone] = hu[bone]
    arr = arr.reshape(shape)
    rng = np.random.default_rng(seed)
    arr += rng.normal(0, 25, arr.shape).astype(np.float32)
    return Volume(arr, spacing, origin), truth
