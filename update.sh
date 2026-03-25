#!/bin/bash
# TuneBridge — updater
# Run to pull the latest version: bash update.sh

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cd "$(dirname "$0")"

echo ""
echo -e "${BOLD}TuneBridge — Update${NC}"
echo "──────────────────────────────────────"

# ── Back up data ──────────────────────────────────────────────────────────────
BACKUP_DIR="data/backups/$(date +%Y%m%d_%H%M%S)"
echo -n "Backing up data to ${BACKUP_DIR}... "
mkdir -p "$BACKUP_DIR"
for f in data/playlists.json data/settings.json data/daps.json data/iems.json data/baselines.json; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" || true
done
echo -e "${GREEN}done${NC}"

# ── Pull latest ───────────────────────────────────────────────────────────────
echo -n "Pulling latest changes... "
git pull --ff-only 2>&1 | tail -1
echo -e "${GREEN}done${NC}"

# ── Update dependencies ───────────────────────────────────────────────────────
echo -n "Updating dependencies... "
source venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
echo -e "${GREEN}done${NC}"

# ── Rebuild Mac app (macOS only) ──────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]] && [ -f "create_app.sh" ]; then
  echo -n "Rebuilding Mac app... "
  bash create_app.sh > /dev/null 2>&1
  echo -e "${GREEN}done${NC}"
fi

echo ""
echo -e "${BOLD}Update complete!${NC}"
echo ""
echo "Restart TuneBridge to apply changes:"
echo "  ${BOLD}bash run.sh${NC}"
echo ""
