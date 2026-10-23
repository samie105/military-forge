"""Checks for mocap.py's maths (no source data needed): python3 -I art/pipeline/test_mocap.py

* the readers' forward kinematics and the retarget match bone directions on the rig;
* two-bone IK reaches its target with the knee toward the pole;
* `march` keeps a planted ankle at its height, sliding back at the gait speed;
* the clip library keeps every other clip byte for byte when one is added and the buffer compacted.
"""
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mocap  # noqa: E402

LIB = Path(__file__).resolve().parents[1] / "character" / "rookie_anims.glb"
rig = mocap.Rig(LIB)


def bvh(frames):
    """A tiny BVH: hips, a spine, two legs and two arms in a T-pose, in centimetres; `frames` rows of channels."""
    joints = """HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Yrotation Xrotation Zrotation
 JOINT Chest { OFFSET 0 12 0 CHANNELS 3 Yrotation Xrotation Zrotation
  JOINT Chest3 { OFFSET 0 20 0 CHANNELS 3 Yrotation Xrotation Zrotation
   JOINT Neck { OFFSET 0 15 0 CHANNELS 3 Yrotation Xrotation Zrotation
    JOINT Head { OFFSET 0 9 0 CHANNELS 3 Yrotation Xrotation Zrotation End Site { OFFSET 0 17 0 } } }
   JOINT LeftCollar { OFFSET 3 7 0 CHANNELS 3 Yrotation Xrotation Zrotation
    JOINT LeftShoulder { OFFSET 15 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
     JOINT LeftElbow { OFFSET 30 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
      JOINT LeftWrist { OFFSET 25 0 0 CHANNELS 3 Yrotation Xrotation Zrotation End Site { OFFSET 19 0 0 } } } } }
   JOINT RightCollar { OFFSET -3 7 0 CHANNELS 3 Yrotation Xrotation Zrotation
    JOINT RightShoulder { OFFSET -15 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
     JOINT RightElbow { OFFSET -30 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
      JOINT RightWrist { OFFSET -25 0 0 CHANNELS 3 Yrotation Xrotation Zrotation End Site { OFFSET -19 0 0 } } } } } } }
 JOINT LeftHip { OFFSET 10 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
  JOINT LeftKnee { OFFSET 0 -43 0 CHANNELS 3 Yrotation Xrotation Zrotation
   JOINT LeftAnkle { OFFSET 0 -43 0 CHANNELS 3 Yrotation Xrotation Zrotation
    JOINT LeftToe { OFFSET 0 -9 19 CHANNELS 3 Yrotation Xrotation Zrotation End Site { OFFSET 0 -1 5 } } } } }
 JOINT RightHip { OFFSET -10 0 0 CHANNELS 3 Yrotation Xrotation Zrotation
  JOINT RightKnee { OFFSET 0 -43 0 CHANNELS 3 Yrotation Xrotation Zrotation
   JOINT RightAnkle { OFFSET 0 -43 0 CHANNELS 3 Yrotation Xrotation Zrotation
    JOINT RightToe { OFFSET 0 -9 19 CHANNELS 3 Yrotation Xrotation Zrotation End Site { OFFSET 0 -1 5 } } } } }
}
"""
    rows = "\n".join(" ".join(f"{v:.4f}" for v in r) for r in frames)
    path = Path(tempfile.mkdtemp()) / "t.bvh"
    path.write_text(f"{joints}MOTION\nFrames: {len(frames)}\nFrame Time: 0.016667\n{rows}\n")
    return path


def channels(arm_down=0.0):
    """One frame: hips at 96 cm, the left arm lowered `arm_down` degrees from the T-pose (about +Z: down is −)."""
    r = [0, 96, 0, 0, 0, 0] + [0, 0, 0] * 20
    # joints in order: Chest Chest3 Neck Head LeftCollar LeftShoulder …; LeftShoulder is the 6th rotating joint
    r[6 + 5 * 3 + 2] = -arm_down
    return r


