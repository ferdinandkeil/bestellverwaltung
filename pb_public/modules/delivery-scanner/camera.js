// Kamera im Scanner: Kamerabild (getUserMedia), Foto in voller Auflösung (ImageCapture.takePhoto),
// Taschenlampe und die Logik für das automatische Auslösen (AutoTrigger, ohne DOM – getestet in
// tests/scanner-camera.test.mjs). Erprobt 11/2026 mit der Test-Seite kamera-test.html (inzwischen entfernt).

/**
 * Kamera im Browser nutzbar? takePhoto() ist nötig, weil nur es die volle Sensorauflösung liefert
 * (ein Bild aus dem Videostrom wäre für kleine Schrift zu grob). Fehlt es (z. B. Safari auf dem iPhone),
 * nimmt der Scanner die System-Kamera.
 */
export function cameraSupported() {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && 'ImageCapture' in window;
}

/**
 * Hauptkamera hinten: bei Android „camera 0, facing back“ bzw. „camera2 0, facing back“ (je nach
 * Chrome-Version), sonst die Rückkamera mit der kleinsten Nummer. Android-Chrome wählt für
 * facingMode „environment“ teils das Weitwinkel-Objektiv (0,5×), takePhoto() nutzt aber die Hauptkamera –
 * dann passen Vorschau und Foto nicht zusammen.
 */
export function preferredCamera(devices) {
  const back = devices.filter((d) => d.kind === 'videoinput' && /back|rück|environment/i.test(d.label));
  const no = (d) => Number(d.label.match(/camera2? (\d+)/)?.[1] ?? Infinity);
  return [...back].sort((x, y) => no(x) - no(y))[0] ?? null;
}

async function startStream(video, deviceId) {
  // 4:3 wie das Foto von takePhoto(): bei 16:9 schneidet die Vorschau den Sensor an der kurzen Seite ab,
  // das Blatt wirkt dort größer als im Foto. Angaben in Sensor-Ausrichtung (quer).
  const size = { aspectRatio: { ideal: 4 / 3 }, width: { ideal: 4080 }, height: { ideal: 3060 } };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size },
  });
  video.srcObject = stream;
  await video.play();
  return stream.getVideoTracks()[0];
}

/**
 * Kamera öffnen und im <video> anzeigen. → { track, imageCapture, photoSize, torch, exposure }
 * Wirft bei verweigertem Zugriff o. Ä. (Aufrufer weicht dann auf die System-Kamera aus).
 */
export async function openCamera(video) {
  let track = await startStream(video, null);
  // Erst nach der Freigabe liefert enumerateDevices() Namen – dann ggf. auf die Hauptkamera wechseln.
  const preferred = preferredCamera(await navigator.mediaDevices.enumerateDevices());
  if (preferred && preferred.deviceId !== track.getSettings().deviceId) {
    track.stop();
    track = await startStream(video, preferred.deviceId);
  }
  const caps = track.getCapabilities?.() ?? {};
  if (caps.focusMode?.includes('continuous')) {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  const imageCapture = new ImageCapture(track);
  const pc = await imageCapture.getPhotoCapabilities().catch(() => ({}));
  const photoSize = {};
  if (pc.imageWidth?.max) photoSize.imageWidth = pc.imageWidth.max;
  if (pc.imageHeight?.max) photoSize.imageHeight = pc.imageHeight.max;
  return { track, imageCapture, photoSize, torch: !!caps.torch, exposure: caps.exposureCompensation ?? null };
}

/** Foto in voller Auflösung (Blob, meist JPEG). */
export function takePhoto(cam) {
  return cam.imageCapture.takePhoto(cam.photoSize);
}

/**
 * Taschenlampe ein/aus. Mit Licht brennt das weiße Papier leicht aus; deshalb wird die Belichtung dabei
 * um 1 Stufe verringert (soweit die Kamera das kann) und beim Ausschalten zurückgesetzt.
 */
export async function setTorch(cam, on) {
  await cam.track.applyConstraints({ advanced: [{ torch: on }] });
  const r = cam.exposure;
  if (r) {
    const value = Math.min(r.max, Math.max(r.min, on ? -1 : 0));
    await cam.track.applyConstraints({ advanced: [{ exposureCompensation: value }] }).catch(() => {});
  }
}

export function closeCamera(cam, video) {
  cam?.track?.stop();
  if (video) video.srcObject = null;
}

// ---------------------------------------------------------------------------
// Automatisches Auslösen
// ---------------------------------------------------------------------------
const KEYS = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];

