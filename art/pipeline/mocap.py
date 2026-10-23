"""Motion data onto the shared skeleton (docs/design/character-feel-research.md §3.10, §5.3), in plain Python + numpy.

No Blender: the clips are computed straight in glTF node space and appended to rookie_anims.glb, so the clips
already there stay byte for byte as they are.

* Readers: BVH (100STYLE), ASF/AMC (the CMU database), glTF/GLB skeletons with animations (Mesh2Motion). Each
  gives a `Motion`: joints, parents, and per frame every joint's world rotation and position, in metres, Y up, the
  character facing +Z with its left at +X (the glTF convention the rig uses).
* `retarget`: each shared-v1 bone takes its source bone's direction (bone → its tip joint) and a twist reference,
  matched as whole frames, so arms in a T-pose source land right on the rig's A-pose. The hips' height follows the
  source scaled by leg length; their travel is dropped (clips are in place).
* `plant`: holds each foot still on the ground while the source's foot is down (the ankle by two-bone IK), so a
  source's proportions don't make the chibi's feet slide. `march`: a planted stance for gait cycles instead (the
  foot moves back at the ground speed, as `clips.gait()` keys it).
* `stylize`: time remap and exaggeration (§5.3 step 3).
* `GlbClips`: reads rookie_anims.glb and appends LINEAR clips (sign-continuous quaternions, 30 fps).

Data files are only read: nothing in them runs.
"""
import json
import math
import re
import struct
from dataclasses import dataclass, field

import numpy as np

# ------------------------------------------------------------------ rotations


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


AXIS = {"X": rot_x, "Y": rot_y, "Z": rot_z}


def quat_to_mat(q):
    """(x, y, z, w) → 3×3."""
    x, y, z, w = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mat_to_quat(m):
    """3×3 → (x, y, z, w), w ≥ 0 not enforced (sign continuity is done per track)."""
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def orthonormal(m):
    """The nearest rotation to `m` (SVD)."""
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def frame_of(primary, secondary):
    """The rotation whose +Y is `primary` and whose +Z is `secondary` made perpendicular to it."""
    y = primary / np.linalg.norm(primary)
    z = secondary - y * np.dot(secondary, y)
    n = np.linalg.norm(z)
    if n < 1e-6:  # secondary along primary: any perpendicular
        z = np.cross(y, [1, 0, 0] if abs(y[0]) < 0.9 else [0, 0, 1])
        n = np.linalg.norm(z)
    z = z / n
    x = np.cross(y, z)
    return np.column_stack([x, y, z])


def slerp_q(a, b, t):
    if np.dot(a, b) < 0:
        b = -b
    d = min(1.0, float(np.dot(a, b)))
    if d > 0.9995:
        q = a + (b - a) * t
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


# ------------------------------------------------------------------ motion


@dataclass
class Motion:
    """World rotations (F, J, 3, 3) and positions (F, J, 3) per frame, metres, Y up, facing +Z, left +X."""
    names: list
    parents: list
    fps: float
    rot: np.ndarray
    pos: np.ndarray
    rest_rot: np.ndarray = None  # (J, 3, 3): the pose the skeleton was built in (T or A)
    rest_pos: np.ndarray = None
    meta: dict = field(default_factory=dict)

    def index(self, name):
        return self.names.index(name)

    @property
    def frames(self):
        return self.rot.shape[0]

    def slice(self, a, b):
        return Motion(self.names, self.parents, self.fps, self.rot[a:b], self.pos[a:b], self.rest_rot, self.rest_pos, dict(self.meta))

    def resample(self, fps):
        """Linear in position, slerp in rotation, onto a new frame rate."""
        n = max(2, int(round((self.frames - 1) * fps / self.fps)) + 1)
        src = np.arange(n) * self.fps / fps
        rot = np.empty((n,) + self.rot.shape[1:])
        pos = np.empty((n,) + self.pos.shape[1:])
        for i, s in enumerate(src):
            a = min(int(s), self.frames - 1)
            b = min(a + 1, self.frames - 1)
            t = s - a
            pos[i] = self.pos[a] * (1 - t) + self.pos[b] * t
            for j in range(rot.shape[1]):
                qa, qb = mat_to_quat(self.rot[a, j]), mat_to_quat(self.rot[b, j])
                rot[i, j] = quat_to_mat(slerp_q(qa, qb, t))
        return Motion(self.names, self.parents, fps, rot, pos, self.rest_rot, self.rest_pos, dict(self.meta))

    def turned(self, yaw):
        """The whole motion turned about +Y (rad) through the origin."""
        r = rot_y(yaw)
        return Motion(self.names, self.parents, self.fps, np.einsum("ij,fkjl->fkil", r, self.rot), self.pos @ r.T,
                      None if self.rest_rot is None else np.einsum("ij,kjl->kil", r, self.rest_rot),
                      None if self.rest_pos is None else self.rest_pos @ r.T, dict(self.meta))


def _fk(parents, offsets, local_rot, root_pos):
    """World rotations and positions from local rotations (F, J, 3, 3), joint offsets (J, 3), root positions (F, 3)."""
    f, j = local_rot.shape[:2]
    rot = np.empty_like(local_rot)
    pos = np.empty((f, j, 3))
    for k in range(j):
        p = parents[k]
        if p < 0:
            rot[:, k] = local_rot[:, k]
            pos[:, k] = root_pos + offsets[k]
        else:
            rot[:, k] = rot[:, p] @ local_rot[:, k]
            pos[:, k] = pos[:, p] + np.einsum("fij,j->fi", rot[:, p], offsets[k])
    return rot, pos


# ------------------------------------------------------------------ BVH


