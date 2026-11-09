// Registry der Lieferanten-Profile.
//
// Ein Profil beschreibt, wie ein Lieferschein eines Lieferanten gelesen wird:
//   {
//     id, label,
//     supplier:  Wert aus orders.supplier; bei 'other' zusätzlich
//     shopName:  RegExp auf orders.supplier_custom_name (z. B. /^tme/i),
//     detect:    RegExp, die im oberen Seitenbereich (y < 0.3) auf den Lieferanten hinweist,
//     und eine der beiden Lesarten der Positionstabelle:
//       columns: { qty, part, desc }     – Überschriften der Spalten (Kopfzeile, z. B. Reichelt)
//       rowAnchor: 'unit', unit: RegExp  – Zeilen über die Mengeneinheit („4 ST“), ohne Kopfzeile (z. B. TME, Würth)
//   }
// Neue Lieferanten: Datei in diesem Ordner anlegen und unten eintragen.
import reichelt from './reichelt.js';
import tme from './tme.js';
import wuerth from './wuerth.js';

export const PROFILES = [reichelt, tme, wuerth];

export function profileById(id) {
  return PROFILES.find((p) => p.id === id) ?? null;
}

/** Passt das Profil zur Bestellung (Lieferant, bei „sonstige“ auch Shop-Name)? */
export function profileMatchesOrder(profile, order) {
  if (!profile || !order || profile.supplier !== order.supplier) return false;
  return profile.supplier !== 'other' || !!profile.shopName?.test(order.supplier_custom_name || '');
}

/** Profil zur Bestellung (oder null). */
export function profileForOrder(order) {
  return PROFILES.find((p) => profileMatchesOrder(p, order)) ?? null;
}

/** Text im oberen Seitenbereich (für die Lieferanten-Erkennung). */
function headerText(page, maxY = 0.3) {
  return page.words.filter((w) => w.bbox.y1 < maxY).map((w) => w.text).join(' ');
}

/** Profil anhand der ersten Seite erkennen (oder null). */
export function detectProfile(pages) {
  if (!pages.length) return null;
  const text = headerText(pages[0]);
  return PROFILES.find((p) => p.detect.test(text)) ?? null;
}
