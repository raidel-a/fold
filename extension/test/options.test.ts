import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resetAllMocks } from './setup';
import { DEFAULT_SETTINGS } from '../src/types';
import type { DomainRule } from '../src/types';

const html = readFileSync(resolve(__dirname, '../src/options.html'), 'utf-8');

/** Routes worker messages the way the real background script does. */
function mockWorkerMessages(overrides: Record<string, any> = {}) {
  (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
    if (msg.type in overrides) { cb(overrides[msg.type]); return; }
    if (msg.type === 'check-apple-ai') cb({ available: true });
    else if (msg.type === 'get-stats') {
      cb({ stats: { totalOrganizations: 10, totalTabsGrouped: 50, lastOrganizedAt: Date.now() } });
    } else if (msg.type === 'get-usage') {
      cb({ usage: { totalInputTokens: 1200, totalOutputTokens: 340, organizations: 4 } });
    } else if (msg.type === 'export-data') cb({ data: { test: 1 } });
    else cb({ status: 'done' });
  });
}

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise(r => process.nextTick(r));
};

/**
 * options.ts binds its elements at module load, and vi.resetModules() hands it a
 * fresh copy of storage as well. The spies therefore have to be installed on the
 * instance options.ts will actually import, not one imported earlier in this file.
 */
async function loadOptionsPage() {
  vi.resetModules();
  const storage = await import('../src/storage');
  const spies = {
    saveSettings: vi.spyOn(storage, 'saveSettings').mockResolvedValue(),
    saveDomainRules: vi.spyOn(storage, 'saveDomainRules').mockResolvedValue(),
    importAll: vi.spyOn(storage, 'importAll').mockResolvedValue(),
  };
  vi.spyOn(storage, 'getSettings').mockResolvedValue(DEFAULT_SETTINGS);
  vi.spyOn(storage, 'getDomainRules').mockResolvedValue([]);
  await import('../src/options');
  await tick(25);
  return spies;
}

