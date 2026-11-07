import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, addItem, changeStatus, bookDelivery, getRecord, http, expectHttpError,
} from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser();
});

async function orderedCart(items = [['A', 2], ['B', 3]]) {
  let order;
  const ids = {};
  for (const [pn, qty] of items) {
    const r = await addItem(u.token, { supplier: 'mouser', part_number: pn, name: pn, qty });
    order = r.order;
    ids[pn] = r.item.id;
  }
  await changeStatus(u.token, order.id, 'advance', { supplier_order_no: ' 12345 ' });
  return { orderId: order.id, ids };
}

const statusOf = async (id) => (await getRecord('orders', id)).status;

test('angefragt → bestellt setzt Auftragsnummer; neuer Artikel landet in neuem Korb', async () => {
  const { orderId } = await orderedCart();
  const o = await getRecord('orders', orderId);
  assert.equal(o.status, 'bestellt');
  assert.equal(o.supplier_order_no, '12345');

  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  assert.notEqual(r.order.id, orderId);
  assert.equal(r.merged, false);
});

test('leerer Korb kann nicht bestellt werden', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await http('DELETE', `/api/collections/order_items/records/${r.item.id}`, { token: u.token });
  const err = await expectHttpError(changeStatus(u.token, r.order.id, 'advance'), 400);
  assert.match(err.body.message, /leerer Warenkorb/);
});

test('bestellt und teilgeliefert lassen sich nicht manuell weiterschalten', async () => {
  const { orderId, ids } = await orderedCart();
  await expectHttpError(changeStatus(u.token, orderId, 'advance'), 400);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  await expectHttpError(changeStatus(u.token, orderId, 'advance'), 400);
});

test('komplett storniert ohne Lieferung → geliefert', async () => {
  const { orderId, ids } = await orderedCart();
  await http('PATCH', `/api/collections/order_items/records/${ids.A}`, { token: u.token, json: { qty_cancelled: 2 } });
  assert.equal(await statusOf(orderId), 'bestellt');
  await http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 3 } });
  assert.equal(await statusOf(orderId), 'geliefert');
});

test('Auto-Lieferstatus: bestellt → teilgeliefert → geliefert, Korrektur zurück', async () => {
  const { orderId, ids } = await orderedCart();
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  assert.equal(await statusOf(orderId), 'teilgeliefert');

  const r = await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.B, qty: 3 }]);
  assert.equal(r.status, 'geliefert');

  // Korrektur nach unten bei „geliefert“ → wieder teilgeliefert
  await bookDelivery(u.token, orderId, [{ item: ids.B, qty: -1 }], 'Zählfehler');
  assert.equal(await statusOf(orderId), 'teilgeliefert');

  // alles wieder auf 0 → bestellt
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: -2 }, { item: ids.B, qty: -2 }]);
  assert.equal(await statusOf(orderId), 'bestellt');
});

test('Storno zählt als erledigt; komplett storniert → geliefert', async () => {
  const { orderId, ids } = await orderedCart();
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 2 }]);
  await http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 3 } });
  assert.equal(await statusOf(orderId), 'geliefert');

  // Storno zurücknehmen → teilgeliefert
  await http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 0 } });
  assert.equal(await statusOf(orderId), 'teilgeliefert');
});

test('Storno höchstens bestellt − geliefert', async () => {
  const { orderId, ids } = await orderedCart();
  await bookDelivery(u.token, orderId, [{ item: ids.B, qty: 2 }]);
  await expectHttpError(
    http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 2 } }), 400);
  await http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 1 } });
});

test('Mengenänderung ab „bestellt“ berechnet Status neu', async () => {
  const { orderId, ids } = await orderedCart([['A', 2]]);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 2 }]);
  assert.equal(await statusOf(orderId), 'geliefert');
  await http('PATCH', `/api/collections/order_items/records/${ids.A}`, { token: u.token, json: { qty_ordered: 5 } });
  assert.equal(await statusOf(orderId), 'teilgeliefert');
});

test('manuelle Schritte geliefert → geprueft → abgerechnet und zurück', async () => {
  const { orderId, ids } = await orderedCart([['A', 1]]);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  await changeStatus(u.token, orderId, 'advance');
  assert.equal(await statusOf(orderId), 'geprueft');
  await changeStatus(u.token, orderId, 'advance');
  assert.equal(await statusOf(orderId), 'abgerechnet');
  await expectHttpError(changeStatus(u.token, orderId, 'advance'), 400);

  // ab geprueft keine Automatik und keine Lieferbuchung
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: -1 }]), 400);

  await changeStatus(u.token, orderId, 'back');
  assert.equal(await statusOf(orderId), 'geprueft');
  await changeStatus(u.token, orderId, 'back');
  assert.equal(await statusOf(orderId), 'geliefert');
  await expectHttpError(changeStatus(u.token, orderId, 'back'), 400);
});

test('zurück auf angefragt: nur ohne Lieferungen und ohne anderen offenen Korb', async () => {
  const { orderId, ids } = await orderedCart([['A', 1]]);
  await changeStatus(u.token, orderId, 'back');
  assert.equal(await statusOf(orderId), 'angefragt');
  await changeStatus(u.token, orderId, 'advance');

  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: -1 }]);
  assert.equal(await statusOf(orderId), 'bestellt');

  await addItem(u.token, { supplier: 'mouser', part_number: 'NEU', name: 'neu', qty: 1 }); // neuer offener Korb
  const err = await expectHttpError(changeStatus(u.token, orderId, 'back'), 400);
  assert.match(err.body.message, /anderen offenen Warenkorb/);
});

test('angefragt hat keinen vorherigen Status; unbekannte Aktion', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await expectHttpError(changeStatus(u.token, r.order.id, 'back'), 400);
  await expectHttpError(changeStatus(u.token, r.order.id, 'jump'), 400);
});
