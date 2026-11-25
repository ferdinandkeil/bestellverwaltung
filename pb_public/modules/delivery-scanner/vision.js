// Bildvorverarbeitung: Foto laden, Blattecken finden (jscanify/OpenCV.js), perspektivisch entzerren.
// OpenCV.js (~13 MB) wird erst beim ersten Aufruf von loadVision() geladen.

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const OPENCV_URL = VENDOR + '@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
const JSCANIFY_URL = VENDOR + 'jscanify@1.4.3/src/jscanify.js';

/**
 * Längste Bildseite beim Arbeiten. Handykameras liefern meist ~4000 px; die volle Auflösung wird gebraucht,
 * damit kleine Ziffern (z. B. Mouser-Mengen, 6,5 pt) lesbar bleiben. Größere Fotos (50-MP-Modus) werden verkleinert.
 */
const MAX_SOURCE_SIDE = 4096;
/** Längste Seite für die Eckenerkennung (schneller, genügt für die Kontur). */
const DETECT_SIDE = 1000;
/**
 * Breite der entzerrten Seite: so breit wie das Blatt im Foto (keine Auflösung verschenken),
 * aber mindestens PAGE_MIN_WIDTH (kleine Fotos werden hochgerechnet, A4 ≈ 220 dpi) und höchstens PAGE_MAX_WIDTH.
 */
export const PAGE_MIN_WIDTH = 1800;
export const PAGE_MAX_WIDTH = 4096;
/** Breite, auf der die Schärfe gemessen wird (Werte damit unabhängig von der Fotoauflösung vergleichbar). */
const SHARPNESS_WIDTH = 1800;
/**
 * Unter diesem Schärfewert (siehe sharpness) gilt ein Foto als unscharf. Kalibriert 22.11.2026 an echten
 * Belegen, Mouser-Testbelegen und dem Testblatt KT1: lesbare Fotos 720–3700, verwackeltes Foto 181.
 */
export const SHARPNESS_MIN = 400;

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

