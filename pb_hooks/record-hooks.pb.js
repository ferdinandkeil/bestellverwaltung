// Record-Hooks: Normalisierung, Validierung und Auto-Lieferstatus.

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
