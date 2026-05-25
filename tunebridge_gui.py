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

    def __init__(self):
        self.window = None

    def open_url(self, url):
        if isinstance(url, str) and any(url.startswith(p) for p in _ALLOWED_OPEN_URL_PREFIXES):
            subprocess.Popen(['open', url])

    def save_text_file(self, filename, content, file_kind=''):
        if self.window is None:
            return {'error': 'No window available'}
        try:
            safe_name = Path(str(filename or 'TuneBridge export.txt')).name
            kind = str(file_kind or '').strip().lower()
            if kind == 'csv':
                wanted_ext = '.csv'
                file_types = ('CSV files (*.csv)',)
            elif kind == 'm3u8':
                wanted_ext = '.m3u8'
                file_types = ('M3U8 playlists (*.m3u8)',)
            elif kind == 'm3u':
                wanted_ext = '.m3u'
                file_types = ('M3U playlists (*.m3u)',)
            elif kind == 'xml':
                wanted_ext = '.xml'
                file_types = ('XML files (*.xml)',)
            else:
                wanted_ext = Path(safe_name).suffix
                file_types = ()
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=safe_name,
                file_types=file_types,
            )
            if not result:
                return {'cancelled': True}
            path = Path(result[0] if isinstance(result, (list, tuple)) else result)
            if wanted_ext and path.suffix.lower() != wanted_ext.lower():
                path = path.with_suffix(wanted_ext)
            path.write_text(str(content or ''), encoding='utf-8')
            return {'ok': True, 'path': str(path)}
        except Exception as exc:
            return {'error': str(exc)}


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


# ── Native macOS menu bar & dock menu ────────────────────────────────────────

_TB_MENU_HANDLER = None  # held in module scope so PyObjC GC does not collect it


def _js(window, script: str) -> None:
    """Dispatch evaluate_js safely from any thread (deadlocks if called on main AppKit thread)."""
    threading.Thread(target=lambda: window.evaluate_js(script), daemon=True).start()


def _show_about_alert():
    """Show a native About dialog. Must be called on the main AppKit thread."""
    from AppKit import NSAlert
    info = _bundled_version_info()
    version = info.get('version_full') or info.get('version') or 'Development Build'
    alert = NSAlert.alloc().init()
    alert.setMessageText_('TuneBridge')
    alert.setInformativeText_(
        f'Version {version}\n\n'
        'Play your music library, build playlists, manage your DAPs and IEMs, '
        'analyse your collection, and sync music to portable devices.'
    )
    alert.runModal()


