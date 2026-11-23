// Oberfläche ohne ungefragtes Caching (pb_hooks/cache.pb.js, ARCHITECTURE.md Kap. 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PB_URL } from './helpers.mjs';

// HEAD: ohne Antwortkörper bleiben keine Verbindungen offen (sonst wartet der Testlauf auf deren Timeout).
const head = (path, headers = {}) => fetch(PB_URL + path, { method: 'HEAD', headers, redirect: 'manual' });

test('Dateien der Oberfläche: Cache-Control no-cache, unverändert nur 304', async () => {
  for (const path of ['/', '/core/config.js', '/modules/delivery-scanner/scanner-modal.js', '/assets/app.css']) {
    const res = await head(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
    const lastModified = res.headers.get('last-modified');
    assert.ok(lastModified, `${path}: Last-Modified fehlt`);
    const again = await head(path, { 'If-Modified-Since': lastModified });
    assert.equal(again.status, 304, `${path}: Nachfrage ohne Änderung`);
  }
});

test('API und Admin-Oberfläche bleiben unberührt', async () => {
  for (const path of ['/api/health', '/_/']) {
    const res = await head(path);
    assert.notEqual(res.headers.get('cache-control'), 'no-cache', path);
  }
});
