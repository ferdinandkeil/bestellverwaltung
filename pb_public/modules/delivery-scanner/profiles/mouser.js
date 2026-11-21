// Lieferanten-Profil Mouser Electronics, abgestimmt auf Lieferscheine („Lieferschein / Packing List“), Stand 11/2026.
//
// Aufbau des Lieferscheins (A4 quer, zweisprachig):
//   Kopf:     Logo „MOUSER“, Kasten „Bestellnummer / Purchase Order Number“ = unsere interne Bestellnummer
//   Tabelle:  Nr./LN | Mouser-Teilenummer, Herstellerteilenummer, Beschreibung | (Kundenartikelnummer) |
//             Datecode/Lot | Bestellte Menge | Gelieferte Menge | Ausstehende Menge
//             Alle Zellen gerahmt; die Mengen stehen klein (≈ 6,5 pt) und allein oben rechts in der Zelle.
//   Mouser-Teilenummern beginnen mit einem Herstellerkürzel aus 2–3 Ziffern und Bindestrich (z. B. 595-TCAN332D).
// Gelesen wird über die Teilenummer (Zeile) und die Tabellenlinien (Spalten, von rechts gezählt):
// gelieferte Menge = vorletzte, bestellte Menge = drittletzte, ausstehende Menge = letzte Spalte. Bestellte und
// ausstehende Menge dienen nur der Kontrolle (Abgleich mit der Bestellung, geliefert + ausstehend = bestellt).

export default {
  id: 'mouser',
  supplier: 'mouser',
  label: 'Mouser',
  // Logo „MOUSER“ (wird von der OCR nicht immer gelesen) oder Spaltenkopf „Mouser-Teilenummer / Mouser Part Number“
  detect: /\bMOUSER\b/i,
  detectMaxY: 0.45,
  rowAnchor: 'part',
  partPattern: /^\d{2,3}-[A-Z0-9][A-Z0-9\-/+.#]*$/,
  qtyColumns: { qty: 2, ordered: 3, pending: 1 },
};
