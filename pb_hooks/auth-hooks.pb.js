// Login per E-Mail-Code: Groß-/Kleinschreibung der Adresse spielt keine Rolle.
//
// PocketBase sucht das Konto zur Code-Anfrage nach der exakten Schreibweise. Findet es keins,
// wird hier ohne Rücksicht auf Groß-/Kleinschreibung gesucht. Eindeutig ist das, weil der
// Index idx_users_email_nocase (pb_schema.json) Adressen schreibweisenunabhängig eindeutig macht.
onRecordRequestOTPRequest((e) => {
  if (!e.record) {
    const body = e.requestInfo().body || {};
    const email = String(body.email || "").trim().toLowerCase();
    if (email) {
      const found = new Record(e.collection);
      try {
        e.app.recordQuery(e.collection)
          .andWhere($dbx.exp("LOWER([[email]]) = {:email}", { email: email }))
          .limit(1)
          .one(found);
        e.record = found;
      } catch (_) {
        // kein Konto: PocketBase antwortet wie gewohnt ohne Mail (kein Ausspähen von Konten)
      }
    }
  }
  e.next();
}, "users");
