"""Headless asset check for the game's glTF assets (docs/04 §5 and §8, docs/11 §3-§4).

    blender -b --factory-startup --python tools/asset-check/check.py -- <file.glb> [options]

Options:
    --kind character|part|kit   what the file is (default: character)
    --lod 0|1                   character LOD budget: 0 = 4k tris, 1 = 1.8k tris (default 0)
    --base <body.glb>           part only: the base body that defines the cosmetic envelope
    --max-tris N                override the triangle budget
    --max-tex N                 max texture edge in px (default 1024)
    --json <out.json>           also write the report as JSON

Prints a PASS/WARN/FAIL table and exits 1 if anything FAILs, so CI can gate on it.

Characters are checked against the shared skeleton (docs/04 §4.1) and against the damage hitboxes
in packages/content/src/hitboxes.ts, read from source so the check can't drift from the sim.
The fairness checks project the mesh onto the gameplay plane (the profile view: the character
faces ±X in game, so here that is glTF Z = Blender -Y against height) and compare silhouettes.
"""
import json
import math
import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector

REPO = Path(__file__).resolve().parents[2]

DEFORM_BONES = [
    "root", "pelvis", "spine1", "spine2", "neck", "head",
    "clavicle_L", "clavicle_R", "upperarm_L", "upperarm_R", "forearm_L", "forearm_R",
    "hand_L", "hand_R", "thigh_L", "thigh_R", "calf_L", "calf_R",
    "foot_L", "foot_R", "toe_L", "toe_R", "jaw", "eye_L", "eye_R",
]
SOCKETS = [
    "socket_weapon_R", "socket_weapon_L", "socket_offhand_IK", "socket_jetpack",
    "socket_hat", "socket_back", "socket_nameplate",
]
HEAD_BONES = {"head", "jaw", "eye_L", "eye_R"}

CHAR_TRIS = {0: 4000, 1: 1800}         # docs/04 §5.6
CHAR_DRAW_CALLS = 3                     # docs/04 §5 "1-3 draw calls"
CHAR_GPU_TEX_BYTES = 1.5 * 1024 * 1024  # docs/04 §5 "≤ 1.5 MB GPU texture memory"
KIT_TRIS = 3000
MAX_INFLUENCES = 4                      # three.js reads JOINTS_0/WEIGHTS_0 only
ENVELOPE_SCALE = 1.10                   # docs/04 §1.2
RASTER = 0.02                           # silhouette raster cell (m)


# ---------------------------------------------------------------- report

class Report:
    def __init__(self, path: str, kind: str):
        self.path, self.kind, self.rows = path, kind, []

    def add(self, status: str, check: str, detail: str):
        self.rows.append({"status": status, "check": check, "detail": detail})

    def ok(self, cond: bool, check: str, detail: str, warn_only: bool = False):
        self.add("PASS" if cond else ("WARN" if warn_only else "FAIL"), check, detail)

    def info(self, check: str, detail: str):
        self.add("INFO", check, detail)

    @property
    def failed(self) -> bool:
        return any(r["status"] == "FAIL" for r in self.rows)

    def print(self):
        width = max(len(r["check"]) for r in self.rows)
        print()
        print(f"asset-check: {self.path}  [{self.kind}]")
        print("-" * (width + 60))
        for r in self.rows:
            print(f"{r['status']:<5} {r['check']:<{width}}  {r['detail']}")
        print("-" * (width + 60))
        counts = {s: sum(r["status"] == s for r in self.rows) for s in ("PASS", "WARN", "FAIL")}
        verdict = "FAIL" if self.failed else "PASS"
        print(f"RESULT: {verdict}  ({counts['PASS']} pass, {counts['WARN']} warn, {counts['FAIL']} fail)")
        print()


# ---------------------------------------------------------------- helpers

def parse_args(argv):
    args = {"kind": "character", "lod": 0, "base": None, "max_tris": None, "max_tex": 1024, "json": None}
    files, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:].replace("-", "_")
            args[key] = argv[i + 1]
            i += 2
        else:
            files.append(a)
            i += 1
    if len(files) != 1:
        sys.exit("usage: blender -b --python check.py -- <file.glb> [--kind character|part|kit] ...")
    args["file"] = files[0]
    args["lod"] = int(args["lod"])
    args["max_tex"] = int(args["max_tex"])
    if args["max_tris"] is not None:
        args["max_tris"] = int(args["max_tris"])
    return args


