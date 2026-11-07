// Gruppen sind an Veranstaltung und Semester gebunden.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetData, createUser, createGroup, http, expectHttpError } from './helpers.mjs';

let u;
beforeEach(async () => {
  await setup();
  await resetData();
  u = await createUser();
});

const create = (json) => http('POST', '/api/collections/groups/records', { token: u.token, json });

test('gleicher Name in anderem Semester oder anderer Veranstaltung ist erlaubt', async () => {
  await createGroup('Gruppe A', 'Elektronik-Projekt', 'WS 2026/27');
  await createGroup('Gruppe A', 'Elektronik-Projekt', 'SS 2027');
  await createGroup('Gruppe A', 'Regelungstechnik', 'WS 2026/27');
});

test('gleicher Name in derselben Veranstaltung und demselben Semester ist verboten (Groß-/Kleinschreibung egal)', async () => {
  await createGroup('Gruppe A', 'Elektronik-Projekt', 'WS 2026/27');
  const err = await expectHttpError(create({ name: 'gruppe a', course: 'elektronik-projekt', semester: 'WS 2026/27' }), 400);
  assert.ok(Object.values(err.body.data).some((e) => e.code === 'validation_not_unique'));
});

test('Veranstaltung und Semester sind Pflicht, Semester im Format WS JJJJ/JJ oder SS JJJJ', async () => {
  await expectHttpError(create({ name: 'X', semester: 'WS 2026/27' }), 400);
  await expectHttpError(create({ name: 'X', course: 'Kurs' }), 400);
  for (const bad of ['WS 26/27', 'Winter 2026', 'SS 27', 'WS 2026/2027']) {
    await expectHttpError(create({ name: 'X', course: 'Kurs', semester: bad }), 400);
  }
  await create({ name: 'X', course: 'Kurs', semester: 'SS 2027' });
});
