// Lieferscheine ohne passende Bestellung (ARCHITECTURE.md Kap. 4.6):
//   1. Bestellung aus einem Lieferschein anlegen (Herkunft „lieferschein“, sofort geliefert)
//   2. Abgelegten Lieferschein einer Bestellung zuordnen (Beleg wird Anhang, Ablage-Eintrag entfällt)
// Muss innerhalb einer Transaktion aufgerufen werden.

const { SUPPLIERS, normalizePartNumber, normalizeShopName, normalizeInternalOrderNo, positiveInt, truthy } =
  require(`${__hooks}/lib/util.js`);
const { allocationNote, resolveGroup, NO_GROUP_LABEL } = require(`${__hooks}/lib/cart.js`);
const { bookDelivery } = require(`${__hooks}/lib/deliveries.js`);

const MAX_ITEMS = 200;

/**
 * body: { supplier, supplier_custom_name?, internal_order_no?, without_internal_order_no?,
 *         supplier_order_no?, note?, items: [{ part_number, name?, qty, group? }] }
 * receipts: Beleg (höchstens eine Datei)
 * → { order, delivery, status }
 */
function createOrderFromDeliveryNote(app, body, items, receipts, userId) {
  const supplier = String(body.supplier || "");
  if (SUPPLIERS.indexOf(supplier) === -1) throw new BadRequestError("Unbekannter Lieferant: " + supplier);
  const shopName = supplier === "other" ? normalizeShopName(body.supplier_custom_name) : "";
  if (supplier === "other" && !shopName) {
    throw new BadRequestError("Bei „Sonstiger Lieferant“ ist der Shop-Name erforderlich.");
  }

  // Interne Bestellnummer: angeben oder ausdrücklich darauf verzichten (Muster, Direktkauf)
  const internalNo = normalizeInternalOrderNo(body.internal_order_no);
  const without = truthy(body.without_internal_order_no);
  if (!internalNo && !without) {
    throw new BadRequestError("Bitte die interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen.");
  }
  if (internalNo && without) {
    throw new BadRequestError("Entweder eine interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen – nicht beides.");
  }

  if (!Array.isArray(items) || !items.length) throw new BadRequestError("Mindestens eine Position angeben.");
  if (items.length > MAX_ITEMS) throw new BadRequestError("Höchstens " + MAX_ITEMS + " Positionen.");

  // Positionen zusammenfassen: gleiche Bestellnummer → eine Position, Gruppenanteile addiert
  const byPart = {};
  const entries = [];
  items.forEach((input, i) => {
    const part = normalizePartNumber(input && input.part_number);
    if (!part) throw new BadRequestError("Position " + (i + 1) + ": Die Bestellnummer ist erforderlich.");
    const qty = positiveInt(input.qty, "Position " + (i + 1) + ": Die Menge");
    const group = resolveGroup(app, input.group);
    let entry = byPart[part];
    if (!entry) {
      entry = byPart[part] = { part: part, name: String(input.name || "").trim(), qty: 0, allocations: [], groups: [] };
      entries.push(entry);
    }
    if (!entry.name) entry.name = String(input.name || "").trim();
    entry.qty += qty;
    const key = group ? group.id : null;
    const alloc = entry.allocations.find((a) => (a.groupId || null) === key);
    if (alloc) alloc.qty += qty;
    else entry.allocations.push({ groupId: key, groupName: group ? group.getString("name") : NO_GROUP_LABEL, qty: qty });
    if (group && entry.groups.indexOf(group.id) === -1) entry.groups.push(group.id);
  });

  const order = new Record(app.findCollectionByNameOrId("orders"));
  order.set("supplier", supplier);
  order.set("supplier_custom_name", shopName);
  order.set("status", "bestellt");
  order.set("origin", "lieferschein");
  order.set("internal_order_no", internalNo);
  order.set("without_internal_order_no", without);
  order.set("supplier_order_no", String(body.supplier_order_no || "").trim());
  order.set("custom_fields", {});
  if (userId) order.set("created_by", userId);
  app.save(order); // Format und Eindeutigkeit der internen Nummer prüft der Validierungs-Hook

  const itemCol = app.findCollectionByNameOrId("order_items");
  const lines = entries.map((entry) => {
    const item = new Record(itemCol);
    item.set("order", order.id);
    item.set("part_number", entry.part);
    item.set("name", entry.name);
    item.set("qty_ordered", entry.qty);
    item.set("qty_delivered", 0);
    item.set("qty_cancelled", 0);
    item.set("groups", entry.groups);
    item.set("group_allocations", entry.allocations);
    item.set("group_allocation_note", allocationNote(entry.allocations));
    app.save(item);
    return { item: item.id, qty: entry.qty };
  });

  const result = bookDelivery(app, order.id, lines, body.note, receipts, userId);
  return { order: app.findRecordById("orders", order.id), delivery: result.delivery, status: result.status };
}

/** Abgelegten Lieferschein einer Bestellung zuordnen: Beleg als Anhang kopieren, Ablage-Eintrag löschen. */
function assignUnmatchedReceipt(app, receiptId, orderId) {
  let entry;
  try {
    entry = app.findRecordById("unmatched_receipts", receiptId);
  } catch (_) {
    throw new BadRequestError("Der abgelegte Lieferschein existiert nicht mehr.");
  }
  let order;
  try {
    order = app.findRecordById("orders", String(orderId || ""));
  } catch (_) {
    throw new BadRequestError("Bitte eine Bestellung wählen.");
  }
  const fsys = app.newFilesystem();
  try {
    const file = fsys.getReuploadableFile(entry.baseFilesPath() + "/" + entry.getString("receipt"), true);
    order.set("attachments+", file);
    app.save(order);
  } finally {
    fsys.close();
  }
  app.delete(entry);
  return order;
}

module.exports = { createOrderFromDeliveryNote, assignUnmatchedReceipt };
