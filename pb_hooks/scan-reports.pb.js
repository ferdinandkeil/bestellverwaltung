// Problem-Meldungen der Lieferschein-Erfassung: Validierung und Benachrichtigung der Superuser.

onRecordValidate((e) => {
  const { validateReport } = require(`${__hooks}/lib/scan-reports.js`);
  validateReport(e.record);
  e.next();
}, "scan_reports");

onRecordAfterCreateSuccess((e) => {
  const { notifySuperusers } = require(`${__hooks}/lib/scan-reports.js`);
  e.next();
  try {
    notifySuperusers(e.app, e.record);
  } catch (err) {
    e.app.logger().error("Benachrichtigung zur Scanner-Meldung fehlgeschlagen", "record", e.record.id, "error", String(err));
  }
}, "scan_reports");
