// Screenshots the popup mid-fold.
//
// The page's real onMessage listener is captured via
// addScriptToEvaluateOnNewDocument and then invoked, so the progress path runs as
// it does in production. Poking the DOM directly would produce a screenshot of an
// idealised state rather than the one a user sees.
//
// Usage: node scripts/shot-progress.mjs <dist-dir> [label] [fraction|null] [out.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const EXT = resolve(process.argv[2]);
const LABEL = process.argv[3] || 'Grouping 60 of 140';
const FRACTION = process.argv[4] ?? '0.43';
const OUT = process.argv[5] || 'progress.png';
const PORT = 9467;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const EXT_ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map(c => 'abcdefghijklmnopqrstuvwxyz'[parseInt(c, 16)]).join('');

const profile = mkdtempSync(join(tmpdir(), 'fold-progress-'));
const browser = spawn('/Applications/Helium.app/Contents/MacOS/Helium', [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, 'about:blank',
], { stdio: 'ignore' });

function connect(url) {
  const ws = new WebSocket(url);
  const waiters = new Map(); let nextId = 0;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data); const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); }
  };
  return { ready: new Promise(r => { ws.onopen = r; }), close: () => ws.close(),
    send: (method, params = {}) => { const id = ++nextId; ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => waiters.set(id, { resolve: res, reject: rej })); } };
}
const t = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout: ' + what)), ms))]);

try {
  let worker = null;
  for (let i = 0; i < 40 && !worker; i++) {
    let list = [];
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {}
    worker = list.find(t => t.url.includes(EXT_ID));
    if (!worker) await sleep(500);
  }
  const w = connect(worker.webSocketDebuggerUrl); await w.ready;
  const origin = (await w.send('Runtime.evaluate', { expression: 'self.location.origin', returnByValue: true })).result.value;
  w.close();

  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(origin + '/popup.html')}`, { method: 'PUT' })).json();
  const c = connect(page.webSocketDebuggerUrl);
  await t(c.ready, 15000, 'connect');
  await t(c.send('Page.enable'), 15000, 'enable');

  // Capture the listener the popup registers, before the bundle runs.
  await t(c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__foldListeners = [];
      const original = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
      chrome.runtime.onMessage.addListener = (fn, ...rest) => {
        window.__foldListeners.push(fn);
        return original(fn, ...rest);
      };`,
  }), 15000, 'inject');

  await t(c.send('Page.navigate', { url: origin + '/popup.html' }), 15000, 'navigate');
  await t(c.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 520, deviceScaleFactor: 2, mobile: false }), 15000, 'metrics');
  await sleep(2500);

  const captured = await c.send('Runtime.evaluate', { expression: 'window.__foldListeners.length', returnByValue: true });
  console.log('listeners captured:', captured.result.value);

  // Drive the real handler.
  const delivered = await c.send('Runtime.evaluate', {
    expression: `(() => {
      const before = document.querySelector('.empty-title')?.textContent ?? null;
      for (const fn of window.__foldListeners) fn({ type: 'fold-progress', progress: { label: ${JSON.stringify(LABEL)}, fraction: ${FRACTION} } });
      const bar = document.getElementById('progress');
      return JSON.stringify({
        before,
        barHidden: bar.hidden,
        mode: bar.dataset.mode,
        valuenow: bar.getAttribute('aria-valuenow'),
        status: document.getElementById('status').textContent,
        emptyAfter: document.querySelector('.empty-title')?.textContent ?? null,
      });
    })()`,
    returnByValue: true,
  });
  console.log(delivered.result.value);

  await sleep(700);
  const shot = await t(c.send('Page.captureScreenshot', { format: 'png' }), 20000, 'shot');
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'shots', OUT);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log('wrote', path);
  c.close();
} finally {
  browser.kill(); await sleep(400); rmSync(profile, { recursive: true, force: true });
}
