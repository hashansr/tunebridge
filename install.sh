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

# ── Python 3.10+ check ────────────────────────────────────────────────────────
printf "  🔍  Checking Python 3.10+... "
PYTHON_BIN=""
for candidate in \
  "$(command -v python3.13 2>/dev/null || true)" \
  "$(command -v python3.12 2>/dev/null || true)" \
  "$(command -v python3.11 2>/dev/null || true)" \
  "$(command -v python3.10 2>/dev/null || true)" \
  "$(command -v python3 2>/dev/null || true)" \
  "/opt/homebrew/bin/python3.13" \
  "/opt/homebrew/bin/python3.12" \
  "/opt/homebrew/bin/python3.11" \
  "/opt/homebrew/bin/python3.10" \
  "/opt/homebrew/bin/python3" \
  "/usr/local/bin/python3.13" \
  "/usr/local/bin/python3.12" \
  "/usr/local/bin/python3.11" \
  "/usr/local/bin/python3.10" \
  "/usr/local/bin/python3"; do
  [ -n "$candidate" ] || continue
  [ -x "$candidate" ] || continue
  PY_VER=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "")
  PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
  PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
  if [ "$PY_MAJOR" = "3" ] && [ "$PY_MINOR" -ge 10 ] 2>/dev/null; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo -e "${RED}not found ❌${NC}"
  echo ""
  echo "  Install Python 3.10+ from https://python.org or Homebrew and re-run."
  exit 1
fi
echo -e "${GREEN}Python $PY_VER ✅${NC}"
echo -e "  ${DIM}${PYTHON_BIN}${NC}"

# ── Virtual environment ───────────────────────────────────────────────────────
if [ -d "venv" ]; then
  VENV_VER=$(venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")
  VENV_MAJOR=$(echo "$VENV_VER" | cut -d. -f1)
  VENV_MINOR=$(echo "$VENV_VER" | cut -d. -f2)
  if [ "$VENV_MAJOR" -lt 3 ] || { [ "$VENV_MAJOR" -eq 3 ] && [ "$VENV_MINOR" -lt 10 ]; }; then
    echo -e "  📁  Virtual environment... ${RED}Python $VENV_VER found; recreate with Python 3.10+ ❌${NC}"
    echo -e "  Remove the old venv and rerun: ${BOLD}rm -rf venv && bash install.sh${NC}"
    exit 1
  fi
  echo -e "  📁  Virtual environment... ${YELLOW}already exists (Python $VENV_VER), skipping ⏭️${NC}"
else
  _spin_start "Creating virtual environment..."
  "$PYTHON_BIN" -m venv venv
  _spin_stop
  echo -e "  📁  Virtual environment... ${GREEN}created ✅${NC}"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
source venv/bin/activate
_spin_start "Installing dependencies (this may take a moment)..."
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
echo -e "  📦  Dependencies... ${GREEN}installed ✅${NC}"

# ── Data directories ──────────────────────────────────────────────────────────
APP_SUPPORT_DIR="$HOME/Library/Application Support/TuneBridge"
mkdir -p "$APP_SUPPORT_DIR/artwork" "$APP_SUPPORT_DIR/playlist_artwork"
echo -e "  📂  Data directories... ${GREEN}ready ✅${NC}"

# ── SQLite bootstrap ──────────────────────────────────────────────────────────
if [ ! -f "$APP_SUPPORT_DIR/tunebridge.db" ]; then
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
