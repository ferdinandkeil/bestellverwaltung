# Architektur & Technische Spezifikation: Labor-Bestellsystem

> Stand: 2026-11-08. Dieses Dokument ist die verbindliche Quelle für fachliche und technische Entscheidungen; neue Entscheidungen werden hier eingetragen.

## 1. System-Überblick & Leitprinzipien
* **Zweck:** Browserbasierte Verwaltung von Laborbestellungen (Elektronik, Verbrauchsmaterial, Geräte) inkl. Sammel-Warenkörben, Moodle-CSV-Import, Shop-Bestellexport, Word-Formular-Generator und (später) Lieferschein-Erfassung.
* **Backend:** PocketBase (Single Binary auf Uberspace, ≥ v0.23 wegen Email-OTP, getestet mit v0.40.6). `pb_schema.json` liegt im Importformat ab v0.23 vor (Admin-UI → Settings → Import collections) und enthält auch die Auth-Einstellungen der `users`. Liefert REST/Realtime-API, führt die serverseitige Geschäftslogik in `pb_hooks/` (JSVM, kein Build) aus und liefert das Frontend aus `pb_public/` aus.
* **Geschäftslogik serverseitig:** Alles, was mehrere Datensätze konsistent ändern muss (Sammel-Warenkorb-Merge, Lieferbuchungen, Status-Workflow), läuft in PocketBase-Hooks **innerhalb einer DB-Transaktion**. Das Frontend ruft dafür eigene Routen auf und schreibt diese Felder nie direkt (durch API-Rules erzwungen).
* **Frontend-Architektur („No-Bundler Reactive“):**
  * **Kein JS-Build:** Kein Node.js/npm, kein Vite/Webpack, kein Babel. Alle JS-Dateien in `pb_public/` sind native ES6-Module und direkt im Browser lauffähig.
  * **Einzige Ausnahme – CSS-Build:** TailwindCSS wird mit dem **Tailwind Standalone CLI** (einzelne Binary, v4.3.3, kein npm) aus `tailwind/app.src.css` zu `pb_public/assets/app.css` übersetzt. Das erzeugte CSS wird committet; ein Deploy ist reines Kopieren.
  * **Modularität:** Jedes Feature ist physisch in einer eigenen Datei isoliert, damit Module unabhängig voneinander erstellt und gewartet werden können.
  * **UI & Reaktivität:** **Alpine.js v3** (ESM-Build) für reaktives State-Management.
  * **Selbst gehostete Bibliotheken:** Alle Fremdbibliotheken liegen mit fester Version unter `pb_public/vendor/<name>@<version>/` (Datenschutz: keine IP-Übertragung an CDNs; Funktion auch bei schlechtem Labor-WLAN). `scripts/fetch-vendor.sh` lädt die festgelegten Versionen. Nie `@latest`.
  * **Mobile-First:** Smartphone-Nutzung am Auspack-Tisch im Labor.

## 2. Authentifizierung, Rollen & Sicherheit
1. **System-Admin (`_superusers`):** Ausschließlich über das PocketBase Admin-UI (`/_/`), Passwort + zweiter Faktor per E-Mail-Code (PocketBase-MFA; TOTP-Apps unterstützt PocketBase nicht). Legt Labor-Nutzer an.
2. **Labor-Nutzer (`users`):**
   * **Login:** Passwortlos per **Email-OTP** (`requestOTP(email)` → `authWithOTP(otpId, code)`). Passwort-Login deaktiviert. OTP-Gültigkeit **10 Minuten**, OTP-Mail **auf Deutsch** (beides in `pb_schema.json`). **Groß-/Kleinschreibung der Adresse ist egal:** PocketBase sucht das Konto exakt; findet es keins, sucht `pb_hooks/auth-hooks.pb.js` schreibweisenunabhängig. Der Index `idx_users_email_nocase` verhindert zwei Konten mit derselben Adresse in anderer Schreibweise.
   * **Keine Selbstregistrierung** (`createRule: null`). Für unbekannte Adressen verschickt PocketBase bewusst keinen Code (Schutz vor Konten-Ausspähung); die Login-Maske weist darauf hin: *„Kein Code erhalten? Ihr Konto muss vom Admin angelegt sein.“*
   * **Lange Sessions:** Auth-Token-Dauer 30 Tage (2592000 s); beim App-Start wird das Token per `authRefresh()` verlängert.
