// Datenmigration (ARCHITECTURE.md Kap. 4.1, 11/2026): TME und Würth Elektronik sind feste Lieferanten.
//
// 1. Bestellungen mit „Sonstiger Lieferant“ und Shop-Namen „TME …“ bzw. „Würth …“/„Wuerth …“/„WE …“
//    werden auf supplier = tme / wuerth umgestellt (Shop-Name danach leer).
//    Ausnahme: Ein offener Warenkorb wird nicht umgestellt, wenn der Lieferant schon einen offenen Korb hat
//    (z. B. „TME“ und „tme.eu“ gleichzeitig offen). Er bleibt „sonstige“ und wird im Log gemeldet;
//    die Positionen werden dann von Hand übertragen. So kann die Migration den Start nie blockieren.
// 2. Bestellungen „aus Lieferschein“, die bewusst ohne interne Bestellnummer angelegt wurden,
//    bekommen without_internal_order_no = true (vorher nicht gespeichert).
//
// Voraussetzung: pb_schema.json ist importiert (Werte „tme“/„wuerth“, Feld without_internal_order_no).
// Auf einer frischen Installation (noch keine Collection „orders“) gibt es nichts umzustellen.
// Ergebnis steht im Admin-UI unter Logs (Meldungen „Migration Lieferanten …“).

const SHOPS = [
  { supplier: "tme", label: "TME", pattern: /^\s*tme\b/i },
  { supplier: "wuerth", label: "Würth Elektronik", pattern: /^\s*(w(ü|ue|u)rth|we\b)/i },
];

migrate((app) => {
  let orders;
  try {
    orders = app.findCollectionByNameOrId("orders");
  } catch (_) {
    return; // frische Installation: das Schema wird erst danach importiert
  }
  const supplierField = orders.fields.getByName("supplier");
  if (!supplierField || supplierField.values.indexOf("wuerth") === -1 || !orders.fields.getByName("without_internal_order_no")) {
    throw new Error("Migration Lieferanten: zuerst pb_schema.json importieren (Lieferanten „tme“/„wuerth“ " +
      "bzw. Feld „without_internal_order_no“ fehlen), dann neu starten.");
  }

  const log = app.logger();

  // Lieferanten, die schon einen offenen Warenkorb haben
  const openCart = {};
  for (const shop of SHOPS) {
    openCart[shop.supplier] = app.findRecordsByFilter("orders",
      "supplier = {:s} && status = 'angefragt'", "", 1, 0, { s: shop.supplier }).length > 0;
  }

  let moved = 0;
  const others = app.findRecordsByFilter("orders", "supplier = 'other'", "created", 0, 0);
  for (const order of others) {
    const name = order.getString("supplier_custom_name");
    const shop = SHOPS.find((s) => s.pattern.test(name));
    if (!shop) continue;
    const isOpen = order.getString("status") === "angefragt";
    if (isOpen && openCart[shop.supplier]) {
      log.warn("Migration Lieferanten: offener Warenkorb bleibt „Sonstiger Lieferant“, weil " + shop.label +
        " schon einen offenen Warenkorb hat – Positionen bitte von Hand übertragen.",
        "order", order.id, "supplier_custom_name", name);
      continue;
    }
    order.set("supplier", shop.supplier);
    order.set("supplier_custom_name", "");
    app.save(order);
    if (isOpen) openCart[shop.supplier] = true;
    moved++;
    log.info("Migration Lieferanten: Bestellung umgestellt", "order", order.id,
      "supplier_custom_name", name, "supplier", shop.supplier);
  }

  const withoutNo = app.findRecordsByFilter("orders",
    "origin = 'lieferschein' && internal_order_no = '' && without_internal_order_no = false", "", 0, 0);
  for (const order of withoutNo) {
    order.set("without_internal_order_no", true);
    app.save(order);
  }

  log.info("Migration Lieferanten abgeschlossen", "umgestellt", moved, "ohne_interne_nummer", withoutNo.length);
}, (app) => {
  // Zurück: feste Lieferanten wieder als „sonstige“ mit Shop-Namen
  let orders;
  try {
    orders = app.findCollectionByNameOrId("orders");
  } catch (_) {
    return;
  }
  for (const shop of SHOPS) {
    for (const order of app.findRecordsByFilter("orders", "supplier = {:s}", "", 0, 0, { s: shop.supplier })) {
      order.set("supplier", "other");
      order.set("supplier_custom_name", shop.label);
      app.save(order);
    }
  }
});
