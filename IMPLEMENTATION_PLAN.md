# Implementierungsplan

> Stand: 2026-11-09. Phase 1 abgenommen; Go-Live erfolgt; Phase 2 und 3 als Beta (Abnahme nach Erprobung im Betrieb). Nächster Schritt: Phase 4.
>
> Phasenweise arbeiten, nach jeder Phase Feedback einholen. Kein JS-Build (kein npm/Vite/Webpack); einzige Ausnahme ist der CSS-Build mit dem Tailwind Standalone CLI. Vorgaben: `ARCHITECTURE.md`, `pb_schema.json`, `CLAUDE.md`.

---

## Phase 1: Fundament, Server-Logik & Kern-UI (Branch `phase-1-core`)

### 1a – Schema & Server
1. `pb_schema.json` erweitern: `orders.shipping_cost`, `orders.invoice_total`, `order_items.qty_cancelled`, neue Collections `deliveries` und `delivery_items`; `order_items.moodle_entry_ids` entfernen; API-Rules laut ARCHITECTURE Kap. 2; OTP 10 min + deutsche Mail.
2. `pb_hooks/`: Routen `POST /api/lab/cart-items`, `POST /api/lab/orders/{id}/status`, `POST /api/lab/orders/{id}/deliveries`; Record-Hooks (`created_by`, Status-Neuberechnung nach Positionsänderung). Alles transaktional.
3. `tests/` (`node --test`, nur eingebaute Module): Merge (gleiche Nummer, zwei Gruppen), gleichzeitige Adds, `other` je Shop-Name, Status-Kette inkl. „zurück“, Auto-Lieferstatus mit Storno, Lieferbuchung inkl. Gegenbuchung, gesperrte Direktzugriffe.
4. `scripts/dev-server.sh`: Test-Instanz mit `pb_data` außerhalb von Dropbox, Mailpit als SMTP.

### 1b – Frontend
1. `scripts/fetch-vendor.sh` + `pb_public/vendor/` (Alpine.js 3.17.5, PocketBase JS SDK 0.28.1); `scripts/build-css.sh` + `tailwind/app.src.css` (Tailwind Standalone CLI 4.3.3).
2. `index.html` (App-Shell, Navigation *Bestellungen*, *Gruppen/Projekte*, *Logout*, Hash-Router), `core/pb.js`, `core/api.js`, `core/config.js`, `core/plugin-registry.js`.
3. Views:
   * **Login:** zweistufig (E-Mail → Code), Hinweis bei fehlendem Code.
   * **Dashboard:** Bestellungen mit Filter nach Status, Lieferant, Gruppe; Fortschritt je Bestellung; Position manuell erfassen (Hinweis „Shop-Bestellnummer“); Slot `dashboard-actions`; Realtime-Aktualisierung.
   * **Bestell-Detail:** Positionen mit `group_allocation_note`, Bestellt / Geliefert / Storniert / Rückstand; Lieferbuchung (Eingabe, „+1“, „Rest komplett“); Lieferhistorie; Storno-Menge; Positionen bearbeiten laut ARCHITECTURE 4.3; Status-Buttons inkl. „Einen Schritt zurück“; Versandkosten, Netto/Brutto, Rechnungsbetrag; Anhänge hochladen/löschen; Slot `order-detail-actions`.
   * **Gruppen/Projekte:** Gruppen je Veranstaltung + Semester anlegen/bearbeiten/aktiv schalten (Vorschläge für die Veranstaltung, Semesterauswahl WS/SS + Jahr); je Gruppe ihre Positionen mit Bestellstatus und Rückstand.

### 1c – Doku
`docs/DEPLOYMENT.md`: Uberspace-Dienst (supervisord), Deploy von `pb_public/` + `pb_hooks/`, Schema-Import, SMTP, Backups von `pb_data`, Update-Vorgehen.

**Akzeptanzkriterien:** Login per OTP (über Mailpit) funktioniert; zwei Bauteile mit gleicher Artikelnummer für zwei Gruppen landen im selben Sammelkorb als eine Position mit addierter Menge und Gruppen-Hinweis; Lieferbuchungen und Storno setzen den Status korrekt; alle Tests grün.

---

## Meilenstein: Go-Live (Phase 1 + Phase 2 als Beta)
1. Durchführung durch den Nutzer nach der Checkliste in `docs/DEPLOYMENT.md` (Kap. 0); Login-Mails über ein Postfach auf Uberspace.
2. Härtung: Rate-Limiting aktiv, Proxy-Header für die Client-IP, MFA für den Admin, Backups geprüft.
3. Erste Labor-Nutzer und Gruppen anlegen, Probebetrieb. Bestellwünsche bis Phase 3 von Hand erfassen.
4. Erfahrungen aus dem Probebetrieb (inkl. Scanner-Beta mit echten Lieferscheinen) als Rückmeldung für die folgenden Phasen sammeln.