def load_hitboxes():
    """Standing hitboxes from packages/content/src/hitboxes.ts (falls back to docs/02 §6)."""
    hb = {"head": (1.24, 0.24), "torso": (0.45, 0.95, 0.30), "legs": (0.10, 0.45, 0.22), "source": "defaults (docs/02 §6)"}
    src = REPO / "packages/content/src/hitboxes.ts"
    try:
        text = src.read_text()
        block = text[text.index("STANDING_HITBOXES"):]
        block = block[: block.index("};")]
        num = r"([-\d.]+)"
        h = re.search(rf"head:\s*{{\s*y:\s*{num},\s*r:\s*{num}", block)
        t = re.search(rf"torso:\s*{{\s*y0:\s*{num},\s*y1:\s*{num},\s*r:\s*{num}", block)
        l = re.search(rf"legs:\s*{{\s*y0:\s*{num},\s*y1:\s*{num},\s*r:\s*{num}", block)
        hb = {
            "head": tuple(map(float, h.groups())),
            "torso": tuple(map(float, t.groups())),
            "legs": tuple(map(float, l.groups())),
            "source": str(src.relative_to(REPO)),
        }
    except (OSError, ValueError, AttributeError):
        pass
    return hb


def import_glb(path: str):
    bpy.ops.wm.read_homefile(use_empty=True)
    before = set(bpy.data.objects)
    # disable_bone_shape: otherwise the importer adds an icosphere mesh to draw the bones
    bpy.ops.import_scene.gltf(filepath=str(path), disable_bone_shape=True)
    return [o for o in bpy.data.objects if o not in before]


def world_tris(objs):
    """World-space triangles of all meshes in the bind pose (the importer poses armatures with
    their first clip, so read the undeformed mesh data rather than the evaluated mesh)."""
    tris = []
    for o in objs:
        if o.type != "MESH":
            continue
        me = o.data
        me.calc_loop_triangles()
        mw = o.matrix_world
        verts = [mw @ v.co for v in me.vertices]
        tris.extend((verts[t.vertices[0]], verts[t.vertices[1]], verts[t.vertices[2]]) for t in me.loop_triangles)
    return tris


def bbox(points):
    xs, ys, zs = zip(*((p.x, p.y, p.z) for p in points))
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def raster_mesh_profile(tris, depth_axis=1):
    """Set of filled cells of the mesh silhouette projected onto (depth_axis, Z)."""
    cells = set()
    for a, b, c in tris:
        pa, pb, pc = (a[depth_axis], a.z), (b[depth_axis], b.z), (c[depth_axis], c.z)
        x0 = math.floor(min(pa[0], pb[0], pc[0]) / RASTER)
        x1 = math.floor(max(pa[0], pb[0], pc[0]) / RASTER)
        y0 = math.floor(min(pa[1], pb[1], pc[1]) / RASTER)
        y1 = math.floor(max(pa[1], pb[1], pc[1]) / RASTER)
        den = (pb[1] - pc[1]) * (pa[0] - pc[0]) + (pc[0] - pb[0]) * (pa[1] - pc[1])
        if abs(den) < 1e-12:
            continue
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                px, py = (cx + 0.5) * RASTER, (cy + 0.5) * RASTER
                w1 = ((pb[1] - pc[1]) * (px - pc[0]) + (pc[0] - pb[0]) * (py - pc[1])) / den
                w2 = ((pc[1] - pa[1]) * (px - pc[0]) + (pa[0] - pc[0]) * (py - pc[1])) / den
                if w1 >= -1e-6 and w2 >= -1e-6 and w1 + w2 <= 1 + 1e-6:
                    cells.add((cx, cy))
    return cells


