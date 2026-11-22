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
 * allowZero: 0 ist eine gültige Angabe (z. B. ausstehende Menge); Liefermengen sind mindestens 1.
 */
export function parseQty(text, allowZero = false) {
  const raw = String(text).trim().replace(/[.,]$/, '');
  if (!/^[0-9OoIl|]+$/.test(raw) || !/[0-9]/.test(raw)) return null;
  const cleaned = raw.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const n = Number(cleaned);
  return cleaned && Number.isInteger(n) && (n > 0 || (allowZero && n === 0)) ? n : null;
}

const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const unionBox = (ws) => ({
  x0: Math.min(...ws.map((w) => w.bbox.x0)),
  y0: Math.min(...ws.map((w) => w.bbox.y0)),
  x1: Math.max(...ws.map((w) => w.bbox.x1)),
  y1: Math.max(...ws.map((w) => w.bbox.y1)),
});

/**
 * Positionszeilen einer Seite lesen – je nach Profil über die Kopfzeile, die Mengeneinheit oder die Teilenummer.
 *   reads: Ergebnisse des Zellen-Lesens (Map boxKey → { value, conf }), optional. Jede Zeile nennt in `cells`
 *          die Bildbereiche ihrer Mengen; der Scanner liest sie gezielt als Zahl (ocr.recognizeNumbers) und
 *          ruft extractRows mit den Ergebnissen erneut auf.
 * → { headerFound, rows: [{ qty, qtyOrdered, qtyPending, qtyConflict, part, box, conf, cells }] }   (Boxen normiert 0..1)
 *   qty: gelieferte Menge oder null (nicht lesbar); qtyOrdered / qtyPending: bestellte bzw. ausstehende Menge laut
 *   Lieferschein (nur wenn das Profil sie liest); qtyConflict: Seiten- und Zellen-Lesen ergeben verschiedene Zahlen.
 *   headerFound: true/false bei Kopfzeilen-Profilen, sonst null
 */
export function extractRows(page, profile, reads = null) {
  const res = profile.rowAnchor === 'unit' ? extractRowsByUnit(page, profile)
    : profile.rowAnchor === 'part' ? extractRowsByPart(page, profile)
      : extractRowsByHeader(page, profile);
  for (const row of res.rows) resolveQuantities(row, reads);
  return res;
}

/** Schlüssel eines Bildbereichs (für die Zuordnung der Zellen-Lesungen). */
export function boxKey(b) {
  return [b.x0, b.y0, b.x1, b.y1].map((v) => v.toFixed(4)).join(',');
}

/** Ab dieser Sicherheit (Tesseract-Konfidenz) zählt das Zellen-Lesen mehr als das Seiten-Lesen. */
const CELL_CONF_MIN = 60;

/**
 * Mengen einer Zeile aus Seiten-OCR (row.cells[k].word) und Zellen-Lesen (reads) bestimmen.
 * Stimmen beide überein oder fehlt eins, gilt das vorhandene; widersprechen sie sich, gilt das Zellen-Lesen
 * (bei ausreichender Sicherheit) und die Zeile wird als unsicher markiert.
 */
function resolveQuantities(row, reads) {
  for (const [key, cell] of Object.entries(row.cells ?? {})) {
    const read = reads?.get(boxKey(cell.box));
    const cellValue = read?.value ?? null;
    let value = cell.word;
    let conflict = false;
    if (cellValue != null) {
      if (value == null) value = cellValue;
      else if (value !== cellValue) {
        conflict = true;
        if (read.conf >= CELL_CONF_MIN) value = cellValue;
      }
    }
    if (key === 'qty') {
      row.qty = value;
      row.qtyConflict = conflict;
    } else if (key === 'ordered') {
      row.qtyOrdered = value;
    } else if (key === 'pending') {
      row.qtyPending = value;
    }
  }
}

/**
 * Bereich um eine Zahl für das Zellen-Lesen: etwas Rand, damit keine Ziffer abgeschnitten wird.
 * h: Schrifthöhe (normiert auf die Seitenhöhe); der seitliche Rand wird über das Seitenverhältnis umgerechnet.
 */
