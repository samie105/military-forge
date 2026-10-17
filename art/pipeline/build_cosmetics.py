"""Starter cosmetics for the Locker (docs/04 §3), built procedurally on the Rookie's landmarks.

    blender -b --factory-startup --python art/pipeline/build_cosmetics.py -- \
        <rookie.blend> <art_out_dir> [--runtime <assets_dir>]

Reads the rigged Rookie (art/character/source/rookie.blend, written by build_character.py) for
the shared skeleton and its landmarks, then builds original toy-style items per slot:

  headgear  field cap, beret, bandana, combat helmet   (rigid to `head`)
  eyewear   aviators, gas mask                          (rigid to `head`)
  jetpack   rocket pack, drum pack                      (rigid to `spine2`)
  boots     sneakers, jungle boots                      (rigid per foot, shafts follow the calves)
  gloves    tactical gloves                             (rigid per hand)

Each item is authored with two vertex-colour layers, `Col` (albedo) and `Dye` (mask: R primary,
G secondary, B accent, A team glow). Both are baked to textures on fresh UVs so cosmetics use the
same albedo + dye-mask path as the body (docs/04 §5.4). LOD1 is a decimated copy re-baked from LOD0.
Slot triangle budgets (SLOT_TRIS) keep any full outfit ≤ 4,000 / 1,800 tris (docs/04 §5.6).

Hero items can instead come from a generated model, `art/cosmetics/source/<id>_tripo_raw.glb`
(concept sheet → Tripo multiview, see art/README.md). The procedural item is still built first and
its bounding box is where the generated model is fitted, so a generated source keeps a fit that
passes the cosmetic envelope. The generated texture is baked onto the decimated LODs like the
Rookie's body, and the dye mask comes from per-item colour rules (dye.make_masks).
`--procedural` ignores the generated sources.
"""
import json
import math
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dye  # noqa: E402
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
import envelope  # noqa: E402
import nozzles  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
BLEND, OUT = Path(argv[0]), Path(argv[1])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None
ONLY = set(argv[argv.index("--only") + 1].split(",")) if "--only" in argv else None  # rebuild just these ids

# LOD0 / LOD1 triangle budgets per slot. Body 2,350 + one item per slot ≤ 3,950 tris (LOD1 1,720).
SLOT_TRIS = {"headgear": (450, 200), "eyewear": (150, 70), "boots": (300, 130), "gloves": (150, 70), "jetpack": (550, 250)}
TEX = (256, 128)
P, S, A, G, N = (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1), (0, 0, 0, 0)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def log(*a):
    print("[build_cosmetics]", *a, flush=True)


# ------------------------------------------------------------------ the Rookie: skeleton + landmarks

bpy.ops.wm.open_mainfile(filepath=str(BLEND))
scene = bpy.context.scene
arm = bpy.data.objects["rookie"]
body = bpy.data.objects["rookie_body"]


# docs/04 §1.2 (strict): no cosmetic sticks out past the body. One envelope for every slot: the
# bare body (LOD0, hair cap, no parts) ×1.10 from the floor up; every LOD is measured against it.
ENV = envelope.of_body([body])
# default parts' boxes: where generated jetpacks are fitted before the envelope fit
DEFAULT_BOX = {_slot: envelope.bbox(bpy.data.objects[f"rookie_{_slot}"])
               for _slot in ("headgear", "boots", "jetpack") if bpy.data.objects.get(f"rookie_{_slot}")}


def envelope_ok(obj, slot):
    return envelope.inside(obj, ENV)


def fit_envelope(obj, slot):
    """Bring an item inside the envelope: jetpacks scale about their backplate (smaller, still on
    the back); everything else gets only its overhang squeezed in (a visor, a knot, a sole)."""
    before = envelope.describe(obj, ENV)
    if slot == "jetpack":
        lo, hi = envelope.bbox(obj)
        envelope.shrink_into(obj, ENV, ((lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2))
    else:
        envelope.squeeze(obj, ENV)
    if before != "inside":
        log(f"  {obj.name} vs the body envelope: {before} -> {envelope.describe(obj, ENV)}")


body_lod1 = bpy.data.objects.get("rookie_body_lod1")  # gloves are built against each body LOD
for o in list(scene.objects):
    if o not in (arm, body, body_lod1):
        bpy.data.objects.remove(o, do_unlink=True)
bones = arm.data.bones
rig = json.loads((BLEND.parent.parent / "rookie_rig.json").read_text())
marks = rig["landmarks_blender_zup"]
NECK_Z = marks["neck_z"]
HEAD_Y = bones["head"].head_local.y
CAP_C = Vector((0, HEAD_Y + 0.03, NECK_Z + 0.21))  # the hair cap build_character.py adds
CAP_R = Vector((0.245, 0.26, 0.25))
EYE_Z = bones["eye_L"].head_local.z
EYE_X = bones["eye_L"].head_local.x
FACE_Y = marks["face_y"]
JET = bones["socket_jetpack"].head_local
FOOT_X = bones["foot_L"].head_local.x


# ------------------------------------------------------------------ modelling helpers

class Item:
    def __init__(self, iid, slot, name):
        self.iid, self.slot, self.name = iid, slot, name
        self.parts = []  # (object, albedo sRGB, dye channel)
        self.extras = {}

    def _add(self, o, col, ch, bevel=0.0):
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel:
            m = o.modifiers.new("bevel", "BEVEL")
            m.width = bevel
            m.segments = 1
            m.limit_method = "ANGLE"
            bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
        self.parts.append((o, col, ch))
        return o

    def ellipsoid(self, c, r, col, ch, keep=None, segs=16, rings=10, rot=(0, 0, 0)):
        """Ellipsoid at c with radii r; keep(face_centre) -> bool trims it (e.g. a cap's crown)."""
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1, location=c,
                                             rotation=[math.radians(a) for a in rot])
        o = bpy.context.active_object
        o.scale = r
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if keep:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep(f.calc_center_median())], context="FACES")
            bm.to_mesh(o.data)
            bm.free()
            sol = o.modifiers.new("solid", "SOLIDIFY")
            sol.thickness = 0.008
            sol.offset = 1
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=sol.name)
        return self._add(o, col, ch)

    def box(self, c, size, col, ch, rot=(0, 0, 0), bevel=0.006):
        bpy.ops.mesh.primitive_cube_add(size=1, location=c, rotation=[math.radians(a) for a in rot])
        o = bpy.context.active_object
        o.scale = size
        return self._add(o, col, ch, bevel)

    def cyl(self, c, r, depth, col, ch, axis="Z", verts=12, rot=(0, 0, 0), bevel=0.004, r2=None):
        base = {"X": (0, 90, 0), "Y": (90, 0, 0), "Z": (0, 0, 0)}[axis]
        ang = [math.radians(a + b) for a, b in zip(base, rot)]
        if r2 is None:
            bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=c, rotation=ang)
        else:
            bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=c, rotation=ang)
        return self._add(bpy.context.active_object, col, ch, bevel)

    def torus(self, c, major, minor, col, ch, scale=(1, 1, 1), rot=(0, 0, 0), segs=16):
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=segs, minor_segments=6,
                                         location=c, rotation=[math.radians(a) for a in rot])
        o = bpy.context.active_object
        o.scale = scale
        return self._add(o, col, ch)


