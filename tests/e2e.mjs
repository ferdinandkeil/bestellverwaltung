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
const ORDER_LINKS = `document.querySelectorAll('#view ul a[href^="#/orders/"]')`; // Karten (Smartphone)
const CART_LINKS = `document.querySelectorAll('#view [data-cart]')`;
/** Letzte (neueste) Toast-Aktion mit dieser Beschriftung anklicken. */
const TOAST_ACTION = (label) => `[...document.querySelectorAll('[data-toast-action]')].filter((e) => e.innerText.trim() === ${JSON.stringify(label)}).pop()`;
const TOASTS = `[...document.querySelectorAll('[data-toast-action]')].map((e) => e.closest('div').innerText).join(' | ')`;
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
  await b.waitFor(`location.hash === '#/' && ${ORDER_LINKS}.length === 1 && ${CART_LINKS}.length === 1`, 'Startseite: 1 Bestellung, 1 Warenkorb');
  if (!(await b.evaluate(`document.querySelector('[data-prominent-action]')?.offsetParent && document.querySelector('[data-prominent-action]').innerText.includes('Lieferschein scannen')`))) {
    throw new Error('Smartphone: „Lieferschein scannen“ nicht als Hauptknopf oben');
  }
  ok('Login → Startseite: Warenkorb in der Leiste, 1 Bestellung als Karte, „Lieferschein scannen“ groß oben');
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

  await b.clickText('button', '+ Position erfassen');
  await b.waitFor(`document.querySelector('.modal-panel input[placeholder^="z. B. 595"]')?.offsetParent`, 'Formular');
  await b.screenshot('03-formular');
  await b.fill('.modal-panel input[placeholder^="z. B. 595"]', '595-SN74HC595N');
  await b.fill('.modal-panel input[placeholder^="z. B. Schiebe"]', 'egal');
  await b.fill('.modal-panel input[type=number]', '2');
  await b.clickText('.modal-panel button', 'In Warenkorb');
  await b.waitFor(`document.body.innerText.includes('zusammengeführt (jetzt 10 Stück)')`, 'Merge-Meldung');
  await b.clickText('.modal-panel button', 'Schließen');
  ok('Akzeptanzkriterium: Merge auf 10 Stück');

  await b.evaluate(`[...${ORDER_LINKS}].find((a) => a.innerText.includes('Reichelt')).click()`);
  await b.waitFor(`document.querySelector('[x-data=orderDetailView]') && document.body.innerText.includes('Lieferhistorie')`, 'Detail');
  if ((await b.evaluate(BADGE)) !== 'Teilgeliefert') throw new Error('Status sollte Teilgeliefert sein');
  ok('Detail Reichelt (teilgeliefert)');
  await b.screenshot('04-detail');

  await b.clickText('button', '+1');
  await b.clickText('button', '+1');
  await b.clickText('button', '+1');
  await b.waitFor(`document.body.innerText.includes('+3 …')`, 'Sammelanzeige');
  await b.waitFor(`[...document.querySelectorAll('#view dd')][1]?.innerText === '7'`, 'geliefert = 7', 6000);
  const lines = await b.evaluate(`document.querySelectorAll('#view section li ul li').length`);
  if (lines !== 2) throw new Error(`Lieferhistorie: ${lines} statt 2 Buchungen`);
  ok('3× „+1“ → eine Buchung, geliefert 7');

  await b.clickText('button', 'Rest komplett');
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'Status geliefert', 6000);
  ok('„Rest komplett“ → automatisch Geliefert');

  // Verwaltungsschritte ohne Rückfrage: Klick hakt sofort ab, Toast mit „Datum ändern“/„Rückgängig“
  const STEP = (v) => `document.querySelector('#view [data-step=${v}]')`;
  await b.waitFor(`${STEP('invoice_received')}?.disabled === false`, 'Rechnungsschritte freigegeben');
  await b.clickText('#view button[data-next-step]', '✓ Rechnung da');
  await b.waitFor(`${STEP('invoice_received')}.dataset.state === 'done' && document.querySelector('[data-order-steps]').innerText.includes('E2E Tester')`, 'Rechnung da erledigt');
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
  await b.evaluate(`document.querySelector('[data-step-date=invoice_received]').click()`);
  await b.waitFor(`document.querySelector('#step-date')?.offsetParent`, 'Datumsdialog');
  await b.fill('#step-date', yesterday.toLocaleDateString('sv-SE'));
  await b.clickText('[data-step-dialog] button', 'Speichern');
  const shownDate = yesterday.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await b.waitFor(`document.querySelector('[data-step-date=invoice_received]').innerText.includes(${JSON.stringify(shownDate)})`, 'Datum geändert');
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
  await b.waitFor(`[...document.querySelectorAll('#view li')].some((l) => l.innerText.includes('NE 556 DIP') && l.innerText.includes('nachgetragen') && l.innerText.includes('E2E Tester'))`, 'nachgetragene Position');
  if ((await b.evaluate(BADGE)) !== 'Geliefert') throw new Error('Status nach Nachtragen: ' + await b.evaluate(BADGE));
  ok('Position nachgetragen und geliefert gebucht – gekennzeichnet, Status bleibt Geliefert');

  // Offenen Mouser-Korb: Formular geschrieben (fehlende interne Bestellnummer → Dialog) → bestellt (Rest übersprungen)
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`${CART_LINKS}.length === 1`, 'Startseite');
  await b.evaluate(`[...${CART_LINKS}].find((a) => a.innerText.includes('Mouser')).click()`);
  await b.waitFor(`document.querySelector('#internal-order-no')?.offsetParent && ${BADGE} === 'Warenkorb'`, 'Detail Mouser');
  await b.clickText('#view button[data-next-step]', '✓ Formular geschrieben');
  await b.waitFor(`document.querySelector('#step-internal-no')?.offsetParent`, 'Dialog: nur die fehlende Nummer');
  await b.fill('#step-internal-no', '2026-4711');
  await b.clickText('[data-step-dialog] button', 'Abhaken');
  await b.waitFor(`document.body.innerText.includes('hat das Format JJJJIW#####')`, 'Format-Hinweis');
  await b.fill('#step-internal-no', ' 2026iw04711 ');
  await b.clickText('[data-step-dialog] button', 'Abhaken');
  await b.waitFor(`${BADGE} === 'In Freigabe' && document.querySelector('#internal-order-no').value === '2026IW04711'`, 'In Freigabe, normalisiert');
  if (!(await b.evaluate(`${TOASTS}.includes('Warenkorb geschlossen')`))) throw new Error('Toast ohne Hinweis auf geschlossenen Warenkorb');
  await b.evaluate(`document.querySelector('#view [data-step=ordered]').click()`);
  await b.waitFor(`${BADGE} === 'Bestellt' && document.querySelector('#view [data-step=form_signed]').dataset.state === 'skipped'`, 'Bestellt');
  if (!(await b.evaluate(`${TOASTS}.includes('Übersprungen: Formular unterschrieben, Formular in Verwaltung')`))) throw new Error('Toast: ' + await b.evaluate(TOASTS));
  await b.screenshot('05-bestellt');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`[...${ORDER_LINKS}].some((a) => a.innerText.includes('2026IW04711'))`, 'Nummer auf der Startseite');
  ok('Formular geschrieben (Nummer per Dialog, normalisiert), bestellt mit übersprungenen Schritten im Toast');

  // PC: Tabelle mit Schritt-Checkboxen, Abhaken direkt in der Zeile
  await b.setViewport({ width: 1366, height: 900 }, false);
  const ROW = (text) => `[...document.querySelectorAll('[data-overview-table] tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(text)}))`;
  await b.waitFor(`document.querySelector('[data-overview-table]')?.offsetParent && ${ROW('2026IW04711')}`, 'Tabelle');
  const cell = (step) => `${ROW('2026IW04711')}.querySelector('[data-step=${step}]')`;
  if ((await b.evaluate(`[${cell('form_written')}, ${cell('form_signed')}, ${cell('ordered')}].map((e) => e.dataset.state).join()`)) !== 'done,skipped,done') {
    throw new Error('Tabelle: Zustände der Schritte falsch');
  }
  await b.evaluate(`${cell('invoice_received')}.click()`);
  await b.waitFor(`${cell('invoice_received')}.dataset.state === 'done'`, 'in der Tabelle abgehakt');
  await b.screenshot('05a-tabelle');
  await b.evaluate(`${TOAST_ACTION('Rückgängig')}.click()`);
  await b.waitFor(`${cell('invoice_received')}.dataset.state === 'open'`, 'Rückgängig in der Tabelle');
  await b.setViewport();
  ok('PC: Tabelle mit Schritt-Checkboxen (Haken, Strich, leer), Abhaken in der Zeile, Rückgängig');

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
