// Verwaltungsschritte, abgeleitete Phase und Auto-Lieferstatus (ARCHITECTURE.md Kap. 4.3).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, addItem, setStep, markOrdered, bookDelivery, getRecord, listRecords, http, expectHttpError, admin,
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
  await markOrdered(u.token, order.id, { internal_order_no: ' 2026iw01047 ', supplier_order_no: ' 12345 ' });
  return { orderId: order.id, ids };
}

const statusOf = async (id) => (await getRecord('orders', id)).status;
const stepsOf = async (id) => Object.fromEntries((await listRecords('order_steps', `order = "${id}"`)).map((s) => [s.step, s]));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('„Formular geschrieben“ schließt den Warenkorb (Phase „freigabe“), mit Datum und Nutzer; neuer Artikel → neuer Korb', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  const before = Date.now();
  const o = await setStep(u.token, r.order.id, 'form_written', { internal_order_no: ' 2026iw01047 ' });
  assert.equal(o.status, 'freigabe');
  assert.equal(o.internal_order_no, '2026IW01047');

  const { form_written: s } = await stepsOf(r.order.id);
  assert.equal(s.done_by, u.user.id);
  assert.ok(Date.parse(s.done_at.replace(' ', 'T')) >= before - 2000, 'ohne Datum = jetzt');

  const next = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  assert.notEqual(next.order.id, r.order.id);
  assert.equal(next.merged, false);
});

test('Schritte überspringen: kein Datensatz, keine Reihenfolge; Freigabe nur, wenn bewusst abgehakt', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await setStep(u.token, r.order.id, 'form_written', { internal_order_no: '2026IW00001' });
  await setStep(u.token, r.order.id, 'form_submitted'); // „unterschrieben“ übersprungen
  const o = await setStep(u.token, r.order.id, 'ordered', { supplier_order_no: ' 12345 ' });
  assert.deepEqual([o.status, o.supplier_order_no], ['bestellt', '12345']);
  assert.deepEqual(Object.keys(await stepsOf(r.order.id)).sort(), ['form_submitted', 'form_written', 'ordered']);

  // übersprungenen Schritt nachtragen
  await setStep(u.token, r.order.id, 'form_signed', { date: daysAgo(3) });
  assert.ok((await stepsOf(r.order.id)).form_signed);
  assert.equal(await statusOf(r.order.id), 'bestellt');
});

