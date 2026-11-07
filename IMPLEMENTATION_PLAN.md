
# Implementierungsplan für den Coding-Agenten

> **WICHTIGE ANWEISUNG FÜR DEN KI-AGENTEN:**
> Arbeite diesen Plan **strikt phasenweise** ab. Erstelle keinen Build-Prozess (`package.json`, `vite`, `npm` sind verboten). Alle Dateien liegen als native ES6-Module unter `pb_public/`. Halte dich exakt an die Vorgaben in `ARCHITECTURE.md` und die Feldnamen in `pb_schema.json`. Frage nach Abschluss jeder Phase den Nutzer nach Feedback, bevor du die nächste Phase startest.

---

## Phase 1: Fundament, Auth (Email-OTP) & Sammel-Warenkorb-Kern
**Ziel:** Lauffähige Grundanwendung in `pb_public/` mit Login, Gruppenverwaltung, manueller Bestellerfassung und der automatischen Sammel-Warenkorb-Logik.

### Aufgaben:
1. **`pb_public/index.html`:**
   * Binde TailwindCSS (Play CDN), Alpine.js (v3 CDN) und das PocketBase JS SDK (via ES-Module CDN `https://cdn.jsdelivr.net/npm/pocketbase@latest/dist/pocketbase.es.mjs`) ein.
   * Erstelle ein responsives Mobile-First-Layout (Header mit Navigation: *Bestellungen*, *Gruppen/Projekte*, *Logout* + dynamischer Bereich für Plugin-Buttons).
2. **`pb_public/core/pb.js`:**
   * Initialisiere den PocketBase-Client (`new PocketBase(window.location.origin)`).
   * Implementiere den Email-OTP-Flow (`requestOTP(email)` und `verifyOTP(otpId, code)`).
3. **`pb_public/core/plugin-registry.js`:**
   * Baue die Registry für die Slots `dashboard-actions` und `order-detail-actions`.
4. **`pb_public/core/api.js`:**
   * Implementiere `addItemToSupplierCart(supplier, itemInput)`:
     * Sucht offenen Warenkorb (`supplier` + `status == "angefragt"`) oder legt ihn an.
     * Prüft, ob `part_number` (getrimmt, Großbuchstaben) im Warenkorb existiert.
     * Falls ja: Addiere `qty_ordered`, aktualisiere `groups` (Relation-IDs), `group_allocations` (JSON-Array `[{groupId, groupName, qty}]`) sowie den lesbaren Text `group_allocation_note` (z. B. `"Gruppe A: 5x | Gruppe B: 2x"`).
   * Implementiere `recalculateOrderStatus(orderId)`:
     * Berechnet anhand von `qty_ordered` vs. `qty_delivered` aller Positionen automatisch, ob der Status auf `bestellt`, `teilgeliefert` oder `geliefert` springt.
5. **Views (`login-view.js`, `dashboard-view.js`, `order-detail-view.js`, `groups-view.js`):**
   * **Dashboard:** Filter nach Status (`angefragt`, `bestellt`, `teilgeliefert`, `geliefert`, `geprueft`, `abgerechnet`), Lieferant und Gruppe.
   * **Order-Detail:** Liste aller zusammengefassten Positionen inkl. Anzeige der `group_allocation_note` und des berechneten Rückstands (`qty_ordered - qty_delivered`). Möglichkeit zur manuellen Eingabe von `qty_delivered`, "+1 / Komplett geliefert"-Schnellbuttons fürs Smartphone sowie Datei-Upload für `attachments`.

**Akzeptanzkriterium Phase 1:** Login per OTP funktioniert; zwei manuell eingetragene Bauteile mit gleicher Artikelnummer für zwei verschiedene Gruppen landen im selben Lieferanten-Sammelkorb und werden zu einer Position mit addierter Menge und sauberem Gruppen-Hinweis verschmolzen.

---

## Phase 2: Modul `shop-export` (Bestelllisten für Distributoren)
**Ziel:** Übergabe eines Sammel-Warenkorbs an Mouser, Farnell, Reichelt und Voelkner per Knopfdruck.

### Aufgaben:
1. Erstelle `pb_public/modules/shop-export/shop-exporter.js` und registriere es im Slot `order-detail-actions`.
2. Öffnet ein Modal mit Copy-to-Clipboard-Textfeld und CSV-Download-Button, formatiert nach `order.supplier`:
   * **Reichelt:** CSV/Text `part_number;qty_ordered`
   * **Mouser:** Format `part_number|qty_ordered|group_allocation_note` (Kundenreferenz gekürzt auf max. 25 Zeichen).
   * **Farnell:** Format `part_number,qty_ordered,group_allocation_note` (Komma-separiert für Farnell Quick-Paste).
   * **Voelkner:** CSV/Text `part_number;qty_ordered`.
