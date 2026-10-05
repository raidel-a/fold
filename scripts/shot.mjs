// Screenshots the built extension in Helium so the UI can actually be looked at.
// Usage: node scripts/shot.mjs [distPath] [dark|light] [outDir]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// First argument is the extension path only when it looks like one; otherwise
// it is the colour scheme, so `node shot.mjs light` works.
const args = process.argv.slice(2);
const hasPath = args[0]?.startsWith('/');
const EXT = hasPath ? args[0] : join(ROOT, 'extension/dist');
const SCHEME = hasPath ? (args[1] ?? 'dark') : (args[0] ?? 'dark');
const OUT = (hasPath ? args[2] : args[1]) || join(ROOT, 'shots');
const PORT = 9451;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// Extension ID is derived from the dist path, same as the native host installer.
const { createHash } = await import('node:crypto');
const EXT_ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map(c => 'abcdefghijklmnopqrstuvwxyz'[parseInt(c, 16)]).join('');

const profile = mkdtempSync(join(tmpdir(), 'fold-shot-'));
const helium = spawn('/Applications/Helium.app/Contents/MacOS/Helium', [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

/** Rejects rather than hanging: a CDP call on an occluded page never settles. */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + what)), ms)),
  ]);
}

function connect(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  let nextId = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  return {
    ready, close: () => ws.close(),
    send: (method, params = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => waiters.set(id, { resolve: res, reject: rej }));
    },
  };
}

async function targetFor(match, tries = 40) {
  for (let i = 0; i < tries; i++) {
    let list = [];
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* retry */ }
    const hit = list.find(match);
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

try {
  const worker = await targetFor(t =>
    (t.type === 'service_worker' || t.type === 'background_page') &&
    t.url.includes(EXT_ID));
  if (!worker) throw new Error(`extension ${EXT_ID} never loaded`);
  console.log('extension id:', EXT_ID);

  // Find the worker's origin, then open the two surfaces.
  const w = connect(worker.webSocketDebuggerUrl);
  await w.ready;
  const origin = (await w.send('Runtime.evaluate', { expression: 'self.location.origin', returnByValue: true }))
    .result.value;
  w.close();

  // Real viewports, so the popup is judged at popup width rather than the
  // window width it is being screenshotted in.
  const POPUP = { width: 340, height: 520, dsf: 2 };
  const OPTIONS = { width: 900, height: 1000, dsf: 2 };
  const pages = [
    ['popup', `${origin}/popup.html`, POPUP],
    ['options-model', `${origin}/options.html#model`, OPTIONS],
    ['options-folding', `${origin}/options.html#folding`, OPTIONS],
    ['options-learning', `${origin}/options.html#learning`, OPTIONS],
    ['options-rules', `${origin}/options.html#rules`, OPTIONS],
    ['options-tools', `${origin}/options.html#tools`, OPTIONS],
  ];

  for (const [name, url, view] of pages) {
    const opened = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }
    )).json();

    const page = connect(opened.webSocketDebuggerUrl);
    await withTimeout(page.ready, 15000, name + " connect");

    // Force the appearance so both schemes can be captured regardless of the
    // host machine's current setting.
    await withTimeout(page.send('Page.enable'), 15000, "Page.enable");
    await withTimeout(page.send('Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height, deviceScaleFactor: view.dsf, mobile: false,
    }), 15000, "setDeviceMetrics");
    await withTimeout(page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: SCHEME }],
    }), 15000, "setEmulatedMedia");
    // The page must be foregrounded or Chromium will not paint it.
    await withTimeout(page.send('Page.bringToFront'), 15000, "bringToFront");
    await sleep(2000);
    // The host reports the machine appearance via data-appearance, which outranks the
    // media query. Override it after the host has answered, so both schemes can be
    // validated on either machine.
    await withTimeout(page.send('Runtime.evaluate', {
      expression: `document.documentElement.dataset.appearance = '${SCHEME}'`,
    }), 10000, "force appearance");

    const shot = await withTimeout(page.send('Page.captureScreenshot', { format: 'png' }), 20000, "captureScreenshot");
    const file = join(OUT, `${name}-${SCHEME}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('wrote', file);
    page.close();
  }

  console.log(readdirSync(OUT).join('\n'));
} finally {
  helium.kill();
  await sleep(400);
  rmSync(profile, { recursive: true, force: true });
}