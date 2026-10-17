"""Bullet impact VFX per surface, bullet-hole decals and particle textures, plus their manifest.

    python3 art/pipeline/build_impacts.py [--runtime apps/web/public/assets]

Inputs (art/vfx/source/, Higgsfield sheets; prompts in art/README.md):
  impact_<style>.webp   2×2 variants on a transparent background. Surface impacts burst UP from
                        the bottom-middle of their quarter (+V = the surface normal); `player` is a
                        centred, non-gory hit marker
  decals.webp           six bullet-hole decals in a 3×2 grid (concrete, metal, wood, dirt, glass,
                        scorch), seen flat

Outputs (<runtime>/vfx/):
  impact_atlas.webp     1024×1536, 24 cells of 256²: each frame's hit point sits at the same spot
                        of its cell (bottom-middle; centre for `player`)
  decal_atlas.webp      512×256, cells of 128², one decal per cell
  particles.webp        256×64: spark streak, dust puff, chip (64² each, white, tinted per style)
  impacts.vfx.json      styles per surface (keyed by the sim's packages/content Material ids),
                        particles, decals with lifetime and cap, and the player hit
"""
import json
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
ATLAS = (1024, 1536)
COLS = ATLAS[0] // CELL
ALPHA_FLOOR = 10
DECAL = 128
DECAL_ORDER = ["concrete", "metal", "wood", "dirt", "glass", "scorch"]

# sim materials (packages/content/src/maps/types.ts Material) → impact style
MATERIALS = {0: "concrete", 1: "metal", 2: "wood", 3: "dirt", 4: "glass"}
# sizeM: world height of the tallest frame; ms: life (pop in over the first 25%, fade over the last 50%)
IMPACT = {
    "concrete": {"sizeM": 0.45, "ms": 260, "anchor": "bottom",
                 "particles": [{"kind": "chip", "count": [3, 5], "tint": "#9a9a96", "sizeM": 0.035, "speedMps": [2, 4],
                                "coneDeg": 50, "gravity": 1, "lifeMs": 500},
                               {"kind": "dust", "count": [1, 2], "tint": "#c9c6bf", "sizeM": 0.25, "speedMps": [0.3, 0.6],
                                "coneDeg": 30, "gravity": -0.1, "lifeMs": 700}]},
    "metal": {"sizeM": 0.40, "ms": 160, "anchor": "bottom",
              "particles": [{"kind": "spark", "count": [5, 8], "tint": "#fff2a0", "sizeM": 0.08, "speedMps": [4, 8],
                             "coneDeg": 70, "gravity": 1, "lifeMs": 300, "blend": "additive"}]},
    "wood": {"sizeM": 0.45, "ms": 240, "anchor": "bottom",
             "particles": [{"kind": "chip", "count": [3, 6], "tint": "#c49a62", "sizeM": 0.04, "speedMps": [2, 4],
                            "coneDeg": 55, "gravity": 1, "lifeMs": 600},
                           {"kind": "dust", "count": [1, 1], "tint": "#d8bf98", "sizeM": 0.2, "speedMps": [0.3, 0.5],
                            "coneDeg": 30, "gravity": -0.1, "lifeMs": 600}]},
    "dirt": {"sizeM": 0.6, "ms": 320, "anchor": "bottom",
             "particles": [{"kind": "chip", "count": [3, 5], "tint": "#7a5a3a", "sizeM": 0.035, "speedMps": [2, 5],
                            "coneDeg": 25, "gravity": 1, "lifeMs": 700},
                           {"kind": "dust", "count": [2, 3], "tint": "#cdb48a", "sizeM": 0.3, "speedMps": [0.4, 0.8],
                            "coneDeg": 25, "gravity": -0.1, "lifeMs": 900}]},
    "glass": {"sizeM": 0.45, "ms": 220, "anchor": "bottom",
              "particles": [{"kind": "chip", "count": [5, 8], "tint": "#e6f4ff", "sizeM": 0.03, "speedMps": [2, 5],
                             "coneDeg": 70, "gravity": 1, "lifeMs": 600},
                            {"kind": "spark", "count": [2, 3], "tint": "#ffffff", "sizeM": 0.05, "speedMps": [3, 5],
                             "coneDeg": 60, "gravity": 0.5, "lifeMs": 200, "blend": "additive"}]},
    # the hit marker on a player: a comic pop, no blood (age rating), white-yellow so it never reads as a team colour
    "player": {"sizeM": 0.5, "ms": 180, "anchor": "centre", "particles": []},
}
DECALS = {
    "concrete": {"sizeM": 0.14}, "metal": {"sizeM": 0.12}, "wood": {"sizeM": 0.15},
    "dirt": {"sizeM": 0.14}, "glass": {"sizeM": 0.18}, "scorch": {"sizeM": 0.5},
}
DECAL_LIFE_MS, DECAL_FADE_MS, DECAL_MAX = 8000, 1000, 64


