#!/bin/bash
# Creates "TuneBridge.app" in /Applications
# Run once: bash create_app.sh

set -e

APP_NAME="TuneBridge"
APP_PATH="/Applications/${APP_NAME}.app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="${PROJECT_DIR}/venv/bin/python"

echo "Building ${APP_NAME}.app..."

# Remove old "Music Manager.app" if it exists (rename migration)
if [ -d "/Applications/Music Manager.app" ]; then
    echo "Removing old Music Manager.app..."
    rm -rf "/Applications/Music Manager.app"
fi

# ── Write AppleScript to temp file ───────────────────────────────────────────
TEMP_SCRIPT=$(mktemp /tmp/tunebridge_XXXXXX.applescript)

cat > "$TEMP_SCRIPT" <<APPLESCRIPT
on run
    set projectDir to "${PROJECT_DIR}"
    set venvPython to "${VENV_PYTHON}"
    set appScript to projectDir & "/app.py"
    set logFile to "/tmp/tunebridge.log"

    -- Check if server is already running on port 5001
    set serverRunning to false
    try
        do shell script "lsof -i :5001 | grep LISTEN"
        set serverRunning to true
    end try

    -- Start server if not running
    if not serverRunning then
        do shell script "nohup " & quoted form of venvPython & " " & quoted form of appScript & " > " & quoted form of logFile & " 2>&1 &"

        -- Wait up to 15 seconds for server to be ready
        set ready to false
        repeat 30 times
            delay 0.5
            try
                do shell script "curl -sf --max-time 1 http://localhost:5001/api/library/status > /dev/null 2>&1"
                set ready to true
                exit repeat
            end try
        end repeat

        if not ready then
            display dialog "TuneBridge failed to start." & return & return & "Check log: " & logFile buttons {"OK"} default button "OK" with icon stop
            return
        end if
    end if

    -- Open in a new Safari window
    tell application "Safari"
        activate
        make new document with properties {URL:"http://localhost:5001"}
    end tell
end run
APPLESCRIPT

# ── Compile to .app ───────────────────────────────────────────────────────────
if [ -d "$APP_PATH" ]; then
    echo "Replacing existing ${APP_NAME}.app..."
    rm -rf "$APP_PATH"
fi

osacompile -o "$APP_PATH" "$TEMP_SCRIPT"
rm "$TEMP_SCRIPT"

# ── Set icon ──────────────────────────────────────────────────────────────────
CUSTOM_ICON="${PROJECT_DIR}/static/TuneBridge.icns"
if [ -f "$CUSTOM_ICON" ]; then
    cp "$CUSTOM_ICON" "${APP_PATH}/Contents/Resources/applet.icns"
    touch "$APP_PATH"
fi

echo ""
echo "  Done! \"${APP_NAME}\" is now in /Applications."
echo ""
echo "  - Double-click to launch (starts server + opens Safari)"
echo "  - Drag to your Dock for quick access"
echo "  - Server log: /tmp/tunebridge.log"
echo ""
