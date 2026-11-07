// Browser-Durchlauf (headless Chrome über das DevTools-Protokoll, nur Node-Bordmittel).
// Start über:  tests/run.sh --e2e
// Optional:    CHROME_BIN=/pfad/zu/chrome   E2E_SCREENSHOTS=/verzeichnis (speichert PNGs in Handy-Breite)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PB_URL, MAILPIT_URL, setup, resetData, createUser, createGroup, addItem, changeStatus, bookDelivery,
} from './helpers.mjs';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const SHOTS = process.env.E2E_SCREENSHOTS || '';
const PORT = Number(process.env.E2E_DEVTOOLS_PORT || 9333);
const VIEWPORT = { width: 400, height: 860 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Testdaten
// ---------------------------------------------------------------------------
async function seed() {
  await setup();
  await resetData();
  const owner = await createUser('Seed');
  const a = await createGroup('Gruppe A');
  const b = await createGroup('Gruppe B');
  await addItem(owner.token, { supplier: 'mouser', part_number: '595-SN74HC595N', name: 'Schieberegister 8 Bit, DIP-16', qty: 5, group: a.id, price_unit: 0.62 });
  await addItem(owner.token, { supplier: 'mouser', part_number: '595-sn74hc595n', name: 'x', qty: 3, group: b.id });
  const r = await addItem(owner.token, { supplier: 'reichelt', part_number: 'NE 555 DIP', name: 'Timer NE555', qty: 10, group: b.id, price_unit: 0.25 });
  await changeStatus(owner.token, r.order.id, 'advance', { supplier_order_no: 'R-4711' });
  await bookDelivery(owner.token, r.order.id, [{ item: r.item.id, qty: 4 }], 'Paket 1');
  return { groupA: a.id, login: await createUser('E2E Tester') };
}

// ---------------------------------------------------------------------------
// Minimaler CDP-Client
// ---------------------------------------------------------------------------
async function launchBrowser(profileDir) {
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
  ], { stdio: 'ignore' });

  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* startet noch */ }
    if (!page) await sleep(100);
  }
  if (!page) throw new Error(`Chrome (${CHROME}) nicht erreichbar.`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') problems.push('Exception: ' + msg.params.exceptionDetails.exception?.description);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`${msg.params.entry.text} (${msg.params.entry.url || ''})`);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(`${expression}\n→ ${r.result.exceptionDetails.exception?.description}`);
    return r.result.result.value;
  };

  return {
    problems,
    evaluate,
    navigate: (url) => send('Page.navigate', { url }),
    async waitFor(expression, label, timeoutMs = 8000) {
      for (let t = 0; t < timeoutMs; t += 100) {
        if (await evaluate(`!!(${expression})`)) return;
        await sleep(100);
      }
      throw new Error('Timeout: ' + label);
    },
    fill: (selector, value) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Feld nicht gefunden: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`),
    clickText: (selector, text) => evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!el) throw new Error('Element nicht gefunden: ' + ${JSON.stringify(text)});
      el.click();
    })()`),
    async screenshot(name) {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    },
    async close() {
      ws.close();
      if (proc.exitCode === null) {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill();
        await exited;
      }
    },
  };
}

