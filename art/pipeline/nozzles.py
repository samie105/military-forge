"""Jetpack nozzle exits, written into each jetpack part's extras as `nozzles` (docs/04 §3: the slot
is "model + exhaust colour + trail", so the renderer needs one flame per nozzle, not a fixed pair).

Imported by build_character.py and build_cosmetics.py (Blender + numpy).
"""
import numpy as np


def find(obj, count, band=0.03):
    """`count` nozzle exit centres in glTF character space ([x, y, z], +Y up, the character faces
    +Z): the part's lowest `band` metres, split into `count` groups side by side (by x). The count
    is a design fact of each pack (twin tank 2, rocket pack 2, drum pack 1); clustering low-poly
    nozzle rims by gaps proved unreliable."""
    mw = np.array(obj.matrix_world)
    co = np.array([tuple(v.co) for v in obj.data.vertices], dtype=np.float64).reshape(-1, 3)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    zmin = co[:, 2].min()
    low = co[co[:, 2] < zmin + band]
    low = low[np.argsort(low[:, 0])]
    out = []
    for g in np.array_split(low, count):
        x, y = g[:, 0].mean(), g[:, 1].mean()
        out.append([round(float(x), 3), round(float(zmin), 3), round(float(-y), 3)])  # Blender -> glTF
    return out
