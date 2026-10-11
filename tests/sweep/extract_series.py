"""Copy the files of one DICOM series out of a zip into a flat folder (no other series, no DICOMDIR).

    python3 -I extract_series.py --zip mandibula_anon.zip --series "0.625mm Bone" --out <dir>

`--series` is a case-insensitive substring of SeriesDescription (or a SeriesInstanceUID). The zip is read entry by entry
(headers only, pixel data skipped) so nothing else is written to disk.
"""
import argparse
import io
import os
import zipfile

import pydicom


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True); ap.add_argument("--series", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    want = a.series.lower()
    n, seen = 0, {}
    with zipfile.ZipFile(a.zip) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            data = z.read(info)
            try:
                ds = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True, force=True)
            except Exception:
                continue
            desc, uid = str(ds.get("SeriesDescription", "")), str(ds.get("SeriesInstanceUID", ""))
            seen[desc] = seen.get(desc, 0) + 1
            if want in desc.lower() or want == uid:
                with open(os.path.join(a.out, os.path.basename(info.filename)), "wb") as f:
                    f.write(data)
                n += 1
    print(f"{n} files -> {a.out}; series in the zip: " + ", ".join(f"{k!r} ({v})" for k, v in seen.items()))
    if not n:
        raise SystemExit(f"no series matching {a.series!r}")


if __name__ == "__main__":
    main()
