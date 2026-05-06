#!/bin/bash
# 🎵 TuneBridge — Master script
#
# Usage:
#   bash tunebridge.sh           # interactive menu
#   bash tunebridge.sh [command] # run directly
#
# Commands: run, install, update, app, dist, dmg, ios, help

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

_header() {
  echo ""
  echo -e "${BOLD}🎵  TuneBridge${NC}"
  echo -e "${DIM}────────────────────────────────────────${NC}"
  echo ""
}

_run()     { bash "$SCRIPT_DIR/run.sh"; }
_install() { bash "$SCRIPT_DIR/install.sh"; }
_update()  { bash "$SCRIPT_DIR/update.sh"; }
_app()     { bash "$SCRIPT_DIR/create_app.sh"; }
_dist()    { bash "$SCRIPT_DIR/build_app.sh"; }
_dmg()     { bash "$SCRIPT_DIR/build_app.sh" --dmg; }
_ios()     { bash "$SCRIPT_DIR/ios/setup.sh"; }

_menu() {
  _header
  echo -e "  What would you like to do?\n"
  echo -e "  ${BOLD}1)${NC}  🚀  Run TuneBridge             ${DIM}development server in browser${NC}"
  echo -e "  ${BOLD}2)${NC}  📦  Install                    ${DIM}first-time setup${NC}"
  echo -e "  ${BOLD}3)${NC}  🔄  Update                     ${DIM}pull latest + rebuild${NC}"
  echo -e "  ${BOLD}4)${NC}  🏗️   Build Mac app               ${DIM}dev build, installs to /Applications${NC}"
  echo -e "  ${BOLD}5)${NC}  📀  Build distributable app     ${DIM}self-contained .app in dist/${NC}"
  echo -e "  ${BOLD}6)${NC}  💿  Build distributable DMG     ${DIM}.app + drag-to-install .dmg${NC}"
  echo -e "  ${BOLD}7)${NC}  📱  iOS project setup           ${DIM}generate Xcode project${NC}"
  echo -e "  ${BOLD}q)${NC}  👋  Quit"
  echo ""
  printf "  Enter choice [1–7, q]: "
  local choice
  read -r choice
  echo ""

  case "$choice" in
    1) _run ;;
    2) _install ;;
    3) _update ;;
    4) _app ;;
    5) _dist ;;
    6) _dmg ;;
    7) _ios ;;
    q|Q|quit|exit) echo "  Bye! 👋"; echo ""; exit 0 ;;
    "") _menu ;;
    *)
      echo -e "  ${RED}❌  Unknown choice: '$choice'${NC}"
      echo ""
      _menu
      ;;
  esac
}

_help() {
  _header
  echo "  Usage: bash tunebridge.sh [command]"
  echo ""
  echo "  Commands:"
  printf "    %-10s  %s\n" "run"     "🚀  Start the development server in your browser"
  printf "    %-10s  %s\n" "install" "📦  First-time setup (venv, deps, data files)"
  printf "    %-10s  %s\n" "update"  "🔄  Pull latest changes and rebuild"
  printf "    %-10s  %s\n" "app"     "🏗️   Build TuneBridge.app (dev, /Applications)"
  printf "    %-10s  %s\n" "dist"    "📀  Build distributable .app (dist/)"
  printf "    %-10s  %s\n" "dmg"     "💿  Build distributable .app + .dmg (dist/ + distro/)"
  printf "    %-10s  %s\n" "ios"     "📱  Set up iOS Xcode project"
  printf "    %-10s  %s\n" "help"    "📋  Show this help"
  echo ""
  echo "  Run without arguments for the interactive menu."
  echo ""
}

case "${1:-}" in
  run)            _run ;;
  install)        _install ;;
  update)         _update ;;
  app)            _app ;;
  dist)           _dist ;;
  dmg)            _dmg ;;
  ios)            _ios ;;
  help|-h|--help) _help ;;
  "")             _menu ;;
  *)
    echo -e "\n  ${RED}❌  Unknown command: '$1'${NC}"
    echo "  Run ${BOLD}bash tunebridge.sh help${NC} to see all commands."
    echo ""
    exit 1
    ;;
esac
