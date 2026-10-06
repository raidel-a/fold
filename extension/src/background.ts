import type {
  Color,
  GroupSuggestion,
  MessageType,
  TabInfo,
  UndoSnapshot,
  Workspace,
  WorkspaceTab,
  CorrectionEntry,
  FoldProgress,
  RejectionEntry,
  SnoozedTab,
} from './types';
import { SECONDARY_TLDS } from './types';
import {
  recordUsage,
  addCorrections,
  addHistory,
  addRejections,
  exportAll,
  getAffinity,
  getCorrections,
  getUsage,
  getDomainRules,
  getHistory,
  getRejections,
  getSettings,
  getStats,
  getUndoSnapshot,
  getWeightedAffinity,
  importAll,
  incrementStats,
  formatWeightedAffinityHints,
  saveSuggestions,
  saveUndoSnapshot,
  summarizeCorrections,
  summarizeCoOccurrence,
  summarizeHistory,
  summarizeRejections,
  updateAffinity,
  updateCoOccurrence,
  updateWeightedAffinity,
  getGroupColorPrefs,
  saveGroupColorPref,
  getSnoozedTabs,
  saveLastDrift,
  addSnoozedTab,
  removeSnoozedTab,
  getWorkspaces,
  saveWorkspace,
  removeWorkspace,
} from './storage';
import { suggest, findDuplicates, inferTargetGroup, matchTabsToExistingGroups, truncateTitle } from './grouper';
import type { ExtraHints } from './grouper';
import { checkAppleAI, testConnection } from './llm';

const ALARM_NAME = 'fold-check';
const REORG_ALARM_NAME = 'fold-reorg';
const STALE_ALARM_NAME = 'fold-stale';
const DRIFT_ALARM_NAME = 'fold-drift';
const SNOOZE_ALARM_PREFIX = 'fold-snooze-';
const CTX_ADD_TO_GROUP_ID = 'fold-add-to-group';
const ACTION_CONTEXT_MENUS: chrome.contextMenus.CreateProperties[] = [
  { id: 'fold-organize', title: 'Organize all tabs', contexts: ['action'] },
  { id: 'fold-organize-ungrouped', title: 'Organize ungrouped tabs only', contexts: ['action'] },
  { id: 'fold-undo', title: 'Undo last grouping', contexts: ['action'] },
  { id: 'fold-duplicates', title: 'Find duplicate tabs', contexts: ['action'] },
];

// In-memory state (session-only, not persisted)
const openerMap = new Map<number, number>();

const IMPORTANT_APP_PATTERNS = [
  'mail.google.com',
  'calendar.google.com',
  'docs.google.com',
  'drive.google.com',
  'notion.so',
  'notion.site',
  'figma.com',
  'linear.app',
  'atlassian.net',
  'slack.com',
  'discord.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'airtable.com',
  'spotify.com',
] as const;
const MAX_TRACKED_TAB_RELATIONS = 5000;

let autoCheckInFlight = false;
let lastAutoCheckTime = 0;
let contextMenuRebuildQueue: Promise<void> = Promise.resolve();
const AUTO_CHECK_COOLDOWN_MS = 60_000; // 60s minimum between auto-organize
const MAX_CONTEXT_GROUP_ID = 1_000_000_000;

/** Reset cooldown — exported for testing only */
export function _resetAutoCheckCooldown() { lastAutoCheckTime = 0; }

export function isTabUrlAllowed(url?: string | null): url is string {
  if (!url || url.length === 0) return false;
  // Block internal browser URLs and privacy-sensitive schemes
  if (/^(chrome|edge|about|chrome-extension):\/\//.test(url)) return false;
  if (/^(file|data|blob|about):/.test(url)) return false;
  return true;
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isImportantAppUrl(url: string): boolean {
  const hostname = hostnameFromUrl(url);
  return IMPORTANT_APP_PATTERNS.some(pattern =>
    hostname === pattern || hostname.endsWith(`.${pattern}`),
  );
}

export function isGroupedTab(tab: { groupId?: number | undefined }): tab is { groupId: number } {
  return tab.groupId !== undefined && tab.groupId !== -1;
}

async function getExistingTabIds(tabIds: number[]): Promise<number[]> {
  const existing: number[] = [];
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id !== undefined) existing.push(id);
    } catch {
      // stale tab id - skip
    }
  }
  return existing;
}

async function ungroupTabsSafe(tabIds: number[]): Promise<void> {
  const existing = await getExistingTabIds(tabIds);
  if (existing.length > 0) {
    await chrome.tabs.ungroup(existing as [number, ...number[]]);
  }
}

async function groupTabsSafe(tabIds: number[], groupId?: number, windowId?: number): Promise<number | null> {
  const existing = await getExistingTabIds(tabIds);
  if (existing.length === 0) return null;
  if (groupId !== undefined) {
    await chrome.tabs.group({ tabIds: existing as [number, ...number[]], groupId });
    return groupId;
  }
  const createProperties = windowId !== undefined ? { windowId } : undefined;
  return await chrome.tabs.group({ tabIds: existing as [number, ...number[]], createProperties }) as number;
}

function toWorkspaceTab(
  tab: chrome.tabs.Tab,
  groupsById: Map<number, chrome.tabGroups.TabGroup>,
): WorkspaceTab | null {
  if (!tab.title || !isTabUrlAllowed(tab.url)) return null;
  const group = isGroupedTab(tab) ? groupsById.get(tab.groupId) : null;
  return {
    url: tab.url,
    title: tab.title,
    pinned: Boolean(tab.pinned),
    active: Boolean(tab.active),
    groupName: group?.title || undefined,
    groupColor: (group?.color as Color | undefined) || undefined,
  };
}

