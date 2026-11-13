// Lieferanten-Profil Würth Elektronik (eiSos), abgestimmt auf Lieferscheine von Würth Elektronik, Stand 11/2026.
//
// Aufbau einer Lieferung (oft mehrere Dokumente, alle fotografiert):
//   Lieferschein: Pos. | Artikelnr. / Ihre Artikelnr. | Menge | Herkunft | Zolltarif-Nr.
//                 Zeile z. B. „001  2513130810105 /  2 STK  SI  85423911000“, darunter Barcode und Bezeichnung
//   Folgeseite:   Chargenliste (Artikelnr. | Charge | Menge, ohne Einheit)
//   Packliste:    Pos. | Artikel-Nr. | Menge | Charge (Menge ohne Einheit)
// Nur die Lieferschein-Zeilen haben die Einheit „STK“ – darüber gelesen, werden Chargen- und Packliste
// nicht doppelt gezählt.

export default {
  id: 'wuerth',
  supplier: 'wuerth',
  label: 'Würth Elektronik',
  detect: /W[üuöo]RTH|we-online/i,
  rowAnchor: 'unit',
  unit: 'STK',
};
