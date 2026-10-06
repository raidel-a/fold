import type { Settings, DomainRule, Color, MessageType } from './types';
import { DEFAULT_SETTINGS, COLORS } from './types';
import { getSettings, saveSettings, getDomainRules, saveDomainRules } from './storage';
import { applyTheme, watchAppearance } from './theme';
import { fetchTheme } from './llm';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- Sidebar navigation ---
// The settings page is one long document split into panes; the sidebar selects
// which is visible, so scrolling restarts at the top of the new pane instead of
// landing mid-section.
const PANE_COPY: Record<string, { title: string; blurb: string }> = {
  model: { title: 'Model', blurb: 'How Fold groups tabs, and what it needs to run.' },
  folding: { title: 'Folding', blurb: 'The shape of a fold, and how eager Fold should be about making one.' },
  learning: { title: 'Learning', blurb: 'What Fold remembers from the corrections you make.' },
  rules: { title: 'Rules', blurb: 'Decisions you make once and want applied every time.' },
  tools: { title: 'Tools', blurb: 'One-off jobs on the tabs you have open right now.' },
};

const LAST_PANE_KEY = 'fold.lastPane';

function showPane(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach(btn => {
    const active = btn.dataset.nav === name;
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll<HTMLElement>('.pane').forEach(pane => {
    pane.classList.toggle('active', pane.dataset.pane === name);
  });

  const copy = PANE_COPY[name];
  if (copy) {
    $('pane-title').textContent = copy.title;
    $('pane-blurb').textContent = copy.blurb;
  }
  try { localStorage.setItem(LAST_PANE_KEY, name); } catch { /* ignore */ }
  window.scrollTo({ top: 0 });
}

document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showPane(btn.dataset.nav!));
});

// A hash in the URL wins over the remembered pane, so a link can deep-link.
const fromHash = location.hash.replace('#', '');
let initialPane = fromHash && PANE_COPY[fromHash] ? fromHash : '';
if (!initialPane) {
  try { initialPane = localStorage.getItem(LAST_PANE_KEY) ?? ''; } catch { /* ignore */ }
}
showPane(initialPane && PANE_COPY[initialPane] ? initialPane : 'model');

const modelStatusCard = $<HTMLDivElement>('model-status-card');
const modelStatusText = $<HTMLSpanElement>('model-status-text');
const modelTitle = $<HTMLDivElement>('model-title');
const modelDetail = $<HTMLDivElement>('model-detail');
const sidebarStatus = $<HTMLSpanElement>('model-status');
const modelSetup = $<HTMLDivElement>('model-setup');
const modelSetupReason = $<HTMLDivElement>('model-setup-reason');
const accentSourceDesc = $<HTMLDivElement>('accent-source-desc');
const accentSourceDot = $<HTMLSpanElement>('accent-source-dot');

/**
 * Explains where the accent came from. The host reports whether macOS gave the
 * user's chosen colour or the system default, which is worth surfacing: a user
 * who picked an accent expects to see it, and "this is just the system colour"
 * is otherwise indistinguishable from a working accent.
 */
async function renderAccentSource(): Promise<void> {
  const theme = await fetchTheme();
  const isFallback = theme.accentIsFallback === true;

  accentSourceDesc.textContent = isFallback
    ? 'The system default accent. macOS has no accent of your own selected.'
    : 'Your macOS accent colour.';
  accentSourceDot.setAttribute(
    'aria-label',
    isFallback ? 'System default accent' : 'Your macOS accent colour',
  );
}

