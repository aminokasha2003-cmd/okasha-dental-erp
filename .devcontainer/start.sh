#!/usr/bin/env bash
# Runs when you open the Codespace: starts the app on port 8000 in the
# background, waits until it answers, shows the sign-in details and returns,
# so this terminal is free again. The app's log is in /tmp/okasha-app.log.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
up() { python -c "import socket; socket.create_connection(('127.0.0.1', 8000), 1)" 2>/dev/null; }

if up; then
  echo "The app is already running."
else
  echo "Starting the app…"
  cd "$ROOT/backend"
  setsid nohup python manage.py runserver 0.0.0.0:8000 < /dev/null > /tmp/okasha-app.log 2>&1 &
  for _ in $(seq 1 60); do up && break; sleep 1; done
  if ! up; then
    echo "The app did not start. The last lines of its log:"
    tail -n 20 /tmp/okasha-app.log
    exit 1
  fi
fi
echo ""
echo "Okasha Dental ERP is ready."
echo "Sign in as: amin"
echo "Password:   $(cat "$ROOT/.devcontainer/owner-password.txt" 2>/dev/null || echo 'not created yet, run: bash .devcontainer/setup.sh')"
echo "Open the Ports tab and click the globe next to port 8000."
