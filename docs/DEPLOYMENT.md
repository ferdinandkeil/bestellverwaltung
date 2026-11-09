# Betrieb auf Uberspace

## 0. Checkliste Go-Live

**Vorbereitung**
- [ ] Uberspace-Konto und Adresse der App (Subdomain) festgelegt
- [ ] Liste der Labor-Nutzer (Name, E-Mail) und Veranstaltungen/Gruppen des Semesters liegt vor
- [ ] Lokal auf `main`: `tests/run.sh --e2e` grün

**Einrichtung** (Kap. 1–4)
- [ ] PocketBase installiert, Dienst läuft (`supervisorctl status bestellverwaltung`), Web-Backend gesetzt
- [ ] Admin angelegt; Schema importiert; App-Name/-URL gesetzt
- [ ] Proxy-Header gesetzt und in den Logs geprüft; Rate limiting aktiv
- [ ] Postfach angelegt, Test-Mail an TH-Adresse kommt im Posteingang an
- [ ] MFA für den Admin aktiv (erst nach funktionierendem Mailversand)
- [ ] App deployt und Dienst neu gestartet; Hook-Prüfung liefert `401` (Kap. 3)
- [ ] Auto-Backups aktiv, ein Backup manuell erzeugt, heruntergeladen und geprüft

**Abnahme im Betrieb**
- [ ] Eigener Login per Code am Rechner und am Smartphone
- [ ] Gruppe anlegen, Position erfassen, Warenkorb als bestellt markieren, Lieferung buchen – danach die Testbestellung über das Admin-UI löschen
- [ ] Lieferschein-Scanner (Beta) einmal mit einem echten Lieferschein am Smartphone ausprobieren, Ergebnis notieren
- [ ] Labor-Nutzer anlegen und informieren (Adresse der App, Login per E-Mail-Code)

**Zurückrollen:** vorherigen Stand aus Git erneut deployen (`git switch --detach <commit>`, Kap. 3) bzw. bei Datenproblemen das letzte Backup wiederherstellen (Kap. 4).


Ziel-Layout auf dem Uberspace-Host (Benutzer `<user>`):

```text
~/bestellverwaltung/
├── pocketbase          # Binary (gleiche Version wie lokal getestet, aktuell v0.40.6)
├── pb_data/            # Datenbank + Uploads – NUR hier, nie in Dropbox/Git
├── pb_hooks/           # aus dem Repo
├── pb_public/          # aus dem Repo (inkl. committetem assets/app.css und vendor/)
└── pb_schema.json      # aus dem Repo (für den Import)
```

## 1. Ersteinrichtung

```bash
# auf dem Uberspace-Host
mkdir -p ~/bestellverwaltung && cd ~/bestellverwaltung
curl -LO https://github.com/pocketbase/pocketbase/releases/download/v0.40.6/pocketbase_0.40.6_linux_amd64.zip
unzip pocketbase_0.40.6_linux_amd64.zip pocketbase && rm pocketbase_0.40.6_linux_amd64.zip
./pocketbase superuser upsert <admin-mail> '<starkes-passwort>'
```

**Dienst (supervisord)** – `~/etc/services.d/bestellverwaltung.ini`:

```ini
[program:bestellverwaltung]
directory=%(ENV_HOME)s/bestellverwaltung
command=%(ENV_HOME)s/bestellverwaltung/pocketbase serve --http 0.0.0.0:8090
autostart=yes
autorestart=yes
startsecs=5
```

```bash
supervisorctl reread && supervisorctl update
supervisorctl status bestellverwaltung
uberspace web backend set / --http --port 8090      # oder eine Subdomain: --domain bestellung.example.de
```

## 2. Konfiguration im Admin-UI (`https://<domain>/_/`)

1. **Zweiter Faktor für den Admin:** Collections → `_superusers` → ⚙ Optionen → **MFA** und **OTP** aktivieren. Danach braucht der Admin-Login Passwort **und** einen E-Mail-Code (PocketBase kennt keine TOTP-Apps). Erst aktivieren, wenn der Mailversand (Schritt 5) funktioniert.
2. **Collections importieren:** Settings → Import collections → Inhalt von `pb_schema.json` einfügen → „Merge“ (fehlende Collections *nicht* löschen) → Review → Confirm.
   Enthält auch die `users`-Auth-Einstellungen (OTP 10 min, deutsche Mail, Passwort-Login aus, Token 30 Tage, Login-Alarm aus).
3. **Settings → Application:**
   * App-Name „Labor-Bestellsystem“, App-URL `https://<domain>` (wird in Mails verwendet, auch für den Link in Scanner-Meldungen).
   * **User IP proxy headers:** `X-Forwarded-For` eintragen, „Use leftmost IP“ **aus**. Uberspace stellt einen Proxy vor die App; ohne diese Einstellung sehen Logs und Rate-Limiting nur die IP des Proxys. Prüfen: Settings → Logs → eine eigene Anfrage muss die eigene öffentliche IP zeigen, nicht `127.0.0.1` o. Ä.
   * **Rate limiting aktivieren** (Standardregeln übernehmen). Ab Werk ist es aus; ohne Begrenzung könnten z. B. massenhaft Login-Mails ausgelöst werden.
4. **Postfach für den Versand** (auf dem Host):
   ```bash
   uberspace mail user add labor      # fragt nach einem Passwort
   ```