def crown(lift=1.0, cut_z=1.19):
    """Face-centre test that keeps the part of a head-sized ellipsoid above the brow line."""
    return lambda p: p.z > cut_z


# ------------------------------------------------------------------ the items (original designs)

OLIVE, OLIVE_D, MAROON, RED, GOLD = (0.38, 0.42, 0.25), (0.25, 0.28, 0.17), (0.48, 0.12, 0.16), (0.80, 0.16, 0.12), (0.86, 0.68, 0.24)
DARK, BLACK, CREAM, NAVY, BRASS = (0.20, 0.21, 0.23), (0.09, 0.09, 0.10), (0.92, 0.87, 0.74), (0.16, 0.22, 0.42), (0.74, 0.58, 0.30)
WHITE, GUM, TEAL, BLUE, RUST, YELLOW = (0.93, 0.93, 0.91), (0.62, 0.42, 0.24), (0.16, 0.66, 0.66), (0.18, 0.36, 0.62), (0.56, 0.28, 0.14), (0.96, 0.78, 0.16)
SMOKE, STEEL = (0.16, 0.20, 0.24), (0.55, 0.58, 0.62)


def field_cap(it):
    it.ellipsoid(CAP_C + Vector((0, 0, 0.005)), CAP_R * 1.07, OLIVE, P, keep=crown(cut_z=NECK_Z + 0.23))
    it.box((0, CAP_C.y - CAP_R.y * 1.08 - 0.06, NECK_Z + 0.245), (0.25, 0.15, 0.016), OLIVE_D, S, rot=(-8, 0, 0), bevel=0.01)
    it.ellipsoid(CAP_C + Vector((0, 0, CAP_R.z * 1.07 + 0.004)), (0.018, 0.018, 0.012), OLIVE_D, S, segs=8, rings=5)
    it.box((0, CAP_C.y - CAP_R.y * 1.04, NECK_Z + 0.31), (0.07, 0.012, 0.045), GOLD, A, bevel=0.003)
    it.extras["hidesHair"] = False


def beret(it):
    it.torus((0, CAP_C.y, NECK_Z + 0.34), 0.232, 0.02, BLACK, S, scale=(1.0, 1.06, 1.0))
    it.ellipsoid((-0.035, CAP_C.y - 0.005, NECK_Z + 0.41), (0.27, 0.27, 0.075), MAROON, P, segs=16, rings=8, rot=(0, -14, 0))
    it.box((0.1, CAP_C.y - 0.235, NECK_Z + 0.37), (0.05, 0.012, 0.055), GOLD, A, rot=(0, 0, 12), bevel=0.003)


def bandana(it):
    it.ellipsoid(CAP_C, CAP_R * 1.035, RED, P, keep=crown(cut_z=NECK_Z + 0.2))
    back = Vector((0, CAP_C.y + CAP_R.y * 1.03, NECK_Z + 0.26))
    it.ellipsoid(back, (0.035, 0.03, 0.03), RED, P, segs=8, rings=6)
    for side in (-1, 1):
        it.box(back + Vector((side * 0.035, 0.03, -0.06)), (0.035, 0.012, 0.11), RED, P, rot=(18, side * 18, 0), bevel=0.004)


def combat_helmet(it):
    it.ellipsoid(CAP_C + Vector((0, 0.0, 0.01)), CAP_R * 1.13, OLIVE, P, keep=crown(cut_z=NECK_Z + 0.16), segs=20, rings=12)
    it.torus((0, CAP_C.y, NECK_Z + 0.175), CAP_R.x * 1.12, 0.012, OLIVE_D, S, scale=(1.0, CAP_R.y / CAP_R.x, 1.0), segs=20)
    for side in (-1, 1):
        it.box((side * CAP_R.x * 1.1, CAP_C.y, NECK_Z + 0.27), (0.02, 0.14, 0.03), DARK, S, bevel=0.004)
    it.box((0, CAP_C.y - CAP_R.y * 1.12, NECK_Z + 0.34), (0.06, 0.03, 0.05), DARK, S, bevel=0.005)
    it.cyl((0, CAP_C.y - CAP_R.y * 1.12 - 0.02, NECK_Z + 0.34), 0.012, 0.012, TEAL, A, axis="Y", verts=8)
    it.extras["hidesHair"] = True


