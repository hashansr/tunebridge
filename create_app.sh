#!/bin/bash
# Creates "TuneBridge.app" in /Applications using pywebview (WKWebView).
# TuneBridge runs as a true native macOS window — no Safari, no browser.
# Run once after install: bash create_app.sh

set -e

APP_NAME="TuneBridge"
APP_PATH="/Applications/${APP_NAME}.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="${PROJECT_DIR}/venv/bin/python"
CUSTOM_ICON="${PROJECT_DIR}/static/TuneBridge.icns"

echo "Building ${APP_NAME}.app (pywebview / WKWebView)..."

# ── Remove stale versions ─────────────────────────────────────────────────────
for OLD in "/Applications/Music Manager.app" "/Applications/TuneBridge.app"; do
    [ -d "$OLD" ] && { echo "  Removing ${OLD}..."; rm -rf "$OLD"; }
done

# ── Verify pywebview is installed ─────────────────────────────────────────────
if ! "$VENV_PYTHON" -c "import webview" 2>/dev/null; then
    echo "  Installing pywebview..."
    "${PROJECT_DIR}/venv/bin/pip" install pywebview --quiet
fi

# ── Build the .app bundle structure ──────────────────────────────────────────
CONTENTS="${APP_PATH}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"

mkdir -p "$MACOS" "$RESOURCES"

# Info.plist — identifies the app to macOS
cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>             <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>      <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>       <string>com.tunebridge.app</string>
    <key>CFBundleVersion</key>          <string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleExecutable</key>       <string>${APP_NAME}</string>
    <key>CFBundleIconFile</key>         <string>AppIcon</string>
    <key>CFBundlePackageType</key>      <string>APPL</string>
    <key>LSMinimumSystemVersion</key>   <string>12.0</string>
    <key>NSHighResolutionCapable</key>  <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key><true/>
    </dict>
    <key>LSUIElement</key>              <false/>
</dict>
</plist>
PLIST

# Launcher shell script — the actual macOS executable
cat > "${MACOS}/${APP_NAME}" <<LAUNCHER
#!/bin/bash
# TuneBridge native launcher
exec "${VENV_PYTHON}" "${PROJECT_DIR}/tunebridge_gui.py"
LAUNCHER
chmod +x "${MACOS}/${APP_NAME}"

# ── Copy icon ─────────────────────────────────────────────────────────────────
if [ -f "$CUSTOM_ICON" ]; then
    cp "$CUSTOM_ICON" "${RESOURCES}/AppIcon.icns"
    # Refresh Finder's icon cache
    touch "$APP_PATH"
fi

# ── Clear quarantine so Gatekeeper doesn't block first launch ─────────────────
xattr -cr "$APP_PATH" 2>/dev/null || true

echo ""
echo "  ✓ ${APP_NAME}.app installed to /Applications"
echo ""
echo "  How it works:"
echo "    • Double-click TuneBridge to open a native WKWebView window"
echo "    • No Safari — TuneBridge appears in Cmd+Tab as its own app"
echo "    • Closing the window stops the server"
echo ""
echo "  To also run from Terminal:"
echo "    source venv/bin/activate && python tunebridge_gui.py"
echo ""
