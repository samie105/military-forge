#!/usr/bin/env python3
"""
Backdrop art → runtime layers (environments stream; docs/11 §2 far background and mid depth).

    python3 -I apps/web/scripts/backdrops.py apps/web/public/assets/backdrops <raw_dir> [<raw_dir> …]

The raw dirs hold the Higgsfield originals (2688 × 1152 PNG, GPT Image 2.5; job ids in art/README.md's
cost table). They are not committed: re-download them from those jobs to re-run this. Each map has its
own folder and theme (the Street Market is the Lagos map; the others are their own places).

Per image (SPECS below):
- skies: resized, saved opaque;
- skyline layers: the soft white haze the model leaves around the roofs is cut from the alpha
  (smoothstep on alpha), the empty sky above the roofline is cropped, the colours are graded into
  the map's mid-depth palette (docs/11 §4: low saturation, low contrast, pulled toward the haze),
  the left/right edges fade out so neighbouring panels cross-fade, and the colour under transparent
  pixels is bled outward so bilinear filtering never pulls in a dark fringe;
- each is written as lossy WebP (RGBA where needed), and also as an ETC1S KTX2 copy (basisu, at the
  WebP's size rounded to block-aligned, with the block-aligned mips) when that copy costs at most
  1.2× the WebP's bytes: it stays compressed on the GPU (4–8 bits per pixel instead of 32), and
  the runtime loads it instead of the WebP where it can transcode. index.json gives each image's
  display size and its KTX2 copy, if any. `--ktx2-only` keeps the shipped WebPs.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

LUNAR = (64, 70, 84)  # space: a dark blue-grey "haze" only for palette discipline (there's no air)
STORM = (95, 108, 122)
LAB = (150, 165, 178)

# name: (source, kind, width px, settings); kinds: sky (camera-anchored), layer (transparent panel),
# wall (an opaque panel: an interior's back wall)
SPECS = {
    "street_market/sky_day": ("b1_sky_day.png", "sky", 1024, {}),
    "street_market/sky_dusk": ("b2_sky_dusk.png", "sky", 1024, {}),
    "street_market/sky_night": ("b2_sky_night.png", "sky", 1024, {}),
    "street_market/far_a": ("b1_far_a.png", "layer", 1024, {"alpha": (130, 245), "sat": 0.55, "haze": 0.3, "contrast": 0.8, "hazeRGB": (196, 207, 214)}),
    "street_market/far_b": ("b2_far_b.png", "layer", 1024, {"alpha": (130, 245), "sat": 0.55, "haze": 0.3, "contrast": 0.8, "hazeRGB": (196, 207, 214)}),
    "street_market/mid_a": ("b1_mid_a.png", "layer", 1536, {"alpha": (215, 250), "sat": 0.62, "haze": 0.16, "contrast": 0.86, "hazeRGB": (196, 207, 214)}),
    "street_market/mid_b": ("b2_mid_b.png", "layer", 1536, {"alpha": (215, 250), "sat": 0.62, "haze": 0.16, "contrast": 0.86, "hazeRGB": (196, 207, 214)}),
    "lunar_outpost/sky": ("lunar_sky.png", "sky", 1024, {}),
    "lunar_outpost/far": ("lunar_far.png", "layer", 1024, {"alpha": (130, 245), "sat": 0.6, "haze": 0.18, "contrast": 0.8, "hazeRGB": LUNAR}),
    "lunar_outpost/mid": ("lunar_mid.png", "layer", 1536, {"alpha": (200, 250), "sat": 0.7, "haze": 0.1, "contrast": 0.86, "hazeRGB": LUNAR}),
    "storm_front/sky": ("storm_sky.png", "sky", 1024, {}),
    "storm_front/far": ("storm_far.png", "layer", 1024, {"alpha": (130, 245), "sat": 0.6, "haze": 0.25, "contrast": 0.8, "hazeRGB": STORM}),
    "storm_front/mid": ("storm_mid.png", "layer", 1536, {"alpha": (200, 250), "sat": 0.65, "haze": 0.15, "contrast": 0.85, "hazeRGB": STORM}),
    "flux_lab/wall": ("lab_wall.png", "wall", 2048, {"sat": 0.7, "haze": 0.12, "contrast": 0.8, "hazeRGB": LAB}),
    "flux_lab/mid": ("lab_mid.png", "layer", 1536, {"alpha": (200, 250), "sat": 0.5, "haze": 0.4, "contrast": 0.62, "hazeRGB": LAB}),
}

# KTX2 copies (ETC1S) ship only where they cost at most 1.2× the WebP download, at the best basisu
# quality that fits (players on mobile data: owner, 18 Oct); elsewhere the WebP is all there is.
KTX2_MAX_RATIO = 1.2
KTX2_QUALITIES = (95, 80, 65, 50)
EDGE_FADE = 0.006  # of the width, each side: just enough to antialias the cut
TOP_MARGIN = 6  # px kept above the highest roof


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def blur(channel, radius):
    img = Image.fromarray(np.clip(channel, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64)


def process_layer(im, s):
    """Haze cut from the alpha, empty sky cropped, graded, edge-faded, colour bled under transparency."""
    arr = np.asarray(im.convert("RGBA"), dtype=np.float64)
    rgb, a = arr[..., :3], arr[..., 3]
    lo, hi = s["alpha"]
    # the model leaves a soft white glow (and sometimes a faint checker) around the roofs in the
    # semi-transparent alpha: keep only near-opaque pixels, and drop what is left of the white haze
    luma = rgb @ np.array([0.299, 0.587, 0.114])
    chroma = rgb.max(axis=-1) - rgb.min(axis=-1)
    whiteness = smoothstep(205, 235, luma) * (1 - smoothstep(8, 22, chroma))
    a = np.where(a < 250, a * (1 - whiteness), a)
    a = 255 * smoothstep(lo, hi, a)
    rows = np.nonzero(a.max(axis=1) > 8)[0]
    top = max(0, int(rows[0]) - TOP_MARGIN) if len(rows) else 0
    rgb, a = rgb[top:], a[top:]
    h, w = a.shape
    # grade: desaturate toward luma, compress contrast around the haze, pull toward the haze
    haze = np.array(s["hazeRGB"], dtype=np.float64)
    luma = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
    rgb = luma + (rgb - luma) * s["sat"]
    rgb = haze + (rgb - haze) * s["contrast"]
    rgb = rgb + (haze - rgb) * s["haze"]
    # fade the left and right edges: neighbouring panels cross-fade
    fade = max(1, int(w * EDGE_FADE))
    ramp = np.ones(w)
    k = smoothstep(0, 1, (np.arange(fade) + 0.5) / fade)
    ramp[:fade] = k
    ramp[w - fade:] = k[::-1]
    a = a * ramp[None, :]
    # bleed colour under (semi-)transparent pixels: normalised convolution of alpha-weighted colour
    wa = blur(a, 6)
    bled = np.stack([blur(rgb[..., i] * a / 255, 6) for i in range(3)], axis=-1) * 255 / np.maximum(wa, 1)[..., None]
    t = (a / 255)[..., None]
    rgb = np.where(wa[..., None] >= 1, rgb * t + bled * (1 - t), rgb)
    out = np.dstack([np.clip(rgb, 0, 255), np.clip(a, 0, 255)]).round().astype(np.uint8)
    img = Image.fromarray(out, "RGBA")
    return img, top / (top + h)


def process_wall(im, s):
    """An opaque panel: graded like a layer, no alpha."""
    rgb = np.asarray(im.convert("RGB"), dtype=np.float64)
    haze = np.array(s["hazeRGB"], dtype=np.float64)
    luma = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
    rgb = luma + (rgb - luma) * s["sat"]
    rgb = haze + (rgb - haze) * s["contrast"]
    rgb = rgb + (haze - rgb) * s["haze"]
    img = Image.fromarray(np.clip(rgb, 0, 255).round().astype(np.uint8), "RGB")
    return img


def fit(im, width):
    """`im` scaled to `width`, keeping its aspect."""
    return im.resize((width, round(im.size[1] * width / im.size[0])), Image.LANCZOS)


def ktx2_size(width, height, align=32):
    """KTX2 size: the WebP's, rounded to a multiple of 32 (≤ 3% squash: the mesh keeps the display
    aspect from index.json), so the first mip levels are block-aligned (ktx2_levels)."""
    return max(align, round(width / align) * align), max(align, round(height / align) * align)


def ktx2_levels(width, height):
    """Mip levels with every level block-aligned (a multiple of 4, or ≤ 2): what WebGL takes for a
    compressed texture's levels. Non-power-of-two sizes stop early; that's enough for backdrops
    and billboards, which are never minified more than ~4×."""
    n = 0
    while True:
        w, h = max(1, width >> n), max(1, height >> n)
        if not all(d % 4 == 0 or d <= 2 for d in (w, h)):
            return n
        n += 1
        if w == 1 and h == 1:
            return n


def write_ktx2(im, size, dest, quality, y_flip=True, alpha=True):
    """ETC1S KTX2 (docs/11 §4: ETC1S for albedo) via basisu, with the block-aligned part of the mip
    chain. Returns its size in bytes."""
    levels = ktx2_levels(*size)
    last = max(max(1, size[0] >> (levels - 1)), max(1, size[1] >> (levels - 1)))
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.png"
        im.resize(size, Image.LANCZOS).save(src)
        # basisu adds a level while the last one's longer side is above -mip_smallest
        cmd = ["basisu", "-ktx2", "-etc1s", "-quality", str(quality), "-effort", "4", "-mipmap", "-mip_srgb", "-mip_smallest", str(last), "-output_file", str(dest), str(src)]
        if y_flip:
            cmd.insert(1, "-y_flip")
        if not alpha:
            cmd.insert(1, "-no_alpha")
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return dest.stat().st_size


def best_ktx2(im, size, dest, budget, **kw):
    """The best ETC1S quality whose file fits `budget` bytes; None (and no file) if none does."""
    for q in KTX2_QUALITIES:
        n = write_ktx2(im, size, dest, q, **kw)
        if n <= budget:
            return q, n
    dest.unlink(missing_ok=True)
    return None


def main():
    """`--ktx2-only`: keep the shipped WebPs (their bytes decide the KTX2 budget), write the copies."""
    args = [a for a in sys.argv[1:] if a != "--ktx2-only"]
    ktx2_only = len(args) != len(sys.argv) - 1
    out, raws = Path(args[0]), [Path(p) for p in args[1:]]
    report = {}
    index = {}
    for name, (src, kind, width, s) in SPECS.items():
        path = next((r / src for r in raws if (r / src).exists()), None)
        if path is None:
            print(f"skip {name}: no {src}")
            continue
        im = Image.open(path)
        dest = out / f"{name}.webp"
        dest.parent.mkdir(parents=True, exist_ok=True)
        cropped = None
        if kind == "wall":
            full = process_wall(im, s)
            quality = 82
        elif kind == "sky":
            full = im.convert("RGB")
            quality = 80
        else:
            full, cropped = process_layer(im, s)
            quality = 82
        if ktx2_only:
            small_size = Image.open(dest).size
        else:
            small = fit(full, width)
            small.save(dest, "WEBP", quality=quality, method=6, exact=False)
            small_size = small.size
        webp_bytes = dest.stat().st_size
        size = ktx2_size(*small_size)
        ktx2 = dest.with_suffix(".ktx2")
        got = best_ktx2(full, size, ktx2, webp_bytes * KTX2_MAX_RATIO, alpha=full.mode == "RGBA")
        report[name] = {"size": list(small_size), "bytes": webp_bytes}
        if got:
            report[name].update({"ktx2": list(size), "ktx2Quality": got[0], "ktx2Bytes": got[1]})
        if cropped is not None:
            report[name]["croppedTop"] = round(cropped, 3)
        folder, file = name.split("/")
        index.setdefault(folder, {})[f"{file}.webp"] = {"size": list(small_size), **({"ktx2": f"{file}.ktx2"} if got else {})}
        print(f"{name}: {report[name]}")
    # the display size of every image (a KTX2 copy is rounded to block-aligned sizes), and which have one
    for folder, files in index.items():
        (out / folder / "index.json").write_text(json.dumps({"version": 1, "files": files}, indent=1) + "\n")
    shipped = [r for r in report.values() if "ktx2Bytes" in r]
    print(json.dumps({"webp_bytes": sum(r["bytes"] for r in report.values()), "ktx2_files": len(shipped), "ktx2_bytes": sum(r["ktx2Bytes"] for r in shipped), "their_webp_bytes": sum(r["bytes"] for r in shipped)}))


if __name__ == "__main__":
    main()
