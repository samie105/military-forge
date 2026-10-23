#!/usr/bin/env python3
"""Fog Stair's sky: a pale morning over a river gorge, the sun a smudge behind the fog (maps-vertical).

    python3 -I art/pipeline/fog_stair_sky.py <raw_dir>

Writes <raw_dir>/fog_sky.png (2688 x 1152 RGB) for apps/web/scripts/backdrops.py. Deterministic
(seeded): a cool zenith over a warm grey horizon, a soft sun glow, low bands of mist.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

W, H = 2688, 1152
ZENITH = np.array([118, 136, 152], dtype=np.float64)
HORIZON = np.array([206, 204, 192], dtype=np.float64)
SUN = np.array([255, 236, 204], dtype=np.float64)
MIST = np.array([222, 224, 220], dtype=np.float64)

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(23)
y = np.linspace(0, 1, H)[:, None]  # 0 top, 1 bottom
x = np.linspace(0, 1, W)[None, :]
t = np.clip(y, 0, 1) ** 1.35
sky = ZENITH + (HORIZON - ZENITH) * t[..., None]
# the sun, a smudge up and to the left
d = np.sqrt(((x - 0.3) * W / H) ** 2 + (y - 0.36) ** 2)
glow = np.exp(-(d / 0.16) ** 2) * 0.55 + np.exp(-(d / 0.5) ** 2) * 0.18
sky = sky + (SUN - sky) * glow[..., None]
# low mist bands: blurred noise, stretched sideways, heavier toward the horizon
noise = rng.random((H // 16, W // 4))
img = Image.fromarray((noise * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(28))
bands = np.asarray(img, dtype=np.float64) / 255
mist = np.clip((bands - 0.45) * 2.2, 0, 1) * (0.15 + 0.55 * t)
sky = sky + (MIST - sky) * mist[..., None]
Image.fromarray(np.clip(sky, 0, 255).round().astype(np.uint8), "RGB").save(out / "fog_sky.png")
print(f"wrote {out / 'fog_sky.png'}")
