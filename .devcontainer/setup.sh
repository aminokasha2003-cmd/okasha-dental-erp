#!/usr/bin/env bash
# Runs once when the Codespace is created: installs everything, builds the
# web app, sets up the database and creates the clinic with an owner account.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASSWORD_FILE="$ROOT/.devcontainer/owner-password.txt"

pip install --quiet -r "$ROOT/backend/requirements.txt"
(cd "$ROOT/frontend" && npm ci --no-audit --no-fund && npm run build)

cd "$ROOT/backend"
for _ in $(seq 1 30); do
  python -c "import psycopg, os; psycopg.connect(host=os.environ['POSTGRES_HOST'], user=os.environ['POSTGRES_USER'], password=os.environ['POSTGRES_PASSWORD'], dbname=os.environ['POSTGRES_DB']).close()" 2>/dev/null && break
  echo "Waiting for the database…"; sleep 2
done
python manage.py migrate --noinput

if [ ! -f "$PASSWORD_FILE" ]; then
  python -c "import secrets; print(secrets.token_urlsafe(9))" > "$PASSWORD_FILE"
fi
INITIAL_OWNER_USERNAME=amin INITIAL_OWNER_PASSWORD="$(cat "$PASSWORD_FILE")" python manage.py bootstrap
