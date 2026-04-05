#!/bin/bash
# 📱 TuneBridge iOS — Xcode project setup
#
# Generates TuneBridge.xcodeproj from project.yml using xcodegen.
#
# Usage:
#   cd ios/
#   bash setup.sh

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}📱  TuneBridge — iOS Project Setup${NC}"
echo -e "${DIM}────────────────────────────────────────${NC}"
echo ""

# ── Install xcodegen if needed ────────────────────────────────────────────────
printf "  🔍  Checking xcodegen... "
if ! command -v xcodegen &>/dev/null; then
  echo -e "${YELLOW}not found, installing via Homebrew ⏳${NC}"
  brew install xcodegen
  echo -e "  📦  xcodegen... ${GREEN}installed ✅${NC}"
else
  XGEN_VER=$(xcodegen version 2>/dev/null || echo "unknown")
  echo -e "${GREEN}${XGEN_VER} ✅${NC}"
fi

# ── Generate .xcodeproj ───────────────────────────────────────────────────────
printf "  🏗️   Generating TuneBridge.xcodeproj... "
xcodegen generate --spec project.yml --project . 2>/dev/null
echo -e "${GREEN}done ✅${NC}"

echo ""
echo -e "${GREEN}${BOLD}✅  Xcode project ready!${NC}"
echo ""
echo -e "  Open the project:"
echo -e "  ${BOLD}open TuneBridge.xcodeproj${NC}"
echo ""
echo -e "  Before building:"
echo -e "  ${BOLD}1.${NC} Set your Apple Developer Team in Xcode → Signing & Capabilities"
echo -e "  ${BOLD}2.${NC} Select an iOS 16+ simulator or connected device"
echo -e "  ${BOLD}3.${NC} Build and run (${BOLD}⌘R${NC})"
echo ""
echo -e "  First-launch notes:"
echo -e "  ${DIM}• Allow Local Network access when prompted (required for Mac sync)${NC}"
echo -e "  ${DIM}• Allow Background App Refresh for uninterrupted sync transfers${NC}"
echo ""