3. **Berechtigungen (API-Rules), Grundsatz „volle Transparenz im Labor“:** Alle eingeloggten Nutzer sehen alles. Einschränkungen:
   * `orders` löschen nur im Status `angefragt`; danach nur Admin.
   * `order_items` löschen nur im offenen Korb (`angefragt`); ab `bestellt` wird storniert statt gelöscht. Ab `geprueft` sind Positionen gesperrt.
   * `orders.status`, `order_items.qty_delivered`, `orders.created_by` sowie das Anlegen von `order_items`, `deliveries`, `delivery_items` sind per Rule für direkte Schreibzugriffe gesperrt und laufen ausschließlich über die Hook-Routen (Kap. 4).
   * `created_by` / `booked_by` werden serverseitig aus dem Auth-Kontext gesetzt (nicht fälschbar).
   * `deliveries` sind unveränderlich (kein Update/Delete für Nutzer); Korrekturen erfolgen per Gegenbuchung.
   * `unmatched_receipts` (Ablage „Lieferscheine ohne Bestellung“): für alle Labor-Nutzer sichtbar, anlegen im eigenen Namen, löschen erlaubt, nicht änderbar; Zuordnen nur über die Hook-Route (Kap. 4.6). `orders.origin` ist nicht von Hand änderbar.
   * `scan_reports` (Problem-Meldungen des Scanners): Labor-Nutzer dürfen nur **anlegen** (im eigenen Namen), lesen/löschen nur der Admin; Fotos sind geschützte Dateien.
   * PocketBase-Login-Alarm („Login from a new location“) ist deaktiviert, da er auf Passwörter verweist, die es nicht gibt.

## 3. Verzeichnisstruktur

```text
Projekt/
├── pb_schema.json                  # Collections im PocketBase-Importformat (≥ v0.23)
├── pb_hooks/                       # Serverseitige Geschäftslogik (PocketBase JSVM)
│   ├── routes.pb.js                # Registrierung der /api/lab/* Routen
│   ├── mcp.pb.js                   # MCP-Endpunkt /mcp für Claude Code (Phase 7, geplant)
│   ├── record-hooks.pb.js          # created_by setzen, Status nach Positionsänderung neu berechnen
│   ├── auth-hooks.pb.js            # Login-Code: Konto unabhängig von Groß-/Kleinschreibung finden
│   ├── scan-reports.pb.js          # Problem-Meldungen des Scanners: Validierung, Mail an Superuser
│   └── lib/
│       ├── cart.js                 # Sammel-Warenkorb-Merge
│       ├── import.js               # Sammel-Import mehrerer Positionen (alles oder nichts)
│       ├── late-items.js           # Positionen nachtragen (vergessen beim Erfassen)
│       ├── delivery-notes.js       # Bestellung aus Lieferschein, Ablage zuordnen
│       ├── deliveries.js           # Lieferbuchungen, qty_delivered-Summen
│       └── status.js               # Status-Workflow & Auto-Lieferstatus
├── pb_public/
│   ├── index.html                  # App-Shell, Hauptnavigation, Router
│   ├── assets/
│   │   ├── app.css                 # ERZEUGT aus tailwind/app.src.css (committet)
│   │   └── templates/              # Word-Vorlagen (.docx)
│   ├── vendor/                     # Selbst gehostete Bibliotheken mit fester Version
│   ├── core/
│   │   ├── ui.js                   # Toasts, Bestätigungen, Formatierung
│   │   ├── pb.js                   # PocketBase-Instanz, OTP-Login, Session-Handling
│   │   ├── api.js                  # Dünner Client für /api/lab/*-Routen + Lese-Abfragen
│   │   ├── config.js               # Konstanten (Lieferanten, Status, MwSt.-Satz 19 %)
│   │   └── plugin-registry.js      # Registry für Erweiterungsmodule (Slots)
│   ├── views/
│   │   ├── login-view.js
│   │   ├── dashboard-view.js
│   │   ├── order-detail-view.js
│   │   ├── groups-view.js
│   │   └── item-form.js            # Formular „Position erfassen“ (Dashboard + Detail)
│   └── modules/                    # Isolierte Erweiterungsmodule (über plugin-registry)
│       ├── shop-export/            # Shop-Export (Kap. 6)
│       │   ├── shop-exporter.js    # Oberfläche: Vorschau, CSV-Download, „Exportiert & bestellt“
│       │   └── formats.js          # CSV-Formate je Shop (reine Logik, getestet)
│       ├── moodle-import/          # Moodle-CSV-Import (Kap. 6)
│       │   ├── moodle-importer.js  # Oberfläche: Datei, Zuordnung, Vorschau, Buchung
│       │   └── moodle-csv.js       # Auswertung der CSV (reine Logik, getestet)
│       ├── word-export/
│       ├── delivery-scanner/       # Lieferschein-Erfassung (Kap. 6)
│       │   ├── scanner-modal.js    # Oberfläche: Aufnahme, Ecken, Prüfmaske, Buchung
│       │   ├── vision.js           # OpenCV.js + jscanify: Eckenerkennung, Entzerrung (lazy)
│       │   ├── ocr.js              # Tesseract.js deu+eng, normierte Wortkoordinaten (lazy)
│       │   ├── matcher.js          # Tabellenzeilen lesen, unscharfer Abgleich, Bestellung finden
│       │   ├── pdf.js              # JPEG-Seiten → PDF (ohne Bibliothek)
│       │   ├── report.js           # Problem-Meldung: Einschätzung „gescheitert“, Analyse-Daten
│       │   └── profiles/           # je Lieferant: Erkennung + Lesart der Tabelle (reichelt.js, tme.js, wuerth.js)
│       └── part-number-check/      # Prüfung der Bestellnummern (Kap. 6)
├── tailwind/app.src.css            # Tailwind-Quelle
├── scripts/
│   ├── build-css.sh                # Tailwind Standalone CLI → pb_public/assets/app.css
│   ├── fetch-vendor.sh             # Lädt festgelegte Bibliotheksversionen nach pb_public/vendor/
│   ├── dev-server.sh               # Lokale Test-Instanz (pb_data außerhalb von Dropbox)
│   └── fetch-scan-reports.mjs      # Scanner-Meldungen nach samples/scan-reports/ holen, dann auf dem Server löschen
├── tests/                          # siehe Kap. 8
│   ├── run.sh                      # frische PocketBase + Mailpit, dann node --test [--e2e]
│   ├── *.test.mjs                  # Server-, Rechte-, OTP- und Unit-Tests
│   ├── browser.mjs                 # CDP-Client für headless Chrome
│   ├── e2e.mjs, e2e-scanner.mjs    # Browser-Durchläufe App und Lieferschein-Erfassung
│   └── helpers.mjs
├── samples/                        # echte Belege zur Entwicklung – nie committen (.gitignore)
└── docs/DEPLOYMENT.md              # Uberspace-Betrieb, Deploy, Backup
```

