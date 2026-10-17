"""The cosmetic envelope (docs/04 §1.2): no cosmetic sticks out past the body.

Imported by build_character.py and build_cosmetics.py (Blender + numpy). The envelope is the base
body's bounding box (rest pose, no parts) grown 10% about its centre, from the floor up, and it is
the same box for every slot, default parts included. tools/asset-check measures the same box
independently, so a part these helpers fit can still fail the check if they drift apart.

* of_body(objs): the envelope (lo, hi) in world metres (Blender axes: -Y front, +Z up).
* overshoot(obj, env): how far the part sticks out on each side (m; <= 0 means inside).
* shrink_into(obj, env, anchor): uniform scale about a point until the part fits (jetpacks scale
  about their backplate, so they shrink but stay on the back).
* squeeze(obj, env): soft-compress only what overhangs (a brim, a visor, a tall crown) so the
  rest of the part keeps its shape.
* clamp(obj, env): hard clamp, for the few millimetres decimation can drift.
"""
import numpy as np

SCALE = 1.10
MARGIN = 0.003  # m kept inside the box, so a later decimation can't tip a part over
SIDES = (("front", 1, -1), ("back", 1, 1), ("right", 0, -1), ("left", 0, 1), ("top", 2, 1), ("below", 2, -1))


def _co(obj):
    mw = np.array(obj.matrix_world)
    co = np.array([tuple(v.co) for v in obj.data.vertices], dtype=np.float64).reshape(-1, 3)
    return co @ mw[:3, :3].T + mw[:3, 3]


def _set(obj, world):
    inv = np.linalg.inv(np.array(obj.matrix_world))
    local = world @ inv[:3, :3].T + inv[:3, 3]
    obj.data.vertices.foreach_set("co", local.astype(np.float32).ravel())
    obj.data.update()


def bbox(obj):
    co = _co(obj)
    return co.min(axis=0), co.max(axis=0)


def of_body(objs):
    co = np.concatenate([_co(o) for o in objs])
    lo, hi = co.min(axis=0), co.max(axis=0)
    c, half = (lo + hi) / 2, (hi - lo) / 2 * SCALE
    elo, ehi = c - half, c + half
    elo[2] = min(lo[2], 0.0)  # from the floor up: footwear fills the gap below a bare body's calves
    return elo, ehi


def overshoot(obj, env):
    co = _co(obj)
    lo, hi = co.min(axis=0), co.max(axis=0)
    out = {}
    for name, axis, side in SIDES:
        out[name] = float(hi[axis] - env[1][axis]) if side > 0 else float(env[0][axis] - lo[axis])
    return out


def inside(obj, env, tol=1e-4):
    return all(v <= tol for v in overshoot(obj, env).values())


def describe(obj, env):
    over = {k: v for k, v in overshoot(obj, env).items() if v > 1e-4}
    return "inside" if not over else ", ".join(f"{k} {v * 100:.1f} cm" for k, v in over.items())


def shrink_into(obj, env, anchor):
    """Uniform scale about `anchor` (world point) until the part fits; returns the scale (<= 1)."""
    co = _co(obj)
    a = np.asarray(anchor, dtype=np.float64)
    elo, ehi = env[0] + MARGIN, env[1] - MARGIN
    s = 1.0
    for axis in range(3):
        hi, lo = co[:, axis].max(), co[:, axis].min()
        if hi > ehi[axis] and hi > a[axis]:
            s = min(s, (ehi[axis] - a[axis]) / (hi - a[axis]))
        if lo < elo[axis] and lo < a[axis]:
            s = min(s, (a[axis] - elo[axis]) / (a[axis] - lo))
    if s < 1.0:
        _set(obj, a + (co - a) * s)
    return s


def squeeze(obj, env, knee=0.06):
    """Soft-compress whatever sticks out. On each side, coordinates from `knee` inside the limit out
    to the part's extreme are remapped linearly so the extreme lands on the limit; anything deeper
    inside is untouched (a brim gets shorter, the crown it hangs off doesn't move). The top uses the
    part's whole height as its knee, i.e. a uniform squash about its bottom. Returns {side: cm}."""
    co = _co(obj)
    elo, ehi = env[0] + MARGIN, env[1] - MARGIN
    moved = {}
    for name, axis, side in SIDES:
        x = co[:, axis]
        lim = ehi[axis] if side > 0 else elo[axis]
        ext = x.max() if side > 0 else x.min()
        if (ext - lim) * side <= 0:
            continue
        k = (lim - x.min()) if name == "top" else knee
        knee_at = lim - side * k
        sel = (x - knee_at) * side > 0
        x[sel] = knee_at + (x[sel] - knee_at) * (lim - knee_at) / (ext - knee_at)
        moved[name] = round(abs(float(ext - lim)) * 100, 1)
    if moved:
        _set(obj, co)
    return moved


def clamp(obj, env, inset=0.0005):
    """Clip vertices into the envelope, `inset` inside it (not at the floor): a vertex left exactly
    on the boundary can land a float32 step outside after glTF export."""
    co = _co(obj)
    lo, hi = np.array(env[0], dtype=np.float64) + inset, np.array(env[1], dtype=np.float64) - inset
    lo[2] = env[0][2]
    _set(obj, np.clip(co, lo, hi))
