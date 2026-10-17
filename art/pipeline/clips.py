"""Animation library for the shared skeleton (docs/04 §4.2-§4.3, sign conventions in §9.2).

Imported by build_character.py (Blender). Three kinds of clip:

* locomotion: full-body loops keyed by hand (idle, walk, run, crouch_idle, crouch_walk, slide,
  jet_ascend, jet_hover, fall) plus the one-shot `land`;
* aim poses: single-frame, upper-body-only poses `aim_<family>_<angle>` for the pistol, dual
  and rifle families at down90/down45/level/up45/up90. The renderer blends the two poses around
  the current aim angle over the upper body;
* upper-body actions: one-shots `reload_pistol`, `reload_rifle`, `swap`, `throw`, `melee`.

Aim poses and actions are solved, not keyed by hand: each key names where the weapon grip
should be and which way the gun points, and two-bone IK places the arms (chibi arms are short,
so hand-keyed angles miss the gun). Every upper-body clip carries tracks for UPPER_BODY only.
"""
import math

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

FPS = 30
UPPER_BODY = [
    "spine1", "spine2", "neck", "head",
    "clavicle_L", "clavicle_R", "upperarm_L", "upperarm_R",
    "forearm_L", "forearm_R", "hand_L", "hand_R",
]
AIM_ANGLES = {"down90": -90, "down45": -45, "level": 0, "up45": 45, "up90": 90}
FAMILIES = ("pistol", "dual", "rifle")
# docs/04 §4.2 families without their own aim poses yet borrow the closest hold
AIM_POSE_FALLBACK = {
    "pistol": "pistol", "dual": "dual", "rifle": "rifle", "shotgun": "rifle", "sniper": "rifle",
    "launcher": "rifle", "heavy": "rifle", "melee": "pistol", "thrown": "pistol",
}


def q(rx=0.0, ry=0.0, rz=0.0):
    """Local rotation from Euler degrees (bone space: +X flexes forward, §9.2)."""
    return Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()


# ------------------------------------------------------------------ keying helpers

class ClipWriter:
    def __init__(self, arm):
        self.arm = arm
        arm.animation_data_create()
        for pb in arm.pose.bones:
            pb.rotation_mode = "QUATERNION"

    def reset(self):
        for pb in self.arm.pose.bones:
            pb.rotation_quaternion = Quaternion()
            pb.location = (0, 0, 0)
        bpy.context.view_layer.update()

    def begin(self, name):
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        self.arm.animation_data.action = act
        self.reset()
        self._last = {}
        return act

    def key(self, frame, pose):
        """pose: {bone: Quaternion | (Quaternion, location)}."""
        for bname, value in pose.items():
            rot, loc = value if isinstance(value, tuple) else (value, None)
            pb = self.arm.pose.bones[bname]
            prev = self._last.get(bname)
            if prev is not None and prev.dot(rot) < 0:
                rot = -rot  # keep quaternions in one hemisphere so keys interpolate the short way
            self._last[bname] = rot.copy()
            pb.rotation_quaternion = rot
            pb.keyframe_insert("rotation_quaternion", frame=frame)
            if loc is not None:
                pb.location = loc
                pb.keyframe_insert("location", frame=frame)

    def end(self, name):
        act = self.arm.animation_data.action
        track = self.arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        self.arm.animation_data.action = None
        self.reset()
        return act


def keyed(w, name, length, keys, loop=True):
    """Hand-keyed clip. keys: {bone: [(frame, (rx, ry, rz)[, location])...]}; loops repeat key 0."""
    w.begin(name)
    frames = {}
    for bname, ks in keys.items():
        for k in ks + ([(length, *ks[0][1:])] if loop else []):
            pose = frames.setdefault(k[0], {})
            pose[bname] = (q(*k[1]), Vector(k[2])) if len(k) > 2 else q(*k[1])
    for f in sorted(frames):
        w.key(f, frames[f])
    return w.end(name)


