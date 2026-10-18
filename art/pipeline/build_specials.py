"""Fire VFX for the special weapons (docs/03 §5, §7): the Dragon's flame stream, the Arc's beam, the
Pulse's EMP orb and burst, the Ripper's blade, the Popper's and Thumper's rounds in flight, and the
riot shield's hits and cracks.

    python3 art/pipeline/build_specials.py [--runtime apps/web/public/assets]

Input: art/vfx/source/flame_dragon.webp (Higgsfield; prompt in art/README.md), a 16-frame flame puff
in a 4×4 grid. Everything else is drawn here, so it tiles and sizes exactly.

Outputs (<runtime>/vfx/):
  flame_atlas.webp     1024², the puff in 16 cells of 256², centred: one crop and scale for the whole
                       flipbook (build_explosions.flipbook), so it grows from 0.15 to 0.6 m like the sim
  specials_atlas.webp  512², cells of 128²:
                         row 0  orb flicker ×4 (additive, baked blue)
                         row 1  pilot flame (origin at the left middle, points +U) | beam flare | soft
                                glow (white: tint it) | thin ring (white: tint it)
                         row 2  shield cracks, light / heavy / breaking (normal blend, cumulative)
  beam.webp            256×64, tileable along U: white core, cyan glow, two electric strands (additive)
  specials.vfx.json    per weapon: what fires, how it moves, what it leaves. Speeds, ranges and
                       timings are docs/03 §7's until packages/content has these weapons.
  manifest.json        the index of every VFX file in vfx/ (which builder, what it holds, texture sizes)
Projectile meshes are in vfx/projectiles.glb (build_projectiles.py); particles, decals and the
shockwave ring are the impact and explosion ones.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_explosions as bx  # noqa: E402  (the flipbook cropper)

REPO = Path(__file__).resolve().parents[2]
argv = sys.argv[1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else REPO / "apps/web/public/assets"
OUT = RUNTIME / "vfx"
C = 128  # specials atlas cell
CYAN = (0.37, 0.95, 1.0)
BLUE = (0.45, 0.74, 1.0)


def grid(n=C):
    """Cell coordinates in [-1, 1] (y down), and the radius."""
    y, x = np.mgrid[0:n, 0:n] / (n - 1) * 2 - 1
    return x, y, np.sqrt(x ** 2 + y ** 2)


def compose(layers, n=C):
    """Additive-style layers [(intensity, rgb)] → RGBA: alpha = total intensity, rgb = its weighted colour."""
    a = np.zeros((n, n))
    rgb = np.zeros((n, n, 3))
    for inten, col in layers:
        a += inten
        rgb += inten[..., None] * np.array(col)
    rgb /= np.maximum(a, 1e-6)[..., None]
    a = np.clip(a, 0, 1)
    return Image.fromarray((np.dstack([np.clip(rgb, 0, 1), a]) * 255).astype(np.uint8), "RGBA")


def strokes(paths, width, n=C, scale=4, blur=0.0):
    """Polylines (cell coords in [-1, 1]) drawn antialiased: an intensity map in [0, 1]."""
    big = Image.new("L", (n * scale, n * scale), 0)
    d = ImageDraw.Draw(big)
    for pts in paths:
        d.line([((x + 1) / 2 * (n * scale - 1), (y + 1) / 2 * (n * scale - 1)) for x, y in pts], fill=255,
               width=max(1, round(width * scale)), joint="curve")
    if blur:
        big = big.filter(ImageFilter.GaussianBlur(blur * scale))
    return np.asarray(big.resize((n, n), Image.LANCZOS), dtype=np.float64) / 255


def jagged(rng, a, r0, r1, steps=7, wander=0.35):
    """A crackling arc from radius r0 to r1 around angle a."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        ang = a + rng.normal(0, wander) * t
        r = r0 + (r1 - r0) * t
        pts.append((r * math.cos(ang), r * math.sin(ang)))
    return pts


def orb_frame(k):
    x, y, r = grid()
    rng = np.random.default_rng(100 + k)
    core = np.exp(-(r / 0.2) ** 2)
    halo = 0.55 * np.exp(-(r / 0.55) ** 2)
    rim = (0.35 + 0.15 * rng.random()) * np.exp(-((r - 0.42) / 0.05) ** 2)
    arcs = strokes([jagged(rng, rng.uniform(0, 2 * math.pi), 0.12, rng.uniform(0.5, 0.75), steps=9, wander=0.18)
                    for _ in range(4)], 1.3)
    return compose([(core, (1, 1, 1)), (halo, BLUE), (rim, (0.6, 0.85, 1.0)), (0.9 * arcs, (0.85, 0.97, 1.0))])


