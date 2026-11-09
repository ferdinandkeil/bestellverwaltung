// Browser-Durchlauf (headless Chrome über das DevTools-Protokoll, nur Node-Bordmittel).
// Start über:  tests/run.sh --e2e
// Optional:    CHROME_BIN=/pfad/zu/chrome   E2E_SCREENSHOTS=/verzeichnis (speichert PNGs in Handy-Breite)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, setup, resetData, createUser, createGroup, addItem, changeStatus, bookDelivery,
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
  await changeStatus(owner.token, r.order.id, 'advance', { supplier_order_no: 'R-4711' });
  await bookDelivery(owner.token, r.order.id, [{ item: r.item.id, qty: 4 }], 'Paket 1');
  return { groupA: a.id, login: await createUser('E2E Tester') };
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
const ORDER_LINKS = `document.querySelectorAll('#view ul a[href^="#/orders/"]')`;
const BADGE = `document.querySelector('#view .badge').innerText.trim()`;

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
  await b.waitFor(`location.hash === '#/' && ${ORDER_LINKS}.length === 2`, 'Dashboard mit 2 Bestellungen');
  ok('Login → Dashboard mit 2 Bestellungen');
  await b.screenshot('02-dashboard');

  if (await b.evaluate(`!!document.querySelector('#view select')?.offsetParent`)) throw new Error('Filter sollten mobil eingeklappt sein');
  await b.clickText('#view button', 'Filter');
  await b.waitFor(`document.querySelector('#view select')?.offsetParent`, 'Filter aufgeklappt');
  const groupSelect = `[...document.querySelectorAll('#view select')][2]`;
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ${JSON.stringify(groupA)}; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 1`, 'Gruppenfilter');
  await b.waitFor(`[...document.querySelectorAll('#view button')].some((e) => e.innerText.includes('Gruppe A') && e.innerText.includes('✕'))`, 'Filter-Chip');
  await b.screenshot('02b-filter');
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 2`, 'Filter zurücksetzen');
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

  await b.evaluate('window.confirm = () => true');
  await b.clickText('button', 'Als geprüft markieren');
  await b.waitFor(`${BADGE} === 'Geprüft'`, 'Geprüft');
  await b.clickText('button', 'Einen Schritt zurück');
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'zurück');
  ok('Geprüft und einen Schritt zurück');

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

  // Offenen Mouser-Korb bestellen: interne Bestellnummer ist Pflicht und wird normalisiert
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`${ORDER_LINKS}.length === 2`, 'Dashboard');
  await b.evaluate(`[...${ORDER_LINKS}].find((a) => a.innerText.includes('Mouser')).click()`);
  await b.waitFor(`document.querySelector('#internal-order-no')?.offsetParent && ${BADGE} === 'Angefragt'`, 'Detail Mouser');
  await b.clickText('button', 'Als bestellt markieren');
  await b.waitFor(`document.body.innerText.includes('Bitte zuerst die interne Bestellnummer eintragen')`, 'Pflicht-Hinweis');
  await b.fill('#internal-order-no', ' 2026iw04711 ');
  await b.waitFor(`document.querySelector('#internal-order-no').value === '2026IW04711'`, 'normalisiert');
  await b.clickText('button', 'Als bestellt markieren');
  await b.waitFor(`${BADGE} === 'Bestellt'`, 'Bestellt');
  await b.screenshot('05-bestellt');
  await b.navigate(PB_URL + '/#/');
  await b.waitFor(`[...${ORDER_LINKS}].some((a) => a.innerText.includes('2026IW04711'))`, 'Nummer im Dashboard');
  ok('Bestellen nur mit interner Bestellnummer (normalisiert, im Dashboard sichtbar)');

  await b.navigate(PB_URL + '/#/groups');
  await b.waitFor(`document.querySelector('[x-data=groupsView]') && [...document.querySelectorAll('#view li')].some((l) => l.innerText.includes('Gruppe B'))`, 'Gruppenliste');
  await b.evaluate(`[...document.querySelectorAll('#view li')].find((l) => l.innerText.includes('Gruppe B')).click()`);
  await b.waitFor(`document.body.innerText.includes('Anteil')`, 'Projekt-Status');
  const groupItems = await b.evaluate(`document.querySelectorAll('#view section:nth-of-type(2) li').length`);
  if (groupItems !== 2) throw new Error(`Gruppe B: ${groupItems} statt 2 Positionen`);
  ok('Projekt-Status Gruppe B');

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
