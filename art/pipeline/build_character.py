"""Turn a generated character GLB (e.g. Higgsfield/Tripo) into game-ready rigged glTF parts.

    blender -b --factory-startup --python art/pipeline/build_character.py -- \
        <raw.glb> <art_out_dir> [--name rookie] [--facing +x] [--height 1.5] [--runtime <dir>]

Steps (docs/04 §4-§5 and §9, NOTES.md §8):
  1. orient (face glTF +Z), scale to --height with the feet on z = 0, centre on the legs;
  2. measure landmarks on the full mesh and build the shared skeleton + 7 sockets;
  3. split the jetpack's shells off into their own part (docs/04 §3: the jetpack is a slot);
  4. LODs per part: collapse-decimate, fresh UVs, bake the original albedo (body 1024²/512²,
     jetpack 512²/256²); LOD0 body + jetpack ≤ 3,900 tris, LOD1 ≤ 1,750;
  5. skin the body (distance-to-bone weights gated by region), the jetpack rigidly to spine2;
  6. author the clip library (clips.py): locomotion, aim poses per weapon family, actions;
  7. dye masks per part (dye.py), default dyes into the glTF extras;
  8. export art sources (plain GLB) and, with --runtime, the web build (meshopt GLB + WebP).

--facing is the axis the raw model faces in Blender after import (Tripo multiview exports +x).

A second base body (the female soldier, docs/04 §3) is built on the first one's skeleton:

    blender -b --factory-startup --python art/pipeline/build_character.py -- \
        <raw.glb> art/character/rookie_female --name rookie_female --body female --parts boots \
        --skeleton art/character/source/rookie.blend --height 1.44 --depth 1.08 --back-depth 1.6 --head-depth 1.2 \
        [--runtime <dir>]

--skeleton fits the body onto that rig (step 4b): every vertex follows its skin weights from this body's
own measured bones onto the rig's, so both bodies share bones, rest pose, sockets, hitbox and clips. Its
default parts (--parts: which ones the generated model wears) ship as that body's fit of the shared items
(`<id>_<body>.glb`, the item manifest's `bodies.<body>`). Without a helmet the generator modelled the head
and hair, so no hair cap is added.
"""
import colorsys
import json
import math
import shutil
import struct
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.geometry import intersect_point_line

sys.dont_write_bytecode = True  # no __pycache__ in art/
sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
import clips  # noqa: E402
import dye  # noqa: E402
import envelope  # noqa: E402
import eyes  # noqa: E402
import nozzles  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
RAW, OUT = Path(argv[0]), Path(argv[1])
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1, 2) if argv[i].startswith("--")}
NAME = opt.get("name", "rookie")
RUNTIME = Path(opt["runtime"]) if "runtime" in opt else None
FACING = opt.get("facing", "+x")
HEIGHT = float(opt.get("height", 1.5))
BODY = opt.get("body", "male")  # docs/04 §3 base body: content BODIES
SKELETON = Path(opt["skeleton"]) if "skeleton" in opt else None  # fit onto this .blend's rig (step 4b)
# --skeleton: deepen the torso behind the spine and the head front to back (docs/04 §1.2: a body's side silhouette
# must cover the shared hitbox like the reference's; a flat back and a shallow head read small on it)
DEPTH = float(opt.get("depth", 1.0))  # the whole body front to back, knees to neck
BACK_DEPTH = float(opt.get("back-depth", 1.0))
HEAD_DEPTH = float(opt.get("head-depth", 1.0))
WANT_PARTS = opt.get("parts", "headgear,boots,jetpack").split(",")  # default parts the generated model wears
# (body, jetpack) budgets: LOD0 sums to 3,900 of 4,000 tris, LOD1 to 1,750 of 1,800 (docs/04 §5.6)
# Parts: the generated soldier is split into body + the default headgear, boots and jetpack, so
# each slot can be swapped for a cosmetic (docs/04 §3). With the cosmetic slot budgets in
# build_cosmetics.py (eyewear 150, gloves 150), a fully dressed character stays ≤ 3,950 / 1,720
# tris (docs/04 §5.6); textures (albedo + dye mask) fit 1.5 MB of GPU memory per character.
LODS = {
    "": {"body": (2350, 512), "headgear": (450, 256), "boots": (300, 256), "jetpack": (550, 256)},
    "_lod1": {"body": (1000, 256), "headgear": (200, 128), "boots": (130, 128), "jetpack": (250, 128)},
}
# The creator's close-up textures (`dye.lod0.heroAlbedo` / `heroMask`, CharacterInstance.setHero): the LOD0 body
# baked again at 1024² on the same UVs, with the same dye rules. Only the creator loads them, never a match.
HERO_TEX = 1024
HERO = {}  # (part, suffix) -> the hero albedo image
EYES = {}  # side -> the painted eye (eyes.measure)
PART_IDS = {"body": f"{NAME}_body", "headgear": "headgear_brim_helmet", "boots": "boots_combat", "jetpack": "jetpack_twin_tank"}
PART_IDS = {k: v for k, v in PART_IDS.items() if k == "body" or k in WANT_PARTS}
# file stems: another body's fit of a shared item gets the body's suffix (boots_combat_female.glb)
FILE_IDS = {k: v if k == "body" or BODY == "male" else f"{v}_{BODY}" for k, v in PART_IDS.items()}
PART_SLOTS = {"headgear": ("socket_hat", "head"), "boots": (None, None), "jetpack": ("socket_jetpack", "spine2")}
PART_NAMES = {"headgear": "Brim Helmet", "boots": "Combat Boots", "jetpack": "Twin Tank"}
OUT.mkdir(parents=True, exist_ok=True)

YAW_TO_FRONT = {"-y": 0.0, "+x": -math.pi / 2, "+y": math.pi, "-x": math.pi / 2}  # → face Blender -Y = glTF +Z


def log(*a):
    print("[build_character]", *a, flush=True)


# ------------------------------------------------------------------ 1. import + normalise


def import_normalised(path, name, height, facing):
    """A generated GLB as one mesh object facing glTF +Z (Blender -Y), `height` tall with the feet on z = 0 and
    centred on its legs (the jetpack would skew a bbox centre). Returns the object and the scale applied."""
    before = {o.name for o in bpy.context.scene.objects}
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o.name for o in bpy.context.scene.objects if o.name not in before]
    meshes = [bpy.data.objects[n] for n in new if bpy.data.objects[n].type == "MESH"]
    for o in bpy.context.scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    # Unparent from any import empties, keeping the transform, then drop the empties.
    mw = obj.matrix_world.copy()
    obj.parent = None
    obj.matrix_world = mw
    for n in new:
        o = bpy.data.objects.get(n)
        if o is not None and o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)
    me = obj.data
    me.transform(Matrix.Rotation(YAW_TO_FRONT[facing], 4, "Z") @ obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)
    zs = [v.co.z for v in me.vertices]
    zmin, zmax = min(zs), max(zs)
    s = height / (zmax - zmin)
    me.transform(Matrix.Scale(s, 4) @ Matrix.Translation((0, 0, -zmin)))
    legs = [v.co for v in me.vertices if v.co.z < 0.25 * height]
    cx = (min(p.x for p in legs) + max(p.x for p in legs)) / 2
    cy = sum(p.y for p in legs) / len(legs)
    me.transform(Matrix.Translation((-cx, -cy, 0)))
    me.update()
    return obj, s


