"""Build the arsenal's weapon models (docs/03 §5) as chunky toy guns.

    blender -b --factory-startup --python art/pipeline/build_weapons.py -- <art_out_dir> [--runtime <assets_dir>]

Every weapon follows docs/04 §9.4: origin at the main grip, **+Y toward the muzzle, +Z up, +X to
the weapon's right** (glTF), so the renderer attaches it to `socket_weapon_R` with an identity
transform. Child nodes (sockets), with extras `dir` (a unit vector in the weapon frame; all but
`offhand`, a hand target) and the extras below:
  grip         the main hand (the origin)
  muzzle       flash + tracer origin, dir +Y; `boreRadius` sizes the flash and the suppressor
  offhand      left-hand IK target (two-handed weapons; within 0.10 m of the grip: chibi arms are short)
  eject        where casings leave, dir = their throw (right, up, a little back)
  mag          the magazine / loading point (revolver cylinder, shotgun port, launcher breech, ammo
               box), dir = the way a mag drops or a round goes in
  rail_top     scope / sight mount, dir +Z, `lengthM` of usable rail; `occupied` when a sight is
               built in (Widow)
  rail_bottom  foregrip / laser mount, dir −Z, `lengthM`
The mesh carries a `_CAMO` vertex attribute (1 on body panels that take a weapon camo, 0 on grips,
steel, the toy tip and blades).
  backblast    launcher exhaust (Thumper), dir −Y
  tip, pin, light, ground  the machete's tip, the frag's pin ring, the mine's light, and the frag
               and mine rest frame in the world (local +Y up, origin on the floor:
               world = floorPoint × inverse(ground.local))
All sockets also go to weapons/sockets.json for the renderer. Weapon extras: weaponId, name,
archetype, hands, family (the docs/04 §4.2 weapon family, plus `thrown`) and aimPose (the clip set
it uses today: pistol or rifle; see clips.AIM_POSE_FALLBACK).

Style: bevelled toy shapes, vertex colours (one shared material, no textures), and an orange
toy muzzle tip on every gun: it reads at gameplay size and keeps the toy-soldier theme.
Names are the invented ones from docs/03 §2, never real-world models.
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

GUNMETAL = (0.20, 0.22, 0.25)
STEEL = (0.47, 0.50, 0.55)
DARK = (0.11, 0.11, 0.12)
POLY = (0.30, 0.33, 0.22)    # olive polymer
WOOD = (0.55, 0.34, 0.18)
SAND = (0.66, 0.58, 0.42)
ORANGE = (0.98, 0.45, 0.10)  # toy muzzle tip
# Body panels take a camo (apps/web/public/assets/weapons/camos.json); grips, steel, the toy tip
# and blades keep their colour, so a camo never hides what a weapon is or where it points.
CAMO_COLOURS = {(0.20, 0.22, 0.25), (0.30, 0.33, 0.22), (0.55, 0.34, 0.18), (0.66, 0.58, 0.42)}
RED = (0.90, 0.12, 0.10)
BLADE = (0.70, 0.73, 0.76)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def reset():
    bpy.ops.wm.read_homefile(use_empty=True)
    mat = bpy.data.materials.new("weapon_toon")
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.7
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


class Gun:
    """Collects coloured parts in the modelling frame (Blender: muzzle +Y, top +Z, grip at 0)."""

    def __init__(self, wid):
        self.wid = wid
        self.parts = []
        self.nodes = {}

    def _finish(self, o, color, bevel, segments=1):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel:
            m = o.modifiers.new("bevel", "BEVEL")
            m.width = bevel
            m.segments = segments
            m.limit_method = "ANGLE"
            bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
        self.parts.append((o, color))
        return o

    def box(self, center, size, color, bevel=0.006, rot=(0, 0, 0)):
        bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=[math.radians(r) for r in rot])
        o = bpy.context.active_object
        o.scale = size
        return self._finish(o, color, bevel)

    def cyl(self, center, radius, length, color, axis="Y", verts=12, bevel=0.004, rot=None):
        r = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
        if rot:
            r = tuple(a + math.radians(b) for a, b in zip(r, rot))
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=length, location=center, rotation=r)
        return self._finish(bpy.context.active_object, color, bevel)

    def cone(self, center, r1, r2, length, color, axis="Y", verts=12):
        r = {"X": (0, math.pi / 2, 0), "Y": (-math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=length, location=center, rotation=r)
        return self._finish(bpy.context.active_object, color, 0.003)

    def sphere(self, center, radius, color, segs=10, rings=7, scale=(1, 1, 1)):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=radius, location=center)
        o = bpy.context.active_object
        o.scale = scale
        return self._finish(o, color, 0)

    def torus(self, center, major, minor, color, axis="X"):
        r = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=10,
                                         minor_segments=5, location=center, rotation=r)
        return self._finish(bpy.context.active_object, color, 0)

    def tip(self, y, z, radius):
        """Orange toy muzzle ring + the `muzzle` node just past it."""
        self.cyl((0, y + 0.012, z), radius * 1.15, 0.024, ORANGE, bevel=0.003)
        self.node("muzzle", (0, y + 0.026, z), dir=(0, 1, 0), boreRadius=radius)

    def node(self, name, pos, rot=None, dir=None, **extras):
        """rot: Euler degrees in the exported (socket) frame; None = the weapon's own axes.
        dir: the socket's direction in the weapon frame (normalised); extras go on the node."""
        if dir is not None:
            d = Vector(dir).normalized()
            extras["dir"] = [round(c, 3) for c in d]
        self.nodes[name] = (pos, rot, extras)

    def rails(self, top=None, bottom=None, **extras):
        """Attachment rails: (y, z, length) each, on the centreline."""
        if top:
            self.node("rail_top", (0, top[0], top[1]), dir=(0, 0, 1), lengthM=top[2], **extras)
        if bottom:
            self.node("rail_bottom", (0, bottom[0], bottom[1]), dir=(0, 0, -1), lengthM=bottom[2])

    def ground(self, z):
        """Rest frame for throwables/deployables: on the item's bottom (modelling z), with local
        +Y (glTF) along the item's top, i.e. +90° about X in the socket frame."""
        self.node("ground", (0, 0, z), rot=(90, 0, 0), dir=(0, 0, -1))