def test_retarget_matches_directions():
    m = mocap.read_bvh(bvh([channels(0), channels(90)]))
    clip = mocap.retarget(m, rig, "100style", "t", fps=m.fps)
    for k, want in ((0, np.array([1.0, 0, 0])), (1, np.array([0, -1.0, 0]))):
        _, pos = mocap.pose_world(rig, clip, k)
        d = mocap._dir(pos[rig.idx("upperarm_L")], pos[rig.idx("forearm_L")])
        assert np.dot(d, want) > 0.999, (k, d)  # T-pose on the rig's A-pose rest: arm out; then straight down
    # standing straight in the source, the hips are at the rig's rest height
    assert abs(clip.pelvis[0, 1] - rig.rest_t[rig.idx("pelvis")][1]) < 0.01


def test_two_bone_reaches():
    rot, pos = rig.rest_world_rot, rig.rest_world_pos
    th, ca, fo = (rig.idx(n) for n in ("thigh_L", "calf_L", "foot_L"))
    target = pos[fo] + np.array([0.0, 0.08, 0.1])
    pole = pos[ca] + np.array([0, 0, 0.5])
    r_up, r_lo = mocap.two_bone(rig, rot, pos, th, ca, fo, target, pole)
    knee = pos[th] + r_up @ (rot[th].T @ (pos[ca] - pos[th]))
    ankle = knee + r_lo @ (rot[ca].T @ (pos[fo] - pos[ca]))
    assert np.linalg.norm(ankle - target) < 1e-6
    assert knee[2] > (pos[th][2] + target[2]) / 2  # the knee bends forward


def test_march_plants():
    frames = 12
    clip = mocap.Clip("w", 30, {b: np.tile(rig.rest_q[rig.idx(b)], (frames + 1, 1)) for b in mocap.RIG_TIPS if b in rig.names},
                      np.tile(rig.rest_t[rig.idx("pelvis")], (frames + 1, 1)))
    clip = mocap.march(rig, clip, speed=1.2, stance=0.55)
    paths = mocap.ankle_paths(rig, clip)
    left = paths["L"]
    down = [k for k in range(frames) if (k / frames) < 0.55]
    for k in down:
        assert abs(left[k][1] - 0.12) < 1e-3, left[k]
    slide = (left[down[0]][2] - left[down[-1]][2]) / ((down[-1] - down[0]) / 30)
    assert abs(slide - 1.2) < 0.02, slide
    assert np.allclose(clip.rot["thigh_L"][0], clip.rot["thigh_L"][-1], atol=1e-6) or np.allclose(clip.rot["thigh_L"][0], -clip.rot["thigh_L"][-1], atol=1e-6)


def test_library_keeps_other_clips():
    lib = mocap.GlbClips(LIB)
    before = {a["name"]: _dump(lib, a["name"]) for a in lib.g["animations"]}
    clip = mocap.Clip("zz_test", 30, {"spine1": np.array([[0, 0, 0, 1.0], [0.1, 0, 0, math.sqrt(0.99)]])})
    lib.add(clip)
    lib.compact()
    out = Path(tempfile.mkdtemp()) / "lib.glb"
    lib.write(out)
    again = mocap.GlbClips(out)
    for name, data in before.items():
        assert _dump(again, name) == data, name
    assert again.names()[-1] == "zz_test"


def _dump(lib, name):
    an = next(a for a in lib.g["animations"] if a["name"] == name)
    out = []
    for ch in an["channels"]:
        s = an["samplers"][ch["sampler"]]
        out.append((ch["target"]["node"], ch["target"]["path"], s["interpolation"],
                    mocap._accessor(lib.g, bytes(lib.bin), s["input"]).tobytes(), mocap._accessor(lib.g, bytes(lib.bin), s["output"]).tobytes()))
    return out


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
