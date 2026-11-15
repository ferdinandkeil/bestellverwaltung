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
  // „ohne interne Bestellnummer“ gilt nur, solange keine Nummer eingetragen ist
  if (no) order.set("without_internal_order_no", false);
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

/** Favoritenlisten: Titel trimmen, Lieferant/Shop-Name prüfen (ARCHITECTURE.md Kap. 4.7). */
onRecordValidate((e) => {
  const { normalizeListSupplier } = require(`${__hooks}/lib/favorites.js`);
  const list = e.record;
  list.set("title", list.getString("title").trim());
  list.set("description", list.getString("description").trim());
  normalizeListSupplier(list);
  e.next();
}, "favorite_lists");

/**
 * Favoriten-Artikel: Bestellnummer normalisieren, je Liste eindeutig (verständliche Meldung statt Index-Fehler).
 * Preisstand: ohne Preis leer; wird der Preis ohne neuen Stand geändert (von Hand), gilt „jetzt“.
 */
onRecordValidate((e) => {
  const { normalizePartNumber } = require(`${__hooks}/lib/util.js`);
  const fav = e.record;
  const part = normalizePartNumber(fav.getString("part_number"));
  fav.set("part_number", part);
  fav.set("name", fav.getString("name").trim());

  let duplicate = null;
  try {
    duplicate = e.app.findFirstRecordByFilter("favorite_items", "list = {:list} && part_number = {:part} && id != {:id}",
      { list: fav.getString("list"), part: part, id: fav.id });
  } catch (_) { /* keine Dublette */ }
  if (duplicate) throw new BadRequestError("Die Bestellnummer " + part + " steht schon in dieser Liste.");

  const price = fav.getFloat("price_unit");
  if (!(price > 0)) {
    fav.set("price_date", "");
  } else if (fav.isNew()) {
    if (fav.getDateTime("price_date").isZero()) fav.set("price_date", new DateTime());
  } else {
    const before = fav.original();
    const priceChanged = before.getFloat("price_unit") !== price;
    const dateUnchanged = before.getDateTime("price_date").string() === fav.getDateTime("price_date").string();
    if (priceChanged && dateUnchanged) fav.set("price_date", new DateTime());
  }
  e.next();
}, "favorite_items");