---

## Phase 2: Lieferschein-Erfassung (Branch `phase-2-delivery-scanner`)

**Status:** als **Beta** in `main` und im Go-Live enthalten (in der App gekennzeichnet); endgültige Abnahme nach dem Test mit echten Handyfotos.
1. ✔ Ansatz evaluiert und entschieden: Browser-OCR (Tesseract.js) mit Entzerrung (jscanify/OpenCV.js), Beleg als PDF.
2. ✔ `modules/delivery-scanner/` in den Slots `order-detail-actions` und `dashboard-actions` (Details ARCHITECTURE Kap. 6), Profile Reichelt, TME, Würth Elektronik.
3. ✔ Unit-Tests (Abgleich, PDF) und Browser-Test mit synthetischem, schräg fotografiertem Beleg.
4. ✔ **Problem melden:** fehlgeschlagene Erkennungen landen mit Originalfotos und OCR-Ergebnis in `scan_reports`, Mail mit Link an die Superuser; Abholen zur Analyse mit `scripts/fetch-scan-reports.mjs` (löscht danach auf dem Server).
5. ✔ **Positionen nachtragen** (11/2026): nicht zugeordnete Lieferschein-Zeile als vergessene Position nachtragen und mitbuchen; ebenso in der Detailansicht; gekennzeichnet (ARCHITECTURE Kap. 4.5).
6. ✔ **Lieferscheine ohne Bestellung** (11/2026): Bestellung aus dem Lieferschein anlegen (Nummer oder ausdrücklich ohne) bzw. ohne Profil in die Ablage „Lieferscheine ohne Bestellung“ legen und später zuordnen (ARCHITECTURE Kap. 4.6). Profile verbessert („3ST“).
7. Offen:
   * Gemeldete Lieferscheine auswerten und Erkennung/Profile nachbessern (erste Auswertung 11/2026: TME und Würth ohne Profil, OCR gut; daraus die Zuordnung über die interne Bestellnummer).
   * Test mit echten Handyfotos **im Labor** (Labor ist nicht vor Ort; später). Dafür die Dev-Instanz im WLAN erreichbar machen (Option für `scripts/dev-server.sh`, noch nicht umgesetzt) oder nach dem Go-Live direkt auf Uberspace testen.
   * Profile für Mouser, Farnell, Voelkner, sobald Beispielbelege vorliegen (am einfachsten per „Problem melden“).
   * TME und Würth sind nur an je einem echten Beleg geprüft (11/2026); weitere Meldungen abwarten.

## Phase 3: Moodle-Import (Branch `phase-3-moodle-import`)

**Status:** als **Beta** umgesetzt (in der App gekennzeichnet); Abnahme nach dem ersten echten Import.
1. ✔ Beispiel-CSV ausgewertet (11/2026): keine Bezeichnung → **Bezeichnung überall optional**; Gruppe steht in der Spalte „Gruppe“ (bei von Dozenten angelegten Einträgen fehlerhaft → von Hand zuweisen).
2. ✔ `modules/moodle-import/` (Papa Parse 5.7.0 aus `vendor/`) im Slot `dashboard-actions`: Datei, Zuordnung (Veranstaltung/Semester, Spalten, Lieferanten, Gruppen), Vorschau.
3. ✔ **Interaktive Gruppenzuweisung** mit markiertem Vorschlag bei gleichnamiger Gruppe; Zuweisung je Zeile möglich.
4. ✔ Hinweise auf offenen Korb und Dubletten; Buchen über `POST /api/lab/cart-items/batch` (alles oder nichts, inkl. neuer Gruppen).
5. ✔ Tests: Route (Rollback, Zeilennummern), CSV-Auswertung, Browser-Durchlauf mit synthetischer CSV.
6. Offen: erster echter Import im Semesterbetrieb; ggf. Moodle-Formular um „Bezeichnung“ ergänzen (wird automatisch erkannt).

## Phase 4: Shop-Export (Branch `phase-4-shop-export`)
1. ✔ Formate für **Mouser, Reichelt und TME** an den CSV-Uploads der Shops verifiziert (Vorlagen + Test-Uploads, 11/2026); Farnell und Voelkner vorerst nicht. Entscheidung: **nur CSV**, kein Copy & Paste.
2. ✔ `modules/shop-export/shop-exporter.js` + `formats.js` im Slot `order-detail-actions`: Vorschau und CSV-Download (Menge = `qty_ordered − qty_cancelled`), Formate in ARCHITECTURE Kap. 6.
3. ✔ Button „Exportiert & auf ‚Bestellt‘ setzen“ (mit interner Bestellnummer, optional `supplier_order_no`) über die Status-Route; angehalten, wenn sich der Warenkorb seit dem Download geändert hat.
4. Tests: `tests/shop-export.test.mjs` (Formate), `tests/e2e-shop-export.mjs` (Browser).