def paint_and_join(gun, mat):
    zs = [(o.matrix_world @ v.co).z for o, _ in gun.parts for v in o.data.vertices]
    zmin, zmax = min(zs), max(zs)
    for o, color in gun.parts:
        me = o.data
        camo = me.attributes.new("_CAMO", "FLOAT", "POINT")  # glTF _CAMO: 1 = this vertex takes a camo
        camo.data.foreach_set("value", [1.0 if tuple(color) in CAMO_COLOURS else 0.0] * len(me.vertices))
        col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for poly in me.polygons:
            up = 1.08 if poly.normal.z > 0.6 else (0.86 if poly.normal.z < -0.6 else 1.0)
            for li in poly.loop_indices:
                z = me.vertices[me.loops[li].vertex_index].co.z
                t = (z - zmin) / max(1e-6, zmax - zmin)
                ao = 0.82 + 0.18 * t
                c = [min(1.0, ch * up * ao) for ch in color]
                col.data[li].color = (*[srgb_to_linear(ch) for ch in c], 1.0)
        me.materials.clear()
        me.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    for o, _ in gun.parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = gun.parts[0][0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = gun.wid
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    # Modelling frame (muzzle +Y, top +Z) → socket frame after the glTF Y-up conversion
    # (glTF +Y muzzle, +Z up): rotate +90° about X so Blender +Y→+Z and +Z→−Y.
    rot = Matrix.Rotation(math.radians(90), 4, "X")
    obj.data.transform(rot)
    gun.nodes.setdefault("grip", ((0, 0, 0), None, {"dir": [0.0, 1.0, 0.0]}))
    for name, (pos, nrot, extras) in gun.nodes.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.02
        e.location = rot @ Vector(pos)
        if nrot:
            e.rotation_euler = [math.radians(a) for a in nrot]
        for k, v in extras.items():
            e[k] = v
        bpy.context.scene.collection.objects.link(e)
        e.parent = obj
    return obj


# ------------------------------------------------------------------ the arsenal (docs/03 §5)

def hawk50(g):  # heavy pistol, default sidearm
    g.box((0, 0.08, 0.055), (0.036, 0.25, 0.055), GUNMETAL)
    g.box((0, 0.06, 0.018), (0.032, 0.17, 0.03), DARK)
    g.box((0, -0.012, -0.045), (0.034, 0.055, 0.12), DARK, rot=(-14, 0, 0))
    g.box((0, 0.03, -0.012), (0.012, 0.05, 0.03), DARK, bevel=0.002)
    g.tip(0.205, 0.058, 0.016)
    g.node("eject", (0.02, 0.06, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, -0.015, -0.105), dir=(0, -0.25, -1))
    g.rails(top=(0.11, 0.083, 0.08), bottom=(0.12, 0.003, 0.06))


def hammer44(g):  # magnum revolver, default primary
    g.cyl((0, 0.17, 0.062), 0.017, 0.2, GUNMETAL)
    g.box((0, 0.17, 0.083), (0.008, 0.18, 0.012), GUNMETAL, bevel=0.002)
    g.cyl((0, 0.045, 0.055), 0.036, 0.06, STEEL, verts=10)
    g.box((0, 0.02, 0.05), (0.03, 0.1, 0.06), GUNMETAL)
    g.box((0, -0.03, 0.085), (0.012, 0.025, 0.03), DARK, rot=(-30, 0, 0), bevel=0.002)
    g.box((0, -0.025, -0.04), (0.034, 0.05, 0.12), WOOD, rot=(-22, 0, 0))
    g.box((0, 0.025, 0.0), (0.01, 0.045, 0.025), DARK, bevel=0.002)
    g.tip(0.27, 0.062, 0.017)
    g.node("eject", (0.03, 0.045, 0.055), dir=(0.6, -0.6, 0.5))  # spent cases on reload
    g.node("mag", (0, 0.045, 0.055), dir=(-1, 0, 0))  # the cylinder; it swings out to the left
    g.rails(top=(0.17, 0.089, 0.1), bottom=(0.2, 0.045, 0.06))


def buzz(g):  # compact SMG (one-handed)
    g.box((0, 0.08, 0.05), (0.05, 0.29, 0.075), DARK)
    g.cyl((0, 0.25, 0.062), 0.016, 0.06, GUNMETAL)
    g.box((0, 0.11, -0.065), (0.034, 0.042, 0.15), GUNMETAL)
    g.box((0, -0.005, -0.04), (0.036, 0.05, 0.1), DARK, rot=(-10, 0, 0))
    g.box((0, -0.09, 0.05), (0.03, 0.06, 0.04), POLY)
    g.box((0, 0.09, 0.094), (0.012, 0.06, 0.016), DARK, bevel=0.002)
    g.tip(0.28, 0.062, 0.016)
    g.node("eject", (0.03, 0.08, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.11, -0.14), dir=(0, 0, -1))
    g.rails(top=(0.09, 0.102, 0.06), bottom=(0.2, 0.0125, 0.05))


def k47(g):  # assault rifle
    g.box((0, 0.06, 0.04), (0.05, 0.3, 0.085), GUNMETAL)
    g.box((0, -0.21, 0.02), (0.045, 0.26, 0.075), WOOD, rot=(6, 0, 0))
    g.box((0, 0.27, 0.05), (0.048, 0.18, 0.06), WOOD)
    g.cyl((0, 0.45, 0.06), 0.013, 0.2, DARK)
    g.box((0, 0.36, 0.085), (0.012, 0.02, 0.04), DARK, bevel=0.002)
    g.box((0, 0.075, -0.055), (0.035, 0.05, 0.1), POLY, rot=(18, 0, 0))
    g.box((0, 0.105, -0.13), (0.033, 0.05, 0.08), POLY, rot=(34, 0, 0))
    g.box((0, -0.03, -0.045), (0.036, 0.05, 0.1), DARK, rot=(-12, 0, 0))
    g.tip(0.55, 0.06, 0.013)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.03, 0.08, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.12, -0.17), dir=(0, 0.45, -1))
    g.rails(top=(0.05, 0.0825, 0.14), bottom=(0.28, 0.02, 0.12))


