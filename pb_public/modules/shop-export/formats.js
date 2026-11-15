// Shop-Export: Formate je Lieferant (reine Logik, ohne Browser – testbar mit node --test).
//
// Zwei Arten:
//   kind 'csv':  Datei für den CSV-Upload des Shops (Schnellbestellung/BOM)
//     { id, label, supplier, kind: 'csv', delimiter, header: Kopfzeile (Array) oder null, row(line): Spalten aus { part, qty } }
//     Verifiziert mit Vorlagen und Test-Uploads in den Shops, Stand 11/2026. UTF-8 ohne BOM, Zeilenende CRLF.
//     Neue Shops erst nach einem Test-Upload eintragen.
//   kind 'text': Liste zum Kopieren in eine Bestell-Mail (Lieferanten ohne Shop-Upload)
//     { id, label, supplier, kind: 'text', recipient: Empfänger für die Anleitung }
//   kind 'checklist': Abhakliste zum Übertragen von Hand (Shop nimmt je Eingabe nur eine Nummer ohne Menge an)
//     { id, label, supplier, kind: 'checklist', shopUrl: Seite zum Eingeben der Nummern }
//     Je Position zwei Haken: Artikelnummer im Shop-Korb, Menge dort geprüft (Stand siehe checklistState).
// supplier ist ein fester Wert aus orders.supplier (nicht „other“).

export const FORMATS = [
  {
    id: 'mouser',
    label: 'Mouser',
    supplier: 'mouser',
    kind: 'csv',
    delimiter: ',',
    // Kopfzeile wie in der Mouser-Vorlage; „Customer Part Number“ bleibt leer, Quantity 2/3 dienen nur der Preisabfrage.
    header: ['Mouser or Manufacturer Part Number', 'Customer Part Number', 'Quantity 1', 'Quantity 2', 'Quantity 3'],
    row: ({ part, qty }) => [part, '', qty, '', ''],
  },
  {
    id: 'reichelt',
    label: 'Reichelt',
    supplier: 'reichelt',
    kind: 'csv',
    // Semikolon, weil Reichelt-Nummern Kommas und Leerzeichen enthalten („MKDS 1,5 3 5,08“).
    delimiter: ';',
    header: null,
    row: ({ part, qty }) => [part, qty],
  },
  {
    id: 'tme',
    label: 'TME',
    supplier: 'tme',
    kind: 'csv',
    delimiter: ';',
    header: null,
    row: ({ part, qty }) => [part, qty],
  },
  {
    // Bestellung (meist Muster) per Mail; nur Menge und Artikelnummer.
    id: 'wuerth',
    label: 'Würth Elektronik',
    supplier: 'wuerth',
    kind: 'text',
    recipient: 'Würth Elektronik',
  },
  {
    // „Bestellen mit Artikelnummer“ nimmt nur eine Nummer ohne Menge an (Stand 11/2026).
    id: 'printus',
    label: 'Printus',
    supplier: 'printus',
    kind: 'checklist',
    shopUrl: 'https://www.printus.de/warenkorb?do=true',
  },
];

/** Passendes Format zum Lieferanten der Bestellung oder null. */
export function formatForOrder(order) {
  if (!order) return null;
  return FORMATS.find((f) => f.supplier === order.supplier) ?? null;
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

/**
 * Liste für die Bestell-Mail: eine Zeile je Position „Menge × Nummer“, Mengen rechtsbündig,
 * Zeilenende LF, ohne abschließenden Zeilenumbruch (wird in den Mailtext eingefügt).
 */
export function buildText(lines) {
  const width = Math.max(0, ...lines.map((l) => String(l.qty).length));
  return lines.map((l) => `${String(l.qty).padStart(width)} × ${l.part}`).join('\n');
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

// ---------------------------------------------------------------------------
// Abhakliste (kind 'checklist')
// ---------------------------------------------------------------------------
// Stand: { parts: [Nummer, …], qty: [Nummer + NUL + Menge, …] } – nur im Browser gespeichert.
// Der Haken „Menge“ gilt für die abgehakte Menge: Ändert sich die Menge im Warenkorb, ist er wieder offen.
// Der Haken „Artikelnummer“ bleibt bei Mengenänderungen stehen (der Artikel liegt ja schon im Shop-Korb).

const qtyKey = (l) => l.part + '\u0000' + l.qty;

export function emptyChecklist() {
  return { parts: [], qty: [] };
}

/** Gespeicherten Stand prüfen (aus localStorage, kann fehlen oder beschädigt sein). */
export function parseChecklist(raw) {
  try {
    const v = JSON.parse(raw || 'null');
    if (v && Array.isArray(v.parts) && Array.isArray(v.qty)) {
      return { parts: v.parts.filter((x) => typeof x === 'string'), qty: v.qty.filter((x) => typeof x === 'string') };
    }
  } catch (_) { /* unbrauchbar → leer */ }
  return emptyChecklist();
}

/** Haken je Position: [{ ...line, partDone, qtyDone }]. */
export function checklistState(lines, state) {
  const parts = new Set(state.parts);
  const qty = new Set(state.qty);
  return lines.map((l) => ({ ...l, partDone: parts.has(l.part), qtyDone: qty.has(qtyKey(l)) }));
}

/** Haken setzen bzw. entfernen; which = 'part' | 'qty'. Liefert einen neuen Stand. */
export function toggleChecklist(state, line, which, done) {
  const key = which === 'part' ? 'parts' : 'qty';
  const value = which === 'part' ? line.part : qtyKey(line);
  let list = state[key].filter((x) => x !== value);
  if (which === 'qty') list = list.filter((x) => !x.startsWith(line.part + '\u0000')); // je Nummer nur eine Menge
  if (done) list.push(value);
  return { ...state, [key]: list };
}

/** Alle Positionen mit beiden Haken? (leere Liste: nein) */
export function checklistComplete(lines, state) {
  return lines.length > 0 && checklistState(lines, state).every((l) => l.partDone && l.qtyDone);
}

/** Abgehakte Nummern, die nicht mehr im Warenkorb stehen – im Shop-Korb wieder entfernen. */
export function checklistRemoved(lines, state) {
  const current = new Set(lines.map((l) => l.part));
  return state.parts.filter((p) => !current.has(p));
}

/** Entfernte Nummer erledigt: Haken der Nummer vergessen. */
export function forgetChecklistPart(state, part) {
  return { parts: state.parts.filter((p) => p !== part), qty: state.qty.filter((x) => !x.startsWith(part + '\u0000')) };
}
