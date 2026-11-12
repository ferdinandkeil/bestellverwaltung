// Lieferscheine ohne passende Bestellung: Bestellung daraus anlegen, Ablage und Zuordnung.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, createGroup, addItem, changeStatus, getRecord, listRecords, http, expectHttpError, PB_URL,
} from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser('Lieferschein-Nutzer');
});

const PDF = () => new Blob(['%PDF-1.4 lieferschein\n%%EOF\n'], { type: 'application/pdf' });
const fromNote = (body, token = u.token) => http('POST', '/api/lab/orders/from-delivery-note', { token, json: body });

test('Bestellung aus Lieferschein: Herkunft, sofort geliefert, Positionen zusammengefasst, Beleg', async () => {
  const g = await createGroup('Thema 3');
  // offener Reichelt-Korb bleibt unberührt
  const cart = await addItem(u.token, { supplier: 'reichelt', part_number: 'OFFEN 1', qty: 1 });

  const form = new FormData();
  form.append('supplier', 'reichelt');
  form.append('internal_order_no', '2026iw07777');
  form.append('note', 'aus Lieferschein');
  form.append('items', JSON.stringify([
    { part_number: 'CLI-581 C', name: 'Tinte', qty: 1 },
    { part_number: 'led 5-4500 rt', qty: 2, group: g.id },
    { part_number: 'LED  5-4500 RT', qty: 3 },
  ]));
  form.append('receipt', PDF(), 'lieferschein.pdf');
  const r = await http('POST', '/api/lab/orders/from-delivery-note', { token: u.token, form });

  assert.equal(r.status, 'geliefert');
  assert.equal(r.order.origin, 'lieferschein');
  assert.equal(r.order.internal_order_no, '2026IW07777');
  assert.equal(r.order.created_by, u.user.id);
  assert.notEqual(r.order.id, cart.order.id);
  assert.match(r.delivery.receipt, /^lieferschein.*\.pdf$/);
  assert.equal(r.delivery.note, 'aus Lieferschein');

  const items = await listRecords('order_items', `order = "${r.order.id}"`);
  const led = items.find((i) => i.part_number === 'LED 5-4500 RT');
  assert.equal(items.length, 2);
  assert.deepEqual([led.qty_ordered, led.qty_delivered], [5, 5]);
  assert.equal(led.group_allocation_note, 'Thema 3: 2x | ohne Gruppe: 3x');
  assert.equal(items.find((i) => i.part_number === 'CLI-581 C').name, 'Tinte');
  assert.equal((await getRecord('orders', cart.order.id)).status, 'angefragt');
});

test('interne Bestellnummer: angeben oder ausdrücklich darauf verzichten', async () => {
  const items = [{ part_number: 'MUSTER 1', qty: 2 }];
  const none = await expectHttpError(fromNote({ supplier: 'other', supplier_custom_name: 'Würth Elektronik', items }), 400);
  assert.match(none.body.message, /ohne interne Bestellnummer/);
  const both = await expectHttpError(fromNote({ supplier: 'reichelt', internal_order_no: '2026IW00001', without_internal_order_no: true, items }), 400);
  assert.match(both.body.message, /nicht beides/);
  const bad = await expectHttpError(fromNote({ supplier: 'reichelt', internal_order_no: '2026-1', items }), 400);
  assert.match(bad.body.message, /Format JJJJIW#####/);

  const r = await fromNote({ supplier: 'other', supplier_custom_name: 'Würth Elektronik', without_internal_order_no: true, items });
  assert.equal(r.order.internal_order_no, '');
  assert.equal(r.status, 'geliefert');
  // bestehende Nummer wird als Dublette abgelehnt
  await fromNote({ supplier: 'reichelt', internal_order_no: '2026IW00002', items });
  const dup = await expectHttpError(fromNote({ supplier: 'farnell', internal_order_no: '2026IW00002', items }), 400);
  assert.match(dup.body.message, /bereits einer anderen Bestellung/);
});

test('Fehler rollen alles zurück; Herkunft ist nicht von Hand änderbar', async () => {
  const before = (await listRecords('orders')).length;
  await expectHttpError(fromNote({ supplier: 'reichelt', without_internal_order_no: true, items: [] }), 400);
  await expectHttpError(fromNote({ supplier: 'reichelt', without_internal_order_no: true, items: [{ part_number: 'A', qty: 1 }, { part_number: 'B', qty: 0 }] }), 400);
  await expectHttpError(fromNote({ supplier: 'reichelt', without_internal_order_no: true, items: [{ part_number: 'A', qty: 1 }] }, null), 401);
  assert.equal((await listRecords('orders')).length, before);

  const cart = await addItem(u.token, { supplier: 'mouser', part_number: 'X', qty: 1 });
  await expectHttpError(http('PATCH', `/api/collections/orders/records/${cart.order.id}`, { token: u.token, json: { origin: 'lieferschein' } }), 404);
});

test('Ablage: Lieferschein ohne Bestellung ablegen, für alle sichtbar, einer Bestellung zuordnen', async () => {
  const other = await createUser('Kollegin');
  const form = new FormData();
  form.append('supplier_name', 'Unbekannter Shop');
  form.append('internal_order_no', '2026IW01087');
  form.append('note', 'Keine Bestellung vorhanden');
  form.append('uploaded_by', u.user.id);
  form.append('receipt', PDF(), 'lieferschein.pdf');
  const entry = await http('POST', '/api/collections/unmatched_receipts/records', { token: u.token, form });

  const list = await http('GET', '/api/collections/unmatched_receipts/records', { token: other.token });
  assert.equal(list.items.length, 1, 'für andere Labor-Nutzer sichtbar');
  await expectHttpError(http('PATCH', `/api/collections/unmatched_receipts/records/${entry.id}`, { token: u.token, json: { note: 'x' } }), 403);
  const foreign = new FormData();
  foreign.append('supplier_name', 'X');
  foreign.append('uploaded_by', other.user.id);
  foreign.append('receipt', PDF(), 'a.pdf');
  await expectHttpError(http('POST', '/api/collections/unmatched_receipts/records', { token: u.token, form: foreign }), 400);

  const cart = await addItem(u.token, { supplier: 'other', supplier_custom_name: 'Unbekannter Shop', part_number: 'Y', qty: 1 });
  await changeStatus(u.token, cart.order.id, 'advance', { internal_order_no: '2026IW01087' });
  const order = await http('POST', `/api/lab/unmatched-receipts/${entry.id}/assign`, { token: other.token, json: { order: cart.order.id } });
  assert.equal(order.attachments.length, 1);
  const file = await fetch(`${PB_URL}/api/files/orders/${order.id}/${order.attachments[0]}`);
  assert.match(await file.text(), /^%PDF-1.4 lieferschein/);
  assert.equal((await listRecords('unmatched_receipts')).length, 0, 'Ablage-Eintrag entfällt');

  await expectHttpError(http('POST', `/api/lab/unmatched-receipts/${entry.id}/assign`, { token: u.token, json: { order: cart.order.id } }), 400);
});