function quadArea(c) {
  const p = KEYS.map((k) => c[k]);
  let s = 0;
  for (let i = 0; i < 4; i++) s += p[i].x * p[(i + 1) % 4].y - p[(i + 1) % 4].x * p[i].y;
  return Math.abs(s) / 2;
}

function maxMove(a, b) {
  return Math.max(...KEYS.map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y)));
}

/**
 * Werte aus dem Kamera-Test (11/2026, Android, Hauptkamera): Auslösen nach 0,4 s Ruhe funktioniert aus
 * freier Hand; das Blatt sollte mindestens 60 % des Bildes füllen, sonst wird es für 6,5-pt-Ziffern zu klein.
 */
export const AUTO_DEFAULTS = {
  stableMs: 400, // so lange muss das Blatt ruhig im Bild liegen
  tolerance: 0.03, // erlaubte Bewegung der Ecken zwischen zwei Bildern (Anteil der Bildbreite)
  minArea: 0.6, // Mindestanteil des Blatts an der Bildfläche
  graceMs: 400, // einzelne Aussetzer der Erkennung setzen die Ruhezeit nicht zurück
  cooldownMs: 1500, // Mindestabstand zwischen zwei automatischen Fotos
  rearmMove: 0.1, // nach einem Foto erst wieder auslösen, wenn das Blatt weg war oder sich so weit bewegt hat
};

/**
 * Entscheidet anhand der Live-Eckenerkennung, wann ausgelöst wird.
 * update(corners | null, width, height, now) → { corners, area, hold (0..1), state }
 *   state: 'search' (kein Blatt), 'closer' (Blatt zu klein), 'hold' (ruhig halten), 'ready' (jetzt auslösen),
 *          'next' (Seite schon fotografiert – nächste Seite hinlegen)
 * Nach dem Auslösen shot(now) aufrufen: Abklingzeit; dieselbe Seite wird nicht noch einmal fotografiert –
 * erst wenn das Blatt aus dem Bild war oder deutlich verschoben wurde (Seitenwechsel), löst es wieder aus.
 */
export class AutoTrigger {
  constructor(options = {}) {
    this.o = { ...AUTO_DEFAULTS, ...options };
    this.reset(-Infinity);
  }

  reset(now) {
    this.corners = null;
    this.lastSeen = -Infinity;
    this.stableSince = now;
    this.lastShot = -Infinity;
    this.shotCorners = null; // Ecken beim letzten Foto, solange dieselbe Seite noch im Bild liegt
  }

  shot(now) {
    this.lastShot = now;
    this.stableSince = now;
    this.shotCorners = this.corners;
  }

  update(detected, width, height, now) {
    const o = this.o;
    let corners = null;
    if (detected) {
      const moved = this.corners ? maxMove(detected, this.corners) / width : Infinity;
      if (moved > o.tolerance) this.stableSince = now;
      corners = detected;
      this.lastSeen = now;
    } else if (this.corners && now - this.lastSeen < o.graceMs) {
      corners = this.corners; // kurzer Aussetzer: letzten Rahmen weiterverwenden
    } else {
      this.stableSince = now;
    }
    this.corners = corners;
    if (this.shotCorners && (!corners || maxMove(corners, this.shotCorners) / width > o.rearmMove)) this.shotCorners = null;
    const area = corners ? quadArea(corners) / (width * height) : 0;
    if (!corners) return { corners, area, hold: 0, state: 'search' };
    if (area < o.minArea) {
      this.stableSince = now;
      return { corners, area, hold: 0, state: 'closer' };
    }
    if (this.shotCorners) return { corners, area, hold: 0, state: 'next' };
    const hold = o.stableMs ? Math.min(1, (now - this.stableSince) / o.stableMs) : 1;
    const ready = hold >= 1 && now - this.lastShot >= o.cooldownMs;
    return { corners, area, hold, state: ready ? 'ready' : 'hold' };
  }
}
