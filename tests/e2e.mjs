// Browser-Durchlauf (headless Chrome über das DevTools-Protokoll, nur Node-Bordmittel).
// Start über:  tests/run.sh --e2e
// Optional:    CHROME_BIN=/pfad/zu/chrome   E2E_SCREENSHOTS=/verzeichnis (speichert PNGs in Handy-Breite)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, setup, resetData, createUser, createGroup, addItem, markOrdered, bookDelivery,
  enableRateLimits, disableRateLimits,
} from './helpers.mjs';
import { launchBrowser, otpFromMailpit, sleep } from './browser.mjs';

// ---------------------------------------------------------------------------
// Testdaten
// ---------------------------------------------------------------------------
async function seed() {
  await setup();
  await resetData();
  const owner = await createUser('Seed');
  const a = await createGroup('Gruppe A');
  const b = await createGroup('Gruppe B');
  await addItem(owner.token, { supplier: 'mouser', part_number: '595-SN74HC595N', name: 'Schieberegister 8 Bit, DIP-16', qty: 5, group: a.id, price_unit: 0.62 });
  await addItem(owner.token, { supplier: 'mouser', part_number: '595-sn74hc595n', name: 'x', qty: 3, group: b.id });
  const r = await addItem(owner.token, { supplier: 'reichelt', part_number: 'NE 555 DIP', name: 'Timer NE555', qty: 10, group: b.id, price_unit: 0.25 });
  await markOrdered(owner.token, r.order.id, { supplier_order_no: 'R-4711' });
  await bookDelivery(owner.token, r.order.id, [{ item: r.item.id, qty: 4 }], 'Paket 1');
  return { groupA: a.id, login: await createUser('E2E Tester') };
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
const ORDER_LINKS = `document.querySelectorAll('[data-overview-table] tr[data-order]')`; // Zeilen der Übersicht
const CART_LINKS = `document.querySelectorAll('[data-cart-panel] [data-cart]')`; // Warenkörbe im Warenkorb-Symbol
/** Letzte (neueste) Toast-Aktion mit dieser Beschriftung anklicken. */
const TOAST_ACTION = (label) => `[...document.querySelectorAll('[data-toast-action]')].filter((e) => e.innerText.trim() === ${JSON.stringify(label)}).pop()`;
const TOASTS = `[...document.querySelectorAll('[data-toast-action]')].map((e) => e.closest('[data-toast]').innerText).join(' | ')`;
const BADGE = `document.querySelector('#view [data-status-badge]').innerText.trim()`;

const { groupA, login } = await seed();
await enableRateLimits(); // Browser-Durchlauf unter Produktionsbedingungen
const profile = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-'));
const b = await launchBrowser(profile);
let failed = false;
const ok = (msg) => console.log('✔', msg);

try {
  await b.navigate(PB_URL + '/');
  await b.waitFor(`location.hash === '#/login' && document.querySelector('#login-email')`, 'Login-Maske');
  ok('ohne Session → #/login');
  await b.screenshot('01-login');

  const requestedAt = Date.now();
  // Adresse mit anderer Groß-/Kleinschreibung als im Konto (Handy-Autokorrektur, Gewohnheit)
  await b.fill('#login-email', ' ' + login.email[0].toUpperCase() + login.email.slice(1).replace('example.com', 'Example.COM'));
  await b.clickText('button', 'Code anfordern');
  await b.waitFor(`document.querySelector('#login-code')?.offsetParent`, 'Code-Feld');
  const code = await otpFromMailpit(login.email, requestedAt);
  ok('Code angefordert (andere Groß-/Kleinschreibung), OTP-Mail erhalten');

  await b.fill('#login-code', '00000000');
  await b.clickText('button', 'Anmelden');
  await b.waitFor(`document.body.innerText.includes('falsch oder abgelaufen')`, 'Meldung falscher Code');
  ok('falscher Code → Fehlermeldung');

  await sleep(3500); // PocketBase-Ratenbegrenzung für Auth-Anfragen
  await b.fill('#login-code', code);
  await b.clickText('button', 'Anmelden');
  await b.waitFor(`location.hash === '#/' && ${ORDER_LINKS}.length === 1 && ${CART_LINKS}.length === 1 && Number(document.querySelector('[data-cart-count]').innerText) === Alpine.store('carts').count && Alpine.store('carts').count > 0`, 'Startseite: 1 Bestellung, 1 Warenkorb mit Zahl am Symbol');
  if (!(await b.evaluate(`document.querySelector('[data-prominent-action]')?.offsetParent && document.querySelector('[data-prominent-action]').innerText.includes('Lieferschein scannen')`))) {
    throw new Error('Smartphone: „Lieferschein scannen“ nicht als Hauptknopf oben');
  }
  ok('Login → Startseite: Warenkorb-Symbol mit Zahl, 1 Bestellung in der kompakten Tabelle, „Lieferschein scannen“ groß oben');
  await b.screenshot('02-dashboard');

  if (await b.evaluate(`!!document.querySelector('#view select')?.offsetParent`)) throw new Error('Filter sollten mobil eingeklappt sein');
  await b.clickText('#view button', 'Filter');
  await b.waitFor(`document.querySelector('#view select')?.offsetParent`, 'Filter aufgeklappt');
  const groupSelect = `[...document.querySelectorAll('#view select')][2]`;
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ${JSON.stringify(groupA)}; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 0 && document.body.innerText.includes('Keine Bestellungen gefunden')`, 'Gruppenfilter');
  await b.waitFor(`[...document.querySelectorAll('#view button')].some((e) => e.innerText.includes('Gruppe A') && e.innerText.includes('✕'))`, 'Filter-Chip');
  await b.screenshot('02b-filter');
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 1`, 'Filter zurücksetzen');
  ok('Filter mobil eingeklappt, Gruppenfilter mit Chip');

  // Smartphone: Hamburger-Menü mit Navigation und Logout; Warenkorb als fester Knopf unten rechts
  if (await b.evaluate(`!!document.querySelector('[data-cart-button]').offsetParent || !document.querySelector('[data-cart-fab]').getClientRects().length`)) {
    throw new Error('Smartphone: Warenkorb gehört als Knopf unten rechts, nicht in die Kopfzeile');
  }
  await b.evaluate(`document.querySelector('[data-menu-button]').click()`);
  await b.waitFor(`document.querySelector('[data-mobile-menu]')?.offsetParent && document.querySelector('[data-mobile-menu]').innerText.includes('Logout')`, 'Menü offen');
  await b.screenshot('02c-menu');
  await b.evaluate(`[...document.querySelectorAll('[data-mobile-menu] a')].find((a) => a.innerText.includes('Gruppen')).click()`);
  await b.waitFor(`location.hash === '#/groups' && !document.querySelector('[data-mobile-menu]').offsetParent`, 'Gruppen über das Menü, Menü geschlossen');
  // ✕ auf der Seite Warenkörbe führt zur vorigen Ansicht zurück
  await b.evaluate(`document.querySelector('[data-cart-fab]').click()`);
  await b.waitFor(`location.hash === '#/carts' && !document.querySelector('[data-cart-fab]').getClientRects().length`, 'Seite Warenkörbe (ohne Knopf)');
  await b.evaluate(`document.querySelector('[data-carts-close]').click()`);
  await b.waitFor(`location.hash === '#/groups'`, '✕ zurück zu Gruppen');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`${ORDER_LINKS}.length === 1`, 'Startseite');
  ok('Smartphone: Hamburger-Menü, Warenkorb-Knopf unten rechts, ✕ zurück zur vorigen Ansicht');

  // Smartphone: Warenkorb-Knopf öffnet die eigene Seite, dort „+ Position erfassen“
  await b.evaluate(`document.querySelector('[data-cart-fab]').click()`);
  await b.waitFor(`location.hash === '#/carts' && document.querySelector('#view [data-cart]')?.offsetParent`, 'Seite Warenkörbe');
  await b.clickText('#view button', '+ Position erfassen');
  await b.waitFor(`document.querySelector('.modal-panel input[placeholder^="z. B. 595"]')?.offsetParent`, 'Formular');
  await b.screenshot('03-formular');
  await b.fill('.modal-panel input[placeholder^="z. B. 595"]', '595-SN74HC595N');
  await b.fill('.modal-panel input[placeholder^="z. B. Schiebe"]', 'egal');
  await b.fill('.modal-panel input[type=number]', '2');
  await b.clickText('.modal-panel button', 'In Warenkorb');
  await b.waitFor(`document.body.innerText.includes('zusammengeführt (jetzt 10 Stück)')`, 'Merge-Meldung');
  await b.clickText('.modal-panel button', 'Schließen');
  await b.waitFor(`[...document.querySelectorAll('#view [data-cart] li')].some((l) => l.innerText.includes('10 ×') && l.innerText.includes('595-SN74HC595N'))`, 'Warenkorb-Seite zeigt 10 Stück');
  ok('Akzeptanzkriterium: Merge auf 10 Stück, sichtbar auf der Seite Warenkörbe');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`${ORDER_LINKS}.length === 1`, 'zurück zur Startseite');

  // Smartphone: Antippen klappt die Schritte auf, „Positionen & Details“ öffnet die Bestellung
  await b.evaluate(`[...${ORDER_LINKS}].find((r) => r.innerText.includes('Reichelt')).click()`);
  await b.waitFor(`[...document.querySelectorAll('[data-row-details]')].some((d) => d.offsetParent && d.querySelector('[data-step=ordered]')?.dataset.state === 'done')`, 'Zeile aufgeklappt');
  await b.screenshot('03b-aufgeklappt');
  await b.evaluate(`[...document.querySelectorAll('[data-order-details]')].find((a) => a.offsetParent).click()`);
  await b.waitFor(`document.querySelector('[x-data=orderDetailView]') && document.body.innerText.includes('Lieferhistorie')`, 'Detail');
  if ((await b.evaluate(BADGE)) !== 'Teilgeliefert') throw new Error('Status sollte Teilgeliefert sein');
  ok('Zeile aufgeklappt (Schritte), Detail Reichelt (teilgeliefert) über „Positionen & Details“');
  await b.screenshot('04-detail');

  // Lieferung in der Zelle „Geliefert“ (aufgeklappte Zeile): Menge dieser Lieferung → sofort gebucht, mit „Rückgängig“
  const ITEM = (pn) => `[...document.querySelectorAll('[data-items-list] [data-item]')].find((r) => r.dataset.part === ${JSON.stringify(pn)})`;
  await b.evaluate(`${ITEM('NE 555 DIP')}.querySelector('button').click()`);
  await b.waitFor(`${ITEM('NE 555 DIP')}.querySelector('[data-cell=delivered]')?.offsetParent`, 'Zeile aufgeklappt');
  await b.evaluate(`${ITEM('NE 555 DIP')}.querySelector('[data-cell=delivered]').click()`);
  await b.waitFor(`${ITEM('NE 555 DIP')}.querySelector('[data-cell-input=delivered]')?.offsetParent`, 'Liefermenge editierbar');
  await b.evaluate(`(() => { const i = ${ITEM('NE 555 DIP')}.querySelector('[data-cell-input=delivered]'); i.value = '3'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await b.waitFor(`${TOASTS}.includes('Lieferung gebucht: NE 555 DIP +3') && ${ITEM('NE 555 DIP')}.querySelector('[data-item-summary]').innerText.trim() === '7 / 10'`, 'gebucht, geliefert 7');
  const lines = await b.evaluate(`document.querySelectorAll('#view [data-delivery-line]').length`);
  if (lines !== 2) throw new Error(`Lieferhistorie: ${lines} statt 2 Buchungen`);
  ok('Liefermenge in „Geliefert“ eingetragen → sofort gebucht, geliefert 7');

  await b.evaluate(`${ITEM('NE 555 DIP')}.querySelector('[data-cell=delivered]').click()`);
  await b.waitFor(`${ITEM('NE 555 DIP')}.querySelector('[data-deliver-all]')?.offsetParent`, 'Doppelhäkchen');
  await b.evaluate(`${ITEM('NE 555 DIP')}.querySelector('[data-deliver-all]').click()`);
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'Status geliefert');
  ok('Doppelhäkchen „alles geliefert“ → automatisch Geliefert');

  // Verwaltungsschritte ohne Rückfrage: Klick hakt sofort ab, Toast mit „Datum ändern“/„Rückgängig“
  const STEP = (v) => `document.querySelector('#view [data-step=${v}]')`;
  await b.waitFor(`${STEP('invoice_received')} && ${STEP('invoice_received')}.getAttribute('aria-disabled') !== 'true'`, 'Rechnungsschritte freigegeben');
  await b.evaluate(`${STEP('invoice_received')}.click()`);
  await b.waitFor(`${STEP('invoice_received')}.dataset.state === 'done'`, 'Rechnung da erledigt');
  await b.evaluate(`${STEP('invoice_submitted')}.click()`);
  await b.waitFor(`${BADGE} === 'Abgeschlossen' && ${STEP('invoice_signed')}.dataset.state === 'skipped' && ${STEP('closed')}.dataset.state === 'done'`, 'Abgeschlossen');
  if (!(await b.evaluate(`${TOASTS}.includes('Übersprungen: Rechnung unterschrieben')`))) throw new Error('Toast ohne Hinweis auf übersprungene Schritte: ' + await b.evaluate(TOASTS));
  await b.screenshot('04a-ablauf');
  ok('Rechnung da, Rechnung in Verwaltung (unterschrieben übersprungen, im Toast genannt) → Abgeschlossen');

  // Haken entfernen ohne Rückfrage, „Rückgängig“ stellt ihn wieder her
  await b.evaluate(`${STEP('invoice_submitted')}.click()`);
  await b.waitFor(`${BADGE} === 'Geliefert' && ${STEP('invoice_signed')}.dataset.state === 'open'`, 'Haken entfernt');
  if (await b.evaluate(`document.querySelector('#confirm-dialog')?.open`)) throw new Error('Sicherheitsabfrage beim Entfernen');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${BADGE} === 'Abgeschlossen' && ${STEP('invoice_submitted')}.dataset.state === 'done'`, 'Rückgängig');
  await b.evaluate(`${STEP('invoice_submitted')}.click()`);
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'wieder entfernt');
  ok('Haken entfernen ohne Rückfrage; „Rückgängig“ im Toast stellt ihn wieder her');

  // Datum eines erledigten Schritts ändern
  const yesterday = new Date(Date.now() - 86400000);
  // Smartphone: Lupe zeigt Datum und Person, dort „Datum ändern“
  await b.evaluate(`document.querySelector('[data-step-info=invoice_received]').click()`);
  await b.waitFor(`document.querySelector('[data-step-details=invoice_received]')?.offsetParent && document.querySelector('[data-step-details=invoice_received]').innerText.includes('E2E Tester')`, 'Details mit Person');
  await b.evaluate(`document.querySelector('[data-step-date=invoice_received]').click()`);
  await b.waitFor(`document.querySelector('#step-date')?.offsetParent`, 'Datumsdialog');
  await b.fill('#step-date', yesterday.toLocaleDateString('sv-SE'));
  await b.clickText('[data-step-dialog] button', 'Speichern');
  const shownDate = yesterday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await b.waitFor(`document.querySelector('[data-step-details=invoice_received]').innerText.includes(${JSON.stringify(shownDate)})`, 'Datum geändert');
  ok('Datum eines erledigten Schritts geändert');

  // Vergessene Position nachtragen und gleich als geliefert buchen → bleibt „Geliefert“, gekennzeichnet
  await b.clickText('#view button', 'Position nachtragen');
  await b.waitFor(`document.querySelector('#late-part')?.offsetParent`, 'Formular nachtragen');
  await b.fill('#late-part', 'ne 556 dip');
  await b.fill('#late-qty', '2');
  await b.evaluate(`document.querySelector('#late-part').closest('form').querySelector('input[type=checkbox]').click()`);
  await sleep(400); // Einblendung abwarten (nur für den Screenshot)
  await b.screenshot('04b-nachtragen');
  await b.clickText('.modal-panel button', 'Nachtragen');
  await b.waitFor(`${ITEM('NE 556 DIP')}?.textContent.includes('nachgetragen') && ${ITEM('NE 556 DIP')}.textContent.includes('E2E Tester')`, 'nachgetragene Position');
  if ((await b.evaluate(BADGE)) !== 'Geliefert') throw new Error('Status nach Nachtragen: ' + await b.evaluate(BADGE));
  ok('Position nachgetragen und geliefert gebucht – gekennzeichnet, Status bleibt Geliefert');

  // Offenen Mouser-Korb: Formular geschrieben (fehlende interne Bestellnummer → Dialog) → bestellt (Rest übersprungen)
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`${CART_LINKS}.length === 1`, 'Startseite');
  await b.evaluate(`document.querySelector('[data-cart-fab]').click()`);
  await b.waitFor(`location.hash === '#/carts'`, 'Seite Warenkörbe');
  await b.evaluate(`[...document.querySelectorAll('#view [data-cart] a')].find((a) => a.innerText.includes('Mouser')).click()`);
  await b.waitFor(`document.querySelector('[data-field=internal_order_no]')?.offsetParent && ${BADGE} === 'Warenkorb'`, 'Detail Mouser');
  // Kopf: Felder als Text, ein Klick macht sie editierbar, Enter speichert, Escape bricht ab
  const FIELD = (k) => `document.querySelector('[data-field=${k}]')`;
  await b.evaluate(`${FIELD('subject')}.querySelector('[data-field-value]').click()`);
  await b.waitFor(`document.querySelector('#order-subject')?.offsetParent`, 'Feld „Was“ editierbar');
  await b.evaluate(`(() => { const i = document.querySelector('#order-subject'); i.value = 'Schieberegister'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await b.waitFor(`!document.querySelector('#order-subject') && ${FIELD('subject')}.innerText.includes('Schieberegister')`, '„Was“ gespeichert');
  await b.evaluate(`${FIELD('subject')}.querySelector('[data-field-value]').click()`);
  await b.waitFor(`document.querySelector('#order-subject')?.offsetParent`, 'erneut editierbar');
  await b.evaluate(`(() => { const i = document.querySelector('#order-subject'); i.value = 'verworfen'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await b.waitFor(`!document.querySelector('#order-subject') && ${FIELD('subject')}.innerText.includes('Schieberegister')`, 'Escape verwirft');
  ok('Kopf: Feld per Klick editierbar, Enter speichert, Escape verwirft');
  await b.evaluate(`document.querySelector('#view [data-step=form_written]').click()`);
  await b.waitFor(`document.querySelector('#step-internal-no')?.offsetParent`, 'Dialog: nur die fehlende Nummer');
  await b.fill('#step-internal-no', '2026-4711');
  await b.clickText('[data-step-dialog] button', 'Abhaken');
  await b.waitFor(`document.body.innerText.includes('hat das Format JJJJIW#####')`, 'Format-Hinweis');
  await b.fill('#step-internal-no', ' 2026iw04711 ');
  await b.clickText('[data-step-dialog] button', 'Abhaken');
  await b.waitFor(`${BADGE} === 'In Freigabe' && document.querySelector('[data-field=internal_order_no]').innerText.includes('2026IW04711')`, 'In Freigabe, normalisiert');
  if (!(await b.evaluate(`${TOASTS}.includes('Warenkorb geschlossen')`))) throw new Error('Toast ohne Hinweis auf geschlossenen Warenkorb');
  await b.evaluate(`document.querySelector('#view [data-step=ordered]').click()`);
  await b.waitFor(`${BADGE} === 'Bestellt' && document.querySelector('#view [data-step=form_signed]').dataset.state === 'skipped'`, 'Bestellt');
  if (!(await b.evaluate(`${TOASTS}.includes('Übersprungen: Formular unterschrieben, Formular in Verwaltung')`))) throw new Error('Toast: ' + await b.evaluate(TOASTS));
  await b.screenshot('05-bestellt');
  // Nach „bestellt“: Geliefert und Rechnung da gleichzeitig als nächste Schritte; „Geliefert“ bucht den Rest
  const NEXT = `[...document.querySelectorAll('#view [data-step-label]')].filter((e) => e.classList.contains('font-semibold')).map((e) => e.dataset.stepLabel).join()`;
  await b.waitFor(`${NEXT} === 'delivered,invoice_received'`, 'zwei nächste Schritte');
  await b.evaluate(`${STEP('delivered')}.click()`);
  await b.waitFor(`${BADGE} === 'Geliefert' && ${STEP('delivered')}.dataset.state === 'done' && document.body.innerText.includes('Rest vollständig geliefert')`, 'Rest geliefert gebucht');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${BADGE} === 'Bestellt' && ${STEP('delivered')}.dataset.state === 'open' && !document.body.innerText.includes('Rest vollständig geliefert')`, 'Buchung zurückgenommen');
  ok('Nach „bestellt“ zwei nächste Schritte; „Geliefert“ bucht den Rest, „Rückgängig“ nimmt die Buchung zurück');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`[...${ORDER_LINKS}].some((a) => a.innerText.includes('04711') && !a.innerText.includes('2026IW')) && document.querySelector('[data-overview-table] th').parentElement.innerText.includes('Best.-Nr.')`, 'Kurznummer auf der Startseite (Smartphone)');
  ok('Formular geschrieben (Nummer per Dialog, normalisiert), bestellt mit übersprungenen Schritten im Toast');

  // PC: Tabelle mit Schritt-Checkboxen, Abhaken direkt in der Zeile
  await b.setViewport({ width: 1366, height: 900 }, false);
  const ROW = (text) => `[...document.querySelectorAll('[data-overview-table] tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(text)}))`;
  await b.waitFor(`document.querySelector('[data-overview-table]')?.offsetParent && ${ROW('2026IW04711')}`, 'Tabelle');
  // PC: Warenkorb-Symbol klappt das Feld auf (kein Seitenwechsel), Escape schließt es
  await b.evaluate(`document.querySelector('[data-cart-button]').click()`);
  await b.waitFor(`document.querySelector('[data-cart-panel]')?.offsetParent && location.hash === '#/' && [...document.querySelectorAll('[data-cart-panel] button')].some((e) => e.innerText.includes('+ Position erfassen'))`, 'Warenkorb-Feld aufgeklappt');
  await b.screenshot('05-warenkorb-feld');
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await b.waitFor(`!document.querySelector('[data-cart-panel]').offsetParent`, 'Warenkorb-Feld geschlossen');
  ok('PC: Warenkorb-Symbol klappt die Warenkörbe mit Aktionen auf, Escape schließt');
  // PC: Scanner als Symbol in der Kopfzeile statt als Knopf auf der Startseite; Suche in der Filterzeile
  if (await b.evaluate(`!!document.querySelector('[data-prominent-action]')?.offsetParent || [...document.querySelectorAll('#view button')].some((e) => e.offsetParent && e.innerText.includes('Lieferschein scannen'))`)) {
    throw new Error('PC: „Lieferschein scannen“ noch als Knopf auf der Startseite');
  }
  await b.evaluate(`document.querySelector('[data-header-action=delivery-scanner]').click()`);
  await b.waitFor(`[...document.querySelectorAll('h2')].some((h) => h.offsetParent && h.innerText.includes('Lieferschein erfassen'))`, 'Scanner über das Kopfzeilen-Symbol');
  await b.clickText('button', 'Schließen');
  if (!(await b.evaluate(`(() => { const s = document.querySelector('[data-overview-search]').getBoundingClientRect(), g = document.querySelector('#filter-group').getBoundingClientRect(); return s.left > g.right && Math.abs(s.top - g.top) < 2; })()`))) {
    throw new Error('PC: Suche nicht rechts neben den Filtern');
  }
  ok('PC: Scanner als Symbol in der Kopfzeile, Suche rechts neben den Filtern');
  const cell = (step) => `${ROW('2026IW04711')}.querySelector('[data-step=${step}]')`;
  if ((await b.evaluate(`[${cell('form_written')}, ${cell('form_signed')}, ${cell('ordered')}].map((e) => e.dataset.state).join()`)) !== 'done,skipped,done') {
    throw new Error('Tabelle: Zustände der Schritte falsch');
  }
  // Tooltip: nur das Datum, als Sprechblase am Kästchen; offene Kästchen ohne Tooltip
  const TIP = `(getComputedStyle(document.querySelector('[data-tooltip]')).display !== 'none' ? document.querySelector('[data-tooltip]').innerText.trim() : '')`;
  await b.evaluate(`${cell('form_written')}.dispatchEvent(new MouseEvent('mouseenter'))`);
  await sleep(300);
  if (await b.evaluate(TIP)) throw new Error('Tooltip erscheint vor Ablauf der Verzögerung');
  await b.waitFor(`/^\\d{1,2}\\.\\d{1,2}\\.\\d{4}$/.test(${TIP})`, 'Tooltip mit Datum');
  // innerhalb von 1 s zum nächsten Kästchen: sofort
  await b.evaluate(`${cell('form_written')}.dispatchEvent(new MouseEvent('mouseleave')); ${cell('ordered')}.dispatchEvent(new MouseEvent('mouseenter'))`);
  if (!(await b.evaluate(TIP))) throw new Error('Folgetooltip nicht sofort');
  await b.screenshot('05a-tooltip');
  await b.evaluate(`${cell('ordered')}.dispatchEvent(new MouseEvent('mouseleave')); ${cell('invoice_signed')}.dispatchEvent(new MouseEvent('mouseenter'))`);
  await b.waitFor(`${TIP} === ''`, 'kein Tooltip am offenen Kästchen');
  await b.evaluate(`${cell('invoice_signed')}.dispatchEvent(new MouseEvent('mouseleave'))`);
  ok('Tooltip am Kästchen zeigt nur das Datum, erst nach Verzögerung, Folgetooltip sofort');

  // PC, Ablauf in der Bestellung: Verweilen über der Beschriftung → blau, unterstrichen, Stift; Klick → Datumsdialog
  await b.evaluate(`${ROW('2026IW04711')}.querySelector('a').click()`);
  await b.waitFor(`document.querySelector('[data-step-label=ordered]')?.offsetParent`, 'Bestellung (PC)');
  const EDIT = `getComputedStyle(document.querySelector('[data-step-edit=ordered]')).opacity === '1'`;
  await b.evaluate(`document.querySelector('[data-step-label=ordered]').dispatchEvent(new MouseEvent('mouseenter'))`);
  await sleep(200);
  if (await b.evaluate(EDIT)) throw new Error('Stift erscheint vor Ablauf der Wartezeit');
  await b.waitFor(`${EDIT} && document.querySelector('[data-step-label=ordered]').classList.contains('text-blue-700') && document.querySelector('[data-step-label=ordered]').contains(document.querySelector('[data-step-edit=ordered]'))`, 'Stift nach Verweilen (im selben Knopf)');
  await b.evaluate(`document.querySelector('[data-step-label=ordered]').click()`);
  await b.waitFor(`document.querySelector('#step-date')?.offsetParent`, 'Datumsdialog über die Beschriftung');
  await b.clickText('[data-step-dialog] button', 'Abbrechen');
  await b.evaluate(`document.querySelector('[data-step-label=ordered]').dispatchEvent(new MouseEvent('mouseleave'))`);
  await b.waitFor(`!(${EDIT})`, 'Stift weg nach Verlassen');
  // warm wie Tooltips: innerhalb von 1 s die nächste Beschriftung → sofort
  const EDIT2 = `getComputedStyle(document.querySelector('[data-step-edit=form_written]')).opacity === '1'`;
  await b.evaluate(`document.querySelector('[data-step-label=form_written]').dispatchEvent(new MouseEvent('mouseenter'))`);
  if (!(await b.evaluate(EDIT2))) throw new Error('Bearbeiten nicht sofort (warm)');
  await b.evaluate(`document.querySelector('[data-step-label=form_written]').dispatchEvent(new MouseEvent('mouseleave'))`);
  ok('PC: Beschriftung nach Verweilen blau mit Stift, Klick ändert das Datum');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`document.querySelector('[data-overview-table]')?.offsetParent && ${ROW('2026IW04711')}`, 'zurück zur Tabelle');
  await b.evaluate(`${cell('invoice_received')}.click()`);
  await b.waitFor(`${cell('invoice_received')}.dataset.state === 'done'`, 'in der Tabelle abgehakt');
  await b.screenshot('05a-tabelle');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${cell('invoice_received')}.dataset.state === 'open'`, 'Rückgängig in der Tabelle');
  ok('PC: Tabelle mit Schritt-Checkboxen (Haken, Strich, leer), Abhaken in der Zeile, Rückgängig');

  // PC: Positionen als Tabelle – eine Zeile je Gruppe, Storno über die Spalte „Bestellt“ (Mouser, bestellt)
  const PC_ITEM = (pn) => `[...document.querySelectorAll('[data-items-table] [data-item]')].find((r) => r.dataset.part === ${JSON.stringify(pn)})`;
  const mouserId = await b.evaluate(`(async () => { const { pb } = await import('/core/pb.js'); return (await pb.collection('orders').getFirstListItem('internal_order_no = "2026IW04711"')).id; })()`);
  await b.navigate(PB_URL + '/#/orders/' + mouserId);
  await b.waitFor(`${PC_ITEM('595-SN74HC595N')}?.offsetParent`, 'Positionstabelle');
  const groupsShown = await b.evaluate(`[...${PC_ITEM('595-SN74HC595N')}.querySelectorAll('[data-group]')].map((g) => g.innerText.trim()).join()`);
  if (!groupsShown.includes('Gruppe A') || !groupsShown.includes('Gruppe B')) throw new Error('Gruppenzeilen: ' + groupsShown);
  if ((await b.evaluate(`${PC_ITEM('595-SN74HC595N')}.querySelectorAll('tr').length`)) < 2) throw new Error('keine eigene Zeile je Gruppe');
  await b.evaluate(`${PC_ITEM('595-SN74HC595N')}.querySelector('[data-cell=qty_cancelled]').click()`);
  await b.waitFor(`${PC_ITEM('595-SN74HC595N')}.querySelector('[data-cell-input=qty_cancelled]')`, 'Feld „storniert“');
  await b.evaluate(`(() => { const i = ${PC_ITEM('595-SN74HC595N')}.querySelector('[data-cell-input=qty_cancelled]'); i.value = '2'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await b.waitFor(`${PC_ITEM('595-SN74HC595N')}.querySelector('[data-cell=qty_cancelled]')?.innerText.replace(/\\s+/g, '') === '10−2' && ${PC_ITEM('595-SN74HC595N')}.querySelector('[data-open]').innerText.trim() === '8'`, 'Storno 2, offen 8');
  await b.screenshot('05b-positionen-pc');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${PC_ITEM('595-SN74HC595N')}.querySelector('[data-cell=qty_cancelled]')?.innerText.trim() === '10'`, 'Storno zurückgenommen');
  ok('PC: Positionen mit einer Zeile je Gruppe; Storno per Klick auf „Bestellt“, „Rückgängig“');

  // PC: Warenkorb – Klick macht die Zeile zur Eingabezeile (Enter speichert), Löschen sofort mit „Rückgängig“
  const conrad = await addItem(login.token, { supplier: 'farnell', part_number: 'C-100', name: 'Kabel', qty: 2, group: groupA });
  await b.navigate(PB_URL + '/#/orders/' + conrad.order.id);
  await b.waitFor(`${PC_ITEM('C-100')}?.offsetParent`, 'Warenkorb Conrad');
  await b.evaluate(`${PC_ITEM('C-100')}.querySelector('[data-cell=qty_ordered]').click()`);
  await b.waitFor(`${PC_ITEM('C-100')}.querySelector('[data-cell-input=qty_ordered]')?.offsetParent && !${PC_ITEM('C-100')}.querySelector('[data-cell-input=name]')`, 'nur diese Zelle editierbar');
  await b.evaluate(`(() => { const i = ${PC_ITEM('C-100')}.querySelector('[data-cell-input=qty_ordered]'); i.value = '4'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await b.waitFor(`!${PC_ITEM('C-100')}.querySelector('[data-cell-input=qty_ordered]') && ${PC_ITEM('C-100')}.querySelector('[data-cell=qty_ordered]').innerText.trim() === '4'`, 'Menge gespeichert');
  await b.evaluate(`${PC_ITEM('C-100')}.querySelector('[data-item-delete]').click()`);
  await b.waitFor(`!${PC_ITEM('C-100')}`, 'sofort ausgeblendet');
  if (await b.evaluate(`document.querySelector('#confirm-dialog')?.open`)) throw new Error('Sicherheitsabfrage beim Löschen');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${PC_ITEM('C-100')}?.offsetParent`, 'wieder eingeblendet');
  // Warenkorb löschen: sofort zur Startseite, „Rückgängig“ führt zurück
  await b.clickText('#view button', 'Warenkorb löschen');
  await b.waitFor(`location.hash === '#/' && ${TOASTS}.includes('Warenkorb Farnell gelöscht')`, 'Warenkorb gelöscht (Toast)');
  if (await b.evaluate(`document.querySelector('#confirm-dialog')?.open`)) throw new Error('Sicherheitsabfrage beim Warenkorb');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`location.hash === '#/orders/${conrad.order.id}' && ${PC_ITEM('C-100')}?.offsetParent`, 'zurück im Warenkorb');
  await b.setViewport();
  ok('PC: Warenkorb – Klick bearbeitet nur die Zelle (Enter); Position und Warenkorb löschen ohne Rückfrage mit „Rückgängig“');

  await b.navigate(PB_URL + '/#/groups');
  await b.waitFor(`document.querySelector('[x-data=groupsView]') && [...document.querySelectorAll('#view li')].some((l) => l.innerText.includes('Gruppe B'))`, 'Gruppenliste');
  await b.evaluate(`[...document.querySelectorAll('#view li')].find((l) => l.innerText.includes('Gruppe B')).click()`);
  // Auf die geladenen Positionen warten – „Anteil“ steht auch im festen Erklärtext und taugt nicht als Signal.
  const GROUP_ITEMS = `document.querySelectorAll('#view section:nth-of-type(2) li')`;
  try {
    await b.waitFor(`!Alpine.$data(document.querySelector('[x-data=groupsView]')).loadingItems && ${GROUP_ITEMS}.length === 2`, 'Projekt-Status');
  } catch (_) {
    throw new Error(`Gruppe B: ${await b.evaluate(`${GROUP_ITEMS}.length`)} statt 2 Positionen`);
  }
  ok('Projekt-Status Gruppe B');

  // Schneller Wechsel A → B, die Antwort für A kommt zuletzt: es bleiben die Positionen von B stehen
  await b.evaluate(`(() => {
    const orig = window.fetch;
    window.__restoreFetch = () => { window.fetch = orig; };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const slow = url.includes('order_items') && url.includes(${JSON.stringify(groupA)});
      return slow ? new Promise((r) => setTimeout(r, 1500)).then(() => orig(input, init)) : orig(input, init);
    };
  })()`);
  await b.evaluate(`[...document.querySelectorAll('#view li')].find((l) => l.innerText.includes('Gruppe A')).click()`);
  await b.evaluate(`[...document.querySelectorAll('#view li')].find((l) => l.innerText.includes('Gruppe B')).click()`);
  await sleep(2500); // verzögerte Antwort für A ist eingetroffen
  await b.evaluate('window.__restoreFetch()');
  const shown = await b.evaluate(`JSON.stringify([document.querySelector('#view section:nth-of-type(2) h2')?.innerText, ${GROUP_ITEMS}.length])`);
  if (shown !== JSON.stringify(['Gruppe B', 2])) throw new Error('Nach schnellem Wechsel angezeigt: ' + shown);
  ok('schneller Gruppenwechsel: späte Antwort der vorigen Gruppe wird verworfen');

  // Gruppe über die Oberfläche anlegen: Vorschlag der Veranstaltung, aktuelles Semester vorausgewählt
  await b.clickText('#view button', '+ Gruppe');
  await b.waitFor(`document.querySelector('#group-course')?.offsetParent`, 'Gruppenformular');
  const suggestions = await b.evaluate(`[...document.querySelectorAll('#known-courses option')].map((o) => o.value)`);
  if (!suggestions.includes('Elektronik-Projekt')) throw new Error('Veranstaltung wird nicht vorgeschlagen: ' + suggestions);
  const year = await b.evaluate(`document.querySelectorAll('.modal-panel select')[1].value`);
  if (!year) throw new Error('Semesterjahr nicht vorausgewählt');
  await b.fill('#group-course', 'Elektronik-Projekt');
  await b.fill('#group-name', 'gruppe a');
  await b.evaluate(`(() => { const s = document.querySelectorAll('.modal-panel select'); s[0].value = 'WS'; s[0].dispatchEvent(new Event('change')); s[1].value = '2026'; s[1].dispatchEvent(new Event('change')); })()`);
  await b.clickText('.modal-panel button', 'Speichern');
  await b.waitFor(`document.body.innerText.includes('existiert bereits')`, 'Dublette abgelehnt');
  await b.fill('#group-name', 'Gruppe C');
  await b.clickText('.modal-panel button', 'Speichern');
  await b.waitFor(`[...document.querySelectorAll('#view h2')].some((h) => h.innerText === 'Elektronik-Projekt (WS 2026/27)') && document.body.innerText.includes('Gruppe C')`, 'neue Gruppe in Liste');
  ok('Gruppe anlegen: Vorschlag, Semesterauswahl, Dublette abgelehnt');
  await b.screenshot('05-gruppen');

  // Erwartet sind nur die 400er-Antworten auf den absichtlich falschen Code und die absichtliche Dublette.
  const expected = [/status of 400.*auth-with-otp/, /status of 400.*collections\/groups\/records/];
  const unexpected = b.problems.filter((p) => !expected.some((re) => re.test(p)));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('fehler').catch(() => {});
} finally {
  await disableRateLimits().catch(() => {});
  await b.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
