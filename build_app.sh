#!/bin/bash
# build_app.sh — Build a self-contained TuneBridge.app (and optionally a DMG).
#
# Usage:
#   bash build_app.sh          # builds dist/TuneBridge.app
#   bash build_app.sh --dmg    # also creates dist/TuneBridge.dmg
#
# Distribution target:
#   - Apple Silicon macOS only (arm64)
#   - No Python required on end-user machines
#   - User can drag TuneBridge.app to /Applications and run

set -euo pipefail

APP_VERSION="1.0"
APP_NAME="TuneBridge"
BUNDLE_ID="com.tunebridge.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${PROJECT_DIR}/dist"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
BUILD_VENV="${PROJECT_DIR}/.build-venv"

BUILD_DMG=0
for arg in "$@"; do
  [ "$arg" = "--dmg" ] && BUILD_DMG=1
done

echo "=== TuneBridge build_app.sh v${APP_VERSION} ==="
echo "    Project : ${PROJECT_DIR}"
echo "    Output  : ${APP_PATH}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: build_app.sh supports macOS only."
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "ERROR: Apple Silicon build only (arm64)."
  echo "  Current architecture: $(uname -m)"
  exit 1
fi

# ── Select build Python (3.10+) ─────────────────────────────────────────────
BUILD_PYTHON=""
for candidate in \
  "/opt/homebrew/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3"; do
  if [ -x "$candidate" ]; then
    _maj=$($candidate -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo 0)
    _min=$($candidate -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
    if [ "${_maj}" = "3" ] && [ "${_min}" -ge 10 ] 2>/dev/null; then
      BUILD_PYTHON="$candidate"
      break
    fi
  fi
done

if [ -z "$BUILD_PYTHON" ]; then
  echo "ERROR: Python 3.10+ not found. Install Python for macOS and retry."
  exit 1
fi

echo "    Python  : $BUILD_PYTHON"

# ── Prepare clean build venv ────────────────────────────────────────────────
if [ -d "$BUILD_VENV" ]; then
  echo "  Removing stale build venv..."
  rm -rf "$BUILD_VENV"
fi

"$BUILD_PYTHON" -m venv "$BUILD_VENV"
source "$BUILD_VENV/bin/activate"

python -m pip install --upgrade pip wheel setuptools --quiet
python -m pip install -r "${PROJECT_DIR}/requirements.txt" --quiet
python -m pip install pyinstaller --quiet

# ── Clean prior outputs ─────────────────────────────────────────────────────
rm -rf "${PROJECT_DIR}/build" "${PROJECT_DIR}/dist/${APP_NAME}.app" "${PROJECT_DIR}/dist/${APP_NAME}.dmg" "${PROJECT_DIR}/dist/${APP_NAME}_tmp.dmg"
mkdir -p "$DIST_DIR"

ICON_PATH="${PROJECT_DIR}/static/TuneBridge.icns"
PYI_ARGS=(
  --noconfirm
  --windowed
  --name "$APP_NAME"
  --target-arch arm64
  --osx-bundle-identifier "$BUNDLE_ID"
  --hidden-import webview.platforms.cocoa
  --hidden-import objc
  --hidden-import AppKit
  --hidden-import Foundation
  --hidden-import WebKit
  --hidden-import Quartz
  --collect-submodules webview
  --collect-submodules sklearn
  --collect-submodules soundfile
  --add-data "${PROJECT_DIR}/static:static"
)

if [ -f "$ICON_PATH" ]; then
  PYI_ARGS+=(--icon "$ICON_PATH")
fi

if [ -d "${PROJECT_DIR}/data/features" ]; then
  PYI_ARGS+=(--add-data "${PROJECT_DIR}/data/features:data/features")
  echo "  Bundling data/features/ for first-run migration"
fi

echo "  Building self-contained app bundle with PyInstaller..."
python -m PyInstaller "${PYI_ARGS[@]}" "${PROJECT_DIR}/tunebridge_gui.py"

if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: Expected app bundle not found at $APP_PATH"
  exit 1
fi

# ── Patch Info.plist with app metadata/permissions ──────────────────────────
PLIST_PATH="${APP_PATH}/Contents/Info.plist"
python - "$PLIST_PATH" "$APP_VERSION" <<'PYEOF'
import plistlib, sys
plist_path = sys.argv[1]
version = sys.argv[2]

with open(plist_path, 'rb') as f:
    p = plistlib.load(f)

p['CFBundleName'] = 'TuneBridge'
p['CFBundleDisplayName'] = 'TuneBridge'
p['CFBundleIdentifier'] = 'com.tunebridge.app'
p['CFBundleVersion'] = version
p['CFBundleShortVersionString'] = version
p['LSMinimumSystemVersion'] = '12.0'
p['NSHighResolutionCapable'] = True
p['NSAppTransportSecurity'] = {'NSAllowsLocalNetworking': True}
p['NSDocumentsFolderUsageDescription'] = (
    'TuneBridge needs access to your Documents folder to reach your music library and playlists.'
)
p['NSMusicFolderUsageDescription'] = (
    'TuneBridge needs access to your Music folder for your music library.'
)

with open(plist_path, 'wb') as f:
    plistlib.dump(p, f)
print('  Info.plist updated')
PYEOF

# ── Ad-hoc signing + quarantine clear ───────────────────────────────────────
echo "  Signing bundle (ad-hoc)..."
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null && \
  echo "  Ad-hoc signed" || \
  echo "  WARNING: codesign failed — app may need manual signing"

xattr -cr "$APP_PATH" 2>/dev/null || true

BUNDLE_SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
echo ""
echo "  Bundle size: ${BUNDLE_SIZE}"
echo "  Location   : ${APP_PATH}"

# ── Optional DMG creation (drag-and-drop install UX) ───────────────────────
if [ "$BUILD_DMG" = "1" ]; then
  echo ""
  echo "  Creating DMG..."
  DMG_PATH="${DIST_DIR}/${APP_NAME}.dmg"
  TMP_DMG="${DIST_DIR}/${APP_NAME}_tmp.dmg"

  [ -f "$DMG_PATH" ] && rm -f "$DMG_PATH"
  [ -f "$TMP_DMG" ] && rm -f "$TMP_DMG"

  hdiutil create -size 500m -fs HFS+ -volname "$APP_NAME" "$TMP_DMG" -quiet

  ATTACH_PLIST="$(hdiutil attach "$TMP_DMG" -noautoopen -nobrowse -plist 2>/dev/null)"
  MOUNT_POINT="$(echo "$ATTACH_PLIST" | python -c '
import sys, plistlib
p = plistlib.loads(sys.stdin.buffer.read())
mp = next((e["mount-point"] for e in p.get("system-entities", []) if "mount-point" in e), "")
print(mp)
')"

  if [ -z "$MOUNT_POINT" ]; then
    echo "  ERROR: Could not determine DMG mount point."
    rm -f "$TMP_DMG"
    exit 1
  fi

  cp -R "$APP_PATH" "$MOUNT_POINT/"
  ln -s /Applications "$MOUNT_POINT/Applications"

  hdiutil detach "$MOUNT_POINT" -quiet
  hdiutil convert "$TMP_DMG" -format UDZO -o "$DMG_PATH" -quiet
  rm -f "$TMP_DMG"

  DMG_SIZE="$(du -sh "$DMG_PATH" | awk '{print $1}')"
  echo "  DMG size   : ${DMG_SIZE}"
  echo "  DMG path   : ${DMG_PATH}"
fi

deactivate || true

echo ""
echo "=== Build complete ==="
echo ""
echo "  Install (distribution):"
echo "    1) Open TuneBridge.dmg"
echo "    2) Drag TuneBridge.app to Applications"
echo "    3) Launch TuneBridge"
echo ""
echo "  First launch:"
echo "    - App bootstrap runs automatically"
echo "    - User data is created at: ~/Library/Application Support/TuneBridge"
echo ""