async function getCurrentWindowId(): Promise<number> {
  let win: chrome.windows.Window | undefined;
  try {
    win = await chrome.windows.getCurrent();
  } catch { /* service worker may not have a current window */ }
  if (win?.id === undefined) {
    try {
      win = await chrome.windows.getLastFocused({ populate: false });
    } catch { /* ignore */ }
  }
  if (win?.id === undefined) throw new Error('Could not determine current window');
  return win.id;
}

export async function saveCurrentWorkspace(name: string): Promise<void> {
  const windowId = await getCurrentWindowId();
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  const groupsById = new Map(groups.map(g => [g.id, g]));
  const wsTabs = tabs
    .map(t => toWorkspaceTab(t, groupsById))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  await saveWorkspace(name, { name, savedAt: Date.now(), tabs: wsTabs });
}

export async function restoreWorkspaceByName(name: string): Promise<void> {
  const workspaces = await getWorkspaces();
  const ws = workspaces[name];
  if (!ws) throw new Error(`Workspace "${name}" not found`);

  const newWin = await chrome.windows.create({ focused: true });
  if (newWin === undefined) throw new Error('Could not create window');
  const windowId = newWin.id;
  if (windowId === undefined) throw new Error('Could not create window');

  const groupTabIds = new Map<string, { tabIds: number[]; color?: Color }>();

  for (const wt of ws.tabs) {
    const tab = await chrome.tabs.create({
      windowId,
      url: wt.url,
      pinned: wt.pinned,
      active: wt.active,
    });
    if (tab.id !== undefined && wt.groupName) {
      if (!groupTabIds.has(wt.groupName)) {
        groupTabIds.set(wt.groupName, { tabIds: [], color: wt.groupColor });
      }
      groupTabIds.get(wt.groupName)!.tabIds.push(tab.id);
    }
  }

  for (const [groupName, { tabIds, color }] of groupTabIds) {
    if (tabIds.length === 0) continue;
    const groupId = await groupTabsSafe(tabIds, undefined, windowId);
    if (groupId === null) continue;
    await chrome.tabGroups.update(groupId, { title: groupName, color: color || 'grey', collapsed: false });
  }

  // Close the initial blank tab Chrome opens with new windows
  try {
    const blankTabs = await chrome.tabs.query({ windowId, url: 'chrome://newtab/' });
    const blankIds = blankTabs.map(t => t.id!).filter(Boolean);
    if (blankIds.length > 0) await chrome.tabs.remove(blankIds);
  } catch { /* best-effort */ }
}

async function recordModelUsage(inputTokens: number, outputTokens: number): Promise<void> {
  if (inputTokens <= 0 && outputTokens <= 0) return;
  await recordUsage(inputTokens, outputTokens);
}

export async function getTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.id !== undefined && isTabUrlAllowed(t.url))
    .map(t => ({ id: t.id!, title: t.title || '', url: t.url! }));
}

export async function snapshotCurrentState(): Promise<UndoSnapshot> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groups: { tabId: number; groupId: number }[] = [];
  const ungrouped: number[] = [];

  for (const t of tabs) {
    if (t.id === undefined) continue;
    if (isGroupedTab(t)) groups.push({ tabId: t.id, groupId: t.groupId });
    else ungrouped.push(t.id);
  }

  return { timestamp: Date.now(), groups, ungrouped };
}

export async function restoreSnapshot(snapshot: UndoSnapshot): Promise<void> {
  if (snapshot.ungrouped.length > 0) {
    try {
      await ungroupTabsSafe(snapshot.ungrouped);
    } catch { /* stale tab IDs during restore — expected */ }
  }

  const byGroup = new Map<number, number[]>();
  for (const { tabId, groupId } of snapshot.groups) {
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId)!.push(tabId);
  }

  for (const [, tabIds] of byGroup) {
    try {
      await groupTabsSafe(tabIds);
    } catch { /* stale tab IDs during restore — expected */ }
  }
}

function consumeLastError(): string | undefined {
  return chrome.runtime.lastError?.message;
}

function removeAllContextMenus(): Promise<void> {
  return new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      consumeLastError();
      resolve();
    });
  });
}

function createContextMenu(props: chrome.contextMenus.CreateProperties): Promise<void> {
  return new Promise(resolve => {
    chrome.contextMenus.create(props, () => {
      const error = consumeLastError();
      if (error && !error.includes('duplicate id')) {
        console.warn('[Fold] Failed to create context menu:', props.id, error);
      }
      resolve();
    });
  });
}

async function rebuildContextMenusNow(): Promise<void> {
  await removeAllContextMenus();

  for (const item of ACTION_CONTEXT_MENUS) {
    await createContextMenu(item);
  }

  await createContextMenu({
    id: CTX_ADD_TO_GROUP_ID,
    title: 'Add tab to group...',
    contexts: ['page'],
  });

  let groups: chrome.tabGroups.TabGroup[] = [];
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win.id !== undefined) {
      groups = await chrome.tabGroups.query({ windowId: win.id });
    }
  } catch { /* no focused window */ }

  for (const group of groups) {
    await createContextMenu({
      id: `${CTX_ADD_TO_GROUP_ID}-${group.id}`,
      parentId: CTX_ADD_TO_GROUP_ID,
      title: group.title || `Group ${group.id}`,
      contexts: ['page'],
    });
  }

  await createContextMenu({
    id: `${CTX_ADD_TO_GROUP_ID}-new`,
    parentId: CTX_ADD_TO_GROUP_ID,
    title: '+ New group',
    contexts: ['page'],
  });
}

