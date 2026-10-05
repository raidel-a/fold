export type Color = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export const COLORS: Color[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** Known secondary-level TLDs for ccTLD base-domain extraction (.co.uk, .com.au, etc.) */
export const SECONDARY_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'me', 'ltd']);

// --- Tab & Group ---

export interface TabInfo {
  id: number;
  title: string;
  url: string;
}



export interface GroupSuggestion {
  name: string;
  color: Color;
  tabs: TabInfo[];
}

// --- Settings ---

/**
 * There is no provider, endpoint, or API key to configure: the only model is
 * Apple's, reached through the local native host.
 */
export interface Settings {
  autoTrigger: boolean;
  threshold: number;
  maxGroups: number;
  mergeMode: boolean;
  maxTitleLength: number;
  silentAutoAdd: boolean;
  autoPinApps: boolean;
  staleTabThresholdHours: number;
  /**
   * Gates the daily stale-tab sweep only. Purging on demand from the settings
   * page ignores this, since that is the user asking directly.
   */
  enableStalePurge: boolean;
  // Smart learning
  enableCorrectionTracking: boolean;
  enableRejectionMemory: boolean;
  enableGroupDrift: boolean;
  enablePatternMining: boolean;
  groupDriftThreshold: number;
  // Scheduled re-org
  reorgSchedule: 'off' | 'daily' | 'weekly';
  reorgTime: number;
  // Pinned groups
  pinnedGroups: string[];
  // Smart ungrouping
  smartUngroup: boolean;
}

export interface AffinityMap {
  [domain: string]: string;
}

// --- Weighted Affinity (learning system) ---

export interface WeightedAffinityGroup {
  count: number;
  lastUsed: number;
}

export interface WeightedAffinityEntry {
  groups: Record<string, WeightedAffinityGroup>;
}

export interface WeightedAffinityMap {
  [key: string]: WeightedAffinityEntry;
}

// --- Correction Tracking ---

export interface CorrectionEntry {
  timestamp: number;
  corrections: { domain: string; originalGroup: string; correctedGroup: string }[];
}

// --- Rejection Memory ---

export interface RejectionEntry {
  timestamp: number;
  domain: string;
  rejectedGroup: string;
}

// --- Snoozed Tabs ---

export interface SnoozedTab {
  id: string;
  url: string;
  title: string;
  wakeAt: number;
}

export interface DomainRule {
  domain: string;
  groupName: string;
  color: Color;
}

// --- Workspaces ---

export interface WorkspaceTab {
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  groupName?: string;
  groupColor?: Color;
}

export interface Workspace {
  name: string;
  savedAt: number;
  tabs: WorkspaceTab[];
}

export interface WorkspaceMap {
  [name: string]: Workspace;
}

// --- History ---

export interface HistoryEntry {
  timestamp: number;
  groups: { name: string; domains: string[] }[];
}

// --- Usage ---
//
// Tokens only. On-device inference is free, so there is no USD figure to track
// and no spending cap to enforce.

export interface UsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  organizations: number;
  /** Tokens for the current browser session, not persisted across restarts. */
  sessionInputTokens: number;
  sessionOutputTokens: number;
}

// --- Undo ---

export interface UndoSnapshot {
  timestamp: number;
  groups: { tabId: number; groupId: number }[];
  ungrouped: number[];
}

// --- Stats ---

export interface Stats {
  totalOrganizations: number;
  totalTabsGrouped: number;
  lastOrganizedAt: number | null;
}

// --- Export ---

export interface ExportData {
  settings: Settings;
  affinity: AffinityMap;
  domainRules: DomainRule[];
  workspaces: WorkspaceMap;
  weightedAffinity?: WeightedAffinityMap;
  corrections?: CorrectionEntry[];
  rejections?: RejectionEntry[];
}

// --- Group Drift ---

/**
 * Outcome of the last drift sweep, persisted so the popup can show it on open.
 * The popup is torn down whenever it closes, so it cannot hold this itself.
 */
export interface DriftReport {
  driftedGroups: string[];
  /** Epoch millis of the sweep, or null when no sweep has ever run. */
  checkedAt: number | null;
}

// --- Defaults ---

export const DEFAULT_SETTINGS: Settings = {
  autoTrigger: false,
  threshold: 5,
  maxGroups: 6,
  mergeMode: false,
  maxTitleLength: 80,
  silentAutoAdd: false,
  autoPinApps: false,
  staleTabThresholdHours: 48,
  // Off by default: closing tabs unattended is destructive and irreversible, so
  // it has to be something the user opts into rather than something they opt out of.
  enableStalePurge: false,
  enableCorrectionTracking: true,
  enableRejectionMemory: true,
  enableGroupDrift: false,
  enablePatternMining: false,
  groupDriftThreshold: 50,
  reorgSchedule: 'off',
  reorgTime: 9,
  pinnedGroups: [],
  smartUngroup: false,
};

export const DEFAULT_STATS: Stats = {
  totalOrganizations: 0,
  totalTabsGrouped: 0,
  lastOrganizedAt: null,
};

export const DEFAULT_USAGE: UsageTotals = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  organizations: 0,
  sessionInputTokens: 0,
  sessionOutputTokens: 0,
};

// --- Messages ---

/**
 * Progress while a fold runs. Broadcast rather than returned, because the reply to
 * `organize` only arrives once the whole thing finishes, and 8 seconds of silence
 * reads as a hang.
 */
export interface FoldProgress {
  /** Human-readable phase, e.g. "Reading tabs" or "Grouping 60 of 140". */
  label: string;
  /** 0 to 1, or null when the total is not yet known. */
  fraction: number | null;
  /** Tabs processed so far, when known. */
  done?: number;
  total?: number;
}

export type MessageType =
  | { type: 'organize' }
  | { type: 'organize-ungrouped' }
  | { type: 'fold-progress'; progress: FoldProgress }
  | { type: 'apply'; suggestions: GroupSuggestion[] }
  | { type: 'undo' }
  | { type: 'find-duplicates' }
  | { type: 'list-workspaces' }
  | { type: 'get-stats' }
  | { type: 'get-usage' }
  | { type: 'export-data' }
  | { type: 'import-data'; data: ExportData }
  | { type: 'test-model' }
  | { type: 'check-apple-ai' }
  | { type: 'snooze-tabs'; tabIds: number[]; wakeAt: number }
  | { type: 'purge-stale' }
  | { type: 'focus-group' }
  | { type: 'delete-all-groups' }
  | { type: 'export-markdown' }
  | { type: 'sort-groups' }
  | { type: 'save-workspace'; name: string }
  | { type: 'restore-workspace'; name: string }
  | { type: 'delete-workspace'; name: string }
  | { type: 'record-corrections'; corrections: CorrectionEntry }
  | { type: 'record-rejections'; rejections: RejectionEntry[] }
  | { type: 'check-group-drift' }
  | { type: 'search-tabs'; query: string }
  | { type: 'get-group-stats' }
  | { type: 'status'; status: string; suggestions?: GroupSuggestion[]; error?: string; duplicates?: TabInfo[][]; stats?: Stats; usage?: UsageTotals; data?: ExportData; chatResponse?: string; markdown?: string; workspaceNames?: string[]; count?: number; drifted?: boolean; driftedGroups?: string[]; available?: boolean; reason?: string; tabResults?: Array<{ id: number; title: string; url: string; groupName: string; groupId: number }>; groupStats?: Array<{ name: string; color: Color; tabCount: number; domains: string[] }> };