## 4. Datenmodell & Kern-Geschäftslogik

### 4.1 Collections (Details: `pb_schema.json`)
* **`groups`:** `name`, **`course`** (Veranstaltung, Pflicht), `semester` (Pflicht, Format `WS 2026/27` bzw. `SS 2027`), `is_active`. **Bewusst keine Kontaktdaten von Studierenden** (kein Name/E-Mail-Feld) – es werden keine personenbezogenen Daten Studierender gespeichert. Der Gruppenname ist nur **innerhalb von Veranstaltung + Semester eindeutig** (Unique-Index `idx_groups_unique_name`, Groß-/Kleinschreibung egal). Bei der Eingabe werden bestehende Veranstaltungen vorgeschlagen; in Auswahllisten erscheinen Gruppen nach Veranstaltung/Semester gegliedert.
* **`orders`:** `supplier` (`mouser|farnell|reichelt|voelkner|other`), `supplier_custom_name` (nur bei `other`, sonst leer), **`internal_order_no`** (interne Bestellnummer der Hochschule, Format `JJJJIW#####`, z. B. `2026IW01047`; eindeutig, Pflicht ab „bestellt“, danach korrigierbar, aber nicht mehr leer; ältere Bestellungen ohne Nummer bleiben bearbeitbar), `supplier_order_no` (optionale Auftragsnummer des Shops), `status`, **`origin`** (`warenkorb` bzw. leer = normal über den Sammelkorb, `lieferschein` = aus einem Lieferschein angelegt, Kap. 4.6), `created_by`, `attachments`, `custom_fields` (JSON), `notes`, **`shipping_cost`** (netto), **`invoice_total`** (tatsächlicher Rechnungsbetrag brutto, von Hand bei der Abrechnung).
* **`order_items`:** `order`, `part_number`, `name` (**Bezeichnung, optional** – der Moodle-Export enthält keine; Formulare kennzeichnen sie als „empfohlen“, die Detailansicht zeigt „ohne Bezeichnung“), `url`, `qty_ordered`, `qty_delivered` (nur Hook), **`qty_cancelled`**, `price_unit` (netto), **`added_later_by`/`added_later_at`** (Kennzeichnung nachgetragener Positionen, Kap. 4.5), `groups`, `group_allocations` (JSON `[{groupId, groupName, qty}]`), `group_allocation_note` (z. B. `"Gruppe A: 5x | Gruppe B: 2x"`). `moodle_entry_ids` entfällt.
* **`deliveries`** (neu): `order`, `booked_by`, `note`, `receipt` (genau eine Datei, optional: Bild oder PDF; mehrseitige Belege als PDF, max. 15 MB ≈ 30 Seiten), `created`.
* **`delivery_items`** (neu): `delivery`, `order_item`, `qty` (ganzzahlig, ≠ 0; negativ = Korrektur-Gegenbuchung).
* **`unmatched_receipts`** (Ablage „Lieferscheine ohne Bestellung“): `supplier_name`, `internal_order_no` (falls auf dem Beleg erkannt, ungeprüft), `note`, `receipt` (eine Datei, PDF/Bild, max. 15 MB), `uploaded_by`, `created`.
* **`scan_reports`** (Problem-Meldungen der Lieferschein-Erfassung): `reported_by`, `order` (optional), `note`, `photos` (Originalfotos, JPEG ≤ 3200 px, geschützt, max. 30), `analysis` (JSON: Ecken automatisch/final, OCR-Wörter mit Koordinaten, gelesene Zeilen, Zuordnung, erkannte und eingetragene Mengen, erkannte Probleme; Format-Version `REPORT_VERSION` in `report.js`), `created`. Kurzlebig: werden nach dem Abholen auf dem Server gelöscht.

