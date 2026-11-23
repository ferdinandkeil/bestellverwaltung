// Vorschau der ersten Seite einer PDF als Bild (ARCHITECTURE.md Kap. 7, Anhänge der Bestellung).
// PDF.js wird erst beim ersten Aufruf geladen (vendor/, feste Version); Ergebnisse je URL zwischengespeichert.

const PDFJS = '../vendor/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const WORKER = new URL('../vendor/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs', import.meta.url).href;

let pdfjsPromise = null;
const cache = new Map(); // url → Promise<string> (Object-URL des Vorschaubilds)

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = WORKER;
      return lib;
    }).catch((err) => {
      pdfjsPromise = null; // nächster Versuch lädt neu
      throw err;
    });
  }
  return pdfjsPromise;
}

/**
 * Erste Seite als PNG-Object-URL, so skaliert, dass die Breite `width` Pixel beträgt.
 * @returns {Promise<string>} schlägt fehl, wenn die PDF nicht gelesen werden kann (Aufrufer zeigt dann „PDF“)
 */
export function pdfPreview(url, width = 400) {
  const key = `${url}#${width}`;
  if (!cache.has(key)) {
    const job = (async () => {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ url }).promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        return URL.createObjectURL(blob);
      } finally {
        doc.destroy();
      }
    })();
    job.catch(() => cache.delete(key));
    cache.set(key, job);
  }
  return cache.get(key);
}
