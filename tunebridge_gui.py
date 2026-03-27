"""
TuneBridge — native macOS desktop app entrypoint.

Starts the Flask/Waitress server in a background thread, then opens a
WKWebView window (via pywebview) so TuneBridge runs as a self-contained
native app — no Safari, no external browser.

Works in two modes:
  - Development: python tunebridge_gui.py (from project root)
  - Installed:   /Applications/TuneBridge.app (PyInstaller bundle)
"""

import os
import sys
import threading
import time
from pathlib import Path

# ── Locate project directory ─────────────────────────────────────────────────
# When frozen by PyInstaller, __file__ is inside the .app bundle temp dir.
# PROJECT_DIR is embedded at build time via the TUNEBRIDGE_PROJECT_DIR env var.
if getattr(sys, 'frozen', False):
    PROJECT_DIR = os.environ.get('TUNEBRIDGE_PROJECT_DIR', '')
    if not PROJECT_DIR or not os.path.isdir(PROJECT_DIR):
        import tkinter.messagebox as mb
        mb.showerror('TuneBridge', 'Cannot find project directory.\nRe-run create_app.sh.')
        sys.exit(1)
else:
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# Ensure imports and Flask's relative file lookups resolve correctly
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)
os.chdir(PROJECT_DIR)

import webview  # noqa: E402 — must come after sys.path setup

PORT = int(os.environ.get("TUNEBRIDGE_PORT", 5001))
URL  = f"http://localhost:{PORT}"


def _start_server():
    """Start the Waitress/Flask server in a daemon thread."""
    from app import app  # noqa: F401 — imports register all routes

    try:
        from waitress import serve
        serve(app, host="127.0.0.1", port=PORT, threads=4)
    except ImportError:
        app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)


def _wait_for_server(timeout: int = 15) -> bool:
    """Poll until the server responds or timeout expires."""
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{URL}/api/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    # Start server in background before creating the window
    server_thread = threading.Thread(target=_start_server, daemon=True)
    server_thread.start()

    if not _wait_for_server():
        webview.create_window(
            "TuneBridge — Error",
            html="<h2 style='font-family:sans-serif;color:#c00;padding:40px'>"
                 "TuneBridge failed to start.<br><small>Check /tmp/tunebridge.log</small></h2>",
        )
        webview.start()
        return

    window = webview.create_window(
        title="TuneBridge",
        url=URL,
        width=1280,
        height=800,
        min_size=(900, 600),
        background_color="#131313",
    )

    # ── Player state persistence ─────────────────────────────────────────────
    # IMPORTANT: Do NOT call evaluate_js from window.events.closing.
    # closing fires on the main AppKit thread; evaluate_js uses
    # performSelectorOnMainThread:waitUntilDone:YES internally, so calling
    # it from the main thread deadlocks the app (the "not responding" hang).
    #
    # Instead, a background thread calls evaluate_js every 5 s and writes
    # the state directly to player_state.json.  Background → main thread
    # dispatch works fine; only main → main self-dispatch deadlocks.
    state_file = Path(PROJECT_DIR) / 'data' / 'player_state.json'

    def _player_state_watcher():
        while True:
            time.sleep(5)
            try:
                state_json = window.evaluate_js(
                    'typeof Player !== "undefined" && Player.getStateJSON'
                    ' ? Player.getStateJSON() : null'
                )
                if state_json and isinstance(state_json, str) and len(state_json) > 5:
                    tmp = str(state_file) + '.tmp'
                    with open(tmp, 'w') as f:
                        f.write(state_json)
                    Path(tmp).replace(state_file)
            except Exception:
                break  # window closed or JS context gone — exit quietly

    watcher = threading.Thread(target=_player_state_watcher, daemon=True)
    watcher.start()

    window.events.closed += lambda: os._exit(0)

    webview.start(
        debug=False,
        http_server=False,
    )


if __name__ == "__main__":
    main()
