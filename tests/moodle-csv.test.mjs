// Moodle-Import: CSV einlesen (Papa Parse aus vendor/) und Zeilen aufbereiten – ohne Server, ohne Browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  guessColumns, buildRows, stripHtml, suggestSupplier, suggestGroup, distinctValues,
  effectiveGroup, checkRows, buildPayload, normalizePartNumber,
} from '../pb_public/modules/moodle-import/moodle-csv.js';
import { MOODLE_CSV } from './fixtures-moodle.mjs';

const Papa = createRequire(import.meta.url)('../pb_public/vendor/papaparse@5.7.0/papaparse.min.js');

function parse(text) {
  const { data } = Papa.parse(text, { skipEmptyLines: false });
  const [headers, ...records] = data;
  return { headers, records: records.filter((r) => !(r.length === 1 && r[0] === '')) };
}

test('Spalten werden über die Überschriften erkannt, Tags ignoriert', () => {
  const { headers } = parse(MOODLE_CSV);
  assert.deepEqual(guessColumns(headers), { supplier: 0, qty: 1, part: 2, group: 4, name: -1, url: -1, comment: 3 });
});

test('Zeilen: HTML-Kommentar als Text, Leerraum in Gruppen, Mengenfehler, Leerzeilen entfallen', () => {
  const { headers, records } = parse(MOODLE_CSV);
  const rows = buildRows(records, guessColumns(headers));
  assert.deepEqual(rows.map((r) => r.line), [2, 3, 4, 5, 6, 7, 9, 10]);
  const r3 = rows.find((r) => r.line === 3);
  assert.equal(r3.comment, '100nF Kondensator, 0603');
  assert.equal(r3.qty, 10);
  assert.equal(rows.find((r) => r.line === 4).comment, 'Hall-Sensor & Ersatz, falls einer kaputt geht');
  assert.equal(rows.find((r) => r.line === 6).groupRaw, 'Getrennte Gruppen Alle Teilnehmer/innen Dozenten');
  const r7 = rows.find((r) => r.line === 7);
  assert.equal(r7.qty, null);
  assert.equal(r7.qtyRaw, 'zwei');
  assert.equal(rows.find((r) => r.line === 9).part, '511-NUCLEO-G031K8');
  assert.equal(rows.find((r) => r.line === 10).groupRaw, '');
  assert.deepEqual(distinctValues(rows, 'supplierRaw').map((d) => d.value), ['Mouser', 'Reichelt', 'TME', 'mouser']);
});

test('Hilfsfunktionen: HTML, Lieferant, Bestellnummer', () => {
  assert.equal(stripHtml('<p>a&nbsp;&lt;b&gt; &#252;ber &#x2013; ok</p>'), 'a <b> über – ok');
  assert.deepEqual(suggestSupplier(' Mouser '), { supplier: 'mouser', supplier_custom_name: '' });
  assert.deepEqual(suggestSupplier('Völkner'), { supplier: 'voelkner', supplier_custom_name: '' });
  assert.deepEqual(suggestSupplier('reichelt elektronik'), { supplier: 'reichelt', supplier_custom_name: '' });
  assert.deepEqual(suggestSupplier('TME'), { supplier: 'tme', supplier_custom_name: '' });
  assert.deepEqual(suggestSupplier('Würth Elektronik'), { supplier: 'wuerth', supplier_custom_name: '' });
  assert.deepEqual(suggestSupplier('Conrad'), { supplier: 'other', supplier_custom_name: 'Conrad' });
  assert.deepEqual(suggestSupplier(''), { supplier: '', supplier_custom_name: '' });
  assert.equal(normalizePartNumber(' debo  jt esp32-c '), 'DEBO JT ESP32-C');
});

test('Gruppen: gleichnamige Gruppe der Veranstaltung wird vorgeschlagen, leere → ohne Gruppe', () => {
  const groups = [{ id: 'g5', name: 'thema 5' }, { id: 'g9', name: 'Thema 9' }];
  assert.deepEqual(suggestGroup('Thema 5', groups), { choice: 'id:g5', suggested: true });
  assert.deepEqual(suggestGroup('Thema 6', groups), { choice: '', suggested: false });
  assert.deepEqual(suggestGroup('', groups), { choice: 'none', suggested: false });
  assert.deepEqual(effectiveGroup({ groupRaw: 'X', groupChoice: '' }, { X: 'rows' }), null, '„je Zeile“ ohne Wahl ist offen');
  assert.deepEqual(effectiveGroup({ groupRaw: 'X', groupChoice: 'new:Thema 6' }, { X: 'rows' }), { kind: 'new', value: 'Thema 6' });
});

test('Prüfung und Daten für den Import', () => {
  const { headers, records } = parse(MOODLE_CSV);
  const rows = buildRows(records, guessColumns(headers));
  const supplierMap = {
    Mouser: suggestSupplier('Mouser'), mouser: suggestSupplier('mouser'),
    Reichelt: suggestSupplier('Reichelt'), TME: suggestSupplier('TME'),
  };
  const groupMap = {
    'Thema 5': 'id:g5', 'Thema 6': 'new', 'Thema 7': 'new',
    'Getrennte Gruppen Alle Teilnehmer/innen Dozenten': 'rows', '': 'none',
  };
  const openItems = [{
    part_number: 'X7R-G0603 100N', group_allocations: [{ groupId: 'g5', qty: 5 }],
    expand: { order: { supplier: 'reichelt', supplier_custom_name: '' } },
  }];

  let checks = checkRows(rows, groupMap, supplierMap, openItems);
  assert.deepEqual(checks.get(6).errors, ['Gruppe nicht zugeordnet']);
  assert.deepEqual(checks.get(7).errors, ['Anzahl „zwei“ ist keine ganze Zahl ≥ 1']);
  assert.match(checks.get(3).warnings[0], /schon im offenen Warenkorb/);
  assert.match(checks.get(9).warnings[0], /wie Zeile 2/);
  assert.deepEqual(checks.get(2), { errors: [], warnings: [] });

  // Dozenten-Eintrag von Hand Thema 7 zuweisen, ungültige Zeile auslassen
  rows.find((r) => r.line === 6).groupChoice = 'new:Thema 7';
  rows.find((r) => r.line === 7).include = false;
  checks = checkRows(rows, groupMap, supplierMap, openItems);
  assert.ok([...checks.values()].every((c) => !c.errors.length));

  const payload = buildPayload(rows, groupMap, supplierMap, { course: ' Projektarbeit ', semester: 'WS 2026/27' });
  assert.deepEqual(payload.groups, [
    { ref: 'g1', name: 'Thema 6', course: 'Projektarbeit', semester: 'WS 2026/27' },
    { ref: 'g2', name: 'Thema 7', course: 'Projektarbeit', semester: 'WS 2026/27' },
  ]);
  assert.equal(payload.items.length, 7);
  assert.deepEqual(payload.items.find((i) => i.line === 5),
    { line: 5, supplier: 'tme', supplier_custom_name: '', part_number: 'INA226AIDGSR', name: '', qty: 2, groupRef: 'g1' });
  assert.equal(payload.items.find((i) => i.line === 6).groupRef, 'g2');
  assert.equal(payload.items.find((i) => i.line === 2).group, 'g5');
  assert.equal(payload.items.find((i) => i.line === 10).group, undefined, 'ohne Gruppe');
  assert.ok(payload.items.every((i) => !('comment' in i)), 'Kommentar wird nicht gespeichert');
});