def breacher(g):  # pump shotgun
    g.box((0, 0.05, 0.045), (0.05, 0.22, 0.08), GUNMETAL)
    g.box((0, -0.2, 0.03), (0.045, 0.28, 0.08), WOOD, rot=(5, 0, 0))
    g.cyl((0, 0.36, 0.068), 0.02, 0.44, DARK)
    g.cyl((0, 0.3, 0.032), 0.016, 0.34, GUNMETAL)
    g.box((0, 0.1, 0.03), (0.05, 0.11, 0.05), WOOD)
    g.box((0, -0.025, -0.04), (0.036, 0.05, 0.1), DARK, rot=(-12, 0, 0))
    g.box((0, 0.13, 0.098), (0.012, 0.03, 0.012), STEEL, bevel=0.002)
    g.tip(0.58, 0.068, 0.02)
    g.node("offhand", (-0.05, 0.08, -0.02))
    g.node("eject", (0.035, 0.06, 0.06), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.03, 0.005), dir=(0, 0, -1))  # loading port under the receiver
    g.rails(top=(0.05, 0.085, 0.12))


def widow(g):  # bolt sniper
    g.box((0, 0.06, 0.04), (0.048, 0.26, 0.075), POLY)
    g.box((0, -0.22, 0.02), (0.045, 0.3, 0.085), POLY, rot=(5, 0, 0))
    g.box((0, -0.2, 0.065), (0.04, 0.14, 0.03), POLY)
    g.cyl((0, 0.47, 0.055), 0.014, 0.56, DARK)
    g.cyl((0, 0.07, 0.125), 0.028, 0.24, DARK)
    g.cyl((0, -0.06, 0.125), 0.034, 0.05, GUNMETAL)
    g.cyl((0, 0.2, 0.125), 0.034, 0.04, GUNMETAL)
    g.box((0, 0.07, 0.095), (0.02, 0.06, 0.03), GUNMETAL)
    g.cyl((0.04, -0.02, 0.06), 0.008, 0.06, STEEL, axis="X")
    g.sphere((0.072, -0.02, 0.06), 0.013, STEEL, segs=8, rings=5)
    g.box((0, 0.075, -0.05), (0.03, 0.05, 0.07), DARK, rot=(15, 0, 0))
    g.box((0, -0.03, -0.045), (0.036, 0.05, 0.1), POLY, rot=(-12, 0, 0))
    g.tip(0.75, 0.055, 0.014)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.035, 0.05, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.085, -0.085), dir=(0, 0.25, -1))
    g.rails(top=(0.07, 0.0775, 0.16), bottom=(0.16, 0.0025, 0.06), occupied="scope")


