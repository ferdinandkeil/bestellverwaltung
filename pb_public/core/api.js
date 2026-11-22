// Dünner Client für die serverseitige Geschäftslogik (/api/lab/*, siehe pb_hooks/)
// und Lese-/Schreibzugriffe auf die freigegebenen Felder.
import { pb } from './pb.js';
import { VAT_RATE, SUPPLIERS } from './config.js';

// ---------------------------------------------------------------------------
// Fehlertexte
// ---------------------------------------------------------------------------

/** Lesbare deutsche Fehlermeldung aus einem PocketBase-Fehler. */
export function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.isAbort) return 'Anfrage abgebrochen.';
  if (err.status === 0) return 'Keine Verbindung zum Server.';
  const res = err.response ?? {};
  const data = res.data ?? {};
  if (Object.values(data).some((e) => e?.code === 'validation_not_unique')) {
    return 'Ein Eintrag mit diesen Angaben existiert bereits.';
  }
  const fields = Object.entries(data)
    .map(([field, e]) => `${field}: ${e?.message ?? e}`)
    .join(', ');
  if (err.status === 404 && err.url && /\/records\//.test(err.url)) {
    return 'Nicht gefunden oder in diesem Status nicht erlaubt.';
  }
  if (err.status === 403) return res.message || 'Keine Berechtigung.';
  return [res.message || err.message, fields].filter(Boolean).join(' – ');
}

// ---------------------------------------------------------------------------
// Geschäftslogik (Server-Routen)
// ---------------------------------------------------------------------------

/**
 * Position in den offenen Sammelkorb des Lieferanten buchen (Merge bei gleicher Bestellnummer).
 * data: { supplier, supplier_custom_name?, part_number, name, qty, group?, url?, price_unit? }
 * → { order, item, merged }
 */
export function addItemToSupplierCart(data) {
  return pb.send('/api/lab/cart-items', { method: 'POST', body: data });
}

/**
 * Verwaltungsschritt abhaken, Datum ändern (done: true bei erledigtem Schritt) oder zurücknehmen (done: false).
 * options: { done = true, date?: 'JJJJ-MM-TT' (leer = jetzt, null = unbekannt), internal_order_no? | without_internal_order_no: true, supplier_order_no? }
 * → Bestellung mit neu abgeleiteter Phase
 */
export function setOrderStep(orderId, step, { done = true, date = '', internal_order_no = '', without_internal_order_no = false, supplier_order_no = '' } = {}) {
  const body = { step, done };
  if (date || date === null) body.date = date; // null = Datum unbekannt
  if (internal_order_no) body.internal_order_no = internal_order_no;
  if (without_internal_order_no) body.without_internal_order_no = true;
  if (supplier_order_no) body.supplier_order_no = supplier_order_no;
  return pb.send(`/api/lab/orders/${orderId}/steps`, { method: 'POST', body });
}

/** Erledigte Verwaltungsschritte einer Bestellung als { step: record } (mit done_by expandiert). */
export async function listOrderSteps(orderId) {
  const list = await pb.collection('order_steps').getFullList({
    filter: pb.filter('order = {:id}', { id: orderId }), expand: 'done_by',
  });
  return Object.fromEntries(list.map((s) => [s.step, s]));
}

/**
 * Lieferung buchen.
 * lines: [{ item, qty }] (qty ≠ 0, negativ = Korrektur), receipt: optionale Datei,
 * newItems: vergessene Positionen [{ part_number, name?, qty, group? }] – werden nachgetragen und mitgeliefert.
 * → { delivery, status }
 */
export function bookDelivery(orderId, lines, { note = '', receipt = null, newItems = [] } = {}) {
  let body;
  if (receipt) {
    body = new FormData();
    body.append('lines', JSON.stringify(lines));
    if (newItems.length) body.append('newItems', JSON.stringify(newItems));
    body.append('note', note);
    body.append('receipt', receipt);
  } else {
    body = { lines, note };
    if (newItems.length) body.newItems = newItems;
  }
  return pb.send(`/api/lab/orders/${orderId}/deliveries`, { method: 'POST', body });
}

// ---------------------------------------------------------------------------
// Bestellungen
// ---------------------------------------------------------------------------

