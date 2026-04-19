#!/bin/bash
# 🎵 TuneBridge — Build Distributable App + DMG
#
# Run with no flags (or just --dmg) for an interactive menu.
# Or pass a channel flag directly to skip the menu:
#   bash build_app.sh --dev           # dev build, app only
#   bash build_app.sh --dmg --dev     # dev build + DMG
#   bash build_app.sh --dmg --test    # RC build + DMG
#   bash build_app.sh --dmg --prod    # full prod release

set -euo pipefail

APP_NAME="TuneBridge"
BUNDLE_ID="com.tunebridge.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${PROJECT_DIR}/dist"
DISTRO_DIR="${PROJECT_DIR}/distro"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
BUILD_VENV="${PROJECT_DIR}/.build-venv"

# ── Flag parsing ──────────────────────────────────────────────────────────────
BUILD_DMG=0
BUILD_CHANNEL=""   # empty = not yet chosen; triggers interactive menu

for arg in "$@"; do
  [ "$arg" = "--dmg" ]  && BUILD_DMG=1
  [ "$arg" = "--dev" ]  && BUILD_CHANNEL="dev"
  [ "$arg" = "--test" ] && BUILD_CHANNEL="rc"   && BUILD_DMG=1
  [ "$arg" = "--prod" ] && BUILD_CHANNEL="prod" && BUILD_DMG=1
done

# ── Interactive menu (shown when no channel flag was given) ───────────────────
if [ -z "$BUILD_CHANNEL" ]; then
  _CUR_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  _CUR_VER=$(python3 -c "import json; d=json.load(open('${PROJECT_DIR}/version.json')); print('v'+d['version'])" 2>/dev/null || echo "")

  echo ""
  echo -e "\033[1m🏗️   TuneBridge Build\033[0m  \033[2m(current: ${_CUR_BRANCH}${_CUR_VER:+  ·  ${_CUR_VER}})\033[0m"
  echo -e "\033[2m────────────────────────────────────────────\033[0m"
  echo ""
  echo "  1)  Dev      — app only        (current branch, no DMG)"
  echo "  2)  Dev      — app + DMG       (current branch)"
  echo "  3)  Test     — app + DMG       (RC build: merges to main, no publish)"
  echo "  4)  Prod     — app + DMG       (full release: merges, tags, pushes, publishes)"
  echo "  5)  Exit"
  echo ""
  printf "  Choice [1–5]: "
  read -r _CHOICE </dev/tty

  case "$_CHOICE" in
    1) BUILD_CHANNEL="dev";  BUILD_DMG=0 ;;
    2) BUILD_CHANNEL="dev";  BUILD_DMG=1 ;;
    3) BUILD_CHANNEL="rc";   BUILD_DMG=1 ;;
    4) BUILD_CHANNEL="prod"; BUILD_DMG=1 ;;
    5) echo ""; echo "  Cancelled."; echo ""; exit 0 ;;
    *) echo ""; echo "  ❌  Invalid choice '${_CHOICE}'. Exiting."; echo ""; exit 1 ;;
  esac

  # If user passed --dmg explicitly but chose option 1, honour it
  for arg in "$@"; do [ "$arg" = "--dmg" ] && BUILD_DMG=1; done

  # Prompt for release notes when building a DMG (these go into CHANGELOG.md)
  RELEASE_NOTES=""
  if [ "$BUILD_DMG" = "1" ]; then
    echo ""
    echo -e "\033[2m  What's new in this build? (one line, Enter to skip)\033[0m"
    printf "  Notes: "
    read -r RELEASE_NOTES </dev/tty
  fi

  echo ""
fi

# ── Git workflow helpers ──────────────────────────────────────────────────────
_ORIGINAL_BRANCH=""
_DID_STASH=0

