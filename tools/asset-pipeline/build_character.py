"""Turn a generated character GLB (e.g. Higgsfield/Tripo) into a game-ready rigged glTF.

    blender -b --factory-startup --python tools/asset-pipeline/build_character.py -- \
        <raw.glb> <out_dir> [--name rookie] [--facing +x] [--height 1.5]

Steps (docs/04 §4-§5, NOTES.md §8):
  1. orient (face glTF +Z), scale to --height with the feet on z = 0, centre on the legs;
  2. decimate to LOD0 ≤ 4k tris, keep only the albedo texture at 1024² (toon look, ≤ 1.5 MB GPU);
  3. build the shared ~24-bone skeleton + 7 non-deform sockets from landmarks measured on the mesh;
  4. skin with distance-to-bone weights gated by body region (rigid head/helmet and jetpack);
  5. author 6 placeholder clips (idle, run, crouch_idle, jet_ascend, jet_hover, fall);
  6. export <name>.glb (LOD0) and <name>_lod1.glb (≤ 1.8k tris, same skeleton and clips),
     plus <name>_rig.json with the landmarks for the README/viewer.

--facing is the axis the raw model faces in Blender after import (Tripo multiview exports +x).
"""
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.geometry import intersect_point_line

argv = sys.argv[sys.argv.index("--") + 1:]
RAW, OUT = Path(argv[0]), Path(argv[1])
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1, 2) if argv[i].startswith("--")}
NAME = opt.get("name", "rookie")
FACING = opt.get("facing", "+x")
HEIGHT = float(opt.get("height", 1.5))
LOD0_TRIS, LOD1_TRIS = 3900, 1750
TEX = 1024
OUT.mkdir(parents=True, exist_ok=True)

YAW_TO_FRONT = {"-y": 0.0, "+x": -math.pi / 2, "+y": math.pi, "-x": math.pi / 2}  # → face Blender -Y = glTF +Z


def log(*a):
    print("[build_character]", *a, flush=True)


# ------------------------------------------------------------------ 1. import + normalise

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(RAW))
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
for o in bpy.context.scene.objects:
    o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = f"{NAME}_body"
# Unparent from any import empties, keeping the transform, then drop the empties.
mw = body.matrix_world.copy()
body.parent = None
body.matrix_world = mw
for o in list(bpy.context.scene.objects):
    if o is not body:
        bpy.data.objects.remove(o, do_unlink=True)

me = body.data
me.transform(Matrix.Rotation(YAW_TO_FRONT[FACING], 4, "Z") @ body.matrix_world)
body.matrix_world = Matrix.Identity(4)
zs = [v.co.z for v in me.vertices]
zmin, zmax = min(zs), max(zs)
s = HEIGHT / (zmax - zmin)
me.transform(Matrix.Scale(s, 4) @ Matrix.Translation((0, 0, -zmin)))
# Centre x/y on the legs (the jetpack would skew a bbox centre).
legs = [v.co for v in me.vertices if v.co.z < 0.25 * HEIGHT]
cx = (min(p.x for p in legs) + max(p.x for p in legs)) / 2
cy = sum(p.y for p in legs) / len(legs)
me.transform(Matrix.Translation((-cx, -cy, 0)))
me.update()
log(f"normalised: scale {s:.3f}, {len(me.polygons)} faces")

# ------------------------------------------------------------------ 2. landmarks + skeleton
# Measured on the full-resolution mesh: decimated slices are too sparse to cluster.

V = [v.co.copy() for v in me.vertices]
H = HEIGHT


def band(z0, z1, pred=lambda p: True):
    return [p for p in V if z0 <= p.z <= z1 and pred(p)]


def clusters(vals, gap=0.025):
    vals = sorted(vals)
    if not vals:
        return []
    out, a, prev = [], vals[0], vals[0]
    for v in vals[1:]:
        if v - prev > gap:
            out.append((a, prev))
            a = v
        prev = v
    out.append((a, prev))
    return out


def mean(pts):
    return sum(pts, Vector()) / len(pts)


