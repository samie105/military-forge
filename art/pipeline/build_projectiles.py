"""Projectiles you can see in flight: one small mesh per type, all in vfx/projectiles.glb.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_projectiles.py -- \
        art/vfx [--runtime apps/web/public/assets]

Each projectile is one node (`proj_<type>`) in the **muzzle frame**: origin at its centre, +Y the
way it flies, +Z up, +X toward the weapon's right (the camera side in the side view). Spawn it at
the weapon's `muzzle` socket with the weapon's rotation and it points the right way. Toy-sized to
match the guns that fire them (the rocket fills the Thumper's bore, the blade is the one shown in
the Ripper), vertex-coloured on one material, with the orange toy tip on anything with a nose.

  rocket   Thumper: olive body, orange nose, four tail fins; `trail` at the nozzle (smoke + flame)
  grenade  Popper: a stubby round with a sand band and an orange nose; it tumbles slowly
  blade    Ripper: a toothed disc in the YZ plane (it faces the camera), spinning about X

The Pulse orb and the Dragon's flames are sprites (build_specials.py), not meshes.
Writes <art_dir>/projectiles.glb, <art_dir>/projectiles.json (sizes, trail point, spin) and, with
--runtime, <runtime>/vfx/projectiles.glb (meshopt) + projectiles.json.
"""
import json
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
from mathutils import Matrix  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None

# the weapon palette (build_weapons.py)
GUNMETAL = (0.20, 0.22, 0.25)
DARK = (0.11, 0.11, 0.12)
POLY = (0.30, 0.33, 0.22)
SAND = (0.66, 0.58, 0.42)
ORANGE = (0.98, 0.45, 0.10)
BLADE = (0.70, 0.73, 0.76)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def part(op, colour, **kw):
    """Add a primitive in the modelling frame (Blender: +Y travel, +Z up) and paint it."""
    op(**kw)
    o = bpy.context.active_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    col = o.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly in o.data.polygons:
        shade = 1.08 if poly.normal.z > 0.6 else (0.86 if poly.normal.z < -0.6 else 1.0)
        c = [srgb_to_linear(min(1.0, ch * shade)) for ch in colour]
        for li in poly.loop_indices:
            col.data[li].color = (*c, 1.0)
    o.data.materials.append(MAT)
    return o


def cyl(centre, r, length, colour, verts=10, axis="Y"):
    rot = {"Y": (math.pi / 2, 0, 0), "X": (0, math.pi / 2, 0)}[axis]
    return part(bpy.ops.mesh.primitive_cylinder_add, colour, vertices=verts, radius=r, depth=length, location=centre,
                rotation=rot)


def cone(centre, r1, r2, length, colour, verts=10):
    # radius1 at −Y, radius2 at +Y
    return part(bpy.ops.mesh.primitive_cone_add, colour, vertices=verts, radius1=r1, radius2=r2, depth=length,
                location=centre, rotation=(-math.pi / 2, 0, 0))


def box(centre, size, colour, rot=(0, 0, 0)):
    return part(bpy.ops.mesh.primitive_cube_add, colour, size=1, location=centre, scale=size,
                rotation=[math.radians(a) for a in rot])


def rocket():
    parts = [cyl((0, 0, 0), 0.04, 0.22, POLY), cone((0, 0.14, 0), 0.04, 0.012, 0.07, ORANGE),
             cyl((0, -0.125, 0), 0.03, 0.03, DARK, verts=8)]
    for i in range(4):
        a = math.radians(45 + 90 * i)
        parts.append(box((0.045 * math.cos(a), -0.09, 0.045 * math.sin(a)), (0.004, 0.06, 0.04), DARK,
                         rot=(0, -math.degrees(a) + 90, 0)))
    return parts, {"trail": [0.0, -0.14, 0.0], "spin": {"axis": [0, 1, 0], "rps": 2.0}, "from": "thumper"}


def grenade():
    parts = [cyl((0, -0.005, 0), 0.028, 0.05, POLY), cyl((0, 0.0, 0), 0.0295, 0.012, SAND),
             cone((0, 0.032, 0), 0.028, 0.012, 0.024, ORANGE), cyl((0, -0.034, 0), 0.025, 0.008, DARK)]
    return parts, {"trail": [0.0, -0.04, 0.0], "spin": {"axis": [1, 0, 0], "rps": 1.5}, "from": "popper"}


def blade():
    r = 0.1  # the Ripper's loaded blade
    parts = [cyl((0, 0, 0), r, 0.006, BLADE, verts=16, axis="X"), cyl((0, 0, 0), 0.026, 0.02, GUNMETAL, verts=8, axis="X")]
    for i in range(16):
        a = math.radians(22.5 * i)
        parts.append(box((0, (r + 0.004) * math.cos(a), (r + 0.004) * math.sin(a)), (0.006, 0.018, 0.018), BLADE,
                         rot=(math.degrees(a) + 45, 0, 0)))
    return parts, {"trail": [0.0, 0.0, 0.0], "spin": {"axis": [1, 0, 0], "rps": 14.0}, "from": "ripper"}


TYPES = {"rocket": rocket, "grenade": grenade, "blade": blade}

bpy.ops.wm.read_homefile(use_empty=True)
MAT = bpy.data.materials.new("projectile")
bsdf = next(n for n in MAT.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.6
vc = MAT.node_tree.nodes.new("ShaderNodeVertexColor")
vc.layer_name = "Col"
MAT.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])


def to_gltf(v):
    """Modelling frame (+Y travel, +Z up) → the muzzle frame after the glTF Y-up export (+Y travel, +Z up)."""
    return [round(c, 3) + 0.0 for c in v]


info = {"file": "projectiles.glb",
        "frame": "muzzle frame: origin at the centre, +Y travel, +Z up, +X the weapon's right; spawn at the weapon's "
                 "`muzzle` socket with the weapon's rotation",
        "types": {}}
for kind, make in TYPES.items():
    parts, extra = make()
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = f"proj_{kind}"
    # modelling frame → glTF muzzle frame, as build_weapons.py does: rotate +90° about X (Blender +Y → +Z,
    # +Z → −Y); the exporter's Y-up conversion then gives glTF +Y travel and +Z up
    o.data.transform(Matrix.Rotation(math.radians(90), 4, "X"))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    o["projectile"] = kind
    me = o.data
    me.calc_loop_triangles()
    ys = [v.co.z for v in me.vertices]  # Blender +Z = glTF +Y after the rotation above
    rs = [math.hypot(v.co.x, v.co.y) for v in me.vertices]
    info["types"][kind] = {"node": o.name, "lengthM": round(max(ys) - min(ys), 3), "radiusM": round(max(rs), 3),
                           "tris": len(me.loop_triangles), **{k: (to_gltf(v) if k == "trail" else v) for k, v in extra.items()}}
    print(f"[build_projectiles] {o.name:14s} {len(me.loop_triangles):4d} tris  length {max(ys) - min(ys):.3f} m")


def export(path, runtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


export(OUT / "projectiles.glb", runtime=False)
(OUT / "projectiles.json").write_text(json.dumps(info, indent=1))
if RUNTIME:
    export(RUNTIME / "vfx" / "projectiles.glb", runtime=True)
    (RUNTIME / "vfx" / "projectiles.json").write_text(json.dumps(info, indent=1))
print("[build_projectiles] done")
