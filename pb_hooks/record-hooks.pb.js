// Record-Hooks: Normalisierung, Validierung und Auto-Lieferstatus.

/**
 * Bestellungen: interne Bestellnummer normalisieren und prüfen.
 * Pflicht wird beim Schritt angefragt → bestellt geprüft (lib/status.js); eine einmal
 * gesetzte Nummer kann außerhalb des offenen Korbs korrigiert, aber nicht mehr geleert werden.
 */
onRecordValidate((e) => {
  const { INTERNAL_ORDER_NO_RE, normalizeInternalOrderNo } = require(`${__hooks}/lib/util.js`);
  const order = e.record;
  const no = normalizeInternalOrderNo(order.getString("internal_order_no"));
  order.set("internal_order_no", no);
  if (no) {
    if (!INTERNAL_ORDER_NO_RE.test(no)) {
      throw new BadRequestError("Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).");
    }
    let duplicate = null;
    try {
      duplicate = e.app.findFirstRecordByFilter("orders", "internal_order_no = {:no} && id != {:id}", { no: no, id: order.id });
    } catch (_) { /* keine Dublette */ }
    if (duplicate) {
      throw new BadRequestError("Die interne Bestellnummer " + no + " ist bereits einer anderen Bestellung zugeordnet.");
    }
  } else if (!order.isNew() && order.original().getString("internal_order_no") && order.getString("status") !== "angefragt") {
    throw new BadRequestError("Die interne Bestellnummer kann nach der Bestellung nicht mehr entfernt werden.");
  }
  e.next();
}, "orders");

/** Positionen: Bestellnummer normalisieren, Storno-Menge prüfen. */
onRecordValidate((e) => {
  const { normalizePartNumber } = require(`${__hooks}/lib/util.js`);
  const item = e.record;
  item.set("part_number", normalizePartNumber(item.getString("part_number")));

  const ordered = item.getInt("qty_ordered");
  const delivered = item.getInt("qty_delivered");
  const cancelled = item.getInt("qty_cancelled");
  const maxCancel = Math.max(0, ordered - delivered);
  if (cancelled > maxCancel) {
    throw new BadRequestError(
      "Storniert werden können höchstens " + maxCancel + " Stück (bestellt − geliefert)."
    );
  }
  e.next();
}, "order_items");

/** Nach Änderung oder Löschung einer Position den Lieferstatus der Bestellung neu berechnen. */
onRecordAfterUpdateSuccess((e) => {
  const { recalculateOrderStatus } = require(`${__hooks}/lib/status.js`);
  e.next();
  try {
    recalculateOrderStatus(e.app, e.record.getString("order"));
  } catch (err) {
    e.app.logger().debug("recalculateOrderStatus übersprungen", "error", String(err));
  }
}, "order_items");

onRecordAfterDeleteSuccess((e) => {
  const { recalculateOrderStatus } = require(`${__hooks}/lib/status.js`);
  e.next();
  try {
    recalculateOrderStatus(e.app, e.record.getString("order"));
  } catch (err) {
    e.app.logger().debug("recalculateOrderStatus übersprungen", "error", String(err));
  }
}, "order_items");
