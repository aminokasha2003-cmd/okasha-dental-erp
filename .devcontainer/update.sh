#!/usr/bin/env bash
# After getting new code (git pull, or switching branch), run this once:
# installs new packages, rebuilds the web app, updates the database and
# restarts the app. Keep this terminal open: the app runs in it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Stopping the app while it updates…"
pkill -f "manage.py runserver" 2>/dev/null || true
cd "$ROOT/backend" && pip install --quiet -r requirements.txt
cd "$ROOT/frontend" && npm ci --silent && npm run build --silent
cd "$ROOT/backend" && python manage.py migrate --noinput
echo ""
echo "Updated. Starting the app…"
exec bash "$ROOT/.devcontainer/start.sh"
