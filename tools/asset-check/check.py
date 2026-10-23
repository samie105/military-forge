"""Headless asset check for the game's glTF assets (docs/04 §5 and §8, docs/11 §3-§4).

    blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/check.py -- <file.glb>[,<part.glb>...] [options]

Several comma-separated files are checked as one assembled character (body + parts): the
triangle, draw-call and texture budgets in docs/04 §5 are per character on screen.

Options:
    --kind character|part|weapon|kit   what the file is (default: character)
    --lod 0|1                   character LOD budget: 0 = 4k tris, 1 = 1.8k tris (default 0)
    --base <body.glb[,...]>     part only: the base body whose bounding box ×1.10, from the floor
                                up, is the cosmetic envelope for every slot (docs/04 §1.2). Only
                                meshes with slot `body` (or no slot) count: default parts are ignored.
                                Pass the LOD0 body for every LOD.
    --max-tris N                override the triangle budget
    --max-tex N                 max texture edge in px (default 1024)
    --json <out.json>           also write the report as JSON

Prints a PASS/WARN/FAIL table and exits 1 if anything FAILs (2 if the check itself crashed), so
CI can gate on it. Keep `--python-exit-code 1`: without it Blender exits 0 when a script raises.

Characters are checked against the shared skeleton (docs/04 §4.1) and against the damage hitboxes
in packages/content/src/hitboxes.ts, read from source so the check can't drift from the sim.
The fairness checks project the mesh onto the gameplay plane (the profile view: the character
faces ±X in game, so here that is glTF Z = Blender -Y against height) and compare silhouettes.
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
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
# slung and holstered weapons (docs/04 §9.3): the body carries them; cosmetic parts built before them may not,
# which is fine (parts merge by their deform bones, and the renderer reads sockets from the body)
OPTIONAL_SOCKETS = ["sling_back", "holster_thigh"]
HEAD_BONES = {"head", "jaw", "eye_L", "eye_R"}

CHAR_TRIS = {0: 4000, 1: 1800}         # docs/04 §5.6
CHAR_DRAW_CALLS = 3                     # docs/04 §5 "1-3 draw calls"
CHAR_GPU_TEX_BYTES = 1.5 * 1024 * 1024  # docs/04 §5 "≤ 1.5 MB GPU texture memory"
KIT_TRIS = 3000
# Map kits: gameplay-layer colours stay ≥ 25 ΔE (CIE76) from both team colours (docs/01 §7: players
# highest contrast; tools/art-preview TEAM), and nothing is drawn on the gameplay plane (|depth| <
# the 0.35 m capsule radius) more than 0.1 m outside the piece's collision, except thin poles
TEAM_RGB = {"blue": 0x2f7dff, "orange": 0xff7a1a}
TEAM_DE = 25.0
PLANE_DEPTH = 0.35
RVC_TOL, RVC_CELL = 0.1, 0.05
MAX_INFLUENCES = 4                      # three.js reads JOINTS_0/WEIGHTS_0 only
ENVELOPE_SCALE = 1.10                   # docs/04 §1.2
# Dye round trip (docs/04 §5.4) on covered texels. Means catch a shifted dye albedo (the AgX bug was
# 22-29/255 mean); the p95 limits leave room for JPEG/WebP chroma loss at colour edges.
DYE_DYED = (0.012, 0.04)                # dyed: (mean, p95) |linear luminance of dyeAlbedo × defaults − albedo|
DYE_UNDYED = (5 / 255, 16 / 255)        # undyed: (mean, p95) |dyeAlbedo − albedo| per channel (sRGB)
DYE_SMALL = (0.015, 0.06, 8 / 255, 32 / 255)  # the same for ≤ 128² textures, where WebP loss is heavier
FIREARMS = {"pistol", "dual", "rifle", "shotgun", "sniper", "launcher", "heavy"}  # docs/04 §4.2
FAMILIES = FIREARMS | {"melee", "thrown", "shield"}  # docs/04 §9.5 (+ shield: the off-hand riot shield)
AIM_POSES = {"pistol", "dual", "rifle"}  # the aim sets the clips provide (rookie.json aimPoseFallback)
PART_SLOTS = {"headgear", "eyewear", "top", "gloves", "legs", "boots", "jetpack", "hair"}  # docs/04 §3
PART_TEX = {0: 256, 1: 128}             # max texture edge per part LOD (albedo and dye mask)
REST_TOL = (0.001, 0.1)                 # m, degrees: a part's bind pose must match the body's
# docs/04 §1.2 locality: the body bones a slot is worn on. A part must also stay inside the box of
# the body vertices skinned to them (plus the slot's default part), ×1.10.
REGION_BONES = {
    "headgear": {"head", "jaw", "eye_L", "eye_R", "neck"},
    "eyewear": {"head", "jaw", "eye_L", "eye_R", "neck"},
    "boots": {"calf_L", "calf_R", "foot_L", "foot_R", "toe_L", "toe_R"},
    "gloves": {"hand_L", "hand_R"},
    "jetpack": {"spine1", "spine2"},
    "top": {"pelvis", "spine1", "spine2", "clavicle_L", "clavicle_R", "upperarm_L", "upperarm_R", "forearm_L", "forearm_R"},
    "legs": {"pelvis", "thigh_L", "thigh_R", "calf_L", "calf_R"},
    "hair": {"head", "jaw", "eye_L", "eye_R", "neck"},
}
HEAD_SLOTS = {"headgear", "eyewear"}  # eyewear's region also counts the default headgear
LOCAL_MARGIN = 0.03                     # m added to the region box on every side
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
            if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                print(f"check.py: {a} needs a value")
                sys.exit(2)
            args[key] = argv[i + 1]
            i += 2
        else:
            files.append(a)
            i += 1
    if len(files) != 1 or args["kind"] not in ("character", "part", "weapon", "kit", "clips"):
        print("usage: blender -b --python-exit-code 1 --python check.py -- <file.glb> [--kind character|part|weapon|kit|clips] ...")
        sys.exit(2)
    args["file"] = files[0]
    try:
        args["lod"] = int(args["lod"])
        args["max_tex"] = int(args["max_tex"])
        if args["max_tris"] is not None:
            args["max_tris"] = int(args["max_tris"])
    except ValueError as e:
        print(f"check.py: bad option value: {e}")
        sys.exit(2)
    if args["lod"] not in (0, 1):
        print("check.py: --lod must be 0 or 1")
        sys.exit(2)
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


def import_glb(path: str, reset: bool = True):
    if reset:
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


def _texture_dir(name, files):
    """<glb dir>/textures/, or one level up (art/character/parts/*.glb use art/character/textures/)."""
    for f in files:
        for d in (Path(f).parent / "textures", Path(f).parent.parent / "textures"):
            if (d / name).exists():
                return d
    return None


def dye_mask_images(objs, files):
    """Dye masks referenced by the parts' extras (`dyeMask`), found next to the GLBs (_texture_dir)."""
    out = []
    for o in objs:
        name = o.get("dyeMask")
        d = _texture_dir(name, files) if name else None
        if d:
            out.append(bpy.data.images.load(str(d / name), check_existing=True))
    return out


def _base_color_image(o):
    for m in o.data.materials:
        if not m or not m.node_tree:
            continue
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED" and n.inputs["Base Color"].links:
                src = n.inputs["Base Color"].links[0].from_node
                if src.type == "TEX_IMAGE" and src.image:
                    return src.image
    return None


def _px(img):
    w, h = img.size
    return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)


def _to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((np.maximum(c, 0) + 0.055) / 1.055) ** 2.4)


def uv_coverage(o, w, h):
    """Texels covered by the mesh's UV triangles (Blender pixel rows, bottom first)."""
    me = o.data
    cov = np.zeros((h, w), dtype=bool)
    if not me.uv_layers.active:
        return cov
    uvs = np.array([d.uv[:] for d in me.uv_layers.active.data], dtype=np.float64).reshape(-1, 2) * (w, h)
    me.calc_loop_triangles()
    for t in me.loop_triangles:
        (ax, ay), (bx, by), (cx, cy) = uvs[list(t.loops)]
        x0, x1 = max(int(min(ax, bx, cx)), 0), min(int(max(ax, bx, cx)) + 1, w - 1)
        y0, y1 = max(int(min(ay, by, cy)), 0), min(int(max(ay, by, cy)) + 1, h - 1)
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if x1 < x0 or y1 < y0 or abs(den) < 1e-12:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
        cov[y0:y1 + 1, x0:x1 + 1] |= (l1 >= 0) & (l2 >= 0) & (1 - l1 - l2 >= 0)
    return cov


def dye_roundtrip(r: Report, objs, files):
    """docs/04 §5.4: on every texel the mesh covers, the shader with the default dyes must give back
    the painted albedo. Dyed texels: dyeAlbedo × Π lerp(1, default_i, mask_i) vs the albedo, linear
    luminance (one default per channel flattens hue inside a channel by design). Undyed texels:
    dyeAlbedo must equal the albedo (WebP loss only). Catches a tone-mapped or wrong dye albedo
    anywhere on the part, and dye files that are missing."""
    lum = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    for o in objs:
        if o.type != "MESH" or not (o.get("dyeAlbedo") or o.get("dyeMask")):
            continue
        check = f"dye round trip: {o.name}"
        tex = _texture_dir(o["dyeMask"], files) if o.get("dyeMask") else None
        albedo = _base_color_image(o)
        dalb = next((tex / f"{o['dyeAlbedo']}{ext}" for ext in (".png", ".webp")
                     if tex and o.get("dyeAlbedo") and (tex / f"{o['dyeAlbedo']}{ext}").exists()), None)
        missing = [what for what, found in ((f"dye mask {o.get('dyeMask')}", tex), (f"dye albedo {o.get('dyeAlbedo')}", dalb),
                                            ("embedded albedo", albedo)) if found is None]
        if missing:
            r.add("FAIL", check, "missing: " + ", ".join(missing))
            continue
        # the lossless albedo PNG the GLB was made from, when it sits next to the dye files (art/
        # sources embed JPEG); otherwise the embedded albedo (the web build's WebP)
        png = tex / o["dyeMask"].replace("_dye_mask.png", "_albedo.png")
        a = _px(bpy.data.images.load(str(png), check_existing=True) if png.exists() else albedo)[..., :3]
        d4 = _px(bpy.data.images.load(str(dalb), check_existing=True))
        d = d4[..., :3]
        m = _px(bpy.data.images.load(str(tex / o["dyeMask"]), check_existing=True))
        if a.shape != d.shape or a.shape[:2] != m.shape[:2]:
            r.add("FAIL", check, f"sizes differ: albedo {a.shape[:2]}, dye albedo {d.shape[:2]}, mask {m.shape[:2]}")
            continue
        cov = uv_coverage(o, a.shape[1], a.shape[0])
        # one texel in from every island border: WebP/JPEG bleeds neighbouring islands into it
        p = np.pad(cov, 1)
        cov = cov & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
        if not cov.any():
            r.add("FAIL", check, "the mesh's UVs cover no texels")
            continue
        tint = np.ones_like(a)
        defaults = o.get("dyeDefaults") or {}
        for i, key in enumerate(("primary", "secondary", "accent")):
            if key in defaults:
                hexc = str(defaults[key]).lstrip("#")
                dye = np.array([int(hexc[j:j + 2], 16) / 255 for j in (0, 2, 4)], dtype=np.float32)
                tint *= 1 + m[..., i:i + 1] * (_to_linear(dye) - 1)
        mm = m[..., :3].max(axis=-1)
        if o.get("dyeSkin") == "alpha" and d4.shape[-1] == 4:
            # the skin weight is the dye albedo's alpha, neutralised against `skinHeadroom` × `skinNeutral`:
            # skin texels go back to the albedo through lerp(1, headroom × skinNeutral, alpha)
            hexc = str(o.get("skinNeutral", "#da9f75")).lstrip("#")
            sk = np.array([int(hexc[j:j + 2], 16) / 255 for j in (0, 2, 4)], dtype=np.float32)
            head = float(o.get("skinHeadroom", 1))
            tint *= 1 + d4[..., 3:4] * (head * _to_linear(sk) - 1)
            mm = np.maximum(mm, d4[..., 3])
        dyed, undyed = cov & (mm > 0.02), cov & (mm <= 0.02)
        parts = []
        ok = True
        few = 0.02 * cov.sum()  # a class this small (a few texels) says nothing either way
        lim_d, lim_u = (DYE_SMALL[:2], DYE_SMALL[2:]) if max(a.shape[:2]) <= 128 else (DYE_DYED, DYE_UNDYED)
        if dyed.sum() > few:
            e = np.abs((_to_linear(d) * tint - _to_linear(a)) @ lum)[dyed]
            mean, p95 = float(e.mean()), float(np.percentile(e, 95))
            ok &= mean <= lim_d[0] and p95 <= lim_d[1]
            parts.append(f"dyed {dyed.sum() / cov.sum():.0%}: mean {mean:.3f} p95 {p95:.3f} (max {lim_d[0]}/{lim_d[1]})")
        if undyed.sum() > few:
            e = np.abs(d - a).max(axis=-1)[undyed]
            mean, p95 = float(e.mean()), float(np.percentile(e, 95))
            ok &= mean <= lim_u[0] and p95 <= lim_u[1]
            parts.append(f"undyed {undyed.sum() / cov.sum():.0%}: mean {mean * 255:.1f} p95 {p95 * 255:.1f}/255 "
                         f"(max {lim_u[0] * 255:.0f}/{lim_u[1] * 255:.0f})")
        r.ok(ok, check, "; ".join(parts))


def content_cosmetic_ids():
    """Item ids in W2's catalogue, packages/content/src/cosmetics.ts (`item(n, 'id', ...)`)."""
    try:
        return set(re.findall(r"\bitem\(\s*\d+,\s*'([^']+)'", (REPO / "packages/content/src/cosmetics.ts").read_text()))
    except OSError:
        return set()


def content_weapon_ids():
    """Weapon and grenade ids defined in packages/content (read from source, like the hitboxes)."""
    ids = set()
    for name in ("weapons.ts", "grenades.ts"):
        try:
            ids |= set(re.findall(r"\bid:\s*'([^']+)'", (REPO / "packages/content/src" / name).read_text()))
        except OSError:
            pass
    return ids


def content_grenade_radius(gid):
    """A grenade's sim ball radius from packages/content/src/grenades.ts, or None."""
    try:
        m = re.search(rf"\bid:\s*'{re.escape(gid)}',[^}}]*?\bradius:\s*([\d.]+)", (REPO / "packages/content/src/grenades.ts").read_text())
    except OSError:
        return None
    return float(m.group(1)) if m else None


def image_report(r: Report, max_tex: int, budget_bytes=None, extra=()):
    """`extra` = the dye masks named by the extras (costed as masks); every other image is colour."""
    masks = {im.name for im in extra}
    images = [im for im in bpy.data.images if im.size[0] > 0 and im.users > 0 and im.name not in masks] + list(extra)
    total = 0.0
    for im in images:
        w, h = im.size
        pot = (w & (w - 1)) == 0 and (h & (h - 1)) == 0
        r.ok(max(w, h) <= max_tex, f"texture size: {im.name}", f"{w}x{h} (max {max_tex})")
        r.ok(pot, f"texture POT: {im.name}", "power of two" if pot else "not a power of two (mips/KTX2 need POT)", warn_only=True)
        # KTX2 estimate (docs/11 §4): ETC1S colour → BC1/ETC1 at 0.5 byte/px; masks are data and
        # go UASTC → BC7/ASTC at 1 byte/px. +1/3 for mips.
        total += w * h * (1.0 if im.name in masks else 0.5) * 4 / 3
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

def check_skeleton(r: Report, objs, meshes):
    """Shared skeleton, sockets and skin weights (docs/04 §4.1, §9.2). Returns (arm, bones, weights)."""
    arms = [o for o in objs if o.type == "ARMATURE"]
    # Assembled characters: every part file carries a copy of the shared skeleton (an optional socket on the
    # body and not on an older part is fine: parts merge by their deform bones).
    same = len({tuple(sorted(b.name for b in a.data.bones if b.name not in OPTIONAL_SOCKETS)) for a in arms}) == 1
    r.ok(len(arms) >= 1 and same, "armature",
         f"{len(arms)} armature(s)" + (" with identical bones (assembled parts)" if len(arms) > 1 and same else ""))
    if not arms:
        return None
    arm = arms[0]
    bones = {b.name for b in arm.data.bones}
    missing = [b for b in DEFORM_BONES if b not in bones]
    r.ok(not missing, "deform bones (docs/04 §4.1)",
         f"all {len(DEFORM_BONES)} present" if not missing else "missing: " + ", ".join(missing))
    missing_s = [s for s in SOCKETS if s not in bones]
    r.ok(not missing_s, "sockets (docs/04 §4.1)",
         f"all {len(SOCKETS)} present" if not missing_s else "missing: " + ", ".join(missing_s))
    extra = sorted(bones - set(DEFORM_BONES) - set(SOCKETS) - set(OPTIONAL_SOCKETS))
    r.ok(not extra, "no unexpected bones", "none" if not extra else ", ".join(extra))
    skinned = [m for m in meshes if any(md.type == "ARMATURE" for md in m.modifiers) or m.parent in arms]
    r.ok(len(skinned) == len(meshes), "meshes skinned to the armature", f"{len(skinned)}/{len(meshes)}")

    # Weights
    vw = vertex_weights(meshes)
    unweighted = sum(1 for _, w in vw if not w)
    over = sum(1 for _, w in vw if len(w) > MAX_INFLUENCES)
    bad_sum = sum(1 for _, w in vw if w and abs(sum(w.values()) - 1) > 0.02)
    r.ok(unweighted == 0, "every vertex weighted", f"{unweighted} unweighted of {len(vw)}")
    r.ok(over == 0, f"≤ {MAX_INFLUENCES} influences per vertex", f"{over} vertices over")
    r.ok(bad_sum == 0, "weights normalised", f"{bad_sum} vertices off by > 2%")
    used = {g for _, w in vw for g in w}
    socket_weighted = sorted(used & set(SOCKETS))
    r.ok(not socket_weighted, "sockets are non-deform (no weights)",
         "none weighted" if not socket_weighted else "weighted: " + ", ".join(socket_weighted))
    unknown = sorted(used - set(DEFORM_BONES))
    r.ok(not unknown, "weights only on skeleton bones", "ok" if not unknown else ", ".join(unknown))
    if len(arms) > 1:  # an assembled outfit: every part must be bound to the same bind pose
        ref = rest_pose(arms[0])
        worst = max((rest_diff(ref, rest_pose(a)) for a in arms[1:]), key=lambda t: (t[0], t[1]))
        r.ok(worst[0] <= REST_TOL[0] and worst[1] <= REST_TOL[1], "same bind pose in every file",
             f"worst {worst[2]}: {worst[0] * 1000:.1f} mm, {worst[1]:.2f}°")
    return arm, bones, vw


def rest_pose(arm):
    return {b.name: arm.matrix_world @ b.matrix_local for b in arm.data.bones}


def rest_diff(ref, other):
    """(metres, degrees, bone) of the worst bone that differs between two rest poses."""
    worst = (0.0, 0.0, "-")
    for name, m in other.items():
        if name not in ref:
            continue
        dt = (m.translation - ref[name].translation).length
        da = math.degrees((ref[name].to_3x3().transposed() @ m.to_3x3()).to_quaternion().angle)
        da = min(da, 360 - da)
        if (dt, da) > worst[:2]:
            worst = (dt, da, name)
    return worst


def check_character(r: Report, objs, args):
    meshes = [o for o in objs if o.type == "MESH"]
    tris = world_tris(meshes)
    budget = args["max_tris"] or CHAR_TRIS[args["lod"]]
    # parts that replace a stretch of the body (`hidesBody`) take its triangles' place: the assembler drops them
    hides = sorted({h for o in meshes for h in o.get("hidesBody", [])})
    hidden = region_tris([o for o in meshes if o.get("slot", "body") == "body"], hides) if hides else 0
    if hides:
        r.info("body triangles hidden by parts", f"{hidden} ({', '.join(hides)})")
    r.ok(len(tris) - hidden <= budget, f"triangles (LOD{args['lod']})", f"{len(tris) - hidden} of {budget}")
    # docs/04 §5.3: parts sharing the skeleton merge into one SkinnedMesh with one material
    # (texture array), so an assembled character costs one draw call; anything not skinned to the
    # shared skeleton stays separate.
    dc = draw_calls(meshes)
    arms = [o for o in objs if o.type == "ARMATURE"]
    skinned = [m for m in meshes if m.parent in arms or any(md.type == "ARMATURE" for md in m.modifiers)]
    # one merged draw call, plus one per extra material any skinned part brings (each part must be one material)
    merged = (1 + sum(draw_calls([m]) - 1 for m in skinned) if skinned else 0) + draw_calls([m for m in meshes if m not in skinned])
    r.ok(merged <= CHAR_DRAW_CALLS, "draw calls after part merge (docs/04 §5.3)",
         f"{merged} of {CHAR_DRAW_CALLS} ({dc} before merging)")
    image_report(r, args["max_tex"], CHAR_GPU_TEX_BYTES, dye_mask_images(meshes, args["files"]))
    dye_roundtrip(r, objs, args["files"])

    found = check_skeleton(r, objs, meshes)
    if not found:
        return
    arm, bones, vw = found

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


# Per-slot LOD0 / LOD1 triangle budgets (art/pipeline/build_cosmetics.py): body 2,350 plus one
# item per slot stays ≤ 3,950 / 1,720 tris, inside docs/04 §5.6.
SLOT_TRIS = {"headgear": (450, 200), "eyewear": (150, 70), "boots": (300, 130), "gloves": (150, 70),
             "jetpack": (550, 250)}
BODY_TRIS = (2350, 1000)
# Slots whose parts replace a stretch of the body (`hidesBody`: hair, a top, trousers): such a part may spend the
# triangles of the body it hides, plus this allowance (LOD0, LOD1), shared so that a body wearing all of them
# plus one item in every other slot stays inside docs/04 §5.6.
REPLACES = {"hair": (50, 40), "top": (0, 0), "legs": (0, 0)}
REGION_CODES = {"hair": 1, "top": 2, "legs": 3}  # build_character.py REGIONS
# the body plus one item in every slot must fit a character (docs/04 §5.6); top/legs/back get budgets
# only when the slots are re-balanced to keep this true
assert all(BODY_TRIS[i] + sum(t[i] for t in SLOT_TRIS.values()) + sum(a[i] for a in REPLACES.values()) <= CHAR_TRIS[i]
           for i in (0, 1)), "slot budgets exceed CHAR_TRIS"


def region_tris(objs, regions):
    """Body triangles whose three vertices all carry one of `regions`' codes (the body's _REGION attribute and
    its manifest's `regions` map, build_character.py 6b): what a part with `hidesBody` replaces."""
    codes = {REGION_CODES[r] for r in regions if r in REGION_CODES}
    n = 0
    for o in objs:
        attr = o.data.attributes.get("_REGION") if o.type == "MESH" else None
        if attr is None or not codes:
            continue
        vals = [round(d.value) for d in attr.data]
        o.data.calc_loop_triangles()
        n += sum(1 for t in o.data.loop_triangles if all(vals[k] in codes for k in t.vertices))
    return n


def check_part(r: Report, objs, args):
    meshes = [o for o in objs if o.type == "MESH"]
    tris = world_tris(meshes)
    pmap = {}
    for o in meshes:
        pmap.update({k: o[k] for k in o.keys() if not k.startswith("_")})
    slot = pmap.get("slot")
    r.ok(slot in PART_SLOTS, "slot extra (docs/04 §3, §9.5)",
         slot if slot in PART_SLOTS else f"{slot!r}: missing or not a part slot (extras exported?)")
    # no fallback budget: a part without a known slot already FAILs above
    budget = args["max_tris"] or SLOT_TRIS.get(slot, (0, 0))[args["lod"]]
    hides = list(pmap.get("hidesBody", []))
    if slot in REPLACES and not args["max_tris"]:
        # the triangles of the body it hides, on the body it is fitted to at this LOD (--base names LOD0; LOD1 is
        # the `<name>_body_lod1.glb` beside it), plus the allowance
        hidden = 0
        if args["base"]:
            body_path = args["base"].split(",")[0]
            if args["lod"] == 1 and Path(body_path.replace("_body.glb", "_body_lod1.glb")).exists():
                body_path = body_path.replace("_body.glb", "_body_lod1.glb")
            before = (set(bpy.data.meshes), set(bpy.data.materials), set(bpy.data.images))
            added = import_glb(body_path, reset=False)
            hidden = region_tris(added, hides)
            for o in added:
                bpy.data.objects.remove(o, do_unlink=True)
            # and its data: the body's textures are not the part's (image_report reads every image)
            for coll, old in zip((bpy.data.meshes, bpy.data.materials, bpy.data.images), before):
                for d in [d for d in coll if d not in old]:
                    coll.remove(d)
        budget = hidden + REPLACES[slot][args["lod"]]
        r.ok(hidden > 0, f"hides the body's {', '.join(hides) or '?'}", f"{hidden} body triangles hidden (hidesBody {hides})")
    r.ok(len(tris) <= budget, f"triangles (slot {slot}, LOD{args['lod']})", f"{len(tris)} of {budget}")
    dc = draw_calls(meshes)
    r.ok(len(meshes) == 1 and dc == 1, "one mesh, one material (docs/04 §5.3)", f"{len(meshes)} mesh(es), {dc} draw call(s)")
    image_report(r, min(args["max_tex"], PART_TEX[args["lod"]]), extra=dye_mask_images(meshes, args["files"]))
    need = ["bodyTypes", "envelopeOk", "cosmeticId", "hidesHair"] + ([] if pmap.get("dyeable") is False else ["dyeMask", "dyeAlbedo", "dyeDefaults"])
    missing = [k for k in need if k not in pmap]
    r.ok(not missing, "required extras (docs/04 §9.5)", "ok" if not missing else "missing: " + ", ".join(missing))
    known = content_cosmetic_ids()
    cid = pmap.get("cosmeticId")
    if known and cid:
        r.ok(cid in known, "cosmeticId in packages/content", cid if cid in known else
             f"{cid} is not in packages/content/src/cosmetics.ts (W2's catalogue names the items)", warn_only=True)
    dye_roundtrip(r, objs, args["files"])
    part_rest = {a.name: rest_pose(a) for a in objs if a.type == "ARMATURE"}
    # docs/04 §9.3: parts are skinned to the shared skeleton in character space, never socket-local
    weights = vertex_weights(meshes)
    skinned = any(o.type == "ARMATURE" for o in objs) and weights and all(w for _, w in weights)
    r.ok(bool(skinned), "skinned in character space (docs/04 §9.3)",
         "every vertex weighted to the shared skeleton" if skinned else "no skin: parts carry the skeleton, they don't hang off sockets")
    if any(o.type == "ARMATURE" for o in objs):
        check_skeleton(r, objs, meshes)
    attach = pmap.get("attachBone")
    if attach and weights:
        rigid = all(abs(w.get(attach, 0.0) - 1.0) < 1e-3 for _, w in weights)
        r.ok(rigid, f"rigid to {attach} (attachBone)", "100% one bone" if rigid else "some vertices weighted to other bones")
    if not args["base"]:
        r.add("FAIL", "cosmetic envelope", "pass --base <body.glb[,default_part.glb...]> to check the envelope")
        return
    part_lo, part_hi = bbox([p for t in tris for p in t])
    base_objs = []
    for i, base in enumerate(args["base"].split(",")):
        base_objs += import_glb(base, reset=i == 0)
    ref = [o for o in base_objs if o.type == "MESH" and o.get("slot", "body") == "body"]  # the body alone (docs/04 §1.2)
    body_arm = next((o for o in base_objs if o.type == "ARMATURE"), None)
    if body_arm and part_rest:
        worst = max(rest_diff(rest_pose(body_arm), rp) for rp in part_rest.values())
        r.ok(worst[0] <= REST_TOL[0] and worst[1] <= REST_TOL[1], "bind pose = the base body's",
             f"worst {worst[2]}: {worst[0] * 1000:.1f} mm, {worst[1]:.2f}° (max {REST_TOL[0] * 1000:.0f} mm, {REST_TOL[1]}°)")
    base_tris = world_tris(ref)
    blo, bhi = bbox([p for t in base_tris for p in t])
    c, half = (blo + bhi) / 2, (bhi - blo) / 2 * ENVELOPE_SCALE
    elo, ehi = c - half, c + half
    elo.z = min(blo.z, 0.0)  # from the floor up: footwear fills the gap below a bare body's calves
    inside = all(elo[i] - 1e-4 <= part_lo[i] and part_hi[i] <= ehi[i] + 1e-4 for i in range(3))
    # Locality: near the bones the slot is worn on (a 1 m-wide hat, or eyewear hanging to the shins,
    # fits the body box but not this): the body verts skinned to the slot's bones plus the slot's
    # default part, ×1.10, inside the body envelope.
    region = REGION_BONES.get(slot)
    if region:
        pts = [co for co, w in vertex_weights(ref) if w and max(w, key=w.get) in region]
        pts += [p for t in world_tris([o for o in base_objs if o.type == "MESH" and (o.get("slot") == slot or (
            slot in HEAD_SLOTS and o.get("slot") in HEAD_SLOTS))]) for p in t]
        if pts:
            rlo, rhi = bbox(pts)
            # ×1.10 plus 3 cm: a hand's box is only ~15 cm, and 10% of it is less than a glove's lining
            rc, rh = (rlo + rhi) / 2, (rhi - rlo) / 2 * ENVELOPE_SCALE + Vector((LOCAL_MARGIN,) * 3)
            llo = Vector([max(rc[i] - rh[i], elo[i]) for i in range(3)])
            lhi = Vector([min(rc[i] + rh[i], ehi[i]) for i in range(3)])
            near = all(llo[i] - 1e-4 <= part_lo[i] and part_hi[i] <= lhi[i] + 1e-4 for i in range(3))
            r.ok(near, f"near its {slot} bones (docs/04 §1.2 locality)",
                 f"part {tuple(round(v, 2) for v in part_lo)}..{tuple(round(v, 2) for v in part_hi)} vs "
                 f"region {tuple(round(v, 2) for v in llo)}..{tuple(round(v, 2) for v in lhi)}")
    claimed = pmap.get("envelopeOk")
    if claimed is not None and bool(claimed) != inside:
        r.add("FAIL", "envelopeOk extra", f"says {bool(claimed)}, measured {inside}")
    r.ok(inside, f"cosmetic envelope ({slot or 'part'}: base x{ENVELOPE_SCALE:.2f})",
         f"part {tuple(round(v, 2) for v in part_lo)}..{tuple(round(v, 2) for v in part_hi)} vs "
         f"envelope {tuple(round(v, 2) for v in elo)}..{tuple(round(v, 2) for v in ehi)}")


WEAPON_TRIS = 1000
WEAPON_TEX = 256  # docs/04 §9.4: ≤ 256² texture per weapon
SHIELD_SIZE = (0.55, 0.90)  # width, height: the sim's blocking segment (shield-sockets.md)
OFFHAND_REACH = 0.10  # chibi arms: the left hand can't get further from the grip (docs/04 §9.4)


def check_weapon(r: Report, objs, args):
    """docs/04 §9.4: origin at the grip, +Y muzzle (Blender +Z after import), +Z up; nodes."""
    meshes = [o for o in objs if o.type == "MESH"]
    parts = [o for o in meshes if o.name.startswith("part_")]  # moving parts: child meshes on the body's material
    body = [o for o in meshes if o not in parts]
    tris = world_tris(meshes)
    budget = args["max_tris"] or WEAPON_TRIS
    r.ok(len(tris) <= budget, "triangles", f"{len(tris)} of {budget}" + (f" (body and {len(parts)} parts)" if parts else ""))
    mats = {m for o in meshes for m in o.data.materials if m is not None}
    if parts:
        r.ok(len(body) == 1 and len(mats) == 1, "one mesh, one material",
             f"1 body + {len(parts)} moving part(s), {len(mats)} material(s): {draw_calls(meshes)} draw call(s)")
    else:
        dc = draw_calls(meshes)
        r.ok(dc == 1, "one mesh, one material", f"{dc} draw call(s)")
    image_report(r, min(args["max_tex"], WEAPON_TEX))
    props = {}
    for o in body:
        props.update({k: o[k] for k in o.keys() if not k.startswith("_")})
    missing = [k for k in ("weaponId", "family", "aimPose", "hands") if k not in props]
    r.ok(not missing, "extras weaponId/family/aimPose/hands", "ok" if not missing else "missing: " + ", ".join(missing))
    known = content_weapon_ids()
    wid = props.get("weaponId")
    if known and wid:
        r.ok(wid in known, "weaponId in packages/content", wid if wid in known else
             f"{wid} is not in packages/content/src/{{weapons,grenades}}.ts yet", warn_only=True)
    nodes = {o.name.split(".")[0]: o.matrix_world.translation.copy() for o in objs if o.type == "EMPTY"}
    # the renderer looks nodes up by exact name (three.js turns `grip.001` into `grip001`); Blender's import
    # renames clashes, so read the names from the file itself (review L4: the shield's LOD1 had `grip.001`)
    suffixed = sorted(n for n in glb_node_names(args["files"]) if re.search(r"\.\d{3}$", n))
    r.ok(not suffixed, "node names exact (no Blender .001 suffix)", ", ".join(suffixed) if suffixed else "ok")
    lo, hi = bbox([p for t in tris for p in t])
    r.info("nodes", ", ".join(sorted(nodes)) or "none")
    r.ok(lo.x - 0.02 <= 0 <= hi.x + 0.02 and lo.y - 0.02 <= 0 <= hi.y + 0.02 and lo.z - 0.02 <= 0 <= hi.z + 0.02,
         "origin on the weapon (the grip)", f"bbox {tuple(round(v, 2) for v in lo)}..{tuple(round(v, 2) for v in hi)}")
    family = props.get("family")
    r.ok(family in FAMILIES, "family is a docs/04 §4.2 family", f"{family!r}" + ("" if family in FAMILIES else f" not in {sorted(FAMILIES)}"))
    aim = props.get("aimPose")
    r.ok(aim in AIM_POSES, "aimPose has clips", f"{aim!r}" + ("" if aim in AIM_POSES else f" not in {sorted(AIM_POSES)}"))
    if family == "thrown":
        r.ok("ground" in nodes, "ground node (rest frame)", "ok" if "ground" in nodes else "throwables need a `ground` node (docs/04 §9.4)")
        r.ok("light" in nodes, "light node (fuse / state light the renderer blinks)",
             "ok" if "light" in nodes else "throwables need a `light` node")
        sim = content_grenade_radius(wid) if wid else None
        if sim:
            half = sorted(hi - lo)[1] / 2
            r.ok(half >= 0.8 * sim, "as big as its sim ball (≥ 80 % of the content radius)",
                 f"half-width {half:.3f} m vs radius {sim:.3f} m")
    if family in ("thrown", "shield"):
        # a grenade or a shield must never read as a team (the kit rule)
        for o in meshes:
            de = team_contrast(o)
            if de is not None:
                r.ok(min(de.values()) >= TEAM_DE, "team-colour contrast",
                     ", ".join(f"{t} ΔE {v:.0f}" for t, v in de.items()) + f" (min {TEAM_DE:.0f})")
    if family in FIREARMS:
        m = nodes.get("muzzle")
        r.ok(m is not None and m.z > 0.05 and abs(m.x) < 0.05, "muzzle node ahead of the grip (+Y)",
             f"muzzle at glTF y {m.z:+.2f} m" if m is not None else "no muzzle node")
    if props.get("hands") == 2:
        o = nodes.get("offhand")
        r.ok(o is not None and o.length <= OFFHAND_REACH, f"offhand node within {OFFHAND_REACH} m of the grip",
             f"{o.length:.3f} m" if o is not None else "no offhand node (two-handed)")
    check_sockets(r, objs, family, lo, hi, props.get("casings", True))
    if parts:
        check_parts(r, parts, lo, hi, body)


PART_KINDS = {"part_slide", "part_pump", "part_bolt", "part_cylinder", "part_mag"}


def check_parts(r: Report, parts, lo, hi, body=()):
    """Moving parts (the owner's request, 18 Oct): `part_*` child meshes the renderer animates when the gun
    fires or reloads. Each must be a known kind, have triangles, sit on the weapon, and carry its motion in
    extras: a unit `axis` in the weapon frame and a `travel` in metres (slide, pump, bolt, mag) or an
    `angle` in degrees (cylinder). A part flagged `cutClean` (the renderer only moves those; review N1) must
    be a closed shell once its seams are welded, and so must the body where the part sits: an open edge on
    either is a cut that shows when the part moves."""
    for o in sorted(parts, key=lambda o: o.name):
        name = o.name.split(".")[0]
        problems = []
        if name not in PART_KINDS:
            problems.append(f"unknown kind (not {sorted(PART_KINDS)})")
        n = len(world_tris([o]))
        if not n:
            problems.append("no triangles")
        axis = o.get("axis")
        a = Vector(tuple(axis)) if axis is not None and len(axis) == 3 else None
        if a is None or abs(a.length - 1) > 0.01:
            problems.append("`axis` missing or not unit")
        travel, angle = o.get("travel"), o.get("angle")
        if not ((travel is not None and 0 < travel <= 0.3) or (angle is not None and 0 < angle <= 360)):
            problems.append("needs `travel` (0–0.3 m) or `angle` (0–360°)")
        plo, phi = bbox([p for t in world_tris([o]) for p in t]) if n else (lo, hi)
        if any(plo[i] < lo[i] - 0.02 or phi[i] > hi[i] + 0.02 for i in range(3)):
            problems.append("outside the weapon's bounds")
        clean = o.get("cutClean")
        if clean is not None and clean is not True and clean != 1:
            problems.append("`cutClean` is only ever true")
        if clean:
            k = open_edges(o)
            if k:
                problems.append(f"flagged `cutClean` but has {k} open edges")
            # the opening it leaves in the body (seen once it moves): open body edges within 1 cm of it
            plo, phi = bbox([p for t in world_tris([o]) for p in t])
            near = sum(open_edges(b, (plo - Vector((0.01,) * 3), phi + Vector((0.01,) * 3))) for b in body)
            if near:
                problems.append(f"flagged `cutClean` but leaves {near} open edges in the body where it sits")
        motion = f"travel {travel} m" if travel is not None else f"angle {angle}°"
        r.ok(not problems, f"moving part {name}",
             "; ".join(problems) if problems else f"{n} tris, axis {tuple(round(float(c), 2) for c in a)}, {motion}"
             + (", cut clean (closed)" if clean else ""))


def open_edges(o, within=None):
    """Edges with one face once coincident vertices (UV and normal splits) are welded; with `within`
    (lo, hi in world space), only those whose middle lies in that box."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    # 0.1 mm: the glTF splits are exact copies, but the runtime's quantised positions (meshopt, up to ~0.07 mm
    # steps on a 1.15 m gun) can part two vertices the source file has within a micron of each other
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    n = 0
    for e in bm.edges:
        if not e.is_boundary:
            continue
        if within is not None:
            m = o.matrix_world @ ((e.verts[0].co + e.verts[1].co) / 2)
            if not all(within[0][i] <= m[i] <= within[1][i] for i in range(3)):
                continue
        n += 1
    bm.free()
    return n


def _gltf(v):
    """Blender (after the glTF import) → the weapon's glTF frame: +Y muzzle, +Z up, +X right."""
    return Vector((v.x, v.z, -v.y))


def check_sockets(r: Report, objs, family, lo, hi, casings=True):
    """Socket layout the renderer and VFX read (art/pipeline/build_weapons.py, weapons/sockets.json):
    required sockets per family, directions, the ejection side, rails above/below the bore, the
    shield's face, and every socket on the weapon. `casings` false (fuel, cells, orbs, blades, drum
    rounds) drops the `eject` requirement."""
    empties = {o.name.split(".")[0]: o for o in objs if o.type == "EMPTY"}
    pos = {k: _gltf(o.matrix_world.translation) for k, o in empties.items()}
    dirs = {k: Vector([float(c) for c in o["dir"]]) for k, o in empties.items() if "dir" in o}
    if family in FIREARMS:
        need = ["grip", "muzzle", "mag", "rail_top"] + (["eject"] if family != "launcher" and casings else [])
    else:
        need = ["grip"] + {"melee": ["tip"], "shield": ["face", "ground"]}.get(family, [])
    missing = [k for k in need if k not in empties]
    r.ok(not missing, "sockets for the family", ", ".join(need) + ("" if not missing else f"; missing {', '.join(missing)}"))
    undirected = [k for k in empties if k != "offhand" and (k not in dirs or abs(dirs[k].length - 1) > 0.01)]
    r.ok(not undirected, "socket directions (unit `dir`)", "ok" if not undirected else "no or bad dir: " + ", ".join(undirected))
    blo, bhi = _gltf(lo), _gltf(hi)
    blo, bhi = Vector(map(min, blo, bhi)), Vector(map(max, blo, bhi))
    off = [k for k, p in pos.items() if any(p[i] < blo[i] - 0.03 or p[i] > bhi[i] + 0.03 for i in range(3))]
    r.ok(not off, "sockets on the weapon (within 3 cm)", "ok" if not off else "off the mesh: " + ", ".join(off))
    if family == "shield" and "face" in pos and "face" in dirs:
        # shield space (render3d/shield.ts): origin on the arm strap, +Y up, +Z out of the strike face
        f, fd, half = pos["face"], dirs["face"], empties["face"].get("halfSize", [0, 0])
        r.ok(fd.z > 0.99 and f.z >= 0.05 and min(half) >= 0.1, "shield face: strike face +Z, in front of the strap",
             f"at z {f.z:+.3f}, dir {tuple(round(c, 2) for c in fd)}, half size {tuple(round(float(h), 2) for h in half)}")
        size = bhi - blo
        r.ok(abs(size.y - SHIELD_SIZE[1]) <= 0.03 and abs(size.x - SHIELD_SIZE[0]) <= 0.03,
             f"shield {SHIELD_SIZE[0]:.2f} × {SHIELD_SIZE[1]:.2f} m (what players see = what blocks)",
             f"{size.x:.2f} × {size.y:.2f} m")
    if family not in FIREARMS:
        return
    m, d = pos.get("muzzle"), dirs.get("muzzle")
    if m is not None and d is not None:
        bore = empties["muzzle"].get("boreRadius", 0)
        r.ok(d.y > 0.99 and bore > 0, "muzzle fires along +Y with a bore radius", f"dir {tuple(round(c, 2) for c in d)}, bore {bore:.3f} m")
    if "eject" in pos and "eject" in dirs:
        e, ed = pos["eject"], dirs["eject"]
        r.ok(e.x >= 0 and ed.x >= 0.3, "casings eject to the right (+X)", f"at x {e.x:+.3f}, dir x {ed.x:+.2f}")
    for rail, sign in (("rail_top", 1), ("rail_bottom", -1)):
        if rail not in pos or m is None:
            continue
        p, rd, ln = pos[rail], dirs.get(rail, Vector()), empties[rail].get("lengthM", 0)
        ok = sign * (p.z - m.z) >= -0.005 and sign * rd.z > 0.99 and ln >= 0.04
        r.ok(ok, f"{rail} {'above' if sign > 0 else 'below'} the bore, facing {'up' if sign > 0 else 'down'}",
             f"z {p.z:+.3f} vs bore {m.z:+.3f}, length {ln:.2f} m")


def _lab(lin):
    """CIE Lab (D65) of linear sRGB rows."""
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = (lin @ m.T) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(np.clip(xyz, 0, None)), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], -1)


def team_contrast(o):
    """Smallest ΔE between the piece's vertex colours and each team colour."""
    attr = o.data.color_attributes.active_color or (o.data.color_attributes[0] if o.data.color_attributes else None)
    if attr is None or not len(attr.data):
        return None
    col = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color", col)
    lab = _lab(col.reshape(-1, 4)[:, :3].astype(np.float64))
    out = {}
    for team, hx in TEAM_RGB.items():
        srgb = np.array([(hx >> 16) & 255, (hx >> 8) & 255, hx & 255]) / 255
        lin = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
        out[team] = float(np.sqrt(((lab - _lab(lin[None, :])) ** 2).sum(-1)).min())
    return out


def _in_poly(x, y, pts):
    inside = np.zeros(x.shape, dtype=bool)
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if y1 == y2:
            continue
        cross = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)
        inside ^= cross
    return inside


def plane_samples(o):
    """Points on the piece's triangles within PLANE_DEPTH of the gameplay plane: x, depth, height."""
    me = o.data
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) @ np.array(o.matrix_world)[:3, :3].T + np.array(o.matrix_world)[:3, 3]
    tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tri)
    tris = co[tri.reshape(-1, 3)]
    keep = (tris[:, :, 1].min(1) < PLANE_DEPTH) & (tris[:, :, 1].max(1) > -PLANE_DEPTH)
    pts = []
    for a, b, c in tris[keep]:
        n = int(np.ceil(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / (RVC_CELL * 0.6))) + 1
        u, v = np.meshgrid(np.linspace(0, 1, n), np.linspace(0, 1, n))
        m = u + v <= 1
        p = a + np.outer(u[m], b - a) + np.outer(v[m], c - a)
        pts.append(p[np.abs(p[:, 1]) < PLANE_DEPTH])
    p = np.concatenate(pts) if pts else np.zeros((0, 3))
    return p[:, 0], p[:, 1], p[:, 2]


def _shapes(o, key):
    return [[float(c) for c in shape] for shape in o.get(key, [])]


def uncovered_blobs(o):
    """Regions drawn on the gameplay plane that the piece's collision doesn't account for: not
    inside a solid or the terrain and not on a one-way, within RVC_TOL. Blobs thinner than 3 cells
    (0.15 m) either way are ignored (rims, bevels), and so are thin posts that are also shallow in
    depth (a pole, not an end plate across the walkway)."""
    x, y, z = plane_samples(o)
    if not len(x):
        return []
    cov = np.zeros(x.shape, dtype=bool)
    for x0, x1, h in _shapes(o, "terrain"):
        cov |= (x >= x0 - RVC_TOL) & (x <= x1 + RVC_TOL) & (z <= h + RVC_TOL)
    for poly in _shapes(o, "solids"):
        pts = list(zip(poly[0::2], poly[1::2]))
        for dx, dz in ((0, 0), (0, RVC_TOL), (0, -RVC_TOL), (RVC_TOL, 0), (-RVC_TOL, 0)):
            cov |= _in_poly(x + dx, z + dz, pts)
    for ax, ay, bx, by in _shapes(o, "oneWays"):
        t = np.clip((x - ax) / max(1e-9, bx - ax), 0, 1)
        line = ay + (by - ay) * t
        cov |= (x >= min(ax, bx) - RVC_TOL) & (x <= max(ax, bx) + RVC_TOL) & (z >= line - 0.25) & (z <= line + RVC_TOL)
    ix, iz, uy = np.floor(x[~cov] / RVC_CELL).astype(int), np.floor(z[~cov] / RVC_CELL).astype(int), y[~cov]
    depth = {}
    for c, d in zip(zip(ix.tolist(), iz.tolist()), uy.tolist()):
        lo, hi = depth.get(c, (d, d))
        depth[c] = (min(lo, d), max(hi, d))
    cells = set(depth)
    blobs, seen = [], set()
    for c in cells:
        if c in seen:
            continue
        stack, comp = [c], []
        seen.add(c)
        while stack:
            cx, cz = stack.pop()
            comp.append((cx, cz))
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                q = (cx + d[0], cz + d[1])
                if q in cells and q not in seen:
                    seen.add(q)
                    stack.append(q)
        xs, zs = [q[0] for q in comp], [q[1] for q in comp]
        w, h = max(xs) - min(xs) + 1, max(zs) - min(zs) + 1
        deep = max(depth[q][1] for q in comp) - min(depth[q][0] for q in comp) >= 0.2
        if h >= 3 and (w >= 3 or deep):
            blobs.append(((min(xs) * RVC_CELL, (max(xs) + 1) * RVC_CELL), (min(zs) * RVC_CELL, (max(zs) + 1) * RVC_CELL)))
    return blobs


def glb_node_names(files):
    """Every node name as written in the GLB files (not as Blender's import renamed them)."""
    names = []
    for f in files:
        b = Path(f).read_bytes()
        jl = struct.unpack_from("<I", b, 12)[0]
        names += [n.get("name", "") for n in json.loads(b[20:20 + jl]).get("nodes", [])]
    return names


def check_clips(r: Report, args):
    """--kind clips: an animation GLB (rookie_anims.glb, art or runtime). Read straight from the file, no
    import. The clips must stay out of meshopt: its QUATERNION filter normalises zero CUBICSPLINE tangents
    and rewrites quaternion signs, which was the original wobble (review L7). They must sample LINEAR, and
    every rotation track must be sign-continuous: no consecutive keys with a negative dot (#75)."""
    b = Path(args["file"]).read_bytes()
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    bin_ = b[20 + jl + 8:]
    anims = g.get("animations", [])
    r.info("clips", f"{len(anims)} clips, {sum(len(a['channels']) for a in anims)} channels")
    if not anims:
        r.add("FAIL", "has clips", "no animations in the file")
        return
    if "EXT_meshopt_compression" in g.get("extensionsUsed", []):
        r.add("FAIL", "clips not through meshopt", "EXT_meshopt_compression: its quaternion filter rewrites the signs and tangents")
        return
    r.add("PASS", "clips not through meshopt", "no EXT_meshopt_compression")
    modes = {}
    for a in anims:
        for smp in a["samplers"]:
            modes[smp.get("interpolation", "LINEAR")] = modes.get(smp.get("interpolation", "LINEAR"), 0) + 1
    other = {k: v for k, v in modes.items() if k != "LINEAR"}
    r.add("FAIL" if other else "PASS", "samplers LINEAR", f"{modes.get('LINEAR', 0)} LINEAR" + (f", {other}" if other else ""))
    flips = []
    for a in anims:
        for ch in a["channels"]:
            if ch["target"]["path"] != "rotation":
                continue
            acc = g["accessors"][a["samplers"][ch["sampler"]]["output"]]
            bv = g["bufferViews"][acc["bufferView"]]
            stride = bv.get("byteStride") or 16
            q = np.ndarray((acc["count"], 4), dtype=np.float32, buffer=bin_,
                           offset=bv.get("byteOffset", 0) + acc.get("byteOffset", 0), strides=(stride, 4))
            n = int(((q[1:] * q[:-1]).sum(1) < 0).sum())
            if n:
                flips.append(f"{a['name']}/{g['nodes'][ch['target']['node']].get('name')} {n}")
    r.add("FAIL" if flips else "PASS", "rotation tracks sign-continuous",
          f"negative-dot key pairs: {', '.join(flips[:6])}" if flips else "0 negative-dot key pairs")


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
        coll = [c for key in ("terrain", "solids", "oneWays") for shape in o.get(key, []) for c in shape]
        if coll:
            # map kits: the collision is what must snap (render = collision, docs/11 §2)
            off = [c for c in coll if abs(round(c / 0.05) * 0.05 - c) > 1e-3]
            r.ok(not off, f"collision on a 0.05 m grid: {o.name}",
                 f"{len(coll)} coordinates" + (f", off-grid: {off[:4]}" if off else ""), warn_only=True)
        elif o.get("layer", "gameplay") == "gameplay":
            on_grid = all(abs(round(s / 0.25) * 0.25 - s) <= 0.02 for s in (size.x, size.z))
            r.ok(on_grid, f"0.25 m grid: {o.name}", f"{size.x:.2f} x {size.z:.2f} m (w x h), depth {size.y:.2f} m",
                 warn_only=True)
        if coll and o.get("layer", "gameplay") == "gameplay":
            blobs = uncovered_blobs(o)
            r.ok(not blobs, f"render = collision on the gameplay plane: {o.name}",
                 "nothing drawn within 0.35 m of the plane outside the collision" if not blobs else
                 "; ".join(f"x {a:+.2f}..{b:+.2f} y {c:.2f}..{d:.2f}" for (a, b), (c, d) in blobs[:3])
                 + " drawn with no collision")
        if o.get("layer", "gameplay") == "gameplay":
            de = team_contrast(o)
            if de is not None:
                r.ok(min(de.values()) >= TEAM_DE, f"team-colour contrast: {o.name}",
                     ", ".join(f"{t} ΔE {v:.0f}" for t, v in de.items()) + f" (min {TEAM_DE:.0f})")
        if o.get("adSlot"):
            ad = o["adSlot"]
            r.ok(not coll and o.get("layer") != "gameplay", f"ad surface off the gameplay plane: {o.name}",
                 f"{ad['kind']} {ad['format']} {ad['size'][0]:g} x {ad['size'][1]:g} m, layer {o.get('layer')}"
                 + (", has collision" if coll else ""))
    r.info("kit total triangles", str(total))
    r.ok(draw_calls(meshes) <= 3 * max(1, len(meshes)), "materials per piece", f"{draw_calls(meshes)} draw calls total")
    image_report(r, args["max_tex"])


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parse_args(argv)
    path = Path(args["file"].split(",")[0])
    r = Report(args["file"], args["kind"])
    crashed = False
    try:
        if not all(Path(f).exists() for f in args["file"].split(",")):
            r.add("FAIL", "file exists", str(path))
        elif args["kind"] == "clips":
            r.info("file size", f"{path.stat().st_size / 1024:.0f} KB")
            check_clips(r, args)
        else:
            files = args["file"].split(",")
            args["files"] = files
            objs = []
            for i, f in enumerate(files):
                objs += import_glb(f, reset=i == 0)
            size = sum(Path(f).stat().st_size for f in files)
            r.info("file size", f"{size / 1024:.0f} KB" + (f" over {len(files)} files" if len(files) > 1 else ""))
            if not any(o.type == "MESH" and o.data.polygons for o in objs):
                r.add("FAIL", "has a mesh", "no mesh in the file (an animation-only GLB?)")
            else:
                {"character": check_character, "part": check_part, "weapon": check_weapon,
                 "kit": check_kit}[args["kind"]](r, objs, args)
    except Exception as e:  # a crash must never read as a PASS
        crashed = True
        r.add("FAIL", "check crashed", f"{type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    r.print()
    if args["json"]:
        try:
            Path(args["json"]).write_text(json.dumps({"file": r.path, "kind": r.kind, "pass": not r.failed, "rows": r.rows}, indent=2))
        except OSError as e:
            print(f"check.py: can't write {args['json']}: {e}")
            crashed = True
    sys.exit(2 if crashed else 1 if r.failed else 0)


main()
