// Zentrale Konstanten des Frontends.
// Lieferanten- und Status-Werte müssen mit pb_schema.json und pb_hooks/lib/util.js übereinstimmen.

export const VAT_RATE = 0.19;

export const SUPPLIERS = [
  { value: 'mouser', label: 'Mouser' },
  { value: 'farnell', label: 'Farnell' },
  { value: 'reichelt', label: 'Reichelt' },
  { value: 'voelkner', label: 'Voelkner' },
  { value: 'tme', label: 'TME' },
  // Bestellung per Mail, meist Muster: „ohne interne Bestellnummer“ ist vorausgewählt.
  { value: 'wuerth', label: 'Würth Elektronik', withoutInternalOrderNo: true },
  { value: 'other', label: 'Sonstiger Lieferant' },
];

/**
 * Vorauswahl „ohne interne Bestellnummer“ beim Bestellen: wenn die Bestellung schon so gekennzeichnet ist
 * oder der Lieferant meist ohne Nummer bestellt wird (Muster) – nie, wenn bereits eine Nummer eingetragen ist.
 */
export function defaultWithoutInternalOrderNo(order) {
  if (!order || order.internal_order_no) return false;
  return !!order.without_internal_order_no || !!SUPPLIERS.find((s) => s.value === order.supplier)?.withoutInternalOrderNo;
}

// Klassen stehen hier vollständig ausgeschrieben, damit der Tailwind-Build sie findet.
export const STATUSES = [
  { value: 'angefragt', label: 'Angefragt', badge: 'bg-slate-100 text-slate-700 ring-slate-300' },
  { value: 'bestellt', label: 'Bestellt', badge: 'bg-blue-50 text-blue-700 ring-blue-300' },
  { value: 'teilgeliefert', label: 'Teilgeliefert', badge: 'bg-amber-50 text-amber-800 ring-amber-300' },
  { value: 'geliefert', label: 'Geliefert', badge: 'bg-emerald-50 text-emerald-700 ring-emerald-300' },
  { value: 'geprueft', label: 'Geprüft', badge: 'bg-teal-50 text-teal-800 ring-teal-300' },
  { value: 'abgerechnet', label: 'Abgerechnet', badge: 'bg-zinc-200 text-zinc-700 ring-zinc-400' },
];

/** Status, in denen Positionen bearbeitet und Lieferungen gebucht werden dürfen. */
export const EDITABLE_STATUSES = ['angefragt', 'bestellt', 'teilgeliefert', 'geliefert'];
export const DELIVERY_STATUSES = ['bestellt', 'teilgeliefert', 'geliefert'];

/** Manuelle Statusschritte (Beschriftung der Buttons). */
export const ADVANCE_LABELS = {
  angefragt: 'Als bestellt markieren',
  geliefert: 'Als geprüft markieren',
  geprueft: 'Als abgerechnet markieren',
};
export const BACK_ALLOWED = ['bestellt', 'geprueft', 'abgerechnet'];

export function supplierLabel(order) {
  if (!order) return '';
  if (order.supplier === 'other') return order.supplier_custom_name || 'Sonstiger Lieferant';
  return SUPPLIERS.find((s) => s.value === order.supplier)?.label ?? order.supplier;
}

/** Interne Bestellnummer der Hochschule: JJJJIW##### (z. B. 2026IW01047). */
export const INTERNAL_ORDER_NO_RE = /^[0-9]{4}IW[0-9]{5}$/;

/** Kurzbezeichnung der Nummern einer Bestellung für Listen und Auswahlfelder. */
export function orderNumbersLabel(order) {
  if (!order) return '';
  const parts = [];
  if (order.internal_order_no) parts.push(order.internal_order_no);
  else if (order.without_internal_order_no) parts.push('ohne interne Bestellnummer');
  if (order.supplier_order_no) parts.push('Shop-Auftrag ' + order.supplier_order_no);
  return parts.join(' · ') || 'ohne Bestellnummer';
}

export function statusMeta(value) {
  return STATUSES.find((s) => s.value === value) ?? { value, label: value, badge: 'bg-slate-100 text-slate-700 ring-slate-300' };
}

// ---------------------------------------------------------------------------
// Semester („WS 2026/27“ bzw. „SS 2027“, Format wie in pb_schema.json geprüft)
// ---------------------------------------------------------------------------

export function formatSemester(term, year) {
  return term === 'WS' ? `WS ${year}/${String((year + 1) % 100).padStart(2, '0')}` : `SS ${year}`;
}

/** Zerlegt „WS 2026/27“ → { term: 'WS', year: 2026 }. */
export function parseSemester(value) {
  const m = /^(WS|SS) (\d{4})/.exec(value || '');
  return m ? { term: m[1], year: Number(m[2]) } : null;
}

/** Aktuelles Semester: SS von April bis September, sonst WS (Jan–März gehört zum WS des Vorjahres). */
export function currentSemester(date = new Date()) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (month >= 4 && month <= 9) return { term: 'SS', year };
  return { term: 'WS', year: month >= 10 ? year : year - 1 };
}

/** Sortierschlüssel in zeitlicher Reihenfolge (WS 2026/27 < SS 2027 < WS 2027/28). */
export function semesterSortKey(value) {
  const s = parseSemester(value);
  return s ? s.year * 2 + (s.term === 'WS' ? 1 : 0) : 0;
}

/** Jahre für die Semester-Auswahl: vom Vorjahr bis zwei Jahre voraus. */
export function semesterYears(date = new Date()) {
  const y = date.getFullYear();
  return [y - 1, y, y + 1, y + 2];
}

// ---------------------------------------------------------------------------
// Gruppen
// ---------------------------------------------------------------------------

/** Überschrift einer Veranstaltung im jeweiligen Semester. */
export function courseLabel(group) {
  return group ? `${group.course} (${group.semester})` : '';
}

/** Vollständige Bezeichnung zur eindeutigen Auswahl, z. B. „Gruppe A · Elektronik-Projekt (WS 2026/27)“. */
export function groupLabel(group) {
  return group ? `${group.name} · ${courseLabel(group)}` : '';
}

/** Gruppen nach Veranstaltung/Semester bündeln (neuestes Semester zuerst) – z. B. für <optgroup>. */
export function groupsByCourse(groups) {
  const map = new Map();
  for (const g of groups) {
    const key = courseLabel(g);
    if (!map.has(key)) map.set(key, { label: key, semester: g.semester, course: g.course, groups: [] });
    map.get(key).groups.push(g);
  }
  return [...map.values()]
    .sort((a, b) => semesterSortKey(b.semester) - semesterSortKey(a.semester) || a.course.localeCompare(b.course, 'de'))
    .map((c) => ({ ...c, groups: c.groups.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true })) }));
}