bpy.ops.wm.read_homefile(use_empty=True)
body, s = import_normalised(RAW, f"{NAME}_body", HEIGHT, FACING)
me = body.data
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


def measure():
    """The landmarks of the mesh in V: the joints the skeleton is built on and the girth the skinning reads."""
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
    # Legs and feet.
    leg_pts = band(crotch_z - 0.12, crotch_z - 0.04, lambda p: p.x > 0)
    hip_j = Vector((mean(leg_pts).x, spine_y, crotch_z + 0.04))
    foot_pts = band(0, 0.06 * H, lambda p: p.x > 0)
    toe_y = min(p.y for p in foot_pts)
    heel_y = max(p.y for p in foot_pts)
    foot_x = mean(foot_pts).x
    ankle = Vector((foot_x, heel_y - 0.10, 0.08 * H))
    # Head.
    face_z = neck_z + 0.27 * (H - neck_z)
    jet_pts = [p for p in V if p.y > back_y and crotch_z < p.z < neck_z]
    return {
        "neck_z": neck_z, "crotch_z": crotch_z, "hip_half": hip_half, "chest_half": chest_half, "armpit_z": armpit_z,
        "spine_y": spine_y, "back_y": back_y, "tip_z": tip_z,
        "shoulder": shoulder, "elbow": shoulder.lerp(hand_end, 0.42), "wrist": shoulder.lerp(hand_end, 0.70), "hand_end": hand_end,
        "hip_j": hip_j, "knee": hip_j.lerp(ankle, 0.5) + Vector((0, -0.02, 0)), "ankle": ankle,
        "ball": Vector((foot_x, toe_y + 0.09, 0.03)), "toe_tip": Vector((foot_x, toe_y + 0.01, 0.03)),
        "top_z": H, "face_z": face_z,
        "face_y": min(p.y for p in band(face_z - 0.02, face_z + 0.02, lambda p: abs(p.x) < 0.08)),
        "head_y": mean(band(neck_z + 0.02, neck_z + 0.10)).y,
        "jet_back": min(p.y for p in jet_pts) if jet_pts else back_y,
        "jet_mid_z": (min(p.z for p in jet_pts) + max(p.z for p in jet_pts)) / 2 if jet_pts else armpit_z,
        "jet_far": max(p.y for p in jet_pts) if jet_pts else back_y,
    }


def marks_of(L):
    """The landmarks as rookie_rig.json records them."""
    return {k: [round(c, 4) for c in v] if isinstance(v, Vector) else round(v, 4) for k, v in {
        "neck_z": L["neck_z"], "crotch_z": L["crotch_z"], "hip_half": L["hip_half"], "chest_half": L["chest_half"],
        "armpit_z": L["armpit_z"], "spine_y": L["spine_y"], "back_y": L["back_y"],
        "shoulder_L": L["shoulder"], "elbow_L": L["elbow"], "wrist_L": L["wrist"], "hand_end_L": L["hand_end"],
        "hip_L": L["hip_j"], "knee_L": L["knee"], "ankle_L": L["ankle"], "ball_L": L["ball"], "toe_L": L["toe_tip"],
        "face_y": L["face_y"], "jetpack_back_y": L["jet_back"], "jetpack_mid_z": L["jet_mid_z"],
    }.items()}


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def arm_axis(L):
    """The left arm's axis where it hangs clear of the torso (A-pose): a line through the middle of the outermost
    cluster of each 2 cm slice, from the fingertips up to where the arm joins the torso. Returns the axis's points
    at that join (`top`) and at the fingertips (`tip`), the join's height, and the arm's inner edge per slice."""
    pts, inner, z, top_z = [], {}, L["tip_z"] + 0.03, None
    while z < L["neck_z"] - 0.1:
        side = [c for c in slice_x(z) if c[0] > 0 and c[1] - c[0] >= 0.04]  # the torso's cluster straddles x = 0
        if not side or max(side, key=lambda c: c[1])[1] - max(side, key=lambda c: c[1])[0] > 0.2:
            break  # the arm has merged with the torso
        a, b = max(side, key=lambda c: c[1])
        pts.append(mean(band(z - 0.012, z + 0.012, lambda p: a <= p.x <= b)))
        inner[round(z, 2)] = a
        top_z = z
        z += 0.02
    c = mean(pts)
    d = Vector(np.linalg.svd(np.array([p - c for p in pts]))[2][0])
    d = -d if d.z > 0 else d  # down the arm, towards the hand

    def at(zz):
        return c + d * ((zz - c.z) / d.z)

    return at(top_z), at(L["tip_z"]), top_z, inner


