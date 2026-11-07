// Sammel-Warenkorb pro Lieferant (ARCHITECTURE.md Kap. 4.2).

const {
  SUPPLIERS, normalizePartNumber, normalizeShopName, readJSON, positiveInt,
} = require(`${__hooks}/lib/util.js`);

const NO_GROUP_LABEL = "ohne Gruppe";

/** Offenen Korb für Lieferant (bei `other`: je Shop-Name, case-insensitive) suchen oder anlegen. */
function findOrCreateOpenCart(app, supplier, shopName, userId) {
  const carts = app.findRecordsByFilter(
    "orders", "supplier = {:supplier} && status = 'angefragt'", "created", 0, 0,
    { supplier: supplier }
  );
  const wanted = shopName.toLowerCase();
  const existing = carts.find((c) => c.getString("supplier_custom_name").toLowerCase() === wanted);
  if (existing) return existing;

  const order = new Record(app.findCollectionByNameOrId("orders"));
  order.set("supplier", supplier);
  order.set("supplier_custom_name", shopName);
  order.set("status", "angefragt");
  order.set("custom_fields", {});
  if (userId) order.set("created_by", userId);
  app.save(order);
  return order;
}

function allocationNote(allocations) {
  return allocations.map((a) => a.groupName + ": " + a.qty + "x").join(" | ");
}

/**
 * Position in den offenen Sammelkorb buchen bzw. mit vorhandener Position zusammenführen.
 * Muss innerhalb einer Transaktion aufgerufen werden.
 *
 * input: { supplier, supplier_custom_name?, part_number, name, qty, group?, url?, price_unit? }
 */
function addItemToSupplierCart(app, input, userId) {
  const supplier = String(input.supplier || "");
  if (SUPPLIERS.indexOf(supplier) === -1) {
    throw new BadRequestError("Unbekannter Lieferant: " + supplier);
  }
  const shopName = supplier === "other" ? normalizeShopName(input.supplier_custom_name) : "";
  if (supplier === "other" && !shopName) {
    throw new BadRequestError("Bei „Sonstiger Lieferant“ ist der Shop-Name erforderlich.");
  }
  const partNumber = normalizePartNumber(input.part_number);
  if (!partNumber) throw new BadRequestError("Die Bestellnummer ist erforderlich.");
  const name = String(input.name || "").trim();
  const qty = positiveInt(input.qty, "Die Menge");
  const url = String(input.url || "").trim();
  const price = input.price_unit === undefined || input.price_unit === null || input.price_unit === ""
    ? null : Number(input.price_unit);
  if (price !== null && (!isFinite(price) || price < 0)) {
    throw new BadRequestError("Der Stückpreis muss eine Zahl ≥ 0 sein.");
  }

  let group = null;
  if (input.group) {
    try {
      group = app.findRecordById("groups", String(input.group));
    } catch (_) {
      throw new BadRequestError("Unbekannte Gruppe: " + input.group);
    }
  }
  const allocKey = group ? group.id : null;
  const allocName = group ? group.getString("name") : NO_GROUP_LABEL;

  const order = findOrCreateOpenCart(app, supplier, shopName, userId);
  const items = app.findRecordsByFilter("order_items", "order = {:order}", "", 0, 0, { order: order.id });
  let item = items.find((it) => normalizePartNumber(it.getString("part_number")) === partNumber);
  const merged = !!item;

  if (!item) {
    if (!name) throw new BadRequestError("Die Bezeichnung ist erforderlich.");
    item = new Record(app.findCollectionByNameOrId("order_items"));
    item.set("order", order.id);
    item.set("part_number", partNumber);
    item.set("name", name);
    item.set("qty_ordered", 0);
    item.set("qty_delivered", 0);
    item.set("qty_cancelled", 0);
  }

  item.set("qty_ordered", item.getInt("qty_ordered") + qty);
  if (!item.getString("name") && name) item.set("name", name);
  if (!item.getString("url") && url) item.set("url", url);
  if (price !== null && !item.getFloat("price_unit")) item.set("price_unit", price);

  if (group) {
    const groups = Array.from(item.getStringSlice("groups"));
    if (groups.indexOf(group.id) === -1) groups.push(group.id);
    item.set("groups", groups);
  }

  const allocations = readJSON(item, "group_allocations", []);
  const entry = allocations.find((a) => (a.groupId || null) === allocKey);
  if (entry) {
    entry.qty += qty;
  } else {
    allocations.push({ groupId: allocKey, groupName: allocName, qty: qty });
  }
  item.set("group_allocations", allocations);
  item.set("group_allocation_note", allocationNote(allocations));

  app.save(item);
  return { order: order, item: item, merged: merged };
}

module.exports = { addItemToSupplierCart };
