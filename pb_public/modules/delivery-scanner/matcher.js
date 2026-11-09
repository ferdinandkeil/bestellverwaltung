// Auswertung der OCR-Ergebnisse: Tabellenzeilen lesen, mit Bestellpositionen abgleichen, Bestellung finden.
// Reine Logik ohne DOM – getestet in tests/scanner-matcher.test.mjs.

/** Für den Vergleich: Großbuchstaben, nur A–Z und 0–9. */
export function normalizePart(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Ähnlichkeit 0..1 zweier Bestellnummern (nach Normalisierung). */
export function similarity(a, b) {
  const x = normalizePart(a);
  const y = normalizePart(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Mengen-Text → Zahl. Typische OCR-Verwechslungen (O→0, I/l/|→1) werden nur korrigiert,
 * wenn der Text ansonsten aus Ziffern besteht (sonst würde z. B. „Volksbank“ zu 1).
 */
export function parseQty(text) {
  const raw = String(text).trim().replace(/[.,]$/, '');
  if (!/^[0-9OoIl|]+$/.test(raw) || !/[0-9]/.test(raw)) return null;
  const cleaned = raw.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const n = Number(cleaned);
  return cleaned && Number.isInteger(n) && n > 0 ? n : null;
}

const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const unionBox = (ws) => ({
  x0: Math.min(...ws.map((w) => w.bbox.x0)),
  y0: Math.min(...ws.map((w) => w.bbox.y0)),
  x1: Math.max(...ws.map((w) => w.bbox.x1)),
  y1: Math.max(...ws.map((w) => w.bbox.y1)),
});

/**
 * Positionszeilen einer Seite lesen. Die Spaltengrenzen ergeben sich aus der Kopfzeile
 * (profile.columns), dadurch unabhängig von Bildausschnitt und Auflösung.
 * → { headerFound, rows: [{ qty, part, box, conf }] }   (box normiert 0..1)
 */
export function extractRows(page, profile) {
  const words = page.words;
  const find = (re) => words.find((w) => re.test(w.text.trim()));
  const hQty = find(profile.columns.qty);
  const hPart = find(profile.columns.part);
  const hDesc = find(profile.columns.desc);
  if (!hQty || !hPart || !hDesc) return { headerFound: false, rows: [] };

  const qtyPartBorder = (hQty.bbox.x1 + hPart.bbox.x0) / 2;
  const partDescBorder = hDesc.bbox.x0 - 0.005;
  const headerBottom = Math.max(hQty.bbox.y1, hPart.bbox.y1, hDesc.bbox.y1);

  // Wörter unterhalb der Kopfzeile zu Zeilen gruppieren (gleiche Mittellinie).
  const lines = [];
  const below = words.filter((w) => w.bbox.y0 > headerBottom).sort((a, b) => center(a.bbox).y - center(b.bbox).y);
  for (const w of below) {
    const cy = center(w.bbox).y;
    const h = w.bbox.y1 - w.bbox.y0;
    const line = lines.find((l) => Math.abs(l.cy - cy) < Math.max(h, l.h) * 0.6);
    if (line) line.words.push(w);
    else lines.push({ cy, h, words: [w] });
  }

  const rows = [];
  for (const line of lines) {
    const ws = line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const qtyWords = ws.filter((w) => center(w.bbox).x < qtyPartBorder);
    const partWords = ws.filter((w) => center(w.bbox).x >= qtyPartBorder && w.bbox.x1 <= partDescBorder + 0.01);
    if (!qtyWords.length || !partWords.length) continue;
    const qty = parseQty(qtyWords.map((w) => w.text).join(''));
    if (!qty) continue;
    rows.push({
      qty,
      part: partWords.map((w) => w.text).join(' '),
      box: unionBox([...qtyWords, ...partWords]),
      conf: Math.round(Math.min(...partWords.map((w) => w.conf ?? 0))),
    });
  }
  return { headerFound: true, rows };
}

/** Schwellen für die Zuordnung. */
export const MATCH = {
  sure: 0.85, // ab dieser Ähnlichkeit (und genug Abstand zum Zweitbesten) gilt die Zuordnung als sicher
  margin: 0.08,
  min: 0.6, // darunter keine Zuordnung
};

/**
 * Erkannte Zeilen den Bestellpositionen zuordnen.
 * items: order_items (part_number, qty_ordered, qty_delivered, qty_cancelled, id)
 * rows:  [{ qty, part, box, conf, page }]
 * → {
 *     assignments: [{ row, itemId|null, sim, status: 'sure'|'check'|'none', reason }],
 *     perItem: { [itemId]: { qty, status, reasons: [] } }
 *   }
 */
export function matchRows(rows, items) {
  const assignments = rows.map((row) => {
    const scored = items
      .map((it) => ({ it, sim: similarity(row.part, it.part_number) }))
      .sort((a, b) => b.sim - a.sim);
    const best = scored[0];
    const second = scored[1];
    if (!best || best.sim < MATCH.min) {
      return { row, itemId: null, sim: best?.sim ?? 0, status: 'none', reason: 'keine passende Position' };
    }
    const margin = best.sim - (second?.sim ?? 0);
    const sure = best.sim >= MATCH.sure && margin >= MATCH.margin;
    return {
      row,
      itemId: best.it.id,
      sim: best.sim,
      status: sure ? 'sure' : 'check',
      reason: sure ? '' : (best.sim < MATCH.sure ? 'Nummer unsicher erkannt' : 'ähnliche Positionen'),
    };
  });

  const perItem = {};
  for (const a of assignments) {
    if (!a.itemId) continue;
    const entry = (perItem[a.itemId] ??= { qty: 0, status: 'sure', reasons: [], rows: 0 });
    entry.qty += a.row.qty;
    entry.rows += 1;
    if (a.status === 'check') {
      entry.status = 'check';
      entry.reasons.push(a.reason);
    }
  }
  for (const it of items) {
    const entry = perItem[it.id];
    if (!entry) continue;
    if (entry.rows > 1) {
      entry.status = 'check';
      entry.reasons.push('mehrere Zeilen zugeordnet');
    }
    const backlog = Math.max(0, it.qty_ordered - (it.qty_delivered || 0) - (it.qty_cancelled || 0));
    if (entry.qty > backlog) {
      entry.status = 'check';
      entry.reasons.push(`mehr als der Rückstand (${backlog})`);
    }
  }
  return { assignments, perItem };
}

// ---------------------------------------------------------------------------
// Interne Bestellnummer der Hochschule (JJJJIW#####) – steht bei allen Lieferanten auf dem Lieferschein
// ---------------------------------------------------------------------------

/** OCR-Verwechslungen in Ziffernfeldern. */
const DIGIT_FIX = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1' };
/** 4 Ziffern, „I“ (oft als 1/l/| gelesen), „W“ (auch „VV“), 5 Ziffern – Satzzeichen am Rand werden ignoriert. */
const INTERNAL_NO_FUZZY = /^([0-9OoDQIli|!]{4})[I1li|!](W|VV)([0-9OoDQIli|!]{5})$/;

/** Wort → normierte interne Bestellnummer oder null. */
export function parseInternalOrderNo(text) {
  const t = String(text).replace(/^[^0-9A-Za-z|!]+|[^0-9A-Za-z|!]+$/g, '');
  const m = INTERNAL_NO_FUZZY.exec(t);
  if (!m) return null;
  const fix = (s) => [...s].map((c) => DIGIT_FIX[c] ?? c).join('');
  const year = fix(m[1]);
  const num = fix(m[3]);
  if (!/^\d{4}$/.test(year) || !/^\d{5}$/.test(num)) return null;
  // Ganz ohne echte Ziffern (z. B. „IIIIIWlllll“) ist es keine Nummer.
  if ((m[1] + m[3]).replace(/[^0-9]/g, '').length < 5) return null;
  return `${year}IW${num}`;
}

/**
 * Alle internen Bestellnummern auf den Seiten (in Lesereihenfolge, ohne Dubletten).
 * Berücksichtigt auch Nummern, die die OCR in zwei Wörter getrennt hat („2026IW 01047“).
 */
export function findInternalOrderNumbers(pages) {
  const found = [];
  for (const page of pages) {
    const words = page?.words ?? [];
    for (let i = 0; i < words.length; i++) {
      const candidates = [words[i].text];
      if (i + 1 < words.length) candidates.push(words[i].text + words[i + 1].text);
      for (const c of candidates) {
        const no = parseInternalOrderNo(c);
        if (no && !found.includes(no)) found.push(no);
      }
    }
  }
  return found;
}

/** Kandidaten für die Auftragsnummer: längere Wörter mit Ziffern im oberen Teil der ersten Seite. */
export function orderNumberTokens(page, maxY = 0.5) {
  return page.words
    .filter((w) => w.bbox.y1 < maxY)
    .map((w) => w.text.trim())
    .filter((t) => normalizePart(t).length >= 6 && /\d{3}/.test(t));
}

/**
 * Bestellungen nach unscharfer Übereinstimmung ihrer Nummern (interne Bestellnummer, Shop-Auftragsnummer)
 * mit dem Lieferschein sortieren – Rückfall, wenn keine interne Bestellnummer eindeutig gelesen wurde.
 * → [{ order, sim }] absteigend
 */
export function rankOrders(orders, tokens) {
  return orders
    .map((order) => {
      const numbers = [order.internal_order_no, order.supplier_order_no].filter(Boolean);
      const sim = Math.max(0, ...numbers.flatMap((no) => tokens.map((t) => similarity(t, no))));
      return { order, sim };
    })
    .sort((a, b) => b.sim - a.sim);
}
