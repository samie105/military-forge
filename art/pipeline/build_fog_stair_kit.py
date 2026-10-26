"""Fog Stair's kit (NOTES §50; the owner, 26 Oct: "it should look bespoke … Chinese surroundings, the
billboards and all"): a stacked hillside river city in south-west China, built to fit the map's
collision exactly, like the Street Market's kit.

    blender -b --factory-startup --python-exit-code 1 --python art/pipeline/build_fog_stair_kit.py -- \
        <out.glb> [--runtime <out.glb>]

Fog Stair's collision is written in packages/content/src/maps/fogStair.ts (it came first). So here
each gameplay piece carries, in glTF extras, exactly the collision it stands for, in piece-local
metres (x right, y up), and art/maps/fog_stair/layout.json places them: compile_map.py's kit check
(`collision` in the layout) and apps/web's fogStair.test.ts check that the placed pieces add up to
the registered map, solid by solid, one-way by one-way, post by post. The extras are the Street
Market's (build_market_kit.py), with one addition: terrain here is sloped, so the hill, the stairs,
the terrace and the quay carry their ground as `solids` (columns down to the floor), and the
layout's pieces cover the map's single terrain polygon between them.

The place (original: no real skyline, no real businesses), and where each thing stands:

* Riverside: stone quays with bollards at the back edge, moored sampans and barges behind the play
  plane, an arcade under each tower (legs: bullet-only), a hotpot restaurant with steam, shutters
  and a corner shop at the arcade's back wall.
* The Stairs: long public stone stairs (45°: steps straddle the slope) with a stone balustrade and a
  handrail on the back edge (nothing stands across the walking line), red lanterns strung over
  them behind the plane, stilted wooden houses (diaojiaolou) stepping down the hill's face; the
  terrace with an old shop-house: a grey-tiled pitched roof whose ridge is the walkable top, the
  eaves turned up at the corners.
* Monorail: the straddle-beam viaduct (the walkable top is the beam's deck, its body and the
  pillars' hammerheads behind the plane, the pillars on the plane bullet-only), the station inside
  each tower, the arch bridge over the gorge (arch behind the plane) and the parked car.
* Rooftops: concrete towers with balcony bands, steel window grilles, air-con units, laundry poles
  and potted plants; bamboo scaffolding on one face; a sectional water tank and a lattice mast on
  each roof; the steel footbridge (its truss on the back edge); the hill pavilion: red-lacquered
  columns and a flat-topped (盝顶) tiled roof whose top is the deck, corners turned up.
* Signs (hanzi_strokes.py: every string with its meaning): vertical neon blades and an LED panel
  on the towers (layer `glow`: unlit, they shine through the fog), painted boards on the shops.

Layers: `gameplay` (collides; graded mid-saturation), `mid` (behind the play plane, no collision,
hazed toward the fog so it reads as background), `glow` (unlit neon and LED). Palette discipline:
gameplay colours stay ≥ 25 ΔE from both team colours (asset-check); the lacquer and the lanterns
are dark oxblood and crimson, never the bright damage red, and the lanterns hang behind the plane.

Every piece is one node with one vertex-colour material (merged per layer at runtime: one draw
call each). Low-poly boxes, no bevels: the whole kit is budgeted against the Street Market's.
"""
import math
import random
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402,F401  (a crash exits 1, not 0)
from hanzi_strokes import strokes  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = Path(argv[0])
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else None

# ------------------------------------------------------------------ palette (sRGB)
CONCRETE = (0.60, 0.60, 0.57)
CONCRETE_B = (0.54, 0.55, 0.53)
CONCRETE_D = (0.43, 0.44, 0.43)
PLASTER = (0.72, 0.70, 0.64)
PLASTER_G = (0.62, 0.66, 0.60)  # green-grey paint
TILE_WALL = (0.70, 0.68, 0.62)  # the towers' cream ceramic tile
STONE = (0.55, 0.52, 0.46)  # grey-brown sandstone (the stairs, the quays)
STONE_L = (0.62, 0.59, 0.52)
STONE_D = (0.40, 0.38, 0.35)
MOSS = (0.38, 0.44, 0.32)
WOOD = (0.44, 0.31, 0.21)
WOOD_D = (0.30, 0.21, 0.14)
WOOD_L = (0.56, 0.42, 0.28)
ROOF_TILE = (0.32, 0.33, 0.34)  # grey tile
ROOF_TILE_D = (0.22, 0.23, 0.24)
LACQUER = (0.44, 0.15, 0.12)  # weathered oxblood lacquer: darker than any damage red
GOLD = (0.70, 0.58, 0.34)
WINDOW = (0.16, 0.19, 0.21)
WINDOW_WARM = (0.80, 0.70, 0.50)
GRILLE = (0.30, 0.32, 0.33)
STEEL = (0.40, 0.42, 0.44)
STEEL_G = (0.36, 0.42, 0.40)  # green-grey painted steel (the footbridge)
AC = (0.80, 0.79, 0.75)
BAMBOO = (0.66, 0.58, 0.38)
NETTING = (0.40, 0.47, 0.42)  # the scaffold's safety net, muted
PLANT = (0.32, 0.42, 0.28)
PLANT_L = (0.42, 0.52, 0.34)
POT = (0.52, 0.36, 0.28)
CLOTHES = [(0.78, 0.76, 0.70), (0.42, 0.48, 0.58), (0.62, 0.52, 0.44), (0.70, 0.66, 0.50), (0.50, 0.40, 0.48)]
LANTERN = (0.50, 0.12, 0.15)  # crimson, dark and matte
SHUTTER = (0.56, 0.58, 0.58)
SHUTTER_D = (0.44, 0.46, 0.47)
PAVING = (0.50, 0.49, 0.46)
TACTILE = (0.66, 0.62, 0.48)
RIVER = (0.36, 0.40, 0.35)  # silt-green river water
SILT = (0.30, 0.29, 0.25)
CAR = (0.84, 0.83, 0.78)
CAR_BAND = (0.17, 0.19, 0.21)
CAR_STRIPE = (0.46, 0.56, 0.52)  # muted jade, far under signal saturation
BOARD_DARK = (0.18, 0.15, 0.13)
BOARD_WOOD = (0.36, 0.24, 0.16)
STEAM = (0.86, 0.87, 0.86)
STOOL = [(0.82, 0.64, 0.34), (0.48, 0.60, 0.52), (0.78, 0.62, 0.66)]  # plastic stools: yellow, jade, pink (no red, no blue)
HOUSE_ART = (0.30, 0.32, 0.35)
BEZEL = (0.15, 0.16, 0.18)
# neon and LED (layer glow, unlit): pink, warm white and a soft violet; away from every signal hue
NEON_PINK = (1.0, 0.42, 0.78)
NEON_WARM = (1.0, 0.90, 0.74)
NEON_VIOLET = (0.78, 0.72, 1.0)
LED_PANEL = (0.10, 0.11, 0.13)
# around the ad bezels: dimmer than the shop signs, so the frame never pulls the eye off the fight
NEON_FRAME = (0.80, 0.46, 0.72)
NEON_FRAME_WARM = (0.82, 0.74, 0.62)
LAMP = (1.0, 0.93, 0.80)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rect(x0, y0, x1, y1):
    """A CCW rectangle as a flat polygon, on a 1 mm grid (no float noise in the extras)."""
    x0, y0, x1, y1 = (round(v, 3) for v in (x0, y0, x1, y1))
    return [x0, y0, x1, y0, x1, y1, x0, y1]


def flat(pts):
    return [round(v, 3) for p in pts for v in p]


# ------------------------------------------------------------------ geometry (game space: x right, y up, z toward the camera)

class Piece:
    """One kit piece: parts are collected as raw polygons and written as ONE mesh (no bpy.ops), each
    face painted with its part's colour (baked AO toward the part's foot, lighter tops)."""

    def __init__(self, pid, layer="gameplay", material=0, seed=1):
        self.pid, self.layer, self.material = pid, layer, material
        self.verts, self.faces, self.cols = [], [], []
        self.extras = {"terrain": [], "solids": [], "oneWays": []}
        self.rng = random.Random(seed)
        # decor modelled around a waterline or a slope: raised by this much on export so its bottom is
        # the pivot (docs/04 §9.6); the layout places it that much lower
        self.lift = 0.0

    # -- raw
    def _part(self, verts, faces, color, ao=True, shade=True, convex=True):
        """verts in game space; faces as vertex-index tuples. A convex part's faces are turned to face
        away from its centre (so callers needn't mind the winding); a lone quad keeps its own."""
        if convex:
            c = tuple(sum(v[k] for v in verts) / len(verts) for k in range(3))
            faces = [_outward(verts, f, c) for f in faces]
            # the camera looks down −z from within ~25° of the axis: faces turned away from it are never seen
            faces = [f for f in faces if _normal([verts[i] for i in f])[2] > -0.6]
        base = len(self.verts)
        ys = [v[1] for v in verts]
        y0, y1 = min(ys), max(ys)
        tall = y1 - y0 > 0.8
        for f in faces:
            pts = [verts[i] for i in f]
            n = _normal(pts)
            jit = 1 + self.rng.uniform(-0.035, 0.035) if shade else 1.0
            up = (1.06 if n[1] > 0.7 else 0.8 if n[1] < -0.7 else 1.0) if shade else 1.0
            corner = []
            for p in pts:
                k = jit * up
                if ao and tall and shade:
                    t = (p[1] - y0) / (y1 - y0)
                    k *= 0.8 + 0.2 * t ** 0.6
                corner.append(tuple(min(1.0, ch * k) for ch in color))
            self.faces.append(tuple(base + i for i in f))
            self.cols.append(corner)
        self.verts.extend(verts)

    def box(self, x0, y0, z0, x1, y1, z1, color, hide="b", **kw):
        """An axis-aligned box. `hide` leaves faces out that nobody sees (b back −z, f front +z, d down,
        u up, l −x, r +x): by default the back, which the camera never faces."""
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        z0, z1 = sorted((z0, z1))
        v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        named = {"f": (4, 5, 6, 7), "b": (1, 0, 3, 2), "l": (0, 4, 7, 3), "r": (5, 1, 2, 6), "u": (3, 7, 6, 2), "d": (0, 1, 5, 4)}
        self._part(v, [f for k, f in named.items() if k not in hide], color, **kw)

    def prism_z(self, pts_xy, z0, z1, color, **kw):
        """A convex polygon in the x-y plane (CCW), extruded along z from z0 (back) to z1 (front)."""
        n = len(pts_xy)
        v = [(x, y, z1) for x, y in pts_xy] + [(x, y, z0) for x, y in pts_xy]
        f = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
        f += [(n + i, n + (i + 1) % n, (i + 1) % n, i) for i in range(n)]
        self._part(v, f, color, **kw)

    def prism_x(self, pts_zy, x0, x1, color, **kw):
        """A convex polygon in the z-y plane (CCW seen from +x), extruded along x."""
        n = len(pts_zy)
        v = [(x1, y, z) for z, y in pts_zy] + [(x0, y, z) for z, y in pts_zy]
        # seen from +x, z runs to the left: CCW in (z, y) seen from +x is CW in (−z, y)
        f = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
        f += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        self._part(v, f, color, **kw)

    def beam(self, a, b, w, d, color, ext=0.0, **kw):
        """A box from point a to point b (game xyz) with cross-section w (in the x-y plane) × d (z), its
        ends pushed out by `ext` (tubes overlap at their joints)."""
        ax, ay, az = a
        bx, by, bz = b
        dx, dy = bx - ax, by - ay
        ln = math.hypot(dx, dy)
        if ln < 1e-6:
            return
        ux, uy = dx / ln, dy / ln
        ax, ay, bx, by = ax - ux * ext, ay - uy * ext, bx + ux * ext, by + uy * ext
        px, py = -uy * w / 2, ux * w / 2
        quad = [(ax - px, ay - py), (bx - px, by - py), (bx + px, by + py), (ax + px, ay + py)]
        z0, z1 = min(az, bz) - d / 2, max(az, bz) + d / 2
        self.prism_z(quad, z0, z1, color, **kw)

    def strut(self, a, b, w, color, **kw):
        """A square strut of side w from point a to point b, in any direction (wires, braces, legs)."""
        d = [b[i] - a[i] for i in range(3)]
        ln = math.sqrt(sum(c * c for c in d))
        if ln < 1e-6:
            return
        d = [c / ln for c in d]
        ref = (0.0, 1.0, 0.0) if abs(d[1]) < 0.9 else (1.0, 0.0, 0.0)
        u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]
        un = math.sqrt(sum(c * c for c in u))
        u = [c / un * w / 2 for c in u]
        v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]
        corners = [(su, sv) for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        verts = [tuple(e[i] + su * u[i] + sv * v[i] for i in range(3)) for e in (a, b) for su, sv in corners]
        f = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        self._part(verts, f, color, **kw)

    def quad(self, pts, color, **kw):
        """A single-sided quad (CCW seen from its front)."""
        self._part(list(pts), [(0, 1, 2, 3)], color, convex=False, **kw)

    def cyl(self, cx, cy, cz, r, length, axis, color, segs=8, r2=None, **kw):
        """A capped cylinder (or a cone frustum with r2) along `axis` ('x', 'y' or 'z'), centred."""
        r2 = r if r2 is None else r2
        ring0, ring1 = [], []
        for i in range(segs):
            a = 2 * math.pi * (i + 0.5) / segs
            c, s = math.cos(a), math.sin(a)
            if axis == "y":
                ring0.append((cx + r * c, cy - length / 2, cz + r * s))
                ring1.append((cx + r2 * c, cy + length / 2, cz + r2 * s))
            elif axis == "x":
                ring0.append((cx - length / 2, cy + r * c, cz + r * s))
                ring1.append((cx + length / 2, cy + r2 * c, cz + r2 * s))
            else:
                ring0.append((cx + r * c, cy + r * s, cz - length / 2))
                ring1.append((cx + r2 * c, cy + r2 * s, cz + length / 2))
        v = ring0 + ring1
        f = [(i, (i + 1) % segs, segs + (i + 1) % segs, segs + i) for i in range(segs)]
        f += [tuple(range(segs))[::-1], tuple(range(segs, 2 * segs))]
        self._part(v, f, color, **kw)

    def blob(self, cx, cy, cz, rx, ry, rz, color, segs=6, rings=4, **kw):
        """A low-poly ellipsoid (plants, steam, lantern bodies)."""
        v = [(cx, cy - ry, cz)]
        for j in range(1, rings):
            t = math.pi * j / rings
            for i in range(segs):
                a = 2 * math.pi * i / segs
                v.append((cx + rx * math.sin(t) * math.cos(a), cy - ry * math.cos(t), cz + rz * math.sin(t) * math.sin(a)))
        v.append((cx, cy + ry, cz))
        top = len(v) - 1
        f = []
        for i in range(segs):
            f.append((0, 1 + (i + 1) % segs, 1 + i))
        for j in range(rings - 2):
            r0, r1 = 1 + j * segs, 1 + (j + 1) * segs
            for i in range(segs):
                f.append((r0 + i, r0 + (i + 1) % segs, r1 + (i + 1) % segs, r1 + i))
        last = 1 + (rings - 2) * segs
        for i in range(segs):
            f.append((last + i, last + (i + 1) % segs, top))
        self._part(v, f, color, **kw)

    def tubes(self, polylines, z, w, color, depth=None, flat=False):
        """Neon tubes (or painted strokes, thin `depth`) along polylines in the x-y plane at depth z;
        `flat`: brushed paint, one camera-facing quad per stroke segment."""
        d = w if depth is None else depth
        for line in polylines:
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                if not flat:
                    self.beam((ax, ay, z), (bx, by, z), w, d, color, ext=w / 2, ao=False, shade=False)
                    continue
                ln = math.hypot(bx - ax, by - ay) or 1.0
                ux, uy = (bx - ax) / ln * w / 2, (by - ay) / ln * w / 2
                q = [(ax - ux + uy, ay - uy - ux, z), (bx + ux + uy, by + uy - ux, z), (bx + ux - uy, by + uy + ux, z), (ax - ux - uy, ay - uy + ux, z)]
                self.quad(q if _normal(q)[2] > 0 else q[::-1], color, ao=False, shade=False)

    # -- collision (piece-local x, y)
    def solid(self, pts):
        self.extras["solids"].append(flat(pts))

    def one_way(self, ax, ay, bx, by):
        self.extras["oneWays"].append([round(ax, 3), round(ay, 3), round(bx, 3), round(by, 3)])
        self.extras["blocksBullets"] = True

    def bullet_only(self, poly, material=1):
        self.extras.setdefault("bulletOnly", []).append(poly)
        self.extras["bulletOnlyMaterial"] = material


def _normal(pts):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = pts[0], pts[1], pts[2]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1
    return nx / ln, ny / ln, nz / ln


def _outward(v, face, centre):
    pts = [v[i] for i in face]
    n = _normal(pts)
    mx = sum(p[0] for p in pts) / len(pts) - centre[0]
    my = sum(p[1] for p in pts) / len(pts) - centre[1]
    mz = sum(p[2] for p in pts) / len(pts) - centre[2]
    return face if n[0] * mx + n[1] * my + n[2] * mz >= 0 else tuple(reversed(face))


# ------------------------------------------------------------------ Blender out

MAT = None


def kit_material():
    global MAT
    MAT = bpy.data.materials.new("kit_fog_stair")
    MAT.use_backface_culling = True  # closed meshes: exported doubleSided false
    bsdf = next(n for n in MAT.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    vc = MAT.node_tree.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    MAT.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])