# ------------------------------------------------------------------ IK solver for upper-body poses

class UpperBodySolver:
    """Poses spine/arms from grip targets (armature space = Blender, character faces -Y)."""

    def __init__(self, arm):
        self.arm = arm
        self.pb = arm.pose.bones
        self.bones = arm.data.bones
        self.len = {n: self.bones[n].length for n in ("upperarm_L", "forearm_L", "upperarm_R", "forearm_R")}

    def _update(self):
        bpy.context.view_layer.update()

    def _aim_bone(self, name, head, direction):
        """Point bone `name` along `direction` with the least twist from its parent-posed rest."""
        pb = self.pb[name]
        pb.rotation_quaternion = Quaternion()
        self._update()
        cur = pb.matrix.copy()
        y = cur.to_3x3().col[1].normalized()
        rot = y.rotation_difference(direction.normalized()).to_matrix() @ cur.to_3x3()
        pb.matrix = Matrix.LocRotScale(head, rot.to_quaternion(), None)
        self._update()

    def _arm(self, side, wrist, pole):
        up, fore = f"upperarm_{side}", f"forearm_{side}"
        self.pb[up].rotation_quaternion = Quaternion()
        self.pb[fore].rotation_quaternion = Quaternion()
        self._update()
        s = self.pb[up].head.copy()
        a, b = self.len[up], self.len[fore]
        to = wrist - s
        d = min(max(to.length, abs(a - b) + 1e-4), a + b - 1e-4)
        axis = to.normalized()
        cos_a = (a * a + d * d - b * b) / (2 * a * d)
        sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
        p = (pole - axis * pole.dot(axis)).normalized()
        elbow = s + axis * (a * cos_a) + p * (a * sin_a)
        self._aim_bone(up, s, elbow - s)
        self._aim_bone(fore, elbow, (s + axis * d) - elbow)

    def _hand(self, side, grip, aim, up):
        """Hand pose that puts socket_weapon_<side> at `grip`, +Y along `aim`, +Z toward `up`."""
        y = aim.normalized()
        z = (up - y * up.dot(y)).normalized()
        x = y.cross(z)
        sock = Matrix.LocRotScale(grip, Matrix((x, y, z)).transposed().to_quaternion(), None)
        s0 = self.bones[f"socket_weapon_{side}"].matrix_local
        h0 = self.bones[f"hand_{side}"].matrix_local
        return sock @ s0.inverted() @ h0

    def solve(self, spec):
        """spec keys (all optional):
        spine: (s1x, s1y, s2x, s2y) degrees; neck, head: x degrees;
        clav_L / clav_R: (x, z) degrees (+x protracts, §9.2);
        R / L: ("grip", point, aim, up) to hold a weapon, or ("wrist", point) to place a free hand;
        pole_R / pole_L: elbow direction.
        Returns {bone: Quaternion} for UPPER_BODY."""
        for n in UPPER_BODY:
            self.pb[n].rotation_quaternion = Quaternion()
        s1x, s1y, s2x, s2y = spec.get("spine", (0, 0, 0, 0))
        self.pb["spine1"].rotation_quaternion = q(s1x, s1y, 0)
        self.pb["spine2"].rotation_quaternion = q(s2x, s2y, 0)
        self.pb["neck"].rotation_quaternion = q(spec.get("neck", 0), 0, 0)
        self.pb["head"].rotation_quaternion = q(spec.get("head", 0), spec.get("head_y", 0), 0)
        for side in "LR":
            cx, cz = spec.get(f"clav_{side}", (0, 0))
            self.pb[f"clavicle_{side}"].rotation_quaternion = q(cx, 0, cz)
        self._update()
        for side, sgn in (("R", -1), ("L", 1)):
            target = spec.get(side)
            if target is None:
                continue
            pole = spec.get(f"pole_{side}", Vector((sgn * 0.7, 0.5, -0.6)))
            if target[0] == "grip":
                _, grip, aim, up = target
                hand = self._hand(side, Vector(grip), Vector(aim), Vector(up))
                self._arm(side, hand.translation, Vector(pole))
                pb = self.pb[f"hand_{side}"]
                pb.matrix = Matrix.LocRotScale(pb.head.copy(), hand.to_quaternion(), None)
            else:
                self._arm(side, Vector(target[1]), Vector(pole))
            self._update()
        return {n: self.pb[n].rotation_quaternion.copy() for n in UPPER_BODY}


