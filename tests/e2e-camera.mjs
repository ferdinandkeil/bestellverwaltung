// Browser-Durchlauf der Kamera im Scanner: Chrome mit simulierter Kamera, die ein Standbild eines
// Lieferscheins auf dunklem Tisch zeigt (Y4M-Datei) → kein automatisches Auslösen, zwei Fotos von Hand,
// „Fertig“ schließt die Kamera, danach je Foto die Eckenprüfung mit vorgeschlagenen Ecken.
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

  // Kamera im Scanner statt System-Kamera; ohne Schalter für automatisches Auslösen
  await b.waitFor(`document.querySelector('[data-start-camera]')?.offsetParent`, 'Knopf „Foto aufnehmen“ (Kamera im Scanner)');
  await b.evaluate(`document.querySelector('[data-start-camera]').click()`);
  await b.waitFor(`${scanner}.step === 'camera' && ${scanner}.camera.ready`, 'Kamera bereit', 20000);
  if (await b.evaluate(`!!document.querySelector('[data-auto-capture]')`)) throw new Error('Schalter „Automatisch auslösen“ noch vorhanden');
  ok('Kamera im Scanner geöffnet, kein automatisches Auslösen');

  // Blatt liegt im Bild → es wird trotzdem nicht ausgelöst
  await sleep(2500);
  if ((await b.evaluate(`${scanner}.queued + ${scanner}.pages.length`)) !== 0) throw new Error('Foto ohne Auslösen aufgenommen');
  ok('ohne Auslöser kein Foto');

  // zwei Fotos von Hand; ausgewertet wird erst nach „Fertig“
  for (const n of [1, 2]) {
    await b.evaluate(`document.querySelector('[data-shutter]').click()`);
    await b.waitFor(`${scanner}.queued === ${n} && !${scanner}.camera.busy`, `Foto ${n} aufgenommen`, 30000);
  }
  const count = await b.evaluate(`document.querySelector('[data-camera-count]').innerText`);
  if (count !== '2 Fotos') throw new Error('Zähler in der Kamera: ' + count);
  await b.screenshot('kamera-01-zwei-fotos');
  ok('zwei Fotos von Hand ausgelöst, Zähler „2 Fotos“');

  await b.clickText('[data-camera] button', 'Fertig');
  await b.waitFor(`${scanner}.step === 'corners' && !document.querySelector('[x-ref=cameraVideo]').srcObject`, 'Eckenprüfung nach „Fertig“', 30000);
  if (!(await b.evaluate(`${scanner}.cornersDetected`))) throw new Error('Blattkanten im Foto nicht vorgeschlagen');
  if (!(await b.evaluate(`document.querySelector('[data-queued]').innerText.includes('1 Foto')`))) throw new Error('Hinweis auf das weitere Foto fehlt');
  await b.screenshot('kamera-02-ecken');
  await b.clickText('[x-data=deliveryScanner] button', 'Übernehmen');
  await b.waitFor(`${scanner}.step === 'corners' && ${scanner}.pages.length === 1 && !${scanner}.busyText`, 'Eckenprüfung Foto 2', 30000);
  await b.clickText('[x-data=deliveryScanner] button', 'Übernehmen');
  await b.waitFor(`${scanner}.step === 'pages' && ${scanner}.pages.length === 2`, 'zwei Seiten übernommen', 30000);
  if (await b.evaluate(`${scanner}.pages.some((p) => p.blurry)`)) throw new Error('Seite fälschlich als unscharf markiert');
  await b.screenshot('kamera-03-seiten');
  ok('„Fertig“ schließt die Kamera, beide Fotos durch die Eckenprüfung (Ecken vorgeschlagen), 2 scharfe Seiten');

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