async function otpFromMailpit(email, notBefore) {
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
    const msg = list.messages?.find((m) => new Date(m.Created).getTime() >= notBefore - 2000);
    if (msg) {
      const full = await (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json();
      const code = full.Text.match(/Anmeldecode lautet:\s*(\d+)/)?.[1];
      if (code) return code;
    }
    await sleep(200);
  }
  throw new Error('Keine OTP-Mail für ' + email);
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
const ORDER_LINKS = `document.querySelectorAll('#view ul a[href^="#/orders/"]')`;
const BADGE = `document.querySelector('#view .badge').innerText.trim()`;

const { groupA, login } = await seed();
const profile = mkdtempSync(join(tmpdir(), 'bestellverwaltung-e2e-'));
const b = await launchBrowser(profile);
let failed = false;
const ok = (msg) => console.log('✔', msg);

try {
  await b.navigate(PB_URL + '/');
  await b.waitFor(`location.hash === '#/login' && document.querySelector('#login-email')`, 'Login-Maske');
  ok('ohne Session → #/login');
  await b.screenshot('01-login');

  const requestedAt = Date.now();
  await b.fill('#login-email', login.email);
  await b.clickText('button', 'Code anfordern');
  await b.waitFor(`document.querySelector('#login-code')?.offsetParent`, 'Code-Feld');
  const code = await otpFromMailpit(login.email, requestedAt);
  ok('Code angefordert, OTP-Mail erhalten');

  await b.fill('#login-code', '00000000');
  await b.clickText('button', 'Anmelden');
  await b.waitFor(`document.body.innerText.includes('falsch oder abgelaufen')`, 'Meldung falscher Code');
  ok('falscher Code → Fehlermeldung');

  await sleep(3500); // PocketBase-Ratenbegrenzung für Auth-Anfragen
  await b.fill('#login-code', code);
  await b.clickText('button', 'Anmelden');
  await b.waitFor(`location.hash === '#/' && ${ORDER_LINKS}.length === 2`, 'Dashboard mit 2 Bestellungen');
  ok('Login → Dashboard mit 2 Bestellungen');
  await b.screenshot('02-dashboard');

  const groupSelect = `[...document.querySelectorAll('#view select')][2]`;
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ${JSON.stringify(groupA)}; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 1`, 'Gruppenfilter');
  await b.evaluate(`(() => { const s = ${groupSelect}; s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`${ORDER_LINKS}.length === 2`, 'Filter zurücksetzen');
  ok('Gruppenfilter');

  await b.clickText('button', '+ Position erfassen');
  await b.waitFor(`document.querySelector('.modal-panel input[placeholder^="z. B. 595"]')?.offsetParent`, 'Formular');
  await b.screenshot('03-formular');
  await b.fill('.modal-panel input[placeholder^="z. B. 595"]', '595-SN74HC595N');
  await b.fill('.modal-panel input[placeholder^="z. B. Schiebe"]', 'egal');
  await b.fill('.modal-panel input[type=number]', '2');
  await b.clickText('.modal-panel button', 'In Warenkorb');
  await b.waitFor(`document.body.innerText.includes('zusammengeführt (jetzt 10 Stück)')`, 'Merge-Meldung');
  await b.clickText('.modal-panel button', 'Schließen');
  ok('Akzeptanzkriterium: Merge auf 10 Stück');

  await b.evaluate(`[...${ORDER_LINKS}].find((a) => a.innerText.includes('Reichelt')).click()`);
  await b.waitFor(`document.querySelector('[x-data=orderDetailView]') && document.body.innerText.includes('Lieferhistorie')`, 'Detail');
  if ((await b.evaluate(BADGE)) !== 'Teilgeliefert') throw new Error('Status sollte Teilgeliefert sein');
  ok('Detail Reichelt (teilgeliefert)');
  await b.screenshot('04-detail');

  await b.clickText('button', '+1');
  await b.clickText('button', '+1');
  await b.clickText('button', '+1');
  await b.waitFor(`document.body.innerText.includes('+3 …')`, 'Sammelanzeige');
  await b.waitFor(`[...document.querySelectorAll('#view dd')][1]?.innerText === '7'`, 'geliefert = 7', 6000);
  const lines = await b.evaluate(`document.querySelectorAll('#view section li ul li').length`);
  if (lines !== 2) throw new Error(`Lieferhistorie: ${lines} statt 2 Buchungen`);
  ok('3× „+1“ → eine Buchung, geliefert 7');

  await b.clickText('button', 'Rest komplett');
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'Status geliefert', 6000);
  ok('„Rest komplett“ → automatisch Geliefert');

  await b.evaluate('window.confirm = () => true');
  await b.clickText('button', 'Als geprüft markieren');
  await b.waitFor(`${BADGE} === 'Geprüft'`, 'Geprüft');
  await b.clickText('button', 'Einen Schritt zurück');
  await b.waitFor(`${BADGE} === 'Geliefert'`, 'zurück');
  ok('Geprüft und einen Schritt zurück');

  await b.navigate(PB_URL + '/#/groups');
  await b.waitFor(`document.querySelector('[x-data=groupsView]') && [...document.querySelectorAll('#view li')].some((l) => l.innerText.includes('Gruppe B'))`, 'Gruppenliste');
  await b.evaluate(`[...document.querySelectorAll('#view li')].find((l) => l.innerText.includes('Gruppe B')).click()`);
  await b.waitFor(`document.body.innerText.includes('Anteil')`, 'Projekt-Status');
  const groupItems = await b.evaluate(`document.querySelectorAll('#view section:nth-of-type(2) li').length`);
  if (groupItems !== 2) throw new Error(`Gruppe B: ${groupItems} statt 2 Positionen`);
  ok('Projekt-Status Gruppe B');
  await b.screenshot('05-gruppen');

  // Erwartet ist nur die 400er-Antwort des absichtlich falschen Codes.
  const unexpected = b.problems.filter((p) => !/auth-with-otp/.test(p));
  if (unexpected.length) throw new Error('Fehler in der Browser-Konsole:\n  ' + unexpected.join('\n  '));
  ok('keine Fehler in der Browser-Konsole');
} catch (err) {
  failed = true;
  console.error('✖', err.message);
  await b.screenshot('fehler').catch(() => {});
} finally {
  await b.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
