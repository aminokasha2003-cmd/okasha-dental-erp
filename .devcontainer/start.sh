#!/usr/bin/env bash
# Runs when you open the Codespace: shows the sign-in details and runs the app
# on port 8000 in this terminal. Keep the terminal open while you use the app.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo ""
echo "Okasha Dental ERP"
echo "Sign in as: amin"
echo "Password:   $(cat "$ROOT/.devcontainer/owner-password.txt" 2>/dev/null || echo 'not created yet, run: bash .devcontainer/setup.sh')"
echo "Open the Ports tab and click the globe next to port 8000."
echo ""
if python -c "import socket; socket.create_connection(('127.0.0.1', 8000), 1)" 2>/dev/null; then
  echo "The app is already running."
  exit 0
fi
cd "$ROOT/backend"
exec python manage.py runserver 0.0.0.0:8000