function numberBox(page, b, h) {
  const hx = h * (page.height && page.width ? page.height / page.width : 1);
  const r = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  return { x0: r(b.x0 - 0.6 * hx), y0: r(b.y0 - 0.35 * h), x1: r(b.x1 + 0.6 * hx), y1: r(b.y1 + 0.35 * h), textHeight: h };
}

/** Position, Satzzeichen: gehören nicht zur Bestellnummer. */
const isPosition = (w) => /^0*\d{1,3}\.?$/.test(w.text.trim());
const isPunctuation = (w) => !/[0-9A-Za-z]/.test(w.text);

/**
 * Lesart „Einheit“: Jede Mengeneinheit (profile.unit, z. B. „ST“) markiert eine Positionszeile.
 * Die OCR liest Menge und Einheit teils als ein Wort („3ST“) – auch das wird erkannt.
 * Menge = Zahl direkt links der Einheit (darf durch die OCR leicht versetzt sein),
 * Bestellnummer = Wörter derselben Zeile links der Menge, ohne führende Positionsnummer.
 * Ist die Menge auf der Seite nicht lesbar (z. B. „10“ als „To“ gelesen) oder fehlt sie, entsteht die Zeile
 * trotzdem – die Menge kommt dann aus dem Zellen-Lesen des Bereichs vor der Einheit.
 * Tabellen ohne Einheit (z. B. Pack- oder Chargenlisten) liefern so keine Zeilen.
 */
function extractRowsByUnit(page, profile) {
  const words = page.words;
  const rows = [];
  const unitOnly = new RegExp(`^(${profile.unit})\\.?$`);
  const merged = new RegExp(`^([0-9OoIl|]+)(${profile.unit})\\.?$`);
  const aspect = page.height && page.width ? page.height / page.width : 1;
  const anchors = [];
  for (const w of words) {
    const t = w.text.trim();
    const h = w.bbox.y1 - w.bbox.y0;
    if (unitOnly.test(t)) {
      const uc = center(w.bbox);
      // Menge: kurzes Wort rechtsbündig vor der Einheit, vertikal höchstens etwa eine Zeilenhöhe versetzt
      const qtyWord = words
        .filter((q) => q !== w && q.bbox.x1 <= w.bbox.x0 + 0.005 && q.bbox.x1 >= w.bbox.x0 - 0.06
          && Math.abs(center(q.bbox).y - uc.y) < h * 1.2 && q.text.trim().length <= 5)
        .sort((a, b) => b.bbox.x1 - a.bbox.x1)[0];
      // ohne Wort: Bereich von etwa vier Ziffernbreiten vor der Einheit
      const qtyArea = qtyWord?.bbox ?? { x0: w.bbox.x0 - 2.4 * h * aspect, y0: w.bbox.y0, x1: w.bbox.x0, y1: w.bbox.y1 };
      anchors.push({ unit: w, qtyWord, left: qtyArea.x0, qty: qtyWord ? parseQty(qtyWord.text) : null, qtyArea });
    } else {
      const m = merged.exec(t);
      const qty = m && parseQty(m[1]);
      if (qty) {
        // nur der Ziffernteil des Worts („4ST“ → „4“), anteilig nach Zeichen
        const b = w.bbox;
        const qtyArea = { x0: b.x0, y0: b.y0, x1: b.x0 + (b.x1 - b.x0) * (m[1].length / t.length), y1: b.y1 };
        anchors.push({ unit: w, qtyWord: w, left: b.x0, qty, qtyArea });
      }
    }
  }

  for (const { unit, qtyWord, left, qty, qtyArea } of anchors) {
    const uc = center(unit.bbox);
    const h = unit.bbox.y1 - unit.bbox.y0;
    // Bestellnummer: Zeile links der Menge. Bei leicht schiefem Blatt liegt die Folgezeile (Hersteller,
    // Beschreibung) ähnlich nah – daher Textzeilen bilden und die Zeile mit Positionsnummer bevorzugen.
    const nearby = words
      .filter((w) => w !== qtyWord && w !== unit && w.bbox.x1 <= left && Math.abs(center(w.bbox).y - uc.y) < h * 2)
      .sort((a, b) => center(a.bbox).y - center(b.bbox).y);
    const lines = [];
    for (const w of nearby) {
      const last = lines[lines.length - 1];
      const cy = center(w.bbox).y;
      if (last && cy - last.cy < 0.5 * Math.max(h, w.bbox.y1 - w.bbox.y0)) last.words.push(w);
      else lines.push({ cy, words: [w] });
    }
    for (const l of lines) {
      l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      l.dy = Math.abs(l.words.reduce((sum, w) => sum + center(w.bbox).y, 0) / l.words.length - uc.y);
    }
    const byDistance = (a, b) => a.dy - b.dy;
    const line = lines.filter((l) => isPosition(l.words[0])).sort(byDistance)[0]
      ?? lines.filter((l) => l.dy < h * 0.6).sort(byDistance)[0];
    if (!line) continue;
    // Nur der zusammenhängende Block am Zeilenanfang (große Lücke = andere Spalte)
    const block = [];
    for (const w of line.words) {
      if (block.length && w.bbox.x0 - block[block.length - 1].bbox.x1 > 0.08) break;
      block.push(w);
    }
    if (block.length && isPosition(block[0])) block.shift();
    const partWords = block.filter((w) => !isPunctuation(w));
    if (!partWords.length) continue;
    rows.push({
      qty,
      part: partWords.map((w) => w.text).join(' ').replace(/[\s/]+$/, ''),
      box: unionBox([...partWords, ...(qtyWord ? [qtyWord] : []), unit]),
      conf: Math.round(Math.min(...partWords.map((w) => w.conf ?? 0))),
      cells: { qty: { word: qty, box: numberBox(page, qtyArea, h) } },
    });
  }
  rows.sort((a, b) => a.box.y0 - b.box.y0);
  return { headerFound: null, rows };
}

