# Architektur & Technische Spezifikation: Labor-Bestellsystem

> Stand: 2026-11-07 – überarbeitet nach kritischer Plan-Review (siehe „Getroffene Entscheidungen“ in `CLAUDE.md`).

## 1. System-Überblick & Leitprinzipien
* **Zweck:** Browserbasierte Verwaltung von Laborbestellungen (Elektronik, Verbrauchsmaterial, Geräte) inkl. Sammel-Warenkörben, Moodle-CSV-Import, Shop-Bestellexport, Word-Formular-Generator und (später) Lieferschein-Erfassung.
* **Backend:** PocketBase (Single Binary auf Uberspace, ≥ v0.23, getestet mit v0.40.6). Liefert REST/Realtime-API, führt die serverseitige Geschäftslogik in `pb_hooks/` (JSVM, kein Build) aus und liefert das Frontend aus `pb_public/` aus.
* **Geschäftslogik serverseitig:** Alles, was mehrere Datensätze konsistent ändern muss (Sammel-Warenkorb-Merge, Lieferbuchungen, Status-Workflow), läuft in PocketBase-Hooks **innerhalb einer DB-Transaktion**. Das Frontend ruft dafür eigene Routen auf und schreibt diese Felder nie direkt (durch API-Rules erzwungen).
* **Frontend-Architektur („No-Bundler Reactive“):**
  * **Kein JS-Build:** Kein Node.js/npm, kein Vite/Webpack, kein Babel. Alle JS-Dateien in `pb_public/` sind native ES6-Module und direkt im Browser lauffähig.
  * **Einzige Ausnahme – CSS-Build:** TailwindCSS wird mit dem **Tailwind Standalone CLI** (einzelne Binary, v4.3.3, kein npm) aus `tailwind/app.src.css` zu `pb_public/assets/app.css` übersetzt. Das erzeugte CSS wird committet; ein Deploy ist reines Kopieren.
  * **Modularität:** Jedes Feature ist physisch in einer eigenen Datei isoliert, damit Module unabhängig voneinander erstellt und gewartet werden können.
  * **UI & Reaktivität:** **Alpine.js v3** (ESM-Build) für reaktives State-Management.
  * **Selbst gehostete Bibliotheken:** Alle Fremdbibliotheken liegen mit fester Version unter `pb_public/vendor/<name>@<version>/` (Datenschutz: keine IP-Übertragung an CDNs; Funktion auch bei schlechtem Labor-WLAN). `scripts/fetch-vendor.sh` lädt die festgelegten Versionen. Nie `@latest`.
  * **Mobile-First:** Smartphone-Nutzung am Auspack-Tisch im Labor.

## 2. Authentifizierung, Rollen & Sicherheit
1. **System-Admin (`_superusers`):** Ausschließlich über das PocketBase Admin-UI (`/_/`), Passwort + 2FA (TOTP). Legt Labor-Nutzer an.
2. **Labor-Nutzer (`users`):**
   * **Login:** Passwortlos per **Email-OTP** (`requestOTP(email)` → `authWithOTP(otpId, code)`). Passwort-Login deaktiviert. OTP-Gültigkeit **10 Minuten**, OTP-Mail **auf Deutsch** (beides in `pb_schema.json`).
   * **Keine Selbstregistrierung** (`createRule: null`). Für unbekannte Adressen verschickt PocketBase bewusst keinen Code (Schutz vor Konten-Ausspähung); die Login-Maske weist darauf hin: *„Kein Code erhalten? Ihr Konto muss vom Admin angelegt sein.“*
   * **Lange Sessions:** Auth-Token-Dauer 30 Tage (2592000 s); beim App-Start wird das Token per `authRefresh()` verlängert.
3. **Berechtigungen (API-Rules), Grundsatz „volle Transparenz im Labor“:** Alle eingeloggten Nutzer sehen alles. Einschränkungen:
   * `orders` löschen nur im Status `angefragt`; danach nur Admin.
   * `orders.status`, `order_items.qty_delivered`, `orders.created_by` sowie das Anlegen von `order_items`, `deliveries`, `delivery_items` sind per Rule für direkte Schreibzugriffe gesperrt und laufen ausschließlich über die Hook-Routen (Kap. 4).
   * `created_by` / `booked_by` werden serverseitig aus dem Auth-Kontext gesetzt (nicht fälschbar).
   * `deliveries` sind unveränderlich (kein Update/Delete für Nutzer); Korrekturen erfolgen per Gegenbuchung.

## 3. Verzeichnisstruktur

