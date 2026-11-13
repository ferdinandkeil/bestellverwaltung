// Sammel-Import (Route POST /api/lab/cart-items/batch): alles oder nichts, neue Gruppen, Zeilennummern.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetData, createUser, createGroup, addItem, http, listRecords, expectHttpError } from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser();
});

const batch = (token, body) => http('POST', '/api/lab/cart-items/batch', { token, json: body });

test('Import mit bestehender und neuer Gruppe, mehreren Lieferanten und Zusammenführung', async () => {
  const thema5 = await createGroup('Thema 5', 'Projektarbeit', 'WS 2026/27');
  await addItem(u.token, { supplier: 'mouser', part_number: '511-NUCLEO-G031K8', name: 'Board', qty: 1 });

  const r = await batch(u.token, {
    groups: [{ ref: 'g1', name: 'Thema 6', course: 'Projektarbeit', semester: 'WS 2026/27' }],
    items: [
      { line: 2, supplier: 'mouser', part_number: '511-nucleo-g031k8', qty: 3, group: thema5.id },
      { line: 3, supplier: 'reichelt', part_number: 'DEBO JT ESP32-C', qty: 2, groupRef: 'g1' },
      { line: 4, supplier: 'tme', part_number: 'INA226AIDGSR', qty: 1, groupRef: 'g1' },
      { line: 5, supplier: 'reichelt', part_number: 'DEBO  JT ESP32-C', qty: 1 },
    ],
  });
  assert.deepEqual(r, { items: 4, merged: 2, orders: 3, groups: 1 });

  const thema6 = (await listRecords('groups', 'name = "Thema 6"'))[0];
  assert.equal(thema6.course, 'Projektarbeit');
  const [nucleo] = await listRecords('order_items', 'part_number = "511-NUCLEO-G031K8"');
  assert.equal(nucleo.qty_ordered, 4);
  assert.equal(nucleo.name, 'Board');
  assert.equal(nucleo.group_allocation_note, 'ohne Gruppe: 1x | Thema 5: 3x');
  const [debo] = await listRecords('order_items', 'part_number = "DEBO JT ESP32-C"');
  assert.equal(debo.qty_ordered, 3);
  assert.equal(debo.name, '', 'Bezeichnung optional');
  assert.equal(debo.group_allocation_note, 'Thema 6: 2x | ohne Gruppe: 1x');
});

test('alles oder nichts: ein Fehler rollt neue Gruppen und alle Positionen zurück, Zeile wird genannt', async () => {
  const err = await expectHttpError(batch(u.token, {
    groups: [{ ref: 'g1', name: 'Thema 9', course: 'Projektarbeit', semester: 'WS 2026/27' }],
    items: [
      { line: 2, supplier: 'mouser', part_number: 'A', qty: 1, groupRef: 'g1' },
      { line: 7, supplier: 'mouser', part_number: 'B', qty: 0 },
    ],
  }), 400);
  assert.match(err.body.message, /^Zeile 7: Die Menge/);
  assert.equal((await listRecords('orders')).length, 0);
  assert.equal((await listRecords('groups')).length, 0);
});

test('neue Gruppe, die es schon gibt, wird verständlich abgelehnt', async () => {
  await createGroup('Thema 5', 'Projektarbeit', 'WS 2026/27');
  const err = await expectHttpError(batch(u.token, {
    groups: [{ ref: 'g1', name: 'thema 5', course: 'Projektarbeit', semester: 'WS 2026/27' }],
    items: [{ supplier: 'mouser', part_number: 'A', qty: 1, groupRef: 'g1' }],
  }), 400);
  assert.match(err.body.message, /Thema 5|thema 5/);
  assert.match(err.body.message, /existiert bereits/);
});

test('Grenzen und Anmeldung', async () => {
  await expectHttpError(batch(u.token, { items: [] }), 400);
  await expectHttpError(batch(u.token, { items: [{ supplier: 'mouser', part_number: 'A', qty: 1, groupRef: 'x' }] }), 400);
  await expectHttpError(batch(undefined, { items: [{ supplier: 'mouser', part_number: 'A', qty: 1 }] }), 401);
});
