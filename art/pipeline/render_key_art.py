"""Key art v2 (owner, 23 Oct: "the poster is nice but it should use our 3D characters instead, like our fighters'
faces", and "I just don't want it to look like we're promoting war"): the Rookie and the female soldier, in the
game's own models, default kit and clips, rifles held low, rendered in Cycles in bright afternoon light with their
jet exhaust, over the background plate (a sunny rooftop arena in the game's 3D style).

    blender -b --factory-startup --python art/pipeline/render_key_art.py -- <shot> <out.png> \
        [--size WxH] [--samples N] [--frame F] [--frames A-B --loop-out <dir>]

<shot> is desktop (16:9), phone (19.5:9) or poster (2:3). The render is the soldiers alone over a
transparent background (the parallax layer); compose_key_art.py lays it over the plate. --frames renders the
ambient loop (the hover clip cycling, the flames flickering, the embers rising) into <dir>/####.png.
"""
import math
import random
import sys
from pathlib import Path

import json

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clips  # noqa: E402  (the clips' arm solver: the off hand onto the gun, as the game's IK does)

argv = sys.argv[sys.argv.index("--") + 1:]
SHOT, OUT = argv[0], Path(argv[1])
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1) if argv[i].startswith("--")}
W, H = (int(v) for v in opt.get("size", "1920x1080").split("x"))
SAMPLES = int(opt.get("samples", 96))
FRAME = int(opt.get("frame", 0))
FRAMES = tuple(int(v) for v in opt["frames"].split("-")) if "frames" in opt else None
LOOP = 120  # the ambient loop: 5 s at 24 fps; the hover clip, the flicker and the embers all repeat over it

REPO = Path(__file__).resolve().parents[2]
ART = REPO / "art"
CHAR = ART / "character"


def log(*a):
    print("[render_key_art]", *a, flush=True)


bpy.ops.wm.read_homefile(use_empty=True)
scene = bpy.context.scene

# ------------------------------------------------------------------ the soldiers: the game's own rig, clips and art

# the Rookie's armature and clips (rookie.blend); her skeleton is his (build_character.py --skeleton), so one rig's
# data poses both
with bpy.data.libraries.load(str(CHAR / "source" / "rookie.blend")) as (src, dst):
    dst.objects = ["rookie"]
    dst.actions = list(src.actions)
RIG = dst.objects[0]


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), disable_bone_shape=True)
    return [o for o in bpy.data.objects if o not in before]


def soldier(name, files, place):
    """One soldier: its own copy of the rig object, and every mesh of `files` (body + parts, the art GLBs with their
    painted textures) bound to it by vertex-group name. The meshes import in their bind pose, so no bone axis
    convention enters it."""
    arm = RIG.copy()
    arm.name = name
    if arm.animation_data:
        arm.animation_data_clear()  # the .blend's active clip would override the pose at render time
    scene.collection.objects.link(arm)
    arm.matrix_world = place
    for f in files:
        objs = import_glb(f)
        for o in objs:
            if o.type != "MESH":
                continue
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = place @ mw
            for md in list(o.modifiers):
                o.modifiers.remove(md)
            mod = o.modifiers.new("skeleton", "ARMATURE")
            mod.object = arm
            o.parent = arm
            o.matrix_parent_inverse = arm.matrix_world.inverted()
        for o in objs:
            if o.type != "MESH":
                bpy.data.objects.remove(o, do_unlink=True)
    arm.animation_data_create()
    return arm


UPPER = ["spine1", "spine2", "neck", "head", "clavicle_L", "clavicle_R", "upperarm_L", "upperarm_R", "forearm_L",
         "forearm_R", "hand_L", "hand_R"]  # rookie.json upperBodyBones: the aim layer's bones


def fcurves(action):
    """An action's F-curves (Blender 4.4+ keeps them in a layered action's channel bag)."""
    if getattr(action, "layers", None):
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        return out
    return list(action.fcurves)