def slice_x(z, half=0.012):
    return clusters([p.x for p in band(z - half, z + half)])


# Neck: narrowest slice (full width, so separate chin straps count) between 55% and 75% of the height.
neck_z = min((z / 100 for z in range(int(0.55 * H * 100), int(0.75 * H * 100))),
             key=lambda z: max((abs(p.x) for p in band(z - 0.012, z + 0.012)), default=9))
# Crotch: going up from the ankles, the first slice with geometry at x = 0.
crotch_z = next(z / 100 for z in range(int(0.1 * H * 100), int(neck_z * 100))
                if any(abs(p.x) < 0.012 for p in band(z / 100 - 0.01, z / 100 + 0.01)))
# Body depth centre (exclude the jetpack: the back half beyond the hips' depth).
# (the hands hang at hip height in an A-pose, so only take the cluster around x = 0)
hip_half = next(max(-a, b) for a, b in slice_x(crotch_z + 0.03) if a <= 0.01 and b >= -0.01)
hips = band(crotch_z, crotch_z + 0.05, lambda p: abs(p.x) <= hip_half)
back_y = max(p.y for p in hips) + 0.03
spine_y = mean(hips).y
# Arms: highest slice below the neck with a separate cluster beyond the hips' half width.
armpit_z = max(z / 100 for z in range(int((crotch_z + 0.1) * 100), int((neck_z - 0.08) * 100))
               if any(a > hip_half * 0.9 for a, b in slice_x(z / 100)))
arm_pts = [p for p in V if p.x > hip_half * 1.25 and crotch_z < p.z < armpit_z]
tip_z = min(p.z for p in arm_pts)
hand_end = mean([p for p in arm_pts if p.z < tip_z + 0.04])
shoulder_cluster = [c for c in slice_x(armpit_z) if c[0] > hip_half * 0.9]
shoulder = Vector((shoulder_cluster[0][0] - 0.02, spine_y, armpit_z + 0.04))
shoulder.y = mean(band(armpit_z - 0.03, armpit_z + 0.03, lambda p: p.x > shoulder.x)).y
chest_half = next(max(-a, b) for a, b in slice_x((crotch_z + armpit_z) / 2) if a <= 0.01 and b >= -0.01)
elbow = shoulder.lerp(hand_end, 0.42)
wrist = shoulder.lerp(hand_end, 0.70)
# Legs and feet.
leg_pts = band(crotch_z - 0.12, crotch_z - 0.04, lambda p: p.x > 0)
hip_j = Vector((mean(leg_pts).x, spine_y, crotch_z + 0.04))
foot_pts = band(0, 0.06 * H, lambda p: p.x > 0)
toe_y = min(p.y for p in foot_pts)
heel_y = max(p.y for p in foot_pts)
foot_x = mean(foot_pts).x
ankle = Vector((foot_x, heel_y - 0.10, 0.08 * H))
ball = Vector((foot_x, toe_y + 0.09, 0.03))
toe_tip = Vector((foot_x, toe_y + 0.01, 0.03))
knee = hip_j.lerp(ankle, 0.5) + Vector((0, -0.02, 0))
# Head.
top_z = H
face_z = neck_z + 0.27 * (top_z - neck_z)
face_y = min(p.y for p in band(face_z - 0.02, face_z + 0.02, lambda p: abs(p.x) < 0.08))
head_y = mean(band(neck_z + 0.02, neck_z + 0.10)).y
jet_pts = [p for p in V if p.y > back_y and crotch_z < p.z < neck_z]
jet_back = min(p.y for p in jet_pts) if jet_pts else back_y
jet_mid_z = (min(p.z for p in jet_pts) + max(p.z for p in jet_pts)) / 2 if jet_pts else armpit_z
jet_far = max(p.y for p in jet_pts) if jet_pts else back_y

