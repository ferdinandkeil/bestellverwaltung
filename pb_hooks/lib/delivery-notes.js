// Lieferscheine ohne passende Bestellung (ARCHITECTURE.md Kap. 4.6):
//   1. Bestellung aus einem Lieferschein anlegen (Herkunft „lieferschein“, sofort geliefert)
//   2. Abgelegten Lieferschein einer Bestellung zuordnen (Beleg wird Anhang, Ablage-Eintrag entfällt)
// Muss innerhalb einer Transaktion aufgerufen werden.

const { parseOrderHead, collectItems, saveOrder } = require(`${__hooks}/lib/new-orders.js`);
const { bookDelivery } = require(`${__hooks}/lib/deliveries.js`);
const { createInitialSteps } = require(`${__hooks}/lib/status.js`);

/**
 * body: { supplier, supplier_custom_name?, internal_order_no?, without_internal_order_no?,
 *         supplier_order_no?, note?, items: [{ part_number, name?, qty, group? }] }
 * receipts: Beleg (höchstens eine Datei)
 * → { order, delivery, status }
 */
function createOrderFromDeliveryNote(app, body, items, receipts, userId) {
  const head = parseOrderHead(body);
  const entries = collectItems(app, items);
  const saved = saveOrder(app, head, entries, {
    status: "bestellt", origin: "lieferschein", supplier_order_no: body.supplier_order_no,
  }, userId);
  const order = saved.order;
  createInitialSteps(app, order, userId); // Formular/Bestellung liefen am System vorbei (Kap. 4.6)

  const lines = saved.items.map((item) => ({ item: item.id, qty: item.getInt("qty_ordered") }));
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
