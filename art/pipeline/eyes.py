"""The painted eyes, measured for a texture blink (no triangles: animation-feel.md ask 1, the orchestrator's (d)).

A body's eyes are painted in its albedo. A face has too few vertices for an eyelid to be weighted, and at 512² an eye
is only about five texels across, so a painted lid mask would be blocky. Instead the manifest gets each eye as an
ellipse in the body's bind-pose space (glTF axes: the body's +X, Y up, Z forward): a shader takes the eye-local
position e = ((X - cx) / rx, (Y - cy) / ry) from the vertex `position` (affine, so exact per fragment) and draws the
lid and a moved iris itself, crisp at any texture size.

measure() renders the head front-on (orthographic, flat, the albedo as is) and finds each painted eye near its bone:
the largest dark blob, thinned of lashes; plus, where there is one, the white beside it. simulate() runs the shader
on that render (blinks and looks) for the README.
"""
import math
import os
import tempfile

import bpy
import numpy as np

FRAME = 0.16   # m: the square rendered round each eye bone
RES = 640      # px: 0.25 mm per pixel
LUM = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _render_eye(body, image, centre_x, centre_z, frame=FRAME, res=RES):
    """The body alone, front-on, flat texture: (res, res, 3) sRGB floats with row 0 at the top; pixel (i, j) is at
    x = centre_x + (j + 0.5) / res * frame - frame / 2, z = centre_z + frame / 2 - (i + 0.5) / res * frame."""
    sc = bpy.context.scene
    saved = {o: o.hide_render for o in sc.objects}
    state = (sc.camera, sc.render.engine, sc.display.shading.color_type, sc.display.shading.light,
             sc.view_settings.view_transform, sc.view_settings.look, sc.render.resolution_x, sc.render.resolution_y,
             sc.render.resolution_percentage, sc.render.filepath, sc.render.image_settings.file_format,
             sc.render.film_transparent)
    tn = next(n for m in body.data.materials for n in m.node_tree.nodes if n.type == "TEX_IMAGE")
    old_image = tn.image
    tn.image = image
    for o in sc.objects:
        o.hide_render = o is not body
    cam_data = bpy.data.cameras.new("eyes_cam")
    cam_data.type, cam_data.ortho_scale = "ORTHO", frame
    cam = bpy.data.objects.new("eyes_cam", cam_data)
    sc.collection.objects.link(cam)
    cam.location = (centre_x, -3.0, centre_z)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    sc.camera = cam
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.color_type, sc.display.shading.light = "TEXTURE", "FLAT"
    sc.view_settings.view_transform, sc.view_settings.look = "Standard", "None"
    sc.render.resolution_x = sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    path = os.path.join(tempfile.mkdtemp(prefix="eyes_"), "eye.png")
    sc.render.filepath = path
    arm = body.find_armature()
    pose = arm.data.pose_position if arm else None
    if arm:
        arm.data.pose_position = "REST"
    bpy.ops.render.render(write_still=True)
    if arm:
        arm.data.pose_position = pose
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(res, res, 4)[::-1, :, :3]  # Blender's rows run bottom-up
    bpy.data.images.remove(img)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data)
    tn.image = old_image
    for o, h in saved.items():
        o.hide_render = h
    (sc.camera, sc.render.engine, sc.display.shading.color_type, sc.display.shading.light,
     sc.view_settings.view_transform, sc.view_settings.look, sc.render.resolution_x, sc.render.resolution_y,
     sc.render.resolution_percentage, sc.render.filepath, sc.render.image_settings.file_format,
     sc.render.film_transparent) = state
    return px


def _shift(m, di, dj):
    out = np.zeros_like(m)
    h, w = m.shape
    out[max(di, 0):h + min(di, 0), max(dj, 0):w + min(dj, 0)] = m[max(-di, 0):h + min(-di, 0), max(-dj, 0):w + min(-dj, 0)]
    return out


def _erode(m, r):
    for _ in range(r):
        m = m & _shift(m, 1, 0) & _shift(m, -1, 0) & _shift(m, 0, 1) & _shift(m, 0, -1)
    return m


