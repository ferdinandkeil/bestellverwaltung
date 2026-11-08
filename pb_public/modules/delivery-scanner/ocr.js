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

/** Speicher freigeben (beim Schließen des Scanners). */
export async function terminateOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (p) {
    try { await (await p).terminate(); } catch { /* bereits beendet */ }
  }
}
