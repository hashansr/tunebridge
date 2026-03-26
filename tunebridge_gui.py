"""
TuneBridge — native macOS desktop app entrypoint.

Starts the Flask/Waitress server in a background thread, then opens a
WKWebView window (via pywebview) so TuneBridge runs as a self-contained
native app — no Safari, no external browser.
"""

import os
import sys
import threading
import time

import webview

# ── Ensure imports resolve when run from any working directory ────────────────
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

PORT = int(os.environ.get("TUNEBRIDGE_PORT", 5001))
URL  = f"http://localhost:{PORT}"


def _start_server():
    """Start the Waitress/Flask server in a daemon thread."""
    from app import app, DATA_DIR  # noqa: F401 — imports register routes

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
        # Server didn't come up — surface a basic error window
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
        background_color="#131313",  # matches --bg in style.css
    )

    # Quit the whole process when the window is closed
    window.events.closed += lambda: os._exit(0)

    webview.start(
        debug=False,       # set True to enable WKWebView inspector
        http_server=False, # we run our own server
    )


if __name__ == "__main__":
    main()
