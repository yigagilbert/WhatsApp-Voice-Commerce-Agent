#!/usr/bin/env bash
# Renders each graphic's HTML to a PNG at its design size with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
render() { "$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$2" --screenshot="$1.png" "file://$PWD/$1.html" 2>/dev/null; }
render title-card 1920,1080
render architecture 1920,1080
render closing-card 1920,1080
render thumbnail-youtube 1280,720
render thumbnail-devpost 1200,800
