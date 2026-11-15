// Browser-Durchlauf Shop-Export: Mouser-Korb → Vorschau (Storno abgezogen) → CSV → Änderung während des Bestellens
// wird erkannt → erneuter Download → „Exportiert & auf ‚Bestellt‘ setzen“. Sichtbarkeit je Shop und Status.
// Würth: Liste für die Bestell-Mail. Printus: Abhakliste (Stand im Browser, Mengenänderung öffnet den Haken).
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, setup, resetData, createUser, createGroup, addItem, http, getRecord, enableRateLimits, disableRateLimits,
} from './helpers.mjs';
import { launchBrowser, loginViaUi, sleep } from './browser.mjs';

async function seed() {
  await setup();
  await resetData();
  const owner = await createUser('Seed');
  const g = await createGroup('Gruppe A');
  const m1 = await addItem(owner.token, { supplier: 'mouser', part_number: '595-SN74HC595N', name: 'Schieberegister', qty: 5, group: g.id });
  await addItem(owner.token, { supplier: 'mouser', part_number: '511-NUCLEO-G031K8', qty: 1, group: g.id });
  const gone = await addItem(owner.token, { supplier: 'mouser', part_number: '667-ERJ-3EKF1001V', name: 'Widerstand', qty: 10, group: g.id });
  await http('PATCH', `/api/collections/order_items/records/${gone.item.id}`, { token: owner.token, json: { qty_cancelled: 10 } });
  await http('PATCH', `/api/collections/order_items/records/${m1.item.id}`, { token: owner.token, json: { qty_cancelled: 2 } });
  const tme = await addItem(owner.token, { supplier: 'tme', part_number: 'INA226AIDGSR', qty: 2, group: g.id });
  const farnell = await addItem(owner.token, { supplier: 'farnell', part_number: '1848687', qty: 3, group: g.id });
  const we = await addItem(owner.token, { supplier: 'wuerth', part_number: '885012207098', qty: 10, group: g.id });
  await addItem(owner.token, { supplier: 'wuerth', part_number: '7447789100', qty: 5, group: g.id });
  const pr = await addItem(owner.token, { supplier: 'printus', part_number: '892586', name: 'Kopierpapier A4', qty: 5 });
  await addItem(owner.token, { supplier: 'printus', part_number: '302491', name: 'Briefumschläge', qty: 1 });
  return {
    printus: pr.order.id,
    owner, group: g.id, mouser: m1.order.id, tme: tme.order.id, farnell: farnell.order.id, wuerth: we.order.id,
    login: await createUser('Export-Tester'),
  };
}

const ok = (msg) => console.log('✔', msg);
const s = await seed();
await enableRateLimits();
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-export-'));
const b = await launchBrowser(join(work, 'profile'));
const exp = `Alpine.$data(document.querySelector('[x-data=shopExporter]'))`;
const BADGE = `document.querySelector('#view [data-status-badge]')?.innerText.trim()`;
const hasExportButton = `[...document.querySelectorAll('#view button')].some((e) => e.innerText.includes('Shop-Export'))`;
let failed = false;

/** Download abfangen: Dateiname und Inhalt des Blob-Links merken. */
const CAPTURE = `(() => {
  window.__downloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download) return click.call(this);
    const name = this.download;
    fetch(this.href).then((r) => r.text()).then((text) => window.__downloads.push({ name, text }));
  };
})()`;

async function openOrder(id) {
  await b.navigate(`${PB_URL}/#/orders/${id}`);
  await b.waitFor(`document.querySelector('[x-data=orderDetailView]') && ${BADGE}`, 'Detail ' + id);
}