/** Verkleinerte Kopie (längste Seite ≤ maxSide); kleinere Bilder werden unverändert zurückgegeben. */
export function downscale(canvas, maxSide) {
  return Math.max(canvas.width, canvas.height) <= maxSide ? canvas : scaledCopy(canvas, maxSide).canvas;
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

/** Mindestanteil des Bildes, den ein erkanntes Blatt einnehmen muss. */
const MIN_PAPER_SHARE = 0.2;

/**
 * Liegt das Viereck verdächtig am Bildrand? Mehr als zwei Ecken am Rand oder eine Ecke in einer Bildecke heißt:
 * Untergrund bzw. Bildrahmen mit erfasst (ein Blatt, das über das Bild hinausragt, hat seine Ecken auf den Kanten,
 * nicht in den Bildecken).
 */
function hugsBorder(quad, W, H) {
  const margin = 0.015 * Math.max(W, H);
  const nearX = (p) => p.x < margin || p.x > W - margin;
  const nearY = (p) => p.y < margin || p.y > H - margin;
  const corners = Object.values(quad);
  return corners.filter((p) => nearX(p) || nearY(p)).length > 2 || corners.some((p) => nearX(p) && nearY(p));
}

/** Blattkontur über jscanify (Kanten). → Ecken im kleinen Bild oder null */
function contourQuad(small) {
  const scanner = new window.jscanify();
  const mat = window.cv.imread(small);
  let contour = null;
  try {
    contour = scanner.findPaperContour(mat);
    if (!contour) return null;
    const c = scanner.getCornerPoints(contour, mat);
    const complete = c.topLeftCorner && c.topRightCorner && c.bottomLeftCorner && c.bottomRightCorner;
    if (!complete || hugsBorder(c, small.width, small.height)) return null;
    return quadArea(c) > MIN_PAPER_SHARE * small.width * small.height ? c : null;
  } finally {
    mat.delete();
    contour?.delete?.();
  }
}

/**
 * Blatt als große Fläche in einer Schwarz-Weiß-Maske (Otsu-Schwelle), auf ein Viereck vereinfacht. Greift, wo die
 * Kantensuche scheitert (helles Blatt auf hellem Tisch) oder nur einen Teil erfasst (Knick im gefalteten Blatt).
 * Verworfen, wenn die Fläche praktisch das ganze Bild ist, mehr als zwei Ecken am Bildrand liegen oder eine Ecke
 * in einer Bildecke klebt (dann ist der Untergrund mit erfasst). → { quad, fit } im kleinen Bild oder null
 *   fit = Überdeckung von Fläche und Viereck (Schnitt / Vereinigung, 1 = deckungsgleich)
 */
function maskQuad(mask, W, H) {
  const cv = window.cv;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  const filled = cv.Mat.zeros(H, W, cv.CV_8U);
  const quadMask = cv.Mat.zeros(H, W, cv.CV_8U);
  const both = new cv.Mat();
  let quadPts = null;
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > bestArea) { bestArea = a; best = i; }
    }
    if (best < 0 || bestArea < MIN_PAPER_SHARE * W * H || bestArea > 0.97 * W * H) return null;
    cv.convexHull(contours.get(best), hull);
    // Auf vier Ecken vereinfachen; schneidet ein Schatten eine Ecke an (Fünfeck), gröber vereinfachen und
    // notfalls die vier äußersten Punkte der Hülle nehmen.
    const toPoints = (m) => Array.from({ length: m.rows }, (_, i) => ({ x: m.data32S[2 * i], y: m.data32S[2 * i + 1] }));
    let pts = null;
    for (const eps of [0.02, 0.04, 0.06]) {
      cv.approxPolyDP(hull, approx, eps * cv.arcLength(hull, true), true);
      if (approx.rows === 4) { pts = toPoints(approx); break; }
    }
    pts ??= toPoints(hull);
    const pick = (f) => pts.reduce((m, p) => (f(p) < f(m) ? p : m));
    const quad = {
      topLeftCorner: pick((p) => p.x + p.y),
      bottomRightCorner: pick((p) => -(p.x + p.y)),
      topRightCorner: pick((p) => p.y - p.x),
      bottomLeftCorner: pick((p) => p.x - p.y),
    };
    // Das Viereck muss die Fläche im Wesentlichen abdecken und darf nicht am Bildrand kleben
    const area = quadArea(quad);
    if (area < 0.85 * bestArea) return null;
    if (hugsBorder(quad, W, H)) return null;
    // Überdeckung: Fläche und Viereck gerastert vergleichen
    const white = new cv.Scalar(255);
    cv.drawContours(filled, contours, best, white, cv.FILLED);
    quadPts = new cv.MatVector();
    const q = [quad.topLeftCorner, quad.topRightCorner, quad.bottomRightCorner, quad.bottomLeftCorner];
    quadPts.push_back(cv.matFromArray(4, 1, cv.CV_32SC2, q.flatMap((p) => [p.x, p.y])));
    cv.fillPoly(quadMask, quadPts, white);
    cv.bitwise_and(filled, quadMask, both);
    const inter = cv.countNonZero(both);
    cv.bitwise_or(filled, quadMask, both);
    return { quad, fit: inter / cv.countNonZero(both) };
  } finally {
    [contours, hierarchy, hull, approx, filled, quadMask, both].forEach((m) => m.delete());
    if (quadPts) { quadPts.get(0).delete(); quadPts.delete(); }
  }
}

/**
 * Blatt über Masken suchen: hell (Helligkeit), farblos (wenig Sättigung – weißes Papier auf beigem oder
 * holzfarbenem Tisch, auch im Schatten) und beides zusammen (Helligkeit − Sättigung). Jede Maske mit eigener
 * Otsu-Schwelle; genommen wird das Viereck, das mit seiner Fläche am besten übereinstimmt (Fehlgriffe ziehen
 * Teile des Tisches mit und sind unregelmäßig). Bis 11/2026 nur die Helligkeit – auf hellem Tisch lief die Fläche in den
 * Untergrund über. → Ecken im kleinen Bild oder null
 */
