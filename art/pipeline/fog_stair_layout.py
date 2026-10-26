#!/usr/bin/env python3
"""Fog Stair's kit layout: where each piece of build_fog_stair_kit.py stands (NOTES §50).

    python3 -I art/pipeline/fog_stair_layout.py art/maps/fog_stair/layout.json

The map is mirrored about the river (x 120): the west bank is written out here and the east bank
is its mirror image (a flipped placement at 240 − x), except for pieces with lettering (`noFlip`:
signs, neon), which are placed unflipped at the mirrored spot, and the pieces that span the river
(placed once). The east bank's signs are not a copy of the west's: its blades swap their words.

Gameplay pieces carry the map's collision (compile_map.py checks the layout against
packages/content/src/maps/fogStair.ts through `collision`); decor (mid and glow layers) carries none.
"""
import json
import sys
from pathlib import Path

W = 240.0


def m(x):
    return round(W - x, 3)


# (piece, x, y, flip) on the west bank: the gameplay plane
WEST = [
    ("fs_edge_wall", -1.0, -6.0, False),
    ("fs_hill", 0.0, 38.0, False),
    ("fs_stair_upper", 22.0, 38.0, False),
    ("fs_terrace", 40.0, 20.0, False),
    ("fs_stair_lower", 56.0, 20.0, False),
    ("fs_quay", 76.0, 0.0, False),
    ("fs_tower", 89.0, 0.0, False),
    ("fs_shophouse", 47.0, 20.0, False),
    ("fs_roof_tank", 84.5, 62.0, False),
    ("fs_roof_mast", 95.0, 62.0, False),
    ("fs_quay_cargo", 101.25, 0.0, False),
    ("fs_viaduct", 22.5, 38.0, False),
    ("fs_pavilion", 10.0, 38.0, False),
    ("fs_perch", 18.0, 50.0, False),
    # the balconies: a flipped one reaches west from the tower's west face (x 80)
    ("fs_balcony", 80.0, 10.0, True),
    ("fs_balcony", 98.0, 14.0, False),
    ("fs_balcony", 98.0, 26.0, False),
    ("fs_balcony", 80.0, 50.0, True),
    ("fs_balcony", 98.0, 50.0, False),
    # sign cabinets on the tower's face (no lettering: they mirror)
    ("fs_blade_cabinet", 84.5, 11.0, False),
    ("fs_blade_cabinet", 93.5, 50.4, False),
]
# lettered pieces on the gameplay plane (painted boards): (piece west, piece east, x, y)
WEST_BOARDS = [
    ("fs_board_huoguo", "fs_board_xiaomaibu", 82.7, 2.85),
    ("fs_board_xiaomaibu", "fs_board_huoguo", 91.3, 2.85),
    ("fs_board_yaofang", "fs_board_yaofang", 93.5, 4.1),
    ("fs_board_mianguan", "fs_board_mianguan", 47.0, 23.3),
]
# pieces across the river, placed once
CENTRE = [
    ("fs_riverbed", 120.0, -4.0),
    ("fs_river", 120.0, -1.0),
    ("fs_bridge", 120.0, 38.0),
    ("fs_footbridge", 120.0, 62.0),
    ("fs_monorail_car", 120.0, 38.0),
]
# decor on the west bank: (piece, x, y, z, flip); glow pieces with lettering go through WEST_GLOW
WEST_DECOR = [
    ("fs_lights_arcade", 89.0, 4.0, 0.0, False),
    ("fs_lights_station", 89.0, 43.5, 0.0, False),
    ("fs_lane_houses", 11.0, 38.0, -5.0, False),
    ("fs_noodle_stall", 1.6, 38.0, -2.2, False),
    ("fs_noodle_stall", 77.4, 0.0, -2.7, False),
    # (y: these pieces' pivots are their feet, under the ground: build_fog_stair_kit.py `lift`)
    ("fs_temple_gate", 53.4, 18.5, -2.6, False),
    ("fs_stilt_house", 61.0, 6.0, -4.6, True),
    ("fs_roof_back", 89.0, 62.0, -2.2, False),
    ("fs_sampan", 107.5, -1.25, -3.0, False),
    ("fs_sampan", 113.5, -1.25, -5.6, True),
    ("fs_viaduct_twin", 22.5, 38.0, -5.0, False),
    # the Hoarding hangs under the monorail's other track (its beam's underside at 36.1)
    ("fs_hoarding_frame_18", 42.0, 36.1, -5.0, False),
    ("fs_ad_tower", 109.0, -1.0, -8.0, False),
    ("fs_led_gantry", 72.5, 4.0, -5.0, False),
    ("fs_neon_frame_screen", 109.0, 21.5, -8.0, False),
    ("fs_neon_frame_screen", 72.5, 18.0, -5.0, False),
    ("fs_neon_frame_hoarding", 42.0, 31.5, -5.0, False),
]
# lettered decor: (piece west, piece east, x, y, z)
WEST_GLOW = [
    ("fs_neon_huoguo", "fs_neon_lvguan", 84.5, 11.0, 0.0),
    ("fs_neon_lvguan", "fs_neon_huoguo", 93.5, 50.4, 0.0),
    ("fs_led_panel", "fs_led_panel", 93.6, 27.3, 0.0),
    ("fs_neon_chaguan_tall", "fs_neon_chaguan_tall", 109.0, 16.6, -8.0),
    ("fs_board_chaguan", "fs_board_chaguan", 11.0, 40.9, -5.0),
    ("fs_board_xiaomian", "fs_board_xiaomian", 1.6, 39.75, -2.2),
    ("fs_board_xiaomian", "fs_board_xiaomian", 77.4, 1.75, -2.7),
]
# the ad bezels (docs/14 §4.2): (piece, x, y, z, west slot, east slot, phase west, phase east)
ADS = [
    ("fs_screen_8x6", 109.0, 21.5, -8.0, "S1", "S2", 0, 3),
    ("fs_screen_8x6", 72.5, 18.0, -5.0, "S3", "S4", 1, 4),
    ("fs_hoarding_18x3", 42.0, 31.5, -5.0, "H1", "H2", 0, 0),
]
CENTRE_DECOR = [
    ("fs_barge", 120.0, -1.6, -12.0),
]
# spawns: fogStair.ts's (both banks); the layout carries them for the lints
SPAWNS = [(103, 0), (89, 0), (42, 20), (53, 20), (16, 38), (89, 38), (91, 62)]