```text
Projekt/
├── pb_schema.json                  # Collections im PocketBase-Importformat (≥ v0.23)
├── pb_hooks/                       # Serverseitige Geschäftslogik (PocketBase JSVM)
│   ├── routes.pb.js                # Registrierung der /api/lab/* Routen
│   ├── record-hooks.pb.js          # created_by setzen, Status nach Positionsänderung neu berechnen
│   └── lib/
│       ├── cart.js                 # Sammel-Warenkorb-Merge
│       ├── deliveries.js           # Lieferbuchungen, qty_delivered-Summen
│       └── status.js               # Status-Workflow & Auto-Lieferstatus
├── pb_public/
│   ├── index.html                  # App-Shell, Hauptnavigation, Router
│   ├── assets/
│   │   ├── app.css                 # ERZEUGT aus tailwind/app.src.css (committet)
│   │   └── templates/              # Word-Vorlagen (.docx)
│   ├── vendor/                     # Selbst gehostete Bibliotheken mit fester Version
│   ├── core/
│   │   ├── pb.js                   # PocketBase-Instanz, OTP-Login, Session-Handling
│   │   ├── api.js                  # Dünner Client für /api/lab/*-Routen + Lese-Abfragen
│   │   ├── config.js               # Konstanten (Lieferanten, Status, MwSt.-Satz 19 %)
│   │   └── plugin-registry.js      # Registry für Erweiterungsmodule (Slots)
│   ├── views/
│   │   ├── login-view.js
│   │   ├── dashboard-view.js
│   │   ├── order-detail-view.js
│   │   └── groups-view.js
│   └── modules/                    # Isolierte Erweiterungsmodule (über plugin-registry)
│       ├── shop-export/
│       ├── moodle-import/
│       ├── word-export/
│       ├── delivery-scanner/       # Lieferschein-Erfassung, Ansatz offen (Kap. 6)
│       └── part-number-check/      # Prüfung der Bestellnummern (Kap. 6)
├── tailwind/app.src.css            # Tailwind-Quelle
├── scripts/
│   ├── build-css.sh                # Tailwind Standalone CLI → pb_public/assets/app.css
│   ├── fetch-vendor.sh             # Lädt festgelegte Bibliotheksversionen nach pb_public/vendor/
│   └── dev-server.sh               # Lokale Test-Instanz (pb_data außerhalb von Dropbox)
├── tests/                          # node --test (nur eingebaute Module, kein npm) gegen Test-Instanz
└── docs/DEPLOYMENT.md              # Uberspace-Betrieb, Deploy, Backup
```

## 4. Datenmodell & Kern-Geschäftslogik

### 4.1 Collections (Details: `pb_schema.json`)
* **`groups`:** `name`, **`course`** (Veranstaltung, Pflicht), `semester` (Pflicht, Format `WS 2026/27` bzw. `SS 2027`), `contact_info`, `is_active`. Der Gruppenname ist nur **innerhalb von Veranstaltung + Semester eindeutig** (Unique-Index `idx_groups_unique_name`, Groß-/Kleinschreibung egal). Bei der Eingabe werden bestehende Veranstaltungen vorgeschlagen; in Auswahllisten erscheinen Gruppen nach Veranstaltung/Semester gegliedert.
* **`orders`:** `supplier` (`mouser|farnell|reichelt|voelkner|other`), `supplier_custom_name` (nur bei `other`, sonst leer), `supplier_order_no`, `status`, `created_by`, `attachments`, `custom_fields` (JSON), `notes`, **`shipping_cost`** (netto), **`invoice_total`** (tatsächlicher Rechnungsbetrag brutto, von Hand bei der Abrechnung).
* **`order_items`:** `order`, `part_number`, `name`, `url`, `qty_ordered`, `qty_delivered` (nur Hook), **`qty_cancelled`**, `price_unit` (netto), `groups`, `group_allocations` (JSON `[{groupId, groupName, qty}]`), `group_allocation_note` (z. B. `"Gruppe A: 5x | Gruppe B: 2x"`). `moodle_entry_ids` entfällt.
* **`deliveries`** (neu): `order`, `booked_by`, `note`, `receipt` (Beleg-Datei, optional), `created`.
* **`delivery_items`** (neu): `delivery`, `order_item`, `qty` (ganzzahlig, ≠ 0; negativ = Korrektur-Gegenbuchung).

**Artikelnummer-Regel:** `part_number` ist **immer die Shop-Bestellnummer** des jeweiligen Lieferanten (z. B. `595-SN74HC595N` bei Mouser), nicht die Herstellernummer. Eingabemaske und Moodle-Formular weisen darauf hin. Gespeichert wird normalisiert (Trim + Großbuchstaben). Eine spätere Prüf-/Korrektur-Erweiterung ist als Modul denkbar.

**Gruppennamen in `group_allocations`/`group_allocation_note`** enthalten nur den Gruppennamen (ohne Veranstaltung) und sind eine Momentaufnahme zum Zeitpunkt der Erfassung; Umbenennungen werden nicht nachgezogen.

**Kosten:** Netto = Σ (`qty_ordered − qty_cancelled`) × `price_unit` + `shipping_cost`; Brutto = Netto × 1,19 (Satz in `core/config.js`). `invoice_total` hält den tatsächlichen Betrag laut Rechnung.

