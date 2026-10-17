"""Compile a kit layout into a packages/content MapDef and AdSlot list (render = collision, docs/11 §2).

    python3 art/pipeline/compile_map.py art/maps/street_market/layout.json

Reads the layout (pieces + flips + spawns + decor) and the kit GLB's per-piece extras (terrain /
solids / oneWays / noFlip / adSlot, written by build_market_kit.py), then writes next to the layout:

* <folder>.map.json: the MapDef the sim loads (packages/content/src/maps/types.ts):
  - terrain pieces (ground blocks, houses, the edge blocks) merge into ONE terrain polygon whose
    top is the skyline, like the movement-test map, so there are no internal edges to snag on;
  - free-standing solids (stall counters, buses, tanks, the billboard panel) stay separate polygons;
  - one-way platforms (awnings, balconies, catwalks, the umbrella slopes) become oneWays;
  - bounds.maxY is a ceiling: a 2 m solid along the top, like movementTest's.
* <folder>.adslots.json: the docs/14 §4.2 AdSlot list, one per decor bezel with a `slotId`.

It checks the docs/01 §7 and docs/14 §2.6 rules it can and exits 1 on any error:
- no void at the map edges: the skyline must reach the ceiling at minX and maxX;
- ≥ 12 spawns, each standing on a walkable edge (terrain top, a solid edge sloping ≤ 50°, or a
  one-way) with the 0.32 × 1.5 m capsule clear of terrain and solids;
- no overlapping solids, no solid sunk into terrain or reaching the ceiling, no one-way inside a solid;
- ≥ 3 walkable layers; bounds ~120 × 60 m (a note);
- sightlines: no clear eye-to-eye line ≥ 60 m (the Widow's range, docs/03) between standing spots
  (one-ways are bullet-pass in the sim, so only terrain and solids block);
- no mirrored lettering: a layout item may not flip a `noFlip` piece;
- AdSlots (docs/14 §2.6): z ∈ [−9, −4], not a gameplay piece, no collision, never flipped, unique
  `<map id>/<slot>` ids (lint 1); 2.5–8% of the screen at 1× and ≥ 1.5% at 4× (lint 2); from every
  standing spot ≤ 2 surfaces in a 1× view and ≤ 4 surfaces / ≤ 8% ad area at 7× (lint 4).
"""
import json
import math
import struct
import sys
from pathlib import Path

EPS = 1e-6
CEILING = 2.0                          # thickness of the ceiling slab under bounds.maxY
WALK_NY = math.cos(math.radians(50))   # the sim's walkable slope limit
CAPSULE = (0.32, 1.5)                  # standing width, height
EYE = 1.08                             # the sim's aim pivot above the feet (docs/02 §6)
WIDOW_RANGE = 60.0                     # docs/03
# 1× camera (docs/03 §10, tools/art-preview): 36 m wide at z = 0, 16:9, vertical FOV 35°
VIEW_W, VIEW_H = 36.0, 36.0 * 9 / 16
CAM_D = (VIEW_H / 2) / math.tan(math.radians(35 / 2))  # ≈ 32.1 m from the gameplay plane
AD_Z = (-9.0, -4.0)                    # docs/14 §2.6 lint 1
ZOOM_4X, ZOOM_MAX = 1.6, 2.3           # the viewer's 4× and 7× (the widest) zoom-outs


def glb_json(path):
    b = Path(path).read_bytes()
    n = struct.unpack_from("<I", b, 12)[0]
    return json.loads(b[20:20 + n])


def kit_pieces(path):
    g = glb_json(path)
    out = {}
    for node in g["nodes"]:
        ex = node.get("extras", {})
        if "kitPiece" in ex:
            out[ex["kitPiece"]] = ex
    return out


def place_poly(points, x, y, flip):
    pts = [(x + (-px if flip else px), y + py) for px, py in zip(points[0::2], points[1::2])]
    if flip:
        pts.reverse()  # keep the winding
    return pts


def bbox(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_poly(px, py, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > py) != (y2 > py) and px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def signed_area(pts):
    return sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
               for i in range(len(pts))) / 2


