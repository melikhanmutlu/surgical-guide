"""The real CT samples (web/sample_*_ct.json, made by tools/make_ct_sample.py) carry voxels only and no face.

- only the known keys are present (no DICOM tag such as name, ID, dates, UIDs or institution can ride along)
- the voxel data decodes to the stated size
- every voxel that is not air lies within 5 mm (+1 mm for quantisation) of bone, so no skin surface is left
- each file stays small enough to ship with the page
"""
import base64, glob, gzip, json, os, sys
import numpy as np
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
KEYS = {'name', 'dims', 'spacing', 'origin', 'axes', 'scale', 'offset', 'meta', 'note', 'data'}
META = {'modality', 'thickness', 'kernel', 'bits'}


def check(path):
    d = json.load(open(path))
    assert set(d) <= KEYS, f'{path}: unexpected keys {set(d) - KEYS}'
    assert set(d.get('meta', {})) <= META, f'{path}: unexpected meta {set(d["meta"]) - META}'
    nx, ny, nz = d['dims']
    q = np.frombuffer(gzip.decompress(base64.b64decode(d['data'])), np.uint8)
    assert q.size == nx * ny * nz, f'{path}: {q.size} voxels, expected {nx * ny * nz}'
    hu = q.reshape(nz, ny, nx).astype(np.int32) * d['scale'] + d['offset']
    sp = d['spacing']
    dist = ndimage.distance_transform_edt(hu < 240, sampling=(sp[2], sp[1], sp[0]))
    far = (hu > -1000) & (dist > 6.0)
    assert far.sum() == 0, f'{path}: {far.sum()} tissue voxels farther than 6 mm from bone'
    mb = os.path.getsize(path) / 1e6
    assert mb < 10, f'{path}: {mb:.1f} MB'
    print(f'ok {os.path.basename(path)} {d["dims"]} {mb:.1f} MB')


if __name__ == '__main__':
    files = sorted(glob.glob(os.path.join(ROOT, 'sample_*_ct.json')))
    assert len(files) >= 2, files
    for f in files: check(f)