def pilot_flame():
    """A small teardrop flame from the left middle toward +U: blue at the base, white-yellow core."""
    n = C
    u = np.linspace(0, 1, n)[None, :].repeat(n, 0)
    v = np.linspace(-1, 1, n)[:, None].repeat(n, 1)
    origin, length = 12 / n, 0.78
    t = np.clip((u - origin) / length, 0, 1)
    half = 0.2 * np.sin(np.pi * np.clip(t, 0, 1) ** 0.55) * (u >= origin)
    body = np.clip(1 - (np.abs(v) / np.maximum(half, 1e-3)) ** 2, 0, 1) * (half > 0)
    core = body * np.exp(-((t - 0.45) / 0.22) ** 2)
    base = body * np.clip(1 - t / 0.45, 0, 1) ** 0.7
    # the blue base replaces the orange body rather than mixing with it (that reads grey)
    return compose([(0.9 * body * (1 - base), (1.0, 0.66, 0.2)), (0.8 * core * (1 - base), (1.0, 0.95, 0.7)),
                    (1.1 * base, (0.3, 0.5, 1.0))])


def flare():
    x, y, r = grid()
    ang = np.arctan2(y, x)
    spikes = sum(np.exp(-((r * np.sin(ang - a)) / 0.035) ** 2) * np.clip(1 - r, 0, 1) * (np.cos(ang - a) > 0)
                 for a in np.linspace(0, 2 * math.pi, 6, endpoint=False) + 0.3)
    return compose([(np.exp(-(r / 0.13) ** 2), (1, 1, 1)), (0.5 * np.exp(-(r / 0.45) ** 2), CYAN), (0.8 * spikes, (0.75, 0.98, 1.0))])


def glow():
    *_, r = grid()
    return compose([(np.exp(-(r / 0.45) ** 2) * (r < 1), (1, 1, 1))])


def ring():
    *_, r = grid()
    return compose([(np.exp(-((r - 0.8) / 0.06) ** 2) * (r < 1), (1, 1, 1))])


def cracks():
    """Three cumulative crack states on transparent: dark lines with a light lip, from one impact point."""
    rng = np.random.default_rng(7)
    centre = (0.08, -0.12)
    lines = []  # (stage, polyline)
    for stage, count, reach in ((1, 5, (0.3, 0.55)), (2, 6, (0.55, 0.9)), (3, 8, (0.9, 1.4))):
        for _ in range(count):
            a = rng.uniform(0, 2 * math.pi)
            pts = [(centre[0] + p[0], centre[1] + p[1]) for p in jagged(rng, a, 0.03, rng.uniform(*reach), steps=5, wander=0.09)]
            lines.append((stage, pts))
    for stage, rad in ((2, 0.3), (3, 0.55)):  # rings of the spider web
        a0 = rng.uniform(0, 2 * math.pi)
        pts = [(centre[0] + rad * (1 + 0.12 * rng.normal()) * math.cos(a0 + t),
                centre[1] + rad * (1 + 0.12 * rng.normal()) * math.sin(a0 + t)) for t in np.linspace(0, 4.4, 14)]
        lines.append((stage, pts))
    out = []
    for s in (1, 2, 3):
        paths = [p for st, p in lines if st <= s]
        dark = strokes(paths, 2.2)
        lip = strokes([[(x + 0.016, y + 0.016) for x, y in p] for p in paths], 1.2)
        a = np.clip(0.9 * dark + 0.45 * lip, 0, 1)
        rgb = (0.9 * dark[..., None] * np.array([0.07, 0.07, 0.08]) + 0.45 * lip[..., None] * np.array([0.86, 0.9, 0.92]))
        rgb /= np.maximum(a, 1e-6)[..., None]
        out.append(Image.fromarray((np.dstack([np.clip(rgb, 0, 1), a]) * 255).astype(np.uint8), "RGBA"))
    return out


