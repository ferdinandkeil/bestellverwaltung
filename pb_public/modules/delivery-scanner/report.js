// Problem-Meldungen: Einschätzung, ob die Erkennung gescheitert ist, und Aufbau der Analyse-Daten
// für die Collection scan_reports. Reine Funktionen (ohne DOM), damit sie ohne Browser testbar sind.
import { profileMatchesOrder } from './profiles/index.js';

/** Version des Formats von scan_reports.analysis – bei Änderungen erhöhen. */
export const REPORT_VERSION = 1;

/**
 * Einschätzung der Erkennung.
 *   pages:          [{ cornersDetected }]
 *   detectedProfile Profil aus dem Lieferschein-Kopf (oder null)
 *   order           gewählte Bestellung (oder null)
 *   orderProfile    Profil zum Lieferanten der Bestellung (oder null)
 *   missingHeader   Seitennummern (1-basiert) ohne gefundene Positionstabelle
 *   rows            gelesene Positionszeilen
 *   assignments     Ergebnis von matchRows().assignments
 * → { failed, problems: [Text] }   failed = offensichtlich gescheitert → Meldung hervorgehoben anbieten
 */
export function assessRecognition({ pages, detectedProfile, order, orderProfile, missingHeader = [], rows = [], assignments = [] }) {
  const hard = [];
  const soft = [];
  const noCorners = pages.map((p, i) => (p.cornersDetected ? null : i + 1)).filter(Boolean);
  if (noCorners.length) soft.push(`Blattkanten auf Seite ${noCorners.join(', ')} nicht automatisch erkannt`);

  if (!detectedProfile) (order ? soft : hard).push('Lieferant im Kopf des Lieferscheins nicht erkannt');
  else if (order && !profileMatchesOrder(detectedProfile, order)) soft.push(`Lieferschein sieht nach ${detectedProfile.label} aus, Bestellung ist bei ${order.supplier === 'other' ? order.supplier_custom_name : order.supplier}`);

  if (order) {
    if (!orderProfile) {
      hard.push(`Kein Lieferschein-Profil für den Lieferanten ${order.supplier === 'other' ? order.supplier_custom_name : order.supplier}`);
    } else {
      if (missingHeader.length) hard.push(`Positionstabelle auf Seite ${missingHeader.join(', ')} nicht gefunden`);
      const matched = assignments.filter((a) => a.itemId).length;
      if (!rows.length) {
        if (!missingHeader.length) hard.push('Keine Positionszeilen gelesen');
      } else if (!matched) {
        hard.push('Keine gelesene Zeile einer Bestellposition zugeordnet');
      }
      const unmatched = assignments.filter((a) => !a.itemId).length;
      if (matched && unmatched) soft.push(`${unmatched} Zeile(n) keiner Position zugeordnet`);
    }
  }
  return { failed: hard.length > 0, problems: [...hard, ...soft] };
}

/** Wörter auf das Nötige kürzen (Koordinaten auf 4 Stellen). */
const round = (v) => Math.round(v * 10000) / 10000;
function compactOcr(ocr) {
  if (!ocr) return null;
  return {
    width: ocr.width,
    height: ocr.height,
    text: ocr.text,
    words: ocr.words.map((w) => ({
      text: w.text, conf: Math.round(w.conf),
      bbox: { x0: round(w.bbox.x0), y0: round(w.bbox.y0), x1: round(w.bbox.x1), y1: round(w.bbox.y1) },
    })),
  };
}

/**
 * Analyse-Daten für scan_reports.analysis.
 *   pages:   [{ source: {width,height}, cornersAuto, cornersDetected, corners, rectified: {width,height}, ocr }]
 *   review:  Zeilen der Prüfansicht (erkannte und zuletzt eingetragene Mengen)
 */
export function buildAnalysis({ pages, detectedProfile, order, items = [], rows = [], assignments = [], review = [], assessment, warnings = [], internalOrderNos = [], client = {} }) {
  return {
    version: REPORT_VERSION,
    client,
    profile: detectedProfile?.id ?? null,
    order: order ? {
      id: order.id, supplier: order.supplier, supplier_custom_name: order.supplier_custom_name || '',
      internal_order_no: order.internal_order_no || '', supplier_order_no: order.supplier_order_no || '',
    } : null,
    internalOrderNos,
    problems: assessment?.problems ?? [],
    failed: assessment?.failed ?? false,
    warnings,
    pages: pages.map((p, index) => ({
      index,
      source: p.source,
      cornersDetected: p.cornersDetected,
      cornersAuto: p.cornersAuto,
      corners: p.corners,
      rectified: p.rectified,
      ocr: compactOcr(p.ocr),
    })),
    items: items.map((it) => ({
      id: it.id, part_number: it.part_number, name: it.name,
      qty_ordered: it.qty_ordered, qty_delivered: it.qty_delivered, qty_cancelled: it.qty_cancelled,
    })),
    rows: rows.map((r) => ({ page: r.page, qty: r.qty, part: r.part, box: r.box, conf: r.conf })),
    assignments: assignments.map((a) => ({ part: a.row.part, page: a.row.page, itemId: a.itemId, sim: a.sim, status: a.status, reason: a.reason })),
    review: review.map((r) => ({ itemId: r.itemId, part: r.part, recognized: r.recognized, entered: r.qty, status: r.status })),
  };
}
