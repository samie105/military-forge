"""Self-test for check.py: known-good assets must pass and known-bad ones must fail.

    blender -b --factory-startup --python tools/asset-check/selftest.py

Builds two hat fixtures in a temp dir (one inside the cosmetic envelope, one ~40% over it) and
runs check.py on them plus the art-test assets. Exits 1 if any verdict is unexpected.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy

REPO = Path(__file__).resolve().parents[2]
CHECK = REPO / "tools/asset-check/check.py"
BODY = REPO / "art/character/rookie.glb"


def hat(path, radius, z0, z1):
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=z1 - z0, location=(0, 0, (z0 + z1) / 2))
    bpy.context.active_object.name = "hat"
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=False)


def run(path, *args):
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", str(CHECK), "--", str(path), *args]
    return subprocess.run(cmd, capture_output=True, text=True).returncode == 0


tmp = Path(tempfile.mkdtemp(prefix="asset-check-"))
hat(tmp / "hat_ok.glb", 0.22, 1.38, 1.56)    # sits on the helmet, inside the envelope
hat(tmp / "hat_huge.glb", 0.60, 1.40, 2.20)  # top hat from a cartoon: way over

cases = [
    ("rookie LOD0 passes", True, BODY),
    ("rookie LOD1 passes", True, REPO / "art/character/rookie_lod1.glb", "--lod", "1"),
    ("raw generator mesh fails", False, REPO / "art/character/source/rookie_tripo_raw.glb"),
    ("LOD0 file fails the LOD1 budget", False, BODY, "--lod", "1"),
    ("kit passes", True, REPO / "art/kit/kit_yard.glb", "--kind", "kit"),
    ("hat inside the envelope passes", True, tmp / "hat_ok.glb", "--kind", "part", "--base", str(BODY)),
    ("oversized hat fails", False, tmp / "hat_huge.glb", "--kind", "part", "--base", str(BODY)),
]
bad = 0
for name, expect, path, *args in cases:
    got = run(path, *args)
    ok = got == expect
    bad += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {'pass' if got else 'fail'} (expected {'pass' if expect else 'fail'})")
print(f"selftest: {len(cases) - bad}/{len(cases)} as expected")
sys.exit(1 if bad else 0)