def read_bvh(path, unit=0.01):
    """A BVH file (100STYLE: centimetres, Y up, facing +Z) → Motion. `unit`: metres per file unit."""
    text = open(path).read()
    head, motion = text.split("MOTION", 1)
    names, parents, offsets, channels = [], [], [], []
    stack = []
    tokens = re.findall(r"[{}]|[^\s{}]+", head)
    i = 0
    pending = None
    while i < len(tokens):
        t = tokens[i]
        if t in ("ROOT", "JOINT"):
            pending = tokens[i + 1]
            i += 2
            continue
        if t == "End":  # End Site: a tip, kept as a joint without channels
            pending = f"{names[stack[-1]]}_end"
            i += 2
            continue
        if t == "{":
            names.append(pending)
            parents.append(stack[-1] if stack else -1)
            offsets.append([0, 0, 0])
            channels.append([])
            stack.append(len(names) - 1)
        elif t == "}":
            stack.pop()
        elif t == "OFFSET":
            offsets[stack[-1]] = [float(tokens[i + 1]), float(tokens[i + 2]), float(tokens[i + 3])]
            i += 3
        elif t == "CHANNELS":
            n = int(tokens[i + 1])
            channels[stack[-1]] = tokens[i + 2:i + 2 + n]
            i += 1 + n
        i += 1
    lines = motion.strip().splitlines()
    frames = int(lines[0].split(":")[1])
    ft = float(lines[1].split(":")[1])
    data = np.array([[float(v) for v in ln.split()] for ln in lines[2:2 + frames]])
    j = len(names)
    local = np.tile(np.eye(3), (frames, j, 1, 1))
    root = np.zeros((frames, 3))
    col = 0
    for k in range(j):
        rots = []
        for ch in channels[k]:
            if ch.endswith("position"):
                root[:, "XYZ".index(ch[0])] = data[:, col] * unit
            else:
                rots.append((ch[0], data[:, col]))
            col += 1
        for f in range(frames):
            m = np.eye(3)
            for axis, vals in rots:  # intrinsic, in the listed order
                m = m @ AXIS[axis](math.radians(vals[f]))
            local[f, k] = m
    offsets = np.array(offsets) * unit
    rot, pos = _fk(parents, offsets, local, root)
    rest_rot, rest_pos = _fk(parents, offsets, np.tile(np.eye(3), (1, j, 1, 1)), np.zeros((1, 3)) + offsets[0])
    return Motion(names, parents, 1.0 / ft, rot, pos, rest_rot[0], rest_pos[0], {"source": str(path)})


# ------------------------------------------------------------------ ASF / AMC (CMU)


def read_asf_amc(asf_path, amc_path, fps=120.0):
    """The CMU database's skeleton and motion (an ASF length unit is 1/0.45 inch; Y up) → Motion. Every bone's
    head is a joint and its tip a joint named `<bone>_end`. `retarget` turns it to face +Z."""
    lines = [ln.strip() for ln in open(asf_path) if ln.strip() and not ln.startswith("#")]
    unit = 0.0254 / 0.45  # metres per ASF length unit
    bones = {"root": {"dir": np.zeros(3), "len": 0.0, "axis": np.eye(3), "dof": ["tx", "ty", "tz", "rx", "ry", "rz"]}}
    order_root = ["rx", "ry", "rz"]
    i = 0
    hierarchy = {}
    while i < len(lines):
        ln = lines[i]
        if ln.startswith(":root"):
            i += 1
            while i < len(lines) and not lines[i].startswith(":"):
                parts = lines[i].split()
                if parts[0] == "order":
                    order_root = [p.lower() for p in parts[1:]]
                if parts[0] == "axis":
                    bones["root"]["axis_order"] = parts[1]
                i += 1
            continue
        if ln == "begin":
            b = {"dof": []}
            i += 1
            while lines[i] != "end":
                parts = lines[i].split()
                if parts[0] == "name":
                    name = parts[1]
                elif parts[0] == "direction":
                    b["dir"] = np.array([float(v) for v in parts[1:4]])
                elif parts[0] == "length":
                    b["len"] = float(parts[1]) * unit
                elif parts[0] == "axis":
                    ang = [math.radians(float(v)) for v in parts[1:4]]
                    # static axes in the listed order ("XYZ": Rz·Ry·Rx), as the CMU tools compose it
                    b["axis"] = AXIS[parts[4][2]](ang[2]) @ AXIS[parts[4][1]](ang[1]) @ AXIS[parts[4][0]](ang[0])
                elif parts[0] == "dof":
                    b["dof"] = parts[1:]
                i += 1
            bones[name] = b
            i += 1
            continue
        if ln.startswith(":hierarchy"):
            i += 1
            while i < len(lines) and not lines[i].startswith(":"):
                parts = lines[i].split()
                if parts[0] not in ("begin", "end"):
                    hierarchy[parts[0]] = parts[1:]
                i += 1
            continue
        i += 1
    names, parents = ["root"], [-1]
    queue = ["root"]
    while queue:
        n = queue.pop(0)
        for c in hierarchy.get(n, []):
            names.append(c)
            parents.append(names.index(n))
            queue.append(c)
    # AMC frames
    frames = []
    cur = None
    for ln in open(amc_path):
        ln = ln.strip()
        if not ln or ln.startswith("#") or ln.startswith(":"):
            continue
        if ln.isdigit():
            cur = {}
            frames.append(cur)
            continue
        parts = ln.split()
        cur[parts[0]] = [float(v) for v in parts[1:]]
    f = len(frames)
    j = len(names)
    rot = np.empty((f, j, 3, 3))
    pos = np.empty((f, j, 3))
    for fi, fr in enumerate(frames):
        for k, n in enumerate(names):
            b = bones[n]
            vals = fr.get(n, [])
            if n == "root":
                tr = np.zeros(3)
                rx = ry = rz = 0.0
                for d, v in zip(order_root, vals):
                    if d == "tx":
                        tr[0] = v
                    elif d == "ty":
                        tr[1] = v
                    elif d == "tz":
                        tr[2] = v
                    elif d == "rx":
                        rx = v
                    elif d == "ry":
                        ry = v
                    elif d == "rz":
                        rz = v
                m = rot_z(math.radians(rz)) @ rot_y(math.radians(ry)) @ rot_x(math.radians(rx))
                rot[fi, k] = m
                pos[fi, k] = tr * unit
                continue
            angles = {"rx": 0.0, "ry": 0.0, "rz": 0.0}
            for d, v in zip(b["dof"], vals):
                angles[d] = math.radians(v)
            motion = rot_z(angles["rz"]) @ rot_y(angles["ry"]) @ rot_x(angles["rx"])
            c = b["axis"]
            local = c @ motion @ c.T
            p = parents[k]
            rot[fi, k] = rot[fi, p] @ local
            # a bone's own frame starts at its parent's tip
            pos[fi, k] = pos[fi, p] + rot[fi, p] @ (bones[names[p]]["dir"] * bones[names[p]]["len"]) if p > 0 else pos[fi, p]
    # tips: each bone's position is its head; add tips as extra joints so every bone has a direction
    tip_names, tip_parents = [], []
    tips_pos = np.empty((f, j, 3))
    for k, n in enumerate(names):
        b = bones[n]
        tips_pos[:, k] = pos[:, k] + np.einsum("fij,j->fi", rot[:, k], b["dir"] * b["len"])
        tip_names.append(f"{n}_end")
        tip_parents.append(k)
    names2 = names + tip_names
    parents2 = parents + tip_parents
    rot2 = np.concatenate([rot, rot], axis=1)
    pos2 = np.concatenate([pos, tips_pos], axis=1)
    # the reference pose (every dof zero): world rotations identity, heads at the parents' tips
    rrot = np.tile(np.eye(3), (j, 1, 1))
    rpos = np.zeros((j, 3))
    for k in range(1, j):
        p = parents[k]
        rpos[k] = rpos[p] + (bones[names[p]]["dir"] * bones[names[p]]["len"] if p > 0 else 0)
    rtip = np.array([rpos[k] + bones[n]["dir"] * bones[n]["len"] for k, n in enumerate(names)])
    return Motion(names2, parents2, fps, rot2, pos2, np.concatenate([rrot, rrot]), np.concatenate([rpos, rtip]), {"source": str(amc_path)})


