// Zentrale Konstanten des Frontends.
// Lieferanten- und Status-Werte müssen mit pb_schema.json und pb_hooks/lib/util.js übereinstimmen.

export const VAT_RATE = 0.19;

export const SUPPLIERS = [
  { value: 'mouser', label: 'Mouser' },
  { value: 'farnell', label: 'Farnell' },
  { value: 'reichelt', label: 'Reichelt' },
  { value: 'voelkner', label: 'Voelkner' },
  { value: 'other', label: 'Sonstiger Lieferant' },
];

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

export function statusMeta(value) {
  return STATUSES.find((s) => s.value === value) ?? { value, label: value, badge: 'bg-slate-100 text-slate-700 ring-slate-300' };
}