describe('Options Page', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    resetAllMocks();
    vi.clearAllMocks();
    mockWorkerMessages();
  });

  it('has no provider, key, or cost controls left in the markup', () => {
    // The point of the strip-down: these must not come back.
    for (const id of [
      'provider-grid', 'key-row', 'apiKey', 'model-select',
      'signup-link', 'cost-table', 'spendingCapUSD',
    ]) {
      expect(document.getElementById(id)).toBeNull();
    }
  });

  it('shows the model as ready when the host reports available', async () => {
    await loadOptionsPage();

    const status = document.getElementById('model-status')!;
    expect(status.dataset.state).toBe('ready');
    expect(document.getElementById('model-title')!.textContent).toBe('Apple AI is ready');
    // The sidebar pill stays terse; the card carries the explanation.
    expect(document.getElementById('model-status')!.textContent).toBe('Ready');
    // Setup guidance stays hidden when there is nothing to fix.
    expect(document.getElementById('model-setup')!.classList.contains('hidden')).toBe(true);
  });

  it('surfaces the host reason and shows setup guidance when unavailable', async () => {
    mockWorkerMessages({
      'check-apple-ai': { available: false, reason: 'Apple Intelligence is off. Turn it on in System Settings.' },
    });
    await loadOptionsPage();

    expect(document.getElementById('model-status-card')!.dataset.state).toBe('unavailable');
    // The host's own wording is passed through rather than replaced.
    expect(document.getElementById('model-setup-reason')!.textContent)
      .toContain('Apple Intelligence is off');
    expect(document.getElementById('model-setup')!.classList.contains('hidden')).toBe(false);
  });

  it('re-checks on demand', async () => {
    mockWorkerMessages({ 'check-apple-ai': { available: false, reason: 'host missing' } });
    await loadOptionsPage();
    expect(document.getElementById('model-status-card')!.dataset.state).toBe('unavailable');

    mockWorkerMessages({ 'check-apple-ai': { available: true } });
    const btn = document.getElementById('model-recheck-btn') as HTMLButtonElement;
    btn.click();
    await tick();
    expect(document.getElementById('model-status')!.getAttribute('data-state')).toBe('ready');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Check again');
  });

  it('flips to ready after a successful test round trip', async () => {
    mockWorkerMessages({
      'check-apple-ai': { available: false, reason: 'host missing' },
      'test-model': { status: 'done', chatResponse: 'OK' },
    });
    await loadOptionsPage();
    // The pill uses the dot vocabulary; the card carries the state name.
    expect(document.getElementById('model-status')!.dataset.state).toBe('stopped');
    expect(document.getElementById('model-status-card')!.dataset.state).toBe('unavailable');

    (document.getElementById('test-btn') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('test-result')!.textContent).toBe('Replied: OK');
    expect(document.getElementById('model-status-card')!.dataset.state).toBe('ready');
    expect(document.getElementById('model-setup')!.classList.contains('hidden')).toBe(true);
  });

  it('shows the error message when the model test fails', async () => {
    mockWorkerMessages({ 'test-model': { status: 'error', error: 'Host unavailable' } });
    await loadOptionsPage();

    (document.getElementById('test-btn') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('test-result')!.textContent).toBe('Host unavailable');
    // A failed test must not claim the model is ready.
    expect(document.getElementById('model-status-card')!.dataset.state).not.toBe('ready');
  });

  it('renders token usage instead of a cost table', async () => {
    await loadOptionsPage();

    const usage = document.getElementById('usage-line')!.textContent!;
    expect(usage).toContain('1,200 in');
    expect(usage).toContain('340 out');
    expect(usage).toContain('free on-device');
    expect(usage).not.toContain('$');
  });

  it('says so when the model has never run', async () => {
    mockWorkerMessages({
      'get-usage': { usage: { totalInputTokens: 0, totalOutputTokens: 0, organizations: 0 } },
    });
    await loadOptionsPage();

    expect(document.getElementById('usage-line')!.textContent).toBe('No model runs yet.');
  });

  it('auto-saves behavior settings on change', async () => {
    const spies = await loadOptionsPage();

    const maxGroups = document.getElementById('maxGroups') as HTMLInputElement;
    maxGroups.value = '10';
    maxGroups.dispatchEvent(new Event('input'));
    maxGroups.dispatchEvent(new Event('change'));
    await tick();

    expect(document.getElementById('maxGroupsVal')?.textContent).toBe('10');
    expect(spies.saveSettings).toHaveBeenCalled();
  });

  it('purges stale tabs on demand and reports how many closed', async () => {
    mockWorkerMessages({ 'purge-stale': { status: 'done', count: 3 } });
    await loadOptionsPage();

    (document.getElementById('purge-stale-now') as HTMLButtonElement).click();
    await tick();

    const status = document.getElementById('purge-stale-status')!;
    expect(status.textContent).toBe('Closed 3 tabs.');
    expect(status.dataset.tone).toBe('ok');
  });

  it('says so when there was nothing stale to close', async () => {
    mockWorkerMessages({ 'purge-stale': { status: 'done', count: 0 } });
    await loadOptionsPage();

    (document.getElementById('purge-stale-now') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('purge-stale-status')!.textContent).toBe('Nothing stale to close.');
  });

  it('saves the threshold before purging, so a fresh slider value is used', async () => {
    mockWorkerMessages({ 'purge-stale': { status: 'done', count: 0 } });
    const spies = await loadOptionsPage();

    const threshold = document.getElementById('staleTabThresholdHours') as HTMLInputElement;
    threshold.value = '2';
    (document.getElementById('purge-stale-now') as HTMLButtonElement).click();
    await tick();

    // The click path calls save() directly rather than relying on the debounce.
    expect(spies.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ staleTabThresholdHours: 2 }),
    );
  });

  it('surfaces a purge failure instead of claiming success', async () => {
    mockWorkerMessages({ 'purge-stale': { status: 'error', error: 'no window' } });
    await loadOptionsPage();

    (document.getElementById('purge-stale-now') as HTMLButtonElement).click();
    await tick();

    const status = document.getElementById('purge-stale-status')!;
    expect(status.textContent).toBe('no window');
    expect(status.dataset.tone).toBe('stop');
  });

  it('reports drifted groups after a sweep', async () => {
    mockWorkerMessages({
      'check-group-drift': { status: 'done', drifted: true, driftedGroups: ['Reading', 'Work'] },
      'get-group-stats': { status: 'done', groupStats: [
        { name: 'Reading', color: 'blue', tabCount: 12, domains: ['news.com'] },
        { name: 'Work', color: 'red', tabCount: 4, domains: ['slack.com', 'linear.app'] },
      ] },
    });
    await loadOptionsPage();

    (document.getElementById('check-drift-now') as HTMLButtonElement).click();
    await tick();

    const status = document.getElementById('drift-status')!;
    expect(status.textContent).toBe('2 groups drifted: Reading, Work');
    expect(status.dataset.tone).toBe('stop');
  });

  it('says every group holds together when nothing drifted', async () => {
    mockWorkerMessages({
      'check-group-drift': { status: 'done', drifted: false, driftedGroups: [] },
      'get-group-stats': { status: 'done', groupStats: [] },
    });
    await loadOptionsPage();

    (document.getElementById('check-drift-now') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('drift-status')!.textContent).toBe('Every group still holds together.');
  });

  it('lists group contents widest first, truncating long domain lists', async () => {
    mockWorkerMessages({
      'get-group-stats': { status: 'done', groupStats: [
        { name: 'Small', color: 'grey', tabCount: 2, domains: ['a.com'] },
        { name: 'Big', color: 'blue', tabCount: 40, domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] },
      ] },
    });
    await loadOptionsPage();
    await tick();

    const rows = document.querySelectorAll('#group-stats .stat-line');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Big');
    expect(rows[0].textContent).toContain('+2');
    expect(rows[1].textContent).toContain('Small');
  });

  it('manages domain rules', async () => {
    const spies = await loadOptionsPage([
      { domain: 'github.com', groupName: 'Dev', color: 'blue' },
    ]);

    (document.getElementById('add-rule') as HTMLButtonElement).click();
    await tick();
    expect(spies.saveDomainRules).toHaveBeenCalled();

    const ruleInput = document.querySelector('.rule-domain') as HTMLInputElement;
    expect(ruleInput).toBeTruthy();
    // Colour is a cycled swatch now, not a named dropdown.
    expect(document.querySelector('.rule-color-swatch')).toBeTruthy();
    expect(document.querySelector('.rule select')).toBeFalsy();
    ruleInput.value = 'github.com';
    ruleInput.dispatchEvent(new Event('change'));
    await tick();
    expect(spies.saveDomainRules).toHaveBeenCalled();

    (document.querySelector('.rule-delete') as HTMLButtonElement).click();
    await tick();
    expect(document.querySelector('.rule-domain')).toBeFalsy();
  });

  it('exports and imports settings', async () => {
    await loadOptionsPage();
    mockWorkerMessages({ 'import-data': { status: 'imported' } });

    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
    (document.getElementById('export-data') as HTMLButtonElement).click();
    await tick();

    const importBtn = document.getElementById('import-data') as HTMLButtonElement;
    const importFile = document.getElementById('import-file') as HTMLInputElement;
    importBtn.click();
    Object.defineProperty(importFile, 'files', {
      value: [new File([JSON.stringify({ settings: DEFAULT_SETTINGS })], 'export.json')],
    });
    importFile.dispatchEvent(new Event('change'));
    await tick();

    // Import round-trips through the worker, not straight to storage.
    const sent = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .map(([m]) => m as any)
      .filter(m => m.type === 'import-data');
    expect(sent).toHaveLength(1);
    expect(sent[0].data.settings).toEqual(DEFAULT_SETTINGS);
  });
});
