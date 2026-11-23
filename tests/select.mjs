// Testauswahl nach Änderungen (ARCHITECTURE.md Kap. 8), aufgerufen von `tests/run.sh --changed [ref]`.
// Nur Node-Bordmittel. Geänderte Dateien = gegenüber dem Abzweig von main (bzw. [ref]), inkl. nicht committeter
// und neuer Dateien. Jede Datei wird über RULES auf Tests abgebildet; die erste passende Regel gilt.
// Grundsatz: lieber zu viel als zu wenig – eine Datei ohne passende Regel löst den vollen Lauf aus.
//
// Ausgabe (stdout, von run.sh gelesen):   UNIT <dateien…>   und   E2E <suiten…>
// Begründung je Datei auf stderr.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL_UNIT = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
// Reihenfolge wie im vollen Lauf (run.sh)
export const ALL_E2E = ['e2e', 'e2e-scanner', 'e2e-camera', 'e2e-moodle', 'e2e-shop-export', 'e2e-favorites'];

const ALL = { unit: ALL_UNIT, e2e: ALL_E2E, why: 'betrifft alles' };
const NONE = { unit: [], e2e: [], why: 'ohne Tests' };
const unit = (...files) => files.map((f) => f + '.test.mjs');
const SCANNER_UNIT = unit('scanner-camera', 'scanner-matcher', 'scanner-pdf', 'scanner-report');

/** [Muster, Auswahl]; Muster ist ein RegExp auf den Pfad relativ zum Projektordner. Erste passende Regel gilt. */
const RULES = [
  // ohne Tests
  [/^(docs\/|samples\/|README|IMPLEMENTATION_PLAN\.md|ARCHITECTURE\.md|CLAUDE\.md|\.gitignore$)/, NONE],
  [/^scripts\/(deploy|fetch-scan-reports|dev-server)/, NONE],
  [/^scripts\/dev-seed\.mjs$/, { unit: unit('dev-seed'), e2e: [], why: 'Testdaten der Dev-Instanz' }],

  // Test-Infrastruktur und Gemeinsames: alles
  [/^tests\/(run\.sh|select\.mjs|helpers\.mjs|browser\.mjs)$/, ALL],
  [/^(pb_schema\.json|pb_migrations\/|pb_public\/vendor\/|pb_public\/index\.html|pb_public\/core\/)/, ALL],

  // einzelne Testdateien
  [/^tests\/fixtures-moodle\.mjs$/, { unit: unit('moodle-csv'), e2e: ['e2e-moodle'], why: 'Moodle-Testdaten' }],
  [/^tests\/([\w-]+\.test\.mjs)$/, (m) => ({ unit: [m[1]], e2e: [], why: 'Testdatei selbst' })],
  [/^tests\/(e2e[\w-]*)\.mjs$/, (m) => ({ unit: [], e2e: [m[1]], why: 'Browser-Test selbst' })],
  [/^tests\/fixtures\//, ALL],

  // Server: Hooks und Regeln greifen ineinander → alle Unit-Tests
  [/^pb_hooks\//, { unit: ALL_UNIT, e2e: [], why: 'Server-Logik' }],

  // CSS (auch erzeugtes): Sichtbarkeit zählt in allen Browser-Tests
  [/^(tailwind\/|pb_public\/assets\/app\.css$)/, { unit: [], e2e: ALL_E2E, why: 'Stile wirken überall' }],
  [/^pb_public\/assets\//, { unit: [], e2e: ['e2e'], why: 'Bilder (Konsole ohne Fehler)' }],

  // Module
  [/^pb_public\/modules\/delivery-scanner\//, { unit: SCANNER_UNIT, e2e: ['e2e-scanner', 'e2e-camera'], why: 'Lieferschein-Scanner' }],
  [/^pb_public\/modules\/moodle-import\//, { unit: unit('moodle-csv'), e2e: ['e2e-moodle'], why: 'Moodle-Import' }],
  [/^pb_public\/modules\/shop-export\//, { unit: unit('shop-export'), e2e: ['e2e-shop-export'], why: 'Shop-Export' }],
  [/^pb_public\/modules\/favorites\//, { unit: [], e2e: ['e2e-favorites'], why: 'Favoriten aus Bestellung' }],

  // Ansichten: je Browser-Test, der durch sie hindurchführt
  [/^pb_public\/views\/login-view\.js$/, { unit: [], e2e: ALL_E2E, why: 'alle Browser-Tests melden sich an' }],
  [/^pb_public\/views\/(dashboard-view|unmatched-receipts)\.js$/, { unit: [], e2e: ['e2e', 'e2e-scanner', 'e2e-camera'], why: 'Startseite (Scanner startet dort)' }],
  [/^pb_public\/views\/(order-detail-view|order-steps)\.js$/, { unit: [], e2e: ['e2e', 'e2e-scanner', 'e2e-shop-export', 'e2e-favorites'], why: 'Bestellansicht' }],
  [/^pb_public\/views\/(cart-menu|item-form)\.js$/, { unit: [], e2e: ['e2e', 'e2e-moodle', 'e2e-favorites'], why: 'Kopfzeile/Warenkorb' }],
  [/^pb_public\/views\/groups-view\.js$/, { unit: [], e2e: ['e2e'], why: 'Gruppen' }],
  [/^pb_public\/views\/favorite(s|-list)-view\.js$/, { unit: [], e2e: ['e2e-favorites'], why: 'Favoriten' }],
];

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

export function changedFiles(ref) {
  const base = ref || git('merge-base', 'main', 'HEAD')[0];
  // Commit ↔ Arbeitsverzeichnis: committete und nicht committete Änderungen; dazu neue, nicht verfolgte Dateien.
  return [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])].sort();
}

export function select(files) {
  const unitSet = new Set();
  const e2eSet = new Set();
  const reasons = [];
  for (const file of files) {
    let sel = null;
    for (const [pattern, choice] of RULES) {
      const m = file.match(pattern);
      if (m) { sel = typeof choice === 'function' ? choice(m) : choice; break; }
    }
    if (!sel) sel = { ...ALL, why: 'keine Regel → alles' };
    sel.unit.forEach((f) => unitSet.add(f));
    sel.e2e.forEach((s) => e2eSet.add(s));
    reasons.push(`${file}: ${sel.why}`);
  }
  return {
    unit: ALL_UNIT.filter((f) => unitSet.has(f)),
    e2e: ALL_E2E.filter((s) => e2eSet.has(s)),
    reasons,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = changedFiles(process.argv[2]);
  const { unit: u, e2e, reasons } = select(files);
  console.error(files.length ? 'Geänderte Dateien:\n  ' + reasons.join('\n  ') : 'Keine Änderungen gefunden.');
  console.log('UNIT ' + u.join(' '));
  console.log('E2E ' + e2e.join(' '));
}
