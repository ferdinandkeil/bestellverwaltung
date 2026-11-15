// Favoriten (ARCHITECTURE.md Kap. 4.7): Artikel aus einer Bestellung in eine Favoritenliste übernehmen.
// Muss innerhalb einer Transaktion aufgerufen werden (alles oder nichts).

const { SUPPLIERS, normalizePartNumber, normalizeShopName, truthy } = require(`${__hooks}/lib/util.js`);

/** Lieferant/Shop-Name einer Liste prüfen und normalisieren (auch für Änderungen über die REST-API). */
function normalizeListSupplier(list) {
  const supplier = list.getString("supplier");
  if (SUPPLIERS.indexOf(supplier) === -1) throw new BadRequestError("Unbekannter Lieferant: " + supplier);
  const shopName = supplier === "other" ? normalizeShopName(list.getString("supplier_custom_name")) : "";
  if (supplier === "other" && !shopName) {
    throw new BadRequestError("Bei „Sonstiger Lieferant“ ist der Shop-Name erforderlich.");
  }
  list.set("supplier_custom_name", shopName);
}

/** Gehören Liste und Bestellung zum selben Lieferanten (bei „sonstige“: gleicher Shop-Name, Groß-/Kleinschreibung egal)? */
function sameSupplier(list, order) {
  if (list.getString("supplier") !== order.getString("supplier")) return false;
  if (list.getString("supplier") !== "other") return true;
  return list.getString("supplier_custom_name").toLowerCase() === normalizeShopName(order.getString("supplier_custom_name")).toLowerCase();
}

function findOrder(app, id) {
  try {
    return app.findRecordById("orders", String(id || ""));
  } catch (_) {
    throw new BadRequestError("Bestellung nicht gefunden.");
  }
}

function findOwnList(app, id, userId) {
  let list;
  try {
    list = app.findRecordById("favorite_lists", String(id || ""));
  } catch (_) {
    throw new BadRequestError("Favoritenliste nicht gefunden.");
  }
  if (list.getString("owner") !== userId) {
    throw new ForbiddenError("Artikel übernehmen kann nur, wem die Liste gehört.");
  }
  return list;
}

function createList(app, input, order, userId) {
  const title = String(input.title || "").trim();
  if (!title) throw new BadRequestError("Bitte einen Titel für die neue Liste angeben.");
  const list = new Record(app.findCollectionByNameOrId("favorite_lists"));
  list.set("title", title);
  list.set("description", String(input.description || "").trim());
  list.set("is_public", truthy(input.is_public));
  list.set("owner", userId);
  list.set("supplier", order.getString("supplier"));
  list.set("supplier_custom_name", order.getString("supplier_custom_name"));
  app.save(list);
  return list;
}

/**
 * body: { order, items?: [Positions-IDs] (fehlt → alle), list?: ID einer eigenen Liste | new_list?: { title, description?, is_public? } }
 * → { list, added, existing, priceUpdated }
 *
 * Standardmenge = bestellt − storniert (mindestens 1); Preis mit dem Anlagedatum der Bestellung als Stand.
 * Steht die Nummer schon in der Liste: keine Dublette; leere Bezeichnung/Link werden ergänzt, der Preis wird
 * übernommen, wenn die Bestellung nicht älter ist als der gespeicherte Stand.
 */
function addItemsFromOrder(app, body, userId) {
  const order = findOrder(app, body.order);
  const hasList = !!body.list;
  const hasNew = !!body.new_list && typeof body.new_list === "object";
  if (hasList === hasNew) throw new BadRequestError("Bitte entweder eine bestehende Liste oder eine neue Liste angeben.");

  let list;
  if (hasList) {
    list = findOwnList(app, body.list, userId);
    if (!sameSupplier(list, order)) {
      throw new BadRequestError("Die Liste gehört zu einem anderen Lieferanten als die Bestellung.");
    }
  }

  const orderItems = app.findRecordsByFilter("order_items", "order = {:order}", "created", 0, 0, { order: order.id });
  let selected = orderItems;
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items) || !body.items.length) throw new BadRequestError("Keine Positionen ausgewählt.");
    const byId = {};
    for (const it of orderItems) byId[it.id] = it;
    selected = body.items.map((id) => {
      const it = byId[String(id)];
      if (!it) throw new BadRequestError("Die Position " + id + " gehört nicht zu dieser Bestellung.");
      return it;
    });
  }
  if (!selected.length) throw new BadRequestError("Die Bestellung enthält keine Positionen.");

  if (!list) list = createList(app, body.new_list, order, userId);

  const existingByPart = {};
  for (const fav of app.findRecordsByFilter("favorite_items", "list = {:list}", "", 0, 0, { list: list.id })) {
    existingByPart[normalizePartNumber(fav.getString("part_number"))] = fav;
  }

  const orderDate = order.getDateTime("created");
  const collection = app.findCollectionByNameOrId("favorite_items");
  let added = 0;
  let existing = 0;
  let priceUpdated = 0;
  const seen = {};

  for (const it of selected) {
    const part = normalizePartNumber(it.getString("part_number"));
    if (seen[part]) continue; // gleiche Position doppelt ausgewählt
    seen[part] = true;
    const price = it.getFloat("price_unit");
    const fav = existingByPart[part];

    if (fav) {
      existing++;
      let changed = false;
      if (!fav.getString("name") && it.getString("name")) { fav.set("name", it.getString("name")); changed = true; }
      if (!fav.getString("url") && it.getString("url")) { fav.set("url", it.getString("url")); changed = true; }
      const stand = fav.getDateTime("price_date");
      if (price > 0 && (stand.isZero() || orderDate.unix() >= stand.unix()) && price !== fav.getFloat("price_unit")) {
        fav.set("price_unit", price);
        fav.set("price_date", orderDate);
        priceUpdated++;
        changed = true;
      }
      if (changed) app.save(fav);
      continue;
    }

    const rec = new Record(collection);
    rec.set("list", list.id);
    rec.set("part_number", part);
    rec.set("name", it.getString("name"));
    rec.set("url", it.getString("url"));
    rec.set("qty", Math.max(1, it.getInt("qty_ordered") - it.getInt("qty_cancelled")));
    if (price > 0) {
      rec.set("price_unit", price);
      rec.set("price_date", orderDate);
    }
    app.save(rec);
    existingByPart[part] = rec;
    added++;
  }

  return { list: list, added: added, existing: existing, priceUpdated: priceUpdated };
}

module.exports = { addItemsFromOrder, normalizeListSupplier };
