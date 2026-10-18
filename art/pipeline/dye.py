"""Dye masks for character parts (docs/04 §5.4): `color = albedo × lerp(1, dye[channel], mask)`.

Imported by build_character.py (Blender + numpy). For one baked part this writes:

* `<name>_dye_mask.png`: R = primary, G = secondary, B = accent, A = emissive/team glow
  (linear, non-colour data, same UVs as the albedo);
* `<name>_dye_albedo.png`: the albedo with every dyeable texel turned into a neutral grey whose
  brightness is relative to that channel's default dye, so `grey × default` gives back the
  original look and any other dye keeps the painted shading. With a skin rule (the body), skin
  texels are divided by SKIN_NEUTRAL instead (per channel, linear) and the **alpha holds the skin
  weight**, so `dyeAlbedo × lerp(1, skinTone, alpha)` gives back the painted skin with skin_04 and
  keeps the lips' and cheeks' warmth with any other tone (rookie.json `dye.lodN.skin: "alpha"`);
* the default dye colours (sRGB hex), returned so they can go into the part's glTF extras.

Texels are classified by colour (HSV of the baked albedo) and by where they are on the body,
from a baked position map: the same "sand" hue is cloth on the legs but skin on the hands.
"""
import colorsys

import bpy
import numpy as np

OFFSET = 10.0  # m, added to baked positions (see _bake_positions)
SKIN_NEUTRAL = "#da9f75"  # skin_04 "Apricot" (packages/content cosmetics.ts): the painted Rookie's tone
SKIN_HEADROOM = 2  # the shader renders skin texels × lerp(1, SKIN_HEADROOM × skinTone, alpha) (dyeMaterial.ts)