def register(ref_raw, ref_height, ref_rig, ref_body):
    """--skeleton: before rigging, move this body onto the reference body's proportions so the reference's skeleton
    fits it, keeping its own build. (1) Shift it front to back so the hips line up. (2) Turn and stretch each arm
    about where it joins the torso onto the reference's arm axis (girth kept), so the hands meet the reference's
    grip sockets; the shoulder blends over 10 cm. (3) Scale the head about the neck so it fits inside the
    reference's head (the hair cap every hat and pair of eyewear was fitted to), then put it on the reference's
    neck with its crown at the reference's. Both arms' axes are measured the same way on both raw meshes, so the reference's own skeleton
    measurements never enter it. (4) Deepen the body front to back (DEPTH, knees to neck), the upper back behind the
    spine (BACK_DEPTH) and the head (HEAD_DEPTH, backwards, still inside the reference's head), so its side silhouette
    covers the shared hitbox like the reference's (docs/04 §1.2). Returns the head scale."""
    global V
    own = measure()
    ref_obj, _ = import_normalised(ref_raw, "reference", ref_height, FACING)
    keep = V
    V = [v.co.copy() for v in ref_obj.data.vertices]
    ref = measure()
    ref_top, ref_tip, _, _ = arm_axis(ref)
    V = keep
    bpy.data.objects.remove(ref_obj, do_unlink=True)

    dy = ref["spine_y"] - own["spine_y"]
    me.transform(Matrix.Translation((0, dy, 0)))
    V = [v.co.copy() for v in me.vertices]
    own = measure()
    top, tip, join_z, inner = arm_axis(own)
    d0, d1 = tip - top, ref_tip - ref_top
    turn = d0.normalized().rotation_difference(d1.normalized()).to_matrix()
    keys = sorted(inner)

    def arm_weight(q):
        if q.z > join_z + 0.10:
            return 0.0
        edge = inner[min(keys, key=lambda k: abs(k - min(q.z, join_z)))] - 0.01
        if q.x < edge:
            return 0.0
        return 1.0 - smoothstep(join_z, join_z + 0.10, q.z)

    # the head: scale about the neck so every extent fits the reference's head, then onto the reference's neck
    def head_box(verts, neck):
        pts = np.array([tuple(p) for p in verts if p.z > neck + 0.015])
        return pts.min(axis=0), pts.max(axis=0)

    ref_lo, ref_hi = head_box([v.co for v in ref_body.data.vertices], ref["neck_z"])
    own_lo, own_hi = head_box(V, own["neck_z"])
    ratios = (ref_hi - ref_lo) / (own_hi - own_lo)
    # 1.5 % under the tightest fit, with the crown on the reference's: her nape hair then clears the long guns'
    # stocks in the -45° holds by 6 mm (tools/asset-check/head_clearance.py), and every hat still sits the same
    s_head = float(min(ratios)) * 0.985
    pivot = Vector((0, own["head_y"], own["neck_z"] + 0.03))
    onto = ref_rig.data.bones["head"].head_local.copy()
    # up or down so the scaled head's crown meets the reference's (aligning necks left her chin 1 cm low, in the
    # way of the pistol and rifle holds: tools/asset-check/head_clearance.py)
    onto.z = float(ref_hi[2]) - (float(own_hi[2]) - pivot.z) * s_head
    log(f"register: hips moved {dy * 100:+.1f} cm deep; arm {d0.length:.3f} -> {d1.length:.3f} m, turned "
        f"{math.degrees(d0.angle(d1)):.1f} deg about z {join_z:.2f}; head x{s_head:.3f} (per axis {np.round(ratios, 3).tolist()})")
    head_s = Vector((s_head, s_head * HEAD_DEPTH, s_head))
    if HEAD_DEPTH * s_head > float(ratios[1]) * 0.985:
        raise RuntimeError(f"--head-depth {HEAD_DEPTH}: the head would come out of the reference's ({ratios[1]:.3f} deep)")
    # the face stays where the plain scale puts it (the guns' holds pass close to it); the head deepens backwards
    onto.y += (float(own_lo[1]) - pivot.y) * s_head * (1 - HEAD_DEPTH)
    spine = own["spine_y"]
    worst = 0.0
    for v in me.vertices:
        p = v.co.copy()
        side = 1.0 if p.x >= 0 else -1.0
        q = Vector((abs(p.x), p.y, p.z))  # the right arm mirrors the left
        w = arm_weight(q)
        if w > 0:
            r = q - top
            t = r.dot(d0) / d0.length_squared
            q = q.lerp(ref_top + d1 * t + turn @ (r - d0 * t), w)
        q.x *= side
        wh = smoothstep(own["neck_z"] - 0.02, own["neck_z"] + 0.03, q.z)
        if wh > 0:
            q = q.lerp(onto + (q - pivot) * head_s, wh)
        if DEPTH != 1.0:
            # below the knees it fades out (the shared boots' shafts fit the trouser cuffs as they are), and the arms
            # keep theirs (her coarse hands fold at the wrist when thickened, and gloves are built from them)
            wd = smoothstep(0.30, 0.42, q.z) * (1 - wh) * (1 - w)
            q.y = spine + (q.y - spine) * (1 + (DEPTH - 1) * wd)
        if BACK_DEPTH != 1.0 and q.y > spine:
            # the upper back, from the waist (fading in over the belt line, so the seat and hips keep their shape) to
            # the neck, not the arms: a soldier's back and shoulder blades, where the pack sits
            wt = smoothstep(own["crotch_z"] + 0.10, own["crotch_z"] + 0.24, q.z) * (1 - wh) * (1 - w)
            q.y = spine + (q.y - spine) * (1 + (BACK_DEPTH - 1) * wt)
        worst = max(worst, (q - p).length)
        v.co = q
    me.update()
    log(f"register: largest vertex move {worst * 100:.1f} cm")
    V = [v.co.copy() for v in me.vertices]
    lo, hi = head_box(V, ref["neck_z"])
    log(f"register: head depth x{HEAD_DEPTH} (in the reference's head: {(lo[1] - ref_lo[1]) * 100:+.1f} cm at the face, "
        f"{(ref_hi[1] - hi[1]) * 100:+.1f} cm at the back); depth x{DEPTH}, back depth x{BACK_DEPTH}")
    return s_head


