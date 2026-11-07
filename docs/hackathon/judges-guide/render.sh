#!/usr/bin/env bash
# Renders guide.html to the PDF that goes on Devpost (fetches the fonts from Google Fonts).
set -euo pipefail
cd "$(dirname "$0")"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \
  --virtual-time-budget=8000 --print-to-pdf=Katale_AI_Judges_Guide.pdf "file://$PWD/guide.html" 2>/dev/null
