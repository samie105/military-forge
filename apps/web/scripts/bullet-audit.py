#!/usr/bin/env python3
"""
Bullet audit overlay: marks, on a screenshot, what stops bullets and what doesn't.

    node apps/web/scripts/environment-shots.mjs --hw --map <id> --only audit --prefix <id>- --out <dir>
    python3 -I apps/web/scripts/bullet-audit.py <dir> <id>-

- green: solids (stop bodies and bullets);
- red: one-way platforms bullets pass (packages/sim world.ts: BulletPass, like a railing);
- blue: one-way slabs that stop bullets (`blocksBullets`), still one-way for bodies;
- orange box: kit decor behind the play plane (no collision; MapEnvironment.decorBoxes);
- thin orange outline: the painted backdrop layers.
Anything drawn near the play plane that looks solid but is red or orange is a candidate: a slab
for blocksBullets, or decoration that should read as background.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def project(pose, cam, x, y, z=0.0):
    k = pose["z"] / (pose["z"] - z)
    px = pose["x"] + (x - pose["x"]) * k
    py = pose["y"] + (y - pose["y"]) * k
    return ((px - cam["x"]) * cam["ppm"] + cam["width"] / 2, cam["height"] / 2 - (py - cam["y"]) * cam["ppm"])


def main():
    d, prefix = Path(sys.argv[1]), sys.argv[2]
    for view in ["audit-overview", "audit-left", "audit-right"]:
        png = d / f"{prefix}{view}.png"
        if not png.exists():
            continue
        data = json.loads((d / f"{prefix}{view}.json").read_text())
        pose, cam = data["pose"], data["cam"]
        im = Image.open(png).convert("RGB")
        # "RGBA" mode on an RGB image blends each shape in, so later fills don't erase earlier lines
        dr = ImageDraw.Draw(im, "RGBA")
        boxes = []
        for b in data.get("decor", []):
            (x0, y0, _z0), (x1, y1, z1) = b["min"], b["max"]
            if y1 - y0 < 4 or x1 - x0 < 2:  # poles, signboards: thin
                continue
            boxes.append((b["piece"], x0, x1, y0, y1, z1))
        for p in data.get("panels", []):  # painted layers: outline only, they fill the frame
            a = project(pose, cam, p["x0"], p["y1"], p["z"])
            b = project(pose, cam, p["x1"], p["y0"], p["z"])
            dr.rectangle([a, b], outline=(255, 150, 0, 160), width=1)
            dr.text((max(a[0], 0) + 4, max(a[1], 70) + 4), f"painted {p['name']} z{p['z']:.0f}", fill=(255, 190, 80, 220))
        for name, xa, xb, y0, y1, z in boxes:
            a = project(pose, cam, xa, y1, z)
            b = project(pose, cam, xb, y0, z)
            dr.rectangle([a, b], outline=(255, 150, 0, 255), width=3, fill=(255, 150, 0, 40))
            dr.text((a[0] + 4, a[1] + 4), f"{name} z{z:.0f}", fill=(255, 190, 80, 255))
        for pts in data["solids"]:
            xy = [project(pose, cam, pts[i], pts[i + 1]) for i in range(0, len(pts), 2)]
            dr.polygon(xy, outline=(60, 255, 90, 255), width=3, fill=(60, 255, 90, 35))
        for o in data["oneWays"]:
            colour = (60, 140, 255, 255) if o.get("blocksBullets") else (255, 40, 40, 255)
            dr.line([project(pose, cam, o["ax"], o["ay"]), project(pose, cam, o["bx"], o["by"])], fill=colour, width=5)
        dr2 = dr
        dr2.rectangle([8, 8, 470, 84], fill=(0, 0, 0, 170))
        dr2.text((16, 12), "green: solid, stops bullets", fill=(90, 255, 120, 255))
        dr2.text((16, 30), "red: one-way, bullets pass", fill=(255, 90, 90, 255))
        dr2.text((16, 48), "blue: one-way slab, stops bullets", fill=(110, 170, 255, 255))
        dr2.text((16, 66), "orange: drawn, no collision (decoration)", fill=(255, 180, 60, 255))
        im.save(d / f"{prefix}{view}-marked.png")
        print(d / f"{prefix}{view}-marked.png")


if __name__ == "__main__":
    main()