**Artikelnummer-Regel:** `part_number` ist **immer die Shop-Bestellnummer** des jeweiligen Lieferanten (z. B. `595-SN74HC595N` bei Mouser), nicht die Herstellernummer. Eingabemaske und Moodle-Formular weisen darauf hin. Gespeichert wird normalisiert: Großbuchstaben, außen getrimmt, mehrfacher bzw. „unsichtbarer“ Leerraum (Tabulator, geschützte Leerzeichen aus kopierten Texten) zu **einem** Leerzeichen zusammengefasst. Einzelne Leerzeichen bleiben, weil sie z. B. bei Reichelt zur Nummer gehören (`MKDS 1,5 3 5,08`). Der Sammelkorb vergleicht ebenfalls normalisiert, auch gegen ältere Positionen. Eine spätere Prüf-/Korrektur-Erweiterung ist als Modul denkbar.

**Gruppennamen in `group_allocations`/`group_allocation_note`** enthalten nur den Gruppennamen (ohne Veranstaltung) und sind eine Momentaufnahme zum Zeitpunkt der Erfassung; Umbenennungen werden nicht nachgezogen.

**Rückstand vom Lieferanten:** Kein eigenes Backorder-Feld; der Rückstand ergibt sich aus bestellt − geliefert − storniert.

**Kosten:** Netto = Σ (`qty_ordered − qty_cancelled`) × `price_unit` + `shipping_cost`; Brutto = Netto × 1,19 (Satz in `core/config.js`). `invoice_total` hält den tatsächlichen Betrag laut Rechnung.

### 4.2 Sammel-Warenkorb (Route `POST /api/lab/cart-items`)
1. Pro Lieferant existiert maximal **ein** offener Warenkorb (`status = "angefragt"`); bei `other` **einer je `supplier_custom_name`** (Groß-/Kleinschreibung egal). DB-seitig erzwungen durch den Unique-Index `idx_orders_one_open_cart`.
2. In einer Transaktion: offenen Korb suchen oder anlegen → Position mit gleicher normalisierter `part_number` suchen →
   * **nicht vorhanden:** neue Position anlegen;
   * **vorhanden (Merge):** `qty_ordered` += Menge; Gruppe zu `groups` hinzufügen; Eintrag in `group_allocations` erhöhen bzw. anlegen; `group_allocation_note` neu erzeugen. Name/URL/Preis werden nur ergänzt, wenn bisher leer.
3. Antwort: `{order, item, merged: bool}`.
4. **Sammel-Import** (Route `POST /api/lab/cart-items/batch`, Moodle-Import): `{groups: [{ref, name, course, semester}], items: [{line, …, group | groupRef}]}`. Legt neue Gruppen an und bucht jede Position nach 1.–2. – **alles oder nichts** in einer Transaktion; Fehler nennen die CSV-Zeile.

### 4.3 Status-Workflow
* Kette: `angefragt` → `bestellt` → `teilgeliefert` → `geliefert` → `geprueft` → `abgerechnet`.
* **Manuelle Schritte** (Route `POST /api/lab/orders/{id}/status`, `{action: "advance" | "back", internal_order_no?, supplier_order_no?}`):
  * `angefragt → bestellt` **nur mit interner Bestellnummer** (im Body oder vorher an der Bestellung eingetragen), optional mit `supplier_order_no`; der Korb ist damit für neue Positionen geschlossen, neue landen in einem neuen offenen Korb.
  * `geliefert → geprueft → abgerechnet`.
  * **„Einen Schritt zurück“** mit Sicherheitsabfrage im UI. Zurück auf `angefragt` wird verweigert, wenn bereits ein anderer offener Korb für den Lieferanten existiert.
