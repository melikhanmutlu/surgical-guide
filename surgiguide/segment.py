"""Bone segmentation backends.

threshold : classical HU threshold + morphology + connected component selection (no dependencies,
            works on clean CT; struggles with osteopenia, contrast-filled vessels, metal artefacts).
totalseg  : AI segmentation with TotalSegmentator (nnU-Net). Optional dependency; see README.
"""
import os
import subprocess
import tempfile
import numpy as np
from scipy import ndimage as ndi

from . import bones


def _threshold_labels(vol, hu, close_mm):
    """HU threshold + closing, then 6-connected components: (labels, n)."""
    mask = vol.array > hu
    r = max(1, int(round(close_mm / vol.spacing.min())))
    mask = ndi.binary_closing(mask, ndi.generate_binary_structure(3, 1), iterations=r)
    return ndi.label(mask)


def _fill_cavity(out):
    """Fill the medullary cavity slice by slice, then in 3D."""
    out = ndi.binary_fill_holes(out)
    for k in range(out.shape[0]):
        out[k] = ndi.binary_fill_holes(out[k])
    return out


def threshold_bone(vol, hu=250.0, component=1, seed=None, close_mm=1.5):
    """Return a boolean mask (z, y, x).

    component: rank of the connected component by volume (1 = largest, 2 = second largest...).
    seed: physical point (x, y, z) mm; if given, the component containing / nearest to it is used.
    """
    lab, n = _threshold_labels(vol, hu, close_mm)
    mask = lab > 0
    if n == 0:
        raise RuntimeError("no voxels above threshold")
    if seed is not None:
        ijk = np.round(vol.physical_to_index(seed)).astype(int)[::-1]
        ijk = np.clip(ijk, 0, np.array(mask.shape) - 1)
        keep = lab[tuple(ijk)]
        if keep == 0:  # nearest labelled voxel
            idx = ndi.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
            keep = lab[tuple(idx[:, ijk[0], ijk[1], ijk[2]])]
    else:
        sizes = ndi.sum(mask, lab, range(1, n + 1))
        keep = int(np.argsort(sizes)[::-1][component - 1]) + 1
    return _fill_cavity(lab == keep)


WORK_MM = 0.8                    # working grid of the bone choice, as in the browser (G.reduce)
WORK_MAX_VOX = 60e6