def load_rig(path):
    """The reference rig's skeleton (bones, rest pose, sockets) without its clips, and its LOD0 body."""
    with bpy.data.libraries.load(str(path)) as (src, dst):
        dst.armatures = list(src.armatures)
        dst.objects = [n for n in src.objects if n.endswith("_body")]
    data = dst.armatures[0]
    data.name = f"{NAME}_skeleton"
    obj = bpy.data.objects.new(NAME, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()  # a new armature object has no pose until the depsgraph evaluates it
    return obj, data, dst.objects[0]


if SKELETON:
    REF_RIG_JSON = json.loads((SKELETON.parent.parent / f"{SKELETON.stem}_rig.json").read_text())
    REF_MARKS = REF_RIG_JSON["landmarks_blender_zup"]
    arm, arm_data, ref_body = load_rig(SKELETON)
    own_marks = marks_of(measure())
    log("own landmarks", json.dumps(own_marks))
    fit_scale = register(SKELETON.parent / f"{SKELETON.stem}_tripo_raw.glb", REF_RIG_JSON["height_m"], arm, ref_body)
    bpy.data.objects.remove(ref_body, do_unlink=True)
L = measure()
if SKELETON:  # the rig's joints; this body's own girth (hip_half, chest_half, back_y, tip_z)
    for k in ("neck_z", "crotch_z", "armpit_z", "spine_y", "face_y"):
        L[k] = REF_MARKS[k]
    for k in ("shoulder", "elbow", "wrist", "hand_end", "ankle", "ball"):
        L[k] = Vector(REF_MARKS[f"{k}_L"])
    L["hip_j"], L["knee"], L["toe_tip"] = (Vector(REF_MARKS[k]) for k in ("hip_L", "knee_L", "toe_L"))
(neck_z, crotch_z, hip_half, chest_half, armpit_z, spine_y, back_y, tip_z, shoulder, elbow, wrist, hand_end,
 hip_j, knee, ankle, ball, toe_tip, top_z, face_z, face_y, head_y, jet_back, jet_mid_z, jet_far) = (L[k] for k in (
    "neck_z", "crotch_z", "hip_half", "chest_half", "armpit_z", "spine_y", "back_y", "tip_z", "shoulder", "elbow",
    "wrist", "hand_end", "hip_j", "knee", "ankle", "ball", "toe_tip", "top_z", "face_z", "face_y", "head_y",
    "jet_back", "jet_mid_z", "jet_far"))
marks = marks_of(L)
log("landmarks", json.dumps(marks))


def mirror(v):
    return Vector((-v.x, v.y, v.z))


def build_skeleton():
    """The shared skeleton (docs/04 §4.1) on the landmarks, with its sockets."""
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
    # 0.07 m ahead of the grip: chibi arms reach ~0.10 m past it at most (docs/04 §9.4)
    off = grip_R + Vector((0, -0.07, 0.02))
    bone("socket_offhand_IK", off, off + Vector((0, -0.05, 0)), "socket_weapon_R", deform=False)
    bone("socket_jetpack", P(0, jet_back, jet_mid_z), P(0, jet_back, jet_mid_z + 0.08), "spine2", deform=False)
    bone("socket_back", P(0, jet_far, spine_top), P(0, jet_far, spine_top + 0.08), "spine2", deform=False)
    # Slung and holstered weapons (the owner, 18 Oct: the unused gun hangs on the soldier). A weapon mounts here
    # with an identity transform, grip on the socket, like socket_weapon_R: bone +Y is the muzzle, +Z the gun's top.
    # sling_back: diagonally across the back just behind the jetpack (its back face is jet_far), in front of the
    # slung riot shield (render3d's socket_shield_back), lying on its side: the muzzle up over the left shoulder, the
    # gun's right side against the back, its top towards the right shoulder. holster_thigh: on the outer right
    # thigh, the muzzle down, the slide forward, the right side out.
    sling = P(0, jet_far + 0.021, spine_top - 0.06)
    bone("sling_back", sling, sling + Vector((0.57, 0, 0.82)) * 0.08, "spine2", deform=False, roll_ref=Vector((-0.82, 0, 0.57)))
    holster = mirror(hip_j) + Vector((-0.166, 0.0, -0.04))
    bone("holster_thigh", holster, holster + Vector((0, 0, -0.08)), "thigh_R", deform=False)
    bone("socket_hat", P(0, head_y, top_z - 0.08), P(0, head_y, top_z), "head", deform=False)
    bone("socket_nameplate", P(0, 0, H + 0.25), P(0, 0, H + 0.33), "root", deform=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm, arm_data


if not SKELETON:
    arm, arm_data = build_skeleton()
arm["skeleton"] = "shared-v1"  # docs/04 §4.1 + §9.3

# ------------------------------------------------------------------ 3. split the default parts + LODs

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
hi.name = f"{NAME}_body_highres"
# The DIFFUSE/COLOR bake returns base colour × (1 - metallic): zero the generator's metalness
# (e.g. Tripo's glossy goggle lenses) so metal parts keep their albedo.
for m in hi.data.materials:
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            for ln in list(n.inputs["Metallic"].links):
                m.node_tree.links.remove(ln)
            n.inputs["Metallic"].default_value = 0.0


def shells(obj):
    """Connected shells of a mesh as lists of BMVerts (generated meshes are a soup of them)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    seen, out = set(), []
    for v in bm.verts:
        if v.index in seen:
            continue
        comp, stack = [], [v]
        seen.add(v.index)
        while stack:
            a = stack.pop()
            comp.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen:
                    seen.add(b.index)
                    stack.append(b)
        out.append(comp)
    return bm, out


def shell_colour(bm, comp, img_px):
    """Median albedo of a shell as HSV (hue in degrees), sampled at its face corners' UVs."""
    uvl = bm.loops.layers.uv.active
    h, w = img_px.shape[:2]
    faces = {f for a in comp for f in a.link_faces}
    cols = [img_px[min(h - 1, int(lp[uvl].uv[1] * h)), min(w - 1, int(lp[uvl].uv[0] * w)), :3] for f in faces for lp in f.loops]
    hh, ss, vv = colorsys.rgb_to_hsv(*np.median(np.array(cols), axis=0))
    return hh * 360, ss, vv


def separate(obj, tag, name):
    """Split the faces whose `part` attribute is `tag` into a new object. The tag (not face
    indices) survives earlier splits, which renumber the faces."""
    me = obj.data
    attr = me.attributes["part"].data
    faces = {i for i in range(len(me.polygons)) if attr[i].value == tag}
    verts = {vi for poly in me.polygons if poly.index in faces for vi in poly.vertices}
    for o in scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.object.mode_set(mode="OBJECT")
    me.polygons.foreach_set("select", [p.index in faces for p in me.polygons])
    me.edges.foreach_set("select", [e.vertices[0] in verts and e.vertices[1] in verts for e in me.edges])
    me.vertices.foreach_set("select", [v.index in verts for v in me.vertices])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    part = next(o for o in bpy.context.selected_objects if o != obj)
    part.name = name
    log(f"split {len(faces)} faces into {name}")
    return part


src_img = next(n.image for m in hi.data.materials for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image
               and any(lk.to_socket.name == "Base Color" for lk in n.outputs["Color"].links))
src_px = np.array(src_img.pixels[:], dtype=np.float32).reshape(src_img.size[1], src_img.size[0], 4)


BOOT_CUFF = 0.17  # × height: the trouser cuff (z ≈ 0.255 m); boot leather below it belongs to the boots


def classify_parts(obj):
    """Shell → default part: jetpack (≥ 80% behind the back, below the neck), headgear (helmet,
    brim, band, goggles: above the face line, or sand-coloured above the neck, or wider than the
    head) and boots (shells below the trouser cuffs). Everything else stays on the body."""
    bm, comps = shells(obj)
    out = {"jetpack": set(), "headgear": set(), "boots": set()}
    plane = back_y - 0.02
    for comp in comps:
        zs = [a.co.z for a in comp]
        faces = {f.index for a in comp for f in a.link_faces}
        if sum(1 for a in comp if a.co.y > plane) / len(comp) >= 0.8 and max(zs) < neck_z + 0.03 and min(zs) > crotch_z - 0.1:
            out["jetpack"] |= faces
        elif max(zs) < 0.15 * H:
            out["boots"] |= faces
        elif max(zs) > neck_z + 0.04:
            hue, _, val = shell_colour(bm, comp, src_px)
            wide = max(abs(a.co.x) for a in comp) > 0.30 or min(a.co.y for a in comp) < -0.30
            low = min(zs)
            if low >= neck_z + 0.14 or (low >= neck_z + 0.04 and (wide or (hue >= 32 and val >= 0.4))):
                out["headgear"] |= faces
    # The boot tops are fused into the trouser-leg shells: faces below the cuff that are boot
    # leather (dark brown) go to the boots too. Left on the body they poked through every other
    # pair of boots (round-2 review).
    uvl = bm.loops.layers.uv.active
    h, w = src_px.shape[:2]
    taken = out["jetpack"] | out["headgear"] | out["boots"]
    bm.faces.ensure_lookup_table()
    moved = 0
    for f in bm.faces:
        if f.index in taken or f.calc_center_median().z >= BOOT_CUFF * H:
            continue
        col = np.median([src_px[min(h - 1, int(lp[uvl].uv[1] * h)), min(w - 1, int(lp[uvl].uv[0] * w)), :3] for lp in f.loops], axis=0)
        hue, sat, val = colorsys.rgb_to_hsv(*col)
        if val < 0.40 and sat > 0.25 and 10 <= hue * 360 <= 40:
            out["boots"].add(f.index)
            moved += 1
    log(f"boot tops: {moved} dark-brown faces below the cuff moved from the trouser shells to the boots")
    bm.free()
    return out


split = {k: v for k, v in classify_parts(hi).items() if k in PART_IDS}  # a part it doesn't wear stays body
TAGS = {"jetpack": 1, "headgear": 2, "boots": 3}
tag_attr = hi.data.attributes.new("part", "INT", "FACE")
for part, faces in split.items():
    for f in faces:
        tag_attr.data[f].value = TAGS[part]
part_hi = {"body": hi}
for part in split:
    part_hi[part] = separate(hi, TAGS[part], f"{NAME}_{part}_highres")
for o in part_hi.values():
    o.data.attributes.remove(o.data.attributes["part"])


def hair_cap(head_c):
    """Short-hair cap where the helmet was: the generator never modelled the skull under it.
    Any headgear covers its top; it is part of the body (docs/04 §3 hair slot later)."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=1, location=head_c)
    cap = bpy.context.active_object
    cap.scale = (0.245, 0.26, 0.25)
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(cap.data)
    kill = [f for f in bm.faces if f.calc_center_median().z < neck_z + 0.04
            or (f.calc_center_median().y < head_c.y - 0.13 and f.calc_center_median().z < neck_z + 0.28)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(cap.data)
    bm.free()
    mat = bpy.data.materials.new("hair")
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.06, 0.03, 0.015, 1)
    cap.data.materials.append(mat)
    return cap


if "headgear" in PART_IDS:  # bare-headed, the generator modelled the head and its hair
    cap = hair_cap(Vector((0, head_y + 0.03, neck_z + 0.21)))
    for o in scene.objects:
        o.select_set(o in (hi, cap))
    bpy.context.view_layer.objects.active = hi
    bpy.ops.object.join()


def weld(obj):
    """glTF import splits vertices along every UV seam: weld them back (UVs live on the loops,
    so nothing is lost) and drop loose verts. Without this, collapse decimation stalls on the
    thousands of open patches, and cracks between them show through outlines."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    log(f"{obj.name}: welded {n0} -> {len(bm.verts)} verts")
    bm.to_mesh(obj.data)
    bm.free()


for o in part_hi.values():
    weld(o)

# docs/04 §1.2: no cosmetic sticks out past the body, default parts included; the hair-capped
# body is the reference. The jetpack scales about its backplate (smaller, still on the back);
# the helmet's brim and crown and the boots' soles are squeezed in, the rest keeps its shape.
ENV = envelope.of_body([part_hi["body"]])
for _part, _obj in part_hi.items():
    if _part == "body":
        continue
    _before = envelope.describe(_obj, ENV)
    if _part == "jetpack":
        _lo, _hi = envelope.bbox(_obj)
        envelope.shrink_into(_obj, ENV, ((_lo[0] + _hi[0]) / 2, _lo[1], (_lo[2] + _hi[2]) / 2))
    else:
        envelope.squeeze(_obj, ENV)
    log(f"{_part} vs the body envelope: {_before} -> {envelope.describe(_obj, ENV)}")


def make_lod(src, part, tris, tex, suffix):
    lo = src.copy()
    lo.data = src.data.copy()
    lo.name = f"{NAME}_{part}{suffix}"
    scene.collection.objects.link(lo)
    lo.modifiers.clear()
    # The LOD gets fresh UVs and a re-bake anyway: drop the generator's UVs and custom normals
    # first, or collapse decimation won't cross their seams and stalls on small parts.
    while lo.data.uv_layers:
        lo.data.uv_layers.remove(lo.data.uv_layers[0])
    for o in scene.objects:
        o.select_set(o == lo)
    bpy.context.view_layer.objects.active = lo
    if lo.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    t0, t1 = decimate(lo, tris)
    lo.data.uv_layers.new(name="UVMap")
    for o in scene.objects:
        o.select_set(o == lo)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()

    img = bpy.data.images.new(f"{NAME}_{part}{suffix}_albedo", tex, tex, alpha=False)
    mat = bpy.data.materials.new(f"{NAME}_{part}{suffix}_mat")
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

    src.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=0.02, max_ray_distance=0.06, margin=8)
    img.pack()
    log(f"{lo.name}: {t0} -> {t1} tris, baked {tex}² albedo")
    if part == "body" and suffix == "":
        hero = bpy.data.images.new(f"{NAME}_{part}_hero_albedo", HERO_TEX, HERO_TEX, alpha=False)
        tn.image = hero
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                            cage_extrusion=0.02, max_ray_distance=0.06, margin=16)
        tn.image = img
        hero.use_fake_user = True  # unused until its masks are made (6): the orphan purge would take it
        HERO[(part, suffix)] = hero
        log(f"{lo.name}: baked the {HERO_TEX}² hero albedo")
    return lo, t1, img