* **Automatischer Lieferstatus** (bei `bestellt`, `teilgeliefert`, `geliefert`; ab `geprueft` keine Automatik), neu berechnet nach jeder Lieferbuchung und jeder Änderung von `qty_ordered`/`qty_cancelled`:
  * Eine Position gilt als **erledigt**, wenn `qty_delivered + qty_cancelled ≥ qty_ordered`.
  * Alle Positionen erledigt → `geliefert`.
  * Sonst: mindestens eine Position mit `qty_delivered > 0` → `teilgeliefert`.
  * Sonst → `bestellt`.
  * Folge: Eine komplett stornierte Bestellung ohne Lieferung wird automatisch `geliefert` (bewusst so festgelegt).
* **Rückstand** je Position = `qty_ordered − qty_delivered − qty_cancelled` (min. 0).
* **Änderungen ab `bestellt`:** `qty_ordered`, `part_number`/`name`/`url`/`price_unit` (Ersatzteil) und `qty_cancelled` bleiben änderbar (bis einschl. `geliefert`). Neue Positionen nur im offenen Korb.

### 4.4 Lieferbuchungen (Route `POST /api/lab/orders/{id}/deliveries`)
* Body: `lines: [{item, qty}]`, `note`, optional `receipt` (eine Datei, multipart; mehr als eine wird abgelehnt).
* In einer Transaktion: `deliveries` + `delivery_items` anlegen, `qty_delivered` jeder betroffenen Position = Σ `delivery_items.qty` neu berechnen (darf nicht < 0 werden), danach Auto-Lieferstatus.
* Schnellbuttons im UI („+1“, „Rest komplett“) erzeugen ebenfalls Buchungen; mehrere schnelle Klicks werden im UI kurz gesammelt, bevor gebucht wird.

### 4.5 Positionen nachtragen (Route `POST /api/lab/orders/{id}/items`)
* Für Ware, die bestellt, aber beim Erfassen vergessen wurde (typisch: auf dem Lieferschein entdeckt). Erlaubt in `bestellt`, `teilgeliefert`, `geliefert`; im offenen Korb wird normal erfasst, ab `geprueft` ist die Bestellung gesperrt.
* Neue Position mit bestellter Menge, Bezeichnung und Gruppe optional; eine schon vorhandene Bestellnummer wird abgelehnt (dort die Menge anpassen). Danach Auto-Lieferstatus (eine offene neue Position macht aus „geliefert“ wieder „teilgeliefert“).
* **Kennzeichnung:** `order_items.added_later_by` / `added_later_at`, serverseitig gesetzt und per Rule nicht änderbar; die Detailansicht zeigt „nachgetragen am … von …“.
* Die Lieferbuchung nimmt zusätzlich `newItems: [{part_number, name?, qty, group?}]` an: Positionen werden in derselben Transaktion nachgetragen und mit `qty` geliefert (Scanner, Option „gleich als geliefert buchen“ in der Detailansicht).

### 4.6 Lieferscheine ohne passende Bestellung
Für Muster, Direktkäufe oder am System vorbei bestellte Ware. Im Scanner, wenn keine Bestellung passt:
* **Bestellung aus Lieferschein anlegen** (Route `POST /api/lab/orders/from-delivery-note`, nur wenn ein Lieferanten-Profil erkannt wurde): Lieferant, interne Bestellnummer (falls auf dem Beleg) und Positionen sind vorbelegt und änderbar, Gruppe je Position optional. **Interne Bestellnummer angeben oder ausdrücklich „ohne interne Bestellnummer“ wählen** – nur bei dieser Herkunft ist eine Bestellung ab „bestellt“ ohne Nummer zulässig. In einer Transaktion: Bestellung (`status = bestellt`, `origin = lieferschein`), Positionen (gleiche Nummern zusammengefasst, bestellt = geliefert) und Lieferung mit dem Beleg-PDF → „geliefert“. Der offene Warenkorb des Lieferanten bleibt unberührt. Die Bestellung zeigt „aus Lieferschein angelegt“.
* **In Ablage legen** (ohne Profil nur diese Möglichkeit): Beleg-PDF mit Lieferant, ggf. Nummer und Notiz in `unmatched_receipts`. Das Dashboard zeigt den Abschnitt „Lieferscheine ohne Bestellung“, solange etwas abgelegt ist. **Zuordnen** (Route `POST /api/lab/unmatched-receipts/{id}/assign`) hängt den Beleg an die gewählte Bestellung (`attachments`) und entfernt den Ablage-Eintrag; Löschen mit Rückfrage.

