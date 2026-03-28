#!/bin/bash
# build_app.sh — Build a distributable TuneBridge.app (and optionally a DMG).
#
# Usage:
#   bash build_app.sh          # builds dist/TuneBridge.app
#   bash build_app.sh --dmg    # also creates dist/TuneBridge.dmg
#
# The resulting .app bundles all Python dependencies inside the bundle itself
# (in Contents/Resources/Packages/) so no venv or system packages are needed
# on the target machine — just a compatible Python interpreter.

set -e

APP_VERSION="1.0"
APP_NAME="TuneBridge"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${PROJECT_DIR}/dist"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
BUILD_DIR="${PROJECT_DIR}"   # launcher.c lives at the project root

# Parse --dmg flag
BUILD_DMG=0
for arg in "$@"; do
    [ "$arg" = "--dmg" ] && BUILD_DMG=1
done

echo "=== TuneBridge build_app.sh v${APP_VERSION} ==="
echo "    Project : ${PROJECT_DIR}"
echo "    Output  : ${APP_PATH}"

# ── Find a suitable build Python ─────────────────────────────────────────────
BUILD_PYTHON=""
# python.org installers are preferred (clean, modern, no yanked packages).
# CLT Python 3.9 is intentionally excluded — pyobjc 10+ dropped 3.9 support.
# Homebrew versioned paths (e.g. python@3.12) are checked before the generic
# python3 symlink, whose version is unpredictable.
for candidate in \
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3" \
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3" \
    "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3" \
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.13/bin/python3" \
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.12/bin/python3" \
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.11/bin/python3" \
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.10/bin/python3" \
    "/opt/homebrew/opt/python@3.13/bin/python3.13" \
    "/opt/homebrew/opt/python@3.12/bin/python3.12" \
    "/opt/homebrew/opt/python@3.11/bin/python3.11" \
    "/opt/homebrew/opt/python@3.10/bin/python3.10" \
    "/usr/local/opt/python@3.13/bin/python3.13" \
    "/usr/local/opt/python@3.12/bin/python3.12" \
    "/usr/local/opt/python@3.11/bin/python3.11" \
    "/usr/local/opt/python@3.10/bin/python3.10" \
    "/opt/homebrew/bin/python3" \
    "/usr/local/bin/python3"; do
    if [ -x "$candidate" ]; then
        # Verify it's actually 3.10+ before accepting it
        _ver=$("$candidate" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null)
        _maj=$("$candidate" -c 'import sys; print(sys.version_info.major)' 2>/dev/null)
        if [ "$_maj" = "3" ] && [ "${_ver:-0}" -ge 10 ] 2>/dev/null; then
            BUILD_PYTHON="$candidate"
            break
        fi
    fi
done

if [ -z "$BUILD_PYTHON" ]; then
    echo ""
    echo "ERROR: Python 3.10+ not found."
    echo "  Install it from https://python.org/downloads/macos/ and re-run."
    echo "  (CLT Python 3.9 is not supported — pyobjc requires 3.10+)"
    exit 1
fi

PYVER="$("$BUILD_PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "    Python  : ${BUILD_PYTHON} (${PYVER})"

# ── Set up output directory ───────────────────────────────────────────────────
[ -d "$APP_PATH" ] && { echo "  Removing existing ${APP_PATH}..."; rm -rf "$APP_PATH"; }
mkdir -p "$DIST_DIR"

CONTENTS="${APP_PATH}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"
PACKAGES_DIR="${RESOURCES}/Packages"
LAUNCHER_BIN="${MACOS}/${APP_NAME}"

mkdir -p "$MACOS" "$RESOURCES" "$PACKAGES_DIR"

# ── Create empty data subdirectories ─────────────────────────────────────────
# These are placeholders; actual user data lives in ~/Library/Application Support/TuneBridge/
mkdir -p "${RESOURCES}/data/artwork"
mkdir -p "${RESOURCES}/data/playlist_artwork"

# ── Copy application source files ────────────────────────────────────────────
echo "  Copying app source..."
cp "${PROJECT_DIR}/app.py"            "${RESOURCES}/app.py"
cp "${PROJECT_DIR}/tunebridge_gui.py" "${RESOURCES}/tunebridge_gui.py"
cp -R "${PROJECT_DIR}/static"         "${RESOURCES}/static"

# ── Install Python dependencies into Packages/ ───────────────────────────────
echo "  Installing Python packages into bundle (this may take a minute)..."
"$BUILD_PYTHON" -m pip install \
    flask \
    mutagen \
    pillow \
    waitress \
    pywebview \
    --target "$PACKAGES_DIR" \
    --quiet \
    --disable-pip-version-check

# ── Write .python-version so the launcher knows which Python to prefer ────────
echo "$PYVER" > "${RESOURCES}/.python-version"
echo "  Wrote .python-version: ${PYVER}"

# ── Copy icon (if it exists) ─────────────────────────────────────────────────
ICON_SRC="${PROJECT_DIR}/static/TuneBridge.icns"
HAS_ICON=0
if [ -f "$ICON_SRC" ]; then
    cp "$ICON_SRC" "${RESOURCES}/TuneBridge.icns"
    HAS_ICON=1
    echo "  Copied TuneBridge.icns"
