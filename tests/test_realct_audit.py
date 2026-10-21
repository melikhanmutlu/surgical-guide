"""tools/realct_audit.py on synthetic meshes: what fails a run (not printable) and what counts as drift (changed guide)."""
import json, os, sys, tempfile, unittest
import numpy as np
import trimesh
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import realct_audit as A

OK_META = {"watertight": True, "bodies": 1, "productionOk": True, "issues": [], "current": True,
           "print": {"thin_wall_mm3": 0, "thin_patch_mm3": 0, "bone_overlap_mm3": 0, "undercut_mm3": 0, "min_wall_mm": 1.0}}


def run_dir(mesh, fib=None, meta=None, fmeta=None):
    d = tempfile.mkdtemp(); r = os.path.join(d, "real"); os.makedirs(r)
    mesh.export(os.path.join(r, "guide_uretim.stl"))
    (fib if fib is not None else mesh).export(os.path.join(r, "fibula_guide_uretim.stl"))
    for n, m in (("guide_uretim_meta.json", meta or OK_META), ("fibula_guide_uretim_meta.json", fmeta or OK_META)):
        with open(os.path.join(r, n), "w") as f: json.dump(m, f)
    return d


def sphere(shift=0.0):
    m = trimesh.creation.icosphere(subdivisions=4, radius=10.0); m.apply_translation([shift, 0, 0]); return m


def terraced():
    """The same sphere as voxel steps (1 mm voxels, no smoothing): what slice terraces look like."""
    return trimesh.creation.icosphere(subdivisions=4, radius=10.0).voxelized(1.0).marching_cubes


class Audit(unittest.TestCase):
    def test_clean_run_passes_and_becomes_the_baseline(self):
        k, b = run_dir(sphere()), tempfile.mkdtemp()
        res, _ = A.audit(k, b)
        self.assertTrue(res["ok"], res); self.assertFalse(res["had_baseline"])
        A.write_baseline(k, b, res)
        self.assertTrue(os.path.exists(os.path.join(b, "baseline.json")))
        res2, rows = A.audit(run_dir(sphere()), b)
        self.assertTrue(res2["ok"], res2)
        self.assertLess(res2["files"]["guide_uretim.stl"]["distance"]["mean_mm"], 0.1)
        self.assertIn("GEÇTİ", A.report(res2, rows))

    def test_moved_guide_is_drift(self):
        k, b = run_dir(sphere()), tempfile.mkdtemp()
        res, _ = A.audit(k, b); A.write_baseline(k, b, res)
        res2, _ = A.audit(run_dir(sphere(1.0)), b)
        self.assertFalse(res2["ok"]); self.assertFalse(res2["fails"])
        self.assertTrue(any("yüzey tabandan" in x for x in res2["drifts"]), res2["drifts"])
        self.assertTrue(A.audit(run_dir(sphere(1.0)), b, allow_drift=True)[0]["ok"])

    def test_terraced_surface_is_drift(self):
        k, b = run_dir(sphere()), tempfile.mkdtemp()
        res, _ = A.audit(k, b); A.write_baseline(k, b, res)
        res2, _ = A.audit(run_dir(terraced()), b)
        self.assertTrue(any("pürüzlülüğü" in x for x in res2["drifts"]), res2["drifts"])

    def test_not_printable_fails_and_is_never_a_baseline(self):
        op = sphere(); op.update_faces(np.arange(len(op.faces)) > 5); op.remove_unreferenced_vertices()
        res, _ = A.audit(run_dir(op), None)
        self.assertTrue(any("su geçirmez değil" in x for x in res["fails"]), res["fails"])
        two = trimesh.util.concatenate([sphere(), sphere(30.0)])
        self.assertTrue(any("2 parça" in x for x in A.audit(run_dir(two), None)[0]["fails"]))
        bad = dict(OK_META, issues=["thin_wall"], productionOk=False)
        res3, _ = A.audit(run_dir(sphere(), meta=bad), None)
        self.assertTrue(any("thin_wall" in x for x in res3["fails"]), res3["fails"])
        self.assertTrue(any("sunucu baskı denetimi sonucu yok" in x for x in A.audit(run_dir(sphere(), meta=dict(OK_META, print=None)), None)[0]["fails"]))
        self.assertTrue(any("yeniden üretilmemiş" in x for x in A.audit(run_dir(sphere(), fmeta=dict(OK_META, current=False)), None)[0]["fails"]))

    def test_missing_production_stl_fails(self):
        k = run_dir(sphere()); os.remove(os.path.join(k, "real", "fibula_guide_uretim.stl"))
        self.assertTrue(any("yok" in x for x in A.audit(k, None)[0]["fails"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