def raster_hitboxes(hb, scale=1.0):
    """Cells inside the standing hitboxes (profile view), optionally grown about their centres."""
    hy, hr = hb["head"]
    shapes = [("circle", hy, hr * scale)]
    for key in ("torso", "legs"):
        y0, y1, r = hb[key]
        mid, half = (y0 + y1) / 2, (y1 - y0) / 2
        shapes.append(("capsule", mid - half * scale, mid + half * scale, r * scale))
    cells = set()
    for cx in range(-60, 61):
        for cy in range(-20, 120):
            px, py = (cx + 0.5) * RASTER, (cy + 0.5) * RASTER
            for s in shapes:
                if s[0] == "circle":
                    inside = px * px + (py - s[1]) ** 2 <= s[2] ** 2
                else:
                    qy = min(max(py, s[1]), s[2])
                    inside = px * px + (py - qy) ** 2 <= s[3] ** 2
                if inside:
                    cells.add((cx, cy))
                    break
    return cells


def vertex_weights(objs):
    """[(world_co, {group: weight})] for all skinned mesh vertices."""
    out = []
    for o in objs:
        if o.type != "MESH":
            continue
        names = {g.index: g.name for g in o.vertex_groups}
        mw = o.matrix_world
        for v in o.data.vertices:
            out.append((mw @ v.co, {names[g.group]: g.weight for g in v.groups if g.group in names and g.weight > 1e-4}))
    return out


def image_report(r: Report, max_tex: int, budget_bytes=None):
    images = [im for im in bpy.data.images if im.size[0] > 0 and im.users > 0]
    total = 0.0
    for im in images:
        w, h = im.size
        pot = (w & (w - 1)) == 0 and (h & (h - 1)) == 0
        r.ok(max(w, h) <= max_tex, f"texture size: {im.name}", f"{w}x{h} (max {max_tex})")
        r.ok(pot, f"texture POT: {im.name}", "power of two" if pot else "not a power of two (mips/KTX2 need POT)", warn_only=True)
        # KTX2 estimate: UASTC→BC7/ASTC = 1 byte/px, + 1/3 for mips. ETC1S RGB albedo is half that.
        total += w * h * 1.0 * 4 / 3
    if budget_bytes is not None:
        r.ok(total <= budget_bytes, "GPU texture memory (KTX2 est.)",
             f"{total / 1048576:.2f} MB of {budget_bytes / 1048576:.2f} MB, {len(images)} image(s)")
    else:
        r.info("GPU texture memory (KTX2 est.)", f"{total / 1048576:.2f} MB, {len(images)} image(s)")


def draw_calls(meshes):
    n = 0
    for o in meshes:
        used = {p.material_index for p in o.data.polygons}
        n += max(1, len(used))
    return n


# ---------------------------------------------------------------- checks

