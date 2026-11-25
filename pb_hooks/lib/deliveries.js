// Lieferbuchungen (ARCHITECTURE.md Kap. 4.4).

const { DELIVERY_STATUSES, nonZeroInt, supplierName } = require(`${__hooks}/lib/util.js`);
const { recalculateOrderStatus } = require(`${__hooks}/lib/status.js`);

/** Summe aller gebuchten Mengen einer Position. */
function sumDelivered(app, itemId) {
  const rows = app.findRecordsByFilter(
    "delivery_items", "order_item = {:item}", "", 0, 0, { item: itemId }
  );
  return rows.reduce((s, r) => s + r.getInt("qty"), 0);
}

/**
 * Lieferung buchen. Muss innerhalb einer Transaktion aufgerufen werden.
 * lines: [{ item, qty }]  (qty ≠ 0, negativ = Korrektur)
 * receipts: optionale Belegdatei als Array (filesystem.File[], höchstens eine – mehrseitige Belege als PDF)
 */
function bookDelivery(app, orderId, lines, note, receipts, userId) {
  const order = app.findRecordById("orders", orderId);
  if (DELIVERY_STATUSES.indexOf(order.getString("status")) === -1) {
    throw new BadRequestError(
      "Lieferungen können nur bei bestellten, teil- oder vollständig gelieferten Bestellungen gebucht werden."
    );
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new BadRequestError("Die Lieferung enthält keine Positionen.");
  }

  // Mengen je Position zusammenfassen und prüfen, dass alle zur Bestellung gehören.
  const perItem = {};
  for (const line of lines) {
    const id = String(line && line.item || "");
    const qty = nonZeroInt(line && line.qty, "Die Liefermenge");
    perItem[id] = (perItem[id] || 0) + qty;
  }
  const items = {};
  for (const id of Object.keys(perItem)) {
    if (perItem[id] === 0) {
      delete perItem[id];
      continue;
    }
    let item;
    try {
      item = app.findRecordById("order_items", id);
    } catch (_) {
      throw new BadRequestError("Unbekannte Position: " + id);
    }
    if (item.getString("order") !== order.id) {
      throw new BadRequestError("Die Position " + id + " gehört nicht zu dieser Bestellung.");
    }
    items[id] = item;
  }
  if (Object.keys(perItem).length === 0) {
    throw new BadRequestError("Die Lieferung enthält keine Mengenänderung.");
  }

  const delivery = new Record(app.findCollectionByNameOrId("deliveries"));
  delivery.set("order", order.id);
  if (userId) delivery.set("booked_by", userId);
  delivery.set("note", String(note || "").trim());
  if (receipts && receipts.length) {
    if (receipts.length > 1) {
      throw new BadRequestError("Nur ein Beleg je Lieferung – mehrseitige Lieferscheine bitte als PDF.");
    }
    delivery.set("receipt", receipts[0]);
  }
  app.save(delivery);

  const lineCol = app.findCollectionByNameOrId("delivery_items");
  for (const id of Object.keys(perItem)) {
    const row = new Record(lineCol);
    row.set("delivery", delivery.id);
    row.set("order_item", id);
    row.set("qty", perItem[id]);
    app.save(row);
  }

  for (const id of Object.keys(items)) {
    const item = items[id];
    const total = sumDelivered(app, id);
    if (total < 0) {
      throw new BadRequestError(
        "Die gelieferte Menge von " + item.getString("part_number") + " würde negativ werden."
      );
    }
    item.set("qty_delivered", total);
    app.save(item);
  }

  const status = recalculateOrderStatus(app, order.id);
  return { delivery: delivery, status: status };
}

/**
 * „Geliefert“ abhaken: den Rest aller Positionen (bestellt − storniert − geliefert) als eine Lieferung buchen.
 * Muss innerhalb einer Transaktion aufgerufen werden. Danach ist die Bestellung „geliefert“ (Phase aus den Mengen).
 */
function bookRest(app, orderId, userId) {
  const items = app.findRecordsByFilter("order_items", "order = {:id}", "created", 0, 0, { id: orderId });
  const lines = [];
  for (const item of items) {
    const rest = item.getInt("qty_ordered") - item.getInt("qty_cancelled") - item.getInt("qty_delivered");
    if (rest > 0) lines.push({ item: item.id, qty: rest });
  }
  if (!lines.length) throw new BadRequestError("Es ist nichts mehr offen – alle Positionen sind geliefert.");
  return bookDelivery(app, orderId, lines, "Rest vollständig geliefert", [], userId);
}

