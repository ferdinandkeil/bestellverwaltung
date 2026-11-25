// Kamera im Scanner: Wahl der Kamera (reine Logik, ohne Browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferredCamera } from '../pb_public/modules/delivery-scanner/camera.js';

test('Hauptkamera hinten bevorzugt (nicht das Weitwinkel-Objektiv)', () => {
  const cams = ['camera 1, facing front', 'camera 2, facing back', 'camera 0, facing back'].map((label, i) => ({ kind: 'videoinput', label, deviceId: 'd' + i }));
  assert.equal(preferredCamera(cams).label, 'camera 0, facing back');
  assert.equal(preferredCamera([{ kind: 'videoinput', label: 'fake_device_0', deviceId: 'x' }]), null);
});
