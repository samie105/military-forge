"""Head clearance: does a weapon held in the aim poses pass through the Rookie's head?

    python3 tools/asset-check/head_clearance.py [ids...] [--weapons art/weapons] [--character art/character]
        [--body art/character/rookie_female/rookie_female_body.glb]

--body checks another base body's head (the female soldier's, on the Rookie's skeleton and clips) instead of the
Rookie's <character>/rookie_body.glb.

For each weapon (default: every art/weapons/<id>.glb whose family has an aim pose), and each aim clip of its
pose family (aim_<pose>_level, _up45, _down45, and the ±90s for the record):
  1. pose the Rookie's rig at the clip's first key (glTF forward kinematics on rookie_anims.glb);
  2. mount the weapon at socket_weapon_R with an identity transform, as render3d does;
  3. take each weapon vertex into the head bone's bind space, and count it as inside when it lies behind the
     nearest head vertex's normal and inside the head's box. The head is the body vertices weighted mostly to
     head, jaw or the eyes (rookie_body.glb), rigid with the head bone.
Fails (exit 1) when a scanned weapon (weapons.json `source: "scan"`) has a vertex more than 2 cm inside at a
level or ±45° aim. Scripted weapons are reported but not gated (they are being replaced by scans), and so are
straight up and down (±90°): the chibi's head sits on the sight line there, and the scripted guns clipped too.
No Blender needed: numpy only, on the art GLBs (not the meshopt runtime copies).
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
HEAD_BONES = {"head", "jaw", "eye_L", "eye_R"}
FAIL_DEPTH = 0.02  # metres
GATED = ("level", "up45", "down45")
COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    b = Path(path).read_bytes()
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    if "EXT_meshopt_compression" in g.get("extensionsUsed", []):
        raise SystemExit(f"{path}: meshopt-compressed; use the art copy")
    return g, b[20 + jl + 8:]


def accessor(g, bin_, i):
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    dt, n = np.dtype(COMP[a["componentType"]]), NCOMP[a["type"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * n
    raw = np.ndarray((a["count"], n), dtype=dt, buffer=bin_, offset=off, strides=(stride, dt.itemsize))
    if a.get("normalized"):
        return raw.astype(np.float64) / np.iinfo(dt).max
    return raw.astype(np.float64 if dt.kind == "f" else np.int64)


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def qrot(q, v):
    """Rotate row vectors v (N×3) by quaternion q (x, y, z, w)."""
    u, w = np.asarray(q[:3]), q[3]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def qinv(q):
    return np.array([-q[0], -q[1], -q[2], q[3]])


def fk(g, keys):
    """World (position, rotation) of every node, from rest TRS overridden by `keys` {(node, path): value}."""
    nodes = g["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    world = {}

    def get(i):
        if i in world:
            return world[i]
        n = nodes[i]
        t = np.asarray(keys.get((i, "translation"), n.get("translation", [0, 0, 0])), float)
        r = np.asarray(keys.get((i, "rotation"), n.get("rotation", [0, 0, 0, 1])), float)
        if i not in parent:
            world[i] = (t, r)
        else:
            pp, pq = get(parent[i])
            world[i] = (pp + qrot(pq, t[None])[0], qmul(pq, r))
        return world[i]

    return {nodes[i].get("name", str(i)): get(i) for i in range(len(nodes))}


def clip_keys(g, bin_, anim):
    """First key of every channel: the pose the aim layer holds."""
    keys = {}
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        v = accessor(g, bin_, s["output"])
        keys[(ch["target"]["node"], ch["target"]["path"])] = v[1] if s.get("interpolation") == "CUBICSPLINE" else v[0]
    return keys


def head_region(body_path):
    g, b = read_glb(body_path)
    skin = g["skins"][0]
    names = np.array([g["nodes"][j]["name"] for j in skin["joints"]])
    for n in g["nodes"]:
        if "mesh" not in n or "skin" not in n:
            continue
        pr = g["meshes"][n["mesh"]]["primitives"][0]
        P = accessor(g, b, pr["attributes"]["POSITION"])
        N = accessor(g, b, pr["attributes"]["NORMAL"])
        J = accessor(g, b, pr["attributes"]["JOINTS_0"]).astype(int)
        W = accessor(g, b, pr["attributes"]["WEIGHTS_0"])
        dom = names[J[np.arange(len(J)), W.argmax(1)]]
        sel = np.isin(dom, list(HEAD_BONES))
        return P[sel], N[sel]
    raise SystemExit(f"{body_path}: no skinned mesh")


def weapon_vertices(path):
    g, b = read_glb(path)
    out = []

    def walk(i, M):
        n = g["nodes"][i]
        L = np.eye(4)
        if "matrix" in n:
            L = np.asarray(n["matrix"], float).reshape(4, 4).T
        else:
            t = n.get("translation", [0, 0, 0])
            x, y, z, w = n.get("rotation", [0, 0, 0, 1])
            s = n.get("scale", [1, 1, 1])
            R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
            L[:3, :3] = R * s
            L[:3, 3] = t
        W = M @ L
        if "mesh" in n:
            for pr in g["meshes"][n["mesh"]]["primitives"]:
                P = accessor(g, b, pr["attributes"]["POSITION"])
                out.append(P @ W[:3, :3].T + W[:3, 3])
        for c in n.get("children", []):
            walk(c, W)

    for r in g["scenes"][g.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return np.concatenate(out)


class Head:
    def __init__(self, character, body=None):
        self.ag, self.ab = read_glb(Path(character) / "rookie_anims.glb")
        self.HP, self.HN = head_region(body or Path(character) / "rookie_body.glb")
        self.lo, self.hi = self.HP.min(0), self.HP.max(0)
        self.bind = fk(self.ag, {})["head"]
        self.clips = {a["name"]: a for a in self.ag["animations"]}

    def inside(self, verts, clip):
        """(count, deepest metres) of `verts` (weapon frame) inside the head at the clip's first key."""
        P = fk(self.ag, clip_keys(self.ag, self.ab, self.clips[clip]))
        sp, sq = P["socket_weapon_R"]
        hp, hq = P["head"]
        world = qrot(sq, verts) + sp
        local = qrot(qinv(hq), world - hp)
        B = qrot(self.bind[1], local) + self.bind[0]
        box = np.all((B >= self.lo) & (B <= self.hi), axis=1)
        if not box.any():
            return 0, 0.0
        Bb = B[box]
        d = np.linalg.norm(Bb[:, None, :] - self.HP[None, :, :], axis=-1)
        k = d.argmin(1)
        ins = ((Bb - self.HP[k]) * self.HN[k]).sum(1) < 0
        depth = d[np.arange(len(Bb)), k][ins]
        return int(ins.sum()), float(depth.max()) if ins.any() else 0.0