def thumper(g):  # rocket launcher
    g.cyl((0, 0.05, 0.095), 0.068, 0.9, POLY, verts=14)
    g.cone((0, 0.53, 0.095), 0.068, 0.085, 0.07, POLY, verts=14)
    g.cone((0, -0.43, 0.095), 0.085, 0.068, 0.07, POLY, verts=14)
    g.cone((0, 0.58, 0.095), 0.045, 0.012, 0.07, ORANGE, verts=10)
    g.box((0, 0.0, -0.01), (0.036, 0.05, 0.1), DARK, rot=(-10, 0, 0))
    g.box((0, 0.08, -0.005), (0.036, 0.05, 0.09), DARK, rot=(-6, 0, 0))
    g.box((0.07, -0.02, 0.15), (0.03, 0.08, 0.05), GUNMETAL)
    g.box((0, 0.2, 0.16), (0.02, 0.04, 0.03), DARK, bevel=0.003)
    g.node("muzzle", (0, 0.62, 0.095), dir=(0, 1, 0), boreRadius=0.06)
    g.node("offhand", (-0.05, 0.08, -0.03))
    g.node("mag", (0, -0.465, 0.095), dir=(0, -1, 0))  # loads at the breech
    g.node("backblast", (0, -0.47, 0.095), dir=(0, -1, 0))
    g.rails(top=(-0.05, 0.163, 0.12))


