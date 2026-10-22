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
- written twice, both at about its drawn size at 1080p and 1× (§2.1: a Screen ≈ 360 × 270 px, a
  Hoarding ≈ 810 × 135 px): WebP, the fallback where the runtime can't transcode, and an ETC1S
  KTX2 layer (basisu, with the block-aligned mips) that stays compressed on the GPU (§4.5's ETC1S
  layer pool), at the best quality within 1.2× the WebP's bytes (players on mobile data), or the
  lowest if none fits: a format's layers are one array, so every creative needs its copy.
Writes <out>/<map>/house.json: the pool the renderer loads. `--ktx2-only` keeps the shipped WebPs
and saturations and only rewrites the KTX2 layers.

The studio's own creatives (Deet Studios, who make the game) go through the same grade and checks
into the pool's `studio` lists: every match shows some of them (render3d/ads houseManifest). Their
masters are committed (art/ads/deet, designed in Pen at docs/14 §3.1's upload sizes, exactly 4:3 or
6:1), so they can be rebuilt without the house art's raw originals:

    python3 -I apps/web/scripts/house-ads.py <map> --studio-only apps/web/public/assets/ads

A studio creative with several sources is a Motion creative (docs/14 §3.3): still keyframes, all
graded alike; the first is its `file` (and the still where keyframes don't play), the rest its
`keys`. Each keyframe's mean luminance is recorded, so the tests can hold the change between them
far under a flash.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import backdrops  # noqa: E402  (ktx2 helpers)

SCREEN = (384, 288)
HOARDING = (864, 144)
# KTX2 layers: the WebP's size (block-aligned for the first mip levels: backdrops.py ktx2_levels)
KTX2_SIZE = {"4:3": SCREEN, "6:1": HOARDING}
KTX2_MAX_RATIO = 1.2
KTX2_QUALITIES = (95, 80, 65, 50)
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

# per map folder: [(creative id, sources, format, title)], sources in art/ads/deet. Screens alternate
# still / Motion, so the two a match takes (houseManifest) usually include one Motion creative.
STUDIO_DIR = Path(__file__).resolve().parents[3] / "art" / "ads" / "deet"
STUDIO = {
    "street_market": [
        ("house:deet-wordmark", ("s0_deet_wordmark.png",), "4:3", "DEET Studios: Products. Worlds. Games."),
        ("house:deet-we-build-motion", ("m0_deet_we_build_k0.png", "m0_deet_we_build_k1.png"), "4:3", "DEET Studios: We build / The whole thing."),
        ("house:deet-one-studio", ("s1_deet_one_studio.png",), "4:3", "DEET Studios: One studio, brand through to backend."),
        ("house:deet-products-motion", ("m1_deet_products_k0.png", "m1_deet_products_k1.png"), "4:3", "DEET Studios: Products. Worlds. Games. / Your idea, built whole."),
        ("house:deet-we-build", ("s2_deet_we_build.png",), "4:3", "DEET Studios: We build products that scale."),
        ("house:deet-wordmark-wide", ("h0_deet_wordmark.png",), "6:1", "DEET Studios: Products. Worlds. Games."),
        ("house:deet-one-studio-wide", ("h1_deet_one_studio.png",), "6:1", "DEET Studios: One studio, brand to backend."),
    ],
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


def write_ktx2(graded, size, path, budget):
    """ETC1S KTX2 layer (docs/14 §3.1/§4.5) at the best quality within `budget` bytes (else the
    lowest), not y-flipped (the board shader reads layers top row first). Returns the quality."""
    img = Image.fromarray(graded.round().astype(np.uint8))
    for q in KTX2_QUALITIES:
        if backdrops.write_ktx2(img, size, path, q, y_flip=False, alpha=False) <= budget:
            return q
    return KTX2_QUALITIES[-1]


def encode(graded, size, path):
    """Writes the WebP and returns the pixels exactly as shipped (decoded back)."""
    Image.fromarray(graded.round().astype(np.uint8)).resize(size, Image.LANCZOS).save(path, "WEBP", quality=88, method=6)
    return np.asarray(Image.open(path).convert("RGB"))


def studio_pool(key, dest):
    """The studio's creatives for one map (STUDIO), graded and checked like the house art."""
    pool = {"screens": [], "hoardings": []}
    for cid, srcs, fmt, title in STUDIO.get(key, []):
        ratio, size = (4 / 3, SCREEN) if fmt == "4:3" else (6.0, HOARDING)
        arrs = [np.asarray(crop_ratio(Image.open(STUDIO_DIR / src).convert("RGB"), ratio)) for src in srcs]
        base = cid.split(":")[1]
        names = [f"{base}{f'-k{i}' if i else ''}.webp" for i in range(len(arrs))]
        sat = GRADE["sat"]
        while True:
            shipped = [encode(grade(a, GRADE, sat), size, dest / n) for a, n in zip(arrs, names)]
            shares = [signal_share(px) for px in shipped]
            share = {k: max(sh[k] for sh in shares) for k in SIGNAL_HUES}
            if max(share.values()) < SIGNAL_LIMIT or sat <= 0.3:
                break
            sat = round(sat - 0.1, 2)
        lums = [round(mean_luminance(px), 4) for px in shipped]
        ktx2 = [n.replace(".webp", ".ktx2") for n in names]
        qs = [write_ktx2(grade(a, GRADE, sat), KTX2_SIZE[fmt], dest / k, (dest / n).stat().st_size * KTX2_MAX_RATIO) for a, n, k in zip(arrs, names, ktx2)]
        entry = {"id": cid, "file": names[0], "ktx2": ktx2[0]}
        if len(names) > 1:
            entry["keys"] = [{"file": n, "ktx2": k} for n, k in zip(names[1:], ktx2[1:])]
        entry |= {"title": title, "signalHues": {k: round(v, 3) for k, v in share.items()}, "saturation": sat, "luminance": max(lums)}
        if len(names) > 1:
            entry["keyLuminance"] = lums
        (pool["screens"] if fmt == "4:3" else pool["hoardings"]).append(entry)
        sizes = ", ".join(f"{(dest / n).stat().st_size} B / KTX2 q{q} {(dest / k).stat().st_size} B" for n, k, q in zip(names, ktx2, qs))
        print(f"{cid}: {len(names)} key(s) {size[0]}x{size[1]} [{sizes}], signal hues {entry['signalHues']}, sat {sat:.2f}, lum {lums}")
    return pool


def pool_files(pool):
    """Every file a pool ships: (webp, ktx2) per image, keyframes included."""
    entries = pool["screens"] + pool["hoardings"] + pool.get("studio", {}).get("screens", []) + pool.get("studio", {}).get("hoardings", [])
    return [(x["file"], x["ktx2"]) for e in entries for x in [e, *e.get("keys", [])]]


def write_pool(dest, pool):
    (dest / "house.json").write_text(json.dumps(pool, indent=1) + "\n")
    files = pool_files(pool)
    print(json.dumps({"total_bytes": sum((dest / w).stat().st_size for w, _ in files), "ktx2_bytes": sum((dest / k).stat().st_size for _, k in files)}))


def main():
    if "--studio-only" in sys.argv:
        key, out = [a for a in sys.argv[1:] if a != "--studio-only"]
        dest = Path(out) / key
        pool = json.loads((dest / "house.json").read_text())
        pool["studio"] = studio_pool(key, dest)
        write_pool(dest, pool)
        return
    args = [a for a in sys.argv[1:] if a != "--ktx2-only"]
    ktx2_only = len(args) != len(sys.argv) - 1
    key, raw, out = args[0], Path(args[1]), Path(args[2])
    map_id, entries = POOLS[key]
    dest = out / key
    dest.mkdir(parents=True, exist_ok=True)
    shipped_pool = json.loads((dest / "house.json").read_text()) if ktx2_only else None
    pool = {"screens": [], "hoardings": []}
    for cid, src, fmt, title in entries:
        im = Image.open(raw / src).convert("RGB")
        im = crop_ratio(im, 4 / 3) if fmt == "4:3" else to_banner(banner_band(im))
        arr = np.asarray(im)
        size = SCREEN if fmt == "4:3" else HOARDING
        name = cid.split(":")[1] + ".webp"
        if shipped_pool:
            entry = next(e for e in shipped_pool["screens"] + shipped_pool["hoardings"] if e["id"] == cid)
            sat = entry["saturation"]
        else:
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
        ktx2 = name.replace(".webp", ".ktx2")
        q = write_ktx2(grade(arr, GRADE, sat), KTX2_SIZE[fmt], dest / ktx2, (dest / name).stat().st_size * KTX2_MAX_RATIO)
        entry = {k: v for k, v in entry.items() if k != "ktx2"}
        entry = {**{k: entry[k] for k in ("id", "file")}, "ktx2": ktx2, **{k: v for k, v in entry.items() if k not in ("id", "file")}}
        (pool["screens"] if fmt == "4:3" else pool["hoardings"]).append(entry)
        print(f"{cid}: {size[0]}x{size[1]} {(dest / name).stat().st_size} B, KTX2 q{q} {(dest / ktx2).stat().st_size} B, signal hues {entry['signalHues']}, sat {sat:.2f}, lum {entry['luminance']}")
    ktx2 = {fmt: list(size) for fmt, size in KTX2_SIZE.items()}
    write_pool(dest, {"version": 1, "map": map_id, "ktx2Size": ktx2, **pool, "studio": studio_pool(key, dest)})


if __name__ == "__main__":
    main()
