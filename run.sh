#!/bin/bash
cd "$(dirname "$0")"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv venv
fi

# Activate and install dependencies
source venv/bin/activate
pip install -q -r requirements.txt

echo ""
echo "  Music Manager"
echo "  Open http://localhost:5001 in your browser"
echo "  Press Ctrl+C to stop"
echo ""

python app.py
