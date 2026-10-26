"""Fog Stair's painted layers, rendered: the far bank and the near towers of a mountain city on a
river gorge, in river fog (maps-vertical; the owner's pick, 23 Oct; regraded to the kit, 26 Oct).
Original, invented buildings: no real skyline, no lettering (at this distance a sign is light, not words).

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_fog_stair_backdrops.py -- <raw_dir> [far|mid]

Writes <raw_dir>/fog_far.png and fog_mid.png (2688 × 1152 RGBA, transparent sky; one of them with
`far` or `mid`, each a render on its own), the raw inputs apps/web/scripts/backdrops.py grades into
apps/web/public/assets/backdrops/fog_stair/ (with the sky from art/pipeline/fog_stair_sky.py).
Deterministic (seeded).

- **Far** (the backdrop at z −40): a ridge across the gorge, with stacked residential towers
  climbing its terraces, the old quarter's gable-front houses under tiled roofs along its lower
  terraces, a pagoda on the western hilltop and a pavilion on the eastern, a monorail viaduct with a
  train crossing, lit windows few and warm.
- **Mid** (z −14): closer towers, taller and plainer, with balcony bands, rooftop water tanks and
  masts and vertical neon blades (pink, warm white, violet: the kit's colours), and the old quarter
  at their feet: tiled roofs turned up at the eaves, stepping up the bank (the stairs themselves
  are on the play plane, in the kit).
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


def neon_material(name, color, fog_near, fog_far, river, strength=2.6):
    """A neon blade: emission in its colour, faded into the fog with depth and toward the river like
    the walls (material()), so it glows through the haze without shouting."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    n = nt.nodes
    ln = nt.links
    n.clear()
    out = n.new("ShaderNodeOutputMaterial")
    emit = n.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (*color, 1)
    emit.inputs["Strength"].default_value = strength
    fogemit = n.new("ShaderNodeEmission")
    fogemit.inputs["Color"].default_value = (*FOG, 1)
    fogemit.inputs["Strength"].default_value = 1.0
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
    mix = n.new("ShaderNodeMixShader")
    ln.new(both.outputs[0], mix.inputs[0])
    ln.new(emit.outputs[0], mix.inputs[1])
    ln.new(fogemit.outputs[0], mix.inputs[2])
    ln.new(mix.outputs[0], out.inputs[0])
    return m


