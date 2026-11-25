import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, addItem, markOrdered, setStep, bookDelivery, getRecord, listRecords,
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
  await markOrdered(u.token, orderId);
  const r = await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.A, qty: 2 }], 'Paket 1');
  assert.equal(r.delivery.booked_by, u.user.id);
  assert.equal(r.delivery.note, 'Paket 1');

  const lines = await listRecords('delivery_items', `delivery = "${r.delivery.id}"`);
  assert.equal(lines.length, 1, 'Zeilen derselben Position werden zusammengefasst');
  assert.equal(lines[0].qty, 3);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 3);
});

test('Überlieferung ist erlaubt, negative Summe nicht (und rollt komplett zurück)', async () => {
  await markOrdered(u.token, orderId);
  await bookDelivery(u.token, orderId, [{ item: ids.B, qty: 5 }]);
  assert.equal((await getRecord('order_items', ids.B)).qty_delivered, 5);

  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.B, qty: -6 }]), 400);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 0, 'Transaktion zurückgerollt');
  assert.equal((await listRecords('deliveries')).length, 1);
});

test('keine Buchung im offenen Korb, für fremde Positionen oder ohne Mengen', async () => {
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]), 400);
  await markOrdered(u.token, orderId);

  const other = await addItem(u.token, { supplier: 'mouser', part_number: 'X', name: 'X', qty: 1 });
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: other.item.id, qty: 1 }]), 400);
  await expectHttpError(bookDelivery(u.token, orderId, []), 400);
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 0 }]), 400);
  await expectHttpError(bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }, { item: ids.A, qty: -1 }]), 400);
});

test('Buchung mit Beleg (multipart)', async () => {
  await markOrdered(u.token, orderId);
  const form = new FormData();
  form.append('lines', JSON.stringify([{ item: ids.A, qty: 4 }]));
  form.append('note', 'mit Beleg');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  form.append('receipt', new Blob([png], { type: 'image/png' }), 'lieferschein.png');
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form });
  assert.match(r.delivery.receipt, /^lieferschein.*\.png$/);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 4);
});

test('Beleg als PDF; mehr als eine Datei wird abgelehnt', async () => {
  await markOrdered(u.token, orderId);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const form = (files) => {
    const f = new FormData();
    f.append('lines', JSON.stringify([{ item: ids.A, qty: 1 }]));
    for (let i = 1; i <= files; i++) f.append('receipt', new Blob([pdf], { type: 'application/pdf' }), `lieferschein-${i}.pdf`);
    return f;
  };
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form: form(1) });
  assert.match(r.delivery.receipt, /^lieferschein_1_.*\.pdf$/);
  await expectHttpError(http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form: form(2) }), 400);
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 1, 'abgelehnte Buchung ohne Wirkung');
});

// „Geliefert“ abhaken (ARCHITECTURE Kap. 4.4/7): Rest aller Positionen buchen, „Rückgängig“ nimmt die Buchung zurück
const bookRest = (token, id) => http('POST', `/api/lab/orders/${id}/deliveries/rest`, { token });
const cancelDelivery = (token, id) => http('DELETE', `/api/lab/deliveries/${id}`, { token });

test('Rest buchen: offene Mengen aller Positionen (ohne Storno) in einer Lieferung → geliefert', async () => {
  await markOrdered(u.token, orderId);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  await http('PATCH', `/api/collections/order_items/records/${ids.B}`, { token: u.token, json: { qty_cancelled: 1 } });

  const r = await bookRest(u.token, orderId);
  assert.equal(r.status, 'geliefert');
  assert.equal(r.delivery.note, 'Rest vollständig geliefert');
  const lines = await listRecords('delivery_items', `delivery = "${r.delivery.id}"`);
  assert.deepEqual(lines.map((l) => [l.order_item, l.qty]).sort(), [[ids.A, 3], [ids.B, 1]].sort());
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 4);
  assert.notEqual((await getRecord('orders', orderId)).delivered_at, '');

  await expectHttpError(bookRest(u.token, orderId), 400); // nichts mehr offen
});

test('Rest buchen nur ab „bestellt“ und angemeldet', async () => {
  await expectHttpError(bookRest(u.token, orderId), 400); // Warenkorb
  await markOrdered(u.token, orderId);
  await expectHttpError(bookRest(undefined, orderId), 401);
});

