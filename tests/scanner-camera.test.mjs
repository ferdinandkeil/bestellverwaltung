// Automatisches Auslösen im Scanner (reine Logik, ohne Browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoTrigger, preferredCamera } from '../pb_public/modules/delivery-scanner/camera.js';

const W = 960, H = 1280;
/** Blatt als Rechteck (Anteil der Bildgröße), optional verschoben (Pixel). */
const sheet = (share = 0.8, dx = 0) => {
  const w = W * Math.sqrt(share), h = H * Math.sqrt(share), x = (W - w) / 2 + dx, y = (H - h) / 2;
  return { topLeftCorner: { x, y }, topRightCorner: { x: x + w, y }, bottomRightCorner: { x: x + w, y: y + h }, bottomLeftCorner: { x, y: y + h } };
};
/** Bildfolge im Abstand von 120 ms abspielen → Zustände. */
const play = (t, frames, start = 0) => frames.map((c, i) => t.update(c, W, H, start + i * 120).state);

test('Auslösen erst, wenn das Blatt groß genug ist und 0,4 s ruhig liegt', () => {
  const t = new AutoTrigger();
  assert.deepEqual(play(t, [null, sheet(0.4), sheet(0.4)]), ['search', 'closer', 'closer']);
  const s = play(t, [sheet(), sheet(), sheet(), sheet(), sheet()], 1000);
  assert.deepEqual(s, ['hold', 'hold', 'hold', 'hold', 'ready']);
});

test('Bewegung setzt die Ruhezeit zurück, kleine Zitterbewegung nicht', () => {
  const t = new AutoTrigger();
  assert.deepEqual(play(t, [sheet(0.8, 0), sheet(0.8, 5), sheet(0.8, 10), sheet(0.8, 15), sheet(0.8, 20)]).at(-1), 'ready');
  const u = new AutoTrigger();
  assert.deepEqual(play(u, [sheet(0.8, 0), sheet(0.8, 60), sheet(0.8, 120), sheet(0.8, 180), sheet(0.8, 240)]).at(-1), 'hold');
});

test('kurzer Aussetzer der Erkennung unterbricht nicht', () => {
  const t = new AutoTrigger();
  assert.equal(play(t, [sheet(), sheet(), null, sheet(), sheet()]).at(-1), 'ready');
});

test('dieselbe Seite wird nicht zweimal fotografiert; nach dem Seitenwechsel wieder', () => {
  const t = new AutoTrigger();
  assert.equal(play(t, [sheet(), sheet(), sheet(), sheet(), sheet()]).at(-1), 'ready');
  t.shot(480);
  assert.deepEqual(play(t, Array(30).fill(sheet()), 600).filter((s) => s !== 'next'), [], 'Seite bleibt liegen → kein zweites Foto');
  // Blatt kurz weg (Hand nimmt die Seite ab), nächste Seite liegt wieder ruhig
  const s = play(t, [null, null, null, null, sheet(), sheet(), sheet(), sheet(), sheet()], 5000);
  assert.equal(s.at(-1), 'ready');
});

test('Hauptkamera hinten bevorzugt (nicht das Weitwinkel-Objektiv)', () => {
  const cams = ['camera 1, facing front', 'camera 2, facing back', 'camera 0, facing back'].map((label, i) => ({ kind: 'videoinput', label, deviceId: 'd' + i }));
  assert.equal(preferredCamera(cams).label, 'camera 0, facing back');
  assert.equal(preferredCamera([{ kind: 'videoinput', label: 'fake_device_0', deviceId: 'x' }]), null);
});
