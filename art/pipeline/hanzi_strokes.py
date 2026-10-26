"""Fog Stair's shop lettering as neon-tube strokes: a small, hand-drawn stroke set for the few Simplified
Chinese characters the kit's signs use (the owner, 26 Oct: Chinese signage makes the place).

No font file is read or shipped: every character is drawn here as polylines on a 10 × 10 grid
(x right, y up, the character box 0…10), stroke by stroke in the usual order, the way a neon bender
would bend the tubes. art/pipeline/build_fog_stair_kit.py turns them into tube geometry (neon) or
flat brush strokes (painted boards).

The signs (each string's meaning, checked against a dictionary; no names of real businesses):

    火锅  huǒguō     hotpot (a hotpot restaurant)
    面馆  miànguǎn   noodle shop
    小面  xiǎomiàn   "small noodles": the region's spicy breakfast noodles
    茶馆  cháguǎn    teahouse
    茶    chá        tea
    药房  yàofáng    pharmacy
    旅馆  lǚguǎn     inn, small hotel
    小卖部 xiǎomàibù  corner shop (a small general store)

    python3 -I art/pipeline/hanzi_strokes.py <out.png>   # a proof sheet of every glyph (PIL)
"""

# character → strokes; a stroke is a polyline [(x, y), …] on the 10 × 10 grid, y up
GLYPHS = {
    # fire: two short dots, then the long left sweep and the right sweep
    "火": [
        [(2.0, 7.4), (3.1, 5.4)],
        [(8.2, 7.6), (6.9, 5.5)],
        [(5.0, 9.7), (5.0, 6.2), (4.5, 3.8), (3.0, 1.8), (0.9, 0.5)],
        [(5.2, 5.0), (6.8, 2.7), (9.3, 0.5)],
    ],
    # pot, wok: the metal radical 钅, then 呙 (口 over 内)
    "锅": [
        [(2.2, 9.8), (0.5, 7.5)],
        [(1.3, 8.2), (3.4, 8.2)],
        [(0.7, 6.0), (3.4, 6.0)],
        [(2.0, 8.2), (2.0, 1.3), (3.5, 2.5)],
        [(5.2, 9.6), (5.2, 7.0)],
        [(5.2, 9.6), (8.8, 9.6), (8.8, 7.0)],
        [(5.2, 7.0), (8.8, 7.0)],
        [(4.4, 5.8), (4.4, 0.2)],
        [(4.4, 5.8), (9.6, 5.8), (9.6, 0.8), (8.7, 0.3)],
        [(7.0, 5.0), (5.6, 2.0)],
        [(6.6, 3.8), (8.4, 1.8)],
    ],
    # face; noodles: the top bar and its short stroke, the outer box, two inner verticals, two inner bars, the bottom
    "面": [
        [(0.5, 9.4), (9.5, 9.4)],
        [(5.0, 9.4), (4.3, 7.6)],
        [(1.4, 7.6), (1.4, 0.3)],
        [(1.4, 7.6), (8.6, 7.6), (8.6, 0.3)],
        [(3.8, 7.6), (3.8, 0.6)],
        [(6.2, 7.6), (6.2, 0.6)],
        [(3.8, 5.2), (6.2, 5.2)],
        [(3.8, 2.9), (6.2, 2.9)],
        [(1.4, 0.6), (8.6, 0.6)],
    ],
    # a public building, a shop: the food radical 饣, then 官 (宀 over a tall stroke with two boxes)
    "馆": [
        [(2.3, 9.8), (0.5, 7.3)],
        [(1.4, 8.2), (3.3, 8.2), (2.6, 7.1)],
        [(1.4, 7.0), (1.4, 1.2), (3.1, 2.5)],
        [(7.0, 9.9), (7.3, 9.1)],
        [(4.4, 8.7), (4.4, 7.6)],
        [(4.4, 8.7), (9.6, 8.7), (9.2, 7.6)],
        [(5.3, 7.0), (5.3, 0.2)],
        [(5.3, 7.0), (8.6, 7.0), (8.6, 4.7)],
        [(5.3, 4.7), (8.6, 4.7)],
        [(5.3, 3.8), (9.0, 3.8), (9.0, 0.6)],
        [(5.3, 0.6), (9.0, 0.6)],
    ],
    # tea: grass on top (艹), a roof of two sweeps (人), then 朩
    "茶": [
        [(0.5, 8.5), (9.5, 8.5)],
        [(3.2, 9.9), (3.2, 7.4)],
        [(6.8, 9.9), (6.8, 7.4)],
        [(5.0, 7.5), (2.8, 5.6), (0.6, 4.4)],
        [(5.0, 7.5), (7.2, 5.6), (9.4, 4.4)],
        [(2.2, 4.3), (7.8, 4.3)],
        [(5.0, 5.6), (5.0, 0.3), (4.3, 0.8)],
        [(3.7, 3.2), (2.0, 1.3)],
        [(6.3, 3.2), (8.0, 1.3)],
    ],
    # medicine: grass on top (艹), then 约: the silk radical 纟 and 勺
    "药": [
        [(0.5, 8.6), (9.5, 8.6)],
        [(3.2, 9.9), (3.2, 7.6)],
        [(6.8, 9.9), (6.8, 7.6)],
        [(2.6, 7.3), (1.2, 5.3), (2.9, 5.6)],
        [(3.1, 6.5), (0.9, 2.9), (3.7, 3.6)],
        [(0.7, 0.9), (3.9, 2.2)],
        [(6.5, 7.4), (4.8, 5.0)],
        [(5.6, 6.3), (9.4, 6.3), (9.4, 1.0), (8.4, 0.3)],
        [(6.6, 4.3), (7.5, 2.9)],
    ],
    # room, house: 户 (a dot, a frame, its long sweep) around 方
    "房": [
        [(5.0, 9.9), (5.4, 9.1)],
        [(1.6, 8.4), (8.6, 8.4), (8.6, 6.6)],
        [(1.6, 6.6), (8.6, 6.6)],
        [(1.6, 8.4), (1.6, 4.4), (1.0, 1.8), (0.2, 0.3)],
        [(6.0, 5.9), (6.4, 5.1)],
        [(2.8, 4.8), (9.5, 4.8)],
        [(5.0, 3.6), (8.4, 3.6), (8.1, 0.9), (7.2, 0.3)],
        [(5.0, 4.8), (4.8, 2.6), (3.0, 0.3)],
    ],
    # travel: 方 on the left, then the banner on the right (𠂉 over a hanging sweep, a lift, a sweep and a long right fall)
    "旅": [
        [(2.2, 9.9), (2.5, 9.0)],
        [(0.4, 8.2), (4.2, 8.2)],
        [(1.7, 6.5), (3.8, 6.5), (3.6, 1.0), (2.8, 0.5)],
        [(1.7, 8.2), (1.5, 5.0), (0.4, 1.1)],
        [(6.7, 9.9), (5.4, 7.9)],
        [(6.1, 8.6), (9.6, 8.6)],
        [(8.9, 7.5), (5.7, 6.3)],
        [(5.7, 6.3), (5.7, 0.8), (6.9, 1.9)],
        [(8.8, 5.9), (6.6, 3.7)],
        [(6.7, 5.2), (7.7, 3.0), (9.8, 0.5)],
    ],
    # small: the hooked middle stroke and a dot either side
    "小": [
        [(5.0, 9.8), (5.0, 0.8), (3.9, 1.5)],
        [(2.8, 6.8), (1.0, 3.0)],
        [(7.2, 6.8), (9.0, 3.3)],
    ],
    # sell: 十 on top, then 买's hooked bar, two dots, a long bar, the sweep and the closing dot
    "卖": [
        [(2.0, 8.6), (8.0, 8.6)],
        [(5.0, 9.9), (5.0, 7.4)],
        [(1.3, 6.8), (8.8, 6.8), (8.0, 5.8)],
        [(3.4, 5.5), (4.3, 4.6)],
        [(3.0, 3.9), (3.9, 3.0)],
        [(0.5, 2.7), (9.5, 2.7)],
        [(6.2, 5.7), (5.8, 2.7), (4.2, 1.1), (1.6, 0.1)],
        [(6.4, 1.6), (8.6, 0.3)],
    ],
    # department, part: 立 over 口 on the left, the ear radical 阝 on the right
    "部": [
        [(3.0, 9.9), (3.2, 9.1)],
        [(0.8, 8.6), (5.4, 8.6)],
        [(1.8, 7.8), (2.4, 6.4)],
        [(4.6, 7.8), (3.8, 6.4)],
        [(0.4, 6.0), (5.8, 6.0)],
        [(1.2, 4.6), (1.2, 0.3)],
        [(1.2, 4.6), (5.0, 4.6), (5.0, 0.3)],
        [(1.2, 0.8), (5.0, 0.8)],
        [(6.8, 9.4), (9.2, 9.4), (7.8, 6.4), (9.6, 4.4), (8.7, 2.6), (7.8, 3.0)],
        [(6.8, 9.4), (6.8, 0.0)],
    ],
}

