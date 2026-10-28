"""Self-test for check.py: known-good assets must pass and known-bad ones must fail.

    blender -b --factory-startup --python-exit-code 1 --python tools/asset-check/selftest.py

Builds part fixtures in a temp dir, skinned to the Rookie's skeleton like real parts (docs/04 §9.3),
and runs check.py on them plus the art-test assets. A check that crashes (exit code 2) never counts
as a pass or a fail. Exits 1 if any verdict is unexpected.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import bmesh
import bpy

REPO = Path(__file__).resolve().parents[2]
CHECK = REPO / "tools/asset-check/check.py"
CHAR = REPO / "art/character"
BODY, JET = CHAR / "rookie_body.glb", CHAR / "parts/jetpack_twin_tank.glb"
DEFAULTS = [CHAR / "parts/headgear_brim_helmet.glb", CHAR / "parts/boots_combat.glb", JET]
# body + default parts: an outfit; only the body counts for a part's envelope (docs/04 §1.2)
OUTFIT = ",".join(str(f) for f in [BODY, *DEFAULTS])
LOD1 = ",".join(str(f).replace(".glb", "_lod1.glb") for f in [BODY, *DEFAULTS])
COS = REPO / "art/cosmetics"
MARKET = REPO / "art/kits/street_market/kit_street_market.glb"


EXTRAS = {"bodyTypes": ["standard"], "envelopeOk": True, "dyeable": False,  # a valid part, minus dyes
          "cosmeticId": "headgear_fixture", "hidesHair": False}


def _skinned(path, build, bone, slot, skinned=True, move_bone=None):
    """Import the Rookie's skeleton, build a mesh with `build()`, weight it 100% to `bone`, export.
    move_bone: (name, metres up) to bind the part to a skeleton whose rest pose differs."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(BODY), disable_bone_shape=True)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        bpy.data.objects.remove(o, do_unlink=True)
    if move_bone:
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode="EDIT")
        eb = arm.data.edit_bones[move_bone[0]]
        eb.head.z += move_bone[1]
        eb.tail.z += move_bone[1]
        bpy.ops.object.mode_set(mode="OBJECT")
    o = build()
    if slot:
        o["slot"] = slot
    for k, v in EXTRAS.items():
        o[k] = v
    if skinned:
        o.vertex_groups.new(name=bone).add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        o.parent = arm
        o.modifiers.new("skeleton", "ARMATURE").object = arm
    else:
        bpy.data.objects.remove(arm, do_unlink=True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False,
                              export_extras=True, export_skins=True, export_animations=False)


def hat(path, radius, z0, z1, y=0.0, squash_y=1.0, slot="headgear", **kw):
    def build():
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=z1 - z0, location=(0, y, (z0 + z1) / 2))
        o = bpy.context.active_object
        o.scale.y = squash_y
        bpy.ops.object.transform_apply(scale=True)
        o.name = "hat"
        return o
    _skinned(path, build, "head", slot, **kw)


def weapon_family(path, family):
    """The K-47 relabelled with another family (e.g. docs/03's 'smg' class instead of a §4.2 family)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(REPO / "art/weapons/k47.glb"))
    for o in bpy.data.objects:
        if o.type == "MESH":
            o["family"] = family
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False, export_extras=True,
                              export_vertex_color="ACTIVE")


def k47_edit(path, edit, weapon="k47"):
    """The K-47 (or `weapon`) with `edit(objects by name)` applied to its sockets, re-exported."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(REPO / f"art/weapons/{weapon}.glb"))
    edit({o.name.split(".")[0]: o for o in bpy.data.objects})
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False, export_extras=True,
                              export_vertex_color="ACTIVE")


def stretched(objs):
    """A blueprint 10 % longer than its base (a barrel poking past cover first): every mesh along the bore."""
    for o in objs.values():
        if o.type == "MESH" and o.parent is None:
            o.scale.z *= 1.1  # the bore is Blender +Z after the glTF import (glTF +Y)


def muzzle_forward(objs):
    """A blueprint whose muzzle node moved 3 cm down the barrel."""
    objs["muzzle"].location.z += 0.03


def eject_left(objs):
    """Casings thrown across the player: the eject socket mirrored to the left."""
    e = objs["eject"]
    e.location.x = -e.location.x
    e["dir"] = [-e["dir"][0], e["dir"][1], e["dir"][2]]


