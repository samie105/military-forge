"""Spent casings for weapon fire VFX: one small mesh per casing type, in casings.glb.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_casings.py -- \
        art/vfx [--runtime apps/web/public/assets]

Four nodes: `casing_pistol`, `casing_rifle`, `casing_sniper` (brass) and `shell_shotgun` (a red hull on a brass
base). Each is a six-sided lathe under 50 triangles, centred on its origin with its axis along glTF +Y,
vertex-coloured on one shared material, and at least 40 ΔE from both team colours. They are toy-sized, about 4×
real, so a casing reads as a brass glint at 1× instead of a single pixel. Writes <art_dir>/casings.glb and
<art_dir>/casings.json (the types and their ejection feel, read by build_vfx.py), the same GLB next to the
weapons (art/weapons/casings.glb) and, with --runtime, <runtime>/vfx/casings.glb and
<runtime>/weapons/casings.glb (meshopt). A gun's `eject` socket is where its casing leaves, along `dir`.
"""
import json
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None

BRASS = (0.92, 0.74, 0.20)  # brighter than the sand uniform it flies past
BRASS_D = (0.66, 0.50, 0.14)
RED_HULL = (0.66, 0.12, 0.12)  # the shotgun shell's hull: a deep red, ≥ 40 ΔE from both team colours
SCALE = 1.5
SIDES = 6  # a hex prism reads round at a few pixels and keeps every casing under 50 triangles
TEAM = {"blue": (0.184, 0.490, 1.0), "orange": (1.0, 0.478, 0.102)}

# node: (lathe profile [(radius, z)] from the base up, the colour of each band between two rings, casing
# type in casings.json, ejection feel). The base and the mouth are closed with a fan.
TYPES = {
    "casing_pistol": ([(0.0115, 0.0), (0.011, 0.032)], [BRASS], "pistol",
                      {"speedMps": 2.2, "coneDeg": 18, "spinRps": 18, "lifeMs": 1400}),
    "casing_rifle": ([(0.0115, 0.0), (0.011, 0.044), (0.0075, 0.050), (0.0075, 0.062)], [BRASS, BRASS, BRASS], "rifle",
                     {"speedMps": 2.8, "coneDeg": 15, "spinRps": 22, "lifeMs": 1500}),
    "casing_sniper": ([(0.013, 0.0), (0.0125, 0.062), (0.0085, 0.070), (0.0085, 0.086)], [BRASS, BRASS, BRASS], "sniper",
                      {"speedMps": 3.0, "coneDeg": 12, "spinRps": 16, "lifeMs": 1700}),
    "shell_shotgun": ([(0.0168, 0.0), (0.0168, 0.016), (0.016, 0.068)], [BRASS, RED_HULL], "shotgun",
                      {"speedMps": 1.8, "coneDeg": 20, "spinRps": 10, "lifeMs": 1800}),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(rgb):
    lin = [srgb_to_linear(c) for c in rgb]
    M = ((0.4124, 0.3576, 0.1805), (0.2126, 0.7152, 0.0722), (0.0193, 0.1192, 0.9505))
    xyz = [sum(M[r][k] * lin[k] for k in range(3)) / w for r, w in zip(range(3), (0.95047, 1.0, 1.08883))]
    f = [v ** (1 / 3) if v > 0.008856 else 7.787 * v + 16 / 116 for v in xyz]
    return (116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2]))


for colour in (BRASS, BRASS_D, RED_HULL):  # casings never read as a team
    for team, t in TEAM.items():
        d = math.dist(lab(colour), lab(t))
        assert d >= 40, f"casing colour {colour} is {d:.0f} ΔE from team {team}"


bpy.ops.wm.read_homefile(use_empty=True)
mat = bpy.data.materials.new("casing")
bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.45
bsdf.inputs["Metallic"].default_value = 0.0
vc = mat.node_tree.nodes.new("ShaderNodeVertexColor")
vc.layer_name = "Col"
mat.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])

info = {"file": "casings.glb", "types": {}}
for node, (profile, bands, kind, feel) in TYPES.items():
    profile = [(r * SCALE, z * SCALE) for r, z in profile]
    total = profile[-1][1]
    verts, faces, colours = [], [], []
    for r, z in profile:
        for k in range(SIDES):
            a = 2 * math.pi * k / SIDES
            verts.append((r * math.cos(a), r * math.sin(a), z - total / 2))
    for b in range(len(profile) - 1):
        for k in range(SIDES):
            i0, i1 = b * SIDES + k, b * SIDES + (k + 1) % SIDES
            faces.append((i0, i1, i1 + SIDES, i0 + SIDES))
            colours.append(bands[b])
    faces.append(tuple(reversed(range(SIDES))))                                        # base (the darker rim)
    colours.append(BRASS_D)
    faces.append(tuple((len(profile) - 1) * SIDES + k for k in range(SIDES)))          # mouth
    colours.append(bands[-1])
    me = bpy.data.meshes.new(node)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(node, me)
    bpy.context.scene.collection.objects.link(o)
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, c in zip(me.polygons, colours):
        shade = 1.1 if abs(poly.normal.z) > 0.7 else 1.0
        lc = [srgb_to_linear(min(1.0, ch * shade)) for ch in c]
        for li in poly.loop_indices:
            col.data[li].color = (*lc, 1.0)
    me.materials.append(mat)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.shade_smooth()
    o.select_set(False)
    o["casing"] = kind
    me.calc_loop_triangles()
    assert len(me.loop_triangles) <= 50, f"{node}: {len(me.loop_triangles)} tris (max 50)"
    info["types"][kind] = {"node": node, "lengthM": round(total, 3), "tris": len(me.loop_triangles), **feel}
    print(f"[build_casings] {node:16s} {len(me.loop_triangles):3d} tris  length {total:.3f} m")


def export(path, runtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


export(OUT / "casings.glb", runtime=False)
(OUT / "casings.json").write_text(json.dumps(info, indent=1))
WEAPONS = Path(__file__).resolve().parents[1] / "weapons"  # the same casings next to the weapons, for the renderer
export(WEAPONS / "casings.glb", runtime=False)
if RUNTIME:
    export(RUNTIME / "vfx" / "casings.glb", runtime=True)
    export(RUNTIME / "weapons" / "casings.glb", runtime=True)
print("[build_casings] done")
