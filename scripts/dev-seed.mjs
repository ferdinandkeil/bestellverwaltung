// Synthetische Testdaten für die lokale Dev-Instanz (scripts/dev-server.sh).
// Legt alles über die echten Routen an (Sammelkorb, Verwaltungsschritte, Lieferbuchung), damit die Daten fachlich stimmen.
// Nur Node-Bordmittel; nutzt die Test-Helfer. Erwartet die Umgebung von dev-server.sh
// (PB_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD, PB_SCHEMA, MAILPIT_SMTP_PORT).
// Alle Daten sind erfunden – das Repo ist öffentlich.
import { setup, admin, http, addItem, setStep, markOrdered, bookDelivery } from '../tests/helpers.mjs';

export const USERS = [
  { email: 'labor@example.com', name: 'Labor Dev' },
  { email: 'kollegin@example.com', name: 'Kollegin Dev' },
];

async function createUser({ email, name }) {
  const pw = 'dev-irrelevant-password-123'; // Passwort-Login ist deaktiviert
  return http('POST', '/api/collections/users/records', {
    token: await admin(), json: { email, name, password: pw, passwordConfirm: pw, verified: true },
  });
}

async function tokenFor(user) {
  const r = await http('POST', `/api/collections/users/impersonate/${user.id}`, { token: await admin(), json: { duration: 3600 } });
  return r.token;
}

async function group(name, course, semester, isActive = true) {
  return http('POST', '/api/collections/groups/records', { token: await admin(), json: { name, course, semester, is_active: isActive } });
}

await setup();
const [me, colleague] = await Promise.all(USERS.map(createUser));
const meToken = await tokenFor(me);
const coToken = await tokenFor(colleague);

// ---- Gruppen: zwei Veranstaltungen, eine Gruppe inaktiv ----
const [gA, gB, gC, t1] = await Promise.all([
  group('Gruppe A', 'Elektronik-Projekt', 'WS 2026/27'),
  group('Gruppe B', 'Elektronik-Projekt', 'WS 2026/27'),
  group('Gruppe C', 'Elektronik-Projekt', 'WS 2026/27'),
  group('Team 1', 'Messtechnik-Praktikum', 'SS 2026'),
  group('Team 2', 'Messtechnik-Praktikum', 'SS 2026', false),
]);

/** Positionen nacheinander buchen (gleiche Nummer wird zusammengeführt). */
async function cart(token, supplier, items, extra = {}) {
  let last;
  for (const it of items) last = await addItem(token, { supplier, ...extra, ...it });
  return last.order.id;
}

/** Datum vor n Tagen als JJJJ-MM-TT (für nachträglich abgehakte Schritte). */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
/** Schritte nacheinander abhaken: [[step, vor Tagen], …]; extra z. B. mit interner Bestellnummer. */
async function steps(token, orderId, list, extra = {}) {
  for (const [step, days] of list) await setStep(token, orderId, step, { date: daysAgo(days), ...extra });
}
const subject = (token, orderId, text) => http('PATCH', `/api/collections/orders/records/${orderId}`, { token, json: { subject: text } });

const itemsOf = (orderId) => http('GET', `/api/collections/order_items/records?perPage=200&filter=${encodeURIComponent(`order = "${orderId}"`)}`,
  { token: meToken }).then((r) => r.items);

// ---- Warenkörbe und Bestellungen in der Freigabe für jeden Exportweg ----
// Mouser: in Freigabe (Formular unterschrieben und eingereicht) → CSV-Export; eine Nummer für zwei Gruppen zusammengeführt
const mouser = await cart(meToken, 'mouser', [
  { part_number: '595-SN74HC595N', name: 'Schieberegister 8 Bit, DIP-16', qty: 5, price_unit: 0.62, group: gA.id },
  { part_number: '595-SN74HC595N', qty: 3, group: gB.id },
  { part_number: '511-NUCLEO-G031K8', name: 'Nucleo-32 Board STM32G031', qty: 2, price_unit: 10.9, group: gC.id },
  { part_number: '667-ERJ-3EKF1001V', name: 'Widerstand 1k 0603', qty: 100, price_unit: 0.02 },
]);
await steps(meToken, mouser, [['form_written', 6], ['form_signed', 4], ['form_submitted', 3]], { internal_order_no: '2026IW01051' });
await subject(meToken, mouser, 'Bauteile Elektronik-Projekt');
// Würth Elektronik: Warenkorb, Liste für die Bestell-Mail (Muster, ohne Formular)
await cart(coToken, 'wuerth', [
  { part_number: '885012207098', name: 'MLCC 100nF 0805', qty: 10, group: t1.id },
  { part_number: '7447789100', name: 'Speicherdrossel 10µH', qty: 5, group: t1.id },
]);
// Printus: Warenkorb (Abhakliste nach der Freigabe)
await cart(meToken, 'printus', [
  { part_number: '892586', name: 'Kopierpapier A4, 500 Blatt', qty: 5, price_unit: 3.99 },
  { part_number: '302491', name: 'Briefumschläge DIN lang, 100 Stück', qty: 2, price_unit: 7.2 },
  { part_number: '423741', name: 'Ordner breit, blau', qty: 10, price_unit: 1.85 },
]);

