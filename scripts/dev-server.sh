#!/usr/bin/env bash
# Lokale Entwicklungs-Instanz: PocketBase + Mailpit mit frischen, synthetischen Testdaten.
# Jeder Start beginnt mit einer leeren Instanz in einem temporären Verzeichnis (außerhalb von Dropbox,
# SQLite/WAL verträgt keinen Sync): Schema importieren → Testdaten anlegen (scripts/dev-seed.mjs).
# Beim Beenden (Strg+C) wird das Verzeichnis gelöscht – nichts bleibt zwischen zwei Starts erhalten.
#
#   scripts/dev-server.sh                           # starten
#   scripts/dev-server.sh add-user <email> [Name]   # weiteren Labor-Nutzer anlegen (Server muss laufen)
#
# App:     http://127.0.0.1:8090/      Login z. B. labor@example.com, Code aus Mailpit
# Admin:   http://127.0.0.1:8090/_/   (dev-admin@example.com / dev-admin-password)
# Mails:   http://127.0.0.1:8025/      (Mailpit, fängt alle OTP-Mails ab)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

WORK="$(mktemp -d -t bestellverwaltung-dev.XXXXXX)"
DATA="$WORK/pb_data"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 >/dev/null 2>&1 &
PIDS+=("$!")

# Leere Instanz: Migrationen tun nichts (keine Collections), das Schema kommt danach per Import.
pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir "$DATA" >/dev/null
pocketbase serve --dev \
  --dir "$DATA" \
  --hooksDir "$ROOT/pb_hooks" \
  --migrationsDir "$ROOT/pb_migrations" --automigrate=false \
  --publicDir "$ROOT/pb_public" \
  --http "${PB#http://}" >"$WORK/pocketbase.log" 2>&1 &
PIDS+=("$!")

for _ in $(seq 1 50); do curl -fsS "$PB/api/health" >/dev/null 2>&1 && break; sleep 0.1; done
if ! curl -fsS "$PB/api/health" >/dev/null 2>&1; then
  echo "PocketBase ist nicht gestartet (Port belegt?). Log:" >&2
  tail -n 20 "$WORK/pocketbase.log" >&2
  exit 1
fi

# Schema importieren und Testdaten anlegen (über die echten Routen)
PB_URL="$PB" PB_ADMIN_EMAIL="$ADMIN_EMAIL" PB_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  PB_SCHEMA="$ROOT/pb_schema.json" MAILPIT_SMTP_PORT=1025 \
  node "$ROOT/scripts/dev-seed.mjs"

curl -fsS -X PATCH "$PB/api/settings" -H "Authorization: $(admin_token)" -H 'Content-Type: application/json' -d "{
  \"meta\": {\"appName\": \"Labor-Bestellsystem (Dev)\", \"appURL\": \"$PB\", \"senderName\": \"Labor-Bestellsystem\", \"senderAddress\": \"labor@example.com\"},
  \"smtp\": {\"enabled\": true, \"host\": \"127.0.0.1\", \"port\": 1025, \"tls\": false}
}" >/dev/null

echo
echo "Dev-Instanz läuft:  App $PB/   Admin $PB/_/   Mails http://127.0.0.1:8025/"
echo "Login:              labor@example.com (oder kollegin@example.com), Code aus Mailpit"
echo "Daten:              $WORK (wird beim Beenden mit Strg+C gelöscht)"
echo "PocketBase-Log:     $WORK/pocketbase.log"
wait
