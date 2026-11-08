// Lieferbuchungen (ARCHITECTURE.md Kap. 4.4).

const { DELIVERY_STATUSES, nonZeroInt } = require(`${__hooks}/lib/util.js`);
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

module.exports = { bookDelivery, sumDelivered };
