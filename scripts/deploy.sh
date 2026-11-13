#!/usr/bin/env bash
# Deploy auf Uberspace (docs/DEPLOYMENT.md Kap. 3): Tests → pb_schema.json, pb_migrations/, pb_hooks/, pb_public/
# kopieren → Dienst neu starten (führt neue Migrationen aus) → prüfen, dass die Hooks geladen sind.
#
#   scripts/deploy.sh             # Tests, dann deployen
#   scripts/deploy.sh --dry-run   # nur anzeigen, was sich auf dem Server ändern würde
#   scripts/deploy.sh --no-tests  # ohne Tests (z. B. direkt nach einem grünen Lauf)
#
# Konfiguration: scripts/deploy.env (Vorlage: scripts/deploy.env.example; nicht im Repo).
# Hat sich pb_schema.json seit dem letzten Deploy geändert, hält das Skript an, damit vorher
# im Admin-UI ein Backup gezogen und das Schema importiert wird (Kap. 2.2).
# shellcheck disable=SC2029  # Variablen werden absichtlich lokal eingesetzt
# shellcheck disable=SC1111  # deutsche Anführungszeichen in Texten
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY=0
TESTS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-tests) TESTS=0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

[ -f scripts/deploy.env ] || { echo "scripts/deploy.env fehlt (Vorlage: scripts/deploy.env.example)." >&2; exit 2; }
# shellcheck source=/dev/null
source scripts/deploy.env
: "${DEPLOY_SSH:?DEPLOY_SSH fehlt in scripts/deploy.env}"
: "${DEPLOY_URL:?DEPLOY_URL fehlt in scripts/deploy.env}"
DEPLOY_DIR="${DEPLOY_DIR:-bestellverwaltung}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-bestellverwaltung}"
DEPLOY_URL="${DEPLOY_URL%/}"

step() { printf '\n==> %s\n' "$*"; }

# ---- Vorbedingungen ------------------------------------------------------------
[ "$(git branch --show-current)" = "main" ] || { echo "Nur von main deployen." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Arbeitsverzeichnis nicht sauber – erst committen." >&2; exit 1; }
REV="$(git rev-parse --short HEAD)"

if [ "$TESTS" -eq 1 ] && [ "$DRY" -eq 0 ]; then
  step "Tests"
  tests/run.sh
fi

step "Stand auf dem Server"
OLD_REV="$(ssh "$DEPLOY_SSH" "cat '$DEPLOY_DIR/DEPLOYED_REVISION' 2>/dev/null" || true)"
echo "deployt: ${OLD_REV:-unbekannt}  →  neu: $REV"

SCHEMA_CHANGED=1
if [ -n "$OLD_REV" ] && git cat-file -e "$OLD_REV^{commit}" 2>/dev/null; then
  git diff --quiet "$OLD_REV" HEAD -- pb_schema.json && SCHEMA_CHANGED=0
fi

RSYNC=(rsync -az --delete)
# Migrationen ohne --delete: auf dem Server liegen ggf. von PocketBase selbst erzeugte (bereits angewandte) Dateien.
RSYNC_KEEP=(rsync -az)
if [ "$DRY" -eq 1 ]; then
  RSYNC+=(--dry-run --itemize-changes)
  RSYNC_KEEP+=(--dry-run --itemize-changes)
fi

if [ "$DRY" -eq 1 ]; then
  step "Probelauf – Änderungen auf dem Server (nichts wird kopiert)"
  "${RSYNC[@]}" pb_schema.json "$DEPLOY_SSH:$DEPLOY_DIR/"
  "${RSYNC_KEEP[@]}" pb_migrations/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_migrations/"
  "${RSYNC[@]}" pb_hooks/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_hooks/"
  "${RSYNC[@]}" pb_public/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_public/"
  [ "$SCHEMA_CHANGED" -eq 1 ] && echo "Hinweis: Schema geändert (oder Stand unbekannt) – beim echten Deploy ist ein Import nötig."
  exit 0
fi

# ---- Schema zuerst (neue Hooks erwarten das neue Schema) ----------------------
step "Schema"
"${RSYNC[@]}" pb_schema.json "$DEPLOY_SSH:$DEPLOY_DIR/"
if [ "$SCHEMA_CHANGED" -eq 1 ]; then
  echo "pb_schema.json hat sich seit dem letzten Deploy geändert (oder der Stand ist unbekannt)."
  echo "Jetzt im Admin-UI ($DEPLOY_URL/_/):"
  echo "  1. Settings → Backups → Backup erstellen"
  echo "  2. Settings → Import collections → Inhalt von pb_schema.json → „Merge“ → Review → Confirm"
  read -r -p "Erledigt? Mit Enter fortfahren, Strg+C bricht ab. " _
else
  echo "unverändert – kein Import nötig."
fi

# ---- Code -------------------------------------------------------------------------
# Migrationen vor den Hooks: PocketBase startet bei Änderungen in pb_hooks/ ggf. selbst neu und führt
# dabei neue Migrationen aus – erst nach dem Schema-Import oben.
step "Migrationen, Hooks und Oberfläche"
"${RSYNC_KEEP[@]}" pb_migrations/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_migrations/"
"${RSYNC[@]}" pb_hooks/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_hooks/"
"${RSYNC[@]}" pb_public/ "$DEPLOY_SSH:$DEPLOY_DIR/pb_public/"

step "Neustart"
ssh "$DEPLOY_SSH" "supervisorctl restart '$DEPLOY_SERVICE'"

step "Prüfung"
for _ in $(seq 1 30); do
  curl -fsS "$DEPLOY_URL/api/health" >/dev/null 2>&1 && break
  sleep 1
done
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DEPLOY_URL/api/lab/cart-items")"
if [ "$CODE" != "401" ]; then
  echo "Hook-Prüfung: HTTP $CODE statt 401 – Hooks nicht geladen? Log: ssh $DEPLOY_SSH supervisorctl tail $DEPLOY_SERVICE stderr" >&2
  exit 1
fi
echo "Hooks geladen (401)."
ssh "$DEPLOY_SSH" "echo '$REV' > '$DEPLOY_DIR/DEPLOYED_REVISION'"
echo "Deploy von $REV abgeschlossen."