## 5. Modul-Schnittstelle (`core/plugin-registry.js`)
Module registrieren sich beim App-Start an festen Slots:
* **`dashboard-actions`:** Buttons oben im Dashboard (z. B. „Moodle-CSV importieren“).
* **`order-detail-actions`:** Buttons in einer geöffneten Bestellung; `onClick(order, items)`.

```javascript
import { registerPlugin } from '../../core/plugin-registry.js';

registerPlugin({
  id: 'word-export',
  slot: 'order-detail-actions',
  label: 'Beschaffungsformular (.docx)',
  icon: 'file-text',
  isVisible: (order) => true,            // optional
  onClick: (order, items) => openWordExportModal(order, items)
});
```

## 6. Module (Überblick)
* **shop-export:** Nur **CSV-Download** für den CSV-Upload der Shops (kein Copy & Paste). Sichtbar im Status „angefragt“ und nur für Shops mit verifiziertem Format; weitere Shops erst nach einem Test-Upload in `formats.js` eintragen. Menge = `qty_ordered − qty_cancelled`, komplett stornierte Positionen entfallen. Dateien UTF-8 ohne BOM, Zeilenende CRLF, Name `<shop>-<interne Bestellnummer>.csv`. Formate (verifiziert 11/2026 mit Vorlagen und Test-Uploads):

  | Shop | Erkennung | Trennzeichen | Kopfzeile | Spalten |
  |---|---|---|---|---|
  | Mouser | `supplier = mouser` | Komma | `Mouser or Manufacturer Part Number,Customer Part Number,Quantity 1,Quantity 2,Quantity 3` | Nummer, *leer*, Menge, *leer*, *leer* |
  | Reichelt | `supplier = reichelt` | Semikolon (Nummern enthalten Kommas/Leerzeichen) | keine | Nummer, Menge |
  | TME | `supplier = other`, Shop-Name beginnt mit „TME“ | Semikolon | keine | Nummer (TME- oder Herstellernummer), Menge |

  Felder mit Trennzeichen oder Anführungszeichen werden nach RFC 4180 maskiert. Ablauf: Vorschau → Download → im Shop hochladen und bestellen → **„Exportiert & auf ‚Bestellt‘ setzen“** (erst nach dem Download; interne Bestellnummer Pflicht, Shop-Auftragsnummer optional) über die Status-Route. Vorher werden die Positionen neu geladen: Hat sich der Warenkorb seit dem Download geändert (z. B. Position von anderen ergänzt), wird der Statuswechsel angehalten und ein neuer Download verlangt.
* **moodle-import (Beta):** CSV-Export der Moodle-Datenbank „Bauteilbestellung“ (Spalten Lieferant, Anzahl, Bestellnummer, Kommentar, Gruppe, Tags; Bezeichnung und Link optional, falls das Formular später ergänzt wird), eingelesen mit Papa Parse. Ablauf:
  1. **Datei** wählen oder hineinziehen; Spalten werden über die Überschriften erkannt und sind änderbar.
  2. **Zuordnung:** Veranstaltung und Semester einmal für den ganzen Import. **Lieferanten** je Angabe (Mouser/Farnell/Reichelt/Voelkner direkt, sonst „sonstige“ mit Shop-Namen, z. B. TME). **Gruppen interaktiv** je Bezeichnung: bestehende Gruppe der Veranstaltung, neu anlegen, ohne Gruppe oder „je Zeile wählen“ (für fehlerhafte Einträge, z. B. von Dozenten angelegte). Eine gleichnamige Gruppe der Veranstaltung ist **vorausgewählt und als Vorschlag markiert** – nichts geschieht stillschweigend; weiter erst, wenn alles zugeordnet ist.
  3. **Vorschau** je Zeile: übernehmen ja/nein, Menge, Bestellnummer, Bezeichnung, Gruppe änderbar. **Fehler** (fehlende Nummer, ungültige Menge, offene Zuordnung) blockieren das Buchen; **Hinweise**, wenn Nummer + Gruppe schon im offenen Korb stehen oder in der Datei doppelt vorkommen.
  4. **Buchen** über den Sammel-Import (Kap. 4.2) – alles oder nichts.
  Der **Moodle-Kommentar** wird nur angezeigt, nicht gespeichert (auch nicht der Link darin); **Tags** werden ignoriert. **Kein gespeicherter Import-Bezug:** Nach dem Buchen ist die Zuordnung zu Moodle-Einträgen nicht mehr vorhanden.