3. Button im Modal: *"Exportiert & Bestellung jetzt auf 'Bestellt' setzen"* (fragt optional nach der `supplier_order_no`).

---

## Phase 3: Modul `moodle-import` (CSV-Drag-&-Drop)
**Ziel:** Import von Bauteil-Zeilen aus einer Moodle-Datenbank-CSV inkl. Dublettenschutz.

### Aufgaben:
1. Erstelle `pb_public/modules/moodle-import/moodle-importer.js` (nutze PapaParse via CDN) und registriere es im Slot `dashboard-actions`.
2. **Spalten-Mapping & Vorschau:**
   * Erlaube Drag & Drop einer CSV-Datei.
   * Prüfe für jede Zeile anhand der eindeutigen Moodle-Eintrags-ID, ob diese ID bereits in irgendeinem `order_items.moodle_entry_ids` in PocketBase existiert. Bereits importierte Zeilen werden in der Vorschau grau als *"Bereits importiert (übersprungen)"* markiert.
   * Nichtexistierende Gruppen aus der CSV können beim Import automatisch in `groups` angelegt oder zugeordnet werden.
   * Beim Klick auf *"Import ausführen"* werden alle neuen Zeilen über `api.addItemToSupplierCart()` in die jeweiligen offenen Sammel-Warenkörbe gebucht.

---

## Phase 4: Modul `delivery-scanner` (jscanify + Tesseract + Bounding Boxes)
**Ziel:** Abfotografieren/Hochladen von Papier-Lieferscheinen, Entzerren, Auslesen von Artikelnummern & gelieferten Mengen über Spalten-Bounding-Boxes und Abgleich mit offenen Bestellungen.

### Aufgaben:
1. **`vision.js`:** Lade OpenCV.js und `jscanify` bei Bedarf (Lazy Loading beim Öffnen des Scanners). Entzerre das Dokument und wende Graustufen/Kontrast-Optimierung an.
2. **`ocr.js`:** Starte `Tesseract.js` Worker. Gib Zeilen und Wörter mit normierten Koordinaten (`x0, y0, x1, y1` zwischen `0.0` und `1.0`) zurück.
3. **`profiles/*.js`:** Lege die Profil-Dateien für `mouser.js`, `farnell.js`, `reichelt.js` und `voelkner.js` mit sauber dokumentierten Platzhalter-RegEx und X-Spalten-Korridoren an, sodass sie anhand echter Beispiel-Lieferscheine nur noch feinjustiert werden müssen.
4. **`matcher.js` & `scanner-modal.js`:**
   * Vergleicht die im Lieferschein erkannten Artikelnummern (Fuzzy-Normalisierung ohne Sonderzeichen/Leerzeichen) mit den `order_items` der Bestellung.
   * Zeigt das entzerrte Bild mit farbig markierten Treffer-Boxen neben einer editierbaren Abgleich-Tabelle (`Bestellt` | `Bisher geliefert` | `Neu erkannt` | `Rückstand` | `Gruppen-Info`).
   * Beim Bestätigen: Aktualisiert `qty_delivered`, lädt das entzerrte Lieferschein-Bild in `orders.attachments` hoch und ruft `api.recalculateOrderStatus(order.id)` auf.

---

## Phase 5: Modul `word-export` (Beschaffungsformulare `.docx`)
**Ziel:** Befüllen von Hochschul-Word-Vorlagen direkt im Browser.

### Aufgaben:
1. Erstelle `pb_public/modules/word-export/docx-generator.js` (nutze `PizZip` und `docxtemplater` via CDN) und registriere es im Slot `order-detail-actions`.
2. Zeige vor dem Generieren ein kurzes Modal für formularspezifische Zusatzfelder, die in `order.custom_fields` (JSON) gespeichert werden (z. B. Kostenstelle, Begründung, Projektleiter – erweiterbar sobald die finale `.docx`-Vorlage vorliegt).
3. Lade die `.docx`-Vorlage aus `assets/templates/`, ersetze alle Platzhalter (`{supplier}`, `{total_net}`, Loop `{#items}...{/items}`) und starte den Browser-Download der fertigen `.docx`-Datei.

```
