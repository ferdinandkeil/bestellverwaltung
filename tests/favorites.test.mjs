// Favoriten (ARCHITECTURE.md Kap. 2 und 4.7): Rechte, Übernahme aus einer Bestellung, Bestellen über den Sammel-Import.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, resetData, createUser, createGroup, addItem, http, getRecord, listRecords, expectHttpError, admin,
} from './helpers.mjs';

let owner;
let other;
beforeEach(async () => {
  await setup();
  await resetData();
  owner = await createUser('Besitzer');
  other = await createUser('Andere');
});

const createList = (u, data) => http('POST', '/api/collections/favorite_lists/records', {
  token: u.token, json: { owner: u.user.id, title: 'Liste', supplier: 'reichelt', ...data },
});
const addFav = (u, list, data) => http('POST', '/api/collections/favorite_items/records', {
  token: u.token, json: { list: list.id, qty: 1, ...data },
});
const fromOrder = (u, body) => http('POST', '/api/lab/favorite-lists/from-order', { token: u.token, json: body });
const favItems = async (list) => (await listRecords('favorite_items', `list = "${list.id}"`))
  .sort((a, b) => a.part_number.localeCompare(b.part_number));

test('Rechte: alle sehen alle Listen, ändern und löschen nur der Besitzer', async () => {
  const priv = await createList(owner, { title: 'Privat', is_public: false });
  const fav = await addFav(owner, priv, { part_number: 'A-1' });

  // Transparenz: auch nicht öffentliche Listen sind für alle sichtbar
  const seen = await http('GET', '/api/collections/favorite_lists/records', { token: other.token });
  assert.deepEqual(seen.items.map((l) => l.title), ['Privat']);
  await http('GET', `/api/collections/favorite_items/records/${fav.id}`, { token: other.token });

  // fremde Liste: nicht änderbar, keine Artikel hinzufügen/ändern/löschen, nicht löschbar
  await expectHttpError(http('PATCH', `/api/collections/favorite_lists/records/${priv.id}`, { token: other.token, json: { title: 'X' } }), 404);
  await expectHttpError(addFav(other, priv, { part_number: 'B-1' }), 400);
  await expectHttpError(http('PATCH', `/api/collections/favorite_items/records/${fav.id}`, { token: other.token, json: { qty: 5 } }), 404);
  await expectHttpError(http('DELETE', `/api/collections/favorite_items/records/${fav.id}`, { token: other.token }), 404);
  await expectHttpError(http('DELETE', `/api/collections/favorite_lists/records/${priv.id}`, { token: other.token }), 404);

  // Liste im fremden Namen anlegen ist nicht möglich
  await expectHttpError(http('POST', '/api/collections/favorite_lists/records', {
    token: other.token, json: { owner: owner.user.id, title: 'Untergeschoben', supplier: 'mouser' },
  }), 400);

  // Besitzer: ändern ja, aber Besitzer und Lieferant bleiben fest
  const renamed = await http('PATCH', `/api/collections/favorite_lists/records/${priv.id}`, {
    token: owner.token, json: { title: ' Neu ', is_public: true },
  });
  assert.equal(renamed.title, 'Neu');
  assert.equal(renamed.is_public, true);
  await expectHttpError(http('PATCH', `/api/collections/favorite_lists/records/${priv.id}`, { token: owner.token, json: { owner: other.user.id } }), 404);
  await expectHttpError(http('PATCH', `/api/collections/favorite_lists/records/${priv.id}`, { token: owner.token, json: { supplier: 'mouser' } }), 404);
  await expectHttpError(http('PATCH', `/api/collections/favorite_items/records/${fav.id}`, {
    token: owner.token, json: { list: (await createList(other, {})).id },
  }), 404);

  // Löschen der Liste nimmt die Artikel mit
  await http('DELETE', `/api/collections/favorite_lists/records/${priv.id}`, { token: owner.token });
  assert.equal((await listRecords('favorite_items')).length, 0);
});

test('Lieferant und Shop-Name: „sonstige“ braucht einen Shop-Namen, sonst bleibt er leer', async () => {
  await expectHttpError(createList(owner, { supplier: 'other', supplier_custom_name: '  ' }), 400);
  const conrad = await createList(owner, { supplier: 'other', supplier_custom_name: ' Conrad ' });
  assert.equal(conrad.supplier_custom_name, 'Conrad');
  const mouser = await createList(owner, { supplier: 'mouser', supplier_custom_name: 'egal' });
  assert.equal(mouser.supplier_custom_name, '');
  await expectHttpError(createList(owner, { title: '   ' }), 400);
});