# ------------------------------------------------------------------ glTF


def _glb(path):
    b = open(path, "rb").read()
    assert b[:4] == b"glTF", path
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from("<I", b, off)[0]
    return g, b[off + 8:off + 8 + bl]


def _accessor(g, bin_, i):
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
    assert a["componentType"] == 5126, "float accessors only"
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", 4 * comps)
    out = np.empty((a["count"], comps), np.float32)
    for k in range(a["count"]):
        out[k] = np.frombuffer(bin_, np.float32, comps, start + k * stride)
    return out


def read_gltf_motion(path, animation, fps=30.0, scale=1.0):
    """One animation of a glTF skeleton (Mesh2Motion: metres, Y up, facing +Z) sampled at `fps` → Motion. Every
    node under the scene is a joint (the Armature's own transform included)."""
    g, bin_ = _glb(path)
    nodes = g["nodes"]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i
    order = []

    def visit(i):
        order.append(i)
        for c in nodes[i].get("children", []):
            visit(c)

    for r in g["scenes"][g.get("scene", 0)]["nodes"]:
        visit(r)
    names = [nodes[i].get("name", f"node{i}") for i in order]
    parents = [order.index(parent[i]) if i in parent else -1 for i in order]
    rest_t = np.array([nodes[i].get("translation", [0, 0, 0]) for i in order], float) * scale
    rest_r = np.array([nodes[i].get("rotation", [0, 0, 0, 1]) for i in order], float)
    rest_s = np.array([nodes[i].get("scale", [1, 1, 1]) for i in order], float)
    an = next(a for a in g["animations"] if a.get("name") == animation)
    length = 0.0
    tracks = {}
    for ch in an["channels"]:
        s = an["samplers"][ch["sampler"]]
        times = _accessor(g, bin_, s["input"])[:, 0]
        vals = _accessor(g, bin_, s["output"])
        if s.get("interpolation", "LINEAR") == "CUBICSPLINE":
            vals = vals.reshape(len(times), 3, -1)[:, 1]
        tracks[(ch["target"]["node"], ch["target"]["path"])] = (times, vals, s.get("interpolation", "LINEAR"))
        length = max(length, float(times[-1]))
    n = int(round(length * fps)) + 1
    j = len(order)
    local = np.empty((n, j, 3, 3))
    trans = np.empty((n, j, 3))
    for f in range(n):
        t = f / fps
        for k, i in enumerate(order):
            r = rest_r[k]
            tr = rest_t[k]
            if (i, "rotation") in tracks:
                times, vals, interp = tracks[(i, "rotation")]
                r = _sample(times, vals, t, interp, quat=True)
            if (i, "translation") in tracks:
                times, vals, interp = tracks[(i, "translation")]
                tr = _sample(times, vals, t, interp) * scale
            local[f, k] = quat_to_mat(r) * rest_s[k]
            trans[f, k] = tr
    rot = np.empty_like(local)
    pos = np.empty((n, j, 3))
    for k in range(j):
        p = parents[k]
        if p < 0:
            rot[:, k] = local[:, k]
            pos[:, k] = trans[:, k]
        else:
            rot[:, k] = rot[:, p] @ local[:, k]
            pos[:, k] = pos[:, p] + np.einsum("fij,fj->fi", rot[:, p], trans[:, k])
    # world rotations without the (uniform) scales
    for k in range(j):
        for f in range(n):
            rot[f, k] = orthonormal(rot[f, k])
    rr = np.array([quat_to_mat(q) * s for q, s in zip(rest_r, rest_s)])
    rest_rot = np.empty((j, 3, 3))
    rest_pos = np.empty((j, 3))
    for k in range(j):
        p = parents[k]
        rest_rot[k] = rr[k] if p < 0 else rest_rot[p] @ rr[k]
        rest_pos[k] = rest_t[k] if p < 0 else rest_pos[p] + rest_rot[p] @ rest_t[k]
    rest_rot = np.array([orthonormal(m) for m in rest_rot])
    return Motion(names, parents, fps, rot, pos, rest_rot, rest_pos, {"source": f"{path}#{animation}"})


def _sample(times, vals, t, interp, quat=False):
    if t <= times[0]:
        return vals[0].astype(float)
    if t >= times[-1]:
        return vals[-1].astype(float)
    k = int(np.searchsorted(times, t)) - 1
    if interp == "STEP":
        return vals[k].astype(float)
    u = (t - times[k]) / (times[k + 1] - times[k])
    a, b = vals[k].astype(float), vals[k + 1].astype(float)
    return slerp_q(a, b, u) if quat else a * (1 - u) + b * u


# ------------------------------------------------------------------ the target rig


