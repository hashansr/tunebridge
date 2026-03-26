#!/bin/bash
# Creates "TuneBridge.app" in /Applications using PyInstaller + pywebview.
# Produces a proper Mach-O binary — macOS prompts for ~/Documents access on
# first launch, then remembers the permission forever.
# Run once after install: bash create_app.sh

set -e

APP_NAME="TuneBridge"
APP_PATH="/Applications/${APP_NAME}.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="${PROJECT_DIR}/venv/bin/python"
VENV_PYINSTALLER="${PROJECT_DIR}/venv/bin/pyinstaller"
CUSTOM_ICON="${PROJECT_DIR}/static/TuneBridge.icns"

echo "Building ${APP_NAME}.app (PyInstaller + pywebview / WKWebView)..."

# ── Remove stale versions ─────────────────────────────────────────────────────
for OLD in "/Applications/Music Manager.app" "/Applications/TuneBridge.app"; do
    [ -d "$OLD" ] && { echo "  Removing ${OLD}..."; rm -rf "$OLD"; }
done

# ── Ensure dependencies are installed ────────────────────────────────────────
if ! "$VENV_PYTHON" -c "import webview" 2>/dev/null; then
    echo "  Installing pywebview..."
    "${PROJECT_DIR}/venv/bin/pip" install pywebview --quiet
fi
if [ ! -f "$VENV_PYINSTALLER" ]; then
    echo "  Installing pyinstaller..."
    "${PROJECT_DIR}/venv/bin/pip" install pyinstaller --quiet
fi

# ── PyInstaller build ─────────────────────────────────────────────────────────
# Embed PROJECT_DIR so the frozen binary can locate data/ and static/ at runtime.
# --windowed: no terminal window
# --hidden-import: pywebview's macOS backend isn't auto-detected by PyInstaller
cd "$PROJECT_DIR"
"$VENV_PYINSTALLER" \
    --noconfirm \
    --windowed \
    --name "$APP_NAME" \
    --icon "$CUSTOM_ICON" \
    --hidden-import "webview.platforms.cocoa" \
    --distpath "/tmp/tunebridge_dist" \
    --workpath "/tmp/tunebridge_build" \
    --specpath "/tmp/tunebridge_build" \
    tunebridge_gui.py \
    2>&1 | grep -E "^(Building|Copying|EXE|BUNDLE|INFO|WARNING|ERROR|completed)" || true

BUILT_APP="/tmp/tunebridge_dist/${APP_NAME}.app"

if [ ! -d "$BUILT_APP" ]; then
    echo "ERROR: PyInstaller build failed — check output above"
    exit 1
fi

# ── Embed PROJECT_DIR into the app's environment ──────────────────────────────
# Patch Info.plist via Python to handle paths with spaces correctly
"$VENV_PYTHON" - "${BUILT_APP}/Contents/Info.plist" "$PROJECT_DIR" <<'PYEOF'
import plistlib, sys
plist_path, project_dir = sys.argv[1], sys.argv[2]
with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)
plist.setdefault('LSEnvironment', {})['TUNEBRIDGE_PROJECT_DIR'] = project_dir
with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f)
print(f"  Embedded PROJECT_DIR: {project_dir}")
PYEOF

# ── Move to /Applications ─────────────────────────────────────────────────────
cp -r "$BUILT_APP" "$APP_PATH"

# ── Clear quarantine so Gatekeeper doesn't block first launch ─────────────────
xattr -cr "$APP_PATH" 2>/dev/null || true

# ── Clean up build artefacts ─────────────────────────────────────────────────
rm -rf /tmp/tunebridge_dist /tmp/tunebridge_build

echo ""
echo "  ✓ ${APP_NAME}.app installed to /Applications"
echo ""
echo "  FIRST LAUNCH: macOS will ask for access to ~/Documents."
echo "  Click 'Allow' — this is needed to reach your music library."
echo "  (This prompt only appears once.)"
echo ""
echo "  How it works:"
echo "    • Native WKWebView window — no Safari"
echo "    • Cmd+Tab shows 'TuneBridge'"
echo "    • Closing the window stops the server"
echo ""
echo "  To run from Terminal instead:"
echo "    cd \"${PROJECT_DIR}\" && source venv/bin/activate && python tunebridge_gui.py"
echo ""
