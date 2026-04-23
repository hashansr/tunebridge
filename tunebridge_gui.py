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

import webview  # noqa: E402 — must come after sys.path setup

PORT = int(os.environ.get("TUNEBRIDGE_PORT", 5001))
URL  = f"http://localhost:{PORT}"


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
    from app import app  # noqa: F401 — imports register all routes

    try:
        from waitress import serve
        serve(app, host="127.0.0.1", port=PORT, threads=4)
    except ImportError:
        app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)


def _health_check() -> bool:
    """Return True if a TuneBridge server is already healthy on PORT."""
    import urllib.request
    import json as _json
    try:
        with urllib.request.urlopen(f"{URL}/api/health", timeout=2) as r:
            return _json.loads(r.read().decode()).get("status") == "ok"
    except Exception:
        return False


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
        system_mask = 1 << 14
        refs['local'] = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
            system_mask, _handle_event
        )
        refs['global'] = NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(
            system_mask, _handle_event
        )
        print('TuneBridge: media key bridge enabled (Play/Pause, Next, Previous)')
    except Exception as exc:
        print(f'TuneBridge: media key bridge unavailable: {exc}')

    return refs


def main():
    # If a TuneBridge server is already running (e.g. a dev server, or a
    # previous app instance), reuse it instead of showing an error.
    reusing = _health_check()

    if not reusing:
        server_thread = threading.Thread(target=_start_server, daemon=True)
        server_thread.start()
        if not _wait_for_server():
            # Last-chance check: maybe a concurrent launch beat us to the port
            if not _health_check():
                webview.create_window(
                    "TuneBridge — Error",
                    html="<h2 style='font-family:sans-serif;color:#c00;padding:40px'>"
                         "TuneBridge failed to start.<br>"
                         "<small>Check that port 5001 is not blocked.</small></h2>",
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
