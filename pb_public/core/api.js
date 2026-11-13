// Dünner Client für die serverseitige Geschäftslogik (/api/lab/*, siehe pb_hooks/)
// und Lese-/Schreibzugriffe auf die freigegebenen Felder.
import { pb } from './pb.js';
import { VAT_RATE } from './config.js';

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
 * action: 'advance' | 'back'
 * numbers (nur angefragt → bestellt): { internal_order_no | without_internal_order_no: true, supplier_order_no? }
 */
export function changeOrderStatus(orderId, action, numbers = {}) {
  const body = { action };
  if (numbers.internal_order_no) body.internal_order_no = numbers.internal_order_no;
  if (numbers.without_internal_order_no) body.without_internal_order_no = true;
  if (numbers.supplier_order_no) body.supplier_order_no = numbers.supplier_order_no;
  return pb.send(`/api/lab/orders/${orderId}/status`, { method: 'POST', body });
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

/** Bestellungen inkl. Positionen (für Fortschritt) mit optionalen Filtern. */
export async function listOrders({ status = '', supplier = '', group = '' } = {}) {
  const parts = [];
  const params = {};
  if (status) { parts.push('status = {:status}'); params.status = status; }
  if (supplier) { parts.push('supplier = {:supplier}'); params.supplier = supplier; }
  if (group) { parts.push('order_items_via_order.groups.id ?= {:group}'); params.group = group; }
  return pb.collection('orders').getFullList({
    filter: parts.length ? pb.filter(parts.join(' && '), params) : '',
    sort: '-updated',
    expand: 'order_items_via_order,created_by',
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
