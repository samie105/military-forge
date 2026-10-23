"""Key art v2: lay the soldiers' render (render_key_art.py, transparent) over the background plate, with a glow
round the flames, and write the title screen's files (apps/web/public/art/key-art/, the names #185 shipped).

    python3 art/pipeline/compose_key_art.py <plate> <desktop.png> <phone.png> <poster.png> [--poster-x X] [--loop DIR]

<desktop.png> is the 16:9 render; <phone.png> the 19.5:9 one, over the plate's middle rows; <poster.png> the 2:3 one,
over the plate's 2:3 crop from --poster-x. --loop DIR takes the ambient loop's frames (render_key_art.py --frames,
0000.png on) over the plate, as the 5 s desktop loop (H.264 MP4 and VP9 WebM, silent). Sources (full size, JPEG q93,
the soldiers' layers as lossless WebP) go to art/key-art/.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parents[2]
PUB = REPO / "apps/web/public/art/key-art"
SRC = REPO / "art/key-art"
argv = sys.argv[1:]
opt = {argv[i][2:]: argv[i + 1] for i in range(len(argv) - 1) if argv[i].startswith("--")}
plate = Image.open(argv[0]).convert("RGB")
desk = Image.open(argv[1]).convert("RGBA")
phone = Image.open(argv[2]).convert("RGBA")
poster = Image.open(argv[3]).convert("RGBA")


def glow(layer: Image.Image) -> Image.Image:
    """The render's hot, saturated parts (flames, embers: near-white orange) bloomed, to add over the composite; a
    sunlit sand uniform is saturated but not that bright, and stays as it is."""
    a = np.asarray(layer).astype(np.float32) / 255
    rgb, alpha = a[..., :3], a[..., 3:]
    lum = rgb.max(axis=2, keepdims=True)
    sat = (lum - rgb.min(axis=2, keepdims=True)) / np.maximum(lum, 1e-4)
    hot = np.clip((lum - 0.88) / 0.12, 0, 1) * np.clip((sat - 0.35) / 0.4, 0, 1) * rgb * alpha
    img = Image.fromarray((hot * 255).astype(np.uint8))
    r = max(4, layer.width // 160)
    out = np.asarray(img.filter(ImageFilter.GaussianBlur(r))).astype(np.float32) * 0.9
    out += np.asarray(img.filter(ImageFilter.GaussianBlur(r * 4))).astype(np.float32) * 0.6
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def compose(bg: Image.Image, layer: Image.Image) -> Image.Image:
    bg = bg.resize(layer.size, Image.LANCZOS)
    out = Image.alpha_composite(bg.convert("RGBA"), layer).convert("RGB")
    g = np.asarray(glow(layer)).astype(np.float32) / 255
    o = np.asarray(out).astype(np.float32) / 255
    o = 1 - (1 - o) * (1 - g)  # screen
    return Image.fromarray((np.clip(o, 0, 1) * 255).astype(np.uint8))


def save(img: Image.Image, stem: str, size, limit_kb=None, alpha=False):
    """WebP and AVIF at `size`; under `limit_kb` (the phone files) by stepping the quality down."""
    img = img.resize(size, Image.LANCZOS)
    for ext, q0 in (("webp", 80), ("avif", 55)):
        path = PUB / f"{stem}.{ext}"
        q = q0
        while True:
            img.save(path, quality=q, **({"method": 6} if ext == "webp" else {}))
            kb = path.stat().st_size / 1024
            if not limit_kb or kb <= limit_kb or q <= 30:
                break
            q -= 6
        print(f"{path.name}: {img.size[0]}x{img.size[1]}, q{q}, {kb:.0f} KB")


PUB.mkdir(parents=True, exist_ok=True)
SRC.mkdir(parents=True, exist_ok=True)

# desktop 16:9
full = compose(plate, desk)
full.save(SRC / "key-art-desktop-4k.jpg", quality=93)
save(full, "key-art-desktop", (2560, 1440))
save(desk, "key-art-desktop-fg", (2560, 1440), alpha=True)

# phone 19.5:9 over the plate's middle rows
ph = round(plate.width * 9 / 19.5)
y0 = (plate.height - ph) // 2
wide = compose(plate.crop((0, y0, plate.width, y0 + ph)), phone)
wide.save(SRC / "key-art-phone-4k.jpg", quality=93)
save(wide, "key-art-phone", (2340, 1080), limit_kb=400)
save(phone, "key-art-phone-fg", (2340, 1080), limit_kb=400, alpha=True)

# the 2:3 poster on the plate's 2:3 crop
pw = round(plate.height * 2 / 3)
x0 = int(opt.get("poster-x", (plate.width - pw) // 2))
tall = compose(plate.crop((x0, 0, x0 + pw, plate.height)), poster)
tall.save(SRC / "poster-portrait.jpg", quality=93)
save(tall, "poster-portrait", (1600, 2400))
save(tall, "poster-portrait-phone", (1080, 1620), limit_kb=400)

# the soldiers' layers, for a later re-grade or re-compose
desk.save(SRC / "soldiers-desktop.webp", lossless=True)
phone.save(SRC / "soldiers-phone.webp", lossless=True)
poster.save(SRC / "soldiers-poster.webp", lossless=True)

# the desktop's ambient loop: every frame over the still plate, then encoded
if "loop" in opt:
    frames = sorted(Path(opt["loop"]).glob("[0-9][0-9][0-9][0-9].png"))
    with tempfile.TemporaryDirectory() as tmp:
        for k, f in enumerate(frames):
            compose(plate, Image.open(f).convert("RGBA")).save(Path(tmp) / f"{k:04d}.png")
        src = str(Path(tmp) / "%04d.png")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i", src, "-c:v", "libx264", "-crf", "26",
                        "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
                        str(PUB / "key-art-desktop-loop.mp4")], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "24", "-i", src, "-c:v", "libvpx-vp9", "-crf", "38",
                        "-b:v", "0", "-row-mt", "1", "-an", str(PUB / "key-art-desktop-loop.webm")], check=True)
    for ext in ("mp4", "webm"):
        f = PUB / f"key-art-desktop-loop.{ext}"
        print(f"{f.name}: {len(frames)} frames, {f.stat().st_size / 1024:.0f} KB")
