// Auswertung der Lieferschein-Erkennung (ohne Server, ohne Browser).
// Die Seite ist synthetisch im Layout des Reichelt-Lieferscheins nachgebaut; die OCR-Fehler
// („CRCWO06…“, „KBB“) entsprechen denen, die Tesseract beim echten Beleg gemacht hat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePart, similarity, parseQty, extractRows, matchRows, orderNumberTokens, rankOrders,
  parseInternalOrderNo, findInternalOrderNumbers, findKnownInternalOrderNumbers, levenshtein, boxKey,
} from '../pb_public/modules/delivery-scanner/matcher.js';
import { detectProfile, profileById, profileForOrder, profileMatchesOrder } from '../pb_public/modules/delivery-scanner/profiles/index.js';

const reichelt = profileById('reichelt');

/** Wort an Position (x, y) in normierten Koordinaten; Breite ~ Zeichenanzahl. */
const word = (text, x, y, conf = 90) => ({ text, conf, bbox: { x0: x, y0: y, x1: x + text.length * 0.009, y1: y + 0.008 } });
/** Zeile: Menge rechtsbündig bei x≈0.13, Artikelnummer ab 0.18, Bezeichnung ab 0.34 */
function row(y, qty, part, desc, jitter = 0) {
  const ws = [word(String(qty), 0.135 - String(qty).length * 0.009, y + jitter)];
  let x = 0.18;
  for (const p of part.split(' ')) { ws.push(word(p, x, y)); x += p.length * 0.009 + 0.006; }
  x = 0.34;
  for (const d of desc.split(' ')) { ws.push(word(d, x, y - jitter)); x += d.length * 0.009 + 0.006; }
  return ws;
}

const PAGE = {
  words: [
    word('reichelt', 0.6, 0.06), word('elektronik', 0.65, 0.1),
    word('Bestellnummer', 0.11, 0.36), word('20261W01047', 0.11, 0.39),
    word('Rechnung:', 0.52, 0.17), word('3480800', 0.65, 0.17),
    word('Menge', 0.08, 0.48), word('Artikelnummer', 0.18, 0.48), word('Bezeichnung', 0.34, 0.48),
    ...row(0.505, 3, 'XIAO ESP32C6', 'Xiao ESP32C6, WiFi 6'),
    ...row(0.52, 4, 'MKDS 1,5 3 5,08', 'Leiterplattenklemme, 3 polig', 0.002),
    ...row(0.535, 10, 'WAL WR08X1200FTL', 'SMD-Widerstand, 0805'),
    ...row(0.55, 6, 'CRCWO060310K0 EC', 'SMD Widerstand 0603'),
    ...row(0.565, 3, 'CL10B105KBBNQNC', 'MLCC, 0603, 1µF'),
    ...row(0.58, 7, 'UNBEKANNT 123', 'Nicht bestellter Artikel'),
    // Fußzeile: kein Mengenwert → keine Position
    word('Volksbank', 0.07, 0.92), word('Jade-Weser', 0.16, 0.92), word('EUR-Konto', 0.32, 0.92),
  ],
};

const ITEMS = [
  { id: 'xiao', part_number: 'XIAO ESP32C6', qty_ordered: 3, qty_delivered: 0, qty_cancelled: 0 },
  { id: 'xiao3', part_number: 'XIAO ESP32C3', qty_ordered: 2, qty_delivered: 0, qty_cancelled: 0 },
  { id: 'mkds', part_number: 'MKDS 1,5 3 5,08', qty_ordered: 4, qty_delivered: 0, qty_cancelled: 0 },
  { id: 'wal', part_number: 'WAL WR08X1200FTL', qty_ordered: 10, qty_delivered: 5, qty_cancelled: 0 },
  { id: 'crcw', part_number: 'CRCW060310K0 EC', qty_ordered: 6, qty_delivered: 0, qty_cancelled: 0 },
  { id: 'crcw1k', part_number: 'CRCW06031K00 EC', qty_ordered: 6, qty_delivered: 0, qty_cancelled: 0 },
  { id: 'cl10', part_number: 'CL10B105KB8NQNC', qty_ordered: 3, qty_delivered: 0, qty_cancelled: 0 },
];

