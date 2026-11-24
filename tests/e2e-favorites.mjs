// Browser-Durchlauf Favoriten (ARCHITECTURE.md Kap. 4.7): aus einer Bestellung übernehmen (Auswahl, neue Liste)
// → Liste bearbeiten → Übersicht mit Filter „nur eigene und öffentliche“ → in den Warenkorb (Gruppe, Menge, Preis)
// → fremde Liste nur lesen und bestellen → Liste löschen.
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, setup, resetData, createUser, createGroup, addItem, http, listRecords, enableRateLimits, disableRateLimits,
} from './helpers.mjs';
import { launchBrowser, loginViaUi, sleep } from './browser.mjs';

async function seed() {
  await setup();
  await resetData();
  const other = await createUser('Kollegin');
  const g = await createGroup('Gruppe A');
  const a = await addItem(other.token, { supplier: 'reichelt', part_number: 'NE 555 DIP', name: 'Timer', qty: 10, price_unit: 0.31, group: g.id });
  await addItem(other.token, { supplier: 'reichelt', part_number: 'LED 5MM RT', name: 'LED rot', qty: 20 });
  await addItem(other.token, { supplier: 'reichelt', part_number: 'NICHT MITNEHMEN', qty: 1 });
  // Bestellen, damit der Warenkorb danach neu angelegt wird (Favoriten → neuer offener Korb)
  await http('POST', `/api/lab/orders/${a.order.id}/steps`, { token: other.token, json: { step: 'ordered', internal_order_no: '2026IW08001' } });
  const list = (title, isPublic, supplier = 'printus') => http('POST', '/api/collections/favorite_lists/records', {
    token: other.token, json: { owner: other.user.id, title, is_public: isPublic, supplier },
  });
  const pub = await list('Bürobedarf Standard', true);
  await http('POST', '/api/collections/favorite_items/records', {
    token: other.token, json: { list: pub.id, part_number: '892586', name: 'Kopierpapier A4', qty: 5, price_unit: 3.99 },
  });
  const priv = await list('Privatliste', false);
  return { order: a.order.id, group: g.id, pub: pub.id, priv: priv.id, login: await createUser('Favoriten-Tester') };
}

const ok = (msg) => console.log('✔', msg);
const s = await seed();
await enableRateLimits();
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-favorites-'));
const b = await launchBrowser(join(work, 'profile'));
const modal = `document.querySelector('[data-favorites-from-order]')`;
const titles = `[...document.querySelectorAll('#view [data-favorite-list]')].map((e) => e.dataset.favoriteList).join('|')`;
const detailItems = `[...document.querySelectorAll('#view [data-favorite-item]')].map((e) => e.dataset.favoriteItem).join('|')`;
let failed = false;