_git_prepare() {
  _ORIGINAL_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  [ -z "$_ORIGINAL_BRANCH" ] && { echo "❌  Not a git repository."; exit 1; }

  # Stash any dirty state (tracked modifications + untracked files)
  local stash_out
  stash_out=$(git -C "$PROJECT_DIR" stash push --include-untracked \
    -m "build-auto-stash-$(date +%s)" 2>&1) || true
  echo "$stash_out" | grep -q "Saved working directory" && _DID_STASH=1

  # Switch to main and bring in the current branch
  git -C "$PROJECT_DIR" checkout main
  git -C "$PROJECT_DIR" merge "$_ORIGINAL_BRANCH" --no-edit
}

_git_restore() {
  # Always switch back to the original branch (called from trap too)
  if [ -n "$_ORIGINAL_BRANCH" ] && [ "$_ORIGINAL_BRANCH" != "main" ]; then
    git -C "$PROJECT_DIR" merge --abort 2>/dev/null || true
    git -C "$PROJECT_DIR" checkout "$_ORIGINAL_BRANCH" 2>/dev/null || true
    if [ "$_DID_STASH" = "1" ]; then
      git -C "$PROJECT_DIR" stash pop 2>/dev/null || {
        # Resolve any conflicts by keeping the stashed (working) versions
        git -C "$PROJECT_DIR" diff --name-only --diff-filter=U 2>/dev/null \
          | while IFS= read -r f; do
              git -C "$PROJECT_DIR" checkout --theirs -- "$f" 2>/dev/null || true
            done
        git -C "$PROJECT_DIR" reset HEAD -- 2>/dev/null || true
      }
      _DID_STASH=0
    fi
    # Sync version.json back so next build increments from the correct number
    git -C "$PROJECT_DIR" show main:version.json > "${PROJECT_DIR}/version.json" 2>/dev/null || true
  fi
  _ORIGINAL_BRANCH=""
}

# Kick off git workflow now for --test / --prod (before version increment)
if [[ "$BUILD_CHANNEL" == "rc" || "$BUILD_CHANNEL" == "prod" ]]; then
  _git_prepare
fi

# ── Version auto-increment ────────────────────────────────────────────────────
GIT_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
GIT_HASH=$(git -C "$PROJECT_DIR"   rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")

BUILD_NUM=$(python3 -c "import json; print(json.load(open('${PROJECT_DIR}/version.json'))['build']+1)")
APP_VERSION="0.${BUILD_NUM}"

case "$BUILD_CHANNEL" in
  prod) VERSION_FULL="${APP_VERSION}" ;;
  rc)   VERSION_FULL="${APP_VERSION}-rc" ;;
  *)    VERSION_FULL="${APP_VERSION}-dev+${GIT_HASH}" ;;
esac

python3 -c "
import json
with open('${PROJECT_DIR}/version.json', 'w') as f:
    json.dump({
        'version': '${APP_VERSION}',
        'version_full': '${VERSION_FULL}',
        'build': ${BUILD_NUM},
        'channel': '${BUILD_CHANNEL}',
        'released': '$(date +%Y-%m-%d)'
    }, f, indent=2)
    f.write('\n')
"

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Spinner ───────────────────────────────────────────────────────────────────
_SP=""
_spin_start() {
  [ -n "$_SP" ] && _spin_stop
  local m="$1"
  (while :; do
    for c in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do printf "\r  %s  %s " "$c" "$m"; sleep 0.08; done
  done) &
  _SP=$!; disown 2>/dev/null || true
}
_spin_stop() {
  [ -n "$_SP" ] && { kill "$_SP" 2>/dev/null; wait "$_SP" 2>/dev/null || true; _SP=""; printf "\r\033[K"; }
}
_cleanup() { _spin_stop; _git_restore; }
trap '_cleanup' EXIT INT TERM

# ── Helpers ───────────────────────────────────────────────────────────────────
_phase() { echo ""; echo -e "${BOLD}${CYAN}$1${NC}"; echo -e "${DIM}────────────────────────────────────────${NC}"; echo ""; }
_ok()    { echo -e "  ✅  $1"; }
_warn()  { echo -e "  ⚠️   ${YELLOW}$1${NC}"; }
_err()   { echo -e "  ❌  ${RED}$1${NC}"; }
_info()  { echo -e "  ${DIM}$1${NC}"; }
_kv()    { printf "  %-16s %s\n" "$1" "$2"; }