test('Normalisierung, Ähnlichkeit, Mengen mit OCR-Verwechslungen', () => {
  assert.equal(normalizePart(' mkds 1,5 3 5,08 '), 'MKDS153508');
  assert.equal(similarity('KEM X7R0805 100N', 'kem x7r0805 100n'), 1);
  assert.ok(similarity('CL10B105KBBNQNC', 'CL10B105KB8NQNC') > 0.9);
  assert.equal(parseQty('1O'), 10);
  assert.equal(parseQty('l2'), 12);
  assert.equal(parseQty('abc'), null);
  assert.equal(parseQty('0'), null);
  assert.equal(parseQty('Volksbank'), null, 'Wörter mit l/I/O sind keine Mengen');
  assert.equal(parseQty('IO'), null, 'ohne echte Ziffer keine Menge');
  assert.equal(parseQty('2S'), 25, 'S statt 5');
  assert.equal(parseQty('1B0'), 180, 'B statt 8');
  assert.equal(parseQty('Z0'), 20, 'Z statt 2');
  assert.equal(parseQty('G0'), 60, 'G statt 6');
  for (const t of ['ST', 'SB', 'BGZ', 'Stk', '10ST']) assert.equal(parseQty(t), null, t);
});

test('Profil wird über den Kopfbereich erkannt', () => {
  assert.equal(detectProfile([PAGE]).id, 'reichelt');
  assert.equal(detectProfile([{ words: [word('Mouser Electronics', 0.1, 0.05)] }]).id, 'mouser');
  assert.equal(detectProfile([{ words: [word('Conrad Electronic', 0.1, 0.05)] }]), null, 'Lieferant ohne Profil');
});

test('Zeilen werden über die Kopfzeile gelesen, Fußzeile ignoriert', () => {
  const { headerFound, rows } = extractRows(PAGE, reichelt);
  assert.ok(headerFound);
  assert.deepEqual(rows.map((r) => [r.qty, r.part]), [
    [3, 'XIAO ESP32C6'], [4, 'MKDS 1,5 3 5,08'], [10, 'WAL WR08X1200FTL'],
    [6, 'CRCWO060310K0 EC'], [3, 'CL10B105KBBNQNC'], [7, 'UNBEKANNT 123'],
  ]);
  assert.equal(extractRows({ words: PAGE.words.filter((w) => w.text !== 'Menge') }, reichelt).headerFound, false);
});

test('Zuordnung: sicher, unsicher, Rückstand überschritten, nicht zugeordnet', () => {
  const { rows } = extractRows(PAGE, reichelt);
  const { assignments, perItem } = matchRows(rows, ITEMS);

  assert.equal(perItem.xiao.qty, 3);
  assert.equal(perItem.xiao.status, 'sure');
  assert.equal(perItem.mkds.status, 'sure');
  assert.equal(perItem.crcw.qty, 6, 'OCR-Fehler O statt 0 wird aufgefangen');
  assert.equal(perItem.cl10.qty, 3, 'OCR-Fehler B statt 8 wird aufgefangen');
  assert.equal(perItem.xiao3, undefined, 'ähnliche Nummer XIAO ESP32C3 wird nicht verwechselt');
  assert.equal(perItem.crcw1k, undefined);

  assert.equal(perItem.wal.status, 'check', 'mehr als Rückstand (5) → prüfen');
  assert.match(perItem.wal.reasons.join(), /Rückstand \(5\)/);

  const unmatched = assignments.filter((a) => a.status === 'none');
  assert.deepEqual(unmatched.map((a) => a.row.part), ['UNBEKANNT 123']);
});

test('gleiche Position in zwei Zeilen → Mengen addiert, zur Prüfung markiert', () => {
  const rows = [{ qty: 1, part: 'XIAO ESP32C6' }, { qty: 2, part: 'XIAO ESP32C6' }];
  const { perItem } = matchRows(rows, ITEMS);
  assert.equal(perItem.xiao.qty, 3);
  assert.equal(perItem.xiao.status, 'check');
});

