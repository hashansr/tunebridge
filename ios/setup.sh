#!/bin/bash
# setup.sh — Generate TuneBridge.xcodeproj from project.yml using xcodegen.
#
# Usage:
#   cd ios/
#   bash setup.sh
#
# Requirements:
#   - Homebrew (https://brew.sh)
#   - Xcode 15+ with Command Line Tools

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== TuneBridge iOS — Project Setup ==="

# Install xcodegen if needed
if ! command -v xcodegen &>/dev/null; then
  echo "  Installing xcodegen via Homebrew..."
  brew install xcodegen
else
  echo "  xcodegen $(xcodegen version) found"
fi

# Generate .xcodeproj
echo "  Generating TuneBridge.xcodeproj..."
xcodegen generate --spec project.yml --project .

echo ""
echo "=== Setup complete ==="
echo ""
echo "  Open the project:"
echo "    open TuneBridge.xcodeproj"
echo ""
echo "  Before building:"
echo "    1. Set your Apple Developer Team in Xcode → Signing & Capabilities"
echo "    2. Select an iOS 16+ simulator or connected device"
echo "    3. Build and run (⌘R)"
echo ""
echo "  First-launch notes:"
echo "    - Allow Local Network access when prompted (required for Mac sync)"
echo "    - Allow Background App Refresh for uninterrupted sync transfers"