* **word-export:** PizZip + docxtemplater, Zusatzfelder in `orders.custom_fields`. Benötigt die `.docx`-Vorlage.
* **delivery-scanner:** Komplett im Browser, keine Daten an Dritte (OCR-Dienste/KI-APIs bewusst ausgeschlossen). Die Entzerrung ist fester Bestandteil, weil direkt aus der Web-App fotografiert wird und keine Scan-App vorausgesetzt werden kann. Bewertung am echten Reichelt-Beleg: mit Entzerrung 12/12 Positionen und Mengen korrekt (auch bei schrägem Foto), ohne Entzerrung 0/12. Ablauf:
  1. **Start** aus der Bestellung (Bestellung fest; Warnung, wenn auf dem Lieferschein eine andere interne Bestellnummer steht) oder aus dem Dashboard. Die Bestellung wird dann **über die interne Bestellnummer** zugeordnet, die bei allen Lieferanten auf dem Lieferschein steht (z. B. Reichelt „Bestellnummer“, TME „Bestellnummer des Kunden“): Suche auf allen Seiten, tolerant gegenüber OCR-Verwechslungen (`I`→`1`, `O`→`0`, `W`→`VV`), auch ohne Lieferanten-Profil. Rückfall: unscharfer Vergleich mit interner und Shop-Auftragsnummer der offenen Bestellungen. Der Nutzer bestätigt.
  2. **Aufnahme** über die System-Kamera (`<input capture="environment">`) oder Bildauswahl, beliebig viele Seiten.
  3. **Entzerrung:** Blattecken automatisch (jscanify/OpenCV.js), als verschiebbare Punkte angezeigt; Seite auf 1800 px Breite entzerrt. Das Bild ist in die Bildschirmhöhe eingepasst, die Knöpfe stehen in einer festen Leiste unten (auf dem Handy ohne Scrollen erreichbar). Beim Ziehen eines Punkts zeigt eine **Lupe** (dreifach, aus dem Originalfoto, mit Blattkanten und Fadenkreuz) den Ausschnitt um den Punkt – oben auf der dem Punkt abgewandten Seite, damit der Finger sie nicht verdeckt.
  4. **OCR:** Tesseract.js (deu+eng, LSTM), Wörter mit normierten Koordinaten 0..1.
  5. **Tabelle lesen**, je Profil auf eine von zwei Arten – unabhängig von Bildausschnitt und Auflösung:
     * **Kopfzeile** (Reichelt): Spaltengrenzen aus den Überschriften (z. B. Menge | Artikelnummer | Bezeichnung).
     * **Mengeneinheit** (TME „4 ST“, Würth „2 STK“): jede Einheit markiert eine Positionszeile; Menge = Zahl direkt davor, Bestellnummer = Anfang der Zeile mit Positionsnummer. Braucht keine Kopfzeile (bei TME von der OCR oft nicht gelesen) und zählt Begleitdokumente ohne Einheit (Würth: Chargen- und Packliste) nicht doppelt.
     Mengen mit OCR-Korrektur (O→0, I/l→1) nur bei sonst rein numerischem Text. Profile gehören zu einem Lieferanten, bei „sonstige“ zusätzlich zu einem Shop-Namen (z. B. TME, Würth/WE).
  6. **Abgleich:** Ähnlichkeit der normierten Bestellnummern (Levenshtein) gegen die Positionen der Bestellung. *Sicher* ab 0,85 mit Abstand ≥ 0,08 zum Zweitbesten, sonst *prüfen*; zusätzlich *prüfen* bei Menge > Rückstand oder mehreren Zeilen je Position. Nicht zugeordnete Zeilen weist der Nutzer von Hand einer Position zu oder **trägt sie als vergessene Position nach** (Kap. 4.5; Bestellnummer vor dem Buchen prüfbar, Lieferung und neue Position in einer Buchung).
  7. **Buchung** über die Lieferbuchungs-Route; alle Seiten als ein PDF (Graustufen-JPEG) in `receipt`. Ohne Mengen wird das PDF nur an `orders.attachments` gehängt.
  8. **Keine passende Bestellung:** Bestellung aus dem Lieferschein anlegen oder Lieferschein ablegen (Kap. 4.6).
  9. **Problem melden** (Beta-Rückmeldung): Knopf in der Prüfansicht, unabhängig von der Buchung. Bei offensichtlichem Scheitern (Lieferant nicht erkannt, kein Profil, Positionstabelle nicht gefunden, keine Zeile zugeordnet) wird die Meldung hervorgehoben angeboten; kleinere Auffälligkeiten (Ecken von Hand, einzelne Zeilen ohne Zuordnung) werden nur mitgeschickt. Die Meldung landet in `scan_reports` auf dem eigenen Server; alle Superuser bekommen eine Mail mit **Link in die Admin-UI, ohne Anhang** (in der Mail nur Bestellung, Probleme, Notiz). Analyse: `node scripts/fetch-scan-reports.mjs <URL>` holt die Meldungen nach `samples/scan-reports/` (nie committen) und löscht sie danach auf dem Server; daraus werden synthetische Testfälle abgeleitet.
  Neue Lieferanten: Profil in `profiles/` anlegen (Erkennungsmuster + Lesart), sobald Beispielbelege vorliegen – am einfachsten aus einer Problem-Meldung.