try {
  await loginViaUi(b, PB_URL, s.login.email);

  await openOrder(s.farnell);
  await b.waitFor(`document.body.innerText.includes('Als bestellt markieren')`, 'Farnell-Detail');
  if (await b.evaluate(hasExportButton)) throw new Error('Export für Farnell sichtbar (kein verifiziertes Format)');
  await openOrder(s.tme);
  await b.waitFor(hasExportButton, 'Export-Button TME');
  ok('Export nur für Shops mit verifiziertem Format (TME ja, Farnell nein)');

  await openOrder(s.mouser);
  await b.waitFor(hasExportButton, 'Export-Button Mouser');
  await b.evaluate(CAPTURE);
  await b.clickText('#view button', 'Shop-Export');
  await b.waitFor(`${exp}.isOpen && document.querySelector('[data-shop-export]').offsetParent`, 'Export-Dialog');
  const shown = await b.evaluate(`[...document.querySelectorAll('[data-export-lines] li')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())`);
  if (shown.join(' | ') !== '1× 511-NUCLEO-G031K8 ohne Bezeichnung | 3× 595-SN74HC595N Schieberegister') throw new Error('Vorschau: ' + JSON.stringify(shown));
  if (!(await b.evaluate(`document.querySelector('[data-shop-export]').innerText.includes('1 komplett storniert')`))) throw new Error('Hinweis auf Storno fehlt');
  if (!(await b.evaluate(`document.querySelector('[data-export-ordered]').disabled`))) throw new Error('„Bestellt“ vor dem Download möglich');
  ok('Vorschau: Storno abgezogen, komplett stornierte Position entfällt, „Bestellt“ erst nach Download');
  await b.screenshot('export-01-vorschau');

  await b.fill('#export-internal-no', ' 2026iw07001 ');
  await b.clickText('[data-shop-export] button', 'CSV herunterladen');
  await b.waitFor(`window.__downloads.length === 1`, 'Download 1');
  const d1 = await b.evaluate(`window.__downloads[0]`);
  const expected1 = 'Mouser or Manufacturer Part Number,Customer Part Number,Quantity 1,Quantity 2,Quantity 3\r\n' +
    '511-NUCLEO-G031K8,,1,,\r\n595-SN74HC595N,,3,,\r\n';
  if (d1.name !== 'mouser-2026IW07001.csv' || d1.text !== expected1) throw new Error('Download: ' + JSON.stringify(d1));
  ok('CSV im Mouser-Format, Dateiname mit interner Bestellnummer');

  // Während im Shop bestellt wird, ergänzt jemand eine Position → Statuswechsel wird angehalten
  await addItem(s.owner.token, { supplier: 'mouser', part_number: '595-TL072CP', qty: 2, group: s.group });
  await b.clickText('[data-shop-export] button', 'Exportiert');
  await b.waitFor(`document.querySelector('[data-export-changed]').offsetParent && document.querySelectorAll('[data-export-lines] li').length === 3`, 'Änderung erkannt');
  if ((await getRecord('orders', s.mouser)).status !== 'angefragt') throw new Error('Status trotz Änderung gesetzt');
  ok('Änderung seit dem Download erkannt, Status bleibt „angefragt“');
  await b.screenshot('export-02-geaendert');

  await b.clickText('[data-shop-export] button', 'CSV herunterladen');
  await b.waitFor(`window.__downloads.length === 2 && window.__downloads[1].text.includes('595-TL072CP,,2,,')`, 'Download 2');
  await b.fill('#export-supplier-no', 'M-123456');
  await b.clickText('[data-shop-export] button', 'Exportiert');
  await b.confirmDialog('Als bestellt markieren');
  await b.waitFor(`!${exp}.isOpen && ${BADGE} === 'Bestellt'`, 'Bestellt');
  const order = await getRecord('orders', s.mouser);
  if (order.internal_order_no !== '2026IW07001' || order.supplier_order_no !== 'M-123456') throw new Error('Nummern: ' + JSON.stringify(order));
  if (await b.evaluate(hasExportButton)) throw new Error('Export nach „Bestellt“ noch sichtbar');
  ok('Exportiert & bestellt: Status, interne Bestellnummer und Shop-Auftragsnummer gesetzt');
  await b.screenshot('export-03-bestellt');

  // ---- Würth Elektronik: Liste für die Bestell-Mail, Muster ohne interne Bestellnummer ----
  await openOrder(s.wuerth);
  await b.waitFor(hasExportButton, 'Export-Button Würth');
  if (!(await b.evaluate(`document.querySelector('[data-without-internal-no] input').checked`))) {
    throw new Error('Würth: „ohne interne Bestellnummer“ in der Bestellung nicht vorausgewählt');
  }
  await b.clickText('#view button', 'Shop-Export');
  await b.waitFor(`${exp}.isOpen && document.querySelector('[data-export-copy]')?.offsetParent`, 'Würth-Export');
  if (await b.evaluate(`!!document.querySelector('[data-export-download]').offsetParent`)) throw new Error('Würth: CSV-Download sichtbar');
  if (!(await b.evaluate(`document.querySelector('[data-export-without-internal-no] input').checked && document.querySelector('#export-internal-no').disabled`))) {
    throw new Error('Würth: „ohne interne Bestellnummer“ im Export nicht vorausgewählt');
  }
  // Zwischenablage nicht verfügbar → Text markiert zum Kopieren von Hand
  await b.evaluate(`navigator.clipboard.writeText = () => Promise.reject(new Error('verweigert'))`);
  await b.clickText('[data-shop-export] button', 'Liste kopieren');
  await b.waitFor(`document.querySelector('[data-shop-export] textarea')?.offsetParent`, 'Text zum Kopieren von Hand');
  const LIST = ' 5 × 7447789100\n10 × 885012207098'; // sortiert nach Nummer wie die CSV
  const manual = await b.evaluate(`document.querySelector('[data-shop-export] textarea').value`);
  if (manual !== LIST) throw new Error('Liste (von Hand): ' + JSON.stringify(manual));
  // Zwischenablage verfügbar
  await b.evaluate(`window.__clipboard = null; navigator.clipboard.writeText = (t) => { window.__clipboard = t; return Promise.resolve(); }`);
  await b.clickText('[data-shop-export] button', 'Liste kopieren');
  await b.waitFor(`window.__clipboard !== null`, 'kopiert');
  if ((await b.evaluate('window.__clipboard')) !== LIST) throw new Error('Zwischenablage: ' + JSON.stringify(await b.evaluate('window.__clipboard')));
  ok('Würth: Liste „Menge × Nummer“ in die Zwischenablage (sonst markiert zum Kopieren von Hand)');
  await b.screenshot('export-04-wuerth');

  await b.clickText('[data-shop-export] button', 'Exportiert');
  await b.confirmDialog('Als bestellt markieren');
  await b.waitFor(`!${exp}.isOpen && ${BADGE} === 'Bestellt'`, 'Würth bestellt');
  const we = await getRecord('orders', s.wuerth);
  if (we.internal_order_no !== '' || we.without_internal_order_no !== true) throw new Error('Würth: ' + JSON.stringify(we));
  await b.waitFor(`document.body.innerText.includes('Ohne interne Bestellnummer bestellt')`, 'Hinweis in der Bestellung');
  ok('Würth: als Muster ohne interne Bestellnummer bestellt (gespeichert und angezeigt)');

  // ---- Printus: Abhakliste, je Position Haken für Artikelnummer und Menge ----
  const ROW = (part) => `document.querySelector('[data-checklist-row="${part}"]')`;
  const tick = (part, which) => b.evaluate(`${ROW(part)}.querySelector('[data-check-${which}]').click()`);
  const ORDERED_DISABLED = `document.querySelector('[data-export-ordered]').disabled`;
  const openPrintus = async ({ reload = false } = {}) => {
    if (reload) {
      // Seite wirklich neu laden (gleiche URL): erst weiter, wenn das alte Dokument weg ist
      await b.evaluate('window.__alteSeite = true; location.reload()');
      await b.waitFor(`!window.__alteSeite && document.querySelector('[x-data=orderDetailView]') && ${BADGE}`, 'Detail nach dem Neuladen');
    } else {
      await openOrder(s.printus);
    }
    await b.waitFor(hasExportButton, 'Export-Button Printus');
    await b.clickText('#view button', 'Shop-Export');
    await b.waitFor(`${exp}.isOpen && document.querySelector('[data-export-checklist]')?.offsetParent`, 'Printus-Abhakliste');
  };
  await openPrintus();
  if (await b.evaluate(`!!document.querySelector('[data-export-download]').offsetParent || !!document.querySelector('[data-export-copy]').offsetParent || !!document.querySelector('[data-export-lines]').offsetParent`)) {
    throw new Error('Printus: CSV, Mail-Liste oder Vorschau sichtbar');
  }
  const order1 = await b.evaluate(`[...document.querySelectorAll('[data-checklist-row]')].map((e) => e.dataset.checklistRow)`);
  if (order1.join() !== '302491,892586') throw new Error('Printus: Reihenfolge ' + JSON.stringify(order1));
  await b.evaluate(`window.__clipboard = null; navigator.clipboard.writeText = (t) => { window.__clipboard = t; return Promise.resolve(); }`);
  await b.evaluate(`${ROW('892586')}.querySelector('[data-copy-part]').click()`);
  await b.waitFor(`window.__clipboard === '892586' && ${ROW('892586')}.querySelector('[data-copy-part]').innerText.trim() === 'Kopiert'`, 'Nummer kopiert');
  await tick('892586', 'part');
  await tick('302491', 'part');
  await tick('302491', 'qty');
  await b.waitFor(`document.querySelector('[data-checklist-progress]').innerText.includes('2/2 Artikelnummern · 1/2 Mengen')`, 'Fortschritt');
  if (!(await b.evaluate(ORDERED_DISABLED))) throw new Error('Printus: „Bestellt“ vor allen Haken möglich');
  ok('Printus: Abhakliste statt Datei, Nummer kopieren, Haken für Nummer und Menge, „Bestellt“ erst wenn alles abgehakt');
  await sleep(400); // Einblenden des Dialogs abwarten
  await b.screenshot('export-05-printus');

  // Stand bleibt beim Neuladen erhalten; Mengenänderung im Warenkorb öffnet nur den Mengen-Haken
  await tick('892586', 'qty');
  await addItem(s.owner.token, { supplier: 'printus', part_number: '302491', qty: 2 });
  await openPrintus({ reload: true });
  await b.waitFor(`${ROW('302491')}?.innerText.includes('3×')`, 'neue Menge nach dem Neuladen');
  const st = await b.evaluate(`[...document.querySelectorAll('[data-checklist-row]')].map((e) =>
    [e.dataset.checklistRow, e.querySelector('[data-check-part]').checked, e.querySelector('[data-check-qty]').checked].join(':'))`);
  if (st.join() !== '302491:true:false,892586:true:true') throw new Error('Printus nach Neuladen: ' + JSON.stringify(st));
  if (!(await b.evaluate(ORDERED_DISABLED))) throw new Error('Printus: „Bestellt“ trotz geänderter Menge möglich');
  await tick('302491', 'qty');
  await b.waitFor(`!${ORDERED_DISABLED}`, 'alles abgehakt');
  ok('Printus: Haken bleiben beim Neuladen, geänderte Menge muss neu abgehakt werden');

  // Änderung, während der Dialog offen ist → beim „Bestellt“-Setzen erkannt
  await addItem(s.owner.token, { supplier: 'printus', part_number: '423741', qty: 3 });
  await b.fill('#export-internal-no', '2026IW07002');
  await b.clickText('[data-shop-export] button', 'Exportiert');
  await b.waitFor(`document.querySelector('[data-export-changed]').offsetParent && ${ROW('423741')} && ${ORDERED_DISABLED}`, 'Printus: Änderung erkannt');
  await tick('423741', 'part');
  await tick('423741', 'qty');
  await b.clickText('[data-shop-export] button', 'Exportiert');
  await b.confirmDialog('Als bestellt markieren');
  await b.waitFor(`!${exp}.isOpen && ${BADGE} === 'Bestellt'`, 'Printus bestellt');
  if ((await getRecord('orders', s.printus)).internal_order_no !== '2026IW07002') throw new Error('Printus: interne Bestellnummer');
  if (await b.evaluate(`localStorage.getItem('shop-export-checklist:${s.printus}')`) !== null) throw new Error('Printus: Abhakstand nicht aufgeräumt');
  ok('Printus: neue Position während des Übertragens erkannt, danach bestellt und Abhakstand aufgeräumt');

  if (b.problems.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + b.problems.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('export-fehler').catch(() => {});
} finally {
  await disableRateLimits().catch(() => {});
  await b.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