def clean(a):
    a = a.copy()
    a[..., 3] = np.where(a[..., 3] < ALPHA_FLOOR, 0, a[..., 3])
    return a


def impact_frames(sheet, anchor):
    """The 4 variants of a 2×2 sheet: (rgba, hit point (x, y), extent) in sheet px."""
    a = clean(np.asarray(sheet))
    h, w = a.shape[:2]
    out = []
    for qy in range(2):
        for qx in range(2):
            q = a[qy * h // 2:(qy + 1) * h // 2, qx * w // 2:(qx + 1) * w // 2]
            alpha = q[..., 3].astype(np.float32) / 255
            ys, xs = np.nonzero(alpha > 0.15)
            if anchor == "centre":
                wsum = alpha.sum()
                cx = float((alpha.sum(axis=0) * np.arange(alpha.shape[1])).sum() / wsum)
                cy = float((alpha.sum(axis=1) * np.arange(alpha.shape[0])).sum() / wsum)
                ext = max(xs.max() - cx, cx - xs.min(), ys.max() - cy, cy - ys.min())
            else:
                solid = np.nonzero((alpha > 0.4).any(axis=1))[0]
                cy = float(solid.max())
                band = alpha[max(0, int(cy) - max(2, int(0.06 * (cy - ys.min())))):int(cy) + 1]
                cx = float((band.sum(axis=0) * np.arange(band.shape[1])).sum() / max(1e-6, band.sum()))
                ext = max(cy - ys.min(), 2 * max(xs.max() - cx, cx - xs.min()))
            out.append((q, (cx, cy), float(ext)))
    return out


def build_impact_atlas():
    atlas = Image.new("RGBA", ATLAS, (0, 0, 0, 0))
    styles, cell = {}, 0
    for style, spec in IMPACT.items():
        frames = impact_frames(Image.open(SRC / f"impact_{style}.webp").convert("RGBA"), spec["anchor"])
        ext = max(e for *_, e in frames)
        # bottom anchor: the hit point 6 px above the cell bottom, the burst fills the height;
        # centre anchor: the hit point in the middle, the burst fills half the cell each way
        target = (CELL - 10) if spec["anchor"] == "bottom" else (CELL / 2 - 6)
        s = target / ext
        hit = (CELL / 2, CELL - 6) if spec["anchor"] == "bottom" else (CELL / 2, CELL / 2)
        ids = []
        for q, (cx, cy), _ in frames:
            img = Image.fromarray(q).resize((max(1, round(q.shape[1] * s)), max(1, round(q.shape[0] * s))), Image.LANCZOS)
            tile = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
            tile.alpha_composite(img, (round(hit[0] - cx * s), round(hit[1] - cy * s)))
            arr = np.asarray(tile).copy()
            if spec["anchor"] == "centre":
                # the marker's soft glow would end in a hard square at the cell edge: fade it out radially
                yy, xx = np.mgrid[0:CELL, 0:CELL]
                r = np.hypot(xx - hit[0], yy - hit[1]) / (CELL / 2)
                arr[..., 3] = (arr[..., 3] * np.clip((1.0 - r) / 0.25, 0, 1)).astype(np.uint8)
            arr[[0, -1], :, 3] = 0
            arr[:, [0, -1], 3] = 0
            atlas.paste(Image.fromarray(arr), ((cell % COLS) * CELL, (cell // COLS) * CELL))
            ids.append(cell)
            cell += 1
        full = spec["sizeM"] * CELL / (target if spec["anchor"] == "bottom" else 2 * target)
        styles[style] = {"frames": ids, "quadM": round(full, 4),
                         "hitUV": [0.5, round(hit[1] / CELL, 4)] if spec["anchor"] == "bottom" else [0.5, 0.5],
                         "ms": spec["ms"], "anchor": spec["anchor"], "particles": spec["particles"],
                         "decal": style if style in DECALS else None}
    return atlas, styles


def build_decals():
    sheet = clean(np.asarray(Image.open(SRC / "decals.webp").convert("RGBA")))
    h, w = sheet.shape[:2]
    atlas = Image.new("RGBA", (512, 256), (0, 0, 0, 0))
    cells = {}
    for i, name in enumerate(DECAL_ORDER):
        q = sheet[(i // 3) * h // 2:(i // 3 + 1) * h // 2, (i % 3) * w // 3:(i % 3 + 1) * w // 3]
        alpha = q[..., 3]
        ys, xs = np.nonzero(alpha > 20)
        crop = Image.fromarray(q[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
        side = max(crop.size)
        s = (DECAL - 8) / side
        crop = crop.resize((max(1, round(crop.size[0] * s)), max(1, round(crop.size[1] * s))), Image.LANCZOS)
        tile = Image.new("RGBA", (DECAL, DECAL), (0, 0, 0, 0))
        tile.alpha_composite(crop, ((DECAL - crop.size[0]) // 2, (DECAL - crop.size[1]) // 2))
        atlas.paste(tile, ((i % 4) * DECAL, (i // 4) * DECAL))
        cells[name] = {"cell": i, **DECALS[name]}
    return atlas, cells


def particles_texture():
    """spark (a streak, head at +U), dust (a soft puff), chip (a hard-edged blob): white, tinted per use."""
    n = 64
    y, x = np.mgrid[0:n, 0:n] / (n - 1) * 2 - 1
    spark = np.clip(1 - np.abs(y) / 0.18, 0, 1) ** 1.5 * np.clip((x + 1) / 2, 0, 1) ** 2
    dust = np.clip(1 - np.sqrt(x ** 2 + y ** 2), 0, 1) ** 1.6
    r = np.sqrt((x * 1.1) ** 2 + (y * 0.9) ** 2) + 0.12 * np.sin(5 * np.arctan2(y, x))
    chip = np.clip((0.7 - r) / 0.06, 0, 1)  # anti-aliased edge
    out = np.zeros((n, 4 * n, 4), dtype=np.float32)
    for i, a in enumerate((spark, dust, chip)):
        out[:, i * n:(i + 1) * n, :3] = 1.0
        out[:, i * n:(i + 1) * n, 3] = a
    return Image.fromarray((out * 255).astype(np.uint8), "RGBA")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    atlas, styles = build_impact_atlas()
    atlas.save(OUT / "impact_atlas.webp", "WEBP", quality=86, alpha_quality=90, method=6)
    decals, decal_cells = build_decals()
    decals.save(OUT / "decal_atlas.webp", "WEBP", quality=90, alpha_quality=95, method=6)
    particles_texture().save(OUT / "particles.webp", "WEBP", lossless=True)
    manifest = {
        "version": 1,
        "materials": {str(k): v for k, v in MATERIALS.items()},
        "impact": {"atlas": "impact_atlas.webp", "atlasSize": list(ATLAS), "cell": [CELL, CELL], "blend": "normal",
                   "styles": styles,
                   "notes": "draw a random frame on a camera-facing quad of quadM × quadM with hitUV on the hit point and "
                            "+V along the surface normal (centre anchor: no rotation); scale 0.6 → 1.0 over the first 25% "
                            "of ms and fade over the last 50%; `player` is the hit marker on a character"},
        "particles": {"texture": "particles.webp", "cells": {"spark": 0, "dust": 1, "chip": 2}, "cell": [64, 64],
                      "notes": "per impact: count in [min, max]; velocity speedMps along the normal within coneDeg; "
                               "gravity in g (negative floats up); sparks stretch along their velocity"},
        "decals": {"atlas": "decal_atlas.webp", "atlasSize": [512, 256], "cell": [DECAL, DECAL], "styles": decal_cells,
                   "lifeMs": DECAL_LIFE_MS, "fadeMs": DECAL_FADE_MS, "maxLive": DECAL_MAX,
                   "notes": "on map surfaces only (never on characters): in the side view, on the camera-facing front "
                            "face of the hit geometry at the hit (x, y); a random roll; the oldest goes first when "
                            "maxLive is reached; `scorch` is for explosions"},
    }
    (OUT / "impacts.vfx.json").write_text(json.dumps(manifest, indent=1))
    print(f"build_impacts: {sum(len(s['frames']) for s in styles.values())} impact frames in {ATLAS[0]}×{ATLAS[1]}, "
          f"{len(decal_cells)} decals, 3 particle sprites → {OUT}")


if __name__ == "__main__":
    main()