def item(piece, x, y, flip=False, z=None, **extra):
    it = {"piece": piece, "x": round(x, 3), "y": round(y, 3)}
    if z is not None:
        it["z"] = round(z, 3)
    if flip:
        it["flip"] = True
    it.update(extra)
    return it


def main():
    pieces = []
    for piece, x, y, flip in WEST:
        pieces.append(item(piece, x, y, flip))
        pieces.append(item(piece, m(x), y, not flip))
    for west, east, x, y in WEST_BOARDS:
        pieces.append(item(west, x, y))
        pieces.append(item(east, m(x), y))
    for piece, x, y in CENTRE:
        pieces.append(item(piece, x, y))
    decor = []
    for piece, x, y, z, flip in WEST_DECOR:
        decor.append(item(piece, x, y, flip, z))
        decor.append(item(piece, m(x), y, not flip, z))
    for west, east, x, y, z in WEST_GLOW:
        decor.append(item(west, x, y, False, z))
        decor.append(item(east, m(x), y, False, z))
    for piece, x, y, z, sw, se, pw, pe in ADS:
        decor.append(item(piece, x, y, False, z, slotId=f"fog-stair/{sw}", phaseIdx=pw))
        decor.append(item(piece, m(x), y, False, z, slotId=f"fog-stair/{se}", phaseIdx=pe))
    for piece, x, y, z in CENTRE_DECOR:
        decor.append(item(piece, x, y, False, z))
    spawns = [{"x": float(x), "y": float(y)} for x, y in SPAWNS] + [{"x": m(x), "y": float(y)} for x, y in SPAWNS]
    layout = {
        "id": "fog-stair",
        "name": "Fog Stair",
        "kit": "kits/fog_stair/kit_fog_stair.glb",
        # the collision is fogStair.ts's (compile_map.py checks the kit against it and writes only the AdSlots)
        "collision": "fog_stair.map.json",
        "bounds": {"minX": -2, "minY": -6, "maxX": 242, "maxY": 102},
        "pieces": pieces,
        "decor": decor,
        "spawns": spawns,
    }
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(layout, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}: {len(pieces)} pieces, {len(decor)} decor")


if __name__ == "__main__":
    main()