def aviators(it):
    y = FACE_Y - 0.018
    for side in (-1, 1):
        it.ellipsoid((side * EYE_X, y, EYE_Z), (0.052, 0.012, 0.04), SMOKE, A, segs=10, rings=6)
        it.torus((side * EYE_X, y + 0.002, EYE_Z), 0.05, 0.005, GOLD, S, scale=(1.0, 1.0, 0.8), rot=(90, 0, 0), segs=12)
        it.box((side * 0.185, y + 0.11, EYE_Z + 0.01), (0.008, 0.24, 0.008), GOLD, S, rot=(0, 0, side * -18), bevel=0)
    it.box((0, y, EYE_Z + 0.022), (0.05, 0.006, 0.008), GOLD, S, bevel=0)


def gas_mask(it):
    # Slim (docs/04 §1.2, strict): everything within ~2 cm of the face. A flat mouth plate with twin
    # cheek filters angled out to the sides, instead of one canister sticking 11 cm forward.
    mouth = Vector((0, FACE_Y + 0.025, EYE_Z - 0.075))
    it.ellipsoid(mouth, (0.14, 0.045, 0.10), BLACK, N, segs=14, rings=8)
    for side in (-1, 1):
        filt = Vector((side * 0.105, FACE_Y + 0.03, EYE_Z - 0.10))
        it.cyl(filt, 0.036, 0.045, OLIVE, S, axis="X", verts=12, rot=(0, 0, side * 35))
        it.cyl(filt + Vector((side * 0.02, -0.014, 0)), 0.038, 0.01, OLIVE_D, S, axis="X", verts=12,
               rot=(0, 0, side * 35), bevel=0)
        it.cyl((side * EYE_X, FACE_Y - 0.008, EYE_Z), 0.045, 0.03, BLACK, N, axis="Y", verts=12)
        it.cyl((side * EYE_X, FACE_Y - 0.022, EYE_Z), 0.036, 0.006, TEAL, A, axis="Y", verts=12, bevel=0)
    it.torus((0, CAP_C.y + 0.02, EYE_Z + 0.02), CAP_R.x * 1.04, 0.009, BLACK, N, scale=(1.0, 1.06, 1.0), segs=18)


def rocket_pack(it):
    it.extras["nozzleCount"] = 2
    c = Vector((0, JET.y + 0.12, JET.z + 0.02))
    it.box((0, JET.y + 0.015, JET.z), (0.2, 0.03, 0.3), DARK, S)
    it.cyl(c, 0.085, 0.34, CREAM, P, verts=14)
    it.cyl(c + Vector((0, 0, 0.23)), 0.085, 0.12, CREAM, P, verts=14, r2=0.015)
    for i in range(3):
        a = math.radians(90 + i * 120)
        it.box(c + Vector((0.1 * math.cos(a), 0.1 * math.sin(a), -0.12)), (0.012, 0.06, 0.12), NAVY, S,
               rot=(0, 0, math.degrees(a) + 90), bevel=0.003)
    for side in (-1, 1):
        it.cyl(c + Vector((side * 0.035, 0, -0.205)), 0.022, 0.07, BRASS, N, verts=10, r2=0.034)
    it.torus(c + Vector((0, 0, 0.06)), 0.087, 0.01, NAVY, A, segs=16)


def drum_pack(it):
    # radius 0.11: at 0.12 the drum stuck 1 cm out of the cosmetic envelope (asset-check)
    c = Vector((0, JET.y + 0.125, JET.z + 0.0))
    it.box((0, JET.y + 0.015, JET.z), (0.22, 0.03, 0.32), DARK, S)
    it.cyl(c, 0.11, 0.36, BLUE, P, verts=16)
    for dz in (-0.09, 0.09):
        it.torus(c + Vector((0, 0, dz)), 0.112, 0.008, RUST, S, segs=16)
    it.cyl(c + Vector((0, 0, 0.18)), 0.105, 0.01, RUST, S, verts=16, bevel=0)
    it.cyl(c + Vector((0, 0, -0.07)), 0.113, 0.03, YELLOW, A, verts=16, bevel=0)
    it.cyl(c + Vector((0, 0, -0.22)), 0.05, 0.09, DARK, N, verts=12, r2=0.075)


def _boot(it, side, upper, sole, accent, top):
    x = side * FOOT_X
    it.box((x, -0.03, 0.025), (0.13, 0.35, 0.05), sole[0], sole[1], bevel=0.018)
    it.ellipsoid((x, -0.05, 0.085), (0.07, 0.165, 0.07), upper[0], upper[1], segs=12, rings=8)
    it.cyl((x - side * 0.01, 0.04, 0.05 + top / 2), 0.078, top, upper[0], upper[1], verts=12, bevel=0.006)
    it.box((x + side * 0.068, -0.02, 0.09), (0.006, 0.14, 0.025), accent[0], accent[1], bevel=0)


def sneakers(it):
    for side in (-1, 1):
        _boot(it, side, (WHITE, P), (GUM, S), (TEAL, A), 0.17)


def jungle_boots(it):
    for side in (-1, 1):
        _boot(it, side, (OLIVE, P), (BLACK, S), (GOLD, A), 0.22)


def tactical_gloves(it, src=None, offset=0.010):
    """Gloves follow the body's own hands: copy the hand faces, inflate them a little. Built again
    from each body LOD (LOD1 decimates the hands differently), and skinned with the body's own
    hand/forearm weights (skin()), so the hand under the glove can't move out of it."""
    src = src or body
    groups = {g.index: g.name for g in src.vertex_groups}
    me = src.data
    dom = {}
    for v in me.vertices:
        if v.groups:
            g = max(v.groups, key=lambda g: g.weight)
            dom[v.index] = groups[g.group]
    for side in "LR":
        faces = [p for p in me.polygons if all(dom.get(i) == f"hand_{side}" for i in p.vertices)]
        bm = bmesh.new()
        vmap = {}
        for p in faces:
            for i in p.vertices:
                if i not in vmap:
                    v = me.vertices[i]
                    vmap[i] = bm.verts.new(src.matrix_world @ v.co + v.normal * offset)
            try:
                bm.faces.new([vmap[i] for i in p.vertices])
            except ValueError:
                pass
        order = {bv: n for n, bv in enumerate(bm.verts)}
        src_of = {order[bv]: i for i, bv in vmap.items()}
        m = bpy.data.meshes.new(f"glove_{side}")
        bm.to_mesh(m)
        bm.free()
        o = bpy.data.objects.new(f"glove_{side}", m)
        scene.collection.objects.link(o)
        # every glove vertex takes the weights of the skin vertex it was copied from, so the glove
        # bends exactly like the hand under it (decimation interpolates them for the LODs)
        for n, i in src_of.items():
            for g in me.vertices[i].groups:
                gname = groups[g.group]
                vg = o.vertex_groups.get(gname) or o.vertex_groups.new(name=gname)
                vg.add([n], g.weight, "REPLACE")
        for x in scene.objects:
            x.select_set(x == o)
        it._add(o, BLACK, P)