raw_tris = sum(tri_count(o.data) for o in part_hi.values())
parts = {}  # (part, suffix) -> (object, tris, albedo image)
for suffix, budget in LODS.items():
    for part, src in part_hi.items():
        parts[(part, suffix)] = make_lod(src, part, *budget[part], suffix)
for o in part_hi.values():
    bpy.data.objects.remove(o, do_unlink=True)
bpy.data.orphans_purge(do_recursive=True)
# the check measures against the LOD0 body: clamp the few mm decimation can drift
ENV0 = envelope.of_body([parts[("body", "")][0]])
for (_part, _suffix), (_obj, _, _) in parts.items():
    if _part != "body":
        envelope.clamp(_obj, ENV0)

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


def skin_rigid(obj, bone):
    """Rigid part (headgear, eyewear, jetpack): every vertex 100% on one bone, so it can still
    be merged into the character's single SkinnedMesh (docs/04 §5.3)."""
    for b in arm_data.bones:
        if b.use_deform:
            obj.vertex_groups.new(name=b.name)
    obj.vertex_groups[bone].add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm
    log("skinned", obj.name, "rigidly to", bone)


for (part, suffix), (obj, _, _) in parts.items():
    if part in ("body", "boots"):
        skin(obj)  # the boot zone is rigid per foot; shafts follow the calves
    else:
        skin_rigid(obj, PART_SLOTS[part][1])

# ------------------------------------------------------------------ 5. clips

bpy.context.scene.render.fps = clips.FPS
clip_names = clips.build_all(arm)
log("clips", len(clip_names), clip_names)


def assert_offhand_reach():
    """docs/04 §4.2/§9.4: W1 IKs the left hand to socket_offhand_IK, or to a two-handed weapon's
    `offhand` node, on top of the rifle aim poses. Every target must be inside the left arm's reach
    (shoulder -> wrist <= upperarm + forearm) in every rifle pose, or the hand floats off the gun."""
    weapons_json = Path(__file__).resolve().parents[1] / "weapons" / "weapons.json"
    nodes = {}
    if weapons_json.exists():
        for wid, w in json.loads(weapons_json.read_text()).items():
            if w.get("hands") == 2 and "offhand" in w.get("nodes", {}):
                nodes[wid] = Vector(w["nodes"]["offhand"])  # the weapon frame = socket_weapon_R's frame
    solver = clips.UpperBodySolver(arm)
    reach = solver.len["upperarm_L"] + solver.len["forearm_L"]
    saved = arm.animation_data.action if arm.animation_data else None
    arm.animation_data_create()
    worst = {}
    for name in clip_names:
        if not name.startswith("aim_rifle_"):
            continue
        act = bpy.data.actions[name]
        arm.animation_data.action = act
        bpy.context.scene.frame_set(int(act.frame_range[0]))
        bpy.context.view_layer.update()
        pb = arm.pose.bones
        shoulder = pb["upperarm_L"].head
        sock = pb["socket_weapon_R"].matrix
        d, u = sock.col[1].xyz.normalized(), sock.col[2].xyz.normalized()
        targets = {"socket_offhand_IK": pb["socket_offhand_IK"].matrix.translation}
        targets.update({wid: sock @ n for wid, n in nodes.items()})
        for tid, t in targets.items():
            wrist = solver._hand("L", t, d, u).translation
            margin = reach - (wrist - shoulder).length
            worst[tid] = min(worst.get(tid, 9.0), margin)
            if margin < 0.005:
                raise RuntimeError(f"{name}: the left hand can't reach {tid} ({margin * 100:.1f} cm short of the 0.5 cm margin)")
    arm.animation_data.action = saved
    bpy.context.scene.frame_set(0)
    log("off-hand reach margins (cm, worst over the rifle aim poses):",
        {k: round(v * 100, 1) for k, v in worst.items()})