def _setup_native_menus(window):
    """
    Build the native macOS menu bar and dock menu using PyObjC (pure NSMenu).

    Runs in a background thread (pywebview func= callback). All NSApplication
    mutations are dispatched to the main thread via callAfter().
    """
    global _TB_MENU_HANDLER
    try:
        from AppKit import (
            NSApplication, NSMenu, NSMenuItem, NSObject,
            NSEventModifierFlagCommand, NSEventModifierFlagShift, NSEventModifierFlagOption,
        )
        try:
            from PyObjCTools.AppHelper import callAfter
        except ImportError:
            def callAfter(fn, *args):  # fallback: call inline (safe at startup)
                fn(*args)
    except ImportError as exc:
        print(f'TuneBridge: native menus unavailable: {exc}')
        return

    CMD   = NSEventModifierFlagCommand   # ⌘
    SHIFT = NSEventModifierFlagShift     # ⇧
    OPT   = NSEventModifierFlagOption    # ⌥
    RIGHT = ''                     # NSRightArrowFunctionKey  →
    LEFT  = ''                     # NSLeftArrowFunctionKey   ←

    # ── Action handler ────────────────────────────────────────────────────────
    class _TBMenuHandler(NSObject):
        """Receives all menu item actions; routes them to the web Player/App API."""

        def playPause_(self, sender):   _js(window, 'Player.togglePlay()')
        def nextTrack_(self, sender):   _js(window, 'Player.next()')
        def prevTrack_(self, sender):   _js(window, 'Player.prev()')
        def muteToggle_(self, sender):  _js(window, 'Player.toggleMute()')
        def shuffle_(self, sender):     _js(window, 'Player.toggleShuffle()')
        def cycleRepeat_(self, sender): _js(window, 'Player.cycleRepeat()')
        def newPlaylist_(self, sender): _js(window, 'App.showCreatePlaylistModal()')
        def importPl_(self, sender):    _js(window, 'App.triggerImport()')
        def addDap_(self, sender):      _js(window, 'App.showAddDapModal()')
        def addIem_(self, sender):      _js(window, 'App.showAddIemModal()')
        def libraryScan_(self, sender): _js(window, 'App.rescan()')
        def prefs_(self, sender):       _js(window, "App.showView('settings')")
        def helpModal_(self, sender):   _js(window, 'App.showHelp()')
        def github_(self, sender):      subprocess.Popen(['open', 'https://github.com/hashansr/tunebridge-releases/'])
        def kofi_(self, sender):        subprocess.Popen(['open', 'https://ko-fi.com/hashansr'])
        def aboutApp_(self, sender):    _show_about_alert()

    handler = _TBMenuHandler.alloc().init()

    # ── Edit menu delegate — strips macOS auto-injected text-service items ────
    class _EditMenuDelegate(NSObject):
        _SYSTEM = frozenset([
            'Writing Tools', 'AutoFill',
            'Start Dictation…', 'Emoji & Symbols',
            'Substitutions', 'Transformations', 'Speech',
        ])

        def menuWillOpen_(self, menu):
            i = menu.numberOfItems() - 1
            while i >= 0:
                if str(menu.itemAtIndex_(i).title()) in self._SYSTEM:
                    menu.removeItemAtIndex_(i)
                i -= 1
            # Remove trailing separator macOS leaves behind
            while menu.numberOfItems() > 0:
                if menu.itemAtIndex_(menu.numberOfItems() - 1).isSeparatorItem():
                    menu.removeItemAtIndex_(menu.numberOfItems() - 1)
                else:
                    break

    edit_delegate = _EditMenuDelegate.alloc().init()

    # ── Menu item factory ─────────────────────────────────────────────────────
    def mi(title, action=None, key='', mask=CMD, target=None):
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            title, action, key
        )
        if key:
            item.setKeyEquivalentModifierMask_(mask)
        if target is not None:
            item.setTarget_(target)
        return item

    sep = NSMenuItem.separatorItem

    # ── TuneBridge (app) menu ─────────────────────────────────────────────────
    app_m = NSMenu.alloc().initWithTitle_('TuneBridge')
    app_m.addItem_(mi('About TuneBridge', 'aboutApp:', target=handler))
    app_m.addItem_(sep())
    app_m.addItem_(mi('Preferences…', 'prefs:', ',', target=handler))
    app_m.addItem_(sep())
    svc_m = NSMenu.alloc().initWithTitle_('Services')
    svc_i = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_('Services', None, '')
    svc_i.setSubmenu_(svc_m)
    app_m.addItem_(svc_i)
    app_m.addItem_(sep())
    app_m.addItem_(mi('Hide TuneBridge', 'hide:', 'h'))
    app_m.addItem_(mi('Hide Others', 'hideOtherApplications:', 'h', mask=CMD | OPT))
    app_m.addItem_(mi('Show All', 'unhideAllApplications:', ''))
    app_m.addItem_(sep())
    app_m.addItem_(mi('Quit TuneBridge', 'terminate:', 'q'))

    # ── File menu ─────────────────────────────────────────────────────────────
    file_m = NSMenu.alloc().initWithTitle_('File')
    file_m.addItem_(mi('New Playlist', 'newPlaylist:', 'n', target=handler))
    file_m.addItem_(sep())
    file_m.addItem_(mi('Import Playlist…', 'importPl:', 'i', target=handler))
    file_m.addItem_(sep())
    file_m.addItem_(mi('Add Digital Audio Player…', 'addDap:', target=handler))
    file_m.addItem_(mi('Add IEM or Headphone…', 'addIem:', target=handler))
    file_m.addItem_(sep())
    file_m.addItem_(mi('Library Scan', 'libraryScan:', target=handler))
    file_m.addItem_(sep())
    file_m.addItem_(mi('Close Window', 'performClose:', 'w'))

    # ── Edit menu (standard NSResponder selectors — WKWebView handles these) ──
    edit_m = NSMenu.alloc().initWithTitle_('Edit')
    edit_m.addItem_(mi('Undo', 'undo:', 'z'))
    edit_m.addItem_(mi('Redo', 'redo:', 'z', mask=CMD | SHIFT))
    edit_m.addItem_(sep())
    edit_m.addItem_(mi('Cut', 'cut:', 'x'))
    edit_m.addItem_(mi('Copy', 'copy:', 'c'))
    edit_m.addItem_(mi('Paste', 'paste:', 'v'))
    edit_m.addItem_(sep())
    edit_m.addItem_(mi('Select All', 'selectAll:', 'a'))
    edit_m.setDelegate_(edit_delegate)

    # ── Play menu ─────────────────────────────────────────────────────────────
    play_m = NSMenu.alloc().initWithTitle_('Play')
    play_m.addItem_(mi('Play/Pause', 'playPause:', 'p', target=handler))
    play_m.addItem_(mi('Next Track', 'nextTrack:', RIGHT, target=handler))
    play_m.addItem_(mi('Previous Track', 'prevTrack:', LEFT, target=handler))
    play_m.addItem_(sep())
    play_m.addItem_(mi('Mute', 'muteToggle:', target=handler))  # no ⌘M — that minimises
    play_m.addItem_(sep())
    play_m.addItem_(mi('Shuffle', 'shuffle:', 's', mask=CMD | SHIFT, target=handler))
    play_m.addItem_(mi('Repeat', 'cycleRepeat:', 'r', mask=CMD | SHIFT, target=handler))

    # ── Help menu ─────────────────────────────────────────────────────────────
    help_m = NSMenu.alloc().initWithTitle_('Help')
    help_m.addItem_(mi('TuneBridge Help', 'helpModal:', '?', target=handler))
    help_m.addItem_(sep())
    help_m.addItem_(mi('View on GitHub', 'github:', target=handler))
    help_m.addItem_(mi('Support on Ko‑fi', 'kofi:', target=handler))

    # ── Dock right-click menu ─────────────────────────────────────────────────
    dock_m = NSMenu.alloc().init()
    dock_m.addItem_(mi('Play/Pause', 'playPause:', target=handler))
    dock_m.addItem_(mi('Next Track', 'nextTrack:', target=handler))
    dock_m.addItem_(mi('Previous Track', 'prevTrack:', target=handler))

    # ── Assemble menu bar & apply on main thread ──────────────────────────────
    bar = NSMenu.alloc().init()
    for menu in (app_m, file_m, edit_m, play_m, help_m):
        top = NSMenuItem.alloc().init()
        top.setSubmenu_(menu)
        bar.addItem_(top)

    def _apply():
        app = NSApplication.sharedApplication()
        app.setMainMenu_(bar)
        app.setServicesMenu_(svc_m)
        app.setDockMenu_(dock_m)

    callAfter(_apply)
    _TB_MENU_HANDLER = (handler, edit_delegate)  # both must stay alive for PyObjC GC
    print('TuneBridge: native menu bar installed')


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

    native_api = _TuneBridgeApi()
    window = webview.create_window(
        title="TuneBridge",
        url=app_url,
        width=1280,
        height=800,
        min_size=(900, 600),
        background_color="#131313",
        js_api=native_api,
    )
    native_api.window = window

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

    # Mutable flag so the background dialog thread can re-trigger close after confirmation.
    _close_state = {'quit_confirmed': False}

    def _on_window_closing():
        import app as flask_app
        sync_active = flask_app.sync_state.get('status') in ('scanning', 'copying')
        if sync_active and not _close_state['quit_confirmed']:
            # Run the dialog off the main AppKit thread so returning True here
            # is processed before the thread blocks — this is what allows
            # pywebview to actually cancel the close.
            def _ask_and_maybe_quit():
                try:
                    result = subprocess.run(
                        ['osascript', '-e',
                         'display dialog "A sync is in progress.\\n\\nQuitting now may leave '
                         'incomplete files on your device. Quit anyway?" '
                         'buttons {"Go Back", "Quit App"} default button "Go Back" with icon caution'],
                        capture_output=True, text=True, timeout=30
                    )
                    if result.returncode == 0 and 'Quit App' in (result.stdout or ''):
                        _close_state['quit_confirmed'] = True
                        _stop_playback_best_effort()
                        window.destroy()
                except Exception:
                    pass  # Dialog failed — do nothing; app stays open
            threading.Thread(target=_ask_and_maybe_quit, daemon=True).start()
            return True  # Cancel this close attempt; thread handles quit if confirmed
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
        func=_setup_native_menus,
        args=(window,),
    )


if __name__ == "__main__":
    main()
