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
- everything is written as lossy WebP (RGBA where needed). KTX2/ETC1S would be ~4× smaller on the
  GPU but needs `toktx`, a user install (docs: art/README.md open question 4); WebP is the fallback.
"""
import json
import sys
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

EDGE_FADE = 0.006  # of the width, each side: just enough to antialias the cut
TOP_MARGIN = 6  # px kept above the highest roof


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def blur(channel, radius):
    img = Image.fromarray(np.clip(channel, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64)


def process_layer(im, width, s):
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
    height = round(h * width / w)
    return img.resize((width, height), Image.LANCZOS), top / (top + h)


def process_wall(im, width, s):
    """An opaque panel: graded like a layer, no alpha."""
    rgb = np.asarray(im.convert("RGB"), dtype=np.float64)
    haze = np.array(s["hazeRGB"], dtype=np.float64)
    luma = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
    rgb = luma + (rgb - luma) * s["sat"]
    rgb = haze + (rgb - haze) * s["contrast"]
    rgb = rgb + (haze - rgb) * s["haze"]
    img = Image.fromarray(np.clip(rgb, 0, 255).round().astype(np.uint8), "RGB")
    return img.resize((width, round(img.size[1] * width / img.size[0])), Image.LANCZOS)


def main():
    out, raws = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    report = {}
    for name, (src, kind, width, s) in SPECS.items():
        path = next((r / src for r in raws if (r / src).exists()), None)
        if path is None:
            print(f"skip {name}: no {src}")
            continue
        im = Image.open(path)
        dest = out / f"{name}.webp"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if kind == "wall":
            im = process_wall(im, width, s)
            im.save(dest, "WEBP", quality=82, method=6)
            report[name] = {"size": list(im.size), "bytes": dest.stat().st_size}
        elif kind == "sky":
            im = im.convert("RGB")
            im = im.resize((width, round(im.size[1] * width / im.size[0])), Image.LANCZOS)
            im.save(dest, "WEBP", quality=80, method=6)
            report[name] = {"size": list(im.size), "bytes": dest.stat().st_size}
        else:
            im, cropped = process_layer(im, width, s)
            im.save(dest, "WEBP", quality=82, method=6, exact=False)
            report[name] = {"size": list(im.size), "bytes": dest.stat().st_size, "croppedTop": round(cropped, 3)}
        print(f"{name}: {report[name]}")
    print(json.dumps({"total_bytes": sum(r["bytes"] for r in report.values())}))


if __name__ == "__main__":
    main()