* **part-number-check:** Prüft Bestellnummern auf das Format des jeweiligen Shops und schlägt Korrekturen vor (z. B. Herstellernummer statt Shop-Nummer erkannt). Korrekturen werden interaktiv bestätigt.
* **MCP-Zugang für Claude Code (Phase 7, geplant):** Route `/mcp` in `pb_hooks` stellt ausgewählte Funktionen als MCP-Werkzeuge bereit (Streamable HTTP). Zugriff nur mit dem Token eines eigenen Dienst-Nutzers „KI-Assistent“ (widerrufbar, gleiche API-Rules wie Labor-Nutzer). Lesende Werkzeuge plus „Position in Sammelkorb“ und „Notiz setzen“; Lieferbuchungen, Statuswechsel und Löschen bleiben Menschen vorbehalten. Übermittelt werden nur Bestelldaten und Labor-Nutzer (öffentlich auf der TH-Homepage); Studierendendaten existieren im System nicht; Belege/Anhänge nur als Dateiname.

## 7. UI-Konventionen
* **Mobile-First:** große Touch-Ziele (Schnellbuttons „+1“, „Rest komplett“), Modals als Bottom-Sheet auf dem Smartphone.
* **Dashboard:** Filter (Status, Lieferant, Gruppe) auf dem Smartphone einklappbar, aktive Filter als entfernbare Chips; Filter werden pro Browser gemerkt.
* **Gruppenauswahl:** immer nach Veranstaltung/Semester gegliedert (neuestes Semester zuerst).
* **Meldungen:** höchstens drei Toasts gleichzeitig (älteste fällt weg).
* **Sicherheitsabfragen:** eigener Dialog im Stil der App (`confirmAction()` in `core/ui.js`, natives `<dialog>` mit `showModal()`; auf dem Smartphone als Bottom-Sheet), keine Browser-Dialoge. Der Bestätigungsknopf nennt die Aktion („Löschen“, „Buchen“, „Zurücksetzen“ …). Endgültiges Löschen oder Verwerfen wird rot dargestellt, der Fokus liegt dann auf „Abbrechen“. Escape, ein Klick neben den Dialog und „Abbrechen“ brechen ab, darunterliegende Modals bleiben offen.
* **Sprache:** komplette Oberfläche und Fehlermeldungen auf Deutsch.

## 8. Qualitätssicherung
* `tests/run.sh` startet eine frische PocketBase-Instanz (+ Mailpit als Test-Mailserver) außerhalb von Dropbox, importiert das Schema und führt `node --test` aus (nur Node-Bordmittel, kein npm).
* `tests/run.sh --e2e` führt zusätzlich die Browser-Durchläufe in headless Chrome aus (App-Ablauf und Lieferschein-Erfassung); sie schlagen auch bei Fehlern in der Browser-Konsole fehl.
* Testdaten sind synthetisch. Der Scanner-Test erzeugt einen Lieferschein im Reichelt-Layout als HTML und „fotografiert“ ihn schräg; echte Belege (`samples/`) gelangen nie ins Repo.
* Nach Änderungen an `pb_hooks/` oder am Schema: `tests/run.sh`; nach UI-Änderungen zusätzlich `scripts/build-css.sh` und `tests/run.sh --e2e`.

## 9. Betrieb
* **Produktivbetrieb:** Rate-Limiting aktiv, Client-IP über den Proxy-Header `X-Forwarded-For` (Uberspace-Proxy), Login-Mails über ein Postfach auf Uberspace.
* `pb_data/` liegt **nie** in Dropbox (SQLite/WAL kann durch Sync beschädigt werden). Lokale Test-Instanzen liegen außerhalb des Projektordners.
* Lokale Entwicklung: `scripts/dev-server.sh` (PocketBase + Mailpit), Daten unter `~/.local/share/bestellverwaltung-dev/`.
* Deploy, Dienst-Einrichtung, Backup und Updates auf Uberspace: `docs/DEPLOYMENT.md`.
