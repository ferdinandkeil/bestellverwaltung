// Moodle-Import: Auswertung des CSV-Exports der Moodle-Datenbank-Aktivität „Bauteilbestellung“.
// Reine Logik ohne DOM (getestet in tests/moodle-csv.test.mjs). Das Einlesen der Datei übernimmt Papa Parse.
//
// Aufbau des Exports (Stand 11/2026): Lieferant, Anzahl, Bestellnummer, Kommentar (HTML), Gruppe, Tags.
// Bezeichnung/Link sind optional (falls das Moodle-Formular später ergänzt wird). Tags werden ignoriert.

import { SUPPLIERS } from '../../core/config.js';

/** Felder des Imports und typische Spaltenüberschriften. */
export const FIELDS = [
  { key: 'supplier', label: 'Lieferant', required: true, match: /^(lieferant|shop|händler|haendler|anbieter)$/i },
  { key: 'qty', label: 'Anzahl', required: true, match: /^(anzahl|menge|stückzahl|stueckzahl|stück)$/i },
  { key: 'part', label: 'Bestellnummer', required: true, match: /^(bestellnummer|bestell-nr\.?|artikelnummer|artikel-nr\.?)$/i },
  { key: 'group', label: 'Gruppe', required: false, match: /^(gruppe|team|thema)$/i },
  { key: 'name', label: 'Bezeichnung', required: false, match: /^(bezeichnung|beschreibung|artikel|bauteil)$/i },
  { key: 'url', label: 'Link', required: false, match: /^(link|url|produktlink)$/i },
  { key: 'comment', label: 'Kommentar', required: false, match: /^(kommentar|bemerkung|anmerkung)$/i },
];

/** Spalten anhand der Überschriften zuordnen → { supplier: index|-1, … }. */
export function guessColumns(headers) {
  const cols = {};
  for (const f of FIELDS) cols[f.key] = headers.findIndex((h) => f.match.test(String(h).trim()));
  return cols;
}

/** Wie normalizePartNumber in pb_hooks/lib/util.js (dort maßgeblich) – für Vorschau und Dublettenprüfung. */
export function normalizePartNumber(value) {
  return String(value ?? '').replace(/[\s​⁠]+/g, ' ').trim().toUpperCase();
}

/** Leerraum zusammenfassen (Gruppennamen aus Moodle enthalten teils lange Leerzeichenfolgen). */
export const collapse = (value) => String(value ?? '').replace(/[\s​⁠]+/g, ' ').trim();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HTML des Moodle-Kommentars → lesbarer Text (nur zur Anzeige, wird nicht gespeichert). */
export function stripHtml(html) {
  return collapse(String(html ?? '')
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    }));
}

/** Lieferantenangabe → { supplier, supplier_custom_name } (Vorschlag; im Import änderbar). */
export function suggestSupplier(value) {
  const raw = collapse(value);
  if (!raw) return { supplier: '', supplier_custom_name: '' };
  const key = raw.toLowerCase().replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z]/g, '');
  const known = SUPPLIERS.find((s) => s.value !== 'other' && (key === s.value || key.startsWith(s.value)));
  return known ? { supplier: known.value, supplier_custom_name: '' } : { supplier: 'other', supplier_custom_name: raw };
}

/** Menge: positive ganze Zahl oder null. */
export function parseQty(value) {
  const t = collapse(value);
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : null;
}

/**
 * Datensätze (Arrays ohne Kopfzeile) → Zeilen der Vorschau.
 * line = Zeilennummer in der Datei (Kopfzeile = 1). Leere Datensätze entfallen.
 */
export function buildRows(records, cols) {
  const cell = (r, key) => (cols[key] >= 0 ? String(r[cols[key]] ?? '') : '');
  return records
    .map((r, i) => ({ r, line: i + 2 }))
    .filter(({ r }) => r.some((c) => collapse(c)))
    .map(({ r, line }) => ({
      line,
      supplierRaw: collapse(cell(r, 'supplier')),
      qty: parseQty(cell(r, 'qty')),
      qtyRaw: collapse(cell(r, 'qty')),
      part: normalizePartNumber(cell(r, 'part')),
      name: collapse(cell(r, 'name')),
      url: collapse(cell(r, 'url')),
      comment: stripHtml(cell(r, 'comment')),
      groupRaw: collapse(cell(r, 'group')),
      include: true,
      groupChoice: '', // '' = wie Zuordnung der Gruppenbezeichnung
    }));
}

/** Verschiedene Werte einer Spalte in Reihenfolge des ersten Auftretens, mit Anzahl. */
export function distinctValues(rows, key) {
  const map = new Map();
  for (const r of rows) map.set(r[key], (map.get(r[key]) ?? 0) + 1);
  return [...map.entries()].map(([value, count]) => ({ value, count }));
}

const sameName = (a, b) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

/**
 * Vorschlag für die Gruppenzuordnung einer Bezeichnung:
 *   gleichnamige Gruppe der Veranstaltung → 'id:<id>' (als Vorschlag markiert), leer → 'none', sonst '' (offen).
 */
