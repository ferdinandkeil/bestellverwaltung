// Auswertung der Lieferschein-Erkennung (ohne Server, ohne Browser).
// Die Seite ist synthetisch im Layout des Reichelt-Lieferscheins nachgebaut; die OCR-Fehler
// („CRCWO06…“, „KBB“) entsprechen denen, die Tesseract beim echten Beleg gemacht hat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePart, similarity, parseQty, extractRows, matchRows, orderNumberTokens, rankOrders,
} from '../pb_public/modules/delivery-scanner/matcher.js';
import { detectProfile, profileForSupplier } from '../pb_public/modules/delivery-scanner/profiles/index.js';

const reichelt = profileForSupplier('reichelt');

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
});

test('Profil wird über den Kopfbereich erkannt', () => {
  assert.equal(detectProfile([PAGE]).id, 'reichelt');
  assert.equal(detectProfile([{ words: [word('Mouser Electronics', 0.1, 0.05)] }]), null);
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

test('Bestellung über unscharf gelesene Auftragsnummer finden', () => {
  const tokens = orderNumberTokens(PAGE);
  assert.ok(tokens.includes('20261W01047'));
  assert.ok(!tokens.includes('Volksbank'));
  const ranked = rankOrders([
    { id: 'a', supplier_order_no: '2026IW00999' },
    { id: 'b', supplier_order_no: '2026IW01047' },
    { id: 'c', supplier_order_no: '' },
  ], tokens);
  assert.equal(ranked[0].order.id, 'b');
  assert.ok(ranked[0].sim > 0.9);
  assert.ok(ranked[0].sim - ranked[1].sim > 0.1);
});