_elapsed() {
  local t=$(( $(date +%s) - $1 ))
  if [ "$t" -ge 60 ]; then printf "%dm %ds" $((t/60)) $((t%60))
  else printf "%ds" "$t"; fi
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}🏗️   TuneBridge — Build Distributable v${VERSION_FULL}${NC}"
echo -e "${DIM}════════════════════════════════════════════${NC}"
echo ""
_kv "📁 Project:" "${PROJECT_DIR}"
_kv "📤 Output:"  "${APP_PATH}"
_kv "🏷️  Version:" "${VERSION_FULL}  (channel: ${BUILD_CHANNEL})"
_kv "🔀 Branch:"  "${GIT_BRANCH}  ${GIT_HASH}"
_kv "⚙️  Mode:"    "$( [ "$BUILD_DMG" = "1" ] && echo "App + DMG" || echo "App only" )"

if [ "$(uname -s)" != "Darwin" ]; then
  _err "This script supports macOS only."
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  _err "Apple Silicon (arm64) required."
  _info "Current arch: $(uname -m)"
  exit 1
fi

# ── Find Python 3.10+ ─────────────────────────────────────────────────────────
_phase "🔍 Environment"

printf "  🔍  Finding Python 3.10+... "
BUILD_PYTHON=""
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
  if [ "${_maj}" = "3" ] && [ "${_min}" -ge 10 ] 2>/dev/null; then
    BUILD_PYTHON="$candidate"
    echo -e "${GREEN}Python ${_maj}.${_min} ✅${NC}"
    _info "${candidate}"
    break
  fi
done

if [ -z "$BUILD_PYTHON" ]; then
  echo -e "${RED}not found ❌${NC}"
  echo ""
  _err "Python 3.10+ is required."
  echo "  Install:  ${BOLD}brew install python@3.12${NC}"
  echo "  Or from:  https://www.python.org/downloads/macos/"
  exit 1
fi

# ── Build venv + dependencies ─────────────────────────────────────────────────
_phase "📦 Build Environment"

T0=$(date +%s)
_spin_start "Creating isolated build environment..."
[ -d "$BUILD_VENV" ] && rm -rf "$BUILD_VENV"
"$BUILD_PYTHON" -m venv "$BUILD_VENV" 2>/dev/null
source "$BUILD_VENV/bin/activate"
_spin_stop
_ok "Build venv created"

_spin_start "Installing build dependencies (pip, wheel, requirements, pyinstaller)..."
pip install --upgrade pip wheel setuptools --quiet 2>/dev/null
pip install -r "${PROJECT_DIR}/requirements.txt" --quiet 2>/dev/null
pip install pyinstaller --quiet 2>/dev/null
_spin_stop
DEP_ELAPSED=$(_elapsed "$T0")
_ok "Dependencies installed  (${DEP_ELAPSED})"

# ── Clean + prepare ───────────────────────────────────────────────────────────
_phase "🏗️  Bundle Assembly"

printf "  🗑️   Cleaning previous outputs... "
rm -rf "${PROJECT_DIR}/build" \
       "${PROJECT_DIR}/dist/${APP_NAME}.app" \
       "${PROJECT_DIR}/dist/${APP_NAME}.dmg" \
       "${PROJECT_DIR}/dist/${APP_NAME}_tmp.dmg"
mkdir -p "$DIST_DIR"
echo -e "${GREEN}done ✅${NC}"

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
  --collect-submodules mpv
  --add-data "${PROJECT_DIR}/static:static"
  --add-data "${PROJECT_DIR}/version.json:."
)
[ -f "$ICON_PATH" ] && PYI_ARGS+=(--icon "$ICON_PATH")
if [ -d "${PROJECT_DIR}/data/features" ]; then
  PYI_ARGS+=(--add-data "${PROJECT_DIR}/data/features:data/features")
  _info "Bundling data/features/ for first-run migration"
