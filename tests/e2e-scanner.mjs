// Browser-Durchlauf der Lieferschein-Erfassung: synthetischer Reichelt-Lieferschein → „Handyfoto“
// (perspektivisch verzerrt auf dunklem Tisch) → Scanner aus dem Dashboard → Entzerrung, OCR, Abgleich → Buchung.
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PB_URL, MAILPIT_URL, setup, resetData, createUser, addItem, markOrdered, listRecords, admin } from './helpers.mjs';
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
const noteHtml = ({ logo, orderNo, rows }) => `<!doctype html><html><head><meta charset="utf-8"><style>
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
  <div class="logo">${logo}</div>
  <div class="muster">MUSTER-HOCHSCHULE<br>Teststraße 1<br>12345 Musterstadt</div>
  <div class="title">Lieferschein</div>
  <div class="order">Bestellnummer<br>${orderNo}</div>
  <table><tr><th>Menge</th><th>Artikelnummer</th><th>Bezeichnung</th></tr>
  ${rows.map(([q, p, d]) => `<tr><td class="q">${q}</td><td>${p}</td><td>${d}</td></tr>`).join('')}
  </table>
</body></html>`;
const NOTE_HTML = noteHtml({ logo: 'reichelt<small>elektronik</small>', orderNo: ORDER_NO, rows: [...PARTS, FORGOTTEN] });
/** Lieferschein ohne Bestellung im System (Direktkauf) → Bestellung daraus anlegen. */
const DIRECT_NO = '2026IW08888';
const DIRECT_HTML = noteHtml({
  logo: 'reichelt<small>elektronik</small>', orderNo: DIRECT_NO,
  rows: [[1, 'CLI-581 C', 'Tintenpatrone cyan'], [4, 'KEM X7R0805 100N', 'Vielschicht-Kerko, 100nF']],
});
/** Lieferant ohne Profil → Lieferschein in die Ablage. */
const UNKNOWN_HTML = noteHtml({
  logo: 'Musterteile<small>Versand</small>', orderNo: 'unbekannt',
  rows: [[2, 'MT-4711', 'Beispielteil']],
});

/**
 * Synthetischer Lieferschein im Layout von Mouser (A4 quer, gerahmte Tabelle, Mengen klein und allein in den Zellen,
 * wie im Original ≈ 6,5 pt). Gerendert mit 300 dpi, damit der Pfad mit voller Auflösung durchlaufen wird.
 */
