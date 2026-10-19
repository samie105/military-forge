"""Rebuild a weapon from a generated 3D model (Higgsfield concept → Tripo H3.1 multiview → this).

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_gun_scan.py -- \
        <id> [<id> ...] [--runtime apps/web/public/assets]

Per id, from art/weapons/scan_specs.json and art/weapons/scan/source/<id>_tripo_raw.glb:
  1. orient the raw model into the modelling frame (Blender +Y muzzle, +Z up, +X the gun's right; the
     spec says which raw axes those are), scale it to the spec's length, and put the grip at the origin;
  2. weld, then a symmetric collapse to the spec's triangle budget (≤ 1,000: docs/04 §9.4);
  3. fresh UVs, and bake the generated texture onto them at 512², downsampled to a 256² albedo;
  4. flatten it for the toon look: k-means colour clusters, each lifted in saturation (the generator's
     textures are greyer than the concepts), 35 % of the painted detail kept, the dark edge lines kept;
     then texels in the team orange's or blue's hue band are capped at 0.44 saturation (wood reads brown),
     and the build fails if over 2 % of the albedo reads as a team colour or sits within ΔE 40 of one;
  5. `_CAMO` per vertex from the colour clusters (body panels yes; dark grips, steel and the yellow toy
     tip no), minus the spec's `plain` boxes (barrels and blades that share a body colour), and `_GLOW`
     where the spec marks glowing colours;
  6. spec `squash` reshapes a part before the bake (the Widow's shorter scope), and spec `drop` lowers the gun
     in the hand so it clears the head at the ±45° aims (tools/asset-check/head_clearance.py);
  7. sockets from the spec, in normalised side-view coordinates of the final mesh (u along the gun from
     the butt to the muzzle, v from the bottom to the top), written as child nodes with `dir` and the
     extras build_weapons.py writes (boreRadius, lengthM, occupied);
  8. export like build_weapons.py (glTF +Y muzzle, +Z up) and merge the entry into weapons.json and
     sockets.json, so ids, socket names and the schema don't change.
build_weapons.py skips an id once its raw scan source exists (the scripted builder stays as the fallback).
"""
import colorsys
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)

REPO = Path(__file__).resolve().parents[2]
ART = REPO / "art/weapons"
argv = sys.argv[sys.argv.index("--") + 1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None
IDS = [a for a in argv if not a.startswith("--") and (RUNTIME is None or a != str(RUNTIME))]
SPECS = json.loads((ART / "scan_specs.json").read_text())["weapons"]
TEX = 256
TEAM = {"blue": "#2f7dff", "orange": "#ff7a1a"}
SAT_CAP = 0.44  # cap_team_hues
TEAM_SHARE_MAX = 0.02  # of the albedo's covered texels, per team and test
TRI_BUDGET = 1000  # the weapon budget (docs/04 §9.4), with the parts and their cut caps

AXES = {"+x": Vector((1, 0, 0)), "-x": Vector((-1, 0, 0)), "+y": Vector((0, 1, 0)), "-y": Vector((0, -1, 0)),
        "+z": Vector((0, 0, 1)), "-z": Vector((0, 0, -1))}


def log(*a):
    print("[build_gun_scan]", *a, flush=True)


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lab(rgb):
    lin = srgb_to_linear(rgb)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = (lin @ m.T) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(np.clip(xyz, 0, None)), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])


# ------------------------------------------------------------------ 1. import and orient

def import_raw(wid):
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ART / "scan/source" / f"{wid}_tripo_raw.glb"))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in list(bpy.context.scene.objects):
        if o != obj:
            bpy.data.objects.remove(o, do_unlink=True)
    return obj


def orient(obj, spec):
    """Rotate so the raw `forward` axis (Blender axes after import) is +Y and `up` is +Z; scale to
    lengthM along Y; centre on the bbox for now (the grip moves to the origin once sockets are known)."""
    fwd, up = AXES[spec["forward"]], AXES[spec["up"]]
    right = fwd.cross(up)
    basis = Matrix((right, fwd, up))  # rows: new axes in raw coordinates → maps raw → (x right, y fwd, z up)
    obj.data.transform(basis.to_4x4())
    pts = np.array([v.co[:] for v in obj.data.vertices])
    lo, hi = pts.min(0), pts.max(0)
    s = spec["lengthM"] / (hi[1] - lo[1])
    centre = (lo + hi) / 2
    obj.data.transform(Matrix.Diagonal((s, s, s, 1.0)) @ Matrix.Translation(Vector(-centre)))
    obj.data.update()


# ------------------------------------------------------------------ 2. decimate

def mesh_bounds(obj):
    pts = np.array([v.co[:] for v in obj.data.vertices])
    return pts.min(0), pts.max(0)


