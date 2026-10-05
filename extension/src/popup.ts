import type { Color, GroupSuggestion, MessageType, CorrectionEntry, RejectionEntry } from './types';
import { COLORS } from './types';
import { getSuggestions, getSettings, saveSettings } from './storage';
import { checkAppleAI } from './llm';
import { applyTheme, watchAppearance } from './theme';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const btnOrganize = $<HTMLButtonElement>('organize');
const btnOrganizeUngrouped = $<HTMLButtonElement>('organize-ungrouped');
const btnApply = $<HTMLButtonElement>('apply-all');
const btnUndo = $<HTMLButtonElement>('undo');
const btnSettings = $<HTMLButtonElement>('open-settings');
const status = $<HTMLDivElement>('status');
const progress = $<HTMLDivElement>('progress');
const progressFill = $<HTMLSpanElement>('progress-fill');
const container = $<HTMLDivElement>('suggestions');
const searchInput = $<HTMLInputElement>('search');
const tabSearchResults = $<HTMLDivElement>('tab-search-results');
const statsText = $<HTMLSpanElement>('stats-text');

let currentSuggestions: GroupSuggestion[] = [];
let originalSuggestions: GroupSuggestion[] = [];

function clearSuggestionUi() {
  currentSuggestions = [];
  container.innerHTML = '';
  renderEmptyState();
  searchInput.value = '';
  tabSearchResults.innerHTML = '';
  btnApply.hidden = true;
}

type Tone = 'idle' | 'busy' | 'ok' | 'stop';

/**
 * Status carries a tone, not just text, so the color follows meaning: a pending
 * run reads as working, a failure as a stop. An empty message keeps the row's
 * height so the layout never jumps.
 */
