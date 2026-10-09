#!/usr/bin/env bash
# After getting new code (git pull, or switching branch), run this once:
# installs new packages, rebuilds the web app, updates the database and
# restarts the app in the background.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Step 1 of 4: stopping the app while it updates…"
pkill -f "manage.py runserver" 2>/dev/null || true
echo "Step 2 of 4: installing new packages (this can take a few minutes)…"
cd "$ROOT/backend" && pip install --quiet --progress-bar off -r requirements.txt
cd "$ROOT/frontend" && npm ci --no-audit --no-fund --loglevel=error
echo "Step 3 of 4: building the screens…"
npm run build --silent
echo "Step 4 of 4: updating the database…"
cd "$ROOT/backend" && python manage.py migrate --noinput
echo ""
bash "$ROOT/.devcontainer/start.sh"