def shredder(g):  # minigun
    for i in range(6):
        a = i * math.pi / 3
        g.cyl((0.03 * math.cos(a), 0.37, 0.07 + 0.03 * math.sin(a)), 0.011, 0.42, DARK, verts=8, bevel=0)
    for y in (0.22, 0.56):
        g.cyl((0, y, 0.07), 0.05, 0.03, GUNMETAL, verts=12)
    g.box((0, 0.02, 0.06), (0.11, 0.3, 0.13), GUNMETAL)
    g.box((0, 0.03, 0.15), (0.03, 0.18, 0.025), DARK)
    g.box((0, -0.02, 0.135), (0.03, 0.03, 0.04), DARK)
    g.box((0, 0.11, 0.135), (0.03, 0.03, 0.04), DARK)
    g.box((-0.1, 0.0, 0.02), (0.08, 0.16, 0.14), POLY)
    g.box((0, -0.03, -0.05), (0.036, 0.05, 0.1), DARK, rot=(-10, 0, 0))
    g.tip(0.58, 0.07, 0.052)
    g.node("offhand", (-0.05, 0.08, -0.03))
    g.node("eject", (0.07, 0.05, 0.05), dir=(0.7, -0.2, -0.7))  # links and cases spill down-right
    g.node("mag", (-0.14, 0.0, 0.02), dir=(-1, 0, 0))  # the ammo box on the left
    g.rails(top=(0.03, 0.1625, 0.1))


def machete(g):
    g.cyl((0, 0.0, 0.0), 0.019, 0.13, DARK, verts=10)
    for y in (-0.03, 0.0, 0.03):
        g.cyl((0, y, 0.0), 0.021, 0.012, ORANGE, verts=10, bevel=0)
    g.box((0, 0.075, 0.0), (0.03, 0.02, 0.06), STEEL)
    blade = g.box((0, 0.3, 0.012), (0.01, 0.44, 0.07), BLADE, bevel=0.002)
    # taper the blade toward a raked tip
    for v in blade.data.vertices:
        t = max(0.0, (v.co.y - 0.08) / 0.44)
        if v.co.z > 0.012:
            v.co.z -= 0.03 * t * t
        if v.co.y > 0.45 and v.co.z < 0.0:
            v.co.y -= 0.05 * (v.co.y - 0.45) / 0.07
    g.node("tip", (0, 0.52, 0.0), dir=(0, 1, 0))


def frag(g):  # frag grenade (held in the right hand like a ball)
    g.sphere((0, 0, 0), 0.045, POLY, segs=10, rings=8, scale=(1, 1, 1.15))
    for z in (-0.02, 0.02):
        g.cyl((0, 0, z), 0.0465, 0.006, (0.24, 0.27, 0.17), axis="Z", verts=10, bevel=0)
    g.cyl((0, 0, 0.06), 0.016, 0.03, STEEL, axis="Z", verts=8)
    g.box((0.012, -0.012, 0.03), (0.01, 0.012, 0.07), STEEL, rot=(0, 18, 0), bevel=0.002)
    g.torus((-0.02, 0, 0.075), 0.013, 0.003, ORANGE, axis="X")
    g.node("pin", (-0.02, 0, 0.075), dir=(-1, 0, 0))
    g.ground(-0.045 * 1.15)  # stands on its base at rest


def mine(g):  # proximity mine: origin at its centre, +Z up is its top
    g.cyl((0, 0, 0), 0.1, 0.035, POLY, axis="Z", verts=16, bevel=0.006)
    g.cyl((0, 0, 0.022), 0.07, 0.012, GUNMETAL, axis="Z", verts=14, bevel=0.003)
    g.sphere((0, 0, 0.032), 0.016, RED, segs=8, rings=5, scale=(1, 1, 0.7))
    for i in range(4):
        a = i * math.pi / 2 + math.pi / 4
        g.box((0.085 * math.cos(a), 0.085 * math.sin(a), 0.0), (0.03, 0.03, 0.04), DARK, bevel=0.003)
    g.node("light", (0, 0, 0.04), dir=(0, 0, 1))
    g.ground(-0.02)  # the feet