test('interne Bestellnummer trotz OCR-Verwechslungen lesen', () => {
  assert.equal(parseInternalOrderNo('2026IW01047'), '2026IW01047');
  assert.equal(parseInternalOrderNo('20261W01049'), '2026IW01049', 'I als 1 gelesen (TME, Reichelt)');
  assert.equal(parseInternalOrderNo('2026lW0lO47,'), '2026IW01047', 'l/O in Ziffern, Satzzeichen am Rand');
  assert.equal(parseInternalOrderNo('2026|VV01047'), '2026IW01047', 'W als VV gelesen');
  assert.equal(parseInternalOrderNo('2026/W01202'), '2026IW01202', 'I als / gelesen (kleine Schrift)');
  assert.equal(parseInternalOrderNo('2026I1W01204'), '2026IW01204', 'I verdoppelt gelesen');
  assert.equal(parseInternalOrderNo('2026IW0S876'), '2026IW05876', 'S in Ziffern als 5');
  assert.equal(parseInternalOrderNo('2O2GIWB1Z03'), '2026IW81203', 'G/B/Z in Ziffern');
  for (const t of ['40538175', '2026IW0104', 'IIIIIWlllll', 'L26DE440078', 'B26DE363696', '2026/11/W01202', '2026III1W01204', '']) {
    assert.equal(parseInternalOrderNo(t), null, t);
  }
});

test('interne Bestellnummer auf allen Seiten finden, auch getrennt gelesen', () => {
  const page2 = { words: [word('Bestellnummer', 0.1, 0.2), word('des', 0.2, 0.2), word('Kunden', 0.25, 0.2), word('2026IW', 0.4, 0.2), word('00777', 0.47, 0.2)] };
  assert.deepEqual(findInternalOrderNumbers([PAGE, page2, PAGE]), ['2026IW01047', '2026IW00777']);
  assert.deepEqual(findInternalOrderNumbers([{ words: [word('Kundennummer', 0.1, 0.1), word('40538175', 0.3, 0.1)] }]), []);
});

test('Rückfall: Bestellung über unscharf gelesene Nummer finden (intern oder Shop)', () => {
  const tokens = orderNumberTokens(PAGE);
  assert.ok(tokens.includes('20261W01047'));
  assert.ok(!tokens.includes('Volksbank'));
  const ranked = rankOrders([
    { id: 'a', internal_order_no: '2026IW00999' },
    { id: 'b', internal_order_no: '2026IW01047' },
    { id: 'c', supplier_order_no: '' },
  ], tokens);
  assert.equal(ranked[0].order.id, 'b');
  assert.ok(ranked[0].sim > 0.9);
  assert.ok(ranked[0].sim - ranked[1].sim > 0.1);
});

// ---------------------------------------------------------------------------
// Profile ohne Kopfzeile (Zeilen über die Mengeneinheit): TME, Würth – synthetische Seiten
// ---------------------------------------------------------------------------
const tme = profileById('tme');
const wuerth = profileById('wuerth');

/** Wörter einer Zeile ab x, mit Abstand; dy verschiebt einzelne Zeilen (schiefes Blatt). */
const lineAt = (y, x, texts, step = 0.006) => texts.map((t) => { const w = word(t, x, y); x += t.length * 0.009 + step; return w; });

/** TME-Layout: Lfd. Nr. | Artikel (fett) + Hersteller/Beschreibung darunter | Anzahl „n ST“ rechts. Kopfzeile fehlt (OCR). */
const TME_PAGE = {
  words: [
    word('TME', 0.04, 0.21), word('Germany', 0.09, 0.21), word('GmbH', 0.17, 0.21),
    word('Bestellnummer', 0.59, 0.10), word('des', 0.7, 0.10), word('Kunden', 0.73, 0.10), word('20261W00321', 0.83, 0.10),
    word('Kundennummer', 0.67, 0.14), word('12345678', 0.86, 0.14),
    // Position 1: Blatt leicht schief – die Einheit liegt rechts tiefer als die Artikelzeile
    // (Artikelzeile 0,66 Zeilenhöhen über der Einheit, Herstellerzeile 0,78 darunter – beide ähnlich nah)
    word('1', 0.05, 0.3405), word('TST-ABC123', 0.10, 0.337), word('4', 0.887, 0.3423), word('ST', 0.902, 0.3423),
    ...lineAt(0.3485, 0.10, ['Hersteller:', 'MUSTER', 'Herstellersymbol:', 'ABC123']),
    ...lineAt(0.356, 0.10, ['IC:Beispiel;5VDC;SO8']),
    // Position 2: Menge von der OCR eine halbe Zeile tiefer gelesen
    word('2', 0.05, 0.386), word('NTC-10K-1%', 0.10, 0.383), word('ST', 0.902, 0.389), word('10', 0.88, 0.3893),
    ...lineAt(0.392, 0.10, ['Hersteller:', 'BEISPIEL', 'Herstellersymbol:', 'NTC-10K-1%']),
    // Position 3: OCR liest „3ST“ als ein Wort und verliert die Positionsnummer
    word('DCDC-X1/CHY', 0.10, 0.431), word('3ST', 0.89, 0.431),
    ...lineAt(0.438, 0.10, ['Hersteller:', 'BEISPIEL', 'Herstellersymbol:', 'DCDC-X1/CHY']),
    // Fließtext ohne Einheit
    ...lineAt(0.47, 0.04, ['Die', 'Bestellung', 'wurde', '2', 'Mal', 'geprüft', 'STATUS']),
  ],
};

