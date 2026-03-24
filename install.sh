#!/bin/bash
# TuneBridge — one-time installer
# Run this once on a new machine: bash install.sh

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BOLD}TuneBridge — Setup${NC}"
echo "──────────────────────────────────────"

# ── Check Python 3.8+ ───────────────────────────────────────────────────────
echo -n "Checking Python 3... "
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}not found${NC}"
  echo "Install Python 3.8+ from https://python.org and re-run this script."
  exit 1
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 8 ]; }; then
  echo -e "${RED}Python $PY_VER found — need 3.8+${NC}"
  exit 1
fi
echo -e "${GREEN}Python $PY_VER${NC}"

# ── Create virtual environment ───────────────────────────────────────────────
cd "$(dirname "$0")"

if [ -d "venv" ]; then
  echo -e "Virtual environment: ${YELLOW}already exists, skipping${NC}"
else
  echo -n "Creating virtual environment... "
  python3 -m venv venv
  echo -e "${GREEN}done${NC}"
fi

# ── Install dependencies ─────────────────────────────────────────────────────
echo -n "Installing dependencies... "
source venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
echo -e "${GREEN}done${NC}"

# ── Create data directories ──────────────────────────────────────────────────
echo -n "Creating data directories... "
mkdir -p data/artwork data/playlist_artwork
echo -e "${GREEN}done${NC}"

# ── Bootstrap empty data files ───────────────────────────────────────────────
if [ ! -f "data/playlists.json" ]; then
  echo -n "Creating empty playlists.json... "
  echo '{}' > data/playlists.json
  echo -e "${GREEN}done${NC}"
fi

# ── Settings ─────────────────────────────────────────────────────────────────
if [ ! -f "data/settings.json" ]; then
  echo -n "Creating default settings.json... "
  cat > data/settings.json <<'JSON'
{
  "poweramp_mount": "/Volumes/FIIO M21",
  "ap80_mount": "/Volumes/AP80",
  "music_base": "/Volumes/Storage/Music/FLAC"
}
JSON
  echo -e "${GREEN}done${NC}"
fi

echo ""
echo -e "${BOLD}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit data/settings.json to set your music library path:"
echo "       \"music_base\": \"/path/to/your/Music\""
echo "  2. Start the app:  ${BOLD}bash run.sh${NC}"
echo "  3. Open browser:   ${BOLD}http://localhost:5001${NC}"
echo "  4. Click 'Rescan Library' in the sidebar to index your music."
echo ""
