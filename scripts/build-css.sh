#!/usr/bin/env bash
# Erzeugt pb_public/assets/app.css aus tailwind/app.src.css (Tailwind Standalone CLI, kein npm).
# Voraussetzung: `tailwindcss` (v4.3.3) im PATH.
#
#   scripts/build-css.sh           # einmalig, minifiziert (vor jedem Commit von UI-Änderungen)
#   scripts/build-css.sh --watch   # während der Entwicklung
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED="4.3.3"

if ! command -v tailwindcss >/dev/null; then
  echo "tailwindcss nicht im PATH (benötigt v$REQUIRED)." >&2
  exit 1
fi
version="$(tailwindcss --help 2>&1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
if [ "$version" != "v$REQUIRED" ]; then
  echo "Warnung: tailwindcss $version gefunden, festgelegt ist v$REQUIRED." >&2
fi

cd "$ROOT"
if [ "${1:-}" = "--watch" ]; then
  exec tailwindcss -i tailwind/app.src.css -o pb_public/assets/app.css --watch
fi
tailwindcss -i tailwind/app.src.css -o pb_public/assets/app.css --minify