/** Würth-Layout: Lieferschein mit „n STK“, dazu Chargen- und Packliste ohne Einheit (dürfen nicht doppelt zählen). */
const WE_DELIVERY = {
  words: [
    word('WÜRTH', 0.6, 0.05), word('ELEKTRONIK', 0.7, 0.05),
    ...lineAt(0.50, 0.02, ['Pos.', 'Artikelnr.', '/', 'Ihre', 'Artikelnr.']), word('Menge', 0.47, 0.50), word('Herkunft', 0.63, 0.50),
    ...lineAt(0.535, 0.07, ['Unsere', 'Auftragsnummer', 'X26DE000001', 'von', '02.11.2026']),
    word('001', 0.03, 0.551), word('1111111111105', 0.07, 0.551), word('/', 0.19, 0.551), word('2', 0.49, 0.551), word('STK', 0.51, 0.551), word('SI', 0.66, 0.551), word('85423911000', 0.76, 0.551),
    ...lineAt(0.578, 0.07, ['SENSOR-A', '3', 'to', '5,5', 'V']),
    word('002', 0.03, 0.669), word('1111111111101', 0.08, 0.669), word('/', 0.2, 0.669), word('3', 0.5, 0.669), word('STK', 0.51, 0.669), word('SI', 0.66, 0.669),
  ],
};
const WE_PACKING = {
  words: [
    ...lineAt(0.40, 0.05, ['Pos.', 'Artikel-Nr./', 'Ihre', 'Artikelnummer']), word('Menge', 0.38, 0.40), word('Charge', 0.51, 0.40),
    word('1', 0.05, 0.484), word('1111111111101', 0.08, 0.484), word('3', 0.38, 0.484),
    word('2', 0.05, 0.626), word('1111111111105', 0.09, 0.626), word('2', 0.38, 0.626), word('444010012510000', 0.51, 0.626),
  ],
};

test('Profile TME und Würth: Erkennung über den Kopf, Zuordnung über den Lieferanten', () => {
  assert.equal(detectProfile([TME_PAGE]).id, 'tme');
  assert.equal(detectProfile([WE_DELIVERY]).id, 'wuerth');
  assert.equal(profileForOrder({ supplier: 'tme' }).id, 'tme');
  assert.equal(profileForOrder({ supplier: 'wuerth' }).id, 'wuerth');
  assert.equal(profileForOrder({ supplier: 'other', supplier_custom_name: 'TME' }), null, 'sonstige haben kein Profil');
  assert.equal(profileForOrder({ supplier: 'reichelt' }).id, 'reichelt');
  assert.equal(profileMatchesOrder(tme, { supplier: 'reichelt' }), false);
  assert.equal(profileMatchesOrder(tme, { supplier: 'wuerth' }), false);
});

test('TME: Zeilen über die Einheit „ST“ – trotz schiefem Blatt, versetzter Menge, „3ST“ und fehlender Kopfzeile', () => {
  const { headerFound, rows } = extractRows(TME_PAGE, tme);
  assert.equal(headerFound, null, 'keine Kopfzeile nötig');
  assert.deepEqual(rows.map((r) => [r.qty, r.part]), [[4, 'TST-ABC123'], [10, 'NTC-10K-1%'], [3, 'DCDC-X1/CHY']]);
});