def rattler(g):  # machine pistol (one-handed, long mag below the grip)
    g.box((0, 0.09, 0.056), (0.036, 0.27, 0.05), GUNMETAL)
    g.box((0, 0.05, 0.02), (0.034, 0.17, 0.028), POLY)
    g.box((0, -0.012, -0.045), (0.034, 0.055, 0.12), POLY, rot=(-14, 0, 0))
    g.box((0, -0.03, -0.14), (0.028, 0.045, 0.1), DARK, rot=(-14, 0, 0))     # the long mag
    g.box((0, 0.03, -0.012), (0.012, 0.05, 0.03), DARK, bevel=0.002)
    for y in (-0.02, -0.005, 0.01):
        g.box((0.019, y, 0.062), (0.004, 0.006, 0.03), DARK, bevel=0)        # slide grooves
    g.tip(0.225, 0.058, 0.015)
    g.node("eject", (0.02, 0.07, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, -0.055, -0.19), dir=(0, -0.25, -1))
    g.rails(top=(0.11, 0.081, 0.06), bottom=(0.13, 0.006, 0.05))


def hornet(g):  # high-rate SMG: folding stock, vented shroud, mag ahead of the trigger
    g.box((0, 0.06, 0.05), (0.05, 0.26, 0.075), GUNMETAL)
    g.box((0, 0.24, 0.055), (0.052, 0.12, 0.06), POLY)                       # vented shroud
    for y in (0.205, 0.235, 0.265):
        g.box((0.027, y, 0.055), (0.004, 0.016, 0.02), DARK, bevel=0)
    g.cyl((0, 0.32, 0.055), 0.013, 0.05, DARK)
    g.box((0, 0.1, -0.06), (0.032, 0.04, 0.16), DARK)                         # straight mag
    g.box((0, -0.03, -0.045), (0.036, 0.05, 0.1), POLY, rot=(-12, 0, 0))
    g.box((0, 0.025, -0.01), (0.012, 0.045, 0.025), DARK, bevel=0.002)
    g.box((0, -0.12, 0.07), (0.012, 0.16, 0.014), STEEL, bevel=0.002)          # folding stock: top bar
    g.box((0, -0.12, 0.0), (0.012, 0.16, 0.014), STEEL, bevel=0.002, rot=(-22, 0, 0))
    g.box((0, -0.2, 0.035), (0.03, 0.02, 0.09), DARK)                         # butt plate
    g.box((0, 0.06, 0.093), (0.012, 0.05, 0.014), DARK, bevel=0.002)
    g.tip(0.345, 0.055, 0.013)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.03, 0.06, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.1, -0.14), dir=(0, 0, -1))
    g.rails(top=(0.06, 0.0875, 0.1), bottom=(0.24, 0.025, 0.08))


def trident(g):  # 3-round burst rifle: angular handguard, carry handle, slotted stock
    g.box((0, 0.06, 0.04), (0.05, 0.28, 0.08), GUNMETAL)
    g.box((0, 0.3, 0.048), (0.054, 0.2, 0.066), POLY)                         # angular handguard
    g.box((0, 0.3, 0.012), (0.04, 0.2, 0.01), POLY, rot=(4, 0, 0))
    g.cyl((0, 0.47, 0.055), 0.012, 0.16, DARK)
    g.box((0, 0.06, 0.112), (0.02, 0.16, 0.014), GUNMETAL)                     # carry handle
    for y in (0.0, 0.12):
        g.box((0, y, 0.095), (0.016, 0.02, 0.026), GUNMETAL)
    g.box((0, -0.21, 0.035), (0.046, 0.24, 0.07), POLY, rot=(4, 0, 0))         # stock
    for y in (-0.26, -0.2, -0.14):
        g.box((0.024, y, 0.04), (0.004, 0.04, 0.012), DARK, bevel=0)
    g.box((0, 0.08, -0.06), (0.034, 0.05, 0.1), DARK, rot=(16, 0, 0))          # curved mag
    g.box((0, 0.105, -0.13), (0.032, 0.05, 0.07), DARK, rot=(30, 0, 0))
    g.box((0, -0.03, -0.045), (0.036, 0.05, 0.1), POLY, rot=(-12, 0, 0))
    g.box((0, 0.025, -0.01), (0.012, 0.045, 0.025), DARK, bevel=0.002)
    g.tip(0.55, 0.055, 0.012)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.03, 0.08, 0.07), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.12, -0.165), dir=(0, 0.4, -1))
    g.rails(top=(0.06, 0.119, 0.12), bottom=(0.3, 0.007, 0.12))