def beam():
    w, h = 256, 64
    x = np.linspace(0, 1, w, endpoint=False)[None, :]
    y = np.linspace(-1, 1, h)[:, None]
    core = np.exp(-(y / 0.07) ** 2) * np.ones_like(x)
    glow_ = 0.55 * np.exp(-(y / 0.36) ** 2) * (0.85 + 0.15 * np.sin(2 * np.pi * 3 * x))
    # integer frequencies along U: the strip tiles
    s1 = 0.26 * np.sin(2 * np.pi * 2 * x + 0.5) + 0.1 * np.sin(2 * np.pi * 7 * x)
    s2 = -0.22 * np.sin(2 * np.pi * 3 * x + 1.3) + 0.08 * np.sin(2 * np.pi * 11 * x)
    strands = 0.7 * (np.exp(-((y - s1) / 0.045) ** 2) + np.exp(-((y - s2) / 0.045) ** 2))
    a = np.clip(core + glow_ + strands, 0, 1)
    rgb = (core[..., None] * np.array([1, 1, 1]) + glow_[..., None] * np.array(CYAN) + strands[..., None] * np.array([0.75, 0.98, 1.0]))
    rgb /= np.maximum(core + glow_ + strands, 1e-6)[..., None]
    return Image.fromarray((np.dstack([np.clip(rgb, 0, 1), a]) * 255).astype(np.uint8), "RGBA")


