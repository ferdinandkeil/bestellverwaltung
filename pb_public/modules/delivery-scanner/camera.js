// Kamera im Scanner: Kamerabild (getUserMedia), Foto in voller Auflösung (ImageCapture.takePhoto) und
// Taschenlampe. Ausgelöst wird nur von Hand; das automatische Auslösen mit Live-Eckenerkennung wurde 11/2026
// entfernt, weil es ältere Handys überlastete. Erprobt 11/2026 mit der Test-Seite kamera-test.html (inzwischen entfernt).

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
