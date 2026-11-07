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

# <npm-paket>@<version>  <pfad-im-paket>  [<zielpfad unter vendor/>, Standard: <paket>@<version>/<pfad>]
FILES=(
  "alpinejs@3.17.5     dist/module.esm.js"
  "pocketbase@0.28.1   dist/pocketbase.es.mjs"
  "pocketbase@0.28.1   dist/pocketbase.es.mjs.map"
  # Lieferschein-Erfassung (werden erst beim Öffnen des Scanners geladen)
  "@techstark/opencv-js@5.0.0-release.1  dist/opencv.js"
  "jscanify@1.4.3                        src/jscanify.js"
  "tesseract.js@7.0.0                    dist/tesseract.esm.min.js"
  "tesseract.js@7.0.0                    dist/worker.min.js"
  "tesseract.js-core@7.0.0               tesseract-core-lstm.wasm.js"
  "tesseract.js-core@7.0.0               tesseract-core-simd-lstm.wasm.js"
  "tesseract.js-core@7.0.0               tesseract-core-relaxedsimd-lstm.wasm.js"
  # Tesseract.js erwartet alle Sprachdaten in einem Verzeichnis (langPath):
  "@tesseract.js-data/deu@1.0.0          4.0.0_best_int/deu.traineddata.gz  tessdata/4.0.0_best_int/deu.traineddata.gz"
  "@tesseract.js-data/eng@1.0.0          4.0.0_best_int/eng.traineddata.gz  tessdata/4.0.0_best_int/eng.traineddata.gz"
)

mkdir -p "$VENDOR"
for entry in "${FILES[@]}"; do
  read -r pkg path dest <<<"$entry"
  target="$VENDOR/${dest:-$pkg/$path}"
  mkdir -p "$(dirname "$target")"
  curl -fsSL "https://cdn.jsdelivr.net/npm/$pkg/$path" -o "$target"
  echo "geladen: $pkg/$path → ${dest:-$pkg/$path}"
done

cd "$VENDOR"
if [ "${1:-}" = "--update" ]; then
  find . -type f ! -name SHA256SUMS -printf '%P\n' | sort | xargs -d '\n' sha256sum > SHA256SUMS
  echo "SHA256SUMS neu geschrieben – Änderungen vor dem Commit prüfen."
else
  sha256sum --check --quiet SHA256SUMS
  echo "Prüfsummen OK."
fi