def pose(arm, loco, aim, t, lean=0.0):
    """The game's layering: `loco` on every bone at time t (s, looped), then the aim pose on the upper body."""
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    span = LOOP / scene.render.fps
    for action, bones, at in ((bpy.data.actions[loco], None, t), (bpy.data.actions[aim], set(UPPER), 0.0)):
        f0, f1 = action.frame_range
        # a whole number of cycles in the loop, so its last frame meets its first
        cycles = max(1, round(span * scene.render.fps / max(1.0, f1 - f0)))
        frame = f0 + ((at / span) * cycles % 1.0) * (f1 - f0)
        for fc in fcurves(action):
            path = fc.data_path
            if not path.startswith('pose.bones["'):
                continue
            bone = path.split('"')[1]
            if bones is not None and bone not in bones:
                continue
            pb = arm.pose.bones.get(bone)
            if pb is None:
                continue
            prop = path.rsplit(".", 1)[1]
            if prop == "rotation_quaternion":
                pb.rotation_mode = "QUATERNION"
            getattr(pb, prop)[fc.array_index] = fc.evaluate(frame)
    if lean:
        arm.pose.bones["spine1"].rotation_quaternion = (Matrix.Rotation(lean, 4, "X").to_quaternion()
                                                        @ arm.pose.bones["spine1"].rotation_quaternion)
    bpy.context.view_layer.update()


def hold(arm, weapon):
    """The weapon rigid on socket_weapon_R, with an identity transform in its frame (+Y the muzzle, +Z the top),
    as the game mounts it."""
    objs = import_glb(ART / "weapons" / f"{weapon}.glb")
    meshes = [o for o in objs if o.type == "MESH"]
    for o in objs:
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)  # the GLB's node transform into the mesh: its coordinates are the weapon frame's
        o.matrix_world = Matrix()
        o.parent = arm
        o.parent_type = "BONE"
        o.parent_bone = "socket_weapon_R"
        # bone parenting is at the bone's tail; put the gun's origin on the socket's head, in its frame
        bone = arm.data.bones["socket_weapon_R"]
        o.matrix_parent_inverse = Matrix.Translation((0, -bone.length, 0))
        o.matrix_basis = WEAPON_AXES
    return meshes


# The game mounts a weapon's glTF coordinates as they are in the socket's frame (+Y the muzzle, +Z the top; the
# offhand node is `socket @ node`, build_character.py), and the importer turned them into Blender's Z-up: turn back.
WEAPON_AXES = Matrix.Rotation(math.radians(-90), 4, "X")
WEAPONS = json.loads((REPO / "apps/web/public/assets/weapons/weapons.json").read_text())["weapons"]


def offhand(arm, weapon):
    """The left hand on a two-handed weapon's `offhand` node, as the game's IK puts it over the aim pose."""
    node = WEAPONS[weapon].get("nodes", {}).get("offhand")
    if WEAPONS[weapon].get("hands") != 2 or node is None:
        return
    pb = arm.pose.bones
    sock = pb["socket_weapon_R"].matrix
    solver = clips.UpperBodySolver(arm)
    hand = solver._hand("L", sock @ Vector(node), sock.col[1].xyz, sock.col[2].xyz)
    for n in ("upperarm_L", "forearm_L", "hand_L"):
        pb[n].rotation_mode = "QUATERNION"
    solver._arm("L", hand.translation, Vector((0.7, 0.5, -0.6)))
    pb["hand_L"].matrix = Matrix.LocRotScale(pb["hand_L"].head.copy(), hand.to_quaternion(), None)
    bpy.context.view_layer.update()
    log(f"  {arm.name}: off hand {(pb['socket_weapon_L'].head - hand.translation).length * 100:.1f} cm from its grip on the {weapon}")

M = CHAR / "parts"
F = CHAR / "rookie_female"
him = soldier("rookie", [CHAR / "rookie_body.glb", M / "headgear_brim_helmet.glb", M / "boots_combat.glb",
                         M / "jetpack_twin_tank.glb"],
              Matrix.Translation((-0.58, 0.0, 0.32)) @ Matrix.Rotation(math.radians(-24), 4, "Z"))
her = soldier("rookie_female", [F / "rookie_female_body.glb", M / "headgear_brim_helmet_female.glb",
                                F / "parts" / "boots_combat_female.glb", M / "jetpack_twin_tank_female.glb"],
              Matrix.Translation((0.62, 0.55, 0.55)) @ Matrix.Rotation(math.radians(22), 4, "Z"))
hold(him, "k47")
hold(her, "longbow")
# both rifles held low, pointing down, not aimed (the owner: nothing that reads as promoting war)
SOLDIERS = [(him, "k47", "aim_rifle_down45", 0.0, -0.06), (her, "longbow", "aim_rifle_down45", 0.37, -0.04)]

# ------------------------------------------------------------------ jet exhaust and embers

