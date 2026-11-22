// Verwaltungsschritte, abgeleitete Phase & automatischer Lieferstatus (ARCHITECTURE.md Kap. 4.3).
//
// Ein Datensatz in `order_steps` heißt „erledigt“ (done_at leer = Datum unbekannt). Es gibt kein Feld
// „übersprungen“: Fehlt ein Schritt, während ein späterer derselben Spur erledigt ist, gilt er als
// übersprungen. Deshalb erzwingt der Server keine Reihenfolge innerhalb einer Spur, nur feste Regeln.
// `orders.status` (Phase) wird nach jeder Änderung hier abgeleitet und nie direkt geschrieben.

const { normalizeInternalOrderNo, truthy } = require(`${__hooks}/lib/util.js`);

/** Spur „Bestellung“: Formular, Freigabe, bestellt. */
const ORDER_TRACK = ["form_written", "form_signed", "form_submitted", "approval", "ordered"];
/** Spur „Rechnung“ inkl. Abschluss (für Bestellungen ohne Rechnung, z. B. Muster). */
const INVOICE_TRACK = ["invoice_received", "invoice_signed", "invoice_submitted", "closed"];
const STEPS = ORDER_TRACK.concat(INVOICE_TRACK);
/** Schritte, die die interne Bestellnummer brauchen (es gibt ein Formular). */
const FORM_STEPS = ["form_written", "form_signed", "form_submitted", "approval"];

const STEP_LABELS = {
  form_written: "Formular geschrieben",
  form_signed: "Formular unterschrieben",
  form_submitted: "Formular in Verwaltung",
  approval: "Freigabe",
  ordered: "Bestellt",
  invoice_received: "Rechnung da",
  invoice_signed: "Rechnung unterschrieben",
  invoice_submitted: "Rechnung in Verwaltung",
  closed: "Abgeschlossen",
};

/** Spielraum für Zeitzonen: Ein Datum gilt erst als „Zukunft“, wenn sein Tag nirgends schon begonnen hat. */
const MAX_TZ_AHEAD_MS = 14 * 3600 * 1000;

/**
 * Lieferstatus aus den Positionen ableiten.
 * Erledigt = qty_delivered + qty_cancelled >= qty_ordered.
 */
function deliveryStatusOf(items) {
  if (!items.length) return "bestellt";
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

/** Erledigte Schritte einer Bestellung als { step: record }. */
function stepsOf(app, orderId) {
  const map = {};
  for (const r of app.findRecordsByFilter("order_steps", "order = {:order}", "", 0, 0, { order: orderId })) {
    map[r.getString("step")] = r;
  }
  return map;
}

/** Phase aus Schritten und Positionen (ARCHITECTURE.md Kap. 4.3, Tabelle „Phase“). */
function deriveStatus(steps, items) {
  if (!ORDER_TRACK.some((s) => steps[s])) return "angefragt";
  if (!steps.ordered) return "freigabe";
  const delivery = deliveryStatusOf(items);
  if (delivery === "geliefert" && (steps.invoice_submitted || steps.closed)) return "abgeschlossen";
  return delivery;
}

/** Zeitpunkt der letzten Lieferbuchung oder null. */
function lastDeliveryAt(app, orderId) {
  const rows = app.findRecordsByFilter("deliveries", "order = {:order}", "-created", 1, 0, { order: orderId });
  return rows.length ? rows[0].getDateTime("created") : null;
}

/**
 * Phase und `delivered_at` einer Bestellung neu berechnen und speichern (nur bei Änderung).
 * Gibt die (ggf. neue) Phase zurück.
 */
function recalculateOrderStatus(app, orderId) {
  const order = app.findRecordById("orders", orderId);
  const items = itemsOf(app, orderId);
  const steps = stepsOf(app, orderId);
  const next = deriveStatus(steps, items);
  let changed = false;

  if (order.getString("status") !== next) {
    order.set("status", next);
    changed = true;
  }
  const complete = next === "geliefert" || next === "abgeschlossen";
  const deliveredAt = order.getDateTime("delivered_at");
  if (complete && deliveredAt.isZero()) {
    order.set("delivered_at", lastDeliveryAt(app, orderId) || new DateTime());
    changed = true;
  } else if (!complete && !deliveredAt.isZero()) {
    order.set("delivered_at", "");
    changed = true;
  }
  if (changed) app.save(order);
  return next;
}

/** Gibt es neben dieser Bestellung bereits einen offenen Korb für denselben Lieferanten/Shop? */
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
 * Datum eines Schritts: leer → jetzt; „JJJJ-MM-TT“ → dieser Tag 12:00 UTC (bleibt in jeder
 * europäischen Zeitzone derselbe Kalendertag). Ein Tag in der Zukunft wird abgelehnt.
 */
function parseStepDate(value) {
  if (value === undefined || value === null || value === "") return new DateTime();
  const s = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + "T00:00:00Z") : NaN;
  if (isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) {
    throw new BadRequestError("Ungültiges Datum (erwartet JJJJ-MM-TT): " + s);
  }
  if (ms > Date.now() + MAX_TZ_AHEAD_MS) throw new BadRequestError("Das Datum liegt in der Zukunft.");
  return new DateTime(s + " 12:00:00.000Z");
}

/**
 * Interne Bestellnummer aus dem Body übernehmen bzw. „ohne interne Bestellnummer“ festhalten.
 * requireNumber: Formularschritte (nur mit Nummer); sonst („bestellt“) genügt auch „ohne“.
 */