# every string the kit shows, with its meaning (the report and the tests read this)
SIGNS = {
    "火锅": "hotpot",
    "面馆": "noodle shop",
    "小面": "small noodles (the region's spicy breakfast noodles)",
    "茶馆": "teahouse",
    "茶": "tea",
    "药房": "pharmacy",
    "旅馆": "inn",
    "小卖部": "corner shop",
}


def strokes(text, size=1.0, gap=0.18, vertical=False):
    """Polylines for `text` in metres: each character `size` tall and wide with `gap` × size between
    them, laid out left to right (or top to bottom when `vertical`), from (0, 0) at the bottom left
    of the first character (vertical: the top left, going down)."""
    out = []
    step = size * (1 + gap)
    for i, ch in enumerate(text):
        ox, oy = (0.0, -(i + 1) * step + gap * size) if vertical else (i * step, 0.0)
        for s in GLYPHS[ch]:
            out.append([(ox + x / 10 * size, oy + y / 10 * size) for x, y in s])
    return out


if __name__ == "__main__":
    import sys

    from PIL import Image, ImageDraw

    cell = 160
    chars = sorted({c for s in SIGNS for c in s}, key=lambda c: list(GLYPHS).index(c))
    im = Image.new("RGB", (cell * len(chars), cell), (24, 26, 30))
    d = ImageDraw.Draw(im)
    for i, ch in enumerate(chars):
        for s in GLYPHS[ch]:
            pts = [(i * cell + 15 + x * 13, cell - 15 - y * 13) for x, y in s]
            d.line(pts, fill=(255, 140, 200), width=9, joint="curve")
    im.save(sys.argv[1])
    print(f"wrote {sys.argv[1]}: {''.join(chars)}")