def emission_material(name, colour, strength, fade_axis="Z"):
    """Emission that fades to transparent along the object's generated coordinate (a flame's length)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*colour, 1)
    em.inputs["Strength"].default_value = strength
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs[fade_axis], ramp.inputs["Fac"])
    # soft edges: transparent where the surface turns away from the camera, so the cone reads as a plume
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.35
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], inv.inputs[1])
    soft = nt.nodes.new("ShaderNodeMath")
    soft.operation = "MULTIPLY"
    nt.links.new(ramp.outputs["Color"], soft.inputs[0])
    nt.links.new(inv.outputs[0], soft.inputs[1])
    nt.links.new(soft.outputs[0], mix.inputs["Fac"])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


FLAME_CORE = emission_material("flame_core", (1.0, 0.50, 0.10), 7.0)
FLAME_OUTER = emission_material("flame_outer", (1.0, 0.25, 0.02), 3.0)
EMBER = bpy.data.materials.new("ember")
EMBER.use_nodes = True
_em = EMBER.node_tree.nodes
_bsdf = _em.get("Principled BSDF")
_bsdf.inputs["Emission Color"].default_value = (1.0, 0.38, 0.06, 1)
_bsdf.inputs["Emission Strength"].default_value = 3.0
_bsdf.inputs["Base Color"].default_value = (0.1, 0.03, 0.01, 1)

# nozzle exits in each soldier's bind pose (glTF character space, the twin tank's manifest `nozzles`), rigid to spine2
NOZZLES = {"rookie": [(-0.064, 0.536, -0.297), (0.069, 0.536, -0.233)]}


def nozzles_of(arm):
    import json
    m = json.loads((REPO / "apps/web/public/assets/cosmetics/jetpack/jetpack_twin_tank.json").read_text())
    pts = m["nozzles"] if arm.name == "rookie" else m["bodies"]["female"]["nozzles"]
    pb = arm.pose.bones["spine2"]
    rel = pb.matrix @ pb.bone.matrix_local.inverted()
    return [arm.matrix_world @ rel @ Vector((x, -z, y)) for x, y, z in pts]


FLAMES = []


def build_flames():
    for arm, *_ in SOLDIERS:
        for k, p in enumerate(nozzles_of(arm)):
            group = []
            for mat, r, length in ((FLAME_CORE, 0.026, 0.40), (FLAME_OUTER, 0.085, 0.95)):
                bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r, radius2=0.004, depth=length, end_fill_type="NOTHING")
                c = bpy.context.active_object
                c.name = f"flame_{arm.name}_{k}"
                c.data.materials.append(mat)
                c.visible_shadow = False
                group.append((c, length))
            light = bpy.data.lights.new(f"exhaust_{arm.name}_{k}", "POINT")
            light.color = (1.0, 0.5, 0.18)
            light.energy = 25  # stronger, the next soldier over (1.2 m away) out-lit the key on her front
            light.shadow_soft_size = 0.08
            lo = bpy.data.objects.new(light.name, light)
            scene.collection.objects.link(lo)
            FLAMES.append((arm, k, group, lo))


def place_flames(t):
    """Each flame hangs from its nozzle (pointing down, the pack's own down), flickering on a 5 s cycle."""
    for arm, k, group, light in FLAMES:
        p = nozzles_of(arm)[k]
        pb = arm.pose.bones["spine2"]
        down = (arm.matrix_world.to_3x3() @ (pb.matrix.to_3x3() @ pb.bone.matrix_local.to_3x3().inverted()) @ Vector((0, 0, -1))).normalized()
        phase = 2 * math.pi * t * (scene.render.fps / LOOP)
        flick = 1.0 + 0.10 * math.sin(phase * 7 + k * 1.7) + 0.06 * math.sin(phase * 13 + k)
        rot = Vector((0, 0, -1)).rotation_difference(down).to_matrix().to_4x4()
        for c, length in group:
            # the cone's base (its wide end) sits at the nozzle; its axis runs down
            c.matrix_world = Matrix.Translation(p) @ rot @ Matrix.Diagonal((1, 1, flick, 1)) @ Matrix.Translation((0, 0, -length / 2)) \
                @ Matrix.Rotation(math.pi, 4, "X")
        light.location = p + down * 0.25
        light.data.energy = 25 * flick


EMBERS = []


def build_embers(seed=7, count=0):  # none: in daylight they read as sparks from a fire
    rnd = random.Random(seed)
    for i in range(count):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=4, radius=1)
        e = bpy.context.active_object
        e.data.materials.append(EMBER)
        e.visible_shadow = False
        x, y, z = rnd.uniform(-2.2, 2.2), rnd.uniform(-1.2, 2.0), rnd.uniform(-0.2, 2.6)
        size = rnd.uniform(0.0025, 0.006)
        laps = 1 if rnd.uniform(0.25, 0.6) < 0.48 else 2
        EMBERS.append((e, Vector((x, y, z)), size, laps, rnd.uniform(0, 2 * math.pi)))


