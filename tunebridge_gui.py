"""
TuneBridge — native macOS desktop app entrypoint.

Starts the Flask/Waitress server in a background thread, then opens a
WKWebView window (via pywebview) so TuneBridge runs as a self-contained
native app — no Safari, no external browser.

Works in two modes:
  - Development: python tunebridge_gui.py (from project root)
  - Installed:   /Applications/TuneBridge.app (self-contained frozen bundle)
"""

import os
import sys
import threading
import time
import uuid
from pathlib import Path


def _resolve_project_dir() -> str:
    """
    Resolve runtime project/resources directory.

    Priority order:
      1) Explicit env override (legacy launcher compatibility)
      2) PyInstaller/Nuitka-style extraction dir (`sys._MEIPASS`) when frozen
      3) Current file directory (development mode)
    """
    env_dir = os.environ.get('TUNEBRIDGE_PROJECT_DIR', '')
    if env_dir and os.path.isdir(env_dir):
        return env_dir

    if getattr(sys, 'frozen', False):
        mei = getattr(sys, '_MEIPASS', '')
        if mei and os.path.isdir(mei):
            return mei

        # Fallback: executable directory (defensive fallback only)
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if os.path.isdir(exe_dir):
            return exe_dir

        raise RuntimeError('Cannot resolve bundled resources directory.')

    return os.path.dirname(os.path.abspath(__file__))


# ── Locate project/resources directory ───────────────────────────────────────
PROJECT_DIR = _resolve_project_dir()

# Ensure bundled mode stores user data in App Support even when no external
# launcher injects TUNEBRIDGE_BUNDLED.
if getattr(sys, 'frozen', False):
    os.environ.setdefault('TUNEBRIDGE_BUNDLED', '1')
    os.environ.setdefault('TUNEBRIDGE_PROJECT_DIR', PROJECT_DIR)

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


def _wait_for_server(expected_token: str, timeout: int = 15):
    """
    Poll until our own server responds.

    Returns: (ok: bool, reason: str)
      - (True, 'ok') on success
      - (False, 'other_instance') when another TuneBridge instance is already bound
      - (False, 'timeout') if no server became healthy
    """
    import urllib.request
    import json as _json
    deadline = time.time() + timeout
    foreign_hits = 0
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{URL}/api/health", timeout=1) as r:
                data = _json.loads(r.read().decode("utf-8"))
            if data.get("status") == "ok" and data.get("instance_token") == expected_token:
                return True, 'ok'
            if data.get("status") == "ok":
                foreign_hits += 1
                if foreign_hits >= 2:
                    return False, 'other_instance'
        except Exception:
            time.sleep(0.3)
    return False, 'timeout'


def main():
    # Unique token so this process can detect if port 5001 is serving a stale
    # older TuneBridge process instead of the server we just started.
    instance_token = str(uuid.uuid4())
    os.environ["TUNEBRIDGE_INSTANCE_TOKEN"] = instance_token

    # Start server in background before creating the window
    server_thread = threading.Thread(target=_start_server, daemon=True)
    server_thread.start()

    ok, reason = _wait_for_server(instance_token)
    if not ok:
        msg = (
            "Another TuneBridge instance appears to be running on port 5001."
            if reason == 'other_instance' else
            "TuneBridge failed to start."
        )
        webview.create_window(
            "TuneBridge — Error",
            html="<h2 style='font-family:sans-serif;color:#c00;padding:40px'>"
                 f"{msg}<br><small>Close existing instances and relaunch.</small></h2>",
        )
        webview.start()
        return

    # Per-launch query param prevents WKWebView from reusing a stale cached
    # document shell on cold start.
    app_url = f"{URL}/?v={int(time.time())}"

    window = webview.create_window(
        title="TuneBridge",
        url=app_url,
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
    _bundled = os.environ.get('TUNEBRIDGE_BUNDLED') == '1'
    _data_dir = (
        Path.home() / 'Library' / 'Application Support' / 'TuneBridge'
        if _bundled else
        Path(PROJECT_DIR) / 'data'
    )
    state_file = _data_dir / 'player_state.json'

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
