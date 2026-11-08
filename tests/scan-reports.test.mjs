// Problem-Meldungen der Lieferschein-Erfassung: Rechte, Validierung, Mail an die Superuser.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, createUser, addItem, http, admin, expectHttpError, PB_URL, MAILPIT_URL,
} from './helpers.mjs';

before(setup);

// Synthetisches Test-JPEG (Graustufenverlauf 40×56)
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAA4ACgBAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUI/8QAFhAAAwAAAAAAAAAAAAAAAAAAABRh/9oACAEBAAA/ANPs0M0M0M0M0jM0M0M0M0M0is0M0M0M0M0jM0M0M0M0M0js0M0M0M0M0is0M0M0M0M0jM0M0M0M0M0//9k=', 'base64');
const page = (n) => ({ index: n, corners: null, cornersDetected: false, ocr: { width: 40, height: 56, text: '', words: [] } });

function reportForm({ reportedBy, orderId, pages = 2, photos = 2, note = '' }) {
  const form = new FormData();
  form.append('reported_by', reportedBy);
  if (orderId) form.append('order', orderId);
  form.append('note', note);
  form.append('analysis', JSON.stringify({
    version: 1, profile: null, problems: ['Positionstabelle auf Seite 1 nicht gefunden'],
    pages: Array.from({ length: pages }, (_, i) => page(i)),
  }));
  for (let i = 0; i < photos; i++) form.append('photos', new Blob([JPEG], { type: 'image/jpeg' }), `seite-${i + 1}.jpg`);
  return form;
}

async function mailWithSubject(text, notBefore) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('subject:"' + text + '"')}`);
    const data = await res.json();
    const msg = data.messages?.find((m) => new Date(m.Created).getTime() >= notBefore - 2000);
    if (msg) return (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Keine Mail mit Betreff ' + text);
}

test('Meldung anlegen → Mail mit Link an die Superuser, ohne Anhang', async () => {
  const { user, token } = await createUser('Melder');
  const { order } = await addItem(token, { supplier: 'reichelt', part_number: 'X 1', name: 'Teil', qty: 1 });
  const before = Date.now();
  const report = await http('POST', '/api/collections/scan_reports/records', {
    token, form: reportForm({ reportedBy: user.id, orderId: order.id, note: 'Mengen <falsch>' }),
  });
  assert.equal(report.photos.length, 2);

  const mail = await mailWithSubject('Lieferschein-Scanner: Problem gemeldet', before);
  assert.deepEqual(mail.To.map((t) => t.Address), ['test-admin@example.com']);
  assert.equal(mail.Attachments.length, 0);
  assert.ok(mail.HTML.includes(`${PB_URL}/_/#/collections?collection=pb_scan_reports_col&amp;recordId=${report.id}`));
  assert.match(mail.HTML, /Melder/);
  assert.match(mail.HTML, /reichelt/);
  assert.match(mail.HTML, /Positionstabelle auf Seite 1 nicht gefunden/);
  assert.match(mail.HTML, /Mengen &lt;falsch&gt;/, 'Notiz wird escaped');
});

test('Labor-Nutzer können Meldungen weder lesen noch ändern oder löschen; Fotos sind geschützt', async () => {
  const { user, token } = await createUser();
  const report = await http('POST', '/api/collections/scan_reports/records', {
    token, form: reportForm({ reportedBy: user.id, pages: 1, photos: 1 }),
  });
  await expectHttpError(http('GET', '/api/collections/scan_reports/records', { token }), 403);
  await expectHttpError(http('GET', `/api/collections/scan_reports/records/${report.id}`, { token }), 403);
  await expectHttpError(http('PATCH', `/api/collections/scan_reports/records/${report.id}`, { token, json: { note: 'x' } }), 403);
  await expectHttpError(http('DELETE', `/api/collections/scan_reports/records/${report.id}`, { token }), 403);

  const file = `/api/files/scan_reports/${report.id}/${report.photos[0]}`;
  assert.equal((await fetch(PB_URL + file)).status, 404, 'ohne Datei-Token kein Zugriff');
  const { token: fileToken } = await http('POST', '/api/files/token', { token: await admin() });
  const res = await fetch(`${PB_URL}${file}?token=${fileToken}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
});

test('Meldung nur im eigenen Namen, mit Fotos und passender Seitenzahl', async () => {
  const { user, token } = await createUser();
  const { user: other } = await createUser();
  const url = '/api/collections/scan_reports/records';
  await expectHttpError(http('POST', url, { token, form: reportForm({ reportedBy: other.id }) }), 400);
  await expectHttpError(http('POST', url, { form: reportForm({ reportedBy: user.id }) }), 400);
  const noPhotos = await expectHttpError(http('POST', url, { token, form: reportForm({ reportedBy: user.id, photos: 0 }) }), 400);
  assert.ok(noPhotos.body.data.photos, 'Fotos sind Pflicht');
  const mismatch = await expectHttpError(http('POST', url, { token, form: reportForm({ reportedBy: user.id, pages: 3, photos: 2 }) }), 400);
  assert.match(mismatch.body.message, /Anzahl der Seiten/);
});