def place_embers(t):
    """Embers rise and drift; each rises once or twice over the loop, so its path repeats exactly."""
    span = LOOP / scene.render.fps
    for e, p0, size, laps, ph in EMBERS:
        rise = (p0.z + 2.8 * laps * t / span) % 2.8 - 0.2
        drift = 0.08 * math.sin(2 * math.pi * t / span + ph)
        e.location = Vector((p0.x + drift, p0.y, rise))
        e.scale = (size, size, size * 3.5)


# ------------------------------------------------------------------ camera, light, render

cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
if SHOT == "poster":
    cam_data.lens = 50
    cam_data.sensor_fit = "HORIZONTAL"
    cam.location = (0.0, -4.0, 0.35)
    target = Vector((0.0, 0.2, 1.42))
elif SHOT == "phone":  # 19.5:9: a little further back, so the rifle and the boots stay in the shorter frame
    cam_data.lens = 46
    cam.location = (0.0, -6.3, 0.45)
    target = Vector((0.0, 0.2, 1.08))
else:
    cam_data.lens = 46
    cam.location = (0.0, -5.4, 0.42)
    target = Vector((0.0, 0.2, 1.12))
if SHOT != "poster":
    cam_data.sensor_fit = "AUTO"
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def light(name, kind, colour, energy, loc, look, size=1.0):
    d = bpy.data.lights.new(name, kind)
    d.color = colour
    d.energy = energy
    if kind == "AREA":
        d.size = size
    if kind == "SUN":
        d.angle = math.radians(3)
    o = bpy.data.objects.new(name, d)
    scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(look) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o


# a bright afternoon (the plate's): a warm sun high on the right and in front, a soft blue sky all round, a gentle
# key from the front left and a white rim from behind
light("sun", "SUN", (1.0, 0.93, 0.82), 3.2, (4, -3, 7), (0, 0, 1.0))
light("rim", "AREA", (1.0, 0.97, 0.92), 300, (-1.5, 5.0, 3.0), (0, 0, 1.2), size=3.0)
light("key", "AREA", (1.0, 0.95, 0.88), 220, (-3.0, -4.0, 2.8), (0, 0, 1.1), size=3.0)

world = bpy.data.worlds.new("afternoon")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.58, 0.85, 1)  # the blue sky's fill
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
scene.world = world

r = scene.render
r.engine = "CYCLES"
r.resolution_x, r.resolution_y = W, H
r.resolution_percentage = 100
r.film_transparent = True
r.fps = 24
r.use_motion_blur = False
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Punchy"  # daylight flattens the vinyl; the plate is saturated
except TypeError:
    log("no AgX Punchy look; the base AgX")
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception as e:  # noqa: BLE001 - CPU is fine, only slower
    log("GPU unavailable, CPU:", e)

for o in scene.objects:
    if o.type == "MESH" and o.parent in (him, her):
        for slot in o.material_slots:
            m = slot.material
            if m and m.use_nodes and "Principled BSDF" in m.node_tree.nodes:
                b = m.node_tree.nodes["Principled BSDF"]
                b.inputs["Roughness"].default_value = 0.78  # the painted vinyl look, lit: matte, a soft sheen
                b.inputs["Metallic"].default_value = 0.0
                b.inputs["Specular IOR Level"].default_value = 0.25
                # a body albedo keeps its skin weight in the alpha (the dye system's); the importer would make it
                # see-through
                for link in list(b.inputs["Alpha"].links):
                    m.node_tree.links.remove(link)
                b.inputs["Alpha"].default_value = 1.0

build_flames()
build_embers()


def frame_at(t):
    for arm, weapon, aim, phase, lean in SOLDIERS:
        pose(arm, "jet_hover", aim, t + phase, lean)
        offhand(arm, weapon)
    place_flames(t)
    place_embers(t)


if FRAMES:
    loop_dir = Path(opt["loop-out"])
    loop_dir.mkdir(parents=True, exist_ok=True)
    for f in range(FRAMES[0], FRAMES[1] + 1):
        frame_at(f / r.fps)
        r.filepath = str(loop_dir / f"{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        log("frame", f)
else:
    frame_at(FRAME / r.fps)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    r.filepath = str(OUT)
    bpy.ops.render.render(write_still=True)
    log("rendered", OUT)
