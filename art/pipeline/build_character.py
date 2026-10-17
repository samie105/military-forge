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
"""
import colorsys
import json
import math
import shutil
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
import nozzles  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
RAW, OUT = Path(argv[0]), Path(argv[1])
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1, 2) if argv[i].startswith("--")}
NAME = opt.get("name", "rookie")
RUNTIME = Path(opt["runtime"]) if "runtime" in opt else None
FACING = opt.get("facing", "+x")
HEIGHT = float(opt.get("height", 1.5))
# (body, jetpack) budgets: LOD0 sums to 3,900 of 4,000 tris, LOD1 to 1,750 of 1,800 (docs/04 §5.6)
# Parts: the generated soldier is split into body + the default headgear, boots and jetpack, so
# each slot can be swapped for a cosmetic (docs/04 §3). With the cosmetic slot budgets in
# build_cosmetics.py (eyewear 150, gloves 150), a fully dressed character stays ≤ 3,950 / 1,720
# tris (docs/04 §5.6); textures (albedo + dye mask) fit 1.5 MB of GPU memory per character.
LODS = {
    "": {"body": (2350, 512), "headgear": (450, 256), "boots": (300, 256), "jetpack": (550, 256)},
    "_lod1": {"body": (1000, 256), "headgear": (200, 128), "boots": (130, 128), "jetpack": (250, 128)},
}
PART_IDS = {"body": f"{NAME}_body", "headgear": "headgear_brim_helmet", "boots": "boots_combat", "jetpack": "jetpack_twin_tank"}
PART_SLOTS = {"headgear": ("socket_hat", "head"), "boots": (None, None), "jetpack": ("socket_jetpack", "spine2")}
PART_NAMES = {"headgear": "Brim Helmet", "boots": "Combat Boots", "jetpack": "Twin Tank"}
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
# 0.07 m ahead of the grip: chibi arms reach ~0.10 m past it at most (docs/04 §9.4)
off = grip_R + Vector((0, -0.07, 0.02))
bone("socket_offhand_IK", off, off + Vector((0, -0.05, 0)), "socket_weapon_R", deform=False)
bone("socket_jetpack", P(0, jet_back, jet_mid_z), P(0, jet_back, jet_mid_z + 0.08), "spine2", deform=False)
bone("socket_back", P(0, jet_far, spine_top), P(0, jet_far, spine_top + 0.08), "spine2", deform=False)
bone("socket_hat", P(0, head_y, top_z - 0.08), P(0, head_y, top_z), "head", deform=False)
bone("socket_nameplate", P(0, 0, H + 0.25), P(0, 0, H + 0.33), "root", deform=False)
bpy.ops.object.mode_set(mode="OBJECT")
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


split = classify_parts(hi)
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


for suffix in LODS:
    skin(parts[("body", suffix)][0])
    skin(parts[("boots", suffix)][0])  # the boot zone is rigid per foot; shafts follow the calves
    skin_rigid(parts[("headgear", suffix)][0], "head")
    skin_rigid(parts[("jetpack", suffix)][0], "spine2")

# ------------------------------------------------------------------ 5. clips

bpy.context.scene.render.fps = clips.FPS
clip_names = clips.build_all(arm)
log("clips", len(clip_names), clip_names)


def assert_offhand_reach():
    """docs/04 §4.2/§9.4: W1 IKs the left hand to socket_offhand_IK, or to a two-handed weapon's
    `offhand` node, on top of the rifle aim poses. Every target must be inside the left arm's reach
    (shoulder -> wrist <= upperarm + forearm) in every rifle pose, or the hand floats off the gun."""
    weapons_json = OUT.parent / "weapons" / "weapons.json"
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


def envelope_ok(obj, part):
    """docs/04 §1.2, measured: inside the body's envelope (the body itself trivially is)."""
    return envelope.inside(obj, ENV0)



dyes, NOZZLES = {}, {}
for (part, suffix), (obj, tris, img) in parts.items():
    slot, rules = part, RULES[part]
    tex_name = f"{PART_IDS[part]}{suffix}"
    img.filepath_raw = str(TEXDIR / f"{tex_name}_albedo.png")
    img.file_format = "PNG"
    img.save()
    defaults, cover = dye.make_masks(obj, img, TEXDIR, tex_name, rules)
    dyes[(part, suffix)] = (defaults, cover)
    obj["slot"] = slot
    obj["bodyTypes"] = ["standard"]
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
    socket, bone = PART_SLOTS.get(part, (None, None))
    if socket:
        obj["socket"] = socket
    if bone:
        obj["attachBone"] = bone
    log(f"{tex_name}: dye defaults {defaults}, coverage {cover}")

# ------------------------------------------------------------------ 7. export


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
        export_meshopt_compression_enable=runtime,
        export_materials="EXPORT", export_normals=True, export_texcoords=True,
        export_tangents=False, export_morph=False, export_cameras=False, export_lights=False,
    )
    log("wrote", path, f"{path.stat().st_size / 1024:.0f} KB")