def main():
    argv = sys.argv[1:]
    opt = lambda k, d: Path(argv[argv.index(k) + 1]) if k in argv else REPO / d  # noqa: E731
    wdir, cdir = opt("--weapons", "art/weapons"), opt("--character", "art/character")
    body = Path(argv[argv.index("--body") + 1]) if "--body" in argv else None
    skip = {argv[argv.index(k) + 1] for k in ("--weapons", "--character", "--body") if k in argv}
    ids = [a for a in argv if not a.startswith("--") and a not in skip]
    sockets = json.loads((wdir / "sockets.json").read_text())["weapons"]
    scanned = {w for w, m in json.loads((wdir / "weapons.json").read_text()).items() if isinstance(m, dict) and m.get("source") == "scan"}
    head = Head(cdir, body)
    poses = {p.split("_")[1] for p in head.clips if p.startswith("aim_")}
    ids = ids or [w for w, s in sockets.items() if s.get("aimPose") in poses and s.get("frame") != "shield"
                  and s.get("family") != "thrown"]
    failed = []
    for wid in ids:
        pose = sockets[wid]["aimPose"]
        verts = weapon_vertices(wdir / f"{wid}.glb")
        cells = []
        for clip in sorted(c for c in head.clips if c.startswith(f"aim_{pose}_")):
            n, depth = head.inside(verts, clip)
            tag = clip.split("_", 2)[2]
            over = tag in GATED and depth > FAIL_DEPTH
            bad = over and wid in scanned
            cells.append(f"{tag} {n}" + (f" ({depth * 100:.0f} cm)" if n else "") + (" FAIL" if bad else " over" if over else ""))
            if bad:
                failed.append(f"{wid} {clip}")
        verdict = "FAIL" if any(f.startswith(wid + " ") for f in failed) else "PASS" if wid in scanned else "info"
        print(f"{verdict}  {wid:10s} {pose:6s} " + " | ".join(cells))
    gated = [w for w in ids if w in scanned]
    print(f"head clearance: {len(gated) - len({f.split()[0] for f in failed})}/{len(gated)} scanned weapons pass"
          + (f"; inside the head: {', '.join(failed)}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
