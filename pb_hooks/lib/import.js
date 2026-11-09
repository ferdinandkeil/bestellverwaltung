// Sammel-Import mehrerer Positionen (Moodle-Import, ARCHITECTURE.md Kap. 6) – alles oder nichts.
// Muss innerhalb einer Transaktion aufgerufen werden: ein Fehler rollt Gruppen und Positionen zurück.

const { addItemToSupplierCart } = require(`${__hooks}/lib/cart.js`);

const MAX_ITEMS = 500;
const MAX_GROUPS = 100;

/** Lesbarer Text eines Fehlers (eigene BadRequestError oder Validierungsfehler von PocketBase). */
function errorText(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  return String(err).replace(/^Error:\s*/, "");
}

/**
 * body: {
 *   groups: [{ ref, name, course, semester }]               – neu anzulegende Gruppen
 *   items:  [{ line?, supplier, supplier_custom_name?, part_number, name?, qty, url?,
 *              group?: <id bestehender Gruppe>, groupRef?: <ref einer neuen Gruppe> }]
 * }
 * → { items: n, merged: m, orders: k, groups: g }
 */
function importItems(app, body, userId) {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new BadRequestError("Keine Positionen zum Importieren.");
  if (items.length > MAX_ITEMS) throw new BadRequestError("Höchstens " + MAX_ITEMS + " Positionen je Import.");
  if (groups.length > MAX_GROUPS) throw new BadRequestError("Höchstens " + MAX_GROUPS + " neue Gruppen je Import.");

  const collection = app.findCollectionByNameOrId("groups");
  const refToId = {};
  for (const g of groups) {
    const ref = String(g.ref || "");
    if (!ref || refToId[ref]) throw new BadRequestError("Ungültige Gruppen-Referenz.");
    const record = new Record(collection);
    record.set("name", String(g.name || "").trim());
    record.set("course", String(g.course || "").trim());
    record.set("semester", String(g.semester || "").trim());
    record.set("is_active", true);
    try {
      app.save(record);
    } catch (err) {
      const text = errorText(err);
      throw new BadRequestError("Gruppe „" + record.getString("name") + "“ konnte nicht angelegt werden: " +
        (/unique/i.test(text) ? "existiert bereits in dieser Veranstaltung." : text));
    }
    refToId[ref] = record.id;
  }

  const orders = {};
  let merged = 0;
  items.forEach((input, i) => {
    const line = input.line || i + 1;
    let group = input.group || "";
    if (input.groupRef) {
      group = refToId[String(input.groupRef)];
      if (!group) throw new BadRequestError("Zeile " + line + ": unbekannte neue Gruppe.");
    }
    let result;
    try {
      result = addItemToSupplierCart(app, {
        supplier: input.supplier,
        supplier_custom_name: input.supplier_custom_name,
        part_number: input.part_number,
        name: input.name,
        qty: input.qty,
        url: input.url,
        group: group,
      }, userId);
    } catch (err) {
      throw new BadRequestError("Zeile " + line + ": " + errorText(err));
    }
    orders[result.order.id] = true;
    if (result.merged) merged++;
  });

  return { items: items.length, merged: merged, orders: Object.keys(orders).length, groups: groups.length };
}

module.exports = { importItems };
