"""Synthetic CT of both ankles (plan M3 test fixture, not patient data): the right ankle with the trimalleolar fracture
of surgiguide.phantom.ankle_phantom (displaced), the left ankle intact (gap 0) as its mirror image across the sagittal
plane x = X, with ~10 mm of air between the legs. Written as a studio sample JSON (web/sample_*.json format).

    python3 tools/make_ankle_bilateral.py OUT.json        prints the mirror plane X (mm)
"""
import base64
import gzip
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit('/tools/', 1)[0])
from surgiguide.phantom import ankle_phantom  # noqa: E402

SCALE, OFFSET, GAPVOX = 16, -1024, 14


def main(out):
    right, truth = ankle_phantom(displaced=True, gap=1.0)
    left, _ = ankle_phantom(displaced=False, gap=0.0, seed=5)
    a, b = right.array, left.array[:, :, ::-1]
    nz, ny, nx = a.shape
    air = np.full((nz, ny, GAPVOX), -1000.0, np.float32)
    arr = np.concatenate([a, air, b], axis=2)
    sx = float(right.spacing[0])
    x0 = float(right.origin[0])
    # voxel i of the left block: world x0 + sx (nx + G + i), original x0 + sx (nx - 1 - i); their mean is the plane
    X = (2 * x0 + sx * (2 * nx - 1 + GAPVOX)) / 2
    q = np.clip(np.round((arr - OFFSET) / SCALE), 0, 255).astype(np.uint8)
    d = {'name': 'ankle_bilateral', 'dims': [arr.shape[2], arr.shape[1], arr.shape[0]], 'spacing': [float(v) for v in right.spacing],
         'origin': [float(v) for v in right.origin], 'scale': SCALE, 'offset': OFFSET,
         'note': 'Sentetik iki ayak bileği (sağ kırık, sol sağlam ayna); hasta verisi değil. tools/make_ankle_bilateral.py',
         'truth': truth, 'mirror_x': X,
         'data': base64.b64encode(gzip.compress(q.tobytes(), 6)).decode()}
    with open(out, 'w') as f:
        json.dump(d, f)
    print(X)


if __name__ == '__main__':
    main(sys.argv[1])
