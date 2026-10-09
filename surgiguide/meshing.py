"""Mask -> surface mesh, and resampling of masks onto arbitrary oriented local grids."""
import numpy as np
import trimesh
from scipy import ndimage as ndi
from skimage import measure


def mask_to_mesh(mask, spacing_xyz, to_world, smooth_iter=10, sigma=0.6):
    """mask (z, y, x) bool -> trimesh in world mm.

    to_world: function mapping (N, 3) local (x, y, z) mm to world mm.
    """
    pad = np.pad(mask.astype(np.float32), 2)
    if sigma:
        pad = ndi.gaussian_filter(pad, sigma)
    verts, faces, _, _ = measure.marching_cubes(pad, 0.5, spacing=tuple(np.asarray(spacing_xyz)[::-1]))
    verts = verts[:, ::-1] - 2 * np.asarray(spacing_xyz)           # (z,y,x) -> (x,y,z), undo pad
    mesh = trimesh.Trimesh(to_world(verts), faces[:, ::-1], process=True)
    if smooth_iter:
        trimesh.smoothing.filter_taubin(mesh, iterations=smooth_iter)
    mesh.fix_normals()
    return mesh


def volume_mask_mesh(vol, mask, **kw):
    return mask_to_mesh(mask, vol.spacing, lambda v: vol.origin + v @ vol.direction.T, **kw)


class LocalGrid:
    """Regular grid in an oriented frame: world = origin + axes @ (x, y, z)."""

    def __init__(self, origin, axes, lo, hi, h):
        self.origin, self.axes, self.h = np.asarray(origin, float), np.asarray(axes, float), h
        self.lo = np.asarray(lo, float)
        self.n = np.ceil((np.asarray(hi) - self.lo) / h).astype(int) + 1   # (nx, ny, nz)
        xs = [self.lo[i] + h * np.arange(self.n[i]) for i in range(3)]
        Z, Y, X = np.meshgrid(xs[2], xs[1], xs[0], indexing="ij")
        self.local = np.stack([X, Y, Z], -1)                             # (nz, ny, nx, 3)

    def world(self, local=None):
        local = self.local if local is None else local
        return self.origin + local @ self.axes.T

    def to_world_fn(self):
        return lambda v: self.origin + (v + self.lo) @ self.axes.T

    def sample_mask(self, vol, mask):
        ijk = vol.physical_to_index(self.world().reshape(-1, 3))        # (x, y, z) index
        vals = ndi.map_coordinates(mask.astype(np.float32), ijk[:, ::-1].T, order=1, cval=0)
        return vals.reshape(self.local.shape[:3]) > 0.5

    def mesh(self, m, **kw):
        kw.setdefault("sigma", 0.5)
        kw.setdefault("smooth_iter", 5)
        return mask_to_mesh(m, (self.h,) * 3, self.to_world_fn(), **kw)