fi

# ── Run PyInstaller ───────────────────────────────────────────────────────────
PYI_LOG=$(mktemp)
PYI_T0=$(date +%s)
_spin_start "Running PyInstaller — this takes a few minutes, grab a coffee ☕"
set +e
python -m PyInstaller "${PYI_ARGS[@]}" "${PROJECT_DIR}/tunebridge_gui.py" > "$PYI_LOG" 2>&1
PYI_EXIT=$?
set -e
_spin_stop
PYI_ELAPSED=$(_elapsed "$PYI_T0")

if [ "$PYI_EXIT" -ne 0 ]; then
  _err "PyInstaller failed after ${PYI_ELAPSED}"
  echo ""
  echo -e "  ${BOLD}Last 30 lines of output:${NC}"
  echo -e "  ${DIM}────────────────────────────────${NC}"
  tail -30 "$PYI_LOG" | sed 's/^/  /'
  rm -f "$PYI_LOG"
  exit 1
fi

# ── Analyse PyInstaller warnings ──────────────────────────────────────────────
# Warnings come from cross-platform modules that don't apply to macOS arm64.
# We categorise them so you only see ones worth investigating.
ALL_WARNS=""
ALL_WARNS=$(grep "^WARNING:" "$PYI_LOG" 2>/dev/null || true)

WARN_COUNT=0
[ -n "$ALL_WARNS" ] && WARN_COUNT=$(echo "$ALL_WARNS" | wc -l | tr -d ' ')

# Known-harmless: Windows/Linux-only modules, Python 2 compat shims, internal tools
HARMLESS_RE="webview\.platforms\.(gtk|mshtml|winforms|edgechromium)"
HARMLESS_RE="${HARMLESS_RE}|pkg_resources\.py2_compat"
HARMLESS_RE="${HARMLESS_RE}|charset_normalizer\.legacy"
HARMLESS_RE="${HARMLESS_RE}|_distutils_hack"
HARMLESS_RE="${HARMLESS_RE}|distutils\.command\."
HARMLESS_RE="${HARMLESS_RE}|setuptools\._vendor"
HARMLESS_RE="${HARMLESS_RE}|importlib\.metadata\._meta"

REAL_WARNS=""
HARMLESS_COUNT=0
REAL_WARN_COUNT=0
if [ -n "$ALL_WARNS" ]; then
  REAL_WARNS=$(echo "$ALL_WARNS" | grep -vE "$HARMLESS_RE" || true)
  [ -n "$REAL_WARNS" ] && REAL_WARN_COUNT=$(echo "$REAL_WARNS" | wc -l | tr -d ' ')
  HARMLESS_COUNT=$(( WARN_COUNT - REAL_WARN_COUNT ))
fi

if [ "$WARN_COUNT" -eq 0 ]; then
  _ok "PyInstaller complete (${PYI_ELAPSED}) — no warnings 🎉"
else
  _ok "PyInstaller complete (${PYI_ELAPSED})"
  if [ "$HARMLESS_COUNT" -gt 0 ]; then
    _info "${HARMLESS_COUNT} platform-compatibility notice(s) — safe to ignore (Windows/Linux modules)"
  fi
  if [ "$REAL_WARN_COUNT" -gt 0 ]; then
    echo ""
    _warn "${REAL_WARN_COUNT} warning(s) worth a look:"
    echo "$REAL_WARNS" | head -20 | while IFS= read -r line; do
      echo -e "     ${YELLOW}${line}${NC}"
    done
    if [ "$REAL_WARN_COUNT" -gt 20 ]; then
      _info "  … and $(( REAL_WARN_COUNT - 20 )) more. Full log: ${PYI_LOG}"
    fi
    echo ""
  fi
fi
rm -f "$PYI_LOG"

