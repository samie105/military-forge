"""Build the art-test map-slice kit (docs/11 §2 and §4): chunky, bevelled, toy-like pieces.

    blender -b --factory-startup --python tools/asset-pipeline/build_kit.py -- <out.glb>

Pieces (one node each, all sharing one vertex-colour material so the kit is one material/atlas):
  ground_4m    4 x 1.5 m ground block, top surface at y = 0, 2 m deep (z -1..+1, the gameplay band)
  platform_2m  2 m drop-through platform (yellow, like the debug client's one-way platforms),
               top surface at y = 0, 1.25 m deep
  crate_1m     1 m cover crate, bottom at y = 0

Colours are baked into vertex colours with a bottom-dark gradient ("baked AO", docs/11 §2) and a
little per-face jitter for a hand-painted feel. Palette discipline (docs/11 §4): the kit stays
mid/low saturation; only the platform's hazard yellow (a gameplay cue) is saturated.
"""
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(sys.argv[sys.argv.index("--") + 1])
random.seed(7)

CONCRETE = (0.60, 0.58, 0.54)
CONCRETE_DARK = (0.46, 0.45, 0.43)
TURF = (0.47, 0.53, 0.36)
HAZARD = (0.93, 0.72, 0.16)
STEEL = (0.25, 0.27, 0.30)
WOOD = (0.63, 0.47, 0.30)
WOOD_DARK = (0.44, 0.31, 0.19)

bpy.ops.wm.read_homefile(use_empty=True)
mat = bpy.data.materials.new("kit_toon")
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.9
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Col"
nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


COLORS = {}  # part object name -> base colour (kept out of ID properties)


def block(name, lo, hi, color, bevel=0.04, rot=None):
    """A bevelled box from lo to hi (Blender coords: x right, y depth (-y = camera), z up)."""
    lo, hi = Vector(lo), Vector(hi)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(lo + hi) / 2, rotation=rot or (0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.scale = hi - lo
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        m = o.modifiers.new("bevel", "BEVEL")
        m.width = bevel
        m.segments = 2 if bevel >= 0.04 else 1  # small parts: a single chamfer
        m.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=m.name)
    COLORS[o.name] = color
    return o


def paint(obj, base, zmin, zmax):
    """Vertex colours: base colour x bottom-dark gradient (over the whole piece) x per-face
    jitter, top faces lighter."""
    me = obj.data
    mw = obj.matrix_world
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    base = Vector(base)
    for poly in me.polygons:
        jitter = 1 + random.uniform(-0.035, 0.035)
        up = 1.06 if poly.normal.z > 0.7 else (0.9 if poly.normal.z < -0.7 else 1.0)
        for li in poly.loop_indices:
            z = (mw @ me.vertices[me.loops[li].vertex_index].co).z
            t = (z - zmin) / max(1e-6, zmax - zmin)
            ao = 0.72 + 0.28 * min(1.0, max(0.0, t)) ** 0.7
            c = [min(1.0, ch * ao * jitter * up) for ch in base]
            col.data[li].color = (*[srgb_to_linear(ch) for ch in c], 1.0)


def merge(name, parts):
    """Paint each part (joining would merge material slots, so colours go on before the join),
    then join into one piece with the one shared kit material."""
    zs = [(p.matrix_world @ v.co).z for p in parts for v in p.data.vertices]
    for p in parts:
        paint(p, COLORS[p.name], min(zs), max(zs))
        p.data.materials.clear()
        p.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    # The join keeps the first part's origin; bake it so the piece's pivot is the world origin
    # (ground/platform: walkable top surface at 0; crate: bottom at 0).
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    o["kitPiece"] = name
    o["biome"] = "yard"
    return o


# ---------------------------------------------------------------- ground_4m
parts = [
    block("body", (-2, -1, -1.5), (2, 1, -0.12), CONCRETE, 0.05),
    block("cap", (-2, -1.08, -0.18), (2, 1.0, 0), TURF, 0.06),
]
# Two chipped stones set into the face at different heights and tilts (not a tidy row).
for x, z, sz, tilt in ((-1.25, -0.62, 0.30, 18), (0.9, -1.05, 0.22, -12)):
    parts.append(block("stone", (x - sz / 2, -1.05, z - sz * 0.35), (x + sz / 2, -0.95, z + sz * 0.35),
                       CONCRETE_DARK, 0.04, rot=(0, math.radians(tilt), 0)))
merge("ground_4m", parts)

# ---------------------------------------------------------------- platform_2m
parts = [block("deck", (-1, -0.6, -0.2), (1, 0.6, 0), HAZARD, 0.03)]
for i in range(8):  # hazard-striped front fascia
    x0 = -1 + i * 0.25
    parts.append(block("stripe", (x0 + 0.01, -0.64, -0.17), (x0 + 0.24, -0.6, -0.03), STEEL if i % 2 else HAZARD, 0))
for x in (-0.7, 0.7):
    parts.append(block("bracket", (x - 0.08, -0.35, -0.5), (x + 0.08, 0.35, -0.2), STEEL, 0.03))
merge("platform_2m", parts)

# ---------------------------------------------------------------- crate_1m
parts = [block("core", (-0.46, -0.46, 0.04), (0.46, 0.46, 0.96), WOOD, 0.02)]
for sx in (-1, 1):
    for sy in (-1, 1):
        parts.append(block("post", (sx * 0.5 - 0.06 * (sx + 1), sy * 0.5 - 0.06 * (sy + 1), 0),
                           (sx * 0.5 - 0.06 * (sx - 1), sy * 0.5 - 0.06 * (sy - 1), 1), WOOD_DARK, 0.025))
for z0 in (0, 0.88):  # top and bottom rims, front and back
    for y in (-0.5, 0.38):
        parts.append(block("rim", (-0.44, y, z0), (0.44, y + 0.12, z0 + 0.12), WOOD_DARK, 0.02))
for y in (-0.52, 0.44):  # diagonal braces front and back
    parts.append(block("brace", (-0.08, y, -0.52), (0.08, y + 0.08, 0.52), WOOD_DARK, 0.02, rot=(0, math.radians(45), 0)))
    parts[-1].location.z += 0.5
    bpy.context.view_layer.objects.active = parts[-1]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
merge("crate_1m", parts)

for o in bpy.context.scene.objects:
    me = o.data
    me.calc_loop_triangles()
    print(f"[build_kit] {o.name}: {len(me.loop_triangles)} tris")

bpy.ops.export_scene.gltf(
    filepath=str(OUT), export_format="GLB", export_yup=True, export_apply=True, export_extras=True,
    export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True,
    export_texcoords=False, export_animations=False, export_cameras=False, export_lights=False,
)
print(f"[build_kit] wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
