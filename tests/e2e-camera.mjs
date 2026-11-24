// Browser-Durchlauf der Kamera im Scanner: Chrome mit simulierter Kamera, die ein Standbild eines
// Lieferscheins auf dunklem Tisch zeigt (Y4M-Datei) → automatisches Auslösen, keine Doppelaufnahme,
// Auslösen von Hand, Schalter „Automatisch auslösen“ (gemerkt), „Fertig“ schließt die Kamera.
// Start über:  tests/run.sh --e2e
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PB_URL, setup, resetData, createUser } from './helpers.mjs';
import { launchBrowser, loginViaUi, sleep } from './browser.mjs';

const W = 1536;
const H = 2048; // Hochformat wie ein Handy; groß genug, dass die entzerrte Seite nicht hochgerechnet wird

/** Standbild (Blatt mit Text und Tabelle, leicht gedreht auf dunklem Tisch) als Y4M-Datei (ein Bild, 4:2:0). */
async function makeFakeVideo(b, path) {
  const base64 = await b.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = ${W}; c.height = ${H};
    const x = c.getContext('2d');
    x.fillStyle = '#3b2f25'; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(-0.03);
    const pw = 1300, ph = 1838;
    x.fillStyle = '#f8f8f4'; x.fillRect(-pw / 2, -ph / 2, pw, ph);
    x.fillStyle = '#111'; x.font = 'bold 56px sans-serif'; x.fillText('Lieferschein', -pw / 2 + 90, -ph / 2 + 150);
    x.font = '30px sans-serif';
    for (let i = 0; i < 14; i++) {
      const y = -ph / 2 + 320 + i * 90;
      x.fillText('Pos. ' + (i + 1) + '   ' + (3 + i) + ' Stk   ART-' + (1000 + 37 * i) + '-X   Beschreibung', -pw / 2 + 90, y);
      x.fillRect(-pw / 2 + 80, y + 25, pw - 160, 3);
    }
    const img = x.getImageData(0, 0, c.width, c.height).data;
    // RGB → YUV (BT.601, volle Wertebereiche wie JPEG), Farbe 2×2 gemittelt
    const w = c.width, h = c.height, Y = new Uint8Array(w * h), U = new Uint8Array(w * h / 4), V = new Uint8Array(w * h / 4);
    for (let i = 0; i < w * h; i++) {
      const r = img[i * 4], g = img[i * 4 + 1], bl = img[i * 4 + 2];
      Y[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * bl);
    }
    for (let yy = 0; yy < h / 2; yy++) for (let xx = 0; xx < w / 2; xx++) {
      let r = 0, g = 0, bl = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((yy * 2 + dy) * w + xx * 2 + dx) * 4; r += img[i]; g += img[i + 1]; bl += img[i + 2];
      }
      r /= 4; g /= 4; bl /= 4;
      U[yy * w / 2 + xx] = Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * bl);
      V[yy * w / 2 + xx] = Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * bl);
    }
    const head = new TextEncoder().encode('YUV4MPEG2 W' + w + ' H' + h + ' F30:1 Ip A1:1 C420jpeg\\nFRAME\\n');
    const all = new Uint8Array(head.length + Y.length + U.length + V.length);
    all.set(head); all.set(Y, head.length); all.set(U, head.length + Y.length); all.set(V, head.length + Y.length + U.length);
    let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  writeFileSync(path, Buffer.from(base64, 'base64'));
}

const ok = (msg) => console.log('✔', msg);
await setup();
await resetData();
const login = await createUser('Kamera-Tester');
const work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-camera-'));
const video = join(work, 'lieferschein.y4m');
const scanner = `Alpine.$data(document.querySelector('[x-data=deliveryScanner]'))`;
let b = await launchBrowser(join(work, 'profile-0'));
let failed = false;

try {
  await makeFakeVideo(b, video);
  await b.close();
  b = await launchBrowser(join(work, 'profile'), [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`,
  ]);
  await loginViaUi(b, PB_URL, login.email);
  await b.waitFor(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]')?.getClientRects().length`, 'Scanner-Knopf in der Leiste unten');
  await b.evaluate(`document.querySelector('[data-bottom-action=delivery-scanner-mobile]').click()`);
  await b.waitFor(`${scanner}.isOpen && ${scanner}.libState === 'ready'`, 'Bildverarbeitung geladen', 60000);

  // Kamera im Scanner statt System-Kamera; Automatik ist voreingestellt
  await b.waitFor(`document.querySelector('[data-start-camera]')?.offsetParent`, 'Knopf „Foto aufnehmen“ (Kamera im Scanner)');
  if (!(await b.evaluate(`document.querySelector('[data-auto-capture]').checked`))) throw new Error('Automatik nicht voreingestellt');
  await b.evaluate(`document.querySelector('[data-start-camera]').click()`);
  await b.waitFor(`${scanner}.step === 'camera' && ${scanner}.camera.ready`, 'Kamera bereit', 20000);
  ok('Kamera im Scanner geöffnet, „Automatisch auslösen“ voreingestellt');

  await b.waitFor(`${scanner}.pages.length === 1`, 'automatisch ausgelöst', 30000);
  await b.screenshot('kamera-01-automatisch');
  const page = await b.evaluate(`({ blurry: ${scanner}.pages[0].blurry, msg: document.querySelector('[data-camera-message]').innerText })`);
  if (page.blurry) throw new Error('Seite fälschlich als unscharf markiert');
  ok(`automatisch ausgelöst, Seite übernommen (${page.msg})`);

  // dieselbe Seite bleibt liegen → kein zweites automatisches Foto
  await sleep(3000);
  const after = await b.evaluate(`({ n: ${scanner}.pages.length, msg: document.querySelector('[data-camera-message]').innerText })`);
  if (after.n !== 1) throw new Error('Dieselbe Seite wurde mehrfach aufgenommen: ' + after.n);
  if (!after.msg.includes('Nächste Seite')) throw new Error('Hinweis auf die nächste Seite fehlt: ' + after.msg);
  ok('keine Doppelaufnahme derselben Seite, Hinweis „Nächste Seite hinlegen“');

  // Automatik aus (gemerkt), Auslösen von Hand
  await b.evaluate(`document.querySelector('[data-auto-capture]').click()`);
  if ((await b.evaluate(`localStorage.getItem('deliveryScanner.autoCapture')`)) !== '0') throw new Error('Schalter nicht gespeichert');
  await b.evaluate(`document.querySelector('[data-shutter]').click()`);
  await b.waitFor(`${scanner}.pages.length === 2 && !${scanner}.camera.busy`, 'von Hand ausgelöst', 30000);
  await sleep(1500);
  if ((await b.evaluate(`${scanner}.pages.length`)) !== 2) throw new Error('Automatik löst trotz Schalter aus');
  ok('Automatik abschaltbar (pro Gerät gemerkt), Auslösen von Hand');

  await b.clickText('[data-camera] button', 'Fertig');
  await b.waitFor(`${scanner}.step === 'pages' && !document.querySelector('[x-ref=cameraVideo]').srcObject`, 'Kamera geschlossen');
  await b.screenshot('kamera-02-seiten');
  ok('„Fertig“ schließt die Kamera, 2 Seiten in der Übersicht');

  const unexpected = b.problems.filter((p) => !/status of 4\d\d.*(auth-with-otp)/.test(p));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('kamera-fehler').catch(() => {});
} finally {
  await b.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
