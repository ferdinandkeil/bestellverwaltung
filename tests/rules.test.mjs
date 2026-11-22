// API-Rules: gesperrte Direktzugriffe (ARCHITECTURE.md Kap. 2).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, addItem, markOrdered, setStep, bookDelivery, getRecord, http,
  expectHttpError,
} from './helpers.mjs';

let u;
let cart;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser();
  cart = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 2 });
});

const patch = (col, id, json, token = u.token) =>
  http('PATCH', `/api/collections/${col}/records/${id}`, { token, json });

test('Status, created_by und qty_delivered sind nicht direkt schreibbar', async () => {
  const other = await createUser('Anderer');
  await expectHttpError(patch('orders', cart.order.id, { status: 'bestellt' }), 404);
  await expectHttpError(patch('orders', cart.order.id, { created_by: other.user.id }), 404);
  await expectHttpError(patch('order_items', cart.item.id, { qty_delivered: 2 }), 404);
  await expectHttpError(patch('order_items', cart.item.id, { order: cart.order.id }), 404);

  // erlaubte Felder
  await patch('orders', cart.order.id, { notes: 'Hinweis', shipping_cost: 4.95 });
  await patch('order_items', cart.item.id, { name: 'Neuer Name', qty_ordered: 3, price_unit: 0.5 });
  assert.equal((await getRecord('order_items', cart.item.id)).qty_ordered, 3);
});

test('Positionen und Bestellungen nicht direkt anlegbar, Lieferungen unveränderlich', async () => {
  await expectHttpError(http('POST', '/api/collections/orders/records', {
    token: u.token, json: { supplier: 'farnell', status: 'angefragt' } }), 403);
  await expectHttpError(http('POST', '/api/collections/order_items/records', {
    token: u.token, json: { order: cart.order.id, part_number: 'B', name: 'B', qty_ordered: 1 } }), 403);

  await markOrdered(u.token, cart.order.id);
  const d = await bookDelivery(u.token, cart.order.id, [{ item: cart.item.id, qty: 1 }]);
  await expectHttpError(patch('deliveries', d.delivery.id, { note: 'x' }), 403);
  await expectHttpError(http('DELETE', `/api/collections/deliveries/records/${d.delivery.id}`, { token: u.token }), 403);
});

test('Löschen nur im Status angefragt', async () => {
  const second = await addItem(u.token, { supplier: 'mouser', part_number: 'B', name: 'B', qty: 1 });
  await http('DELETE', `/api/collections/order_items/records/${second.item.id}`, { token: u.token });

  await markOrdered(u.token, cart.order.id);
  await expectHttpError(http('DELETE', `/api/collections/order_items/records/${cart.item.id}`, { token: u.token }), 404);
  await expectHttpError(http('DELETE', `/api/collections/orders/records/${cart.order.id}`, { token: u.token }), 404);

  const open = await addItem(u.token, { supplier: 'reichelt', part_number: 'C', name: 'C', qty: 1 });
  await http('DELETE', `/api/collections/orders/records/${open.order.id}`, { token: u.token });
});

test('ab abgeschlossen sind Positionen gesperrt', async () => {
  await markOrdered(u.token, cart.order.id);
  await bookDelivery(u.token, cart.order.id, [{ item: cart.item.id, qty: 2 }]);
  await setStep(u.token, cart.order.id, 'closed');
  await expectHttpError(patch('order_items', cart.item.id, { qty_cancelled: 0, name: 'x' }), 404);
});

test('Verwaltungsschritte und geliefert-am nur über die Route', async () => {
  await markOrdered(u.token, cart.order.id);
  const [step] = (await http('GET', `/api/collections/order_steps/records?filter=${encodeURIComponent(`order = "${cart.order.id}"`)}`,
    { token: u.token })).items;
  assert.equal(step.step, 'ordered', 'Schritte sind für alle lesbar');
  await expectHttpError(http('POST', '/api/collections/order_steps/records', {
    token: u.token, json: { order: cart.order.id, step: 'invoice_received' } }), 403);
  await expectHttpError(patch('order_steps', step.id, { done_at: '2020-01-01 12:00:00.000Z' }), 403);
  await expectHttpError(http('DELETE', `/api/collections/order_steps/records/${step.id}`, { token: u.token }), 403);
  await expectHttpError(patch('orders', cart.order.id, { delivered_at: '2020-01-01 12:00:00.000Z' }), 404);
  await patch('orders', cart.order.id, { subject: 'Kleinteile' });
});

test('Gruppen: alle eingeloggten Nutzer dürfen verwalten, Gäste nichts sehen', async () => {
  const g = await http('POST', '/api/collections/groups/records', { token: u.token, json: { name: 'Neu', course: 'Kurs', semester: 'WS 2026/27' } });
  await patch('groups', g.id, { is_active: true });
  await expectHttpError(http('GET', `/api/collections/groups/records/${g.id}`), 404);
  const list = await http('GET', '/api/collections/orders/records');
  assert.equal(list.items.length, 0, 'Gäste sehen keine Bestellungen');
  await expectHttpError(http('POST', '/api/lab/cart-items', {
    json: { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 } }), 401);
});
