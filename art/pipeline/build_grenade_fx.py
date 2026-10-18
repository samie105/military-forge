"""Grenade readability VFX: smoke puffs for throw trails, and how each throwable shows itself in flight.

    python3 art/pipeline/build_grenade_fx.py [--runtime apps/web/public/assets]

The first grenade trails were faint white lines that vanished against a light sky, and the frag itself
was half its sim size. The models are fixed in build_weapons.py (frag at the content radius, a light
band, a fuse light; mine with a hazard rim and a tintable state light). This adds what flies with them.

Outputs (<runtime>/vfx/):
  trail_puffs.webp   512×256, 8 puff variants in cells of 128². Toon-lit from above (three value bands)
                     with a darker lower rim, in neutral greys: a trail reads on light sky (the dark
                     rim) and on dark ground (the light tops). Normal blend; a tint multiplies.
  grenades.vfx.json  per throwable kind: model, trail (rate, size over life, life, tint, rise),
                     fuse / state light (node, colours, blink), outline suggestion. The frag's fuse
                     comes from packages/content; the mine's timings from docs/02 §14.
Re-writes vfx/manifest.json (build_specials.write_index).
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_specials  # noqa: E402  (the vfx/manifest.json index)

REPO = Path(__file__).resolve().parents[2]
argv = sys.argv[1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else REPO / "apps/web/public/assets"
OUT = RUNTIME / "vfx"
C = 128
LIGHT = np.array([-0.35, -0.75, 0.55])  # from the upper left, toward the viewer (x right, y down, z out)
LIGHT /= np.linalg.norm(LIGHT)


def blur(a, sigma):
    """Separable Gaussian blur of a 2-D array (edge-clamped)."""
    r = int(3 * sigma)
    k = np.exp(-(np.arange(-r, r + 1) / sigma) ** 2 / 2)
    k /= k.sum()
    p = np.pad(a, r, mode="edge")
    p = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, p)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, p)


def puff(seed):
    """One cartoon smoke puff: many soft lobes merged into one cloud, toon-lit, darker underneath."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:C, 0:C] / (C - 1) * 2 - 1
    height = np.zeros((C, C))
    for _ in range(rng.integers(7, 11)):
        ang, dist = rng.uniform(0, 2 * math.pi), rng.uniform(0, 0.38)
        cx, cy = dist * math.cos(ang), dist * math.sin(ang) * 0.85 + 0.04
        rad = rng.uniform(0.16, 0.3)
        d2 = (x - cx) ** 2 + (y - cy) ** 2
        height = np.maximum(height, np.sqrt(np.clip(rad ** 2 - d2, 0, None)))
    height = blur(height, 2.5)  # the lobes merge into one cloud: no hard crescents between them
    mask = np.clip((height - 0.012) / 0.05, 0, 1)
    gy, gx = np.gradient(height, 2 / (C - 1))
    n = np.dstack([-gx, -gy, np.full_like(height, 0.6)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    lam = np.clip((n * LIGHT).sum(axis=2), 0, 1)
    value = np.where(lam > 0.5, 0.95, 0.66)  # two toon bands: lit top, shaded body
    # the dark lip underneath: a band just inside the lower edge
    lower = np.clip(n[..., 1] * 1.6 - 0.35, 0, 1)  # image y grows downward: a lower edge has n.y > 0
    lip = (mask > 0) & (mask < 0.999) | (height < 0.05)
    value = np.where(lip & (lower > 0.3) & (mask > 0), 0.4, value)
    a = mask * 0.94
    rgb = np.dstack([value * 0.98, value * 0.98, value])  # a hair cooler than pure grey
    return Image.fromarray((np.dstack([np.clip(rgb, 0, 1), a]) * 255).astype(np.uint8), "RGBA")


def frag_fuse():
    src = (REPO / "packages/content/src/grenades.ts").read_text()
    block = src[src.index("export const FRAG"):]
    return float(re.search(r"\bfuse:\s*([\d.]+)", block).group(1))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (4 * C, 2 * C), (0, 0, 0, 0))
    for i in range(8):
        sheet.paste(puff(40 + i), ((i % 4) * C, (i // 4) * C))
    sheet.save(OUT / "trail_puffs.webp", "WEBP", lossless=True)
    fuse = frag_fuse()
    doc = {
        "version": 1,
        "puffs": {"texture": "trail_puffs.webp", "size": [4 * C, 2 * C], "cell": [C, C], "variants": 8, "blend": "normal",
                  "notes": "toon-lit from above with a darker lower rim: reads on light sky and dark ground; pick a "
                           "variant per puff, roll it ±25°, tint multiplies"},
        "kinds": {
            "frag": {
                "model": "weapons/frag.glb", "simRadiusM": 0.1, "spinRps": 2.5,
                "trail": {"everyMs": 28, "minSpeedMps": 2.5, "sizeM": [0.14, 0.42], "lifeMs": 650, "tint": "#f4f1ea",
                          "alpha": [0.9, 0.0], "riseMps": 0.25, "drag": 2.0, "jitterM": 0.03,
                          "notes": "puffs at the grenade's centre while it moves; they grow and fade, no line"},
                "fuseLight": {"node": "light", "color": "#ff3b2f", "fuseS": fuse,
                              "blinkHz": {"from": 2, "to": 10}, "reducedMotionMaxHz": 3,
                              "notes": "blinks faster as the fuse runs out; fuseS from packages/content FRAG.fuse"},
                "outline": {"color": "#121212", "px": 2, "notes": "keeps the olive body readable on mid-tone walls"},
            },
            "mine": {
                "model": "weapons/mine.glb", "spinRps": 0,
                "trail": {"everyMs": 40, "minSpeedMps": 2.5, "sizeM": [0.1, 0.28], "lifeMs": 450, "tint": "#eef0f2",
                          "alpha": [0.8, 0.0], "riseMps": 0.15, "drag": 2.5, "jitterM": 0.02},
                "stateLight": {"node": "light", "flying": "#3ddc5a", "arming": "#ffd23a",
                               "armed": {"color": "#ff3b2f", "blinkHz": 4}, "armS": 2.0, "triggerBeepMs": 250,
                               "reducedMotionMaxHz": 3,
                               "notes": "docs/02 §14: green flying, yellow stuck/arming, flashing red armed; the light "
                                        "dome is near-white so tint it"},
                "outline": {"color": "#121212", "px": 2},
            },
        },
    }
    (OUT / "grenades.vfx.json").write_text(json.dumps(doc, indent=1))
    build_specials.OUT = OUT
    build_specials.write_index()
    print(f"build_grenade_fx: 8 trail puffs; frag fuse {fuse} s → {OUT}")


if __name__ == "__main__":
    main()
