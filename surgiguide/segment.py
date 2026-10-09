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


def threshold_bone(vol, hu=250.0, component=1, seed=None, close_mm=1.5):
    """Return a boolean mask (z, y, x).

    component: rank of the connected component by volume (1 = largest, 2 = second largest...).
    seed: physical point (x, y, z) mm; if given, the component containing / nearest to it is used.
    """
    mask = vol.array > hu
    r = max(1, int(round(close_mm / vol.spacing.min())))
    st = ndi.generate_binary_structure(3, 1)
    mask = ndi.binary_closing(mask, st, iterations=r)
    lab, n = ndi.label(mask)
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
    out = lab == keep
    # fill the medullary cavity slice by slice, then in 3D
    out = ndi.binary_fill_holes(out)
    for k in range(out.shape[0]):
        out[k] = ndi.binary_fill_holes(out[k])
    return out


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
