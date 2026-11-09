// Browser-Durchlauf Moodle-Import: synthetische CSV → Zuordnung (Veranstaltung, Lieferanten, Gruppen)
// → Vorschau mit Fehlern/Hinweisen → Korrektur → Buchung (alles oder nichts) → Prüfung in der Datenbank.
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, setup, resetData, createUser, createGroup, addItem, listRecords, enableRateLimits, disableRateLimits,
} from './helpers.mjs';
import { launchBrowser, loginViaUi } from './browser.mjs';
import { MOODLE_CSV } from './fixtures-moodle.mjs';
import { formatSemester, currentSemester } from '../pb_public/core/config.js';

const SEMESTER = formatSemester(currentSemester().term, currentSemester().year);
const COURSE = 'Projektarbeit';

async function seed() {
  await setup();
  await resetData();
  const owner = await createUser('Seed');
  const thema5 = await createGroup('Thema 5', COURSE, SEMESTER);
  await createGroup('Thema 5', 'Andere Veranstaltung', SEMESTER); // darf nicht vorgeschlagen werden
  // steht schon im offenen Reichelt-Korb für Thema 5 → Hinweis in der Vorschau
  await addItem(owner.token, { supplier: 'reichelt', part_number: 'X7R-G0603 100N', name: 'Kerko', qty: 5, group: thema5.id });
  return { thema5: thema5.id, login: await createUser('Moodle-Tester') };
}

const ok = (msg) => console.log('✔', msg);
const { thema5, login } = await seed();
await enableRateLimits();
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-moodle-'));
const csvPath = join(work, 'Bauteilbestellung.csv');
writeFileSync(csvPath, '﻿' + MOODLE_CSV); // Moodle exportiert teils mit BOM
const b = await launchBrowser(join(work, 'profile'));
const imp = `Alpine.$data(document.querySelector('[x-data=moodleImporter]'))`;
const select = (label, value) => b.fill(`[x-data=moodleImporter] select[aria-label="${label}"]`, value);
let failed = false;