const MOUSER_NO = '2026IW09876';
const MOUSER_ROWS = [ // [Mouser-Nr., bestellt, geliefert, ausstehend]
  ['595-SN74HC595N', 10, 10, 0], ['511-LD1117S33TR', 4, 4, 0], ['81-GRM188R71H104KA3D', 100, 100, 0],
  ['710-885012206046', 25, 20, 5], ['652-3362P-1-103LF', 3, 3, 0], ['621-1N4148W-F', 50, 50, 0],
];
const MOUSER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: 297mm; height: 210mm; background: #fff; font-family: Arial, Helvetica, sans-serif; color: #000; zoom: 3.125; position: relative; }
  div { position: absolute; }
  .t { left: 0; right: 0; top: 9mm; text-align: center; font-weight: bold; font-size: 11pt; }
  .logo { left: 22mm; top: 20mm; font-size: 30pt; font-weight: 900; }
  .send { left: 22mm; top: 40mm; font-size: 6pt; font-weight: bold; line-height: 1.25; }
  .ship { left: 98mm; top: 33mm; font-size: 8pt; line-height: 1.3; }
  .po { right: 14mm; top: 40mm; width: 72mm; border: .3mm solid #000; text-align: center; font-size: 6.5pt; font-weight: bold; padding: 1mm 0; }
  table { position: absolute; left: 12mm; top: 70mm; width: 273mm; border-collapse: collapse; }
  th, td { border: .3mm solid #000; vertical-align: top; }
  th { background: #bbb; font-size: 7pt; text-align: left; padding: .6mm 1mm; height: 9mm; }
  td { height: 15mm; font-size: 8pt; line-height: 1.12; padding: .5mm 1mm; }
  td.q { width: 18mm; text-align: right; font-size: 6.5pt; padding: .5mm .8mm; }
</style></head><body>
  <div class="t">LIEFERSCHEIN / PACKING LIST</div>
  <div class="logo">MOUSER</div>
  <div class="send">Mouser Electronics Inc<br>1000 N. Main Street<br>Mansfield , TX, 76063<br>Ph. (800) 346-6873</div>
  <div class="ship"><u>Versand an: / SHIP TO:</u><br>MUSTER-HOCHSCHULE<br>TESTSTRASSE 1<br>12345 MUSTERSTADT</div>
  <div class="po">Bestellnummer / Purchase Order Number:<br>${MOUSER_NO}</div>
  <table><tr><th style="width:8mm">Nr.<br>LN</th><th>Mouser-Teilenummer / Mouser Part Number<br>Beschreibung / Description</th><th style="width:26mm">Datecode<br>Lot Code</th>
    <th>Bestellte Menge<br>Quantity Ordered</th><th>Gelieferte Menge<br>Quantity Shipped</th><th>Austehende Menge<br>Quantity Pending</th></tr>
  ${MOUSER_ROWS.map(([part, o, s, p], i) => `<tr><td>${String(i + 1).padStart(3, '0')}</td><td>${part}<br>Taric: 85423990${i}0 &nbsp; ECCN: EAR99<br>RoHS: compliant / RoHS: Konform</td>
    <td>26${10 + i}<br>LOT${4711 + i}X</td><td class="q">${o}</td><td class="q">${s}</td><td class="q">${p}</td></tr>`).join('')}
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
  await markOrdered(owner.token, order.id, { internal_order_no: ORDER_NO });
  // Zweite offene Reichelt-Bestellung: Zuordnung muss über die interne Bestellnummer erfolgen.
  const other = await addItem(owner.token, { supplier: 'reichelt', part_number: 'XIAO ESP32C6', name: 'andere Bestellung', qty: 1 });
  await markOrdered(owner.token, other.order.id, { internal_order_no: '2026IW00999' });
  let mouserOrder;
  for (const [part, ordered] of MOUSER_ROWS) {
    mouserOrder = (await addItem(owner.token, { supplier: 'mouser', part_number: part, name: 'Mouser-Teil', qty: ordered })).order;
  }
  await markOrdered(owner.token, mouserOrder.id, { internal_order_no: MOUSER_NO });
  return { orderId: order.id, mouserOrderId: mouserOrder.id, login: await createUser('Scanner-Tester') };
}

/** „Handyfoto“ eines Lieferscheins im Querformat (Mouser): 300-dpi-Rendering, schräg auf dunklem Tisch, 4000 × 3000. */
async function makeLandscapePhoto(b, dir, html, name) {
  const notePath = join(dir, name + '-note.png');
  await b.setViewport({ width: 3508, height: 2480 }, false);
  await b.navigate('about:blank');
  await b.evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close();`);
  await sleep(300);
  await b.screenshotTo(notePath, 'png');
  const dataUrl = 'data:image/png;base64,' + readFileSync(notePath).toString('base64');
  await b.setViewport({ width: 4000, height: 3000 }, false);
  await b.evaluate(`document.open(); document.write(${JSON.stringify(`<!doctype html><html><body style="margin:0;height:3000px;background:#3b2f25;display:flex;align-items:center;justify-content:center;perspective:5000px">
    <img src="${dataUrl}" style="width:3500px;transform:rotateX(6deg) rotateZ(-2deg);box-shadow:0 20px 40px rgba(0,0,0,.5)">
  </body></html>`)}); document.close();`);
  await b.waitFor(`document.querySelector('img')?.complete`, 'Foto-Seite');
  await sleep(300);
  const photoPath = join(dir, name + '.jpg');
  await b.screenshotTo(photoPath, 'jpeg', 90);
  return photoPath;
}

/** Erzeugt mit dem Browser ein „Handyfoto“ des synthetischen Lieferscheins. */
async function makePhoto(b, dir, html = NOTE_HTML, name = 'foto') {
  const notePath = join(dir, name + '-note.png');
  await b.setViewport({ width: 1240, height: 1754 }, false);
  await b.navigate('about:blank');
  await b.evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close();`);
  await sleep(300);
  await b.screenshotTo(notePath, 'png');

  const dataUrl = 'data:image/png;base64,' + readFileSync(notePath).toString('base64');
  await b.setViewport({ width: 1500, height: 2000 }, false);
  await b.evaluate(`document.open(); document.write(${JSON.stringify(`<!doctype html><html><body style="margin:0;height:2000px;background:#3b2f25;display:flex;align-items:center;justify-content:center;perspective:2400px">
    <img src="${dataUrl}" style="width:1120px;transform:rotateX(9deg) rotateZ(-5deg) translateY(30px);box-shadow:0 20px 40px rgba(0,0,0,.5)">
  </body></html>`)}); document.close();`);
  await b.waitFor(`document.querySelector('img')?.complete`, 'Foto-Seite');
  await sleep(300);
  const photoPath = join(dir, name + '.jpg');
  await b.screenshotTo(photoPath, 'jpeg', 88);
  return photoPath;
}

const ok = (msg) => console.log('✔', msg);
const { orderId, mouserOrderId, login } = await seed();
await enableRateLimits(); // Browser-Durchlauf unter Produktionsbedingungen
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-scanner-'));
const b = await launchBrowser(join(work, 'profile'));
let failed = false;
const scanner = `Alpine.$data(document.querySelector('[x-data=deliveryScanner]'))`;

try {
  const photo = await makePhoto(b, work);
  const directPhoto = await makePhoto(b, work, DIRECT_HTML, 'direkt');
  const unknownPhoto = await makePhoto(b, work, UNKNOWN_HTML, 'unbekannt');
  const mouserPhoto = await makeLandscapePhoto(b, work, MOUSER_HTML, 'mouser');
  ok('synthetischen Lieferschein fotografiert (schräg auf dunklem Tisch)');

  await b.setViewport();
  await loginViaUi(b, PB_URL, login.email);
  await b.waitFor(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]')?.getClientRects().length`, 'Scanner-Knopf in der Leiste unten');
  await b.evaluate(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]').click()`);
  await b.waitFor(`${scanner}.isOpen && ${scanner}.libState === 'ready'`, 'Bildverarbeitung geladen', 60000);
  ok('Scanner geöffnet, OpenCV/jscanify geladen');

  // Helles Blatt auf hellem, beigem Tisch (Meldung 25.11.2026): Licht von oben rechts, dort ist der Tisch so hell wie
  // das Papier; Blatt unten im Schatten, weiche Kanten. Früher lief die helle Fläche in den Tisch über bzw. die
  // Kantensuche nahm den Bildrahmen. Erwartet: Ecken auf ≤ 2 % der Bildbreite genau.
  const lightTable = JSON.parse(await b.evaluate(`(async () => {
    const v = await import('/modules/delivery-scanner/vision.js');
    const W = 1500, H = 2000;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    const t = x.createLinearGradient(W, 0, 0, H);
    t.addColorStop(0, '#fbf1df'); t.addColorStop(1, '#bba98c');
    x.fillStyle = t; x.fillRect(0, 0, W, H);
    const corners = [[230, 260], [1270, 230], [1300, 1720], [200, 1750]];
    const paper = x.createLinearGradient(0, 230, 0, 1750);
    paper.addColorStop(0, '#f7f7f5'); paper.addColorStop(0.55, '#ededeb'); paper.addColorStop(1, '#bdbdbb');
    x.fillStyle = paper; x.beginPath(); corners.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); x.fill();
    x.fillStyle = '#222'; x.font = '28px sans-serif';
    for (let i = 0; i < 12; i++) x.fillText('Position ' + (i + 1) + '   3 Stk   ART-' + (1000 + i), 330, 450 + i * 90);
    const soft = document.createElement('canvas'); soft.width = W; soft.height = H;
    const sx = soft.getContext('2d'); sx.filter = 'blur(5px)'; sx.drawImage(c, 0, 0);
    const d = v.detectCorners(soft);
    const keys = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];
    const err = d.detected ? Math.max(...keys.map((k, i) => Math.hypot(d.corners[k].x - corners[i][0], d.corners[k].y - corners[i][1]))) / W : null;
    return JSON.stringify({ err, method: d.method });
  })()`));
  if (lightTable.err === null || lightTable.err > 0.02) throw new Error('Blatt auf hellem Tisch falsch erkannt: ' + JSON.stringify(lightTable));
  ok(`helles Blatt auf hellem Tisch erkannt (Abweichung ${(lightTable.err * 100).toFixed(1)} %, ${lightTable.method})`);
  await b.screenshot('scanner-01-start');

  await b.setFiles('[x-data=deliveryScanner] input[capture]', [photo]);
  await b.waitFor(`${scanner}.step === 'corners'`, 'Eckenprüfung', 30000);
  if (!(await b.evaluate(`${scanner}.cornersDetected`))) throw new Error('Blattkanten wurden nicht erkannt');
  ok('Blattkanten automatisch erkannt');
  await b.screenshot('scanner-02-ecken');

  // Handy-Breite: ganzes Bild und alle Knöpfe ohne Scrollen sichtbar
  const fit = await b.evaluate(`(() => {
    const c = document.querySelector('[x-data=deliveryScanner] canvas[x-ref=cornerCanvas]').getBoundingClientRect();
    const bar = document.querySelector('[data-corner-actions]').getBoundingClientRect();
    const btns = [...document.querySelectorAll('[data-corner-actions] button')].map((e) => e.getBoundingClientRect());
    return { canvas: c.top >= 0 && c.bottom <= bar.top + 1, buttons: btns.length === 3 && btns.every((r) => r.top >= 0 && r.bottom <= innerHeight) };
  })()`);
  if (!fit.canvas || !fit.buttons) throw new Error('Eckenauswahl passt nicht auf den Bildschirm: ' + JSON.stringify(fit));
  ok('Eckenauswahl: Bild und Knöpfe ohne Scrollen sichtbar');

  // Eckpunkt ziehen → Lupe erscheint auf der abgewandten Seite; zurück an die Ausgangsstelle, loslassen → Lupe weg
  const tl = await b.evaluate(`${scanner}.cornerScreenPoint('topLeftCorner')`);
  await b.mouse('mousePressed', tl.x, tl.y);
  await b.mouse('mouseMoved', tl.x + 30, tl.y + 20);
  await b.waitFor(`${scanner}.loupeSide === 'right' && document.querySelector('[data-loupe]').offsetParent`, 'Lupe sichtbar');
  await sleep(200);
  await b.screenshot('scanner-02b-lupe');
  await b.mouse('mouseMoved', tl.x, tl.y);
  await b.mouse('mouseReleased', tl.x, tl.y);
  await b.waitFor(`${scanner}.loupeSide === '' && !document.querySelector('[data-loupe]').offsetParent`, 'Lupe ausgeblendet');
  ok('Lupe beim Ziehen eines Eckpunkts');

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
  // Der Beleg erscheint in der Bestellung unter „Anhänge“ (als „Lieferschein <Datum>“, nicht löschbar)
  // Anhänge sind eingeklappt; aufgeklappt zeigt der Beleg die erste PDF-Seite als Vorschau (PDF.js)
  await b.navigate(PB_URL + '/#/orders/' + orderId);
  await b.waitFor(`document.querySelector('[data-attachments-toggle]')?.offsetParent && !document.querySelector('[data-attachment=receipt]')?.offsetParent`, 'Anhänge eingeklappt');
  await b.evaluate(`document.querySelector('[data-attachments-toggle]').click()`);
  await b.waitFor(`[...document.querySelectorAll('[data-attachments] [data-attachment=receipt]')].some((a) => a.innerText.includes('Lieferschein ') && !a.querySelector('[data-attachment-delete]')?.offsetParent)`, 'Beleg unter Anhänge');
  await b.waitFor(`[...document.querySelectorAll('[data-attachment=receipt] [data-pdf-thumb]')].some((i) => i.complete && i.naturalWidth > 0)`, 'PDF-Vorschau', 15000);
  ok('Beleg in der Bestellung unter „Anhänge“ (eingeklappt), aufgeklappt mit PDF-Vorschau');

  // ---- Lieferschein ohne Bestellung im System → Bestellung daraus anlegen ----------------
  const scanFromDashboard = async (file) => {
    await b.navigate(PB_URL + '/#/');
    await b.waitFor(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]')?.getClientRects().length`, 'Dashboard');
    await b.evaluate(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]').click()`);
    await b.waitFor(`${scanner}.isOpen && ${scanner}.libState === 'ready'`, 'Scanner bereit', 60000);
    await b.setFiles('[x-data=deliveryScanner] input[capture]', [file]);
    await b.waitFor(`${scanner}.step === 'corners'`, 'Eckenprüfung', 30000);
    await b.clickText('[x-data=deliveryScanner] button', 'Übernehmen');
    await b.waitFor(`${scanner}.step === 'pages' && ${scanner}.pages.length === 1`, 'Seite übernommen', 20000);
    await b.clickText('[x-data=deliveryScanner] button', 'Erkennung starten');
    await b.waitFor(`${scanner}.step === 'review'`, 'Prüfmaske', 120000);
  };

  await scanFromDashboard(directPhoto);
  if (await b.evaluate(`!!${scanner}.order`)) throw new Error('Direktkauf fälschlich einer Bestellung zugeordnet');
  await b.waitFor(`document.querySelector('[data-no-order]')?.offsetParent`, 'Hinweis „Keine passende Bestellung?“');
  await b.clickText('[data-no-order] button', 'Bestellung aus Lieferschein anlegen');
  await b.waitFor(`document.querySelector('[data-create-order]')?.offsetParent`, 'Formular Bestellung anlegen');
  const created = await b.evaluate(`JSON.stringify({ no: ${scanner}.create.internal_order_no, s: ${scanner}.create.supplier, items: ${scanner}.create.items.map((i) => i.qty + '×' + i.part_number) })`);
  if (created !== JSON.stringify({ no: DIRECT_NO, s: 'reichelt', items: ['1×CLI-581 C', '4×KEM X7R0805 100N'] })) throw new Error('Vorbelegung: ' + created);
  await b.fill('[data-create-item="0"] input[aria-label="Bezeichnung"]', 'Tinte cyan');
  await b.screenshot('scanner-07-bestellung-anlegen');
  await b.clickText('[data-create-order] button', 'Bestellung anlegen und Lieferung buchen');
  await b.confirmDialog('Anlegen und buchen');
  await b.waitFor(`location.hash.startsWith('#/orders/') && document.body.innerText.includes('aus Lieferschein angelegt')`, 'neue Bestellung', 30000);
  const [direct] = await listRecords('orders', `internal_order_no = "${DIRECT_NO}"`);
  const directItems = await listRecords('order_items', `order = "${direct.id}"`);
  const [directDelivery] = await listRecords('deliveries', `order = "${direct.id}"`);
  if (direct.origin !== 'lieferschein' || direct.status !== 'geliefert' || directItems.length !== 2
      || !directItems.every((i) => i.qty_delivered === i.qty_ordered) || !/\.pdf$/.test(directDelivery?.receipt ?? '')) {
    throw new Error('Bestellung aus Lieferschein: ' + JSON.stringify({ direct, directItems, directDelivery }));
  }
  ok('Bestellung aus Lieferschein angelegt: Nummer übernommen, 2 Positionen, geliefert, PDF-Beleg');

  // ---- Lieferant ohne Profil → Ablage → im Dashboard einer Bestellung zuordnen ---------------
  await scanFromDashboard(unknownPhoto);
  await b.waitFor(`document.querySelector('[data-no-order]')?.offsetParent`, 'Hinweis ohne Profil');
  if (await b.evaluate(`[...document.querySelectorAll('[data-no-order] button')].some((e) => e.offsetParent && e.innerText.includes('Bestellung aus'))`)) {
    throw new Error('Ohne Profil darf keine Bestellung angelegt werden');
  }
  await b.clickText('[data-no-order] button', 'In Ablage legen');
  await b.waitFor(`document.querySelector('[data-archive]')?.offsetParent`, 'Ablage-Formular');
  await b.fill('#archive-supplier', 'Musterteile Versand');
  await b.clickText('[data-archive] button', 'In Ablage legen');
  await b.waitFor(`!${scanner}.isOpen`, 'abgelegt', 30000);
  await b.waitFor(`document.querySelector('[data-unmatched-receipts]')?.offsetParent && document.body.innerText.includes('Musterteile Versand')`, 'Ablage im Dashboard');
  await b.screenshot('scanner-08-ablage');
  await b.evaluate(`Alpine.$data(document.querySelector('[data-unmatched-receipts]')).loadOrders()`);
  await b.waitFor(`document.querySelectorAll('[data-unmatched-receipts] option').length > 1`, 'Bestellungen zur Auswahl');
  await b.fill('[data-unmatched-receipts] select', direct.id);
  await b.clickText('[data-unmatched-receipts] button', 'Zuordnen');
  // ohne Rückfrage: Eintrag sofort ausgeblendet, angehängt nach Ablauf des Toasts („Rückgängig“ möglich)
  await b.waitFor(`!document.querySelector('[data-unmatched-receipts]')?.offsetParent`, 'Ablage leer');
  await b.waitFor(`[...document.querySelectorAll('[data-toast-action]')].some((e) => e.innerText.trim() === 'Rückgängig')`, 'Toast mit Rückgängig');
  await b.waitFor(`document.body.innerText.includes('Lieferschein an die Bestellung angehängt')`, 'verzögert angehängt', 15000);
  const assigned = (await listRecords('orders', `id = "${direct.id}"`))[0];
  if (assigned.attachments.length !== 1 || (await listRecords('unmatched_receipts')).length !== 0) throw new Error('Zuordnung: ' + JSON.stringify(assigned.attachments));
  ok('Lieferschein ohne Profil abgelegt und im Dashboard einer Bestellung zugeordnet (Anhang)');

  // ---- Mouser: Mengen klein in gerahmten Zellen → Zellen-Lesen, Teillieferung mit Gegenprobe --------------
  await scanFromDashboard(mouserPhoto);
  const mouser = await b.evaluate(`JSON.parse(JSON.stringify({ order: ${scanner}.order?.id, profile: ${scanner}.profileLabel, rows: ${scanner}.reviewRows }))`);
  if (mouser.order !== mouserOrderId || mouser.profile !== 'Mouser') throw new Error('Mouser-Zuordnung: ' + JSON.stringify({ order: mouser.order, profile: mouser.profile }));
  const mouserWrong = [];
  for (const [part, , shipped] of MOUSER_ROWS) {
    const r = mouser.rows.find((x) => x.part === part);
    if (!r || r.qty !== shipped || r.status !== 'sure') mouserWrong.push(`${part}: ${r ? `${r.qty} (${r.status}: ${r.reasons.join(', ')})` : 'fehlt'}`);
  }
  if (mouserWrong.length) throw new Error('Mouser-Mengen:\n  ' + mouserWrong.join('\n  '));
  ok('Mouser: Profil erkannt, Mengen aus den Tabellenzellen gelesen (6 sicher, Teillieferung 20 von 25 bestätigt)');
  await b.screenshot('scanner-09-mouser');

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