def bullpup(g):  # bullpup rifle: long smooth body, magazine behind the grip
    g.box((0, -0.04, 0.045), (0.056, 0.5, 0.09), POLY)                         # body, stock to handguard
    g.box((0, -0.27, 0.03), (0.05, 0.04, 0.11), DARK)                         # butt pad
    g.box((0, 0.16, 0.1), (0.04, 0.22, 0.022), GUNMETAL)                       # top rail housing
    g.cyl((0, 0.27, 0.05), 0.012, 0.1, DARK)
    g.box((0, -0.08, -0.06), (0.034, 0.05, 0.11), DARK, rot=(-12, 0, 0))       # mag behind the grip
    g.box((0, 0.0, -0.045), (0.036, 0.05, 0.1), POLY, rot=(-12, 0, 0))         # grip
    g.box((0, 0.045, -0.02), (0.012, 0.06, 0.03), DARK, bevel=0.002)            # long trigger guard
    for y in (0.08, 0.13):
        g.box((0.029, y, 0.06), (0.004, 0.03, 0.01), DARK, bevel=0)
    g.tip(0.315, 0.05, 0.012)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.03, -0.1, 0.06), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, -0.095, -0.13), dir=(0, -0.2, -1))
    g.rails(top=(0.16, 0.111, 0.16), bottom=(0.17, 0.0, 0.08))


def longbow(g):  # marksman rifle: wood stock, long thin barrel, medium scope, small box mag
    g.box((0, 0.08, 0.04), (0.046, 0.3, 0.07), WOOD)                           # fore-end
    g.box((0, -0.2, 0.025), (0.044, 0.26, 0.08), WOOD, rot=(6, 0, 0))           # stock
    g.box((0, -0.03, -0.045), (0.036, 0.05, 0.1), WOOD, rot=(-14, 0, 0))        # grip
    g.box((0, 0.04, 0.07), (0.036, 0.14, 0.03), GUNMETAL)                       # receiver
    g.cyl((0, 0.45, 0.06), 0.011, 0.46, DARK)
    g.cyl((0, 0.05, 0.115), 0.022, 0.2, DARK)                                  # scope
    g.cyl((0, 0.15, 0.115), 0.027, 0.03, GUNMETAL)
    for y in (0.0, 0.1):
        g.box((0, y, 0.09), (0.016, 0.016, 0.03), GUNMETAL)
    g.cyl((0.035, -0.0, 0.07), 0.007, 0.05, STEEL, axis="X")                    # bolt
    g.sphere((0.062, 0.0, 0.07), 0.011, STEEL, segs=8, rings=5)
    g.box((0, 0.08, -0.03), (0.03, 0.05, 0.06), DARK)                          # small box mag
    g.box((0, 0.03, -0.01), (0.012, 0.045, 0.025), DARK, bevel=0.002)
    g.tip(0.68, 0.06, 0.012)
    g.node("offhand", (-0.05, 0.07, -0.03))
    g.node("eject", (0.035, 0.05, 0.08), dir=(0.8, -0.25, 0.55))
    g.node("mag", (0, 0.08, -0.06), dir=(0, 0, -1))
    g.rails(top=(0.05, 0.085, 0.14), bottom=(0.16, 0.005, 0.08), occupied="scope")


ARSENAL = [
    # id, builder, name (docs/03 §5), archetype, family (docs/04 §4.2), aim-pose set, hands
    ("hawk50", hawk50, "Hawk .50", "heavy pistol", "pistol", "pistol", 1),
    ("hammer44", hammer44, "Hammer .44", "magnum revolver", "pistol", "pistol", 1),
    ("buzz", buzz, "Buzz", "compact SMG", "pistol", "pistol", 1),  # one-handed, dual-wieldable
    ("k47", k47, "K-47", "assault rifle", "rifle", "rifle", 2),
    ("breacher", breacher, "Breacher", "pump shotgun", "shotgun", "rifle", 2),
    ("widow", widow, "Widow", "bolt sniper", "sniper", "rifle", 2),
    ("thumper", thumper, "Thumper", "rocket launcher", "launcher", "rifle", 2),
    ("shredder", shredder, "Shredder", "minigun", "heavy", "rifle", 2),
    ("rattler", rattler, "Rattler", "machine pistol", "pistol", "pistol", 1),
    ("hornet", hornet, "Hornet", "high-rate SMG", "rifle", "rifle", 2),
    ("trident", trident, "Trident", "burst rifle", "rifle", "rifle", 2),
    ("bullpup", bullpup, "Bullpup", "bullpup rifle", "rifle", "rifle", 2),
    ("longbow", longbow, "Longbow", "marksman rifle", "sniper", "rifle", 2),
    ("machete", machete, "Machete", "melee", "melee", "pistol", 1),
    ("frag", frag, "Frag grenade", "grenade", "thrown", "pistol", 1),
    ("mine", mine, "Proximity mine", "mine", "thrown", "pistol", 1),
]