def squash(obj, spec, bounds):
    """Spec `squash`: [{"box": [u0, v0, u1, v1], "scale": [sy, sz] or [sy, sz, sx]}], side-view coordinates as
    for sockets. Vertices in the box scale along the gun (y) about the box's middle, in height (z) about its
    bottom and, given sx, in width (x) about the centreline: the Widow's scope is shortened this way (review
    M4), and the chunky specials are flattened whole, keeping their cross-section."""
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    me.vertices.foreach_set("co", squash_points(co.reshape(-1, 3), spec, bounds).ravel())
    me.update()


def squash_points(co, spec, bounds):
    """The `squash` mapping for N×3 modelling-frame points; sockets in a squashed part move with it."""
    lo, hi = bounds
    co = np.array(co, dtype=float)
    for sq in spec.get("squash", []):
        u0, v0, u1, v1 = sq["box"]
        sy, sz, sx = (*sq["scale"], 1.0)[:3]
        y0, y1 = lo[1] + u0 * (hi[1] - lo[1]), lo[1] + u1 * (hi[1] - lo[1])
        z0, z1 = lo[2] + v0 * (hi[2] - lo[2]), lo[2] + v1 * (hi[2] - lo[2])
        m = (co[:, 1] >= y0) & (co[:, 1] <= y1) & (co[:, 2] >= z0) & (co[:, 2] <= z1)
        mid = (y0 + y1) / 2
        co[m, 0] *= sx
        co[m, 1] = mid + (co[m, 1] - mid) * sy
        co[m, 2] = z0 + (co[m, 2] - z0) * sz
    return co