function rebuildContextMenus(): Promise<void> {
  const rebuild = contextMenuRebuildQueue.then(rebuildContextMenusNow, rebuildContextMenusNow);
  contextMenuRebuildQueue = rebuild.catch(err => {
    console.warn('[Fold] Failed to rebuild context menus:', err instanceof Error ? err.message : err);
  });
  return rebuild;
}

export async function organize(
  ungroupedOnly = false,
  report?: (progress: FoldProgress) => void,
): Promise<{ suggestions?: GroupSuggestion[]; error?: string }> {
  try {
    // A fold takes seconds, most of it waiting on the model. Reporting each phase
    // turns an unexplained pause into something the popup can show.
    const phase = (label: string, fraction: number | null = null, extra: Partial<FoldProgress> = {}) =>
      report?.({ label, fraction, ...extra });
    const [settings, affinity, domainRules, history, weightedAffinity, corrections, rejections] = await Promise.all([
      getSettings(),
      getAffinity(),
      getDomainRules(),
      getHistory(),
      getWeightedAffinity(),
      getCorrections(),
      getRejections(),
    ]);

    phase('Reading tabs', 0);
    let tabs = await getTabs();
    let existingGroupNames: string[] = [];

    if (ungroupedOnly || settings.mergeMode) {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const groupedIds = new Set(allTabs.filter(isGroupedTab).map(t => t.id).filter((id): id is number => id !== undefined));
      tabs = tabs.filter(t => !groupedIds.has(t.id));

      // Collect existing group names for smart merge
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        existingGroupNames = groups.map(g => g.title || '').filter(Boolean);
      } catch { /* ignore */ }
    }

    if (tabs.length < 2) return { error: 'Need at least 2 tabs to organize' };

    // Build extra hints from learning data
    const extraHints: ExtraHints = {};
    extraHints.affinityHint = formatWeightedAffinityHints(weightedAffinity);

    if (settings.enableCorrectionTracking) {
      extraHints.corrections = await summarizeCorrections(corrections);
    }
    if (settings.enableRejectionMemory) {
      extraHints.rejections = await summarizeRejections(rejections);
    }
    if (settings.enablePatternMining) {
      await updateCoOccurrence(history);
      extraHints.coOccurrence = await summarizeCoOccurrence();
    }

    // Build opener hints
    const openerLines: string[] = [];
    for (const tab of tabs) {
      const openerId = openerMap.get(tab.id);
      if (openerId !== undefined) {
        const openerTab = tabs.find(t => t.id === openerId);
        if (openerTab) {
          openerLines.push(`  Tab ${tab.id} was opened from Tab ${openerId} (likely related)`);
        }
      }
    }
    if (openerLines.length > 0) {
      if (openerLines.length > 15) openerLines.length = 15;
      extraHints.openers = `\nTab relationships (opened from same parent):\n${openerLines.join('\n')}\n`;
    }

    // Smart merge: pre-assign tabs matching existing group names by title
    let preMatched: GroupSuggestion[] = [];
    let tabsForLLM = tabs;
    if (existingGroupNames.length > 0) {
      const { matched, remaining } = matchTabsToExistingGroups(tabs, existingGroupNames);
      const colorPrefs = await getGroupColorPrefs();
      preMatched = Array.from(matched.entries()).map(([name, matchedTabs]) => ({
        name,
        color: (colorPrefs[name] ?? 'grey') as const,
        tabs: matchedTabs,
      }));
      tabsForLLM = remaining;
    }

    if (tabsForLLM.length === 0 && preMatched.length > 0) {
      const suggestions = preMatched;
      await saveSuggestions(suggestions);
      await chrome.action.setBadgeText({ text: String(suggestions.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });
      return { suggestions };
    }

    const historyHint = summarizeHistory(history);
    const result = tabsForLLM.length >= 2
      ? await suggest(
          tabsForLLM, settings, affinity, domainRules, historyHint, extraHints,
          (done, total) => phase(
            total > 0 ? `Grouping ${done} of ${total}` : 'Grouping',
            total > 0 ? done / total : null,
            { done, total },
          ),
        )
      // Keep a single leftover tab ungrouped instead of forcing an "Other" group.
      : { suggestions: [] as GroupSuggestion[], inputTokens: 0, outputTokens: 0 };

    phase('Finishing', 1);

    const allSuggestions = [...preMatched, ...result.suggestions];

    await recordModelUsage(result.inputTokens, result.outputTokens);
    await saveSuggestions(allSuggestions);
    await chrome.action.setBadgeText({ text: String(allSuggestions.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });

    return { suggestions: allSuggestions };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export async function applyGroups(suggestions: GroupSuggestion[]): Promise<void> {
  const snapshot = await snapshotCurrentState();
  await saveUndoSnapshot(snapshot);

  const settings = await getSettings();
  const pinnedSet = new Set(settings.pinnedGroups);

  // If pinned groups exist, exclude their tabs from ungrouping
  let pinnedTabIds = new Set<number>();
  if (pinnedSet.size > 0) {
    try {
      const windowId = await getCurrentWindowId();
      const existingGroups = await chrome.tabGroups.query({ windowId });
      for (const g of existingGroups) {
        if (g.title && pinnedSet.has(g.title)) {
          const groupTabs = await chrome.tabs.query({ groupId: g.id });
          for (const t of groupTabs) {
            if (t.id !== undefined) pinnedTabIds.add(t.id);
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Filter out suggestions targeting pinned groups and tabs in pinned groups
  const filteredSuggestions = suggestions.filter(g => !pinnedSet.has(g.name));
  const allTabIds = filteredSuggestions
    .flatMap(g => g.tabs.map(t => t.id))
    .filter(id => !pinnedTabIds.has(id));

  try {
    if (allTabIds.length > 0) {
      await ungroupTabsSafe(allTabIds);
    }
  } catch { /* stale tab IDs during apply — expected */ }

  const colorPrefs = await getGroupColorPrefs();

  for (const group of filteredSuggestions) {
    const tabIds = group.tabs.map(t => t.id).filter(id => !pinnedTabIds.has(id));
    if (tabIds.length === 0) continue;
    const groupId = await groupTabsSafe(tabIds);
    if (groupId === null) continue;
    const color = (group.name && colorPrefs[group.name]) || group.color;
    await chrome.tabGroups.update(groupId, { title: group.name, color, collapsed: false });
  }

  await updateAffinity(filteredSuggestions);
  await addHistory(filteredSuggestions);
  await incrementStats(filteredSuggestions.reduce((sum, g) => sum + g.tabs.length, 0));
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });
}

export async function undoLastGrouping(): Promise<{ error?: string }> {
  const snapshot = await getUndoSnapshot();
  if (!snapshot) return { error: 'No undo history available' };

  try {
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    const groupedIds = currentTabs.filter(isGroupedTab).map(t => t.id).filter((id): id is number => id !== undefined);
    if (groupedIds.length) {
      try {
        await ungroupTabsSafe(groupedIds);
      } catch {
        // ignored
      }
    }

    await restoreSnapshot(snapshot);
    await saveUndoSnapshot(null);


    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Undo failed' };
  }
}

export async function findDuplicateTabs(): Promise<TabInfo[][]> {
  return findDuplicates(await getTabs());
}

/**
 * Closes tabs that have gone untouched for longer than the configured threshold.
 *
 * Driven by a daily alarm, so this cannot use `currentWindow`: a service worker
 * woken by an alarm has no current window, and the query would fail. Enumerating
 * windows is also the right scope for an unattended sweep.
 *
 * Deliberately not gated on `enableStalePurge`. That setting governs the daily
 * sweep; this is also the path behind the settings-page button, which is the
 * user asking for it directly.
 */
export async function purgeStaleTabs(): Promise<number> {
  const settings = await getSettings();
  const thresholdMs = settings.staleTabThresholdHours * 60 * 60 * 1000;
  const now = Date.now();
  const windows = await chrome.windows.getAll({ populate: true });

  const toRemove: number[] = [];
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.id === undefined) continue;
      if (!isTabUrlAllowed(tab.url)) continue;
      if (tab.active || tab.pinned) continue;
      if (tab.lastAccessed == null || tab.lastAccessed <= 0) continue;
      if (now - tab.lastAccessed > thresholdMs) toRemove.push(tab.id);
    }
  }

  if (toRemove.length) {
    try {
      await chrome.tabs.remove(toRemove);
      // Loud on purpose: this closes tabs the user never asked to lose, so it
      // should be traceable in the service worker log.
      console.warn(
        `[Fold] Closed ${toRemove.length} tab(s) untouched for over ${settings.staleTabThresholdHours}h.`,
      );
    } catch { /* some tabs may have been closed already */ }
  }

  return toRemove.length;
}



export async function focusCurrentGroup(): Promise<number> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.windowId === undefined) throw new Error('No active tab');
  if (!isGroupedTab(activeTab)) throw new Error('Active tab must be grouped to focus');

  const groups = await chrome.tabGroups.query({ windowId: activeTab.windowId });
  for (const group of groups) {
    await chrome.tabGroups.update(group.id, { collapsed: group.id !== activeTab.groupId });
  }

  return groups.length;
}



export async function sortCurrentGroupsByDomain(): Promise<number> {
  const tabs = (await chrome.tabs.query({ currentWindow: true }))
    .filter(tab => tab.id !== undefined && isTabUrlAllowed(tab.url));
  const buckets = new Map<string, chrome.tabs.Tab[]>();

  for (const tab of tabs) {
    const key = isGroupedTab(tab) ? `group:${tab.groupId}` : 'ungrouped';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(tab);
  }

  const orderedBuckets = Array.from(buckets.values())
    .map(bucket => bucket.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)))
    .sort((a, b) => (a[0]?.index ?? 0) - (b[0]?.index ?? 0));

  for (const bucket of orderedBuckets) {
    const startIndex = bucket[0]?.index ?? 0;
    const sorted = [...bucket].sort((a, b) => {
      const hostDiff = hostnameFromUrl(a.url!).localeCompare(hostnameFromUrl(b.url!));
      if (hostDiff !== 0) return hostDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    for (let i = 0; i < sorted.length; i++) {
      try { await chrome.tabs.move(sorted[i].id!, { index: startIndex + i }); } catch { /* tab may have been closed */ }
    }
  }

  await autoPinImportantApps();
  return orderedBuckets.length;
}

export async function exportGroupsAsMarkdown(): Promise<string> {
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const tabs = await chrome.tabs.query({ currentWindow: true });

  const lines: string[] = ['# Tab Groups', ''];

  const escMd = (s: string) => s.replace(/[[\]]/g, '\\$&');

  for (const group of groups) {
    lines.push(`## ${group.title || 'Unnamed Group'}`);
    const groupTabs = tabs.filter(t => t.groupId === group.id && isTabUrlAllowed(t.url));
    for (const tab of groupTabs) {
      lines.push(`- [${escMd(tab.title || tab.url || '')}](${tab.url})`);
    }
    lines.push('');
  }

  const ungroupedTabs = tabs.filter(t => !isGroupedTab(t) && isTabUrlAllowed(t.url));
  if (ungroupedTabs.length) {
    lines.push('## Ungrouped');
    for (const tab of ungroupedTabs) {
      lines.push(`- [${escMd(tab.title || tab.url || '')}](${tab.url})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function deleteAllTabGroups(): Promise<number> {
  await saveSuggestions(null);
  await chrome.action.setBadgeText({ text: '' });

  const settings = await getSettings();
  const pinnedSet = new Set(settings.pinnedGroups);

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupedTabs = tabs.filter(tab => tab.id !== undefined && isGroupedTab(tab));
  if (!groupedTabs.length) return 0;

  // Respect pinned groups — find which group IDs are pinned
  const pinnedGroupIds = new Set<number>();
  if (pinnedSet.size > 0) {
    try {
      const windowId = await getCurrentWindowId();
      const groups = await chrome.tabGroups.query({ windowId });
      for (const g of groups) {
        if (g.title && pinnedSet.has(g.title)) pinnedGroupIds.add(g.id);
      }
    } catch { /* ignore */ }
  }

  const tabIds = groupedTabs
    .filter(tab => !pinnedGroupIds.has(tab.groupId))
    .map(tab => tab.id!);
  const uniqueGroups = new Set(
    groupedTabs.filter(tab => !pinnedGroupIds.has(tab.groupId)).map(tab => tab.groupId),
  );

  if (tabIds.length > 0) {
    await ungroupTabsSafe(tabIds);
  }
  return uniqueGroups.size;
}

export async function autoPinImportantApps(windowId?: number): Promise<number> {
  const settings = await getSettings();
  if (!settings.autoPinApps) return 0;

  const tabs = await chrome.tabs.query(windowId ? { windowId } : { currentWindow: true });
  const importantTabs = tabs
    .filter(tab =>
      tab.id !== undefined &&
      isTabUrlAllowed(tab.url) &&
      isImportantAppUrl(tab.url!) &&
      !isGroupedTab(tab),
    )
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let pinnedCount = 0;
  for (let i = 0; i < importantTabs.length; i++) {
    const tab = importantTabs[i];
    try {
      if (!tab.pinned) pinnedCount++;
      await chrome.tabs.update(tab.id!, { pinned: true });
      await chrome.tabs.move(tab.id!, { index: i });
    } catch { /* tab may have been closed during operation */ }
  }

  return pinnedCount;
}



// --- Group Drift Detection ---

export async function checkGroupDrift(): Promise<{ drifted: boolean; driftedGroups: string[] }> {
  const settings = await getSettings();
  const windowId = await getCurrentWindowId();
  const groups = await chrome.tabGroups.query({ windowId });
  const driftedGroups: string[] = [];

  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (tabs.length < 2) continue;

    const domainCounts: Record<string, number> = {};
    for (const tab of tabs) {
      if (!tab.url) continue;
      const domain = hostnameFromUrl(tab.url);
      if (domain) domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
    }

    const counts = Object.values(domainCounts);
    if (counts.length === 0) continue; // skip empty/unresolvable groups
    const maxCount = Math.max(...counts);
    const coherence = (maxCount / tabs.length) * 100;

    if (coherence < settings.groupDriftThreshold) {
      driftedGroups.push(group.title || `Group ${group.id}`);
    }
  }

  return { drifted: driftedGroups.length > 0, driftedGroups };
}

// --- Scheduled Re-org ---

export async function setupReorgAlarm(): Promise<void> {
  const settings = await getSettings();

  if (settings.reorgSchedule === 'off') {
    chrome.alarms.clear(REORG_ALARM_NAME);
    return;
  }

  const now = new Date();
  const targetHour = settings.reorgTime;
  const nextFire = new Date(now);
  nextFire.setHours(targetHour, 0, 0, 0);
  if (settings.reorgSchedule === 'weekly') {
    if (nextFire <= now) nextFire.setDate(nextFire.getDate() + 7);
  } else if (nextFire <= now) {
    nextFire.setDate(nextFire.getDate() + 1);
  }

  const delayInMinutes = Math.max(1, (nextFire.getTime() - now.getTime()) / 60000);
  const periodInMinutes = settings.reorgSchedule === 'daily' ? 1440 : 10080;

  chrome.alarms.create(REORG_ALARM_NAME, { delayInMinutes, periodInMinutes });
}

/**
 * Sweeps untouched tabs once a day, but only while the user has opted in. Kept
 * independent of the re-org alarm so the two schedules cannot drift into each
 * other, and given an explicit first delay so enabling it never closes anything
 * straight away. The threshold is read at fire time, so changing it needs no
 * reschedule.
 */
export async function setupStaleAlarm(): Promise<void> {
  const settings = await getSettings();

  if (!settings.enableStalePurge) {
    chrome.alarms.clear(STALE_ALARM_NAME);
    return;
  }

  const day = 1440;
  chrome.alarms.create(STALE_ALARM_NAME, { delayInMinutes: day, periodInMinutes: day });
}

/**
 * Daily group-drift sweep, gated on the same opt-in. Kept as its own alarm rather
 * than folded into the stale sweep so the two can be enabled independently, and
 * on a different period so a large window does not cost two long sweeps back to
 * back. Six hours off the stale sweep, to stay clear of the same hour.
 */
export async function setupDriftAlarm(): Promise<void> {
  const settings = await getSettings();

  if (!settings.enableGroupDrift) {
    chrome.alarms.clear(DRIFT_ALARM_NAME);
    return;
  }

  chrome.alarms.create(DRIFT_ALARM_NAME, { delayInMinutes: 360, periodInMinutes: 1440 });
}

/**
 * Runs a sweep and persists the outcome. Persisting here rather than at the
 * caller is what lets the popup show a result it never computed: the popup is
 * destroyed on close and cannot hold state between visits.
 */
async function runDriftSweep(): Promise<{ drifted: boolean; driftedGroups: string[] }> {
  const result = await checkGroupDrift();
  await saveLastDrift(result.driftedGroups);
  return result;
}

async function checkAutoTrigger(): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoTrigger) return;

  const tabs = await getTabs();
  if (tabs.length >= settings.threshold) {
    const result = await organize(settings.mergeMode);
    if (result.suggestions?.length) {
      await applyGroups(result.suggestions);
    }
  }
}

chrome.runtime.onMessage.addListener((msg: MessageType, _sender, sendResponse) => {
  if (msg.type === 'organize' || msg.type === 'organize-ungrouped') {
    // Progress goes out as its own broadcast. The reply to this message cannot
    // carry it, since that only arrives once the whole fold has finished.
    const broadcast = (progress: FoldProgress) => {
      // Wrapped rather than chained: with no popup open the send can reject, and
      // a throw here would abort a fold the user is waiting on. Reporting
      // progress is never worth failing the work over.
      try {
        void Promise.resolve(chrome.runtime.sendMessage({ type: 'fold-progress', progress }))
          .catch(() => {});
      } catch {
        // Older Chrome builds can throw synchronously if nothing is listening.
      }
    };
    organize(msg.type === 'organize-ungrouped', broadcast).then(r =>
      sendResponse({ type: 'status', status: r.error ? 'error' : 'done', ...r })
    );
    return true;
  }

  if (msg.type === 'apply') {
    applyGroups(msg.suggestions).then(() => sendResponse({ type: 'status', status: 'applied' }));
    return true;
  }

  if (msg.type === 'undo') {
    undoLastGrouping().then(r => sendResponse({ type: 'status', status: r.error ? 'error' : 'undone', error: r.error }));
    return true;
  }

  if (msg.type === 'find-duplicates') {
    findDuplicateTabs().then(duplicates => sendResponse({ type: 'status', status: 'done', duplicates }));
    return true;
  }

  if (msg.type === 'purge-stale') {
    purgeStaleTabs()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'focus-group') {
    focusCurrentGroup()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'sort-groups') {
    sortCurrentGroupsByDomain()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'delete-all-groups') {
    deleteAllTabGroups()
      .then(count => sendResponse({ type: 'status', status: 'done', count }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'get-stats') {
    getStats().then(stats => sendResponse({ type: 'status', status: 'done', stats }));
    return true;
  }

  if (msg.type === 'get-usage') {
    getUsage().then(usage => sendResponse({ type: 'status', status: 'done', usage }));
    return true;
  }

  if (msg.type === 'export-data') {
    exportAll().then(data => sendResponse({ type: 'status', status: 'done', data }));
    return true;
  }

  if (msg.type === 'import-data') {
    importAll(msg.data)
      .then(() => sendResponse({ type: 'status', status: 'imported' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'test-model') {
    // Cold start pays the model-load cost, so the UI shows a pending state.
    testConnection()
      .then(reply => sendResponse({ type: 'status', status: 'done', chatResponse: reply }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'check-apple-ai') {
    checkAppleAI()
      .then(result => sendResponse({ type: 'status', status: 'done', ...result }))
      .catch(error => sendResponse({ type: 'status', status: 'error', available: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'record-corrections') {
    (async () => {
      await addCorrections(msg.corrections);
      // Apply correction weight (3x) to weighted affinity
      const correctedSuggestions: GroupSuggestion[] = [];
      for (const c of msg.corrections.corrections) {
        correctedSuggestions.push({
          name: c.correctedGroup,
          color: 'grey',
          tabs: [{ id: -1, title: '', url: `https://${c.domain}` }],
        });
      }
      if (correctedSuggestions.length > 0) {
        await updateWeightedAffinity(correctedSuggestions, 3);
      }
      sendResponse({ type: 'status', status: 'done' });
    })();
    return true;
  }

  if (msg.type === 'record-rejections') {
    addRejections(msg.rejections)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'check-group-drift') {
    runDriftSweep()
      .then(result => sendResponse({ type: 'status', status: 'done', ...result }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'export-markdown') {
    exportGroupsAsMarkdown()
      .then(markdown => sendResponse({ type: 'status', status: 'done', markdown }))
      .catch(error => sendResponse({ type: 'status', status: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (msg.type === 'search-tabs') {
    (async () => {
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        const groupMap = new Map(groups.map(g => [g.id, g.title || `Group ${g.id}`]));
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const q = (msg.query || '').toLowerCase();
        const tabResults = tabs
          .filter(t => t.id !== undefined && isTabUrlAllowed(t.url) && (
            !q || (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)
          ))
          .map(t => ({
            id: t.id!,
            title: t.title || t.url || '',
            url: t.url!,
            groupName: isGroupedTab(t) ? (groupMap.get(t.groupId) || '') : '',
            groupId: isGroupedTab(t) ? t.groupId : -1,
          }));
        sendResponse({ type: 'status', status: 'done', tabResults });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Search failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'get-group-stats') {
    (async () => {
      try {
        const windowId = await getCurrentWindowId();
        const groups = await chrome.tabGroups.query({ windowId });
        const groupStats = [];
        for (const group of groups) {
          const tabs = await chrome.tabs.query({ groupId: group.id });
          const domains = [...new Set(
            tabs.filter(t => t.url).map(t => hostnameFromUrl(t.url!)).filter(Boolean)
          )];
          groupStats.push({
            name: group.title || `Group ${group.id}`,
            color: group.color,
            tabCount: tabs.length,
            domains,
          });
        }
        sendResponse({ type: 'status', status: 'done', groupStats });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'snooze-tabs') {
    (async () => {
      try {
        let count = 0;
        for (const tabId of msg.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab.url || !isTabUrlAllowed(tab.url)) continue;
            const snoozeId = `${Date.now()}-${tabId}`;
            const entry: SnoozedTab = {
              id: snoozeId,
              url: tab.url,
              title: tab.title || tab.url,
              wakeAt: msg.wakeAt,
            };
            await addSnoozedTab(entry);
            const delayMs = Math.max(60000, msg.wakeAt - Date.now());
            chrome.alarms.create(`${SNOOZE_ALARM_PREFIX}${snoozeId}`, { delayInMinutes: Math.ceil(delayMs / 60000) });
            await chrome.tabs.remove(tabId);
            count++;
          } catch { /* skip tabs that no longer exist */ }
        }
        sendResponse({ type: 'status', status: 'done', count });
      } catch (e) {
        sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Snooze failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'list-workspaces') {
    getWorkspaces()
      .then(ws => sendResponse({ type: 'status', status: 'done', workspaceNames: Object.keys(ws) }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'save-workspace') {
    saveCurrentWorkspace(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'restore-workspace') {
    restoreWorkspaceByName(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }

  if (msg.type === 'delete-workspace') {
    removeWorkspace(msg.name)
      .then(() => sendResponse({ type: 'status', status: 'done' }))
      .catch(e => sendResponse({ type: 'status', status: 'error', error: e instanceof Error ? e.message : 'Failed' }));
    return true;
  }
});

let commandInFlight = false;
let commandInFlightTimer: ReturnType<typeof setTimeout> | null = null;
chrome.commands?.onCommand?.addListener((command: string) => {
  if (commandInFlight) return;
  commandInFlight = true;
  // Safety timeout: reset flag after 60s in case command hangs
  commandInFlightTimer = setTimeout(() => { commandInFlight = false; }, 60_000);
  const p = command === 'organize-tabs' ? organize() : command === 'undo-grouping' ? undoLastGrouping() : null;
  (p || Promise.resolve()).finally(() => { commandInFlight = false; if (commandInFlightTimer) clearTimeout(commandInFlightTimer); });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 });
  void setupStaleAlarm();
  void setupDriftAlarm();
  setupReorgAlarm();
  return rebuildContextMenus();
});

// The clicked tab arrives as the second argument, not as `info.tab`, which is
// not part of OnClickData. Reading info.tab meant the tab was always undefined
// and the "Add tab to group..." items did nothing.
chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === 'fold-organize') void organize().catch(() => {});
  if (info.menuItemId === 'fold-organize-ungrouped') void organize(true).catch(() => {});
  if (info.menuItemId === 'fold-undo') void undoLastGrouping().catch(() => {});
  if (info.menuItemId === 'fold-duplicates') void findDuplicateTabs().catch(() => {});

  const tabId = tab?.id;
  if (tabId === undefined) return;

  const menuId = String(info.menuItemId);
  if (menuId === `${CTX_ADD_TO_GROUP_ID}-new`) {
    (async () => {
      const newGroupId = await groupTabsSafe([tabId]);
      if (newGroupId === null) return;
      await chrome.tabGroups.update(newGroupId, { title: 'New Group', collapsed: false });
      await rebuildContextMenus();
    })();
  } else if (menuId.startsWith(`${CTX_ADD_TO_GROUP_ID}-`)) {
    const groupId = Number(menuId.slice(CTX_ADD_TO_GROUP_ID.length + 1));
    if (Number.isInteger(groupId) && groupId > 0 && groupId < MAX_CONTEXT_GROUP_ID) {
      void groupTabsSafe([tabId], groupId);
    }
  }
});

chrome.tabGroups?.onCreated?.addListener(() => rebuildContextMenus());
chrome.tabGroups?.onRemoved?.addListener(() => rebuildContextMenus());
chrome.tabGroups?.onUpdated?.addListener((group) => {
  rebuildContextMenus();
  if (group.title && group.color) {
    saveGroupColorPref(group.title, group.color as Color).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) triggerAutoCheck();
  if (alarm.name === REORG_ALARM_NAME) {
    getSettings().then(settings => {
      if (settings.reorgSchedule !== 'off') {
        organize(settings.mergeMode).then(result => {
          if (result.suggestions?.length) applyGroups(result.suggestions);
        });
      }
    });
  }
  if (alarm.name === STALE_ALARM_NAME) {
    // Best-effort like every other alarm body: a failed sweep must not throw
    // back into the event loop.
    purgeStaleTabs().catch(() => {});
  }
  if (alarm.name === DRIFT_ALARM_NAME) {
    runDriftSweep().catch(() => {});
  }
  if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
    const snoozeId = alarm.name.slice(SNOOZE_ALARM_PREFIX.length);
    (async () => {
      try {
        const tabs = await getSnoozedTabs();
        const entry = tabs.find(t => t.id === snoozeId);
        if (!entry) return;
        let windowId: number | undefined;
        try {
          const win = await chrome.windows.getLastFocused({ populate: false });
          if (win.id !== undefined) windowId = win.id;
        } catch { /* best-effort fallback */ }
        await chrome.tabs.create({ url: entry.url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
        await removeSnoozedTab(snoozeId);
      } catch (err) {
        console.warn('[Fold] Failed to restore snoozed tab:', err instanceof Error ? err.message : err);
      }
    })();
  }
});

function triggerAutoCheck() {
  if (autoCheckInFlight) return;
  const now = Date.now();
  if (now - lastAutoCheckTime < AUTO_CHECK_COOLDOWN_MS) return;

  autoCheckInFlight = true;
  lastAutoCheckTime = now;
  checkAutoTrigger()
    .catch(() => {
      // Keep auto-trigger best-effort and never break the event loop on runtime failures.
    })
    .finally(() => {
      autoCheckInFlight = false;
    });
}

chrome.tabs.onCreated?.addListener((tab: chrome.tabs.Tab) => {
  // Track opener relationship
  if (tab?.id !== undefined && tab?.openerTabId !== undefined) {
    openerMap.set(tab.id, tab.openerTabId);
    if (openerMap.size > MAX_TRACKED_TAB_RELATIONS) {
      const oldest = openerMap.keys().next().value;
      if (oldest !== undefined) openerMap.delete(oldest);
    }
  }
  triggerAutoCheck();
});

chrome.tabs.onRemoved?.addListener((tabId: number) => {
  // Clean up in-memory maps — no auto-check needed on removal
  if (tabId !== undefined) {
    openerMap.delete(tabId);
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.settings) {
    setupReorgAlarm();
    // The opt-ins gate the alarms' existence, not just their behaviour, so the
    // toggles have to reschedule rather than wait for the next fire.
    void setupStaleAlarm();
    void setupDriftAlarm();
  }
});

chrome.tabs.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || tab.windowId === undefined) return;
  if (!isTabUrlAllowed(tab.url)) return;

  triggerAutoCheck();

  if (isGroupedTab(tab)) {
    const settings = await getSettings();
    if (settings.smartUngroup) {
      try {
        const groupTabs = await chrome.tabs.query({ groupId: tab.groupId, windowId: tab.windowId });
        const otherTabs = groupTabs.filter(t => t.id !== tabId && isTabUrlAllowed(t.url));
        const newDomain = hostnameFromUrl(tab.url);
        if (otherTabs.length > 0 && newDomain) {
          const groupDomains = otherTabs.map(t => hostnameFromUrl(t.url!)).filter(Boolean);
          // Handle ccTLDs like .co.uk, .com.au
          const baseDomain = (d: string) => {
            const parts = d.split('.');
            if (parts.length >= 3) {
              const tld = parts[parts.length - 1];
              const sld = parts[parts.length - 2];
              if (tld.length === 2 && SECONDARY_TLDS.has(sld)) return parts.slice(-3).join('.');
            }
            return parts.slice(-2).join('.');
          };
          const isRelated = groupDomains.some(d => baseDomain(d) === baseDomain(newDomain));
          if (!isRelated) {
            await ungroupTabsSafe([tabId]);
          }
        }
      } catch { /* ignore */ }
    }
    return;
  }

  const settings = await getSettings();
  if (!settings.silentAutoAdd) return;

  // 1. Check opener — if opener is in a group, prefer that group
  const openerId = openerMap.get(tabId);
  if (openerId !== undefined) {
    try {
      const openerTab = await chrome.tabs.get(openerId);
      if (isGroupedTab(openerTab) && openerTab.windowId === tab.windowId) {
        await groupTabsSafe([tabId], openerTab.groupId);
        return;
      }
    } catch { /* opener may have been closed */ }
  }

  // 2. Use enhanced inferTargetGroup with weighted affinity and rejections
  const [rules, affinity, weightedAffinity, rejections] = await Promise.all([
    getDomainRules(), getAffinity(), getWeightedAffinity(), getRejections(),
  ]);
  const inferred = inferTargetGroup(tab.url, rules, affinity, weightedAffinity, rejections);
  if (!inferred) return;

  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: inferred.name });
    if (groups.length > 0) {
      await groupTabsSafe([tabId], groups[0].id);
    } else {
      const newGroupId = await groupTabsSafe([tabId]);
      if (newGroupId === null) return;
      await chrome.tabGroups.update(newGroupId, {
        title: inferred.name,
        color: inferred.color || 'grey',
        collapsed: false,
      });
    }
  } catch {
    // Ignored if grouping fails while the window is changing.
  }
});
