// Bestellung von Hand übernehmen („+ Neue Bestellung“, Route POST /api/lab/orders/manual, ARCHITECTURE Kap. 4.8).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, createGroup, addItem, getRecord, listRecords, http, expectHttpError,
} from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser('Übernehmer');
});

const manual = (body, token = u.token) => http('POST', '/api/lab/orders/manual', { token, json: body });
const stepsOf = async (orderId) =>
  Object.fromEntries((await listRecords('order_steps', `order = "${orderId}"`)).map((s) => [s.step, s]));
const ITEMS = [{ part_number: 'NE 555 DIP', name: 'Timer', qty: 4 }, { part_number: 'BC 547C', qty: 10 }];

test('Stand „Bestellt“: Formularschritte und „bestellt“ ohne Datum, Freigabe übersprungen, Positionen', async () => {
  const g = await createGroup('Thema 7');
  const cart = await addItem(u.token, { supplier: 'reichelt', part_number: 'OFFEN 1', qty: 1 });
  const r = await manual({
    supplier: 'reichelt', internal_order_no: ' 2026iw08001 ', supplier_order_no: 'R-123', subject: 'Altbestand',
    stage: 'ordered',
    items: [...ITEMS, { part_number: 'ne  555 dip', qty: 2, group: g.id }],
  });
  assert.equal(r.status, 'bestellt');
  assert.equal(r.order.origin, 'manuell');
  assert.equal(r.order.internal_order_no, '2026IW08001');
  assert.equal(r.order.supplier_order_no, 'R-123');
  assert.equal(r.order.subject, 'Altbestand');
  assert.equal(r.order.created_by, u.user.id);
  assert.notEqual(r.order.id, cart.order.id);
  assert.equal((await getRecord('orders', cart.order.id)).status, 'angefragt', 'offener Korb unberührt');

  const steps = await stepsOf(r.order.id);
  assert.deepEqual(Object.keys(steps).sort(), ['form_signed', 'form_submitted', 'form_written', 'ordered']);
  for (const s of Object.values(steps)) assert.deepEqual([s.done_at, s.done_by], ['', ''], 'übernommen: ohne Datum und Nutzer');

  const items = await listRecords('order_items', `order = "${r.order.id}"`);
  const timer = items.find((i) => i.part_number === 'NE 555 DIP');
  assert.equal(items.length, 2);
  assert.deepEqual([timer.qty_ordered, timer.qty_delivered, timer.name], [6, 0, 'Timer']);
  assert.equal(timer.group_allocation_note, 'ohne Gruppe: 4x | Thema 7: 2x');
});

test('Stände vor „bestellt“: Schritte bis dahin, Phase „In Freigabe“; Freigabe nur, wenn gewählt', async () => {
  const signed = await manual({ supplier: 'mouser', internal_order_no: '2026IW08002', stage: 'form_signed', items: ITEMS });
  assert.equal(signed.status, 'freigabe');
  assert.deepEqual(Object.keys(await stepsOf(signed.order.id)).sort(), ['form_signed', 'form_written']);

  const approved = await manual({ supplier: 'mouser', internal_order_no: '2026IW08003', stage: 'approval', items: ITEMS });
  assert.equal(approved.status, 'freigabe');
  assert.deepEqual(Object.keys(await stepsOf(approved.order.id)).sort(), ['approval', 'form_signed', 'form_submitted', 'form_written']);
});

test('Stand „Geliefert“: alles als geliefert gebucht (ohne Beleg)', async () => {
  const r = await manual({ supplier: 'other', supplier_custom_name: 'Conrad', internal_order_no: '2026IW08004', stage: 'delivered', items: ITEMS });
  assert.equal(r.status, 'geliefert');
  assert.equal(r.order.supplier_custom_name, 'Conrad');
  assert.notEqual(r.order.delivered_at, '');
  const items = await listRecords('order_items', `order = "${r.order.id}"`);
  assert.ok(items.every((i) => i.qty_delivered === i.qty_ordered));
  const [delivery] = await listRecords('deliveries', `order = "${r.order.id}"`);
  assert.equal(delivery.receipt, '');
});

test('ohne interne Bestellnummer nur ab „bestellt“, dann ohne Formularschritte', async () => {
  await expectHttpError(manual({ supplier: 'wuerth', without_internal_order_no: true, stage: 'form_written', items: ITEMS }), 400);
  const r = await manual({ supplier: 'wuerth', without_internal_order_no: true, stage: 'ordered', items: ITEMS });
  assert.equal(r.status, 'bestellt');
  assert.equal(r.order.without_internal_order_no, true);
  assert.deepEqual(Object.keys(await stepsOf(r.order.id)), ['ordered']);
});

test('Fehler rollen alles zurück: Stand, Nummer, Positionen, Lieferant, Anmeldung', async () => {
  const base = { supplier: 'reichelt', internal_order_no: '2026IW08005', stage: 'ordered', items: ITEMS };
  await expectHttpError(manual({ ...base, stage: 'closed' }), 400);
  await expectHttpError(manual({ ...base, internal_order_no: '' }), 400);
  await expectHttpError(manual({ ...base, internal_order_no: '2026-08005' }), 400);
  await expectHttpError(manual({ ...base, items: [] }), 400);
  await expectHttpError(manual({ ...base, items: [{ part_number: 'X', qty: 0 }] }), 400);
  await expectHttpError(manual({ ...base, supplier: 'other' }), 400);
  await expectHttpError(http('POST', '/api/lab/orders/manual', { json: base }), 401);
  await manual(base);
  await expectHttpError(manual(base), 400); // Nummer schon vergeben
  assert.equal((await listRecords('orders')).length, 1);
  assert.equal((await listRecords('order_items')).length, 2);
});
