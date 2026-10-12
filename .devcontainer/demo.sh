#!/usr/bin/env bash
# Starts the demo clinic again from scratch: removes every patient, visit,
# invoice, lab case, stock and staff record in the app, builds the demo
# clinic, restarts the app and shows the demo sign-ins. Your own sign-in
# (amin) and its password are kept. Add --yes to skip the question.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != "--yes" ]; then
  echo "This replaces everything in the app (patients, visits, money, lab, stock, staff) with fresh demo data."
  echo "Your sign-in (amin) and its password stay as they are."
  read -r -p "Type yes to go on: " answer
  if [ "$answer" != "yes" ]; then
    echo "Nothing was changed."
    exit 0
  fi
fi

echo "Step 1 of 3: stopping the app…"
pkill -f "manage.py runserver" 2>/dev/null || true
echo "Step 2 of 3: building the demo clinic (about half a minute)…"
cd "$ROOT/backend" && python manage.py seed_demo --reset
echo ""
echo "Step 3 of 3: starting the app again…"
bash "$ROOT/.devcontainer/start.sh"