test('interne Bestellnummer: Pflicht für Formularschritte und „bestellt“, Format, eindeutig, danach nicht mehr leer', async () => {
  const a = await addItem(u.token, { supplier: 'reichelt', part_number: 'A', name: 'A', qty: 1 });
  const b = await addItem(u.token, { supplier: 'farnell', part_number: 'B', name: 'B', qty: 1 });

  const missing = await expectHttpError(setStep(u.token, a.order.id, 'form_written'), 400);
  assert.match(missing.body.message, /interne Bestellnummer angeben/);
  const missingOrdered = await expectHttpError(setStep(u.token, a.order.id, 'ordered'), 400);
  assert.match(missingOrdered.body.message, /„ohne interne Bestellnummer“ wählen/);
  const format = await expectHttpError(setStep(u.token, a.order.id, 'form_written', { internal_order_no: '2026-4711' }), 400);
  assert.match(format.body.message, /Format JJJJIW#####/);
  assert.equal(await statusOf(a.order.id), 'angefragt', 'Transaktion zurückgerollt');
  assert.deepEqual(await stepsOf(a.order.id), {});

  // im offenen Korb vorab eintragbar, dann genügt der Schritt ohne Angabe
  await http('PATCH', `/api/collections/orders/records/${a.order.id}`, { token: u.token, json: { internal_order_no: '2026IW00001' } });
  await setStep(u.token, a.order.id, 'form_written');
  assert.equal((await getRecord('orders', a.order.id)).internal_order_no, '2026IW00001');

  const dup = await expectHttpError(setStep(u.token, b.order.id, 'form_written', { internal_order_no: '2026iw00001' }), 400);
  assert.match(dup.body.message, /bereits einer anderen Bestellung/);

  // korrigieren ja, leeren nein
  await http('PATCH', `/api/collections/orders/records/${a.order.id}`, { token: u.token, json: { internal_order_no: '2026IW00002' } });
  const clear = await expectHttpError(http('PATCH', `/api/collections/orders/records/${a.order.id}`, { token: u.token, json: { internal_order_no: '' } }), 400);
  assert.match(clear.body.message, /nicht mehr entfernt/);
});

test('ohne interne Bestellnummer (Muster): kein Formular, direkt bestellt, Verzicht gilt weiter, Nummer nachtragbar', async () => {
  const a = await addItem(u.token, { supplier: 'wuerth', part_number: '885012207098', qty: 10 });
  const both = await expectHttpError(setStep(u.token, a.order.id, 'ordered',
    { internal_order_no: '2026IW00009', without_internal_order_no: true }), 400);
  assert.match(both.body.message, /nicht beides/);
  // nicht von Hand setzbar, nur über die Schritt-Route
  await expectHttpError(http('PATCH', `/api/collections/orders/records/${a.order.id}`,
    { token: u.token, json: { without_internal_order_no: true } }), 404);

  const form = await expectHttpError(setStep(u.token, a.order.id, 'form_written', { without_internal_order_no: true }), 400);
  assert.match(form.body.message, /kein Formular/);

  await setStep(u.token, a.order.id, 'ordered', { without_internal_order_no: true });
  let o = await getRecord('orders', a.order.id);
  assert.deepEqual([o.status, o.internal_order_no, o.without_internal_order_no], ['bestellt', '', true]);
  assert.deepEqual(Object.keys(await stepsOf(a.order.id)), ['ordered']);

  // zurück in den Korb und erneut bestellen: der Verzicht gilt weiter
  o = await setStep(u.token, a.order.id, 'ordered', { done: false });
  assert.equal(o.status, 'angefragt');
  await setStep(u.token, a.order.id, 'ordered');
  assert.equal(await statusOf(a.order.id), 'bestellt');
  const form2 = await expectHttpError(setStep(u.token, a.order.id, 'approval'), 400);
  assert.match(form2.body.message, /kein Formular/);

  // Nummer nachträglich eingetragen → Kennzeichen entfällt, Nummer danach nicht mehr leer
  await http('PATCH', `/api/collections/orders/records/${a.order.id}`, { token: u.token, json: { internal_order_no: '2026IW00010' } });
  o = await getRecord('orders', a.order.id);
  assert.deepEqual([o.internal_order_no, o.without_internal_order_no], ['2026IW00010', false]);
  await expectHttpError(http('PATCH', `/api/collections/orders/records/${a.order.id}`, { token: u.token, json: { internal_order_no: '' } }), 400);
});

test('ältere Bestellungen ohne interne Bestellnummer bleiben bearbeitbar', async () => {
  const { orderId } = await orderedCart();
  // Altbestand simulieren: Nummer als Admin entfernen (vor Einführung des Feldes)
  await http('PATCH', `/api/collections/orders/records/${orderId}`, { token: await admin(), json: { internal_order_no: '', status: 'angefragt' } });
  await http('PATCH', `/api/collections/orders/records/${orderId}`, { token: await admin(), json: { status: 'bestellt' } });
  await http('PATCH', `/api/collections/orders/records/${orderId}`, { token: u.token, json: { notes: 'Altbestand' } });
  assert.equal((await getRecord('orders', orderId)).notes, 'Altbestand');
});

test('leerer Korb kann nicht abgeschlossen werden', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await http('DELETE', `/api/collections/order_items/records/${r.item.id}`, { token: u.token });
  const err = await expectHttpError(markOrdered(u.token, r.order.id), 400);
  assert.match(err.body.message, /leerer Warenkorb/);
  await expectHttpError(setStep(u.token, r.order.id, 'form_written', { internal_order_no: '2026IW00003' }), 400);
});

test('Datum: gewählter Tag (12:00 UTC), Zukunft und Unsinn abgelehnt, nachträglich korrigierbar (Nutzer bleibt)', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  const day = daysAgo(2);
  await setStep(u.token, r.order.id, 'form_written', { internal_order_no: '2026IW00004', date: day });
  assert.equal((await stepsOf(r.order.id)).form_written.done_at, `${day} 12:00:00.000Z`);

  const future = await expectHttpError(setStep(u.token, r.order.id, 'form_signed', { date: daysAgo(-3) }), 400);
  assert.match(future.body.message, /Zukunft/);
  await expectHttpError(setStep(u.token, r.order.id, 'form_signed', { date: '2026-02-30' }), 400);
  await expectHttpError(setStep(u.token, r.order.id, 'form_signed', { date: '21.11.2026' }), 400);
  await setStep(u.token, r.order.id, 'form_signed', { date: today() });

  const other = await createUser('Kollegin');
  await setStep(other.token, r.order.id, 'form_written', { date: daysAgo(5) });
  const s = (await stepsOf(r.order.id)).form_written;
  assert.deepEqual([s.done_at, s.done_by], [`${daysAgo(5)} 12:00:00.000Z`, u.user.id]);
});