try {
  await loginViaUi(b, PB_URL, login.email);
  await b.waitFor(`[...document.querySelectorAll('#view button')].some((e) => e.innerText.includes('Moodle-Import'))`, 'Import-Button');
  await b.clickText('#view button', 'Moodle-Import');
  await b.waitFor(`${imp}.isOpen && window.Papa`, 'Import geöffnet, Papa Parse geladen');
  await b.screenshot('moodle-01-datei');

  await b.setFiles('[x-data=moodleImporter] input[data-moodle-file]', [csvPath]);
  await b.waitFor(`${imp}.step === 'map'`, 'Zuordnung', 10000);
  const counts = await b.evaluate(`[${imp}.rows.length, ${imp}.groupValues.length, ${imp}.supplierValues.length]`);
  if (counts.join() !== '8,5,4') throw new Error('Zeilen/Gruppen/Lieferanten: ' + counts);
  ok('CSV gelesen: 8 Zeilen, 5 Gruppenbezeichnungen, 4 Lieferantenangaben');

  if (await b.evaluate(`${imp}.canPreview()`)) throw new Error('Vorschau ohne Veranstaltung möglich');
  await b.fill('#moodle-course', COURSE);
  await b.waitFor(`${imp}.groupSuggested['Thema 5'] && ${imp}.groupMap['Thema 5'] === 'id:${thema5}'`, 'Vorschlag Thema 5 (richtige Veranstaltung)');
  const tme = await b.evaluate(`JSON.stringify(${imp}.supplierMap.TME)`);
  if (tme !== '{"supplier":"other","supplier_custom_name":"TME"}') throw new Error('TME: ' + tme);
  ok('Vorschläge: gleichnamige Gruppe der Veranstaltung, TME als sonstiger Lieferant');

  await select('Gruppe für Thema 6', 'new');
  await select('Gruppe für Thema 7', 'new');
  await select('Gruppe für Getrennte Gruppen Alle Teilnehmer/innen Dozenten', 'rows');
  await b.waitFor(`${imp}.canPreview()`, 'alle Gruppen zugeordnet');
  await b.screenshot('moodle-02-zuordnung');
  await b.clickText('[x-data=moodleImporter] button', 'Weiter zur Vorschau');
  await b.waitFor(`${imp}.step === 'preview'`, 'Vorschau');

  const errs = await b.evaluate(`JSON.stringify(Object.entries(${imp}.checks).filter(([, c]) => c.errors.length).map(([l, c]) => l + ':' + c.errors.join('/')))`);
  if (errs !== '["6:Gruppe nicht zugeordnet","7:Anzahl „zwei“ ist keine ganze Zahl ≥ 1"]') throw new Error('Fehler: ' + errs);
  if (!/schon im offenen Warenkorb/.test(await b.evaluate(`${imp}.checks[3].warnings.join()`))) throw new Error('Hinweis offener Korb fehlt');
  if (await b.evaluate(`!document.querySelector('[x-data=moodleImporter] .btn-success').disabled`)) throw new Error('Buchen trotz Fehlern möglich');
  ok('Vorschau: Fehler (Gruppe offen, Anzahl ungültig) blockieren, Hinweis auf offenen Korb');
  await b.screenshot('moodle-03-vorschau-fehler');

  await b.fill('[data-line="6"] select[aria-label="Gruppe"]', 'new:Thema 7');
  await b.fill('[data-line="7"] input[aria-label="Anzahl"]', '2');
  await b.fill('[data-line="2"] input[aria-label="Bezeichnung"]', 'Nucleo-Board');
  await b.waitFor(`${imp}.errorCount() === 0`, 'Fehler behoben');
  await b.evaluate('window.confirm = () => true');
  await b.clickText('[x-data=moodleImporter] button', '8 Position(en) buchen');
  await b.waitFor(`!${imp}.isOpen && document.body.innerText.includes('gebucht')`, 'Buchung', 15000);
  const toastText = await b.evaluate(`[...document.querySelectorAll('[role=status], .toast, [x-data] div')].map((e) => e.innerText).find((t) => /Position\\(en\\) in/.test(t)) || ''`);
  ok('gebucht: ' + toastText.split('\n')[0]);

  const groups = await listRecords('groups', `course = "${COURSE}"`);
  const names = groups.map((g) => g.name + '|' + g.semester).sort();
  if (names.join() !== ['Thema 5', 'Thema 6', 'Thema 7'].map((n) => n + '|' + SEMESTER).join()) throw new Error('Gruppen: ' + names);
  const items = await listRecords('order_items');
  const by = (p) => items.find((i) => i.part_number === p);
  if (by('511-NUCLEO-G031K8').qty_ordered !== 7 || by('511-NUCLEO-G031K8').name !== 'Nucleo-Board') throw new Error('NUCLEO: ' + JSON.stringify(by('511-NUCLEO-G031K8')));
  if (by('X7R-G0603 100N').qty_ordered !== 15) throw new Error('X7R: ' + by('X7R-G0603 100N').qty_ordered);
  if (by('700-MAX3485EPA+').qty_ordered !== 2) throw new Error('MAX3485');
  if (!/^Thema 7: 3x$/.test(by('DEBO JT ESP32-C').group_allocation_note)) throw new Error('Dozenten-Zeile: ' + by('DEBO JT ESP32-C').group_allocation_note);
  if (by('MKDS 1-5 3-5.08').group_allocation_note !== 'ohne Gruppe: 1x') throw new Error('ohne Gruppe');
  const tmeOrder = (await listRecords('orders', 'supplier = "other"'))[0];
  if (tmeOrder?.supplier_custom_name !== 'TME') throw new Error('TME-Korb fehlt');
  if (items.some((i) => /Kondensator|Hall-Sensor/.test(i.name))) throw new Error('Kommentar wurde gespeichert');
  ok('Datenbank: neue Gruppen in der Veranstaltung, Mengen zusammengeführt, TME-Korb, Kommentar nicht gespeichert');

  const unexpected = b.problems.filter((p) => !/status of 4\d\d.*(auth-with-otp)/.test(p));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('moodle-fehler').catch(() => {});
} finally {
  await disableRateLimits().catch(() => {});
  await b.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