## Phase 5: Word-Export (Branch `phase-5-word-export`)
1. Vorab: `.docx`-Vorlage der Hochschule beschaffen.
2. `modules/word-export/docx-generator.js` (PizZip + docxtemplater aus `vendor/`) im Slot `order-detail-actions`; Zusatzfelder in `orders.custom_fields`; Platzhalter u. a. `{supplier}`, `{total_net}`, `{total_gross}`, `{shipping_cost}`, Loop `{#items}…{/items}`.

## Phase 6: Prüfung der Bestellnummern (Branch `phase-6-part-number-check`)
1. Vorab: Formatregeln der Shop-Bestellnummern zusammentragen und mit dem Nutzer abstimmen (z. B. Mouser `NNN-…`); klären, ob Online-Abfragen bei den Shops gewünscht/zulässig sind.
2. `modules/part-number-check/` im Slot `order-detail-actions` (und als Prüfschritt im Moodle-Import nutzbar): auffällige Nummern markieren, Korrekturvorschläge interaktiv bestätigen.

## Phase 7: Zugriff für Claude Code per MCP (Branch `phase-7-mcp`)
1. Datengrundlage: Es werden nur Bestelldaten und Daten der Labor-Nutzer übermittelt. Labor-Nutzer (Name, E-Mail) sind öffentlich (Homepage der TH); Daten von Studierenden werden im System gar nicht gespeichert (Gruppen ohne Kontaktfeld). Belege und Anhänge werden nur als Dateiname genannt, nicht inhaltlich übertragen.
2. Dienst-Nutzer „KI-Assistent“ in `users`; langlebiges Token wird vom Admin ausgestellt (Impersonate) und ist durch Zurücksetzen des `tokenKey` sofort widerrufbar. Es gelten dieselben API-Rules; Ersteller/Bucher ist sichtbar „KI-Assistent“.
3. MCP-Server als Route `/mcp` in `pb_hooks` (Streamable HTTP, JSON-RPC: `initialize`, `tools/list`, `tools/call`), Authentifizierung per `Authorization`-Header.
4. Werkzeuge – lesend: Bestellungen suchen/anzeigen, Rückstände je Gruppe/Veranstaltung, Kosten einer Bestellung, Gruppen auflisten; schreibend: Position in den Sammelkorb legen (über die vorhandene Transaktionslogik), Notiz setzen. **Nicht** enthalten: Lieferungen buchen, Status ändern, Löschen (Schutz vor manipulierten Eingaben, z. B. aus Moodle-Daten).
5. Einrichtung in Claude Code dokumentieren (`claude mcp add --transport http …` mit Header) in `docs/DEPLOYMENT.md`.
6. Tests: Protokoll-Handshake, Werkzeugliste, Rechte (ohne/mit ungültigem Token), Schreibwerkzeuge nur im erlaubten Umfang, keine Dateiinhalte in Antworten.

## Phase 8: Lager (Branch `phase-8-stock`, Entscheidungen 11/2026, Umsetzung nach den übrigen Phasen)
1. **Was ins Lager kommt:** der Anteil einer Position ohne Gruppe – also „ohne Gruppe“ zugeordnete Mengen und was über den Bedarf der Gruppen hinaus bestellt wurde (bestellt > Σ Gruppenanteile).
2. **Wann:** bei **jeder Lieferbuchung**. Bei Teillieferungen gilt **Gruppen zuerst**: die gelieferte Menge deckt zunächst den Bedarf der Gruppen, erst was darüber hinausgeht, kommt ins Lager. Korrekturbuchungen (negativ) nehmen zuerst aus dem Lager zurück.
3. **Datenmodell:** Lagerartikel und Lagerbewegungen als Journal (Zugang aus Lieferung, Entnahme für Gruppe, Korrektur) mit Herkunft und Nutzer; Bestand = Summe der Bewegungen – nachvollziehbar wie bei den Lieferungen.
4. **Funktionen:** Bestandsübersicht mit Suche (Bestand, Herkunft, Verlauf); **Entnahme für eine Gruppe**, erscheint im Projekt-Status der Gruppe. Lagerort, Mindestbestand und Hinweis beim Erfassen vorerst nicht.
5. Offen bei Umsetzung: Zuordnung gleicher Artikel verschiedener Lieferanten (Bestellnummer je Shop), Umgang mit bestehendem Bestand bei Einführung.