function brightQuad(small) {
  const cv = window.cv;
  const W = small.width;
  const H = small.height;
  const src = cv.imread(small);
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const gray = new cv.Mat();
  const whiteness = new cv.Mat();
  const bin = new cv.Mat();
  let sat = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    sat = channels.get(1);
    cv.subtract(gray, sat, whiteness);
    const blur = (m) => cv.GaussianBlur(m, m, new cv.Size(5, 5), 0);
    [gray, sat, whiteness].forEach(blur);
    let best = null;
    for (const [m, type] of [[gray, cv.THRESH_BINARY], [sat, cv.THRESH_BINARY_INV], [whiteness, cv.THRESH_BINARY]]) {
      cv.threshold(m, bin, 0, 255, type + cv.THRESH_OTSU);
      const r = maskQuad(bin, W, H);
      if (r && (!best || r.fit > best.fit)) best = r;
    }
    return best?.quad ?? null;
  } finally {
    [src, rgb, hsv, channels, gray, whiteness, bin].forEach((m) => m.delete());
    sat?.delete();
  }
}

/**
 * Blattecken im Bild suchen: zuerst die Kantenkontur (jscanify), sonst bzw. wenn diese deutlich kleiner ist
 * als die helle Fläche (gefaltetes Blatt, nur eine Hälfte erfasst), die helle Fläche.
 * → { corners, detected, method }  (detected = false: Standard-Ecken, Nutzer muss anpassen;
 *    method: 'contour' | 'bright' | null)
 */
export function detectCorners(canvas) {
  const { canvas: small, scale } = scaledCopy(canvas, DETECT_SIDE);
  const byContour = contourQuad(small);
  const byBrightness = brightQuad(small);
  let c = byContour;
  let method = 'contour';
  if (byBrightness && (!byContour || quadArea(byContour) < 0.75 * quadArea(byBrightness))) {
    c = byBrightness;
    method = 'bright';
  }
  if (!c) return { corners: defaultCorners(canvas.width, canvas.height), detected: false, method: null };
  const corners = Object.fromEntries(Object.entries(c).map(([k, p]) => [k, { x: p.x / scale, y: p.y / scale }]));
  return { corners, detected: true, method };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Entzerrt den durch `corners` begrenzten Bereich. Seitenverhältnis aus den Kantenlängen, Breite wie das Blatt
 * im Foto (zwischen PAGE_MIN_WIDTH und PAGE_MAX_WIDTH).
 */
export function rectify(canvas, corners) {
  const c = corners;
  const w = Math.max(dist(c.topLeftCorner, c.topRightCorner), dist(c.bottomLeftCorner, c.bottomRightCorner));
  const h = Math.max(dist(c.topLeftCorner, c.bottomLeftCorner), dist(c.topRightCorner, c.bottomRightCorner));
  const width = Math.round(Math.min(PAGE_MAX_WIDTH, Math.max(PAGE_MIN_WIDTH, w)));
  const height = Math.round(width * (h / w));
  const scanner = new window.jscanify();
  return scanner.extractPaper(canvas, width, height, corners);
}

/**
 * Schärfe der entzerrten Seite: Varianz des Laplace-Filters, gemessen nur in der Nähe von Kanten (Text,
 * Linien) auf einer Kopie mit SHARPNESS_WIDTH Breite. Größer = schärfer. Anders als die Varianz über die
 * ganze Seite hängt der Wert kaum davon ab, wie viel Text auf dem Blatt steht (bis 11/2026: ganze Seite;
 * ein dicht bedruckter Beleg lag dort doppelt so hoch wie ein gleich scharfes, fast leeres Blatt).
 */
export function sharpness(page) {
  const cv = window.cv;
  const k = SHARPNESS_WIDTH / page.width;
  const copy = document.createElement('canvas');
  copy.width = SHARPNESS_WIDTH;
  copy.height = Math.round(page.height * k);
  copy.getContext('2d').drawImage(page, 0, 0, copy.width, copy.height);
  const src = cv.imread(copy);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  const lap = new cv.Mat();
  const mean = new cv.Mat();
  const std = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Kantenmaske: Canny auf leicht geglättetem Bild (Papierstruktur, Rauschen fallen weg), etwas verbreitert
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 30, 90);
    cv.dilate(edges, edges, kernel);
    if (cv.countNonZero(edges) < 0.002 * edges.rows * edges.cols) return 0; // (fast) leeres Bild
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std, edges);
    return Math.round(std.doubleAt(0, 0) ** 2);
  } finally {
    [src, gray, blurred, edges, kernel, lap, mean, std].forEach((m) => m.delete());
  }
}