function setStatus(msg: string, tone: Tone = 'idle') {
  status.textContent = msg;
  status.dataset.tone = tone === 'idle' ? '' : tone;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The worker's reply shape, pulled from the message union so this file stops
 * treating every field as `unknown` at each call site.
 */
type StatusReply = Omit<Extract<MessageType, { type: 'status' }>, 'type'>;

/** Listens for the worker's progress broadcasts and mirrors them into the status line. */
function onWorkerMessage(handler: (msg: MessageType) => void): void {
  const listener = (msg: MessageType) => {
    // Ignore anything aimed at the worker rather than at a page.
    if (msg?.type === 'fold-progress') handler(msg);
  };
  chrome.runtime.onMessage.addListener(listener);
}

// --- Fold progress ---

/**
 * A fold spends most of its time waiting on the model, with nothing to show. The
 * worker broadcasts each phase, and a determinate bar appears only once the tab
 * count is known: an indeterminate sweep that then resolves into a real fraction
 * is worse than no bar at all.
 */
let progressActive = false;

function showProgress({ label, fraction }: { label: string; fraction: number | null }) {
  if (!progressActive) {
    progressActive = true;
    progress.hidden = false;
    // Clear a stale empty state, which would otherwise sit under the bar claiming
    // nothing has been folded.
    container.innerHTML = '';
  }
  status.textContent = label;
  status.dataset.tone = 'busy';

  if (fraction === null) {
    progress.dataset.mode = 'indeterminate';
    progress.removeAttribute('aria-valuenow');
  } else {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    progress.dataset.mode = 'determinate';
    progress.setAttribute('aria-valuenow', String(percent));
    progressFill.style.transform = `scaleX(${percent / 100})`;
  }
}

function stopProgress() {
  if (!progressActive) return;
  progressActive = false;
  progress.hidden = true;
  delete progress.dataset.mode;
  // Restore the empty state only if the fold produced nothing. Otherwise the
  // caller renders suggestions immediately after.
  if (!currentSuggestions.length && !tabSearchResults.children.length) renderEmptyState();
}

function sendMsg(msg: MessageType): Promise<StatusReply | undefined> {
  return new Promise(resolve =>
    chrome.runtime.sendMessage(msg, resolve as (reply: StatusReply) => void));
}

onWorkerMessage(msg => {
  if (msg.type === 'fold-progress') showProgress(msg.progress);
});

function deepCloneSuggestions(suggestions: GroupSuggestion[]): GroupSuggestion[] {
  return suggestions.map(g => ({
    name: g.name,
    color: g.color,
    tabs: g.tabs.map(t => ({ ...t })),
  }));
}

function computeCorrections(original: GroupSuggestion[], current: GroupSuggestion[]): CorrectionEntry['corrections'] {
  const originalMap = new Map<number, string>();
  for (const g of original) {
    for (const t of g.tabs) originalMap.set(t.id, g.name);
  }

  const corrections: CorrectionEntry['corrections'] = [];
  for (const g of current) {
    for (const t of g.tabs) {
      const origGroup = originalMap.get(t.id);
      if (origGroup && origGroup !== g.name) {
        try {
          const domain = new URL(t.url).hostname;
          corrections.push({ domain, originalGroup: origGroup, correctedGroup: g.name });
        } catch { /* skip */ }
      }
    }
  }

  return corrections;
}

/**
 * Shown when nothing is queued: explains the action instead of leaving a void.
 *
 * Skipped while a fold is in flight. "Nothing folded yet" directly contradicts a
 * progress bar reporting progress, and the panel looks broken rather than busy.
 */
function renderEmptyState() {
  if (progressActive) return;
  container.innerHTML = `
    <div class="empty">
      <div class="empty-title">Nothing folded yet</div>
      <div class="empty-body">Fold groups your open tabs by topic, on this Mac. Review every group before applying.</div>
    </div>`;
}

function renderSuggestions(suggestions: GroupSuggestion[]) {
  currentSuggestions = suggestions;
  originalSuggestions = deepCloneSuggestions(suggestions);
  container.innerHTML = '';
  tabSearchResults.innerHTML = '';

  if (!suggestions.length) {
    btnApply.hidden = true;
    renderEmptyState();
    return;
  }

  for (let i = 0; i < suggestions.length; i++) {
    const g = suggestions[i];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <input class="group-name" value="${esc(g.name)}" data-i="${i}" />
        <div class="card-tools">
          <button class="swatch" data-i="${i}" style="background: var(--group-${g.color})"
            title="Change colour (currently ${g.color})" aria-label="Change colour, currently ${g.color}"></button>
          <button class="icon-btn pin-group" data-i="${i}" title="Pin so this group survives re-folding"
            aria-label="Pin this group">&#9679;</button>
          <button class="icon-btn remove-group" data-i="${i}" title="Discard this group"
            aria-label="Discard this group">&times;</button>
        </div>
      </div>
      <ul class="card-list">
        ${g.tabs.map(t => `<li title="${esc(t.url)}">${esc(t.title || t.url)}</li>`).join('')}
      </ul>`;
    // The leading edge carries the group colour, same as the browser's own
    // tab-group indicator, so the two read as the same thing.
    card.style.borderLeftColor = `var(--group-${g.color})`;
    container.appendChild(card);
  }

  container.querySelectorAll<HTMLInputElement>('.group-name').forEach(el =>
    el.addEventListener('input', () => {
      currentSuggestions[Number(el.dataset.i)].name = el.value;
    }),
  );

  // Nine colours fit in one row, so cycling beats a dropdown: one click
  // instead of two, and no menu to dismiss afterwards.
  container.querySelectorAll<HTMLButtonElement>('.swatch').forEach(el =>
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.i);
      const next = COLORS[(COLORS.indexOf(currentSuggestions[idx].color) + 1) % COLORS.length];
      currentSuggestions[idx].color = next as Color;
      renderSuggestions(currentSuggestions);
    }),
  );

  container.querySelectorAll<HTMLButtonElement>('.pin-group').forEach(el =>
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.i);
      const groupName = currentSuggestions[idx]?.name;
      if (!groupName) return;
      const settings = await getSettings();
      const pinned = new Set(settings.pinnedGroups);
      if (pinned.has(groupName)) {
        pinned.delete(groupName);
        setStatus(`Unpinned "${groupName}"`);
      } else {
        pinned.add(groupName);
        setStatus(`Pinned "${groupName}" — survives re-org`);
      }
      await saveSettings({ ...settings, pinnedGroups: [...pinned] });
    }),
  );

  container.querySelectorAll<HTMLButtonElement>('.remove-group').forEach(el =>
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.i);
      const removed = currentSuggestions[idx];

      if (removed) {
        const rejections: RejectionEntry[] = [];
        const now = Date.now();
        for (const tab of removed.tabs) {
          try {
            const domain = new URL(tab.url).hostname;
            rejections.push({ timestamp: now, domain, rejectedGroup: removed.name });
          } catch { /* skip */ }
        }
        if (rejections.length > 0) {
          sendMsg({ type: 'record-rejections', rejections });
        }
      }

      currentSuggestions.splice(idx, 1);
      renderSuggestions(currentSuggestions);
    }),
  );

  btnApply.hidden = false;
}

// --- Tab search ---

function renderTabSearchResults(results: Array<{ id: number; title: string; url: string; groupName: string; groupId: number }>) {
  tabSearchResults.innerHTML = '';
  if (!results.length) {
    tabSearchResults.innerHTML = '<div class="hit-none">No tabs found</div>';
    return;
  }
  for (const tab of results.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'hit';
    row.innerHTML = `
      <div class="hit-main">
        <span class="hit-title">${esc(tab.title || tab.url)}</span>
        ${tab.groupName ? `<span class="hit-group">${esc(tab.groupName)}</span>` : ''}
      </div>
      <button class="fold-btn fold-btn--plain" data-id="${tab.id}">Switch</button>`;
    tabSearchResults.appendChild(row);
  }
  tabSearchResults.querySelectorAll<HTMLButtonElement>('.fold-btn fold-btn--plain').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = Number(btn.dataset.id);
      await chrome.tabs.update(tabId, { active: true });
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    });
  });
}

let searchTabsTimer: ReturnType<typeof setTimeout> | null = null;

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();

  if (currentSuggestions.length > 0) {
    tabSearchResults.innerHTML = '';
    container.querySelectorAll('.card-list li').forEach(li => {
      const match = !q || (li.textContent ?? '').toLowerCase().includes(q) || (li.getAttribute('title') ?? '').toLowerCase().includes(q);
      (li as HTMLElement).style.display = match ? '' : 'none';
      li.className = q && match ? 'search-match' : '';
    });
    container.querySelectorAll<HTMLDivElement>('.card').forEach(card => {
      const hasVisible = card.querySelector('.card-list li:not([style*="display: none"])');
      card.style.opacity = !q || hasVisible ? '1' : '0.4';
    });
  } else {
    if (searchTabsTimer) clearTimeout(searchTabsTimer);
    tabSearchResults.innerHTML = '';
    if (!q) return;
    searchTabsTimer = setTimeout(async () => {
      const res = await sendMsg({ type: 'search-tabs', query: q });
      if (res?.tabResults) renderTabSearchResults(res.tabResults);
    }, 200);
  }
});

// --- Keyboard navigation ---

let focusedCardIdx = -1;

function getCards(): HTMLDivElement[] {
  return Array.from(container.querySelectorAll<HTMLDivElement>('.card'));
}

function setFocusedCard(idx: number) {
  const cards = getCards();
  cards.forEach((c, i) => c.dataset.focus = i === idx ? '' : undefined);
  focusedCardIdx = idx;
  if (idx >= 0 && idx < cards.length) {
    cards[idx].scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', e => {
  const inInput = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;

  if (e.key === 'Escape') {
    searchInput.value = '';
    tabSearchResults.innerHTML = '';
    container.querySelectorAll<HTMLElement>('.card-list li').forEach(li => { li.style.display = ''; li.className = ''; });
    container.querySelectorAll<HTMLDivElement>('.card').forEach(c => { c.style.opacity = '1'; });
    setFocusedCard(-1);
    (document.activeElement as HTMLElement)?.blur?.();
    return;
  }

  if (inInput) return;

  const cards = getCards();
  if (e.key === 'ArrowDown' && cards.length) {
    e.preventDefault();
    setFocusedCard(Math.min(focusedCardIdx + 1, cards.length - 1));
  } else if (e.key === 'ArrowUp' && cards.length) {
    e.preventDefault();
    setFocusedCard(Math.max(0, focusedCardIdx - 1));
  } else if (e.key === 'Enter' && currentSuggestions.length > 0 && !btnApply.hidden) {
    e.preventDefault();
    btnApply.click();
  }
});

// --- Core actions ---

async function doOrganize(ungroupedOnly: boolean) {
  setStatus('Reading tabs…', 'busy');
  btnOrganize.disabled = true;
  btnOrganizeUngrouped.disabled = true;
  container.innerHTML = '';
  btnApply.hidden = true;

  const res = await sendMsg({ type: ungroupedOnly ? 'organize-ungrouped' : 'organize' });

  btnOrganize.disabled = false;
  btnOrganizeUngrouped.disabled = false;
  // A stale tick could otherwise land after the result and overwrite it.
  stopProgress();

  if (!res) {
    setStatus('No response from the worker — try again', 'stop');
  } else if (res.error) {
    setStatus(res.error, 'stop');
  } else if (res.suggestions) {
    setStatus(`${res.suggestions.length} groups suggested`, 'ok');
    renderSuggestions(res.suggestions);
  } else {
    setStatus('No suggestions returned', 'stop');
  }
}

btnOrganize.addEventListener('click', () => doOrganize(false));
btnOrganizeUngrouped.addEventListener('click', () => doOrganize(true));

btnApply.addEventListener('click', async () => {
  if (!currentSuggestions.length) return;
  setStatus('Applying groups…', 'busy');
  btnApply.disabled = true;

  const corrections = computeCorrections(originalSuggestions, currentSuggestions);
  if (corrections.length > 0) {
    sendMsg({ type: 'record-corrections', corrections: { timestamp: Date.now(), corrections } });
  }

  await sendMsg({ type: 'apply', suggestions: currentSuggestions });
  setStatus('Groups applied', 'ok');
  btnApply.disabled = false;
  clearSuggestionUi();
  await refreshFooter();
});

btnUndo.addEventListener('click', async () => {
  setStatus('Undoing…', 'busy');
  const res = await sendMsg({ type: 'undo' });
  setStatus(res?.error ? res.error : 'Last folding undone', res?.error ? 'stop' : 'ok');
});

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Footer ---

async function refreshFooter() {
  const statsRes = await sendMsg({ type: 'get-stats' });
  const stats = statsRes?.stats;

  statsText.textContent = stats?.totalOrganizations
    ? `${stats.totalOrganizations} folds · ${stats.totalTabsGrouped} tabs`
    : '';
}

// --- Model status pill ---

const modelStatus = $<HTMLSpanElement>('model-status');

/**
 * The pill reports whether grouping can actually run. Worth checking here rather
 * than letting the first fold fail with a raw host error.
 */
async function refreshModelStatus() {
  modelStatus.dataset.state = 'working';
  modelStatus.textContent = 'Checking…';
  const res = await checkAppleAI();
  modelStatus.dataset.state = res.available ? 'ready' : 'stopped';
  modelStatus.textContent = res.available ? 'On-device' : 'Unavailable';
  modelStatus.title = res.available
    ? 'Grouping runs on this Mac through Foundation Models'
    : (res.reason ?? 'Apple AI is unavailable');
}

// --- Init ---

(async () => {
  // Theme first: it only sets CSS variables, so the panel never paints in the
  // wrong colors. Neither it nor the status probe should block first paint.
  void applyTheme();
  watchAppearance();
  void refreshModelStatus();

  const pending = await getSuggestions();
  if (pending?.length) {
    setStatus(`${pending.length} groups waiting for review`, 'ok');
    renderSuggestions(pending);
  } else {
    renderEmptyState();
  }
  await refreshFooter();
})();