/**
 * Lesart „Kopfzeile“: Die Spaltengrenzen ergeben sich aus den Überschriften (profile.columns),
 * dadurch unabhängig von Bildausschnitt und Auflösung.
 */
function extractRowsByHeader(page, profile) {
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
    const qtyBox = unionBox(qtyWords);
    rows.push({
      qty,
      part: partWords.map((w) => w.text).join(' '),
      box: unionBox([...qtyWords, ...partWords]),
      conf: Math.round(Math.min(...partWords.map((w) => w.conf ?? 0))),
      cells: { qty: { word: qty, box: numberBox(page, qtyBox, qtyBox.y1 - qtyBox.y0) } },
    });
  }
  return { headerFound: true, rows };
}

/**
 * Lesart „Teilenummer“ (Mouser): Tabelle mit Rahmenlinien, Mengen stehen allein in eigenen Spalten.
 *   Zeilen:  jedes Wort im Muster profile.partPattern (z. B. „595-TCAN332D“), das in der Tabelle liegt
 *            (links und rechts davon senkrechte Tabellenlinien).
 *   Mengen:  Spalten zwischen den senkrechten Tabellenlinien, gezählt von rechts (profile.qtyColumns,
 *            z. B. { ordered: 3, qty: 2 } = drittletzte bzw. vorletzte Spalte); Bereich = Höhe der Teilenummer.
 *   Linien kommen aus vision.prepareForOcr (page.lines). Ohne Linien keine Mengen (→ Zellen leer, „prüfen“).
 */