test('Rechnung erst ab „bestellt“; abgeschlossen = geliefert + Rechnung in Verwaltung; geliefert am', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 2 });
  const early = await expectHttpError(setStep(u.token, r.order.id, 'invoice_received'), 400);
  assert.match(early.body.message, /erst möglich, wenn die Bestellung bestellt ist/);

  await markOrdered(u.token, r.order.id);
  await setStep(u.token, r.order.id, 'invoice_submitted'); // Rechnung vor der Ware, „da“/„unterschrieben“ übersprungen
  assert.equal(await statusOf(r.order.id), 'bestellt');

  await bookDelivery(u.token, r.order.id, [{ item: r.item.id, qty: 1 }]);
  let o = await getRecord('orders', r.order.id);
  assert.deepEqual([o.status, o.delivered_at], ['teilgeliefert', '']);

  const d = await bookDelivery(u.token, r.order.id, [{ item: r.item.id, qty: 1 }]);
  o = await getRecord('orders', r.order.id);
  assert.equal(o.status, 'abgeschlossen');
  assert.equal(o.delivered_at, d.delivery.created, 'geliefert am = letzte Lieferbuchung');

  // ab abgeschlossen keine Lieferbuchung; Rechnungsschritt zurück → wieder geliefert
  await expectHttpError(bookDelivery(u.token, r.order.id, [{ item: r.item.id, qty: -1 }]), 400);
  o = await setStep(u.token, r.order.id, 'invoice_submitted', { done: false });
  assert.equal(o.status, 'geliefert');
  await bookDelivery(u.token, r.order.id, [{ item: r.item.id, qty: -1 }]);
  o = await getRecord('orders', r.order.id);
  assert.deepEqual([o.status, o.delivered_at], ['teilgeliefert', ''], 'geliefert am wird geleert');
});

test('„abgeschlossen“ von Hand (Muster ohne Rechnung) erst, wenn geliefert', async () => {
  const { orderId, ids } = await orderedCart([['A', 1]]);
  const err = await expectHttpError(setStep(u.token, orderId, 'closed'), 400);
  assert.match(err.body.message, /vollständig geliefert/);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  const o = await setStep(u.token, orderId, 'closed');
  assert.equal(o.status, 'abgeschlossen');
  assert.ok(!(await stepsOf(orderId)).invoice_received, 'Rechnungsschritte bleiben leer (übersprungen)');
});

test('zurücknehmen: „bestellt“ nur ohne Lieferung und ohne Rechnungsschritt; Korb nur ohne anderen offenen Korb', async () => {
  const { orderId, ids } = await orderedCart([['A', 1]]);
  await setStep(u.token, orderId, 'invoice_received');
  const inv = await expectHttpError(setStep(u.token, orderId, 'ordered', { done: false }), 400);
  assert.match(inv.body.message, /Rechnungsschritte/);
  await setStep(u.token, orderId, 'invoice_received', { done: false });

  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  const del = await expectHttpError(setStep(u.token, orderId, 'ordered', { done: false }), 400);
  assert.match(del.body.message, /Lieferungen gebucht/);
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: -1 }]);

  await addItem(u.token, { supplier: 'mouser', part_number: 'NEU', name: 'neu', qty: 1 }); // neuer offener Korb
  const err = await expectHttpError(setStep(u.token, orderId, 'ordered', { done: false }), 400);
  assert.match(err.body.message, /anderen offenen Warenkorb/);
  assert.equal(await statusOf(orderId), 'bestellt');

  const missing = await expectHttpError(setStep(u.token, orderId, 'form_signed', { done: false }), 400);
  assert.match(missing.body.message, /nicht erledigt/);
});

test('zurücknehmen: früherer Schritt bei erledigtem späterem → bleibt in Freigabe; letzter Schritt öffnet den Korb', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await setStep(u.token, r.order.id, 'form_written', { internal_order_no: '2026IW00005' });
  await setStep(u.token, r.order.id, 'form_signed');
  let o = await setStep(u.token, r.order.id, 'form_written', { done: false });
  assert.equal(o.status, 'freigabe');
  o = await setStep(u.token, r.order.id, 'form_signed', { done: false });
  assert.equal(o.status, 'angefragt');
  const again = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  assert.equal(again.order.id, r.order.id, 'wieder offener Korb nimmt Positionen auf');
});

test('unbekannter Schritt, fehlende Bestellung, ohne Login', async () => {
  const r = await addItem(u.token, { supplier: 'mouser', part_number: 'A', name: 'A', qty: 1 });
  await expectHttpError(setStep(u.token, r.order.id, 'geprueft'), 400);
  await expectHttpError(setStep(u.token, 'aaaaaaaaaaaaaaa', 'ordered'), 400);
  await expectHttpError(setStep(null, r.order.id, 'ordered'), 401);
});

test('bestellt und teilgeliefert: Lieferstatus nur aus den Buchungen', async () => {
  const { orderId, ids } = await orderedCart();
  assert.equal(await statusOf(orderId), 'bestellt');
  await bookDelivery(u.token, orderId, [{ item: ids.A, qty: 1 }]);
  assert.equal(await statusOf(orderId), 'teilgeliefert');
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

