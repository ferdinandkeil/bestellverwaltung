# Architektur & Technische Spezifikation: Labor-Bestellsystem

## 1. System-Überblick & Leitprinzipien
* **Zweck:** Browserbasierte Verwaltung von Laborbestellungen (Elektronik, Verbrauchsmaterial, Geräte) inkl. Sammel-Warenkörben, Moodle-CSV-Import, Shop-Bestellexport, Lieferschein-OCR-Scanner und Word-Formular-Generator.
* **Backend:** PocketBase (Single Binary auf Uberspace). Liefert sowohl die REST/Realtime-API als auch die statischen Frontend-Dateien über das Verzeichnis `pb_public/` aus.
* **Frontend-Architektur ("No-Build Reactive"):**
  * **Kein Build-Schritt:** Kein Node.js, kein Vite/Webpack, kein Babel. Alle Dateien in `pb_public/` sind direkt im Browser lauffähig.
  * **Modularität:** Native ES6-Module (`<script type="module">`, `import` / `export`). Jedes Feature ist physisch in einer eigenen Datei isoliert, damit KI-Agenten Module unabhängig voneinander erstellen und warten können.
  * **UI & Reaktivität:** **Alpine.js (v3, via CDN)** für reaktives State-Management und DOM-Updates ohne manuelles `document.getElementById`.
  * **Styling:** **TailwindCSS (Play CDN)** für schnelles, mobiles Responsive-Design (Smartphone-Nutzung am Auspack-Tisch im Labor).

## 2. Authentifizierung, Rollen & Sicherheit
Es gibt keine eigene Rollen-Tabelle im Frontend. PocketBase trennt strikt zwischen System-Administration und Labor-Nutzern:

1. **System-Admin (`_superusers` / PocketBase Admin):**
   * Loggt sich ausschließlich über das native PocketBase Admin-UI (`/_/`) ein.
   * **Sicherheit:** Passwort + 2FA (TOTP) in PocketBase aktiviert.
2. **Labor-Nutzer (`users` Collection):**
   * Umfasst wissenschaftliche Mitarbeiter, Besteller und Gruppenleiter.
   * **Login-Verfahren:** Passwortlos per **Email-OTP** (`pb.collection('users').requestOTP(email)` -> `authWithOTP(otpId, code)`). Passwort-Login ist für `users` deaktiviert.
   * **Lange Sessions:** Die Auth-Token-Dauer für `users` wird in den PocketBase-Settings auf **30 Tage (2592000 Sekunden)** eingestellt, damit man am Labor-Tablet/Smartphone eingeloggt bleibt.
   * **Sichtbarkeit & Berechtigungen (API Rules):** Volle Transparenz im Labor. Alle eingeloggten Nutzer (`@request.auth.id != ""`) dürfen alle Gruppen, Bestellungen und Positionen sehen, anlegen und bearbeiten.

## 3. Verzeichnisstruktur (`pb_public/`)

```text
pb_public/
├── index.html                      # App-Shell, CDN-Imports (Alpine, Tailwind, PB SDK), Hauptnavigation
├── assets/
│   └── templates/                  # Word-Vorlagen (.docx) für spätere Beschaffungsformulare
├── core/
│   ├── pb.js                       # PocketBase-Instanz, OTP-Login-Wrapper, Session-Handling
│   ├── api.js                      # Zentrale Geschäftslogik: Sammel-Warenkorb-Upsert, Auto-Status
│   └── plugin-registry.js          # Zentrale Registry für Erweiterungsmodule (Buttons/Modals/Views)
├── views/
│   ├── login-view.js               # Zweistufige Email-OTP Anmeldemaske
│   ├── dashboard-view.js           # Übersicht aller Bestellungen (Filter: Status, Lieferant, Gruppe)
│   ├── order-detail-view.js        # Warenkorb-Ansicht, Mengenkorrektur, Lieferhaken, Anhänge
│   └── groups-view.js              # Verwaltung der Studierenden-Gruppen & Projekt-Status-Ansicht
└── modules/                        # ISOLIERTE ERWEITERUNGS-MODULE (über plugin-registry eingehängt)
    ├── moodle-import/
    │   └── moodle-importer.js      # PapaParse CSV-Import, Dublettencheck, Merge in Sammel-Warenkorb
    ├── shop-export/
    │   └── shop-exporter.js        # Generiert Copy&Paste / CSV-Warenkörbe (Mouser, Farnell, Reichelt, Voelkner)
    ├── delivery-scanner/
    │   ├── scanner-modal.js        # Kamera/Datei-UI, Review-Maske (Human-in-the-Loop)
    │   ├── vision.js               # jscanify + OpenCV.js (Papier-Erkennung, Perspektiv-Entzerrung, Binarisierung)
    │   ├── ocr.js                  # Tesseract.js Worker (liefert Wörter/Zeilen + normierte Bounding Boxes 0..1)
    │   ├── matcher.js              # Abgleich erkannter Zeilen mit offenen order_items des Lieferanten
    │   └── profiles/               # Isolierte Lieferanten-Regeln (RegEx + Spalten-Bounding-Boxes)
    │       ├── mouser.js
    │       ├── farnell.js
    │       ├── reichelt.js
    │       └── voelkner.js
    └── word-export/
        └── docx-generator.js       # PizZip + docxtemplater: Befüllt .docx-Vorlagen aus order + custom_fields

```

## 4. Kern-Geschäftslogik (Spezifikation für `core/api.js`)

### 4.1 Automatischer Sammel-Warenkorb pro Lieferant