test('Würth: nur Lieferschein-Zeilen mit „STK“ zählen, Packliste nicht doppelt', () => {
  assert.deepEqual(extractRows(WE_DELIVERY, wuerth).rows.map((r) => [r.qty, r.part]), [[2, '1111111111105'], [3, '1111111111101']]);
  assert.deepEqual(extractRows(WE_PACKING, wuerth), { headerFound: null, rows: [] });
});

test('Einheit: unlesbare Menge vor „ST“ → Zeile ohne Menge, Zellen-Lesen ergänzt sie', () => {
  const page = { words: [
    word('TME', 0.04, 0.05),
    word('1', 0.05, 0.30), word('TST-ABC123', 0.10, 0.30), word('4ST', 0.89, 0.30),
    word('2', 0.05, 0.35), word('NTC-10K-1%', 0.10, 0.35), word('To', 0.88, 0.35), word('ST', 0.902, 0.35),
  ] };
  const first = extractRows(page, tme).rows;
  assert.deepEqual(first.map((r) => [r.qty, r.part]), [[4, 'TST-ABC123'], [null, 'NTC-10K-1%']]);
  assert.ok(first[1].cells.qty.box.x1 <= 0.902 + 0.01, 'Mengenbereich liegt vor der Einheit');
  const reads = new Map([[boxKey(first[1].cells.qty.box), { value: 10, conf: 90 }]]);
  assert.deepEqual(extractRows(page, tme, reads).rows.map((r) => r.qty), [4, 10]);
});

test('Zellen-Lesen widerspricht der Seiten-OCR → Zellenwert (bei ausreichender Sicherheit), Zeile unsicher', () => {
  const page = { words: [word('1', 0.05, 0.30), word('TST-ABC123', 0.10, 0.30), word('7', 0.89, 0.30), word('ST', 0.902, 0.30)] };
  const [row] = extractRows(page, tme).rows;
  const key = boxKey(row.cells.qty.box);
  const sure = extractRows(page, tme, new Map([[key, { value: 1, conf: 90 }]])).rows[0];
  assert.deepEqual([sure.qty, sure.qtyConflict], [1, true]);
  const weak = extractRows(page, tme, new Map([[key, { value: 1, conf: 30 }]])).rows[0];
  assert.deepEqual([weak.qty, weak.qtyConflict], [7, true]);
});

// ---------------------------------------------------------------------------
// Mouser: Zeilen über die Teilenummer, Mengen aus den Tabellenspalten (Linien aus vision.prepareForOcr)
// ---------------------------------------------------------------------------
const mouser = profileById('mouser');
const hLine = (y, x0, x1) => ({ y, x0, x1 });
const vLine = (x, y0, y1) => ({ x, y0, y1 });
/** Mouser-Layout (A4 quer): Spalten LN | Teilenummer … | Lot | bestellt | geliefert | ausstehend. */
const MOUSER_PAGE = {
  width: 3000,
  height: 2100,
  words: [
    word('MOUSER', 0.1, 0.08),
    // Kopf: Telefonnummer neben einem Strichcode (senkrechte Striche) und dem Infokasten rechts
    word('Ph.', 0.03, 0.2), word('(800)', 0.05, 0.2), word('346-6873', 0.09, 0.2),
    word('Bestellnummer', 0.65, 0.1), word('2026IW01047', 0.75, 0.13),
    // Position 1: alle Mengen auf der Seite gelesen
    word('001', 0.04, 0.43), word('595-TCAN332D', 0.08, 0.43), word('Taric:', 0.3, 0.45), word('8542399000', 0.36, 0.45),
    ...lineAt(0.47, 0.08, ['TI', 'CAN', 'Interface', 'IC', '3.3-V']),
    word('4', 0.785, 0.43), word('4', 0.885, 0.43), word('0', 0.965, 0.43),
    // Position 2: gelieferte Menge auf der Seite nicht gelesen (nur im Zellen-Lesen)
    word('002', 0.04, 0.56), word('511-LD1117S33TR', 0.08, 0.56), word('25', 0.776, 0.56), word('5', 0.965, 0.56),
    ...lineAt(0.60, 0.08, ['STMicroelectronics', 'LDO', '3.3V']),
  ],
  lines: {
    v: [
      vLine(0.015, 0.05, 0.3), vLine(0.02, 0.05, 0.3), // Strichcode
      vLine(0.62, 0.02, 0.25), vLine(0.72, 0.02, 0.25), vLine(0.98, 0.02, 0.25), // Infokasten
      // Tabelle (eine Linie durch Zeilentrenner unterbrochen)
      ...[0.03, 0.07, 0.55, 0.70, 0.80, 0.90, 0.98].map((x) => vLine(x, 0.36, 0.95)),
      vLine(0.801, 0.36, 0.5), vLine(0.802, 0.51, 0.95),
    ],
    h: [
      hLine(0.05, 0.62, 0.98), hLine(0.15, 0.62, 0.98), // Infokasten
      hLine(0.36, 0.03, 0.98), hLine(0.42, 0.03, 0.6), hLine(0.42, 0.61, 0.98), // Kopfzeile, mit kleiner Lücke
      hLine(0.55, 0.03, 0.98), hLine(0.68, 0.03, 0.98),
    ],
  },
};

