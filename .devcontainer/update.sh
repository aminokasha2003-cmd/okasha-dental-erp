#!/usr/bin/env bash
# After getting new code (git pull, or switching branch), run this once:
# installs new packages, rebuilds the web app and updates the database.
# The running app picks the changes up by itself; refresh the browser tab.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend" && pip install --quiet -r requirements.txt
cd "$ROOT/frontend" && npm ci --silent && npm run build --silent
cd "$ROOT/backend" && python manage.py migrate --noinput
echo ""
echo "Updated. Refresh the app in your browser."
