// Test-Hilfsfunktionen: nur eingebaute Node-Module (fetch, fs), kein npm.
import { readFileSync } from 'node:fs';

export const PB_URL = process.env.PB_URL;
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
export const MAILPIT_URL = process.env.MAILPIT_URL;

if (!PB_URL) throw new Error('PB_URL fehlt – Tests bitte über tests/run.sh starten.');

/** Fehler mit HTTP-Status und Antwortkörper. */
export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export async function http(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(PB_URL + path, { method, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

let adminToken;
export async function admin() {
  if (!adminToken) {
    const r = await http('POST', '/api/collections/_superusers/auth-with-password', {
      json: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    adminToken = r.token;
  }
  return adminToken;
}

let setupDone = false;
/** Schema importieren und SMTP auf Mailpit stellen (einmal pro Testlauf-Prozess). */
export async function setup() {
  if (setupDone) return;
  const token = await admin();
  const collections = JSON.parse(readFileSync(process.env.PB_SCHEMA, 'utf8'));
  await http('PUT', '/api/collections/import', { token, json: { collections, deleteMissing: false } });
  await http('PATCH', '/api/settings', {
    token,
    json: {
      meta: { appName: 'Labor-Bestellsystem (Test)', appURL: PB_URL, senderName: 'Labor', senderAddress: 'labor@example.com' },
      smtp: { enabled: true, host: '127.0.0.1', port: Number(process.env.MAILPIT_SMTP_PORT), tls: false },
    },
  });
  setupDone = true;
}

/** Alle Fachdaten löschen (Bestellungen kaskadieren auf Positionen & Lieferungen). */
export async function resetData() {
  const token = await admin();
  for (const col of ['orders', 'groups']) {
    const list = await http('GET', `/api/collections/${col}/records?perPage=500&fields=id`, { token });
    for (const r of list.items) await http('DELETE', `/api/collections/${col}/records/${r.id}`, { token });
  }
}

let userCounter = 0;
/** Labor-Nutzer anlegen und per Impersonate ein Token holen (Passwort-Login ist deaktiviert). */
export async function createUser(name = 'Tester') {
  const token = await admin();
  const email = `user${Date.now()}${++userCounter}@example.com`;
  const pw = 'irrelevant-password-123';
  const user = await http('POST', '/api/collections/users/records', {
    token, json: { email, name, password: pw, passwordConfirm: pw, verified: true },
  });
  const auth = await http('POST', `/api/collections/users/impersonate/${user.id}`, {
    token, json: { duration: 3600 },
  });
  return { user, email, token: auth.token };
}

export async function createGroup(name, course = 'Elektronik-Projekt', semester = 'WS 2026/27') {
  return http('POST', '/api/collections/groups/records', {
    token: await admin(), json: { name, course, semester, is_active: true },
  });
}

export function addItem(token, data) {
  return http('POST', '/api/lab/cart-items', { token, json: data });
}

export function changeStatus(token, orderId, action, extra = {}) {
  return http('POST', `/api/lab/orders/${orderId}/status`, { token, json: { action, ...extra } });
}

export function bookDelivery(token, orderId, lines, note = '') {
  return http('POST', `/api/lab/orders/${orderId}/deliveries`, { token, json: { lines, note } });
}

export async function getRecord(col, id) {
  return http('GET', `/api/collections/${col}/records/${id}`, { token: await admin() });
}

export async function listRecords(col, filter = '') {
  const q = filter ? `&filter=${encodeURIComponent(filter)}` : '';
  const r = await http('GET', `/api/collections/${col}/records?perPage=500${q}`, { token: await admin() });
  return r.items;
}

/** Erwartet, dass ein Promise mit HttpError(status) fehlschlägt. */
export async function expectHttpError(promise, status) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpError && err.status === status) return err;
    throw err;
  }
  throw new Error(`Erwartet: HTTP ${status}, aber Anfrage war erfolgreich.`);
}

/** Rate-Limiting mit den PocketBase-Standardregeln einschalten (wie im Produktivbetrieb). */
export async function enableRateLimits() {
  const token = await admin();
  const settings = await http('GET', '/api/settings', { token });
  await http('PATCH', '/api/settings', { token, json: { rateLimits: { ...settings.rateLimits, enabled: true } } });
}

export async function disableRateLimits() {
  const token = await admin();
  const settings = await http('GET', '/api/settings', { token });
  await http('PATCH', '/api/settings', { token, json: { rateLimits: { ...settings.rateLimits, enabled: false } } });
}
