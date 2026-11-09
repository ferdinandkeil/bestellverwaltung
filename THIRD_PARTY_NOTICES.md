# Fremdsoftware

Der eigene Code dieses Projekts steht unter der MIT-Lizenz (`LICENSE`). Unter `pb_public/vendor/` werden
folgende Bibliotheken unverändert mit ausgeliefert (feste Versionen, geladen über `scripts/fetch-vendor.sh`,
Prüfsummen in `pb_public/vendor/SHA256SUMS`). Die Lizenztexte liegen jeweils neben den Dateien.

| Bibliothek | Version | Lizenz | Urheber | Lizenztext |
|---|---|---|---|---|
| Alpine.js | 3.17.5 | MIT | Caleb Porzio and contributors | unten in dieser Datei (nicht im npm-Paket enthalten) |
| PocketBase JavaScript SDK | 0.28.1 | MIT | Gani Georgiev | `vendor/pocketbase@0.28.1/LICENSE.md` |
| jscanify | 1.4.3 | MIT | ColonelParrot | `vendor/jscanify@1.4.3/LICENSE` |
| OpenCV.js (Build von @techstark/opencv-js) | 5.0.0-release.1 | Apache-2.0 | OpenCV team / TechStark | `vendor/@techstark/opencv-js@5.0.0-release.1/LICENSE` |
| Tesseract.js | 7.0.0 | Apache-2.0 | Tesseract.js contributors | `vendor/tesseract.js@7.0.0/LICENSE.md`; mitgebündelte Abhängigkeiten (u. a. buffer/ieee754, regenerator-runtime, zlib.js – MIT/BSD-3-Clause) in `dist/*.LICENSE.txt` |
| tesseract.js-core (Tesseract OCR als WebAssembly) | 7.0.0 | Apache-2.0 | Tesseract.js contributors, Tesseract OCR authors | `vendor/tesseract.js-core@7.0.0/LICENSE` |
| Sprachdaten deu/eng (tessdata_best, int) | 4.0.0 | Apache-2.0 (Daten des Tesseract-OCR-Projekts; npm-Paketierung @tesseract.js-data unter MIT) | Tesseract OCR authors | Apache-2.0, siehe Lizenztext von tesseract.js-core |
| Papa Parse | 5.7.0 | MIT | Matthew Holt | `vendor/papaparse@5.7.0/LICENSE` |

Keines der Apache-2.0-Pakete enthält eine NOTICE-Datei.

Zur Laufzeit wird zusätzlich **PocketBase** (MIT, Gani Georgiev) als Server verwendet; die Binary ist nicht Teil dieses Repositorys.
Für den CSS-Build wird das **Tailwind CSS Standalone CLI** (MIT, Tailwind Labs) verwendet; das erzeugte `pb_public/assets/app.css` enthält Teile von Tailwind CSS (MIT).

---

## Lizenztext Alpine.js

# MIT License

Copyright © 2019-2025 Caleb Porzio and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
