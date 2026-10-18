#!/usr/bin/env python3
"""
House art for billboard ads (docs/14 §2.1 house-only pool, §3.4 grade, §3.5 checks) → runtime layers.

    python3 -I apps/web/scripts/house-ads.py <map> <raw_dir> apps/web/public/assets/ads

Every map with ad slots carries its own local house pool (POOLS below; the renderer is generic and
reads <out>/<map>/house.json). <raw_dir> holds that map's Higgsfield originals (GPT Image 2.5,
high 1k; job ids in art/README.md's cost table); they are not committed. Per image:
- crop to the exact format: 4:3 Screens; 6:1 Hoardings are found as the banner band between the
  flat grey margins the prompt asked for, then trimmed to 6:1;
- palette-relative grade (§3.4): contrast compressed toward mid grey, saturation cut, a luminance
  ceiling and a little of the map's haze, so a creative never outshines the play plane;
- signal-hue check (§3.5), on the final shipped pixels at full size: the share of pixels within
  ±15° of team blue, team orange or damage/low-HP red at saturation > 0.4 must stay under 15% (§3.5
  sends it to a reviewer above that); we keep a margin and lower the saturation of any image over
  10% until the encoded file passes;
- records each creative's mean relative luminance (linear), for the per-look brightness test
  (render3d/ads: a board never outshines the kit around it, docs/14 §3.4);
- resized to about its drawn size at 1080p and 1× (§2.1: a Screen ≈ 360 × 270 px, a Hoarding
  ≈ 810 × 135 px) and written as WebP. KTX2/ETC1S would let the full 32 + 8 layer pool fit in
  ≈ 5.1 MB of GPU memory (§4.9) but needs `toktx`/`basisu`, a user install; this fallback uploads
  only the house pool as RGBA8 (≈ 8.6 MB with mips).
Writes <out>/<map>/house.json: the pool the renderer loads.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SCREEN = (384, 288)
HOARDING = (864, 144)
# gameplay signal hues (docs/14 §3.5): team blue #2f7dff, team orange #ff7a1a, damage/low-HP red #f85149
SIGNAL_HUES = {"teamBlue": 216.0, "teamOrange": 25.0, "damageRed": 3.0}
SIGNAL_LIMIT = 0.10

# per map folder: (map id, [(creative id, source, format, title)]); titles are for logs and the
# About-ads page later. The Street Market is the Lagos map: invented local businesses and civic notices.
POOLS = {
    "street_market": (
        "street-market",
        [
            ("house:sm-bakery", "s0_bakery.png", "4:3", "Sunrise Bakery"),
            ("house:sm-kitchen", "s1_kitchen.png", "4:3", "Market Kitchen"),
            ("house:sm-tailors", "s2_tailors.png", "4:3", "Golden Needle Tailors"),
            ("house:sm-gutters", "s3_gutters.png", "4:3", "Keep our gutters clear"),
            ("house:sm-zebra", "s4_zebra.png", "4:3", "Cross at the zebra"),
            ("house:sm-water", "s5_water.png", "4:3", "Drink clean water"),
            ("house:sm-fish", "s6_fish.png", "4:3", "Harbour Fish Market"),
            ("house:sm-market-day", "s7_marketday.png", "4:3", "Market day"),
            ("house:sm-city-market", "h8_citymarket.png", "6:1", "City Market"),
            ("house:sm-trees", "h9_trees.png", "6:1", "Plant a tree"),
            ("house:sm-slow-down", "h10_slowdown.png", "6:1", "Slow down near the market"),
            ("house:sm-bakery-wide", "h11_bakery.png", "6:1", "Sunrise Bakery"),
        ],
    ),
}

GRADE = {"contrast": 0.8, "sat": 0.8, "ceiling": 0.9, "haze": (196, 207, 214), "hazeAmount": 0.06}


def crop_ratio(im, ratio):
    w, h = im.size
    if w / h > ratio:
        nw = round(h * ratio)
        x0 = (w - nw) // 2
        return im.crop((x0, 0, x0 + nw, h))
    nh = round(w / ratio)
    y0 = (h - nh) // 2
    return im.crop((0, y0, w, y0 + nh))


def banner_band(im):
    """Rows of the 6:1 banner: everything that isn't the flat grey margin."""
    a = np.asarray(im.convert("RGB"), dtype=np.float64)
    grey = np.median(np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3)]), axis=0)
    diff = np.abs(a - grey).sum(axis=-1).mean(axis=1)
    rows = np.nonzero(diff > 12)[0]
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    inset = 3  # the band's anti-aliased edge
    return im.crop((0, top + inset, im.size[0], bottom - inset))