ITEMS = [
    ("headgear_field_cap", "headgear", "Field Cap", field_cap),
    ("headgear_beret", "headgear", "Beret", beret),
    ("headgear_bandana", "headgear", "Bandana", bandana),
    ("headgear_combat_helmet", "headgear", "Combat Helmet", combat_helmet),
    ("eyewear_aviators", "eyewear", "Aviators", aviators),
    ("eyewear_gas_mask", "eyewear", "Gas Mask", gas_mask),
    ("jetpack_rocket", "jetpack", "Rocket Pack", rocket_pack),
    ("jetpack_drum", "jetpack", "Drum Pack", drum_pack),
    ("boots_sneakers", "boots", "Sneakers", sneakers),
    ("boots_jungle", "boots", "Jungle Boots", jungle_boots),
    ("gloves_tactical", "gloves", "Tactical Gloves", tactical_gloves),
]
RIGID = {"headgear": "head", "eyewear": "head", "jetpack": "spine2"}
SOCKET = {"headgear": "socket_hat", "eyewear": "socket_hat", "jetpack": "socket_jetpack"}


# ------------------------------------------------------------------ generated sources (Higgsfield)

SRC = BLEND.parents[2] / "cosmetics" / "source"
USE_GENERATED = "--procedural" not in argv


def _hue(h, a, b):
    return (h >= a) & (h <= b) if a <= b else (h >= a) | (h <= b)


def _none(h):
    return np.zeros(h.shape, dtype=bool)


# Dye rules per generated item: (h°, s, v, pos) -> primary, secondary, accent, glow (docs/04 §5.4).
def rules_combat_helmet(h, s, v, pos):
    teal = _hue(h, 150, 215) & (s > 0.25)
    shell = _hue(h, 38, 95) & (s > 0.22) & (v > 0.42) & ~teal
    band = ~shell & ~teal & (v < 0.5)
    return shell, band, teal, _none(h)


def rules_field_cap(h, s, v, pos):
    gold = _hue(h, 30, 58) & (s > 0.45) & (v > 0.5)
    cloth = _hue(h, 40, 110) & (s > 0.15) & ~gold
    peak = cloth & (v < 0.36)
    return cloth & ~peak, peak, gold, _none(h)


def rules_beret(h, s, v, pos):
    gold = _hue(h, 25, 60) & (s > 0.4) & (v > 0.45)
    felt = _hue(h, 330, 20) & (s > 0.3) & (v > 0.2)
    band = ~felt & ~gold & (v < 0.4)
    return felt, band, gold, _none(h)


def rules_bandana(h, s, v, pos):
    cloth = _hue(h, 340, 25) & (s > 0.35)
    hem = ~cloth & (v < 0.3)
    return cloth, hem, _none(h), _none(h)


def rules_rocket(h, s, v, pos):
    cream = (s < 0.3) & (v > 0.6)
    navy = _hue(h, 195, 250) & (s > 0.25)
    brass = _hue(h, 30, 60) & (s > 0.35) & (v > 0.35)
    return cream, navy, brass, _none(h)


def rules_drum(h, s, v, pos):
    blue = _hue(h, 190, 230) & (s > 0.25)
    rust = _hue(h, 5, 35) & (s > 0.3)
    yellow = _hue(h, 40, 60) & (s > 0.5) & (v > 0.5)
    return blue, rust, yellow, _none(h)


def rules_boots(h, s, v, pos):
    """Upper = primary, sole = secondary (the bottom 4 cm of the boot), stripe/eyelets = accent."""
    sole = pos[..., 2] < 0.045
    accent = (_hue(h, 160, 210) & (s > 0.3)) | (_hue(h, 35, 55) & (s > 0.45) & (v > 0.45))
    return ~sole & ~accent, sole & ~accent, accent & ~sole, _none(h)


# yaw (°) turns the generator's front (+X after import) to the Rookie's front (−Y); jetpack sheets
# put the outside of the pack first, so their "front" turns to +Y (away from the back).
GENERATED = {
    # the generator painted it sand, the same as the default Brim Helmet: ship it olive drab
    "headgear_combat_helmet": {"yaw": -90, "rules": rules_combat_helmet, "dyes": {"primary": "#7a7b45"}},
    "headgear_field_cap": {"yaw": -90, "rules": rules_field_cap},
    "headgear_beret": {"yaw": -90, "rules": rules_beret, "brim": 0.25},  # band on the brow, not perched
    "headgear_bandana": {"yaw": -90, "rules": rules_bandana},
    "jetpack_rocket": {"yaw": 90, "rules": rules_rocket, "fit": "default"},
    "jetpack_drum": {"yaw": 90, "rules": rules_drum, "fit": "default"},
    "boots_sneakers": {"yaw": -90, "rules": rules_boots},
    "boots_jungle": {"yaw": -90, "rules": rules_boots},
}


def import_generated(path):
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in scene.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for o in scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # DIFFUSE/COLOR bakes base colour × (1 − metallic): zero the generator's metalness (badges, lenses)
    for m in obj.data.materials:
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                for ln in list(n.inputs["Metallic"].links):
                    m.node_tree.links.remove(ln)
                n.inputs["Metallic"].default_value = 0.0
    return obj


