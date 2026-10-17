"""Side-view sheet of the arsenal (thumbnails for the README / Locker).

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/render_weapons.py -- \
        <weapons_dir> <out_dir> [--size 320] [--sockets]

Renders <out_dir>/<id>.png per weapon from its right side, muzzle to the right, at one shared
scale (metres per pixel) so sizes compare. Stitch with any image tool. --sockets draws every
socket (weapons/sockets.json) as a coloured ball with a stick along its `dir`.
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
SOCKETS = "--sockets" in argv
# socket colours (sRGB) for the sheet; the legend is in art/README.md
SOCKET_COLOURS = {"muzzle": (1.0, 0.85, 0.1), "grip": (1.0, 1.0, 1.0), "offhand": (0.2, 0.9, 0.3),
                  "eject": (0.95, 0.35, 0.9), "mag": (0.2, 0.75, 1.0), "rail_top": (1.0, 0.3, 0.25),
                  "rail_bottom": (1.0, 0.55, 0.2), "backblast": (0.6, 0.6, 0.6), "tip": (1.0, 0.85, 0.1),
                  "pin": (0.95, 0.35, 0.9), "light": (1.0, 0.2, 0.2), "ground": (0.6, 0.6, 0.6)}


def marker(empty):
    """A ball at the socket and a stick along its `dir` (5 cm; rails: their usable length)."""
    name = empty.name.split(".")[0]
    col = SOCKET_COLOURS.get(name, (1, 1, 1))
    mat = bpy.data.materials.new(f"m_{name}")
    mat.use_nodes = True
    em = mat.node_tree.nodes.new("ShaderNodeEmission")
    em.inputs[0].default_value = (*[c ** 2.2 for c in col], 1)
    mat.node_tree.links.new(em.outputs[0], mat.node_tree.nodes["Material Output"].inputs[0])
    at = empty.matrix_world.translation.copy()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.009, location=at, segments=12, ring_count=8)
    bpy.context.active_object.data.materials.append(mat)
    if "dir" in empty:
        # sockets.json dir is in the weapon (glTF) frame; the scene is rotated like the mesh
        d = Vector([float(c) for c in empty["dir"]])
        to_scene = empty.parent.matrix_world.to_3x3()
        d = (to_scene @ Vector((d.x, -d.z, d.y))).normalized()
        sticks = [(at, d, 0.05)]
        if name.startswith("rail"):  # the usable rail along the barrel, and a short tick for its facing
            along = (to_scene @ Vector((0, 0, 1))).normalized()  # weapon +Y (muzzle)
            length = float(empty.get("lengthM", 0.05))
            sticks = [(at - along * length / 2, along, length), (at, d, 0.02)]
        for start, axis, length in sticks:
            bpy.ops.mesh.primitive_cylinder_add(radius=0.003, depth=length, location=start + axis * length / 2, vertices=8)
            stick = bpy.context.active_object
            stick.rotation_euler = axis.to_track_quat("Z", "Y").to_euler()
            stick.data.materials.append(mat)
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
    if SOCKETS:
        for e in [o for o in scene.objects if o.type == "EMPTY"]:
            marker(e)
        bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "MESH" and not o.name.startswith(("Sphere", "Cylinder"))
           for c in o.bound_box]
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