if [ ! -d "$APP_PATH" ]; then
  _err "Expected app bundle not found at: ${APP_PATH}"
  exit 1
fi

# ── Patch Info.plist ──────────────────────────────────────────────────────────
_phase "📝 Post-processing"

printf "  📝  Patching Info.plist... "
PLIST_PATH="${APP_PATH}/Contents/Info.plist"
python - "$PLIST_PATH" "$APP_VERSION" > /dev/null 2>&1 <<'PYEOF'
import plistlib, sys
plist_path = sys.argv[1]
version = sys.argv[2]

with open(plist_path, 'rb') as f:
    p = plistlib.load(f)

p.update({
    'CFBundleName': 'TuneBridge',
    'CFBundleDisplayName': 'TuneBridge',
    'CFBundleIdentifier': 'com.tunebridge.app',
    'CFBundleVersion': version,
    'CFBundleShortVersionString': version,
    'LSMinimumSystemVersion': '12.0',
    'NSHighResolutionCapable': True,
    'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
    'NSDocumentsFolderUsageDescription':
        'TuneBridge needs access to your Documents folder to reach your music library and playlists.',
    'NSMusicFolderUsageDescription':
        'TuneBridge needs access to your Music folder for your music library.',
})

with open(plist_path, 'wb') as f:
    plistlib.dump(p, f)
PYEOF
echo -e "${GREEN}done ✅${NC}"

printf "  🔏  Signing (ad-hoc)... "
if codesign --force --deep --sign - "$APP_PATH" 2>/dev/null; then
  echo -e "${GREEN}signed ✅${NC}"
else
  echo -e "${YELLOW}codesign failed ⚠️${NC}"
  _warn "Run manually: codesign --force --deep --sign - \"$APP_PATH\""
fi

printf "  🧹  Clearing quarantine... "
xattr -cr "$APP_PATH" 2>/dev/null || true
echo -e "${GREEN}done ✅${NC}"

BUNDLE_SIZE="$(du -sh "$APP_PATH" | awk '{print $1}')"
echo ""
_ok "App bundle ready — ${BUNDLE_SIZE}"
_info "${APP_PATH}"

# ── DMG packaging ─────────────────────────────────────────────────────────────
if [ "$BUILD_DMG" = "1" ]; then
  _phase "💿 DMG Packaging"

  DMG_PATH="${DIST_DIR}/${APP_NAME}.dmg"
  TMP_DMG="${DIST_DIR}/${APP_NAME}_tmp.dmg"
  mkdir -p "$DISTRO_DIR"
  [ -f "$DMG_PATH" ] && rm -f "$DMG_PATH"
  [ -f "$TMP_DMG" ]  && rm -f "$TMP_DMG"

  _spin_start "Creating DMG volume..."
  hdiutil create -size 500m -fs HFS+ -volname "$APP_NAME" "$TMP_DMG" -quiet
  _spin_stop
  _ok "Temporary DMG volume created"

  printf "  📦  Mounting and staging app... "
  ATTACH_PLIST="$(hdiutil attach "$TMP_DMG" -noautoopen -nobrowse -plist 2>/dev/null)"
  MOUNT_POINT="$(echo "$ATTACH_PLIST" | python -c '
