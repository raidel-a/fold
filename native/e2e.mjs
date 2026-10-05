// Loads the built extension into Helium via CDP and exercises the native host
// end to end, the same path the real extension uses.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT = resolve(process.argv[2]);
const HOST_BIN = resolve(process.argv[3]);
const PORT = 9444;

// Chromium's unpacked-extension ID is a hash of the absolute path, the same
// derivation scripts/install-native-host.sh uses. Hardcoding it here meant a
// moved checkout silently failed with "access to the native messaging host is
// forbidden", which reads like a permissions bug rather than a stale constant.
const EXT_ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map(c => 'abcdefghijklmnopqrstuvwxyz'[parseInt(c, 16)]).join('');

const profile = mkdtempSync(join(tmpdir(), 'fold-helium-'));

// Chromium resolves user-level native messaging hosts relative to the active
// user-data-dir, so a throwaway profile needs its own copy of the manifest.
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(join(profile, 'NativeMessagingHosts', 'com.fold.appleai.json'), JSON.stringify({
  name: 'com.fold.appleai',
  description: 'Fold Apple Foundation Models bridge',
  path: HOST_BIN,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXT_ID}/`],
}));
const helium = spawn('/Applications/Helium.app/Contents/MacOS/Helium', [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions-except=' + EXT,
  '--load-extension=' + EXT,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
helium.stderr.on('data', (d) => { stderr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return res;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`devtools never came up.\n${stderr}`);
}

function connect(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  let nextId = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result); }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
  };
  return { ready, send, close: () => ws.close() };
}

const timeout = setTimeout(() => {
  console.error('\nwatchdog: aborting');
  process.exit(1);
}, 240_000);
timeout.unref?.();

try {
  await endpoint('/json/version');

  // Helium ships its own internal extension, so identify ours by manifest rather
  // than taking the first service worker target.
  let worker;
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const list = await (await endpoint('/json/list')).json();
    const candidates = list.filter((t) => t.type === 'service_worker' || t.type === 'background_page');
    seen.push(...candidates.map((t) => t.url));
    for (const c of candidates) {
      const cdp0 = connect(c.webSocketDebuggerUrl);
      await cdp0.ready;
      const r = await cdp0.send('Runtime.evaluate', {
        expression: 'try { chrome.runtime.getManifest().name } catch { null }',
        returnByValue: true,
      }).catch(() => null);
      cdp0.close();
      if (r?.result?.value === 'Fold') { worker = c; break; }
    }
    if (worker) break;
    await sleep(500);
  }
  if (!worker) throw new Error(`Fold worker never appeared; saw:\n${[...new Set(seen)].join('\n')}`);

  const cdp = connect(worker.webSocketDebuggerUrl);
  await cdp.ready;

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
    return r.result.value;
  };

  console.log('worker url:', await evaluate('self.location.href'));

  console.log('manifest perms:', await evaluate('chrome.runtime.getManifest().permissions.join(",")'));

  // Test sendNativeMessage directly, independent of Fold's message plumbing.
  console.log('\n--- chrome.runtime.sendNativeMessage (direct, via llm.ts checkAppleAI path)');
  console.log(JSON.stringify(await evaluate(`
    new Promise(r => {
      let done = false;
      const t = setTimeout(() => { if (!done) r({ TIMEOUT: true }); }, 30000);
      chrome.runtime.sendNativeMessage('com.fold.appleai', { id: 'x', op: 'status' }, resp => {
        done = true; clearTimeout(t);
        r(resp === undefined ? { UNDEFINED: true, lastError: chrome.runtime.lastError?.message } : resp);
      });
    })
  `), null, 2));

  // The options page sends check-apple-ai to the worker; retry until the
  // worker's onMessage listener is live (MV3 workers start lazily).
  // Exercise the real llm.ts completion path: same host, same prompt shape the
  // grouper sends. A service worker cannot message itself, so the status probe
  // above goes straight to sendNativeMessage and the full flow is driven from the
  // options page further down.
  console.log('\n--- real grouping prompt through the native host');
  const tabs = [
    { title: 'myorg/pulls', url: 'https://github.com/myorg/pulls' },
    { title: 'Trending', url: 'https://github.com/trending' },
    { title: 'Shop shoes', url: 'https://shop.example.com/shoes' },
    { title: 'Local news', url: 'https://news.example.org/local' },
  ];
  const list = tabs.map(t => `${t.title} (${t.url})`).join('\n');
  const result = await evaluate(`
    new Promise(res => {
      let done = false;
      const t = setTimeout(() => { if (!done) res({ TIMEOUT: true }); }, 120000);
      chrome.runtime.sendNativeMessage('com.fold.appleai', {
        id: 'e2e',
        systemPrompt: 'Group tabs into at most 2 topics. Reply with JSON only.',
        prompt: ${JSON.stringify(list)},
        maxTokens: 512,
      }, resp => {
        done = true; clearTimeout(t);
        res(resp === undefined ? { UNDEFINED: true, err: chrome.runtime.lastError?.message } : resp);
      });
    })
  `);
  console.log(JSON.stringify(result, null, 2));

  const waitForTarget = async (match, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const list = await (await endpoint('/json/list')).json();
      const hit = list.find(match);
      if (hit) return hit;
      await sleep(500);
    }
    return null;
  };

// Drive the options page UI, which is where a user actually picks the provider.
  const origin = await evaluate('self.location.origin');
  const opened = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${origin}/options.html`)}`,
    { method: 'PUT' }
  )).json();

  const optTarget = await waitForTarget((t) => t.url.endsWith('/options.html'));
  if (!optTarget) throw new Error('options page never loaded');
  await sleep(3000);

  const opt = connect(optTarget.webSocketDebuggerUrl);
  await opt.ready;
  const optEval = async (expression) => {
    const r = await opt.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
    return r.result.value;
  };

  console.log('\n--- model status card');
  console.log(await optEval(`
    (() => {
      const card = document.getElementById('model-status-card');
      return JSON.stringify({
        state: card.dataset.state,
        title: document.getElementById('model-title').textContent,
        detail: document.getElementById('model-detail').textContent,
        sidebarPill: document.getElementById('model-status').textContent,
        setupHidden: document.getElementById('model-setup').classList.contains('hidden'),
        // The accent must come from the host, not a hardcoded brand colour.
        accent: getComputedStyle(document.documentElement).getPropertyValue('--fold-accent').trim(),
        groupBlue: getComputedStyle(document.documentElement).getPropertyValue('--group-blue').trim(),
        // Nothing model-picker-shaped should remain.
        removed: ['provider-grid', 'key-row', 'apiKey', 'model-select', 'cost-table', 'spendingCapUSD', 'tab-btn', 'tab-panel']
          .filter(id => document.getElementById(id) || document.querySelector('.' + id)),
      }, null, 2);
    })()
  `));

  console.log('\n--- usage readout');
  console.log(await optEval(`document.getElementById('usage-line').textContent`));

  console.log('\n--- Test model round trip through llm.ts');
  await optEval(`(() => { document.getElementById('test-btn').click(); return true; })()`);
  for (let i = 0; i < 90; i++) {
    const text = await optEval(`document.getElementById('test-result').textContent`);
    if (text && text !== 'Warming up the model…') { console.log('test-result:', text); break; }
    await sleep(1000);
    if (i === 89) console.log('test-result: TIMED OUT');
  }
  console.log('status after test:', await optEval(`document.getElementById('model-status').dataset.state`));

  // Real end to end: run the worker's organize handler over open tabs and confirm
  // it produced groups via Foundation Models. Sent from a page (not the worker)
  // because a service worker cannot receive its own runtime message.
  // A real fold needs real tabs; the model reads their titles and URLs.
  const tabUrls = [
    'https://github.com/myorg/pulls',
    'https://github.com/trending',
    'https://stackoverflow.com/questions',
    'https://shop.example.com/shoes',
    'https://news.example.org/local',
    'https://docs.google.com/document/d/abc',
  ];
  const caller = connect(optTarget.webSocketDebuggerUrl);
  await caller.ready;
  const callerEval = async (expression) => {
    const r = await caller.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
    return r.result.value;
  };
  for (const url of tabUrls) {
    await callerEval(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then(() => true)`);
  }
  await sleep(2000);

  console.log('\n--- tabs opened for grouping');
  console.log(await callerEval(`
    chrome.tabs.query({}).then(ts =>
      JSON.stringify(ts.filter(t => /^https?:/.test(t.url)).map(t => t.title), null, 2))
  `));

  console.log('\n--- organize (Apple AI via Foundation Models)');
  console.log(await callerEval(`
    new Promise(res => {
      let done = false;
      const t = setTimeout(() => { if (!done) res({ TIMEOUT: true }); }, 180000);
      chrome.runtime.sendMessage({ type: 'organize' }, resp => {
        done = true; clearTimeout(t);
        res(JSON.stringify(resp, null, 2));
      });
    })
  `));

  console.log('\n--- usage recorded');
  console.log(await callerEval(`
    new Promise(r => chrome.runtime.sendMessage({ type: 'get-usage' }, r))
      .then(r => JSON.stringify(r.usage, null, 2))
  `));

  caller.close();

  console.log('\n--- persisted settings');
  console.log(await optEval(`
    new Promise(r => chrome.storage.sync.get(null, r))
      .then(s => JSON.stringify(s))
  `));

  opt.close();
  cdp.close();
  console.log('\nOK');
} finally {
  helium.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}