"""
Frame strips of the phone UI's transitions (docs/design/ui-motion-spec.md §5: "a frame strip of each
new transition, committed as WebP"). phone-hud-shots.mjs leaves frames/<name>-NN.png, 16 ms of
animation time apart; this lays each run out as one WebP: frames left to right in rows, numbered
by their time.

    python3 -I apps/web/scripts/phone-strips.py docs/screenshots/phone-ui
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/screenshots/phone-ui')
frames = root / 'frames'
runs = defaultdict(list)
for f in sorted(frames.glob('*.png')):
    m = re.match(r'(.+)-(\d+)\.png$', f.name)
    if m:
        runs[m.group(1)].append((int(m.group(2)), f))

for name, items in sorted(runs.items()):
    items.sort()
    shots = [Image.open(f).convert('RGB') for _, f in items]
    # half size: the shots are 2× (the phone's device pixels); whole screens at 400 px wide, 4 to a row
    k = 2 if shots[0].width // 2 <= 500 else shots[0].width / 400
    shots = [s.resize((round(s.width / k), round(s.height / k)), Image.LANCZOS) for s in shots]
    w, h = shots[0].size
    cols = max(1, min(len(shots), 1600 // (w + 4)))
    rows = (len(shots) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (w + 4) + 4, rows * (h + 22) + 4), (14, 16, 11))
    draw = ImageDraw.Draw(sheet)
    for i, s in enumerate(shots):
        x = 4 + (i % cols) * (w + 4)
        y = 4 + (i // cols) * (h + 22)
        sheet.paste(s, (x, y + 18))
        draw.text((x + 2, y + 2), f'{i * 16} ms', fill=(214, 255, 59))
    out = root / f'strip-{name}.webp'
    sheet.save(out, 'WEBP', quality=82, method=6)
    print(f'{out} ({len(shots)} frames, {cols}×{rows})')