const testBtn = $<HTMLButtonElement>('test-btn');
const testResult = $<HTMLSpanElement>('test-result');
const inMaxGroups = $<HTMLInputElement>('maxGroups');
const outMaxGroups = $<HTMLSpanElement>('maxGroupsVal');
const inMaxTitleLength = $<HTMLInputElement>('maxTitleLength');
const outMaxTitleLength = $<HTMLSpanElement>('maxTitleVal');
const inAutoTrigger = $<HTMLInputElement>('autoTrigger');
const inThreshold = $<HTMLInputElement>('threshold');
const outThreshold = $<HTMLSpanElement>('thresholdVal');
const inMergeMode = $<HTMLInputElement>('mergeMode');
const inSilentAutoAdd = $<HTMLInputElement>('silentAutoAdd');
const inAutoPinApps = $<HTMLInputElement>('autoPinApps');
const inSmartUngroup = $<HTMLInputElement>('smartUngroup');
const inStaleTabThresholdHours = $<HTMLInputElement>('staleTabThresholdHours');
const outStale = $<HTMLSpanElement>('staleVal');
const inEnableStalePurge = $<HTMLInputElement>('enableStalePurge');
const btnPurgeStaleNow = $<HTMLButtonElement>('purge-stale-now');
const purgeStaleStatus = $<HTMLDivElement>('purge-stale-status');
const inEnableCorrectionTracking = $<HTMLInputElement>('enableCorrectionTracking');
const inEnableRejectionMemory = $<HTMLInputElement>('enableRejectionMemory');
const inEnableGroupDrift = $<HTMLInputElement>('enableGroupDrift');
const inEnablePatternMining = $<HTMLInputElement>('enablePatternMining');
const inGroupDriftThreshold = $<HTMLInputElement>('groupDriftThreshold');
const outDriftThreshold = $<HTMLSpanElement>('driftThresholdVal');
const inReorgSchedule = $<HTMLSelectElement>('reorgSchedule');
const inReorgTime = $<HTMLInputElement>('reorgTime');
const outReorgTime = $<HTMLSpanElement>('reorgTimeVal');
const pinnedContainer = $<HTMLDivElement>('pinned-groups');
const inNewPinnedGroup = $<HTMLInputElement>('new-pinned-group');
const btnAddPinned = $<HTMLButtonElement>('add-pinned');
const rulesContainer = $<HTMLDivElement>('domain-rules');
const btnAddRule = $<HTMLButtonElement>('add-rule');
const btnExportRulesCSV = $<HTMLButtonElement>('export-rules-csv');
const btnImportRulesCSV = $<HTMLButtonElement>('import-rules-csv');
const importRulesFile = $<HTMLInputElement>('import-rules-file');
const btnExport = $<HTMLButtonElement>('export-data');
const btnImport = $<HTMLButtonElement>('import-data');
const importFile = $<HTMLInputElement>('import-file');
const statsLine = $<HTMLDivElement>('stats-line');
const usageLine = $<HTMLDivElement>('usage-line');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The worker's reply shape, taken from the message union. */
type StatusReply = Omit<Extract<MessageType, { type: 'status' }>, 'type'>;

function sendMsg(msg: MessageType): Promise<StatusReply | undefined> {
  return new Promise(resolve =>
    chrome.runtime.sendMessage(msg, resolve as (reply: StatusReply) => void));
}

// --- Model status ---

/**
 * Apple AI is the only model, so what used to be a provider picker is a status
 * card: a dot for state, a sentence explaining it, and the install steps when
 * something is wrong.
 */
type ModelState = 'checking' | 'ready' | 'unavailable';

const modelState: { state: ModelState; reason?: string } = { state: 'checking' };

async function probeModel(): Promise<void> {
  modelState.state = 'checking';
  renderModelStatus();

  const res = await sendMsg({ type: 'check-apple-ai' });
  const available = res?.available === true;
  const reason = typeof res?.reason === 'string' ? res.reason : undefined;

  modelState.state = available ? 'ready' : 'unavailable';
  modelState.reason = available ? undefined : reason;
  renderModelStatus();
}

function renderModelStatus() {
  const { state, reason } = modelState;
  const dotState = state === 'checking' ? 'working' : state === 'ready' ? 'ready' : 'stopped';

  const copy = {
    checking: ['Checking…', 'Checking Apple AI…', 'Asking the native host whether the model can run.'],
    ready: ['Ready', 'Apple AI is ready', 'Grouping runs on this Mac through Foundation Models. Nothing is sent anywhere.'],
    unavailable: ['Unavailable', 'Apple AI is unavailable', reason ?? 'The native host did not answer.'],
  } as const;

  const [pill, title, detail] = copy[state];

  // The sidebar pill stays terse; the card carries the explanation.
  sidebarStatus.dataset.state = dotState;
  sidebarStatus.textContent = pill;
  sidebarStatus.title = detail;

  modelStatusCard.dataset.state = state;
  modelStatusText.dataset.state = dotState;
  modelStatusText.setAttribute('aria-label', title);
  modelTitle.textContent = title;
  modelDetail.textContent = detail;

  // The host explains why it is unavailable; show its wording verbatim.
  modelSetupReason.textContent = state === 'unavailable' ? (reason ?? '') : '';
  modelSetup.classList.toggle('hidden', state === 'ready');
}

