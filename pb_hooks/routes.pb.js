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
 *   note?: string
 *   receipt?: eine Datei (nur multipart; Bild oder PDF, mehrseitige Belege als PDF)
 * Antwort: { delivery, status }
 */
routerAdd("POST", "/api/lab/orders/{id}/deliveries", (e) => {
  const { bookDelivery } = require(`${__hooks}/lib/deliveries.js`);
  const id = e.request.pathValue("id");
  const body = e.requestInfo().body || {};

  let lines = body.lines;
  if (typeof lines === "string") {
    try {
      lines = JSON.parse(lines);
    } catch (_) {
      throw new BadRequestError("„lines“ ist kein gültiges JSON.");
    }
  }

  let receipts = [];
  const contentType = String(e.request.header.get("Content-Type") || "");
  if (contentType.indexOf("multipart/form-data") === 0) {
    receipts = Array.from(e.findUploadedFiles("receipt") || []);
  }

  let result;
  $app.runInTransaction((txApp) => {
    result = bookDelivery(txApp, id, lines, body.note, receipts, e.auth.id);
  });
  return e.json(200, result);
}, $apis.requireAuth("users"));