def ribbon(name, outline, thick, y, depth, mat):
    """A slab that follows a front outline (x, z) top edge, `thick` deep downward, `depth` deep in y."""
    v = []
    for x, z in outline:
        v += [(x, y - depth / 2, z), (x, y - depth / 2, z - thick), (x, y + depth / 2, z), (x, y + depth / 2, z - thick)]
    f = []
    for i in range(len(outline) - 1):
        a, b = 4 * i, 4 * (i + 1)
        f += [(a, b, b + 1, a + 1), (a + 2, a + 3, b + 3, b + 2), (a, a + 2, b + 2, b), (a + 1, b + 1, b + 3, a + 3)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    o = bpy.data.objects.new(name, me)
    o.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return o


def fan(name, centre, outline, y, depth, mat):
    """A flat polygon (a gable's wall) from a fan around `centre`, `depth` deep."""
    cx, cz = centre
    v = [(cx, y - depth / 2, cz)] + [(x, y - depth / 2, z) for x, z in outline]
    f = [(0, i + 1, i + 2) for i in range(len(outline) - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    o = bpy.data.objects.new(name, me)
    o.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(o)
    return o


def roof_outline(cx, w, base, h, flare=0.2, tip=0.13, n=7):
    """The front edge of a gable-front tiled roof: concave from each eave up to the ridge, the eaves
    turned up at both ends (the south-west's old houses, seen end-on)."""
    left = [(cx - w / 2 + (w / 2) * (i / n), base + h * (i / n) ** 1.7) for i in range(n + 1)]
    right = [(2 * cx - x, z) for x, z in reversed(left[:-1])]
    return [(cx - w / 2 - tip * w, base + flare * h)] + left + right + [(cx + w / 2 + tip * w, base + flare * h)]


def old_house(name, cx, z0, w, body, y, depth, wall, roof, ground=-60.0):
    """A house of the old quarter: a body down to the ground (out of the fog), a whitewashed or timber
    gable and a tiled roof over it."""
    box(f"{name}_body", cx - w / 2, ground, cx + w / 2, z0 + body, y, depth, wall)
    h = 0.42 * w
    top = roof_outline(cx, w, z0 + body, h)
    fan(f"{name}_gable", (cx, z0 + body), top[1:-1], y - 0.05, depth, wall)
    ribbon(f"{name}_roof", top, 0.45, y - 0.2, depth + 0.6, roof)


def pagoda(name, cx, z0, y, tiers, w0, wall, roof, step=0.86):
    """A ridge-top pagoda: tiers narrowing upward, each with its own flared roof, a spire."""
    z = z0
    w = w0
    for k in range(tiers):
        h = 5.2 if k else 7.0
        box(f"{name}_t{k}", cx - 0.36 * w, z, cx + 0.36 * w, z + h, y, 0.72 * w, wall)
        ribbon(f"{name}_r{k}", roof_outline(cx, w, z + h, 0.12 * w, flare=0.45, tip=0.1), 0.6, y - 0.4, 0.9 * w, roof)
        z += h + 0.12 * w * 0.6
        w *= step
    box(f"{name}_spire", cx - 0.25, z, cx + 0.25, z + 6.0, y, 0.5, roof)


ROOF = (0.25, 0.26, 0.28)
PLASTERS = [(0.74, 0.72, 0.66), (0.66, 0.66, 0.62), (0.46, 0.36, 0.28)]
NEON = [(1.0, 0.42, 0.78), (1.0, 0.90, 0.74), (0.78, 0.72, 1.0)]


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
    for i in range(56):
        x = rng.uniform(-250, 250)
        if -120 < x < -60 and rng.random() < 0.7:
            continue  # leave the pagoda's hill clear
        base = 22 + 40 * math.exp(-((x - 20) / 120) ** 2) - rng.uniform(0, 14)
        w = rng.uniform(7, 15)
        h = rng.uniform(18, 58) * (1.15 if abs(x) < 90 else 0.9)
        y = rng.uniform(340, 410)
        lit = rng.choice([0.0, 0.0, 0.25, 0.5])
        mat = material(f"t{i}", rng.choice(CONCRETE), 300, 620, (0, 26), lit, (w / 2.8, h / 3.2))
        box(f"tower{i}", x - w / 2, base, x + w / 2, base + h, y, 10, mat)
    # the old quarter along the lower terraces: gable-front houses under tiled roofs
    roof = material("roof_far", ROOF, 300, 620, (0, 24))
    walls = [material(f"wall_far{i}", c, 300, 620, (0, 24), 0.15, (1.2, 0.8)) for i, c in enumerate(PLASTERS)]
    x = -255.0
    while x < 255:
        w = rng.uniform(9, 14)
        ridge_top = 22 + 40 * math.exp(-((x - 20) / 120) ** 2)
        z0 = ridge_top - rng.uniform(12, 24)
        old_house(f"oldf{int(x)}", x, z0, w, rng.uniform(4, 7), rng.uniform(352, 368), 8, rng.choice(walls), roof)
        x += w + rng.uniform(0.5, 4)
    # a pagoda on the western hilltop, a pavilion on the eastern
    pag_wall = material("pagoda", (0.52, 0.30, 0.24), 300, 620, (0, 26))
    hill = 22 + 40 * math.exp(-((-90 - 20) / 120) ** 2)
    pagoda("pagoda", -90, hill + 4, 372, 5, 15, pag_wall, roof)
    hill = 22 + 40 * math.exp(-((150 - 20) / 120) ** 2)
    pagoda("pavilion", 150, hill + 6, 380, 2, 12, pag_wall, roof, step=0.7)
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
    xs = sorted(rng.uniform(-150, 150) for _ in range(14))
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
        # a vertical neon blade on most (no lettering at this distance: a glowing tube frame and bars)
        if rng.random() < 0.7:
            col = rng.choice(NEON)
            neon = neon_material(f"n{i}", col, 120, 360, (-4, 30))
            z0 = base + rng.uniform(10, 30)
            side = x + w / 2 + 1.2 if rng.random() < 0.5 else x - w / 2 - 1.2
            back = material(f"nb{i}", (0.16, 0.15, 0.16), 120, 360, (-4, 30))
            box(f"blade{i}", side - 1.1, z0, side + 1.1, z0 + 14, y - 7.6, 0.5, back)
            for zz in (z0 + 0.3, z0 + 13.5):
                box(f"neon{i}_{zz:.0f}", side - 1.0, zz, side + 1.0, zz + 0.25, y - 7.9, 0.2, neon)
            for xx in (side - 1.0, side + 0.75):
                box(f"neonv{i}_{xx:.0f}", xx, z0 + 0.3, xx + 0.25, z0 + 13.75, y - 7.9, 0.2, neon)
            for k in range(3):  # glyph-like bars, no words
                zz = z0 + 2.0 + k * 4.0
                box(f"neong{i}_{k}", side - 0.5, zz, side + 0.5, zz + 0.3, y - 7.9, 0.2, neon)
                box(f"neonh{i}_{k}", side - 0.12, zz - 1.2, side + 0.12, zz + 1.6, y - 7.9, 0.2, neon)
    # the old quarter at the towers' feet: gable-front houses with tiled roofs stepping up the bank
    roof = material("roof_mid", ROOF, 120, 360, (-4, 30))
    walls = [material(f"wall_mid{i}", c, 120, 360, (-4, 30), 0.2, (1.1, 0.75)) for i, c in enumerate(PLASTERS)]
    x = -165.0
    while x < 165:
        w = rng.uniform(11, 16)
        z0 = rng.uniform(-8, 6)
        old_house(f"oldm{int(x)}", x, z0, w, rng.uniform(5, 9), rng.uniform(128, 140), 8, rng.choice(walls), roof)
        if rng.random() < 0.45:  # one more up the slope behind
            old_house(f"oldm{int(x)}b", x + rng.uniform(-2, 2), z0 + rng.uniform(7, 11), w * 0.85, rng.uniform(4, 7), rng.uniform(142, 148), 7, rng.choice(walls), roof)
        x += w + rng.uniform(1, 6)
    camera(scene, 330, 0, 52)
    render(scene, OUT / "fog_mid.png")


ONLY = argv[1] if len(argv) > 1 else "both"
if ONLY in ("far", "both"):
    far_layer()
if ONLY in ("mid", "both"):
    mid_layer()