/** Beginn des Zeitraums für abgeschlossene Bestellungen: '3m', '12m', 'year:JJJJ' oder 'all'. → { from, to } | null */
/** „Geliefert“ abhaken: Rest aller Positionen als eine Lieferung buchen. → { delivery, status } */
export function bookRestDelivered(orderId) {
  return pb.send(`/api/lab/orders/${orderId}/deliveries/rest`, { method: 'POST' });
}

/** Letzte Lieferbuchung zurücknehmen („Rückgängig“, nur ohne Beleg). → { status } */
export function cancelDelivery(deliveryId) {
  return pb.send(`/api/lab/deliveries/${deliveryId}`, { method: 'DELETE' });
}

export function periodRange(period, now = new Date()) {
  if (period === '3m' || period === '12m') {
    const from = new Date(now);
    from.setMonth(from.getMonth() - (period === '3m' ? 3 : 12));
    return { from, to: null };
  }
  const year = /^year:(\d{4})$/.exec(period || '')?.[1];
  if (year) return { from: new Date(Number(year), 0, 1), to: new Date(Number(year) + 1, 0, 1) };
  return null;
}

/**
 * Bestellungen für die Startseite (ohne offene Warenkörbe) mit Schritten, Lieferungen und Positionen.
 * Ohne Suche: Phasen (leer = alle), Zeitraum gilt nur für abgeschlossene (nach closed_at), offene immer.
 * Mit Suche: alle Bestellungen inkl. Warenkörbe, unabhängig von Phase und Zeitraum (interne/Shop-Auftragsnummer,
 * Lieferant, Was, Artikelnummer). Lieferant und Gruppe gelten immer.
 */
export async function listOverviewOrders({ phases = [], period = '3m', supplier = '', group = '', search = '' } = {}) {
  const parts = [];
  const params = {};
  const q = search.trim();
  if (q) {
    params.q = q;
    const or = ['internal_order_no ~ {:q}', 'supplier_order_no ~ {:q}', 'subject ~ {:q}', 'supplier_custom_name ~ {:q}',
      'order_items_via_order.part_number ?~ {:q}'];
    SUPPLIERS.filter((s) => s.value !== 'other' && s.label.toLowerCase().includes(q.toLowerCase()))
      .forEach((s, i) => { or.push(`supplier = {:s${i}}`); params['s' + i] = s.value; });
    parts.push('(' + or.join(' || ') + ')');
  } else {
    parts.push("status != 'angefragt'");
    if (phases.length) {
      parts.push('(' + phases.map((p, i) => `status = {:p${i}}`).join(' || ') + ')');
      phases.forEach((p, i) => { params['p' + i] = p; });
    }
    const range = periodRange(period);
    if (range) {
      params.from = range.from;
      let closed = 'closed_at >= {:from}';
      if (range.to) { closed += ' && closed_at < {:to}'; params.to = range.to; }
      parts.push(`(status != 'abgeschlossen' || (${closed}))`);
    }
  }
  if (supplier) { parts.push('supplier = {:supplier}'); params.supplier = supplier; }
  if (group) { parts.push('order_items_via_order.groups.id ?= {:group}'); params.group = group; }
  return pb.collection('orders').getFullList({
    filter: pb.filter(parts.join(' && '), params),
    sort: 'created',
    expand: 'order_steps_via_order.done_by,deliveries_via_order,order_items_via_order',
  });
}

/** Offene Warenkörbe (Phase „angefragt“) mit Positionen, älteste zuerst. */
export function listOpenCarts() {
  return pb.collection('orders').getFullList({
    filter: "status = 'angefragt'", sort: 'created', expand: 'order_items_via_order',
  });
}

export function getOrder(id) {
  return pb.collection('orders').getOne(id, { expand: 'created_by' });
}

export function listOrderItems(orderId) {
  return pb.collection('order_items').getFullList({
    filter: pb.filter('order = {:id}', { id: orderId }),
    sort: 'created',
    expand: 'added_later_by',
  });
}

/**
 * Vergessene Position bei einer bestellten Bestellung nachtragen (gekennzeichnet).
 * data: { part_number, name?, qty, group? } → { item, status }
 */
export function addLateItem(orderId, data) {
  return pb.send(`/api/lab/orders/${orderId}/items`, { method: 'POST', body: data });
}

/** Freigegebene Felder: internal_order_no, supplier_order_no, notes, shipping_cost, invoice_total, custom_fields, … */
export function updateOrder(id, data) {
  return pb.collection('orders').update(id, data);
}

