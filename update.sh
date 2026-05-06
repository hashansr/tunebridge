#!/bin/bash
# 🎵 TuneBridge — Updater
# Pull the latest version: bash update.sh

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cd "$(dirname "$0")"

# ── Spinner ───────────────────────────────────────────────────────────────────
_SP=""
_spin_start() {
  local m="$1"
  (while :; do
    for c in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do printf "\r  %s  %s " "$c" "$m"; sleep 0.08; done
  done) &
  _SP=$!; disown 2>/dev/null || true
}
_spin_stop() {
  [ -n "$_SP" ] && { kill "$_SP" 2>/dev/null; wait "$_SP" 2>/dev/null || true; _SP=""; printf "\r\033[K"; }
}
trap '_spin_stop' EXIT INT TERM

echo ""
echo -e "${BOLD}🎵  TuneBridge — Update${NC}"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

# ── Back up data ──────────────────────────────────────────────────────────────
BACKUP_DIR="data/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
BACKED_UP=0
APP_SUPPORT_DIR="$HOME/Library/Application Support/TuneBridge"
for f in \
  "$APP_SUPPORT_DIR/tunebridge.db" \
  "$APP_SUPPORT_DIR/tunebridge.db-wal" \
  "$APP_SUPPORT_DIR/tunebridge.db-shm" \
  data/tunebridge.db \
  data/tunebridge.db-wal \
  data/tunebridge.db-shm; do
  if [ -f "$f" ]; then
    cp "$f" "$BACKUP_DIR/"
    BACKED_UP=$(( BACKED_UP + 1 ))
  fi
done
if [ -d "$APP_SUPPORT_DIR/playlist_artwork" ]; then
  cp -R "$APP_SUPPORT_DIR/playlist_artwork" "$BACKUP_DIR/"
elif [ -d "data/playlist_artwork" ]; then
  cp -R data/playlist_artwork "$BACKUP_DIR/"
fi
echo -e "  💾  Data backed up... ${GREEN}${BACKED_UP} file(s) → ${BACKUP_DIR} ✅${NC}"

# ── Pull latest ───────────────────────────────────────────────────────────────
printf "  🔄  Pulling latest changes... "
set +e
GIT_OUT=$(git pull --ff-only 2>&1)
GIT_EXIT=$?
set -e
if [ "$GIT_EXIT" -ne 0 ]; then
  echo -e "${RED}failed ❌${NC}"
  echo ""
  echo "$GIT_OUT"
  echo ""
  echo "  Tip: commit or stash local changes first, then re-run."
  exit 1
fi
GIT_MSG=$(echo "$GIT_OUT" | tail -1)
echo -e "${GREEN}${GIT_MSG} ✅${NC}"

# ── Update dependencies ───────────────────────────────────────────────────────
source venv/bin/activate
_spin_start "Updating dependencies..."
pip install -q --upgrade pip
pip install -q -r requirements.txt
python - <<'PYEOF'
from pathlib import Path
import hashlib
req = Path('requirements.txt')
stamp = Path('venv/.tunebridge-requirements.sha256')
stamp.write_text(hashlib.sha256(req.read_bytes()).hexdigest() + '\n')
PYEOF
_spin_stop
echo -e "  📦  Dependencies... ${GREEN}up to date ✅${NC}"

# ── Rebuild Mac app (macOS only) ──────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]] && [ -f "create_app.sh" ]; then
  _spin_start "Rebuilding Mac app..."
  bash create_app.sh > /dev/null 2>&1
  _spin_stop
  echo -e "  🏗️   Mac app... ${GREEN}rebuilt ✅${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}✅  Update complete!${NC}"
echo ""
echo -e "  Restart TuneBridge to apply changes:"
echo -e "  ${BOLD}bash run.sh${NC}  ${DIM}(or: bash tunebridge.sh run)${NC}"
echo ""
