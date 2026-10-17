"""Side-view sheet of the arsenal (thumbnails for the README / Locker).

    blender -b --factory-startup --python art/pipeline/render_weapons.py -- <weapons_dir> <out_dir> [--size 320]

Renders <out_dir>/<id>.png per weapon from its right side, muzzle to the right, at one shared
scale (metres per pixel) so sizes compare. Stitch with any image tool.
"""
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = Path(argv[0]), Path(argv[1])
size = int(argv[argv.index("--size") + 1]) if "--size" in argv else 320
out.mkdir(parents=True, exist_ok=True)
SPAN = 1.25  # metres across every tile: the Widow (1.15 m) just fits

for glb in sorted(src.glob("*.glb")):
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    scene = bpy.context.scene
    roots = [o for o in scene.objects if o.parent is None]
    # The file's frame has the muzzle along glTF +Y (Blender +Z after import): lay it flat,
    # muzzle toward +Y, top toward +Z.
    for r in roots:
        r.matrix_world = Matrix.Rotation(math.radians(-90), 4, "X") @ r.matrix_world
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "MESH" for c in o.bound_box]
    centre = sum(pts, Vector()) / len(pts)

    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = size
    scene.render.resolution_y = size // 2
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.8, 0.82, 0.85, 1)
    scene.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(40), math.radians(20), math.radians(70))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = SPAN
    scene.collection.objects.link(cam)
    scene.camera = cam
    # camera on the gun's right side (+X), looking at -X; screen right = +Y (muzzle)
    cam.location = centre + Vector((3, 0, 0))
    cam.rotation_euler = (math.radians(90), 0, math.radians(90))
    scene.render.filepath = str(out / f"{glb.stem}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", glb.stem)
