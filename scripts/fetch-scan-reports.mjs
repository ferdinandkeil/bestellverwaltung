#!/usr/bin/env node
// Holt Problem-Meldungen der Lieferschein-Erfassung (Collection scan_reports) vom Server
// nach samples/scan-reports/ (in .gitignore – enthält echte Belege) und löscht sie danach dort.
//
//   node scripts/fetch-scan-reports.mjs https://labor.example.uber.space
//   node scripts/fetch-scan-reports.mjs http://127.0.0.1:8090 --keep     # lokal, nicht löschen
//
// Anmeldung als Superuser: E-Mail und Passwort (oder PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD),
// bei aktivierter MFA zusätzlich der Code aus der Mail. Nur Node-Bordmittel, kein npm.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'scan-reports');
const urlArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!urlArg || !/^https?:\/\//.test(urlArg)) {
  console.error('Aufruf: node scripts/fetch-scan-reports.mjs <URL der App, z. B. https://labor.example.uber.space> [--keep]');
  process.exit(2);
}
const baseUrl = new URL(urlArg).origin;

// ---- Eingabe -------------------------------------------------------------------
let rl = null;
const lines = [];
let waiting = null;
function input() {
  if (!rl) {
    // Mit Terminal braucht readline den Ausgabekanal, sonst wird die Eingabe nicht angezeigt.
    rl = process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      : createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
  }
  return rl;
}
function ask(question, { hidden = false } = {}) {
  const r = input();
  process.stdout.write(question);
  const tty = process.stdin.isTTY;
  if (hidden && tty) r._writeToOutput = () => {};
  return new Promise((resolve) => {
    const done = (l) => {
      if (hidden && tty) { delete r._writeToOutput; process.stdout.write('\n'); }
      resolve(l.trim());
    };
    if (lines.length) done(lines.shift());
    else waiting = done;
  });
}

// ---- HTTP ----------------------------------------------------------------------
async function api(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  if (json) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(baseUrl + path, { method, headers, body: json ? JSON.stringify(json) : undefined });
  } catch (err) {
    throw new Error(`Server ${baseUrl} nicht erreichbar (${err.cause?.code ?? err.cause?.message ?? err.message}).`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, data };
}

async function login() {
  const email = process.env.PB_ADMIN_EMAIL || await ask('Admin-E-Mail: ');
  const password = process.env.PB_ADMIN_PASSWORD || await ask('Passwort: ', { hidden: true });
  const first = await api('POST', '/api/collections/_superusers/auth-with-password', { json: { identity: email, password } });
  if (first.ok) return first.data.token;
  const mfaId = first.data?.mfaId;
  if (!mfaId) throw new Error(`Anmeldung fehlgeschlagen (HTTP ${first.status}): ${first.data?.message ?? ''}`);

  const otp = await api('POST', '/api/collections/_superusers/request-otp', { json: { email } });
  if (!otp.ok) throw new Error(`Code konnte nicht angefordert werden (HTTP ${otp.status}).`);
  const code = await ask('Code aus der Mail: ');
  const second = await api('POST', '/api/collections/_superusers/auth-with-otp', { json: { otpId: otp.data.otpId, password: code, mfaId } });
  if (!second.ok) throw new Error(`Code ungültig (HTTP ${second.status}).`);
  return second.data.token;
}

async function listReports(token) {
  const all = [];
  for (let page = 1; ; page++) {
    const r = await api('GET', `/api/collections/scan_reports/records?page=${page}&perPage=50&sort=created`, { token });
    if (!r.ok) throw new Error(`Meldungen konnten nicht gelesen werden (HTTP ${r.status}).`);
    all.push(...r.data.items);
    if (page >= r.data.totalPages) return all;
  }
}

/** Datei herunterladen; Fehler, wenn nicht vollständig. */
async function download(report, name, fileToken, target) {
  const url = `${baseUrl}/api/files/scan_reports/${report.id}/${encodeURIComponent(name)}?token=${fileToken}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download von ${name} fehlgeschlagen (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = Number(res.headers.get('content-length'));
  if (!buf.length || (expected && buf.length !== expected)) throw new Error(`Download von ${name} unvollständig.`);
  writeFileSync(target, buf);
}

// ---- Ablauf --------------------------------------------------------------------
try {
  const token = await login();
  const reports = await listReports(token);
  if (!reports.length) {
    console.log('Keine Meldungen vorhanden.');
  }
  for (const report of reports) {
    const { data: { token: fileToken } } = await api('POST', '/api/files/token', { token });
    const stamp = report.created.slice(0, 19).replace(/[: ]/g, (c) => (c === ' ' ? '_' : '-'));
    const dir = join(outDir, `${stamp}_${report.id}`);
    if (existsSync(join(dir, 'report.json'))) {
      console.log(`${report.id}: bereits vorhanden – wird nicht erneut geholt.`);
    } else {
      mkdirSync(dir, { recursive: true });
      for (const [i, name] of report.photos.entries()) {
        await download(report, name, fileToken, join(dir, `seite-${String(i + 1).padStart(2, '0')}.jpg`));
      }
      writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    let action = 'behalten (--keep)';
    if (!keep) {
      const del = await api('DELETE', `/api/collections/scan_reports/records/${report.id}`, { token });
      if (!del.ok) throw new Error(`${report.id}: Löschen auf dem Server fehlgeschlagen (HTTP ${del.status}).`);
      action = 'auf dem Server gelöscht';
    }
    const problems = report.analysis?.problems?.join('; ') || 'keine automatisch erkannten Probleme';
    console.log(`${report.id}: ${report.photos.length} Seite(n) → ${dir} – ${action}. ${problems}`);
  }
} catch (err) {
  console.error('Fehler:', err.message);
  process.exitCode = 1;
} finally {
  rl?.close();
}
