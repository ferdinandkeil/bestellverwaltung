// Lieferanten-Profil Reichelt (abgestimmt auf Lieferscheine von reichelt elektronik, Stand 11/2026).
//
// Aufbau des Lieferscheins:
//   Kopf:     Logo „reichelt elektronik“, „Bestellnummer“ (z. B. 2026IW01047) = unsere supplier_order_no
//   Tabelle:  Menge | Artikelnummer | Bezeichnung   (Artikelnummer = Reichelt-Bestellnummer, kann Leerzeichen enthalten)
//   Es gibt keine Spalten für bestellte Menge oder Rückstand.

export default {
  id: 'reichelt',
  supplier: 'reichelt',
  label: 'Reichelt',

  /** Erkennung im oberen Seitenbereich (normierte y-Koordinate < 0.3). */
  detect: /reichelt/i,

  /** Spaltenüberschriften der Positionstabelle (je ein Wort). */
  columns: {
    qty: /^Menge$/i,
    part: /^Artikel(nummer)?$/i,
    desc: /^Bezeichnung$/i,
  },
};