def tri_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def decimate(obj, budget):
    """Weld the generator's split seams, then one symmetric collapse (left/right, the gun's X) to the
    budget. A planar dissolve first left jagged slivers on these noisy surfaces."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0008)
    bpy.ops.object.mode_set(mode="OBJECT")
    n = tri_count(obj)
    if n > budget:
        m = obj.modifiers.new("collapse", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = budget / n * 0.97
        m.use_collapse_triangulate = True
        m.use_symmetry = True
        m.symmetry_axis = "X"
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris()
    bpy.ops.object.mode_set(mode="OBJECT")
    return tri_count(obj)


# ------------------------------------------------------------------ 3–4. bake and flatten

def bake_albedo(low, high, size=512):
    """Bake the raw model's base colour onto the low-poly's fresh UVs (Cycles, selected to active)."""
    bpy.context.view_layer.objects.active = low
    for o in bpy.context.scene.objects:
        o.select_set(False)
    low.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    img = bpy.data.images.new("bake", size, size, alpha=False, float_buffer=True)  # linear floats
    mat = bpy.data.materials.new("bake_target")
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.nodes.active = tex
    low.data.materials.clear()
    low.data.materials.append(mat)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 4
    sc.cycles.device = "CPU"
    bake = sc.render.bake
    bake.use_pass_direct = False
    bake.use_pass_indirect = False
    bake.use_pass_color = True
    bake.use_selected_to_active = True
    bake.cage_extrusion = 0.01
    bake.max_ray_distance = 0.05
    bake.margin = 4
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"})
    px = np.array(img.pixels[:], dtype=np.float64).reshape(size, size, 4)[..., :3]
    # Blender images are linear floats here: back to sRGB for the colour work
    return np.where(px <= 0.0031308, px * 12.92, 1.055 * np.clip(px, 0, None) ** (1 / 2.4) - 0.055), img


def kmeans(x, k, iters=12, seed=3):
    rng = np.random.default_rng(seed)
    c = x[rng.choice(len(x), k, replace=False)]
    for _ in range(iters):
        d = ((x[:, None, :] - c[None, :, :]) ** 2).sum(-1)
        lab_ = d.argmin(1)
        for j in range(k):
            sel = x[lab_ == j]
            if len(sel):
                c[j] = sel.mean(0)
    d = ((x[:, None, :] - c[None, :, :]) ** 2).sum(-1)
    return c, d.argmin(1)


def flatten(rgb, spec):
    """Toon look: each texel goes 75 % of the way to its colour cluster; dark lines stay. Returns the
    flattened sRGB image and per-texel cluster ids (for `_CAMO`)."""
    h, w, _ = rgb.shape
    flat = rgb.reshape(-1, 3)
    labx = lab(flat)
    k = spec.get("clusters", 7)
    # cluster the texels the bake covered: the empty atlas (black, most of it) would take most clusters
    covered = flat.sum(1) > 0.02
    sample = labx[covered][:: max(1, int(covered.sum()) // 20000)]
    centres, _ = kmeans(sample, k)
    d = ((labx[:, None, :] - centres[None, :, :]) ** 2).sum(-1)
    ids = d.argmin(1)
    cent_rgb = np.array([flat[(ids == j) & covered].mean(0) if ((ids == j) & covered).any() else np.zeros(3)
                         for j in range(k)])
    # the generator's textures come out greyer than the concept (mean saturation ~0.19): lift each
    # cluster's saturation for the toon read (greys stay grey), and keep 35 % of each texel's offset from
    # its cluster so the painted detail stays relative
    sat = spec.get("saturation", 1.4)
    lifted = np.array([colorsys.hsv_to_rgb(hh, min(0.9, ss * sat) if ss > 0.08 else ss, vv)
                       for hh, ss, vv in (colorsys.rgb_to_hsv(*c) for c in cent_rgb)])
    out = lifted[ids] + 0.35 * (flat - cent_rgb[ids])
    cent_rgb = lifted
    lum = flat @ [0.2126, 0.7152, 0.0722]
    line = lum < 0.6 * (cent_rgb[ids] @ [0.2126, 0.7152, 0.0722])
    out[line] = (flat * 0.85)[line]
    return cap_team_hues(np.clip(out, 0, 1)).reshape(h, w, 3), ids.reshape(h, w), cent_rgb


def hsv_arrays(rgb):
    mx, mn = rgb.max(1), rgb.min(1)
    d = mx - mn + 1e-9
    r, g, b = rgb.T
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return hue, np.where(mx > 0, (mx - mn) / (mx + 1e-9), 0), mx


def rgb_arrays(hue, sat, val):
    hh = (hue % 360) / 60
    i = np.floor(hh).astype(int) % 6
    f = hh - np.floor(hh)
    p, q, t = val * (1 - sat), val * (1 - sat * f), val * (1 - sat * (1 - f))
    return np.stack([np.choose(i, [val, q, p, p, t, val]), np.choose(i, [t, val, val, q, p, p]),
                     np.choose(i, [p, p, t, val, val, q])], -1)


def cap_team_hues(rgb):
    """Orange and blue mean teams only (the owner's rule). Texels in the team orange's hue band (12–40°) or
    the team blue's (195–235°) keep their hue and value but are capped at 0.44 saturation, and the warm ones
    darken by up to 15 %: the generated wood reads brown, not orange (review M3), and a pale glow stays pale.
    The bands and the 0.45 line are the ones team_share() measures."""
    hue, sat, val = hsv_arrays(rgb)
    warm = (hue >= 12) & (hue <= 40) & (sat > SAT_CAP)
    blue = (hue >= 195) & (hue <= 235) & (sat > SAT_CAP)
    darken = 1 - 0.15 * np.clip((sat - SAT_CAP) / 0.3, 0, 1)
    val = np.where(warm, val * darken, val)
    sat = np.where(warm | blue, np.minimum(sat, SAT_CAP), sat)
    return np.where((warm | blue)[:, None], rgb_arrays(hue, sat, val), rgb)


def team_share(rgb):
    """Per team: the share of texels in its hue band that read as that colour (saturation ≥ 0.45 and value
    ≥ 0.35), and the share within ΔE76 40 of it."""
    hue, sat, val = hsv_arrays(rgb)
    bands = {"orange": (12, 40), "blue": (195, 235)}
    labs = lab(rgb)
    out = {}
    for team, (lo, hi) in bands.items():
        hued = (hue >= lo) & (hue <= hi) & (sat >= 0.45) & (val >= 0.35)
        near = np.linalg.norm(labs - lab(hexrgb(TEAM[team])[None])[0], axis=1) < 40
        out[team] = (float(hued.mean()), float(near.mean()))
    return out


# ------------------------------------------------------------------ 5. masks

def classify(cent_rgb, spec):
    """Per colour cluster: takes a camo (body panels), glows, or neither. Dark (grips, barrels), steel-grey
    and the yellow toy tip never take a camo; the spec's `plain` boxes take it off by position."""
    out = []
    for c in cent_rgb:
        r, g, b = c
        mx, mn = max(c), min(c)
        v, s = mx, (mx - mn) / (mx + 1e-6)
        hue = (np.degrees(np.arctan2(math.sqrt(3) * (g - b), 2 * r - g - b)) + 360) % 360
        yellow = 40 <= hue <= 70 and s > 0.55 and v > 0.6
        dark = v < spec.get("dark", 0.24)  # near-black mags and grips; gunmetal (~0.27) takes a camo
        steel = s < 0.12 and v > 0.45
        camo = not (yellow or dark or steel)
        glow = any(np.abs(c - hexrgb(gh)).max() < 0.18 for gh in spec.get("glow", []))
        out.append((camo and not glow, glow))
    return out


def vertex_masks(obj, ids, cls, spec, bounds):
    """`_CAMO` / `_GLOW` per vertex: the cluster under each loop's UV, by majority per vertex. Vertices in
    a spec `plain` box ([u0, v0, u1, v1], side-view coordinates of the unsquashed gun, as for sockets) never
    take a camo: a barrel in the receiver's gunmetal stays steel, as on the scripted guns. Vertices in a
    `glow_boxes` box glow and take no camo: a pilot tab too small for a colour cluster of its own."""
    me = obj.data
    uv = me.uv_layers.active.data
    h, w = ids.shape
    votes_c = np.zeros(len(me.vertices))
    votes_g = np.zeros(len(me.vertices))
    count = np.zeros(len(me.vertices))
    for loop in me.loops:
        u, v = uv[loop.index].uv
        x = min(w - 1, max(0, int(u * w)))
        y = min(h - 1, max(0, int(v * h)))  # Blender's pixel rows start at the bottom (v = 0)
        camo, glow = cls[ids[y, x]]
        votes_c[loop.vertex_index] += camo
        votes_g[loop.vertex_index] += glow
        count[loop.vertex_index] += 1
    camo = (votes_c / np.maximum(count, 1)) > 0.5
    pts = unsquash_points(np.array([v.co[:] for v in me.vertices]), spec, bounds)
    lo, hi = bounds
    u = (pts[:, 1] - lo[1]) / (hi[1] - lo[1])
    v = (pts[:, 2] - lo[2]) / (hi[2] - lo[2])
    inside = lambda b: (u >= b[0]) & (u <= b[2]) & (v >= b[1]) & (v <= b[3])  # noqa: E731
    for box in spec.get("plain", []):
        camo &= ~inside(box)
    glow = (votes_g / np.maximum(count, 1)) > 0.5
    for box in spec.get("glow_boxes", []):
        glow |= inside(box)
        camo &= ~inside(box)
    me.attributes.new("_CAMO", "FLOAT", "POINT").data.foreach_set("value", camo.astype(np.float32))
    if glow.any():
        me.attributes.new("_GLOW", "FLOAT", "POINT").data.foreach_set("value", glow.astype(np.float32))
    return float(camo.mean()), float(glow.mean())


# ------------------------------------------------------------------ 6. sockets

def socket_points(obj, spec, bounds):
    """Spec sockets (u along butt→muzzle, v bottom→top of the side silhouette) → modelling-frame points.
    x: 0 (the centreline) unless the spec gives `side`: then the gun's right (+X) or left surface at that point,
    from the vertices within 2 cm in the side view (a bolt knob or scope elsewhere doesn't count). A big flat
    panel can leave only the far side's vertices that close (and a long cell none at all), so a result on the
    wrong side of the centreline, or none, falls back to a ray cast onto the surface."""
    pts = np.array([v.co[:] for v in obj.data.vertices])
    lo, hi = bounds
    tree = BVHTree.FromPolygons([v.co.copy() for v in obj.data.vertices], [p.vertices[:] for p in obj.data.polygons])
    out = {}
    for name, s in spec["sockets"].items():
        u, v = s["at"]
        y = lo[1] + u * (hi[1] - lo[1])
        z = lo[2] + v * (hi[2] - lo[2])
        _, y, z = squash_points([[0.0, y, z]], spec, bounds)[0]  # a socket in a squashed part follows it
        x = 0.0
        if s.get("side") in ("right", "left"):
            near = pts[np.hypot(pts[:, 1] - y, pts[:, 2] - z) < 0.02]
            right = s["side"] == "right"
            x = float(near[:, 0].max() if right else near[:, 0].min()) if len(near) else 0.0
            if (x <= 0) if right else (x >= 0):
                sign = 1 if right else -1
                hit, *_ = tree.ray_cast(Vector((sign * (abs(hi[0]) + abs(lo[0]) + 1), y, z)), Vector((-sign, 0, 0)))
                if hit is not None:
                    x = float(hit.x)
        out[name] = (Vector((x, y, z)) + Vector(s.get("offset", (0, 0, 0))), s)
    return out


def bore_radius_at(obj, muzzle, along=2, height=1):
    """Half the mesh's height over its last 2 cm toward the muzzle, for the flash and the suppressor. Axes:
    the socket frame by default (the bore runs along Blender +Z after the export rotation, height is
    Blender -Y); the modelling frame is along=1, height=2."""
    pts = np.array([v.co[:] for v in obj.data.vertices])
    near = pts[pts[:, along] > muzzle[along] - 0.02]
    if len(near) < 3:
        return 0.015
    return float(max(0.008, min(0.08, (near[:, height].max() - near[:, height].min()) / 2)))


# ------------------------------------------------------------------ moving parts

def unsquash_points(co, spec, bounds):
    """The inverse of squash_points (for points that were inside a squashed box)."""
    lo, hi = bounds
    co = np.array(co, dtype=float)
    for sq in reversed(spec.get("squash", [])):
        u0, v0, u1, v1 = sq["box"]
        sy, sz, sx = (*sq["scale"], 1.0)[:3]
        y0, y1 = lo[1] + u0 * (hi[1] - lo[1]), lo[1] + u1 * (hi[1] - lo[1])
        z0, z1 = lo[2] + v0 * (hi[2] - lo[2]), lo[2] + v1 * (hi[2] - lo[2])
        mid = (y0 + y1) / 2
        m = ((co[:, 1] >= mid + (y0 - mid) * sy) & (co[:, 1] <= mid + (y1 - mid) * sy)
             & (co[:, 2] >= z0) & (co[:, 2] <= z0 + (z1 - z0) * sz))
        co[m, 0] /= sx
        co[m, 1] = mid + (co[m, 1] - mid) / sy
        co[m, 2] = z0 + (co[m, 2] - z0) / sz
    return co


def cap_uv(small, covered):
    """UV of the darkest texel well inside the bake (its 3×3 neighbourhood covered too): the cut caps sample it."""
    lum = small @ np.array([0.2126, 0.7152, 0.0722])
    inner = covered.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            inner &= np.roll(np.roll(covered, dy, 0), dx, 1)
    r, c = np.unravel_index(np.argmin(np.where(inner, lum, np.inf)), lum.shape)
    return (c + 0.5) / lum.shape[1], (r + 0.5) / lum.shape[0]  # Blender's pixel rows start at the bottom


def cut_parts(low, spec, bounds, dark_uv, quiet=False):
    """Spec `parts` (the owner's request, 18 Oct): {"part_slide" | "part_pump" | "part_bolt" | "part_cylinder" |
    "part_mag": {"box": [u0, v0, u1, v1], "side": "right"|"left" (optional), "inset": m (optional), "axis":
    [x, y, z], "travel": m or "angle": deg, "bisect": false | "y" (optional), "cutClean": true (optional)}}. The box is in side-view coordinates of
    the unsquashed silhouette, as for sockets; with `side`, only what lies more than `inset` metres out on that
    side of the centreline. The faces in the box move to their own mesh, which keeps the UVs, the albedo and
    `_CAMO`. The renderer moves it along `axis` (weapon frame: +Y muzzle, +Z up, +X right) by `travel`, or turns
    it by `angle`, when the gun fires or reloads.
    Review N1 (an open cut tears when the part moves): the shell is first split along the box's planes, so the
    cut is straight (no faces straddle it to leave shards and spikes; `bisect: "y"` cuts only at the box's front
    and back, `false` keeps the shell's own edges, where a full straight cut costs too many triangles), and both
    openings, on the part and on the
    body, are closed with caps that sample the albedo's darkest texel and take no camo. `cutClean` goes to the
    node only where the spec sets it, once the part has been checked at full travel. Returns [(object, spec)]."""
    out = []
    lo, hi = bounds
    for name, cfg in spec.get("parts", {}).items():
        u0, v0, u1, v1 = cfg["box"]
        (_, ya, za), (_, yb, zb) = squash_points([[0.0, lo[1] + u0 * (hi[1] - lo[1]), lo[2] + v0 * (hi[2] - lo[2])],
                                                   [0.0, lo[1] + u1 * (hi[1] - lo[1]), lo[2] + v1 * (hi[2] - lo[2])]],
                                                  spec, bounds)
        side = {"right": 1, "left": -1}.get(cfg.get("side"), 0)
        xcut = side * cfg.get("inset", 0.0)
        bm = bmesh.new()
        bm.from_mesh(low.data)
        planes = [((0, ya, 0), (0, 1, 0)), ((0, yb, 0), (0, 1, 0)), ((0, 0, za), (0, 0, 1)), ((0, 0, zb), (0, 0, 1))]
        if side:
            planes.append(((xcut, 0, 0), (1, 0, 0)))

        def overlaps(f, m=1e-4):
            cs = np.array([v.co[:] for v in f.verts])
            return (cs[:, 1].max() >= ya - m and cs[:, 1].min() <= yb + m and cs[:, 2].max() >= za - m
                    and cs[:, 2].min() <= zb + m and (not side or (side * cs[:, 0]).max() >= side * xcut - m))

        cut = cfg.get("bisect", True)  # True: all the box's planes; "y": its front and back only; False: none
        for co, no in [pl for pl in planes if cut is True or (cut == "y" and pl[1][1])]:
            faces = [f for f in bm.faces if overlaps(f)]
            geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, dist=1e-5)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])

        def inside(f):
            c = f.calc_center_median()
            return ya <= c.y <= yb and za <= c.z <= zb and (not side or side * c.x >= side * xcut)

        bm.faces.ensure_lookup_table()
        sel = np.array([inside(f) for f in bm.faces])
        if not sel.any():
            bm.free()
            if not quiet:
                log(f"{low.name}: {name} selects no faces; skipped")
            continue
        seam = bm.verts.layers.int.new("_seam")
        for v in bm.verts:
            ins = {inside(f) for f in v.link_faces}
            v[seam] = int(len(ins) == 2)
        part = low.copy()
        part.data = low.data.copy()
        part.name = part.data.name = name
        bpy.context.scene.collection.objects.link(part)
        for obj, drop in ((part, ~sel), (low, sel)):
            b2 = bm.copy()
            b2.faces.ensure_lookup_table()
            bmesh.ops.delete(b2, geom=[b2.faces[i] for i in np.nonzero(drop)[0]], context="FACES")
            # vertices within 0.1 mm become one, as they will once exported (the runtime's quantised positions
            # move by up to ~0.07 mm) and welded: caps built on a near pair leave an opening there
            bmesh.ops.remove_doubles(b2, verts=b2.verts, dist=1e-4)
            sl = b2.verts.layers.int["_seam"]
            # every opening that touches the cut; on the part, every opening at all, so it comes out a closed
            # shell even where the cut meets a hole the decimation left (the asset check welds and counts)
            rim = [e for lp in boundary_loops(b2) if obj is part or any(v[sl] for e in lp for v in e.verts) for e in lp]
            caps = bmesh.ops.holes_fill(b2, edges=rim, sides=0)["faces"]
            caps = bmesh.ops.triangulate(b2, faces=caps)["faces"]
            # what holes_fill leaves (a loop touching another, or one running into a non-manifold edge): a fan
            for lp in boundary_loops(b2):
                if obj is part or any(v[sl] for e in lp for v in e.verts):
                    caps += fan_fill(b2, lp)
            left = sum(1 for e in b2.edges if e.is_boundary)  # what neither could close
            if caps:  # its own vertices: a cap takes no camo or glow, and samples the dark texel
                caps = [g for g in bmesh.ops.split(b2, geom=caps)["geom"] if isinstance(g, bmesh.types.BMFace)]
                uv = b2.loops.layers.uv.active  # none yet in cut_total's dry run
                for f in caps:
                    for loop in f.loops if uv is not None else ():
                        loop[uv].uv = dark_uv
                    for v in f.verts:
                        for layer in ("_CAMO", "_GLOW"):
                            if layer in b2.verts.layers.float:
                                v[b2.verts.layers.float[layer]] = 0.0
            b2.verts.layers.int.remove(sl)
            b2.to_mesh(obj.data)
            b2.free()
            obj.data.update()
            if not quiet:
                log(f"{low.name}: {name} {'part' if obj is part else 'body'} cut capped with {len(caps)} tris"
                    + (f"; {left} open edges left" if left else ""))
        bm.free()
        out.append((part, cfg))
    return out


