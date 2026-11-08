// Bildvorverarbeitung: Foto laden, Blattecken finden (jscanify/OpenCV.js), perspektivisch entzerren.
// OpenCV.js (~13 MB) wird erst beim ersten Aufruf von loadVision() geladen.

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const OPENCV_URL = VENDOR + '@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
const JSCANIFY_URL = VENDOR + 'jscanify@1.4.3/src/jscanify.js';

/** Längste Bildseite beim Arbeiten (Handyfotos haben oft 4000 px und mehr). */
const MAX_SOURCE_SIDE = 3200;
/** Längste Seite für die Eckenerkennung (schneller, genügt für die Kontur). */
const DETECT_SIDE = 1000;
/** Breite der entzerrten Seite in Pixeln (A4 bei ca. 220 dpi – gut für OCR). */
export const PAGE_WIDTH = 1800;

let readyPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Konnte nicht geladen werden: ' + src));
    document.head.appendChild(el);
  });
}

/** Lädt OpenCV.js und jscanify (einmalig). */
export function loadVision() {
  readyPromise ??= (async () => {
    await loadScript(OPENCV_URL);
    // Je nach Build ist `cv` ein Promise/Thenable oder meldet sich über onRuntimeInitialized.
    if (typeof window.cv?.then === 'function') window.cv = await window.cv;
    if (!window.cv?.Mat) await new Promise((resolve) => { window.cv.onRuntimeInitialized = resolve; });
    await loadScript(JSCANIFY_URL);
    if (typeof window.jscanify !== 'function') throw new Error('jscanify nicht verfügbar.');
  })().catch((err) => {
    readyPromise = null; // erneuter Versuch beim nächsten Öffnen
    throw err;
  });
  return readyPromise;
}

/** Bilddatei → Canvas (EXIF-Drehung beachtet, auf MAX_SOURCE_SIDE verkleinert). */
export async function fileToCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

function scaledCopy(canvas, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return { canvas: out, scale };
}

/** Fläche eines Vierecks (Gaußsche Trapezformel). */
function quadArea(c) {
  const pts = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Standard-Ecken (leicht eingerückt), falls kein Blatt erkannt wird. */
export function defaultCorners(width, height, inset = 0.04) {
  const dx = width * inset;
  const dy = height * inset;
  return {
    topLeftCorner: { x: dx, y: dy },
    topRightCorner: { x: width - dx, y: dy },
    bottomRightCorner: { x: width - dx, y: height - dy },
    bottomLeftCorner: { x: dx, y: height - dy },
  };
}

/**
 * Blattecken im Bild suchen.
 * → { corners, detected }  (detected = false: Standard-Ecken, Nutzer muss anpassen)
 */
export function detectCorners(canvas) {
  const { canvas: small, scale } = scaledCopy(canvas, DETECT_SIDE);
  const scanner = new window.jscanify();
  const mat = window.cv.imread(small);
  let contour = null;
  try {
    contour = scanner.findPaperContour(mat);
    if (contour) {
      const c = scanner.getCornerPoints(contour, mat);
      const complete = c.topLeftCorner && c.topRightCorner && c.bottomLeftCorner && c.bottomRightCorner;
      if (complete && quadArea(c) > 0.2 * small.width * small.height) {
        const corners = Object.fromEntries(
          Object.entries(c).map(([k, p]) => [k, { x: p.x / scale, y: p.y / scale }]));
        return { corners, detected: true };
      }
    }
  } finally {
    mat.delete();
    contour?.delete?.();
  }
  return { corners: defaultCorners(canvas.width, canvas.height), detected: false };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Entzerrt den durch `corners` begrenzten Bereich. Seitenverhältnis aus den Kantenlängen. */
export function rectify(canvas, corners) {
  const c = corners;
  const w = Math.max(dist(c.topLeftCorner, c.topRightCorner), dist(c.bottomLeftCorner, c.bottomRightCorner));
  const h = Math.max(dist(c.topLeftCorner, c.bottomLeftCorner), dist(c.topRightCorner, c.bottomRightCorner));
  const width = PAGE_WIDTH;
  const height = Math.round(PAGE_WIDTH * (h / w));
  const scanner = new window.jscanify();
  return scanner.extractPaper(canvas, width, height, corners);
}

/** Canvas → JPEG-Blob in Farbe (Originalfoto für Problem-Meldungen). */
export function toJpeg(canvas, quality = 0.85) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG-Erzeugung fehlgeschlagen.'))), 'image/jpeg', quality));
}

/** Canvas → JPEG-Blob in Graustufen (kleiner, für Beleg-PDF). */
export function toGrayJpeg(canvas, quality = 0.75) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG-Erzeugung fehlgeschlagen.'))), 'image/jpeg', quality));
}
