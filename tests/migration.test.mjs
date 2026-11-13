// Datenmigrationen (pb_migrations/) gegen eine eigene, frische PocketBase-Instanz:
// Daten im alten Zustand anlegen (ohne Migrationen gestartet), dann `pocketbase migrate up` und prüfen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PB_MIGRATION_TEST_PORT || 8097);
const URL = `http://127.0.0.1:${PORT}`;
const ADMIN = { identity: 'migration-admin@example.com', password: 'migration-admin-password' };

let work;
let server;
let token;

async function api(method, path, json) {
  const res = await fetch(URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** PocketBase starten; ohne `migrations` mit leerem Migrationsordner (= Stand vor dem Deploy). */
async function start(migrationsDir) {
  server = spawn('pocketbase', ['serve', '--dir', join(work, 'pb_data'), '--hooksDir', join(ROOT, 'pb_hooks'),
    '--migrationsDir', migrationsDir, '--automigrate=false', '--http', `127.0.0.1:${PORT}`], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL + '/api/health')).ok) break;
    } catch (_) { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  token = (await api('POST', '/api/collections/_superusers/auth-with-password', ADMIN)).token;
}

async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = null;
}

const order = (data) => api('POST', '/api/collections/orders/records', { custom_fields: {}, ...data });
const get = (id) => api('GET', `/api/collections/orders/records/${id}`);

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'bestellverwaltung-migration.'));
  const empty = join(work, 'keine-migrationen');
  mkdirSync(empty);
  execFileSync('pocketbase', ['superuser', 'upsert', ADMIN.identity, ADMIN.password, '--dir', join(work, 'pb_data')]);
  await start(empty);
  const collections = JSON.parse(readFileSync(join(ROOT, 'pb_schema.json'), 'utf8'));
  await api('PUT', '/api/collections/import', { collections, deleteMissing: false });
});

after(async () => {
  await stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

test('Migration TME/Würth: Shop-Namen → feste Lieferanten, Konflikt offener Körbe, ohne interne Nummer', async () => {
  const o = {
    tmeOpen: await order({ supplier: 'other', supplier_custom_name: 'TME', status: 'angefragt' }),
    tmeOpen2: await order({ supplier: 'other', supplier_custom_name: 'tme.eu', status: 'angefragt' }),
    tmeOld: await order({ supplier: 'other', supplier_custom_name: 'TME Germany', status: 'bestellt', internal_order_no: '2026IW00001' }),
    wuerth: await order({ supplier: 'other', supplier_custom_name: 'Würth Elektronik', status: 'angefragt' }),
    wuerth2: await order({ supplier: 'other', supplier_custom_name: 'Wuerth', status: 'geliefert', internal_order_no: '2026IW00002' }),
    we: await order({ supplier: 'other', supplier_custom_name: 'WE eiSos', status: 'abgerechnet', internal_order_no: '2026IW00003' }),
    conrad: await order({ supplier: 'other', supplier_custom_name: 'Conrad', status: 'angefragt' }),
    westfalia: await order({ supplier: 'other', supplier_custom_name: 'Westfalia', status: 'angefragt' }),
    reichelt: await order({ supplier: 'reichelt', status: 'angefragt' }),
    noteWithout: await order({ supplier: 'reichelt', status: 'geliefert', origin: 'lieferschein' }),
    noteWith: await order({ supplier: 'reichelt', status: 'geliefert', origin: 'lieferschein', internal_order_no: '2026IW00004' }),
    oldWithout: await order({ supplier: 'mouser', status: 'bestellt' }),
  };

  await stop();
  execFileSync('pocketbase', ['migrate', 'up', '--dir', join(work, 'pb_data'), '--hooksDir', join(ROOT, 'pb_hooks'),
    '--migrationsDir', join(ROOT, 'pb_migrations')], { stdio: 'ignore' });
  await start(join(ROOT, 'pb_migrations'));

  const now = {};
  for (const [k, v] of Object.entries(o)) now[k] = await get(v.id);
  const sup = (k) => [now[k].supplier, now[k].supplier_custom_name];

  assert.deepEqual(sup('tmeOpen'), ['tme', '']);
  assert.deepEqual(sup('tmeOpen2'), ['other', 'tme.eu'], 'zweiter offener TME-Korb bleibt (Unique-Index)');
  assert.deepEqual(sup('tmeOld'), ['tme', '']);
  assert.deepEqual(sup('wuerth'), ['wuerth', '']);
  assert.deepEqual(sup('wuerth2'), ['wuerth', '']);
  assert.deepEqual(sup('we'), ['wuerth', '']);
  assert.deepEqual(sup('conrad'), ['other', 'Conrad']);
  assert.deepEqual(sup('westfalia'), ['other', 'Westfalia']);
  assert.deepEqual(sup('reichelt'), ['reichelt', '']);
  assert.equal(now.tmeOld.internal_order_no, '2026IW00001');

  assert.equal(now.noteWithout.without_internal_order_no, true, 'aus Lieferschein ohne Nummer → gekennzeichnet');
  assert.equal(now.noteWith.without_internal_order_no, false);
  assert.equal(now.oldWithout.without_internal_order_no, false, 'alte Bestellung ohne Nummer bleibt unverändert');

  const logs = await api('GET', `/api/logs?perPage=50&filter=${encodeURIComponent("message ~ 'Migration Lieferanten'")}`);
  assert.ok(logs.items.some((l) => l.level === 4 && l.data.order === o.tmeOpen2.id), 'Konflikt im Log gemeldet');
  assert.ok(logs.items.some((l) => l.message === 'Migration Lieferanten abgeschlossen' && l.data.umgestellt === 5));
});
