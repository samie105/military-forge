"""Explosion VFX sized for blast launches (NOTES §17): fireball flipbooks, shockwave ring, debris,
scorch, light flash, camera-shake suggestion and the trail of a blast-launched player.

    python3 art/pipeline/build_explosions.py [--runtime apps/web/public/assets]

Inputs (art/vfx/source/, Higgsfield; prompts in art/README.md):
  explosion_frag.webp     16-frame toon explosion in a 4×4 grid (flash → fireball → smoke)
  explosion_rocket.webp   16-frame mushroom explosion with a base ring of smoke
Reuses vfx/particles.webp (debris, dust) and the `scorch` decal from build_impacts.py.

Outputs (<runtime>/vfx/):
  explosion_atlas.webp    2048×1024: frag frames in the left 4×4 cells of 256², rocket in the right.
                          A flipbook keeps its frames' positions relative to each other (one crop and
                          scale per sheet), so the anchor is the same point in every frame: the
                          fireball centre (frag) or the base of the smoke ring (rocket)
  shockwave.webp          256² soft ring, white, tinted
  explosions.vfx.json     styles per explosive, sized from packages/content (frag radius 4 m)
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "art/vfx/source"
argv = sys.argv[1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else REPO / "apps/web/public/assets"
OUT = RUNTIME / "vfx"
CELL = 256
ALPHA_FLOOR = 10


def content_radius(name):
    """Blast radius from packages/content/src/grenades.ts (the `explosion: { radius: N`)."""
    src = (REPO / "packages/content/src/grenades.ts").read_text()
    block = src[src.index(f"export const {name}"):]
    return float(re.search(r"explosion:\s*{\s*radius:\s*([\d.]+)", block).group(1))


FRAG_RADIUS = content_radius("FRAG")

# Flipbooks: the source sheet, where its anchor is, and the world size of a cell. `fireballM` is
# the full-size fireball's width (frag: 0.8 × the blast radius; the shockwave ring shows the radius).
FLIPBOOKS = {
    "frag": {"sheet": "explosion_frag", "anchor": "centre", "fps": 18, "fireballM": 0.8 * FRAG_RADIUS, "peak": 4},
    "rocket": {"sheet": "explosion_rocket", "anchor": "base", "fps": 16, "fireballM": 1.0 * FRAG_RADIUS, "peak": 3},
}
# Explosives → style. Radii come from content where it exists; the launcher has no content entry yet.
STYLES = {
    "frag": {"flipbook": "frag", "scale": 1.0, "radiusM": FRAG_RADIUS},
    "grenade_launcher": {"flipbook": "frag", "scale": 0.8, "radiusM": 0.8 * FRAG_RADIUS, "provisional": True},
    "rocket": {"flipbook": "rocket", "scale": 1.0, "radiusM": 1.25 * FRAG_RADIUS, "provisional": True},
}


def cells(sheet):
    a = np.asarray(sheet).copy()
    a[..., 3] = np.where(a[..., 3] < ALPHA_FLOOR, 0, a[..., 3])
    h, w = a.shape[:2]
    return [a[(i // 4) * h // 4:(i // 4 + 1) * h // 4, (i % 4) * w // 4:(i % 4 + 1) * w // 4] for i in range(16)]


def flipbook(spec):
    frames = cells(Image.open(SRC / f"{spec['sheet']}.webp").convert("RGBA"))
    ch, cw = frames[0].shape[:2]
    # the anchor, from the fireball frames (2–8): mean alpha centroid in x; centroid or base in y
    xs, ys = [], []
    for f in frames[1:8]:
        al = f[..., 3].astype(np.float32) / 255
        wsum = al.sum()
        xs.append((al.sum(axis=0) * np.arange(cw)).sum() / wsum)
        if spec["anchor"] == "centre":
            ys.append((al.sum(axis=1) * np.arange(ch)).sum() / wsum)
        else:
            rows = np.nonzero((al > 0.5).any(axis=1))[0]
            ys.append(rows.max())
    ax, ay = float(np.mean(xs)), float(np.median(ys))
    # one scale for the whole flipbook: the farthest opaque pixel from the anchor fits the cell
    reach = 0
    for f in frames:
        yy, xx = np.nonzero(f[..., 3] > 30)
        if len(xx):
            if spec["anchor"] == "centre":
                reach = max(reach, np.abs(xx - ax).max(), np.abs(yy - ay).max())
            else:
                reach = max(reach, 2 * np.abs(xx - ax).max(), ay - yy.min())
    # base anchor: 22 px above the cell bottom, room for the smoke ring that spills below it
    target = CELL / 2 - 6 if spec["anchor"] == "centre" else CELL - 30
    s = target / reach
    anchor_px = (CELL / 2, CELL / 2) if spec["anchor"] == "centre" else (CELL / 2, CELL - 22)
    tiles = []
    for f in frames:
        img = Image.fromarray(f).resize((round(cw * s), round(ch * s)), Image.LANCZOS)
        t = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        t.alpha_composite(img, (round(anchor_px[0] - ax * s), round(anchor_px[1] - ay * s)))
        arr = np.asarray(t).copy()
        # a 4 px fade at the cell edge: drops slivers of the neighbouring frame from the source grid
        edge = np.minimum.reduce(np.mgrid[0:CELL, 0:CELL].tolist() + [CELL - 1 - np.mgrid[0:CELL, 0:CELL][0],
                                                                        CELL - 1 - np.mgrid[0:CELL, 0:CELL][1]])
        arr[..., 3] = (arr[..., 3] * np.clip(edge / 4.0, 0, 1)).astype(np.uint8)
        tiles.append(Image.fromarray(arr))
    # world size of a cell from the peak fireball's width
    peak = np.asarray(tiles[spec["peak"]])[..., 3]
    cols = np.nonzero((peak > 128).any(axis=0))[0]
    cell_m = spec["fireballM"] * CELL / max(1, cols.max() - cols.min())
    return tiles, {"cellM": round(cell_m, 3), "anchorUV": [0.5, round(anchor_px[1] / CELL, 4)], "fps": spec["fps"],
                   "frames": 16, "anchor": spec["anchor"]}


def shockwave():
    n = 256
    y, x = np.mgrid[0:n, 0:n] / (n - 1) * 2 - 1
    r = np.sqrt(x ** 2 + y ** 2)
    a = np.exp(-((r - 0.86) / 0.06) ** 2) + 0.35 * np.exp(-((r - 0.78) / 0.12) ** 2)
    a = np.clip(a * (r < 1), 0, 1)
    out = np.dstack([np.ones_like(a), np.ones_like(a), np.ones_like(a), a])
    return Image.fromarray((out * 255).astype(np.uint8), "RGBA")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    atlas = Image.new("RGBA", (2048, 1024), (0, 0, 0, 0))
    books = {}
    for bi, (name, spec) in enumerate(FLIPBOOKS.items()):
        tiles, info = flipbook(spec)
        for i, t in enumerate(tiles):
            atlas.paste(t, (bi * 1024 + (i % 4) * CELL, (i // 4) * CELL))
        books[name] = {**info, "firstCell": [bi * 4, 0]}
    atlas.save(OUT / "explosion_atlas.webp", "WEBP", quality=86, alpha_quality=90, method=6)
    shockwave().save(OUT / "shockwave.webp", "WEBP", lossless=True)

    styles = {}
    for name, st in STYLES.items():
        r = st["radiusM"]
        styles[name] = {
            "flipbook": st["flipbook"], "scale": st["scale"], "radiusM": round(r, 2),
            **({"provisional": "no content entry yet: radius scaled from the frag"} if st.get("provisional") else {}),
            "shockwave": {"fromM": 0.3, "toM": round(r, 2), "ms": 220, "tint": "#fff6e0", "opacity": 0.85,
                          "notes": "a camera-facing ring growing to the blast radius: where the launch and damage reach"},
            "light": {"color": "#ffcf80", "intensity": round(6 + 2 * r / FRAG_RADIUS, 1), "rangeM": round(2.2 * r, 1), "ms": 160},
            "debris": {"kind": "chip", "count": [10, 14], "tint": "#4a4743", "sizeM": 0.07, "speedMps": [6, 12],
                       "coneDeg": 80, "gravity": 1, "lifeMs": 900},
            "dust": {"kind": "dust", "count": [5, 7], "tint": "#cfc6b4", "sizeM": round(0.18 * r, 2), "speedMps": [1.5, 3],
                     "alongGround": True, "gravity": -0.05, "lifeMs": 1100},
            "scorch": {"decal": "scorch", "sizeM": round(0.6 * r, 2), "onGroundOnly": False},
            "cameraShake": {"amplitudeM": round(0.35 * r / FRAG_RADIUS, 2), "freqHz": 14, "decayMs": 420,
                            "fullWithinM": round(r, 1), "zeroAtM": round(3.5 * r, 1), "verticalBias": 0.6},
        }
    manifest = {
        "version": 1,
        "atlas": "explosion_atlas.webp", "atlasSize": [2048, 1024], "cell": [CELL, CELL], "blend": "normal",
        "flipbooks": books,
        "shockwave": {"texture": "shockwave.webp", "blend": "additive"},
        "particles": {"texture": "particles.webp", "from": "impacts.vfx.json"},
        "decals": {"from": "impacts.vfx.json"},
        "styles": styles,
        "launchTrail": {
            "minSpeedMps": 12, "everyMs": 45, "kind": "dust", "tint": "#f4f1ea", "sizeM": 0.35, "lifeMs": 380,
            "notes": "puffs behind a player while a blast throws them faster than launchSpeedX (NOTES §17), so a "
                     "16 m flight reads as a launch, not a teleport; stops when they land",
        },
        "notes": "play the flipbook at fps on a camera-facing quad of cellM × scale with anchorUV on the blast "
                 "point (rocket: the base of its smoke ring, on the surface it hit); the first frames are bright: "
                 "draw them above the shockwave; camera shake is a suggestion for W1 (falls off from fullWithinM "
                 "to zeroAtM)",
    }
    (OUT / "explosions.vfx.json").write_text(json.dumps(manifest, indent=1))
    print(f"build_explosions: frag radius {FRAG_RADIUS} m; flipbooks " +
          ", ".join(f"{k} {v['cellM']} m/cell" for k, v in books.items()) + f" → {OUT}")


if __name__ == "__main__":
    main()