def check_character(r: Report, objs, args):
    meshes = [o for o in objs if o.type == "MESH"]
    arms = [o for o in objs if o.type == "ARMATURE"]
    tris = world_tris(meshes)
    budget = args["max_tris"] or CHAR_TRIS[args["lod"]]
    r.ok(len(tris) <= budget, f"triangles (LOD{args['lod']})", f"{len(tris)} of {budget}")
    dc = draw_calls(meshes)
    r.ok(dc <= CHAR_DRAW_CALLS, "draw calls (mesh x material)", f"{dc} of {CHAR_DRAW_CALLS}")
    image_report(r, args["max_tex"], CHAR_GPU_TEX_BYTES)

    # Skeleton
    r.ok(len(arms) == 1, "armature", f"{len(arms)} armature(s)")
    if not arms:
        return
    arm = arms[0]
    bones = {b.name for b in arm.data.bones}
    missing = [b for b in DEFORM_BONES if b not in bones]
    r.ok(not missing, "deform bones (docs/04 §4.1)",
         f"all {len(DEFORM_BONES)} present" if not missing else "missing: " + ", ".join(missing))
    missing_s = [s for s in SOCKETS if s not in bones]
    r.ok(not missing_s, "sockets (docs/04 §4.1)",
         f"all {len(SOCKETS)} present" if not missing_s else "missing: " + ", ".join(missing_s))
    extra = sorted(bones - set(DEFORM_BONES) - set(SOCKETS))
    r.ok(not extra, "no unexpected bones", "none" if not extra else ", ".join(extra), warn_only=True)
    skinned = [m for m in meshes if any(md.type == "ARMATURE" for md in m.modifiers) or m.parent == arm]
    r.ok(len(skinned) == len(meshes), "meshes skinned to the armature", f"{len(skinned)}/{len(meshes)}")

    # Weights
    vw = vertex_weights(meshes)
    unweighted = sum(1 for _, w in vw if not w)
    over = sum(1 for _, w in vw if len(w) > MAX_INFLUENCES)
    bad_sum = sum(1 for _, w in vw if w and abs(sum(w.values()) - 1) > 0.02)
    r.ok(unweighted == 0, "every vertex weighted", f"{unweighted} unweighted of {len(vw)}")
    r.ok(over == 0, f"≤ {MAX_INFLUENCES} influences per vertex", f"{over} vertices over")
    r.ok(bad_sum == 0, "weights normalised", f"{bad_sum} vertices off by > 2%", warn_only=True)
    used = {g for _, w in vw for g in w}
    socket_weighted = sorted(used & set(SOCKETS))
    r.ok(not socket_weighted, "sockets are non-deform (no weights)",
         "none weighted" if not socket_weighted else "weighted: " + ", ".join(socket_weighted))
    unknown = sorted(used - set(DEFORM_BONES))
    r.ok(not unknown, "weights only on skeleton bones", "ok" if not unknown else ", ".join(unknown))

    # Orientation, scale and fairness vs the hitboxes
    hb = load_hitboxes()
    lo, hi = bbox([p for t in tris for p in t])
    head_y, head_r = hb["head"]
    head_top = head_y + head_r
    r.info("bounds (m)", f"x {lo.x:+.2f}..{hi.x:+.2f}  depth(y) {lo.y:+.2f}..{hi.y:+.2f}  z {lo.z:+.2f}..{hi.z:+.2f}")
    r.ok(abs(lo.z) <= 0.03, "feet on the ground (min z = 0)", f"min z {lo.z:+.3f} m")
    r.ok(head_top * 0.95 <= hi.z <= head_top * ENVELOPE_SCALE, "height vs hitbox top",
         f"{hi.z:.3f} m, hitbox top {head_top:.2f} m (allowed {head_top * 0.95:.2f}-{head_top * ENVELOPE_SCALE:.2f})")
    pb = arm.data.bones
    if "toe_L" in bones and "foot_L" in bones:
        fwd = (arm.matrix_world @ pb["toe_L"].head_local).y < (arm.matrix_world @ pb["foot_L"].head_local).y
        r.ok(fwd, "faces glTF +Z (toes ahead of ankles)", "ok" if fwd else "character faces backwards")
    head_pts = [co for co, w in vw if w and max(w, key=w.get) in HEAD_BONES]
    if head_pts:
        hlo, hhi = bbox(head_pts)
        centre = (hlo.z + hhi.z) / 2
        r.ok(abs(centre - head_y) <= 0.08, "head centre vs head hitbox",
             f"{centre:.3f} m vs {head_y:.2f} m (±0.08); head height {hhi.z - hlo.z:.2f} m vs {2 * head_r:.2f} m")
        r.ok(hhi.z - hlo.z >= 0.25 * hi.z, "chibi head ≈ ⅓ of height",
             f"head {100 * (hhi.z - hlo.z) / hi.z:.0f}% of height", warn_only=True)

    # Silhouette in the gameplay plane: depth (glTF Z = Blender -Y) against height. Centre on the
    # body (pelvis bone), not the bbox, so the jetpack doesn't shift the reference.
    cx = (arm.matrix_world @ pb["pelvis"].head_local).y if "pelvis" in bones else (lo.y + hi.y) / 2
    shifted = [tuple(Vector((p.x, p.y - cx, p.z)) for p in t) for t in tris]
    mesh_cells = raster_mesh_profile(shifted)
    hit_cells = raster_hitboxes(hb)
    env_cells = raster_hitboxes(hb, ENVELOPE_SCALE)
    coverage = len(mesh_cells & hit_cells) / max(1, len(hit_cells))
    outside = len(mesh_cells - env_cells) / max(1, len(mesh_cells))
    r.info("hitbox source", hb["source"])
    r.ok(coverage >= 0.60, "silhouette covers hitboxes (no tiny skins)",
         f"{coverage:.0%} of the hitbox area is drawn (min 60%)")
    r.ok(outside <= 0.25, "silhouette within hitbox envelope",
         f"{outside:.0%} of the silhouette is outside hitboxes x{ENVELOPE_SCALE:.2f} (max 25%; jetpack/arms)",
         warn_only=True)

    # Envelope written for cosmetics to be checked against (docs/04 §1.2)
    env = {"min": list(lo), "max": list(hi), "scale": ENVELOPE_SCALE}
    r.info("base bbox (cosmetics may grow it ≤ x1.10)", json.dumps({k: [round(v, 3) for v in env[k]] for k in ("min", "max")}))

    # Animations and extras
    acts = [a.name for a in bpy.data.actions]
    r.info("animation clips", f"{len(acts)}: " + ", ".join(sorted(acts)) if acts else "none")
    props = {k for o in objs for k in o.keys() if not k.startswith("_")}
    want = {"slot", "bodyTypes", "envelopeOk"}
    r.ok(want <= props, "custom properties (docs/04 §8)", ", ".join(sorted(props & want)) or "none", warn_only=True)


