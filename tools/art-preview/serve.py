"""Local server for the art preview: serves the repo root and saves viewer screenshots.

    python3 tools/art-preview/serve.py [port]      # default 8123, binds 127.0.0.1 only
    open http://localhost:8123/tools/art-preview/

POST /__screenshot/<name>.png with PNG bytes writes art/screenshots/<name>.png (the viewer's
"Save screenshot" button). Nothing else is writable.
"""
import http.server
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "art" / "screenshots"
MAX_BYTES = 16 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".glb": "model/gltf-binary", ".js": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        m = re.fullmatch(r"/__screenshot/([a-z0-9_-]{1,48})\.png", self.path)
        length = int(self.headers.get("Content-Length", 0))
        if not m or not 0 < length <= MAX_BYTES:
            self.send_error(400)
            return
        data = self.rfile.read(length)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            self.send_error(415)
            return
        SHOTS.mkdir(parents=True, exist_ok=True)
        (SHOTS / f"{m[1]}.png").write_bytes(data)
        self.send_response(204)
        self.end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
print(f"art preview: http://localhost:{port}/tools/art-preview/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
