# CLAUDE.md – Labor-Bestellsystem

Maßgebliche Projektdokumente: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `pb_schema.json`.

## Grundregeln für die Zusammenarbeit

1. **Fragen statt Annahmen treffen.** Wenn etwas in den Dokumenten unklar, widersprüchlich oder nicht spezifiziert ist, wird nachgefragt, bevor implementiert wird. Das gilt besonders bei Problemen (z. B. technische Hindernisse, Inkompatibilitäten, fehlgeschlagene Tests oder blockierte Aktionen): erst das Problem schildern und Optionen nennen, nicht eigenmächtig umgehen.
2. **Sauberes Design statt schneller Lösungen.** Keine Workarounds, Hacks oder Abkürzungen, die der Architektur widersprechen oder später aufgeräumt werden müssen. Lieber die saubere Lösung vorschlagen und abstimmen.
3. **Vorschläge des Nutzers: erst Feedback, dann Umsetzung.** Macht der Nutzer einen Vorschlag, wird dieser zunächst bewertet (Vor-/Nachteile, Bedenken, Alternativen). Implementiert wird erst nach ausdrücklicher Bestätigung.

## Arbeitsweise laut Implementierungsplan

- Strikt phasenweise arbeiten; nach jeder Phase Feedback einholen, bevor die nächste beginnt.
- Kein JS-Build (kein `package.json`, kein npm/Vite/Webpack). Alle Frontend-JS-Dateien als native ES6-Module unter `pb_public/`. Einzige Ausnahme: CSS-Build mit dem Tailwind Standalone CLI (`scripts/build-css.sh`); das erzeugte `pb_public/assets/app.css` wird mitcommittet.
- Geschäftslogik, die mehrere Datensätze konsistent ändert, gehört in `pb_hooks/` (transaktional), nicht ins Frontend.
- Nach Änderungen an `pb_hooks/` oder Schema: `tests/run.sh`; nach UI-Änderungen: `scripts/build-css.sh` und `tests/run.sh --e2e`.
- Feldnamen exakt wie in `pb_schema.json`.

## Git

- **Repository:** lokales Git-Repo im Projektordner. `pb_data/`, die PocketBase-Binary und lokale Testartefakte stehen in `.gitignore` und werden nie committet.
- **Branches:** pro Phase ein Feature-Branch (`phase-1-core`, `phase-2-delivery-scanner`, `phase-3-shop-export`, `phase-4-moodle-import`, `phase-5-word-export`, `phase-6-part-number-check`). In `main` wird erst nach Freigabe der Phase durch den Nutzer gemergt.
- **Commits:** selbstständig und kleinschrittig, nach jedem sinnvollen, in sich abgeschlossenen Schritt. Commit-Nachrichten auf Deutsch, kurz und aussagekräftig (was und warum).
- **Remote / Push:** gepusht wird nur auf ausdrückliche Anweisung. Keine History-Umschreibungen (force-push, rebase veröffentlichter Commits) ohne Rückfrage.

## Getroffene Entscheidungen

