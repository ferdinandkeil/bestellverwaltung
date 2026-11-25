// Testdaten der Dev-Instanz (scripts/dev-seed.mjs): laufen gegen das aktuelle Schema und die echten Routen durch.
// Bricht eine Route oder das Schema die Testdaten, fällt es hier auf und nicht erst beim Start von dev-server.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, resetData, listRecords } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Dev-Testdaten: alle Phasen, alle Exportwege, Favoriten, feste Nutzer', async () => {
  await setup();
  await resetData();
  const out = execFileSync('node', [join(ROOT, 'scripts/dev-seed.mjs')], { env: process.env, encoding: 'utf8' });
  assert.match(out, /Testdaten angelegt/);

  const orders = await listRecords('orders');
  const status = Object.fromEntries(orders.map((o) => [o.supplier, o.status]));
  assert.deepEqual(status, {
    mouser: 'freigabe', wuerth: 'angefragt', printus: 'angefragt', reichelt: 'teilgeliefert',
    tme: 'geliefert', farnell: 'abgeschlossen', other: 'bestellt', voelkner: 'bestellt',
  });
  assert.equal(orders.find((o) => o.supplier === 'voelkner').origin, 'manuell', 'von Hand übernommen');
  const users = (await listRecords('users')).map((u) => u.email);
  assert.ok(users.includes('labor@example.com') && users.includes('kollegin@example.com'));
  const merged = (await listRecords('order_items')).find((i) => i.part_number === '595-SN74HC595N');
  assert.equal(merged.qty_ordered, 8, 'Mouser-Position für zwei Gruppen zusammengeführt');
  const lists = (await listRecords('favorite_lists')).map((l) => `${l.title}|${l.supplier}|${l.is_public}`).sort();
  assert.deepEqual(lists, [
    'Bürobedarf Standard|printus|false', 'Grundausstattung Elektronik-Projekt|reichelt|true',
    'Messtechnik: Strommessung|tme|true', 'Werkstatt Lötplatz|other|false',
  ]);
  assert.equal((await listRecords('favorite_items')).length, 3 + 2 + 2 + 2);
});
