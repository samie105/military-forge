"""Weapon camos: six tileable patterns + palettes, applied to the `_CAMO` panels of each weapon.

    python3 art/pipeline/build_camos.py [--runtime apps/web/public/assets]

Weapons have no UVs (vertex colours on one material), so a camo works like the characters' dye
mask, but in object space: build_weapons.py marks body panels with a `_CAMO` vertex attribute
(grips, steel, the toy muzzle tip and blades stay as they are, so every weapon keeps its role and
silhouette), and the renderer projects a tileable pattern onto those panels (triplanar, in the
weapon's frame) and colours its levels from a palette. apps/web/src/armory/camo.ts is the reference
shader.

Patterns are periodic noise (built in the frequency domain, so they tile exactly), quantised into
3–4 levels by quantile. Output (<runtime>/weapons/):
  camo_patterns.png   1024×512, 4×2 cells of 256²; level i stored as round(255·i/(levels−1)) in R
  camos.json          per camo: name, cell, palette (sRGB, one colour per level), tile size in metres
Exits 1 if a palette colour is within 25 ΔE of a team colour (camos never read as a team).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
argv = sys.argv[1:]
RUNTIME = Path(argv[argv.index("--runtime") + 1]) if "--runtime" in argv else REPO / "apps/web/public/assets"
OUT = RUNTIME / "weapons"
N = 256
TEAM = {"blue": "#2f7dff", "orange": "#ff7a1a"}  # tools/art-preview TEAM; asset-check kit rule

# id: (name, palette dark → light by share, beta (1/f^beta: higher = blobbier), stretch (x, y), pixel block, seed)
CAMOS = {
    "forest_patch": ("Forest Patch", ["#23241f", "#3d4a2a", "#6b5034", "#5f6b3a"], 3.2, (1, 1), 0, 3),
    "dune": ("Dune", ["#9c7f52", "#b59d6e", "#cbb78c"], 3.4, (1, 1), 0, 5),
    "concrete": ("Concrete", ["#5c6064", "#8a8d90", "#b9bcbe"], 2.6, (1, 1), 0, 7),
    "snowline": ("Snowline", ["#7f8a93", "#b8bfc6", "#e6e9ec"], 3.0, (1, 1), 0, 11),
    "stripe": ("Stripe", ["#1f201c", "#5a4430", "#4b5a33"], 2.8, (4, 1), 0, 13),
    "pixel": ("Pixel", ["#2f352c", "#4e5a48", "#6f7a5d", "#93987c"], 2.6, (1, 1), 16, 17),
}
TILE_M = 0.30  # one pattern tile covers 30 cm of weapon


def periodic_noise(beta, stretch, seed):
    rng = np.random.default_rng(seed)
    fx = np.fft.fftfreq(N)[None, :] * stretch[0]
    fy = np.fft.fftfreq(N)[:, None] * stretch[1]
    f = np.sqrt(fx ** 2 + fy ** 2)
    f[0, 0] = 1
    spec = (rng.normal(size=(N, N)) + 1j * rng.normal(size=(N, N))) / f ** (beta / 2)
    spec[0, 0] = 0
    field = np.real(np.fft.ifft2(spec))
    return (field - field.min()) / (field.max() - field.min())


def quantise(field, levels):
    edges = np.quantile(field, np.linspace(0, 1, levels + 1)[1:-1])
    return np.digitize(field, edges)


def lab(hex_):
    c = np.array([int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = (m @ lin) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def main():
    errors = []
    atlas = np.zeros((2 * N, 4 * N), dtype=np.uint8)
    camos = {}
    for i, (cid, (name, palette, beta, stretch, block, seed)) in enumerate(CAMOS.items()):
        for col in palette:
            for team, t in TEAM.items():
                d = float(np.linalg.norm(lab(col) - lab(t)))
                if d < 25:
                    errors.append(f"{cid}: {col} is {d:.0f} ΔE from team {team}")
        field = periodic_noise(beta, stretch, seed)
        if block:  # digital: blocks of `block` px (256 is a multiple, so it still tiles)
            field = field.reshape(N // block, block, N // block, block).mean(axis=(1, 3)).repeat(block, 0).repeat(block, 1)
        levels = quantise(field, len(palette))
        cell = levels * 255 // (len(palette) - 1)
        x0, y0 = (i % 4) * N, (i // 4) * N
        atlas[y0:y0 + N, x0:x0 + N] = cell
        camos[cid] = {"name": name, "cell": i, "palette": palette, "levels": len(palette), "tileM": TILE_M}
    if errors:
        for e in errors:
            print("ERROR:", e)
        sys.exit(1)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(atlas, "L").save(OUT / "camo_patterns.png", optimize=True)
    doc = {
        "patterns": "camo_patterns.png", "atlasSize": [4 * N, 2 * N], "cell": [N, N],
        "encoding": "R = round(255 · level / (levels − 1)); sample with nearest filtering and no mipmaps",
        "applies": "vertices whose _CAMO attribute is 1 (body panels); project triplanar in the weapon frame, "
                   "one tile per tileM metres; the toon lighting shades it",
        "camos": camos,
    }
    (OUT / "camos.json").write_text(json.dumps(doc, indent=1))
    print(f"build_camos: {len(camos)} camos → {OUT}")


if __name__ == "__main__":
    main()
