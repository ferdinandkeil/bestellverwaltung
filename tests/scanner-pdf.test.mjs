// PDF-Schreiber der Lieferschein-Erfassung (ohne Server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpegInfo, jpegsToPdf } from '../pb_public/modules/delivery-scanner/pdf.js';

// Kleine Test-JPEGs (synthetisch erzeugt): Graustufenverlauf 40×56 und blaue Fläche 30×20
const GRAY = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAA4ACgBAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUI/8QAFhAAAwAAAAAAAAAAAAAAAAAAABRh/9oACAEBAAA/ANPs0M0M0M0M0jM0M0M0M0M0is0M0M0M0M0jM0M0M0M0M0js0M0M0M0M0is0M0M0M0M0jM0M0M0M0M0//9k=', 'base64');
const BLUE = Buffer.from('/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUAB4DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AlwGipgAAAAAB/9k=', 'base64');

function hasQpdf() {
  try { execFileSync('qpdf', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('jpegInfo liest Größe und Farbkomponenten', () => {
  const g = jpegInfo(new Uint8Array(GRAY));
  assert.equal(g.width, 40);
  assert.equal(g.height, 56);
  assert.ok([1, 3].includes(g.components));
  const b = jpegInfo(new Uint8Array(BLUE));
  assert.deepEqual([b.width, b.height, b.components], [30, 20, 3]);
  assert.throws(() => jpegInfo(new Uint8Array([1, 2, 3])), /Kein JPEG/);
});

test('mehrseitiges PDF: Struktur, Querverweise, Seitenzahl', async () => {
  const pdf = await jpegsToPdf([GRAY, new Blob([BLUE]), GRAY.buffer.slice(GRAY.byteOffset, GRAY.byteOffset + GRAY.length)]);
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 3/);

  // Jeder xref-Eintrag zeigt exakt auf den Beginn seines Objekts.
  const xrefStart = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xrefStart, xrefStart + 4), 'xref');
  const entries = [...text.slice(xrefStart).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 11);
  entries.forEach((off, i) => assert.equal(text.slice(off, off + String(i + 1).length + 6), `${i + 1} 0 obj`));

  // Seitenformat: A4-Breite, Höhe nach Seitenverhältnis (40×56 → 595.28 × 833.39)
  assert.match(text, /\/MediaBox \[0 0 595\.28 833\.39\]/);
  assert.match(text, /\/MediaBox \[0 0 595\.28 396\.85\]/);

  if (hasQpdf()) {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-test-'));
    try {
      const file = join(dir, 'test.pdf');
      writeFileSync(file, pdf);
      const out = execFileSync('qpdf', ['--check', file], { encoding: 'utf8' });
      assert.match(out, /No syntax or stream encoding errors found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('leere Seitenliste wird abgelehnt', async () => {
  await assert.rejects(jpegsToPdf([]), /Keine Seiten/);
});