async function testModel() {
  testBtn.disabled = true;
  testResult.textContent = 'Warming up the model…';
  testResult.dataset.tone = 'busy';

  const res = await sendMsg({ type: 'test-model' });
  testBtn.disabled = false;

  if (res?.status === 'error') {
    testResult.textContent = res.error as string;
    testResult.dataset.tone = 'stop';
    // A failed round trip is stronger evidence than a bare availability probe,
    // so trust the failure over the probe's optimistic answer.
    modelState.state = 'unavailable';
    modelState.reason = res.error as string;
    renderModelStatus();
  } else {
    testResult.textContent = `Replied: ${res?.chatResponse ?? 'OK'}`;
    testResult.dataset.tone = 'ok';
    // A successful round trip means the model is genuinely ready.
    modelState.state = 'ready';
    modelState.reason = undefined;
    renderModelStatus();
  }
}

// --- Save ---

async function save() {
  // Preserve pinnedGroups from current settings (managed separately)
  const current = await getSettings();

  const settings: Settings = {
    maxGroups: Number(inMaxGroups.value) || DEFAULT_SETTINGS.maxGroups,
    maxTitleLength: Number(inMaxTitleLength.value) || DEFAULT_SETTINGS.maxTitleLength,
    autoTrigger: inAutoTrigger.checked,
    threshold: Number(inThreshold.value) || DEFAULT_SETTINGS.threshold,
    mergeMode: inMergeMode.checked,
    silentAutoAdd: inSilentAutoAdd.checked,
    autoPinApps: inAutoPinApps.checked,
    staleTabThresholdHours: Number(inStaleTabThresholdHours.value) || DEFAULT_SETTINGS.staleTabThresholdHours,
    enableStalePurge: inEnableStalePurge.checked,
    enableCorrectionTracking: inEnableCorrectionTracking.checked,
    enableRejectionMemory: inEnableRejectionMemory.checked,
    enableGroupDrift: inEnableGroupDrift.checked,
    enablePatternMining: inEnablePatternMining.checked,
    groupDriftThreshold: Number(inGroupDriftThreshold.value) || DEFAULT_SETTINGS.groupDriftThreshold,
    reorgSchedule: inReorgSchedule.value as Settings['reorgSchedule'],
    reorgTime: Number(inReorgTime.value),
    pinnedGroups: current.pinnedGroups || [],
    smartUngroup: inSmartUngroup.checked,
  };
  await saveSettings(settings);
}

let saveDebounceTimer: number | undefined;
function scheduleSave(delayMs = 180) {
  if (saveDebounceTimer !== undefined) window.clearTimeout(saveDebounceTimer);
  saveDebounceTimer = window.setTimeout(() => { void save(); }, delayMs);
}

// --- Load ---

async function load() {
  const s = await getSettings();

  // Behavior
  inMaxGroups.value = String(s.maxGroups);
  outMaxGroups.textContent = String(s.maxGroups);
  
  inMaxTitleLength.value = String(s.maxTitleLength);
  outMaxTitleLength.textContent = String(s.maxTitleLength);
  
  inAutoTrigger.checked = s.autoTrigger;
  
  inThreshold.value = String(s.threshold);
  outThreshold.textContent = String(s.threshold);
  
  inMergeMode.checked = s.mergeMode;
  inSilentAutoAdd.checked = s.silentAutoAdd;
  inAutoPinApps.checked = s.autoPinApps;
  inSmartUngroup.checked = s.smartUngroup;
  
  inStaleTabThresholdHours.value = String(s.staleTabThresholdHours);
  outStale.textContent = String(s.staleTabThresholdHours);
  inEnableStalePurge.checked = s.enableStalePurge;

  // Smart learning
  inEnableCorrectionTracking.checked = s.enableCorrectionTracking;
  inEnableRejectionMemory.checked = s.enableRejectionMemory;
  inEnableGroupDrift.checked = s.enableGroupDrift;
  inEnablePatternMining.checked = s.enablePatternMining;
  inGroupDriftThreshold.value = String(s.groupDriftThreshold);
  outDriftThreshold.textContent = String(s.groupDriftThreshold);

  // Scheduled re-org
  inReorgSchedule.value = s.reorgSchedule;
  inReorgTime.value = String(s.reorgTime);
  outReorgTime.textContent = String(s.reorgTime);

  // Pinned groups
  renderPinnedGroups(s.pinnedGroups || []);

  // Domain rules
  await renderDomainRules();

  // Group health
  await renderGroupStats();

  // Stats & usage
  await refreshData();

  // Model status, last so the panel paints without waiting on the probe.
  await probeModel();
}

