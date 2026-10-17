"""Import first in every Blender build script: an uncaught exception exits 1.

Blender's `--python` runner prints the traceback and exits 0 unless it is run with
`--python-exit-code 1`, so a crashed build would look like a success and leave the old outputs in
place. Every documented command passes the flag too; this makes the scripts safe without it.
"""
import os
import sys
import traceback


def _exit_on_error(kind, value, tb):
    traceback.print_exception(kind, value, tb)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(1)


sys.excepthook = _exit_on_error
