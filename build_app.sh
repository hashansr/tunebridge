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
DISTRO_DIR="${PROJECT_DIR}/distro"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
BUILD_VENV="${PROJECT_DIR}/.build-venv"

BUILD_DMG=0
for arg in "$@"; do
  [ "$arg" = "--dmg" ] && BUILD_DMG=1
done

hr()        { printf '%s\n' "------------------------------------------------------------"; }
phase()     { printf '\n[PHASE] %s\n' "$1"; }
step()      { printf '[STEP ] %s\n' "$1"; }
ok()        { printf '[OK   ] %s\n' "$1"; }
warn()      { printf '[WARN ] %s\n' "$1"; }
err()       { printf '[ERROR] %s\n' "$1"; }
kv()        { printf '        %-10s %s\n' "$1" "$2"; }

printf '=== TuneBridge build_app.sh v%s ===\n' "${APP_VERSION}"
kv "Project:" "${PROJECT_DIR}"
kv "Output:" "${APP_PATH}"
kv "Distro dir:" "${DISTRO_DIR}"
kv "Mode:" "$( [ "$BUILD_DMG" = "1" ] && echo "App + DMG" || echo "App only" )"
hr

if [ "$(uname -s)" != "Darwin" ]; then
  err "build_app.sh supports macOS only."
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  err "Apple Silicon build only (arm64)."
  kv "Current arch:" "$(uname -m)"
  exit 1
fi

