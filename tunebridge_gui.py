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
import json
import socket
import subprocess
import threading
import time
import traceback
from collections import deque
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

import subprocess  # noqa: E402
import webview  # noqa: E402 — must come after sys.path setup

BASE_PORT = int(os.environ.get("TUNEBRIDGE_PORT", 5001))
PORT = BASE_PORT
URL  = f"http://localhost:{PORT}"
_SERVER_STARTUP_ERROR = None


_ALLOWED_OPEN_URL_PREFIXES = (
    'https://ko-fi.com/',
    'https://github.com/hashansr/tunebridge-releases/',
)


class _TuneBridgeApi:
    """Exposed to JavaScript as window.pywebview.api — provides native macOS actions."""

    def open_url(self, url):
        if isinstance(url, str) and any(url.startswith(p) for p in _ALLOWED_OPEN_URL_PREFIXES):
            subprocess.Popen(['open', url])


def _set_port(port: int):
    """Update the process-wide local server port."""
    global PORT, URL
    PORT = int(port)
    URL = f"http://localhost:{PORT}"


def _bundled_version_info() -> dict:
    """Return the version metadata for this app bundle/source checkout."""
    try:
        with open(Path(PROJECT_DIR) / "version.json", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


# ── macOS media key integration ──────────────────────────────────────────────
# NX constants from <IOKit/hidsystem/ev_keymap.h>
_NX_SUBTYPE_AUX_CONTROL_BUTTON = 8
_NX_KEYTYPE_PLAY     = 16
_NX_KEYTYPE_NEXT     = 17
_NX_KEYTYPE_PREVIOUS = 18
_NX_KEYTYPE_FAST     = 19
_NX_KEYTYPE_REWIND   = 20


def _start_server():
    """Start the Waitress/Flask server in a daemon thread."""
    global _SERVER_STARTUP_ERROR

    try:
        from app import app  # noqa: F401 — imports register all routes
        try:
            from waitress import serve
        except ImportError:
            app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)
        else:
            serve(app, host="127.0.0.1", port=PORT, threads=4)
    except Exception:
        _SERVER_STARTUP_ERROR = traceback.format_exc()
        print(_SERVER_STARTUP_ERROR)


def _health_check(port: int | None = None) -> bool:
    """Return True if a TuneBridge server is already healthy on PORT."""
    import urllib.request
    import json as _json
    check_url = f"http://localhost:{port or PORT}"
    try:
        with urllib.request.urlopen(f"{check_url}/api/health", timeout=2) as r:
            return _json.loads(r.read().decode()).get("status") == "ok"
    except Exception:
        return False


def _server_version_info(port: int | None = None) -> dict:
    """Return version metadata from an already-running TuneBridge server."""
    import urllib.request
    check_url = f"http://localhost:{port or PORT}"
    try:
        with urllib.request.urlopen(f"{check_url}/api/version", timeout=2) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


def _same_build(server_info: dict, bundled_info: dict) -> bool:
    """Return True when a running server matches this app bundle."""
    if not server_info or not bundled_info:
        return False
    server_build = server_info.get("build")
    bundled_build = bundled_info.get("build")
    if server_build is not None and bundled_build is not None:
        try:
            return int(server_build) == int(bundled_build)
        except Exception:
            pass
    return (server_info.get("version_full") or server_info.get("version")) == (
        bundled_info.get("version_full") or bundled_info.get("version")
    )


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", int(port))) != 0


def _find_fallback_port(start: int) -> int:
    """Find a free local port for this app when 5001 has a stale server."""
    for port in range(max(1, start), start + 100):
        if _port_is_free(port):
            return port
    raise RuntimeError("No available TuneBridge local port found.")