### 4.2 Sammel-Warenkorb (Route `POST /api/lab/cart-items`)
1. Pro Lieferant existiert maximal **ein** offener Warenkorb (`status = "angefragt"`); bei `other` **einer je `supplier_custom_name`** (Groß-/Kleinschreibung egal). DB-seitig erzwungen durch den Unique-Index `idx_orders_one_open_cart`.
2. In einer Transaktion: offenen Korb suchen oder anlegen → Position mit gleicher normalisierter `part_number` suchen →
   * **nicht vorhanden:** neue Position anlegen;
   * **vorhanden (Merge):** `qty_ordered` += Menge; Gruppe zu `groups` hinzufügen; Eintrag in `group_allocations` erhöhen bzw. anlegen; `group_allocation_note` neu erzeugen. Name/URL/Preis werden nur ergänzt, wenn bisher leer.
3. Antwort: `{order, item, merged: bool}`.

### 4.3 Status-Workflow
* Kette: `angefragt` → `bestellt` → `teilgeliefert` → `geliefert` → `geprueft` → `abgerechnet`.
* **Manuelle Schritte** (Route `POST /api/lab/orders/{id}/status`, `{action: "advance" | "back", supplier_order_no?}`):
  * `angefragt → bestellt` (optional mit `supplier_order_no`); der Korb ist damit für neue Positionen geschlossen, neue landen in einem neuen offenen Korb.
  * `geliefert → geprueft → abgerechnet`.
  * **„Einen Schritt zurück“** mit Sicherheitsabfrage im UI. Zurück auf `angefragt` wird verweigert, wenn bereits ein anderer offener Korb für den Lieferanten existiert.
* **Automatischer Lieferstatus** (bei `bestellt`, `teilgeliefert`, `geliefert`; ab `geprueft` keine Automatik), neu berechnet nach jeder Lieferbuchung und jeder Änderung von `qty_ordered`/`qty_cancelled`:
  * Eine Position gilt als **erledigt**, wenn `qty_delivered + qty_cancelled ≥ qty_ordered`.
  * Alle Positionen erledigt → `geliefert`.
  * Sonst: mindestens eine Position mit `qty_delivered > 0` → `teilgeliefert`.
  * Sonst → `bestellt`.
* **Rückstand** je Position = `qty_ordered − qty_delivered − qty_cancelled` (min. 0).
* **Änderungen ab `bestellt`:** `qty_ordered`, `part_number`/`name`/`url`/`price_unit` (Ersatzteil) und `qty_cancelled` bleiben änderbar (bis einschl. `geliefert`). Neue Positionen nur im offenen Korb.

### 4.4 Lieferbuchungen (Route `POST /api/lab/orders/{id}/deliveries`)
* Body: `lines: [{item, qty}]`, `note`, optional `receipt` (Datei, multipart).
* In einer Transaktion: `deliveries` + `delivery_items` anlegen, `qty_delivered` jeder betroffenen Position = Σ `delivery_items.qty` neu berechnen (darf nicht < 0 werden), danach Auto-Lieferstatus.
* Schnellbuttons im UI („+1“, „Rest komplett“) erzeugen ebenfalls Buchungen; mehrere schnelle Klicks werden im UI kurz gesammelt, bevor gebucht wird.

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
* **shop-export:** Copy&Paste-Text und CSV je Lieferant. Die Formate werden vor der Umsetzung an den echten Schnellbestell-/Upload-Masken der Shops verifiziert.
* **moodle-import:** CSV per Drag & Drop (PapaParse), Spalten-Mapping, Vorschau. **Gruppen werden interaktiv zugewiesen:** Für jede in der CSV vorkommende Gruppenbezeichnung wählt der Nutzer eine bestehende Gruppe (mit Veranstaltung/Semester) oder legt sie neu an – es gibt keine stillschweigende automatische Zuordnung. **Kein gespeicherter Import-Bezug:** Nach dem Buchen ist die Zuordnung zu Moodle-Einträgen nicht mehr vorhanden. Die Vorschau **warnt**, wenn Artikelnummer + Gruppe bereits im offenen Korb stehen. Gebucht wird über `POST /api/lab/cart-items`. Benötigt eine Beispiel-CSV.
* **word-export:** PizZip + docxtemplater, Zusatzfelder in `orders.custom_fields`. Benötigt die `.docx`-Vorlage.
* **delivery-scanner:** Ansatz (OCR des Lieferscheins, Barcode/DataMatrix der Beutel-Etiketten, PDF-Lieferschein) wird erst anhand echter Belege entschieden. Ergebnis wird immer über die Lieferbuchungs-Route gebucht (Beleg als `receipt`).
* **part-number-check:** Prüft Bestellnummern auf das Format des jeweiligen Shops und schlägt Korrekturen vor (z. B. Herstellernummer statt Shop-Nummer erkannt). Korrekturen werden interaktiv bestätigt.

## 7. Betrieb
* `pb_data/` liegt **nie** in Dropbox (SQLite/WAL kann durch Sync beschädigt werden). Lokale Test-Instanzen liegen außerhalb des Projektordners.
* Deploy, Dienst-Einrichtung, Backup und Updates auf Uberspace: `docs/DEPLOYMENT.md`.