/** Kürzeste Länge (Anteil der Seitenbreite), ab der ein gerader Strich als Tabellen- bzw. Unterstreichungslinie gilt. */
const LINE_MIN_SHARE = 1 / 40;
/**
 * Größte mittlere Strichstärke (Anteil der Seitenbreite) einer Linie. Dickere lange Striche sind Teile großer
 * Schrift (Logo, Überschrift) und bleiben stehen. 0,4 % ≈ 0,8 mm auf A4 – Tabellenlinien sind deutlich dünner.
 */
const LINE_MAX_THICKNESS = 0.004;
/** Grauwert, ab dem die ausgeglichene Seite als Papier (weiß) gilt. */
const PAPER_WHITE = 215;
/** Rand der entzerrten Seite (Anteil), der für die OCR weiß gesetzt wird. */
const EDGE_MARGIN = 0.008;

/**
 * Seite für die Texterkennung aufbereiten (Tesseract teilt die Seite sonst an Tabellenlinien falsch auf und
 * übergeht einzeln stehende Zahlen in Kästchen):
 *   1. Hintergrund ausgleichen – Graubild durch den geschätzten Papierhintergrund teilen, Papier wird weiß
 *      (Schatten, Farbstich und Helligkeitsverlauf verschwinden).
 *   2. Lange waagerechte und senkrechte Linien finden und weiß übermalen (Tabellenrahmen, Unterstreichungen).
 * Bewertet 11/2026 an echten Mouser-Belegen: Mengen in Tabellenzellen 0/20 → 18/20 gelesen; Testblatt KT1:
 * Ziffern im Kästchen bis 5 pt lesbar. Andere Lieferanten unverändert oder besser.
 * → { canvas (Graustufen, für die OCR), lines: { h: [{ x0, x1, y }], v: [{ x, y0, y1 }] } }  (normiert 0..1)
 */
export function prepareForOcr(page) {
  const cv = window.cv;
  const W = page.width;
  const H = page.height;
  const L = Math.max(15, Math.round(W * LINE_MIN_SHARE));
  const mats = [];
  const mat = (m) => (mats.push(m), m);
  try {
    const src = mat(cv.imread(page));
    const gray = mat(new cv.Mat());
    const bg = mat(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Hintergrund: Schrift wegdehnen (Maximum 7×7), glätten (Median 31) → Papierhelligkeit je Stelle
    cv.dilate(gray, bg, mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7))));
    cv.medianBlur(bg, bg, 31);
    cv.divide(gray, bg, gray, 255);

    // Linien: Binärbild (dunkel = 255), Öffnen mit langen Strukturelementen behält nur lange Striche
    const bin = mat(new cv.Mat());
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 15);
    const hMask = mat(new cv.Mat());
    const vMask = mat(new cv.Mat());
    cv.morphologyEx(bin, hMask, cv.MORPH_OPEN, mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(L, 1))));
    cv.morphologyEx(bin, vMask, cv.MORPH_OPEN, mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, L))));
    // nur dünne Striche sind Linien (Masken werden darauf beschränkt)
    const maxThick = Math.max(3, W * LINE_MAX_THICKNESS);
    const lines = { h: thinLines(hMask, bin, W, H, 'h', maxThick), v: thinLines(vMask, bin, W, H, 'v', maxThick) };

    const mask = mat(new cv.Mat());
    cv.bitwise_or(hMask, vMask, mask);
    cv.dilate(mask, mask, mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))));
    gray.setTo(new cv.Scalar(255), mask);

    // Fast-Weiß (blasse Säume um entfernte Linien, Papierstruktur) auf Weiß ziehen: bei PAPER_WHITE kappen
    // und auf 0..255 strecken – Schrift bleibt dunkel, der Hintergrund wird gleichmäßig weiß.
    cv.threshold(gray, gray, PAPER_WHITE, 255, cv.THRESH_TRUNC);
    gray.convertTo(gray, -1, 255 / PAPER_WHITE, 0);
    // Schmaler Rand ringsum weiß: dort liegen nach dem Entzerren oft Reste des Untergrunds, die die OCR
    // als „|“, „1“ oder „3“ liest (und z. B. für eine Positionsnummer hält).
    const mx = Math.round(W * EDGE_MARGIN);
    const my = Math.round(H * EDGE_MARGIN);
    for (const [x, y, w, h] of [[0, 0, W, my], [0, H - my, W, my], [0, 0, mx, H], [W - mx, 0, mx, H]]) {
      mat(gray.roi(new cv.Rect(x, y, w, h))).setTo(new cv.Scalar(255));
    }

    const out = document.createElement('canvas');
    cv.imshow(out, gray);
    return { canvas: out, lines };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