test('Rückgängig: letzte Buchung zurücknehmen stellt Mengen und Phase wieder her', async () => {
  await markOrdered(u.token, orderId);
  const first = await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  const rest = await bookRest(u.token, orderId);

  await expectHttpError(cancelDelivery(u.token, first.delivery.id), 400); // nicht die letzte
  const r = await cancelDelivery(u.token, rest.delivery.id);
  assert.equal(r.status, 'teilgeliefert');
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 1);
  assert.equal((await getRecord('order_items', ids.B)).qty_delivered, 0);
  assert.equal((await getRecord('orders', orderId)).delivered_at, '');
  assert.equal((await listRecords('deliveries')).length, 1);
  assert.equal((await listRecords('delivery_items', `delivery = "${rest.delivery.id}"`)).length, 0);

  await cancelDelivery(u.token, first.delivery.id); // jetzt die letzte
  assert.equal((await getRecord('orders', orderId)).status, 'bestellt');
  await expectHttpError(cancelDelivery(u.token, first.delivery.id), 404);
});

test('Rückgängig nicht für Buchungen mit Beleg', async () => {
  await markOrdered(u.token, orderId);
  const form = new FormData();
  form.append('lines', JSON.stringify([{ item: ids.A, qty: 1 }]));
  form.append('receipt', new Blob(['%PDF-1.4 synthetisch'], { type: 'application/pdf' }), 'lieferschein.pdf');
  const r = await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form });
  await expectHttpError(cancelDelivery(u.token, r.delivery.id), 400);
});

// „Geliefert“ zurücksetzen (Haken im Ablauf entfernen, ARCHITECTURE Kap. 4.4/7)
const resetDeliveries = (token, id) => http('POST', `/api/lab/orders/${id}/deliveries/reset`, { token });

test('Zurücksetzen: alle Buchungen gelöscht, Mengen 0, Belege in der Ablage', async () => {
  await markOrdered(u.token, orderId, { internal_order_no: '2026IW07001' });
  const form = new FormData();
  form.append('lines', JSON.stringify([{ item: ids.A, qty: 1 }]));
  form.append('note', 'Scanner');
  form.append('receipt', new Blob(['%PDF-1.4 synthetisch'], { type: 'application/pdf' }), 'lieferschein.pdf');
  await http('POST', `/api/lab/orders/${orderId}/deliveries`, { token: u.token, form });
  await bookRest(u.token, orderId);
  assert.equal((await getRecord('orders', orderId)).status, 'geliefert');

  const r = await resetDeliveries(u.token, orderId);
  assert.deepEqual(r, { status: 'bestellt', deliveries: 2, archived: 1 });
  assert.equal((await getRecord('order_items', ids.A)).qty_delivered, 0);
  assert.equal((await getRecord('order_items', ids.B)).qty_delivered, 0);
  const order = await getRecord('orders', orderId);
  assert.equal(order.status, 'bestellt');
  assert.equal(order.delivered_at, '');
  assert.equal((await listRecords('deliveries')).length, 0);
  assert.equal((await listRecords('delivery_items')).length, 0);

  const [entry] = await listRecords('unmatched_receipts');
  assert.equal(entry.supplier_name, 'Farnell');
  assert.equal(entry.internal_order_no, '2026IW07001');
  assert.equal(entry.uploaded_by, u.user.id);
  assert.match(entry.note, /2026IW07001 zurückgesetzt – Scanner/);
  assert.match(entry.receipt, /^lieferschein.*\.pdf$/);
  const file = await fetch(`${process.env.PB_URL}/api/files/unmatched_receipts/${entry.id}/${entry.receipt}`);
  assert.equal(await file.text(), '%PDF-1.4 synthetisch', 'Beleg kopiert');
});

test('Zurücksetzen nur mit Buchungen, nicht abgeschlossen, nur angemeldet', async () => {
  await expectHttpError(resetDeliveries(u.token, orderId), 400); // Warenkorb
  await markOrdered(u.token, orderId);
  await expectHttpError(resetDeliveries(u.token, orderId), 400); // keine Buchung
  await bookRest(u.token, orderId);
  await expectHttpError(resetDeliveries(undefined, orderId), 401);
  await setStep(u.token, orderId, 'closed');
  assert.equal((await getRecord('orders', orderId)).status, 'abgeschlossen');
  await expectHttpError(resetDeliveries(u.token, orderId), 400);
  assert.equal((await listRecords('deliveries')).length, 1, 'nichts geändert');
});
