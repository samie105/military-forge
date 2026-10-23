"""Tops and trousers (docs/04 §3) built on a base body, for build_cosmetics.py (Blender + numpy).

A garment replaces a stretch of the body: the body's `_REGION` faces (build_character.py 6b) for its region, which
the assembler hides when the garment's manifest says `hidesBody: [region]`. Each body LOD gets its own garment,
made from that LOD's own region faces, so it fits each body and LOD exactly:

1. the region's faces (all three vertices in it), smoothed (Taubin, so it keeps its volume) with the vertices on
   its edge pinned: pouches and webbing flatten into cloth;
2. pushed out by the garment's thickness;
3. a hem band over the body's border faces (the strip between the region and the skin or the next region that
   stays drawn): their region-side vertices are the garment's own, their far side stands 3 mm off the body, so
   collars, cuffs and waistbands sit proud and the strip never shows through;
4. long sleeves (tubes down the forearm to the wrist), pockets, plates, pads and the team armband (the accent dye,
   glowing in the team colour: docs/04 §1.4), placed on the garment's surface;
5. skin weights: every vertex takes those of the body vertex it came from (pieces: the nearest), so it bends
   exactly like the body under it;
6. the caller decimates it (hem vertices pinned: the `_free` vertex group) to the triangles of the body it hides,
   so a dressed soldier stays in budget.

Colours: `Col` (albedo), `Dye` (R primary, G secondary, B accent) and `Glow` (R: team glow) corner attributes, plus
`kind` per face (0 cloth, 1 hem, 2 piece, 10+ a tube with its own painter), so the caller can repaint the cloth and
tubes finely (prints, stripes, cuffs) on a subdivided copy before baking.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.geometry import intersect_point_line
from mathutils.kdtree import KDTree

REGIONS = {"hair": 1, "top": 2, "legs": 3}  # build_character.py REGIONS
HEM_LIFT = 0.003  # m: a hem band's far edge off the body
P, S, A, N = (1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def dominant(obj):
    names = {g.index: g.name for g in obj.vertex_groups}
    return {v.index: names[max(v.groups, key=lambda g: g.weight).group] for v in obj.data.vertices if v.groups}


def nearest_on_bones(p, bones):
    """(bone name, parameter along it, closest point) of the nearest bone segment to p."""
    best = None
    for b in bones:
        q, t = intersect_point_line(p, b.head_local, b.tail_local)
        t = min(max(t, 0.0), 1.0)
        q = b.head_local.lerp(b.tail_local, t)
        d = (p - q).length
        if best is None or d < best[0]:
            best = (d, b.name, t, q)
    return best[1], best[2], best[3]


class Garment:
    """One garment on one body LOD, assembled in a bmesh with per-face colours and per-vertex source weights."""

    def __init__(self, src, arm, region):
        self.src, self.arm, self.code = src, arm, REGIONS[region]
        self.bm = bmesh.new()
        self.colour = {}  # face -> (rgb, dye channel, glow, kind)
        self.weights = {}  # vert -> {bone: weight}
        self.free = set()  # the cloth's interior: the only vertices decimation may move
        self.painters = {}  # kind -> colour(p, n): how the caller repaints those faces finely (0 = the cloth)
        self.region_bones = [b for b in arm.data.bones if b.use_deform]
        me = src.data
        names = {g.index: g.name for g in src.vertex_groups}
        self.src_w = [{names[g.group]: g.weight for g in v.groups} for v in me.vertices]
        code = [round(d.value) for d in me.attributes["_REGION"].data]
        inr = [c == self.code for c in code]
        self.hidden = [p for p in me.polygons if all(inr[i] for i in p.vertices)]
        self.border = [p for p in me.polygons if any(inr[i] for i in p.vertices) and not all(inr[i] for i in p.vertices)]
        self.inr = inr
        me.calc_loop_triangles()
        self.hidden_tris = sum(1 for t in me.loop_triangles if all(inr[i] for i in t.vertices))

    # ---------------------------------------------------------------- the cloth: region faces, smoothed, thickened

    def cloth(self, thick, colour, iters=24, lam=0.5, mu=-0.53):
        """The region's faces, smoothed with their edge pinned and pushed out by `thick(p)` m. colour(p, n) ->
        (rgb, dye channel[, glow]) per face. Returns {body vertex index: garment vert} for the region's vertices."""
        me, bm = self.src.data, self.bm
        vmap = {}
        for p in self.hidden:
            for i in p.vertices:
                if i not in vmap:
                    vmap[i] = bm.verts.new(self.src.matrix_world @ me.vertices[i].co)
                    self.weights[vmap[i]] = dict(self.src_w[i])
            try:
                f = bm.faces.new([vmap[i] for i in p.vertices])
                self.colour[f] = None
            except ValueError:
                pass
        border_verts = {i for p in self.border for i in p.vertices if self.inr[i]}
        edge = {vmap[i] for i in border_verts if i in vmap} | {v for v in vmap.values() if v.is_boundary}
        self.free = set(vmap.values()) - edge
        self.painters[0] = colour
        # consistent normals, then outward as a whole (away from the bones the region follows)
        faces = list(self.colour)
        bmesh.ops.recalc_face_normals(bm, faces=faces)
        bm.normal_update()
        away = sum(v.normal.dot(v.co - nearest_on_bones(v.co, self.region_bones)[2]) for v in vmap.values())
        if away < 0:
            bmesh.ops.reverse_faces(bm, faces=faces)
            bm.normal_update()
        # Taubin smoothing: alternate shrink (lam) and inflate (mu) so the volume stays; the edge stays put
        verts = list(vmap.values())
        nbr = {v: [e.other_vert(v) for e in v.link_edges] for v in verts}
        free = [v for v in verts if v not in edge]
        for k in range(iters * 2):
            f = lam if k % 2 == 0 else mu
            new = {v: v.co + f * (sum((o.co for o in nbr[v]), Vector()) / len(nbr[v]) - v.co) for v in free if nbr[v]}
            for v, c in new.items():
                v.co = c
        bm.normal_update()
        for v in verts:
            v.co = v.co + v.normal * thick(v.co)
        bm.normal_update()
        for f in faces:
            self.colour[f] = self._paint(colour(f.calc_center_median(), f.normal), 0)
        self.vmap = vmap
        return vmap

    def hems(self, colour, lift=HEM_LIFT):
        """A band over the body's border faces: their region vertices are the cloth's, the others stand `lift` off
        the body (and are pinned for decimation)."""
        me, bm = self.src.data, self.bm
        outer = {}
        for p in self.border:
            vs = []
            for i in p.vertices:
                if i in self.vmap:
                    vs.append(self.vmap[i])
                    continue
                if i not in outer:
                    v = me.vertices[i]
                    n = v.normal
                    q = self.src.matrix_world @ v.co
                    if n.dot(q - nearest_on_bones(q, self.region_bones)[2]) < 0:
                        n = -n
                    outer[i] = bm.verts.new(q + n * lift)
                    self.weights[outer[i]] = dict(self.src_w[i])
                vs.append(outer[i])
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            self.colour[f] = self._paint(colour(f.calc_center_median(), f.normal), 1)
        bm.normal_update()
        return outer

    # ---------------------------------------------------------------- pieces

    def _paint(self, c, kind):
        rgb, ch = c[0], c[1]
        glow = c[2] if len(c) > 2 else 0.0
        return (tuple(rgb), tuple(ch), glow, kind)

    def piece(self, geom_faces, rgb, ch, glow=0.0):
        for f in geom_faces:
            self.colour[f] = (tuple(rgb), tuple(ch), glow, 2)

    def surface(self, origin, direction):
        """Where a ray from `origin` along `direction` meets the garment so far: (point, normal) or None."""
        from mathutils.bvhtree import BVHTree
        tree = BVHTree.FromBMesh(self.bm)
        hit = tree.ray_cast(Vector(origin), Vector(direction).normalized(), 3.0)
        return (hit[0], hit[1]) if hit[0] is not None else None

    def box(self, centre, size, normal, rgb, ch, up=(0, 0, 1), glow=0.0):
        """A box `size` (width, height, depth) whose back face lies on the surface at `centre`, facing `normal`."""
        nz = Vector(normal).normalized()
        ux = Vector(up).cross(nz)
        if ux.length < 1e-4:
            ux = Vector((1, 0, 0))
        ux.normalize()
        uy = nz.cross(ux)
        m = Matrix((ux, uy, nz)).transposed().to_4x4()
        m.translation = Vector(centre) + nz * (size[2] / 2 - 0.002)
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m @ Matrix.Diagonal((size[0], size[1], size[2], 1)))
        faces = list({f for v in res["verts"] for f in v.link_faces})
        self.piece(faces, rgb, ch, glow)
        return res["verts"]

    def ellipsoid(self, centre, radii, rgb, ch, segs=10, rings=6, rot=None):
        m = (rot.to_4x4() if rot is not None else Matrix.Identity(4)) @ Matrix.Diagonal((*radii, 1))
        m.translation = Vector(centre)
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=rings, radius=1.0, matrix=m)
        faces = list({f for v in res["verts"] for f in v.link_faces})
        self.piece(faces, rgb, ch)
        return res["verts"]

    def cylinder(self, a, b, r, rgb, ch, segs=8, r2=None, caps=True):
        a, b = Vector(a), Vector(b)
        d = b - a
        z = d.normalized()
        x = z.orthogonal().normalized()
        y = z.cross(x)
        m = Matrix((x, y, z)).transposed().to_4x4()
        m.translation = (a + b) / 2
        res = bmesh.ops.create_cone(self.bm, cap_ends=caps, segments=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=d.length, matrix=m)
        faces = list({f for v in res["verts"] for f in v.link_faces})
        self.piece(faces, rgb, ch)
        return res["verts"]

    def tube(self, axis, radius, rgb, ch, segs=8, colour=None):
        """An open tube through the points of `axis` with a radius per point (a sleeve, a trouser cuff), or a list of
        `segs` radii per point (a ring that follows the cloth, ring_frame's directions). Its vertices take the weights
        of the nearest body vertex (weigh_pieces)."""
        bm = self.bm
        rings = []
        for k, (c, r) in enumerate(zip(axis, radius)):
            x, y = ring_frame(axis, k)
            rr = r if isinstance(r, (list, tuple)) else [r] * segs
            rings.append([bm.verts.new(c + (x * math.cos(2 * math.pi * j / segs) + y * math.sin(2 * math.pi * j / segs)) * rr[j])
                          for j in range(segs)])
        faces = []
        for r0, r1 in zip(rings, rings[1:]):
            for j in range(segs):
                faces.append(bm.faces.new((r0[j], r0[(j + 1) % segs], r1[(j + 1) % segs], r1[j])))
        kind = 2
        if colour:  # its own painter, so the caller repaints it finely (cuffs, camo) like the cloth
            kind = 10 + sum(1 for k in self.painters if k >= 10)
            self.painters[kind] = colour
        for f in faces:
            c = colour(f.calc_center_median(), None) if colour else (rgb, ch)
            self.colour[f] = self._paint(c, kind)
        bm.normal_update()
        # outward normals: away from the axis
        for f in faces:
            k = min(range(len(axis)), key=lambda i: (axis[i] - f.calc_center_median()).length)
            if f.normal.dot(f.calc_center_median() - axis[k]) < 0:
                f.normal_flip()
        return rings

    # ---------------------------------------------------------------- finish

    def weigh_pieces(self):
        """Pieces and tubes take the weights of the nearest body vertex."""
        me = self.src.data
        kd = KDTree(len(me.vertices))
        for v in me.vertices:
            kd.insert(self.src.matrix_world @ v.co, v.index)
        kd.balance()
        for v in self.bm.verts:
            if v not in self.weights:
                self.weights[v] = dict(self.src_w[kd.find(v.co)[1]])

    def to_object(self, name, scene):
        """The garment as a mesh object: Col / Dye / Glow corner colours, `kind` per face, vertex groups."""
        self.weigh_pieces()
        bm = self.bm
        bm.verts.index_update()
        bm.faces.index_update()
        me = bpy.data.meshes.new(name)
        order = list(bm.faces)
        bm.to_mesh(me)
        o = bpy.data.objects.new(name, me)
        scene.collection.objects.link(o)
        col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        dye = me.color_attributes.new("Dye", "BYTE_COLOR", "CORNER")
        glow = me.color_attributes.new("Glow", "BYTE_COLOR", "CORNER")
        kind = me.attributes.new("kind", "INT", "FACE")
        for f, poly in zip(order, me.polygons):
            rgb, ch, g, k = self.colour.get(f) or ((0.5, 0.5, 0.5), N, 0.0, 0)
            up = 1.06 if poly.normal.z > 0.6 else (0.9 if poly.normal.z < -0.6 else 1.0)
            c = [srgb_to_linear(min(1.0, x * up)) for x in rgb]
            for li in poly.loop_indices:
                col.data[li].color = (*c, 1.0)
                dye.data[li].color = (*[float(x) for x in ch], 0.0)
                glow.data[li].color = (g, g, g, 1.0)
            kind.data[poly.index].value = k
        for b in self.arm.data.bones:
            if b.use_deform:
                o.vertex_groups.new(name=b.name)
        for v in bm.verts:
            w = self.weights[v]
            top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
            tot = sum(x for _, x in top) or 1.0
            for name, x in top:
                o.vertex_groups[name].add([v.index], x / tot, "REPLACE")
        free = o.vertex_groups.new(name="_free")  # decimation may move these: the cloth's interior, nothing else
        free.add([v.index for v in bm.verts if v in self.free], 1.0, "REPLACE")
        bm.free()
        return o