def _wait_for_server(timeout: int = 15) -> bool:
    """Poll until a healthy server responds on PORT. Returns True on success."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _health_check():
            return True
        time.sleep(0.3)
    return False


def _start_media_key_bridge(window):
    """
    Capture macOS media keys (Play/Pause, Next, Previous) and dispatch
    to the web Player API in a background thread.
    """
    # Keep these refs alive for app lifetime (PyObjC monitor callbacks are GC-sensitive).
    refs = {'local': None, 'global': None}
    cmd_queue = deque()
    queue_lock = threading.Lock()
    queue_event = threading.Event()

    def _enqueue(cmd: str):
        with queue_lock:
            cmd_queue.append(cmd)
        queue_event.set()

    def _drain_js_worker():
        while True:
            queue_event.wait(timeout=1.0)
            while True:
                with queue_lock:
                    if not cmd_queue:
                        queue_event.clear()
                        break
                    cmd = cmd_queue.popleft()
                try:
                    if cmd == 'play_pause':
                        window.evaluate_js(
                            'if (window.Player && Player.togglePlay) { Player.togglePlay(); }'
                            ' else { document.getElementById("player-play-btn")?.click(); }'
                        )
                    elif cmd == 'next':
                        window.evaluate_js(
                            'if (window.Player && Player.next) { Player.next(); }'
                            ' else { document.getElementById("player-next-btn")?.click(); }'
                        )
                    elif cmd == 'previous':
                        window.evaluate_js(
                            'if (window.Player && Player.prev) { Player.prev(); }'
                            ' else { document.getElementById("player-prev-btn")?.click(); }'
                        )
                except Exception:
                    # Window closed / JS runtime unavailable; stop silently.
                    return

    worker = threading.Thread(target=_drain_js_worker, daemon=True)
    worker.start()

    _last_fire = {'play_pause': 0.0, 'next': 0.0, 'previous': 0.0}
    _dedupe_sec = 0.12

    def _maybe_enqueue(cmd: str):
        now = time.monotonic()
        last = _last_fire.get(cmd, 0.0)
        if (now - last) < _dedupe_sec:
            return
        _last_fire[cmd] = now
        _enqueue(cmd)

    def _handle_event(ev):
        try:
            if ev is None:
                return ev
            if int(ev.subtype()) != _NX_SUBTYPE_AUX_CONTROL_BUTTON:
                return ev

            data1 = int(ev.data1())
            key_code = (data1 & 0xFFFF0000) >> 16
            key_flags = (data1 & 0x0000FFFF)
            key_state = (key_flags & 0xFF00) >> 8

            # Only fire on key-down to avoid double-trigger on key-up.
            if key_state != 0xA:
                return ev

            if key_code == _NX_KEYTYPE_PLAY:
                _maybe_enqueue('play_pause')
            elif key_code in (_NX_KEYTYPE_NEXT, _NX_KEYTYPE_FAST):
                _maybe_enqueue('next')
            elif key_code in (_NX_KEYTYPE_PREVIOUS, _NX_KEYTYPE_REWIND):
                _maybe_enqueue('previous')
        except Exception:
            pass
        return ev

    try:
        from AppKit import NSEvent

        # System-defined events include hardware media keys.
        # Local monitor only: addGlobalMonitorForEventsMatchingMask on
        # NSEventMaskSystemDefined triggers kTCCServiceMediaLibrary on macOS 12+
        # because the OS routes media-key interception through the Now Playing
        # framework. The local monitor fires whenever TuneBridge is frontmost,
        # which is the only context where keyboard shortcuts are useful anyway.
        system_mask = 1 << 14
        refs['local'] = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
            system_mask, _handle_event
        )
        print('TuneBridge: media key bridge enabled (Play/Pause, Next, Previous)')
    except Exception as exc:
        print(f'TuneBridge: media key bridge unavailable: {exc}')

    return refs


def main():
    # If the same TuneBridge build is already running, reuse it. If an older
    # dev/app server is still on the default port, start this bundle on a
    # fallback port so a new app window cannot accidentally show stale UI.
    bundled_info = _bundled_version_info()
    reusing = False
    if _health_check(BASE_PORT):
        existing_info = _server_version_info(BASE_PORT)
        if _same_build(existing_info, bundled_info):
            _set_port(BASE_PORT)
            reusing = True
        else:
            try:
                fallback = _find_fallback_port(BASE_PORT + 1)
                print(
                    "TuneBridge: existing server on port "
                    f"{BASE_PORT} is build {existing_info.get('version_full') or existing_info.get('version') or 'unknown'}; "
                    f"starting this build on port {fallback}."
                )
                _set_port(fallback)
            except Exception as exc:
                webview.create_window(
                    "TuneBridge — Error",
                    html="<h2 style='font-family:sans-serif;color:#c00;padding:40px'>"
                         "TuneBridge could not find a free local port.<br>"
                         f"<small>{exc}</small></h2>",
                )
                webview.start()
                return
    else:
        _set_port(BASE_PORT)

    if not reusing:
        server_thread = threading.Thread(target=_start_server, daemon=True)
        server_thread.start()
        if not _wait_for_server():
            # Last-chance check: maybe a concurrent launch beat us to the port
            if not _health_check():
                detail = _SERVER_STARTUP_ERROR or "No backend response before startup timeout."
                detail_html = (
                    detail.replace("&", "&amp;")
                          .replace("<", "&lt;")
                          .replace(">", "&gt;")
                )
                webview.create_window(
                    "TuneBridge — Error",
                    html="<h2 style='font-family:sans-serif;color:#c00;padding:40px'>"
                         "TuneBridge failed to start.<br>"
                         "<small>Check that port 5001 is not blocked.</small></h2>"
                         "<pre style='font-family:monospace;color:#333;padding:0 40px;white-space:pre-wrap'>"
                         f"{detail_html}</pre>",
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
        js_api=_TuneBridgeApi(),
    )

    # ── Player state persistence ─────────────────────────────────────────────
    # IMPORTANT: Do NOT call evaluate_js from window.events.closing.
    # closing fires on the main AppKit thread; evaluate_js uses
    # performSelectorOnMainThread:waitUntilDone:YES internally, so calling
    # it from the main thread deadlocks the app (the "not responding" hang).
    #
    # Instead, a background thread calls evaluate_js every 5 s and posts
    # the state to /api/player/state (persisted in SQLite). Background → main thread
    # dispatch works fine; only main → main self-dispatch deadlocks.
    def _player_state_watcher():
        import urllib.request as _urlreq
        while True:
            time.sleep(5)
            try:
                state_json = window.evaluate_js(
                    'typeof Player !== "undefined" && Player.getStateJSON'
                    ' ? Player.getStateJSON() : null'
                )
                if state_json and isinstance(state_json, str) and len(state_json) > 5:
                    req = _urlreq.Request(
                        f'http://127.0.0.1:{PORT}/api/player/state',
                        data=state_json.encode('utf-8'),
                        headers={'Content-Type': 'application/json'},
                        method='POST',
                    )
                    _urlreq.urlopen(req, timeout=2)
            except Exception:
                break  # window closed or JS context gone — exit quietly

    watcher = threading.Thread(target=_player_state_watcher, daemon=True)
    watcher.start()

    # Install native macOS media key bridge.
    _media_key_refs = _start_media_key_bridge(window)

    def _stop_playback_best_effort():
        """Stop audio backends during app shutdown (no JS calls; close-safe)."""
        try:
            import urllib.request as _urlreq
            import json as _json
            for endpoint, payload in (
                ('/api/player/crossfade_cancel', {}),
                ('/api/player/pause', {'paused': True}),
                ('/api/player/stop', {}),
            ):
                try:
                    req = _urlreq.Request(
                        f'http://127.0.0.1:{PORT}{endpoint}',
                        data=_json.dumps(payload).encode('utf-8'),
                        headers={'Content-Type': 'application/json'},
                        method='POST',
                    )
                    _urlreq.urlopen(req, timeout=1.0)
                except Exception:
                    pass
        except Exception:
            pass

    def _force_exit_failsafe():
        """Fallback exit for close paths that don't trigger `closed` on macOS."""
        def _delayed_exit():
            time.sleep(1.5)
            os._exit(0)
        threading.Thread(target=_delayed_exit, daemon=True).start()

    def _on_window_closing():
        import app as flask_app
        sync_active = flask_app.sync_state.get('status') in ('scanning', 'copying')
        if sync_active:
            try:
                result = subprocess.run(
                    ['osascript', '-e',
                     'display dialog "A sync is in progress.\\n\\nQuitting now may leave '
                     'incomplete files on your device. Quit anyway?" '
                     'buttons {"Cancel", "Quit"} default button "Cancel" with icon caution'],
                    capture_output=True, text=True, timeout=30
                )
                # osascript stdout: "button returned:Quit\n" on confirm
                if result.returncode != 0 or 'Quit' not in (result.stdout or ''):
                    return True  # Cancel the close
            except Exception:
                pass  # Dialog failed — allow close rather than hanging
        _stop_playback_best_effort()
        _force_exit_failsafe()

    def _on_window_closed():
        _stop_playback_best_effort()
        os._exit(0)

    window.events.closing += _on_window_closing
    window.events.closed += _on_window_closed

    webview.start(
        debug=False,
        http_server=False,
    )


if __name__ == "__main__":
    main()