import sys, plistlib
p = plistlib.loads(sys.stdin.buffer.read())
mp = next((e["mount-point"] for e in p.get("system-entities", []) if "mount-point" in e), "")
print(mp)
')"

  if [ -z "$MOUNT_POINT" ]; then
    echo -e "${RED}failed ❌${NC}"
    _err "Could not determine DMG mount point."
    rm -f "$TMP_DMG"
    exit 1
  fi

  cp -R "$APP_PATH" "$MOUNT_POINT/"
  ln -s /Applications "$MOUNT_POINT/Applications"
  echo -e "${GREEN}done ✅${NC}"

  _spin_start "Compressing DMG (UDZO)..."
  hdiutil detach "$MOUNT_POINT" -quiet
  hdiutil convert "$TMP_DMG" -format UDZO -o "$DMG_PATH" -quiet
  rm -f "$TMP_DMG"
  _spin_stop

  DMG_SIZE="$(du -sh "$DMG_PATH" | awk '{print $1}')"
  _ok "DMG compressed — ${DMG_SIZE}"
  _info "${DMG_PATH}"

  printf "  📤  Publishing to distro/... "
  BUILD_STAMP="$(date +%Y%m%d-%H%M%S)"
  DISTRO_LATEST="${DISTRO_DIR}/${APP_NAME}-latest.dmg"
  DISTRO_VERSIONED="${DISTRO_DIR}/${APP_NAME}-v${VERSION_FULL}-${BUILD_STAMP}.dmg"
  cp -f "$DMG_PATH" "$DISTRO_LATEST"
  cp -f "$DMG_PATH" "$DISTRO_VERSIONED"
  echo -e "${GREEN}done ✅${NC}"
  _info "distro/${APP_NAME}-latest.dmg  (stable latest)"
  _info "distro/${APP_NAME}-v${VERSION_FULL}-${BUILD_STAMP}.dmg  (archived)"

  # ── Update /Applications with the new build ─────────────────────────────────
  printf "  🖥️   Updating /Applications/${APP_NAME}.app... "
  [ -d "/Applications/${APP_NAME}.app" ] && rm -rf "/Applications/${APP_NAME}.app"
  cp -R "$APP_PATH" "/Applications/"
  xattr -cr "/Applications/${APP_NAME}.app" 2>/dev/null || true
  echo -e "${GREEN}done ✅${NC}"
  _info "/Applications/${APP_NAME}.app"
fi

deactivate || true

# ── Update CHANGELOG.md ───────────────────────────────────────────────────────
CHANGELOG="${PROJECT_DIR}/CHANGELOG.md"
if [ "$BUILD_DMG" = "1" ]; then
  # Build the new entry header
  _ENTRY_HEADER="## v${VERSION_FULL} · $(date '+%Y-%m-%d')"
  _ENTRY_NOTES="${RELEASE_NOTES:-No notes provided.}"

  # Only prepend if this exact version isn't already the first entry
  if ! grep -qF "## v${VERSION_FULL}" "$CHANGELOG" 2>/dev/null; then
    _NEW_ENTRY="${_ENTRY_HEADER}"$'\n'"- ${_ENTRY_NOTES}"$'\n'

    if [ -f "$CHANGELOG" ]; then
      # Preserve the existing content after the title line
      _EXISTING=$(tail -n +2 "$CHANGELOG")
      { head -1 "$CHANGELOG"; echo ""; echo "$_NEW_ENTRY"; echo "$_EXISTING"; } > "${CHANGELOG}.tmp"
    else
      { echo "# TuneBridge — Changelog"; echo ""; echo "$_NEW_ENTRY"; } > "${CHANGELOG}.tmp"
    fi
    mv "${CHANGELOG}.tmp" "$CHANGELOG"
  fi
fi