export function deleteOrder(id) {
  return pb.collection('orders').delete(id);
}

export function uploadAttachments(orderId, files) {
  const form = new FormData();
  for (const f of files) form.append('attachments+', f);
  return pb.collection('orders').update(orderId, form);
}

export function removeAttachment(orderId, filename) {
  return pb.collection('orders').update(orderId, { 'attachments-': [filename] });
}

export function fileUrl(record, filename, thumb) {
  return pb.files.getURL(record, filename, thumb ? { thumb } : undefined);
}

// ---------------------------------------------------------------------------
// Positionen
// ---------------------------------------------------------------------------

/** Freigegebene Felder: part_number, name, url, qty_ordered, qty_cancelled, price_unit. */
export function updateItem(id, data) {
  return pb.collection('order_items').update(id, data);
}

export function deleteItem(id) {
  return pb.collection('order_items').delete(id);
}

/** Rückstand = bestellt − geliefert − storniert (min. 0). */
export function backlogOf(item) {
  return Math.max(0, (item.qty_ordered || 0) - (item.qty_delivered || 0) - (item.qty_cancelled || 0));
}

/** Netto/Brutto einer Bestellung (ARCHITECTURE.md Kap. 4.1). */
export function orderTotals(order, items) {
  const itemsNet = items.reduce(
    (sum, it) => sum + Math.max(0, (it.qty_ordered || 0) - (it.qty_cancelled || 0)) * (it.price_unit || 0), 0);
  const shipping = order?.shipping_cost || 0;
  const net = itemsNet + shipping;
  return {
    itemsNet,
    shipping,
    net,
    vat: net * VAT_RATE,
    gross: net * (1 + VAT_RATE),
    missingPrices: items.filter((it) => !it.price_unit).length,
  };
}

// ---------------------------------------------------------------------------
// Lieferhistorie
// ---------------------------------------------------------------------------

export function listDeliveries(orderId) {
  return pb.collection('deliveries').getFullList({
    filter: pb.filter('order = {:id}', { id: orderId }),
    sort: '-created',
    expand: 'booked_by,delivery_items_via_delivery',
  });
}

// ---------------------------------------------------------------------------
// Gruppen
// ---------------------------------------------------------------------------

export function listGroups({ onlyActive = false } = {}) {
  return pb.collection('groups').getFullList({
    filter: onlyActive ? 'is_active = true' : '',
    sort: 'course,name',
  });
}

export function createGroup(data) {
  return pb.collection('groups').create(data);
}

export function updateGroup(id, data) {
  return pb.collection('groups').update(id, data);
}

export function deleteGroup(id) {
  return pb.collection('groups').delete(id);
}

/** Alle Positionen, an denen eine Gruppe beteiligt ist, inkl. Bestellung. */
export function listItemsForGroup(groupId) {
  return pb.collection('order_items').getFullList({
    filter: pb.filter('groups.id ?= {:g}', { g: groupId }),
    sort: '-created',
    expand: 'order',
  });
}

// ---------------------------------------------------------------------------
// Lieferscheine ohne Bestellung (ARCHITECTURE.md Kap. 4.6)
// ---------------------------------------------------------------------------

/**
 * Bestellung aus einem Lieferschein anlegen (Herkunft „lieferschein“, sofort geliefert).
 * data: { supplier, supplier_custom_name?, internal_order_no? | without_internal_order_no, supplier_order_no?,
 *         note?, items: [{ part_number, name?, qty, group? }] }, receipt: PDF
 * → { order, delivery, status }
 */
export function createOrderFromDeliveryNote(data, receipt) {
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    body.append(k, k === 'items' ? JSON.stringify(v) : String(v));
  }
  if (receipt) body.append('receipt', receipt);
  return pb.send('/api/lab/orders/from-delivery-note', { method: 'POST', body });
}

export function listUnmatchedReceipts() {
  return pb.collection('unmatched_receipts').getFullList({ sort: '-created', expand: 'uploaded_by' });
}

/** Lieferschein ohne Bestellung ablegen. data: { supplier_name, internal_order_no?, note? } */
export function createUnmatchedReceipt(data, receipt) {
  const body = new FormData();
  body.append('supplier_name', data.supplier_name);
  body.append('internal_order_no', data.internal_order_no || '');
  body.append('note', data.note || '');
  body.append('uploaded_by', pb.authStore.record?.id ?? '');
  body.append('receipt', receipt);
  return pb.collection('unmatched_receipts').create(body);
}