def _dilate(m, r):
    for _ in range(r):
        m = m | _shift(m, 1, 0) | _shift(m, -1, 0) | _shift(m, 0, 1) | _shift(m, 0, -1)
    return m


def _largest(m):
    """The largest 4-connected blob of a boolean mask."""
    lab = np.zeros(m.shape, np.int32)
    best, best_n, n = None, 0, 0
    for i, j in zip(*np.nonzero(m)):
        if lab[i, j]:
            continue
        n += 1
        stack, cells = [(i, j)], []
        lab[i, j] = n
        while stack:
            a, b = stack.pop()
            cells.append((a, b))
            for c, d in ((a + 1, b), (a - 1, b), (a, b + 1), (a, b - 1)):
                if 0 <= c < m.shape[0] and 0 <= d < m.shape[1] and m[c, d] and not lab[c, d]:
                    lab[c, d] = n
                    stack.append((c, d))
        if len(cells) > best_n:
            best, best_n = n, len(cells)
    return lab == best if best else np.zeros_like(m)


def _ellipse(mask, x0, z0):
    """Centre (x, z) and radii (m) of a filled blob, from its moments (a filled ellipse has sigma = radius / 2)."""
    i, j = np.nonzero(mask)
    x = x0 + (j + 0.5) / RES * FRAME
    z = z0 - (i + 0.5) / RES * FRAME
    return (float(x.mean()), float(z.mean())), (2 * float(x.std()), 2 * float(z.std()))


def _hex(rgb):
    return "#" + "".join(f"{round(min(max(c, 0.0), 1.0) * 255):02x}" for c in rgb)


def measure(body, arm, image, colours=None, margin=1.06):
    """Each eye: {side: dict} with its ellipse in glTF bind-pose space and its iris in eye-local units. Shapes, iris
    and white come from `image` (the albedo as painted: drawn untoned); the lid's skin from `colours` if given (the
    dye albedo the shader samples, whose skin is neutralised for the skin tone: drawn as skin), at the same pixels."""
    eyes, renders = {}, {}
    for side in ("L", "R"):
        bone = arm.data.bones[f"eye_{side}"].head_local
        px = _render_eye(body, image, bone.x, bone.z)
        cpx = _render_eye(body, colours, bone.x, bone.z) if colours is not None else px
        x0, z0 = bone.x - FRAME / 2, bone.z + FRAME / 2  # the frame's left and top edges
        lum = px @ LUM
        sat = px.max(axis=-1) - px.min(axis=-1)
        dark = _largest(lum < 0.22)
        iris = _largest(_dilate(_erode(dark, 20), 20))  # lashes (under ~10 mm thick) fall away
        (ix, iz), (irx, irz) = _ellipse(iris, x0, z0)
        jj, ii = np.meshgrid(np.arange(RES), np.arange(RES))
        gx, gz = x0 + (jj + 0.5) / RES * FRAME, z0 - (ii + 0.5) / RES * FRAME
        near = ((gx - ix) / (irx * 1.9)) ** 2 + ((gz - iz) / (irz * 1.3)) ** 2 < 1
        # the white: brighter and greyer than the skin round it (hers is a pale beige, not white)
        white = _largest((lum > np.median(lum) + 0.06) & (sat < np.median(sat) - 0.1) & near & ~_dilate(dark, 1))
        has_white = white.sum() > 0.05 * iris.sum()
        opening = iris | white if has_white else iris
        (cx, cz), (rx, rz) = _ellipse(opening, x0, z0)
        rx, rz = rx * margin, rz * margin
        eyes[side] = {
            # glTF bind pose: X = Blender x, Y = Blender z, Z = -Blender y (the face is at +Z)
            "centre": [round(cx, 4), round(cz, 4)], "radius": [round(rx, 4), round(rz, 4)],
            "iris": {"centre": [round((ix - cx) / rx, 3), round((iz - cz) / rz, 3)],
                     "radius": [round(irx / rx, 3), round(irz / rz, 3)]},
            "irisColour": _hex(np.median(px[iris], axis=0)),
            "whiteColour": _hex(np.median(px[white], axis=0)) if has_white else None,
            # how far out (eye-local) the painted eye is cleared while it moves or shuts: a dot eye's soft painted
            # edge would stay as a ring; an eye with a white keeps its painted outline (and the lashes over it)
            "erase": 1.0 if has_white else ERASE_DOT,
        }
        ring = (((gx - cx) / rx) ** 2 + ((gz - cz) / rz) ** 2 > 1.2 ** 2) & (((gx - cx) / rx) ** 2 + ((gz - cz) / rz) ** 2
                                                                              < 1.6 ** 2) & (lum > 0.3)
        eyes[side]["skin"] = _hex(np.median(cpx[ring], axis=0))  # the skin round it: the lid's colour
        renders[side] = (px, x0, z0)
    return eyes, renders


