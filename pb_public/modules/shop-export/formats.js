// Shop-Export: CSV-Formate der Upload-Masken je Shop (reine Logik, ohne Browser – testbar mit node --test).
//
// Ein Format beschreibt die Datei, die der Shop beim CSV-Upload (Schnellbestellung/BOM) annimmt:
//   {
//     id, label,
//     supplier:  Wert aus orders.supplier; bei 'other' zusätzlich
//     shopName:  RegExp auf orders.supplier_custom_name (z. B. /^tme/i),
//     delimiter: Trennzeichen,
//     header:    Kopfzeile (Array) oder null,
//     row(line): Spalten einer Position aus { part, qty },
//   }
// Verifiziert mit Vorlagen und Test-Uploads in den Shops, Stand 11/2026. Alle Dateien UTF-8 ohne BOM, Zeilenende CRLF.
// Neue Shops erst nach einem Test-Upload eintragen.

export const FORMATS = [
  {
    id: 'mouser',
    label: 'Mouser',
    supplier: 'mouser',
    delimiter: ',',
    // Kopfzeile wie in der Mouser-Vorlage; „Customer Part Number“ bleibt leer, Quantity 2/3 dienen nur der Preisabfrage.
    header: ['Mouser or Manufacturer Part Number', 'Customer Part Number', 'Quantity 1', 'Quantity 2', 'Quantity 3'],
    row: ({ part, qty }) => [part, '', qty, '', ''],
  },
  {
    id: 'reichelt',
    label: 'Reichelt',
    supplier: 'reichelt',
    // Semikolon, weil Reichelt-Nummern Kommas und Leerzeichen enthalten („MKDS 1,5 3 5,08“).
    delimiter: ';',
    header: null,
    row: ({ part, qty }) => [part, qty],
  },
  {
    id: 'tme',
    label: 'TME',
    supplier: 'other',
    shopName: /^\s*tme\b/i,
    delimiter: ';',
    header: null,
    row: ({ part, qty }) => [part, qty],
  },
];

/** Passendes Format zur Bestellung (Lieferant, bei „sonstige“ auch Shop-Name) oder null. */
export function formatForOrder(order) {
  if (!order) return null;
  return FORMATS.find((f) => f.supplier === order.supplier &&
    (f.supplier !== 'other' || !!f.shopName?.test(order.supplier_custom_name || ''))) ?? null;
}

/**
 * Zu bestellende Positionen: Menge = qty_ordered − qty_cancelled, komplett stornierte entfallen.
 * Liefert { lines: [{ id, part, name, qty }], skipped: Anzahl entfallener Positionen }.
 */
export function exportLines(items) {
  const lines = [];
  let skipped = 0;
  for (const it of items || []) {
    const qty = (it.qty_ordered || 0) - (it.qty_cancelled || 0);
    if (qty > 0 && it.part_number) lines.push({ id: it.id, part: it.part_number, name: it.name || '', qty });
    else skipped++;
  }
  lines.sort((a, b) => a.part.localeCompare(b.part, 'de', { numeric: true }));
  return { lines, skipped };
}

/** Feld nach RFC 4180 maskieren, wenn es Trennzeichen, Anführungszeichen oder Zeilenumbrüche enthält. */
function field(value, delimiter) {
  const s = String(value ?? '');
  return s.includes(delimiter) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV-Text im Format des Shops (CRLF, abschließender Zeilenumbruch). */
export function buildCsv(format, lines) {
  const rows = format.header ? [format.header] : [];
  for (const l of lines) rows.push(format.row(l));
  return rows.map((r) => r.map((v) => field(v, format.delimiter)).join(format.delimiter) + '\r\n').join('');
}

/** Dateiname, z. B. „mouser-2026IW01047.csv“ bzw. „tme-2026-11-12.csv“ ohne interne Bestellnummer. */
export function csvFileName(format, order, today = new Date()) {
  const date = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  return `${format.id}-${order?.internal_order_no || date}.csv`;
}

/** Stimmen zwei Positionslisten überein (Nummer und Menge)? */
export function sameLines(a, b) {
  const key = (lines) => lines.map((l) => l.part + '\u0000' + l.qty).sort().join('\u0001');
  return key(a) === key(b);
}
