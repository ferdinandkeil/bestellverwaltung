// Positionen nachtragen (ARCHITECTURE.md Kap. 4.5): bei einer bereits bestellten Bestellung eine
// Position ergänzen, die beim Erfassen vergessen wurde (z. B. auf dem Lieferschein entdeckt).
// Muss innerhalb einer Transaktion aufgerufen werden.

const { DELIVERY_STATUSES, normalizePartNumber, positiveInt } = require(`${__hooks}/lib/util.js`);
const { allocationNote, parsePrice, resolveGroup, NO_GROUP_LABEL } = require(`${__hooks}/lib/cart.js`);

/**
 * input: { part_number, name?, qty, group?, url?, price_unit? }  – qty = bestellte Menge
 * → neue Position (gekennzeichnet mit added_later_by / added_later_at)
 */
function addLateItem(app, orderId, input, userId) {
  const order = app.findRecordById("orders", orderId);
  if (DELIVERY_STATUSES.indexOf(order.getString("status")) === -1) {
    throw new BadRequestError(
      "Nachtragen ist nur bei bestellten, teil- oder vollständig gelieferten Bestellungen möglich" +
      " (im offenen Warenkorb normal erfassen)."
    );
  }
  const partNumber = normalizePartNumber(input.part_number);
  if (!partNumber) throw new BadRequestError("Die Bestellnummer ist erforderlich.");
  const qty = positiveInt(input.qty, "Die Menge");
  const price = parsePrice(input.price_unit);
  const group = resolveGroup(app, input.group);

  const existing = app.findRecordsByFilter("order_items", "order = {:order}", "", 0, 0, { order: order.id })
    .find((it) => normalizePartNumber(it.getString("part_number")) === partNumber);
  if (existing) {
    throw new BadRequestError(
      "Die Bestellnummer " + partNumber + " steht schon in dieser Bestellung – bitte dort die Menge anpassen."
    );
  }

  const allocations = [{ groupId: group ? group.id : null, groupName: group ? group.getString("name") : NO_GROUP_LABEL, qty: qty }];
  const item = new Record(app.findCollectionByNameOrId("order_items"));
  item.set("order", order.id);
  item.set("part_number", partNumber);
  item.set("name", String(input.name || "").trim());
  item.set("url", String(input.url || "").trim());
  item.set("qty_ordered", qty);
  item.set("qty_delivered", 0);
  item.set("qty_cancelled", 0);
  if (price !== null) item.set("price_unit", price);
  if (group) item.set("groups", [group.id]);
  item.set("group_allocations", allocations);
  item.set("group_allocation_note", allocationNote(allocations));
  if (userId) item.set("added_later_by", userId);
  item.set("added_later_at", new DateTime());
  app.save(item);
  return item;
}

module.exports = { addLateItem };