function extractRowsByPart(page, profile) {
  const words = page.words;
  const vertical = tableBorders(page.lines?.v ?? []);
  const horizontal = rules(page.lines?.h ?? []);
  const rows = [];
  for (const w of words) {
    const t = w.text.trim().replace(/[.,;:]$/, '');
    if (!profile.partPattern.test(t)) continue;
    const cy = center(w.bbox).y;
    // Spaltengrenzen auf Höhe dieser Zeile
    const xs = vertical.filter((v) => v.y0 <= cy && v.y1 >= cy).map((v) => v.x);
    const leftOf = xs.filter((x) => x < w.bbox.x0);
    const rightOf = xs.filter((x) => x > w.bbox.x1);
    if (!leftOf.length || !rightOf.length) continue; // nicht in der Tabelle (z. B. Telefonnummer im Kopf)
    const h = w.bbox.y1 - w.bbox.y0;
    const cells = {};
    for (const [key, fromRight] of Object.entries(profile.qtyColumns)) {
      if (xs.length < fromRight + 1) continue;
      const x1 = xs[xs.length - fromRight];
      const x0 = xs[xs.length - fromRight - 1];
      if (x0 <= w.bbox.x1) continue; // Spalte läge links der Teilenummer – Tabelle nicht vollständig erkannt
      // Abstand zu den (in der aufbereiteten Seite entfernten) Linien; kleiner war in der Auswertung 11/2026 schlechter
      const inset = 0.003;
      const box = { x0: x0 + inset, y0: Math.max(0, w.bbox.y0 - 0.6 * h), x1: x1 - inset, y1: Math.min(1, w.bbox.y1 + 0.6 * h), textHeight: h };
      // Seiten-OCR: Zahl, deren Mitte im Bereich liegt
      const inCell = words.filter((q) => q !== w && center(q.bbox).x > box.x0 && center(q.bbox).x < box.x1
        && center(q.bbox).y > box.y0 && center(q.bbox).y < box.y1);
      const r = (v) => Math.round(v * 10000) / 10000;
      cells[key] = {
        word: inCell.length ? parseQty(inCell.map((q) => q.text).join(''), key === 'pending') : null,
        box: { x0: r(box.x0), y0: r(box.y0), x1: r(box.x1), y1: r(box.y1), textHeight: h },
      };
    }
    const cellRight = Math.max(0, ...Object.values(cells).map((c) => c.box.x1));
    if (!cellRight) continue;
    // Positionstabelle: über der Zeile liegt eine waagerechte Linie (Zeilen- oder Kopftrenner), die von der
    // Teilenummer bis über die Mengenspalten reicht. Schließt Treffer im Kopf aus (Telefonnummer neben einem
    // Strichcode, dessen Striche als senkrechte Linien gelten).
    const ruled = horizontal.some((l) => l.y < w.bbox.y0 && l.y > w.bbox.y0 - 0.25
      && l.x0 <= w.bbox.x0 + 0.01 && l.x1 >= cellRight - 0.01);
    if (!ruled) continue;
    rows.push({ qty: null, part: t, box: { ...w.bbox }, conf: Math.round(w.conf ?? 0), cells });
  }
  rows.sort((a, b) => a.box.y0 - b.box.y0);
  return { headerFound: null, rows };
}

/**
 * Senkrechte Tabellenlinien: Linienstücke mit (fast) gleichem x zusammenfassen (Unterbrechungen durch
 * Waagerechte oder Lücken im Druck). → [{ x, y0, y1 }] nach x sortiert, nur Linien ab 5 % Seitenhöhe
 */
function tableBorders(segments) {
  const merged = [];
  for (const s of [...segments].sort((a, b) => a.x - b.x)) {
    const m = merged.find((g) => Math.abs(g.x - s.x) < 0.006 && s.y0 <= g.y1 + 0.02 && s.y1 >= g.y0 - 0.02);
    if (m) {
      m.x = (m.x + s.x) / 2;
      m.y0 = Math.min(m.y0, s.y0);
      m.y1 = Math.max(m.y1, s.y1);
    } else {
      merged.push({ ...s });
    }
  }
  return merged.filter((g) => g.y1 - g.y0 >= 0.05).sort((a, b) => a.x - b.x);
}

