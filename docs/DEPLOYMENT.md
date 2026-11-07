# Betrieb auf Uberspace

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

1. **2FA für den Admin** aktivieren (Superusers → eigener Account → MFA/OTP).
2. **Collections importieren:** Settings → Import collections → Inhalt von `pb_schema.json` einfügen → „Merge“ (fehlende Collections *nicht* löschen) → Review → Confirm.
   Enthält auch die `users`-Auth-Einstellungen (OTP 10 min, deutsche Mail, Passwort-Login aus, Token 30 Tage).
3. **Settings → Application:** App-Name „Labor-Bestellsystem“, App-URL `https://<domain>`.
4. **Settings → Mail settings:** Absender + SMTP. Auf Uberspace z. B. ein eigenes Postfach anlegen (`uberspace mail user add labor`) und als SMTP `<host>.uberspace.de:587`, STARTTLS, Benutzer `labor@<user>.uber.space` verwenden – oder den SMTP-Server der Hochschule. Mit „Send test email“ prüfen.
5. **Labor-Nutzer anlegen:** Collections → users → New record (E-Mail, Name, beliebiges Passwort – wird nie benutzt, `verified` an).

## 3. Deploy (vom Entwicklungsrechner)

Vorher lokal: `tests/run.sh` grün, `scripts/build-css.sh` ausgeführt und `pb_public/assets/app.css` committet.

```bash
rsync -av --delete pb_public/ <user>@<host>.uberspace.de:bestellverwaltung/pb_public/
rsync -av --delete pb_hooks/  <user>@<host>.uberspace.de:bestellverwaltung/pb_hooks/
rsync -av pb_schema.json      <user>@<host>.uberspace.de:bestellverwaltung/
```

* Änderungen in `pb_hooks/` lädt PocketBase automatisch neu (Hooks-Watcher). Im Zweifel: `supervisorctl restart bestellverwaltung`.
* Bei Schema-Änderungen anschließend erneut importieren (Schritt 2.2). **Vorher ein Backup ziehen.**

## 4. Backups

* **PocketBase-Backups:** Settings → Backups → „Auto backups“ aktivieren, z. B. täglich `0 3 * * *`, 14 Stück behalten. Die ZIPs liegen in `pb_data/backups/`.
* **Kopie außerhalb des Hosts:** die Backup-ZIPs regelmäßig abholen (z. B. per `rsync` vom Hochschul-Rechner) oder in den Backup-Einstellungen einen S3-Speicher eintragen. Uberspace-eigene Snapshots sind nur eine zusätzliche Absicherung.
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