- **PocketBase-Version:** aktuelles PocketBase (≥ v0.23, wegen Email-OTP). `pb_schema.json` liegt im aktuellen Import-Format vor (getestet mit v0.40.6, Import über Admin-UI → Settings → Import collections). Die Auth-Einstellungen der `users` (OTP an, Passwort-Login aus, Token-Dauer 30 Tage) sind im JSON enthalten.
- **Bibliotheken:** selbst gehostet unter `pb_public/vendor/<name>@<version>/`, immer feste Version, nie `@latest`, keine CDN-Aufrufe zur Laufzeit.
- **Lieferant `other`:** pro `supplier_custom_name` ein eigener offener Sammel-Warenkorb (statt eines gemeinsamen `other`-Korbs).
- **Ein offener Korb – DB-seitig abgesichert:** Unique-Index `idx_orders_one_open_cart` auf `orders (supplier, supplier_custom_name COLLATE NOCASE) WHERE status = 'angefragt'`. `api.js` fängt den Konflikt ab und verwendet den vorhandenen Korb. Bei Lieferanten außer `other` ist `supplier_custom_name` leer.
- **Auto-Lieferstatus:** `recalculateOrderStatus` rechnet bei `bestellt`, `teilgeliefert` **und** `geliefert` neu (nachträgliche Korrekturen nach unten werden berücksichtigt). Ab `geprueft` keine automatische Änderung mehr.
- **Status zurück:** Button „Einen Schritt zurück“ mit Sicherheitsabfrage. Ein Zurücksetzen auf `angefragt` wird verweigert, wenn für den Lieferanten bereits ein anderer offener Korb existiert.
- **Kernlogik serverseitig** in PocketBase-Hooks (Merge, Status, Lieferbuchungen); `core/api.js` ist nur ein Client.
- **Lieferhistorie:** Collections `deliveries` + `delivery_items`; `qty_delivered` = Summe der Buchungen (nur Hook). Korrekturen per Gegenbuchung.
- **Storno:** `order_items.qty_cancelled`; Position erledigt, wenn geliefert + storniert ≥ bestellt.
- **Ab `bestellt` änderbar:** Mengen, Ersatzteil-Daten, Storno. Neue Positionen nur im offenen Korb.
- **Löschen von Bestellungen** nur im Status `angefragt` (sonst Admin).
- **Moodle-Import:** kein gespeicherter Import-Bezug (`moodle_entry_ids` entfällt); nur Warnung, wenn Artikelnummer + Gruppe schon im offenen Korb stehen.
- **Artikelnummer:** ein Feld, immer Shop-Bestellnummer. Ggf. später Prüf-/Korrektur-Plugin.
- **Gruppennamen in Allokationen:** Momentaufnahme, Umbenennungen werden nicht nachgezogen.
- **Kosten:** `orders.shipping_cost`, MwSt. 19 % berechnet, `orders.invoice_total` von Hand. Kein Backorder-Feld.
- **Login:** OTP-Mail deutsch, Gültigkeit 10 min, Hinweis in der Login-Maske; keine Selbstregistrierung.
- **Phasen-Reihenfolge:** 1 Kern → Go-Live → 2 Lieferschein-Erfassung (erst mit echten Belegen konzipieren) → 3 Shop-Export → 4 Moodle-Import → 5 Word-Export → 6 Prüfung der Bestellnummern.
- **Test-Mailserver:** Mailpit lokal.
- **Komplett storniert ohne Lieferung:** Status wird automatisch `geliefert` (bestätigt).
- **Gruppen:** gebunden an Veranstaltung (`course`, Freitext mit Vorschlägen aus bestehenden Gruppen) und Semester (Auswahl WS/SS + Jahr, Format `WS 2026/27` / `SS 2027`); Name eindeutig je Veranstaltung + Semester. In Positions-Hinweisen und Exporten nur der Gruppenname.
- **Moodle-Import:** Gruppen werden interaktiv zugewiesen (bestehende wählen oder neu anlegen), keine automatische Zuordnung.
- **Dashboard mobil:** Filter einklappbar, aktive Filter als Chips. Höchstens drei Toasts gleichzeitig.
- **Lieferschein-Erfassung (Phase 2):** OCR im Browser (Tesseract.js, selbst gehostet, keine externen Dienste). Entzerrung (jscanify + OpenCV.js) ist fester Bestandteil, da direkt aus der Web-App fotografiert wird. Bewertung am Reichelt-Beleg: mit Entzerrung 12/12 Positionen und Mengen korrekt (auch bei schrägem Foto), ohne Entzerrung 0/12. Echte Belege liegen in `samples/` (nie committen).
- **Beleg einer Lieferbuchung:** genau eine Datei. Der Scanner erzeugt im Browser ein PDF aus allen entzerrten Seiten (JPEG eingebettet, eigener kleiner PDF-Schreiber, keine Bibliothek). Limit 15 MB ≈ 30 Seiten.
