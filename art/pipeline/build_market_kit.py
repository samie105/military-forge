"""Street Market map kit (docs/01 §7: dense rooftops, minibuses, stalls, breakable awnings).

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_market_kit.py -- \
        <out.glb> [--runtime <out.glb>]

Every piece is one node (one shared vertex-colour material, so the kit instances cleanly) whose
glTF extras carry its gameplay collision in piece-local metres (x right, y up):

  kitPiece   piece id
  layer      gameplay | mid | far      (docs/11 §2 depth layers; only gameplay pieces collide)
  terrain    [[x0, x1, height], ...]   rectangles standing on the ground; the map compiler merges
                                       them with the ground into ONE terrain skyline polygon
  solids     [[x0, y0, x1, y1, ...]]   free-standing solid polygons, CCW (bus body, stall counter)
  oneWays    [[ax, ay, bx, by], ...]   one-way platforms (awnings, balconies, catwalks), may slope
  material   sim material id (packages/content Material: 0 concrete, 1 metal, 2 wood, 3 dirt)
  noFlip     true on pieces with lettering: the layout must not mirror them
  adSlot     on Screen / Hoarding bezels (docs/14 §2.1, §4.2): kind, format, size [w, h] m,
             frames, centre [x, y, z] of the creative surface (glTF, piece-local; it faces +z)

art/pipeline/compile_map.py turns a layout (pieces + flips + spawns + decor) into a packages/content
MapDef plus the map's AdSlot list, so what the renderer draws and what the sim collides with come
from the same data (render = collision, docs/11 §2). Pivots follow docs/04 §9.6: ground on its
walkable top, everything else on its bottom centre. Gameplay pieces are 2 m deep (Blender y −1…+1,
the camera on −y); anything drawn within 0.35 m of the gameplay plane (the capsule radius) is
inside the collision, so nothing visible stands where the sim lets players walk.

Original designs: invented, region-neutral signage, no real brands.
"""
import math
import random
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None
random.seed(23)

# Palette (sRGB): gameplay plane mid saturation and ≥ 25 ΔE from both team colours (asset-check);
# awnings and umbrellas are platform cues, so they pop. Mid/far layers are paler.
DIRT = (0.62, 0.38, 0.26)
KERB = (0.62, 0.60, 0.56)
PEACH = (0.86, 0.66, 0.52)
MINT = (0.58, 0.74, 0.64)
SKY = (0.60, 0.70, 0.80)
CREAM = (0.88, 0.84, 0.74)
PLINTH = (0.42, 0.40, 0.38)
WINDOW = (0.16, 0.20, 0.24)
SHUTTER = (0.22, 0.52, 0.55)
WOOD = (0.58, 0.40, 0.24)
WOOD_D = (0.40, 0.27, 0.16)
RUST = (0.56, 0.36, 0.26)
ZINC = (0.62, 0.64, 0.66)
AWNING = (0.24, 0.46, 0.58)
BUS = (0.88, 0.86, 0.80)
BUS_STRIPE = (0.30, 0.52, 0.38)
BLACK = (0.10, 0.10, 0.11)
STEEL = (0.38, 0.40, 0.44)
TOMATO = (0.84, 0.20, 0.14)
PEPPER = (0.20, 0.55, 0.22)
YAM = (0.70, 0.56, 0.36)
UMB = [(0.86, 0.18, 0.16), (0.96, 0.78, 0.18), (0.18, 0.56, 0.30), (0.92, 0.90, 0.84)]
BOARD = (0.80, 0.85, 0.70)
INK = (0.14, 0.30, 0.20)
CONCRETE = (0.60, 0.60, 0.62)
MID_A = (0.74, 0.68, 0.58)
MID_B = (0.64, 0.66, 0.68)
MID_C = (0.70, 0.62, 0.56)
BEZEL = (0.16, 0.17, 0.19)
HOUSE_ART = (0.34, 0.37, 0.40)  # placeholder where the creative (or house art) is drawn


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


