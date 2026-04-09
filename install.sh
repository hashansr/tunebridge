#!/bin/bash
# 🎵 TuneBridge — First-time setup
# Run once on a new machine: bash install.sh

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
echo -e "${BOLD}🎵  TuneBridge — Setup${NC}"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

# ── Python 3.8+ check ─────────────────────────────────────────────────────────
printf "  🔍  Checking Python 3... "
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}not found ❌${NC}"
  echo ""
  echo "  Install Python 3.8+ from https://python.org and re-run."
  exit 1
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 8 ]; }; then
  echo -e "${RED}Python $PY_VER — need 3.8+ ❌${NC}"
  exit 1
fi
echo -e "${GREEN}Python $PY_VER ✅${NC}"

# ── Virtual environment ───────────────────────────────────────────────────────
if [ -d "venv" ]; then
  echo -e "  📁  Virtual environment... ${YELLOW}already exists, skipping ⏭️${NC}"
else
  _spin_start "Creating virtual environment..."
  python3 -m venv venv
  _spin_stop
  echo -e "  📁  Virtual environment... ${GREEN}created ✅${NC}"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
source venv/bin/activate
_spin_start "Installing dependencies (this may take a moment)..."
pip install -q --upgrade pip
pip install -q -r requirements.txt
_spin_stop
echo -e "  📦  Dependencies... ${GREEN}installed ✅${NC}"

# ── Data directories ──────────────────────────────────────────────────────────
mkdir -p data/artwork data/playlist_artwork
echo -e "  📂  Data directories... ${GREEN}ready ✅${NC}"

# ── SQLite bootstrap ──────────────────────────────────────────────────────────
if [ ! -f "data/tunebridge.db" ]; then
  echo -e "  🗃️   SQLite database... ${YELLOW}will be created on first app launch ⏭️${NC}"
else
  echo -e "  🗃️   SQLite database... ${GREEN}found ✅${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}✅  Setup complete!${NC}"
echo ""
echo -e "  Next steps:"
echo -e "  ${BOLD}1.${NC} Start:   ${BOLD}bash run.sh${NC}  ${DIM}(or: bash tunebridge.sh run)${NC}"
echo -e "  ${BOLD}2.${NC} Browse:  ${BOLD}http://localhost:5001${NC}"
echo -e "  ${BOLD}3.${NC} In app Settings, set your music library path."
echo -e "  ${BOLD}4.${NC} Click ${BOLD}Rescan Library${NC} to index your music."
echo ""
