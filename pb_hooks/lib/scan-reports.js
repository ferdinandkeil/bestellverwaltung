// Problem-Meldungen der Lieferschein-Erfassung (ARCHITECTURE.md Kap. 6, Modul delivery-scanner).
// Die Meldung bleibt auf dem Server; die Superuser bekommen nur eine Mail mit Link (kein Anhang).

const { readJSON } = require(`${__hooks}/lib/util.js`);

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Prüft den Aufbau der Analyse-Daten (kommen vom Browser). */
function validateReport(record) {
  const analysis = readJSON(record, "analysis", null);
  if (!analysis || typeof analysis !== "object" || !Array.isArray(analysis.pages)) {
    throw new BadRequestError("Analyse-Daten fehlen oder sind ungültig.");
  }
  const photos = record.get("photos");
  const count = photos && photos.length !== undefined ? photos.length : 0;
  if (count && analysis.pages.length !== count) {
    throw new BadRequestError("Anzahl der Seiten passt nicht zur Anzahl der Fotos.");
  }
}

/** Link auf den Datensatz in der Admin-UI. */
function adminLink(app, record) {
  const base = String(app.settings().meta.appURL || "").replace(/\/+$/, "");
  return base + "/_/#/collections?collection=" + record.collection().id + "&recordId=" + record.id;
}

function buildMail(app, record) {
  const analysis = readJSON(record, "analysis", {});
  const problems = Array.isArray(analysis.problems) ? analysis.problems : [];
  let reporter = "";
  try {
    const user = app.findRecordById("users", record.getString("reported_by"));
    reporter = user.getString("name") || user.getString("email");
  } catch (_) { /* Nutzer gelöscht */ }
  let orderText = "nicht zugeordnet";
  const orderId = record.getString("order");
  if (orderId) {
    try {
      const order = app.findRecordById("orders", orderId);
      const shop = order.getString("supplier") === "other" ? order.getString("supplier_custom_name") : order.getString("supplier");
      const no = order.getString("internal_order_no") || order.getString("supplier_order_no");
      orderText = shop + (no ? " · " + no : "");
    } catch (_) { orderText = "gelöscht"; }
  }
  const link = adminLink(app, record);
  const rows = [
    ["Gemeldet von", reporter],
    ["Bestellung", orderText],
    ["Seiten", String(analysis.pages ? analysis.pages.length : 0)],
    ["Profil", analysis.profile || "nicht erkannt"],
  ];
  const html =
    "<p>Im Lieferschein-Scanner wurde ein Problem gemeldet.</p>" +
    "<table>" + rows.map((r) => "<tr><td><b>" + r[0] + "</b></td><td>" + escapeHtml(r[1]) + "</td></tr>").join("") + "</table>" +
    (problems.length ? "<p><b>Automatisch erkannt:</b></p><ul>" + problems.map((p) => "<li>" + escapeHtml(p) + "</li>").join("") + "</ul>" : "") +
    (record.getString("note") ? "<p><b>Notiz:</b> " + escapeHtml(record.getString("note")) + "</p>" : "") +
    '<p><a href="' + escapeHtml(link) + '">Meldung in der Admin-Oberfläche öffnen</a></p>' +
    "<p>Zur Analyse abholen (und danach auf dem Server löschen): <code>node scripts/fetch-scan-reports.mjs</code></p>";
  return { subject: "Lieferschein-Scanner: Problem gemeldet (" + orderText + ")", html };
}

/** Mail an alle Superuser. Fehler beim Versand werden protokolliert, die Meldung bleibt gespeichert. */
function notifySuperusers(app, record) {
  const to = app.findAllRecords("_superusers").map((s) => ({ address: s.getString("email") })).filter((a) => a.address);
  if (!to.length) return;
  const meta = app.settings().meta;
  const mail = buildMail(app, record);
  const message = new MailerMessage({
    from: { address: meta.senderAddress, name: meta.senderName },
    to,
    subject: mail.subject,
    html: mail.html,
  });
  app.newMailClient().send(message);
}

module.exports = { validateReport, notifySuperusers, buildMail };