5. **Settings → Mail settings:**
   * Absender-Name „Labor-Bestellsystem“, Absender-Adresse `labor@<user>.uber.space`.
   * SMTP: Host `<host>.uberspace.de`, Port `587`, TLS/STARTTLS, Benutzer `labor@<user>.uber.space`, Passwort aus Schritt 4.
   * „Send test email“ an eine **TH-Adresse** schicken und prüfen, dass sie im Posteingang (nicht im Spam) landet. Landet sie im Spam: Absender bei der TH-IT freigeben lassen oder auf den SMTP-Server der TH umstellen.
6. **Labor-Nutzer anlegen:** Collections → users → New record (E-Mail, Name, beliebiges Passwort – wird nie benutzt, `verified` an).
7. **Backups einrichten** (siehe Kap. 4).

**Scanner-Meldungen:** Meldet jemand im Lieferschein-Scanner ein Problem, bekommen **alle Superuser** eine Mail an ihre Admin-Adresse (nur Link, kein Anhang). Abholen und auf dem Server löschen, vom Entwicklungsrechner im Projektordner:
```bash
node scripts/fetch-scan-reports.mjs https://<domain>          # fragt E-Mail, Passwort und Code aus der Mail
node scripts/fetch-scan-reports.mjs https://<domain> --keep   # nur herunterladen
```
Die Meldungen landen in `samples/scan-reports/` (nicht im Repo, enthält echte Belege).

## 3. Deploy (vom Entwicklungsrechner)

Immer vom Branch `main` deployen:

```bash
git switch main && git status        # Arbeitsverzeichnis muss sauber sein
tests/run.sh --e2e                   # alles grün
git log --oneline -1                 # deployten Stand notieren (für ein Zurückrollen)
```

```bash
rsync -av --delete pb_public/ <user>@<host>.uberspace.de:bestellverwaltung/pb_public/
rsync -av --delete pb_hooks/  <user>@<host>.uberspace.de:bestellverwaltung/pb_hooks/
rsync -av pb_schema.json      <user>@<host>.uberspace.de:bestellverwaltung/
```

Danach **immer** den Dienst neu starten und prüfen, ob die Hooks geladen sind:

```bash
ssh <user>@<host>.uberspace.de supervisorctl restart bestellverwaltung
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/api/lab/cart-items   # erwartet: 401
```

* `401` (Anmeldung erforderlich) heißt: Die eigenen Routen sind geladen. **`404`** heißt: Die Hooks fehlen – dann `supervisorctl tail bestellverwaltung stderr` prüfen.
* Warum immer neu starten: PocketBase lädt `pb_hooks/` beim Start und überwacht den Ordner nur, wenn er beim Start schon existierte. Lief der Dienst vor dem ersten Deploy, bleiben die Hooks bis zum Neustart ungeladen (11/2026: „Artikel anlegen“ schlug mit 404 fehl).
* Bei Schema-Änderungen anschließend erneut importieren (Schritt 2.2). **Vorher ein Backup ziehen.**
* **Einführung der internen Bestellnummer (11/2026):** Bestellungen, die schon vorher auf „bestellt“ standen, haben noch keine. Sie bleiben bearbeitbar; die Nummer in der Bestell-Detailansicht nachtragen (stand sie bisher im Feld „Auftragsnummer“, dorthin verschieben), damit der Lieferschein-Scanner sie findet.
* **Achtung:** Der Import mit „Merge“ ergänzt und ändert Felder, **entfernt aber keine Felder**, die im Schema weggefallen sind. Solche Felder im Admin-UI (Collection → Feld → Löschen) von Hand entfernen. Die betroffenen Felder stehen in der jeweiligen Commit-Nachricht.

## 4. Backups

* **PocketBase-Backups:** Settings → Backups → „Auto backups“ aktivieren, z. B. täglich `0 3 * * *`, 14 Stück behalten. Die ZIPs liegen in `pb_data/backups/`.
* **Kopie außerhalb des Hosts:** die Backup-ZIPs regelmäßig abholen (z. B. per `rsync` vom Hochschul-Rechner) oder in den Backup-Einstellungen einen S3-Speicher eintragen. Uberspace-eigene Snapshots sind nur eine zusätzliche Absicherung.
* **Backup prüfen** (nach der Einrichtung und dann regelmäßig): Settings → Backups → „Initialize new backup“ → ZIP herunterladen und öffnen; es muss `data.db` und den Ordner `storage/` enthalten.
* **Wiederherstellen:** Settings → Backups → Backup auswählen → Restore (startet PocketBase neu).
* `pb_data/` niemals per Dropbox oder ähnlichem synchronisieren (SQLite/WAL kann dabei beschädigt werden).

## 5. Updates von PocketBase

1. Changelog der neuen Version prüfen (Breaking Changes, insbesondere JSVM-/Hook-API).
2. Lokal: neue Binary in den PATH, `tests/run.sh` ausführen.
3. Auf dem Host: Backup ziehen, Binary ersetzen, `supervisorctl restart bestellverwaltung`.
4. Versionsnummer hier und in `ARCHITECTURE.md` aktualisieren.

## 6. Lokale Entwicklung

```bash
scripts/dev-server.sh                                 # PocketBase :8090 + Mailpit :8025
scripts/dev-server.sh add-user name@example.com "Vorname Name"
scripts/build-css.sh --watch                          # parallel, bei UI-Arbeit
tests/run.sh                                          # Tests gegen frische Instanz
tests/run.sh --e2e                                    # zusätzlich Browser-Durchläufe (App + Lieferschein-Scanner)
```

Die Daten der Dev-Instanz liegen in `~/.local/share/bestellverwaltung-dev/` (außerhalb von Dropbox).