/**
 * Linienstücke einer Maske (zusammenhängende Bereiche). Als Linie gilt nur ein Stück, das
 *   – dünn ist (mittlere Strichstärke = Fläche/Länge ≤ maxThick Pixel; lange dicke Striche gehören zu großer Schrift),
 *   – frei steht: in schmalen Streifen beidseits (über/unter bzw. links/rechts) ist es überwiegend hell. Innerhalb
 *     fetter Schrift, deren Buchstaben sich berühren, entstehen sonst dünne „Linien“ quer durch die Buchstaben.
 * Die Maske wird auf diese Stücke beschränkt. → Linienstücke in normierten Koordinaten
 */
function thinLines(mask, bin, W, H, dir, maxThick) {
  const cv = window.cv;
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const keep = cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8U);
  try {
    const n = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
    const out = [];
    const r = (v) => Math.round(v * 10000) / 10000;
    for (let i = 1; i < n; i++) {  // 0 = Hintergrund
      const x = stats.intAt(i, cv.CC_STAT_LEFT);
      const y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const length = dir === 'h' ? w : h;
      if (stats.intAt(i, cv.CC_STAT_AREA) / length > maxThick) continue;
      if (!standsFree(bin, x, y, w, h, dir)) continue;
      cv.rectangle(keep, new cv.Point(x, y), new cv.Point(x + w - 1, y + h - 1), new cv.Scalar(255), -1);
      out.push(dir === 'h'
        ? { x0: r(x / W), x1: r((x + w) / W), y: r((y + h / 2) / H) }
        : { x: r((x + w / 2) / W), y0: r(y / H), y1: r((y + h) / H) });
    }
    cv.bitwise_and(mask, keep, mask);
    return out;
  } finally {
    [labels, stats, centroids, keep].forEach((m) => m.delete());
  }
}

/** Anteil dunkler Pixel, ab dem ein Seitenstreifen neben einem Linienstück als „bedeckt“ gilt. */
const LINE_SIDE_DARK = 0.5;

/** Ist es beidseits des Linienstücks (Streifen 2 px, 2 px Abstand) überwiegend hell? */
function standsFree(bin, x, y, w, h, dir) {
  const cv = window.cv;
  const gap = 2;
  const band = 2;
  const sides = dir === 'h'
    ? [[x, y - gap - band, w, band], [x, y + h + gap, w, band]]
    : [[x - gap - band, y, band, h], [x + w + gap, y, band, h]];
  for (const [sx, sy, sw, sh] of sides) {
    const cx = Math.max(0, sx);
    const cy = Math.max(0, sy);
    const cw = Math.min(bin.cols, sx + sw) - cx;
    const ch = Math.min(bin.rows, sy + sh) - cy;
    if (cw <= 0 || ch <= 0) continue; // am Seitenrand
    const roi = bin.roi(new cv.Rect(cx, cy, cw, ch));
    const dark = cv.countNonZero(roi) / (cw * ch);
    roi.delete();
    if (dark > LINE_SIDE_DARK) return false;
  }
  return true;
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