test('Mouser: Erkennung, Zeilen über die Teilenummer, Mengen aus Tabellenspalten, Kopf ignoriert', () => {
  assert.equal(detectProfile([MOUSER_PAGE]).id, 'mouser');
  // Logo nicht gelesen: Spaltenkopf der Tabelle genügt (größerer Suchbereich nur für Mouser)
  assert.equal(detectProfile([{ words: [word('Mouser-Teilenummer', 0.08, 0.38), word('Würth', 0.1, 0.38)] }]).id, 'mouser');
  assert.equal(detectProfile([{ words: [word('Würth', 0.1, 0.38)] }]), null, 'andere Profile nur im Kopf (y < 0,3)');
  assert.equal(profileForOrder({ supplier: 'mouser' }).id, 'mouser');
  const { rows } = extractRows(MOUSER_PAGE, mouser);
  assert.deepEqual(rows.map((r) => [r.part, r.qty, r.qtyOrdered, r.qtyPending]), [['595-TCAN332D', 4, 4, 0], ['511-LD1117S33TR', null, 25, 5]]);
  // Mengenbereich „geliefert“ liegt in der vorletzten Spalte, auf Höhe der Teilenummer
  const box = rows[1].cells.qty.box;
  assert.ok(box.x0 > 0.80 && box.x1 < 0.90 && box.y0 < 0.56 && box.y1 > 0.568, JSON.stringify(box));
  const reads = new Map([[boxKey(box), { value: 20, conf: 90 }]]);
  assert.deepEqual(extractRows(MOUSER_PAGE, mouser, reads).rows.map((r) => r.qty), [4, 20]);
});

test('Mouser: ohne Tabellenlinien keine Mengen (Zeilen werden nicht geraten)', () => {
  assert.deepEqual(extractRows({ ...MOUSER_PAGE, lines: null }, mouser).rows, []);
});

test('Abgleich: unlesbare Menge → offene Menge vorgeschlagen, abweichende Bestellmenge und Widerspruch → prüfen', () => {
  const items = [
    { id: 'a', part_number: '595-TCAN332D', qty_ordered: 4, qty_delivered: 1, qty_cancelled: 0 },
    { id: 'b', part_number: '511-LD1117S33TR', qty_ordered: 25, qty_delivered: 0, qty_cancelled: 0 },
    { id: 'c', part_number: '81-GRM188R71H104KA3D', qty_ordered: 100, qty_delivered: 0, qty_cancelled: 0 },
  ];
  const rows = [
    { part: '595-TCAN332D', qty: null, qtyOrdered: 4, box: {} },
    { part: '511-LD1117S33TR', qty: 20, qtyOrdered: 30, box: {} },
    { part: '81-GRM188R71H104KA3D', qty: 100, qtyOrdered: 100, qtyConflict: true, box: {} },
  ];
  const { perItem } = matchRows(rows, items);
  assert.deepEqual([perItem.a.qty, perItem.a.status], [3, 'check']);
  assert.ok(perItem.a.reasons.includes('Menge nicht lesbar – offene Menge vorgeschlagen'));
  assert.deepEqual([perItem.b.qty, perItem.b.status], [20, 'check']);
  assert.ok(perItem.b.reasons.includes('bestellt laut Lieferschein 30, in der Bestellung 25'));
  assert.deepEqual([perItem.c.qty, perItem.c.status, perItem.c.reasons], [100, 'check', ['Menge unsicher gelesen']]);
});

