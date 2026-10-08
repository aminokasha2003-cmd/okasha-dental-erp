#!/usr/bin/env bash
# Runs every time the Codespace starts: launches the app on port 8000.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"
nohup python manage.py runserver 0.0.0.0:8000 > /tmp/okasha-erp.log 2>&1 &
echo ""
echo "Okasha Dental ERP is starting on port 8000 (see the Ports tab)."
echo "Sign in as: amin"
echo "Password:   $(cat "$ROOT/.devcontainer/owner-password.txt" 2>/dev/null || echo 'not created yet, run: bash .devcontainer/setup.sh')"
echo ""