// --- Test model ---

testBtn.addEventListener('click', async () => {
  await save();
  await testModel();
});

// --- Domain Rules ---

async function renderDomainRules() {
  const rules = await getDomainRules();
  rulesContainer.innerHTML = '';

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const row = document.createElement('div');
    row.className = 'rule';
    // A colour swatch rather than a named dropdown: the nine options are all
    // visible at once in the popup, and matching that here keeps one mental model.
    // Each element carries a single class attribute: a duplicate is silently
    // dropped by the HTML parser, which would break the save handler's lookups.
    row.innerHTML = `
      <input class="fold-field rule-domain" type="text" value="${esc(r.domain)}"
        placeholder="domain.com or *.example.com" data-i="${i}" aria-label="Domain" />
      <input class="fold-field rule-group" type="text" value="${esc(r.groupName)}"
        placeholder="Group name" data-i="${i}" aria-label="Group name" />
      <button class="swatch rule-color-swatch" data-i="${i}" data-color="${r.color}"
        style="background: var(--group-${r.color})" title="${r.color}"
        aria-label="Colour: ${r.color}"></button>
      <div class="rule-actions">
        <button class="rule-icon rule-icon--danger rule-delete" data-i="${i}" title="Remove rule"
          aria-label="Remove rule">&times;</button>
      </div>`;
    rulesContainer.appendChild(row);
  }

  // Bind handlers
  const saveRules = async () => {
    const updated: DomainRule[] = [];
    rulesContainer.querySelectorAll('.rule').forEach((row) => {
      const domain = (row.querySelector('.rule-domain') as HTMLInputElement).value.trim().toLowerCase();
      const groupName = (row.querySelector('.rule-group') as HTMLInputElement).value.trim();
      const color = ((row.querySelector('.rule-color-swatch') as HTMLElement).dataset.color ?? 'grey') as Color;
      if (domain && groupName) updated.push({ domain, groupName, color });
    });
    await saveDomainRules(updated);
  };

  rulesContainer.querySelectorAll('.fold-field').forEach(el =>
    el.addEventListener('change', saveRules));

  // Cycle the swatch through the palette, same gesture as the popup cards.
  rulesContainer.querySelectorAll<HTMLButtonElement>('.rule-color-swatch').forEach(el =>
    el.addEventListener('click', async () => {
      const rules = await getDomainRules();
      const idx = Number(el.dataset.i);
      const current = (el.dataset.color ?? 'grey') as Color;
      const next = COLORS[(COLORS.indexOf(current) + 1) % COLORS.length];
      el.dataset.color = next;
      el.style.background = `var(--group-${next})`;
      el.title = next;
      el.setAttribute('aria-label', `Colour: ${next}`);
      rules[idx].color = next;
      await saveDomainRules(rules);
    }));
  rulesContainer.querySelectorAll('.rule-delete').forEach(el =>
    el.addEventListener('click', async () => {
      const rules = await getDomainRules();
      rules.splice(Number((el as HTMLElement).dataset.i), 1);
      await saveDomainRules(rules);
      renderDomainRules();
    }));
}

btnAddRule.addEventListener('click', async () => {
  const rules = await getDomainRules();
  rules.push({ domain: '', groupName: '', color: 'grey' });
  await saveDomainRules(rules);
  renderDomainRules();
});

