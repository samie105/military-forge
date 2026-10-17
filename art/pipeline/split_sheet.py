"""Split a front/side/back character turnaround sheet into one square image per view.

Usage: python3 art/pipeline/split_sheet.py <sheet.png> <out_dir> [names...]

The sheet must have a flat background and the views must be separated by background-only
columns (that's how the concept prompts in art/README.md ask for them). Each view is padded to a
square on the background colour so image-to-3D models see it centred, at the same scale.
Default names: front left back (the order Tripo's multiview model expects).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BG_TOLERANCE = 18   # max per-channel distance from the background colour
MIN_GAP = 24        # background-only columns needed to separate two views
MARGIN = 0.06       # padding around each view, as a fraction of its height


def main() -> None:
    sheet_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    names = sys.argv[3:] or ["front", "left", "back"]
    img = np.asarray(Image.open(sheet_path).convert("RGB")).astype(np.int16)
    h, w, _ = img.shape

    # Background colour = median of the outer 8 px border.
    border = np.concatenate([img[:8].reshape(-1, 3), img[-8:].reshape(-1, 3),
                             img[:, :8].reshape(-1, 3), img[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    fg = np.abs(img - bg).max(axis=2) > BG_TOLERANCE
    col_has_fg = fg.sum(axis=0) > 3

    runs, start, gap = [], None, 0
    for x in range(w):
        if col_has_fg[x]:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= MIN_GAP:
                runs.append((start, x - gap + 1))
                start, gap = None, 0
    if start is not None:
        runs.append((start, w))
    runs = [r for r in runs if r[1] - r[0] > w * 0.05]  # drop specks
    # A pair (boots, gloves) shows as two runs per view: merge across the narrowest gaps.
    while len(runs) > len(names):
        i = min(range(len(runs) - 1), key=lambda k: runs[k + 1][0] - runs[k][1])
        runs[i:i + 2] = [(runs[i][0], runs[i + 1][1])]
    if len(runs) != len(names):
        sys.exit(f"found {len(runs)} views {runs}, expected {len(names)}")

    out_dir.mkdir(parents=True, exist_ok=True)
    rgb = Image.open(sheet_path).convert("RGB")
    bg_rgb = tuple(int(c) for c in bg)
    # One shared square size so every view keeps the sheet's scale.
    rows = np.where(fg.any(axis=1))[0]
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    view_h = bottom - top
    size = int(max(view_h, max(r[1] - r[0] for r in runs)) * (1 + 2 * MARGIN))
    for (x0, x1), name in zip(runs, names):
        crop = rgb.crop((x0, top, x1, bottom))
        canvas = Image.new("RGB", (size, size), bg_rgb)
        canvas.paste(crop, ((size - (x1 - x0)) // 2, (size - view_h) // 2))
        canvas.save(out_dir / f"{name}.png")
        print(f"{name}: x {x0}-{x1}, y {top}-{bottom} -> {size}x{size}")


if __name__ == "__main__":
    main()
