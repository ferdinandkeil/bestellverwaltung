// Browser-Durchlauf der Lieferschein-Erfassung: synthetischer Reichelt-Lieferschein → „Handyfoto“
// (perspektivisch verzerrt auf dunklem Tisch) → Scanner aus dem Dashboard → Entzerrung, OCR, Abgleich → Buchung.
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PB_URL, MAILPIT_URL, setup, resetData, createUser, addItem, changeStatus, listRecords, admin } from './helpers.mjs';
import { enableRateLimits, disableRateLimits } from './helpers.mjs';
import { launchBrowser, loginViaUi, sleep } from './browser.mjs';

const ORDER_NO = '2026IW01047';
const PARTS = [
  [3, 'XIAO ESP32C6', 'Xiao ESP32C6, WiFi 6 / BT5.0, Zigbee, Thread'],
  [4, 'MKDS 1,5 3 5,08', 'Leiterplattenklemme, 3 polig, RM: 5,08 mm'],
  [2, 'ESP32DEVKITC32E', 'Entwicklungsboard ESP32-WROOM-32E'],
  [3, 'DELOCK 83898', 'USB 2.0 Kabel, A Stecker auf Micro B Stecker'],
  [10, 'WAL WR08X1200FTL', 'SMD-Widerstand, 0805, 120 Ohm, 125 mW, 1%'],
  [10, 'KEM X7R0805 100N', 'Vielschicht-Kerko, 100nF, 50V, 125°C'],
  [20, 'X7R-G0603 100N', 'SMD-Vielschicht, 0603, 100 nF, 10 %, 16 V'],
  [2, 'DEBO JT ESP32-C', 'NodeMCU ESP32 WiFi- und Bluetooth-Modul'],
  [3, 'CL10A106KP8NNNC', 'MLCC, 0603, 10µF, 10V, X5R, ±10%'],
  [6, 'CRCW060310K0 EC', 'SMD Widerstand 0603, 10 kOhm, 100mW, 1%'],
  [3, 'CL10B105KB8NQNC', 'MLCC, 0603, 1µF, 50V, X7R, ±10%'],
  [5, 'STAPELLEISTE 10G', 'Stapelleiste, 10-polig, einreihig'],
];

/** Geliefert, aber beim Erfassen der Bestellung vergessen → wird im Scanner nachgetragen. */
const FORGOTTEN = [2, 'LED 5-4500 RT', 'LED, 5 mm, bedrahtet, rot'];

/** Synthetischer Lieferschein im Layout von Reichelt (keine echten Kundendaten). */
const NOTE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 1240px; height: 1754px; background: #fff; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .logo { position: absolute; left: 700px; top: 80px; font-size: 96px; font-weight: 900; letter-spacing: -2px; }
  .logo small { display: block; font-size: 48px; margin: -18px 0 0 120px; letter-spacing: 0; }
  .muster { position: absolute; left: 140px; top: 330px; font-size: 26px; line-height: 1.4; }
  .title { position: absolute; left: 720px; top: 520px; font-size: 40px; font-weight: bold; }
  .order { position: absolute; left: 140px; top: 600px; font-size: 22px; line-height: 2; }
  table { position: absolute; left: 90px; top: 790px; border-collapse: collapse; font-size: 22px; }
  th { text-align: left; font-weight: normal; padding: 0 30px 14px 0; }
  td { padding: 4px 30px 4px 0; white-space: nowrap; }
  td.q { text-align: right; padding-right: 70px; }
</style></head><body>
  <div class="logo">reichelt<small>elektronik</small></div>
  <div class="muster">MUSTER-HOCHSCHULE<br>Teststraße 1<br>12345 Musterstadt</div>
  <div class="title">Lieferschein</div>
  <div class="order">Bestellnummer<br>${ORDER_NO}</div>
  <table><tr><th>Menge</th><th>Artikelnummer</th><th>Bezeichnung</th></tr>
  ${PARTS.map(([q, p, d]) => `<tr><td class="q">${q}</td><td>${p}</td><td>${d}</td></tr>`).join('')}
  <tr><td class="q">${FORGOTTEN[0]}</td><td>${FORGOTTEN[1]}</td><td>${FORGOTTEN[2]}</td></tr>
  </table>
