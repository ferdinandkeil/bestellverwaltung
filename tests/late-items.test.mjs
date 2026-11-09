// Positionen nachtragen: einzeln (Detailansicht) und zusammen mit einer Lieferbuchung (Lieferschein-Scanner).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, createGroup, addItem, changeStatus, getRecord, listRecords, http, expectHttpError,
} from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser('Nachtrager');
});

async function orderedCart() {
  const r = await addItem(u.token, { supplier: 'reichelt', part_number: 'A 1', name: 'A', qty: 2 });
  await changeStatus(u.token, r.order.id, 'advance');
  return { orderId: r.order.id, itemId: r.item.id };
}
const addLate = (orderId, body, token = u.token) => http('POST', `/api/lab/orders/${orderId}/items`, { token, json: body });

test('Position nachtragen: gekennzeichnet, mit Gruppe, Status wird neu berechnet', async () => {
  const { orderId, itemId } = await orderedCart();
  await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, json: { lines: [{ item: itemId, qty: 2 }] } });
  assert.equal((await getRecord('orders', orderId)).status, 'geliefert');

  const g = await createGroup('Thema 7');
  const before = Date.now();
  const { item, status } = await addLate(orderId, { part_number: ' b  2 ', qty: 3, group: g.id });
  assert.equal(item.part_number, 'B 2');
  assert.equal(item.name, '');
  assert.equal(item.qty_ordered, 3);
  assert.equal(item.added_later_by, u.user.id);
  assert.ok(Date.parse(item.added_later_at.replace(' ', 'T')) >= before - 2000);
  assert.equal(item.group_allocation_note, 'Thema 7: 3x');
  assert.equal(status, 'teilgeliefert', 'neue offene Position → nicht mehr vollständig geliefert');
});

test('Nachtragen nur ab „bestellt“, nicht doppelt, nicht nach „geprüft“', async () => {
  const cart = await addItem(u.token, { supplier: 'mouser', part_number: 'X', name: 'X', qty: 1 });
  const open = await expectHttpError(addLate(cart.order.id, { part_number: 'Y', qty: 1 }), 400);
  assert.match(open.body.message, /im offenen Warenkorb normal erfassen/);

  const { orderId, itemId } = await orderedCart();
  const dup = await expectHttpError(addLate(orderId, { part_number: 'a  1', qty: 1 }), 400);
  assert.match(dup.body.message, /steht schon in dieser Bestellung/);
  await expectHttpError(addLate(orderId, { part_number: 'Z', qty: 0 }), 400);
  await expectHttpError(addLate(orderId, { part_number: 'Z', qty: 1 }, null), 401);

  await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, json: { lines: [{ item: itemId, qty: 2 }] } });
  await changeStatus(u.token, orderId, 'advance'); // geliefert → geprüft
  await expectHttpError(addLate(orderId, { part_number: 'Z', qty: 1 }), 400);
});

test('Kennzeichnung ist nicht von Hand setzbar (Regel verweigert → 404)', async () => {
  const { itemId } = await orderedCart();
  await expectHttpError(http('PATCH', `/api/collections/order_items/records/${itemId}`, {
    token: u.token, json: { added_later_by: u.user.id },
  }), 404);
  await expectHttpError(http('PATCH', `/api/collections/order_items/records/${itemId}`, {
    token: u.token, json: { added_later_at: '2026-01-01 00:00:00.000Z' },
  }), 404);
  await http('PATCH', `/api/collections/order_items/records/${itemId}`, { token: u.token, json: { name: 'erlaubt' } });
});

test('Lieferung mit nachgetragener Position: alles in einer Buchung, Fehler rollt alles zurück', async () => {
  const { orderId, itemId } = await orderedCart();
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, {
    token: u.token,
    json: { lines: [{ item: itemId, qty: 2 }], newItems: [{ part_number: 'VERGESSEN 9', name: 'vergessen', qty: 4 }], note: 'Scan' },
  });
  assert.equal(r.status, 'geliefert');
  const late = (await listRecords('order_items', 'part_number = "VERGESSEN 9"'))[0];
  assert.deepEqual([late.qty_ordered, late.qty_delivered, late.added_later_by], [4, 4, u.user.id]);
  const lines = await listRecords('delivery_items', `delivery = "${r.delivery.id}"`);
  assert.equal(lines.length, 2);

  // nur nachgetragene Position, aber ungültig → nichts angelegt
  await expectHttpError(http('POST', `/api/lab/orders/${orderId}/deliveries`, {
    token: u.token, json: { newItems: [{ part_number: 'NEU 1', qty: 1 }, { part_number: '', qty: 1 }] },
  }), 400);
  assert.equal((await listRecords('order_items', 'part_number = "NEU 1"')).length, 0);
  assert.equal((await listRecords('deliveries', `order = "${orderId}"`)).length, 1);
});

test('nachgetragene Position mit Beleg (multipart)', async () => {
  const { orderId } = await orderedCart();
  const form = new FormData();
  form.append('newItems', JSON.stringify([{ part_number: 'NEU 2', qty: 1 }]));
  form.append('note', '');
  form.append('receipt', new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }), 'lieferschein.pdf');
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form });
  assert.match(r.delivery.receipt, /^lieferschein.*\.pdf$/);
  assert.equal((await listRecords('order_items', 'part_number = "NEU 2"'))[0].qty_delivered, 1);
});