# id → cell index in specials_atlas (4 columns)
CELLS = {"orb0": 0, "orb1": 1, "orb2": 2, "orb3": 3, "pilot": 4, "flare": 5, "glow": 6, "ring": 7,
         "crack1": 8, "crack2": 9, "crack3": 10}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tiles, flame = bx.flipbook({"sheet": "flame_dragon", "anchor": "centre", "fps": 20, "fireballM": 1.2, "peak": 6})
    atlas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    for i, t in enumerate(tiles):
        atlas.paste(t, ((i % 4) * bx.CELL, (i // 4) * bx.CELL))
    atlas.save(OUT / "flame_atlas.webp", "WEBP", quality=86, alpha_quality=90, method=6)

    sp = Image.new("RGBA", (4 * C, 4 * C), (0, 0, 0, 0))
    art = {**{f"orb{k}": orb_frame(k) for k in range(4)}, "pilot": pilot_flame(), "flare": flare(), "glow": glow(),
           "ring": ring(), **{f"crack{i + 1}": c for i, c in enumerate(cracks())}}
    ramp = np.clip(np.minimum.reduce([np.arange(C)[None, :].repeat(C, 0), np.arange(C)[:, None].repeat(C, 1),
                                      C - 1 - np.arange(C)[None, :].repeat(C, 0), C - 1 - np.arange(C)[:, None].repeat(C, 1)]) / 4, 0, 1)
    for name, img in art.items():
        i = CELLS[name]
        a = np.asarray(img).copy()
        a[..., 3] = (a[..., 3] * ramp).astype(np.uint8)  # a 4 px fade: nothing ends in a hard cell edge
        sp.paste(Image.fromarray(a), ((i % 4) * C, (i // 4) * C))
    sp.save(OUT / "specials_atlas.webp", "WEBP", lossless=True)
    beam().save(OUT / "beam.webp", "WEBP", lossless=True)

    docs = "docs/03 §7 until packages/content has this weapon"
    manifest = {
        "version": 1,
        "frame": "positions name weapon sockets (weapons/sockets.json); `dir` is the muzzle's; sizes in metres",
        "atlases": {
            "flame": {"texture": "flame_atlas.webp", "size": [1024, 1024], "cell": [bx.CELL, bx.CELL]},
            "specials": {"texture": "specials_atlas.webp", "size": [4 * C, 4 * C], "cell": [C, C], "cells": CELLS},
        },
        "flipbooks": {
            "flame": {"atlas": "flame", "firstCell": 0, **flame,
                      "notes": "one puff over its 0.8 s life: frame = 16 × age / life; it grows 0.15 → 0.6 m in "
                               "radius like the sim projectile; the late frames are smoke (normal blend)"},
            "orb": {"atlas": "specials", "cells": ["orb0", "orb1", "orb2", "orb3"], "fps": 16, "loop": True, "blend": "additive"},
        },
        "sprites": {name: {"atlas": "specials", "cell": name,
                           "blend": "normal" if name.startswith("crack") else "additive",
                           **({"originU": 12 / C} if name == "pilot" else {})}
                    for name in ("pilot", "flare", "glow", "ring", "crack1", "crack2", "crack3")},
        "beam": {"texture": "beam.webp", "size": [256, 64], "blend": "additive", "wrapU": True,
                 "notes": "a camera-facing strip from the muzzle to the hit point; U repeats along it"},
        "projectiles": {"from": "projectiles.json", "glb": "projectiles.glb"},
        "particles": {"texture": "particles.webp", "from": "impacts.vfx.json"},
        "styles": {
            "dragon": {
                "kind": "flame", "from": "muzzle", "flipbook": "flame", "blend": "normal",
                "spawnEveryS": 0.15, "puffsPerSpawn": 3, "lifeS": 0.8, "speedMps": 7, "gravity": -0.2, "spreadDeg": 8,
                "jitter": {"rollDeg": 180, "scale": [0.9, 1.1], "flipU": True},
                "pilot": {"socket": "pilot", "sprite": "pilot", "sizeM": 0.07, "flickerHz": 14, "always": True},
                "light": {"color": "#ff9a40", "intensity": 3.0, "rangeM": 3.5, "flickerHz": 9},
                "burn": {"flipbook": "flame", "frames": [1, 7], "sizeM": 0.35, "durationS": 2.0,
                         "notes": "on a burning player, at the chest, for the 2 s burn"},
                "wallHit": {"decal": "scorch", "sizeM": 0.35},
                "provisional": docs,
                "notes": "each 0.15 s sim projectile draws puffsPerSpawn puffs spread along its first metre so the "
                         "stream reads continuous; puffs stop at walls (they reflect weakly in the sim)",
            },
            "arc": {
                "kind": "beam", "from": "muzzle", "rangeM": 52, "tickS": 0.15, "widthM": 0.07, "uvPerM": 2.5,
                "scrollMps": 9, "flicker": {"widthJitter": 0.15, "hz": 20},
                "startGlow": {"sprite": "glow", "sizeM": 0.14, "tint": "#5ff2ff"},
                "endFlare": {"sprite": "flare", "sizeM": 0.38, "spinDegPerS": 120},
                "hitSparks": {"particle": "spark", "count": [1, 2], "tint": "#bff8ff", "speedMps": [2, 4], "coneDeg": 70,
                              "lifeMs": 220, "notes": "per tick on whatever the beam hits"},
                "wallHit": {"decal": "scorch", "sizeM": 0.1},
                "light": {"color": "#5ff2ff", "intensity": 2.5, "rangeM": 2.5},
                "provisional": docs,
            },
            "pulse": {
                "kind": "orb", "from": "muzzle", "flipbook": "orb", "sizeM": 0.24, "speedMps": 8, "passesWalls": True,
                "charge": {"socket": "charge", "chargeS": 0.7, "sprite": "glow", "tint": "#6fb6ff", "sizeM": [0.03, 0.14],
                           "ring": {"sprite": "ring", "tint": "#9fd2ff", "fromM": 0.3, "toM": 0.06}},
                "trail": {"sprite": "glow", "tint": "#6fb6ff", "everyMs": 40, "sizeM": 0.14, "lifeMs": 240},
                "burst": {"radiusM": 2.5, "shockwave": {"texture": "shockwave.webp", "fromM": 0.2, "toM": 2.5, "ms": 280,
                                                        "tint": "#7fc4ff", "opacity": 0.9},
                          "flash": {"flipbook": "orb", "sizeM": 1.1, "ms": 180},
                          "light": {"color": "#7fc4ff", "intensity": 5.0, "rangeM": 5.0, "ms": 200}},
                "stunned": {"particle": "spark", "tint": "#9fd2ff", "everyMs": 120, "durationS": 3.0,
                            "notes": "crackle at the jetpack while it's disabled"},
                "light": {"color": "#6fb6ff", "intensity": 2.0, "rangeM": 2.0},
                "provisional": docs,
            },
            "ripper": {
                "kind": "blade", "from": "muzzle", "projectile": "blade", "speedMps": 18, "lifeS": 5,
                "charge": {"socket": "charge", "chargeS": 0.4, "spinUpRps": 14,
                           "sparks": {"particle": "spark", "everyMs": 50, "tint": "#ffe6a0", "speedMps": [1, 2.5]}},
                "trail": {"sprite": "glow", "tint": "#d8e2ea", "everyMs": 30, "sizeM": 0.2, "lifeMs": 120},
                "bounce": {"particle": "spark", "count": [8, 12], "tint": "#ffe08a", "speedMps": [3, 6], "coneDeg": 70,
                           "lifeMs": 300, "decal": "metal"},
                "expire": {"explosion": "frag", "scale": 0.5, "notes": "it explodes after 5 s"},
                "provisional": docs,
            },
            "popper": {
                "kind": "grenade", "from": "muzzle", "projectile": "grenade", "gravity": 1.0,
                "trail": {"particle": "dust", "tint": "#d9d4c8", "everyMs": 50, "sizeM": 0.08, "lifeMs": 350},
                "explosion": "grenade_launcher",
                "provisional": docs,
            },
            "thumper": {
                "kind": "rocket", "from": "muzzle", "projectile": "rocket",
                "trail": {"flame": {"flipbook": "flame", "frames": [0, 4], "sizeM": 0.22, "at": "trail"},
                          "smoke": {"particle": "dust", "tint": "#cfcac0", "everyMs": 25, "sizeM": 0.2, "lifeMs": 600}},
                "explosion": "rocket",
            },
            "riot_shield": {
                "kind": "shield", "at": "face", "maxHp": 300,
                "hit": {"impact": "metal", "ripple": {"sprite": "ring", "tint": "#cfe8ff", "fromM": 0.04, "toM": 0.22, "ms": 160}},
                "cracks": [{"belowHpFraction": 0.66, "sprite": "crack1"}, {"belowHpFraction": 0.33, "sprite": "crack2"},
                           {"belowHpFraction": 0.12, "sprite": "crack3"}],
                "break": {"particle": "chip", "count": [14, 18], "tint": "#5a5f48", "speedMps": [2, 5], "coneDeg": 90,
                          "gravity": 1, "lifeMs": 900},
                "notes": "cracks are a decal on the face socket, 2 × halfSize; bullets within ±60° hit the shield "
                         "(docs/03 §7); flames, explosions, melee and saws go round it",
                "provisional": "docs/03 §5 (300 HP) until packages/content has the shield",
            },
        },
    }
    (OUT / "specials.vfx.json").write_text(json.dumps(manifest, indent=1))
    write_index()
    print(f"build_specials: flame {flame['cellM']} m/cell; {len(CELLS)} sprites; beam; {len(manifest['styles'])} styles → {OUT}")


# vfx/manifest.json: the index a renderer starts from (what exists, which file has what). Written last,
# by the last VFX builder, from the files that are actually there.
INDEX = {
    "weapons": ("weapons.vfx.json", "build_vfx.py", "per weapon id: flash style + scale, tracer, casing and ejection, "
                "`special` (a specials style); flash atlas, tracer styles, casing feel"),
    "impacts": ("impacts.vfx.json", "build_impacts.py", "per surface material: impact flipbook, particles (spark, dust, "
                "chip), decals"),
    "explosions": ("explosions.vfx.json", "build_explosions.py", "flipbooks (frag, rocket) and styles per explosive: "
                   "radius, shockwave, light, debris, dust, scorch, camera shake; launchTrail"),
    "specials": ("specials.vfx.json", "build_specials.py", "flame stream, beam, EMP orb and burst, saw blade, rounds in "
                 "flight, riot-shield hits and cracks"),
    "projectiles": ("projectiles.json", "build_projectiles.py", "rocket, grenade round and saw blade meshes in "
                    "projectiles.glb (muzzle frame), trail point, spin"),
}


def write_index():
    files = {k: {"file": f, "builder": f"art/pipeline/{b}", "has": has} for k, (f, b, has) in INDEX.items() if (OUT / f).exists()}
    textures = sorted(p.name for p in OUT.glob("*.webp"))
    models = sorted(p.name for p in OUT.glob("*.glb"))
    (OUT / "manifest.json").write_text(json.dumps({
        "version": 1,
        "base": "assets/vfx/",
        "files": files,
        "textures": {name: list(Image.open(OUT / name).size) for name in textures},
        "models": models,
        "conventions": {
            "units": "metres and milliseconds unless a key says otherwise (S = seconds, Mps = m/s, Rps = turns/s)",
            "atlases": "cells are numbered row-major from the top left; `anchorUV` / `originU` have v from the top",
            "tints": "sRGB hex; white textures are meant to be tinted",
            "provisional": "a `provisional` key marks numbers taken from docs/03 until packages/content has them",
        },
    }, indent=1))


if __name__ == "__main__":
    main()