assert_offhand_reach()

# ------------------------------------------------------------------ 6. dye masks + extras

TEXDIR = OUT / "textures"
TEXDIR.mkdir(parents=True, exist_ok=True)
RULES = {"body": dye.rookie_body_rules(marks), "headgear": dye.helmet_rules, "boots": dye.no_rules,
         "jetpack": dye.jetpack_rules}
SKIN = {"body": dye.rookie_body_skin(marks)}  # parts whose dye albedo carries a skin weight in alpha


def envelope_ok(obj, part):
    """docs/04 §1.2, measured: inside the body's envelope (the body itself trivially is)."""
    return envelope.inside(obj, ENV0)



dyes, NOZZLES = {}, {}
for (part, suffix), (obj, tris, img) in parts.items():
    slot, rules = part, RULES[part]
    tex_name = f"{FILE_IDS[part]}{suffix}"
    img.filepath_raw = str(TEXDIR / f"{tex_name}_albedo.png")
    img.file_format = "PNG"
    img.save()
    defaults, cover = dye.make_masks(obj, img, TEXDIR, tex_name, rules, skin_rule=SKIN.get(part))
    dyes[(part, suffix)] = (defaults, cover)
    obj["slot"] = slot
    obj["bodyTypes"] = ["standard" if BODY == "male" else BODY]
    if part != "body":  # the same part schema as build_cosmetics (round-2 review)
        obj["cosmeticId"] = PART_IDS[part]
        obj["hidesHair"] = part == "headgear"
    if part == "jetpack":
        NOZZLES.setdefault(part, nozzles.find(obj, 2))  # the twin tank; LOD0 positions for the manifest
        obj["nozzles"] = nozzles.find(obj, 2)
    obj["envelopeOk"] = envelope_ok(obj, part)
    obj["dyeDefaults"] = defaults
    obj["dyeMask"] = f"{tex_name}_dye_mask.png"
    obj["dyeAlbedo"] = f"{tex_name}_dye_albedo"  # .png in art/, .webp in the web build
    if part in SKIN:  # skin weight in the dye albedo's alpha, neutralised against skin_04
        obj["dyeSkin"] = "alpha"
        obj["skinNeutral"] = dye.SKIN_NEUTRAL
        obj["skinHeadroom"] = dye.SKIN_HEADROOM
    socket, bone = PART_SLOTS.get(part, (None, None))
    if socket:
        obj["socket"] = socket
    if bone:
        obj["attachBone"] = bone
    log(f"{tex_name}: dye defaults {defaults}, coverage {cover}")
    if (part, suffix) in HERO:  # the close-ups: the same rules on the 1024² bake; the manifest keeps LOD0's defaults
        hero = HERO[(part, suffix)]
        hero.filepath_raw = str(TEXDIR / f"{tex_name}_hero_albedo.png")
        hero.file_format = "PNG"
        hero.save()
        _, hero_cover = dye.make_masks(obj, hero, TEXDIR, f"{tex_name}_hero", rules, skin_rule=SKIN.get(part))
        hero.use_fake_user = False  # not kept in the .blend
        log(f"{tex_name}_hero: coverage {hero_cover}")
        if part == "body":  # the painted eyes for the texture blink: shapes as painted, the lid as the shader samples
            # (both from the saved 8-bit files, so a measure of the committed textures gives the same numbers)
            EYES.update(eyes.measure(obj, arm, bpy.data.images.load(str(TEXDIR / f"{tex_name}_hero_albedo.png")),
                                     bpy.data.images.load(str(TEXDIR / f"{tex_name}_hero_dye_albedo.png")))[0])
            log("eyes:", EYES)

# ------------------------------------------------------------------ 6b. body regions
# Parts that replace a stretch of the body (a top, trousers, a hairstyle) name it in their manifest
# (`hidesBody`), and the assembler drops the body triangles whose three vertices all carry its code: the
# glTF attribute _REGION (0 = always drawn). Skin always stays (a top's open neck, rolled sleeves); hair is
# the dark head texels above the brows or behind the ears, so brows and eyes stay; the rest goes by the bone
# a vertex mostly follows.
REGIONS = {"hair": 1, "top": 2, "legs": 3}
REGION_BONES = {
    "top": {"spine1", "spine2", "neck"} | {f"{p}_{s}" for p in ("clavicle", "upperarm", "forearm") for s in "LR"},
    "legs": {"pelvis"} | {f"{p}_{s}" for p in ("thigh", "calf") for s in "LR"},
}
HEAD = {"head", "jaw", "eye_L", "eye_R"}
CLOTHED = {"spine1", "spine2", "pelvis"} | {f"{p}_{s}" for p in ("clavicle", "thigh", "calf") for s in "LR"}


def fill_regions(me, codes, dom):
    """Make the top and legs regions whole. A garment replaces its region and hems the region's border, so a hole in
    it (cloth whose texels read as skin: the sand uniform is close to the skin) became a hem ring across the shirt,
    with the body showing in it. Fill every small patch (up to 40 vertices, no hand or head in it: a bare forearm
    and its hand are bounded by the sleeve alone) that the top and legs surround, with the code round it (the larger,
    where both meet), and drop region specks (under 12 vertices) inside skin. Hair is left as it is: its holes are
    ears."""
    nbr = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nbr[a].append(b)
        nbr[b].append(a)

    def patches(pred):
        seen, out = set(), []
        for i in range(len(codes)):
            if i in seen or not pred(i):
                continue
            comp, stack = [], [i]
            seen.add(i)
            while stack:
                j = stack.pop()
                comp.append(j)
                for k in nbr[j]:
                    if k not in seen and pred(k):
                        seen.add(k)
                        stack.append(k)
            out.append(comp)
        return out

    cloth = (REGIONS["top"], REGIONS["legs"])
    filled = specks = 0
    for comp in patches(lambda i: codes[i] == 0):
        inside = set(comp)
        ring = [codes[k] for j in comp for k in nbr[j] if k not in inside]
        if len(comp) <= 40 and ring and all(c in cloth for c in ring) and \
                not any(dom[j].startswith("hand_") or dom[j] in HEAD for j in comp):
            codes[comp] = max(cloth, key=ring.count)
            filled += len(comp)
    for code in cloth:
        for comp in patches(lambda i: codes[i] == code):
            inside = set(comp)
            ring = [codes[k] for j in comp for k in nbr[j] if k not in inside]
            if len(comp) < 12 and ring and all(c == 0 for c in ring):
                codes[comp] = 0
                specks += len(comp)
    log(f"regions: {filled} vertices of holes filled, {specks} of specks dropped")


