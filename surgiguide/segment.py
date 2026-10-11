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
import SimpleITK as sitk

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


def _largest(lab, n, count):
    """The `count` largest components as (mask crop, origin index) pairs."""
    sizes = ndi.sum(lab > 0, lab, range(1, n + 1))
    out = []
    for i in np.argsort(sizes)[::-1][:count]:
        sl = ndi.find_objects((lab == i + 1).astype(np.uint8))[0]
        out.append((lab[sl] == i + 1, tuple(s.start for s in sl), sl))
    return out


def mandible_bone(vol, hu=250.0, close_mm=1.5):
    """Planning bone of a head / neck CT: (mask (z, y, x), info). The largest threshold component is the mandible when
    it is mandible-sized; when skull + upper jaw + spine are joined it is cut at its thin necks and the mandible-like
    piece is taken (surgiguide/bones.py). info['status'] is 'whole', 'split' or 'failed'; 'failed' returns the whole
    largest component, as threshold_bone does, and info['warning'] says why that is not a mandible."""
    lab, n = _threshold_labels(vol, hu, close_mm)
    if n == 0:
        raise RuntimeError("no voxels above threshold")
    (m, origin, sl), = _largest(lab, n, 1)
    sx, sy, sz = vol.spacing
    m, info = bones.pick_mandible(m, (sx, sy, sz), origin, up=1 if vol.direction[2, 2] >= 0 else -1)
    out = np.zeros(lab.shape, bool)
    out[sl] = m
    return _fill_cavity(out), info


def fibula_bone(vol, hu=250.0, side="right", close_mm=1.5):
    """Fibula of the donor leg from a leg CT: (mask (z, y, x), info). A fibula is a slender long piece beside a thicker
    parallel one (tibia); tibia + fibula + foot are one threshold component per leg and the CT table one more, so thick
    long components are cut at their thin necks first. With both legs in the scan `side` picks the leg (right = smaller x
    in LPS). info['status'] is 'ok' or 'failed' (the longest slender piece is returned; info['warning'] says why)."""
    lab, n = _threshold_labels(vol, hu, close_mm)
    if n == 0:
        raise RuntimeError("no voxels above threshold")
    cs = _largest(lab, n, 8)
    i, m, info = bones.pick_fibula([(c[0], c[1]) for c in cs], tuple(vol.spacing), side)
    out = np.zeros(lab.shape, bool)
    out[cs[i][2]] = m
    return _fill_cavity(out), info


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