test('Artikel von Hand: Nummer normalisiert und je Liste eindeutig, Preisstand automatisch', async () => {
  const list = await createList(owner, {});
  const a = await addFav(owner, list, { part_number: ' mkds  1,5 3 ', qty: 4, price_unit: 0.42 });
  assert.equal(a.part_number, 'MKDS 1,5 3');
  assert.ok(a.price_date, 'Preisstand gesetzt');
  const err = await expectHttpError(addFav(owner, list, { part_number: 'MKDS 1,5 3' }), 400);
  assert.match(JSON.stringify(err.body), /steht schon in dieser Liste/);
  // gleiche Nummer in einer anderen Liste ist erlaubt
  await addFav(owner, await createList(owner, { title: 'Zweite' }), { part_number: 'MKDS 1,5 3' });

  // Preis von Hand ändern → neuer Stand; Preis entfernen → kein Stand
  const old = '2025-01-01 00:00:00.000Z';
  await http('PATCH', `/api/collections/favorite_items/records/${a.id}`, { token: await admin(), json: { price_date: old } });
  const changed = await http('PATCH', `/api/collections/favorite_items/records/${a.id}`, { token: owner.token, json: { price_unit: 0.5 } });
  assert.ok(changed.price_date > old, 'Stand bei Preisänderung aktualisiert');
  const sameDate = await http('PATCH', `/api/collections/favorite_items/records/${a.id}`, { token: owner.token, json: { qty: 6 } });
  assert.equal(sameDate.price_date, changed.price_date, 'andere Änderungen lassen den Stand stehen');
  const cleared = await http('PATCH', `/api/collections/favorite_items/records/${a.id}`, { token: owner.token, json: { price_unit: 0 } });
  assert.equal(cleared.price_date, '');
  await expectHttpError(addFav(owner, list, { part_number: 'NULL', qty: 0 }), 400);
});

test('Aus Bestellung übernehmen: neue Liste mit allen Positionen, Menge abzüglich Storno, Preis mit Stand', async () => {
  const g = await createGroup('Gruppe A');
  const a = await addItem(owner.token, { supplier: 'reichelt', part_number: 'NE 555 DIP', name: 'Timer', qty: 10, group: g.id, price_unit: 0.31, url: 'https://example.com/ne555' });
  await addItem(owner.token, { supplier: 'reichelt', part_number: 'LED 5MM RT', qty: 3 });
  const gone = await addItem(owner.token, { supplier: 'reichelt', part_number: 'KAPUTT', qty: 2 });
  await http('PATCH', `/api/collections/order_items/records/${a.item.id}`, { token: owner.token, json: { qty_cancelled: 4 } });
  await http('PATCH', `/api/collections/order_items/records/${gone.item.id}`, { token: owner.token, json: { qty_cancelled: 2 } });
  const order = await getRecord('orders', a.order.id);

  // auch aus fremden Bestellungen; neue Liste gehört dem Aufrufer
  const r = await fromOrder(other, { order: order.id, new_list: { title: ' Grundausstattung ', description: 'Standard', is_public: true } });
  assert.deepEqual([r.added, r.existing, r.priceUpdated], [3, 0, 0]);
  assert.equal(r.list.owner, other.user.id);
  assert.equal(r.list.title, 'Grundausstattung');
  assert.equal(r.list.supplier, 'reichelt');
  assert.equal(r.list.is_public, true);

  const items = await favItems(r.list);
  assert.deepEqual(items.map((i) => [i.part_number, i.qty]), [['KAPUTT', 1], ['LED 5MM RT', 3], ['NE 555 DIP', 6]]);
  const ne = items.find((i) => i.part_number === 'NE 555 DIP');
  assert.equal(ne.name, 'Timer');
  assert.equal(ne.url, 'https://example.com/ne555');
  assert.equal(ne.price_unit, 0.31);
  assert.equal(ne.price_date, order.created, 'Stand = Anlagedatum der Bestellung');
  assert.equal(items.find((i) => i.part_number === 'LED 5MM RT').price_date, '');
});

test('Aus Bestellung übernehmen: Auswahl in bestehende Liste, Dubletten ergänzen, Preis nur von neueren Bestellungen', async () => {
  const list = await createList(owner, { supplier: 'reichelt' });
  await addFav(owner, list, { part_number: 'NE 555 DIP', qty: 7 });
  const a = await addItem(owner.token, { supplier: 'reichelt', part_number: 'ne 555 dip', name: 'Timer', qty: 2, price_unit: 0.3 });
  const b = await addItem(owner.token, { supplier: 'reichelt', part_number: 'LED 5MM RT', qty: 3 });
  await addItem(owner.token, { supplier: 'reichelt', part_number: 'NICHT GEWAEHLT', qty: 1 });

  const r = await fromOrder(owner, { order: a.order.id, list: list.id, items: [a.item.id, b.item.id] });
  assert.deepEqual([r.added, r.existing, r.priceUpdated], [1, 1, 1]);
  let items = await favItems(list);
  assert.deepEqual(items.map((i) => [i.part_number, i.qty, i.name]), [['LED 5MM RT', 3, ''], ['NE 555 DIP', 7, 'Timer']],
    'keine Dublette, Standardmenge bleibt, Bezeichnung ergänzt, nicht gewählte Position fehlt');
  assert.equal(items[1].price_unit, 0.3);

  // Preis von Hand mit späterem Stand → ältere Bestellung überschreibt ihn nicht
  await http('PATCH', `/api/collections/favorite_items/records/${items[1].id}`, { token: await admin(), json: { price_unit: 0.4, price_date: '2099-01-01 00:00:00.000Z' } });
  const again = await fromOrder(owner, { order: a.order.id, list: list.id, items: [a.item.id] });
  assert.deepEqual([again.added, again.existing, again.priceUpdated], [0, 1, 0]);
  items = await favItems(list);
  assert.equal(items[1].price_unit, 0.4);
});