def write(p):
    """The piece as one Blender object (game space → Blender: x, −z, y), extras on the node."""
    me = bpy.data.meshes.new(p.pid)
    # a neon tube's bend dips a centimetre under its sign's foot: flattened onto it (the pivot)
    snap = (lambda y: max(y, 0.0) if -0.03 < y < 0.0 else y) if p.layer == "glow" else (lambda y: y)
    me.from_pydata([(x, -z, snap(y) + p.lift) for x, y, z in p.verts], [], p.faces)
    me.update()
    assert len(me.polygons) == len(p.cols), p.pid
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly, corner in zip(me.polygons, p.cols):
        for k, c in zip(poly.loop_indices, corner):
            col.data[k].color = (*[srgb_to_linear(ch) for ch in c], 1.0)
    me.materials.append(MAT)
    obj = bpy.data.objects.new(p.pid, me)
    bpy.context.scene.collection.objects.link(obj)
    obj["kitPiece"] = p.pid
    obj["biome"] = "fog_stair"
    obj["layer"] = p.layer
    obj["material"] = p.material
    for k, v in p.extras.items():
        obj[k] = v
    return obj


# ------------------------------------------------------------------ details (façades, roofs, street life)

def window(p, x, y, w, h, z, style="cage"):
    """A window on a wall whose face is at depth z: a dark pane in a frame, and (style) a steel grille
    cage (防盗网) bolted over it, a plain frame, or warm-lit glass."""
    pane = WINDOW_WARM if style == "warm" else WINDOW
    p.quad([(x - w / 2, y, z + 0.01), (x + w / 2, y, z + 0.01), (x + w / 2, y + h, z + 0.01), (x - w / 2, y + h, z + 0.01)], pane, ao=False)
    if style == "warm":  # a lit room: its frame and mullions dark against it
        p.box(x - 0.03, y, z + 0.01, x + 0.03, y + h, z + 0.04, WOOD_D, hide="bud", ao=False)
        p.box(x - w / 2, y + h * 0.62 - 0.03, z + 0.01, x + w / 2, y + h * 0.62 + 0.03, z + 0.04, WOOD_D, hide="bdlr", ao=False)
    if style != "cage":
        p.box(x - w / 2 - 0.08, y - 0.1, z, x + w / 2 + 0.08, y, z + 0.12, CONCRETE_B, hide="bdlr", ao=False)  # sill
        return
    d = 0.42
    p.box(x - w / 2 - 0.06, y + h, z, x + w / 2 + 0.06, y + h + 0.06, z + d, GRILLE, hide="bd", ao=False)  # lid
    p.box(x - w / 2 - 0.06, y - 0.04, z, x + w / 2 + 0.06, y + 0.02, z + d, GRILLE, hide="bd", ao=False)  # floor
    for k in range(3):
        bx = x - w / 2 + k * w / 2
        p.box(bx - 0.025, y, z + d - 0.05, bx + 0.025, y + h, z + d, GRILLE, hide="bud", ao=False)


def ac_unit(p, x, y, z):
    """An air-con unit on a bracket under a window, its fan a dark disc."""
    p.box(x - 0.42, y, z, x + 0.42, y + 0.55, z + 0.32, AC, ao=False)
    p.box(x - 0.2, y + 0.1, z + 0.32, x + 0.2, y + 0.45, z + 0.34, (0.30, 0.31, 0.31), ao=False)


def laundry(p, x0, x1, y, z, rng):
    """A laundry pole along a façade with clothes hanging from it (camera-facing quads)."""
    p.box(x0, y - 0.03, z - 0.03, x1, y + 0.03, z + 0.03, STEEL, ao=False)
    x = x0 + 0.15
    while x < x1 - 0.4:
        w = rng.uniform(0.3, 0.6)
        h = rng.uniform(0.45, 0.9)
        c = rng.choice(CLOTHES)
        p.quad([(x, y - h, z + 0.04), (x + w, y - h, z + 0.04), (x + w, y, z + 0.04), (x, y, z + 0.04)], c, shade=False)
        x += w + rng.uniform(0.08, 0.3)


def potted(p, x, y, z, rng, s=1.0):
    """A clay pot with a plant."""
    p.box(x - 0.16 * s, y, z - 0.16 * s, x + 0.16 * s, y + 0.3 * s, z + 0.16 * s, POT, hide="bd", ao=False)
    p.blob(x, y + 0.45 * s, z, 0.28 * s, 0.26 * s, 0.24 * s, rng.choice((PLANT, PLANT_L)), segs=5, rings=2)


def puff(p, x, y, z, r):
    """A puff of steam: a flat, round, camera-facing disc (stylised, so it reads at any zoom)."""
    pts = [(x + r * math.cos(2 * math.pi * (i + 0.5) / 9), y + r * 0.82 * math.sin(2 * math.pi * (i + 0.5) / 9)) for i in range(9)]
    p._part([(x_, y_, z) for x_, y_ in pts], [tuple(range(len(pts)))], STEAM, ao=False, shade=False, convex=False)


def steam(p, x, y, z, s=1.0):
    """A column of steam over a pot: puffs growing and drifting as they rise."""
    for dx, dy, r in ((0.0, 0.0, 0.16), (0.12, 0.32, 0.22), (-0.06, 0.7, 0.28), (0.16, 1.12, 0.3), (0.02, 1.55, 0.24)):
        puff(p, x + dx * s, y + dy * s, z + dy * 0.02, r * s)


def lantern(p, x, y, z, s=1.0):
    """A red paper lantern: a crimson body between gold caps, a tassel under it."""
    p.box(x - 0.08 * s, y + 0.2 * s, z - 0.08 * s, x + 0.08 * s, y + 0.28 * s, z + 0.08 * s, GOLD, ao=False)
    p.blob(x, y, z, 0.25 * s, 0.23 * s, 0.25 * s, LANTERN, segs=6, rings=3, ao=False)
    p.box(x - 0.08 * s, y - 0.28 * s, z - 0.08 * s, x + 0.08 * s, y - 0.2 * s, z + 0.08 * s, GOLD, hide="bud", ao=False)