def no_rail(objs):
    bpy.data.objects.remove(objs["rail_top"], do_unlink=True)


def no_face(objs):
    bpy.data.objects.remove(objs["face"], do_unlink=True)


def short_shield(objs):
    """The riot shield at 70 % height: shorter than the 0.9 m the sim blocks."""
    objs["riot_shield"].scale = (1.0, 1.0, 0.7)  # glTF +Y (up) is Blender +Z after import


def shrink_frag(objs):
    """The frag at its old size (0.09 m wide), under half its 0.1 m sim radius."""
    objs["frag"].scale = (0.45, 0.45, 0.45)


def team_orange_frag(objs):
    """The frag painted in the orange team's colour."""
    lin = (1.0, 0.194, 0.0103, 1.0)  # #ff7a1a in linear
    for d in objs["frag"].data.color_attributes[0].data:
        d.color = lin


def open_slide(objs):
    """The Hawk's slide, flagged cutClean, with three faces punched out of its shell."""
    me = objs["part_slide"].data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=bm.faces[:3], context="FACES")
    bm.to_mesh(me)
    bm.free()


def claims_casings(objs):
    """The Dragon marked as throwing casings, which it has no `eject` socket for."""
    objs["dragon"]["casings"] = True


def suffixed_grip(objs):
    """The shield's LOD1 with Blender's clash suffix on its grip node (review L4)."""
    objs["grip"].name = "grip.001"


def deep_jetpack(path, back):
    """The default jetpack, moved `back` metres further behind (Blender +Y)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(JET), disable_bone_shape=True)
    for o in bpy.data.objects:
        if o.type == "MESH":
            for v in o.data.vertices:
                v.co.y += back
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False,
                              export_extras=True, export_skins=True, export_animations=False)


def dye_fixture(dst, darken=None, with_textures=True):
    """The default jetpack in its own folder: its dye textures copied next to it (optionally the dye
    albedo darkened like the AgX bug, 0.6x linear), or none at all."""
    import shutil
    import numpy as np
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copy(JET, dst / JET.name)
    if not with_textures:
        return dst / JET.name
    (dst / "textures").mkdir(exist_ok=True)
    for f in (CHAR / "textures").glob("jetpack_twin_tank_*.png"):
        if "_lod1" not in f.name:
            shutil.copy(f, dst / "textures" / f.name)
    if darken:
        f = dst / "textures" / "jetpack_twin_tank_dye_albedo.png"
        im = bpy.data.images.load(str(f))
        px = np.array(im.pixels[:], dtype=np.float32).reshape(-1, 4)
        lin = np.where(px[:, :3] <= 0.04045, px[:, :3] / 12.92, ((px[:, :3] + 0.055) / 1.055) ** 2.4) * darken
        px[:, :3] = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
        im.pixels[:] = px.ravel()
        im.filepath_raw, im.file_format = str(f), "PNG"
        im.save()
    return dst / JET.name


def from_item(path, src, edit):
    """A shipped cosmetic, edited by `edit(mesh_object, armature)` and re-exported with its skin."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(src), disable_bone_shape=True)
    mesh = next(o for o in bpy.data.objects if o.type == "MESH")
    edit(mesh, next(o for o in bpy.data.objects if o.type == "ARMATURE"))
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False, export_extras=True,
                              export_skins=True, export_animations=False)


def widen(mesh, _arm, k=1.9):
    for v in mesh.data.vertices:
        v.co.x *= k


def add_panel(mesh, _arm):
    """A 0.58 × 1.15 m head-weighted panel at x 0.40 that hides the arm and the team armband."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    vs = [bm.verts.new(c) for c in ((0.40, -0.29, 0.15), (0.40, 0.29, 0.15), (0.40, 0.29, 1.30), (0.40, -0.29, 1.30))]
    bm.faces.new(vs)
    bm.to_mesh(mesh.data)
    bm.free()
    head = mesh.vertex_groups["head"]
    head.add([v.index for v in mesh.data.vertices][-4:], 1.0, "REPLACE")


def market_edit(path, edit):
    """The Street Market kit with `edit(crates_object)` applied, re-exported with its extras."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(MARKET))
    edit(bpy.data.objects["sm_crates"])
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False, export_extras=True,
                              export_vertex_color="ACTIVE", export_animations=False)


