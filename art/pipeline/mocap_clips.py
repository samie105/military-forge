"""Motion-capture clips onto the shared skeleton (docs/design/character-feel-research.md §5.2, §5.3), appended to
the clip library both bodies share (rookie_anims.glb; the female rig has the same skeleton).

    python3 -I art/pipeline/mocap_clips.py --data <dir> [--out art/character] [--runtime apps/web/public/assets]

`--data` holds the source packs, each downloaded on its own (never committed; the repo keeps only these recipes,
the clips they make, and the licences in art/README.md and apps/web/public/licenses/motion-data.txt):
    <dir>/100style/Neutral_FW.bvh       100STYLE (CC BY 4.0), https://zenodo.org/record/8127870
    <dir>/cmu/140.asf, 140_07.amc …     CMU Graphics Lab Motion Capture Database, http://mocap.cs.cmu.edu/
The clips:
    walk         replaces W8's unplanted walk: a 100STYLE neutral walk's upper body, hips and timing, with planted
                 feet (mocap.march: down 55 % of the cycle, sliding back at 1.2 m/s) on a 0.4 s cycle for chibi legs
    idle_shift   CMU 140_07 (idle): weight shifting from foot to foot, looped, feet planted
    idle_look    CMU 140_06 (idle): looking around, looped, feet planted
Run it after build_character.py (which writes the hand-keyed library); it replaces the clips it makes and keeps
every other clip byte for byte. Data files are only read.
"""
import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mocap  # noqa: E402

FPS = 30
ROOT = Path(__file__).resolve().parents[2]

# who made each clip, under which licence (art/README.md "Motion capture", the game's credits)
SOURCES = {
    "100style": {"name": "100STYLE dataset (Mason, Starke, Komura, 2022)", "licence": "CC BY 4.0", "url": "https://www.ianxmason.com/100style/"},
    "cmu": {"name": "CMU Graphics Lab Motion Capture Database", "licence": "free for all uses; not for resale as data", "url": "http://mocap.cs.cmu.edu/",
            "credit": "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217."},
}


def walk(data, rig):
    """The planted walk: one cycle of 100STYLE's neutral forward walk (a straight stretch, left foot down to left
    foot down), its heading drift taken out, on the rig; the spine and head stood up; arms and spine ×1.3; then a
    0.4 s cycle (12 frames) whose feet march: down 55 % of it, sliding back at 1.2 m/s, 5 cm lift."""
    m = mocap.read_bvh(data / "100style" / "Neutral_FW.bvh")
    down = mocap.contacts(m, "LeftAnkle")
    td = [k for k in range(1168, 1500) if down[k] and not down[k - 1]]
    cyc = mocap.dedrift(m.slice(td[0], td[1] + 1), mocap.HIPS["100style"])
    clip = mocap.retarget(cyc, rig, "100style", "walk")
    frames = 12
    period = (cyc.frames - 1) / cyc.fps
    clip = mocap.retime(clip, [k / frames * period for k in range(frames + 1)])
    clip.fps = FPS
    clip = mocap.close_loop(clip)
    clip = mocap.upright(rig, clip)
    clip = mocap.exaggerate(clip, ["upperarm_L", "upperarm_R", "forearm_L", "forearm_R", "spine1", "spine2"], 1.3)
    clip = mocap.march(rig, clip, speed=1.2, stance=0.55, lift=0.05)
    clip = mocap.toe_clear(rig, clip)
    return clip, {"source": "100style", "file": "Neutral/Neutral_FW.bvh", "frames": [td[0], td[1]], "speed": 1.2, "stance": 0.55}


def idle(data, rig, name, take, start, seconds):
    """A looped idle from a CMU take: `seconds` from `start` (s), at 30 fps, the spine and head stood up to 70 %,
    closed into a loop over its last quarter, feet planted where they stand."""
    m = mocap.read_asf_amc(data / "cmu" / f"{take.split('_')[0]}.asf", data / "cmu" / f"{take}.amc").resample(FPS)
    a = int(start * FPS)
    seg = m.slice(a, a + int(seconds * FPS) + 1)
    clip = mocap.retarget(seg, rig, "cmu", name)
    clip = mocap.upright(rig, clip, keep=0.3)
    clip = mocap.close_loop(clip, 0.25)
    clip = mocap.plant(rig, clip)
    clip = mocap.toe_clear(rig, clip)
    return clip, {"source": "cmu", "file": f"{take}.amc", "seconds": [start, start + seconds]}


def build(data, rig):
    return [
        walk(data, rig),
        idle(data, rig, "idle_shift", "140_07", 0.0, 4.0),
        idle(data, rig, "idle_look", "140_06", 6.0, 4.0),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", default=ROOT / "art" / "character", type=Path)
    ap.add_argument("--runtime", default=ROOT / "apps" / "web" / "public" / "assets", type=Path)
    args = ap.parse_args()
    lib_path = args.out / "rookie_anims.glb"
    rig = mocap.Rig(lib_path)
    lib = mocap.GlbClips(lib_path)
    made = {}
    for clip, info in build(args.data, rig):
        lib.add(clip, replace=True)
        made[clip.name] = {**info, "frames_out": clip.frames, "fps": clip.fps, **{k: v for k, v in SOURCES[info["source"]].items() if k != "credit"}}
        print(f"{clip.name}: {clip.frames} frames from {info['source']} {info['file']}")
    lib.compact()
    lib.write(lib_path)
    (args.out / "rookie_mocap.json").write_text(json.dumps(made, indent=2) + "\n")
    runtime = args.runtime / "characters" / "rookie"
    if runtime.exists():
        lib.write(runtime / "rookie_anims.glb")
        manifest = json.loads((runtime / "rookie.json").read_text())
        manifest["clips"] = lib.names()
        (runtime / "rookie.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", lib_path, f"{lib_path.stat().st_size / 1024:.0f} KB,", len(lib.names()), "clips")


if __name__ == "__main__":
    main()