def lantern_string(p, a, b, sag, z, every=1.6, s=0.9):
    """Lanterns on a wire from a to b (x, y), sagging by `sag` in the middle."""
    (ax, ay), (bx, by) = a, b
    n = 10
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append((ax + (bx - ax) * t, ay + (by - ay) * t - sag * 4 * t * (1 - t)))
    for (ux, uy), (vx, vy) in zip(pts, pts[1:]):
        p.beam((ux, uy, z), (vx, vy, z), 0.03, 0.03, (0.20, 0.20, 0.20), ao=False)
    span = math.hypot(bx - ax, by - ay)
    k = max(1, int(span // every))
    for i in range(1, k):
        t = i / k
        x = ax + (bx - ax) * t
        y = ay + (by - ay) * t - sag * 4 * t * (1 - t)
        lantern(p, x, y - 0.4 * s, z, s)


def tile_roof(p, x0, x1, ridge_y, ridge_half, eave_y, eave_z, flare=0.45, back=True, ridge=True, overhang=0.4, zc=0.0):
    """A grey-tiled pitched roof with its ridge along x at `ridge_y` (flat for |z| ≤ ridge_half), the
    eaves at `eave_y`, `eave_z` out from the ridge, front and back. Tile rows (筒瓦) run down the
    slopes; the four corners turn up (`flare` m) and out (`overhang` m past x0 and x1). `zc`: the
    ridge's depth (0: on the gameplay plane)."""
    for sd in ((1, -1) if back else (1,)):
        z_in, z_out = zc + sd * ridge_half, zc + sd * eave_z
        p.prism_x([(z_in, ridge_y), (z_out, eave_y), (z_out, eave_y - 0.18), (z_in, ridge_y - 0.18)], x0, x1, ROOF_TILE)
        n = int((x1 - x0) / 0.75)
        for i in range(n + 1):
            tx = x0 + 0.08 + (x1 - x0 - 0.16) * i / max(1, n)
            a, b = (z_in, ridge_y + 0.005), (z_out, eave_y + 0.005)
            for side in (-1, 1):  # a rounded tile row (筒瓦): two faces meeting along a ridge 6 cm up
                q = [(tx + side * 0.08, a[1], a[0]), (tx + side * 0.08, b[1], b[0]), (tx, b[1] + 0.06, b[0]), (tx, a[1] + 0.06, a[0])]
                up = _normal([(x, y, z) for x, y, z in q])[1] > 0
                p.quad(q if up else q[::-1], ROOF_TILE_D, ao=False)
        # the eave's edge (the dark tile ends) and the corner horns, curving up and out
        p.box(x0 - overhang * 0.5, eave_y - 0.22, z_out - 0.08 * sd, x1 + overhang * 0.5, eave_y, z_out + 0.06 * sd, ROOF_TILE_D, ao=False)
        for cx, dx in ((x0, -1), (x1, 1)):
            pts = [(cx, eave_y - 0.12), (cx + dx * overhang * 0.55, eave_y + flare * 0.06), (cx + dx * overhang * 0.88, eave_y + flare * 0.4), (cx + dx * overhang, eave_y + flare)]
            for k, ((ax, ay), (bx, by)) in enumerate(zip(pts, pts[1:])):
                w = (0.24, 0.17, 0.1)[k]
                p.beam((ax, ay, z_out), (bx, by, z_out), w, w * 1.4, ROOF_TILE_D, ext=w / 2, ao=False)
    if ridge:
        p.box(x0, ridge_y - 0.05, zc - ridge_half - 0.05, x1, ridge_y, zc + ridge_half + 0.05, ROOF_TILE_D, ao=False)


def step_flight(p, x0, y0, run, rise_total, z0=-1.0, z1=1.0, step=0.25, color=STONE, nosing=STONE_L):
    """Stone steps on a 45° slope from (x0, y0) going right and down `rise_total`: each step's tread is
    at the slope's height in the middle of the step, so the corners stand ±step/2 off the walking line.
    Only what the camera sees: each step's front, tread and riser."""
    n = int(round(run / step))
    for k in range(n):
        a = x0 + k * step
        top = y0 - (k + 0.5) * step * rise_total / run
        c = nosing if k % 2 else color
        p.quad([(a, top - 0.3, z1), (a + step, top - 0.3, z1), (a + step, top, z1), (a, top, z1)], c, ao=False)
        p.quad([(a, top, z1), (a + step, top, z1), (a + step, top, z0), (a, top, z0)], c, ao=False)
        p.quad([(a + step, top - step, z1), (a + step, top - step, z0), (a + step, top, z0), (a + step, top, z1)], c, ao=False)
def house_face(p, x0, x1, y0, y1, z, rng, kind=None):
    """One old house on a hillside face: a wall panel from y0 to y1 between x0 and x1, set on the face
    at depth z, with a grey-tile eave strip along its top, windows (wooden lattice or steel cages),
    and sometimes a stilt storey under it (diaojiaolou: posts over a dark undercroft)."""
    kind = kind or rng.choice(("timber", "timber", "plaster", "brick"))
    wall = {"timber": WOOD, "plaster": PLASTER, "brick": (0.50, 0.40, 0.34)}[kind]
    stilts = kind == "timber" and y1 - y0 > 5.5 and rng.random() < 0.7
    body0 = y0 + (2.2 if stilts else 0.0)
    if stilts:
        p.box(x0, y0, z - 0.02, x1, body0, z + 0.02, (0.14, 0.13, 0.12), ao=False)  # the dark undercroft
        for k in range(int((x1 - x0) // 1.4) + 2):
            sx = min(x1 - 0.1, x0 + 0.1 + k * 1.4)
            p.box(sx - 0.09, y0, z, sx + 0.09, body0, z + 0.22, WOOD_D, ao=False)
        p.beam((x0 + 0.1, y0 + 0.3, z + 0.12), (min(x1, x0 + 2.6), body0 - 0.1, z + 0.12), 0.1, 0.1, WOOD_D, ao=False)
    p.box(x0, body0, z, x1, y1, z + 0.18, wall)
    if kind == "timber":
        for k in range(int((x1 - x0) // 1.8) + 1):  # vertical boards
            bx = x0 + 0.9 + k * 1.8
            if bx < x1 - 0.1:
                p.box(bx - 0.03, body0, z + 0.18, bx + 0.03, y1, z + 0.21, WOOD_D, ao=False)
    floors = max(1, int((y1 - body0 - 0.6) // 2.8))
    for f in range(floors):
        wy = body0 + 0.8 + f * 2.8
        if wy + 1.3 > y1 - 0.5:
            break
        n = max(1, int((x1 - x0 - 0.6) // 2.3))
        for i in range(n):
            wx = x0 + (i + 0.5) * (x1 - x0) / n
            style = rng.choice(("lattice", "plain", "warm")) if kind == "timber" else rng.choice(("cage", "plain", "warm"))
            if style == "lattice":
                p.box(wx - 0.5, wy, z + 0.12, wx + 0.5, wy + 1.2, z + 0.2, WINDOW, ao=False)
                for gx in (-0.2, 0.2):
                    p.box(wx + gx - 0.025, wy, z + 0.2, wx + gx + 0.025, wy + 1.2, z + 0.24, WOOD_L, hide="bud", ao=False)
                p.box(wx - 0.5, wy + 0.58, z + 0.2, wx + 0.5, wy + 0.62, z + 0.24, WOOD_L, hide="blr", ao=False)
            else:
                window(p, wx, wy, 0.9, 1.2, z + 0.18, style)
            if rng.random() < 0.15:
                potted(p, wx + 0.2, wy - 0.06, z + 0.4, rng, 0.8)
    # the eave: a grey-tile strip, all inside the face
    p.box(x0 - 0.05, y1 - 0.25, z, x1 + 0.05, y1, z + 0.55, ROOF_TILE, ao=False)
    p.box(x0 - 0.05, y1 - 0.32, z + 0.5, x1 + 0.05, y1 - 0.2, z + 0.6, ROOF_TILE_D, ao=False)
    if rng.random() < 0.3:
        laundry(p, x0 + 0.3, x1 - 0.3, y1 - 0.5, z + 0.5, rng)


def face_stack(p, x0, x1, bottom, top, z, rng, width=(3.6, 5.6), houses=13.0):
    """Houses stepping down a hillside face between x0 and x1: `top(x)` is the walking line above
    (each house's top stays under it); `houses` m of them under the line, then the older city's
    concrete and stone below, plainer (what the camera sees least), down to `bottom`."""
    x = x0
    while x < x1 - 0.5:
        w = min(x1 - x, rng.uniform(*width))
        if x1 - (x + w) < 1.5:
            w = x1 - x
        y = min(top(x), top(x + w))
        floor = y - houses
        while y - max(bottom, floor) > 2.5:
            h = min(y - max(bottom, floor), rng.uniform(5.0, 8.0))
            if y - h - max(bottom, floor) < 2.5:
                h = y - max(bottom, floor)
            house_face(p, x + 0.05, x + w - 0.05, y - h, y, z, rng)
            y -= h
        if y - bottom > 0.5:
            plain_block(p, x + 0.05, x + w - 0.05, bottom, y, z, rng)
        x += w


def plain_block(p, x0, x1, y0, y1, z, rng):
    """An old concrete block low on the hill's face: stained walls, a few dark windows, a band per
    storey (cheap: most of it is under the play)."""
    p.box(x0, y0, z, x1, y1, z + 0.14, rng.choice((CONCRETE_B, CONCRETE_D, (0.50, 0.46, 0.40))))
    y = y0 + 3.2
    while y < y1 - 0.4:
        p.box(x0, y - 0.18, z + 0.14, x1, y, z + 0.3, CONCRETE, hide="bd", ao=False)
        if rng.random() < 0.7:
            wx = rng.uniform(x0 + 0.8, x1 - 0.8)
            p.quad([(wx - 0.5, y - 2.4, z + 0.15), (wx + 0.5, y - 2.4, z + 0.15), (wx + 0.5, y - 1.2, z + 0.15), (wx - 0.5, y - 1.2, z + 0.15)],
                   WINDOW_WARM if rng.random() < 0.2 else WINDOW, ao=False)
        y += 3.2


def retaining_wall(p, x0, x1, y0, y1, z, rng, rows=4):
    """Big sandstone blocks in staggered courses on a face at depth z."""
    p.box(x0, y0, z - 0.02, x1, y1, z + 0.02, STONE_D, ao=False)
    h = (y1 - y0) / rows
    for r in range(rows):
        x = x0 - (0.6 if r % 2 else 0.0)
        while x < x1:
            w = rng.uniform(2.0, 3.4)
            a, b = max(x0, x + 0.04), min(x1, x + w - 0.04)
            if b - a > 0.3:
                p.box(a, y0 + r * h + 0.04, z, b, y0 + (r + 1) * h - 0.04, z + rng.uniform(0.04, 0.09), rng.choice((STONE, STONE_L, STONE)), hide="bd", ao=False)
            x += w


def paving(p, x0, x1, z0, z1, color=PAVING, joint=1.5):
    """A paved top at y 0 (the walkable surface), its slab joints flush with it."""
    p.box(x0, -0.3, z0, x1, 0.0, z1, color)
    x = x0 + joint
    while x < x1 - 0.2:
        p.quad([(x - 0.02, 0.002, z1), (x + 0.02, 0.002, z1), (x + 0.02, 0.002, z0), (x - 0.02, 0.002, z0)], CONCRETE_D, ao=False, shade=False)
        x += joint


def kerb(p, x0, x1):
    """The front edge of a walkable top: a stone kerb flush with it (top at y 0)."""
    p.box(x0, -0.55, 0.92, x1, 0.0, 1.12, STONE_L)


def skirt(p, x0, x1, bottom):
    """Below the map's floor, in front of the plane only: the camera stops at the bounds on the plane,
    so a phone's wide view still sees a strip under the front faces (z 1). Out of the band: no collision."""
    p.box(x0, bottom - 10.0, 0.4, x1, bottom, 0.98, STONE_D, hide="bd", ao=False)


# ------------------------------------------------------------------ gameplay pieces: the ground (terrain columns)

def edge_wall():
    """The map's side wall (x −2…0, y −6…100): a dark tower edge up the whole height."""
    p = Piece("fs_edge_wall", seed=3)
    p.box(-1, 0, -8, 1, 106, 1, CONCRETE_D)
    for k in range(32):
        y = 1.5 + k * 3.3
        p.box(-1.0, y + 2.7, 1.0, 1.0, y + 2.95, 1.2, CONCRETE_B, hide="bd", ao=False)
        if k % 2 == 0:
            window(p, 0, y + 0.6, 1.0, 1.4, 1.0, "warm" if k % 7 == 3 else "plain")
    p.solid([(-1, 0), (1, 0), (1, 106), (-1, 106)])
    return p


def hill():
    """The hilltop lane (y 38) and the hill's face below it, down to the floor: a sandstone retaining
    wall under the lane, then old houses stacked down the cliff."""
    p = Piece("fs_hill", seed=5)
    rng = p.rng
    p.box(0, -44, -8, 22, -0.3, 0.98, STONE_D)
    paving(p, 0, 22, -4.5, 0.92)
    kerb(p, 0, 22)
    retaining_wall(p, 0, 22, -4.2, -0.55, 0.98, rng)
    for x in (3.0, 9.5, 15.0, 19.5):  # creepers over the wall
        p.blob(x, -1.8, 1.12, 1.0, 0.8, 0.14, rng.choice((PLANT, MOSS)), segs=6, rings=3)
    face_stack(p, 0, 22, -40.0, lambda x: -4.3, 0.98, rng, width=(4.0, 6.0))
    retaining_wall(p, 0, 22, -44, -40.0, 0.98, rng, rows=2)
    skirt(p, 0, 22, -44)
    p.solid([(0, -44), (22, -44), (22, 0), (0, 0)])
    return p


def stair(pid, run, bottom, seed):
    """A long public stone stair at 45° from (0, 0) down to (run, −run), its ground column down to
    `bottom`: steps across the band, the balustrade and handrail on the back edge, lanterns strung
    over it behind the plane, and stilted houses stepping down its face."""
    p = Piece(pid, seed=seed)
    rng = p.rng
    line = lambda x: -x  # noqa: E731
    p.prism_z([(0, bottom), (run, bottom), (run, -run - 0.45), (0, -0.45)], -8, 0.98, STONE_D)
    step_flight(p, 0, 0, run, run, z0=-1.45, z1=1.0)
    # the stringer under the steps' front edge
    p.prism_z([(0, -0.4), (run, -run - 0.4), (run, -run - 1.05), (0, -1.05)], 0.9, 1.1, STONE_L)
    # the balustrade on the back edge: a base, balusters, a stone rail; the steel handrail on it
    p.prism_z([(0, 0.15), (run, -run + 0.15), (run, -run - 0.3), (0, -0.3)], -1.45, -1.1, STONE)
    k = 0.5
    while k <= run:
        p.box(k - 0.07, line(k), -1.36, k + 0.07, line(k) + 0.85, -1.2, STONE_L, ao=False)
        k += 1.0
    p.beam((0, 0.92, -1.28), (run, -run + 0.92, -1.28), 0.16, 0.26, STONE_L, ao=False)
    p.beam((0, 1.05, -1.08), (run, -run + 1.05, -1.08), 0.05, 0.05, STEEL, ao=False)
    # lanterns strung over the steps from lamp posts on the back edge
    posts = list(range(2, int(run), 6))
    for x in posts:
        p.box(x - 0.06, line(x), -1.62, x + 0.06, line(x) + 3.8, -1.5, (0.24, 0.24, 0.24), ao=False)
    for a, b in zip(posts, posts[1:]):
        lantern_string(p, (a, line(a) + 3.75), (b, line(b) + 3.75), 0.7, -1.56, every=1.9)
    # the face: stilted houses stepping down under the stair
    face_stack(p, 0.2, run, bottom + 1.5, lambda x: line(x) - 1.6, 0.98, rng, width=(3.2, 4.8))
    skirt(p, 0, run, bottom)
    p.solid([(0, bottom), (run, bottom), (run, -run), (0, 0)])
    return p


def terrace():
    """The terrace between the stairs (y 20): paved, its face a stack of houses down to the floor."""
    p = Piece("fs_terrace", seed=7)
    rng = p.rng
    p.box(0, -26, -8, 16, -0.3, 0.98, STONE_D)
    paving(p, 0, 16, -4.5, 0.92, joint=1.6)
    kerb(p, 0, 16)
    retaining_wall(p, 0, 16, -3.2, -0.55, 0.98, rng, rows=3)
    face_stack(p, 0, 16, -24.0, lambda x: -3.3, 0.98, rng, width=(4.0, 5.5))
    retaining_wall(p, 0, 16, -26, -24.0, 0.98, rng, rows=1)
    skirt(p, 0, 16, -26)
    p.solid([(0, -26), (16, -26), (16, 0), (0, 0)])
    return p


def quay():
    """The stone quay (y 0): sandstone slabs, a kerb, bollards on the back edge where the boats tie
    up, steps down to the water, the quay wall's big blocks down to the floor."""
    p = Piece("fs_quay", seed=11)
    rng = p.rng
    p.box(0, -6, -9, 28, -0.3, 0.98, STONE_D)
    paving(p, 0, 28, -9, 0.92, color=STONE, joint=2.0)
    kerb(p, 0, 28)
    retaining_wall(p, 0, 28, -6, -0.55, 0.98, rng, rows=4)
    for x in (6.0, 13.0, 20.0, 26.5):  # bollards on the back edge
        p.cyl(x, 0.3, -1.6, 0.26, 0.6, "y", STONE_D, segs=8)
        p.cyl(x, 0.66, -1.6, 0.32, 0.12, "y", STONE_D, segs=8)
    for k in range(6):  # steps down to the water, far behind the plane
        p.box(23.0 + k * 0.5, -0.3 - k * 0.5, -9.0, 28.0, -k * 0.5 - 0.01, -7.6, STONE, ao=False)
    skirt(p, 0, 28, -6)
    p.solid([(0, -6), (28, -6), (28, 0), (0, 0)])
    return p


def riverbed():
    """The river's bed (y −4), silt and a few stones, under the water."""
    p = Piece("fs_riverbed", seed=13)
    p.box(-16, -2, -9, 16, 0, 1.0, SILT)
    for x in (-11, -4, 3, 9, 13):
        p.blob(x, -0.2, 0.2, 0.6, 0.18, 0.5, STONE_D, segs=5, rings=3)
    skirt(p, -16, 16, -2)
    p.solid([(-16, -2), (16, -2), (16, 0), (-16, 0)])
    return p


def river():
    """The river's surface (y −1, the water zone's top) across the gorge and back into the fog: no
    collision (the water is a zone); drawn flat, so a swimmer under it is never hidden."""
    p = Piece("fs_river", seed=17)
    p.quad([(-16, 0, 1.0), (16, 0, 1.0), (16, 0, -40), (-16, 0, -40)][::-1], RIVER, shade=False)
    rng = p.rng
    for k in range(14):  # current lines
        z = -rng.uniform(1.5, 30)
        x = rng.uniform(-14, 10)
        p.quad([(x, 0.01, z + 0.12), (x + rng.uniform(2, 6), 0.01, z + 0.12), (x + rng.uniform(2, 6), 0.01, z - 0.12), (x, 0.01, z - 0.12)][::-1],
               (0.44, 0.48, 0.43), shade=False)
    return p


# ------------------------------------------------------------------ gameplay pieces: the towers

def facade_floor(p, x0, x1, y, z, rng, bays, scaffold=None, clear=()):
    """One storey of a tower's front: its balcony band, and per bay a window (a steel cage most often),
    maybe an air-con unit under it, a laundry pole, potted plants on the cage. Nothing that sticks out
    goes where a sign hangs (`clear`: x0, y0, x1, y1 rectangles) or under the scaffold."""
    def free(ax, bx, ay, by):
        if scaffold and ax < scaffold[1] and bx > scaffold[0]:
            return False
        return not any(ax < c[2] and bx > c[0] and ay < c[3] and by > c[1] for c in clear)
    p.box(x0, y - 0.28, z, x1, y, z + 0.38, CONCRETE)
    w = (x1 - x0) / bays
    for i in range(bays):
        cx = x0 + (i + 0.5) * w
        r = rng.random()
        style = "cage" if r < 0.42 else "plain" if r < 0.88 else "warm"
        if style == "cage" and not free(cx - 1.0, cx + 1.0, y, y + 2.2):
            style = "plain"
        window(p, cx, y + 0.55, min(1.7, w - 1.6), 1.5, z, style)
        ax = cx + (0.9 if rng.random() < 0.5 else -0.9)
        if rng.random() < 0.4 and free(ax - 0.45, ax + 0.45, y, y + 0.6):
            ac_unit(p, ax, y + 0.05, z + 0.02)
        if style == "cage" and rng.random() < 0.35:
            potted(p, cx - 0.4, y + 2.11, z + 0.22, rng, 0.75)
            if rng.random() < 0.5:
                potted(p, cx + 0.35, y + 2.11, z + 0.24, rng, 0.65)
        if rng.random() < 0.22 and free(cx - w / 2 + 0.5, cx + w / 2 - 0.5, y + 1.3, y + 2.4):
            laundry(p, cx - w / 2 + 0.5, cx + w / 2 - 0.5, y + 2.35, z + 0.62, rng)


def bamboo_scaffold(p, x0, x1, y0, y1, z, rng):
    """Bamboo scaffolding lashed over a façade: poles, ledgers, a few patches of safety net."""
    x = x0 + 0.2
    while x <= x1 - 0.1:
        p.cyl(x, (y0 + y1) / 2, z + 0.62, 0.05, y1 - y0, "y", BAMBOO, segs=5, ao=False)
        x += 1.5
    y = y0 + 1.0
    while y < y1:
        p.cyl((x0 + x1) / 2, y, z + 0.7, 0.045, x1 - x0, "x", BAMBOO, segs=5, ao=False)
        y += 2.0
    for k in range(int((x1 - x0) // 3)):  # diagonal braces
        a = x0 + 0.2 + k * 3.0
        p.beam((a, y0 + 0.3, z + 0.66), (a + 3.0, min(y1, y0 + 6.3), z + 0.66), 0.08, 0.08, BAMBOO, ao=False)
    yy = y0 + 2.5
    while yy < y1 - 2.0:  # net patches
        a = rng.uniform(x0, x1 - 4.0)
        p.quad([(a, yy, z + 0.8), (a + rng.uniform(2.5, 4.0), yy, z + 0.8), (a + rng.uniform(2.5, 4.0), yy + 2.6, z + 0.8), (a, yy + 2.6, z + 0.8)], NETTING, shade=False)
        yy += 4.0


# where the layout hangs signs on the tower's face (tower-local x0, y0, x1, y1; fog_stair_layout.py):
# the blade at x 84.5 (y 11), the LED panel at x 93.6 (y 27.3), the blade at x 93.5 (y 50.4)
TOWER_SIGNS = ((-5.5, 10.6, -3.5, 14.6), (1.2, 26.8, 8.2, 31.0), (3.5, 50.0, 5.5, 54.0))


def tower():
    """A concrete residential tower on the quay (x 80…98): an arcade under it (three legs, bullet-only)
    with shops at its back wall, ten storeys, the monorail station's gap (38…43.5), six more storeys
    with bamboo scaffolding over half of them, a flat roof at 62."""
    p = Piece("fs_tower", seed=19)
    rng = p.rng
    # the blocks and the station's back
    p.box(-9, 4, -12, 9, 38, 1.0, TILE_WALL)
    p.box(-9, 43.5, -12, 9, 62, 1.0, PLASTER_G)
    p.box(-9, 0, -12, 9, 4, -1.45, CONCRETE_B)  # behind the arcade
    p.box(-9, 38, -12, 9, 43.5, -5.0, CONCRETE_B)  # behind the station
    # the arcade: legs on the plane, back columns, the fascia over it
    for x in (-8.4, 0.0, 8.4):
        p.box(x - 0.2, 0, -1.0, x + 0.2, 4.0, 1.0, CONCRETE)
        p.box(x - 0.3, 0, -1.6, x + 0.3, 4.0, -1.4, CONCRETE, ao=False)
    p.box(-9, 4.0, 1.0, 9, 5.2, 1.15, CONCRETE)
    # the shopfronts on the arcade's back wall (z −1.45): hotpot, shutter, corner shop, shutter
    bays = [(-8.2, -4.4), (-4.0, -0.4), (0.4, 4.2), (4.6, 8.2)]
    for i, (a, b) in enumerate(bays):
        if i in (1, 3):  # rolling steel shutters, one half up
            top = 3.1 if i == 1 else 1.6
            p.box(a, top, -1.48, b, 3.4, -1.43, SHUTTER, ao=False)
            for k in range(int((3.4 - top) / 0.18)):
                p.box(a, top + k * 0.18, -1.43, b, top + k * 0.18 + 0.05, -1.41, SHUTTER_D, ao=False)
            p.box(a, 0, -1.48, b, top, -1.46, (0.12, 0.12, 0.12), ao=False)
            p.box(a - 0.1, 3.4, -1.48, b + 0.1, 3.75, -1.35, SHUTTER_D, ao=False)  # the shutter box
        else:
            p.box(a, 0, -1.5, b, 2.6, -1.46, (0.16, 0.14, 0.12), ao=False)  # open front, dim inside
            p.box(a, 2.6, -1.5, b, 2.75, -1.38, WOOD_D, ao=False)
    # hotpot: a stove and a pot by the door, steam rising, stools
    p.box(-7.6, 0, -2.5, -6.6, 0.8, -1.7, STEEL, ao=False)
    p.cyl(-7.1, 1.0, -2.1, 0.32, 0.4, "y", (0.30, 0.28, 0.26), segs=8, ao=False)
    steam(p, -7.1, 1.4, -1.9, 1.3)
    for k, x in enumerate((-5.6, -5.0, -4.5)):
        c = STOOL[k % 3]
        p.box(x - 0.16, 0.42, -2.4, x + 0.16, 0.47, -2.08, c, ao=False)
        p.box(x - 0.14, 0, -2.38, x + 0.14, 0.42, -2.1, c, ao=False)
    # corner shop: drinks crates and a cooler
    p.box(0.8, 0, -2.4, 1.8, 1.7, -1.7, (0.78, 0.80, 0.80), ao=False)
    p.box(0.9, 0.3, -1.7, 1.7, 1.5, -1.66, (0.35, 0.45, 0.48), ao=False)
    for k in range(3):
        p.box(2.2 + k * 0.6, 0, -2.2, 2.7 + k * 0.6, 0.35 + 0.3 * (k % 2), -1.75, (0.36, 0.44, 0.36) if k % 2 else (0.70, 0.60, 0.40), ao=False)
    # lower storeys (5.2 … 37.2)
    for k in range(10):
        facade_floor(p, -9, 9, 5.2 + 3.2 * k, 1.0, rng, 4, clear=TOWER_SIGNS)
    # the station: the guideway's top through it, the platform behind, screen doors, the back wall
    p.box(-9, 37.7, -1.0, 9, 38.0, 1.0, CONCRETE_D)
    p.box(-9, 37.995, -0.45, 9, 38.002, 0.45, (0.26, 0.27, 0.27), ao=False, shade=False)
    p.box(-9, 37.7, -5.0, 9, 38.0, -1.0, (0.58, 0.58, 0.56))
    p.box(-9, 37.998, -1.45, 9, 38.004, -1.15, TACTILE, ao=False, shade=False)
    for k in range(6):
        a = -8.6 + k * 2.95
        p.box(a, 38.0, -1.66, a + 2.6, 40.5, -1.6, (0.30, 0.36, 0.38), ao=False)
        p.box(a - 0.1, 38.0, -1.7, a, 40.7, -1.56, STEEL, ao=False)
    p.box(-9, 40.5, -1.72, 9, 40.8, -1.55, STEEL, ao=False)
    p.box(-9, 43.5, 1.0, 9, 44.3, 1.18, CONCRETE)  # the fascia over the station's mouth
    p.box(-9, 37.4, 1.0, 9, 38.0, 1.18, CONCRETE)  # the platform's edge beam
    # upper storeys (44 … 59): bamboo scaffolding over the west half
    scaffold = (-9.0, -0.6)
    for k in range(6):
        facade_floor(p, -9, 9, 44.6 + 2.9 * k, 1.0, rng, 4, scaffold=scaffold, clear=TOWER_SIGNS)
    bamboo_scaffold(p, scaffold[0] + 0.1, scaffold[1], 44.4, 58.6, 1.0, rng)
    # the roof's coping, flush with the walkable top
    p.box(-9, 61.55, 1.0, 9, 62.0, 1.2, CONCRETE)
    p.solid([(-9, 4), (9, 4), (9, 38), (-9, 38)])
    p.solid([(-9, 43.5), (9, 43.5), (9, 62), (-9, 62)])
    for x in (-8.4, 0.0, 8.4):
        p.bullet_only(rect(x - 0.2, 0, x + 0.2, 4))
    return p


def shophouse():
    """An old shop-house on the terrace (6 × 6.5 m): a noodle shop's wooden front under a tiled waist
    eave, lattice windows above, a grey-tiled pitched roof whose ridge is the walkable top (6.5 m),
    the eaves' corners turned up."""
    p = Piece("fs_shophouse", seed=23)
    rng = p.rng
    p.box(-3, 0, -1.7, 3, 5.6, 0.95, PLASTER)
    p.box(-3, 0, -4.0, 3, 4.0, -1.7, PLASTER, ao=False)  # the back wing
    p.box(-3.0, 4.0, -4.0, 3.0, 4.15, -1.6, ROOF_TILE, ao=False)
    # ground floor: the shopfront (counter, dark inside, a door), wooden posts
    p.box(-3, 0, 0.95, 3, 0.2, 1.05, STONE_D, ao=False)
    p.box(-2.5, 0.2, 0.95, 0.6, 0.95, 1.12, WOOD_L)
    p.box(-2.5, 0.95, 0.94, 0.6, 2.7, 0.97, (0.14, 0.12, 0.10), ao=False)
    p.box(0.95, 0.2, 0.94, 2.45, 2.5, 1.02, WOOD_D, ao=False)
    for x in (-2.85, 0.78, 2.7):
        p.box(x - 0.13, 0.2, 0.95, x + 0.13, 3.0, 1.18, WOOD)
    p.box(-3, 2.7, 0.95, 3, 3.0, 1.14, WOOD)
    # a pot of noodles steaming on the counter, a menu slate
    p.cyl(-1.6, 1.12, 1.0, 0.24, 0.34, "y", STEEL, segs=8, ao=False)
    steam(p, -1.6, 1.42, 1.0, 0.75)
    # the waist eave over the shopfront, tiled, its ends turned up (inside the house's width)
    p.box(-3, 3.0, 0.95, 3, 3.22, 1.85, ROOF_TILE)
    for k in range(19):
        x = -2.85 + k * 0.316
        p.box(x - 0.05, 3.22, 0.95, x + 0.05, 3.29, 1.85, ROOF_TILE_D, ao=False)
    p.box(-3, 2.95, 1.78, 3, 3.1, 1.9, ROOF_TILE_D, ao=False)
    for cx, dx in ((-2.95, 1), (2.95, -1)):
        p.beam((cx + dx * 0.4, 3.15, 1.85), (cx, 3.6, 1.9), 0.14, 0.16, ROOF_TILE_D, ext=0.04, ao=False)
    # lanterns under the waist eave
    for x in (-2.4, 2.4):
        lantern(p, x, 2.3, 1.55, 0.85)
    # upper floor: lattice windows
    for x in (-1.6, 1.6):
        p.box(x - 0.8, 3.75, 0.95, x + 0.8, 5.05, 1.02, WINDOW, ao=False)
        for gx in (-0.4, 0.0, 0.4):
            p.box(x + gx - 0.03, 3.75, 1.02, x + gx + 0.03, 5.05, 1.06, WOOD_L, ao=False)
        for gy in (4.18, 4.62):
            p.box(x - 0.8, gy - 0.03, 1.02, x + 0.8, gy + 0.03, 1.06, WOOD_L, ao=False)
        p.box(x - 0.9, 3.65, 0.95, x + 0.9, 3.75, 1.1, WOOD, ao=False)
        p.box(x - 0.9, 5.05, 0.95, x + 0.9, 5.15, 1.1, WOOD, ao=False)
    # the gables (inside the house's width) and the roof: the ridge at the walkable top
    for a, b in ((-3.0, -2.86), (2.86, 3.0)):
        p.prism_x([(-1.75, 5.55), (0.0, 6.42), (1.75, 5.55)], a, b, PLASTER)
    tile_roof(p, -3.0, 3.0, 6.5, 0.32, 5.55, 1.85, flare=0.42, overhang=0.36)
    p.solid([(-3, 0), (3, 0), (3, 6.5), (-3, 6.5)])
    return p


def roof_tank():
    """A sectional steel water tank on a low frame (3 × 2.5 m), a ladder up its front."""
    p = Piece("fs_roof_tank", material=1, seed=29)
    p.box(-1.5, 0, -1.5, 1.5, 0.3, 1.0, STEEL)
    p.box(-1.45, 0.3, -1.4, 1.45, 2.45, 0.95, (0.74, 0.75, 0.73))
    for y in (0.9, 1.6):
        p.box(-1.45, y - 0.04, 0.95, 1.45, y + 0.04, 1.0, (0.60, 0.61, 0.60), ao=False)
    for x in (-0.5, 0.5):
        p.box(x - 0.04, 0.3, 0.95, x + 0.04, 2.45, 1.0, (0.60, 0.61, 0.60), ao=False)
    p.box(-0.45, 2.45, -0.45, 0.45, 2.5, 0.45, (0.60, 0.61, 0.60), ao=False)
    for x in (0.95, 1.35):
        p.box(x - 0.03, 0.3, 1.0, x + 0.03, 2.5, 1.06, STEEL, ao=False)
    for k in range(6):
        y = 0.55 + k * 0.33
        p.box(0.95, y - 0.02, 1.0, 1.35, y + 0.02, 1.06, STEEL, ao=False)
    p.box(-1.2, 0.0, -1.7, -1.0, 1.6, -1.5, STEEL, ao=False)  # the down pipe, behind
    p.solid([(-1.5, 0), (1.5, 0), (1.5, 2.5), (-1.5, 2.5)])
    return p


def roof_mast():
    """A lattice radio mast (8 m, 0.3 m wide on the plane: bullet-only), its antennas and dish behind."""
    p = Piece("fs_roof_mast", material=1, seed=31)
    legs = [(-0.12, -0.1), (0.12, -0.1), (0.0, 0.12)]
    for x, z in legs:
        p.box(x - 0.025, 0, z - 0.025, x + 0.025, 8.0, z + 0.025, STEEL, ao=False)
    for k in range(13):
        y0, y1 = k * 0.6, k * 0.6 + 0.6
        a, b = legs[k % 3], legs[(k + 1) % 3]
        p.strut((a[0], y0, a[1]), (b[0], y1, b[1]), 0.025, STEEL, ao=False)
    p.box(-0.14, 0, -0.14, 0.14, 0.1, 0.14, CONCRETE_D, ao=False)
    for y in (6.4, 7.3):
        p.box(-0.08, y, -0.62, 0.08, y + 0.8, -0.48, (0.78, 0.78, 0.76), ao=False)
    p.cyl(0.0, 5.2, -0.6, 0.45, 0.08, "z", (0.80, 0.80, 0.78), segs=10, ao=False)
    for gx, gz in ((-2.2, -3.0), (2.2, -3.0)):
        p.strut((0, 6.0, -0.1), (gx, 0.0, gz), 0.02, (0.30, 0.30, 0.30), ao=False)
    p.bullet_only(rect(-0.15, 0, 0.15, 8))
    return p


def quay_cargo():
    """A steel cargo box on the quay (1.5 × 1.2 m), a tarp and a coil of rope on it."""
    p = Piece("fs_quay_cargo", material=1, seed=37)
    col = (0.42, 0.46, 0.44)
    p.box(-0.75, 0, -0.7, 0.75, 1.2, 0.95, col)
    for x in (-0.5, -0.17, 0.17, 0.5):
        p.box(x - 0.03, 0.05, 0.95, x + 0.03, 1.15, 0.99, (0.34, 0.38, 0.36), ao=False)
    p.box(-0.75, 1.0, -0.7, 0.2, 1.2, 0.97, (0.48, 0.52, 0.42), ao=False)  # the tarp's edge, on top
    p.cyl(0.42, 1.1, 0.2, 0.22, 0.18, "y", (0.62, 0.54, 0.38), segs=8, ao=False)
    p.solid([(-0.75, 0), (0.75, 0), (0.75, 1.2), (-0.75, 1.2)])
    return p


def monorail_car():
    """The monorail car parked on the river bridge (8 × 3.2 m): cream with a dark window band and a
    muted jade stripe, its bogie skirt down to the deck, a flat roof (the walkable top)."""
    p = Piece("fs_monorail_car", material=1, seed=41)
    p.box(-4, 0, -1.0, 4, 0.32, 1.0, (0.28, 0.29, 0.30))
    p.box(-4, 0.32, -1.15, 4, 3.05, 1.15, CAR)
    p.box(-3.9, 3.05, -1.05, 3.9, 3.2, 1.05, (0.74, 0.74, 0.70))
    p.box(-3.75, 1.55, 1.15, 3.75, 2.6, 1.18, CAR_BAND, ao=False)
    p.box(-4, 1.18, 1.15, 4, 1.36, 1.17, CAR_STRIPE, ao=False)
    p.box(-4, 0.62, 1.15, 4, 0.7, 1.17, CAR_STRIPE, ao=False)
    for x in (-1.7, 1.7):
        p.box(x - 0.62, 0.38, 1.15, x + 0.62, 2.7, 1.2, (0.70, 0.70, 0.66), ao=False)
        p.box(x - 0.02, 0.38, 1.2, x + 0.02, 2.7, 1.22, (0.40, 0.40, 0.38), ao=False)
        p.box(x - 0.5, 1.6, 1.2, x + 0.5, 2.55, 1.22, CAR_BAND, ao=False)
    for x in (-3.95, 3.95):  # the cab ends
        p.box(x - 0.05, 1.5, -1.0, x + 0.05, 2.65, 1.0, CAR_BAND, ao=False)
    p.solid([(-4, 0), (4, 0), (4, 3.2), (-4, 3.2)])
    return p


# ------------------------------------------------------------------ gameplay pieces: what players land on

def balcony():
    """A cantilevered balcony perch off a tower's side (4 m, one-way slab): concrete with a painted
    fascia, a steel grille rail, pot plants, an air-con unit and a laundry pole on its back edge."""
    p = Piece("fs_balcony", seed=43)
    rng = p.rng
    p.box(0, -0.28, -1.0, 4, 0.0, 1.0, CONCRETE)
    p.box(0.02, -0.24, 1.0, 4, -0.1, 1.06, PLASTER_G, ao=False)
    p.prism_z([(0, -0.28), (1.2, -0.28), (0, -1.3)], -1.0, -0.6, CONCRETE_B)  # corbel, behind
    for x in (0.3, 1.2, 2.1, 3.0, 3.9):
        p.box(x - 0.025, 0, -1.0, x + 0.025, 1.1, -0.95, GRILLE, ao=False)
    for y in (0.5, 1.08):
        p.box(0.1, y - 0.02, -1.0, 4.0, y + 0.02, -0.95, GRILLE, ao=False)
    for x in (0.75, 1.65, 2.55, 3.45):
        p.box(x - 0.015, 0, -0.99, x + 0.015, 1.1, -0.96, GRILLE, ao=False)
    ac_unit(p, 0.62, 0.0, -1.0)
    potted(p, 1.9, 0.0, -0.66, rng)
    potted(p, 3.2, 0.0, -0.7, rng, 0.85)
    laundry(p, 0.3, 3.8, 1.95, -0.88, rng)
    p.one_way(0, 0, 4, 0)
    return p


def perch():
    """The hill's lookout perch (4 m deck at 50, over the lane at 38): a timber deck on stilts that
    stand behind the plane, a lattice rail at its back, a small tiled canopy over the back half."""
    p = Piece("fs_perch", seed=47)
    p.box(0, -0.3, -1.0, 4, 0, 1.0, WOOD)
    for k in range(9):
        x = 0.22 + k * 0.45
        p.box(x - 0.01, -0.004, -1.0, x + 0.01, 0.002, 1.0, WOOD_D, ao=False, shade=False)
    p.box(0, -0.55, 0.85, 4, -0.3, 1.0, WOOD_D, ao=False)
    for x in (0.4, 3.6):
        for z in (-1.3, -2.8):
            p.box(x - 0.1, -12.0, z - 0.1, x + 0.1, 2.15, z + 0.1, WOOD_D)
    for z in (-1.3, -2.8):
        for y in (-11.5, -7.5, -3.5):
            p.beam((0.4, y, z), (3.6, y + 3.5, z), 0.1, 0.1, WOOD_D, ao=False)
    p.box(0, -0.3, -2.9, 4, 0, -1.0, WOOD_D, ao=False)  # the deck runs on behind
    for x in (0.05, 1.0, 2.0, 3.0, 3.95):
        p.box(x - 0.04, 0, -1.02, x + 0.04, 0.95, -0.94, WOOD_D, ao=False)
    p.box(0.0, 0.88, -1.02, 4.0, 0.98, -0.94, WOOD_L, ao=False)
    for x in (0.5, 1.5, 2.5, 3.5):
        p.beam((x - 0.45, 0.1, -0.98), (x + 0.45, 0.85, -0.98), 0.04, 0.03, WOOD_L, ao=False)
    tile_roof(p, 0.0, 4.0, 2.75, 0.1, 2.15, 0.85, flare=0.32, overhang=0.3, zc=-2.05)
    lantern(p, 0.75, 1.75, -1.5, 0.7)
    p.one_way(0, 0, 4, 0)
    return p


def pavilion():
    """The hill pavilion (x 2…18): red-lacquered columns (the two on the plane bullet-only, the back
    ones and their bracing behind it), simple brackets, and a flat-topped tiled roof (盝顶) whose
    paved top is the rooftop deck at 24 m above the lane, its eaves' corners turned up."""
    p = Piece("fs_pavilion", seed=53)
    for x in (-6.0, 6.0):
        p.box(x - 0.2, 0.45, -0.2, x + 0.2, 23.75, 0.2, LACQUER)
        p.box(x - 0.2, 0, -0.4, x + 0.2, 0.45, 0.4, STONE)
        p.box(x - 0.24, 0.0, -3.64, x + 0.24, 23.75, -3.16, WOOD_D)
        p.box(x - 0.3, 0.0, -3.7, x + 0.3, 0.45, -3.1, STONE, ao=False)
        for y in (8.0, 16.0):  # tie beams front to back, as thin as the column on the plane
            p.box(x - 0.12, y, -3.4, x + 0.12, y + 0.35, 0.0, WOOD_D, ao=False)
        # brackets at the column head, front and back (along z only: nothing wider than the column on the plane)
        for z0, z1 in ((0.2, 1.4), (-1.4, -0.2)):
            p.box(x - 0.18, 23.0, z0, x + 0.18, 23.4, z1, GOLD if z0 > 0 else LACQUER, ao=False)
            p.box(x - 0.14, 22.7, min(z0, z1) + 0.3, x + 0.14, 23.0, max(z0, z1) - 0.3, LACQUER, ao=False)
    for y0, y1 in ((0.6, 7.6), (8.4, 15.6)):  # light X bracing between the back columns, low down
        p.beam((-6, y0, -3.45), (6, y1, -3.45), 0.09, 0.09, WOOD_D, ao=False)
        p.beam((-6, y1, -3.45), (6, y0, -3.45), 0.09, 0.09, WOOD_D, ao=False)
    for y in (8.0, 16.0):
        p.box(-6, y, -3.55, 6, y + 0.35, -3.25, WOOD_D, ao=False)
    # the lintel and its gold dots, behind the plane under the deck
    p.box(-6, 22.5, -1.15, 6, 23.3, -0.75, LACQUER, ao=False)
    for k in range(7):
        x = -4.5 + k * 1.5
        p.box(x - 0.18, 22.75, -0.75, x + 0.18, 23.05, -0.7, GOLD, ao=False)
    # the flat paved top, its edge, and the tiled eaves front and back with turned-up corners
    p.box(-8, 23.75, -1.0, 8, 24.0, 1.0, STONE_L)
    for k in range(1, 8):
        x = -8 + k * 2.0
        p.box(x - 0.02, 23.995, -1.0, x + 0.02, 24.002, 1.0, STONE_D, ao=False, shade=False)
    tile_roof(p, -8.0, 8.0, 24.0, 1.0, 23.5, 2.5, flare=0.6, overhang=0.7, ridge=False)
    # a lacquer rail on the deck's back edge, lanterns under the back eave
    for x in (-7.8, -5.2, -2.6, 0.0, 2.6, 5.2, 7.8):
        p.box(x - 0.06, 24.0, -0.98, x + 0.06, 24.8, -0.86, WOOD_D, ao=False)
    p.box(-7.8, 24.72, -0.98, 7.8, 24.84, -0.86, WOOD_D, ao=False)
    for x in (-3.0, 3.0):
        p.box(x - 0.01, 22.3, -1.71, x + 0.01, 23.4, -1.69, (0.2, 0.2, 0.2), ao=False)
        lantern(p, x, 21.9, -1.7, 1.0)
    p.one_way(-8, 24, 8, 24)
    for x in (-6.0, 6.0):
        p.bullet_only(rect(x - 0.2, 0, x + 0.2, 24))
    return p


def viaduct():
    """The monorail's straddle-beam viaduct from the hilltop to the tower (57.5 m): the deck on the
    plane is the beam's walkable top; the beam's body and the pillars' hammerheads stand behind the
    plane; the pillars on the plane are 0.6 m wide and bullet-only."""
    p = Piece("fs_viaduct", seed=59)
    run = 57.5
    p.box(0, -0.25, -1.0, run, 0.0, 1.0, CONCRETE)
    p.box(0, -0.005, -0.42, run, 0.002, 0.42, (0.30, 0.31, 0.31), ao=False, shade=False)
    p.box(0, -0.24, 1.0, run, -0.12, 1.05, CONCRETE_D, ao=False)
    p.box(0, -1.9, -1.5, run, -0.25, -0.5, CONCRETE_B)
    for x, bottom in ((8.5, -9.0), (30.5, -18.0), (43.5, -28.0)):
        p.box(x - 0.3, bottom, -1.5, x + 0.3, -0.25, 0.3, CONCRETE_B)
        p.box(x - 1.3, -2.7, -1.6, x + 1.3, -1.9, -0.5, CONCRETE)
    for k in range(0, int(run), 3):  # the maintenance rail on the back edge
        p.box(k + 0.5 - 0.03, 0, -1.0, k + 0.5 + 0.03, 1.0, -0.94, STEEL, ao=False)
    p.box(0.3, 0.95, -1.0, run, 1.0, -0.94, STEEL, ao=False)
    p.box(0.3, 0.5, -1.0, run, 0.54, -0.94, STEEL, ao=False)
    p.one_way(0, 0, run, 0)
    for x, bottom in ((8.5, -9), (30.5, -18), (43.5, -28)):
        p.bullet_only(rect(x - 0.3, bottom, x + 0.3, 0))
    return p


def bridge():
    """The monorail's arch bridge over the gorge (44 m, tower to tower): the deck on the plane, the
    arch and its spandrel posts behind it, springing from the towers' faces."""
    p = Piece("fs_bridge", seed=61)
    half = 22.0
    p.box(-half, -0.25, -1.0, half, 0.0, 1.0, CONCRETE)
    p.box(-half, -0.75, -1.4, half, -0.25, -0.5, CONCRETE_B)  # the deck's girder, behind the plane
    p.box(-half, -0.005, -0.42, half, 0.002, 0.42, (0.30, 0.31, 0.31), ao=False, shade=False)
    p.box(-half, -0.24, 1.0, half, -0.12, 1.05, CONCRETE_D, ao=False)
    pts = []
    for i in range(17):
        t = -1 + 2 * i / 16
        pts.append((t * half, -13.0 + 12.4 * (1 - t * t)))
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        p.beam((ax, ay, -1.65), (bx, by, -1.65), 0.8, 0.6, CONCRETE_B, ext=0.1)
    for i in range(1, 16, 2):
        x, y = pts[i]
        p.box(x - 0.18, y, -1.8, x + 0.18, -0.45, -1.5, CONCRETE_B, ao=False)
    for k in range(int(2 * half) // 3):
        x = -half + 1.5 + k * 3
        p.box(x - 0.03, 0, -1.0, x + 0.03, 1.0, -0.94, STEEL, ao=False)
    p.box(-half, 0.95, -1.0, half, 1.0, -0.94, STEEL, ao=False)
    p.one_way(-half, 0, half, 0)
    return p


def footbridge():
    """The steel footbridge between the towers' roofs (44 m): a chequer-plate deck on the plane, the
    girder under it and a Warren truss along its back edge (the railing), both behind the plane."""
    p = Piece("fs_footbridge", seed=67)
    half = 22.0
    p.box(-half, -0.3, -1.0, half, 0.0, 1.0, STEEL_G)
    for k in range(44):
        x = -half + 0.5 + k
        p.box(x - 0.04, -0.004, -1.0, x + 0.04, 0.002, 1.0, (0.44, 0.50, 0.48), ao=False, shade=False)
    p.box(-half, -1.0, -1.25, half, -0.3, -0.55, STEEL_G)
    p.box(-half, 1.3, -1.12, half, 1.42, -1.0, STEEL_G, ao=False)
    p.box(-half, 0.0, -1.12, half, 0.12, -1.0, STEEL_G, ao=False)
    k = 0
    x = -half
    while x < half - 0.1:
        p.box(x - 0.05, 0.0, -1.12, x + 0.05, 1.36, -1.0, STEEL_G, ao=False)
        p.beam((x, 0.08 if k % 2 == 0 else 1.34, -1.06), (x + 2.75, 1.34 if k % 2 == 0 else 0.08, -1.06), 0.07, 0.08, STEEL_G, ao=False)
        x += 2.75
        k += 1
    p.box(half - 0.05, 0.0, -1.12, half + 0.0, 1.36, -1.0, STEEL_G, ao=False)
    p.one_way(-half, 0, half, 0)
    return p


# ------------------------------------------------------------------ signs (hanzi_strokes.py: every string and its meaning)

def text_lines(text, size, vertical=False, gap=0.18):
    """`text`'s strokes centred on x 0, its top at y 0."""
    lines = strokes(text, size, gap, vertical)
    n = len(text)
    if vertical:
        return [[(x - size / 2, y) for x, y in s] for s in lines]
    width = n * size + (n - 1) * gap * size
    return [[(x - width / 2, y - size) for x, y in s] for s in lines]


def neon_border(p, x0, y0, x1, y1, z, w, color, r=0.25):
    """A neon tube around a rectangle, its corners cut (bent tube)."""
    pts = [(x0 + r, y0), (x1 - r, y0), (x1, y0 + r), (x1, y1 - r), (x1 - r, y1), (x0 + r, y1), (x0, y1 - r), (x0, y0 + r), (x0 + r, y0)]
    p.tubes([pts], z, w, color)


def blade_cabinet():
    """A vertical blade sign's cabinet (1.6 × 3.3 m) standing off a façade on brackets (the façade's
    face at z 1.0; the cabinet clears its balcony bands and window cages)."""
    p = Piece("fs_blade_cabinet", material=1, seed=71)
    p.box(-0.8, 0, 1.44, 0.8, 3.3, 1.72, BOARD_DARK)
    for a, b in (((-0.8, 0.0), (0.8, 0.06)), ((-0.8, 3.24), (0.8, 3.3)), ((-0.8, 0.0), (-0.74, 3.3)), ((0.74, 0.0), (0.8, 3.3))):
        p.box(a[0], a[1], 1.72, b[0], b[1], 1.76, STEEL, ao=False)
    for y in (0.3, 3.0):
        p.box(-0.5, y - 0.06, 1.0, 0.5, y + 0.06, 1.44, STEEL, ao=False)
    return p


def blade_neon(pid, text, color, border):
    """The neon of a vertical blade: two characters 1.1 m tall and a bent-tube border (layer glow)."""
    p = Piece(pid, layer="glow", seed=73)
    lines = [[(x, y + 3.05) for x, y in s] for s in text_lines(text, 1.1, vertical=True)]
    p.tubes(lines, 1.8, 0.085, color)
    neon_border(p, -0.66, 0.025, 0.66, 3.16, 1.8, 0.05, border, r=0.18)
    p.extras["noFlip"] = True
    return p


def led_panel():
    """An LED panel on a tower's face (6.4 × 3.4 m, layer glow): a dark matrix with 小面 in warm
    white over a row of pink dots."""
    p = Piece("fs_led_panel", layer="glow", seed=79)
    p.box(-3.2, 0, 1.46, 3.2, 3.4, 1.56, LED_PANEL, ao=False, shade=False)
    p.tubes([[(x, y + 3.0) for x, y in s] for s in text_lines("小面", 1.9)], 1.59, 0.16, NEON_WARM, depth=0.04)
    for k in range(15):
        x = -2.8 + k * 0.4
        p.box(x - 0.08, 0.35, 1.56, x + 0.08, 0.51, 1.6, NEON_PINK, ao=False, shade=False)
    p.box(-3.2, 3.3, 1.56, 3.2, 3.4, 1.6, NEON_VIOLET, ao=False, shade=False)
    p.extras["noFlip"] = True
    return p


def lights(pid, x0, x1, n, w=0.12):
    """Ceiling light strips (layer glow): n strips across [x0, x1], just under a ceiling at y 0."""
    p = Piece(pid, layer="glow", seed=83)
    for k in range(n):
        x = x0 + (k + 0.5) * (x1 - x0) / n
        p.box(x - 0.9, -0.06, -0.6, x + 0.9, 0.0, 0.6, LAMP, ao=False, shade=False)
    return p


def board(pid, text, w, h, size, bg, fg, z, layer="gameplay"):
    """A painted shop board (w × h m) with its characters brushed on, its face at depth z."""
    p = Piece(pid, layer=layer, seed=89)
    p.box(-w / 2, 0, z - 0.06, w / 2, h, z, bg)
    for a, b in (((-w / 2, 0.0), (w / 2, 0.05)), ((-w / 2, h - 0.05), (w / 2, h)), ((-w / 2, 0.0), (-w / 2 + 0.05, h)), ((w / 2 - 0.05, 0.0), (w / 2, h))):
        p.box(a[0], a[1], z, b[0], b[1], z + 0.02, fg, ao=False)
    p.tubes([[(x, y + h / 2 + size / 2) for x, y in s] for s in text_lines(text, size)], z + 0.012, 0.1 * size, fg, flat=True)
    p.extras["noFlip"] = True
    return p


# ------------------------------------------------------------------ mid layer: behind the play plane (no collision, hazed)

def lane_houses():
    """Three old shop-houses in a row (18 m) behind a lane: whitewash and timber, tiled pitched roofs
    with turned-up eaves, lanterns, shutters."""
    p = Piece("fs_lane_houses", layer="mid", seed=97)
    rng = p.rng
    for i, (x0, h, col) in enumerate(((-9.0, 6.2, PLASTER), (-3.0, 7.2, WOOD), (3.0, 6.6, PLASTER))):
        x1 = x0 + 6.0
        p.box(x0 + 0.05, 0, -4.0, x1 - 0.05, h, 0.0, col)
        p.box(x0 + 0.05, 0, 0.0, x1 - 0.05, 0.25, 0.3, STONE_D, ao=False)
        if i == 1:
            p.box(x0 + 0.6, 0.25, 0.0, x1 - 0.6, 2.6, 0.05, (0.15, 0.13, 0.11), ao=False)
            for k in range(6):
                p.box(x0 + 0.6 + k * 0.96, 0.25, 0.05, x0 + 0.66 + k * 0.96, 2.6, 0.1, WOOD_L, ao=False)
        else:
            p.box(x0 + 0.6, 0.25, 0.0, x1 - 0.6, 2.5, 0.05, SHUTTER, ao=False)
            for k in range(5):
                p.box(x0 + 0.6, 0.45 + k * 0.42, 0.05, x1 - 0.6, 0.5 + k * 0.42, 0.07, SHUTTER_D, hide="bd", ao=False)
        p.box(x0, 2.7, 0.0, x1, 2.9, 0.9, ROOF_TILE, ao=False)  # waist eave
        for x in (x0 + 1.5, x1 - 1.5):
            p.box(x - 0.6, 3.5, 0.0, x + 0.6, 4.9, 0.06, WINDOW, ao=False)
            for gx in (-0.3, 0.0, 0.3):
                p.box(x + gx - 0.03, 3.5, 0.06, x + gx + 0.03, 4.9, 0.1, WOOD_L, ao=False)
        tile_roof(p, x0, x1, h + 1.6, 0.25, h, 2.6, flare=0.4, overhang=0.35, zc=-2.0, back=False)
        for x in (x0 + 1.0, x1 - 1.0):
            lantern(p, x, 2.2, 0.55, 0.8)
        if rng.random() < 0.6:
            potted(p, x0 + 3.0, 0.25, 0.5, rng)
    return p


def temple_gate():
    """A small temple's gate on the terrace: lacquered columns and lintel, bracket blocks, a blank
    plaque under a grey-tiled roof whose corners and ridge ends turn up, whitewashed side walls with
    their own tiled copings, studded doors standing open, two stone lions on plinths."""
    p = Piece("fs_temple_gate", layer="mid", seed=101)
    p.lift = 1.5  # its side walls' footings run 1.5 m into the ground
    for sx in (-1, 1):
        p.box(sx * 1.75, -1.5, -0.5, sx * 3.0, 3.1, 0.25, PLASTER)
        p.box(sx * 1.75, -1.5, -0.5, sx * 3.0, 0.5, 0.3, STONE_D, ao=False)
        tile_roof(p, min(sx * 1.75, sx * 3.0), max(sx * 1.75, sx * 3.0), 3.55, 0.08, 3.05, 0.6, flare=0.25, overhang=0.2, zc=-0.12, back=False)
        p.box(sx * 1.6 - 0.18, 0, -0.18, sx * 1.6 + 0.18, 4.3, 0.18, LACQUER)
        p.box(sx * 1.6 - 0.28, 0, -0.28, sx * 1.6 + 0.28, 0.4, 0.28, STONE)
        # the door leaves, standing open against the columns
        p.box(sx * 1.4 - 0.08, 0.05, -0.9, sx * 1.4 + 0.08, 3.4, -0.1, (0.36, 0.13, 0.11), ao=False)
        for y in (0.8, 1.6, 2.4):
            p.box(sx * 1.4 - 0.1, y - 0.05, -0.75, sx * 1.4 + 0.1, y + 0.05, -0.25, GOLD, ao=False)
        p.box(sx * 2.4 - 0.3, 0, 0.45, sx * 2.4 + 0.3, 0.65, 1.05, STONE)
        p.blob(sx * 2.4, 0.98, 0.75, 0.26, 0.33, 0.26, STONE_D, segs=6, rings=4)
        p.blob(sx * 2.4, 1.38, 0.83, 0.19, 0.17, 0.17, STONE_D, segs=6, rings=3)
    p.box(-1.6, 3.45, -0.22, 1.6, 3.85, 0.22, LACQUER)
    for x in (-1.1, 0.0, 1.1):  # bracket blocks under the eave
        p.box(x - 0.16, 3.85, -0.18, x + 0.16, 4.15, 0.36, GOLD if x == 0 else LACQUER, ao=False)
    p.box(-0.62, 3.95, 0.37, 0.62, 4.6, 0.43, BOARD_DARK, ao=False)  # the plaque, gilt-framed
    p.box(-0.68, 3.9, 0.36, 0.68, 3.95, 0.45, GOLD, ao=False)
    p.box(-0.68, 4.6, 0.36, 0.68, 4.65, 0.45, GOLD, ao=False)
    p.box(-1.75, 4.15, -0.4, 1.75, 4.4, 0.4, LACQUER, ao=False)
    tile_roof(p, -2.0, 2.0, 5.55, 0.12, 4.55, 1.25, flare=0.55, overhang=0.6)
    for sx in (-1, 1):  # the ridge's ends curl up
        p.beam((sx * 1.85, 5.5, 0.0), (sx * 2.15, 5.95, 0.0), 0.12, 0.2, ROOF_TILE_D, ext=0.05, ao=False)
    for k in range(3):
        p.box(-1.45 - 0.25 * (2 - k), k * 0.14, 0.3, 1.45 + 0.25 * (2 - k), (k + 1) * 0.14, 0.62 + 0.3 * (2 - k), STONE_L, ao=False)
    return p


def noodle_stall():
    """A street noodle stall: a steel cart with a steaming pot, an awning on poles, folding tables
    and plastic stools (yellow, jade, pink)."""
    p = Piece("fs_noodle_stall", layer="mid", seed=103)
    p.box(-1.1, 0.25, -0.5, 1.1, 0.95, 0.5, STEEL)
    for x in (-0.9, 0.9):
        p.cyl(x, 0.14, 0.42, 0.14, 0.08, "z", (0.15, 0.15, 0.15), segs=8)
    p.cyl(-0.45, 1.15, 0.0, 0.3, 0.4, "y", (0.62, 0.62, 0.60), segs=8)
    p.cyl(0.45, 1.05, 0.0, 0.24, 0.2, "y", (0.62, 0.62, 0.60), segs=8)
    steam(p, -0.45, 1.5, 0.35, 1.0)
    for x in (-1.15, 1.15):
        p.box(x - 0.03, 0.95, -0.55, x + 0.03, 2.4, -0.49, STEEL, ao=False)
    p.box(-1.5, 2.4, -1.2, 1.5, 2.5, 0.6, (0.56, 0.62, 0.58), ao=False)
    for k in range(5):
        p.box(-1.5 + k * 0.6, 2.32, 0.55, -1.2 + k * 0.6, 2.5, 0.62, (0.82, 0.80, 0.72), ao=False)
    for tx in (2.6,):
        p.box(tx - 0.55, 0.7, -0.4, tx + 0.55, 0.75, 0.4, (0.80, 0.78, 0.72))
        for lx in (-0.45, 0.45):
            p.box(tx + lx - 0.03, 0, -0.03, tx + lx + 0.03, 0.7, 0.03, STEEL, ao=False)
        for k, (sx, sz) in enumerate(((-0.75, 0.2), (0.75, -0.1))):
            c = STOOL[(k + int(tx)) % 3]
            p.box(tx + sx - 0.17, 0.4, sz - 0.17, tx + sx + 0.17, 0.46, sz + 0.17, c, ao=False)
            p.box(tx + sx - 0.14, 0, sz - 0.14, tx + sx + 0.14, 0.4, sz + 0.14, c, ao=False)
    return p


def sampan():
    """A small wooden river boat with an arched bamboo canopy, moored behind the play plane."""
    p = Piece("fs_sampan", layer="mid", seed=107)
    p.lift = 0.25  # its waterline 0.25 m over its keel
    p.prism_z([(-3.0, 0.7), (3.0, 0.7), (2.4, -0.25), (-2.4, -0.25)], -0.75, 0.75, WOOD_D)
    p.box(-2.8, 0.62, -0.8, 2.8, 0.74, 0.8, WOOD, ao=False)
    p.cyl(0.0, 0.7, 0.0, 0.85, 2.6, "x", (0.36, 0.30, 0.22), segs=10)
    p.box(-1.3, 0.0, -0.9, 1.3, 0.72, 0.9, WOOD_D, ao=False)
    p.beam((2.6, 0.7, 0.3), (4.2, 3.4, 0.3), 0.06, 0.06, BAMBOO, ao=False)
    return p


def barge():
    """A river barge (26 m): a long dark hull, a hold, a white cabin at the stern."""
    p = Piece("fs_barge", layer="mid", seed=109)
    p.lift = 0.4
    p.prism_z([(-13, 1.4), (13, 1.4), (12.2, -0.4), (-12.6, -0.4)], -2.2, 2.2, (0.26, 0.28, 0.29))
    p.box(-10, 1.4, -1.8, 6, 2.2, 1.8, (0.40, 0.42, 0.40))
    p.box(7, 1.4, -1.7, 12, 4.6, 1.7, (0.80, 0.80, 0.76))
    for x in (8.0, 9.6, 11.2):
        p.box(x - 0.45, 3.2, 1.7, x + 0.45, 3.9, 1.74, WINDOW, ao=False)
    p.box(8.0, 4.6, -0.6, 11.0, 5.4, 0.6, (0.72, 0.72, 0.68))
    p.box(9.6, 5.4, -0.06, 9.72, 7.4, 0.06, STEEL, ao=False)
    return p


def stilt_house():
    """A stilted wooden house (diaojiaolou) clinging to the slope behind the stairs: a timber body
    with a lattice gallery, a tiled roof with turned-up eaves, long stilts and braces down the hill."""
    p = Piece("fs_stilt_house", layer="mid", seed=113)
    p.lift = 9.0  # its floor 9 m over the stilts' feet
    rng = p.rng
    p.box(-3.0, 0, -3.0, 3.0, 4.8, 0.0, WOOD)
    for k in range(7):
        x = -2.7 + k * 0.9
        p.box(x - 0.03, 0, 0.0, x + 0.03, 4.8, 0.04, WOOD_D, ao=False)
    p.box(-3.2, -0.2, 0.0, 3.2, 0.0, 1.1, WOOD_D)  # the gallery's floor
    for x in (-3.0, -1.5, 0.0, 1.5, 3.0):
        p.box(x - 0.05, 0.0, 1.0, x + 0.05, 1.0, 1.1, WOOD_D, ao=False)
    p.box(-3.2, 0.95, 1.0, 3.2, 1.05, 1.1, WOOD_L, ao=False)
    for x in (-2.25, -0.75, 0.75, 2.25):
        p.beam((x - 0.6, 0.1, 1.05), (x + 0.6, 0.9, 1.05), 0.04, 0.03, WOOD_L, ao=False)
    for x in (-1.6, 1.6):
        p.box(x - 0.6, 1.8, 0.0, x + 0.6, 3.6, 0.05, WINDOW_WARM if rng.random() < 0.5 else WINDOW, ao=False)
    tile_roof(p, -3.2, 3.2, 6.3, 0.2, 4.8, 2.2, flare=0.45, overhang=0.4, zc=-1.5, back=False)
    for x in (-2.8, 2.8):
        for z in (0.9, -2.8):
            p.box(x - 0.1, -9.0, z - 0.1, x + 0.1, -0.2, z + 0.1, WOOD_D, ao=False)
    for z in (0.9, -2.8):
        for y0 in (-8.5, -4.5):
            p.beam((-2.8, y0, z), (0.0, y0 + 3.8, z), 0.08, 0.08, WOOD_D, ao=False)
            p.beam((2.8, y0, z), (0.0, y0 + 3.8, z), 0.08, 0.08, WOOD_D, ao=False)
    laundry(p, -2.6, 2.6, 2.0, 1.0, rng)
    return p


def roof_back():
    """Rooftop clutter behind a tower's roof: solar water heaters, a stair hut, a dish, a small tank."""
    p = Piece("fs_roof_back", layer="mid", seed=127)
    p.box(-7.5, 0, -4.0, -3.5, 2.6, 0.0, CONCRETE_B)
    p.box(-6.0, 0, 0.0, -5.0, 2.1, 0.03, WOOD_D, ao=False)
    for x in (-1.6, 1.0, 3.6):
        p.prism_x([(0.0, 0.3), (0.0, 0.42), (-1.4, 1.6), (-1.4, 1.48)], x - 1.0, x + 1.0, (0.22, 0.26, 0.32))
        p.cyl(x, 1.7, -1.55, 0.22, 2.0, "x", (0.78, 0.78, 0.76), segs=8)
        p.strut((x - 0.9, 0.05, -0.1), (x - 0.9, 1.6, -1.5), 0.05, STEEL, ao=False)
        p.strut((x + 0.9, 0.05, -0.1), (x + 0.9, 1.6, -1.5), 0.05, STEEL, ao=False)
    p.cyl(6.4, 1.0, -1.2, 0.7, 2.0, "y", (0.70, 0.71, 0.69), segs=10)
    p.cyl(-2.4, 2.9, -3.0, 0.55, 0.06, "z", (0.82, 0.82, 0.80), segs=10)
    p.box(-2.45, 0, -3.1, -2.35, 2.9, -3.0, STEEL, ao=False)
    return p


def viaduct_twin():
    """The monorail's other track, behind (57.5 m beam on pillars), with a hoarding frame standing on
    it (the ad bezel goes on the frame: docs/14, mid depth)."""
    p = Piece("fs_viaduct_twin", layer="mid", seed=131)
    run = 57.5
    p.box(0, -1.9, -1.0, run, 0.0, 0.0, CONCRETE)
    p.box(0, -0.005, -0.8, run, 0.002, -0.2, (0.30, 0.31, 0.31), ao=False, shade=False)
    for x, bottom in ((8.5, -9.6), (30.5, -18.0), (43.5, -28.6)):
        p.box(x - 0.6, bottom, -0.9, x + 0.6, -1.9, -0.1, CONCRETE_B)
        p.box(x - 1.3, -2.7, -1.0, x + 1.3, -1.9, 0.0, CONCRETE)
    return p


def hoarding_frame(width):
    """Steel hangers and a rail that hang a hoarding under a viaduct's beam: the frame's top (local y
    0) meets the beam's underside; the bezel hangs from local y −0.4 down, in front of the hangers."""
    p = Piece(f"fs_hoarding_frame_{int(width)}", layer="mid", material=1, seed=137)
    for x in (-width / 2 + 1.0, 0.0, width / 2 - 1.0):
        p.box(x - 0.12, -3.7, -0.86, x + 0.12, 0.0, -0.62, STEEL, ao=False)
        p.strut((x, -0.05, -0.92), (x, -1.6, -0.62), 0.08, STEEL, ao=False)
    p.box(-width / 2, -0.4, -0.9, width / 2, -0.26, -0.6, STEEL, ao=False)
    return p


def ad_tower():
    """A slim tower behind the play plane (8 m wide, 42 m tall) whose face carries a vertical
    neon-framed cabinet: the Screen's bezel on top (docs/14), a neon blade under it."""
    p = Piece("fs_ad_tower", layer="mid", seed=139)
    rng = p.rng
    p.box(-4.0, 0, -6.0, 4.0, 42.0, -0.6, TILE_WALL)
    for k in range(13):
        y = 1.6 + k * 3.1
        p.box(-4.0, y - 0.25, -0.6, 4.0, y, -0.3, CONCRETE, ao=False)
        for x in (-2.6, 2.6):
            if not 17.0 < y + 0.5 < 30.6:
                window(p, x, y + 0.5, 1.4, 1.4, -0.6, rng.choice(("cage", "plain", "warm")))
    # the cabinet: the blade's box (2 × 4.7 m) under the Screen's backing (the bezel goes at local y 22.5)
    p.box(-1.0, 17.6, -0.6, 1.0, 22.3, -0.05, BOARD_DARK)
    p.box(-4.6, 22.4, -0.6, 4.6, 29.8, -0.55, BOARD_DARK, ao=False)
    return p


def blade_neon_tall(pid, text, color, border):
    """A tall neon blade (layer glow): `text` top to bottom at 1.6 m a character, and a border."""
    p = Piece(pid, layer="glow", seed=149)
    lines = [[(x, y + 4.1) for x, y in s] for s in text_lines(text, 1.6, vertical=True, gap=0.3)]
    p.tubes(lines, 0.04, 0.12, color)
    neon_border(p, -0.9, 0.035, 0.9, 4.4, 0.04, 0.07, border, r=0.25)
    p.extras["noFlip"] = True
    return p


def neon_frame(pid, w, h, color):
    """A neon tube around a Screen's bezel (layer glow): the frame glows, the creative never does."""
    p = Piece(pid, layer="glow", seed=151)
    neon_border(p, -w / 2, 0.05, w / 2, h, 0.16, 0.1, color, r=0.4)
    return p


def led_gantry():
    """A steel gantry on the hillside behind the lower stair, holding an LED Screen high over the steps
    (the bezel goes at local y 14)."""
    p = Piece("fs_led_gantry", layer="mid", material=1, seed=157)
    for x in (-3.6, 3.6):
        p.box(x - 0.18, 0, -0.9, x + 0.18, 20.8, -0.55, STEEL)
        p.box(x - 0.5, 0, -1.2, x + 0.5, 0.5, -0.3, CONCRETE_D, ao=False)
    for y in (4.5, 9.0, 13.5):
        p.box(-3.6, y, -0.85, 3.6, y + 0.16, -0.6, STEEL, ao=False)
        p.beam((-3.6, y - 4.4, -0.72), (3.6, y, -0.72), 0.08, 0.08, STEEL, ao=False)
    return p


# ------------------------------------------------------------------ ad surfaces (docs/14 §2.1, §4.2): mid layer
# A bezel's creative surface is at local z 0 (it faces the camera), the frame lip in front of it, the
# cabinet behind (the Street Market's bezels, build_market_kit.py ad_bezel).

def ad_bezel(pid, w, h, b, kind, fmt, frames):
    p = Piece(pid, layer="mid", material=1, seed=163)
    p.box(-w / 2 - b, 0, -0.6, w / 2 + b, h + 2 * b, -0.05, BEZEL)
    for lo, hi in (((-w / 2 - b, 0, -0.05), (w / 2 + b, b, 0.1)),
                   ((-w / 2 - b, h + b, -0.05), (w / 2 + b, h + 2 * b, 0.1)),
                   ((-w / 2 - b, b, -0.05), (-w / 2, h + b, 0.1)),
                   ((w / 2, b, -0.05), (w / 2 + b, h + b, 0.1))):
        p.box(*lo, *hi, BEZEL, ao=False)
    p.box(-w / 2, b, -0.05, w / 2, h + b, 0.0, HOUSE_ART, ao=False)
    p.extras["adSlot"] = {"kind": kind, "format": fmt, "size": [w, h], "frames": frames, "centre": [0.0, round(b + h / 2, 3), 0.0]}
    return p


# ------------------------------------------------------------------ build

BUILDERS = [
    edge_wall, hill, terrace, quay, riverbed, river,
    lambda: stair("fs_stair_upper", 18.0, -44.0, 191),
    lambda: stair("fs_stair_lower", 20.0, -26.0, 193),
    tower, shophouse, roof_tank, roof_mast, quay_cargo, monorail_car,
    balcony, perch, pavilion, viaduct, bridge, footbridge,
    blade_cabinet,
    lambda: blade_neon("fs_neon_huoguo", "火锅", NEON_PINK, NEON_WARM),
    lambda: blade_neon("fs_neon_lvguan", "旅馆", NEON_WARM, NEON_PINK),
    led_panel,
    lambda: lights("fs_lights_station", -8.6, 8.6, 5),
    lambda: lights("fs_lights_arcade", -8.6, 8.6, 4),
    lambda: board("fs_board_mianguan", "面馆", 2.8, 0.78, 0.56, BOARD_WOOD, GOLD, 1.56),
    lambda: board("fs_board_yaofang", "药房", 3.4, 0.98, 0.72, (0.20, 0.30, 0.25), (0.92, 0.90, 0.84), 1.22),
    lambda: board("fs_board_huoguo", "火锅", 3.0, 0.9, 0.66, BOARD_WOOD, GOLD, -1.3),
    lambda: board("fs_board_xiaomaibu", "小卖部", 3.4, 0.85, 0.6, (0.84, 0.82, 0.74), (0.16, 0.16, 0.17), -1.3),
    lambda: board("fs_board_chaguan", "茶馆", 2.6, 0.8, 0.56, BOARD_DARK, GOLD, 0.98, layer="mid"),
    lambda: board("fs_board_xiaomian", "小面", 1.6, 0.6, 0.42, (0.84, 0.82, 0.74), (0.16, 0.16, 0.17), 0.66, layer="mid"),
    lane_houses, temple_gate, noodle_stall, sampan, barge, stilt_house, roof_back, viaduct_twin,
    lambda: hoarding_frame(18), ad_tower, led_gantry,
    lambda: blade_neon_tall("fs_neon_chaguan_tall", "茶馆", NEON_VIOLET, NEON_PINK),
    lambda: neon_frame("fs_neon_frame_screen", 8.6, 6.6, NEON_FRAME),
    lambda: neon_frame("fs_neon_frame_hoarding", 18.5, 3.5, NEON_FRAME_WARM),
    lambda: ad_bezel("fs_screen_8x6", 8.0, 6.0, 0.3, "screen", "4:3", 6),
    lambda: ad_bezel("fs_hoarding_18x3", 18.0, 3.0, 0.25, "hoarding", "6:1", 1),
]


def main():
    bpy.ops.wm.read_homefile(use_empty=True)
    kit_material()
    total = {"gameplay": 0, "mid": 0, "glow": 0, "far": 0}
    for build in BUILDERS:
        p = build()
        obj = write(p)
        tris = sum(len(f) - 2 for f in p.faces)
        total[p.layer] += tris
        ex = p.extras
        print(f"[build_fog_stair_kit] {p.pid:26s} {tris:6d} tris  layer {p.layer:8s} solids {len(ex['solids'])} oneWays {len(ex['oneWays'])}"
              f" bulletOnly {len(ex.get('bulletOnly', []))}" + ("  adSlot" if "adSlot" in ex else "") + ("  noFlip" if ex.get("noFlip") else ""))
        assert obj.name == p.pid, (obj.name, p.pid)
    print(f"[build_fog_stair_kit] pieces {len(BUILDERS)}; tris per piece (one each) {total}")
    export(OUT, runtime=False)
    if RUNTIME:
        export(RUNTIME, runtime=True)


def export(path, runtime):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_yup=True, export_apply=True, export_extras=True,
        export_vertex_color="ACTIVE", export_materials="EXPORT", export_normals=True, export_texcoords=False,
        export_animations=False, export_cameras=False, export_lights=False, export_meshopt_compression_enable=runtime,
    )
    print(f"[build_fog_stair_kit] wrote {path} ({path.stat().st_size / 1024:.0f} KB)")


main()