btnExportRulesCSV.addEventListener('click', async () => {
  const rules = await getDomainRules();
  const lines = ['domain,groupName,color', ...rules.map(r =>
    [r.domain, r.groupName, r.color].map(v => `"${v.replace(/"/g, '""')}"`).join(',')
  )];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fold-domain-rules.csv';
  a.click();
});

btnImportRulesCSV.addEventListener('click', () => importRulesFile.click());

importRulesFile.addEventListener('change', async () => {
  const file = importRulesFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const imported: DomainRule[] = [];
    for (const line of lines) {
      if (line.toLowerCase().startsWith('domain,')) continue;
      // Parse simple CSV: handle quoted fields
      const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      const [domain, groupName, color] = parts;
      const normalizedDomain = domain?.trim().toLowerCase();
      const normalizedGroup = groupName?.trim();
      if (normalizedDomain && normalizedGroup && COLORS.includes(color as Color)) {
        imported.push({ domain: normalizedDomain, groupName: normalizedGroup, color: color as Color });
      }
    }
    if (imported.length === 0) { alert('No valid rules found in CSV'); return; }
    const existing = await getDomainRules();
    // Merge: overwrite existing entries for the same domain, append new ones
    const merged = new Map(existing.map(r => [r.domain, r]));
    for (const r of imported) merged.set(r.domain, r);
    await saveDomainRules([...merged.values()]);
    await renderDomainRules();
    alert(`Imported ${imported.length} rule(s)`);
  } catch { alert('Failed to parse CSV'); }
  importRulesFile.value = '';
});

// --- Data ---

async function refreshData() {
  const [statsRes, usageRes] = await Promise.all([
    sendMsg({ type: 'get-stats' }),
    sendMsg({ type: 'get-usage' }),
  ]);

  if (statsRes?.stats) {
    const s = statsRes.stats;
    const last = s.lastOrganizedAt ? new Date(s.lastOrganizedAt).toLocaleDateString() : 'never';
    statsLine.innerHTML = `<strong>${s.totalOrganizations}</strong> organizes &middot; <strong>${s.totalTabsGrouped}</strong> tabs grouped &middot; Last: ${last}`;
  }

  if (usageRes?.usage) {
    const u = usageRes.usage;
    const total = u.totalInputTokens + u.totalOutputTokens;
    if (total > 0) {
      usageLine.textContent =
        `${u.totalInputTokens.toLocaleString()} in · ${u.totalOutputTokens.toLocaleString()} out · `
        + `${u.organizations.toLocaleString()} runs · free on-device`;
    } else {
      usageLine.textContent = 'No model runs yet.';
    }
  }
}

// Export
btnExport.addEventListener('click', async () => {
  const res = await sendMsg({ type: 'export-data' });
  if (res?.data) {
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fold-export.json';
    a.click();
  }
});

// Import
btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await sendMsg({ type: 'import-data', data });
    if (res?.status !== 'imported') throw new Error(res?.error || 'Import failed');
    await load();
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Invalid import file');
  }
  importFile.value = '';
});

// Purge stale tabs on demand. Saving first matters: the worker reads the
// threshold from settings, and a user who just moved the slider should not have
// to wait for the debounced save before their click takes effect.
btnPurgeStaleNow.addEventListener('click', async () => {
  btnPurgeStaleNow.disabled = true;
  purgeStaleStatus.textContent = 'Looking for stale tabs…';
  purgeStaleStatus.dataset.tone = 'busy';

  await save();
  const res = await sendMsg({ type: 'purge-stale' });
  btnPurgeStaleNow.disabled = false;

  if (res?.error) {
    purgeStaleStatus.textContent = res.error;
    purgeStaleStatus.dataset.tone = 'stop';
    return;
  }
  const count = res?.count ?? 0;
  purgeStaleStatus.textContent = count === 0
    ? 'Nothing stale to close.'
    : `Closed ${count} tab${count === 1 ? '' : 's'}.`;
  purgeStaleStatus.dataset.tone = 'ok';
});

// --- Pinned Groups ---

