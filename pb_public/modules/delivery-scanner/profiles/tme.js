// Lieferanten-Profil TME (Transfer Multisort Elektronik), abgestimmt auf Lieferscheine von TME Germany, Stand 11/2026.
//
// Aufbau des Lieferscheins:
//   Kopf:     „TME Germany GmbH“, „Bestellnummer des Kunden“ = unsere interne Bestellnummer (JJJJIW#####)
//   Tabelle:  Lfd. Nr. | Artikel | Anzahl
//             Artikel: erste Zeile fett = TME-Symbol (unsere Bestellnummer), darunter Hersteller und Beschreibung
//             Anzahl rechts mit Einheit, z. B. „4 ST“
//   Die Kopfzeile ist grau hinterlegt und wird von der OCR oft nicht gelesen → Zeilen über die Einheit „ST“ finden.

export default {
  id: 'tme',
  supplier: 'other',
  /** Shop-Name einer „sonstigen“ Bestellung, zu dem das Profil gehört. */
  shopName: /^\s*tme\b/i,
  label: 'TME',
  detect: /\bTME\b|tme-germany|Transfer Multisort/i,
  /** Positionszeilen: Menge direkt vor der Einheit, Bestellnummer am Zeilenanfang (nach der Positionsnummer). */
  rowAnchor: 'unit',
  /** Mengeneinheit (Text, Großbuchstaben); erkannt als eigenes Wort oder an der Menge („3ST“). */
  unit: 'ST',
};
