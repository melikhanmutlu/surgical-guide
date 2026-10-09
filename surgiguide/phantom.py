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
    """Right lower leg: tibia + slightly tilted fibula, 320 mm long."""
    origin = np.array([-55.0, -45.0, 0.0])
    shape = (int(320 / spacing[2]), int(90 / spacing[1]), int(110 / spacing[0]))
    x, y, z = _grid(shape, spacing, origin)
    arr = np.full(shape, AIR, np.float32)
    arr[((x / 52) ** 2 + (y / 43) ** 2) <= 1] = SOFT
    path_t, path_f = [], []
    for zs in np.arange(5, 315, 0.8):
        path_t.append((np.array([-12.0, -8.0, zs]), np.array([0, 0, 1.0]), np.array([1.0, 0, 0]), 13.0, 11.0))
        ft = np.array([0.04, 0.02, 1.0]); ft /= np.linalg.norm(ft)
        r = 7.0 + 1.5 * np.sin(zs / 320 * np.pi)                    # slightly thicker mid-shaft
        path_f.append((np.array([20.0, 6.0, 0.0]) + (zs - 160) * ft + np.array([0, 0, 160]),
                       ft, np.array([1.0, 0, 0]), r, r * 0.85))
    _sweep(arr, x, y, z, path_t, cortex=3.0)
    _sweep(arr, x, y, z, path_f, cortex=2.0)
    rng = np.random.default_rng(seed)
    arr += rng.normal(0, 25, arr.shape).astype(np.float32)
    return Volume(arr, spacing, origin)
