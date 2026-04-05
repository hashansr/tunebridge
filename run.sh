#!/bin/bash
# 🎵 TuneBridge — Run server

cd "$(dirname "$0")"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo -e "${BOLD}🎵  TuneBridge${NC}"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

# Create virtual environment if needed
if [ ! -d "venv" ]; then
  echo -e "  📦  Creating virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

printf "  📦  Checking dependencies... "
pip install -q -r requirements.txt
echo -e "${GREEN}ready ✅${NC}"

echo ""
echo -e "  🚀  Server starting at ${BOLD}http://localhost:5001${NC}"
echo -e "  ⌨️   Press ${BOLD}Ctrl+C${NC} to stop"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

python app.py