test('Abgleich: Teillieferung nur sicher, wenn geliefert + ausstehend = bestellt', () => {
  const items = [{ id: 'a', part_number: '710-885012206046', qty_ordered: 25, qty_delivered: 0, qty_cancelled: 0 }];
  const run = (row) => matchRows([{ part: '710-885012206046', box: {}, ...row }], items).perItem.a;
  assert.equal(run({ qty: 20, qtyOrdered: 25, qtyPending: 5 }).status, 'sure');
  assert.equal(run({ qty: 25, qtyOrdered: 25, qtyPending: null }).status, 'sure');
  const misread = run({ qty: 2, qtyOrdered: 25, qtyPending: 5 }); // „20“ als „2“ gelesen
  assert.deepEqual([misread.status, misread.reasons], ['check', ['Teillieferung – Menge bitte prüfen']]);
  assert.equal(run({ qty: 2, qtyOrdered: 25, qtyPending: null }).status, 'check');
});

test('Abgleich: weniger als der Rückstand ohne Bestätigung durch den Lieferschein → prüfen', () => {
  const items = [{ id: 'a', part_number: '595-SN74HC595N', qty_ordered: 10, qty_delivered: 0, qty_cancelled: 0 }];
  const run = (row) => matchRows([{ part: '595-SN74HC595N', box: {}, ...row }], items).perItem.a;
  // „10“ als „3“ gelesen, bestellte Menge nicht lesbar (Mouser-Testbeleg 6,5 pt)
  const misread = run({ qty: 3, qtyOrdered: null, qtyPending: 0 });
  assert.deepEqual([misread.status, misread.reasons], ['check', ['Teillieferung – Menge bitte prüfen']]);
  assert.equal(run({ qty: 3 }).status, 'check', 'Profil ohne Spalten bestellt/ausstehend');
  assert.equal(run({ qty: 3, qtyOrdered: 10, qtyPending: 7 }).status, 'sure', 'vom Lieferschein bestätigt');
  assert.equal(run({ qty: 10 }).status, 'sure', 'volle offene Menge');
  assert.equal(run({ qty: 10, qtyOrdered: null, qtyPending: 0 }).status, 'sure');
  // Rest einer früheren Teillieferung: offen 5, geliefert 5
  const rest = [{ ...items[0], qty_delivered: 5 }];
  assert.equal(matchRows([{ part: '595-SN74HC595N', qty: 5, box: {} }], rest).perItem.a.status, 'sure');
});

test('Verwechslungen Buchstabe/Ziffer zählen beim Vergleich von Bestellnummern nur halb', () => {
  assert.equal(levenshtein('LD1117S33TR', 'LD1117533TR'), 0.5);
  assert.equal(levenshtein('ABC', 'ABX'), 1);
  assert.ok(similarity('511-LD1117533TR', '511-LD1117S33TR') > similarity('511-LD1117X33TR', '511-LD1117S33TR'));
  // ähnliche Nummern bleiben unterscheidbar: echte Abweichung kostet voll
  assert.ok(similarity('XIAO ESP32C6', 'XIAO ESP32C3') < 0.95);
});

test('bekannte interne Nummern offener Bestellungen auch stark verlesen finden', () => {
  const known = ['2026IW09876', '2026IW01047', '2026IW01048', ''];
  const page = (...texts) => ({ words: texts.map((t, i) => word(t, 0.1 + i * 0.12, 0.2)) });
  assert.deepEqual(findKnownInternalOrderNumbers([page('Bestellnummer', '2026IW0S876')], known), ['2026IW09876'], 'S statt 9: eine Abweichung');
  assert.deepEqual(findKnownInternalOrderNumbers([page('2026IW', '09B76')], known), ['2026IW09876'], 'getrennt gelesen');
  assert.deepEqual(findKnownInternalOrderNumbers([page('2026|VV09876')], known), ['2026IW09876']);
  assert.deepEqual(findKnownInternalOrderNumbers([page('2026IW0104X')], known), [], 'passt zu zwei Bestellungen → keine Zuordnung');
  assert.deepEqual(findKnownInternalOrderNumbers([page('20280W0%75')], known), [], 'zu stark verlesen');
  assert.deepEqual(findKnownInternalOrderNumbers([page('2026IW05278')], known), [], 'andere Nummer');
  assert.deepEqual(findKnownInternalOrderNumbers([page('2026IW0S876')], []), []);
});
