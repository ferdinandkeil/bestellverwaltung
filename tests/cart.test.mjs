import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, createGroup, addItem, listRecords, expectHttpError, http,
} from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser('Besteller');
});

test('Akzeptanzkriterium: gleiche Nummer für zwei Gruppen wird zu einer Position verschmolzen', async () => {
  const a = await createGroup('Gruppe A');
  const b = await createGroup('Gruppe B');

  const r1 = await addItem(u.token, { supplier: 'mouser', part_number: ' 595-sn74hc595n ', name: 'Schieberegister', qty: 5, group: a.id });
  const r2 = await addItem(u.token, { supplier: 'mouser', part_number: '595-SN74HC595N', name: 'egal', qty: 3, group: b.id });

  assert.equal(r1.merged, false);
  assert.equal(r2.merged, true);
  assert.equal(r1.order.id, r2.order.id);
  assert.equal(r1.order.status, 'angefragt');
  assert.equal(r1.order.created_by, u.user.id);

  const items = await listRecords('order_items');
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.part_number, '595-SN74HC595N');
  assert.equal(it.name, 'Schieberegister');
  assert.equal(it.qty_ordered, 8);
  assert.deepEqual([...it.groups].sort(), [a.id, b.id].sort());
  assert.deepEqual(it.group_allocations, [
    { groupId: a.id, groupName: 'Gruppe A', qty: 5 },
    { groupId: b.id, groupName: 'Gruppe B', qty: 3 },
  ]);
  assert.equal(it.group_allocation_note, 'Gruppe A: 5x | Gruppe B: 3x');
});

test('gleiche Gruppe zweimal erhöht deren Anteil; ohne Gruppe wird separat geführt', async () => {
  const a = await createGroup('Gruppe A');
  await addItem(u.token, { supplier: 'reichelt', part_number: 'NE 555', name: 'Timer', qty: 2, group: a.id });
  await addItem(u.token, { supplier: 'reichelt', part_number: 'ne 555', name: 'Timer', qty: 4, group: a.id });
  await addItem(u.token, { supplier: 'reichelt', part_number: 'NE 555', name: 'Timer', qty: 1 });

  const [it] = await listRecords('order_items');
  assert.equal(it.qty_ordered, 7);
  assert.equal(it.group_allocation_note, 'Gruppe A: 6x | ohne Gruppe: 1x');
});

test('Bestellnummer: mehrfacher und unsichtbarer Leerraum wird zusammengefasst, einzelne Leerzeichen bleiben', async () => {
  const a = await addItem(u.token, { supplier: 'reichelt', part_number: ' mkds 1,5 3 5,08 ', name: 'Klemme', qty: 1 });
  assert.equal(a.item.part_number, 'MKDS 1,5 3 5,08');
  for (const variant of ['MKDS  1,5\t3 5,08', 'MKDS\u00A01,5 3\u202F5,08', 'MKDS 1,5\u200B 3 5,08']) {
    const r = await addItem(u.token, { supplier: 'reichelt', part_number: variant, name: 'Klemme', qty: 1 });
    assert.equal(r.merged, true, JSON.stringify(variant));
    assert.equal(r.item.id, a.item.id);
  }
  const other = await addItem(u.token, { supplier: 'reichelt', part_number: 'MKDS1,535,08', name: 'ohne Leerzeichen', qty: 1 });
  assert.equal(other.merged, false, 'ganz ohne Leerzeichen ist es eine andere Nummer');

  // auch beim direkten Bearbeiten einer Position
  const edited = await http('PATCH', `/api/collections/order_items/records/${other.item.id}`, {
    token: u.token, json: { part_number: 'XIAO\u00A0\u00A0esp32c6 ' },
  });
  assert.equal(edited.part_number, 'XIAO ESP32C6');
});

test('verschiedene Lieferanten landen in verschiedenen Körben', async () => {
  const r1 = await addItem(u.token, { supplier: 'mouser', part_number: 'X1', name: 'X', qty: 1 });
  const r2 = await addItem(u.token, { supplier: 'farnell', part_number: 'X1', name: 'X', qty: 1 });
  assert.notEqual(r1.order.id, r2.order.id);
});

test('„other“: ein Korb je Shop-Name, Groß-/Kleinschreibung egal', async () => {
  const c1 = await addItem(u.token, { supplier: 'other', supplier_custom_name: 'Conrad', part_number: 'A', name: 'A', qty: 1 });
  const c2 = await addItem(u.token, { supplier: 'other', supplier_custom_name: ' conrad ', part_number: 'B', name: 'B', qty: 1 });
  const d1 = await addItem(u.token, { supplier: 'other', supplier_custom_name: 'Digikey', part_number: 'A', name: 'A', qty: 1 });
  assert.equal(c1.order.id, c2.order.id);
  assert.notEqual(c1.order.id, d1.order.id);
  assert.equal(c1.order.supplier_custom_name, 'Conrad');
  await expectHttpError(addItem(u.token, { supplier: 'other', part_number: 'A', name: 'A', qty: 1 }), 400);
});

test('gleichzeitige Buchungen verlieren keine Mengen und erzeugen nur einen Korb', async () => {
  const groups = await Promise.all([1, 2, 3, 4, 5].map((i) => createGroup('G' + i)));
  await Promise.all(groups.map((g, i) =>
    addItem(u.token, { supplier: 'voelkner', part_number: 'R-10K', name: 'Widerstand 10k', qty: i + 1, group: g.id })));

  const orders = await listRecords('orders');
  assert.equal(orders.length, 1);
  const [it] = await listRecords('order_items');
  assert.equal(it.qty_ordered, 1 + 2 + 3 + 4 + 5);
  assert.equal(it.group_allocations.length, 5);
});

test('Bezeichnung ist optional und wird später ergänzt, wenn sie fehlt', async () => {
  const a = await addItem(u.token, { supplier: 'mouser', part_number: 'OHNE-NAME', qty: 1 });
  assert.equal(a.item.name, '');
  const b = await addItem(u.token, { supplier: 'mouser', part_number: 'ohne-name', name: 'Nachgetragen', qty: 1 });
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.item.name, 'Nachgetragen');
  const c = await addItem(u.token, { supplier: 'mouser', part_number: 'OHNE-NAME', name: 'Anders', qty: 1 });
  assert.equal(c.item.name, 'Nachgetragen', 'vorhandene Bezeichnung wird nicht überschrieben');
});

test('Validierung: Pflichtfelder, Menge, Lieferant, Gruppe', async () => {
  await expectHttpError(addItem(u.token, { supplier: 'amazon', part_number: 'A', name: 'A', qty: 1 }), 400);
  await expectHttpError(addItem(u.token, { supplier: 'mouser', part_number: '  ', name: 'A', qty: 1 }), 400);
  await expectHttpError(addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 0 }), 400);
  await expectHttpError(addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1.5 }), 400);
  await expectHttpError(addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1, group: 'gibtesnicht1234' }), 400);
  assert.equal((await listRecords('orders')).length, 0, 'fehlgeschlagene Buchungen hinterlassen keinen Korb');
});

test('ohne Login keine Buchung', async () => {
  await expectHttpError(addItem(undefined, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 }), 401);
});