def export(path, obj, runtime):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for c in obj.children:
        c.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
        export_extras=True, export_vertex_color="ACTIVE", export_attributes=True, export_materials="EXPORT",
        export_normals=True, export_texcoords=False, export_animations=False,
        export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )


manifest, sockets = {}, {}
for wid, build, name, archetype, family, aim_pose, hands in ARSENAL:
    mat = reset()
    g = Gun(wid)
    build(g)
    obj = paint_and_join(g, mat)
    obj["weaponId"] = wid
    obj["name"] = name
    obj["archetype"] = archetype
    obj["family"] = family
    obj["aimPose"] = aim_pose
    obj["hands"] = hands
    me = obj.data
    me.calc_loop_triangles()
    pts = [v.co for v in me.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    # glTF frame: (x, y, z)_gltf = (x, z, -y)_blender
    to_gltf = lambda v: [round(v.x, 3) + 0.0, round(v.z, 3) + 0.0, round(-v.y, 3) + 0.0]  # noqa: E731 (+0.0: no -0.0)
    nodes = {c.name.split(".")[0]: to_gltf(c.location) for c in obj.children}
    sockets[wid] = {"family": family, "aimPose": aim_pose, "hands": hands, "lengthM": round(hi.z - lo.z, 3),
                    "sockets": {c.name.split(".")[0]: {"pos": to_gltf(c.location),
                                                       **{k: (list(c[k]) if k == "dir" else c[k]) for k in c.keys()}}
                                for c in sorted(obj.children, key=lambda c: c.name)}}
    manifest[wid] = {"name": name, "archetype": archetype, "family": family, "aimPose": aim_pose, "hands": hands,
                     "tris": len(me.loop_triangles), "nodes": nodes,
                     "lengthM": round(hi.z - lo.z, 3), "file": f"{wid}.glb"}
    export(OUT / f"{wid}.glb", obj, runtime=False)
    if RUNTIME:
        export(RUNTIME / "weapons" / f"{wid}.glb", obj, runtime=True)
    print(f"[build_weapons] {wid:9s} {len(me.loop_triangles):4d} tris  length {hi.z - lo.z:.2f} m  nodes {sorted(nodes)}")

SOCKETS_DOC = {
    "frame": "weapon frame = glTF: origin at the main grip, +Y muzzle, +Z up, +X right; attach to socket_weapon_R "
             "with an identity transform (docs/04 §9.4)",
    "fields": "pos [x, y, z] m; dir unit vector; muzzle.boreRadius m; rail_*.lengthM m; rail_top.occupied = a built-in "
              "sight; frag/mine `ground` = rest frame in the world (world = floorPoint × inverse(ground.local))",
    "weapons": sockets,
}
(OUT / "weapons.json").write_text(json.dumps(manifest, indent=2))
(OUT / "sockets.json").write_text(json.dumps(SOCKETS_DOC, indent=1))
if RUNTIME:
    (RUNTIME / "weapons" / "weapons.json").write_text(json.dumps({
        "frame": "origin at the main grip; +Y muzzle, +Z up (docs/04 §9.4): attach to socket_weapon_R with an identity transform",
        "ground": "frag/mine `ground` node = the rest frame in the world (local +Y up, origin on the floor): world = floorPoint × inverse(ground.local)",
        "requires": ["EXT_meshopt_compression (GLTFLoader.setMeshoptDecoder)"],
        "weapons": manifest,
    }, indent=2))
    (RUNTIME / "weapons" / "sockets.json").write_text(json.dumps(SOCKETS_DOC, indent=1))
print("[build_weapons] done")