function applyInternalNo(order, input, requireNumber) {
  const givenNo = normalizeInternalOrderNo(input.internal_order_no);
  const without = truthy(input.without_internal_order_no);
  if (givenNo && without) {
    throw new BadRequestError("Entweder eine interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen – nicht beides.");
  }
  if (givenNo) order.set("internal_order_no", givenNo); // Format und Eindeutigkeit prüft der Validierungs-Hook
  if (order.getString("internal_order_no")) return;

  if (requireNumber) {
    if (without || order.getBool("without_internal_order_no")) {
      throw new BadRequestError("Ohne interne Bestellnummer gibt es kein Formular und keine Freigabe.");
    }
    throw new BadRequestError("Bitte die interne Bestellnummer angeben (Format JJJJIW#####, z. B. 2026IW01047).");
  }
  if (without || order.getBool("without_internal_order_no")) {
    order.set("without_internal_order_no", true);
    return;
  }
  throw new BadRequestError("Bitte die interne Bestellnummer angeben (Format JJJJIW#####, z. B. 2026IW01047) oder „ohne interne Bestellnummer“ wählen.");
}

/**
 * Schritt abhaken, Datum ändern oder zurücknehmen. Muss innerhalb einer Transaktion aufgerufen werden.
 * input: { step, done (Standard true), date?: "JJJJ-MM-TT", internal_order_no?, without_internal_order_no?, supplier_order_no? }
 * → Bestellung (mit neu berechneter Phase)
 */
function setStep(app, orderId, input, userId) {
  input = input || {};
  const step = String(input.step || "");
  if (STEPS.indexOf(step) === -1) throw new BadRequestError("Unbekannter Schritt: " + step);
  const done = input.done === undefined ? true : truthy(input.done);

  let order;
  try {
    order = app.findRecordById("orders", orderId);
  } catch (_) {
    throw new BadRequestError("Die Bestellung existiert nicht.");
  }
  const steps = stepsOf(app, orderId);
  const existing = steps[step];
  const label = "„" + STEP_LABELS[step] + "“";

  if (done) {
    const date = parseStepDate(input.date);
    if (existing) {
      // Datum eines erledigten Schritts korrigieren (Nutzer bleibt)
      existing.set("done_at", date);
      app.save(existing);
      recalculateOrderStatus(app, orderId);
      return app.findRecordById("orders", orderId);
    }

    const items = itemsOf(app, orderId);
    if (ORDER_TRACK.indexOf(step) !== -1 && order.getString("status") === "angefragt" && items.length === 0) {
      throw new BadRequestError("Ein leerer Warenkorb kann nicht abgeschlossen werden.");
    }
    if (FORM_STEPS.indexOf(step) !== -1) applyInternalNo(order, input, true);
    if (step === "ordered") {
      applyInternalNo(order, input, false);
      const supplierNo = input.supplier_order_no;
      if (supplierNo != null && String(supplierNo).trim() !== "") order.set("supplier_order_no", String(supplierNo).trim());
    }
    if (INVOICE_TRACK.indexOf(step) !== -1 && !steps.ordered) {
      throw new BadRequestError(label + " ist erst möglich, wenn die Bestellung bestellt ist.");
    }
    if (step === "closed" && deliveryStatusOf(items) !== "geliefert") {
      throw new BadRequestError("Abschließen ist erst möglich, wenn die Ware vollständig geliefert ist.");
    }
    app.save(order);

    const record = new Record(app.findCollectionByNameOrId("order_steps"));
    record.set("order", orderId);
    record.set("step", step);
    record.set("done_at", date);
    if (userId) record.set("done_by", userId);
    app.save(record);
  } else {
    if (!existing) throw new BadRequestError(label + " ist nicht erledigt.");
    if (step === "ordered") {
      if (itemsOf(app, orderId).some((it) => it.getInt("qty_delivered") !== 0)) {
        throw new BadRequestError("„Bestellt“ kann nicht zurückgenommen werden: Es sind bereits Lieferungen gebucht.");
      }
      if (INVOICE_TRACK.some((s) => steps[s])) {
        throw new BadRequestError("„Bestellt“ kann nicht zurückgenommen werden: Es sind bereits Rechnungsschritte erledigt.");
      }
    }
    const reopensCart = ORDER_TRACK.indexOf(step) !== -1 && !ORDER_TRACK.some((s) => s !== step && steps[s]);
    if (reopensCart && otherOpenCartExists(app, order)) {
      throw new BadRequestError(
        "Für diesen Lieferanten gibt es bereits einen anderen offenen Warenkorb. " +
        "Der Warenkorb kann daher nicht wieder geöffnet werden."
      );
    }
    app.delete(existing);
  }

  recalculateOrderStatus(app, orderId);
  return app.findRecordById("orders", orderId);
}

/**
 * Schritte für Bestellungen anlegen, die am System vorbei entstanden sind (Lieferschein):
 * „bestellt“ jetzt; mit interner Nummer die Formularschritte als erledigt ohne Datum (Freigabe nicht).
 */
function createInitialSteps(app, order, userId) {
  const col = app.findCollectionByNameOrId("order_steps");
  const add = (step, date, by) => {
    const r = new Record(col);
    r.set("order", order.id);
    r.set("step", step);
    if (date) r.set("done_at", date);
    if (by) r.set("done_by", by);
    app.save(r);
  };
  if (order.getString("internal_order_no")) {
    for (const s of ["form_written", "form_signed", "form_submitted"]) add(s, null, null);
  }
  add("ordered", new DateTime(), userId);
}

module.exports = {
  ORDER_TRACK, INVOICE_TRACK, STEPS,
  deliveryStatusOf, deriveStatus, recalculateOrderStatus, setStep, createInitialSteps,
};
