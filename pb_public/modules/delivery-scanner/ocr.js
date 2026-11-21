// Texterkennung mit Tesseract.js (selbst gehostet). Liefert Wörter mit normierten Koordinaten (0..1).
// Engine und Sprachdaten (~10 MB) werden erst beim ersten Aufruf geladen.

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const TESSERACT_URL = VENDOR + 'tesseract.js@7.0.0/dist/tesseract.esm.min.js';
const WORKER_URL = VENDOR + 'tesseract.js@7.0.0/dist/worker.min.js';
const CORE_PATH = VENDOR + 'tesseract.js-core@7.0.0';
const LANG_PATH = VENDOR + 'tessdata/4.0.0_best_int';
const LANGS = ['deu', 'eng'];
const OEM_LSTM_ONLY = 1;

let workerPromise = null;
let progressListener = null;

function getWorker() {
  workerPromise ??= (async () => {
    const { default: Tesseract } = await import(TESSERACT_URL);
    return Tesseract.createWorker(LANGS, OEM_LSTM_ONLY, {
      workerPath: WORKER_URL,
      corePath: CORE_PATH,
      langPath: LANG_PATH,
      logger: (m) => progressListener?.(m),
    });
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

/** Engine vorab laden (z. B. beim Öffnen des Scanners). */
export function preloadOcr() {
  return getWorker();
}

/**
 * Texterkennung einer Seite.
 * onProgress(anteil 0..1, statusText)
 * → { width, height, text, words: [{ text, conf, bbox: { x0, y0, x1, y1 } }] }  (bbox normiert 0..1)
 */
export async function recognizePage(canvas, onProgress) {
  progressListener = (m) => {
    if (typeof m.progress === 'number') onProgress?.(m.progress, m.status);
  };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const W = canvas.width;
    const H = canvas.height;
    const words = (data.blocks ?? [])
      .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
      .map((w) => ({
        text: w.text,
        conf: w.confidence,
        bbox: { x0: w.bbox.x0 / W, y0: w.bbox.y0 / H, x1: w.bbox.x1 / W, y1: w.bbox.y1 / H },
      }));
    return { width: W, height: H, text: data.text ?? '', words };
  } finally {
    progressListener = null;
  }
}

// ---- Ziffern in Tabellenzellen ---------------------------------------------------------------------
// Eigener Worker, fest eingestellt auf „eine Textzeile, nur Ziffern“ (PSM 7 + Whitelist). Mengen stehen oft
// allein in Tabellenzellen; die Seiten-OCR übergeht sie oder verliest sie („10“ → „To“). Ein getrennter Worker
// vermeidet, die Einstellungen des Seiten-Workers umzuschalten. Wird erst beim ersten Zellen-Lesen geladen.

const PSM_SINGLE_LINE = '7';
/** Ziel-Schrifthöhe in Pixeln für das Zellen-Lesen (kleinere Ziffern werden hochgerechnet). */
const DIGIT_TARGET_PX = 48;

let digitWorkerPromise = null;

function getDigitWorker() {
  digitWorkerPromise ??= (async () => {
    const { default: Tesseract } = await import(TESSERACT_URL);
    const worker = await Tesseract.createWorker(['eng'], OEM_LSTM_ONLY, { workerPath: WORKER_URL, corePath: CORE_PATH, langPath: LANG_PATH });
    await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_LINE, tessedit_char_whitelist: '0123456789' });
    return worker;
  })().catch((err) => {
    digitWorkerPromise = null;
    throw err;
  });
  return digitWorkerPromise;
}

/**
 * Zahlen in Bildbereichen lesen (je Bereich eine Zahl, z. B. eine Mengenzelle).
 * canvas: aufbereitete Seite (vision.prepareForOcr); boxes: [{ x0, y0, x1, y1 }] normiert 0..1,
 * textHeight: erwartete Schrifthöhe (normiert) zum Hochrechnen kleiner Ziffern.
 * → [{ text, value (Zahl oder null), conf }] in derselben Reihenfolge
 */
export async function recognizeNumbers(canvas, boxes) {
  if (!boxes.length) return [];
  const empty = { text: '', value: null, conf: 0 };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  let worker = null;
  for (const b of boxes) {
    const sx = Math.max(0, Math.floor(b.x0 * canvas.width));
    const sy = Math.max(0, Math.floor(b.y0 * canvas.height));
    const sw = Math.min(canvas.width, Math.ceil(b.x1 * canvas.width)) - sx;
    const sh = Math.min(canvas.height, Math.ceil(b.y1 * canvas.height)) - sy;
    if (sw < 4 || sh < 4 || !hasInk(ctx.getImageData(sx, sy, sw, sh))) { out.push(empty); continue; } // leere Zelle
    // Ganzen Bereich auf etwa DIGIT_TARGET_PX Schrifthöhe hochrechnen, weißer Rand. (Ausgewertet 11/2026:
    // enger Ausschnitt um die Schrift und Kontrastspreizung waren nicht besser bzw. schlechter.)
    const textPx = (b.textHeight ?? (b.y1 - b.y0) / 2) * canvas.height;
    const k = Math.min(4, Math.max(1, DIGIT_TARGET_PX / Math.max(1, textPx)));
    const pad = 16;
    const crop = document.createElement('canvas');
    crop.width = Math.round(sw * k) + 2 * pad;
    crop.height = Math.round(sh * k) + 2 * pad;
    const c2 = crop.getContext('2d');
    c2.fillStyle = '#fff';
    c2.fillRect(0, 0, crop.width, crop.height);
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(canvas, sx, sy, sw, sh, pad, pad, crop.width - 2 * pad, crop.height - 2 * pad);
    worker ??= await getDigitWorker();
    const { data } = await worker.recognize(crop);
    const text = (data.text ?? '').replace(/\s+/g, '');
    out.push({ text, value: /^\d+$/.test(text) ? Number(text) : null, conf: Math.round(data.confidence ?? 0) });
  }
  return out;
}

/** Ist nichts dunkler als dieser Grauwert, gilt eine Zelle als leer. */
const EMPTY_LEVEL = 200;

/**
 * Enthält der Bildausschnitt Schrift? Schwelle je Ausschnitt (halber Weg zwischen dunkelstem Pixel und Weiß,
 * blasser Druck zählt mit); einzelne Störpixel und flache Strichreste (unter 4 Pixel hoch) zählen nicht.
 */
function hasInk(img) {
  const { width: w, height: h, data } = img;
  let min = 255;
  for (let i = 0; i < data.length; i += 4) if (data[i] < min) min = data[i];
  if (min > EMPTY_LEVEL) return false;
  const level = (min + 255) / 2;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (data[(y * w + x) * 4] < level) n++;
    if (n > 1) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return top >= 0 && bottom - top >= 3;
}

/** Speicher freigeben (beim Schließen des Scanners). */
export async function terminateOcr() {
  for (const p of [workerPromise, digitWorkerPromise]) {
    if (!p) continue;
    try { await (await p).terminate(); } catch { /* bereits beendet */ }
  }
  workerPromise = null;
  digitWorkerPromise = null;
}
