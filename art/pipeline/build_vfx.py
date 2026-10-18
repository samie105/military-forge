"""Weapon fire VFX: muzzle-flash atlas, tracer texture and the manifest the renderer reads.

    python3 art/pipeline/build_vfx.py [--runtime apps/web/public/assets]

Inputs:
  art/vfx/source/flash_<style>.webp   one Higgsfield sheet per flash style: 4 variants in a 2×2
                                      grid on a transparent background, each blasting to the right
                                      from the left-middle of its quarter (prompts in art/README.md)
  art/weapons/sockets.json            muzzle / eject sockets per weapon (build_weapons.py)
  art/vfx/casings.json                casing types in vfx/casings.glb (build_casings.py)

Outputs (under <runtime>/vfx/, default apps/web/public/assets/vfx/):
  flash_atlas.webp   1024×1024, 32 cells of 256×128; every frame's origin (where it leaves the
                     muzzle) sits at the same point of its cell, so one quad shape fits all frames
  tracer.webp        128×16 streak, head on the right, white core; tinted per style
  flash_atlas_mono.webp  the same frames as luminance, for the cosmetic fire tints
  weapons.vfx.json   flash styles (frames, quad size, light pop), tracer styles, casing ejection,
                     fireTints (cosmetic flash / tracer colours, ≥ 25 ΔE from the team colours)
                     and per weapon `special`: a specials.vfx.json style (build_specials.py) for
                     flames, beams, orbs, blades, rounds in flight and the shield
                     and the per-weapon hook-up (which flash, tracer and casing each weapon uses)

Exits 1 if a weapon in sockets.json has no entry or an entry names a missing style.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_camos import TEAM, lab  # noqa: E402  (ΔE against the team colours)

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "art/vfx/source"
argv = sys.argv[1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else REPO / "apps/web/public/assets"
OUT = RUNTIME / "vfx"

CELL = (256, 128)
ORIGIN = (6, 64)        # where the muzzle is, in every cell (px)
ATLAS = (1024, 1024)
COLS = ATLAS[0] // CELL[0]
ALPHA_FLOOR = 8         # the generator leaves a faint glow everywhere: drop it

# Flash styles: world length of the longest frame (the quad scales from it), light pop and timing.
# Colours stay white-yellow, clear of both team colours (docs/11 §4).
FLASH = {
    "pistol":   {"lengthM": 0.28, "light": {"color": "#ffd890", "intensity": 2.0, "rangeM": 3.0}, "ms": 40},
    "smg":      {"lengthM": 0.36, "light": {"color": "#ffd890", "intensity": 1.8, "rangeM": 3.0}, "ms": 33},
    "rifle":    {"lengthM": 0.50, "light": {"color": "#ffd890", "intensity": 2.5, "rangeM": 4.0}, "ms": 45},
    "shotgun":  {"lengthM": 0.55, "light": {"color": "#ffd080", "intensity": 3.5, "rangeM": 5.0}, "ms": 60},
    "sniper":   {"lengthM": 0.90, "light": {"color": "#fff0c0", "intensity": 3.0, "rangeM": 5.0}, "ms": 70},
    "launcher": {"lengthM": 0.70, "light": {"color": "#ffc870", "intensity": 5.0, "rangeM": 7.0}, "ms": 120},
    "heavy":    {"lengthM": 0.50, "light": {"color": "#ffd890", "intensity": 2.5, "rangeM": 4.0}, "ms": 33},
}
# Tracers: drawn from the muzzle toward the hit; `every` = one tracer per N shots. Hitscan, so speed
# is only how fast the streak travels on screen. White-yellow, clear of the team colours.
TRACER = {
    "pistol":  {"tint": "#fff1b8", "widthM": 0.035, "lengthM": 1.2, "speedMps": 90, "every": 1},
    "smg":     {"tint": "#fff1b8", "widthM": 0.030, "lengthM": 1.0, "speedMps": 100, "every": 2},
    "rifle":   {"tint": "#ffe9a0", "widthM": 0.040, "lengthM": 1.8, "speedMps": 140, "every": 1},
    "shotgun": {"tint": "#fff6d0", "widthM": 0.020, "lengthM": 0.6, "speedMps": 80, "every": 1, "perPellet": True},
    "sniper":  {"tint": "#ffffff", "widthM": 0.060, "lengthM": 4.0, "speedMps": 260, "every": 1,
                "trail": {"tint": "#d8d8d0", "widthM": 0.05, "fadeMs": 450}},
    "heavy":   {"tint": "#ffdf8a", "widthM": 0.040, "lengthM": 1.6, "speedMps": 150, "every": 2},
}
# Cosmetic fire colours (store-safe: no gameplay effect). `classic` is the default look; the others
# multiply the flash's luminance (flash_atlas_mono.webp) and the white tracer. Each stays ≥ 25 ΔE from
# both team colours, so a tinted shot never reads as a team.
FIRE_TINTS = {
    "classic": {"name": "Classic", "flash": None, "tracer": None},
    "toxic": {"name": "Toxic", "flash": "#8dff5a", "tracer": "#a8ff7a"},
    "violet": {"name": "Violet", "flash": "#c08cff", "tracer": "#cfa6ff"},
    "ice": {"name": "Ice", "flash": "#bdf2ff", "tracer": "#d6f7ff"},
    "gold": {"name": "Gold", "flash": "#ffd23a", "tracer": "#ffe07a"},
    "rose": {"name": "Rose", "flash": "#ff8fc4", "tracer": "#ffb0d4"},
}
# Weapon hook-up: flash style (+ scale), tracer style, casing type and when it ejects.
WEAPONS = {
    "hawk50":   {"flash": "pistol", "tracer": "pistol", "casing": "pistol", "eject": "shot"},
    "hammer44": {"flash": "pistol", "flashScale": 1.25, "tracer": "pistol", "casing": "pistol",
                 "eject": "reload", "ejectCount": 6},
    "buzz":     {"flash": "smg", "tracer": "smg", "casing": "pistol", "eject": "shot"},
    "k47":      {"flash": "rifle", "tracer": "rifle", "casing": "rifle", "eject": "shot"},
    "breacher": {"flash": "shotgun", "tracer": "shotgun", "casing": "shotgun", "eject": "pump", "ejectDelayMs": 250},
    "widow":    {"flash": "sniper", "tracer": "sniper", "casing": "sniper", "eject": "bolt", "ejectDelayMs": 350},
    "thumper":  {"flash": "launcher", "tracer": None, "casing": None, "eject": None, "special": "thumper"},
    "shredder": {"flash": "heavy", "tracer": "heavy", "casing": "rifle", "eject": "shot", "ejectEvery": 2},
    "rattler":  {"flash": "smg", "flashScale": 0.9, "tracer": "smg", "casing": "pistol", "eject": "shot"},
    "hornet":   {"flash": "smg", "tracer": "smg", "casing": "pistol", "eject": "shot", "ejectEvery": 2},
    "trident":  {"flash": "rifle", "tracer": "rifle", "casing": "rifle", "eject": "shot", "burst": 3},
    "bullpup":  {"flash": "rifle", "flashScale": 0.9, "tracer": "rifle", "casing": "rifle", "eject": "shot"},
    "longbow":  {"flash": "sniper", "flashScale": 0.8, "tracer": "rifle", "casing": "sniper", "eject": "shot"},
    # `special`: a specials.vfx.json style (build_specials.py) for what isn't a flash and a bullet
    "dragon":   {"flash": None, "tracer": None, "casing": None, "eject": None, "special": "dragon"},
    "arc":      {"flash": None, "tracer": None, "casing": None, "eject": None, "special": "arc"},
    "popper":   {"flash": "shotgun", "flashScale": 1.1, "tracer": None, "casing": None, "eject": None, "special": "popper"},
    "ripper":   {"flash": None, "tracer": None, "casing": None, "eject": None, "special": "ripper"},
    "pulse":    {"flash": None, "tracer": None, "casing": None, "eject": None, "special": "pulse"},
    "riot_shield": {"flash": None, "tracer": None, "casing": None, "eject": None, "special": "riot_shield"},
    "machete":  {"flash": None, "tracer": None, "casing": None, "eject": None},
    "frag":     {"flash": None, "tracer": None, "casing": None, "eject": None},
    "mine":     {"flash": None, "tracer": None, "casing": None, "eject": None},
}


def frames_of(sheet):
    """The 4 variants of a 2×2 sheet: (rgba, origin (x, y), right edge, half height) in sheet px."""
    a = np.asarray(sheet).copy()
    a[..., 3] = np.where(a[..., 3] < ALPHA_FLOOR, 0, a[..., 3])
    h, w = a.shape[:2]
    out = []
    for qy in range(2):
        for qx in range(2):
            q = a[qy * h // 2:(qy + 1) * h // 2, qx * w // 2:(qx + 1) * w // 2]
            alpha = q[..., 3].astype(np.float32) / 255
            ys, xs = np.nonzero(alpha > 0.1)
            x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
            # the origin: the leftmost solid column, at the alpha-weighted height of the first 6%
            solid = np.nonzero((alpha > 0.5).any(axis=0))[0]
            ox = solid.min()
            band = alpha[:, ox:ox + max(2, int(0.06 * (x1 - ox)))]
            oy = float((band.sum(axis=1) * np.arange(band.shape[0])).sum() / max(1e-6, band.sum()))
            out.append((q, (ox, oy), x1, max(oy - y0, y1 - oy)))
    return out


def build_atlas():
    atlas = Image.new("RGBA", ATLAS, (0, 0, 0, 0))
    styles, cell = {}, 0
    for style, spec in FLASH.items():
        frames = frames_of(Image.open(SRC / f"flash_{style}.webp").convert("RGBA"))
        length = max(x1 - ox for _, (ox, _), x1, _ in frames)
        half = max(hh for *_, hh in frames)
        s = min((CELL[0] - ORIGIN[0] - 4) / length, (CELL[1] / 2 - 3) / half)
        ids = []
        for q, (ox, oy), _, _ in frames:
            img = Image.fromarray(q).resize((max(1, round(q.shape[1] * s)), max(1, round(q.shape[0] * s))), Image.LANCZOS)
            tile = Image.new("RGBA", CELL, (0, 0, 0, 0))
            tile.alpha_composite(img, (round(ORIGIN[0] - ox * s), round(ORIGIN[1] - oy * s)))
            # nothing may spill into the neighbouring cell
            arr = np.asarray(tile).copy()
            arr[[0, -1], :, 3] = 0
            arr[:, [0, -1], 3] = 0
            atlas.paste(Image.fromarray(arr), ((cell % COLS) * CELL[0], (cell // COLS) * CELL[1]))
            ids.append(cell)
            cell += 1
        m_per_px = spec["lengthM"] / (length * s)  # world metres per atlas pixel
        styles[style] = {
            "frames": ids,
            "quad": {"widthM": round(CELL[0] * m_per_px, 4), "heightM": round(CELL[1] * m_per_px, 4),
                     "originU": round(ORIGIN[0] / CELL[0], 4)},
            "ms": spec["ms"], "light": spec["light"],
            "jitter": {"scale": [0.85, 1.15], "rollDeg": 6, "flipV": True},
        }
    return atlas, styles


def mono_atlas(atlas):
    """The flash atlas as luminance (white-hot core, grey edges), same alpha: tints multiply it cleanly."""
    a = np.asarray(atlas).astype(np.float64) / 255
    lum = (0.3 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]) ** 0.8
    out = np.dstack([lum, lum, lum, a[..., 3]])
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA")


def tracer_texture():
    w, h = 128, 16
    x = np.linspace(0, 1, w)[None, :]
    y = np.linspace(-1, 1, h)[:, None]
    along = np.clip(x, 0, 1) ** 1.6 * np.clip((1 - x) / 0.06, 0, 1)  # fades in from the tail, sharp head
    core = np.exp(-(y / 0.22) ** 2)
    glow = np.exp(-(y / 0.6) ** 2) * 0.55
    a = np.clip((core + glow) * along, 0, 1)
    rgb = np.stack([np.ones_like(a), np.ones_like(a) * (0.94 + 0.06 * core), 0.82 + 0.18 * core * np.ones_like(a)], -1)
    return Image.fromarray(np.dstack([rgb * 255, a[..., None] * 255]).astype(np.uint8), "RGBA")


def main():
    sockets = json.loads((REPO / "art/weapons/sockets.json").read_text())["weapons"]
    casings = json.loads((REPO / "art/vfx/casings.json").read_text())
    errors = []
    for wid in sockets:
        e = WEAPONS.get(wid)
        if e is None:
            errors.append(f"{wid}: no VFX entry")
            continue
        if e["flash"] and e["flash"] not in FLASH:
            errors.append(f"{wid}: unknown flash style {e['flash']}")
        if e["tracer"] and e["tracer"] not in TRACER:
            errors.append(f"{wid}: unknown tracer style {e['tracer']}")
        if e["casing"] and e["casing"] not in casings["types"]:
            errors.append(f"{wid}: unknown casing {e['casing']}")
        if e["flash"] and "muzzle" not in sockets[wid]["sockets"]:
            errors.append(f"{wid}: has a flash but no muzzle socket")
        if e["casing"] and "eject" not in sockets[wid]["sockets"]:
            errors.append(f"{wid}: ejects casings but has no eject socket")
    for tid, t in FIRE_TINTS.items():
        for key in ("flash", "tracer"):
            for team, hx in TEAM.items():
                if t[key] and float(np.linalg.norm(lab(t[key]) - lab(hx))) < 25:
                    errors.append(f"fire tint {tid}: {key} {t[key]} is within 25 ΔE of team {team}")
    if errors:
        for e in errors:
            print("ERROR:", e)
        sys.exit(1)

    OUT.mkdir(parents=True, exist_ok=True)
    atlas, styles = build_atlas()
    atlas.save(OUT / "flash_atlas.webp", "WEBP", quality=88, alpha_quality=90, method=6)
    mono_atlas(atlas).save(OUT / "flash_atlas_mono.webp", "WEBP", quality=88, alpha_quality=90, method=6)
    tracer_texture().save(OUT / "tracer.webp", "WEBP", lossless=True)
    manifest = {
        "version": 1,
        "frame": "weapon sockets (weapons/sockets.json): flashes leave `muzzle` along its dir, casings leave "
                 "`eject` along its dir; quads lie in the plane of the muzzle dir and the camera (or as two "
                 "crossed quads)",
        "flash": {"atlas": "flash_atlas.webp", "atlasSize": list(ATLAS), "cell": list(CELL),
                  "blend": "additive", "styles": styles,
                  "notes": "pick a random frame per shot; scale and roll from `jitter`; flipV mirrors it across "
                           "the muzzle axis; the point light pops for `ms`"},
        "tracer": {"texture": "tracer.webp", "blend": "additive", "styles": TRACER,
                   "notes": "the texture's head is +U; stretch it from the muzzle toward the hit; perPellet = one "
                            "per shotgun pellet; trail = a smoke line left behind that fades over fadeMs"},
        "casings": {"file": casings["file"], "maxLive": 32, "types": casings["types"],
                    "notes": "spawn at `eject`, velocity speedMps along its dir within coneDeg, spin spinRps "
                             "about a random axis, gravity 9.8 m/s², fade out over the last 300 ms of lifeMs"},
        "fireTints": {"monoAtlas": "flash_atlas_mono.webp", "tints": FIRE_TINTS,
                      "notes": "cosmetic (store-safe). A tinted flash draws flash_atlas_mono.webp × `flash` and its light "
                               "pop takes that colour; a tinted tracer multiplies tracer.webp by `tracer` instead of the "
                               "style tint. classic = the coloured atlas and the style tints"},
        "weapons": WEAPONS,
    }
    (OUT / "weapons.vfx.json").write_text(json.dumps(manifest, indent=1))
    print(f"build_vfx: {sum(len(s['frames']) for s in styles.values())} flash frames in {ATLAS[0]}×{ATLAS[1]}, "
          f"{len(TRACER)} tracer styles, {len(casings['types'])} casing types, {len(WEAPONS)} weapons → {OUT}")


if __name__ == "__main__":
    main()