SLOT_PARTS = [p for p in PART_IDS if p != "body"]


def write_set(char_dir, part_dir, runtime):
    """char_dir gets the body LODs + anims; part_dir(slot) the default parts."""
    for suffix in LODS:
        export(char_dir / f"{NAME}_body{suffix}.glb", [arm, parts[("body", suffix)][0]], runtime=runtime)
        for part in SLOT_PARTS:
            export(part_dir(part) / f"{PART_IDS[part]}{suffix}.glb", [arm, parts[(part, suffix)][0]], runtime=runtime)
    export(char_dir / f"{NAME}_anims.glb", [arm], animations=True, runtime=runtime)


def runtime_textures(src_names, dest):
    """Dye masks stay lossless PNG (they are data); dye albedos go to WebP for download size."""
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
        settings.color_mode = "RGB"
        settings.quality = 90
        img.save_render(str(dest / f"{stem}_dye_albedo.webp"), scene=scene)
        bpy.data.images.remove(img)


write_set(OUT, lambda part: OUT / "parts", runtime=False)
# One-file preview of the default outfit with every clip (render_views, quick looks; not shipped).
export(OUT / f"{NAME}_preview.glb", [arm] + [parts[(p, "")][0] for p in PART_IDS], animations=True)

summary = {
    "name": NAME, "height_m": HEIGHT, "source": RAW.name, "skeleton": "shared-v1",
    "parts": PART_IDS,
    "tris": {"raw": raw_tris, **{f"{p}{s or '_lod0'}": t for (p, s), (_, t, _) in parts.items()}},
    "textures": {f"{p}{s or '_lod0'}": img.size[0] for (p, s), (_, _, img) in parts.items()},
    "dyeDefaults": {f"{p}{s or '_lod0'}": d for (p, s), (d, _) in dyes.items()},
    "dyeCoverage": {f"{p}{s or '_lod0'}": c for (p, s), (_, c) in dyes.items()},
    "clips": clip_names,
    "upperBodyBones": clips.UPPER_BODY,
    "aimAngles": clips.AIM_ANGLES,
    "landmarks_blender_zup": marks,
}
(OUT / f"{NAME}_rig.json").write_text(json.dumps(summary, indent=2))

if RUNTIME:
    # --runtime is the web assets root: characters/<name>/ and cosmetics/<slot>/ (docs/04 §9).
    char_dir = RUNTIME / "characters" / NAME
    slot_dir = lambda part: RUNTIME / "cosmetics" / part  # noqa: E731
    write_set(char_dir, slot_dir, runtime=True)
    runtime_textures([f"{NAME}_body{s}" for s in LODS], char_dir / "textures")
    for part in SLOT_PARTS:
        runtime_textures([f"{PART_IDS[part]}{s}" for s in LODS], slot_dir(part) / "textures")

    def dye_entry(part, suffix):
        stem = f"{PART_IDS[part]}{suffix}"
        return {"mask": f"textures/{stem}_dye_mask.png", "albedo": f"textures/{stem}_dye_albedo.webp",
                "defaults": dyes[(part, suffix)][0]}

    (char_dir / f"{NAME}.json").write_text(json.dumps({
        "id": NAME, "skeleton": "shared-v1", "heightM": HEIGHT,
        "lods": {"lod0": f"{NAME}_body.glb", "lod1": f"{NAME}_body_lod1.glb"},
        "anims": f"{NAME}_anims.glb",
        "dye": {"lod0": dye_entry("body", ""), "lod1": dye_entry("body", "_lod1")},
        "defaultParts": {part: PART_IDS[part] for part in SLOT_PARTS},
        "clips": clip_names, "upperBodyBones": clips.UPPER_BODY, "aimAngles": clips.AIM_ANGLES,
        # docs/04 §4.2 family -> the aim-pose set these clips provide (until each family has its own)
        "aimPoseFallback": clips.AIM_POSE_FALLBACK,
        "requires": ["EXT_meshopt_compression (GLTFLoader.setMeshoptDecoder)", "EXT_texture_webp"],
    }, indent=2))
    for part in SLOT_PARTS:
        socket, bone = PART_SLOTS[part]
        (slot_dir(part) / f"{PART_IDS[part]}.json").write_text(json.dumps({
            "id": PART_IDS[part], "slot": part, "name": PART_NAMES[part], "skeleton": "shared-v1", "default": True,
            **({"socket": socket} if socket else {}), **({"attachBone": bone} if bone else {}),
            "lods": {"lod0": f"{PART_IDS[part]}.glb", "lod1": f"{PART_IDS[part]}_lod1.glb"},
            "dye": {"lod0": dye_entry(part, ""), "lod1": dye_entry(part, "_lod1")},
            "tris": {"lod0": parts[(part, "")][1], "lod1": parts[(part, "_lod1")][1]},
            **({"nozzles": NOZZLES[part]} if part in NOZZLES else {}),
        }, indent=2))
    log("runtime set in", RUNTIME)

(OUT / "source").mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "source" / f"{NAME}.blend"), compress=True)
log("done")
