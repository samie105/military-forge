"""Fog Stair's painted layers, rendered: the far bank and the near towers of a mountain city on a
river gorge, in river fog (maps-vertical; the owner's pick, 23 Oct). Original, invented buildings:
no real skyline, no lettering.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_fog_stair_backdrops.py -- <raw_dir>

Writes <raw_dir>/fog_far.png and fog_mid.png (2688 × 1152 RGBA, transparent sky), the raw inputs
apps/web/scripts/backdrops.py grades into apps/web/public/assets/backdrops/fog_stair/ (with the
sky from art/pipeline/fog_stair_sky.py). Deterministic (seeded).

- **Far** (the backdrop at z −40): a ridge across the gorge, with stacked residential towers
  climbing its terraces, a monorail viaduct with a train crossing, lit windows few and warm.
- **Mid** (z −14): closer towers, taller and plainer, with balcony bands, rooftop water tanks and
  masts, and blank vertical sign boards (the stairs themselves are on the play plane).
Fog everywhere: every surface fades toward the river-fog colour with depth and, more strongly,
toward the bottom of the frame where the river is.
"""
import math
import random
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
OUT.mkdir(parents=True, exist_ok=True)

W, H = 2688, 1152
FOG = (0.62, 0.67, 0.70)
WINDOW = (1.0, 0.80, 0.52)
CONCRETE = [(0.52, 0.53, 0.52), (0.62, 0.61, 0.57), (0.70, 0.67, 0.60), (0.45, 0.47, 0.48), (0.50, 0.44, 0.40), (0.42, 0.48, 0.45)]
SIGNS = [(0.62, 0.16, 0.12), (0.70, 0.52, 0.16), (0.20, 0.40, 0.42)]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.cycles.device = "CPU"
    scene.render.resolution_x = W
    scene.render.resolution_y = H
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("fog")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (*FOG, 1)
    bg.inputs[1].default_value = 1.15
    scene.world = world
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 1.4
    sun.color = (1.0, 0.95, 0.88)
    o = bpy.data.objects.new("sun", sun)
    o.rotation_euler = (math.radians(50), math.radians(-25), math.radians(20))
    scene.collection.objects.link(o)
    return scene