bpy.ops.wm.read_homefile(use_empty=True)
MAT = bpy.data.materials.new("kit_street_market")
MAT.use_backface_culling = True  # closed meshes: exported doubleSided false
_bsdf = next(n for n in MAT.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
_bsdf.inputs["Roughness"].default_value = 0.9
_vc = MAT.node_tree.nodes.new("ShaderNodeVertexColor")
_vc.layer_name = "Col"
MAT.node_tree.links.new(_vc.outputs["Color"], _bsdf.inputs["Base Color"])


class Piece:
    def __init__(self, pid, layer="gameplay", material=0):
        self.pid, self.layer, self.material = pid, layer, material
        self.parts = []
        self.terrain, self.solids, self.one_ways = [], [], []
        self.extras = {}

    def _add(self, o, color, bevel):
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel:
            m = o.modifiers.new("bevel", "BEVEL")
            m.width = bevel
            m.segments = 1
            m.limit_method = "ANGLE"
            bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
        self.parts.append((o, color))
        return o

    def box(self, lo, hi, color, bevel=0.03, rot=(0, 0, 0)):
        lo, hi = Vector(lo), Vector(hi)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(lo + hi) / 2, rotation=[math.radians(a) for a in rot])
        o = bpy.context.active_object
        o.scale = hi - lo
        return self._add(o, color, bevel)

    def prism(self, pts_xz, y0, y1, color):
        """A convex polygon in the x/z (side-view) plane, extruded from depth y0 to y1."""
        n = len(pts_xz)
        verts = [(x, y0, z) for x, z in pts_xz] + [(x, y1, z) for x, z in pts_xz]
        faces = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
        faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        me = bpy.data.meshes.new("prism")
        me.from_pydata(verts, [], faces)
        me.validate()
        me.update()
        o = bpy.data.objects.new("prism", me)
        bpy.context.scene.collection.objects.link(o)
        for q in bpy.context.scene.objects:
            q.select_set(q == o)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        return self._add(o, color, 0)

    def cyl(self, c, r, depth, color, axis="Z", verts=12, r2=None, bevel=0.02):
        rot = {"X": (0, math.pi / 2, 0), "Y": (math.pi / 2, 0, 0), "Z": (0, 0, 0)}[axis]
        if r2 is None:
            bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=c, rotation=rot)
        else:
            bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=c, rotation=rot)
        return self._add(bpy.context.active_object, color, bevel)

    def sphere(self, c, r, color, scale=(1, 1, 1), segs=8, rings=5):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=r, location=c)
        o = bpy.context.active_object
        o.scale = scale
        return self._add(o, color, 0)

    def text(self, body, c, size, color, depth=0.0):
        """Flat lettering facing the camera; low curve resolution keeps signs cheap. The piece can
        no longer be mirrored by the layout."""
        bpy.ops.object.text_add(location=c, rotation=(math.radians(90), 0, 0))
        o = bpy.context.active_object
        o.data.body = body
        o.data.size = size
        o.data.extrude = depth
        o.data.resolution_u = 2
        o.data.align_x = "CENTER"
        bpy.ops.object.convert(target="MESH")
        self.extras["noFlip"] = True
        return self._add(bpy.context.active_object, color, 0)