test('Aus Bestellung übernehmen: Fehlerfälle ändern nichts', async () => {
  const a = await addItem(owner.token, { supplier: 'reichelt', part_number: 'NE 555 DIP', qty: 2 });
  const m = await addItem(owner.token, { supplier: 'mouser', part_number: '595-NE555P', qty: 2 });
  const own = await createList(owner, { supplier: 'reichelt' });
  const foreign = await createList(other, { supplier: 'reichelt' });
  const mouserList = await createList(owner, { supplier: 'mouser' });

  await expectHttpError(fromOrder(owner, { order: a.order.id, list: foreign.id }), 403);
  await expectHttpError(fromOrder(owner, { order: a.order.id, list: mouserList.id }), 400);
  await expectHttpError(fromOrder(owner, { order: a.order.id, list: own.id, items: [] }), 400);
  await expectHttpError(fromOrder(owner, { order: a.order.id, list: own.id, items: [a.item.id, m.item.id] }), 400);
  await expectHttpError(fromOrder(owner, { order: a.order.id }), 400);
  await expectHttpError(fromOrder(owner, { order: a.order.id, list: own.id, new_list: { title: 'X' } }), 400);
  await expectHttpError(fromOrder(owner, { order: 'gibtesnicht1234', list: own.id }), 400);
  // neue Liste ohne Titel: es bleibt keine leere Liste zurück
  await expectHttpError(fromOrder(owner, { order: a.order.id, new_list: { title: ' ' } }), 400);
  // ungültige Auswahl nach Anlegen der neuen Liste → Rollback auch der Liste
  await expectHttpError(fromOrder(owner, { order: a.order.id, items: ['gibtesnicht1234'], new_list: { title: 'Rollback' } }), 400);
  await expectHttpError(fromOrder(other, { order: a.order.id }), 400);

  assert.equal((await listRecords('favorite_items')).length, 0);
  assert.deepEqual((await listRecords('favorite_lists')).map((l) => l.title).sort(), ['Liste', 'Liste', 'Liste']);
});

test('„sonstige“: Übernahme nur bei gleichem Shop-Namen (Groß-/Kleinschreibung egal)', async () => {
  const c = await addItem(owner.token, { supplier: 'other', supplier_custom_name: 'conrad', part_number: 'C-1', qty: 1 });
  const conrad = await createList(owner, { supplier: 'other', supplier_custom_name: 'Conrad' });
  const digikey = await createList(owner, { supplier: 'other', supplier_custom_name: 'Digikey' });
  await expectHttpError(fromOrder(owner, { order: c.order.id, list: digikey.id }), 400);
  assert.equal((await fromOrder(owner, { order: c.order.id, list: conrad.id })).added, 1);
  const neu = await fromOrder(owner, { order: c.order.id, new_list: { title: 'Neu' } });
  assert.deepEqual([neu.list.supplier, neu.list.supplier_custom_name], ['other', 'conrad']);
});

test('Bestellen aus Favoriten: Sammel-Import übernimmt den Preis nur, wenn die Position noch keinen hat', async () => {
  const g = await createGroup('Gruppe A');
  await addItem(owner.token, { supplier: 'printus', part_number: '892586', qty: 1, price_unit: 4.5 });
  const r = await http('POST', '/api/lab/cart-items/batch', {
    token: other.token,
    json: {
      items: [
        { supplier: 'printus', part_number: '892586', qty: 5, price_unit: 3.99, group: g.id },
        { supplier: 'printus', part_number: '302491', name: 'Umschläge', qty: 2, price_unit: 7.2 },
      ],
    },
  });
  assert.deepEqual(r, { items: 2, merged: 1, orders: 1, groups: 0 });
  const items = await listRecords('order_items');
  const by = (p) => items.find((i) => i.part_number === p);
  assert.deepEqual([by('892586').qty_ordered, by('892586').price_unit], [6, 4.5]);
  assert.equal(by('302491').price_unit, 7.2);
});