class Rig:
    """The shared-v1 skeleton from rookie_anims.glb: node names, parents and rest transforms (glTF node space)."""

    def __init__(self, path):
        self.g, self.bin = _glb(path)
        nodes = self.g["nodes"]
        self.names = [n.get("name") for n in nodes]
        self.parent = [-1] * len(nodes)
        for i, n in enumerate(nodes):
            for c in n.get("children", []):
                self.parent[c] = i
        self.rest_t = np.array([n.get("translation", [0, 0, 0]) for n in nodes], float)
        self.rest_q = np.array([n.get("rotation", [0, 0, 0, 1]) for n in nodes], float)
        self.rest_q[np.all(self.rest_q == 0, axis=1)] = [0, 0, 0, 1]
        self.order = []

        def visit(i):
            self.order.append(i)
            for c in nodes[i].get("children", []):
                visit(c)

        for r in self.g["scenes"][self.g.get("scene", 0)]["nodes"]:
            visit(r)
        self.rest_world_rot, self.rest_world_pos = self.fk({})

    def idx(self, name):
        return self.names.index(name)

    def fk(self, local_q, root_t=None):
        """World rotations and positions with some bones' local rotations replaced ({index: quat})."""
        n = len(self.names)
        rot = np.empty((n, 3, 3))
        pos = np.empty((n, 3))
        for i in self.order:
            q = local_q.get(i, self.rest_q[i])
            t = root_t if (root_t is not None and self.names[i] == "pelvis") else self.rest_t[i]
            p = self.parent[i]
            r = quat_to_mat(q)
            if p < 0:
                rot[i], pos[i] = r, t
            else:
                rot[i] = rot[p] @ r
                pos[i] = pos[p] + rot[p] @ t
        return rot, pos


# ------------------------------------------------------------------ retargeting

# shared-v1 bone → (source joint, its tip joint, twist reference in world space at rest: 'fwd' +Z, 'up' +Y)
RIG_TIPS = {
    "pelvis": "spine1", "spine1": "spine2", "spine2": "neck", "neck": "head", "head": "socket_hat",
    "clavicle_L": "upperarm_L", "upperarm_L": "forearm_L", "forearm_L": "hand_L", "hand_L": "socket_weapon_L",
    "clavicle_R": "upperarm_R", "upperarm_R": "forearm_R", "forearm_R": "hand_R", "hand_R": "socket_weapon_R",
    "thigh_L": "calf_L", "calf_L": "foot_L", "foot_L": "toe_L",
    "thigh_R": "calf_R", "calf_R": "foot_R", "foot_R": "toe_R",
}
TWIST_REF = {
    "pelvis": "fwd", "spine1": "fwd", "spine2": "fwd", "neck": "fwd", "head": "fwd",
    "clavicle_L": "fwd", "upperarm_L": "fwd", "forearm_L": "fwd", "hand_L": "fwd",
    "clavicle_R": "fwd", "upperarm_R": "fwd", "forearm_R": "fwd", "hand_R": "fwd",
    "thigh_L": "fwd", "calf_L": "fwd", "foot_L": "up", "thigh_R": "fwd", "calf_R": "fwd", "foot_R": "up",
}
REF = {"fwd": np.array([0.0, 0.0, 1.0]), "up": np.array([0.0, 1.0, 0.0])}

# skeleton maps: shared-v1 bone → (source joint, source tip)
MAP_100STYLE = {
    "pelvis": ("Hips", "Chest"), "spine1": ("Chest", "Chest3"), "spine2": ("Chest3", "Neck"), "neck": ("Neck", "Head"),
    "head": ("Head", "Head_end"),
    "clavicle_L": ("LeftCollar", "LeftShoulder"), "upperarm_L": ("LeftShoulder", "LeftElbow"), "forearm_L": ("LeftElbow", "LeftWrist"),
    "hand_L": ("LeftWrist", "LeftWrist_end"),
    "clavicle_R": ("RightCollar", "RightShoulder"), "upperarm_R": ("RightShoulder", "RightElbow"), "forearm_R": ("RightElbow", "RightWrist"),
    "hand_R": ("RightWrist", "RightWrist_end"),
    "thigh_L": ("LeftHip", "LeftKnee"), "calf_L": ("LeftKnee", "LeftAnkle"), "foot_L": ("LeftAnkle", "LeftToe"),
    "thigh_R": ("RightHip", "RightKnee"), "calf_R": ("RightKnee", "RightAnkle"), "foot_R": ("RightAnkle", "RightToe"),
}
MAP_CMU = {
    "pelvis": ("lowerback", "lowerback_end"), "spine1": ("upperback", "upperback_end"), "spine2": ("thorax", "thorax_end"),
    "neck": ("lowerneck", "upperneck_end"), "head": ("head", "head_end"),
    "clavicle_L": ("lclavicle", "lclavicle_end"), "upperarm_L": ("lhumerus", "lhumerus_end"), "forearm_L": ("lradius", "lradius_end"),
    "hand_L": ("lwrist", "lhand_end"),
    "clavicle_R": ("rclavicle", "rclavicle_end"), "upperarm_R": ("rhumerus", "rhumerus_end"), "forearm_R": ("rradius", "rradius_end"),
    "hand_R": ("rwrist", "rhand_end"),
    "thigh_L": ("lfemur", "lfemur_end"), "calf_L": ("ltibia", "ltibia_end"), "foot_L": ("lfoot", "lfoot_end"),
    "thigh_R": ("rfemur", "rfemur_end"), "calf_R": ("rtibia", "rtibia_end"), "foot_R": ("rfoot", "rfoot_end"),
}
MAP_M2M = {
    "pelvis": ("pelvis", "spine_01"), "spine1": ("spine_01", "spine_02"), "spine2": ("spine_02", "neck_01"), "neck": ("neck_01", "head"),
    "head": ("head", "head_leaf"),
    "clavicle_L": ("clavicle_l", "upperarm_l"), "upperarm_L": ("upperarm_l", "lowerarm_l"), "forearm_L": ("lowerarm_l", "hand_l"),
    "hand_L": ("hand_l", "middle_01_l"),
    "clavicle_R": ("clavicle_r", "upperarm_r"), "upperarm_R": ("upperarm_r", "lowerarm_r"), "forearm_R": ("lowerarm_r", "hand_r"),
    "hand_R": ("hand_r", "middle_01_r"),
    "thigh_L": ("thigh_l", "calf_l"), "calf_L": ("calf_l", "foot_l"), "foot_L": ("foot_l", "ball_l"),
    "thigh_R": ("thigh_r", "calf_r"), "calf_R": ("calf_r", "foot_r"), "foot_R": ("foot_r", "ball_r"),
}
# the pelvis's lateral axis (its frame's twist), per source: (left hip, right hip)
HIPS = {"100style": ("LeftHip", "RightHip"), "cmu": ("lfemur", "rfemur"), "m2m": ("thigh_l", "thigh_r")}
MAPS = {"100style": MAP_100STYLE, "cmu": MAP_CMU, "m2m": MAP_M2M}