def boundary_loops(bm):
    """The mesh's open edges, grouped into connected loops."""
    bm.verts.index_update()
    bm.edges.index_update()
    edges = [e for e in bm.edges if e.is_boundary]
    at = {}
    for e in edges:
        for v in e.verts:
            at.setdefault(v.index, []).append(e)
    seen, loops = set(), []
    for e in edges:
        if e.index in seen:
            continue
        loop, stack = [], [e]
        while stack:
            x = stack.pop()
            if x.index in seen:
                continue
            seen.add(x.index)
            loop.append(x)
            stack += [y for v in x.verts for y in at[v.index]]
        loops.append(loop)
    return loops


def fan_fill(bm, loop):
    """Close one open loop of edges with a fan of triangles about its centre, wound like the faces beside
    it (so the cap faces out). A chain that doesn't close (it runs into a non-manifold edge) is closed from
    end to end. Returns the new faces."""
    adj = {}
    for e in loop:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    if len(adj) < 3 or any(len(n) > 2 for n in adj.values()):
        return []
    ends = [v for v, n in adj.items() if len(n) == 1]
    path = [ends[0] if ends else next(iter(adj))]
    seen = {path[0]}
    while True:
        nxt = [w for w in adj[path[-1]] if w not in seen]
        if not nxt:
            break
        path.append(nxt[0])
        seen.add(nxt[0])
    edge = next(e for e in loop if set(e.verts) == {path[0], path[1]})
    if edge.link_faces and any(lp.vert is path[0] and lp.link_loop_next.vert is path[1] for lp in edge.link_faces[0].loops):
        path.reverse()  # the neighbour runs a→b along this edge, so the cap runs b→a
    centre = bm.verts.new(sum((v.co for v in path), Vector()) / len(path))
    faces = []
    for i, v in enumerate(path):
        w = path[(i + 1) % len(path)]
        try:
            faces.append(bm.faces.new((v, w, centre)))
        except ValueError:  # that triangle exists already
            pass
    return faces


