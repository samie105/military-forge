"""Spent casings for weapon fire VFX: one small mesh per casing type, all in vfx/casings.glb.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_casings.py -- \
        art/vfx [--runtime apps/web/public/assets]

Each casing is one node (`casing_<type>`), centred on its origin with its axis along glTF +Y,
vertex-coloured on one shared material. They are toy-sized, about 4× real, so a casing reads as a
brass glint at 1× instead of a single pixel. Writes <art_dir>/casings.glb, <art_dir>/casings.json (the types and
their ejection feel, read by build_vfx.py) and, with --runtime, <runtime>/vfx/casings.glb (meshopt).
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
SCALE = 1.5
HULL = (0.25, 0.45, 0.28)

# type: (parts [(kind, radius(s), length, z0, colour)], ejection feel)
TYPES = {
    "pistol": ([("cyl", 0.0125, 0.004, 0.0, BRASS_D), ("cyl", 0.011, 0.028, 0.004, BRASS)],
               {"speedMps": 2.2, "coneDeg": 18, "spinRps": 18, "lifeMs": 1400}),
    "rifle": ([("cyl", 0.0125, 0.004, 0.0, BRASS_D), ("cyl", 0.011, 0.04, 0.004, BRASS),
               ("cone", (0.011, 0.0075), 0.006, 0.044, BRASS), ("cyl", 0.0075, 0.012, 0.05, BRASS)],
              {"speedMps": 2.8, "coneDeg": 15, "spinRps": 22, "lifeMs": 1500}),
    "shotgun": ([("cyl", 0.0168, 0.016, 0.0, BRASS), ("cyl", 0.016, 0.052, 0.016, HULL)],
                {"speedMps": 1.8, "coneDeg": 20, "spinRps": 10, "lifeMs": 1800}),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


bpy.ops.wm.read_homefile(use_empty=True)
mat = bpy.data.materials.new("casing")
bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.45
bsdf.inputs["Metallic"].default_value = 0.0
vc = mat.node_tree.nodes.new("ShaderNodeVertexColor")
vc.layer_name = "Col"
mat.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])

info = {"file": "casings.glb", "types": {}}
for kind, (parts, feel) in TYPES.items():
    objs = []
    parts = [(sh, (tuple(v * SCALE for v in r) if isinstance(r, tuple) else r * SCALE), ln * SCALE, z0 * SCALE, c)
             for sh, r, ln, z0, c in parts]
    total = max(z0 + ln for _, _, ln, z0, _ in parts)
    for shape, r, ln, z0, colour in parts:
        loc = (0, 0, z0 + ln / 2 - total / 2)
        if shape == "cyl":
            bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=r, depth=ln, location=loc)
        else:
            bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=r[0], radius2=r[1], depth=ln, location=loc)
        o = bpy.context.active_object
        col = o.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for poly in o.data.polygons:
            shade = 1.1 if abs(poly.normal.z) > 0.7 else 1.0
            c = [srgb_to_linear(min(1.0, ch * shade)) for ch in colour]
            for li in poly.loop_indices:
                col.data[li].color = (*c, 1.0)
        o.data.materials.append(mat)
        objs.append(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = f"casing_{kind}"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_smooth()
    o["casing"] = kind
    o.data.calc_loop_triangles()
    info["types"][kind] = {"node": o.name, "lengthM": round(total, 3), "tris": len(o.data.loop_triangles), **feel}
    print(f"[build_casings] {o.name:16s} {len(o.data.loop_triangles):3d} tris  length {total:.3f} m")


def export(path, runtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


export(OUT / "casings.glb", runtime=False)
(OUT / "casings.json").write_text(json.dumps(info, indent=1))
if RUNTIME:
    export(RUNTIME / "vfx" / "casings.glb", runtime=True)
print("[build_casings] done")