def simulate(px, x0, z0, eye, blink=0.0, look=(0.0, 0.0), frame=FRAME, res=RES):
    """The shader the README describes, on a front render of the albedo. While the eye blinks or looks, redraw it:
    inside its painted outline and its moved one, the eye moved by `look` (eye-local units; a dot eye moves whole,
    an eye with a white moves only its iris), the skin elsewhere; then the lid comes down from the top to the
    blink's line (0 open, 1 shut), which ends as a lash arc across the eye's lower third."""
    out = px.copy()
    jj, ii = np.meshgrid(np.arange(res), np.arange(res))
    ex = (x0 + (jj + 0.5) / res * frame - eye["centre"][0]) / eye["radius"][0]
    ey = (z0 - (ii + 0.5) / res * frame - eye["centre"][1]) / eye["radius"][1]
    rgb = lambda h: np.array([int(h[k:k + 2], 16) / 255 for k in (1, 3, 5)], np.float32)  # noqa: E731
    skin, iris_c = rgb(eye["skin"]), rgb(eye["irisColour"])
    dot = eye["whiteColour"] is None
    white_c = skin if dot else rgb(eye["whiteColour"])
    lx, ly = look
    if blink <= 0 and lx == 0 and ly == 0:
        return out  # open and ahead: the painting as it is
    sx, sy = (ex - lx, ey - ly) if dot else (ex, ey)
    painted = ex ** 2 + ey ** 2 < eye["erase"] ** 2
    in_eye = sx ** 2 + sy ** 2 < 1
    ic, ir = eye["iris"]["centre"], eye["iris"]["radius"]
    in_iris = ((ex - ic[0] - lx) / ir[0]) ** 2 + ((ey - ic[1] - ly) / ir[1]) ** 2 < 1
    col = np.where(in_eye[..., None], np.where(in_iris[..., None], iris_c, white_c), skin)
    if blink > 0:
        sag = SAG * blink * (1 - np.clip(sx, -1, 1) ** 2)  # the lid's edge dips in the middle as it closes
        edge = 1 - 2.2 * blink - sag
        col = np.where((in_eye & (sy > edge))[..., None], skin, col)
        line = np.maximum(1 - 2.2 * blink, LINE_REST) - sag
        lash = (sx ** 2 / 1.08 ** 2 + sy ** 2 < 1.08 ** 2) & (np.abs(sy - line) < LASH)
        col = np.where(lash[..., None], iris_c, col)
        in_eye = in_eye | lash
    return np.where((painted | in_eye)[..., None], col, out)


LOOK_MAX = 0.3   # eye-local units an eye (or its iris) moves at most
ERASE_DOT = 1.15  # a dot eye's painted area cleared while it moves or shuts (eye-local)
LINE_REST = -0.35  # eye-local y where the lash line stays once the eye is shut
SAG = 0.25       # how far the lid's edge dips in the middle when shut (eye-local)
LASH = 0.07      # half the lash line's thickness (eye-local)
FRONT = 0.1      # m, bind-pose Z: only the face (in front of the head's middle) has eyes; the back of the head doesn't


def manifest(measured):
    """The body manifest's `eyes` block (README: the texture blink)."""
    return {"front": FRONT, "lookMax": LOOK_MAX, "eraseDot": ERASE_DOT, "lineRest": LINE_REST, "sag": SAG, "lash": LASH,
            **{side: {k: v for k, v in e.items()} for side, e in measured.items()}}
