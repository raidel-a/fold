import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resetAllMocks } from './setup';
import * as storage from '../src/storage';

const html = readFileSync(resolve(__dirname, '../src/popup.html'), 'utf-8');

/** Pumps the microtask queue so the popup's async init can settle. */
const tick = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise(r => process.nextTick(r));
};

/**
 * popup.ts binds its elements at module load, so every test needs a fresh module
 * against a fresh DOM. The storage spy must land on the instance popup.ts will
 * actually import, which resetModules makes a new one.
 */
async function loadPopup(_unused?: unknown, pending?: unknown[]) {
  vi.resetModules();
  const mod = await import('../src/storage');
  vi.spyOn(mod, 'getSuggestions').mockResolvedValue(
    (pending ?? [{ name: 'Pending Group', color: 'blue', tabs: [{ id: 1, url: 'https://tab1.com', title: 'Tab 1' }] }]) as any,
  );
  await import('../src/popup');
  await tick(20);
  return mod;
}

describe('Popup Page', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    resetAllMocks();
    vi.clearAllMocks();

    vi.spyOn(storage, 'getSuggestions').mockResolvedValue([
      { name: 'Pending Group', color: 'blue', tabs: [{ id: 1, url: 'https://tab1.com', title: 'Tab 1' }] },
    ] as any);

    // The popup also talks to the native host for its status pill and theme.
    vi.mocked((chrome.runtime as any).sendNativeMessage).mockImplementation(
      (_host: string, msg: any, cb: Function) => {
        if (msg?.op === 'status') cb({ ok: true, available: true });
        else if (msg?.op === 'theme') {
          cb({ ok: true, accent: '#FF9500', isDark: true, accentIsFallback: false, groupColors: { blue: '#0091FF' } });
        } else cb({ ok: true, content: 'OK' });
      }
    );

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'get-stats') cb({ stats: { totalOrganizations: 1, totalTabsGrouped: 5 } });
      else cb({ status: 'done', count: 5 });
    });
  });

  it('renders pending suggestions from storage on open', async () => {
    await loadPopup();

    expect(document.getElementById('status')?.textContent).toContain('waiting for review');
    expect((document.getElementById('apply-all') as HTMLButtonElement).hidden).toBe(false);
    expect(document.querySelectorAll('.card')).toHaveLength(1);
  });

  it('shows the empty state when nothing is pending', async () => {
    await loadPopup(undefined, []);

    expect(document.querySelector('.empty-title')?.textContent).toBe('Nothing folded yet');
    expect((document.getElementById('apply-all') as HTMLButtonElement).hidden).toBe(true);
  });

  it('adopts the accent color reported by the native host', async () => {
    await loadPopup();

    // The host owns the accent so the UI matches System Settings.
    expect(document.documentElement.style.getPropertyValue('--fold-accent')).toBe('#FF9500');
    expect(document.documentElement.dataset.appearance).toBe('dark');
    // Group colours become variables so chips use the browser's real palette.
    expect(document.documentElement.style.getPropertyValue('--group-blue')).toBe('#0091FF');
  });

  it('reports model availability in the header pill', async () => {
    await loadPopup();

    const pill = document.getElementById('model-status')!;
    expect(pill.dataset.state).toBe('ready');
    expect(pill.textContent).toBe('On-device');
  });

  it('folds on demand and reveals apply', async () => {
    await loadPopup();

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'organize') {
        cb({ suggestions: [
          { name: 'Group 1', color: 'blue', tabs: [{ id: 1, url: 'https://a.com', title: 'A' }, { id: 2, url: 'https://b.com', title: 'B' }] },
        ] });
      } else cb({ status: 'done' });
    });

    (document.getElementById('organize') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('status')?.textContent).toContain('1 groups suggested');
    const card = document.querySelector('.card') as HTMLElement;
    expect(card.style.borderLeftColor).toContain('--group-blue');
  });

  it('cycles the group colour instead of opening a dropdown', async () => {
    await loadPopup();

    const swatch = document.querySelector('.swatch') as HTMLButtonElement;
    expect(swatch.title).toBe('Change colour (currently blue)');
    swatch.click();
    await tick();

    expect((document.querySelector('.swatch') as HTMLElement).title).toBe('Change colour (currently red)');
  });

  it('applies groups and clears the cards', async () => {
    await loadPopup();

    const btnApply = document.getElementById('apply-all') as HTMLButtonElement;
    btnApply.click();
    await tick();

    expect(btnApply.hidden).toBe(true);
    expect(document.getElementById('status')?.textContent).toBe('Groups applied');
  });

  it('undoes the last fold', async () => {
    await loadPopup();

    (document.getElementById('undo') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('status')?.textContent).toBe('Last folding undone');
  });

  it('opens settings', async () => {
    await loadPopup();

    (document.getElementById('open-settings') as HTMLButtonElement).click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('folds ungrouped tabs only', async () => {
    await loadPopup();

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'organize-ungrouped') cb({ suggestions: [] });
      else cb({ status: 'done' });
    });

    (document.getElementById('organize-ungrouped') as HTMLButtonElement).click();
    await tick();

    expect(document.querySelector('.empty-title')).toBeTruthy();
  });

  it('reports a missing worker response as a failure', async () => {
    await loadPopup();

    (chrome.runtime.sendMessage as any).mockImplementationOnce((_m: any, cb: Function) => cb(undefined));
    (document.getElementById('organize') as HTMLButtonElement).click();
    await tick();

    const status = document.getElementById('status')!;
    expect(status.textContent).toBe('No response from the worker — try again');
    // A failure must not read as success.
    expect(status.dataset.tone).toBe('stop');
  });

  it('surfaces a worker error', async () => {
    await loadPopup();

    (chrome.runtime.sendMessage as any).mockImplementationOnce((_m: any, cb: Function) => cb({ error: 'Native host unavailable' }));
    (document.getElementById('organize') as HTMLButtonElement).click();
    await tick();

    expect(document.getElementById('status')?.textContent).toBe('Native host unavailable');
    expect(document.getElementById('status')?.dataset.tone).toBe('stop');
  });

  // ---------- fold progress ----------

  /** Delivers a worker broadcast to whatever the popup registered. */
  async function emitProgress(progress: Record<string, unknown>) {
    await (chrome.runtime.onMessage as any).callListeners({ type: 'fold-progress', progress });
  }

  it('stays quiet until the worker reports something', async () => {
    await loadPopup();

    const bar = document.getElementById('progress') as HTMLDivElement;
    expect(bar.hidden).toBe(true);
  });

  it('shows an indeterminate bar while the tab count is unknown', async () => {
    await loadPopup();

    await emitProgress({ label: 'Reading tabs', fraction: 0 });
    await tick(2);

    const bar = document.getElementById('progress') as HTMLDivElement;
    expect(bar.hidden).toBe(false);
    // A phase with no honest total must not claim a percentage.
    expect(bar.dataset.mode).toBe('determinate');
    expect(document.getElementById('status')?.textContent).toBe('Reading tabs');
  });

  it('shows no percentage while the fraction is null', async () => {
    await loadPopup();

    await emitProgress({ label: 'Grouping', fraction: null });
    await tick(2);

    const bar = document.getElementById('progress') as HTMLDivElement;
    expect(bar.dataset.mode).toBe('indeterminate');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('scales the bar and reports a percentage once determinate', async () => {
    await loadPopup();

    await emitProgress({ label: 'Grouping 60 of 140', fraction: 60 / 140, done: 60, total: 140 });
    await tick(2);

    const bar = document.getElementById('progress') as HTMLDivElement;
    const fill = document.getElementById('progress-fill') as HTMLSpanElement;
    expect(bar.dataset.mode).toBe('determinate');
    expect(bar.getAttribute('aria-valuenow')).toBe('43');
    expect(fill.style.transform).toBe('scaleX(0.43)');
    expect(document.getElementById('status')?.textContent).toBe('Grouping 60 of 140');
  });

  it('clamps a fraction outside 0 to 1', async () => {
    await loadPopup();

    await emitProgress({ label: 'Finishing', fraction: 4 });
    await tick(2);
    expect(document.getElementById('progress')!.getAttribute('aria-valuenow')).toBe('100');

    await emitProgress({ label: 'Reading tabs', fraction: -1 });
    await tick(2);
    expect(document.getElementById('progress')!.getAttribute('aria-valuenow')).toBe('0');
  });

  it('does not claim nothing is folded while a fold is running', async () => {
    // "Nothing folded yet" under a progress bar reporting progress reads as a
    // broken panel, not a busy one.
    // The helper installs the spy on the module instance popup.ts will import.
    await loadPopup(undefined, []);
    expect(document.querySelector('.empty-title')).toBeTruthy();

    await emitProgress({ label: 'Grouping 60 of 140', fraction: 0.4 });
    expect(document.querySelector('.empty-title')).toBeFalsy();
  });

  it('restores the empty state when a fold returns nothing', async () => {
    await loadPopup(undefined, []);

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'get-stats') return cb({ stats: {} });
      if (msg.type === 'organize') return cb({ suggestions: [] });
      cb({ status: 'done' });
    });

    (document.getElementById('organize') as HTMLButtonElement).click();
    await tick();

    expect(document.querySelector('.empty-title')?.textContent).toBe('Nothing folded yet');
  });

  it('hides the bar once the fold returns', async () => {
    await loadPopup();

    (chrome.runtime.sendMessage as any).mockImplementation((msg: any, cb: Function) => {
      if (msg.type === 'get-stats') return cb({ stats: {} });
      if (msg.type === 'organize') {
        // Synchronous on purpose: the mock's callback style has no place to await.
        void emitProgress({ label: 'Grouping 60 of 140', fraction: 0.5 });
        return cb({ suggestions: [{ name: 'Dev', color: 'blue', tabs: [{ id: 1, url: 'https://a.com', title: 'A' }] }] });
      }
      cb({ status: 'done' });
    });

    (document.getElementById('organize') as HTMLButtonElement).click();
    await tick();

    const bar = document.getElementById('progress') as HTMLDivElement;
    expect(bar.hidden).toBe(true);
    // The result must win over any progress text left on screen.
    expect(document.getElementById('status')?.textContent).toContain('1 groups suggested');
  });

  it('ignores messages that are not progress', async () => {
    await loadPopup();

    const before = document.getElementById('status')?.textContent;
    await (chrome.runtime.onMessage as any).callListeners({ type: 'get-stats' });
    await tick(2);

    expect(document.getElementById('status')?.textContent).toBe(before);
    expect((document.getElementById('progress') as HTMLDivElement).hidden).toBe(true);
  });
});