def _dir(a, b):
    d = b - a
    n = np.linalg.norm(d)
    return d / n if n > 1e-9 else np.array([0.0, 1.0, 0.0])


@dataclass
class Clip:
    """A clip on the rig: per frame, local rotations for some bones (name → (F, 4) xyzw) and the pelvis's
    translation (F, 3), at `fps`."""
    name: str
    fps: float
    rot: dict
    pelvis: np.ndarray = None

    @property
    def frames(self):
        return len(next(iter(self.rot.values())))


def retarget(m: Motion, rig: Rig, kind: str, name: str, fps=30.0, root_scale=None):
    """The motion on the rig as a Clip (in place). Every mapped bone takes its source bone's direction and twist,
    matched as frames against the rig's rest; the hips' height follows the source's (from where they stand in its
    rest pose, over its lowest foot), scaled by leg length."""
    mapping = MAPS[kind]
    hips = HIPS[kind]
    # face +Z on average: the left hip on +X
    li, ri = m.index(hips[0]), m.index(hips[1])
    lat = (m.pos[:, li] - m.pos[:, ri]).mean(axis=0)
    yaw = math.atan2(lat[2], lat[0])  # angle of the left axis from +X toward +Z
    m = m.turned(yaw)
    if abs(fps - m.fps) > 1e-6:
        m = m.resample(fps)
    f = m.frames
    # rest directions on the rig and a twist frame per bone
    rr, rp = rig.rest_world_rot, rig.rest_world_pos
    target_rest_frame = {}
    for bone, tip in RIG_TIPS.items():
        b, t = rig.idx(bone), rig.idx(tip)
        d = _dir(rp[b], rp[t])
        target_rest_frame[bone] = frame_of(d, REF[TWIST_REF[bone]])
    # the source's twist reference, carried by its bone's rotation from the source's rest
    src_rest_rot = m.rest_rot
    world = {}
    for bone, (sj, st) in mapping.items():
        j, tj = m.index(sj), m.index(st)
        out = np.empty((f, 3, 3))
        for k in range(f):
            d = _dir(m.pos[k, j], m.pos[k, tj])
            if bone == "pelvis":
                # the hips: up along the spine, twist from the hips' left-to-right axis
                lateral = _dir(m.pos[k, m.index(hips[1])], m.pos[k, m.index(hips[0])])
                ref = np.cross(lateral, d)  # forward
            else:
                delta = m.rot[k, j] @ src_rest_rot[j].T if src_rest_rot is not None else np.eye(3)
                ref = delta @ REF[TWIST_REF[bone]]
            src_frame = frame_of(d, ref)
            out[k] = src_frame @ target_rest_frame[bone].T @ rr[rig.idx(bone)]
        world[bone] = out
    # local rotations through the rig's own hierarchy (bones not mapped keep their rest)
    clip_rot = {}
    for bone in mapping:
        i = rig.idx(bone)
        p = rig.parent[i]
        pname = rig.names[p]
        q = np.empty((f, 4))
        for k in range(f):
            parent_world = world[pname][k] if pname in world else _rest_chain(rig, p, world, k)
            q[k] = mat_to_quat(parent_world.T @ world[bone][k])
        clip_rot[bone] = _continuous(q)
    # the hips' height: the source's, from its first frame, scaled by leg length
    leg_src = np.linalg.norm(m.rest_pos[m.index(mapping["thigh_L"][0])] - m.rest_pos[m.index(mapping["calf_L"][1])])
    leg_rig = np.linalg.norm(rp[rig.idx("thigh_L")] - rp[rig.idx("foot_L")])
    scale = root_scale if root_scale is not None else leg_rig / leg_src
    hip = m.index(mapping["pelvis"][0])
    feet = [m.index(mapping[f"foot_{s}"][k]) for s in ("L", "R") for k in (0, 1)]
    floor = m.pos[:, feet, 1].min()
    stand = m.rest_pos[hip, 1] - m.rest_pos[feet, 1].min()  # the hips' height standing straight (the source's rest)
    pelvis = np.tile(rig.rest_t[rig.idx("pelvis")], (f, 1))
    pelvis[:, 1] += (m.pos[:, hip, 1] - floor - stand) * scale
    return Clip(name, fps, clip_rot, pelvis)


def _rest_chain(rig, i, world, k):
    """World rotation of rig node `i` at frame k when it isn't retargeted: its rest local under its parent."""
    p = rig.parent[i]
    parent = np.eye(3) if p < 0 else (world[rig.names[p]][k] if rig.names[p] in world else _rest_chain(rig, p, world, k))
    return parent @ quat_to_mat(rig.rest_q[i])


def _continuous(q):
    q = q.copy()
    for k in range(1, len(q)):
        if np.dot(q[k], q[k - 1]) < 0:
            q[k] = -q[k]
    return q


# ------------------------------------------------------------------ feet


def two_bone(rig, rot_world, pos, upper, lower, end, target, pole):
    """Analytic two-bone IK in world space: new world rotations for upper and lower (dict updates), the chain
    reaching `target` with the middle joint toward `pole`."""
    a, b, c = pos[upper], pos[lower], pos[end]
    l1, l2 = np.linalg.norm(b - a), np.linalg.norm(c - b)
    want = np.linalg.norm(target - a)
    dist = min(l1 + l2 - 1e-4, max(abs(l1 - l2) + 1e-4, want))
    n = (target - a) / (want or 1)
    pd = pole - a
    pd = pd - n * np.dot(pd, n)
    if np.linalg.norm(pd) < 1e-9:
        pd = b - a - n * np.dot(b - a, n)
    if np.linalg.norm(pd) < 1e-9:  # a straight chain on the line: bend forward
        pd = np.array([0.0, 0.0, 1.0]) - n * n[2]
    pd /= np.linalg.norm(pd)
    along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    out = math.sqrt(max(0.0, l1 * l1 - along * along))
    elbow = a + n * along + pd * out
    tip = a + n * dist
    s1 = _swing(_dir(a, b), _dir(a, elbow))
    r_up = s1 @ rot_world[upper]
    s2 = _swing(s1 @ _dir(b, c), _dir(elbow, tip))
    return r_up, s2 @ s1 @ rot_world[lower]


