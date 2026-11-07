#!/usr/bin/env bash
# Lädt die festgelegten Bibliotheksversionen nach pb_public/vendor/<name>@<version>/
# und prüft sie gegen pb_public/vendor/SHA256SUMS.
#
#   scripts/fetch-vendor.sh            # laden + prüfen
#   scripts/fetch-vendor.sh --update   # laden + SHA256SUMS neu schreiben (nach Versionswechsel)
#
# Neue Version: Eintrag unten ändern, mit --update ausführen, Diff prüfen, committen.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/pb_public/vendor"
SUMS="$VENDOR/SHA256SUMS"

# <npm-paket>@<version>  <pfad-im-paket>
FILES=(
  "alpinejs@3.17.5     dist/module.esm.js"
  "pocketbase@0.28.1   dist/pocketbase.es.mjs"
  "pocketbase@0.28.1   dist/pocketbase.es.mjs.map"
)

mkdir -p "$VENDOR"
for entry in "${FILES[@]}"; do
  read -r pkg path <<<"$entry"
  target="$VENDOR/$pkg/$path"
  mkdir -p "$(dirname "$target")"
  curl -fsSL "https://cdn.jsdelivr.net/npm/$pkg/$path" -o "$target"
  echo "geladen: $pkg/$path"
done

cd "$VENDOR"
if [ "${1:-}" = "--update" ]; then
  find . -type f ! -name SHA256SUMS -printf '%P\n' | sort | xargs -d '\n' sha256sum > SHA256SUMS
  echo "SHA256SUMS neu geschrieben – Änderungen vor dem Commit prüfen."
else
  sha256sum --check --quiet SHA256SUMS
  echo "Prüfsummen OK."
fi
