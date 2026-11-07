import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, addItem, changeStatus, bookDelivery, getRecord, listRecords,
  http, expectHttpError,
} from './helpers.mjs';

let u;
let orderId;
let ids;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser('Auspacker');
  const a = await addItem(u.token, { supplier: 'farnell', part_number: 'A', name: 'A', qty: 4 });
  const b = await addItem(u.token, { supplier: 'farnell', part_number: 'B', name: 'B', qty: 2 });
  orderId = a.order.id;
  ids = { A: a.item.id, B: b.item.id };
});

test('Buchung legt Historie an und summiert qty_delivered', async () => {
  await changeStatus(u.token, orderId, 'advance');
  const r = await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.A, qty: 2 }], 'Paket 1');
  assert.equal(r.delivery.booked_by, u.user.id);
  assert.equal(r.delivery.note, 'Paket 1');

  const lines = await listRecords('delivery_items', `delivery = "${r.delivery.id}"`);
  assert.equal(lines.length, 1, 'Zeilen derselben Position werden zusammengefasst');
  assert.equal(lines[0].qty, 3);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 3);
});

test('Überlieferung ist erlaubt, negative Summe nicht (und rollt komplett zurück)', async () => {
  await changeStatus(u.token, orderId, 'advance');
  await bookDelivery(u.token, orderId, [{ item: ids.B, qty: 5 }]);
  assert.equal((await getRecord('order_items', ids.B)).qty_delivered, 5);

  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.B, qty: -6 }]), 400);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 0, 'Transaktion zurückgerollt');
  assert.equal((await listRecords('deliveries')).length, 1);
});

test('keine Buchung im offenen Korb, für fremde Positionen oder ohne Mengen', async () => {
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]), 400);
  await changeStatus(u.token, orderId, 'advance');

  const other = await addItem(u.token, { supplier: 'mouser', part_number: 'X', name: 'X', qty: 1 });
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: other.item.id, qty: 1 }]), 400);
  await expectHttpError(bookDelivery(u.token, orderId, []), 400);
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 0 }]), 400);
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.A, qty: -1 }]), 400);
});

test('Buchung mit Beleg (multipart)', async () => {
  await changeStatus(u.token, orderId, 'advance');
  const form = new FormData();
  form.append('lines', JSON.stringify([{ item: ids.A, qty: 4 }]));
  form.append('note', 'mit Beleg');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  form.append('receipt', new Blob([png], { type: 'image/png' }), 'lieferschein.png');
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form });
  assert.equal(r.delivery.receipt.length, 1);
  assert.match(r.delivery.receipt[0], /^lieferschein.*\.png$/);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 4);
});

test('mehrseitiger Beleg: mehrere Dateien, höchstens 10', async () => {
  await changeStatus(u.token, orderId, 'advance');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = (pages) => {
    const f = new FormData();
    f.append('lines', JSON.stringify([{ item: ids.A, qty: 1 }]));
    for (let i = 1; i <= pages; i++) f.append('receipt', new Blob([png], { type: 'image/png' }), `seite-${i}.png`);
    return f;
  };
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form: form(3) });
  assert.equal(r.delivery.receipt.length, 3);
  await expectHttpError(http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form: form(11) }), 400);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 1, 'abgelehnte Buchung ohne Wirkung');
});