def tag_regions(obj, stem):
    """Write _REGION on the body's vertices from its skin weights, its skin texels and its albedo."""
    def load(name):
        img = bpy.data.images.load(str(TEXDIR / name))
        px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
        bpy.data.images.remove(img)
        return px

    albedo, skin_px = load(f"{stem}_albedo.png"), load(f"{stem}_dye_albedo.png")
    h, w = albedo.shape[:2]
    me = obj.data
    uv = me.uv_layers.active.data
    skin = np.zeros(len(me.vertices))
    dark = np.ones(len(me.vertices))
    for lp in me.loops:
        x, y = uv[lp.index].uv
        px, py = min(w - 1, int(x * w)), min(h - 1, int(y * h))
        skin[lp.vertex_index] = max(skin[lp.vertex_index], skin_px[py, px, 3] if "body" in SKIN else 0.0)
        dark[lp.vertex_index] = min(dark[lp.vertex_index], float(albedo[py, px, :3].max()))
    names = {g.index: g.name for g in obj.vertex_groups}
    eye_z = arm_data.bones["eye_L"].head_local.z
    head_y = arm_data.bones["head"].head_local.y
    codes = np.zeros(len(me.vertices), dtype=np.float32)
    doms = []
    for v in me.vertices:
        dom = names[max(v.groups, key=lambda g: g.weight).group] if v.groups else "root"
        doms.append(dom)
        # the torso and legs are always clothed on these soldiers (the bare skin is forearms, hands, neck and face),
        # and their sand cloth reads as skin to the texel test: trust it only where skin can be
        if skin[v.index] > 0.4 and dom not in CLOTHED:
            continue
        if dom in HEAD:
            if dark[v.index] < 0.3 and (v.co.z > eye_z + 0.07 or v.co.y > head_y):
                codes[v.index] = REGIONS["hair"]
            continue
        for region, bones in REGION_BONES.items():
            if dom in bones:
                codes[v.index] = REGIONS[region]
    fill_regions(me, codes, doms)
    attr = me.attributes.new("_REGION", "FLOAT", "POINT")
    attr.data.foreach_set("value", codes)
    me.calc_loop_triangles()
    tris = {name: sum(1 for t in me.loop_triangles if all(codes[i] == code for i in t.vertices)) for name, code in REGIONS.items()}
    log(f"{stem}: region triangles {tris}")
    return tris


REGION_TRIS = {suffix or "_lod0": tag_regions(parts[("body", suffix)][0], f"{FILE_IDS['body']}{suffix}") for suffix in LODS}

# ------------------------------------------------------------------ 7. export


def sign_continuous_rotations(path):
    """Negate every rotation key whose quaternion has a negative dot with the previous key's, so each
    track stays sign-continuous (the M4 review found flipped pairs in six clips). The exporter derives each bone's
    quaternion from a matrix per key, so its sign comes out arbitrary; an engine that blends or
    interpolates component-wise would turn those bones the long way round. Rewrites the GLB's binary
    chunk in place (same layout); the poses don't change, since q and -q are the same rotation."""
    b = bytearray(path.read_bytes())
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    base = 20 + jl + 8
    flipped = 0
    for an in g.get("animations", []):
        for ch in an["channels"]:
            if ch["target"]["path"] != "rotation":
                continue
            s = an["samplers"][ch["sampler"]]
            a = g["accessors"][s["output"]]
            bv = g["bufferViews"][a["bufferView"]]
            assert a["componentType"] == 5126 and a["type"] == "VEC4" and bv.get("byteStride", 16) == 16
            assert s.get("interpolation", "LINEAR") != "CUBICSPLINE" and "min" not in a
            off = base + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
            q = np.frombuffer(bytes(b[off:off + a["count"] * 16]), np.float32).reshape(-1, 4).copy()
            for k in range(1, len(q)):
                if float(q[k] @ q[k - 1]) < 0:
                    q[k] = -q[k]
                    flipped += 1
            b[off:off + q.nbytes] = q.tobytes()
    path.write_bytes(bytes(b))
    log(f"{path.name}: {flipped} rotation key(s) negated for sign continuity")


def export(path, objs, animations=False, runtime=False):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=False, export_extras=True,
        export_skins=True, export_def_bones=False, export_influence_nb=4,
        export_animations=animations, export_animation_mode="ACTIONS",
        # unsampled: each clip keeps only the bones it keys, so upper-body clips layer cleanly
        export_force_sampling=False, export_optimize_animation_size=False,
        export_reset_pose_bones=True, export_anim_slide_to_zero=True,
        export_image_format="WEBP" if runtime else "JPEG", export_image_quality=90, export_jpeg_quality=90,
        # the clips stay uncompressed: meshopt made them larger (218 vs 179 KB), and the sign pass
        # below rewrites their keys in place
        export_meshopt_compression_enable=runtime and not animations,
        export_materials="EXPORT", export_normals=True, export_texcoords=True,
        export_tangents=False, export_morph=False, export_cameras=False, export_lights=False,
        export_attributes=True,  # the body's _REGION (6b)
    )
    if animations:
        sign_continuous_rotations(path)
    log("wrote", path, f"{path.stat().st_size / 1024:.0f} KB")


SLOT_PARTS = [p for p in PART_IDS if p != "body"]
# --skeleton: the rig's own clip file, when this body's clips come out byte-identical to it (same skeleton)
REF_ANIMS = SKELETON.parent.parent / f"{SKELETON.stem}_anims.glb" if SKELETON else None
shared_anims = False


def write_set(char_dir, part_dir, runtime):
    """char_dir gets the body LODs + anims; part_dir(slot) the default parts."""
    for suffix in LODS:
        export(char_dir / f"{NAME}_body{suffix}.glb", [arm, parts[("body", suffix)][0]], runtime=runtime)
        for part in SLOT_PARTS:
            export(part_dir(part) / f"{FILE_IDS[part]}{suffix}.glb", [arm, parts[(part, suffix)][0]], runtime=runtime)
    if not shared_anims:
        export(char_dir / f"{NAME}_anims.glb", [arm], animations=True, runtime=runtime)


def runtime_textures(src_names, dest, alpha=False):
    """Dye masks stay lossless PNG (they are data); dye albedos go to WebP for download size, with
    their alpha when it holds a skin weight (the body)."""
    dest.mkdir(parents=True, exist_ok=True)
    for stem in src_names:
        shutil.copy(TEXDIR / f"{stem}_dye_mask.png", dest / f"{stem}_dye_mask.png")
        img = bpy.data.images.load(str(TEXDIR / f"{stem}_dye_albedo.png"))
        scene = bpy.context.scene
        # save_render applies the scene's view transform: AgX would tone-map the albedo
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
        settings = scene.render.image_settings
        settings.file_format = "WEBP"
        settings.color_mode = "RGBA" if alpha else "RGB"
        settings.quality = 90
        img.save_render(str(dest / f"{stem}_dye_albedo.webp"), scene=scene)
        bpy.data.images.remove(img)