def sack_on_plane(o):
    """A 0.6 m sack on the top crate, on the gameplay plane, with no collision under it."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.create_cube(bm, size=0.6, matrix=__import__("mathutils").Matrix.Translation((-0.5, 0.0, 1.9)))
    bm.to_mesh(o.data)
    bm.free()


def team_orange(o):
    attr = o.data.color_attributes.active_color or o.data.color_attributes[0]
    for d in attr.data:
        d.color = (1.0, 0.195, 0.0103, 1.0)  # #ff7a1a, linear


def clips_edit(src, dst, flip=False, meshopt=False):
    """A copy of a clips GLB with one rotation key negated (flip) or flagged as meshopt-compressed."""
    import json, struct
    b = bytearray(Path(src).read_bytes())
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    base = 20 + jl + 8
    if flip:
        a = g["animations"][0]
        ch = next(c for c in a["channels"] if c["target"]["path"] == "rotation")
        acc = g["accessors"][a["samplers"][ch["sampler"]]["output"]]
        off = base + g["bufferViews"][acc["bufferView"]].get("byteOffset", 0) + acc.get("byteOffset", 0) + 16
        q = struct.unpack_from("<4f", b, off)
        struct.pack_into("<4f", b, off, *(-x for x in q))
    if meshopt:
        g.setdefault("extensionsUsed", []).append("EXT_meshopt_compression")
    js = json.dumps(g).encode()
    js += b" " * (-len(js) % 4)
    out = bytearray(b[:12]) + struct.pack("<II", len(js), 0x4E4F534A) + js + b[20 + jl:]
    struct.pack_into("<I", out, 8, len(out))
    Path(dst).write_bytes(bytes(out))


def run(path, *args):
    """'pass', 'fail' or 'crash' (check.py exits 0 / 1 / anything else)."""
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1",
           "--python", str(CHECK), "--", str(path), *args]
    code = subprocess.run(cmd, capture_output=True, text=True).returncode
    return {0: "pass", 1: "fail"}.get(code, "crash")


tmp = Path(tempfile.mkdtemp(prefix="asset-check-"))
hat(tmp / "hat_ok.glb", 0.22, 1.30, 1.47)            # sits on the hair, under the envelope top
hat(tmp / "hat_huge.glb", 0.60, 1.40, 2.20)          # top hat from a cartoon: way over
hat(tmp / "hat_back.glb", 0.20, 1.38, 1.56, y=0.19)  # sticks out behind the head, into the jetpack's depth
deep_jetpack(tmp / "jetpack_deep.glb", 0.25)
hat(tmp / "hat_unskinned.glb", 0.22, 1.30, 1.47, skinned=False)       # valid except for the skin
hat(tmp / "hat_wide.glb", 0.48, 1.30, 1.45, squash_y=0.45)           # 1 m wide: inside the body box, not near the head
hat(tmp / "hat_feet.glb", 0.20, 0.0, 0.30)                           # skinned to the head but modelled at the feet
hat(tmp / "hat_movedbone.glb", 0.22, 1.30, 1.47, move_bone=("head", 0.10))  # bound to another bind pose
hat(tmp / "hat_noslot.glb", 0.22, 1.30, 1.47, slot=None)             # extras without `slot`
weapon_family(tmp / "k47_smg.glb", "smg")
jet_dark = dye_fixture(tmp / "dark", darken=0.6)
from_item(tmp / "field_cap_wide.glb", COS / "headgear/headgear_field_cap.glb", widen)
from_item(tmp / "aviators_panel.glb", COS / "eyewear/eyewear_aviators.glb", add_panel)
jet_nodye = dye_fixture(tmp / "nodye", with_textures=False)
k47_edit(tmp / "k47_eject_left.glb", eject_left)
k47_edit(tmp / "k47_no_rail.glb", no_rail)
k47_edit(tmp / "k47_long.glb", stretched)
k47_edit(tmp / "k47_galaxy_relic_muzzle.glb", muzzle_forward, "k47_galaxy_relic")
k47_edit(tmp / "shield_no_face.glb", no_face, "riot_shield")
k47_edit(tmp / "dragon_casings.glb", claims_casings, "dragon")
k47_edit(tmp / "hawk_open_slide.glb", open_slide, "hawk50")
k47_edit(tmp / "frag_small.glb", shrink_frag, "frag")
k47_edit(tmp / "shield_short.glb", short_shield, "riot_shield")
k47_edit(tmp / "frag_orange.glb", team_orange_frag, "frag")
k47_edit(tmp / "shield_lod1_suffix.glb", suffixed_grip, "riot_shield_lod1")
market_edit(tmp / "kit_sack.glb", sack_on_plane)
market_edit(tmp / "kit_orange.glb", team_orange)
clips_edit(CHAR / "rookie_anims.glb", tmp / "clips_flipped.glb", flip=True)
clips_edit(CHAR / "rookie_anims.glb", tmp / "clips_meshopt.glb", meshopt=True)

cases = [
    ("Rookie outfit LOD0 passes", "pass", OUTFIT),
    ("Rookie outfit LOD1 passes", "pass", LOD1, "--lod", "1"),
    ("raw generator mesh fails", "fail", CHAR / "source/rookie_tripo_raw.glb"),
    ("LOD0 outfit fails the LOD1 budget", "fail", OUTFIT, "--lod", "1"),
    ("animation-only GLB fails cleanly", "fail", CHAR / "rookie_anims.glb"),
    ("default jetpack fits the body-only envelope", "pass", JET, "--kind", "part", "--base", OUTFIT),
    ("jetpack 25 cm deeper than the default fails", "fail", tmp / "jetpack_deep.glb", "--kind", "part", "--base", OUTFIT),
    ("combat helmet cosmetic passes", "pass", COS / "headgear/headgear_combat_helmet.glb", "--kind", "part", "--base", OUTFIT),
    ("fully dressed outfit passes", "pass", ",".join(str(f) for f in [BODY, COS / "headgear/headgear_combat_helmet.glb",
     COS / "eyewear/eyewear_gas_mask.glb", COS / "gloves/gloves_tactical.glb", COS / "boots/boots_jungle.glb",
     COS / "jetpack/jetpack_rocket.glb"])),
    ("LOD0 helmet fails the LOD1 slot budget", "fail", COS / "headgear/headgear_combat_helmet.glb", "--kind", "part",
     "--lod", "1", "--base", OUTFIT),
    ("kit passes", "pass", REPO / "art/kit/kit_yard.glb", "--kind", "kit"),
    ("K-47 weapon passes", "pass", REPO / "art/weapons/k47.glb", "--kind", "weapon"),
    ("mine (thrown, ground node) passes", "pass", REPO / "art/weapons/mine.glb", "--kind", "weapon"),
    ("a body is not a weapon", "fail", BODY, "--kind", "weapon"),
    ("hat inside the envelope passes", "pass", tmp / "hat_ok.glb", "--kind", "part", "--base", OUTFIT),
    ("oversized hat fails", "fail", tmp / "hat_huge.glb", "--kind", "part", "--base", OUTFIT),
    ("hat sticking out behind fails (the jetpack doesn't widen headgear)", "fail", tmp / "hat_back.glb", "--kind", "part", "--base", OUTFIT),
    ("unskinned part fails (the skin rule alone)", "fail", tmp / "hat_unskinned.glb", "--kind", "part", "--base", OUTFIT),
    ("1 m-wide hat fails (locality)", "fail", tmp / "hat_wide.glb", "--kind", "part", "--base", OUTFIT),
    ("hat modelled at the feet fails (locality)", "fail", tmp / "hat_feet.glb", "--kind", "part", "--base", OUTFIT),
    ("part bound to a moved head bone fails", "fail", tmp / "hat_movedbone.glb", "--kind", "part", "--base", OUTFIT),
    ("part without a slot extra fails", "fail", tmp / "hat_noslot.glb", "--kind", "part", "--base", OUTFIT),
    ("weapon with a non-§4.2 family fails", "fail", tmp / "k47_smg.glb", "--kind", "weapon"),
    ("dye albedo darkened like the AgX bug fails", "fail", jet_dark, "--kind", "part", "--base", OUTFIT),
    ("part with its dye files missing fails", "fail", jet_nodye, "--kind", "part", "--base", OUTFIT),
    ("Field Cap 1.9x wide fails (locality)", "fail", tmp / "field_cap_wide.glb", "--kind", "part", "--base", OUTFIT),
    ("Aviators with a panel down to the shins fail (locality)", "fail", tmp / "aviators_panel.glb", "--kind", "part", "--base", OUTFIT),
    ("K-47 casings ejecting to the left fail", "fail", tmp / "k47_eject_left.glb", "--kind", "weapon"),
    ("K-47 without its top rail fails", "fail", tmp / "k47_no_rail.glb", "--kind", "weapon"),
    # docs/17 §3.6: blueprint (Forged) skins against their base gun
    ("K-47 Galaxy Relic is a blueprint of the K-47", "pass", REPO / "art/weapons/k47_galaxy_relic.glb", "--kind", "weapon",
     "--blueprint-of", REPO / "art/weapons/k47.glb"),
    ("the K-47 is a blueprint of itself", "pass", REPO / "art/weapons/k47.glb", "--kind", "weapon", "--blueprint-of", REPO / "art/weapons/k47.glb"),
    ("a K-47 10 % longer is no blueprint of it", "fail", tmp / "k47_long.glb", "--kind", "weapon", "--blueprint-of", REPO / "art/weapons/k47.glb"),
    ("a blueprint with its muzzle node 3 cm off fails", "fail", tmp / "k47_galaxy_relic_muzzle.glb", "--kind", "weapon",
     "--blueprint-of", REPO / "art/weapons/k47.glb"),
    ("the Hammer .44 is no blueprint of the K-47", "fail", REPO / "art/weapons/hammer44.glb", "--kind", "weapon",
     "--blueprint-of", REPO / "art/weapons/k47.glb"),
    ("Hawk .50 (slide cut clean: a closed shell) passes", "pass", REPO / "art/weapons/hawk50.glb", "--kind", "weapon"),
    ("Hawk .50 with a hole in its cutClean slide fails", "fail", tmp / "hawk_open_slide.glb", "--kind", "weapon"),
    ("Dragon (no casings, no eject socket) passes", "pass", REPO / "art/weapons/dragon.glb", "--kind", "weapon"),
    ("Dragon marked as throwing casings, with no eject socket, fails", "fail", tmp / "dragon_casings.glb", "--kind", "weapon"),
    ("Riot Shield (shield space, face, grip, ground) passes", "pass", REPO / "art/weapons/riot_shield.glb", "--kind", "weapon"),
    ("Riot Shield without its face socket fails", "fail", tmp / "shield_no_face.glb", "--kind", "weapon"),
    ("Riot Shield shorter than the 0.9 m the sim blocks fails", "fail", tmp / "shield_short.glb", "--kind", "weapon"),
    ("Riot Shield LOD1 passes", "pass", REPO / "art/weapons/riot_shield_lod1.glb", "--kind", "weapon"),
    ("Riot Shield LOD1 with a `grip.001` node fails", "fail", tmp / "shield_lod1_suffix.glb", "--kind", "weapon"),
    ("frag at under half its sim radius fails", "fail", tmp / "frag_small.glb", "--kind", "weapon"),
    ("frag in the orange team's colour fails", "fail", tmp / "frag_orange.glb", "--kind", "weapon"),
    ("frag (sim-sized, fuse light) passes", "pass", REPO / "art/weapons/frag.glb", "--kind", "weapon"),
    ("Street Market kit passes", "pass", MARKET, "--kind", "kit"),
    ("kit prop on the gameplay plane with no collision fails", "fail", tmp / "kit_sack.glb", "--kind", "kit"),
    ("kit piece in team orange fails", "fail", tmp / "kit_orange.glb", "--kind", "kit"),
    ("Rookie clips pass (LINEAR, sign-continuous, no meshopt)", "pass", CHAR / "rookie_anims.glb", "--kind", "clips"),
    ("runtime clips pass", "pass", REPO / "apps/web/public/assets/characters/rookie/rookie_anims.glb", "--kind", "clips"),
    ("clips with a sign-flipped key fail", "fail", tmp / "clips_flipped.glb", "--kind", "clips"),
    ("clips through meshopt fail", "fail", tmp / "clips_meshopt.glb", "--kind", "clips"),
]
bad = 0
for name, expect, path, *args in cases:
    got = run(path, *args)
    ok = got == expect
    bad += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {got} (expected {expect})")
print(f"selftest: {len(cases) - bad}/{len(cases)} as expected")
sys.exit(1 if bad else 0)
