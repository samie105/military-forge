"""Render turnaround thumbnails of a GLB (front / left / back / three-quarter) side by side.

    blender -b --factory-startup --python tools/asset-pipeline/render_views.py -- <in.glb> <out.png> [--size 512]

Orthographic, flat studio light, Eevee. Used for the art README and as the "thumbnail" step of the
asset pipeline (docs/11 §4).
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = Path(argv[0]), Path(argv[1])
size = int(argv[argv.index("--size") + 1]) if "--size" in argv else 512

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(src), disable_bone_shape=True)
scene = bpy.context.scene

# Pose: rest by default (the importer assigns the first clip), or --action <clip> --frame <n>.
action = argv[argv.index("--action") + 1] if "--action" in argv else None
for arm in (o for o in scene.objects if o.type == "ARMATURE"):
    if action:
        arm.animation_data.action = bpy.data.actions[action]
        if arm.animation_data.action_slot is None and arm.animation_data.action_suitable_slots:
            arm.animation_data.action_slot = arm.animation_data.action_suitable_slots[0]
        scene.frame_set(int(argv[argv.index("--frame") + 1]) if "--frame" in argv else 0)
    else:
        arm.data.pose_position = "REST"
bpy.context.view_layer.update()

dg = bpy.context.evaluated_depsgraph_get()
pts = []
for o in (o for o in scene.objects if o.type == "MESH"):
    ev = o.evaluated_get(dg)
    m = ev.to_mesh()
    pts += [o.matrix_world @ v.co for v in m.vertices]
    ev.to_mesh_clear()
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre, extent = (lo + hi) / 2, max(hi - lo)

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = scene.render.resolution_y = size
scene.render.film_transparent = False
world = bpy.data.worlds.new("studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.83, 0.85, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world
scene.view_settings.view_transform = "Standard"

sun = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
sun.data.energy = 2.5
sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
scene.collection.objects.link(sun)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = "ORTHO"
cam.data.ortho_scale = extent * 1.1
scene.collection.objects.link(cam)
scene.camera = cam

# Blender -Y is the glTF front.
views = [("front", 0), ("left", 90), ("back", 180), ("three_quarter", 35)]
tiles = []
for name, yaw in views:
    a = math.radians(yaw)
    d = extent * 3
    cam.location = centre + Vector((d * math.sin(a), -d * math.cos(a), 0))
    cam.rotation_euler = (math.radians(90), 0, a)
    tile = out.with_name(f"{out.stem}_{name}.png")
    scene.render.filepath = str(tile)
    bpy.ops.render.render(write_still=True)
    tiles.append(tile)

# Stitch the tiles into one strip.
strip = bpy.data.images.new("strip", size * len(tiles), size)
px = [0.0] * (size * len(tiles) * size * 4)
for i, t in enumerate(tiles):
    im = bpy.data.images.load(str(t))
    tp = list(im.pixels)
    for y in range(size):
        row = tp[y * size * 4:(y + 1) * size * 4]
        start = (y * size * len(tiles) + i * size) * 4
        px[start:start + size * 4] = row
    t.unlink()
strip.pixels = px
strip.filepath_raw = str(out)
strip.file_format = "PNG"
strip.save()
print("wrote", out)
