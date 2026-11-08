// Einschätzung der Erkennung und Aufbau der Analyse-Daten für Problem-Meldungen (ohne Server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRecognition, buildAnalysis, REPORT_VERSION } from '../pb_public/modules/delivery-scanner/report.js';
import { profileForSupplier } from '../pb_public/modules/delivery-scanner/profiles/index.js';

const reichelt = profileForSupplier('reichelt');
const order = { id: 'o1', supplier: 'reichelt', supplier_order_no: '2026IW01047' };
const ok = { pages: [{ cornersDetected: true }], detectedProfile: reichelt, order, orderProfile: reichelt };
const row = (part) => ({ qty: 1, part, page: 0, box: { x0: 0, y0: 0, x1: 0.1, y1: 0.01 }, conf: 90 });

test('erfolgreiche Erkennung: nicht gescheitert, keine Probleme', () => {
  const r = assessRecognition({ ...ok, rows: [row('A')], assignments: [{ row: row('A'), itemId: 'i1' }] });
  assert.deepEqual(r, { failed: false, problems: [] });
});

test('offensichtliches Scheitern wird erkannt', () => {
  // Start im Dashboard: Lieferant nicht erkannt, keine Bestellung gewählt
  assert.equal(assessRecognition({ ...ok, detectedProfile: null, order: null, orderProfile: null }).failed, true);
  // Kopfzeile fehlt
  const header = assessRecognition({ ...ok, missingHeader: [2] });
  assert.equal(header.failed, true);
  assert.deepEqual(header.problems, ['Positionstabelle auf Seite 2 nicht gefunden']);
  // Zeilen gelesen, aber keine zugeordnet
  assert.equal(assessRecognition({ ...ok, rows: [row('A')], assignments: [{ row: row('A'), itemId: null }] }).failed, true);
  // keine Zeilen trotz Kopfzeile
  assert.match(assessRecognition(ok).problems.join(), /Keine Positionszeilen/);
  // Lieferant ohne Profil (z. B. Mouser) → Beispiel für ein neues Profil
  const mouser = assessRecognition({ ...ok, detectedProfile: null, order: { ...order, supplier: 'mouser' }, orderProfile: null });
  assert.equal(mouser.failed, true);
  assert.match(mouser.problems.join(), /Kein Lieferschein-Profil für den Lieferanten mouser/);
});

test('kleinere Auffälligkeiten werden genannt, gelten aber nicht als Scheitern', () => {
  const r = assessRecognition({
    ...ok,
    pages: [{ cornersDetected: true }, { cornersDetected: false }],
    rows: [row('A'), row('B')],
    assignments: [{ row: row('A'), itemId: 'i1' }, { row: row('B'), itemId: null }],
  });
  assert.equal(r.failed, false);
  assert.deepEqual(r.problems, ['Blattkanten auf Seite 2 nicht automatisch erkannt', '1 Zeile(n) keiner Position zugeordnet']);
});

test('Analyse-Daten: Seiten, OCR gekürzt, erkannte und eingetragene Mengen', () => {
  const ocr = { width: 1800, height: 2546, text: 'Menge', words: [{ text: 'Menge', conf: 91.234, bbox: { x0: 0.123456, y0: 0.2, x1: 0.3, y1: 0.21 }, extra: 1 }] };
  const a = buildAnalysis({
    pages: [{ source: { width: 3200, height: 2400 }, cornersDetected: true, cornersAuto: null, corners: { topLeftCorner: { x: 1, y: 2 } }, rectified: { width: 1800, height: 2546 }, ocr }],
    detectedProfile: reichelt,
    order: { ...order, created_by: 'geheim' },
    items: [{ id: 'i1', part_number: 'A', name: 'Teil', qty_ordered: 3, qty_delivered: 0, qty_cancelled: 0, group_allocation_note: 'Gruppe A: 3x' }],
    rows: [row('A')],
    assignments: [{ row: row('A'), itemId: 'i1', sim: 1, status: 'sure', reason: '' }],
    review: [{ itemId: 'i1', part: 'A', recognized: 1, qty: 3, status: 'sure' }],
    assessment: { failed: false, problems: [] },
  });
  assert.equal(a.version, REPORT_VERSION);
  assert.equal(a.profile, 'reichelt');
  assert.deepEqual(Object.keys(a.order).sort(), ['id', 'supplier', 'supplier_custom_name', 'supplier_order_no']);
  assert.deepEqual(a.pages[0].ocr.words[0], { text: 'Menge', conf: 91, bbox: { x0: 0.1235, y0: 0.2, x1: 0.3, y1: 0.21 } });
  assert.equal(a.items[0].group_allocation_note, undefined, 'Gruppenaufteilung wird nicht mitgesendet');
  assert.deepEqual(a.review, [{ itemId: 'i1', part: 'A', recognized: 1, entered: 3, status: 'sure' }]);
  assert.doesNotThrow(() => JSON.stringify(a));
});
