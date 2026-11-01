"""
LaHave WaterWatch — build + serve (stdlib only, no external deps).

  python serve.py            # build data.json if missing, then serve on :8137
  python serve.py --rebuild  # force rebuild of data.json from the CSV
  python serve.py --build    # build only, don't serve

Binds to 127.0.0.1 only.
"""
import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "app"))
DATA_JSON = ROOT / "static" / "data.json"
PORT = 8137
HOST = "127.0.0.1"


def build():
    import pipeline  # noqa: E402
    pipeline.build.cache_clear()
    pipeline.load_raw.cache_clear()
    data = pipeline.build()
    DATA_JSON.write_text(json.dumps(data), encoding="utf-8")
    m = data["meta"]
    print(f"[build] {m['n_measurements']:,} measurements · {m['n_stations']} stations "
          f"· {m['n_params']} params · {m['n_exceedances']:,} exceedances")
    print(f"[build] wrote {DATA_JSON}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, fmt, *args):
        pass  # quiet


def serve():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[serve] LaHave WaterWatch → http://{HOST}:{PORT}/")
    print("[serve] Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] stopped")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="force rebuild data.json")
    ap.add_argument("--build", action="store_true", help="build only, no serve")
    args = ap.parse_args()

    if args.rebuild or args.build or not DATA_JSON.exists():
        build()
    if not args.build:
        serve()
