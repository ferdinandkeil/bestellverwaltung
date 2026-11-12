// Eigene API-Routen für die Labor-Geschäftslogik (ARCHITECTURE.md Kap. 4).
// Jede Route läuft vollständig in einer DB-Transaktion.
// Hinweis: In PocketBase-Hooks hat jeder Handler einen eigenen Kontext,
// daher werden die Bibliotheken innerhalb der Handler per require() geladen.

/**
 * POST /api/lab/cart-items
 * Body: { supplier, supplier_custom_name?, part_number, name, qty, group?, url?, price_unit? }
 * Antwort: { order, item, merged }
 */
routerAdd("POST", "/api/lab/cart-items", (e) => {
  const { addItemToSupplierCart } = require(`${__hooks}/lib/cart.js`);
  const body = e.requestInfo().body || {};
  let result;
  $app.runInTransaction((txApp) => {
    result = addItemToSupplierCart(txApp, body, e.auth.id);
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/cart-items/batch   (Moodle-Import)
 * Body: { groups: [{ ref, name, course, semester }], items: [{ line?, supplier, …, group? | groupRef? }] }
 * Alles oder nichts: neue Gruppen und alle Positionen in einer Transaktion.
 * Antwort: { items, merged, orders, groups }
 */
routerAdd("POST", "/api/lab/cart-items/batch", (e) => {
  const { importItems } = require(`${__hooks}/lib/import.js`);
  const body = e.requestInfo().body || {};
  let result;
  $app.runInTransaction((txApp) => {
    result = importItems(txApp, body, e.auth.id);
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/orders/{id}/status
 * Body: { action: "advance" | "back", internal_order_no?, supplier_order_no? }
 *   internal_order_no ist beim Schritt angefragt → bestellt Pflicht (falls noch nicht gesetzt).
 * Antwort: order
 */
routerAdd("POST", "/api/lab/orders/{id}/status", (e) => {
  const { changeStatus } = require(`${__hooks}/lib/status.js`);
  const id = e.request.pathValue("id");
  const body = e.requestInfo().body || {};
  let order;
  $app.runInTransaction((txApp) => {
    order = changeStatus(txApp, id, String(body.action || ""), {
      internal_order_no: body.internal_order_no,
      supplier_order_no: body.supplier_order_no,
    });
  });
  return e.json(200, order);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/orders/{id}/deliveries
 * Body (JSON oder multipart/form-data):
 *   lines: [{ item, qty }]   (bei multipart als JSON-String)
 *   newItems?: [{ part_number, name?, qty, group? }] – werden nachgetragen und mit qty geliefert (JSON-String bei multipart)
 *   note?: string
 *   receipt?: eine Datei (nur multipart; Bild oder PDF, mehrseitige Belege als PDF)
 * Antwort: { delivery, status }
 */
routerAdd("POST", "/api/lab/orders/{id}/deliveries", (e) => {
  const { bookDelivery } = require(`${__hooks}/lib/deliveries.js`);
  const { addLateItem } = require(`${__hooks}/lib/late-items.js`);
  const id = e.request.pathValue("id");
  const body = e.requestInfo().body || {};

  const parseJSON = (value, field, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      throw new BadRequestError("„" + field + "“ ist kein gültiges JSON.");
    }
  };
  let lines = parseJSON(body.lines, "lines", []);
  const newItems = parseJSON(body.newItems, "newItems", []);
  if (!Array.isArray(lines) || !Array.isArray(newItems)) {
    throw new BadRequestError("„lines“ und „newItems“ müssen Listen sein.");
  }

  let receipts = [];
  const contentType = String(e.request.header.get("Content-Type") || "");
  if (contentType.indexOf("multipart/form-data") === 0) {
    receipts = Array.from(e.findUploadedFiles("receipt") || []);
  }

  let result;
  $app.runInTransaction((txApp) => {
    // nachgetragene Positionen (Lieferschein enthält Ware, die beim Erfassen vergessen wurde)
    const added = newItems.map((n) => addLateItem(txApp, id, n || {}, e.auth.id));
    const allLines = lines.concat(added.map((item, i) => ({ item: item.id, qty: newItems[i].qty })));
    result = bookDelivery(txApp, id, allLines, body.note, receipts, e.auth.id);
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/orders/{id}/items   – Position nachtragen (Bestellung ab „bestellt“)
 * Body: { part_number, name?, qty, group?, url?, price_unit? }
 * Antwort: { item, status }
 */
routerAdd("POST", "/api/lab/orders/{id}/items", (e) => {
  const { addLateItem } = require(`${__hooks}/lib/late-items.js`);
  const { recalculateOrderStatus } = require(`${__hooks}/lib/status.js`);
  const id = e.request.pathValue("id");
  const body = e.requestInfo().body || {};
  let result;
  $app.runInTransaction((txApp) => {
    const item = addLateItem(txApp, id, body, e.auth.id);
    result = { item: item, status: recalculateOrderStatus(txApp, id) };
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/orders/from-delivery-note   – Bestellung aus einem Lieferschein anlegen (Herkunft „lieferschein“)
 * Body (JSON oder multipart/form-data):
 *   supplier, supplier_custom_name?, internal_order_no? | without_internal_order_no: true,
 *   supplier_order_no?, note?, items: [{ part_number, name?, qty, group? }] (bei multipart als JSON-String),
 *   receipt?: eine Datei (Lieferschein als PDF)
 * Legt Bestellung (bestellt), Positionen und Lieferung in einer Transaktion an → Status „geliefert“.
 * Antwort: { order, delivery, status }
 */
routerAdd("POST", "/api/lab/orders/from-delivery-note", (e) => {
  const { createOrderFromDeliveryNote } = require(`${__hooks}/lib/delivery-notes.js`);
  const body = e.requestInfo().body || {};
  let items = body.items;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch (_) {
      throw new BadRequestError("„items“ ist kein gültiges JSON.");
    }
  }
  let receipts = [];
  if (String(e.request.header.get("Content-Type") || "").indexOf("multipart/form-data") === 0) {
    try {
      receipts = Array.from(e.findUploadedFiles("receipt") || []);
    } catch (_) {
      receipts = [];
    }
  }
  let result;
  $app.runInTransaction((txApp) => {
    result = createOrderFromDeliveryNote(txApp, body, items, receipts, e.auth.id);
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));

/**
 * POST /api/lab/unmatched-receipts/{id}/assign   – abgelegten Lieferschein einer Bestellung zuordnen
 * Body: { order }
 * Der Beleg wird Anhang der Bestellung, der Eintrag in der Ablage wird gelöscht.
 * Antwort: order
 */
routerAdd("POST", "/api/lab/unmatched-receipts/{id}/assign", (e) => {
  const { assignUnmatchedReceipt } = require(`${__hooks}/lib/delivery-notes.js`);
  const id = e.request.pathValue("id");
  const body = e.requestInfo().body || {};
  let order;
  $app.runInTransaction((txApp) => {
    order = assignUnmatchedReceipt(txApp, id, body.order);
  });
  return e.json(200, order);
}, $apis.requireAuth("users"));