def bbox_np(obj, side=0):
    co = np.array([tuple(obj.matrix_world @ v.co) for v in obj.data.vertices])
    if side:
        co = co[co[:, 0] * side > 0]
    return co.min(axis=0), co.max(axis=0)


def fit(gen, proc, slot, yaw, cfg):
    """Scale + move the generated mesh into the procedural item's bounding box, or the default
    part's (`fit: default`, the slot's envelope reference) for generated jetpacks."""
    gen.data.transform(Matrix.Rotation(math.radians(yaw), 4, "Z"))
    co = np.array([tuple(v.co) for v in gen.data.vertices])
    if slot == "boots":
        # a pair: fit each boot to its own foot with one shared scale
        co[:, 0] -= (co[:, 0].min() + co[:, 0].max()) / 2
        sides = {side: co[:, 0] * side > 0 for side in (-1, 1)}
        s = min(min((bbox_np(proc, side)[1] - bbox_np(proc, side)[0]) / np.ptp(co[sel], axis=0))
                for side, sel in sides.items())
        out = co.copy()
        for side, sel in sides.items():
            glo, ghi = co[sel].min(axis=0), co[sel].max(axis=0)
            plo, phi = bbox_np(proc, side)
            t = (plo + phi) / 2 - (glo + ghi) / 2 * s
            t[2] = plo[2] - glo[2] * s  # soles on the ground
            out[sel] = co[sel] * s + t
    else:
        glo, ghi = co.min(axis=0), co.max(axis=0)
        plo, phi = bbox_np(proc)
        if cfg.get("fit") == "default" and slot in DEFAULT_BOX:
            plo, phi = (np.array(tuple(v)) for v in DEFAULT_BOX[slot])
        gsz, psz = ghi - glo, phi - plo
        if slot == "headgear":
            # width and depth of the procedural hat; the brim sits on its brim line
            s = min(psz[0] / gsz[0], psz[1] / gsz[1])
            t = (plo + phi) / 2 - (glo + ghi) / 2 * s
            t[2] = (NECK_Z + cfg["brim"] if "brim" in cfg else plo[2]) - glo[2] * s
        else:
            # jetpack: inside the box, backplate flush with the procedural plate
            s = float(min(psz / gsz))
            t = (plo + phi) / 2 - (glo + ghi) / 2 * s
            t[1] = plo[1] - glo[1] * s
        out = co * s + t
    gen.data.vertices.foreach_set("co", out.astype(np.float32).ravel())
    gen.data.update()
    return s


def clear_head(obj, margin=1.03):
    """Push any part of a generated hat's crown that dips into the head (the body's hair cap)
    back out to its surface. The hat's underside stays: it is hidden inside the head, and keeping
    the mesh closed lets the LODs decimate (an open rim stalls collapse decimation)."""
    c, r = CAP_C, CAP_R * margin
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    pushed = 0
    for v in bm.verts:
        d = Vector(((v.co.x - c.x) / r.x, (v.co.y - c.y) / r.y, (v.co.z - c.z) / r.z))
        # only the crown (above the cap's centre, facing out) moves; the underside sits below the
        # centre, and pushing it "out" would drive it down through the face
        if d.length < 1.0 and d.z > 0.05 and v.normal.dot((v.co - c).normalized()) > 0.2:
            d.normalize()
            v.co = c + Vector((d.x * r.x, d.y * r.y, d.z * r.z))
            pushed += 1
    bm.to_mesh(obj.data)
    bm.free()
    log(f"  head clearance: {pushed} crown verts pushed out")


def prep_lod(hi, name):
    """Copy of the generated mesh, ready to decimate: no UVs or custom normals, seams welded."""
    lo = hi.copy()
    lo.data = hi.data.copy()
    lo.name = name
    scene.collection.objects.link(lo)
    while lo.data.uv_layers:
        lo.data.uv_layers.remove(lo.data.uv_layers[0])
    for o in scene.objects:
        o.select_set(o == lo)
    bpy.context.view_layer.objects.active = lo
    if lo.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    # LOD0's smooth-by-angle marks sharp edges, and collapse won't decimate across them
    for name in ("sharp_edge", "sharp_face"):
        if name in lo.data.attributes:
            lo.data.attributes.remove(lo.data.attributes[name])
    bm = bmesh.new()
    bm.from_mesh(lo.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    # generated meshes arrive with a few pinholes: close them, since collapse decimation keeps
    # boundary edges and stalls above a 200-tri budget
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    bm.to_mesh(lo.data)
    bm.free()
    return lo


def bake_from(lo, hi, size, name, reach=0.05):
    """Bake the generated model's base colour onto the decimated LOD (selected-to-active). `reach`
    grows with decimation: a 200-tri LOD sits further from the source surface."""
    img = bpy.data.images.new(name, size, size, alpha=False)
    mat = bpy.data.materials.new(f"{name}_bake")
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = 0.0
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = img
    nt.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
    nt.nodes.active = tn
    lo.data.materials.clear()
    lo.data.materials.append(mat)
    for o in scene.objects:
        o.select_set(o in (lo, hi))
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_selected_to_active=True,
                        cage_extrusion=reach * 0.4, max_ray_distance=reach, margin=4)
    return img


# ------------------------------------------------------------------ finishing: paint, bake, skin