# ---------------------------------------------------------------- patterns (procedural, original)

def _hash(i, j):
    """A repeatable pseudo-random number in [0, 1) per integer cell."""
    h = (i * 374761393 + j * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65536.0


def wax_print(u, v, ground, ring, dot, leaf):
    """A bold original wax-style print on a (u, v) plane in metres: big concentric discs on a staggered grid with
    leaf shapes between them. Returns an sRGB colour."""
    cell = 0.075
    gi, gj = math.floor(u / cell), math.floor(v / cell)
    for di in (0, 1):
        for dj in (0, 1):
            i, j = gi + di, gj + dj
            cx, cy = (i + 0.5 * (j % 2)) * cell, j * cell
            r = math.hypot(u - cx, v - cy) / cell
            if r < 0.42:
                return dot if r < 0.12 else ring if r < 0.24 else dot if r < 0.3 else ring
    # leaves: an ellipse turned by the cell, between the discs
    lx, ly = (u / cell - gi - 0.25), (v / cell - gj - 0.5)
    a = _hash(gi, gj) * math.pi
    x, y = lx * math.cos(a) + ly * math.sin(a), -lx * math.sin(a) + ly * math.cos(a)
    if (x / 0.22) ** 2 + (y / 0.08) ** 2 < 1:
        return leaf
    return ground


def camo(p, light, dark, mid, scale=0.07):
    """Blocky urban camouflage in 3D (so it wraps a leg seamlessly): two layers of axis-aligned cells."""
    for k, (s, col, thr) in enumerate(((scale, dark, 0.62), (scale * 0.6, mid, 0.55))):
        i, j, l = (math.floor((p[n] + k * 0.031) / s) for n in range(3))
        if _hash(i * 7 + l, j * 13 - l) > thr:
            return col
    return light


# ---------------------------------------------------------------- the garments (original designs: art/README.md)

OLIVE, OLIVE_D, SAND_P, CHAR, MUSTARD = (0.38, 0.40, 0.24), (0.25, 0.27, 0.16), (0.82, 0.74, 0.54), (0.20, 0.21, 0.22), (0.82, 0.60, 0.15)
CREAM, TERRA, INDIGO, COYOTE, COYOTE_D = (0.90, 0.86, 0.76), (0.68, 0.30, 0.19), (0.15, 0.19, 0.38), (0.62, 0.50, 0.34), (0.44, 0.35, 0.24)
STONE, STONE_D, BRASS, TEAL, BROWN, GREY_D = (0.58, 0.57, 0.52), (0.40, 0.40, 0.37), (0.76, 0.60, 0.30), (0.16, 0.66, 0.66), (0.30, 0.20, 0.12), (0.30, 0.30, 0.30)
LEAF = (0.86, 0.74, 0.38)


class Ctx:
    """The body a garment is built on: its skeleton (bones in rest pose, Blender axes: -Y front, +Z up) and LOD."""

    def __init__(self, arm, src, lod1):
        self.arm, self.src, self.lod1 = arm, src, lod1
        self.B = arm.data.bones

    def at(self, bone, t=0.0):
        b = self.B[bone]
        return b.head_local.lerp(b.tail_local, t)

    def armband(self, p):
        """On the left upper arm's band (docs/04 §1.4: the team glows there)."""
        b = self.B["upperarm_L"]
        q, t = intersect_point_line(p, b.head_local, b.tail_local)
        return 0.30 < t < 0.58 and p.x > 0.10 and (p - q).length < 0.14


def _radius_about(src, a, b, centre, reach, allowed):
    """Largest distance from the line a-b of the body vertices (mostly skinned to `allowed` bones) whose projection
    falls within `reach` of `centre` along it."""
    names = {g.index: g.name for g in src.vertex_groups}
    d = (b - a).normalized()
    best = 0.0
    for v in src.data.vertices:
        if not v.groups or names[max(v.groups, key=lambda g: g.weight).group] not in allowed:
            continue
        p = src.matrix_world @ v.co
        if abs((p - centre).dot(d)) > reach:
            continue
        best = max(best, ((p - a) - d * (p - a).dot(d)).length)
    return best


def ring_frame(axis, k):
    """The two directions a tube's ring k spans (Garment.tube)."""
    d = (axis[min(k + 1, len(axis) - 1)] - axis[max(k - 1, 0)]).normalized()
    x = d.orthogonal().normalized()
    return x, d.cross(x)


def cloth_ring(g, axis, k, at, segs, reach=0.2):
    """How far the cloth is from `at` in each direction of a tube's ring k, by rays outward. A ray that finds no
    cloth within `reach` (a gap, the other leg) takes the median of the others."""
    x, y = ring_frame(axis, k)
    out = []
    for j in range(segs):
        a = 2 * math.pi * j / segs
        hit = g.surface(at, x * math.cos(a) + y * math.sin(a))
        out.append((hit[0] - at).length if hit and (hit[0] - at).length < reach else None)
    known = sorted(r for r in out if r is not None)
    fill = known[len(known) // 2] if known else 0.09
    return [fill if r is None else r for r in out]


SLEEVE_R_MAX = 0.075  # m: a chibi arm's widest, at the shoulder


def sleeves(g, k, thick, rgb, ch, to=1.0, cuff=None, rolled=False):
    """Long sleeves: a tube on each arm from where the cloth ends on the upper arm, past the elbow, down the forearm
    (to `to` of it: 1 = the wrist), wide enough for the arm inside plus `thick`; `cuff` paints the last ring band."""
    segs = 6 if k.lod1 else 8
    for s in "LR":
        ua, fa = k.B[f"upperarm_{s}"], k.B[f"forearm_{s}"]
        # where the cloth ends on this arm: the lowest point along the upper arm of its cloth vertices
        ts = [intersect_point_line(v.co, ua.head_local, ua.tail_local)[1] for v in g.vmap.values()
              if (v.co.x > 0) == (s == "L") and max(g.weights[v], key=g.weights[v].get) == f"upperarm_{s}"]
        t0 = max(0.3, min(0.9, max(ts) - 0.12)) if ts else 0.6
        pts = [ua.head_local.lerp(ua.tail_local, t0), ua.tail_local, fa.head_local.lerp(fa.tail_local, to * 0.5),
               fa.head_local.lerp(fa.tail_local, to)]
        if k.lod1:
            pts = [pts[0], pts[1], pts[3]]
        # the arm's own vertices only: the shoulder's (clavicle) reach into the chest, and made the first ring a flare
        allowed = {f"upperarm_{s}", f"forearm_{s}"}
        radii = [min(SLEEVE_R_MAX, _radius_about(k.src, ua.head_local if i == 0 else fa.head_local,
                                                 ua.tail_local if i == 0 else fa.tail_local, p, 0.035, allowed)) + thick
                 for i, p in enumerate(pts)]
        radii[0] += 0.006  # over the cloth's hem at the cuff
        def colour(c, n, last=pts[-1]):
            if cuff and (c - last).length < (0.035 if not rolled else 0.05):
                return cuff
            return (rgb, ch, 1.0) if k.armband(c) else (rgb, ch)
        g.tube(pts, radii, rgb, ch, segs=segs, colour=colour)


def waist_skirt(g, k, rgb, ch, drop=0.04, margin=0.022):
    """A jacket's hem hanging over the waistband: two rings round the spine below the cloth's lower edge, outside
    any trousers (their cloth stands at most 1 cm off the body)."""
    segs = 8 if k.lod1 else 12
    zs = sorted(v.co.z for v in g.vmap.values())
    z_w = zs[int(len(zs) * 0.02)]  # the cloth's lowest band
    c = k.at("pelvis", 1.0)
    names = {gr.index: gr.name for gr in k.src.vertex_groups}
    pts = [k.src.matrix_world @ v.co for v in k.src.data.vertices
           if abs((k.src.matrix_world @ v.co).z - z_w) < 0.04 and v.groups
           and names[max(v.groups, key=lambda gg: gg.weight).group] in ("pelvis", "spine1", "thigh_L", "thigh_R")]
    rings = []
    for z, extra in ((z_w + 0.02, 0.0), (z_w - drop, 0.01)):
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            d = Vector((math.sin(a), -math.cos(a), 0))
            r = max([((p - c) * Vector((1, 1, 0))).dot(d) for p in pts
                     if ((p - c) * Vector((1, 1, 0))).normalized().dot(d) > math.cos(math.pi / segs)] or [0.15])
            ring.append(g.bm.verts.new(Vector((c.x, c.y, z)) + d * (r + margin + extra)))
        rings.append(ring)
    faces = [g.bm.faces.new((rings[0][j], rings[0][(j + 1) % segs], rings[1][(j + 1) % segs], rings[1][j])) for j in range(segs)]
    g.piece(faces, rgb, ch)
    g.bm.normal_update()
    for f in faces:
        if f.normal.dot(f.calc_center_median() - Vector((c.x, c.y, f.calc_center_median().z))) < 0:
            f.normal_flip()


def front(g, x, z, back=False):
    """Where the cloth's front (or back) is at (x, z): (point, outward normal)."""
    hit = g.surface((x, 1.0 if back else -1.0, z), (0, -1.0 if back else 1.0, 0))
    return hit if hit else (Vector((x, 0.1 if back else -0.1, z)), Vector((0, 1.0 if back else -1.0, 0)))


def flat_front(g, x, z, w, h, back=False):
    """Where a rigid plate w × h centred at (x, z) sits on the cloth's front (or back): (point, normal). Rays over
    its whole footprint find the outermost cloth, so a lump under it (the Rookie's moulded pack, a chest) stays
    behind the plate instead of poking through, as a ray at its centre alone let it."""
    axis = Vector((0, 1.0 if back else -1.0, 0))
    hits = [g.surface((x + u * w * 0.45, axis.y, z + v * h * 0.45), -axis)
            for u in (-1, -0.5, 0, 0.5, 1) for v in (-1, -0.5, 0, 0.5, 1)]
    hits = [hit for hit in hits if hit]
    p, _ = front(g, x, z, back)
    if not hits:
        return p, axis
    tilt = sum(hit[1].z for hit in hits) / len(hits)  # the torso's slope, a little: a lump's top must not tip it up
    n = Vector((0, axis.y, max(-0.2, min(0.2, tilt)))).normalized()
    return p + n * (max(0.0, max((hit[0] - p).dot(n) for hit in hits)) + 0.003), n


def pocket(g, k, x, z, size, rgb, ch, flap=None, back=False):
    p, n = front(g, x, z, back)
    g.box(p, size, n, rgb, ch)
    if flap and not k.lod1:
        g.box(p + Vector((0, 0, size[1] * 0.5)), (size[0] * 1.08, size[1] * 0.32, size[2] + 0.006), n, flap, ch)


def outer_side(g, k, side, z, back=False):
    """The outer side of a leg at height z: (point, normal), by a ray from outside along x."""
    s = 1 if side == "L" else -1
    hit = g.surface((s * 1.0, k.at(f"thigh_{side}").y, z), (-s, 0, 0))
    return hit if hit else (Vector((s * 0.2, 0, z)), Vector((s, 0, 0)))


# Each style: region, cloth thickness (m), smoothing passes, cloth colour(c, n), hem colour, pieces(g, k).

def _tee(k):
    zc = k.at("spine2", 0.7).z
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        if n.y < -0.5 and abs(c.x) < 0.05:
            for z0 in (zc, zc - 0.022):
                if abs((c.z - z0) + 0.65 * abs(c.x)) < 0.007:
                    return SAND_P, S
        return OLIVE, P
    return colour


def _hoodie(k):
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        if n.y < -0.35 and abs(c.x) < 0.13 and c.z < k.at("spine2", 0.9).z:
            return MUSTARD, S  # the front panel
        return CHAR, P
    return colour


def _hoodie_pieces(g, k):
    sleeves(g, k, 0.014, CHAR, P, cuff=(GREY_D, P))
    waist_skirt(g, k, CHAR, P)
    pocket(g, k, 0.0, k.at("spine1", 0.55).z, (0.17, 0.075, 0.012), MUSTARD, S)
    # the hood, down round the back of the neck: one soft roll
    nk = k.at("neck", 0.2)
    g.ellipsoid(nk + Vector((0, 0.07, -0.01)), (0.15, 0.06, 0.05), CHAR, P, segs=6 if k.lod1 else 8, rings=4 if k.lod1 else 5)
    if not k.lod1:
        for s in (-1, 1):
            p, n = front(g, s * 0.035, nk.z - 0.06)
            g.cylinder(p + Vector((0, -0.006, 0)), p + Vector((0, -0.01, -0.09)), 0.006, CREAM, N, segs=4, caps=False)


def _jersey(k):
    zv = k.at("neck").z - 0.11
    zl, zh = k.at("spine1", 0.3).z, k.at("spine2", 0.95).z
    def tri(x):
        return abs((x / 0.035) % 2 - 1) * 2 - 1
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        if n.y < -0.3 and c.z > zv and abs(abs(c.x) - (c.z - zv) * 0.55) < 0.01:
            return TERRA, S  # the V neck's trim
        on_arm = abs(c.x) > 0.2
        u = c.z + 0.012 * tri(c.y if on_arm else c.x)
        if (zl < c.z < zh or on_arm) and abs((u % 0.075) - 0.0375) < 0.011:
            return TERRA, S
        return CREAM, P
    return colour


def _print_shirt(k):
    cy = k.at("spine2").y
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        u = math.atan2(c.x, -(c.y - cy)) * 0.16
        return wax_print(u, c.z, INDIGO, MUSTARD, TERRA, LEAF), N
    return colour


def _print_pieces(g, k):
    nk = k.at("neck", 0.1)
    for s in (-1, 1):  # the camp collar's two points
        p, n = front(g, s * 0.05, nk.z - 0.025)
        g.box(p, (0.06, 0.05, 0.008), n, INDIGO, N, up=(s * 0.4, 0, 1))
    if not k.lod1:
        for i in range(4):
            p, n = front(g, 0.0, nk.z - 0.07 - i * 0.05)
            g.box(p, (0.012, 0.012, 0.006), n, CREAM, N)


def _bomber(k):
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        if n.y < -0.5 and abs(c.x) < 0.007:
            return BRASS, N  # the zip
        return OLIVE, P
    return colour


def _bomber_pieces(g, k):
    sleeves(g, k, 0.018, OLIVE, P, cuff=(CHAR, S))
    waist_skirt(g, k, CHAR, S, drop=0.03)
    nk = k.at("neck", 0.15)
    segs = 6 if k.lod1 else 10
    ring = [nk + Vector((math.sin(2 * math.pi * j / segs) * 0.13, -math.cos(2 * math.pi * j / segs) * 0.12 + 0.01, -0.035))
            for j in range(segs + 1)]
    g.tube(ring, [0.022] * len(ring), CHAR, S, segs=3 if k.lod1 else 4)  # the ribbed collar
    if not k.lod1:  # the sleeve pocket on the left arm
        ua = k.B["upperarm_L"]
        p = ua.head_local.lerp(ua.tail_local, 0.45)
        hit = g.surface(p + Vector((0.3, -0.05, 0.05)), Vector((-1, 0.15, -0.15)))
        if hit:
            g.box(hit[0], (0.045, 0.06, 0.01), hit[1], OLIVE_D, P)


def _carrier(k):
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        return SAND_P, N  # the shirt under the vest
    return colour


def _carrier_pieces(g, k):
    zc = k.at("spine2", 0.45).z
    for back in (False, True):
        p, n = flat_front(g, 0.0, zc, 0.25, 0.24, back)
        g.box(p, (0.25, 0.24, 0.02), n, COYOTE, P)
        if not back and k.lod1:  # LOD1: the three pouches as one strip
            q, m = front(g, 0.0, zc - 0.07)
            g.box(q + m * 0.016, (0.2, 0.085, 0.024), m, COYOTE_D, S)
        elif not back:
            for x in (-0.07, 0.0, 0.07):
                q, m = front(g, x, zc - 0.07)
                g.box(q + m * 0.016, (0.06, 0.085, 0.024), m, COYOTE_D, S)
        elif not k.lod1:
            q, m = front(g, 0.0, zc + 0.13, True)
            g.box(q + m * 0.016, (0.08, 0.02, 0.016), m, COYOTE_D, S)  # the grab handle
    for s in (-1, 1):  # the shoulder straps, front plate to back plate over the shoulder
        top = k.at(f"clavicle_{'L' if s > 0 else 'R'}", 0.55)
        for y in ((0.0,) if k.lod1 else (-0.09, 0.0, 0.09)):
            o = Vector((top.x, top.y + y, top.z + 0.4))
            hit = g.surface(o, (0, 0, -1))
            if hit:
                g.box(hit[0], (0.07, 0.22 if k.lod1 else 0.08, 0.02), hit[1], COYOTE, P, up=(0, 1, 0))
    for s in ("L", "R") if not k.lod1 else ():  # the side straps under the arms
        z = k.at("spine2", 0.2).z
        hit = g.surface(((1 if s == "L" else -1) * 1.0, k.at("spine2").y, z), ((-1 if s == "L" else 1), 0, 0))
        if hit:
            g.box(hit[0], (0.12, 0.05, 0.015), hit[1], COYOTE_D, S, up=(0, 0, 1))


def _field_jacket(k):
    zw = k.at("spine1", 0.1).z
    def colour(c, n):
        if k.armband(c):
            return TEAL, A, 1.0
        if abs(c.z - zw) < 0.008:
            return STONE_D, S  # the drawstring channel
        return STONE, P
    return colour


def _field_pieces(g, k):
    sleeves(g, k, 0.014, STONE, P, to=0.55, cuff=(STONE_D, P), rolled=True)
    waist_skirt(g, k, STONE, P, drop=0.05)
    zc, zh = k.at("spine2", 0.55).z, k.at("spine1", 0.45).z
    for s in (-1, 1):
        pocket(g, k, s * 0.09, zh, (0.085, 0.085, 0.014), STONE, P, flap=STONE_D)
        if k.lod1:  # LOD1: the hip pockets only
            continue
        pocket(g, k, s * 0.075, zc, (0.075, 0.075, 0.012), STONE, P, flap=STONE_D)
        p, n = front(g, s * 0.055, k.at("neck", 0.1).z - 0.03)
        g.box(p, (0.07, 0.055, 0.01), n, STONE_D, S, up=(s * 0.5, 0, 1))  # the collar points


def _combat(k):
    def colour(c, n):
        return OLIVE, P
    return colour


def _combat_pieces(g, k):
    for s in ("L", "R"):
        th, ca = k.B[f"thigh_{s}"], k.B[f"calf_{s}"]
        p, n = outer_side(g, k, s, th.head_local.lerp(th.tail_local, 0.55).z)
        g.box(p, (0.075, 0.09, 0.022), n, OLIVE_D, S, up=(0, 0, 1))  # cargo pockets
        kn = ca.head_local + Vector((0, -0.02, 0.005))
        hit = g.surface(Vector((kn.x, -1.0, kn.z)), (0, 1, 0))
        if hit and k.lod1:
            g.box(hit[0], (0.09, 0.1, 0.024), hit[1], GREY_D, S)
        elif hit:
            g.ellipsoid(hit[0] + hit[1] * 0.012, (0.05, 0.026, 0.055), GREY_D, S, segs=8, rings=4)


def _joggers(k):
    def colour(c, n):
        side = c.x > 0
        th = k.B["thigh_L" if side else "thigh_R"]
        ax = th.head_local
        if abs(n.x) > 0.75 and (c.x - ax.x) * (1 if side else -1) > 0:
            return MUSTARD, S  # the side stripe
        return CHAR, P
    return colour


def _jogger_pieces(g, k):
    for s in ("L", "R"):  # ribbed cuffs at the trouser ends
        ca = k.B[f"calf_{s}"]
        low = [v.co for v in g.vmap.values() if v.is_boundary and v.co.z < ca.head_local.z and (v.co.x > 0) == (s == "L")]
        if not low:
            continue
        c = sum(low, Vector()) / len(low)
        r = max(((v - c) * Vector((1, 1, 0))).length for v in low) + 0.008
        g.tube([c + Vector((0, 0, 0.03)), c - Vector((0, 0, 0.01))], [r, r], GREY_D, P, segs=6 if k.lod1 else 8)
    if not k.lod1:
        z = max(v.co.z for v in g.vmap.values()) - 0.03
        for s in (-1, 1):
            p, n = front(g, s * 0.02, z)
            g.cylinder(p + n * 0.004, p + n * 0.008 + Vector((0, 0, -0.07)), 0.005, CREAM, N, segs=4, caps=False)


def _cargos(k):
    def colour(c, n):
        col = camo(c, STONE, (0.32, 0.32, 0.31), (0.46, 0.46, 0.43))
        return col, (P if col == STONE else S)
    return colour


def _cargo_pieces(g, k):
    for s in ("L", "R"):
        th, ca = k.B[f"thigh_{s}"], k.B[f"calf_{s}"]
        p, n = outer_side(g, k, s, th.head_local.lerp(th.tail_local, 0.6).z)
        g.box(p, (0.08, 0.1, 0.024), n, (0.46, 0.46, 0.43), S, up=(0, 0, 1))
        # loose legs from just under the knee, straight down over the boot's shaft (not into it). The rings follow
        # the cloth's own section (a chunky chibi calf is far from round: a round tube wide enough for its widest
        # stood out everywhere else, a ledge round the shin): snug at the top, falling loose to the bottom.
        low = [v.co for v in g.vmap.values() if v.is_boundary and v.co.z < ca.head_local.z and (v.co.x > 0) == (s == "L")]
        c = sum(low, Vector()) / len(low) if low else ca.tail_local
        top = ca.head_local.lerp(ca.tail_local, 0.12)
        axis = [top, Vector((top.x, top.y, max(0.18, c.z - 0.05)))]
        segs = 6 if k.lod1 else 9
        r_top = [r + 0.006 for r in cloth_ring(g, axis, 0, top, segs)]
        r_low = cloth_ring(g, axis, 1, Vector((top.x, top.y, c.z + 0.015)), segs)
        r_bot = [max(rt, rl + 0.014, 0.078) for rt, rl in zip(r_top, r_low)]
        def colour(cc, nn):
            col = camo(cc, STONE, (0.32, 0.32, 0.31), (0.46, 0.46, 0.43))
            return col, (P if col == STONE else S)
        g.tube(axis, [r_top, r_bot], STONE, P, segs=segs, colour=colour)


STYLES = {
    "top_tee_field": dict(region="top", thick=0.007, iters=26, colour=_tee, hem=(OLIVE_D, S), pieces=None),
    "top_hoodie_street": dict(region="top", thick=0.013, iters=30, colour=_hoodie, hem=(GREY_D, P), pieces=_hoodie_pieces),
    "top_jersey_street": dict(region="top", thick=0.008, iters=26, colour=_jersey, hem=(TERRA, S), pieces=None),
    "top_print_shirt": dict(region="top", thick=0.009, iters=26, colour=_print_shirt, hem=(INDIGO, N), pieces=_print_pieces),
    "top_bomber": dict(region="top", thick=0.016, iters=30, colour=_bomber, hem=(CHAR, S), pieces=_bomber_pieces),
    "top_plate_carrier": dict(region="top", thick=0.005, iters=20, colour=_carrier, hem=(SAND_P, N), pieces=_carrier_pieces),
    "top_field_jacket": dict(region="top", thick=0.013, iters=28, colour=_field_jacket, hem=(STONE_D, P), pieces=_field_pieces),
    "legs_combat_trousers": dict(region="legs", thick=0.009, iters=22, colour=_combat, hem=(BROWN, N), pieces=_combat_pieces),
    "legs_joggers": dict(region="legs", thick=0.007, iters=22, colour=_joggers, hem=(GREY_D, P), pieces=_jogger_pieces),
    "legs_cargo_long": dict(region="legs", thick=0.011, iters=22, colour=_cargos, hem=(GREY_D, S), pieces=_cargo_pieces),
}


def build(iid, src, arm, lod1, scene):
    """One LOD of garment `iid` on body LOD `src`: the object (Col/Dye/Glow, kind, weights, `_free` = the vertices
    decimation may move), the triangles of the body it hides (its budget) and its painters (kind -> colour)."""
    st = STYLES[iid]
    k = Ctx(arm, src, lod1)
    g = Garment(src, arm, st["region"])
    colour = st["colour"](k)
    g.cloth(lambda p: st["thick"], colour, iters=st["iters"])
    hem = st["hem"]
    g.hems(lambda c, n: (TEAL, A, 1.0) if k.armband(c) else (hem[0], hem[1]))
    if st["pieces"]:
        st["pieces"](g, k)
    return g.to_object(f"{iid}{'_lod1' if lod1 else ''}", scene), g.hidden_tris, g.painters
