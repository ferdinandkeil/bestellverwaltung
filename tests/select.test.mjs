// Testauswahl nach Änderungen (tests/select.mjs) – ohne Server, ohne Browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, ALL_E2E } from './select.mjs';

test('Ansicht wählt nur die Browser-Tests, die durch sie hindurchführen', () => {
  const r = select(['pb_public/views/dashboard-view.js']);
  assert.deepEqual(r.unit, []);
  assert.deepEqual(r.e2e, ['e2e', 'e2e-scanner', 'e2e-camera']);
});

test('Modul: eigene Unit- und Browser-Tests', () => {
  const r = select(['pb_public/modules/shop-export/formats.js']);
  assert.deepEqual(r.unit, ['shop-export.test.mjs']);
  assert.deepEqual(r.e2e, ['e2e-shop-export']);
});

test('Server-Logik: alle Unit-Tests, keine Browser-Tests', () => {
  const r = select(['pb_hooks/lib/cart.js']);
  assert.ok(r.unit.includes('cart.test.mjs') && r.unit.includes('rules.test.mjs'));
  assert.deepEqual(r.e2e, []);
});

test('Gemeinsames und Unbekanntes: alles (lieber zu viel als zu wenig)', () => {
  for (const file of ['pb_public/core/api.js', 'pb_schema.json', 'tests/helpers.mjs', 'irgendwas/neu.txt']) {
    const r = select([file]);
    assert.deepEqual(r.e2e, ALL_E2E, file);
    assert.ok(r.unit.includes('cart.test.mjs'), file);
    assert.match(r.reasons[0], /alles/, file);
  }
});

test('Doku: keine Tests; mehrere Dateien: Vereinigung in fester Reihenfolge', () => {
  assert.deepEqual(select(['docs/DEPLOYMENT.md', 'ARCHITECTURE.md']), {
    unit: [], e2e: [], reasons: ['docs/DEPLOYMENT.md: ohne Tests', 'ARCHITECTURE.md: ohne Tests'],
  });
  const r = select(['pb_public/views/favorites-view.js', 'pb_public/views/groups-view.js']);
  assert.deepEqual(r.e2e, ['e2e', 'e2e-favorites']);
});