def to_banner(band, ratio=6.0):
    """Exactly `ratio`, never cutting the design: a band wider than that grows top and bottom in
    its own background colour, a taller one grows at the sides."""
    w, h = band.size
    a = np.asarray(band.convert("RGB"))
    border = np.concatenate([a[:2].reshape(-1, 3), a[-2:].reshape(-1, 3), a[:, :2].reshape(-1, 3), a[:, -2:].reshape(-1, 3)])
    fill = tuple(int(v) for v in np.median(border, axis=0).round())
    if w / h >= ratio:
        out = Image.new("RGB", (w, round(w / ratio)), fill)
        out.paste(band, (0, (out.size[1] - h) // 2))
    else:
        out = Image.new("RGB", (round(h * ratio), h), fill)
        out.paste(band, ((out.size[0] - w) // 2, 0))
    return out


def grade(arr, g, sat):
    rgb = arr.astype(np.float64)
    luma = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
    rgb = luma + (rgb - luma) * sat
    rgb = 128 + (rgb - 128) * g["contrast"]
    rgb = np.minimum(rgb, 255 * g["ceiling"])
    rgb = rgb + (np.array(g["haze"]) - rgb) * g["hazeAmount"]
    return np.clip(rgb, 0, 255)


def hsv(rgb):
    """HSV of an (…, 3) array of 0–255 sRGB values: hue in degrees, saturation and value 0–1."""
    c = rgb.astype(np.float64) / 255
    mx, mn = c.max(axis=-1), c.min(axis=-1)
    d = mx - mn
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    with np.errstate(invalid="ignore", divide="ignore"):
        h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
        sat = np.where(mx > 0, d / mx, 0)
    return np.nan_to_num(h), sat, mx


def signal_share(rgb):
    """Share of pixels within ±15° of each signal hue at saturation > 0.4 (HSV), on these exact pixels."""
    h, sat, v = hsv(rgb)
    out = {}
    for name, hue in SIGNAL_HUES.items():
        dh = np.abs(h - hue)
        dh = np.minimum(dh, 360 - dh)
        out[name] = float(((dh <= 15) & (sat > 0.4) & (v > 0.15)).mean())
    return out


def mean_luminance(rgb):
    """Mean relative luminance, linear (sRGB decoded)."""
    c = rgb.astype(np.float64) / 255
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return float((lin @ np.array([0.2126, 0.7152, 0.0722])).mean())


def encode(graded, size, path):
    """Writes the WebP and returns the pixels exactly as shipped (decoded back)."""
    Image.fromarray(graded.round().astype(np.uint8)).resize(size, Image.LANCZOS).save(path, "WEBP", quality=88, method=6)
    return np.asarray(Image.open(path).convert("RGB"))


def main():
    key, raw, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    map_id, entries = POOLS[key]
    dest = out / key
    dest.mkdir(parents=True, exist_ok=True)
    pool = {"screens": [], "hoardings": []}
    for cid, src, fmt, title in entries:
        im = Image.open(raw / src).convert("RGB")
        im = crop_ratio(im, 4 / 3) if fmt == "4:3" else to_banner(banner_band(im))
        arr = np.asarray(im)
        size = SCREEN if fmt == "4:3" else HOARDING
        name = cid.split(":")[1] + ".webp"
        sat = GRADE["sat"]
        shipped = encode(grade(arr, GRADE, sat), size, dest / name)
        share = signal_share(shipped)
        while max(share.values()) >= SIGNAL_LIMIT and sat > 0.3:
            sat = round(sat - 0.1, 2)
            shipped = encode(grade(arr, GRADE, sat), size, dest / name)
            share = signal_share(shipped)
        entry = {
            "id": cid,
            "file": name,
            "title": title,
            "signalHues": {k: round(v, 3) for k, v in share.items()},
            "saturation": sat,
            "luminance": round(mean_luminance(shipped), 4),
        }
        (pool["screens"] if fmt == "4:3" else pool["hoardings"]).append(entry)
        print(f"{cid}: {size[0]}x{size[1]} {(dest / name).stat().st_size} B, signal hues {entry['signalHues']}, sat {sat:.2f}, lum {entry['luminance']}")
    (dest / "house.json").write_text(json.dumps({"version": 1, "map": map_id, **pool}, indent=1) + "\n")
    total = sum((dest / e["file"]).stat().st_size for e in pool["screens"] + pool["hoardings"])
    print(json.dumps({"total_bytes": total}))


if __name__ == "__main__":
    main()
