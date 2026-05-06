#!/bin/bash
# 🎵 TuneBridge — Run server

cd "$(dirname "$0")"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BOLD}🎵  TuneBridge${NC}"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

# Create virtual environment if needed
if [ ! -d "venv" ]; then
  echo -e "  📦  Creating virtual environment..."
  if ! command -v python3 &>/dev/null; then
    echo -e "  ${RED}Python 3.10+ not found.${NC}"
    exit 1
  fi
  PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
  PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
  if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo -e "  ${RED}Python $PY_VER found; TuneBridge needs Python 3.10+.${NC}"
    exit 1
  fi
  python3 -m venv venv
fi

VENV_VER=$(venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")
VENV_MAJOR=$(echo "$VENV_VER" | cut -d. -f1)
VENV_MINOR=$(echo "$VENV_VER" | cut -d. -f2)
if [ "$VENV_MAJOR" -lt 3 ] || { [ "$VENV_MAJOR" -eq 3 ] && [ "$VENV_MINOR" -lt 10 ]; }; then
  echo -e "  ${RED}Existing venv uses Python $VENV_VER; TuneBridge needs Python 3.10+.${NC}"
  echo -e "  ${DIM}Run: rm -rf venv && bash install.sh${NC}"
  exit 1
fi

source venv/bin/activate

printf "  📦  Checking dependencies... "
REQ_HASH=$(python - <<'PYEOF'
from pathlib import Path
import hashlib
print(hashlib.sha256(Path('requirements.txt').read_bytes()).hexdigest())
PYEOF
)
STAMP_FILE="venv/.tunebridge-requirements.sha256"
OLD_HASH=""
[ -f "$STAMP_FILE" ] && OLD_HASH="$(cat "$STAMP_FILE")"
if [ "$REQ_HASH" != "$OLD_HASH" ]; then
  pip install -q --upgrade pip
  pip install -q -r requirements.txt
  echo "$REQ_HASH" > "$STAMP_FILE"
else
  python - <<'PYEOF'
import importlib.util, sys
mods = ['flask', 'mutagen', 'PIL', 'waitress', 'webview', 'soundfile', 'numpy', 'sklearn', 'mpv', 'pyloudnorm', 'send2trash']
missing = [m for m in mods if importlib.util.find_spec(m) is None]
if missing:
    print(', '.join(missing))
    sys.exit(1)
PYEOF
  if [ "$?" -ne 0 ]; then
    echo -e "${YELLOW}repairing${NC}"
    pip install -q -r requirements.txt
    echo "$REQ_HASH" > "$STAMP_FILE"
    printf "  📦  Checking dependencies... "
  fi
fi
echo -e "${GREEN}ready ✅${NC}"

echo ""
echo -e "  🚀  Server starting at ${BOLD}http://localhost:5001${NC}"
echo -e "  ⌨️   Press ${BOLD}Ctrl+C${NC} to stop"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

python app.py