</body></html>`;

async function seed() {
  await setup();
  await resetData();
  const owner = await createUser('Seed');
  let order;
  for (const [qty, part, name] of PARTS) {
    order = (await addItem(owner.token, { supplier: 'reichelt', part_number: part, name, qty })).order;
  }
  await addItem(owner.token, { supplier: 'reichelt', part_number: 'NICHT GELIEFERT 1', name: 'fehlt auf dem Lieferschein', qty: 1 });
  await changeStatus(owner.token, order.id, 'advance', { internal_order_no: ORDER_NO });
  // Zweite offene Reichelt-Bestellung: Zuordnung muss über die interne Bestellnummer erfolgen.
  const other = await addItem(owner.token, { supplier: 'reichelt', part_number: 'XIAO ESP32C6', name: 'andere Bestellung', qty: 1 });
  await changeStatus(owner.token, other.order.id, 'advance', { internal_order_no: '2026IW00999' });
  return { orderId: order.id, login: await createUser('Scanner-Tester') };
}

/** Erzeugt mit dem Browser ein „Handyfoto“ des synthetischen Lieferscheins. */
async function makePhoto(b, dir) {
  const notePath = join(dir, 'note.png');
  await b.setViewport({ width: 1240, height: 1754 }, false);
  await b.navigate('about:blank');
  await b.evaluate(`document.open(); document.write(${JSON.stringify(NOTE_HTML)}); document.close();`);
  await sleep(300);
  await b.screenshotTo(notePath, 'png');

  const dataUrl = 'data:image/png;base64,' + readFileSync(notePath).toString('base64');
  await b.setViewport({ width: 1500, height: 2000 }, false);
  await b.evaluate(`document.open(); document.write(${JSON.stringify(`<!doctype html><html><body style="margin:0;height:2000px;background:#3b2f25;display:flex;align-items:center;justify-content:center;perspective:2400px">
    <img src="${dataUrl}" style="width:1120px;transform:rotateX(9deg) rotateZ(-5deg) translateY(30px);box-shadow:0 20px 40px rgba(0,0,0,.5)">
  </body></html>`)}); document.close();`);
  await b.waitFor(`document.querySelector('img')?.complete`, 'Foto-Seite');
  await sleep(300);
  const photoPath = join(dir, 'foto.jpg');
  await b.screenshotTo(photoPath, 'jpeg', 88);
  return photoPath;
}

const ok = (msg) => console.log('✔', msg);
const { orderId, login } = await seed();
await enableRateLimits(); // Browser-Durchlauf unter Produktionsbedingungen
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-scanner-'));
const b = await launchBrowser(join(work, 'profile'));
let failed = false;
const scanner = `Alpine.$data(document.querySelector('[x-data=deliveryScanner]'))`;

try {
  const photo = await makePhoto(b, work);
  ok('synthetischen Lieferschein fotografiert (schräg auf dunklem Tisch)');

  await b.setViewport();
  await loginViaUi(b, PB_URL, login.email);
  await b.waitFor(`[...document.querySelectorAll('#view button')].some((e) => e.innerText.includes('Lieferschein scannen'))`, 'Scanner-Button im Dashboard');
  await b.clickText('#view button', 'Lieferschein scannen');
  await b.waitFor(`${scanner}.isOpen && ${scanner}.libState === 'ready'`, 'Bildverarbeitung geladen', 60000);
  ok('Scanner geöffnet, OpenCV/jscanify geladen');
  await b.screenshot('scanner-01-start');

  await b.setFiles('[x-data=deliveryScanner] input[capture]', [photo]);
  await b.waitFor(`${scanner}.step === 'corners'`, 'Eckenprüfung', 30000);
  if (!(await b.evaluate(`${scanner}.cornersDetected`))) throw new Error('Blattkanten wurden nicht erkannt');
  ok('Blattkanten automatisch erkannt');
  await b.screenshot('scanner-02-ecken');

  await b.clickText('[x-data=deliveryScanner] button', 'Übernehmen');
  await b.waitFor(`${scanner}.step === 'pages' && ${scanner}.pages.length === 1`, 'Seite übernommen', 20000);
  ok('Seite entzerrt');
  await b.screenshot('scanner-03-seiten');

  await b.clickText('[x-data=deliveryScanner] button', 'Erkennung starten');
  await b.waitFor(`${scanner}.step === 'review' && ${scanner}.order`, 'Prüfmaske', 120000);
  const selected = await b.evaluate(`${scanner}.selectedOrderId`);
  if (selected !== orderId) throw new Error('Falsche Bestellung zugeordnet: ' + selected);
  const hint = await b.evaluate(`${scanner}.detectedOrderHint`);
  if (!hint.includes('über die interne Bestellnummer ' + ORDER_NO)) throw new Error('Zuordnung nicht über die interne Bestellnummer: ' + hint);
  ok('Bestellung über die interne Bestellnummer gefunden (2 offene Reichelt-Bestellungen)');

  const rows = await b.evaluate(`JSON.parse(JSON.stringify(${scanner}.reviewRows))`);
  const wrong = [];
  for (const [qty, part] of PARTS) {
    const r = rows.find((x) => x.part === part);
    if (!r || r.qty !== qty || r.status === 'missing') wrong.push(`${part}: ${r ? `${r.qty} (${r.status})` : 'fehlt'}`);
  }
  const notDelivered = rows.find((x) => x.part === 'NICHT GELIEFERT 1');
  if (notDelivered.qty !== 0 || notDelivered.status !== 'missing') wrong.push('NICHT GELIEFERT 1 sollte leer bleiben');
  if (wrong.length) throw new Error('Abweichungen:\n  ' + wrong.join('\n  '));
  const checks = rows.filter((r) => r.status === 'check').length;
  ok(`alle 12 Positionen mit richtiger Menge erkannt (${12 - checks} sicher, ${checks} zur Prüfung)`);
  await b.screenshot('scanner-04-pruefen');

  // Problem melden (hier ohne echtes Problem – geprüft wird der Ablauf)
  if (await b.evaluate(`${scanner}.recognitionFailed`)) throw new Error('Erkennung fälschlich als gescheitert eingestuft');
  await b.evaluate(`${scanner}.reviewRows.find((r) => r.part === 'STAPELLEISTE 10G').qty = 4`); // Korrektur von Hand
  await b.clickText('[x-data=deliveryScanner] button', 'Problem melden');
  await b.waitFor(`document.querySelector('[data-scan-report]')?.offsetParent`, 'Meldeformular');
  await b.fill('[data-scan-report] textarea', 'Test-Meldung aus dem Browser-Durchlauf');
  const reportedAt = Date.now();
  await b.clickText('[data-scan-report] button', 'Meldung senden');
  await b.waitFor(`${scanner}.reported`, 'Meldung gesendet', 30000);
  const [report] = await listRecords('scan_reports');
  if (report.photos.length !== 1 || report.order !== orderId || report.note !== 'Test-Meldung aus dem Browser-Durchlauf') {
    throw new Error('Meldung unvollständig: ' + JSON.stringify({ ...report, analysis: undefined }));
  }
  const an = report.analysis;
  const stapel = an.review.find((r) => r.part === 'STAPELLEISTE 10G');
  if (an.profile !== 'reichelt' || an.pages[0].ocr.words.length < 50 || !an.pages[0].cornersAuto || an.rows.length !== 13
      || stapel.recognized !== 5 || stapel.entered !== 4) {
    throw new Error('Analyse-Daten unvollständig: ' + JSON.stringify({ profile: an.profile, words: an.pages[0].ocr?.words.length, rows: an.rows.length, stapel }));
  }
  const mails = await (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('subject:"Problem gemeldet"')}`)).json();
  if (!mails.messages?.some((m) => new Date(m.Created).getTime() >= reportedAt - 2000)) throw new Error('Keine Mail zur Meldung');
  ok(`Problem gemeldet: Originalfoto, ${an.pages[0].ocr.words.length} OCR-Wörter, erkannte + korrigierte Mengen, Mail an Admin`);
  await b.screenshot('scanner-05-gemeldet');
  await b.evaluate(`${scanner}.reviewRows.find((r) => r.part === 'STAPELLEISTE 10G').qty = 5`);

  // Vergessene Position: nicht zugeordnete Zeile als neue Position nachtragen
  const unmatchedParts = await b.evaluate(`JSON.stringify(${scanner}.unmatched.map((u) => u.qty + '×' + u.part))`);
  if (unmatchedParts !== JSON.stringify([FORGOTTEN[0] + '×' + FORGOTTEN[1]])) throw new Error('Nicht zugeordnet: ' + unmatchedParts);
  await b.fill('[data-unmatched="0"] select', '__new');
  await b.waitFor(`document.querySelector('[data-unmatched="0"] input[aria-label^="Bezeichnung"]')?.offsetParent`, 'Felder zum Nachtragen');
  await b.fill('[data-unmatched="0"] input[aria-label^="Bezeichnung"]', 'LED rot');
  await b.screenshot('scanner-06-nachtragen');
  ok('nicht zugeordnete Zeile zum Nachtragen markiert');

  await b.evaluate('window.confirm = () => true');
  await b.clickText('[x-data=deliveryScanner] button', 'Lieferung buchen');
  await b.waitFor(`document.body.innerText.includes('Lieferung mit 13 Position(en) gebucht, davon 1 nachgetragen')`, 'Buchung', 30000);
  const [late] = await listRecords('order_items', `part_number = "${FORGOTTEN[1]}"`);
  if (!late || late.order !== orderId || late.qty_ordered !== 2 || late.qty_delivered !== 2 || !late.added_later_by || late.name !== 'LED rot') {
    throw new Error('Nachgetragene Position: ' + JSON.stringify(late));
  }
  ok('Lieferung gebucht, vergessene Position nachgetragen (gekennzeichnet, bestellt = geliefert = 2)');

  const [delivery] = await listRecords('deliveries', `order = "${orderId}"`);
  if (!/^lieferschein_reichelt_.*\.pdf$/.test(delivery.receipt)) throw new Error('PDF-Beleg fehlt: ' + delivery.receipt);
  const res = await fetch(`${PB_URL}/api/files/deliveries/${delivery.id}/${delivery.receipt}`, { headers: { Authorization: await admin() } });
  const pdfPath = join(work, 'beleg.pdf');
  writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()));
  const check = execFileSync('qpdf', ['--check', pdfPath], { encoding: 'utf8' });
  if (!/No syntax or stream encoding errors/.test(check)) throw new Error('PDF fehlerhaft:\n' + check);
  const order = (await listRecords('orders', `id = "${orderId}"`))[0];
  if (order.status !== 'teilgeliefert') throw new Error('Status sollte teilgeliefert sein: ' + order.status);
  ok(`PDF-Beleg angehängt (${(readFileSync(pdfPath).length / 1024).toFixed(0)} KB, qpdf ok), Status teilgeliefert`);

  const unexpected = b.problems.filter((p) => !/status of 4\d\d.*(auth-with-otp)/.test(p));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('scanner-fehler').catch(() => {});
} finally {
  await disableRateLimits().catch(() => {});
  await b.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
