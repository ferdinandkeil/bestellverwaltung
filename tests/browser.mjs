// Gemeinsamer Browser-Client für die E2E-Tests (headless Chrome über das DevTools-Protokoll,
// nur Node-Bordmittel). Optional: CHROME_BIN, E2E_SCREENSHOTS, E2E_DEVTOOLS_PORT.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAILPIT_URL } from './helpers.mjs';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
export const SHOTS = process.env.E2E_SCREENSHOTS || '';
const PORT = Number(process.env.E2E_DEVTOOLS_PORT || 9333);
const VIEWPORT = { width: 400, height: 860 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimaler CDP-Client
// ---------------------------------------------------------------------------
export async function launchBrowser(profileDir) {
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
    /** Viewport setzen (Standard: Smartphone-Breite). */
    setViewport: (v = VIEWPORT, mobile = true) =>
      send('Emulation.setDeviceMetricsOverride', { ...v, deviceScaleFactor: mobile ? 2 : 1, mobile }),
    /** Datei(en) in ein <input type=file> legen (löst change aus). */
    async setFiles(selector, files) {
      const { result: { root } } = await send('DOM.getDocument', { depth: 0 });
      const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('Datei-Feld nicht gefunden: ' + selector);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    /** Screenshot des Viewports als Datei (PNG oder JPEG). */
    async screenshotTo(path, format = 'png', quality = 90) {
      const r = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}) });
      writeFileSync(path, Buffer.from(r.result.data, 'base64'));
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

export async function otpFromMailpit(email, notBefore) {
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

/** Login über die Oberfläche mit OTP aus Mailpit. */
export async function loginViaUi(b, baseUrl, email) {
  await b.navigate(baseUrl + '/');
  await b.waitFor(`location.hash === '#/login' && document.querySelector('#login-email')`, 'Login-Maske');
  const requestedAt = Date.now();
  await b.fill('#login-email', email);
  await b.clickText('button', 'Code anfordern');
  await b.waitFor(`document.querySelector('#login-code')?.offsetParent`, 'Code-Feld');
  const code = await otpFromMailpit(email, requestedAt);
  await b.fill('#login-code', code);
  await b.clickText('button', 'Anmelden');
  await b.waitFor(`location.hash === '#/'`, 'Login');
}