def clip_data(path):
    """A clip GLB's bones (rest TRS) and keys (sampler bytes per animation, node and path), ignoring the
    armature's own node name, which is the body's."""
    b = path.read_bytes()
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    data = b[20 + jl + 8:]

    def raw(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        return data[off:off + bv["byteLength"] - a.get("byteOffset", 0)]

    top = set(g["scenes"][g.get("scene", 0)]["nodes"])  # the armature object itself
    bones = {n["name"]: (n.get("translation"), n.get("rotation"), n.get("scale")) for i, n in enumerate(g["nodes"]) if i not in top}
    keys = {(an["name"], g["nodes"][ch["target"]["node"]]["name"], ch["target"]["path"]):
            (raw(an["samplers"][ch["sampler"]]["input"]), raw(an["samplers"][ch["sampler"]]["output"]),
             an["samplers"][ch["sampler"]].get("interpolation", "LINEAR"))
            for an in g.get("animations", []) for ch in an["channels"]}
    return bones, keys


write_set(OUT, lambda part: OUT / "parts", runtime=False)
if REF_ANIMS:
    # Same skeleton, same clips.build_all: every bone's rest pose and every key must come out identical to the
    # rig's. Then this body ships no clip file of its own and its manifest points at the rig's (one download).
    if clip_data(OUT / f"{NAME}_anims.glb") != clip_data(REF_ANIMS):
        raise RuntimeError(f"{NAME}_anims.glb differs from {REF_ANIMS.name}: the skeletons don't match")
    (OUT / f"{NAME}_anims.glb").unlink()
    shared_anims = True
    log(f"clips: identical to {REF_ANIMS.name}; {NAME} shares them")
# One-file preview of the default outfit with every clip (render_views, quick looks; not shipped).
export(OUT / f"{NAME}_preview.glb", [arm] + [parts[(p, "")][0] for p in PART_IDS], animations=True)

summary = {
    "name": NAME, "body": BODY, "height_m": HEIGHT, "source": RAW.name, "skeleton": "shared-v1",
    "parts": PART_IDS,
    "tris": {"raw": raw_tris, **{f"{p}{s or '_lod0'}": t for (p, s), (_, t, _) in parts.items()}},
    "textures": {f"{p}{s or '_lod0'}": img.size[0] for (p, s), (_, _, img) in parts.items()},
    "dyeDefaults": {f"{p}{s or '_lod0'}": d for (p, s), (d, _) in dyes.items()},
    "dyeCoverage": {f"{p}{s or '_lod0'}": c for (p, s), (_, c) in dyes.items()},
    "clips": clip_names,
    "upperBodyBones": clips.UPPER_BODY,
    "aimAngles": clips.AIM_ANGLES,
    "landmarks_blender_zup": marks,
    "regions": REGIONS, "regionTris": REGION_TRIS,
    **({"fittedTo": SKELETON.stem, "headScale": round(fit_scale, 4), "sharedAnims": f"{SKELETON.stem}_anims.glb",
        "ownLandmarks_blender_zup": own_marks} if SKELETON else {}),
}
(OUT / f"{NAME}_rig.json").write_text(json.dumps(summary, indent=2))

if RUNTIME:
    # --runtime is the web assets root: characters/<name>/ and cosmetics/<slot>/ (docs/04 §9).
    char_dir = RUNTIME / "characters" / NAME
    slot_dir = lambda part: RUNTIME / "cosmetics" / part  # noqa: E731
    write_set(char_dir, slot_dir, runtime=True)
    runtime_textures([f"{NAME}_body{s}" for s in LODS] + [f"{FILE_IDS[p]}{s}_hero" for p, s in HERO],
                     char_dir / "textures", alpha="body" in SKIN)
    for part in SLOT_PARTS:
        runtime_textures([f"{FILE_IDS[part]}{s}" for s in LODS], slot_dir(part) / "textures")

    def dye_entry(part, suffix):
        stem = f"{FILE_IDS[part]}{suffix}"
        return {"mask": f"textures/{stem}_dye_mask.png", "albedo": f"textures/{stem}_dye_albedo.webp",
                "defaults": dyes[(part, suffix)][0],
                **({"skin": "alpha", "skinNeutral": dye.SKIN_NEUTRAL, "skinHeadroom": dye.SKIN_HEADROOM} if part in SKIN else {}),
                **({"heroAlbedo": f"textures/{stem}_hero_dye_albedo.webp", "heroMask": f"textures/{stem}_hero_dye_mask.png"}
                   if (part, suffix) in HERO else {})}

    (char_dir / f"{NAME}.json").write_text(json.dumps({
        "id": NAME, "body": BODY, "skeleton": "shared-v1", "heightM": HEIGHT if not SKELETON else 1.5,
        "lods": {"lod0": f"{NAME}_body.glb", "lod1": f"{NAME}_body_lod1.glb"},
        # no `anims`: the body shares the reference's clip library (apps/web character/assembler.ts loadBase)
        **({} if shared_anims else {"anims": f"{NAME}_anims.glb"}),
        "dye": {"lod0": dye_entry("body", ""), "lod1": dye_entry("body", "_lod1")},
        # the body's _REGION codes: a part's `hidesBody` names the regions it replaces (6b)
        "regions": REGIONS,
        # the painted eyes, for a texture blink and eye looks (eyes.py; README)
        **({"eyes": eyes.manifest(EYES)} if EYES else {}),
        # every slot's default: the shared items (this body's fits where it has its own), as the Rookie's
        "defaultParts": {"headgear": "headgear_brim_helmet", "boots": "boots_combat", "jetpack": "jetpack_twin_tank",
                         **{part: PART_IDS[part] for part in SLOT_PARTS}},
        "clips": clip_names, "upperBodyBones": clips.UPPER_BODY, "aimAngles": clips.AIM_ANGLES,
        # docs/04 §4.2 family -> the aim-pose set these clips provide (until each family has its own)
        "aimPoseFallback": clips.AIM_POSE_FALLBACK,
        "requires": ["EXT_meshopt_compression (GLTFLoader.setMeshoptDecoder)", "EXT_texture_webp"],
    }, indent=2))
    for part in SLOT_PARTS:
        socket, bone = PART_SLOTS[part]
        path = slot_dir(part) / f"{PART_IDS[part]}.json"
        old = json.loads(path.read_text()) if path.exists() else {}
        fit = {
            "lods": {"lod0": f"{FILE_IDS[part]}.glb", "lod1": f"{FILE_IDS[part]}_lod1.glb"},
            "dye": {"lod0": dye_entry(part, ""), "lod1": dye_entry(part, "_lod1")},
            "tris": {"lod0": parts[(part, "")][1], "lod1": parts[(part, "_lod1")][1]},
        }
        if BODY != "male":  # this body's fit of a shared item: the manifest's bodies.<body> (the male fit stays on top)
            path.write_text(json.dumps({**old, "bodies": {**old.get("bodies", {}), BODY: fit}}, indent=2))
            continue
        path.write_text(json.dumps({
            "id": PART_IDS[part], "slot": part, "name": PART_NAMES[part], "skeleton": "shared-v1", "default": True,
            **({"socket": socket} if socket else {}), **({"attachBone": bone} if bone else {}),
            **fit,
            **({"nozzles": NOZZLES[part]} if part in NOZZLES else {}),
            **({"bodies": old["bodies"]} if "bodies" in old else {}),  # other bodies' fits, from their own builds
        }, indent=2))
    log("runtime set in", RUNTIME)

(OUT / "source").mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "source" / f"{NAME}.blend"), compress=True)
log("done")
