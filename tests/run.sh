#!/usr/bin/env bash
# Startet eine frische, temporäre PocketBase-Instanz (+ Mailpit) und führt die Tests aus.
# Voraussetzungen im PATH: pocketbase, mailpit, node (≥ 20). Kein npm.
#
#   tests/run.sh                 # alle Tests
#   tests/run.sh tests/x.test.mjs
#   tests/run.sh --e2e           # zusätzlich Browser-Durchläufe (headless Chrome, tests/e2e*.mjs)
#   tests/run.sh --changed [ref] # nur die zu den Änderungen passenden Tests (gegenüber dem Abzweig von main
#                                # bzw. [ref], inkl. nicht committeter Dateien; Zuordnung in tests/select.mjs)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Browser-Durchläufe in fester Reihenfolge: Datei (ohne .mjs) → Überschrift
E2E_ALL=(e2e e2e-scanner e2e-camera e2e-moodle e2e-shop-export e2e-favorites)
declare -A E2E_TITLE=(
  [e2e]="Browser-Durchlauf"
  [e2e-scanner]="Browser-Durchlauf Lieferschein-Erfassung"
  [e2e-camera]="Browser-Durchlauf Kamera im Scanner"
  [e2e-moodle]="Browser-Durchlauf Moodle-Import"
  [e2e-shop-export]="Browser-Durchlauf Shop-Export"
  [e2e-favorites]="Browser-Durchlauf Favoriten"
)

CHANGED=0
E2E_RUN=()
UNIT_FILES=()
if [ "${1:-}" = "--e2e" ]; then
  E2E_RUN=("${E2E_ALL[@]}"); shift
elif [ "${1:-}" = "--changed" ]; then
  CHANGED=1; shift
  selection="$(node "$ROOT/tests/select.mjs" "${1:-}")"
  read -r -a UNIT_FILES <<<"$(sed -n 's/^UNIT *//p' <<<"$selection")"
  read -r -a E2E_RUN <<<"$(sed -n 's/^E2E *//p' <<<"$selection")"
  for i in "${!UNIT_FILES[@]}"; do UNIT_FILES[$i]="$ROOT/tests/${UNIT_FILES[$i]}"; done
  echo "Auswahl: ${#UNIT_FILES[@]} Unit-Testdatei(en), Browser: ${E2E_RUN[*]:-keine}"
  if [ "${#UNIT_FILES[@]}" -eq 0 ] && [ "${#E2E_RUN[@]}" -eq 0 ]; then
    echo "Nichts zu testen."
    exit 0
  fi
  set --
fi

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
  --migrationsDir "$ROOT/pb_migrations" --automigrate=false \
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

# Unit-Tests: ausdrücklich genannte Dateien, sonst die Auswahl (--changed), sonst alle
if [ "$#" -gt 0 ]; then FILES=("$@")
elif [ "$CHANGED" -eq 1 ]; then FILES=("${UNIT_FILES[@]}")
else FILES=("$ROOT"/tests/*.test.mjs); fi

status=0
if [ "${#FILES[@]}" -gt 0 ]; then
  node --test --test-concurrency=1 "${FILES[@]}" || status=$?
fi
for suite in "${E2E_RUN[@]}"; do
  [ "$status" -eq 0 ] || break
  echo "--- ${E2E_TITLE[$suite]} ---"
  node "$ROOT/tests/$suite.mjs" || status=$?
done
if [ "$status" -ne 0 ]; then
  echo "--- pocketbase.log (letzte 40 Zeilen) ---" >&2
  tail -n 40 "$WORK/pocketbase.log" >&2
fi
exit "$status"
