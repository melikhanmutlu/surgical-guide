"""DICOM I/O and helpers for working with physical (LPS, mm) coordinates."""
import os
import datetime
import numpy as np
import SimpleITK as sitk
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage


class Volume:
    """A CT volume as a numpy array (z, y, x) plus its physical geometry."""

    def __init__(self, array, spacing, origin, direction=None):
        self.array = array                                   # (z, y, x)
        self.spacing = np.asarray(spacing, float)            # (sx, sy, sz) mm
        self.origin = np.asarray(origin, float)              # (x, y, z) mm
        self.direction = np.eye(3) if direction is None else np.asarray(direction, float).reshape(3, 3)

    @classmethod
    def from_dicom_dir(cls, path):
        reader = sitk.ImageSeriesReader()
        series = reader.GetGDCMSeriesIDs(path)
        if not series:
            raise FileNotFoundError(f"no DICOM series in {path}")
        # pick the series with the most slices
        files = max((reader.GetGDCMSeriesFileNames(path, s) for s in series), key=len)
        reader.SetFileNames(files)
        img = reader.Execute()
        return cls(sitk.GetArrayFromImage(img).astype(np.float32), img.GetSpacing(),
                   img.GetOrigin(), img.GetDirection())

    @classmethod
    def from_file(cls, path):
        """NIfTI / NRRD / MHA etc."""
        img = sitk.ReadImage(path)
        return cls(sitk.GetArrayFromImage(img).astype(np.float32), img.GetSpacing(),
                   img.GetOrigin(), img.GetDirection())

    def to_sitk(self, array=None):
        img = sitk.GetImageFromArray(self.array if array is None else array)
        img.SetSpacing(tuple(self.spacing)); img.SetOrigin(tuple(self.origin))
        img.SetDirection(tuple(self.direction.ravel()))
        return img

    def index_to_physical(self, ijk):
        """ijk: (..., 3) in (x, y, z) index order -> physical mm."""
        return self.origin + (np.asarray(ijk) * self.spacing) @ self.direction.T

    def physical_to_index(self, pts):
        """physical (..., 3) -> continuous (x, y, z) index."""
        return ((np.asarray(pts) - self.origin) @ self.direction) / self.spacing


def write_dicom_series(vol, out_dir, description="PHANTOM", patient="Phantom^Synthetic"):
    """Write an int16 CT series (HU via slope 1 / intercept -1024)."""
    os.makedirs(out_dir, exist_ok=True)
    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    now = datetime.datetime.now()
    nz, ny, nx = vol.array.shape
    for k in range(nz):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, meta.MediaStorageSOPInstanceUID
        ds.Modality, ds.PatientName, ds.PatientID = "CT", patient, "SYNTH0001"
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.SeriesDescription, ds.SeriesNumber, ds.InstanceNumber = description, 1, k + 1
        ds.StudyDate = ds.SeriesDate = now.strftime("%Y%m%d")
        ds.ImagePositionPatient = [float(v) for v in vol.index_to_physical([0, 0, k])]
        ds.ImageOrientationPatient = [float(v) for v in
                                      list(vol.direction[:, 0]) + list(vol.direction[:, 1])]
        ds.PixelSpacing = [float(vol.spacing[1]), float(vol.spacing[0])]
        ds.SliceThickness = float(vol.spacing[2])
        ds.Rows, ds.Columns = ny, nx
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
        px = np.clip(vol.array[k] + 1024, -32768, 32767).astype(np.int16)
        ds.PixelData = px.tobytes()
        ds.save_as(os.path.join(out_dir, f"slice_{k:04d}.dcm"), enforce_file_format=True)