1. Für jeden Lieferanten (`mouser`, `farnell`, `reichelt`, `voelkner`, `other`) existiert maximal **eine** Bestellung im Status `angefragt`.
2. Wird ein neues Bauteil hinzugefügt (manuell oder per Moodle-Import), prüft `api.addItemToSupplierCart(supplier, itemData)`:
* Existiert ein `orders`-Eintrag mit `supplier == X` und `status == "angefragt"`? Wenn nein -> automatisch anlegen.
* Existiert in diesem Warenkorb bereits ein `order_items`-Eintrag mit derselben normalisierten `part_number` (Trim + Uppercase)?
* **Nein:** Neues `order_item` anlegen.
* **Ja (Merge / Zusammenfassen):**
* `qty_ordered` = bisherige Menge + neue Menge.
* `groups` = Gruppen-ID zur Multi-Relation hinzufügen (falls noch nicht enthalten).
* `group_allocation` (JSON-Array `[{groupId, groupName, qty}]` + lesbarer String) aktualisieren, damit der Besteller/Auspacker sieht: *"Gruppe A: 5x, Gruppe B: 3x"*.
* `moodle_entry_ids` = Array um die neue Moodle-Zeilen-ID ergänzen (Dublettenschutz).

### 4.2 Status-Workflow & Rückstands-Berechnung

* **Kein Freigabe-Zwischenschritt:** Status-Kette für `orders` ist strikt:
`angefragt` -> `bestellt` -> `teilgeliefert` -> `geliefert` -> `geprueft` -> `abgerechnet`.
* Sobald eine Bestellung von `angefragt` auf `bestellt` wechselt, ist dieser Warenkorb für neue Moodle-Importe geschlossen.
* **Automatischer Lieferstatus (`api.recalculateOrderStatus(orderId)`):**
* Jedes `order_item` besitzt `qty_ordered` und `qty_delivered` (Standard: `0`). Der Rückstand ist `qty_ordered - qty_delivered`.
* Wenn bei einer Bestellung im Status `bestellt` oder `teilgeliefert` Mengen aktualisiert werden (manuell oder per Lieferschein-Scan):
* Alle Positionen `qty_delivered == 0` -> bleibt `bestellt`.
* Mindestens eine Position `qty_delivered > 0`, aber noch nicht alle `qty_delivered >= qty_ordered` -> Status wird automatisch `teilgeliefert`.
* Alle Positionen `qty_delivered >= qty_ordered` -> Status wird automatisch `geliefert`.


* Die letzten beiden Schritte (`geprueft`, `abgerechnet`) werden manuell per Button gesetzt.

## 5. Modul-Schnittstelle (`core/plugin-registry.js`)

Damit neue Features (z. B. ein weiteres Formular oder ein neuer Importer) hinzugefügt werden können, ohne bestehenden Code in `views/` umzuschreiben, registrieren sich Module beim App-Start an festen Slots:

* **Slot `dashboard-actions`:** Buttons oben im Dashboard (z. B. *"Moodle-CSV importieren"*, *"Lieferschein scannen"*).
* **Slot `order-detail-actions`:** Aktions-Buttons in einer geöffneten Bestellung, bekommt `order` und `items` übergeben (z. B. *"Shop-Export (CSV/Copy)"*, *"Word-Formular generieren"*, *"Lieferschein zu dieser Bestellung scannen"*).

```javascript
// Beispiel-Registrierung in einem Modul:
import { registerPlugin } from '../../core/plugin-registry.js';

registerPlugin({
  id: 'word-export',
  slot: 'order-detail-actions',
  label: 'Beschaffungsformular (.docx)',
  icon: 'file-text',
  onClick: (order, items) => openWordExportModal(order, items)
});

```

## 6. Spezifikation der Lieferschein-OCR-Pipeline (`modules/delivery-scanner/`)

1. **Bildaufnahme:** Datei-Upload oder Smartphone-Kamera (`<input type="file" accept="image/*" capture="environment">`).
2. **Pre-Processing (`vision.js`):**
* `jscanify` findet die Blattkanten des Lieferscheins und entzerrt die Perspektive (`extractPaper`).
* Umwandlung in Graustufen + Kontrastverstärkung/Binarisierung für optimale OCR-Lesbarkeit.
* Das entzerrte Bild wird als `Blob` behalten, um es nach Bestätigung direkt in `orders.attachments` hochzuladen.


3. **Texterkennung (`ocr.js`):**
* `Tesseract.js` (`deu` + `eng`) extrahiert alle Zeilen und Wörter inkl. Bounding Boxes (`bbox: {x0, y0, x1, y1}`).
* Alle Koordinaten werden durch Bildbreite/-höhe geteilt (Normierung auf `0.00` bis `1.00`).


4. **Lieferanten-Profile (`profiles/*.js`):**
* Jedes Profil exportiert ein Objekt mit:
* `detect(ocrResult)`: Prüft per RegEx im oberen Kopfbereich (`y < 0.3`), ob der Lieferschein zu diesem Lieferanten gehört (z. B. `"Mouser"`, `"Reichelt"`, `"Farnell"`, `"Voelkner"`).
* `extractOrderNo(ocrResult)`: RegEx für Auftrags-/Lieferscheinnummer.
* `columns`: Normierte X-Korridore für Artikelnummer (`partNoX: [min, max]`), gelieferte Menge (`qtyDeliveredX: [min, max]`) und Rückstand (`qtyBackorderX: [min, max]`) sowie RegEx für das Artikelnummern-Format.




5. **Review-UI (`scanner-modal.js`):**
* Zeigt das entzerrte Lieferschein-Bild mit eingezeichneten Bounding-Boxen neben einer Tabelle der zugeordneten `order_items`.
* Nutzer kann erkannte `qty_delivered`-Zahlen bei Bedarf korrigieren und klickt auf **"Übernehmen & Beleg anhängen"**.