fi

# ── Compile C launcher ───────────────────────────────────────────────────────
# mach-o/dyld.h is part of the default SDK — no extra frameworks needed.
echo "  Compiling launcher binary..."
clang -O2 -o "$LAUNCHER_BIN" "${BUILD_DIR}/launcher.c"
chmod +x "$LAUNCHER_BIN"
echo "  Compiled ${LAUNCHER_BIN}"

# ── Write Info.plist via Python's plistlib ───────────────────────────────────
echo "  Writing Info.plist..."
"$BUILD_PYTHON" - "$CONTENTS/Info.plist" "$APP_VERSION" "$HAS_ICON" <<'PYEOF'
import plistlib, sys

plist_path  = sys.argv[1]
version     = sys.argv[2]
has_icon    = sys.argv[3] == "1"

plist = {
    'CFBundleName':               'TuneBridge',
    'CFBundleDisplayName':        'TuneBridge',
    'CFBundleIdentifier':         'com.tunebridge.app',
    'CFBundleVersion':            version,
    'CFBundleShortVersionString': version,
    'CFBundleExecutable':         'TuneBridge',
    'CFBundlePackageType':        'APPL',
    'NSHighResolutionCapable':    True,
    'LSMinimumSystemVersion':     '12.0',
    'NSAppTransportSecurity':     {'NSAllowsLocalNetworking': True},
    'NSDocumentsFolderUsageDescription':
        'TuneBridge needs access to your Documents folder to reach your music library and playlists.',
    'NSMusicFolderUsageDescription':
        'TuneBridge needs access to your Music folder for your music library.',
}
if has_icon:
    plist['CFBundleIconFile'] = 'TuneBridge'

with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f)
print(f"  Wrote Info.plist")
PYEOF

# ── Ad-hoc sign ──────────────────────────────────────────────────────────────
echo "  Signing bundle (ad-hoc)..."
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null && \
    echo "  Ad-hoc signed" || \
    echo "  WARNING: codesign failed — app may need manual signing"

# ── Clear quarantine ──────────────────────────────────────────────────────────
xattr -cr "$APP_PATH" 2>/dev/null || true

# ── Bundle size ───────────────────────────────────────────────────────────────
BUNDLE_SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
echo ""
echo "  Bundle size: ${BUNDLE_SIZE}"
echo "  Location   : ${APP_PATH}"

# ── Optional DMG creation ─────────────────────────────────────────────────────
if [ "$BUILD_DMG" = "1" ]; then
    echo ""
    echo "  Creating DMG..."
    DMG_PATH="${DIST_DIR}/TuneBridge.dmg"
    TMP_DMG="${DIST_DIR}/TuneBridge_tmp.dmg"

    [ -f "$DMG_PATH" ] && rm -f "$DMG_PATH"
    [ -f "$TMP_DMG"  ] && rm -f "$TMP_DMG"

    # 1. Create a temp writable HFS+ image (400 MB is ample for deps)
    hdiutil create -size 400m -fs HFS+ -volname "TuneBridge" "$TMP_DMG" -quiet

    # 2. Mount the temp image.
    #    Use -plist output so we can parse the mount point reliably with Python
    #    (hdiutil's plain-text output format varies across macOS versions and
    #     the tab-delimited columns confuse simple awk/cut approaches).
    ATTACH_PLIST="$(hdiutil attach "$TMP_DMG" -noautoopen -nobrowse -plist 2>/dev/null)"
    MOUNT_POINT="$(echo "$ATTACH_PLIST" | "$BUILD_PYTHON" -c "
import sys, plistlib
data = plistlib.loads(sys.stdin.buffer.read())
mp = next(
    (e['mount-point'] for e in data.get('system-entities', []) if 'mount-point' in e),
    ''
)
print(mp)
")"

    if [ -z "$MOUNT_POINT" ]; then
        echo "  ERROR: Could not determine DMG mount point. Skipping DMG."
        rm -f "$TMP_DMG"
    else
        echo "  Mounted at: ${MOUNT_POINT}"

        # 3. Copy the .app into the mounted volume
        cp -R "$APP_PATH" "${MOUNT_POINT}/"

        # 4. Add an Applications symlink for drag-to-install UX
        ln -s /Applications "${MOUNT_POINT}/Applications"

        # 5. Unmount
        hdiutil detach "$MOUNT_POINT" -quiet

        # 6. Convert to compressed read-only UDZO image
        hdiutil convert "$TMP_DMG" -format UDZO -o "$DMG_PATH" -quiet

        # 7. Remove temp image
        rm -f "$TMP_DMG"

        DMG_SIZE="$(du -sh "$DMG_PATH" | awk '{print $1}')"
        echo "  DMG size   : ${DMG_SIZE}"
        echo "  DMG path   : ${DMG_PATH}"
    fi
fi

# ── Final instructions ────────────────────────────────────────────────────────
echo ""
echo "=== Build complete ==="
echo ""
echo "  To launch:"
echo "    open \"${APP_PATH}\""
echo ""
echo "  First-launch notes:"
echo "    - Gatekeeper: right-click the app and choose Open, then click Open"
echo "    - TCC (Documents/Music access): click Allow when macOS asks"
echo "    - These prompts only appear once"
echo ""
