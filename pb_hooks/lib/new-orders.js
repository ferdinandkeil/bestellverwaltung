// Bestellungen direkt anlegen, ohne Sammel-Warenkorb (ARCHITECTURE.md Kap. 4.6 und 4.7):
//   – aus einem Lieferschein (delivery-notes.js, Herkunft „lieferschein“)
//   – von Hand übernommen (createManualOrder, Herkunft „manuell“, „+ Neue Bestellung“ auf der Startseite)
// Gemeinsam: Lieferant, interne Bestellnummer und Positionen prüfen, Bestellung und Positionen anlegen.
// Muss innerhalb einer Transaktion aufgerufen werden.

const { SUPPLIERS, normalizePartNumber, normalizeShopName, normalizeInternalOrderNo, positiveInt, truthy } =
  require(`${__hooks}/lib/util.js`);
const { allocationNote, resolveGroup, NO_GROUP_LABEL } = require(`${__hooks}/lib/cart.js`);
const { bookRest } = require(`${__hooks}/lib/deliveries.js`);
const { ORDER_TRACK, recalculateOrderStatus } = require(`${__hooks}/lib/status.js`);

const MAX_ITEMS = 200;

/**
 * Kopfdaten prüfen: Lieferant (bei „sonstige“ mit Shop-Name) und interne Bestellnummer – angeben oder
 * ausdrücklich darauf verzichten (Muster, Direktkauf).
 * → { supplier, shopName, internalNo, without }
 */
function parseOrderHead(body) {
  const supplier = String(body.supplier || "");
  if (SUPPLIERS.indexOf(supplier) === -1) throw new BadRequestError("Unbekannter Lieferant: " + supplier);
  const shopName = supplier === "other" ? normalizeShopName(body.supplier_custom_name) : "";
  if (supplier === "other" && !shopName) {
    throw new BadRequestError("Bei „Sonstiger Lieferant“ ist der Shop-Name erforderlich.");
  }
  const internalNo = normalizeInternalOrderNo(body.internal_order_no);
  const without = truthy(body.without_internal_order_no);
  if (!internalNo && !without) {
    throw new BadRequestError("Bitte die interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen.");
  }
  if (internalNo && without) {
    throw new BadRequestError("Entweder eine interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen – nicht beides.");
  }
  return { supplier: supplier, shopName: shopName, internalNo: internalNo, without: without };
}

/**
 * Positionen prüfen und zusammenfassen: gleiche Bestellnummer → eine Position, Gruppenanteile addiert.
 * items: [{ part_number, name?, qty, group? }] → [{ part, name, qty, allocations, groups }]
 */
function collectItems(app, items) {
  if (!Array.isArray(items) || !items.length) throw new BadRequestError("Mindestens eine Position angeben.");
  if (items.length > MAX_ITEMS) throw new BadRequestError("Höchstens " + MAX_ITEMS + " Positionen.");
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
  return entries;
}

/**
 * Bestellung mit ihren Positionen anlegen (Phase vorläufig; der Aufrufer legt die Schritte an und leitet die
 * Phase danach ab). → { order, items: [Record] }
 */
function saveOrder(app, head, entries, fields, userId) {
  const order = new Record(app.findCollectionByNameOrId("orders"));
  order.set("supplier", head.supplier);
  order.set("supplier_custom_name", head.shopName);
  order.set("status", fields.status);
  order.set("origin", fields.origin);
  order.set("internal_order_no", head.internalNo);
  order.set("without_internal_order_no", head.without);
  order.set("supplier_order_no", String(fields.supplier_order_no || "").trim());
  if (fields.subject) order.set("subject", String(fields.subject).trim());
  order.set("custom_fields", {});
  if (userId) order.set("created_by", userId);
  app.save(order); // Format und Eindeutigkeit der internen Nummer prüft der Validierungs-Hook

  const itemCol = app.findCollectionByNameOrId("order_items");
  const items = entries.map((entry) => {
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
    return item;
  });
  return { order: order, items: items };
}

/** Stände, die beim Übernehmen von Hand gewählt werden können (Reihenfolge = Ablauf). */
const MANUAL_STAGES = ["form_written", "form_signed", "form_submitted", "approval", "ordered", "delivered"];

/**
 * Bestellung von Hand übernehmen (Herkunft „manuell“), z. B. außerhalb des Systems bestellt.
 * body: { supplier, supplier_custom_name?, internal_order_no? | without_internal_order_no: true, supplier_order_no?,
 *         subject?, stage, items: [{ part_number, name?, qty, group? }] }
 * stage: bis zu welchem Schritt der Ablauf erledigt ist. Alle Schritte der Bestell-Spur bis dahin werden ohne
 * Datum und Nutzer angelegt (übernommen); die Freigabe nur, wenn sie selbst der gewählte Stand ist (wie bei
 * Altbestellungen und Bestellungen aus Lieferschein). „delivered“ = bestellt und alle Positionen geliefert
 * (eine Lieferung ohne Beleg). Ohne interne Bestellnummer erst ab „bestellt“ (kein Formular).
 * Ein offener Warenkorb des Lieferanten bleibt unberührt. → { order, status }
 */
function createManualOrder(app, body, userId) {
  const stage = String(body.stage || "");
  if (MANUAL_STAGES.indexOf(stage) === -1) throw new BadRequestError("Bitte den Stand der Bestellung wählen.");
  const head = parseOrderHead(body);
  const ordered = stage === "ordered" || stage === "delivered";
  if (head.without && !ordered) {
    throw new BadRequestError("Ohne interne Bestellnummer gibt es kein Formular – Stand „Bestellt“ oder „Geliefert“ wählen.");
  }
  const entries = collectItems(app, body.items);
  const { order } = saveOrder(app, head, entries, {
    status: ordered ? "bestellt" : "freigabe", origin: "manuell", supplier_order_no: body.supplier_order_no, subject: body.subject,
  }, userId);

  const last = ordered ? "ordered" : stage;
  const stepCol = app.findCollectionByNameOrId("order_steps");
  for (const step of ORDER_TRACK.slice(0, ORDER_TRACK.indexOf(last) + 1)) {
    if (head.without && step !== "ordered") continue; // kein Formular
    if (step === "approval" && last !== "approval") continue;
    const r = new Record(stepCol);
    r.set("order", order.id);
    r.set("step", step);
    app.save(r); // ohne Datum und Nutzer: übernommen
  }

  if (stage === "delivered") bookRest(app, order.id, userId);
  const status = recalculateOrderStatus(app, order.id);
  return { order: app.findRecordById("orders", order.id), status: status };
}

module.exports = { parseOrderHead, collectItems, saveOrder, createManualOrder, MANUAL_STAGES };
