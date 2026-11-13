#!/usr/bin/env bash
# Lokale Entwicklungs-Instanz: PocketBase + Mailpit.
# Daten liegen bewusst AUSSERHALB von Dropbox (SQLite/WAL verträgt keinen Sync).
#
#   scripts/dev-server.sh                    # starten
#   scripts/dev-server.sh add-user <email> [Name]   # Labor-Nutzer anlegen (Server muss laufen)
#
# App:     http://127.0.0.1:8090/
# Admin:   http://127.0.0.1:8090/_/   (dev-admin@example.com / dev-admin-password)
# Mails:   http://127.0.0.1:8025/      (Mailpit, fängt alle OTP-Mails ab)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${PB_DEV_DIR:-$HOME/.local/share/bestellverwaltung-dev}/pb_data"
PB="http://127.0.0.1:${PB_DEV_PORT:-8090}"
ADMIN_EMAIL="dev-admin@example.com"
ADMIN_PASSWORD="dev-admin-password"

admin_token() {
  curl -fsS -X POST "$PB/api/collections/_superusers/auth-with-password" \
    -H 'Content-Type: application/json' \
    -d "{\"identity\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" |
    python3 -I -c 'import sys, json; print(json.load(sys.stdin)["token"])'
}

if [ "${1:-}" = "add-user" ]; then
  email="${2:?E-Mail fehlt}"; name="${3:-$email}"
  pw="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(24))')"  # wird nie benutzt (Passwort-Login aus)
  body="$(python3 -I -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"name":sys.argv[2],"password":sys.argv[3],"passwordConfirm":sys.argv[3],"verified":True}))' "$email" "$name" "$pw")"
  curl -fsS -X POST "$PB/api/collections/users/records" -H "Authorization: $(admin_token)" \
    -H 'Content-Type: application/json' -d "$body" >/dev/null
  echo "Nutzer $email angelegt. Login über die App, der Code erscheint in Mailpit (http://127.0.0.1:8025/)."
  exit 0
fi

mkdir -p "$DATA"
PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 >/dev/null 2>&1 &
PIDS+=("$!")

pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir "$DATA" >/dev/null
pocketbase serve --dev \
  --dir "$DATA" \
  --hooksDir "$ROOT/pb_hooks" \
  --migrationsDir "$ROOT/pb_migrations" --automigrate=false \
  --publicDir "$ROOT/pb_public" \
  --http "${PB#http://}" &
PIDS+=("$!")

for _ in $(seq 1 50); do curl -fsS "$PB/api/health" >/dev/null 2>&1 && break; sleep 0.1; done

# Schema (idempotent) und Einstellungen anwenden
TOKEN="$(admin_token)"
python3 -I -c 'import json,sys; print(json.dumps({"collections": json.load(open(sys.argv[1])), "deleteMissing": False}))' \
  "$ROOT/pb_schema.json" |
  curl -fsS -X PUT "$PB/api/collections/import" -H "Authorization: $TOKEN" -H 'Content-Type: application/json' --data @- >/dev/null
curl -fsS -X PATCH "$PB/api/settings" -H "Authorization: $TOKEN" -H 'Content-Type: application/json' -d "{
  \"meta\": {\"appName\": \"Labor-Bestellsystem (Dev)\", \"appURL\": \"$PB\", \"senderName\": \"Labor-Bestellsystem\", \"senderAddress\": \"labor@example.com\"},
  \"smtp\": {\"enabled\": true, \"host\": \"127.0.0.1\", \"port\": 1025, \"tls\": false}
}" >/dev/null

echo
echo "Dev-Instanz läuft:  App $PB/   Admin $PB/_/   Mails http://127.0.0.1:8025/"
echo "Nutzer anlegen:     scripts/dev-server.sh add-user name@example.com \"Vorname Name\""
wait