def cut_total(low, spec, bounds):
    """Triangles of the whole gun once its parts are cut and capped: a dry run on a copy, before the bake."""
    tmp = low.copy()
    tmp.data = low.data.copy()
    bpy.context.scene.collection.objects.link(tmp)
    objs = [tmp] + [o for o, _ in cut_parts(tmp, spec, bounds, (0.0, 0.0), quiet=True)]
    n = sum(tri_count(o) for o in objs)
    for o in objs:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.meshes.remove(me)
    return n


def pivot_part(part, cfg, body):
    """Origin at the part's centre (its pivot: a cylinder turns about it), parented to the body, with its
    motion as node extras. A bolt's handle lifts about the bore line, so its pivot sits on the centreline at
    the handle's top (the meshes are in the export frame here: +Z muzzle, −Y up)."""
    vs = np.array([v.co[:] for v in part.data.vertices])
    centre = Vector(((vs.min(0) + vs.max(0)) / 2).tolist())
    if part.name.startswith("part_bolt"):
        centre.x, centre.y = 0.0, float(vs[:, 1].min())
    part.data.transform(Matrix.Translation(-centre))
    part.location = centre
    part.parent = body
    part["axis"] = [round(c, 3) for c in Vector(cfg["axis"]).normalized()]
    for k in ("travel", "angle", "lift", "cutClean"):
        if k in cfg:
            part[k] = cfg[k]


