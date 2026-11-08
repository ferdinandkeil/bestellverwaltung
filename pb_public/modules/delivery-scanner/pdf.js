// Minimaler PDF-Schreiber: bettet JPEG-Seiten unverändert ein (DCTDecode), eine Seite pro Bild.
// Seitenbreite A4 (595,28 pt), Höhe nach Seitenverhältnis des Bildes. Keine Abhängigkeiten.
// Getestet in tests/scanner-pdf.test.mjs.

const PAGE_WIDTH_PT = 595.28;
const COLOR_SPACES = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' };

/** Breite, Höhe und Farbkomponenten aus dem SOF-Marker eines JPEG lesen. */
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Kein JPEG.');
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15 außer DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    i += 2 + len;
  }
  throw new Error('JPEG ohne Bildgröße (SOF fehlt).');
}

const num = (n) => (Math.round(n * 100) / 100).toString();

/**
 * JPEG-Seiten → PDF.
 * jpegs: Array aus Uint8Array | ArrayBuffer | Blob
 * → Uint8Array (PDF-Datei)
 */
export async function jpegsToPdf(jpegs) {
  if (!jpegs.length) throw new Error('Keine Seiten.');
  const images = await Promise.all(jpegs.map(async (j) => {
    const bytes = j instanceof Uint8Array ? j : new Uint8Array(j instanceof Blob ? await j.arrayBuffer() : j);
    const info = jpegInfo(bytes);
    const colorSpace = COLOR_SPACES[info.components];
    if (!colorSpace) throw new Error(`Nicht unterstützte JPEG-Farbkomponenten: ${info.components}`);
    return { bytes, ...info, colorSpace };
  }));

  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (part) => {
    const b = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(b);
    length += b.length;
  };
  const object = (id, ...parts) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };

  // Header mit Binär-Kommentar, damit Programme die Datei als binär erkennen.
  push(new Uint8Array([...enc.encode('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageIds = images.map((_, i) => 3 + i * 3);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`);

  images.forEach((img, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const w = PAGE_WIDTH_PT;
    const h = PAGE_WIDTH_PT * (img.height / img.width);
    const content = `q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q`;
    object(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    object(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(imageId,
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace ${img.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      img.bytes,
      '\nendstream');
  });

  const size = 3 + images.length * 3;
  const xrefOffset = length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}