try {
  await loginViaUi(b, PB_URL, s.login.email);

  // ---- Aus einer (fremden, bestellten) Bestellung übernehmen: Auswahl, neue Liste ----
  await b.navigate(`${PB_URL}/#/orders/${s.order}`);
  await b.clickText('#view button', 'In Favoriten');
  await b.waitFor(`${modal}?.offsetParent && document.querySelectorAll('[data-fav-item]').length === 3`, 'Übernahme-Dialog');
  if (!(await b.evaluate(`document.querySelector('[data-fav-item="NE 555 DIP"]').innerText.includes('Standard 10×')`))) throw new Error('Standardmenge');
  await b.evaluate(`document.querySelector('[data-fav-item="NICHT MITNEHMEN"] input').click()`);
  await b.fill('#fav-new-title', 'Grundausstattung Praktikum');
  await b.evaluate(`[...${modal}.querySelectorAll('label')].find((l) => l.innerText.trim() === 'öffentlich').querySelector('input').click()`);
  await sleep(300); // Einblenden abwarten
  await b.screenshot('fav-01-uebernehmen');
  await b.clickText('[data-favorites-from-order] button', '2 Artikel übernehmen');
  await b.waitFor(`document.querySelector('[data-fav-result]')?.innerText.includes('2 Artikel in „Grundausstattung Praktikum“ übernommen')`, 'Ergebnis');
  ok('Aus Bestellung übernommen: Auswahl, neue öffentliche Liste, Standardmenge');

  await b.clickText('[data-fav-result] a', 'Zur Liste');
  await b.waitFor(`document.querySelector('#view [data-favorite-title]')?.innerText === 'Grundausstattung Praktikum' && ${detailItems} === 'LED 5MM RT|NE 555 DIP'`, 'Liste geöffnet');
  if (!(await b.evaluate(`document.querySelector('[data-favorite-item="NE 555 DIP"]').innerText.includes('zuletzt 0,31')`))) throw new Error('Preis mit Stand fehlt');
  ok('Liste: Artikel nach Bezeichnung sortiert, zuletzt bezahlter Preis mit Stand');

  // erneut übernehmen in die bestehende Liste → keine Dubletten
  await b.navigate(`${PB_URL}/#/orders/${s.order}`);
  await b.clickText('#view button', 'In Favoriten');
  await b.waitFor(`${modal}?.offsetParent && ${modal}.querySelector('select[aria-label=Favoritenliste]')?.offsetParent`, 'eigene Liste als Ziel vorausgewählt');
  await b.clickText('[data-favorites-from-order] button', '3 Artikel übernehmen');
  await b.waitFor(`document.querySelector('[data-fav-result]')?.innerText.includes('1 Artikel in „Grundausstattung Praktikum“ übernommen. 2 stand(en) schon in der Liste')`, 'Ergebnis 2');
  await b.clickText('[data-favorites-from-order] button', 'Schließen');
  ok('Erneute Übernahme in die eigene Liste: nur neue Artikel, keine Dubletten');

  // ---- Übersicht: Filter „nur eigene und öffentliche“ ----
  await b.navigate(`${PB_URL}/#/favorites`);
  await b.waitFor(`${titles} === 'Grundausstattung Praktikum|Bürobedarf Standard'`, 'Übersicht mit Filter');
  await sleep(200);
  await b.screenshot('fav-02-uebersicht');
  await b.evaluate(`document.querySelector('[data-favorites-filter] input').click()`);
  await b.waitFor(`${titles} === 'Grundausstattung Praktikum|Bürobedarf Standard|Privatliste'`, 'alle Listen');
  await b.evaluate('window.__alteSeite = true; location.reload()');
  await b.waitFor(`!window.__alteSeite && ${titles} === 'Grundausstattung Praktikum|Bürobedarf Standard|Privatliste'`, 'Filter gemerkt');
  await b.evaluate(`document.querySelector('[data-favorites-filter] input').click()`);
  await b.waitFor(`${titles} === 'Grundausstattung Praktikum|Bürobedarf Standard'`, 'Filter wieder an');
  ok('Übersicht: voreingestellt eigene und öffentliche Listen, ausgeschaltet alle; Filter wird gemerkt');
  const overflow = await b.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  if (overflow > 0) throw new Error('Seite auf dem Smartphone um ' + overflow + ' px zu breit (Kopfzeile?)');
  ok('Seite passt auf das Smartphone (keine Überbreite)');

  // ---- Eigene Liste bearbeiten ----
  await b.clickText('#view a', 'Grundausstattung Praktikum');
  await b.waitFor(`${detailItems} === 'LED 5MM RT|NICHT MITNEHMEN|NE 555 DIP'`, 'eigene Liste');
  await b.clickText('#view button', '+ Artikel');
  await b.fill('#fav-part', ' led 5mm rt ');
  await b.clickText('[data-favorite-item-form] button', 'Speichern');
  await b.waitFor(`[...document.querySelectorAll('[role=status], .pointer-events-auto')].some((e) => e.innerText.includes('steht schon in dieser Liste'))`, 'Dublette abgelehnt');
  await b.fill('#fav-part', 'SMD 0805 10K');
  await b.fill('#fav-name', 'Widerstand 10k');
  await b.fill('#fav-qty', '50');
  await b.clickText('[data-favorite-item-form] button', 'Speichern');
  await b.waitFor(`${detailItems} === 'LED 5MM RT|NICHT MITNEHMEN|NE 555 DIP|SMD 0805 10K'`, 'Artikel von Hand');
  await b.evaluate(`document.querySelector('[data-favorite-item="NICHT MITNEHMEN"] button').click()`);
  await b.clickText('[data-favorite-item-form] button', 'Entfernen');
  await b.confirmDialog('Entfernen');
  await b.waitFor(`${detailItems} === 'LED 5MM RT|NE 555 DIP|SMD 0805 10K'`, 'Artikel entfernt');
  ok('Eigene Liste: Artikel hinzufügen (Dublette abgelehnt), entfernen');

  // ---- In den Warenkorb: Auswahl, Gruppe für alle, Menge je Zeile ----
  await b.evaluate(`document.querySelector('[data-select-all]').click()`);
  await b.evaluate(`document.querySelector('[data-favorite-item="SMD 0805 10K"] input[type=checkbox]').click()`);
  await b.clickText('#view button', 'In den Warenkorb');
  await b.waitFor(`document.querySelector('[data-cart-form]')?.offsetParent && document.querySelectorAll('[data-cart-row]').length === 2`, 'Warenkorb-Dialog');
  await b.fill('#cart-group-all', s.group);
  await b.fill('[data-cart-row="LED 5MM RT"] input[aria-label=Menge]', '25');
  await sleep(300);
  await b.screenshot('fav-03-warenkorb');
  await b.clickText('[data-cart-form] button', '2 Artikel in den Warenkorb');
  await b.waitFor(`location.hash.startsWith('#/orders/') && document.querySelector('#view [data-status-badge]')?.innerText.trim() === 'Warenkorb'`, 'Warenkorb geöffnet');
  const items = await listRecords('order_items', `order.status = "angefragt"`);
  const by = (p) => items.find((i) => i.part_number === p);
  if (items.length !== 2 || by('LED 5MM RT')?.qty_ordered !== 25 || by('NE 555 DIP')?.qty_ordered !== 10) throw new Error('Warenkorb: ' + JSON.stringify(items.map((i) => [i.part_number, i.qty_ordered])));
  if (by('NE 555 DIP').price_unit !== 0.31 || !by('NE 555 DIP').groups.includes(s.group) || !by('LED 5MM RT').groups.includes(s.group)) throw new Error('Preis/Gruppe: ' + JSON.stringify(items));
  ok('In den Warenkorb: Menge je Zeile, Gruppe für alle, Preis übernommen, danach Warenkorb geöffnet');

  // ---- Fremde öffentliche Liste: nur lesen, aber bestellen ----
  await b.navigate(`${PB_URL}/#/favorites/${s.pub}`);
  await b.waitFor(`${detailItems} === '892586'`, 'fremde Liste');
  const ownerButtons = await b.evaluate(`[...document.querySelectorAll('#view button')].filter((e) => e.offsetParent && /Bearbeiten|\\+ Artikel/.test(e.innerText)).length`);
  if (ownerButtons) throw new Error('Fremde Liste: Bearbeiten sichtbar');
  await b.evaluate(`document.querySelector('[data-favorite-item="892586"] input[type=checkbox]').click()`);
  await b.clickText('#view button', 'In den Warenkorb');
  await b.clickText('[data-cart-form] button', '1 Artikel in den Warenkorb');
  await b.waitFor(`location.hash.startsWith('#/orders/') && document.body.innerText.includes('Printus')`, 'Printus-Warenkorb');
  ok('Fremde Liste: ohne Bearbeiten, aber bestellbar');

  // ---- Eigene Liste löschen ----
  await b.navigate(`${PB_URL}/#/favorites`);
  await b.clickText('#view a', 'Grundausstattung Praktikum');
  await b.clickText('#view button', 'Bearbeiten');
  await b.clickText('[data-favorite-list-edit] button', 'Liste löschen');
  await b.confirmDialog('Löschen');
  await b.waitFor(`location.hash === '#/favorites' && ${titles} === 'Bürobedarf Standard'`, 'Liste gelöscht');
  ok('Eigene Liste gelöscht');

  // Erwartet ist nur die 400er-Antwort auf die absichtliche Dublette.
  const unexpected = b.problems.filter((p) => !/status of 400.*collections\/favorite_items\/records/.test(p));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('fav-fehler').catch(() => {});
} finally {
  await disableRateLimits().catch(() => {});
  await b.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