# ------------------------------------------------------------------ 7. export

def export(path, obj, runtime):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for c in obj.children:
        c.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
        export_extras=True, export_vertex_color="NONE", export_attributes=True, export_materials="EXPORT",
        export_image_format="WEBP" if runtime else "AUTO", export_image_quality=90,
        export_normals=True, export_texcoords=True, export_animations=False,
        export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


def build(wid, manifest, sockets_doc):
    spec = SPECS[wid]
    meta = manifest[wid]
    high = import_raw(wid)
    raw_tris = tri_count(high)
    orient(high, spec)
    bounds = mesh_bounds(high)  # sockets and plain boxes use the unsquashed silhouette
    squash(high, spec, bounds)
    low = high.copy()
    low.data = high.data.copy()
    bpy.context.scene.collection.objects.link(low)
    low.name = wid
    target = spec.get("tris", 950)
    tris = decimate(low, target)
    if spec.get("parts"):  # the straight cuts and their caps add triangles: decimate further until it all fits
        for _ in range(5):
            total = cut_total(low, spec, bounds)
            if total <= TRI_BUDGET:
                break
            target = int(target * (TRI_BUDGET - 10) / total)  # the cut's cost shrinks with the mesh, so step in proportion
            low.data = high.data.copy()
            tris = decimate(low, target)
        log(f"{wid}: decimated to {tris} so the gun, its parts and their cut caps come to {total} tris")
    srgb, img = bake_albedo(low, high)
    flat, ids, cent = flatten(srgb, spec)
    # team colours stay off the finish (the kit rule)
    for j, c in enumerate(cent):
        for team, hx in TEAM.items():
            d = float(np.linalg.norm(lab(c[None])[0] - lab(hexrgb(hx)[None])[0]))
            if d < 25:
                raise RuntimeError(f"{wid}: colour cluster {c.round(2)} is {d:.0f} ΔE from team {team}")
    cls = classify(cent, spec)
    log(wid, "clusters", [("#%02x%02x%02x" % tuple(int(round(x * 255)) for x in c), "camo" if cl[0] else ("glow" if cl[1] else "-"))
                         for c, cl in zip(cent, cls)])
    camo_share, glow_share = vertex_masks(low, ids, cls, spec, bounds)
    # the 256² albedo (sRGB bytes), on a plain material like the scripted weapons'
    k = flat.shape[0] // TEX
    small = flat.reshape(TEX, k, TEX, k, 3).mean(axis=(1, 3))  # 512² → 256², a box filter
    covered = (srgb.reshape(TEX, k, TEX, k, 3).sum(-1) > 0.02).all(axis=(1, 3))
    shares = team_share(small[covered])
    for team, (hued, near) in shares.items():
        if hued > TEAM_SHARE_MAX or near > TEAM_SHARE_MAX:
            raise RuntimeError(f"{wid}: {hued:.1%} of the albedo reads {team} (hue band) and {near:.1%} is within ΔE 40 of it")
    log(wid, "team-colour texels", {t: f"{h:.1%} hued, {n:.1%} within ΔE 40" for t, (h, n) in shares.items()})
    # a byte image holds sRGB values as they are (dye.py's albedos too); its colorspace is set before
    # the pixels, since changing it afterwards regenerates the image (black)
    alb = bpy.data.images.new(f"{wid}_albedo", TEX, TEX, alpha=False)
    alb.colorspace_settings.name = "sRGB"
    alb.pixels[:] = np.concatenate([small, np.ones((TEX, TEX, 1))], -1).astype(np.float32).ravel()
    alb.filepath_raw = str(ART / "scan" / f"{wid}_albedo.png")
    alb.file_format = "PNG"
    (ART / "scan").mkdir(parents=True, exist_ok=True)
    alb.save()  # the 256² albedo, for the record next to the raw model
    mat = bpy.data.materials.new("weapon_toon")
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.7
    t = mat.node_tree.nodes.new("ShaderNodeTexImage")
    t.image = alb
    mat.node_tree.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    low.data.materials.clear()
    low.data.materials.append(mat)
    bpy.data.objects.remove(high, do_unlink=True)
    bpy.data.images.remove(img)

    # sockets: grip at the origin (measured on the whole mesh, before any part is cut off)
    pts = socket_points(low, spec, bounds)
    # the bore on the whole gun, before a slide that carries the muzzle tip is cut off (the Hawk's: review)
    bore = bore_radius_at(low, pts["muzzle"][0], along=1, height=2) if "muzzle" in pts else None
    parts = cut_parts(low, spec, bounds, cap_uv(small, covered))
    meshes = [low] + [o for o, _ in parts]
    grip = pts["grip"][0].copy()
    for o in meshes:
        o.data.transform(Matrix.Translation(-grip))
    for k in pts:
        pts[k] = (pts[k][0] - grip, pts[k][1])
    # spec `drop` (m): the gun sits lower in the hand, so its receiver and scope clear the head at the ±45°
    # aims (review M4; tools/asset-check/head_clearance.py). The off hand keeps its place relative to the grip.
    drop = spec.get("drop", 0.0)
    if drop:
        for o in meshes:
            o.data.transform(Matrix.Translation((0, 0, -drop)))
        for k in pts:
            if k not in ("grip", "offhand"):
                pts[k] = (pts[k][0] - Vector((0, 0, drop)), pts[k][1])
    # modelling frame → socket frame (glTF +Y muzzle, +Z up after export), as build_weapons.paint_and_join
    rot = Matrix.Rotation(math.radians(90), 4, "X")
    for o in meshes:
        o.data.transform(rot)
    allv = [v.co.copy() for o in meshes for v in o.data.vertices]
    length = max(v.z for v in allv) - min(v.z for v in allv)
    for o, cfg in parts:
        pivot_part(o, cfg, low)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = low
    # smooth by angle: flat panels hide the decimated triangulation, edges over 35° stay hard (toon)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
    for name, (p, s) in pts.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.02
        e.location = rot @ p
        extras = {k: v for k, v in s.items() if k not in ("at", "side", "offset")}
        if "dir" in extras:
            d = Vector(extras["dir"]).normalized()
            extras["dir"] = [round(c, 3) for c in d]
        if name == "muzzle":
            extras["boreRadius"] = round(s.get("boreRadius") or bore, 4)
        for k, v in extras.items():
            e[k] = v
        bpy.context.scene.collection.objects.link(e)
        e.parent = low
    for k in ("weaponId", "name", "archetype", "family", "aimPose", "hands", "casings", "attach", "frame"):
        if k in meta or k == "weaponId":
            low[k] = wid if k == "weaponId" else meta[k]
    low["source"] = "scan"

    tris = 0
    for o in meshes:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    to_gltf = lambda v: [round(v.x, 3) + 0.0, round(v.z, 3) + 0.0, round(-v.y, 3) + 0.0]  # noqa: E731
    nodes = {c.name.split(".")[0]: to_gltf(c.location) for c in low.children}
    extras = lambda c: {k: (c[k].to_list() if hasattr(c[k], "to_list") else c[k]) for k in c.keys()}  # noqa: E731
    entry = {k: v for k, v in sockets_doc["weapons"].get(wid, {}).items() if k not in ("sockets", "parts")}
    sockets_doc["weapons"][wid] = {
        **entry,
        "lengthM": round(length, 3),
        "sockets": {c.name.split(".")[0]: {"pos": to_gltf(c.location), **extras(c)}
                    for c in sorted(low.children, key=lambda c: c.name) if c.type == "EMPTY"},
        **({"parts": {o.name: {"pos": to_gltf(o.location), **extras(o)} for o, _ in parts}} if parts else {})}
    manifest[wid] = {**{k: v for k, v in meta.items() if k != "parts"}, "tris": tris, "nodes": nodes,
                     "lengthM": round(length, 3), "file": f"{wid}.glb", "source": "scan", "texture": TEX,
                     **({"parts": sorted(o.name for o, _ in parts)} if parts else {})}
    export(ART / f"{wid}.glb", low, runtime=False)
    if RUNTIME:
        export(RUNTIME / "weapons" / f"{wid}.glb", low, runtime=True)
    log(f"{wid}: raw {raw_tris} tris → {tris}; camo {camo_share:.0%}, glow {glow_share:.0%}; "
        f"length {length:.2f} m; sockets {sorted(n for n in nodes if not n.startswith('part_'))}"
        + (f"; parts {', '.join(f'{o.name} {len(o.data.loop_triangles)} tris' for o, _ in parts)}" if parts else ""))


def main():
    manifest = json.loads((ART / "weapons.json").read_text())
    sockets_doc = json.loads((ART / "sockets.json").read_text())
    for wid in IDS:
        build(wid, manifest, sockets_doc)
    (ART / "weapons.json").write_text(json.dumps(manifest, indent=2))
    (ART / "sockets.json").write_text(json.dumps(sockets_doc, indent=1))
    if RUNTIME:
        rt = json.loads((RUNTIME / "weapons" / "weapons.json").read_text())
        rt["weapons"].update({wid: manifest[wid] for wid in IDS})
        (RUNTIME / "weapons" / "weapons.json").write_text(json.dumps(rt, indent=2))
        (RUNTIME / "weapons" / "sockets.json").write_text(json.dumps(sockets_doc, indent=1))


main()
