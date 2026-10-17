"""Weapon attachments ("things you can add"), in the arsenal's chunky toy style.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_attachments.py -- \
        art/attachments [--runtime apps/web/public/assets]

One GLB per attachment (packages/content/src/attachments.ts ids), each in its MOUNT frame, which is
the weapon frame (docs/04 §9.4: +Y toward the muzzle, +Z up, +X right) moved to the socket:
  rail_top     origin on the rail centre; the part sits above it (+Z)
  rail_bottom  origin on the rail centre; the part hangs below it (−Z)
  muzzle       origin on the muzzle; the part extends forward (+Y). Its `muzzle` node is the new
               flash point; scale it by the weapon's boreRadius / 0.016
  mag          origin on the mag socket; the part extends along local −Z: turn −Z onto the
               socket's `dir` when mounting
The laser has a `beam` node (the beam leaves along +Y). attachments.json lists each part's mount,
size, mounting hints and the weapons it fits, computed from art/weapons/sockets.json:
  sights: an unoccupied rail_top (the long scope needs ≥ 0.10 m of rail)
  suppressor: a muzzle with boreRadius ≤ 0.02 on anything but a launcher or heavy
  foregrip: a rail_bottom on a two-handed weapon; laser: any rail_bottom
  long mag: a mag socket pointing down (box mags), not a shotgun, launcher or heavy
  drum: the K-47 and the Buzz (the drum's look fits them)
"""
import json
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None
REPO = Path(__file__).resolve().parents[2]
SOCKETS = json.loads((REPO / "art/weapons/sockets.json").read_text())["weapons"]

GUNMETAL = (0.20, 0.22, 0.25)
DARK = (0.11, 0.11, 0.12)
STEEL = (0.47, 0.50, 0.55)
POLY = (0.30, 0.33, 0.22)
LENS = (0.55, 0.80, 0.86)
BEAM = (0.30, 1.00, 0.40)  # green: never a team colour
SUPPRESSOR_BORE = 0.016    # the bore the suppressor is modelled for


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


class Part:
    def __init__(self, aid):
        self.aid = aid
        self.parts = []
        self.nodes = {}

    def _finish(self, o, color, bevel):
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel:
            m = o.modifiers.new("bevel", "BEVEL")
            m.width = bevel
            m.segments = 1
            bpy.ops.object.modifier_apply(modifier=m.name)
        self.parts.append((o, color))
        return o

    def box(self, center, size, color, bevel=0.003):
        bpy.ops.mesh.primitive_cube_add(size=1, location=center)
        o = bpy.context.active_object
        o.scale = size
        return self._finish(o, color, bevel)

    def node(self, name, pos, dir=None):
        self.nodes[name] = (pos, dir)

    def cyl(self, center, radius, length, color, axis="Y", verts=14, bevel=0.002):
        rot = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=length, location=center, rotation=rot)
        return self._finish(bpy.context.active_object, color, bevel)


def sight_dot(p):
    p.box((0, 0, 0.006), (0.026, 0.05, 0.012), DARK)                 # rail clamp
    p.box((0, 0, 0.026), (0.03, 0.046, 0.03), GUNMETAL)              # housing
    p.box((0, -0.0235, 0.03), (0.022, 0.002, 0.018), LENS, bevel=0)  # rear lens
    p.box((0, 0.0235, 0.03), (0.022, 0.002, 0.018), LENS, bevel=0)   # front lens


def sight_long(p):
    for y in (-0.045, 0.045):
        p.box((0, y, 0.012), (0.022, 0.016, 0.024), DARK)            # rings
    p.cyl((0, 0, 0.038), 0.016, 0.16, GUNMETAL)                     # tube
    p.cyl((0, 0.075, 0.038), 0.02, 0.02, GUNMETAL)                  # objective bell
    p.cyl((0, -0.073, 0.038), 0.018, 0.018, GUNMETAL)               # eyepiece
    p.cyl((0, 0.086, 0.038), 0.017, 0.002, LENS, bevel=0)
    p.cyl((0, 0.012, 0.058), 0.007, 0.012, STEEL, axis="Z")         # turret


def suppressor(p):
    p.cyl((0, 0.07, 0), 0.026, 0.14, DARK)
    for y in (0.025, 0.05, 0.075, 0.1):
        p.cyl((0, y, 0), 0.0275, 0.006, GUNMETAL, bevel=0)
    p.node("muzzle", (0, 0.142, 0), dir=(0, 1, 0))


def foregrip(p):
    p.box((0, 0, -0.006), (0.022, 0.04, 0.012), DARK)                # clamp
    p.cyl((0, 0, -0.045), 0.013, 0.07, POLY, axis="Z")              # grip


def laser(p):
    p.box((0, 0, -0.006), (0.022, 0.04, 0.012), DARK)
    p.box((0, 0.004, -0.024), (0.026, 0.05, 0.024), GUNMETAL)
    p.cyl((0, 0.031, -0.024), 0.006, 0.004, BEAM, bevel=0)          # emitter
    p.node("beam", (0, 0.033, -0.024), dir=(0, 1, 0))


def mag_ext(p):
    p.box((0, 0, -0.04), (0.03, 0.045, 0.08), POLY)                 # the extra length below the stock mag
    p.box((0, 0, -0.083), (0.034, 0.05, 0.008), DARK)                # base plate