/** Pinned groups are short names, so they read as chips rather than form rows. */
function renderPinnedGroups(pinnedGroups: string[]) {
  pinnedContainer.innerHTML = '';
  if (!pinnedGroups.length) {
    const empty = document.createElement('span');
    empty.style.cssText = 'font-size:12px;color:var(--label-tertiary)';
    empty.textContent = 'Nothing pinned yet.';
    pinnedContainer.appendChild(empty);
    return;
  }

  for (let i = 0; i < pinnedGroups.length; i++) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(pinnedGroups[i])}<button data-i="${i}" title="Unpin ${esc(pinnedGroups[i])}"
      aria-label="Unpin ${esc(pinnedGroups[i])}">&times;</button>`;
    pinnedContainer.appendChild(chip);
  }

  pinnedContainer.querySelectorAll('button').forEach(el =>
    el.addEventListener('click', async () => {
      const s = await getSettings();
      const groups = [...(s.pinnedGroups || [])];
      groups.splice(Number((el as HTMLElement).dataset.i), 1);
      await saveSettings({ ...s, pinnedGroups: groups });
      renderPinnedGroups(groups);
    }),
  );
}

btnAddPinned.addEventListener('click', async () => {
  const name = inNewPinnedGroup.value.trim();
  if (!name) return;
  const s = await getSettings();
  const groups = [...(s.pinnedGroups || [])];
  if (!groups.includes(name)) groups.push(name);
  await saveSettings({ ...s, pinnedGroups: groups });
  renderPinnedGroups(groups);
  inNewPinnedGroup.value = '';
});

// --- Auto-save on changes ---
const rangeBindings = [
  { input: inMaxGroups, out: outMaxGroups },
  { input: inMaxTitleLength, out: outMaxTitleLength },
  { input: inThreshold, out: outThreshold },
  { input: inStaleTabThresholdHours, out: outStale },
  { input: inGroupDriftThreshold, out: outDriftThreshold },
  { input: inReorgTime, out: outReorgTime },
];
for (const b of rangeBindings) {
  b.input.addEventListener('input', () => { b.out.textContent = b.input.value; });
}

const autoSaveElements = [
  inMaxGroups, inMaxTitleLength, inAutoTrigger, inThreshold,
  inMergeMode, inSilentAutoAdd, inAutoPinApps, inSmartUngroup, inStaleTabThresholdHours,
  inEnableStalePurge,
  inEnableCorrectionTracking, inEnableRejectionMemory, inEnableGroupDrift,
  inEnablePatternMining, inGroupDriftThreshold,
  inReorgSchedule, inReorgTime,
];
for (const el of autoSaveElements) {
  el.addEventListener('change', () => { void save(); });
  // Sliders fire `input` on every drag step, so save as they move; checkboxes
  // and selects already fire `change` the moment they are touched.
  if (el instanceof HTMLInputElement && el.type === 'range') {
    el.addEventListener('input', () => scheduleSave());
  }
}

// --- Group health ---
//
// Drift detection and the per-group table answer different questions, so they
// stay separate: the sweep says which groups have stopped making sense, the
// table says what each group currently holds.

const btnDriftNow = $<HTMLButtonElement>('check-drift-now');
const driftStatus = $<HTMLDivElement>('drift-status');
const groupStatsEl = $<HTMLDListElement>('group-stats');

/** Shape of one row from the `get-group-stats` reply. */
interface GroupStatRow {
  name: string;
  color: Color;
  tabCount: number;
  domains: string[];
}

function renderDriftResult(drifted: boolean, driftedGroups: string[]): void {
  if (driftedGroups.length === 0) {
    driftStatus.textContent = 'Every group still holds together.';
    driftStatus.dataset.tone = 'ok';
    return;
  }
  const list = driftedGroups.join(', ');
  driftStatus.textContent =
    `${driftedGroups.length} group${driftedGroups.length === 1 ? '' : 's'} drifted: ${list}`;
  driftStatus.dataset.tone = drifted ? 'stop' : 'ok';
}

async function renderGroupStats(): Promise<void> {
  const res = await sendMsg({ type: 'get-group-stats' });
  groupStatsEl.innerHTML = '';

  if (res?.error) {
    const line = document.createElement('div');
    line.className = 'stat-line';
    line.textContent = res.error;
    groupStatsEl.appendChild(line);
    return;
  }

  const rows = (res?.groupStats ?? []) as GroupStatRow[];
  if (rows.length === 0) {
    const line = document.createElement('div');
    line.className = 'stat-line';
    line.textContent = 'No groups yet.';
    groupStatsEl.appendChild(line);
    return;
  }

  // Widest first: a group holding the most tabs is the one worth reading about.
  for (const row of [...rows].sort((a, b) => b.tabCount - a.tabCount)) {
    const line = document.createElement('div');
    line.className = 'stat-line';
    const domains = row.domains.length === 0
      ? 'no readable domains'
      : row.domains.slice(0, 4).join(', ') + (row.domains.length > 4 ? ` +${row.domains.length - 4}` : '');
    line.innerHTML = `<dt><span class="group-dot" style="background: var(--group-${row.color})"></span>${esc(row.name)}</dt>`
      + `<dd>${row.tabCount} tab${row.tabCount === 1 ? '' : 's'} · ${esc(domains)}</dd>`;
    groupStatsEl.appendChild(line);
  }
}

btnDriftNow.addEventListener('click', async () => {
  btnDriftNow.disabled = true;
  driftStatus.textContent = 'Checking groups…';
  driftStatus.dataset.tone = 'busy';

  // Save first: the sweep reads groupDriftThreshold out of settings, and a
  // threshold moved moments ago should apply to this click.
  await save();
  const res = await sendMsg({ type: 'check-group-drift' });
  btnDriftNow.disabled = false;

  if (res?.error) {
    driftStatus.textContent = res.error;
    driftStatus.dataset.tone = 'stop';
    return;
  }
  renderDriftResult(res?.drifted === true, res?.driftedGroups ?? []);
  await renderGroupStats();
});


// --- Power Tools ---

const toolStatus = $<HTMLDivElement>('tool-status');
const toolResults = $<HTMLDivElement>('tool-results');

/** The tool log carries a tone rather than an inline colour, keeping the palette in CSS. */
function setToolStatus(msg: string, isError = false) {
  toolStatus.textContent = msg;
  toolStatus.dataset.tone = isError ? 'stop' : msg.endsWith('...') ? 'busy' : 'ok';
}

$<HTMLButtonElement>('tool-duplicates').addEventListener('click', async () => {
  setToolStatus('Scanning for duplicates...');
  toolResults.innerHTML = '';
  const res = await sendMsg({ type: 'find-duplicates' });
  if (!res?.duplicates?.length) {
    setToolStatus('No duplicates found');
    return;
  }
  setToolStatus(`Found ${res.duplicates.length} duplicate group(s)`);
  for (const group of res.duplicates) {
    const div = document.createElement('div');
    div.className = 'tool-result';
    const first = group[0] as { title?: string; url?: string } | undefined;
    div.innerHTML = `<strong>${esc(first?.title || first?.url || 'Unknown')} (${group.length}x)</strong>`
      + group.map((t: { url?: string }) => `<br>${esc(t.url || '')}`).join('');
    toolResults.appendChild(div);
  }
});

$<HTMLButtonElement>('tool-focus').addEventListener('click', async () => {
  setToolStatus('Collapsing other groups...');
  const res = await sendMsg({ type: 'focus-group' });
  setToolStatus(res?.error ? res.error : 'Focus mode activated', Boolean(res?.error));
});

$<HTMLButtonElement>('tool-sort').addEventListener('click', async () => {
  setToolStatus('Sorting tab groups...');
  const res = await sendMsg({ type: 'sort-groups' });
  setToolStatus(res?.error ? res.error : `Sorted ${res?.count ?? 0} groups`, Boolean(res?.error));
});

$<HTMLButtonElement>('tool-clear').addEventListener('click', async () => {
  setToolStatus('Clearing all tab groups...');
  const res = await sendMsg({ type: 'delete-all-groups' });
  setToolStatus(res?.error ? res.error : (res?.count ? `Cleared ${res.count} groups` : 'No groups to clear'), Boolean(res?.error));
});

$<HTMLButtonElement>('tool-export-md').addEventListener('click', async () => {
  setToolStatus('Exporting...');
  const res = await sendMsg({ type: 'export-markdown' });
  if (res?.error) { setToolStatus(res.error, true); return; }
  try {
    await navigator.clipboard.writeText(res?.markdown ?? '');
    setToolStatus('Markdown copied to clipboard!');
  } catch {
    setToolStatus('Clipboard access denied', true);
  }
});

$<HTMLButtonElement>('tool-snooze').addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) { setToolStatus('No active tab to snooze', true); return; }
  const delayMs = Number(($<HTMLSelectElement>('tool-snooze-duration')).value) || 86400000;
  const wakeAt = Date.now() + delayMs;
  setToolStatus('Snoozing...');
  const res = await sendMsg({ type: 'snooze-tabs', tabIds: [activeTab.id], wakeAt });
  if (res?.error) { setToolStatus(res.error, true); return; }
  const sel = $<HTMLSelectElement>('tool-snooze-duration');
  setToolStatus(`Tab snoozed until ${sel.options[sel.selectedIndex]?.text || 'later'}`);
});

// Workspace tools
const toolWsList = $<HTMLDivElement>('tool-workspace-list');

async function refreshToolWorkspaces() {
  const res = await sendMsg({ type: 'list-workspaces' });
  const names: string[] = res?.workspaceNames || [];
  toolWsList.innerHTML = '';
  if (!names.length) return;

  const wsData = await sendMsg({ type: 'export-data' });
  const workspaces = wsData?.data?.workspaces || {};

  for (const name of names) {
    const ws = workspaces[name];
    const tabCount = ws?.tabs?.length ?? '?';
    const row = document.createElement('div');
    row.className = 'rule';
    row.innerHTML = `
      <span class="ws-name" title="${esc(name)}">${esc(name)}</span>
      <span class="ws-count">${tabCount} tabs</span>
      <div class="rule-actions">
        <button class="fold-btn ws-tool-restore" data-name="${esc(name)}">Restore</button>
        <button class="rule-icon rule-icon--danger ws-tool-delete" data-name="${esc(name)}"
          title="Delete ${esc(name)}" aria-label="Delete ${esc(name)}">&times;</button>
      </div>`;
    toolWsList.appendChild(row);
  }

  toolWsList.querySelectorAll<HTMLButtonElement>('.ws-tool-restore').forEach(btn => {
    btn.addEventListener('click', async () => {
      setToolStatus(`Restoring "${btn.dataset.name}"...`);
      const name = btn.dataset.name ?? '';
      const res = await sendMsg({ type: 'restore-workspace', name });
      setToolStatus(res?.error ? res.error : `Restored "${btn.dataset.name}" in new window`, Boolean(res?.error));
    });
  });

  toolWsList.querySelectorAll<HTMLButtonElement>('.ws-tool-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sendMsg({ type: 'delete-workspace', name: btn.dataset.name ?? '' });
      await refreshToolWorkspaces();
    });
  });
}

$<HTMLButtonElement>('tool-workspace-save').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('tool-workspace-name');
  const name = input.value.trim();
  if (!name) { setToolStatus('Enter a workspace name', true); return; }
  setToolStatus('Saving workspace...');
  const res = await sendMsg({ type: 'save-workspace', name });
  if (res?.error) { setToolStatus(res.error, true); return; }
  input.value = '';
  setToolStatus(`Workspace "${name}" saved`);
  await refreshToolWorkspaces();
});

// --- Setup panel ---

document.querySelectorAll<HTMLButtonElement>('.copy-btn[data-copy]').forEach(btn => {
  btn.addEventListener('click', () => {
    void navigator.clipboard.writeText(btn.dataset.copy!);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
});

const recheckBtn = document.getElementById('model-recheck-btn') as HTMLButtonElement | null;
recheckBtn?.addEventListener('click', async () => {
  recheckBtn.disabled = true;
  recheckBtn.textContent = 'Checking…';
  await probeModel();
  recheckBtn.disabled = false;
  recheckBtn.textContent = 'Check again';
});

// --- Init ---
// Theme first so the page never paints in the wrong appearance or accent.
void applyTheme();
watchAppearance();

load();
void renderAccentSource();
refreshToolWorkspaces();
