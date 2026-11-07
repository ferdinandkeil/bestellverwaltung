# CLAUDE.md – Labor-Bestellsystem

Maßgebliche Projektdokumente: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `pb_schema.json`.

## Grundregeln für die Zusammenarbeit

1. **Fragen statt Annahmen treffen.** Wenn etwas in den Dokumenten unklar, widersprüchlich oder nicht spezifiziert ist, wird nachgefragt, bevor implementiert wird. Das gilt besonders bei Problemen (z. B. technische Hindernisse, Inkompatibilitäten, fehlgeschlagene Tests oder blockierte Aktionen): erst das Problem schildern und Optionen nennen, nicht eigenmächtig umgehen.
2. **Sauberes Design statt schneller Lösungen.** Keine Workarounds, Hacks oder Abkürzungen, die der Architektur widersprechen oder später aufgeräumt werden müssen. Lieber die saubere Lösung vorschlagen und abstimmen.
3. **Vorschläge des Nutzers: erst Feedback, dann Umsetzung.** Macht der Nutzer einen Vorschlag, wird dieser zunächst bewertet (Vor-/Nachteile, Bedenken, Alternativen). Implementiert wird erst nach ausdrücklicher Bestätigung.

## Arbeitsweise laut Implementierungsplan

- Strikt phasenweise arbeiten; nach jeder Phase Feedback einholen, bevor die nächste beginnt.
- Kein Build-Prozess (kein `package.json`, kein npm/Vite/Webpack). Alle Frontend-Dateien als native ES6-Module unter `pb_public/`.
- Feldnamen exakt wie in `pb_schema.json`.

## Git

- **Repository:** lokales Git-Repo im Projektordner. `pb_data/`, die PocketBase-Binary und lokale Testartefakte stehen in `.gitignore` und werden nie committet.
- **Branches:** pro Phase ein Feature-Branch (`phase-1-core`, `phase-2-shop-export`, `phase-3-moodle-import`, `phase-4-delivery-scanner`, `phase-5-word-export`). In `main` wird erst nach Freigabe der Phase durch den Nutzer gemergt.
- **Commits:** selbstständig und kleinschrittig, nach jedem sinnvollen, in sich abgeschlossenen Schritt. Commit-Nachrichten auf Deutsch, kurz und aussagekräftig (was und warum).
- **Remote / Push:** gepusht wird nur auf ausdrückliche Anweisung. Keine History-Umschreibungen (force-push, rebase veröffentlichter Commits) ohne Rückfrage.

## Getroffene Entscheidungen

- **PocketBase-Version:** aktuelles PocketBase (≥ v0.23, wegen Email-OTP). `pb_schema.json` liegt im aktuellen Import-Format vor (getestet mit v0.40.6, Import über Admin-UI → Settings → Import collections). Die Auth-Einstellungen der `users` (OTP an, Passwort-Login aus, Token-Dauer 30 Tage) sind im JSON enthalten.
- **CDN-Abhängigkeiten:** immer mit fester Version einbinden, nie `@latest`.
- **Lieferant `other`:** pro `supplier_custom_name` ein eigener offener Sammel-Warenkorb (statt eines gemeinsamen `other`-Korbs).
