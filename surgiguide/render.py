"""Static PNG previews (matplotlib) of the plan and guides."""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


def _dec(mesh, faces=12000):
    if len(mesh.faces) > faces:
        try:
            return mesh.simplify_quadric_decimation(face_count=faces)
        except Exception:
            pass
    return mesh


def _add(ax, mesh, color, alpha=1.0):
    m = _dec(mesh)
    light = np.array([0.3, -0.5, 0.8]); light /= np.linalg.norm(light)
    shade = 0.45 + 0.55 * np.clip(m.face_normals @ light, 0, 1)
    rgb = np.array(matplotlib.colors.to_rgb(color))
    fc = np.clip(shade[:, None] * rgb, 0, 1)
    pc = Poly3DCollection(m.vertices[m.faces], facecolors=np.c_[fc, np.full(len(fc), alpha)], linewidths=0)
    ax.add_collection3d(pc)
    return m.bounds


def render(path, items, title, view=(25, -60)):
    fig = plt.figure(figsize=(8, 7), dpi=110)
    ax = fig.add_subplot(111, projection="3d")
    bounds = [_add(ax, m, c, a) for m, c, a in items]
    lo = np.min([b[0] for b in bounds], 0); hi = np.max([b[1] for b in bounds], 0)
    c, r = (lo + hi) / 2, (hi - lo).max() / 2
    ax.set_xlim(c[0] - r, c[0] + r); ax.set_ylim(c[1] - r, c[1] + r); ax.set_zlim(c[2] - r, c[2] + r)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(*view); ax.set_axis_off()
    ax.set_title(title)
    fig.tight_layout(); fig.savefig(path); plt.close(fig)