// ---- Reichelt: bestellt und teilgeliefert ----
const reichelt = await cart(meToken, 'reichelt', [
  { part_number: 'NE 555 DIP', name: 'Timer NE555, DIP-8', qty: 10, price_unit: 0.31, group: gA.id },
  { part_number: 'LED 5MM RT', name: 'LED 5 mm rot', qty: 50, price_unit: 0.05, group: gB.id },
  { part_number: 'MKDS 1,5 3 5,08', name: 'Anschlussklemme 3-pol.', qty: 20, price_unit: 0.28 },
]);
await steps(meToken, reichelt, [['form_written', 20], ['form_signed', 18], ['form_submitted', 17]], { internal_order_no: '2026IW01047' });
await steps(meToken, reichelt, [['ordered', 12]], { supplier_order_no: 'R-4711' }); // Freigabe nicht nötig → übersprungen
await subject(meToken, reichelt, 'Kleinteile Semesterbeginn');
const reicheltItems = await itemsOf(reichelt);
const ne555 = reicheltItems.find((it) => it.part_number === 'NE 555 DIP');
const led = reicheltItems.find((it) => it.part_number === 'LED 5MM RT');
await bookDelivery(meToken, reichelt, [{ item: ne555.id, qty: 10 }, { item: led.id, qty: 30 }], 'erste Teillieferung');

// ---- TME: komplett geliefert ----
const tme = await cart(coToken, 'tme', [
  { part_number: 'INA226AIDGSR', name: 'Strom-/Leistungsmonitor I²C', qty: 4, price_unit: 2.15, group: t1.id },
  { part_number: 'BSS138', name: 'N-MOSFET SOT-23', qty: 25, price_unit: 0.06, group: t1.id },
]);
await steps(coToken, tme, [['form_written', 30], ['form_signed', 29], ['form_submitted', 28], ['approval', 25], ['ordered', 24]],
  { internal_order_no: '2026IW01048' });
await bookDelivery(coToken, tme, (await itemsOf(tme)).map((it) => ({ item: it.id, qty: it.qty_ordered })), 'komplett');
await steps(coToken, tme, [['invoice_received', 2]]);
await subject(coToken, tme, 'Messverstärker');

// ---- Farnell: abgeschlossen (Rechnung in Verwaltung) ----
const farnell = await cart(meToken, 'farnell', [
  { part_number: '1848687', name: 'Spannungsregler LM7805', qty: 6, price_unit: 0.48, group: gC.id },
]);
await steps(meToken, farnell, [['form_written', 60], ['form_signed', 58], ['form_submitted', 57], ['ordered', 55]],
  { internal_order_no: '2026IW00912' });
await bookDelivery(meToken, farnell, (await itemsOf(farnell)).map((it) => ({ item: it.id, qty: it.qty_ordered })));
await steps(meToken, farnell, [['invoice_received', 45], ['invoice_signed', 44], ['invoice_submitted', 40]]);
await http('PATCH', `/api/collections/orders/records/${farnell}`, { token: meToken, json: { shipping_cost: 4.9, invoice_total: 9.26 } });

// ---- Sonstiger Lieferant: bestellt, eine Position teilweise storniert ----
const conrad = await cart(coToken, 'other', [
  { part_number: '1234567-62', name: 'Lötstation 80 W', qty: 1, price_unit: 59.9 },
  { part_number: '7654321-62', name: 'Entlötlitze 1,5 mm', qty: 5, price_unit: 2.49 },
], { supplier_custom_name: 'Conrad' });
await markOrdered(coToken, conrad, { internal_order_no: '2026IW01050' }); // direkt bestellt, Formular übersprungen
await subject(coToken, conrad, 'Lötplatz');
const litze = (await itemsOf(conrad)).find((it) => it.part_number === '7654321-62');
await http('PATCH', `/api/collections/order_items/records/${litze.id}`, { token: coToken, json: { qty_cancelled: 2 } });

// ---- Voelkner: von Hand übernommen („+ Neue Bestellung“), außerhalb des Systems bestellt ----
await http('POST', '/api/lab/orders/manual', { token: meToken, json: {
  supplier: 'voelkner', internal_order_no: '2026IW00987', stage: 'ordered', subject: 'Netzteile (nachgetragen)',
  items: [
    { part_number: 'S123456', name: 'Labornetzteil 0–30 V, 5 A', qty: 2, group: gA.id },
    { part_number: 'S654321', name: 'Sicherheitsmessleitungen, Satz', qty: 4 },
  ],
} });

// ---- Favoriten: eigene (öffentlich und nicht), fremde öffentliche und fremde nicht öffentliche ----
const fromOrder = (token, body) => http('POST', '/api/lab/favorite-lists/from-order', { token, json: body });
await fromOrder(meToken, { order: reichelt, new_list: {
  title: 'Grundausstattung Elektronik-Projekt', description: 'Was jede Gruppe zu Semesterbeginn braucht.', is_public: true,
} });
const buero = await http('POST', '/api/collections/favorite_lists/records', {
  token: meToken, json: { owner: me.id, title: 'Bürobedarf Standard', supplier: 'printus', is_public: false },
});
for (const it of [
  { part_number: '892586', name: 'Kopierpapier A4, 500 Blatt', qty: 10, price_unit: 3.99 },
  { part_number: '423741', name: 'Ordner breit, blau', qty: 5, price_unit: 1.85 },
]) {
  await http('POST', '/api/collections/favorite_items/records', { token: meToken, json: { list: buero.id, ...it } });
}
await fromOrder(coToken, { order: tme, new_list: { title: 'Messtechnik: Strommessung', is_public: true } });
await fromOrder(coToken, { order: conrad, new_list: { title: 'Werkstatt Lötplatz', is_public: false } });

console.log('Testdaten angelegt: 5 Gruppen, 8 Bestellungen (Warenkorb, in Freigabe, bestellt, teilgeliefert, geliefert, abgeschlossen, von Hand übernommen), 4 Favoritenlisten.');
console.log('Nutzer: ' + USERS.map((u) => `${u.email} (${u.name})`).join(', '));