export function suggestGroup(value, courseGroups) {
  if (!value) return { choice: 'none', suggested: false };
  const match = courseGroups.find((g) => sameName(g.name, value));
  return match ? { choice: 'id:' + match.id, suggested: true } : { choice: '', suggested: false };
}

/**
 * Wirksame Gruppe einer Zeile.
 *   groupMap: { [groupRaw]: 'none' | 'new' | 'id:<id>' | 'rows' | '' }
 *   row.groupChoice überschreibt ('none' | 'id:<id>' | 'new:<groupRaw>')
 * → { kind: 'none' } | { kind: 'id', id } | { kind: 'new', value } | null (noch offen)
 */
export function effectiveGroup(row, groupMap) {
  const choice = row.groupChoice || groupMap[row.groupRaw] || '';
  if (choice === 'none') return { kind: 'none' };
  if (choice === 'new') return { kind: 'new', value: row.groupRaw };
  if (choice.startsWith('new:')) return { kind: 'new', value: choice.slice(4) };
  if (choice.startsWith('id:')) return { kind: 'id', id: choice.slice(3) };
  return null;
}

/** Lieferant einer Zeile aus der Zuordnung der Lieferantenangaben. */
export function effectiveSupplier(row, supplierMap) {
  const s = supplierMap[row.supplierRaw];
  if (!s?.supplier) return null;
  if (s.supplier === 'other' && !collapse(s.supplier_custom_name)) return null;
  return { supplier: s.supplier, supplier_custom_name: s.supplier === 'other' ? collapse(s.supplier_custom_name) : '' };
}

const cartKey = (supplier, part) =>
  [supplier.supplier, supplier.supplier_custom_name.toLowerCase(), normalizePartNumber(part)].join('|');

/**
 * Probleme und Hinweise je Zeile.
 *   openItems: Positionen offener Körbe [{ part_number, group_allocations, expand: { order: { supplier, supplier_custom_name } } }]
 * → Map line → { errors: [Text], warnings: [Text] }   (errors verhindern das Buchen der Zeile)
 */
export function checkRows(rows, groupMap, supplierMap, openItems = []) {
  const open = new Map();
  for (const it of openItems) {
    const o = it.expand?.order ?? {};
    const key = cartKey({ supplier: o.supplier ?? '', supplier_custom_name: o.supplier_custom_name ?? '' }, it.part_number);
    open.set(key, (it.group_allocations ?? []).map((a) => a.groupId || null));
  }
  const seen = new Map();
  const result = new Map();
  for (const row of rows) {
    const errors = [];
    const warnings = [];
    if (row.include) {
      const supplier = effectiveSupplier(row, supplierMap);
      const group = effectiveGroup(row, groupMap);
      if (!row.part) errors.push('Bestellnummer fehlt');
      if (!row.qty) errors.push(row.qtyRaw ? `Anzahl „${row.qtyRaw}“ ist keine ganze Zahl ≥ 1` : 'Anzahl fehlt');
      if (!supplier) errors.push('Lieferant nicht zugeordnet');
      if (!group) errors.push('Gruppe nicht zugeordnet');
      if (supplier && row.part && group) {
        const key = cartKey(supplier, row.part);
        const groupId = group.kind === 'id' ? group.id : group.kind === 'none' ? null : 'new:' + group.value;
        if ((open.get(key) ?? []).includes(groupId)) {
          warnings.push('steht für diese Gruppe schon im offenen Warenkorb – Menge würde erhöht');
        }
        const dupKey = key + '|' + groupId;
        if (seen.has(dupKey)) warnings.push(`gleiche Bestellnummer und Gruppe wie Zeile ${seen.get(dupKey)} – Mengen werden addiert`);
        else seen.set(dupKey, row.line);
      }
    }
    result.set(row.line, { errors, warnings });
  }
  return result;
}

/**
 * Daten für POST /api/lab/cart-items/batch aus den gewählten Zeilen.
 *   course, semester: Veranstaltung und Semester für neue Gruppen
 */
export function buildPayload(rows, groupMap, supplierMap, { course, semester }) {
  const newGroups = new Map(); // groupRaw → ref
  const items = [];
  for (const row of rows.filter((r) => r.include)) {
    const supplier = effectiveSupplier(row, supplierMap);
    const group = effectiveGroup(row, groupMap);
    const item = {
      line: row.line,
      ...supplier,
      part_number: row.part,
      name: row.name,
      qty: row.qty,
    };
    if (row.url) item.url = row.url;
    if (group.kind === 'id') item.group = group.id;
    if (group.kind === 'new') {
      if (!newGroups.has(group.value)) newGroups.set(group.value, 'g' + (newGroups.size + 1));
      item.groupRef = newGroups.get(group.value);
    }
    items.push(item);
  }
  const groups = [...newGroups.entries()].map(([value, ref]) => ({ ref, name: collapse(value), course: collapse(course), semester }));
  return { groups, items };
}