# ------------------------------------------------------------------ the clip set

def aim_dirs(deg):
    t = math.radians(deg)
    return Vector((0, -math.cos(t), math.sin(t))), Vector((0, math.sin(t), math.cos(t)))


# Every hold pivots on one point just in front of the chest pouches. Chibi arms reach only 0.27 m
# from the shoulder to the wrist (0.32 m to the grip), so the shoulders protract and the guns stay
# near the centreline.
CHEST = Vector((0.0, -0.02, 0.76))
PROTRACT = (22, 0)
# Rifle holds per aim angle: grip offset from CHEST (x, forward along the aim, z), spine yaw (deg),
# clavicle protraction L / R (deg). Searched numerically so that both wrists stay >= 1 cm inside
# their reach in every pose: the right on its grip, the left on socket_offhand_IK and on a foregrip
# 0.08 m ahead (W1 IKs the left hand there, docs/04 §4.2). build_character.py asserts it per pose
# for every two-handed weapon's `offhand` node.
RIFLE_HOLD = {
    -90: (-0.03, 0.13, 0.04, -15, 50, 35),
    -45: (-0.03, 0.20, 0.04, 0, 65, 35),
    0: (-0.03, 0.20, -0.04, 0, 65, 35),
    45: (-0.03, 0.20, -0.04, 0, 65, 35),
    90: (-0.03, 0.16, -0.04, -30, 65, 22),
}


def hold(solver, family, deg):
    """Spec for holding a weapon of `family` aimed `deg` above level (side view, facing -Y)."""
    d, u = aim_dirs(deg)
    k = deg / 90.0
    # ~24° of head pitch at ±90°, spread down the spine: the big chibi head exaggerates any tilt.
    spec = {"spine": (-4 * k, 0, -7 * k, 0), "neck": -4 * k, "head": -9 * k,
            "pole_R": Vector((-0.7, 0.3, -0.6)), "pole_L": Vector((0.7, 0.3, -0.6))}
    if family == "rifle":
        gx, f, gz, yaw, cl, cr = RIFLE_HOLD[min(RIFLE_HOLD, key=lambda a: abs(a - deg))]
        spec["spine"] = (-4 * k, yaw, -7 * k, yaw)
        spec["head_y"] = -2 * yaw  # the head turns back so the face stays on the aim
        grip = CHEST + Vector((gx, 0, gz)) + d * f
        side = d.cross(u)  # the gun's +X (its right)
        spec.update(clav_L=(cl, 0), clav_R=(cr, 0))
        spec["R"] = ("grip", grip, d, u)
        # the left hand on the foregrip: the k47's `offhand` node (gun frame -0.05, 0.07, -0.03)
        spec["L"] = ("grip", grip - side * 0.05 + d * 0.07 - u * 0.03, d, u)
    elif family == "dual":
        spec.update(clav_L=PROTRACT, clav_R=PROTRACT)
        spec["R"] = ("grip", CHEST + Vector((-0.09, 0, 0)) + d * 0.25, d, u)
        spec["L"] = ("grip", CHEST + Vector((0.09, 0, 0)) + d * 0.25, d, u)
    else:
        spec.update(clav_R=PROTRACT)
        spec["R"] = ("grip", CHEST + Vector((-0.07, 0, 0)) + d * 0.26, d, u)
        spec["L"] = ("wrist", Vector((0.30, 0.0, 0.56)))  # free hand relaxed by the hip
    return spec