/**
 * Letzte Lieferbuchung einer Bestellung zurücknehmen („Rückgängig“ nach dem Buchen). Muss innerhalb einer
 * Transaktion aufgerufen werden. Nur die jeweils letzte Buchung und nur ohne Beleg (Belege bleiben erhalten);
 * Mengen und Phase werden neu berechnet.
 */
function cancelDelivery(app, deliveryId) {
  let delivery;
  try {
    delivery = app.findRecordById("deliveries", deliveryId);
  } catch (_) {
    throw new NotFoundError("Lieferbuchung nicht gefunden.");
  }
  const orderId = delivery.getString("order");
  const latest = app.findRecordsByFilter("deliveries", "order = {:id}", "-created,-id", 1, 0, { id: orderId });
  if (!latest.length || latest[0].id !== delivery.id) {
    throw new BadRequestError("Nur die letzte Lieferbuchung einer Bestellung kann zurückgenommen werden.");
  }
  if (delivery.getString("receipt")) {
    throw new BadRequestError("Lieferbuchungen mit Beleg können nicht zurückgenommen werden.");
  }
  const lines = app.findRecordsByFilter("delivery_items", "delivery = {:id}", "", 0, 0, { id: delivery.id });
  const itemIds = lines.map((l) => l.getString("order_item"));
  app.delete(delivery); // Zeilen hängen per cascadeDelete daran

  for (const id of itemIds) {
    const item = app.findRecordById("order_items", id);
    const total = sumDelivered(app, id);
    if (total < 0) {
      throw new BadRequestError("Die gelieferte Menge von " + item.getString("part_number") + " würde negativ werden.");
    }
    item.set("qty_delivered", total);
    app.save(item);
  }
  return { status: recalculateOrderStatus(app, orderId) };
}

/**
 * „Geliefert“ zurücksetzen (Haken im Ablauf entfernen): alle Lieferbuchungen der Bestellung löschen, gelieferte
 * Mengen auf 0. Belege (gescannte Lieferscheine) gehen nicht verloren, sondern in die Ablage „Lieferscheine ohne
 * Bestellung“ – von dort lassen sie sich einer anderen Bestellung zuordnen. Muss innerhalb einer Transaktion
 * aufgerufen werden (ARCHITECTURE.md Kap. 2 und 4.4).
 * → { status, deliveries: Anzahl gelöschter Buchungen, archived: Anzahl abgelegter Belege }
 */
function resetDeliveries(app, orderId, userId) {
  let order;
  try {
    order = app.findRecordById("orders", orderId);
  } catch (_) {
    throw new NotFoundError("Bestellung nicht gefunden.");
  }
  if (DELIVERY_STATUSES.indexOf(order.getString("status")) === -1) {
    throw new BadRequestError(order.getString("status") === "abgeschlossen"
      ? "Die Bestellung ist abgeschlossen – Lieferungen lassen sich nicht mehr zurücksetzen."
      : "Die Bestellung hat keine Lieferungen.");
  }
  const deliveries = app.findRecordsByFilter("deliveries", "order = {:id}", "created", 0, 0, { id: orderId });
  if (!deliveries.length) throw new BadRequestError("Die Bestellung hat keine Lieferbuchungen.");

  const number = order.getString("internal_order_no");
  const archiveCol = app.findCollectionByNameOrId("unmatched_receipts");
  let archived = 0;
  const fsys = app.newFilesystem();
  try {
    for (const delivery of deliveries) {
      const name = delivery.getString("receipt");
      if (!name) continue;
      const entry = new Record(archiveCol);
      entry.set("supplier_name", supplierName(order));
      entry.set("internal_order_no", number);
      entry.set("note", "Lieferung von " + (number || "Bestellung ohne interne Nummer") + " zurückgesetzt" +
        (delivery.getString("note") ? " – " + delivery.getString("note") : ""));
      entry.set("receipt", fsys.getReuploadableFile(delivery.baseFilesPath() + "/" + name, true));
      if (userId) entry.set("uploaded_by", userId);
      app.save(entry);
      archived++;
    }
  } finally {
    fsys.close();
  }

  for (const delivery of deliveries) app.delete(delivery); // Zeilen hängen per cascadeDelete daran
  const items = app.findRecordsByFilter("order_items", "order = {:id}", "", 0, 0, { id: orderId });
  for (const item of items) {
    if (item.getInt("qty_delivered") === 0) continue;
    item.set("qty_delivered", 0);
    app.save(item);
  }
  return { status: recalculateOrderStatus(app, orderId), deliveries: deliveries.length, archived: archived };
}

module.exports = { bookDelivery, bookRest, cancelDelivery, resetDeliveries, sumDelivered };
