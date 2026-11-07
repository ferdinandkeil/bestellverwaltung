// Registry der Lieferanten-Profile.
//
// Ein Profil beschreibt, wie ein Lieferschein eines Lieferanten gelesen wird:
//   {
//     id, supplier (Wert aus orders.supplier), label,
//     detect:  RegExp, die im oberen Seitenbereich (y < 0.3) auf den Lieferanten hinweist,
//     columns: { qty: RegExp, part: RegExp, desc: RegExp }  – Überschriften der Positionstabelle
//   }
// Neue Lieferanten: Datei in diesem Ordner anlegen und unten eintragen.
import reichelt from './reichelt.js';

export const PROFILES = [reichelt];

export function profileForSupplier(supplier) {
  return PROFILES.find((p) => p.supplier === supplier) ?? null;
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