# ── Publish to tunebridge-releases (all channels with DMG) ───────────────────
if [ "$BUILD_DMG" = "1" ]; then
  RELEASES_REPO="${HOME}/tunebridge-releases"

  # Prod-only: commit version.json to main, tag, and push private repo
  if [ "$BUILD_CHANNEL" = "prod" ]; then
    _phase "🚀 Release v${VERSION_FULL}"

    printf "  📝  Committing version.json + changelog to main... "
    git -C "$PROJECT_DIR" add version.json CHANGELOG.md
    git -C "$PROJECT_DIR" commit -m "Release v${APP_VERSION}"
    echo -e "${GREEN}done ✅${NC}"

    printf "  🏷️   Tagging v${APP_VERSION}... "
    git -C "$PROJECT_DIR" tag "v${APP_VERSION}" 2>/dev/null \
      || git -C "$PROJECT_DIR" tag -f "v${APP_VERSION}"
    echo -e "${GREEN}done ✅${NC}"

    printf "  🔒  Pushing to private repo... "
    git -C "$PROJECT_DIR" push origin main
    git -C "$PROJECT_DIR" push origin "v${APP_VERSION}"
    echo -e "${GREEN}done ✅${NC}"
    _info "hashansr/tunebridge  main + v${APP_VERSION}"
  else
    _phase "📦 Publish ${BUILD_CHANNEL^^} v${VERSION_FULL}"
  fi

  # Publish DMG + version file to public releases repo (all channels)
  if [ ! -d "$RELEASES_REPO/.git" ]; then
    _warn "Releases repo not found at ${RELEASES_REPO} — skipping publish"
    _info "One-time setup:  git clone https://github.com/hashansr/tunebridge-releases ~/tunebridge-releases"
  else
    # Channel-specific filenames so each channel has its own slot
    case "$BUILD_CHANNEL" in
      prod) DMG_DEST="TuneBridge-latest.dmg";  VER_DEST="version.json" ;;
      rc)   DMG_DEST="TuneBridge-rc.dmg";      VER_DEST="version-rc.json" ;;
      *)    DMG_DEST="TuneBridge-dev.dmg";     VER_DEST="version-dev.json" ;;
    esac

    printf "  📋  Copying artifacts to releases repo... "
    cp -f "$DISTRO_LATEST" "${RELEASES_REPO}/${DMG_DEST}"
    cp -f "${PROJECT_DIR}/version.json" "${RELEASES_REPO}/${VER_DEST}"
    cp -f "${CHANGELOG}" "${RELEASES_REPO}/CHANGELOG.md"
    echo -e "${GREEN}done ✅${NC}"

    printf "  📝  Committing releases repo... "
    git -C "$RELEASES_REPO" add "${DMG_DEST}" "${VER_DEST}" CHANGELOG.md
    git -C "$RELEASES_REPO" commit -m "${BUILD_CHANNEL^^} v${VERSION_FULL}"
    echo -e "${GREEN}done ✅${NC}"

    printf "  🌐  Pushing releases repo... "
    git -C "$RELEASES_REPO" push
    echo -e "${GREEN}done ✅${NC}"
    _ok "Published ${BUILD_CHANNEL^^} v${VERSION_FULL} → hashansr/tunebridge-releases  (${DMG_DEST})"
  fi
fi

# ── Restore git state (back to original branch + unstash) ────────────────────
_git_restore

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${DIM}════════════════════════════════════════════${NC}"
TOTAL_ELAPSED=$(_elapsed "$T0")
echo -e "${GREEN}${BOLD}🎉  Build complete — v${VERSION_FULL}  (total: ${TOTAL_ELAPSED})${NC}"
echo ""

case "$BUILD_CHANNEL" in
  prod)
    echo -e "  ${BOLD}Released:${NC}"
    echo "    🏷️   Tag v${APP_VERSION} pushed to hashansr/tunebridge"
    echo "    🌐  DMG live at hashansr/tunebridge-releases"
    echo ""
    echo -e "  ${BOLD}Local install updated:${NC}"
    echo "    /Applications/${APP_NAME}.app ✅"
    ;;
  rc)
    echo -e "  ${BOLD}RC build — not published:${NC}"
    echo "    Share for testing:  distro/${APP_NAME}-latest.dmg"
    echo "    To release:  bash build_app.sh --prod"
    echo ""
    echo -e "  ${BOLD}Local install updated:${NC}"
    echo "    /Applications/${APP_NAME}.app ✅"
    ;;
  *)
    if [ "$BUILD_DMG" = "1" ]; then
      echo -e "  ${BOLD}Dev build:${NC}"
      echo "    distro/${APP_NAME}-latest.dmg"
    else
      echo -e "  ${BOLD}To install:${NC}"
      echo "    Open  dist/${APP_NAME}.app  and drag to Applications"
    fi
    ;;
esac

echo ""
echo -e "  ${DIM}First launch: user data at ~/Library/Application Support/TuneBridge${NC}"
echo ""
