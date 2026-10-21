"""Turn an anonymised CT series into a studio sample (web/sample_<name>.json).

Only the voxels go out: no DICOM tag (name, ID, dates, UIDs, institution) is copied. The face is removed by keeping
tissue only within MARGIN mm of bone; everything farther out (skin, lips, nose) becomes air, so no face surface can
be rebuilt from the sample. The volume is cropped to a box (index ranges after sorting the slices) and stored the way
the synthetic samples are: uint8 = (HU + 1024) / 16, gzip, base64.

  python3 -I tools/make_ct_sample.py <series dir> <series description> <out.json> --crop x0:x1,y0:y1,z0:z1 [--step 1,1,1]
"""
import argparse, base64, gzip, json, os, sys
import numpy as np
import pydicom
from scipy import ndimage

SCALE, OFFSET, BONE_HU, MARGIN = 16, -1024, 250, 5.0


def read_series(root, desc):
    sl = []
    for dp, _, fs in os.walk(root):
        for f in fs:
            try: d = pydicom.dcmread(os.path.join(dp, f), stop_before_pixels=True)
            except Exception: continue
            if str(d.get('SeriesDescription', '')).strip() == desc and 'ImagePositionPatient' in d: sl.append(os.path.join(dp, f))
    if not sl: sys.exit(f'no slices for series {desc!r}')
    ds = [pydicom.dcmread(p) for p in sl]
    iop = np.array(ds[0].ImageOrientationPatient, float); r, c = iop[:3], iop[3:]; n = np.cross(r, c)
    ds.sort(key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, float), n)))
    pos = np.array([np.dot(np.array(d.ImagePositionPatient, float), n) for d in ds])
    dz = float(np.median(np.diff(pos)))
    hu = np.stack([d.pixel_array.astype(np.float32) * float(d.get('RescaleSlope', 1)) + float(d.get('RescaleIntercept', 0)) for d in ds])
    ps = [float(v) for v in ds[0].PixelSpacing]   # row spacing, column spacing
    d0 = ds[0]
    meta = {'modality': 'CT', 'thickness': float(d0.get('SliceThickness', dz) or dz), 'kernel': str(d0.get('ConvolutionKernel', '') or '').strip(), 'bits': 16}
    # hu[z, y(row), x(col)]; the studio indexes x (col) fastest, then y (row), then z
    return np.clip(hu, -1024, 3056), [ps[1], ps[0], dz], np.array(d0.ImagePositionPatient, float), [r, c, n], meta


def main():
    a = argparse.ArgumentParser(); a.add_argument('dir'); a.add_argument('desc'); a.add_argument('out')
    a.add_argument('--crop', required=True); a.add_argument('--step', default='1,1,1'); a.add_argument('--name', required=True)
    o = a.parse_args()
    hu, sp, org, ax, meta = read_series(o.dir, o.desc)
    (x0, x1), (y0, y1), (z0, z1) = [[int(v) for v in s.split(':')] for s in o.crop.split(',')]
    sx, sy, sz = [int(v) for v in o.step.split(',')]
    v = hu[z0:z1:sz, y0:y1:sy, x0:x1:sx]
    sp = [sp[0] * sx, sp[1] * sy, sp[2] * sz]
    org = org + ax[0] * x0 * (sp[0] / sx) + ax[1] * y0 * (sp[1] / sy) + ax[2] * z0 * (sp[2] / sz)
    # deface: tissue more than MARGIN mm from bone becomes air
    bone = v >= BONE_HU
    far = ndimage.distance_transform_edt(~bone, sampling=(sp[2], sp[1], sp[0])) > MARGIN
    v = v.copy(); v[far] = -1024
    q = np.clip(np.round((v - OFFSET) / SCALE), 0, 255).astype(np.uint8)
    nz, ny, nx = q.shape
    data = base64.b64encode(gzip.compress(q.tobytes(), 9, mtime=0)).decode()
    out = {'name': o.name, 'dims': [nx, ny, nz], 'spacing': [round(s, 5) for s in sp], 'origin': [round(float(t), 3) for t in org],
           'axes': [[round(float(t), 6) for t in x] for x in ax], 'scale': SCALE, 'offset': OFFSET, 'meta': meta,
           'note': 'Anonymised real CT, cropped to bone, face removed (tissue > 5 mm from bone set to air). Research use only.', 'data': data}
    with open(o.out, 'w') as f: json.dump(out, f, separators=(',', ':'))
    print(o.out, [nx, ny, nz], sp, f'{os.path.getsize(o.out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
