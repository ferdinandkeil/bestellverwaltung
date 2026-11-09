#!/usr/bin/env bash
# Startet eine frische, temporäre PocketBase-Instanz (+ Mailpit) und führt die Tests aus.
# Voraussetzungen im PATH: pocketbase, mailpit, node (≥ 20). Kein npm.
#
#   tests/run.sh                 # alle Tests
#   tests/run.sh tests/x.test.mjs
#   tests/run.sh --e2e           # zusätzlich Browser-Durchlauf (headless Chrome, tests/e2e.mjs)
set -euo pipefail

E2E=0
if [ "${1:-}" = "--e2e" ]; then E2E=1; shift; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d -t bestellverwaltung-test.XXXXXX)"   # bewusst außerhalb von Dropbox
PB_PORT="${PB_TEST_PORT:-8091}"
SMTP_PORT="${MAILPIT_TEST_SMTP_PORT:-1026}"
MAIL_UI_PORT="${MAILPIT_TEST_UI_PORT:-8026}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_for() { # url
  for _ in $(seq 1 50); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "Timeout beim Warten auf $1" >&2
  return 1
}

mailpit --smtp "127.0.0.1:$SMTP_PORT" --listen "127.0.0.1:$MAIL_UI_PORT" >"$WORK/mailpit.log" 2>&1 &
PIDS+=("$!")

pocketbase superuser upsert test-admin@example.com test-admin-password --dir "$WORK/pb_data" >/dev/null
pocketbase serve \
  --dir "$WORK/pb_data" \
  --hooksDir "$ROOT/pb_hooks" \
  --publicDir "$ROOT/pb_public" \
  --http "127.0.0.1:$PB_PORT" >"$WORK/pocketbase.log" 2>&1 &
PIDS+=("$!")

wait_for "http://127.0.0.1:$PB_PORT/api/health"
wait_for "http://127.0.0.1:$MAIL_UI_PORT/api/v1/info"

export PB_URL="http://127.0.0.1:$PB_PORT"
export PB_ADMIN_EMAIL="test-admin@example.com"
export PB_ADMIN_PASSWORD="test-admin-password"
export PB_SCHEMA="$ROOT/pb_schema.json"
export MAILPIT_URL="http://127.0.0.1:$MAIL_UI_PORT"
export MAILPIT_SMTP_PORT="$SMTP_PORT"

if [ "$#" -gt 0 ]; then FILES=("$@"); else FILES=("$ROOT"/tests/*.test.mjs); fi

status=0
node --test --test-concurrency=1 "${FILES[@]}" || status=$?
if [ "$status" -eq 0 ] && [ "$E2E" -eq 1 ]; then
  echo "--- Browser-Durchlauf ---"
  node "$ROOT/tests/e2e.mjs" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "--- Browser-Durchlauf Lieferschein-Erfassung ---"
    node "$ROOT/tests/e2e-scanner.mjs" || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    echo "--- Browser-Durchlauf Moodle-Import ---"
    node "$ROOT/tests/e2e-moodle.mjs" || status=$?
  fi
fi
if [ "$status" -ne 0 ]; then
  echo "--- pocketbase.log (letzte 40 Zeilen) ---" >&2
  tail -n 40 "$WORK/pocketbase.log" >&2
fi
exit "$status"