def paint_join(it):
    for o, col, ch in it.parts:
        me = o.data
        c_attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        d_attr = me.color_attributes.new("Dye", "BYTE_COLOR", "CORNER")
        for poly in me.polygons:
            up = 1.07 if poly.normal.z > 0.6 else (0.88 if poly.normal.z < -0.6 else 1.0)
            c = [srgb_to_linear(min(1.0, x * up)) for x in col]
            for li in poly.loop_indices:
                c_attr.data[li].color = (*c, 1.0)
                d_attr.data[li].color = tuple(float(v) for v in (list(ch) + [0, 0, 0, 0])[:4])
    for o in scene.objects:
        o.select_set(any(o == p[0] for p in it.parts))
    bpy.context.view_layer.objects.active = it.parts[0][0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = it.iid
    bpy.ops.object.shade_flat()
    return obj


def tri_count(m):
    m.calc_loop_triangles()
    return len(m.loop_triangles)


def decimate(obj, target):
    bpy.context.view_layer.objects.active = obj
    # open meshes (hats with the underside removed) can stall above the target: step harder
    for k in (1.0, 0.99, 0.95, 0.9, 0.82, 0.7):
        if tri_count(obj.data) <= target:
            break
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.use_collapse_triangulate = True
        mod.ratio = target / tri_count(obj.data) * k
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return tri_count(obj.data)


def unwrap(obj):
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    obj.data.uv_layers.new(name="UVMap")
    for o in scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_attr(target, source, layer, size, name, data):
    """Bake vertex-colour `layer` of `source` into a new image on `target` (EMIT bake)."""
    img = bpy.data.images.new(name, size, size, alpha=data)
    if data:
        img.colorspace_settings.name = "Non-Color"
    mat = bpy.data.materials.new(f"{name}_bake")
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    a = nt.nodes.new("ShaderNodeVertexColor")
    a.layer_name = layer
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(a.outputs["Color" if not data else "Color"], em.inputs["Color"])
    nt.nodes.active = tex
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    for o in (target, source):
        o.data.materials.clear()
        o.data.materials.append(mat)
    for o in scene.objects:
        o.select_set(o in (target, source))
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.bake(type="EMIT", use_selected_to_active=target != source, cage_extrusion=0.01,
                        max_ray_distance=0.03, margin=4)
    if data:
        # the mask's alpha channel = team glow: bake writes A=1, so take it from the Dye layer's A
        # via a second pass would cost a bake; none of the starter items glow, so clear it.
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
        px[..., 3] = 0
        img.pixels[:] = px.ravel()
    return img


def final_material(obj, albedo):
    mat = bpy.data.materials.new(f"{obj.name}_mat")
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.85
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = albedo
    nt.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def skin(obj, slot, src=None):
    for b in arm.data.bones:
        if b.use_deform and b.name not in obj.vertex_groups:
            obj.vertex_groups.new(name=b.name)
    vg = obj.vertex_groups
    # gloves already carry the skin's own weights (tactical_gloves)
    for v in obj.data.vertices if slot != "gloves" else ():
        side = "L" if v.co.x >= 0 else "R"
        if slot in RIGID:
            vg[RIGID[slot]].add([v.index], 1.0, "REPLACE")
        else:  # boots: rigid foot below the ankle, the shaft blends into the calf
            t = min(1.0, max(0.0, (v.co.z - 0.14) / 0.06))
            if t < 1:
                vg[f"foot_{side}"].add([v.index], 1 - t, "REPLACE")
            if t > 0:
                vg[f"calf_{side}"].add([v.index], t, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("skeleton", "ARMATURE")
    mod.object = arm


# Poses the build checks parts against: rest, then frames that bend the wrists, arms and legs.
POSE_SWEEP = [("idle", 0), ("idle", 30), ("walk", 8), ("run", 4), ("aim_rifle_level", 0), ("aim_rifle_up90", 0),
              ("aim_rifle_down90", 0), ("aim_pistol_level", 0), ("reload_rifle", 20), ("melee", 7), ("throw", 9)]
# m a body vertex may stand outside the part covering it. The gloves now carry the skin's own
# weights and stand 10 mm off it (13 mm at LOD1); what remains is a decimated glove face shearing
# by up to ~5.5 mm across the wrist's hand/forearm blend in strong bends (the review measured
# 22-39 mm before). Tighter needs a denser glove than the 150-tri slot budget allows.
POKE_MAX = 0.006


def poke_sweep(part, src, prefixes):
    """Worst distance (m) by which a body vertex skinned mostly to `prefixes` bones stands outside
    `part`, over POSE_SWEEP, with `src` the body LOD the part was built against. Raises if it is
    over POKE_MAX: skin poking through a glove is a defect (round-2 review)."""
    names = {g.index: g.name for g in src.vertex_groups}
    dom = {v.index for v in src.data.vertices
           if v.groups and names[max(v.groups, key=lambda g: g.weight).group].startswith(prefixes)}
    # the skin the part covers: vertices of the faces it was built from, minus their boundary
    # (the wrist ring at a glove's cuff is skin beyond the part, not skin under it)
    covered = [p for p in src.data.polygons if all(i in dom for i in p.vertices)]
    inner = {i for p in covered for i in p.vertices}
    edge = {i for p in src.data.polygons if not all(i in dom for i in p.vertices) for i in p.vertices}
    idx = sorted(inner - edge)
    # faces on the part's open rim (a glove's cuff): skin beyond the rim is not skin through the part
    uses = {}
    for poly in part.data.polygons:
        for k in poly.edge_keys:
            uses[k] = uses.get(k, 0) + 1
    rim = {poly.index for poly in part.data.polygons if any(uses[k] == 1 for k in poly.edge_keys)}
    arm.animation_data_create()
    saved = arm.animation_data.action
    worst, where = 0.0, "rest"
    rest_worst = 0.0
    for clip, frame in [(None, 0)] + POSE_SWEEP:
        if clip and clip not in bpy.data.actions:
            continue
        arm.animation_data.action = bpy.data.actions[clip] if clip else None
        if not clip:
            for pb in arm.pose.bones:
                pb.matrix_basis = Matrix()
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        bvh = BVHTree.FromObject(part, dg)
        inv = part.matrix_world.inverted()
        ev = src.evaluated_get(dg)
        me = ev.to_mesh()
        for i in idx:
            co = inv @ (src.matrix_world @ me.vertices[i].co)
            hit, nrm, face, dist = bvh.find_nearest(co)
            if hit is not None and face not in rim and (co - hit).dot(nrm) > 0 and not clip:
                rest_worst = max(rest_worst, dist)
            if hit is not None and face not in rim and (co - hit).dot(nrm) > 0 and dist > worst:
                worst, where = dist, f"{clip or 'rest'}@{frame}"
        ev.to_mesh_clear()
    arm.animation_data.action = saved
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    scene.frame_set(0)
    log(f"  {part.name}: worst skin outside the part over {len(POSE_SWEEP) + 1} poses: {worst * 1000:.1f} mm ({where}); at rest {rest_worst * 1000:.1f} mm")
    if worst > POKE_MAX:
        raise RuntimeError(f"{part.name}: the body pokes {worst * 1000:.1f} mm through it at {where} (max {POKE_MAX * 1000:.0f} mm)")


def export(path, obj, runtime, quality=90):
    for o in scene.objects:
        o.select_set(o in (arm, obj))
    bpy.context.view_layer.objects.active = arm
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True, export_extras=True,
        export_skins=True, export_def_bones=False, export_influence_nb=4, export_animations=False,
        export_image_format="WEBP" if runtime else "AUTO", export_image_quality=quality,
        export_meshopt_compression_enable=runtime, export_vertex_color="NONE",
        export_materials="EXPORT", export_normals=True, export_texcoords=True,
        export_cameras=False, export_lights=False,
    )


body.hide_set(True)
index = {}
for iid, slot, name, build in ITEMS:
    if ONLY and iid not in ONLY:
        continue
    it = Item(iid, slot, name)
    build(it)
    hi = paint_join(it)
    gen = GENERATED.get(iid) if USE_GENERATED else None
    if gen and (SRC / f"{iid}_tripo_raw.glb").exists():
        proc = hi
        hi = import_generated(SRC / f"{iid}_tripo_raw.glb")
        hi.name = f"{iid}_hi"
        s = fit(hi, proc, slot, gen["yaw"], gen)
        log(f"{iid}: generated source, {tri_count(hi.data)} tris, fitted at scale {s:.3f}")
        fit_envelope(hi, slot)
        if slot == "headgear":
            clear_head(hi)  # after the envelope fit: a squeezed crown must not sink into the hair
        bpy.data.objects.remove(proc, do_unlink=True)
    else:
        gen = None
        fit_envelope(hi, slot)
    tris0, tris1 = SLOT_TRIS[slot]
    lods = {}
    for suffix, (budget, size) in (("", (tris0, TEX[0])), ("_lod1", (tris1, TEX[1]))):
        if slot == "gloves" and suffix and body_lod1:
            # LOD1 gloves follow the LOD1 body's hands (a decimated LOD0 glove clipped them),
            # inflated a little more because the coarser hands bend less smoothly
            sub = Item(iid, slot, name)
            tactical_gloves(sub, body_lod1, offset=0.013)
            lo = paint_join(sub)  # already in the scene
        elif gen:
            # like the Rookie's body: decimate a welded copy, fresh UVs, bake the generated texture.
            # LOD1 starts from LOD0 (450 -> 200 is stable; 30k -> 200 leaves spikes) and stays
            # inside LOD0's bounds, so it can't fail an envelope LOD0 passes.
            lo = prep_lod(hi if not suffix else lods[""][0], f"{iid}{suffix}")
            t = decimate(lo, budget)
            if t > budget:
                # non-manifold fins in the generated mesh stall collapse: rebuild a clean surface
                rm = lo.modifiers.new("remesh", "REMESH")
                rm.mode, rm.voxel_size = "VOXEL", 0.008
                bpy.ops.object.modifier_apply(modifier=rm.name)
                t = decimate(lo, budget)
                log(f"  {iid}{suffix}: voxel remesh fallback -> {t} tris")
            if suffix:
                blo, bhi = bbox_np(lods[""][0])
                co = np.array([tuple(v.co) for v in lo.data.vertices])
                lo.data.vertices.foreach_set("co", np.clip(co, blo, bhi).astype(np.float32).ravel())
                lo.data.update()
            envelope.clamp(lo, ENV)  # the few mm decimation can drift
            unwrap(lo)
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))
            # LOD1 bakes from LOD0 (already textured): far closer than the 30k-tri source
            alb = bake_from(lo, hi if not suffix else lods[""][0], size, f"{iid}{suffix}_albedo")
            lods[suffix] = (lo, t, alb, None)
            continue
        else:
            lo = hi.copy()
            lo.data = hi.data.copy()
            scene.collection.objects.link(lo)
        lo.name = f"{iid}{suffix}"
        t = decimate(lo, budget)
        envelope.clamp(lo, ENV)  # the few mm decimation can drift
        unwrap(lo)
        src = hi if suffix else lo  # LOD0 bakes its own vertex colours; LOD1 bakes from LOD0's mesh
        alb = bake_attr(lo, src, "Col", size, f"{iid}{suffix}_albedo", data=False)
        msk = bake_attr(lo, src, "Dye", size, f"{iid}{suffix}_mask", data=True)
        lods[suffix] = (lo, t, alb, msk)
    tex_dir = OUT / slot / "textures"
    tex_dir.mkdir(parents=True, exist_ok=True)
    # the same schema as build_character's default parts; `name` is a placeholder (cosmetics.ts names it)
    entry = {"id": iid, "slot": slot, "name": name, "skeleton": "shared-v1", "default": False, "lods": {}, "dye": {}, "tris": {},
             "source": "generated" if gen else "procedural",
             **({"attachBone": RIGID[slot], "socket": SOCKET[slot]} if slot in RIGID else {})}
    for suffix, (lo, t, alb, msk) in lods.items():
        stem = f"{iid}{suffix}"
        size = alb.size[0]
        if msk is None:
            def rules(h, s, v, pos, base=gen["rules"]):  # never dye texels the bake didn't reach
                return tuple(m & (v > 0.02) for m in base(h, s, v, pos))
            defaults, cover = dye.make_masks(lo, alb, tex_dir, stem, rules)
            log(f"  {stem} dye cover {cover}")
            if gen.get("dyes"):
                # new default dyes: repaint the albedo so it still equals dyeAlbedo × lerp(1, dye, mask)
                defaults.update({k: v for k, v in gen["dyes"].items() if k in defaults})
                px = {}
                for kind in ("dye_albedo", "dye_mask"):
                    im = bpy.data.images.load(str(tex_dir / f"{stem}_{kind}.png"))
                    px[kind] = np.array(im.pixels[:], dtype=np.float32).reshape(size, size, 4)
                    bpy.data.images.remove(im)
                # in linear space, like the shader (dye.finish)
                tint = np.ones((size, size, 3), dtype=np.float32)
                for i, key in enumerate(("primary", "secondary", "accent")):
                    if key in defaults:
                        rgb = np.array([int(defaults[key][j:j + 2], 16) / 255 for j in (1, 3, 5)], dtype=np.float32)
                        tint *= 1 + px["dye_mask"][..., i:i + 1] * (dye._to_linear(rgb) - 1)
                lin = dye._to_linear(px["dye_albedo"][..., :3]) * tint
                out = np.concatenate([dye._to_srgb(lin), np.ones((size, size, 1), np.float32)], -1)
                alb.pixels[:] = out.ravel()
        else:
            col = np.array(alb.pixels[:], dtype=np.float32).reshape(size, size, 4)[..., :3]
            mask = np.array(msk.pixels[:], dtype=np.float32).reshape(size, size, 4)
            covered = np.ones(col.shape[:2], dtype=bool)
            defaults = dye.finish(col, mask, covered, tex_dir, stem)
        alb.filepath_raw = str(tex_dir / f"{stem}_albedo.png")
        alb.file_format = "PNG"
        alb.save()
        alb.pack()
        final_material(lo, alb)
        for layer in ("Col", "Dye"):
            if layer in lo.data.color_attributes:
                lo.data.color_attributes.remove(lo.data.color_attributes[layer])
        skin(lo, slot, body_lod1 if suffix and body_lod1 else body)
        if slot == "gloves":
            poke_sweep(lo, body_lod1 if suffix and body_lod1 else body, ("hand_",))
        lo["slot"] = slot
        lo["cosmeticId"] = iid  # display names live in packages/content/src/cosmetics.ts (W2's catalogue)
        lo["hidesHair"] = False
        lo["bodyTypes"] = ["standard"]
        lo["envelopeOk"] = envelope_ok(lo, slot)
        lo["dyeDefaults"] = defaults
        lo["dyeMask"] = f"{stem}_dye_mask.png"
        lo["dyeAlbedo"] = f"{stem}_dye_albedo"
        for k, v in it.extras.items():
            if k != "nozzleCount":  # build-only
                lo[k] = v
        if slot in RIGID:
            lo["attachBone"] = RIGID[slot]
            lo["socket"] = SOCKET[slot]
        if slot == "jetpack":
            nz = nozzles.find(lo, it.extras.get("nozzleCount", 1))
            lo["nozzles"] = nz
            entry.setdefault("nozzles", nz)  # the LOD0 positions
        export(OUT / slot / f"{stem}.glb", lo, runtime=False)
        lod = "lod0" if not suffix else "lod1"
        entry["lods"][lod] = f"{stem}.glb"
        entry["dye"][lod] = {"mask": f"textures/{stem}_dye_mask.png", "albedo": f"textures/{stem}_dye_albedo.webp",
                             "defaults": defaults}
        entry["tris"][lod] = t
        if RUNTIME:
            # 128² LOD1 textures go lossless (WebP quality 100): lossy WebP smears their tiny
            # islands, and they cost only a few KB more
            q = 100 if size <= 128 else 90
            export(RUNTIME / "cosmetics" / slot / f"{stem}.glb", lo, runtime=True, quality=q)
            rt_tex = RUNTIME / "cosmetics" / slot / "textures"
            rt_tex.mkdir(parents=True, exist_ok=True)
            shutil.copy(tex_dir / f"{stem}_dye_mask.png", rt_tex / f"{stem}_dye_mask.png")
            img = bpy.data.images.load(str(tex_dir / f"{stem}_dye_albedo.png"))
            # save_render applies the view transform: AgX would tone-map the albedo
            scene.view_settings.view_transform = "Standard"
            scene.view_settings.look = "None"
            scene.view_settings.exposure = 0.0
            scene.view_settings.gamma = 1.0
            st = scene.render.image_settings
            st.file_format, st.color_mode, st.quality = "WEBP", "RGB", q
            img.save_render(str(rt_tex / f"{stem}_dye_albedo.webp"), scene=scene)
            bpy.data.images.remove(img)
        log(f"{stem}: {t} tris, {size}² textures, dyes {defaults}")
    for x in [hi] + [lods[s][0] for s in lods]:
        bpy.data.objects.remove(x, do_unlink=True)
    index[iid] = entry
    if RUNTIME:
        (RUNTIME / "cosmetics" / slot / f"{iid}.json").write_text(json.dumps(entry, indent=2))

if ONLY and (OUT / "cosmetics.json").exists():
    index = {**json.loads((OUT / "cosmetics.json").read_text()), **index}
(OUT / "cosmetics.json").write_text(json.dumps(index, indent=2))
if RUNTIME:
    # the full catalogue: the Rookie's default parts + these starter items, by slot
    catalogue = {}
    for f in sorted((RUNTIME / "cosmetics").glob("*/*.json")):
        e = json.loads(f.read_text())
        catalogue.setdefault(e["slot"], []).append({"id": e["id"], "name": e.get("name", e["id"]),
                                                    "default": e.get("default", False), "manifest": f"{e['slot']}/{f.name}"})
    (RUNTIME / "cosmetics" / "index.json").write_text(json.dumps(catalogue, indent=2))
log("done")
