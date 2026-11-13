// Status-Workflow & automatischer Lieferstatus (ARCHITECTURE.md Kap. 4.3).

const { STATUSES, AUTO_STATUSES, normalizeInternalOrderNo, truthy } = require(`${__hooks}/lib/util.js`);

/**
 * Lieferstatus aus den Positionen ableiten.
 * Erledigt = qty_delivered + qty_cancelled >= qty_ordered.
 */
function deliveryStatusOf(items) {
  let allDone = true;
  let anyDelivered = false;
  for (const it of items) {
    const ordered = it.getInt("qty_ordered");
    const delivered = it.getInt("qty_delivered");
    const cancelled = it.getInt("qty_cancelled");
    if (delivered > 0) anyDelivered = true;
    if (delivered + cancelled < ordered) allDone = false;
  }
  if (allDone) return "geliefert";
  return anyDelivered ? "teilgeliefert" : "bestellt";
}

function itemsOf(app, orderId) {
  return app.findRecordsByFilter("order_items", "order = {:order}", "", 0, 0, { order: orderId });
}

/**
 * Berechnet den Lieferstatus einer Bestellung neu, sofern sie sich in einem
 * automatisch geführten Status befindet. Gibt den (ggf. neuen) Status zurück.
 */
function recalculateOrderStatus(app, orderId) {
  const order = app.findRecordById("orders", orderId);
  const current = order.getString("status");
  if (AUTO_STATUSES.indexOf(current) === -1) return current;

  const items = itemsOf(app, orderId);
  if (items.length === 0) return current;

  const next = deliveryStatusOf(items);
  if (next !== current) {
    order.set("status", next);
    app.save(order);
  }
  return next;
}

/** Gibt es neben `exceptId` bereits einen offenen Korb für denselben Lieferanten/Shop? */
function otherOpenCartExists(app, order) {
  const supplier = order.getString("supplier");
  const shop = order.getString("supplier_custom_name").toLowerCase();
  const carts = app.findRecordsByFilter(
    "orders",
    "supplier = {:supplier} && status = 'angefragt' && id != {:id}",
    "", 0, 0,
    { supplier: supplier, id: order.id }
  );
  return carts.some((c) => c.getString("supplier_custom_name").toLowerCase() === shop);
}

/**
 * Manueller Statusschritt.
 * action "advance": angefragt→bestellt, geliefert→geprueft, geprueft→abgerechnet
 * action "back":    bestellt→angefragt, geprueft→(Lieferstatus), abgerechnet→geprueft
 */
function changeStatus(app, orderId, action, numbers) {
  numbers = numbers || {};
  const order = app.findRecordById("orders", orderId);
  const current = order.getString("status");
  let next;

  if (action === "advance") {
    if (current === "angefragt") {
      if (itemsOf(app, orderId).length === 0) {
        throw new BadRequestError("Ein leerer Warenkorb kann nicht bestellt werden.");
      }
      next = "bestellt";
      // Interne Bestellnummer angeben oder ausdrücklich darauf verzichten (z. B. Muster)
      const givenNo = normalizeInternalOrderNo(numbers.internal_order_no);
      const without = truthy(numbers.without_internal_order_no);
      if (givenNo && without) {
        throw new BadRequestError("Entweder eine interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen – nicht beides.");
      }
      const internalNo = givenNo || order.getString("internal_order_no");
      if (internalNo) {
        order.set("internal_order_no", internalNo); // Format und Eindeutigkeit prüft der Validierungs-Hook
      } else if (without || order.getBool("without_internal_order_no")) {
        order.set("without_internal_order_no", true);
      } else {
        throw new BadRequestError("Bitte die interne Bestellnummer angeben (Format JJJJIW#####, z. B. 2026IW01047) oder „ohne interne Bestellnummer“ wählen.");
      }
      if (numbers.supplier_order_no != null && String(numbers.supplier_order_no).trim() !== "") {
        order.set("supplier_order_no", String(numbers.supplier_order_no).trim());
      }
    } else if (current === "geliefert") {
      next = "geprueft";
    } else if (current === "geprueft") {
      next = "abgerechnet";
    } else if (current === "bestellt" || current === "teilgeliefert") {
      throw new BadRequestError("Der Lieferstatus wird automatisch aus den Lieferbuchungen bestimmt.");
    } else {
      throw new BadRequestError("Die Bestellung ist bereits abgerechnet.");
    }
  } else if (action === "back") {
    if (current === "bestellt") {
      const items = itemsOf(app, orderId);
      if (items.some((it) => it.getInt("qty_delivered") !== 0)) {
        throw new BadRequestError("Es sind bereits Lieferungen gebucht.");
      }
      if (otherOpenCartExists(app, order)) {
        throw new BadRequestError(
          "Für diesen Lieferanten gibt es bereits einen anderen offenen Warenkorb. " +
          "Ein Zurücksetzen auf „angefragt“ ist daher nicht möglich."
        );
      }
      next = "angefragt";
    } else if (current === "geprueft") {
      next = deliveryStatusOf(itemsOf(app, orderId));
    } else if (current === "abgerechnet") {
      next = "geprueft";
    } else if (current === "teilgeliefert" || current === "geliefert") {
      throw new BadRequestError(
        "Der Lieferstatus wird automatisch bestimmt. Bitte die Lieferbuchungen korrigieren."
      );
    } else {
      throw new BadRequestError("Ein offener Warenkorb hat keinen vorherigen Status.");
    }
  } else {
    throw new BadRequestError("Unbekannte Aktion: " + action);
  }

  if (STATUSES.indexOf(next) === -1) throw new Error("Ungültiger Zielstatus " + next);
  order.set("status", next);
  app.save(order);
  return order;
}

module.exports = { deliveryStatusOf, recalculateOrderStatus, changeStatus };