def _bake_positions(obj, size):
    """Bake the object's rest-pose positions into a float image aligned with its UVs."""
    me = obj.data
    # Positions are stored +OFFSET so a texel the bake never reached (still 0) can't pass for
    # one on the part: Cycles writes alpha 1 to every texel, so alpha can't mark coverage.
    attr = me.color_attributes.new("dye_pos", "FLOAT_COLOR", "POINT")
    for i, v in enumerate(me.vertices):
        attr.data[i].color = (v.co.x + OFFSET, v.co.y + OFFSET, v.co.z + OFFSET, 1.0)
    img = bpy.data.images.new(f"{obj.name}_pos", size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    img.generated_color = (0, 0, 0, 0)

    mat = bpy.data.materials.new(f"{obj.name}_posbake")
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    a = nt.nodes.new("ShaderNodeAttribute")
    a.attribute_name = "dye_pos"
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(a.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    nt.nodes.active = tex

    saved = list(me.materials)
    me.materials.clear()
    me.materials.append(mat)
    for o in bpy.context.scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type="EMIT", use_selected_to_active=False, margin=2)
    me.materials.clear()
    for m in saved:
        me.materials.append(m)
    me.color_attributes.remove(me.color_attributes["dye_pos"])
    bpy.data.materials.remove(mat)

    px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
    bpy.data.images.remove(img)
    covered = px[..., 0] > OFFSET / 2
    px[..., :3] -= OFFSET
    px[..., 3] = covered
    return px  # xyz in RGB; A = 0 where no face covers the texel


def _hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.max(rgb, axis=-1)
    mn = np.min(rgb, axis=-1)
    d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    s = np.where(mx > 1e-6, (mx - mn) / (mx + 1e-6), 0)
    return h, s, mx


def _close(m, covered):
    """Morphological closing (3x3 dilate then erode) fills speckles the colour rules miss in
    shaded folds, without growing the region past the UV islands."""
    def shift_max(x):
        p = np.pad(x, 1, mode="edge")
        return np.max([p[1 + dy:1 + dy + x.shape[0], 1 + dx:1 + dx + x.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)

    def shift_min(x):
        p = np.pad(x, 1, mode="edge")
        return np.min([p[1 + dy:1 + dy + x.shape[0], 1 + dx:1 + dx + x.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)

    return shift_min(shift_max(m)) * covered


def _into_gutters(m, covered, px):
    """Extend a mask `px` texels into the uncovered atlas gutter next to it (covered texels keep their
    value). Filtering samples the gutter at UV seams; without this, the seams round the face (the
    hairline, the ear rims) kept the painted colour and showed as pale outlines under a dark tone."""
    out = m.copy()
    for _ in range(px):
        p = np.pad(out, 1, mode="edge")
        grown = np.max([p[1 + dy:1 + dy + m.shape[0], 1 + dx:1 + dx + m.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
        out = np.where(covered, m, np.maximum(out, grown))
    return out


def _soften(m):
    """3x3 box blur: anti-aliases the mask edges."""
    p = np.pad(m, 1, mode="edge")
    return sum(p[1 + dy:1 + dy + m.shape[0], 1 + dx:1 + dx + m.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9


def _hex(rgb):
    return "#" + "".join(f"{int(round(max(0, min(1, c)) * 255)):02x}" for c in rgb)


def _save(name, px, path, data):
    h, w = px.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True)
    if data:
        img.colorspace_settings.name = "Non-Color"
    img.pixels[:] = px.astype(np.float32).ravel()
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def make_masks(obj, albedo, out_dir, name, rules, skin_rule=None):
    """rules(h, s, v, pos) -> (primary, secondary, accent, emissive) boolean arrays; skin_rule(h, s,
    v, pos) -> the skin texels (their weight goes in the dye albedo's alpha, and they stay out of
    every dye channel). `albedo` is the part's baked Blender image (sRGB bytes). Returns the
    default dyes and the coverage per channel."""
    size = albedo.size[0]
    pos = _bake_positions(obj, size)
    col = np.array(albedo.pixels[:], dtype=np.float32).reshape(size, size, 4)[..., :3]
    covered = pos[..., 3] > 0.5
    h, s, v = _hsv(col)
    skin = None
    if skin_rule is not None:
        hard = _close(np.logical_and(skin_rule(h, s, v, pos[..., :3]), covered).astype(np.float32), covered)
        # soften outward only: a skin texel at partial weight keeps a bright neutral colour but only
        # part of the tone, which read as a pale outline round the face under a dark tone
        skin = _into_gutters(np.maximum(hard, _soften(hard)), covered, 3)
    channels = [np.logical_and(m, covered).astype(np.float32) for m in rules(h, s, v, pos[..., :3])]
    channels = [_soften(_close(m, covered)) for m in channels]
    if skin is not None:
        channels = [c * (1 - skin) for c in channels]  # skin never takes a dye
    mask = np.stack(channels, axis=-1)

    defaults = finish(col, mask, covered, out_dir, name, skin=skin)
    cover = {k: round(float((mask[..., i] > 0.5).sum() / max(1, covered.sum())), 3)
             for i, k in enumerate(("primary", "secondary", "accent", "emissive"))}
    if skin is not None:
        cover["skin"] = round(float((skin > 0.5).sum() / max(1, covered.sum())), 3)
    return defaults, cover


LUM = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((np.maximum(c, 0) + 0.055) / 1.055) ** 2.4)


def _to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def finish(col, mask, covered, out_dir, name, skin=None):
    """Write <name>_dye_albedo.png and <name>_dye_mask.png from an sRGB albedo `col` (H×W×3) and a
    mask (H×W×4). Returns the default dyes (sRGB hex) per channel present.

    The shader (docs/04 §5.4) draws `dyeAlbedo × Π lerp(1, dye_i, mask_i)` in linear space, and with
    the default dyes that must give back the painted albedo:
    * mask core (weight >= 0.99): a neutral grey, lum / lum(default), so any dye keeps the painted
      shading but none of the default's hue;
    * soft mask edges (0 < weight < 0.99): the exact inverse, albedo / Π lerp(1, default_i, mask_i)
      in linear space. A grey blend there rendered the island borders 1.2–1.7× too bright;
    * undyed texels: the albedo itself."""
    lum = col @ LUM
    defaults, tint = {}, np.ones_like(col)
    neutral, weight = np.zeros_like(col), np.zeros(col.shape[:2], dtype=np.float32)
    for i, key in enumerate(("primary", "secondary", "accent")):
        m = mask[..., i] * covered
        sel = m > 0.5
        if not sel.any():
            continue
        # The default dye has the channel's median hue at its 98th-percentile brightness, so the
        # neutral grey (lum / lum(default)) stays ≤ 1 for all but the brightest 2%: an 8-bit grey
        # can't go above 1, and a median default clipped every highlight (flat, darker dyed areas).
        med = np.median(col[sel], axis=0)
        dflt = np.clip(med * float(np.percentile(col[sel] @ LUM, 98)) / max(1e-3, float(med @ LUM)), 0, 1)
        defaults[key] = _hex(dflt)
        grey = np.clip(lum / max(1e-3, float(dflt @ LUM)), 0, 1)
        neutral += m[..., None] * grey[..., None]
        weight += m
        tint *= 1 + m[..., None] * (_to_linear(dflt) - 1)
    weight = np.clip(weight, 0, 1)[..., None]
    core = neutral / np.maximum(weight, 1e-6)
    # Soft edges between a bright colour and a dark channel default: the exact inverse would need
    # a dye albedo above 1, which an 8-bit texture can't hold. Cap the mask there so that
    # lerp(1, default, mask) stays >= the albedo (per channel, linear); the edge gets a little
    # harder, and the default look is reproduced exactly.
    lin = _to_linear(col)
    edge_zone = (weight[..., 0] > 0) & (weight[..., 0] < 0.99)
    if edge_zone.any():
        for i, key in enumerate(("primary", "secondary", "accent")):
            if key not in defaults:
                continue
            dl = _to_linear(np.array([int(defaults[key][j:j + 2], 16) / 255 for j in (1, 3, 5)], dtype=np.float32))
            cap = np.min((1 - lin) / np.maximum(1 - dl, 1e-4), axis=-1)
            mask[..., i] = np.where(edge_zone, np.minimum(mask[..., i], np.clip(cap, 0, 1)), mask[..., i])
        tint = np.ones_like(col)
        for i, key in enumerate(("primary", "secondary", "accent")):
            if key in defaults:
                dl = _to_linear(np.array([int(defaults[key][j:j + 2], 16) / 255 for j in (1, 3, 5)], dtype=np.float32))
                tint *= 1 + (mask[..., i] * covered)[..., None] * (dl - 1)
    edge = _to_srgb(lin / np.maximum(tint, 1e-4))
    dye_albedo = np.where(weight >= 0.99, core, np.where(weight > 0, edge, col))
    alpha = np.ones(col.shape[:2] + (1,), dtype=np.float32)
    if skin is not None:
        # skin: the painted colour over SKIN_HEADROOM × skin_04 per channel (linear), weight in alpha, so
        # `dyeAlbedo × lerp(1, SKIN_HEADROOM × skinTone, alpha)` gives back the painted skin with skin_04
        # (the animation stack's shader multiplies by 2 × the tone). The 2× headroom also keeps the
        # highlights: a texel up to twice skin_04 in a channel fits an 8-bit texture.
        ws = skin[..., None]  # covered texels plus the gutter next to them (_into_gutters)
        sk = _to_linear(np.array([int(SKIN_NEUTRAL[j:j + 2], 16) / 255 for j in (1, 3, 5)], dtype=np.float32))
        neutral_skin = _to_srgb(lin / (1 + ws * (SKIN_HEADROOM * sk - 1)))
        dye_albedo = np.where(ws > 0, neutral_skin, dye_albedo)
        # floored at 1/255: lossy WebP rewrites the colour under fully transparent texels (libwebp's
        # transparent-area cleanup), and 1/255 tints a non-skin texel by under 0.4 % at the darkest tone
        alpha = np.maximum(ws, 1 / 255).astype(np.float32)
    rgba = np.concatenate([dye_albedo, alpha], axis=-1)
    _save(f"{name}_dye_albedo", rgba, out_dir / f"{name}_dye_albedo.png", data=False)
    _save(f"{name}_dye_mask", mask, out_dir / f"{name}_dye_mask.png", data=True)
    return defaults


def rookie_body_rules(marks):
    """Rookie: R = sand cloth + helmet, G = olive webbing/pouches, B = teal armband + lenses,
    A = the armband (team glow, docs/04 §1.4). Skin, boots, straps and hair stay as painted, and
    nothing above the collar is dyed: face texels (cheek highlights, around the mouth and eyes) have
    the sand hue and used to land in R, which showed as pale specks with dark skin tones."""
    shoulder_x = marks["shoulder_L"][0]
    elbow_z, shoulder_z = marks["elbow_L"][2], marks["shoulder_L"][2]

    def rules(h, s, v, pos):
        x, z = pos[..., 0], pos[..., 2]
        head = z > marks["neck_z"] + 0.005
        hands = (np.abs(x) > marks["wrist_L"][0] - 0.02) & (z < marks["wrist_L"][2] + 0.04)
        teal = (h >= 150) & (h <= 215) & (s >= 0.28) & (v >= 0.18)
        olive = (h >= 46) & (h < 100) & (s >= 0.16) & (v >= 0.10) & ~teal
        # shaded folds of the uniform are darker but keep the hue; brown boots/straps are
        # darker *and* more saturated
        sand = (h >= 26) & (h < 47) & (s >= 0.08) & (s <= 0.66) & (v >= 0.26) & ~((s > 0.48) & (v < 0.5)) & ~hands & ~head
        olive &= ~head
        armband = teal & (x > shoulder_x - 0.06) & (z > elbow_z - 0.02) & (z < shoulder_z + 0.02)
        return sand, olive, teal, armband

    return rules


def rookie_body_skin(marks):
    """The Rookie's skin. On the head (above the collar) every warm, light texel: skin, the lips, and
    the pale sand the source baked along the hairline and round the ears (helmet colour on the head;
    left as painted it showed as pale outlines under a dark tone). Hair, brows and pupils are dark,
    the eyes' whites unsaturated, the lenses teal: they stay as painted. On the hands only skin
    hues, so the sleeve cuffs stay cloth."""

    def skin(h, s, v, pos):
        x, z = pos[..., 0], pos[..., 2]
        head = z > marks["neck_z"] + 0.005
        hands = (np.abs(x) > marks["wrist_L"][0] - 0.02) & (z < marks["wrist_L"][2] + 0.04)
        warm = (h <= 60) | (h >= 345)
        on_head = head & warm & (s >= 0.06) & (v >= 0.40)
        on_hands = hands & (((h >= 4) & (h <= 42)) | (h >= 345)) & (s >= 0.15) & (s <= 0.68) & (v >= 0.42)
        return on_head | on_hands

    return skin


def jetpack_rules(h, s, v, pos):
    """Twin-tank jetpack: G = olive tanks; frame, straps and nozzles stay as painted."""
    olive = (h >= 40) & (h < 100) & (s >= 0.16) & (v >= 0.10)
    none = np.zeros_like(olive)
    return none, olive, none, none


def helmet_rules(h, s, v, pos):
    """Brim helmet: R = sand dome/brim (dyes with the uniform), B = teal goggle lenses.
    The leather band, strap and goggle frames stay as painted."""
    teal = (h >= 150) & (h <= 215) & (s >= 0.28) & (v >= 0.18)
    sand = (h >= 26) & (h < 47) & (s >= 0.08) & (s <= 0.66) & (v >= 0.34) & ~((s > 0.48) & (v < 0.5)) & ~teal
    none = np.zeros_like(teal)
    return sand, none, teal, none


def no_rules(h, s, v, pos):
    """Not dyeable (e.g. the leather combat boots)."""
    none = np.zeros(h.shape, dtype=bool)
    return none, none, none, none