def walkable_edges(pts):
    """Edges of a polygon whose outward normal points up within the walk limit, left to right."""
    ccw = signed_area(pts) > 0
    out = []
    for i in range(len(pts)):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % len(pts)]
        dx, dy = bx - ax, by - ay
        ln = math.hypot(dx, dy)
        if ln < EPS:
            continue
        ny = (-dx if ccw else dx) / ln  # outward normal is (dy, −dx) for CCW
        if ny >= WALK_NY:
            out.append((ax, ay, bx, by) if ax <= bx else (bx, by, ax, ay))
    return out


def y_on(seg, px):
    ax, ay, bx, by = seg
    if not (ax - EPS <= px <= bx + EPS):
        return None
    return ay if bx - ax < EPS else ay + (by - ay) * (px - ax) / (bx - ax)


def segs_cross(p, q, a, b):
    def orient(u, v, w):
        return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    d1, d2 = orient(a, b, p), orient(a, b, q)
    d3, d4 = orient(p, q, a), orient(p, q, b)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0)


def main():
    layout_path = Path(sys.argv[1])
    layout = json.loads(layout_path.read_text())
    repo = Path(__file__).resolve().parents[2]
    kit = kit_pieces(repo / "art" / layout["kit"])
    b = layout["bounds"]
    map_id = layout["id"]
    stem = layout_path.parent.name
    errors, notes = [], []

    # ---- mirrored lettering (pieces and decor)
    for item in layout["pieces"] + layout.get("decor", []):
        if item.get("flip") and kit.get(item["piece"], {}).get("noFlip"):
            errors.append(f"{item['piece']} at x {item['x']} is flipped, but it carries lettering (noFlip)")

    intervals, solids, one_ways = [], [], []
    for item in layout["pieces"]:
        pc = kit.get(item["piece"])
        if pc is None:
            errors.append(f"unknown piece {item['piece']}")
            continue
        if pc.get("layer", "gameplay") != "gameplay":
            errors.append(f"{item['piece']} is a {pc['layer']} piece: put it in decor")
            continue
        x, y, flip = item["x"], item.get("y", 0.0), item.get("flip", False)
        for x0, x1, h in pc.get("terrain", []):
            if abs(y) > EPS:
                errors.append(f"terrain piece {item['piece']} at y {y}: terrain stands on y = 0")
            a, c = sorted((x + (-x0 if flip else x0), x + (-x1 if flip else x1)))
            intervals.append((a, c, h, item["piece"]))
        for poly in pc.get("solids", []):
            solids.append((place_poly(poly, x, y, flip), pc.get("material", 0), item["piece"], x))
        for ax, ay, bx, by in pc.get("oneWays", []):
            pa, pb = (x + (-ax if flip else ax), y + ay), (x + (-bx if flip else bx), y + by)
            one_ways.append(tuple(pa + pb) if pa[0] <= pb[0] else tuple(pb + pa))

    # ---- terrain skyline (ground, houses, edge blocks) → one polygon
    xs = sorted({b["minX"], b["maxX"], *[i[0] for i in intervals], *[i[1] for i in intervals]})
    xs = [v for v in xs if b["minX"] - EPS <= v <= b["maxX"] + EPS]

    def height(xm):
        hs = [h for a, c, h, _ in intervals if a - EPS <= xm <= c + EPS]
        return max(hs) if hs else None

    top = []
    for a, c in zip(xs, xs[1:]):
        h = height((a + c) / 2)
        if h is None:
            errors.append(f"no ground between x {a:.2f} and {c:.2f}")
            h = 0.0
        if top and abs(top[-1][1] - h) < EPS:
            top[-1] = (top[-1][0], h, c)
        else:
            top.append((a, h, c))
    skyline = lambda xm: next((h for a, h, c in top if a - EPS <= xm <= c + EPS), 0.0)  # noqa: E731
    terrain = [(b["minX"], b["minY"])]
    for a, h, c in top:
        terrain += [(a, h), (c, h)]
    terrain.append((b["maxX"], b["minY"]))
    clean = [terrain[0]]
    for p in terrain[1:]:
        if abs(p[0] - clean[-1][0]) > EPS or abs(p[1] - clean[-1][1]) > EPS:
            clean.append(p)
    terrain = clean

    # ---- boundary: a ceiling slab, and walls (terrain) that reach it at both ends
    ceil_y = b["maxY"] - CEILING
    ceiling = [(b["minX"], ceil_y), (b["maxX"], ceil_y), (b["maxX"], b["maxY"]), (b["minX"], b["maxY"])]
    for side, xm in (("left", b["minX"] + 0.01), ("right", b["maxX"] - 0.01)):
        if skyline(xm) < ceil_y - EPS:
            errors.append(f"the play space is open at the {side} edge: the terrain there stops at "
                          f"{skyline(xm):.1f} m, under the ceiling at {ceil_y:.1f} m (add an edge block)")

    # ---- validation
    for i, (pts, _, name, _) in enumerate(solids):
        x0, y0, x1, y1 = bbox(pts)
        if y0 < skyline((x0 + x1) / 2) - 0.02:
            errors.append(f"solid {name} at x {x0:.1f} sinks into the terrain")
        if y1 > ceil_y + EPS:
            errors.append(f"solid {name} at x {x0:.1f} reaches into the ceiling")
        for j in range(i + 1, len(solids)):
            u0, v0, u1, v1 = bbox(solids[j][0])
            if x0 < u1 - EPS and u0 < x1 - EPS and y0 < v1 - EPS and v0 < y1 - EPS:
                errors.append(f"solids {name} and {solids[j][2]} overlap")
    for ax, ay, bx, by in one_ways:
        for t in (0.25, 0.5, 0.75):
            px, py = ax + (bx - ax) * t, ay + (by - ay) * t + 0.05
            if py < skyline(px) - EPS or any(point_in_poly(px, py, s[0]) for s in solids):
                errors.append(f"one-way {ax:.1f},{ay:.1f}→{bx:.1f},{by:.1f} is inside a solid")
                break

    # walkable surfaces: terrain tops under the ceiling, walkable solid edges, one-ways
    walk_segs = [(a, h, c, h) for a, h, c in top if h < ceil_y - EPS]
    for pts, _, _, _ in solids:
        walk_segs += walkable_edges(pts)
    walk_segs += list(one_ways)

    def blocked(px, py):
        return py < skyline(px) - EPS or py > ceil_y + EPS or any(point_in_poly(px, py, s[0]) for s in solids)

    def capsule_clear(px, py):
        w, h = CAPSULE
        return not any(blocked(px + dx, py + dy) for dx in (-w / 2, 0, w / 2)
                       for dy in (0.05, h / 4, h / 2, 3 * h / 4, h - 0.02))

    for sp in layout["spawns"]:
        px, py = sp["x"], sp["y"]
        on = any((yy := y_on(s, px)) is not None and abs(py - yy) < 0.02 for s in walk_segs)
        clear = capsule_clear(px, py)
        if not on or not clear:
            why = [w for w, bad in (("is not standing on a walkable edge", not on), ("overlaps terrain or a solid", not clear)) if bad]
            errors.append(f"spawn {px},{py} " + " and ".join(why))

    walk = sorted({round(max(s[1], s[3]), 1) for s in walk_segs})
    w_, h_ = b["maxX"] - b["minX"], b["maxY"] - b["minY"]
    if not (100 <= w_ <= 140 and 45 <= h_ <= 75):
        notes.append(f"size {w_:.0f} × {h_:.0f} m (docs/01 §7: ~120 × 60)")
    if len(layout["spawns"]) < 12:
        errors.append(f"{len(layout['spawns'])} spawns (docs/01 §7: ≥ 12)")
    bands = {0 if v < 1.5 else 1 if v < 6 else 2 for v in walk}
    if len(bands) < 3:
        errors.append("fewer than 3 vertical layers (ground, mid ~2–6 m, high ≥ 6 m)")

    # ---- standing spots every ~1 m on every walkable surface (sightlines, ad views)
    spots = []
    for s in walk_segs:
        ax, ay, bx, by = s
        n = max(1, round(bx - ax))
        for k in range(n + 1):
            px = ax + (bx - ax) * k / n
            py = y_on(s, px)
            if capsule_clear(px, py):
                spots.append((px, py))
    edges = []
    for poly in [terrain] + [s[0] for s in solids]:
        edges += [(poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly))]
    clear_long = []
    for i in range(len(spots)):
        for j in range(i + 1, len(spots)):
            p, q = (spots[i][0], spots[i][1] + EYE), (spots[j][0], spots[j][1] + EYE)
            if math.dist(p, q) < WIDOW_RANGE:
                continue
            x0, x1 = min(p[0], q[0]), max(p[0], q[0])
            if not any(segs_cross(p, q, a, c) for a, c in edges if max(a[0], c[0]) >= x0 and min(a[0], c[0]) <= x1):
                clear_long.append((math.dist(p, q), p, q))
    if clear_long:
        d, p, q = max(clear_long)
        errors.append(f"{len(clear_long)} clear sightlines ≥ {WIDOW_RANGE:.0f} m; longest {d:.1f} m from "
                      f"({p[0]:.1f}, {p[1]:.1f}) to ({q[0]:.1f}, {q[1]:.1f}) (docs/01 §7: ≤ the Widow's range)")

    # ---- AdSlots (docs/14 §2.6, §4.2)
    ad_slots, seen = [], set()
    for item in layout.get("decor", []):
        pc = kit.get(item["piece"])
        if pc is None:
            errors.append(f"unknown decor piece {item['piece']}")
            continue
        if pc.get("layer", "gameplay") == "gameplay":
            errors.append(f"{item['piece']} is a gameplay piece in decor: it would draw without collision")
        ad = pc.get("adSlot")
        if not ad:
            if item.get("slotId"):
                errors.append(f"{item['slotId']}: {item['piece']} is not an ad surface")
            continue
        sid, z = item.get("slotId"), item.get("z", 0.0)
        if not sid or not sid.startswith(f"{map_id}/") or sid in seen:
            errors.append(f"{item['piece']} at x {item['x']}: slotId {sid!r} must be a unique '{map_id}/<slot>'")
        seen.add(sid)
        if not (AD_Z[0] <= z <= AD_Z[1]):
            errors.append(f"{sid}: z {z} is outside the mid-depth band {AD_Z} (docs/14 §2.6 lint 1)")
        if any(pc.get(k) for k in ("terrain", "solids", "oneWays")):
            errors.append(f"{sid}: an ad surface may not carry collision")
        if item.get("flip"):
            errors.append(f"{sid}: ad surfaces are never mirrored")
        cx, cy, cz = ad["centre"]
        ad_slots.append({
            "slotId": sid, "kind": ad["kind"], "format": ad["format"], "frames": ad["frames"],
            "dwellMs": 10000, "phaseIdx": item.get("phaseIdx", 0),
            "pos": [item["x"] + cx, item.get("y", 0.0) + cy, z + cz], "size": ad["size"],
            "yawDeg": 0, "houseSet": [], "tags": item.get("tags", []),
        })

    # lint 2: screen share of each surface (perspective: a surface at depth z draws CAM_D / (CAM_D − z)
    # times its size); the camera at zoom k sees k × the 1× view
    for sl in ad_slots:
        s = CAM_D / (CAM_D - sl["pos"][2])
        share = sl["size"][0] * sl["size"][1] * s * s / (VIEW_W * VIEW_H)
        if not (0.025 <= share <= 0.08) or share / ZOOM_4X ** 2 < 0.015:
            errors.append(f"{sl['slotId']}: {share:.1%} of the screen at 1×, {share / ZOOM_4X ** 2:.1%} at 4× "
                          "(docs/14 §2.6 lint 2: 2.5–8%, ≥ 1.5%)")

    # lint 4: the camera centred on a standing player's torso, clamped so the view never leaves the
    # bounds (the game camera stops at them); a surface counts when ≥ 50% of it is on screen (the IAB
    # viewability share docs/14 §4.6 measures with)
    def visible_area(slot, px, py, zoom):
        s = CAM_D / (CAM_D - slot["pos"][2])
        (x, y, _), (w, h) = slot["pos"], slot["size"]
        vw, vh = VIEW_W * zoom, VIEW_H * zoom
        cx = min(max(px, b["minX"] + vw / 2), b["maxX"] - vw / 2)
        cy = min(max(py + 0.9, b["minY"] + vh / 2), b["maxY"] - vh / 2)
        x0, y0 = cx + (x - w / 2 - cx) * s, cy + (y - h / 2 - cy) * s
        x1, y1 = cx + (x + w / 2 - cx) * s, cy + (y + h / 2 - cy) * s
        ov = max(0.0, min(x1, cx + vw / 2) - max(x0, cx - vw / 2)) * max(0.0, min(y1, cy + vh / 2) - max(y0, cy - vh / 2))
        return ov if ov >= 0.5 * (x1 - x0) * (y1 - y0) else 0.0

    worst1, worst7, area7, worst_at, seen_ever = 0, 0, 0.0, None, set()
    for px, py in spots:
        vis = [sl["slotId"] for sl in ad_slots if visible_area(sl, px, py, 1.0)]
        seen_ever |= set(vis)
        if len(vis) > worst1:
            worst1, worst_at = len(vis), (px, py, vis)
        a7 = [visible_area(sl, px, py, ZOOM_MAX) for sl in ad_slots]
        worst7 = max(worst7, sum(1 for a in a7 if a))
        area7 = max(area7, sum(a7) / (VIEW_W * VIEW_H * ZOOM_MAX ** 2))
    if ad_slots:
        if worst1 > 2:
            errors.append(f"{worst1} ad surfaces in one 1× view at ({worst_at[0]:.1f}, {worst_at[1]:.1f}): "
                          f"{', '.join(worst_at[2])} (docs/14 §2.6 lint 4: ≤ 2)")
        if worst7 > 4 or area7 > 0.08:
            errors.append(f"7× view: up to {worst7} ad surfaces, {area7:.1%} ad area (docs/14 §2.6 lint 4: ≤ 4, ≤ 8%)")
        for sl in ad_slots:
            if sl["slotId"] not in seen_ever:
                errors.append(f"{sl['slotId']} is never on screen from a standing spot")
        notes.append(f"ad surfaces per view: ≤ {worst1} at 1×; ≤ {worst7} and ≤ {area7:.1%} of the screen at 7×")

    mapdef = {
        "id": map_id, "name": layout["name"], "bounds": b,
        "solids": [{"points": [c for p in terrain for c in p], "material": layout.get("terrainMaterial", 0)},
                   {"points": [c for p in ceiling for c in p], "material": layout.get("terrainMaterial", 0)}]
        + [{"points": [c for p in pts for c in p], "material": m} for pts, m, _, _ in solids],
        "oneWays": [{"ax": ax, "ay": ay, "bx": bx, "by": by} for ax, ay, bx, by in one_ways],
        "spawns": [{"x": s["x"], "y": s["y"]} for s in layout["spawns"]],
        "dummies": [],
        "labels": [],
    }
    print(f"compile_map: {layout['name']} ({map_id})  {w_:.0f} × {h_:.0f} m")
    print(f"  pieces {len(layout['pieces'])} gameplay + {len(layout.get('decor', []))} decor; ad slots {len(ad_slots)}")
    print(f"  terrain polygon {len(terrain)} points; solids {len(solids)} + ceiling; one-ways {len(one_ways)}; "
          f"spawns {len(layout['spawns'])}")
    print(f"  walkable heights (m): {walk}")
    print(f"  standing spots {len(spots)}; clear sightlines ≥ {WIDOW_RANGE:.0f} m: {len(clear_long)}")
    for n in notes:
        print("  note:", n)
    for e in errors:
        print("  ERROR:", e)
    if errors:
        print("  FAILED")
        sys.exit(1)
    out = layout_path.with_name(f"{stem}.map.json")
    out.write_text(json.dumps(mapdef, indent=1))
    ads = layout_path.with_name(f"{stem}.adslots.json")
    ads.write_text(json.dumps(ad_slots, indent=1))
    print(f"  wrote {out} and {ads.name}")


if __name__ == "__main__":
    main()