def upper_clip(w, solver, name, length, specs, loop=False):
    """One-shot (or looping) upper-body clip from {frame: spec}."""
    w.begin(name)
    for f in sorted(specs):
        w.key(f, solver.solve(specs[f]))
    if loop:
        w.key(length, solver.solve(specs[min(specs)]))
    return w.end(name)


def build_all(arm):
    """Author every clip on `arm`. Returns the action names in order."""
    w = ClipWriter(arm)
    solver = UpperBodySolver(arm)
    names = []

    def add(act):
        names.append(act.name)

    # ---- locomotion (full body, hand-keyed). Pelvis location is in bone space: +Y is up.
    add(keyed(w, "idle", 60, {
        "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (30, (0, 0, 0), (0, -0.01, 0))],
        "spine1": [(0, (0, 0, 0)), (30, (2, 0, 0))],
        "spine2": [(0, (0, 0, 0)), (30, (2, 0, 0))],
        "head": [(0, (0, 0, 0)), (30, (-3, 0, 0))],
        "upperarm_L": [(0, (0, 0, 0)), (30, (0, 0, 4))],
        "upperarm_R": [(0, (0, 0, 0)), (30, (0, 0, -4))],
    }))
    add(keyed(w, "walk", 30, {
        "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (8, (0, 0, 0), (0, 0.015, 0)), (15, (0, 0, 0), (0, 0, 0)), (23, (0, 0, 0), (0, 0.015, 0))],
        "spine1": [(0, (4, 0, 0))],
        "thigh_L": [(0, (25, 0, 0)), (15, (-22, 0, 0))],
        "thigh_R": [(0, (-22, 0, 0)), (15, (25, 0, 0))],
        "calf_L": [(0, (-8, 0, 0)), (8, (-6, 0, 0)), (15, (-12, 0, 0)), (22, (-45, 0, 0))],
        "calf_R": [(0, (-12, 0, 0)), (7, (-45, 0, 0)), (15, (-8, 0, 0)), (23, (-6, 0, 0))],
        "foot_L": [(0, (-10, 0, 0)), (15, (12, 0, 0))],
        "foot_R": [(0, (12, 0, 0)), (15, (-10, 0, 0))],
        "upperarm_L": [(0, (-18, 0, -6)), (15, (18, 0, -6))],
        "upperarm_R": [(0, (18, 0, 6)), (15, (-18, 0, 6))],
    }))
    add(keyed(w, "run", 18, {
        "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (4, (0, 0, 0), (0, 0.035, 0)), (9, (0, 0, 0), (0, 0, 0)), (13, (0, 0, 0), (0, 0.035, 0))],
        "spine1": [(0, (10, 0, 0))],
        "thigh_L": [(0, (40, 0, 0)), (9, (-35, 0, 0))],
        "thigh_R": [(0, (-35, 0, 0)), (9, (40, 0, 0))],
        "calf_L": [(0, (-15, 0, 0)), (5, (-10, 0, 0)), (9, (-20, 0, 0)), (13, (-70, 0, 0))],
        "calf_R": [(0, (-20, 0, 0)), (4, (-70, 0, 0)), (9, (-15, 0, 0)), (14, (-10, 0, 0))],
        "upperarm_L": [(0, (-35, 0, -10)), (9, (40, 0, -10))],
        "upperarm_R": [(0, (40, 0, 10)), (9, (-35, 0, 10))],
        "forearm_L": [(0, (30, 0, 0))],
        "forearm_R": [(0, (30, 0, 0))],
    }))
    # Crouch: the crouched head hitbox centre is 0.84 m (standing 1.24): squat deep, tuck the head.
    crouch = {
        "pelvis": [(0, (0, 0, 0), (0, -0.23, -0.06)), (30, (0, 0, 0), (0, -0.235, -0.06))],
        "thigh_L": [(0, (95, 0, -10))],
        "thigh_R": [(0, (95, 0, 10))],
        "calf_L": [(0, (-140, 0, 0))],
        "calf_R": [(0, (-140, 0, 0))],
        "foot_L": [(0, (45, 0, 0))],
        "foot_R": [(0, (45, 0, 0))],
        "spine1": [(0, (22, 0, 0)), (30, (24, 0, 0))],
        "spine2": [(0, (12, 0, 0))],
        "head": [(0, (-12, 0, 0))],
        "upperarm_L": [(0, (25, 0, -10))],
        "upperarm_R": [(0, (25, 0, 10))],
    }
    add(keyed(w, "crouch_idle", 60, crouch))
    add(keyed(w, "crouch_walk", 30, {
        **crouch,
        "pelvis": [(0, (0, 0, 0), (0, -0.23, -0.06)), (8, (0, 0, 0), (0, -0.215, -0.06)), (15, (0, 0, 0), (0, -0.23, -0.06)), (23, (0, 0, 0), (0, -0.215, -0.06))],
        "thigh_L": [(0, (105, 0, -10)), (15, (82, 0, -10))],
        "thigh_R": [(0, (82, 0, 10)), (15, (105, 0, 10))],
        "calf_L": [(0, (-138, 0, 0)), (8, (-150, 0, 0)), (15, (-132, 0, 0))],
        "calf_R": [(0, (-132, 0, 0)), (15, (-138, 0, 0)), (23, (-150, 0, 0))],
        "foot_L": [(0, (33, 0, 0)), (15, (50, 0, 0))],
        "foot_R": [(0, (50, 0, 0)), (15, (33, 0, 0))],
    }))
    # Slide: feet-first on the hip, lead leg out, trailing knee tucked, leaning back (held loop).
    add(keyed(w, "slide", 12, {
        "pelvis": [(0, (0, 0, 0), (0, -0.30, 0)), (6, (0, 0, 0), (0, -0.295, 0))],
        "spine1": [(0, (-16, 0, 0))],
        "spine2": [(0, (-6, 0, 0))],
        "head": [(0, (14, 0, 0))],
        "thigh_L": [(0, (75, 0, -6))],
        "calf_L": [(0, (-12, 0, 0))],
        "foot_L": [(0, (-20, 0, 0))],
        "thigh_R": [(0, (50, 0, 8))],
        "calf_R": [(0, (-120, 0, 0))],
        "foot_R": [(0, (30, 0, 0))],
        "upperarm_L": [(0, (-25, 0, 30))],
        "upperarm_R": [(0, (-25, 0, -30))],
    }))
    add(keyed(w, "jet_ascend", 24, {
        "spine1": [(0, (-6, 0, 0)), (12, (-4, 0, 0))],
        "thigh_L": [(0, (8, 0, 2)), (12, (12, 0, 2))],
        "thigh_R": [(0, (4, 0, -2)), (12, (8, 0, -2))],
        "calf_L": [(0, (-20, 0, 0)), (12, (-26, 0, 0))],
        "calf_R": [(0, (-14, 0, 0)), (12, (-20, 0, 0))],
        "foot_L": [(0, (-25, 0, 0))],
        "foot_R": [(0, (-25, 0, 0))],
        "upperarm_L": [(0, (-20, 0, -12)), (12, (-24, 0, -10))],
        "upperarm_R": [(0, (-20, 0, 12)), (12, (-24, 0, 10))],
    }))
    add(keyed(w, "jet_hover", 36, {
        "pelvis": [(0, (0, 0, 0), (0, 0, 0)), (18, (0, 0, 0), (0, 0.02, 0))],
        "thigh_L": [(0, (14, 0, 4)), (18, (6, 0, 4))],
        "thigh_R": [(0, (4, 0, -4)), (18, (12, 0, -4))],
        "calf_L": [(0, (-35, 0, 0)), (18, (-25, 0, 0))],
        "calf_R": [(0, (-22, 0, 0)), (18, (-32, 0, 0))],
        "foot_L": [(0, (-15, 0, 0))],
        "foot_R": [(0, (-15, 0, 0))],
        "upperarm_L": [(0, (0, 0, 12)), (18, (0, 0, 16))],
        "upperarm_R": [(0, (0, 0, -12)), (18, (0, 0, -16))],
    }))
    add(keyed(w, "fall", 20, {
        "spine1": [(0, (-8, 0, 0))],
        "head": [(0, (8, 0, 0))],
        "thigh_L": [(0, (25, 0, 10)), (10, (10, 0, 12))],
        "thigh_R": [(0, (5, 0, -12)), (10, (22, 0, -10))],
        "calf_L": [(0, (-40, 0, 0)), (10, (-20, 0, 0))],
        "calf_R": [(0, (-15, 0, 0)), (10, (-40, 0, 0))],
        "upperarm_L": [(0, (0, 0, 70)), (10, (8, 0, 78))],
        "upperarm_R": [(0, (0, 0, -70)), (10, (8, 0, -78))],
        "forearm_L": [(0, (20, 0, 0)), (10, (35, 0, 0))],
        "forearm_R": [(0, (35, 0, 0)), (10, (20, 0, 0))],
    }))
    # Land: a one-shot 0.3 s dip (docs/04 §4.2 "land (additive dip)"); the renderer can play it
    # over the locomotion pose at partial weight.
    add(keyed(w, "land", 9, {
        "pelvis": [(0, (0, 0, 0), (0, -0.02, 0)), (3, (0, 0, 0), (0, -0.09, -0.02)), (9, (0, 0, 0), (0, 0, 0))],
        "thigh_L": [(0, (10, 0, 0)), (3, (38, 0, -4)), (9, (0, 0, 0))],
        "thigh_R": [(0, (10, 0, 0)), (3, (38, 0, 4)), (9, (0, 0, 0))],
        "calf_L": [(0, (-18, 0, 0)), (3, (-62, 0, 0)), (9, (0, 0, 0))],
        "calf_R": [(0, (-18, 0, 0)), (3, (-62, 0, 0)), (9, (0, 0, 0))],
        "foot_L": [(0, (8, 0, 0)), (3, (24, 0, 0)), (9, (0, 0, 0))],
        "foot_R": [(0, (8, 0, 0)), (3, (24, 0, 0)), (9, (0, 0, 0))],
        "spine1": [(0, (4, 0, 0)), (3, (12, 0, 0)), (9, (0, 0, 0))],
        "head": [(0, (0, 0, 0)), (3, (-8, 0, 0)), (9, (0, 0, 0))],
    }, loop=False))

    # ---- aim poses (upper body only, one frame each)
    for family in FAMILIES:
        for tag, deg in AIM_ANGLES.items():
            # two identical keys: a zero-length clip confuses players that loop by duration
            add(upper_clip(w, solver, f"aim_{family}_{tag}", 1, {0: hold(solver, family, deg)}, loop=True))

    # ---- upper-body actions, built on the level holds
    rifle = hold(solver, "rifle", 0)
    pistol = hold(solver, "pistol", 0)
    d, u = aim_dirs(0)
    grip_r = rifle["R"][1]

    def with_(base, **kw):
        s = dict(base)
        s.update(kw)
        return s

    tilt_d, tilt_u = aim_dirs(14)
    mag = grip_r + d * 0.03 - u * 0.09
    add(upper_clip(w, solver, "reload_rifle", 48, {
        0: rifle,
        8: with_(rifle, R=("grip", grip_r, tilt_d, tilt_u), L=("wrist", mag + Vector((0.03, 0.02, 0)))),
        16: with_(rifle, R=("grip", grip_r, tilt_d, tilt_u), L=("wrist", mag + Vector((0.14, 0.08, -0.24)))),
        26: with_(rifle, R=("grip", grip_r, tilt_d, tilt_u), L=("wrist", mag + Vector((0.03, 0.02, 0)))),
        36: with_(rifle, R=("grip", grip_r + d * 0.02, d, u)),
        48: rifle,
    }))
    pgrip = pistol["R"][1]
    near = Vector((-0.06, -0.22, 0.86))
    up_d, up_u = aim_dirs(30)
    add(upper_clip(w, solver, "reload_pistol", 30, {
        0: pistol,
        6: with_(pistol, R=("grip", near, up_d, up_u)),
        10: with_(pistol, R=("grip", near, up_d, up_u), L=("wrist", near + Vector((0.08, 0.02, -0.08)))),
        16: with_(pistol, R=("grip", near, up_d, up_u), L=("wrist", near + Vector((0.14, 0.06, -0.22)))),
        21: with_(pistol, R=("grip", near, up_d, up_u), L=("wrist", near + Vector((0.08, 0.02, -0.08)))),
        26: with_(pistol, R=("grip", pgrip, d, u)),
        30: pistol,
    }))
    hip = Vector((-0.22, 0.02, 0.56))
    down_d, down_u = aim_dirs(-70)
    add(upper_clip(w, solver, "swap", 15, {
        0: rifle,
        6: {"spine": (4, -6, 4, -8), "R": ("grip", hip, down_d, down_u), "L": ("wrist", Vector((0.28, 0.0, 0.58)))},
        9: {"spine": (4, -6, 4, -8), "R": ("grip", hip, down_d, down_u), "L": ("wrist", Vector((0.28, 0.0, 0.58)))},
        15: rifle,
    }))
    back_d, back_u = aim_dirs(150)
    fwd_d, fwd_u = aim_dirs(20)
    add(upper_clip(w, solver, "throw", 18, {
        0: {"spine": (0, 0, 0, 0), "R": ("wrist", Vector((-0.30, -0.06, 0.66))), "L": ("wrist", Vector((0.30, 0.0, 0.58)))},
        6: {"spine": (-6, 10, -10, 18), "neck": 0, "R": ("grip", Vector((-0.22, 0.12, 1.05)), back_d, back_u),
            "L": ("wrist", Vector((0.22, -0.24, 0.80))), "pole_R": Vector((-0.6, 0.2, -0.8))},
        10: {"spine": (8, -6, 10, -12), "R": ("grip", Vector((-0.10, -0.30, 0.92)), fwd_d, fwd_u),
             "L": ("wrist", Vector((0.30, 0.04, 0.62)))},
        18: {"spine": (0, 0, 0, 0), "R": ("wrist", Vector((-0.30, -0.06, 0.66))), "L": ("wrist", Vector((0.30, 0.0, 0.58)))},
    }))
    high_d, high_u = aim_dirs(110)
    low_d, low_u = aim_dirs(-60)
    add(upper_clip(w, solver, "melee", 14, {
        0: {"spine": (-4, 8, -6, 12), "R": ("grip", Vector((-0.20, 0.08, 1.00)), high_d, high_u),
            "L": ("wrist", Vector((0.26, -0.12, 0.70))), "pole_R": Vector((-0.6, 0.3, -0.7))},
        5: {"spine": (6, -8, 8, -10), "R": ("grip", Vector((-0.08, -0.30, 0.72)), d, u),
            "L": ("wrist", Vector((0.30, 0.04, 0.62)))},
        9: {"spine": (8, -10, 10, -12), "R": ("grip", Vector((0.02, -0.16, 0.56)), low_d, low_u),
            "L": ("wrist", Vector((0.30, 0.04, 0.62)))},
        14: {"spine": (0, 0, 0, 0), "R": ("wrist", Vector((-0.30, -0.06, 0.66))), "L": ("wrist", Vector((0.30, 0.0, 0.58)))},
    }))
    return names