def paint_join(p):
    zs = [(o.matrix_world @ v.co).z for o, _ in p.parts for v in o.data.vertices]
    zmin, zmax = min(zs), max(zs)
    for o, color in p.parts:
        me = o.data
        col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for poly in me.polygons:
            jit = 1 + random.uniform(-0.03, 0.03)
            up = 1.06 if poly.normal.z > 0.7 else (0.86 if poly.normal.z < -0.7 else 1.0)
            for li in poly.loop_indices:
                z = me.vertices[me.loops[li].vertex_index].co.z
                # baked AO: darker toward the bottom of the piece (docs/11 §2)
                t = (z - zmin) / max(1e-6, zmax - zmin)
                ao = 0.74 + 0.26 * min(1.0, t) ** 0.6
                c = [srgb_to_linear(min(1.0, ch * ao * jit * up)) for ch in color]
                col.data[li].color = (*c, 1.0)
        me.materials.clear()
        me.materials.append(MAT)
    for o in bpy.context.scene.objects:
        o.select_set(any(o == q for q, _ in p.parts))
    bpy.context.view_layer.objects.active = p.parts[0][0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = p.pid
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    obj["kitPiece"] = p.pid
    obj["biome"] = "street_market"
    obj["layer"] = p.layer
    obj["material"] = p.material
    obj["terrain"] = [list(t) for t in p.terrain]
    obj["solids"] = [list(s) for s in p.solids]
    obj["oneWays"] = [list(w) for w in p.one_ways]
    for k, v in p.extras.items():
        obj[k] = v
    return obj


# ------------------------------------------------------------------ gameplay pieces

def ground_4m():
    p = Piece("sm_ground_4m", material=3)
    p.box((-2, -1, -1.5), (2, 1, -0.08), DIRT, 0.04)
    p.box((-2, -1.05, -0.1), (2, -0.8, 0), KERB, 0.02)
    p.box((-2, -0.8, -0.06), (2, 1.0, 0), DIRT, 0.0)
    p.box((-1.2, -1.07, -0.55), (-0.2, -1.0, -0.3), PLINTH, 0.01)  # drain grille
    for x in (-1.6, 0.6, 1.5):
        s = random.uniform(0.12, 0.2)
        p.sphere((x, -1.02, random.uniform(-1.1, -0.7)), s, PLINTH, scale=(1.2, 0.5, 0.8))
    p.terrain = [(-2, 2, 0)]
    return p


def _windows(p, x0, x1, z0, z1, wall_y, rows):
    w = 0.9
    n = max(1, int((x1 - x0) // 2))
    for r in range(rows):
        zc = z0 + (r + 0.55) * (z1 - z0) / rows
        for i in range(n):
            xc = x0 + (i + 0.5) * (x1 - x0) / n
            p.box((xc - w / 2, wall_y - 0.06, zc - 0.55), (xc + w / 2, wall_y + 0.02, zc + 0.55), WINDOW, 0.01)
            for side in (-1, 1):  # louvre shutters
                p.box((xc + side * (w / 2 + 0.22) - 0.2, wall_y - 0.08, zc - 0.55),
                      (xc + side * (w / 2 + 0.22) + 0.2, wall_y - 0.02, zc + 0.55), SHUTTER, 0.01)
            p.box((xc - w / 2 - 0.08, wall_y - 0.12, zc - 0.62), (xc + w / 2 + 0.08, wall_y - 0.02, zc - 0.55), CREAM, 0.0)


def building(pid, height, color, balconies):
    """Concrete house, 6 m wide; walkable flat roof; cantilevered side balconies (one-ways)."""
    p = Piece(pid, material=0)
    p.box((-3, -1, 0), (3, 1, height), color, 0.05)
    p.box((-3.05, -1.05, 0), (3.05, 1.05, 0.5), PLINTH, 0.03)
    p.box((-3.08, -1.08, height - 0.25), (3.08, 1.08, height), CREAM, 0.03)  # roof slab edge
    # parapet lips at the back only: nothing stands on the walking line without collision
    p.box((-3.08, 0.4, height), (-2.9, 1.08, height + 0.15), CREAM, 0.02)
    p.box((2.9, 0.4, height), (3.08, 1.08, height + 0.15), CREAM, 0.02)
    floors = round(height / 4)
    _windows(p, -2.6, 2.6, 0.6, height - 0.4, -1.0, floors)
    p.box((-0.6, -1.08, 0.0), (0.6, -0.98, 2.2), WOOD_D, 0.02)  # door
    p.box((1.6, -1.25, height - 1.6), (2.5, -0.95, height - 1.0), CREAM, 0.03)  # AC unit
    for (side, z) in balconies:
        x0, x1 = (3.0, 5.0) if side > 0 else (-5.0, -3.0)
        p.box((x0, -0.9, z - 0.15), (x1, 0.9, z), CREAM, 0.03)
        # a front handrail on posts (camera side), no end plate across the walkway: two balconies
        # can join into one ledge, and the open end is a drop the player can see
        for px in (x0 + 0.05, (x0 + x1) / 2, x1 - 0.05):
            p.box((px - 0.03, -0.93, z), (px + 0.03, -0.87, z + 0.88), STEEL, 0.0)
        p.box((x0, -0.92, z + 0.85), (x1, -0.88, z + 0.9), STEEL, 0.0)
        p.one_ways.append((x0, z, x1, z))
    p.terrain = [(-3, 3, height)]
    return p


def stall_4m():
    """Market stall: a solid wooden counter (cover) under a corrugated awning (one-way); the
    produce sits on a back shelf, off the walking line."""
    p = Piece("sm_stall_4m", material=2)
    p.box((-1.5, -0.6, 0), (1.5, 0.6, 1.0), WOOD, 0.04)
    p.box((-1.6, -0.7, 0.95), (1.6, 0.7, 1.05), WOOD_D, 0.02)
    p.box((-1.5, 0.6, 0.0), (1.5, 0.8, 1.12), WOOD_D, 0.02)  # back shelf
    for i, c in enumerate((TOMATO, PEPPER, YAM, TOMATO)):
        x = -1.1 + i * 0.73
        p.cyl((x, 0.68, 1.17), 0.1, 0.1, WOOD_D, verts=10, r2=0.12)
        for k in range(3):
            p.sphere((x + random.uniform(-0.06, 0.06), 0.68 + random.uniform(-0.03, 0.03), 1.25), 0.06, c)
    for x in (-1.9, 1.9):
        for y in (-0.8, 0.8):
            p.box((x - 0.05, y - 0.05, 0), (x + 0.05, y + 0.05, 3.0), WOOD_D, 0.0)
    # corrugated awning: alternating zinc / rust strips, slightly sloped
    for i in range(10):
        x0 = -2.0 + i * 0.4
        p.box((x0, -1.0, 2.95), (x0 + 0.4, 1.0, 3.08 if i % 2 else 3.02), RUST if i % 3 else ZINC, 0.0)
    p.box((-2.05, -1.02, 2.9), (2.05, -0.95, 3.1), AWNING, 0.0)
    p.solids = [(-1.5, 0, 1.5, 0, 1.5, 1.0, -1.5, 1.0)]
    p.one_ways = [(-2.0, 3.05, 2.0, 3.05)]
    return p


def umbrella_stall():
    """Counter under a striped umbrella; the canopy is walkable along its slope (two one-ways
    from the rim up to the pole) and is squashed to the 2 m slab in depth."""
    p = Piece("sm_umbrella_stall", material=2)
    p.box((-0.8, -0.4, 0), (0.8, 0.6, 0.8), WOOD, 0.03)
    p.cyl((0, 0, 1.3), 0.04, 2.6, STEEL, verts=8, bevel=0)
    segs, rx, ry = 12, 1.7, 1.0
    for i in range(segs):  # striped canopy: one solidified wedge per colour panel
        a0, a1 = 2 * math.pi * i / segs, 2 * math.pi * (i + 1) / segs
        me = bpy.data.meshes.new("wedge")
        me.from_pydata([(0, 0, 3.05), (rx * math.cos(a0), ry * math.sin(a0), 2.6),
                        (rx * math.cos(a1), ry * math.sin(a1), 2.6)], [], [(0, 1, 2)])
        o = bpy.data.objects.new("wedge", me)
        bpy.context.scene.collection.objects.link(o)
        for q in bpy.context.scene.objects:
            q.select_set(q == o)
        bpy.context.view_layer.objects.active = o
        sol = o.modifiers.new("solid", "SOLIDIFY")
        sol.thickness = 0.03
        bpy.ops.object.modifier_apply(modifier=sol.name)
        p._add(o, UMB[i % 4], 0)
    for k in range(3):
        p.sphere((-0.4 + k * 0.4, 0.48, 0.9), 0.1, (TOMATO, PEPPER, YAM)[k])
    p.solids = [(-0.8, 0, 0.8, 0, 0.8, 0.8, -0.8, 0.8)]
    # the canopy's top along the gameplay plane is 3.05 − 0.45 |x| / 1.7 (a 15° slope): 2.63 at
    # |x| 1.6, put on the 0.05 m collision grid
    p.one_ways = [(-1.6, 2.65, 0.0, 3.05), (0.0, 3.05, 1.6, 2.65)]
    return p


def minibus():
    """Two-tone minibus: solid cover with a walkable roof rack; the luggage rides at the back."""
    p = Piece("sm_minibus", material=1)
    p.box((-2.6, -0.95, 0.35), (2.2, 0.95, 2.3), BUS, 0.08)
    p.box((2.2, -0.95, 0.35), (2.6, 0.95, 1.6), BUS, 0.06)
    p.prism([(2.2, 1.6), (2.6, 1.6), (2.2, 2.3)], -0.95, 0.95, BUS)  # sloped front = the collision
    d = Vector((0.4, -0.7)).normalized()
    n = Vector((0.7, 0.4)).normalized()
    a, b = Vector((2.2, 2.3)) + d * 0.1, Vector((2.2, 2.3)) + d * 0.7
    p.prism([tuple(a), tuple(b), tuple(b + n * 0.02), tuple(a + n * 0.02)], -0.85, 0.85, WINDOW)  # windscreen
    for z0 in (0.75, 1.15):
        p.box((-2.62, -0.97, z0), (2.62, 0.97, z0 + 0.1), BUS_STRIPE, 0.0)
    for x in (-1.9, -0.9, 0.1, 1.1):
        p.box((x, -0.97, 1.45), (x + 0.8, -0.9, 2.05), WINDOW, 0.02)
    for x in (-1.7, 1.7):
        for y in (-0.85, 0.85):
            p.cyl((x, y, 0.33), 0.33, 0.24, BLACK, axis="Y", verts=12)  # wheels touch y = 0
    p.box((-2.3, -0.8, 2.3), (1.9, 0.8, 2.36), STEEL, 0.0)  # roof rack
    for x, c in ((-1.6, (0.30, 0.42, 0.66)), (-0.6, (0.62, 0.30, 0.22)), (0.6, (0.40, 0.52, 0.30))):
        p.box((x - 0.4, 0.38, 2.36), (x + 0.4, 0.78, 2.8), c, 0.06)  # luggage, behind the plane
    p.solids = [(-2.6, 0.35, 2.6, 0.35, 2.6, 1.6, 2.2, 2.3, -2.6, 2.3)]
    return p


def tank_tower():
    """Water tank on a steel stand: the deck's two ledges either side of the tank are one-ways
    at 4 m (none under the tank), the tank itself is solid."""
    p = Piece("sm_tank_tower", material=1)
    for x in (-1.4, 1.4):
        for y in (-0.8, 0.8):
            p.box((x - 0.06, y - 0.06, 0), (x + 0.06, y + 0.06, 4.0), STEEL, 0.0)
    for z in (1.3, 2.7):
        p.box((-1.45, -0.85, z), (1.45, -0.79, z + 0.06), STEEL, 0.0)
    p.box((-1.6, -0.95, 3.9), (1.6, 0.95, 4.02), STEEL, 0.02)
    p.cyl((0, 0, 4.72), 0.8, 1.4, BLACK, verts=16, bevel=0.05)
    p.cyl((0, 0, 5.42), 0.25, 0.06, BLACK, verts=12)
    p.one_ways = [(-1.6, 4.0, -0.8, 4.0), (0.8, 4.0, 1.6, 4.0)]
    p.solids = [(-0.8, 4.0, 0.8, 4.0, 0.8, 5.4, -0.8, 5.4)]
    return p


def crates():
    p = Piece("sm_crates", material=2)
    p.box((-1.0, -0.6, 0), (0.0, 0.6, 1.0), WOOD, 0.04)
    p.box((0.0, -0.6, 0), (1.0, 0.6, 1.0), WOOD_D, 0.04)
    p.box((-1.0, -0.55, 1.0), (0.0, 0.55, 1.6), WOOD, 0.04)
    for x in (0.3, 0.72):
        p.sphere((x, 0.5, 1.16), 0.2, (0.80, 0.74, 0.58), scale=(1.0, 0.7, 0.8))  # sacks, at the back
    p.solids = [(-1.0, 0, 1.0, 0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.6, -1.0, 1.6)]
    return p


def billboard():
    """House-only billboard (docs/14 §2.1: never sold) on two masts, with a one-way catwalk at
    10 m. The panel is solid (render = collision): it breaks the 12 m roofline sightline in the
    middle of the map, and leaves 2 m of headroom over the catwalk."""
    p = Piece("sm_billboard", material=1)
    for x in (-3.2, 3.2):
        p.cyl((x, 0.6, 8.6), 0.14, 17.2, STEEL, verts=10, bevel=0)  # masts behind the plane
    p.box((-4.0, -0.5, 9.85), (4.0, 0.5, 10.0), STEEL, 0.02)
    p.box((-4.0, -0.52, 10.0), (4.0, -0.48, 10.8), STEEL, 0.0)
    p.box((-4.0, 0.25, 12.0), (4.0, 0.45, 15.2), CREAM, 0.03)
    p.box((-3.8, 0.2, 12.2), (3.8, 0.25, 15.0), BOARD, 0.0)
    # a steep gable (51°) on top: too steep to stand on, so the panel can't become a perch that
    # sees across the whole map
    p.prism([(-4.0, 15.2), (4.0, 15.2), (0.0, 20.2)], 0.25, 0.45, CREAM)
    p.prism([(-3.3, 15.4), (3.3, 15.4), (0.0, 19.5)], 0.2, 0.25, AWNING)
    p.text("FRESH MARKET", (0, 0.17, 13.9), 0.9, INK)
    p.text("FRUIT   BREAD   TOOLS", (0, 0.17, 12.8), 0.42, (0.30, 0.20, 0.12))
    p.one_ways = [(-4.0, 10.0, 4.0, 10.0)]
    p.solids = [(-4.0, 12.0, 4.0, 12.0, 4.0, 15.2, 0.0, 20.2, -4.0, 15.2)]
    return p


def edge_block():
    """Map edge: a tall block whose side wall is the boundary up to the ceiling (54 m). The map
    compiler fails if the play space is open at either end."""
    p = Piece("sm_edge_block", material=0)
    p.box((-2, -1, 0), (2, 1, 54), CONCRETE, 0.05)
    p.box((-2.05, -1.05, 0), (2.05, 1.05, 0.6), PLINTH, 0.03)
    for i in range(14):
        z = 1.4 + i * 3.8
        p.box((-1.2, -1.06, z), (1.2, -0.98, z + 1.6), WINDOW, 0.01)
        p.box((-2.02, -1.04, z + 2.4), (2.02, -0.98, z + 2.55), CREAM, 0.0)
    p.terrain = [(-2, 2, 54)]
    return p


def signboard():
    p = Piece("sm_signboard", layer="mid", material=1)
    for x in (-1.0, 1.0):
        p.box((x - 0.05, -0.05, 0), (x + 0.05, 0.05, 3.2), STEEL, 0.0)
    p.box((-1.4, -0.08, 2.2), (1.4, 0.0, 3.4), (0.20, 0.42, 0.70), 0.02)
    p.text("PHONE REPAIR", (0, -0.1, 2.65), 0.3, (0.98, 0.95, 0.88))
    return p


def power_pole():
    p = Piece("sm_power_pole", layer="mid", material=2)
    p.cyl((0, 0, 4.5), 0.12, 9.0, WOOD_D, verts=8, bevel=0)
    p.box((-1.2, -0.06, 8.2), (1.2, 0.06, 8.32), WOOD_D, 0.0)
    p.cyl((0.3, -0.25, 7.2), 0.25, 0.7, STEEL, verts=10)
    return p


def far_facade(pid, color, height):
    """Background block for the far layer (no collision, low saturation, fog does the rest)."""
    p = Piece(pid, layer="far")
    p.box((-6, -1, 0), (6, 1, height), color, 0.0)
    for r in range(int(height // 3)):
        for i in range(4):
            x = -4.5 + i * 3
            p.box((x - 0.6, -1.05, 1 + r * 3), (x + 0.6, -0.98, 2.2 + r * 3), [c * 0.55 for c in color], 0.0)
    p.box((-6.1, -1.05, height), (6.1, 1.05, height + 0.3), [c * 0.85 for c in color], 0.0)
    return p


# ------------------------------------------------------------------ ad surfaces (docs/14), mid layer
# A bezel's creative surface is at local y = 0 (it faces the camera) and its cabinet reaches back
# to y = 0.6; the structures behind start at y = 0.6, so a bezel and its structure share the
# layout x/z. None of these collide (docs/14 §2.6 lint 1).

def ad_bezel(pid, w, h, b, kind, fmt, frames):
    p = Piece(pid, layer="mid", material=1)
    p.box((-w / 2 - b, 0.05, 0), (w / 2 + b, 0.6, h + 2 * b), BEZEL, 0.03)  # cabinet
    for lo, hi in (((-w / 2 - b, -0.1, 0), (w / 2 + b, 0.05, b)),
                   ((-w / 2 - b, -0.1, h + b), (w / 2 + b, 0.05, h + 2 * b)),
                   ((-w / 2 - b, -0.1, b), (-w / 2, 0.05, h + b)),
                   ((w / 2, -0.1, b), (w / 2 + b, 0.05, h + b))):
        p.box(lo, hi, BEZEL, 0.01)
    p.box((-w / 2, 0.0, b), (w / 2, 0.05, h + b), HOUSE_ART, 0.0)
    p.extras["adSlot"] = {"kind": kind, "format": fmt, "size": [w, h], "frames": frames,
                          "centre": [0.0, round(b + h / 2, 3), 0.0]}
    return p


def _facade(p, x0, x1, h, color, rows, skip=None, depth=4.0):
    p.box((x0, 0.6, 0), (x1, 0.6 + depth, h), color, 0.05)
    p.box((x0 - 0.1, 0.55, h - 0.3), (x1 + 0.1, 0.65 + depth, h), [c * 0.9 for c in color], 0.02)
    n = max(1, int((x1 - x0) // 2.5))
    for r in range(rows):
        z = 1.0 + r * (h - 1.5) / rows
        for i in range(n):
            x = x0 + (i + 0.5) * (x1 - x0) / n
            if skip and skip[0] <= x <= skip[1] and skip[2] <= z <= skip[3]:
                continue
            p.box((x - 0.6, 0.52, z), (x + 0.6, 0.6, z + 1.4), [c * 0.55 for c in color], 0.0)


# Heights fit the Street Market layout (art/maps/street_market/layout.json): each structure carries
# its bezel at the height compile_map's view lints were solved for, and they don't intersect each
# other in depth (the junction block is 2 m deep, in front of the flyover).

def junction_block():
    """Junction building, 6 storeys and a roof plant room; the Screen sits high on its face (S1)."""
    p = Piece("sm_junction_block", layer="mid")
    _facade(p, -6, 6, 23, MID_A, 6, skip=(-4.6, 4.6, 13.4, 21.0), depth=2.0)
    p.box((-3.0, 1.0, 23), (2.0, 2.4, 24.6), [c * 0.92 for c in MID_A], 0.04)
    return p


def screen_tower():
    """Slim tower with the Screen near its top (S2)."""
    p = Piece("sm_screen_tower", layer="mid")
    _facade(p, -2.8, 2.8, 25, MID_B, 7, skip=(-4.6, 4.6, 11.7, 19.3), depth=3.0)
    p.box((-0.1, 1.5, 25), (0.1, 1.7, 28), STEEL, 0.0)  # mast
    return p


def screen_mast():
    """Two steel posts carrying a Screen above the minibus park (S3)."""
    p = Piece("sm_screen_mast", layer="mid", material=1)
    for x in (-3.2, 3.2):
        p.box((x - 0.15, 0.6, 0), (x + 0.15, 0.9, 13.3), STEEL, 0.02)
        p.box((x - 0.4, 0.4, 0), (x + 0.4, 1.1, 0.4), PLINTH, 0.03)
    p.box((-3.4, 0.62, 6.1), (3.4, 0.88, 6.4), STEEL, 0.0)
    for z in (2.0, 4.0):
        p.box((-3.2, 0.66, z), (3.2, 0.84, z + 0.12), STEEL, 0.0)
    return p


def flyover():
    """An elevated road across the upper background, a Hoarding on its parapet (H1)."""
    p = Piece("sm_flyover", layer="mid")
    p.box((-24, 0.6, 21.7), (24, 6.6, 22.7), MID_B, 0.04)
    p.box((-24, 0.6, 22.7), (24, 0.95, 23.3), MID_B, 0.02)  # parapet
    for x in (-14, 14):
        p.box((x - 1.0, 1.6, 0), (x + 1.0, 5.6, 21.7), MID_B, 0.05)
        p.box((x - 1.6, 1.2, 20.9), (x + 1.6, 6.0, 21.7), [c * 0.9 for c in MID_B], 0.03)
    return p


def east_block():
    """Three east buildings: a Hoarding frame spans the first two roofs (H2, centred on the piece) and
    a steel gantry on the second and third carries a Screen 11 m to the right (S4)."""
    p = Piece("sm_east_block", layer="mid")
    _facade(p, -9.5, -3.5, 12, MID_A, 3)
    _facade(p, 3.5, 9.5, 13, MID_C, 3)
    _facade(p, 9.6, 15.4, 14, MID_B, 3)
    for x, base in ((-9.0, 12), (-4.0, 12), (4.0, 13), (9.0, 13)):
        p.box((x - 0.12, 0.62, base), (x + 0.12, 0.86, 17.1), STEEL, 0.0)
    p.box((-9.6, 0.62, 13.1), (9.6, 0.86, 13.4), STEEL, 0.0)
    for x, base in ((7.2, 13), (14.8, 14)):
        p.box((x - 0.12, 0.62, base), (x + 0.12, 0.86, 26.4), STEEL, 0.0)
    p.box((6.8, 0.62, 26.2), (15.2, 0.86, 26.5), STEEL, 0.0)
    p.box((6.8, 0.62, 19.1), (15.2, 0.86, 19.4), STEEL, 0.0)
    return p


BUILDERS = [
    ground_4m, stall_4m, umbrella_stall, minibus, tank_tower, crates, billboard, edge_block,
    signboard, power_pole,
    lambda: building("sm_house_2f", 8.0, PEACH, [(-1, 4.0)]),
    lambda: building("sm_house_3f", 12.0, MINT, [(1, 4.0), (1, 8.0)]),
    lambda: building("sm_house_3f_blue", 12.0, SKY, [(-1, 4.0), (1, 8.0)]),
    lambda: far_facade("sm_far_block_a", (0.66, 0.66, 0.68), 14.0),
    lambda: far_facade("sm_far_block_b", (0.72, 0.68, 0.62), 10.0),
    lambda: ad_bezel("sm_screen_8x6", 8.0, 6.0, 0.3, "screen", "4:3", 6),
    lambda: ad_bezel("sm_hoarding_18x3", 18.0, 3.0, 0.25, "hoarding", "6:1", 1),
    lambda: ad_bezel("sm_hoarding_21x3_5", 21.0, 3.5, 0.25, "hoarding", "6:1", 1),
    junction_block, screen_tower, screen_mast, flyover, east_block,
]
for build in BUILDERS:
    p = build()
    obj = paint_join(p)
    obj.data.calc_loop_triangles()
    print(f"[build_market_kit] {p.pid:20s} {len(obj.data.loop_triangles):5d} tris  layer {p.layer:8s} "
          f"terrain {len(p.terrain)} solids {len(p.solids)} oneWays {len(p.one_ways)}"
          + ("  adSlot" if "adSlot" in p.extras else "") + ("  noFlip" if p.extras.get("noFlip") else ""))


def export(path, runtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_apply=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )
    print(f"[build_market_kit] wrote {path} ({path.stat().st_size / 1024:.0f} KB)")


export(OUT, runtime=False)
if RUNTIME:
    export(RUNTIME, runtime=True)