/** Abgelegten Lieferschein einer Bestellung zuordnen (Beleg wird Anhang, Ablage-Eintrag entfällt). */
export function assignUnmatchedReceipt(id, orderId) {
  return pb.send(`/api/lab/unmatched-receipts/${id}/assign`, { method: 'POST', body: { order: orderId } });
}

export function deleteUnmatchedReceipt(id) {
  return pb.collection('unmatched_receipts').delete(id);
}

// ---------------------------------------------------------------------------
// Favoriten (ARCHITECTURE.md Kap. 4.7)
// ---------------------------------------------------------------------------

/** Alle Favoritenlisten (für alle sichtbar) mit Besitzer und Artikeln (für die Anzahl). */
export function listFavoriteLists() {
  return pb.collection('favorite_lists').getFullList({
    sort: 'title',
    expand: 'owner,favorite_items_via_list',
  });
}

export function getFavoriteList(id) {
  return pb.collection('favorite_lists').getOne(id, { expand: 'owner' });
}

/** Eigene Listen eines Lieferanten (Ziel für „In Favoriten“). Bei „sonstige“ wird der Shop-Name im Browser verglichen. */
export function listOwnFavoriteLists(supplier) {
  return pb.collection('favorite_lists').getFullList({
    filter: pb.filter('owner = {:owner} && supplier = {:supplier}', { owner: pb.authStore.record?.id ?? '', supplier }),
    sort: 'title',
  });
}

/** data: { title, description, is_public, supplier, supplier_custom_name } – Besitzer ist der angemeldete Nutzer. */
export function createFavoriteList(data) {
  return pb.collection('favorite_lists').create({ ...data, owner: pb.authStore.record?.id ?? '' });
}

/** Änderbar: title, description, is_public, supplier_custom_name (Lieferant und Besitzer sind fest). */
export function updateFavoriteList(id, data) {
  return pb.collection('favorite_lists').update(id, data);
}

export function deleteFavoriteList(id) {
  return pb.collection('favorite_lists').delete(id);
}

export function listFavoriteItems(listId) {
  return pb.collection('favorite_items').getFullList({ filter: pb.filter('list = {:id}', { id: listId }) });
}

/** data: { list, part_number, name?, url?, qty, price_unit? } */
export function createFavoriteItem(data) {
  return pb.collection('favorite_items').create(data);
}

export function updateFavoriteItem(id, data) {
  return pb.collection('favorite_items').update(id, data);
}

export function deleteFavoriteItem(id) {
  return pb.collection('favorite_items').delete(id);
}

/**
 * Positionen einer Bestellung in eine Favoritenliste übernehmen.
 * body: { order, items?: [ids], list?: id | new_list?: { title, description?, is_public? } }
 * → { list, added, existing, priceUpdated }
 */
export function addFavoritesFromOrder(body) {
  return pb.send('/api/lab/favorite-lists/from-order', { method: 'POST', body });
}

/**
 * Mehrere Positionen in die Sammelkörbe buchen (alles oder nichts).
 * items: [{ supplier, supplier_custom_name?, part_number, name?, url?, qty, price_unit?, group? }]
 * → { items, merged, orders, groups }
 */
export function addItemsToCarts(items) {
  return pb.send('/api/lab/cart-items/batch', { method: 'POST', body: { groups: [], items } });
}

/** Offener Warenkorb eines Lieferanten (bei „sonstige“ je Shop-Name) oder null. */
export async function findOpenCart(supplier, supplierCustomName = '') {
  const carts = await pb.collection('orders').getFullList({
    filter: pb.filter('supplier = {:supplier} && status = "angefragt"', { supplier }),
  });
  const wanted = (supplierCustomName || '').trim().toLowerCase();
  return carts.find((c) => (c.supplier_custom_name || '').toLowerCase() === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/**
 * Auf Änderungen in Collections reagieren. callback wird (entprellt) aufgerufen.
 * Gibt eine async Abmeldefunktion zurück.
 */
export async function subscribe(collections, callback, delayMs = 250) {
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(callback, delayMs);
  };
  const unsubs = await Promise.all(collections.map((c) => pb.collection(c).subscribe('*', fire)));
  return async () => {
    clearTimeout(timer);
    await Promise.all(unsubs.map((u) => u().catch(() => {})));
  };
}