def _swing(u, v):
    """The shortest rotation taking unit u to unit v."""
    c = np.cross(u, v)
    d = float(np.dot(u, v))
    if d < -0.999999:
        axis = np.cross(u, [1, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(u, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    k = np.array([[0, -c[2], c[1]], [c[2], 0, -c[0]], [-c[1], c[0], 0]])
    return np.eye(3) + k + k @ k / (1 + d)


def pose_world(rig, clip, k):
    """World rotations and positions of the rig at frame k of `clip`."""
    local = {rig.idx(b): q[k] for b, q in clip.rot.items()}
    return rig.fk(local, None if clip.pelvis is None else clip.pelvis[k])


def solve_legs(rig, clip, ankles, weights=None):
    """Re-solves the legs so each ankle reaches `ankles[side][k]` (world, rig space), blended by `weights[side][k]`
    (1 = on the target). The knee keeps the clip's bend plane; the foot keeps the clip's world turn."""
    f = clip.frames
    for side in ("L", "R"):
        th, ca, fo = (rig.idx(f"{n}_{side}") for n in ("thigh", "calf", "foot"))
        qt, qc, qf = clip.rot[f"thigh_{side}"].copy(), clip.rot[f"calf_{side}"].copy(), clip.rot[f"foot_{side}"].copy()
        for k in range(f):
            w = 1.0 if weights is None else float(weights[side][k])
            if w <= 1e-6:
                continue
            rot, pos = pose_world(rig, clip, k)
            target = pos[fo] + (ankles[side][k] - pos[fo]) * w
            pole = pos[ca] + (pos[ca] - (pos[th] + pos[fo]) / 2) * 4 + np.array([0, 0, 0.02])
            foot_world = rot[fo].copy()
            r_up, r_lo = two_bone(rig, rot, pos, th, ca, fo, target, pole)
            parent = rot[rig.parent[th]]
            qt[k] = mat_to_quat(parent.T @ r_up)
            qc[k] = mat_to_quat(r_up.T @ r_lo)
            qf[k] = mat_to_quat(r_lo.T @ foot_world)
        clip.rot[f"thigh_{side}"] = _continuous(qt)
        clip.rot[f"calf_{side}"] = _continuous(qc)
        clip.rot[f"foot_{side}"] = _continuous(qf)
    return clip


def ankle_paths(rig, clip):
    """Each ankle's world position per frame, (F, 3) per side."""
    out = {"L": np.empty((clip.frames, 3)), "R": np.empty((clip.frames, 3))}
    for k in range(clip.frames):
        _, pos = pose_world(rig, clip, k)
        for s in ("L", "R"):
            out[s][k] = pos[rig.idx(f"foot_{s}")]
    return out


def plant(rig, clip, height=0.12, speed=0.25, fade=3):
    """Feet that stay put while down: a foot whose ankle is within 2 cm of its lowest and moving under `speed` m/s
    is held where it came down (on the floor at the rest ankle height); the holds fade in and out over `fade` frames.
    For idles and one-shots (in place, feet mostly still)."""
    paths = ankle_paths(rig, clip)
    targets, weights = {}, {}
    for s, p in paths.items():
        v = np.r_[0, np.linalg.norm(np.diff(p, axis=0), axis=1)] * clip.fps
        low = p[:, 1].min()
        down = (p[:, 1] < low + 0.02) & (v < speed)
        t = p.copy()
        w = np.zeros(len(p))
        k = 0
        while k < len(p):
            if not down[k]:
                k += 1
                continue
            e = k
            while e < len(p) and down[e]:
                e += 1
            spot = p[k:e].mean(axis=0)
            spot[1] = height
            t[k:e] = spot
            w[k:e] = 1
            k = e
        # fades
        w = np.convolve(np.pad(w, fade, mode="edge"), np.ones(2 * fade + 1) / (2 * fade + 1), mode="same")[fade:-fade]
        targets[s], weights[s] = t, np.clip(w * (1 + 1e-9), 0, 1)
    return solve_legs(rig, clip, targets, weights)


# ------------------------------------------------------------------ style


def exaggerate(clip, bones, k, about=None):
    """Each listed bone's rotation away from `about` (default its mean over the clip) scaled by k (§5.3: ×1.2–1.4)."""
    for b in bones:
        q = clip.rot[b]
        mean = about[b] if about else _mean_quat(q)
        out = np.empty_like(q)
        for i, qi in enumerate(q):
            # delta from the mean as a rotation vector, scaled
            d = _mul(qi, _inv(mean))
            out[i] = _mul(_pow(d, k), mean)
        clip.rot[b] = _continuous(out)
    return clip


def retime(clip, times, name=None):
    """A new timing: frame k of the result shows the clip at `times[k]` (s), slerped."""
    out = {b: _continuous(np.array([_sample_q(q, t * clip.fps) for t in times])) for b, q in clip.rot.items()}
    pelvis = None if clip.pelvis is None else np.array([_sample_v(clip.pelvis, t * clip.fps) for t in times])
    return Clip(name or clip.name, clip.fps, out, pelvis)


def _sample_q(q, s):
    a = int(min(max(s, 0), len(q) - 1))
    b = min(a + 1, len(q) - 1)
    return slerp_q(q[a], q[b], min(max(s - a, 0), 1))


def _sample_v(v, s):
    a = int(min(max(s, 0), len(v) - 1))
    b = min(a + 1, len(v) - 1)
    t = min(max(s - a, 0), 1)
    return v[a] * (1 - t) + v[b] * t


def _mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def _inv(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def _pow(q, k):
    q = q if q[3] >= 0 else -q
    v = q[:3]
    s = np.linalg.norm(v)
    if s < 1e-9:
        return np.array([0, 0, 0, 1.0])
    angle = 2 * math.atan2(s, q[3]) * k
    return np.r_[v / s * math.sin(angle / 2), math.cos(angle / 2)]


def _mean_quat(q):
    m = q.T @ q
    w, v = np.linalg.eigh(m)
    return v[:, -1]


# ------------------------------------------------------------------ the clip library file


class GlbClips:
    """rookie_anims.glb: append LINEAR clips (rotation per bone, the pelvis's translation) and write it back."""

    def __init__(self, path):
        self.g, bin_ = _glb(path)
        self.bin = bytearray(bin_)
        self.node = {n.get("name"): i for i, n in enumerate(self.g["nodes"])}

    def names(self):
        return [a["name"] for a in self.g["animations"]]

    def _push(self, data, kind, minmax=False):
        data = np.asarray(data, np.float32)
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data.tobytes()
        self.g["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": data.nbytes})
        acc = {"bufferView": len(self.g["bufferViews"]) - 1, "componentType": 5126, "count": len(data), "type": kind}
        if minmax:
            acc["min"] = [float(data.min())]
            acc["max"] = [float(data.max())]
        self.g["accessors"].append(acc)
        return len(self.g["accessors"]) - 1

    def add(self, clip: Clip, replace=False):
        if clip.name in self.names():
            assert replace, f"{clip.name} is already in the library"
            self.remove(clip.name)
        times = np.arange(clip.frames) / clip.fps
        t = self._push(times.reshape(-1, 1), "SCALAR", minmax=True)
        anim = {"name": clip.name, "channels": [], "samplers": []}
        for bone, q in clip.rot.items():
            s = len(anim["samplers"])
            anim["samplers"].append({"input": t, "interpolation": "LINEAR", "output": self._push(_continuous(q), "VEC4")})
            anim["channels"].append({"sampler": s, "target": {"node": self.node[bone], "path": "rotation"}})
        if clip.pelvis is not None:
            s = len(anim["samplers"])
            anim["samplers"].append({"input": t, "interpolation": "LINEAR", "output": self._push(clip.pelvis, "VEC3")})
            anim["channels"].append({"sampler": s, "target": {"node": self.node["pelvis"], "path": "translation"}})
        self.g["animations"].append(anim)

    def remove(self, name):
        """Drops a clip (its data stays in the buffer until a rebuild; tiny)."""
        self.g["animations"] = [a for a in self.g["animations"] if a["name"] != name]

    def compact(self):
        """Repacks the buffer with only what something still uses (a replaced clip's keys go)."""
        g = self.g
        used = []
        for a in g.get("animations", []):
            for s in a["samplers"]:
                used += [s["input"], s["output"]]
        for sk in g.get("skins", []):
            if "inverseBindMatrices" in sk:
                used.append(sk["inverseBindMatrices"])
        for mesh in g.get("meshes", []):
            for prim in mesh["primitives"]:
                used += list(prim["attributes"].values()) + ([prim["indices"]] if "indices" in prim else [])
        order = sorted(set(used))
        remap = {old: new for new, old in enumerate(order)}
        accessors, views, data = [], [], bytearray()
        for old in order:
            a = dict(g["accessors"][old])
            bv = g["bufferViews"][a["bufferView"]]
            start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
            comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
            size = {5126: 4, 5125: 4, 5123: 2, 5121: 1}[a["componentType"]] * comps
            stride = bv.get("byteStride", size)
            chunk = b"".join(bytes(self.bin[start + k * stride:start + k * stride + size]) for k in range(a["count"]))
            while len(data) % 4:
                data.append(0)
            views.append({"buffer": 0, "byteOffset": len(data), "byteLength": len(chunk)})
            data += chunk
            a["bufferView"] = len(views) - 1
            a.pop("byteOffset", None)
            accessors.append(a)
        for a in g.get("animations", []):
            for s in a["samplers"]:
                s["input"], s["output"] = remap[s["input"]], remap[s["output"]]
        for sk in g.get("skins", []):
            if "inverseBindMatrices" in sk:
                sk["inverseBindMatrices"] = remap[sk["inverseBindMatrices"]]
        for mesh in g.get("meshes", []):
            for prim in mesh["primitives"]:
                prim["attributes"] = {k: remap[v] for k, v in prim["attributes"].items()}
                if "indices" in prim:
                    prim["indices"] = remap[prim["indices"]]
        g["accessors"], g["bufferViews"], self.bin = accessors, views, data

    def write(self, path):
        self.g["buffers"][0]["byteLength"] = len(self.bin)
        js = json.dumps(self.g, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        bn = bytes(self.bin) + b"\0" * (-len(self.bin) % 4)
        total = 12 + 8 + len(js) + 8 + len(bn)
        out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(bn), 0x004E4942) + bn
        open(path, "wb").write(out)


# ------------------------------------------------------------------ cycles


def smootherstep(u):
    u = min(1.0, max(0.0, u))
    return u * u * u * (u * (6 * u - 15) + 10)


def dedrift(m: Motion, hips):
    """A cycle with its heading drift taken out (a straight line fitted to the hips' heading over the clip), the
    hips' own sway left in."""
    li, ri = m.index(hips[0]), m.index(hips[1])
    lat = m.pos[:, li] - m.pos[:, ri]
    head = np.unwrap(np.arctan2(lat[:, 2], lat[:, 0]))
    k = np.arange(m.frames)
    fit = np.polyval(np.polyfit(k, head, 1), k)
    drift = fit - fit.mean()
    rot = m.rot.copy()
    pos = m.pos.copy()
    for f in range(m.frames):
        r = rot_y(drift[f])
        c = m.pos[f, 0]
        rot[f] = np.einsum("ij,kjl->kil", r, m.rot[f])
        pos[f] = (m.pos[f] - c) @ r.T + c
    return Motion(m.names, m.parents, m.fps, rot, pos, m.rest_rot, m.rest_pos, dict(m.meta))


def contacts(m: Motion, joint, speed=0.35):
    """Frames where `joint` (an ankle) is down: near its lowest and slow (m/s)."""
    j = m.index(joint)
    y = m.pos[:, j, 1]
    v = np.linalg.norm(np.gradient(m.pos[:, j], axis=0), axis=1) * m.fps
    return (y < y.min() + 0.02) & (v < speed)


def close_loop(clip, share=0.3):
    """A loop that meets itself: over the last `share` of the clip each bone eases toward its first frame, so the
    last key equals the first."""
    n = clip.frames
    a = int(n * (1 - share))
    for b, q in clip.rot.items():
        q = q.copy()
        err = _mul(_inv(q[-1]), q[0])
        for k in range(a, n):
            w = smootherstep((k - a) / max(1, n - 1 - a))
            q[k] = _mul(q[k], _pow(err, w))
        clip.rot[b] = _continuous(q)
    if clip.pelvis is not None:
        p = clip.pelvis.copy()
        err = p[0] - p[-1]
        for k in range(a, n):
            p[k] += err * smootherstep((k - a) / max(1, n - 1 - a))
        clip.pelvis = p
    return clip


def march(rig, clip, speed, stance, lift=0.05, ankle=0.12, touch_down=0.0, reach=0.985):
    """Planted gait legs for a looping cycle `clip` (its last frame repeats its first): each ankle is down for a
    share `stance` of the cycle from its touch-down (left at `touch_down`, right half a cycle later), moving back at
    `speed` m/s at the rest ankle height `ankle`, then swings forward (a smootherstep, lifted `lift` m at mid-swing).
    The hips drop where a leg needs it to reach; the feet keep the clip's own turn. As `clips.gait()` keys the
    Forge's planted cycles."""
    n = clip.frames - 1
    period = n / clip.fps
    stride = speed * period
    half = stance * stride / 2
    rp = rig.rest_world_pos
    targets = {}
    for s, phase0 in (("L", touch_down), ("R", touch_down + 0.5)):
        rest = rp[rig.idx(f"foot_{s}")]
        t = np.empty((clip.frames, 3))
        for k in range(clip.frames):
            u = ((k / n) - phase0) % 1.0
            if u < stance:
                z = half - (u / stance) * 2 * half
                y = ankle
            else:
                w = (u - stance) / (1 - stance)
                z = -half + 2 * half * smootherstep(w)
                y = ankle + lift * math.sin(math.pi * w)
            t[k] = [rest[0], y, rest[2] + z]
        targets[s] = t
    # the hips come down where a leg can't reach its ankle
    thigh = {s: rig.idx(f"thigh_{s}") for s in ("L", "R")}
    leg = np.linalg.norm(rp[rig.idx("thigh_L")] - rp[rig.idx("foot_L")]) * reach
    drop = np.zeros(clip.frames)
    for k in range(clip.frames):
        _, pos = pose_world(rig, clip, k)
        for s in ("L", "R"):
            h = pos[thigh[s]]
            d = targets[s][k] - h
            flat = math.hypot(d[0], d[2])
            if flat < leg:
                need = (h[1] - targets[s][k][1]) - math.sqrt(leg * leg - flat * flat)
                drop[k] = max(drop[k], need)
    # smooth, and never less than needed: a moving max then a box blur, on the loop
    wrap = np.r_[drop[-4:-1], drop, drop[1:4]]
    mx = np.array([wrap[i:i + 7].max() for i in range(len(drop))])
    wrap = np.r_[mx[-4:-1], mx, mx[1:4]]
    drop = np.array([wrap[i:i + 7].mean() for i in range(len(drop))])
    drop = np.maximum(drop, 0)
    clip.pelvis = clip.pelvis.copy()
    clip.pelvis[:, 1] -= drop
    return solve_legs(rig, clip, targets)


def upright(rig, clip, bones=("spine2", "neck", "head"), keep=0.0):
    """Each listed bone stood up: its average lean over the clip (forward or sideways) taken out in world space,
    leaving `keep` of it, its motion about that average left as it is. Mocap leans and looks down; a big head
    pitched forward reads heavy, and the game adds its own lean at speed (motion.ts)."""
    for b in bones:
        i, tip = rig.idx(b), rig.idx(RIG_TIPS[b])
        dirs = []
        worlds = []
        for k in range(clip.frames):
            rot, pos = pose_world(rig, clip, k)
            dirs.append(_dir(pos[i], pos[tip]))
            worlds.append(rot)
        mean = np.mean(dirs, axis=0)
        mean /= np.linalg.norm(mean)
        rest = _dir(rig.rest_world_pos[i], rig.rest_world_pos[tip])
        fix = _swing(mean, rest)
        if keep:
            fix = quat_to_mat(_pow(mat_to_quat(fix), 1 - keep))
        q = clip.rot[b].copy()
        for k in range(clip.frames):
            parent = worlds[k][rig.parent[i]]
            q[k] = mat_to_quat(parent.T @ fix @ worlds[k][i])
        clip.rot[b] = _continuous(q)
    return clip


def toe_clear(rig, clip, toe=0.03):
    """No toe in the floor: where a foot's toe joint is below `toe` m (its height standing flat), the foot pitches
    up about the ankle, around the body's left-right axis, until it isn't (§ the Forge's toe-off fix, review L6)."""
    for s in ("L", "R"):
        fo, to = rig.idx(f"foot_{s}"), rig.idx(f"toe_{s}")
        q = clip.rot[f"foot_{s}"].copy()
        for k in range(clip.frames):
            rot, pos = pose_world(rig, clip, k)
            v = pos[to] - pos[fo]
            if pos[to][1] >= toe:
                continue
            axis = np.array([1.0, 0.0, 0.0])  # the body's left (clips are authored facing +Z)
            lo, hi = 0.0, math.pi / 2
            for _ in range(30):  # the smallest pitch that lifts the toe to `toe`
                mid = (lo + hi) / 2
                r = _axis_angle(axis, -mid)
                if pos[fo][1] + (r @ v)[1] >= toe:
                    hi = mid
                else:
                    lo = mid
            r = _axis_angle(axis, -hi)
            parent = rot[rig.parent[fo]]
            q[k] = mat_to_quat(parent.T @ r @ rot[fo])
        clip.rot[f"foot_{s}"] = _continuous(q)
    return clip


def _axis_angle(axis, a):
    x, y, z = axis / np.linalg.norm(axis)
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    return np.array([[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                     [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                     [t * x * z - s * y, t * y * z + s * x, t * z * z + c]])