/** Waagerechte Linien: Stücke auf (fast) gleicher Höhe mit kleinen Lücken zusammenfassen. → [{ x0, x1, y }] */
function rules(segments) {
  const merged = [];
  for (const s of [...segments].sort((a, b) => a.x0 - b.x0)) {
    const m = merged.find((g) => Math.abs(g.y - s.y) < 0.004 && s.x0 <= g.x1 + 0.02);
    if (m) {
      m.x1 = Math.max(m.x1, s.x1);
      m.y = (m.y + s.y) / 2;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
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
  const check = (entry, reason) => {
    entry.status = 'check';
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };
  for (const a of assignments) {
    if (!a.itemId) continue;
    const entry = (perItem[a.itemId] ??= { qty: 0, status: 'sure', reasons: [], rows: 0, unreadable: false, confirmed: true });
    const it = items.find((x) => x.id === a.itemId);
    entry.rows += 1;
    if (a.row.qty == null) entry.unreadable = true;
    else entry.qty += a.row.qty;
    if (a.status === 'check') check(entry, a.reason);
    if (a.row.qtyConflict) check(entry, 'Menge unsicher gelesen');
    // Bestellte Menge laut Lieferschein (falls das Profil sie liest) mit der Bestellung vergleichen
    const { qty, qtyOrdered, qtyPending } = a.row;
    if (qtyOrdered != null && qtyOrdered !== it.qty_ordered) {
      check(entry, `bestellt laut Lieferschein ${qtyOrdered}, in der Bestellung ${it.qty_ordered}`);
    }
    // Teillieferung laut Lieferschein: nur sicher, wenn geliefert + ausstehend = bestellt aufgeht – sonst kann
    // auch eine verlesene Ziffer dahinterstecken („20“ als „2“)
    if (qty != null && qtyOrdered != null && qty !== qtyOrdered && !(qtyPending != null && qty + qtyPending === qtyOrdered)) {
      check(entry, 'Teillieferung – Menge bitte prüfen');
    }
    // Vom Lieferschein bestätigt ist eine Menge nur, wenn geliefert + ausstehend = bestellt aufgeht
    if (!(qty != null && qtyOrdered != null && qtyPending != null && qty + qtyPending === qtyOrdered)) entry.confirmed = false;
  }
  for (const it of items) {
    const entry = perItem[it.id];
    if (!entry) continue;
    if (entry.rows > 1) check(entry, 'mehrere Zeilen zugeordnet');
    const backlog = Math.max(0, it.qty_ordered - (it.qty_delivered || 0) - (it.qty_cancelled || 0));
    if (entry.unreadable) {
      // Menge nicht lesbar: offene Menge vorschlagen (bei Mouser meist richtig), immer prüfen lassen
      entry.qty = Math.max(entry.qty, backlog);
      check(entry, 'Menge nicht lesbar – offene Menge vorgeschlagen');
    } else if (entry.qty > backlog) {
      check(entry, `mehr als der Rückstand (${backlog})`);
    } else if (entry.qty < backlog && !entry.confirmed) {
      // Weniger als offen: echte Teillieferung oder verlesene Ziffer („10“ als „3“) – ohne Bestätigung
      // durch den Lieferschein (bestellt/ausstehend) nicht als sicher übernehmen
      check(entry, 'Teillieferung – Menge bitte prüfen');
    }
    delete entry.confirmed;
  }
  return { assignments, perItem };
}

// ---------------------------------------------------------------------------
// Interne Bestellnummer der Hochschule (JJJJIW#####) – steht bei allen Lieferanten auf dem Lieferschein
// ---------------------------------------------------------------------------

/** OCR-Verwechslungen in Ziffernfeldern. */
const DIGIT_FIX = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1' };
/**
 * 4 Ziffern, „I“ (oft als 1/l/|// gelesen, bei kleiner Schrift auch verdoppelt wie „I1“), „W“ (auch „VV“),
 * 5 Ziffern – Satzzeichen am Rand werden ignoriert.
 */
const INTERNAL_NO_FUZZY = /^([0-9OoDQIli|!]{4})[I1li|!/]{1,2}(W|VV)([0-9OoDQIli|!]{5})$/;

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