# ── Select build Python (3.10+) ─────────────────────────────────────────────
phase "Environment checks"
BUILD_PYTHON=""
FOUND_PYTHONS=""
for candidate in \
  "$(command -v python3 2>/dev/null || true)" \
  "$(command -v python3.13 2>/dev/null || true)" \
  "$(command -v python3.12 2>/dev/null || true)" \
  "$(command -v python3.11 2>/dev/null || true)" \
  "$(command -v python3.10 2>/dev/null || true)" \
  "/opt/homebrew/bin/python3" \
  "/opt/homebrew/bin/python3.13" \
  "/opt/homebrew/bin/python3.12" \
  "/opt/homebrew/bin/python3.11" \
  "/opt/homebrew/bin/python3.10" \
  "/usr/local/bin/python3" \
  "/usr/local/bin/python3.13" \
  "/usr/local/bin/python3.12" \
  "/usr/local/bin/python3.11" \
  "/usr/local/bin/python3.10" \
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3"; do
  [ -n "$candidate" ] || continue
  [ -x "$candidate" ] || continue
  _maj=$($candidate -c 'import sys; print(sys.version_info.major)' 2>/dev/null || echo 0)
  _min=$($candidate -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
  if [ "${_maj}" = "3" ]; then
    FOUND_PYTHONS="${FOUND_PYTHONS}\n  - ${candidate} (${_maj}.${_min})"
  fi
  if [ "${_maj}" = "3" ] && [ "${_min}" -ge 10 ] 2>/dev/null; then
    BUILD_PYTHON="$candidate"
    break
  fi
done

if [ -z "$BUILD_PYTHON" ]; then
  err "Python 3.10+ not found."
  printf '        Detected interpreters:%s\n' "${FOUND_PYTHONS:- none}"
  printf '        Install one of:\n'
  printf '          brew install python@3.12\n'
  printf '          or download from https://www.python.org/downloads/macos/\n'
  printf '        Then rerun: bash build_app.sh --dmg\n'
  exit 1
fi

kv "Python:" "$BUILD_PYTHON"
ok "Host checks passed"

# ── Prepare clean build venv ────────────────────────────────────────────────
phase "Build environment"
if [ -d "$BUILD_VENV" ]; then
  step "Removing stale build venv"
  rm -rf "$BUILD_VENV"
fi

step "Creating isolated build virtualenv"
"$BUILD_PYTHON" -m venv "$BUILD_VENV"
source "$BUILD_VENV/bin/activate"

step "Installing build dependencies"
python -m pip install --upgrade pip wheel setuptools --quiet
python -m pip install -r "${PROJECT_DIR}/requirements.txt" --quiet
python -m pip install pyinstaller --quiet
ok "Build environment ready"

# ── Clean prior outputs ─────────────────────────────────────────────────────
phase "Bundle assembly"
step "Cleaning previous outputs"
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
  step "Bundling data/features/ for first-run migration"
fi

step "Running PyInstaller (this can take a few minutes)"
python -m PyInstaller "${PYI_ARGS[@]}" "${PROJECT_DIR}/tunebridge_gui.py"

if [ ! -d "$APP_PATH" ]; then
  err "Expected app bundle not found at $APP_PATH"
  exit 1
fi
ok "App bundle created"

# ── Patch Info.plist with app metadata/permissions ──────────────────────────
step "Patching Info.plist metadata"
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
print('[OK   ] Info.plist updated')
PYEOF

# ── Ad-hoc signing + quarantine clear ───────────────────────────────────────
step "Signing bundle (ad-hoc)"
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null && \
  ok "Ad-hoc signed" || \
  warn "codesign failed - app may need manual signing"

xattr -cr "$APP_PATH" 2>/dev/null || true
step "Clearing quarantine xattrs"

BUNDLE_SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
ok "Bundle ready"
kv "Bundle size:" "${BUNDLE_SIZE}"
kv "App path:" "${APP_PATH}"

# ── Optional DMG creation (drag-and-drop install UX) ───────────────────────
if [ "$BUILD_DMG" = "1" ]; then
  phase "DMG packaging"
  step "Creating temporary DMG"
  DMG_PATH="${DIST_DIR}/${APP_NAME}.dmg"
  TMP_DMG="${DIST_DIR}/${APP_NAME}_tmp.dmg"
  mkdir -p "$DISTRO_DIR"

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
    err "Could not determine DMG mount point."
    rm -f "$TMP_DMG"
    exit 1
  fi

  step "Staging app + Applications link"
  cp -R "$APP_PATH" "$MOUNT_POINT/"
  ln -s /Applications "$MOUNT_POINT/Applications"

  step "Finalizing compressed DMG"
  hdiutil detach "$MOUNT_POINT" -quiet
  hdiutil convert "$TMP_DMG" -format UDZO -o "$DMG_PATH" -quiet
  rm -f "$TMP_DMG"

  DMG_SIZE="$(du -sh "$DMG_PATH" | awk '{print $1}')"
  ok "DMG ready"
  kv "DMG size:" "${DMG_SIZE}"
  kv "DMG path:" "${DMG_PATH}"

  step "Publishing DMG to distro/ folder"
  BUILD_STAMP="$(date +%Y%m%d-%H%M%S)"
  DISTRO_LATEST="${DISTRO_DIR}/${APP_NAME}-latest.dmg"
  DISTRO_VERSIONED="${DISTRO_DIR}/${APP_NAME}-v${APP_VERSION}-${BUILD_STAMP}.dmg"
  cp -f "$DMG_PATH" "$DISTRO_LATEST"
  cp -f "$DMG_PATH" "$DISTRO_VERSIONED"
  ok "DMG published for distribution"
  kv "Latest DMG:" "${DISTRO_LATEST}"
  kv "Archive DMG:" "${DISTRO_VERSIONED}"
fi

deactivate || true

hr
printf '=== Build complete ===\n'
if [ "$BUILD_DMG" = "1" ]; then
  printf '\nInstall (distribution):\n'
  printf '  1) Share from distro/: %s-latest.dmg\n' "${APP_NAME}"
  printf '  2) Open TuneBridge.dmg\n'
  printf '  3) Drag TuneBridge.app to Applications\n'
  printf '  4) Launch TuneBridge\n'
  printf '\nDistribution artifacts:\n'
  printf '  - dist/TuneBridge.dmg (build output)\n'
  printf '  - distro/TuneBridge-latest.dmg (stable latest)\n'
  printf '  - distro/TuneBridge-v%s-<timestamp>.dmg (archived)\n' "${APP_VERSION}"
else
  printf '\nInstall (local app):\n'
  printf '  1) Open dist/TuneBridge.app\n'
  printf '  2) Drag to Applications (optional)\n'
  printf '  3) Launch TuneBridge\n'
fi
printf '\nFirst launch:\n'
printf '  - App bootstrap runs automatically\n'
printf '  - User data is created at: ~/Library/Application Support/TuneBridge\n\n'