def check_part(r: Report, objs, args):
    meshes = [o for o in objs if o.type == "MESH"]
    tris = world_tris(meshes)
    budget = args["max_tris"] or 1500
    r.ok(len(tris) <= budget, "triangles", f"{len(tris)} of {budget}")
    image_report(r, args["max_tex"])
    if not args["base"]:
        r.add("FAIL", "cosmetic envelope", "pass --base <body.glb> to check the envelope")
        return
    part_lo, part_hi = bbox([p for t in tris for p in t])
    base_objs = import_glb(args["base"])
    base_tris = world_tris([o for o in base_objs if o.type == "MESH"])
    blo, bhi = bbox([p for t in base_tris for p in t])
    c, half = (blo + bhi) / 2, (bhi - blo) / 2 * ENVELOPE_SCALE
    elo, ehi = c - half, c + half
    elo.z = blo.z  # the envelope grows up and out, not into the floor
    inside = all(elo[i] - 1e-4 <= part_lo[i] and part_hi[i] <= ehi[i] + 1e-4 for i in range(3))
    r.ok(inside, f"cosmetic envelope (base x{ENVELOPE_SCALE:.2f})",
         f"part {tuple(round(v, 2) for v in part_lo)}..{tuple(round(v, 2) for v in part_hi)} vs "
         f"envelope {tuple(round(v, 2) for v in elo)}..{tuple(round(v, 2) for v in ehi)}")


def check_kit(r: Report, objs, args):
    meshes = [o for o in objs if o.type == "MESH"]
    budget = args["max_tris"] or KIT_TRIS
    total = 0
    for o in sorted(meshes, key=lambda o: o.name):
        tris = world_tris([o])
        total += len(tris)
        lo, hi = bbox([p for t in tris for p in t])
        size = hi - lo
        r.ok(len(tris) <= budget, f"triangles: {o.name}", f"{len(tris)} of {budget}")
        pivot = abs(lo.z) <= 0.01 or abs(hi.z) <= 0.01
        r.ok(pivot, f"pivot: {o.name}", f"y {lo.z:+.2f}..{hi.z:+.2f} m: "
             + ("top or bottom on the origin" if pivot else "neither the walkable top nor the bottom is at y = 0"))
        on_grid = all(abs(round(s / 0.25) * 0.25 - s) <= 0.02 for s in (size.x, size.z))
        r.ok(on_grid, f"0.25 m grid: {o.name}", f"{size.x:.2f} x {size.z:.2f} m (w x h), depth {size.y:.2f} m",
             warn_only=True)
    r.info("kit total triangles", str(total))
    r.ok(draw_calls(meshes) <= 3 * max(1, len(meshes)), "materials per piece", f"{draw_calls(meshes)} draw calls total")
    image_report(r, args["max_tex"])


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parse_args(argv)
    path = Path(args["file"])
    r = Report(str(path), args["kind"])
    if not path.exists():
        r.add("FAIL", "file exists", str(path))
    else:
        size = path.stat().st_size
        objs = import_glb(path)
        r.info("file size", f"{size / 1024:.0f} KB")
        {"character": check_character, "part": check_part, "kit": check_kit}[args["kind"]](r, objs, args)
    r.print()
    if args["json"]:
        Path(args["json"]).write_text(json.dumps({"file": r.path, "kind": r.kind, "pass": not r.failed, "rows": r.rows}, indent=2))
    sys.exit(1 if r.failed else 0)


main()
