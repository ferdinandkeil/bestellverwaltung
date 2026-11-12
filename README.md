# Labor-Bestellsystem

Browserbasierte Verwaltung von Laborbestellungen (Elektronik, Verbrauchsmaterial, Geräte) für die Lehre an einer Hochschule:
Bestellwünsche von Studierenden-Gruppen werden je Lieferant in **Sammel-Warenkörben** zusammengeführt, bestellt,
beim Wareneingang gebucht – per Hand oder per **Foto des Lieferscheins** – und bis zur Abrechnung verfolgt.
Optimiert für die Nutzung am Smartphone am Auspacktisch im Labor.

## Funktionen

| Bereich | Stand |
|---|---|
| **Login** passwortlos per E-Mail-Code, lange Sitzungen | ✔ |
| **Sammel-Warenkorb** je Lieferant (Mouser, Farnell, Reichelt, Voelkner, sonstige je Shop): gleiche Bestellnummern werden zu einer Position zusammengeführt, mit Aufteilung auf Gruppen („Gruppe A: 5x \| Gruppe B: 3x“) | ✔ |
| **Status-Workflow** angefragt → bestellt → teilgeliefert → geliefert → geprüft → abgerechnet; Lieferstatus automatisch aus den Buchungen | ✔ |
| **Lieferbuchungen** mit Historie und Beleg, Schnellbuttons „+1“ / „Rest komplett“, Korrektur per Gegenbuchung, Storno je Position | ✔ |
| **Gruppen** je Veranstaltung und Semester, Projekt-Status je Gruppe | ✔ |
| **Kosten** netto/brutto, Versand, Rechnungsbetrag | ✔ |
| **Lieferschein-Erfassung**: Foto → Entzerrung → Texterkennung → Abgleich mit der Bestellung → Buchung mit PDF-Beleg; vergessene Positionen nachtragen; ohne passende Bestellung daraus eine Bestellung anlegen oder ablegen; komplett im Browser, keine Daten an Dritte | Beta (Profile Reichelt, TME, Würth) |
| **Moodle-CSV-Import** mit interaktiver Gruppenzuweisung, Vorschau und Buchung nach „alles oder nichts“ | Beta |
| Shop-Export (Copy & Paste / CSV für die Schnellbestellung) | geplant (Phase 4) |
| Word-Export für Beschaffungsformulare | geplant (Phase 5) |
| Prüfung der Bestellnummern | geplant (Phase 6) |
| Zugriff für Claude Code per MCP | geplant (Phase 7) |
| Lager für Bauteile ohne Gruppe (Zugang bei Lieferung, Entnahme für Gruppen) | geplant (Phase 8) |

## Technik in Kürze

- **Backend:** [PocketBase](https://pocketbase.io) (eine Binary, SQLite). Geschäftslogik, die mehrere Datensätze ändert
  (Sammel-Warenkorb, Lieferbuchungen, Status), läuft serverseitig und transaktional in `pb_hooks/`; API-Rules verhindern direkte Schreibzugriffe auf diese Felder.
- **Frontend:** native ES-Module mit Alpine.js, **ohne JS-Build**. Einzige Ausnahme ist der CSS-Build mit dem Tailwind Standalone CLI.
- **Bibliotheken** selbst gehostet mit fester Version und Prüfsummen (`pb_public/vendor/`) – keine CDN-Aufrufe zur Laufzeit.
- **Lieferschein-Erfassung:** OpenCV.js + jscanify (Entzerrung), Tesseract.js (OCR), unscharfer Abgleich, eigener kleiner PDF-Schreiber.
- **Tests:** `node --test` ohne npm gegen eine frische PocketBase-Instanz, plus Browser-Durchläufe in headless Chrome.

Details: [`ARCHITECTURE.md`](ARCHITECTURE.md) (verbindliche Entscheidungen), [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (Phasen),
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Betrieb auf Uberspace, Go-Live-Checkliste), [`pb_schema.json`](pb_schema.json) (Datenmodell).

## Lokal starten

Voraussetzungen im `PATH`: [`pocketbase`](https://github.com/pocketbase/pocketbase/releases) (v0.40.6),
[`mailpit`](https://github.com/axllent/mailpit/releases), `node` (≥ 20), für UI-Änderungen
[`tailwindcss`](https://github.com/tailwindlabs/tailwindcss/releases) (Standalone CLI v4.3.3), für die Browser-Tests Google Chrome.

```bash
scripts/dev-server.sh                                   # App http://127.0.0.1:8090, Mails http://127.0.0.1:8025
scripts/dev-server.sh add-user name@example.com "Name"  # Labor-Nutzer anlegen, Login-Code erscheint in Mailpit
tests/run.sh                                            # Server- und Unit-Tests
tests/run.sh --e2e                                      # zusätzlich Browser-Durchläufe
scripts/build-css.sh                                    # CSS nach UI-Änderungen neu erzeugen
```

## Entstehung

Dieses Projekt ist mit KI-Unterstützung entstanden:

- **Vorgaben zur Funktionalität und Architekturentscheidungen:** Ferdinand Keil.
- **Ausarbeitung des ursprünglichen Plans** (erste Fassungen von `ARCHITECTURE.md` und `IMPLEMENTATION_PLAN.md`): Gemini Argon.
- **Gesamter Code, Tests und Dokumentation** sowie die Überarbeitung des Plans auf Basis der getroffenen Entscheidungen: Claude Opus 5.5 (Claude Code).

## Lizenz

Eigener Code: [MIT](LICENSE). Mitgelieferte Bibliotheken unter ihren jeweiligen Lizenzen (MIT, Apache-2.0) – siehe
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