class Work:
    """The working grid the bone is chosen on: the CT block-averaged to ~0.8 mm voxels, or resampled to an even coarser grid when
    that would still be more than 60 M voxels (a thin-slice leg scan). Same rule as the browser's G.reduce, so both pick the same
    bone. A working voxel j covers native indices around (j + 0.5) F - 0.5 on each axis (F: native voxels per working voxel)."""

    def __init__(self, vol, target=WORK_MM, max_vox=WORK_MAX_VOX):
        a = vol.array
        nz, ny, nx = a.shape
        sx, sy, sz = (float(v) for v in vol.spacing)
        f = [max(1, int(np.floor(target / s + 0.5))) for s in (sz, sy, sx)]
        n = [nz // f[0], ny // f[1], nx // f[2]]
        if n[0] * n[1] * n[2] > max_vox:                             # trilinear to an even spacing that fits
            t = np.cbrt(nx * sx * ny * sy * nz * sz / max_vox) * 1.01
            self.F = [max(1.0, t / s) for s in (sz, sy, sx)]
            n = [int(np.floor(N / F)) for N, F in zip((nz, ny, nx), self.F)]
            r = a
            for ax in range(3):
                r = _lerp_axis(r, ax, n[ax], self.F[ax])
        else:
            self.F = [float(v) for v in f]
            r = a[:n[0] * f[0], :n[1] * f[1], :n[2] * f[2]].reshape(n[0], f[0], n[1], f[1], n[2], f[2]).mean(axis=(1, 3, 5), dtype=np.float32)
        self.array = r.astype(np.int16)                              # the browser keeps Int16 too
        self.spacing = (sx * self.F[2], sy * self.F[1], sz * self.F[0])
        self.vol = vol

    def world(self, idx):
        """working-grid index (n, 3) (x, y, z; may be fractional) -> patient mm."""
        nat = (np.asarray(idx, float) + 0.5) * [self.F[2], self.F[1], self.F[0]] - 0.5
        return self.vol.index_to_physical(nat)

    def labels(self, hu, min_size=200):
        """6-connected components above `hu`: (label array, [(label, size)] largest first, only those of >= min_size voxels)."""
        lab, n = ndi.label(self.array > hu)
        if n == 0:
            raise RuntimeError("no voxels above threshold")
        sizes = np.bincount(lab.ravel(), minlength=n + 1)[1:]
        order = [int(i) + 1 for i in np.argsort(-sizes, kind="stable") if sizes[i] >= min_size]
        return lab, [(i, int(sizes[i - 1])) for i in order]

    def crops(self, lab, wanted):
        """[(mask crop, origin index (z, y, x), slices)] of the components `wanted` (labels)."""
        objs = ndi.find_objects(lab)
        out = []
        for l in wanted:
            sl = objs[l - 1]
            out.append((lab[sl] == l, tuple(s.start for s in sl), sl))
        return out

    def lift(self, piece, origin, hu, close_mm=1.5):
        """Native-grid mask (z, y, x of the volume) of a piece chosen on the working grid: the native bone voxels whose nearest
        working-grid bone voxel belongs to the piece (so a piece keeps the edge the block average lost, and no voxel of the
        neighbouring bone), closed by close_mm, the largest part, cavity filled."""
        vol, a = self.vol, self.vol.array
        shp = self.array.shape
        lo = [max(0, o - 3) for o in origin]
        hi = [min(n, o + s + 3) for n, o, s in zip(shp, origin, piece.shape)]
        sl = tuple(slice(l, h) for l, h in zip(lo, hi))
        occ = self.array[sl] > hu
        chosen = np.zeros(occ.shape, bool)
        chosen[tuple(slice(o - l, o - l + s) for o, l, s in zip(origin, lo, piece.shape))] = piece
        occ |= chosen
        d, idx = ndi.distance_transform_edt(~occ, return_indices=True)
        own = chosen[tuple(idx)] & (d <= 2.5)
        nat = []
        for ax in range(3):                                           # native index range whose working voxel lies in [lo, hi)
            N, F = a.shape[ax], self.F[ax]
            j = np.clip(np.floor((np.arange(N) + 0.5) / F).astype(int), 0, shp[ax] - 1)
            k = np.nonzero((j >= lo[ax]) & (j < hi[ax]))[0]
            nat.append((k, j[k] - lo[ax]))
        (kz, jz), (ky, jy), (kx, jx) = nat
        box = (slice(kz[0], kz[-1] + 1), slice(ky[0], ky[-1] + 1), slice(kx[0], kx[-1] + 1))
        m = (a[box] > hu) & own[np.ix_(jz, jy, jx)]
        r = max(1, int(round(close_mm / vol.spacing.min())))
        m = ndi.binary_closing(np.pad(m, r + 1), ndi.generate_binary_structure(3, 1), iterations=r)[(slice(r + 1, -r - 1),) * 3]
        lab, n = ndi.label(m)
        if n > 1:
            m = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
        m = _fill_cavity(m)
        out = np.zeros(a.shape, bool)
        out[box] = m
        return out


def _lerp_axis(a, axis, n_out, F):
    """Linear interpolation along one axis to n_out samples at (i + 0.5) F - 0.5 (web/geom.js resample, one axis at a time)."""
    N = a.shape[axis]
    x = np.clip((np.arange(n_out) + 0.5) * F - 0.5, 0, N - 1)
    i0 = np.maximum(0, np.minimum(N - 2, np.floor(x).astype(int))) if N > 1 else np.zeros(n_out, int)
    w = (x - i0) if N > 1 else np.zeros(n_out)
    i1 = np.minimum(N - 1, i0 + 1)
    shape = [1, 1, 1]
    shape[axis] = n_out
    w = w.reshape(shape).astype(np.float32)
    lo = np.take(a, i0, axis=axis).astype(np.float32)
    hi = np.take(a, i1, axis=axis).astype(np.float32)
    hi -= lo
    hi *= w
    lo += hi
    return lo


def mandible_bone(vol, hu=250.0, close_mm=1.5):
    """Planning bone of a head / neck CT: (mask (z, y, x), info). Chosen on the ~0.8 mm working grid (as in the browser): the
    largest threshold component is the mandible when it is mandible-sized; when skull + upper jaw + spine are joined it is cut
    at its thin necks and the mandible-like piece is taken (surgiguide/bones.py), then the maxilla remnants above the occlusal
    plane are removed. info['status'] is 'whole', 'split' or 'failed'; 'failed' returns the whole largest component, as
    threshold_bone does, and info['warning'] says why that is not a mandible."""
    W = Work(vol)
    lab, comps = W.labels(hu)
    if not comps:
        raise RuntimeError("no bone component above threshold")
    (m, origin, sl), = W.crops(lab, [comps[0][0]])
    nz = W.array.shape[0]
    piece, info = bones.pick_mandible(m, W.spacing, origin, world=W.world, scan_z=(0, nz - 1))
    piece, info = bones.trim_maxilla(piece, W.spacing, origin, W.world, info)
    return W.lift(piece, origin, hu, close_mm), info


def fibula_bone(vol, hu=250.0, side="right", close_mm=1.5):
    """Fibula of the donor leg from a leg CT: (mask (z, y, x), info). Chosen on the same working grid as the browser's fibula
    picker: a fibula is a slender long piece beside a thicker parallel one (tibia); tibia + fibula + foot are one threshold
    component per leg and the CT table one more, so thick long components are cut at their thin necks first. With both legs in
    the scan `side` picks the leg (right = smaller x in LPS). info['status'] is 'ok' or 'failed' (the longest slender piece is
    returned; info['warning'] says why)."""
    W = Work(vol)
    lab, comps = W.labels(hu)
    cs = W.crops(lab, [c[0] for c in comps[:6]])
    i, piece, info = bones.pick_fibula([(c[0], c[1]) for c in cs], W.spacing, side, world=W.world)
    return W.lift(piece, cs[i][1], hu, close_mm), info


TOTALSEG_TASKS = {
    # structure -> (task, output file name)
    "mandible": ("craniofacial_structures", "mandible.nii.gz"),
    "fibula": ("appendicular_bones", "fibula.nii.gz"),
}


def totalseg_bone(vol, structure, dicom_dir=None, fast=False):
    """Segment `structure` with TotalSegmentator (pip install TotalSegmentator).

    Note: some TotalSegmentator tasks (e.g. appendicular_bones) need a licence key from the authors;
    check the licence terms before clinical / commercial use.
    """
    import SimpleITK as sitk                     # only this backend needs it (see volume.py)
    task, fname = TOTALSEG_TASKS[structure]
    with tempfile.TemporaryDirectory() as tmp:
        src = dicom_dir
        if src is None:
            src = os.path.join(tmp, "ct.nii.gz")
            sitk.WriteImage(vol.to_sitk(), src)
        out = os.path.join(tmp, "seg")
        cmd = ["TotalSegmentator", "-i", src, "-o", out, "--task", task]
        if fast:
            cmd.append("--fast")
        subprocess.run(cmd, check=True)
        seg = sitk.ReadImage(os.path.join(out, fname))
        seg = sitk.Resample(seg, vol.to_sitk(), sitk.Transform(), sitk.sitkNearestNeighbor)
        return sitk.GetArrayFromImage(seg) > 0
