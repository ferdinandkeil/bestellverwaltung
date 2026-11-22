// Datenmigration (ARCHITECTURE.md Kap. 4.3, 11/2026): Verwaltungsschritte statt „geprüft“/„abgerechnet“.
//
// Für jede Bestellung, die nicht mehr im Warenkorb ist:
// 1. Schritte bis zum aktuellen Stand als erledigt **ohne Datum und Nutzer** anlegen (das echte Datum ist
//    nicht bekannt): „bestellt“ und – mit interner Bestellnummer – die drei Formularschritte.
//    Die Freigabe wird nicht angelegt (meist nicht nötig; erscheint damit übersprungen).
// 2. Phase aus den Lieferungen neu ableiten. „geprueft“/„abgerechnet“ entfallen und werden auf den
//    Lieferstand zurückgesetzt; Rechnungsschritte trägt der Nutzer von Hand nach.
// 3. `delivered_at` bei vollständig gelieferten Bestellungen aus der letzten Lieferbuchung.
// Bestellungen, die schon Schritte haben, bleiben unverändert (erneuter Lauf ändert nichts).
//
// Voraussetzung: pb_schema.json ist importiert (Collection „order_steps“, Phase „freigabe“).
// Auf einer frischen Installation (noch keine Collection „orders“) gibt es nichts umzustellen.
// Die Logik ist bewusst eigenständig (Stand 11/2026) und hängt nicht von pb_hooks/lib ab.

migrate((app) => {
  let orders;
  try {
    orders = app.findCollectionByNameOrId("orders");
  } catch (_) {
    return; // frische Installation: das Schema wird erst danach importiert
  }
  let stepsCol;
  try {
    stepsCol = app.findCollectionByNameOrId("order_steps");
  } catch (_) {
    stepsCol = null;
  }
  const statusField = orders.fields.getByName("status");
  if (!stepsCol || !statusField || statusField.values.indexOf("freigabe") === -1 || !orders.fields.getByName("delivered_at")) {
    throw new Error("Migration Verwaltungsschritte: zuerst pb_schema.json importieren (Collection „order_steps“, " +
      "Phase „freigabe“ bzw. Feld „delivered_at“ fehlen), dann neu starten.");
  }

  const log = app.logger();
  const addStep = (orderId, step) => {
    const r = new Record(stepsCol);
    r.set("order", orderId);
    r.set("step", step);
    app.save(r);
  };
  const deliveryStatus = (items) => {
    if (!items.length) return "bestellt";
    let allDone = true;
    let anyDelivered = false;
    for (const it of items) {
      if (it.getInt("qty_delivered") > 0) anyDelivered = true;
      if (it.getInt("qty_delivered") + it.getInt("qty_cancelled") < it.getInt("qty_ordered")) allDone = false;
    }
    if (allDone) return "geliefert";
    return anyDelivered ? "teilgeliefert" : "bestellt";
  };

  let migrated = 0;
  let reset = 0;
  for (const order of app.findRecordsByFilter("orders", "status != 'angefragt'", "created", 0, 0)) {
    if (app.findRecordsByFilter("order_steps", "order = {:id}", "", 1, 0, { id: order.id }).length) continue;

    if (order.getString("internal_order_no")) {
      for (const step of ["form_written", "form_signed", "form_submitted"]) addStep(order.id, step);
    }
    addStep(order.id, "ordered");

    const old = order.getString("status");
    const items = app.findRecordsByFilter("order_items", "order = {:id}", "", 0, 0, { id: order.id });
    const next = deliveryStatus(items);
    order.set("status", next);
    if (next === "geliefert") {
      const last = app.findRecordsByFilter("deliveries", "order = {:id}", "-created", 1, 0, { id: order.id });
      order.set("delivered_at", last.length ? last[0].getDateTime("created") : order.getDateTime("updated"));
    } else {
      order.set("delivered_at", "");
    }
    app.save(order);
    migrated++;
    if (old === "geprueft" || old === "abgerechnet") {
      reset++;
      log.warn("Migration Verwaltungsschritte: „" + old + "“ auf Lieferstand zurückgesetzt – Rechnungsschritte bitte von Hand nachtragen.",
        "order", order.id, "internal_order_no", order.getString("internal_order_no"), "status", next);
    }
  }

  log.info("Migration Verwaltungsschritte abgeschlossen", "bestellungen", migrated, "zurueckgesetzt", reset);
}, (app) => {
  // Nicht umkehrbar: „geprueft“/„abgerechnet“ gibt es im Schema nicht mehr, die alten Werte sind nicht gespeichert.
  // Die angelegten Schritte bleiben; ein Zurückspielen des alten Schemas erfordert ein Backup.
});
