import { vi } from 'vitest';

let localStore: Record<string, unknown> = {};
let syncStore: Record<string, unknown> = {};

function makeStorage(store: Record<string, unknown>) {
  return {
    get: vi.fn((keys?: string | string[] | Record<string, unknown> | null) => {
      if (!keys) return Promise.resolve({ ...store });
      if (typeof keys === 'string') return Promise.resolve({ [keys]: store[keys] });
      if (Array.isArray(keys)) {
        const r: Record<string, unknown> = {};
        for (const k of keys) if (k in store) r[k] = store[k];
        return Promise.resolve(r);
      }
      const r: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(keys)) r[k] = k in store ? store[k] : def;
      return Promise.resolve(r);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),
  };
}

class MockEvent {
  listeners = new Set<Function>();
  addListener = vi.fn((cb: Function) => this.listeners.add(cb));
  removeListener = vi.fn((cb: Function) => this.listeners.delete(cb));
  callListeners(...args: any[]) {
    return Promise.all(Array.from(this.listeners).map(cb => cb(...args)));
  }
}

export function resetStores() {
  localStore = {};
  syncStore = {};
  (globalThis as any).chrome.storage.local = makeStorage(localStore);
  (globalThis as any).chrome.storage.sync = makeStorage(syncStore);
}

export function resetAllMocks() {
  resetStores();
  groupIdCounter = 100;
  vi.mocked(chrome.tabs.query).mockReset().mockResolvedValue([]);
  vi.mocked(chrome.tabs.group).mockReset().mockResolvedValue(100);
  vi.mocked(chrome.tabs.ungroup).mockReset().mockResolvedValue(undefined);
  vi.mocked(chrome.tabs.create).mockReset().mockImplementation(async (createProperties: any) => ({
    id: groupIdCounter++,
    windowId: createProperties.windowId ?? 1,
    url: createProperties.url,
    title: createProperties.url || '',
    active: Boolean(createProperties.active),
    pinned: Boolean(createProperties.pinned),
    index: 0,
    groupId: -1,
  }) as any);
  vi.mocked(chrome.tabs.move).mockReset().mockResolvedValue([] as any);
  vi.mocked(chrome.tabs.update).mockReset().mockImplementation(async (tabId: number, updateProperties: any) => ({
    id: tabId,
    ...updateProperties,
  }) as any);
  vi.mocked(chrome.tabs.discard).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(chrome.tabs.remove).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(chrome.tabs.get).mockReset().mockImplementation(async (tabId: number) => ({
    id: tabId, groupId: -1, windowId: 1,
  }) as any);
  vi.mocked(chrome.tabGroups.query).mockReset().mockResolvedValue([]);
  vi.mocked(chrome.tabGroups.update).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(chrome.windows.getCurrent).mockReset().mockResolvedValue({ id: 1 } as any);
  vi.mocked(chrome.windows.getLastFocused).mockReset().mockResolvedValue({ id: 1 } as any);
  vi.mocked(chrome.windows.getAll).mockReset().mockResolvedValue([{ id: 1, tabs: [] }] as any);
  vi.mocked(chrome.windows.create).mockReset().mockResolvedValue({ id: 2 } as any);
  vi.mocked(chrome.contextMenus.create).mockReset().mockImplementation((_props: any, callback?: () => void) => {
    callback?.();
  });
  vi.mocked(chrome.contextMenus.remove).mockReset().mockImplementation((_menuItemId: any, callback?: () => void) => {
    callback?.();
    return Promise.resolve(undefined as any) as any;
  });
  vi.mocked(chrome.contextMenus.removeAll).mockReset().mockImplementation((callback?: () => void) => {
    callback?.();
    return Promise.resolve(undefined as any) as any;
  });
  vi.mocked(chrome.bookmarks.create).mockReset().mockImplementation(async (bookmark: any) => ({
    id: String(groupIdCounter++),
    ...bookmark,
  }) as any);
  vi.mocked(chrome.action.setBadgeText).mockReset().mockResolvedValue(undefined);
  vi.mocked(chrome.action.setBadgeBackgroundColor).mockReset().mockResolvedValue(undefined);
  vi.mocked(chrome.runtime.openOptionsPage).mockReset().mockResolvedValue(undefined as any);
  vi.mocked((chrome.runtime as any).sendNativeMessage).mockReset().mockImplementation(
    (_host: string, msg: any, cb: Function) => {
      if (msg?.op === 'status') cb({ ok: true, available: true });
      else cb({ ok: true, content: '[]', inputTokens: 0, outputTokens: 0 });
    }
  );
  (chrome.runtime as any).lastError = undefined;
  vi.mocked(fetch).mockReset();
}

let groupIdCounter = 100;

(globalThis as any).chrome = {
  tabs: {
    query: vi.fn(() => Promise.resolve([])),
    group: vi.fn(() => Promise.resolve(groupIdCounter++)),
    ungroup: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    discard: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve()),
    onCreated: new MockEvent(),
    onRemoved: new MockEvent(),
    onUpdated: new MockEvent(),
    onActivated: new MockEvent(),
    get: vi.fn((tabId: number) => Promise.resolve({ id: tabId, groupId: -1 })),
  },
  tabGroups: {
    query: vi.fn(() => Promise.resolve([])),
    update: vi.fn(() => Promise.resolve()),
    onCreated: new MockEvent(),
    onRemoved: new MockEvent(),
    onUpdated: new MockEvent(),
  },
  windows: {
    WINDOW_ID_CURRENT: -2,
    getAll: vi.fn(() => Promise.resolve([])),
    getCurrent: vi.fn(() => Promise.resolve({ id: 1 })),
    getLastFocused: vi.fn(() => Promise.resolve({ id: 1 })),
    create: vi.fn(() => Promise.resolve({ id: 2 })),
    update: vi.fn(() => Promise.resolve()),
  },
  scripting: {
    executeScript: vi.fn(() => Promise.resolve([])),
  },
  bookmarks: {
    create: vi.fn(() => Promise.resolve({ id: '123' })),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: new MockEvent(),
  },
  runtime: {
    onMessage: new MockEvent(),
    onInstalled: new MockEvent(),
    lastError: undefined,
    sendMessage: vi.fn(),
    // Native messaging is the only model transport. Default to a successful reply
    // so tests that are not about the model still exercise real code paths; suites
    // covering the transport override this. The group op answers with decoded
    // groups, which is what the host returns under a generation schema.
    sendNativeMessage: vi.fn((_host: string, msg: any, cb: Function) => {
      if (msg?.op === 'status') cb({ ok: true, available: true });
      else if (msg?.op === 'group') cb({ ok: true, groups: [], inputTokens: 0, outputTokens: 0 });
      else cb({ ok: true, content: 'OK', inputTokens: 0, outputTokens: 0 });
    }),
    openOptionsPage: vi.fn(() => Promise.resolve()),
  },
  commands: {
    onCommand: new MockEvent(),
  },
  contextMenus: {
    create: vi.fn((_props: any, callback?: () => void) => callback?.()),
    remove: vi.fn((_menuItemId: any, callback?: () => void) => { callback?.(); return Promise.resolve(); }),
    removeAll: vi.fn((callback?: () => void) => { callback?.(); return Promise.resolve(); }),
    onClicked: new MockEvent(),
  },
  storage: {
    local: makeStorage(localStore),
    sync: makeStorage(syncStore),
    onChanged: new MockEvent(),
  },
  action: {
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
};

(globalThis as any).navigator = {
  ...globalThis.navigator,
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
  }
};

(globalThis as any).fetch = vi.fn();