marks = {k: [round(c, 4) for c in v] if isinstance(v, Vector) else round(v, 4) for k, v in {
    "neck_z": neck_z, "crotch_z": crotch_z, "hip_half": hip_half, "chest_half": chest_half, "armpit_z": armpit_z, "spine_y": spine_y, "back_y": back_y,
    "shoulder_L": shoulder, "elbow_L": elbow, "wrist_L": wrist, "hand_end_L": hand_end,
    "hip_L": hip_j, "knee_L": knee, "ankle_L": ankle, "ball_L": ball, "toe_L": toe_tip,
    "face_y": face_y, "jetpack_back_y": jet_back, "jetpack_mid_z": jet_mid_z,
}.items()}
log("landmarks", json.dumps(marks))


def mirror(v):
    return Vector((-v.x, v.y, v.z))


arm_data = bpy.data.armatures.new(f"{NAME}_skeleton")
arm = bpy.data.objects.new(f"{NAME}", arm_data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
FWD = Vector((0, -1, 0))


def bone(name, head, tail, parent=None, deform=True, connect=False, roll_ref=FWD):
    b = eb.new(name)
    b.head, b.tail = Vector(head), Vector(tail)
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    b.use_deform = deform
    # Bone Z axis points forward (or up for bones that already point forward), so local +X is
    # "flex forward" for every vertical bone; the clips below rely on that.
    d = (b.tail - b.head).normalized()
    b.align_roll(Vector((0, 0, 1)) if abs(d.dot(roll_ref)) > 0.9 else roll_ref)
    return b


P = lambda x, y, z: Vector((x, y, z))  # noqa: E731
bone("root", P(0, 0, 0), P(0, 0, 0.12))
pelvis_z = crotch_z + 0.05
spine_top = neck_z - 0.10
bone("pelvis", P(0, spine_y, pelvis_z), P(0, spine_y, pelvis_z + 0.10), "root")
bone("spine1", P(0, spine_y, pelvis_z + 0.10), P(0, spine_y, (pelvis_z + 0.10 + spine_top) / 2), "pelvis", connect=True)
bone("spine2", P(0, spine_y, (pelvis_z + 0.10 + spine_top) / 2), P(0, spine_y, spine_top), "spine1", connect=True)
bone("neck", P(0, spine_y, spine_top), P(0, head_y, neck_z + 0.03), "spine2", connect=True)
bone("head", P(0, head_y, neck_z + 0.03), P(0, head_y, top_z), "neck", connect=True)
bone("jaw", P(0, head_y - 0.02, neck_z + 0.08), P(0, face_y + 0.03, neck_z + 0.05), "head")
for side, m in (("L", lambda v: v), ("R", mirror)):
    bone(f"eye_{side}", m(P(0.075, face_y + 0.04, face_z)), m(P(0.075, face_y - 0.01, face_z)), "head")
    bone(f"clavicle_{side}", m(P(0.03, spine_y, spine_top - 0.02)), m(shoulder), "spine2")
    bone(f"upperarm_{side}", m(shoulder), m(elbow), f"clavicle_{side}", connect=True)
    bone(f"forearm_{side}", m(elbow), m(wrist), f"upperarm_{side}", connect=True)
    bone(f"hand_{side}", m(wrist), m(hand_end), f"forearm_{side}", connect=True)
    bone(f"thigh_{side}", m(hip_j), m(knee), "pelvis")
    bone(f"calf_{side}", m(knee), m(ankle), f"thigh_{side}", connect=True)
    bone(f"foot_{side}", m(ankle), m(ball), f"calf_{side}", connect=True)
    bone(f"toe_{side}", m(ball), m(toe_tip), f"foot_{side}", connect=True)

# Sockets (non-deform). Weapon sockets point forward: their +Y is the muzzle direction.
grip_R = mirror(wrist.lerp(hand_end, 0.45))
bone("socket_weapon_R", grip_R, grip_R + Vector((0, -0.08, 0)), "hand_R", deform=False)
grip_L = wrist.lerp(hand_end, 0.45)
bone("socket_weapon_L", grip_L, grip_L + Vector((0, -0.08, 0)), "hand_L", deform=False)
off = grip_R + Vector((0, -0.16, 0.02))
bone("socket_offhand_IK", off, off + Vector((0, -0.05, 0)), "socket_weapon_R", deform=False)
bone("socket_jetpack", P(0, jet_back, jet_mid_z), P(0, jet_back, jet_mid_z + 0.08), "spine2", deform=False)
bone("socket_back", P(0, jet_far, spine_top), P(0, jet_far, spine_top + 0.08), "spine2", deform=False)
bone("socket_hat", P(0, head_y, top_z - 0.08), P(0, head_y, top_z), "head", deform=False)
bone("socket_nameplate", P(0, 0, H + 0.25), P(0, 0, H + 0.33), "root", deform=False)
bpy.ops.object.mode_set(mode="OBJECT")
arm["slot"] = "body"
arm["bodyTypes"] = ["standard"]
arm["envelopeOk"] = True
arm["source"] = "higgsfield/tripo_h3_1_multiview_to_3d + tools/asset-pipeline/build_character.py"

# ------------------------------------------------------------------ 3. LODs: decimate + bake

def tri_count(m):
    m.calc_loop_triangles()
    return len(m.loop_triangles)


def decimate(obj, target):
    t0 = tri_count(obj.data)
    bpy.context.view_layer.objects.active = obj
    for attempt in range(3):
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.use_collapse_triangulate = True
        mod.ratio = target / tri_count(obj.data) * (0.995 if attempt else 1.0)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        if tri_count(obj.data) <= target:
            break
    return t0, tri_count(obj.data)


# Collapse decimation wrecks the generator's UV seams (streaks of empty atlas), so every LOD gets
# fresh UVs and the original texture is baked onto it from the full-resolution mesh.
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
hi = body
hi.name = f"{NAME}_highres"
# The DIFFUSE/COLOR bake returns base colour × (1 - metallic): zero the generator's metalness
# (e.g. Tripo's glossy goggle lenses) so metal parts keep their albedo.
for m in hi.data.materials:
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            for ln in list(n.inputs["Metallic"].links):
                m.node_tree.links.remove(ln)
            n.inputs["Metallic"].default_value = 0.0


def make_lod(tris, tex, suffix):
    lo = hi.copy()
    lo.data = hi.data.copy()
    lo.name = f"{NAME}_body{suffix}"
    scene.collection.objects.link(lo)
    lo.modifiers.clear()
    t0, t1 = decimate(lo, tris)
    while lo.data.uv_layers:
        lo.data.uv_layers.remove(lo.data.uv_layers[0])
    lo.data.uv_layers.new(name="UVMap")
    for o in scene.objects:
        o.select_set(o == lo)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()

    img = bpy.data.images.new(f"{NAME}{suffix}_albedo", tex, tex, alpha=False)
    mat = bpy.data.materials.new(f"{NAME}{suffix}_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.9
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = img
    nt.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
    nt.nodes.active = tn  # the bake target
    lo.data.materials.clear()
    lo.data.materials.append(mat)

    hi.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=0.02, max_ray_distance=0.06, margin=8)
    img.pack()
    log(f"{lo.name}: {t0} -> {t1} tris, baked {tex}² albedo")
    return lo, t1


body, lod0_tris = make_lod(LOD0_TRIS, TEX, "")
lod1, lod1_tris = make_lod(LOD1_TRIS, TEX // 2, "_lod1")
raw_tris = tri_count(hi.data)
bpy.data.objects.remove(hi, do_unlink=True)
bpy.data.orphans_purge(do_recursive=True)

# ------------------------------------------------------------------ 4. skinning

DEFORM = [b for b in arm_data.bones if b.use_deform and b.name not in {"root", "jaw", "eye_L", "eye_R"}]
SEG = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in DEFORM}
NEIGH = {}
for b in DEFORM:
    n = {b.name}
    if b.parent and b.parent.name in SEG:
        n.add(b.parent.name)
    n.update(c.name for c in b.children if c.name in SEG)
    NEIGH[b.name] = n
ARM_BONES = {f"{p}_{s}" for p in ("clavicle", "upperarm", "forearm", "hand") for s in "LR"}
LEG_BONES = {f"{p}_{s}" for p in ("thigh", "calf", "foot", "toe") for s in "LR"}
arm_split = {}  # z (2 cm steps) -> |x| beyond which a vertex belongs to an arm


def arm_threshold(z):
    """Halfway between the torso's edge and the arm's inner edge in this height slice."""
    k = round(z * 50)
    if k not in arm_split:
        cs = slice_x(k / 50, 0.02)
        core = next((max(-a, b) for a, b in cs if a <= 0.01 and b >= -0.01), hip_half)
        # Where an arm touches the chest the slice merges into one wide cluster: use the chest.
        if core > max(chest_half, hip_half) + 0.03:
            core = chest_half
        inner = [a for a, b in cs if a > core] + [-b for a, b in cs if b < -core]
        arm_split[k] = (core + min(inner)) / 2 if inner else core + 0.02
    return arm_split[k]


def seg_dist(p, name):
    a, b = SEG[name]
    q, t = intersect_point_line(p, a, b)
    t = min(max(t, 0.0), 1.0)
    return (p - a.lerp(b, t)).length


def allowed(p):
    """(bones this vertex may bind to, rigid?) by body region."""
    ax = abs(p.x)
    side = "L" if p.x >= 0 else "R"
    if p.z > neck_z + 0.015:
        return ({"head"}, True) if p.z > neck_z + 0.06 else ({"head", "neck"}, False)
    if p.y > back_y and crotch_z < p.z < neck_z:
        return {"spine2"}, True  # jetpack: rigid to the chest
    if p.z < ankle.z + 0.02 and ax < hip_half * 1.6:
        return {f"foot_{side}"}, True  # stiff boots
    if p.z < crotch_z - 0.02 and ax < hip_half * 1.15:
        return {b for b in LEG_BONES if b.endswith(side)} | {"pelvis"}, False
    # Below the armpit an arm is whatever lies beyond the torso; above it, the shoulder cap.
    beyond = ax > arm_threshold(p.z) if p.z < armpit_z else ax > shoulder.x - 0.04
    if beyond and p.z > tip_z - 0.03:  # nothing below the fingertips is arm
        return {b for b in ARM_BONES if b.endswith(side)} | {"spine2"}, False
    torso = {"pelvis", "spine1", "spine2", "neck", f"clavicle_{side}", f"thigh_{side}"}
    if armpit_z - 0.06 < p.z < shoulder.z + 0.06 and ax > 0.8 * chest_half:
        torso.add(f"upperarm_{side}")  # soft armpit when the arm is raised
    return torso, False


def skin(obj):
    LV = [v.co.copy() for v in obj.data.vertices]
    zones = [allowed(p) for p in LV]
    weights = []
    for p, (cand, _) in zip(LV, zones):
        near = min(cand, key=lambda n: seg_dist(p, n))
        pool = (NEIGH[near] & cand) | {near}
        raw = {n: 1.0 / (seg_dist(p, n) + 0.01) ** 5 for n in pool}
        top = sorted(raw.items(), key=lambda kv: -kv[1])[:3]
        tot = sum(w for _, w in top)
        weights.append({n: w / tot for n, w in top})

    # Smooth across mesh edges for soft joints; rigid zones stay rigid and nothing leaks into a
    # bone the vertex's zone doesn't allow.
    adj = [[] for _ in LV]
    for e in obj.data.edges:
        a, b = e.vertices
        adj[a].append(b)
        adj[b].append(a)
    for _ in range(2):
        nxt = []
        for i, w in enumerate(weights):
            cand, rigid = zones[i]
            if rigid:
                nxt.append(w)
                continue
            acc = dict(w)
            for j in adj[i]:
                for n, x in weights[j].items():
                    if n in cand:
                        acc[n] = acc.get(n, 0) + 0.5 * x / max(1, len(adj[i]))
            top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
            tot = sum(x for _, x in top)
            nxt.append({n: x / tot for n, x in top})
        weights = nxt

    for b in arm_data.bones:
        if b.use_deform:
            obj.vertex_groups.new(name=b.name)
    for i, w in enumerate(weights):
        for n, x in w.items():
            if x > 1e-4:
                obj.vertex_groups[n].add([i], x, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
    log("skinned", obj.name, len(LV), "verts")


skin(body)
skin(lod1)

# ------------------------------------------------------------------ 5. clips

FPS = 30
bpy.context.scene.render.fps = FPS
arm.animation_data_create()
arm.rotation_mode = "XYZ"
for pb in arm.pose.bones:
    pb.rotation_mode = "XYZ"


def deg(*a):
    return tuple(math.radians(x) for x in a)


def clip(name, length, keys):
    """keys: {bone: [(frame, (rx, ry, rz) degrees, optional location)]}. Loops back to frame 0."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for bname, frames in keys.items():
        pb = arm.pose.bones[bname]
        for k in frames + [(length, *frames[0][1:])]:
            f, rot = k[0], k[1]
            pb.rotation_euler = deg(*rot)
            pb.keyframe_insert("rotation_euler", frame=f)
            if len(k) > 2:
                pb.location = k[2]
                pb.keyframe_insert("location", frame=f)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    arm.animation_data.action = None
    return act


# Signs: +X flexes any vertical bone forward; calves bend back with -X; arm swing fore/aft is
# +X; raising an arm sideways is +Z on the left and -Z on the right.
clip("idle", 60, {
    "spine1": [(0, (0, 0, 0)), (30, (2, 0, 0))],
    "spine2": [(0, (0, 0, 0)), (30, (2, 0, 0))],
    "head": [(0, (0, 0, 0)), (30, (-3, 0, 0))],
    "upperarm_L": [(0, (0, 0, 0)), (30, (0, 0, 4))],
    "upperarm_R": [(0, (0, 0, 0)), (30, (0, 0, -4))],
    "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (30, (0, 0, 0), (0, -0.01, 0))],
})
clip("run", 18, {
    "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (4, (0, 0, 0), (0, 0.035, 0)), (9, (0, 0, 0), (0, 0, 0)), (13, (0, 0, 0), (0, 0.035, 0))],
    "spine1": [(0, (10, 0, 0))],
    "thigh_L": [(0, (40, 0, 0)), (9, (-35, 0, 0))],
    "thigh_R": [(0, (-35, 0, 0)), (9, (40, 0, 0))],
    "calf_L": [(0, (-15, 0, 0)), (5, (-10, 0, 0)), (9, (-20, 0, 0)), (13, (-70, 0, 0))],
    "calf_R": [(0, (-20, 0, 0)), (4, (-70, 0, 0)), (9, (-15, 0, 0)), (14, (-10, 0, 0))],
    "upperarm_L": [(0, (-35, 0, -10)), (9, (40, 0, -10))],
    "upperarm_R": [(0, (40, 0, 10)), (9, (-35, 0, 10))],
    "forearm_L": [(0, (30, 0, 0))],
    "forearm_R": [(0, (30, 0, 0))],
})
# Crouch: the crouched head hitbox centre is 0.84 m (vs 1.24), so squat deep and tuck the head.
clip("crouch_idle", 60, {
    "pelvis": [(0, (0, 0, 0), (0, -0.23, -0.06)), (30, (0, 0, 0), (0, -0.235, -0.06))],
    "thigh_L": [(0, (95, 0, -10))],
    "thigh_R": [(0, (95, 0, 10))],
    "calf_L": [(0, (-140, 0, 0))],
    "calf_R": [(0, (-140, 0, 0))],
    "foot_L": [(0, (45, 0, 0))],
    "foot_R": [(0, (45, 0, 0))],
    "spine1": [(0, (22, 0, 0)), (30, (24, 0, 0))],
    "spine2": [(0, (12, 0, 0))],
    "neck": [(0, (0, 0, 0))],
    "head": [(0, (-12, 0, 0))],
    "upperarm_L": [(0, (25, 0, -10))],
    "upperarm_R": [(0, (25, 0, 10))],
})
clip("jet_ascend", 24, {
    "spine1": [(0, (-6, 0, 0)), (12, (-4, 0, 0))],
    "thigh_L": [(0, (8, 0, 2)), (12, (12, 0, 2))],
    "thigh_R": [(0, (4, 0, -2)), (12, (8, 0, -2))],
    "calf_L": [(0, (-20, 0, 0)), (12, (-26, 0, 0))],
    "calf_R": [(0, (-14, 0, 0)), (12, (-20, 0, 0))],
    "foot_L": [(0, (-25, 0, 0))],
    "foot_R": [(0, (-25, 0, 0))],
    "upperarm_L": [(0, (-20, 0, -12)), (12, (-24, 0, -10))],
    "upperarm_R": [(0, (-20, 0, 12)), (12, (-24, 0, 10))],
})
clip("jet_hover", 36, {
    "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (18, (0, 0, 0), (0, 0.02, 0))],
    "thigh_L": [(0, (14, 0, 4)), (18, (6, 0, 4))],
    "thigh_R": [(0, (4, 0, -4)), (18, (12, 0, -4))],
    "calf_L": [(0, (-35, 0, 0)), (18, (-25, 0, 0))],
    "calf_R": [(0, (-22, 0, 0)), (18, (-32, 0, 0))],
    "foot_L": [(0, (-15, 0, 0))],
    "foot_R": [(0, (-15, 0, 0))],
    "upperarm_L": [(0, (0, 0, 12)), (18, (0, 0, 16))],
    "upperarm_R": [(0, (0, 0, -12)), (18, (0, 0, -16))],
})
clip("fall", 20, {
    "spine1": [(0, (-8, 0, 0))],
    "head": [(0, (8, 0, 0))],
    "thigh_L": [(0, (25, 0, 10)), (10, (10, 0, 12))],
    "thigh_R": [(0, (5, 0, -12)), (10, (22, 0, -10))],
    "calf_L": [(0, (-40, 0, 0)), (10, (-20, 0, 0))],
    "calf_R": [(0, (-15, 0, 0)), (10, (-40, 0, 0))],
    "upperarm_L": [(0, (0, 0, 70)), (10, (8, 0, 78))],
    "upperarm_R": [(0, (0, 0, -70)), (10, (8, 0, -78))],
    "forearm_L": [(0, (20, 0, 0)), (10, (35, 0, 0))],
    "forearm_R": [(0, (35, 0, 0)), (10, (20, 0, 0))],
})
for pb in arm.pose.bones:
    pb.rotation_euler = (0, 0, 0)
    pb.location = (0, 0, 0)
log("clips", [a.name for a in bpy.data.actions])

# ------------------------------------------------------------------ 6. export


def export(path, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=False, export_extras=True,
        export_skins=True, export_def_bones=False, export_influence_nb=4,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_reset_pose_bones=True, export_anim_slide_to_zero=True,
        export_image_format="JPEG", export_jpeg_quality=90,
        export_materials="EXPORT", export_normals=True, export_texcoords=True,
        export_tangents=False, export_morph=False, export_cameras=False, export_lights=False,
    )
    log("wrote", path, f"{path.stat().st_size / 1024:.0f} KB")


export(OUT / f"{NAME}.glb", [arm, body])

export(OUT / f"{NAME}_lod1.glb", [arm, lod1])

(OUT / f"{NAME}_rig.json").write_text(json.dumps({
    "name": NAME, "height_m": HEIGHT, "source": RAW.name,
    "tris": {"raw": raw_tris, "lod0": lod0_tris, "lod1": lod1_tris},
    "albedo": {"lod0": TEX, "lod1": TEX // 2}, "landmarks_blender_zup": marks,
    "clips": sorted(a.name for a in bpy.data.actions),
}, indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "source" / f"{NAME}.blend"), compress=True)
log("done")