def material(name, color, fog_near, fog_far, river, windows=0.0, win_scale=(1.0, 1.0)):
    """A wall that fades into the fog with depth and toward the river below, with lit windows."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    n = nt.nodes
    ln = nt.links
    n.clear()
    out = n.new("ShaderNodeOutputMaterial")
    bsdf = n.new("ShaderNodeBsdfDiffuse")
    bsdf.inputs["Color"].default_value = (*color, 1)
    emit = n.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*WINDOW, 1)
    emit.inputs["Strength"].default_value = 1.6
    fogemit = n.new("ShaderNodeEmission")
    fogemit.inputs["Color"].default_value = (*FOG, 1)
    fogemit.inputs["Strength"].default_value = 1.0
    # windows: a grid on object coordinates (one cell a window: a pane in its middle); a seeded
    # share of the panes (`windows`, per pane from a white noise of the cell) are lit
    tex = n.new("ShaderNodeTexCoord")
    mapping = n.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (win_scale[0], 1.0, win_scale[1])
    ln.new(tex.outputs["Object"], mapping.inputs["Vector"])
    xyz = n.new("ShaderNodeSeparateXYZ")
    ln.new(mapping.outputs["Vector"], xyz.inputs[0])

    def op(kind, a, b=None):
        node = n.new("ShaderNodeMath")
        node.operation = kind
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                node.inputs[i].default_value = v
            else:
                ln.new(v, node.inputs[i])
        return node.outputs[0]

    fx = op("FRACT", xyz.outputs["X"])
    fz = op("FRACT", xyz.outputs["Z"])
    in_x = op("MULTIPLY", op("GREATER_THAN", fx, 0.22), op("LESS_THAN", fx, 0.78))
    in_z = op("MULTIPLY", op("GREATER_THAN", fz, 0.28), op("LESS_THAN", fz, 0.72))
    pane = op("MULTIPLY", in_x, in_z)
    cell = n.new("ShaderNodeVectorMath")
    cell.operation = "FLOOR"
    ln.new(mapping.outputs["Vector"], cell.inputs[0])
    noise = n.new("ShaderNodeTexWhiteNoise")
    noise.noise_dimensions = "3D"
    ln.new(cell.outputs[0], noise.inputs["Vector"])
    lit = op("MULTIPLY", op("GREATER_THAN", noise.outputs["Value"], 1.0 - windows), pane)
    glass = n.new("ShaderNodeMix")
    glass.data_type = "RGBA"
    ln.new(pane, glass.inputs["Factor"])
    glass.inputs[6].default_value = (*color, 1)
    glass.inputs[7].default_value = (0.20, 0.22, 0.24, 1)
    ln.new(glass.outputs[2], bsdf.inputs["Color"])
    mix_win = n.new("ShaderNodeMixShader")
    ln.new(lit, mix_win.inputs[0])
    ln.new(bsdf.outputs[0], mix_win.inputs[1])
    ln.new(emit.outputs[0], mix_win.inputs[2])
    # fog: depth from the camera, and height above the river
    cam = n.new("ShaderNodeCameraData")
    depth = n.new("ShaderNodeMapRange")
    depth.inputs["From Min"].default_value = fog_near
    depth.inputs["From Max"].default_value = fog_far
    ln.new(cam.outputs["View Z Depth"], depth.inputs["Value"])
    geo = n.new("ShaderNodeNewGeometry")
    sep = n.new("ShaderNodeSeparateXYZ")
    ln.new(geo.outputs["Position"], sep.inputs[0])
    low = n.new("ShaderNodeMapRange")
    low.inputs["From Min"].default_value = river[1]
    low.inputs["From Max"].default_value = river[0]
    ln.new(sep.outputs["Z"], low.inputs["Value"])
    both = n.new("ShaderNodeMath")
    both.operation = "MAXIMUM"
    ln.new(depth.outputs[0], both.inputs[0])
    ln.new(low.outputs[0], both.inputs[1])
    mix_fog = n.new("ShaderNodeMixShader")
    ln.new(both.outputs[0], mix_fog.inputs[0])
    ln.new(mix_win.outputs[0], mix_fog.inputs[1])
    ln.new(fogemit.outputs[0], mix_fog.inputs[2])
    ln.new(mix_fog.outputs[0], out.inputs[0])
    return m


def box(name, x0, z0, x1, z1, y, depth, mat):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.name = name
    o.scale = ((x1 - x0), depth, (z1 - z0))
    o.location = ((x0 + x1) / 2, y, (z0 + z1) / 2)
    o.data.materials.append(mat)
    return o


def camera(scene, width, cx, cz):
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = width
    cam.clip_end = 2000
    o = bpy.data.objects.new("cam", cam)
    o.location = (cx, 0, cz)
    o.rotation_euler = (math.radians(90), 0, 0)
    scene.collection.objects.link(o)
    scene.camera = o


def render(scene, path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    print(f"wrote {path}")


def far_layer():
    scene = reset()
    rng = random.Random(41)
    # the ridge across the gorge: a broad hill, terraced
    ridge = material("ridge", (0.40, 0.44, 0.40), 380, 640, (0, 30))
    for i in range(48):
        x0 = -260 + i * 11
        h = 26 + 40 * math.exp(-((x0 + 5 - 20) / 120) ** 2) + rng.uniform(-3, 3)
        box(f"terrace{i}", x0, -20, x0 + 11.2, h, 420, 30, ridge)
    # stacked towers up its terraces
    for i in range(70):
        x = rng.uniform(-250, 250)
        base = 22 + 40 * math.exp(-((x - 20) / 120) ** 2) - rng.uniform(0, 14)
        w = rng.uniform(7, 15)
        h = rng.uniform(18, 58) * (1.15 if abs(x) < 90 else 0.9)
        y = rng.uniform(340, 410)
        lit = rng.choice([0.0, 0.0, 0.25, 0.5])
        mat = material(f"t{i}", rng.choice(CONCRETE), 300, 620, (0, 26), lit, (w / 2.8, h / 3.2))
        box(f"tower{i}", x - w / 2, base, x + w / 2, base + h, y, 10, mat)
    # the monorail: a viaduct across, on pillars, with a train on it
    steel = material("viaduct", (0.36, 0.38, 0.40), 300, 620, (0, 20))
    box("deck", -270, 46, 270, 48, 330, 4, steel)
    for x in range(-260, 270, 28):
        box(f"pillar{x}", x - 0.9, -10, x + 0.9, 46, 330, 2, steel)
    train = material("train", (0.78, 0.78, 0.74), 300, 620, (0, 20), 0.6, (6, 1.2))
    box("train", -40, 48, 12, 52.4, 330, 3.2, train)
    camera(scene, 300, 0, 34)
    render(scene, OUT / "fog_far.png")


def mid_layer():
    scene = reset()
    rng = random.Random(77)
    xs = sorted(rng.uniform(-150, 150) for _ in range(16))
    for i, x in enumerate(xs):
        w = rng.uniform(12, 22)
        h = rng.uniform(55, 110)
        base = rng.uniform(-12, 8)
        y = rng.uniform(150, 190)
        mat = material(f"m{i}", rng.choice(CONCRETE), 120, 360, (-4, 30), rng.choice([0.0, 0.2, 0.35]), (w / 2.8, h / 3.2))
        box(f"tower{i}", x - w / 2, base, x + w / 2, base + h, y, 14, mat)
        # balcony bands
        band = material(f"b{i}", (0.30, 0.31, 0.31), 120, 360, (-4, 30))
        for z in range(int(base) + 9, int(base + h) - 4, 9):
            box(f"band{i}_{z}", x - w / 2 - 0.6, z, x + w / 2 + 0.6, z + 0.5, y - 7.2, 1.2, band)
        # a water tank and a mast on the roof
        tank = material(f"k{i}", (0.55, 0.50, 0.44), 120, 360, (-4, 30))
        box(f"tank{i}", x - 2.5, base + h, x + 1.5, base + h + 4, y, 4, tank)
        box(f"mast{i}", x + w / 2 - 2, base + h, x + w / 2 - 1.6, base + h + 12, y, 0.4, tank)
        # a blank vertical sign board on some
        if rng.random() < 0.5:
            sign = material(f"s{i}", rng.choice(SIGNS), 120, 360, (-4, 30), 0.0)
            box(f"sign{i}", x + w / 2 + 0.2, base + 10, x + w / 2 + 2.4, base + 26, y - 6, 0.4, sign)
    camera(scene, 330, 0, 52)
    render(scene, OUT / "fog_mid.png")


far_layer()
mid_layer()