def mag_drum(p):
    p.box((0, 0, -0.018), (0.03, 0.04, 0.036), POLY)                 # feed
    p.cyl((0, 0, -0.07), 0.05, 0.045, DARK, axis="X", verts=18)      # the drum
    p.cyl((0.024, 0, -0.07), 0.02, 0.004, STEEL, axis="X", bevel=0)


ATTACHMENTS = [
    # id, builder, mount, footprint along the rail (m)
    ("sight_dot", sight_dot, "rail_top", 0.05),
    ("sight_long", sight_long, "rail_top", 0.10),
    ("suppressor", suppressor, "muzzle", 0.0),
    ("foregrip", foregrip, "rail_bottom", 0.04),
    ("laser", laser, "rail_bottom", 0.05),
    ("mag_ext", mag_ext, "mag", 0.0),
    ("mag_drum", mag_drum, "mag", 0.0),
]


def fits(aid, footprint):
    out = []
    for wid, w in SOCKETS.items():
        s, fam = w["sockets"], w["family"]
        if aid.startswith("sight"):
            ok = "rail_top" in s and not s["rail_top"].get("occupied") and s["rail_top"]["lengthM"] >= footprint
        elif aid == "suppressor":
            ok = "muzzle" in s and s["muzzle"].get("boreRadius", 1) <= 0.02 and fam not in ("launcher", "heavy")
        elif aid == "foregrip":
            ok = "rail_bottom" in s and w["hands"] == 2
        elif aid == "laser":
            ok = "rail_bottom" in s
        elif aid == "mag_ext":
            ok = "mag" in s and s["mag"]["dir"][2] < -0.7 and fam not in ("shotgun", "launcher", "heavy")
        else:  # mag_drum
            ok = wid in ("k47", "buzz")
        if ok:
            out.append(wid)
    return out


def build(aid, builder):
    bpy.ops.wm.read_homefile(use_empty=True)
    mat = bpy.data.materials.new("attachment_toon")
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.7
    vc = mat.node_tree.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    mat.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    p = Part(aid)
    builder(p)
    for o, color in p.parts:
        col = o.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for poly in o.data.polygons:
            up = 1.08 if poly.normal.z > 0.6 else (0.86 if poly.normal.z < -0.6 else 1.0)
            c = [srgb_to_linear(min(1.0, ch * up)) for ch in color]
            for li in poly.loop_indices:
                col.data[li].color = (*c, 1.0)
        o.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    for o, _ in p.parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = p.parts[0][0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = aid
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    # modelling frame (+Y forward, +Z up) → the glTF weapon frame, as build_weapons does
    rot = Matrix.Rotation(math.radians(90), 4, "X")
    obj.data.transform(rot)
    nodes = {}
    for name, (pos, d) in p.nodes.items():
        e = bpy.data.objects.new(name, None)
        e.location = rot @ Vector(pos)
        if d:
            e["dir"] = [round(c, 3) for c in Vector(d).normalized()]
        bpy.context.scene.collection.objects.link(e)
        e.parent = obj
        nodes[name] = {"pos": [round(c, 4) + 0.0 for c in pos], **({"dir": list(d)} if d else {})}
    obj.data.calc_loop_triangles()
    return obj, nodes, len(obj.data.loop_triangles)


def export(path, obj, runtime):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for c in obj.children:
        c.select_set(True)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


# the ids and mounts must match packages/content/src/attachments.ts
import re  # noqa: E402
content = (REPO / "packages/content/src/attachments.ts").read_text()
want = dict(re.findall(r"id: '([^']+)', name: '[^']+', kind: '[^']+', mount: '([^']+)'", content))
have = {aid: mount for aid, _, mount, _ in ATTACHMENTS}
if want != have:
    raise RuntimeError(f"attachments differ from packages/content: content {want}, art {have}")

manifest = {}
for aid, builder, mount, footprint in ATTACHMENTS:
    obj, nodes, tris = build(aid, builder)
    obj["attachmentId"] = aid
    obj["mount"] = mount
    entry = {"mount": mount, "file": f"{aid}.glb", "tris": tris, "railFootprintM": footprint, "nodes": nodes,
             "fits": fits(aid, footprint)}
    if aid == "suppressor":
        entry.update({"modelBoreM": SUPPRESSOR_BORE, "flashScale": 0.4,
                      "notes": "scale by the weapon's muzzle.boreRadius / modelBoreM; the flash moves to its `muzzle` node"})
    if mount == "mag":
        entry["notes"] = "turn the part's −Z onto the weapon's mag socket dir"
    if mount == "rail_bottom":
        entry["notes"] = "with both foregrip and laser on one rail: foregrip at −¼, laser at +¼ of the rail length"
    manifest[aid] = entry
    export(OUT / f"{aid}.glb", obj, runtime=False)
    if RUNTIME:
        export(RUNTIME / "attachments" / f"{aid}.glb", obj, runtime=True)
    print(f"[build_attachments] {aid:10s} {tris:4d} tris  {mount:11s} fits {entry['fits']}")

doc = {
    "frame": "mount frame = the weapon frame (glTF: +Y muzzle, +Z up, +X right) moved to the socket; see "
             "art/pipeline/build_attachments.py",
    "fairness": "stat-changing attachments are in-match pickups only, never sold (packages/content/src/attachments.ts)",
    "attachments": manifest,
}
(OUT / "attachments.json").write_text(json.dumps(doc, indent=1))
if RUNTIME:
    (RUNTIME / "attachments" / "attachments.json").write_text(json.dumps(doc, indent=1))
print("[build_attachments] done")
