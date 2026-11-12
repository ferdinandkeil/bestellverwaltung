// Shop-Export: CSV-Formate je Shop – ohne Server, ohne Browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatForOrder, exportLines, buildCsv, csvFileName, sameLines,
} from '../pb_public/modules/shop-export/formats.js';

const item = (part, qty_ordered, qty_cancelled = 0, name = '') => ({ id: part, part_number: part, name, qty_ordered, qty_cancelled });

test('Format je Lieferant: Mouser, Reichelt, TME als sonstiger Shop; andere ohne Format', () => {
  assert.equal(formatForOrder({ supplier: 'mouser' }).id, 'mouser');
  assert.equal(formatForOrder({ supplier: 'reichelt' }).id, 'reichelt');
  assert.equal(formatForOrder({ supplier: 'other', supplier_custom_name: ' TME Germany' }).id, 'tme');
  assert.equal(formatForOrder({ supplier: 'other', supplier_custom_name: 'Würth' }), null);
  assert.equal(formatForOrder({ supplier: 'other', supplier_custom_name: '' }), null);
  assert.equal(formatForOrder({ supplier: 'farnell' }), null);
  assert.equal(formatForOrder({ supplier: 'voelkner' }), null);
  assert.equal(formatForOrder(null), null);
});

test('Menge = bestellt − storniert, komplett stornierte entfallen, sortiert nach Nummer', () => {
  const { lines, skipped } = exportLines([
    item('B-2', 10, 3, 'Zwei'), item('A-10', 1), item('A-9', 4, 4), item('A-2', 2),
  ]);
  assert.deepEqual(lines.map((l) => [l.part, l.qty]), [['A-2', 2], ['A-10', 1], ['B-2', 7]]);
  assert.equal(skipped, 1);
  assert.equal(lines[2].name, 'Zwei');
});

test('Mouser: Kopfzeile wie Vorlage, Komma, Customer Part Number leer, CRLF', () => {
  const csv = buildCsv(formatForOrder({ supplier: 'mouser' }), [{ part: '595-SN74HC595N', qty: 2 }, { part: '511-NUCLEO-G031K8', qty: 1 }]);
  assert.equal(csv,
    'Mouser or Manufacturer Part Number,Customer Part Number,Quantity 1,Quantity 2,Quantity 3\r\n' +
    '595-SN74HC595N,,2,,\r\n' +
    '511-NUCLEO-G031K8,,1,,\r\n');
});

test('Reichelt: Semikolon ohne Kopfzeile, Komma und Leerzeichen in der Nummer bleiben unmaskiert', () => {
  const csv = buildCsv(formatForOrder({ supplier: 'reichelt' }), [{ part: 'MKDS 1,5 3 5,08', qty: 2 }, { part: 'XIAO ESP32C6', qty: 1 }]);
  assert.equal(csv, 'MKDS 1,5 3 5,08;2\r\nXIAO ESP32C6;1\r\n');
});

test('TME: Semikolon ohne Kopfzeile; Felder mit Trennzeichen oder Anführungszeichen werden maskiert', () => {
  const tme = formatForOrder({ supplier: 'other', supplier_custom_name: 'TME' });
  assert.equal(buildCsv(tme, [{ part: 'NTCM-HP-2K2-1%', qty: 10 }]), 'NTCM-HP-2K2-1%;10\r\n');
  assert.equal(buildCsv(tme, [{ part: 'A;B "C"', qty: 1 }]), '"A;B ""C""";1\r\n');
});

test('Dateiname mit interner Bestellnummer, sonst Datum', () => {
  const mouser = formatForOrder({ supplier: 'mouser' });
  assert.equal(csvFileName(mouser, { internal_order_no: '2026IW01047' }), 'mouser-2026IW01047.csv');
  assert.equal(csvFileName(mouser, { internal_order_no: '' }, new Date(2026, 10, 2)), 'mouser-2026-11-02.csv');
});

test('Abgleich vor dem Statuswechsel: Reihenfolge egal, Menge und Nummer zählen', () => {
  const a = [{ part: 'X', qty: 1 }, { part: 'Y', qty: 2 }];
  assert.ok(sameLines(a, [{ part: 'Y', qty: 2 }, { part: 'X', qty: 1 }]));
  assert.ok(!sameLines(a, [{ part: 'X', qty: 1 }, { part: 'Y', qty: 3 }]));
  assert.ok(!sameLines(a, [...a, { part: 'Z', qty: 1 }]));
});
