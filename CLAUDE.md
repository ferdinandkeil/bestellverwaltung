# CLAUDE.md – Labor-Bestellsystem

Maßgebliche Projektdokumente: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `pb_schema.json`.

## Grundregeln für die Zusammenarbeit

1. **Fragen statt Annahmen treffen.** Wenn etwas in den Dokumenten unklar, widersprüchlich oder nicht spezifiziert ist, wird nachgefragt, bevor implementiert wird. Das gilt besonders bei Problemen (z. B. technische Hindernisse, Inkompatibilitäten, fehlgeschlagene Tests oder blockierte Aktionen): erst das Problem schildern und Optionen nennen, nicht eigenmächtig umgehen.
2. **Sauberes Design statt schneller Lösungen.** Keine Workarounds, Hacks oder Abkürzungen, die der Architektur widersprechen oder später aufgeräumt werden müssen. Lieber die saubere Lösung vorschlagen und abstimmen.
3. **Vorschläge des Nutzers: erst Feedback, dann Umsetzung.** Macht der Nutzer einen Vorschlag, wird dieser zunächst bewertet (Vor-/Nachteile, Bedenken, Alternativen). Implementiert wird erst nach ausdrücklicher Bestätigung.

## Arbeitsweise laut Implementierungsplan

- Strikt phasenweise arbeiten; nach jeder Phase Feedback einholen, bevor die nächste beginnt.
- Kein JS-Build (kein `package.json`, kein npm/Vite/Webpack). Alle Frontend-JS-Dateien als native ES6-Module unter `pb_public/`. Einzige Ausnahme: CSS-Build mit dem Tailwind Standalone CLI (`scripts/build-css.sh`); das erzeugte `pb_public/assets/app.css` wird mitcommittet.
- Geschäftslogik, die mehrere Datensätze konsistent ändert, gehört in `pb_hooks/` (transaktional), nicht ins Frontend.
- Nach Änderungen an `pb_hooks/` oder Schema: `tests/run.sh`; nach UI-Änderungen: `scripts/build-css.sh` und `tests/run.sh --e2e`.
- Feldnamen exakt wie in `pb_schema.json`.

## Git

- **Repository:** lokales Git-Repo im Projektordner. `pb_data/`, die PocketBase-Binary und lokale Testartefakte stehen in `.gitignore` und werden nie committet.
- **Branches:** pro Phase ein Feature-Branch (`phase-1-core`, `phase-2-delivery-scanner`, `phase-3-moodle-import`, `phase-4-shop-export`, `phase-5-word-export`, `phase-6-part-number-check`, `phase-7-mcp`). In `main` wird erst nach Freigabe der Phase durch den Nutzer gemergt.
- **Commits:** selbstständig und kleinschrittig, nach jedem sinnvollen, in sich abgeschlossenen Schritt. Commit-Nachrichten auf Deutsch, kurz und aussagekräftig (was und warum).
- **Remote / Push:** gepusht wird nur auf ausdrückliche Anweisung. Keine History-Umschreibungen (force-push, rebase veröffentlichter Commits) ohne Rückfrage.

## Wo Entscheidungen stehen

- **Fachliche und technische Entscheidungen** (Datenmodell, Rechte, Workflow, Module, UI-Konventionen, Tests, Betrieb): `ARCHITECTURE.md` – verbindliche Quelle.
- **Reihenfolge, Umfang und offene Punkte der Phasen:** `IMPLEMENTATION_PLAN.md`.
- **Betrieb, Deploy, Backup:** `docs/DEPLOYMENT.md`.
- Neue Entscheidungen werden direkt in diesen Dokumenten festgehalten (nicht hier) und mit dem zugehörigen Code committet.
- Echte Belege in `samples/` enthalten Kundendaten und werden nie committet.
