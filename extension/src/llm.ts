// Single LLM path: Apple Foundation Models over Chrome native messaging.
//
// The extension has no cloud provider and no API keys. A request leaves this file
// only as a framed message to the local native host process.

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

// Must stay in sync with scripts/install-native-host.sh. Chromium rejects
// hyphenated native-messaging host names and chrome-extension://* wildcards,
// so this is a fixed, extension-ID-free identifier.
export const APPLE_AI_HOST = 'com.fold.appleai';

// Cold start includes loading the model into memory, which can exceed the usual
// request budget on the first call.
const TIMEOUT_COLD_MS = 120_000;
const TIMEOUT_WARM_MS = 60_000;
const MAX_TOKENS = 4096;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface NativeResponse {
  ok: boolean;
  content?: string;
  error?: string;
  available?: boolean;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  accent?: string;
  isDark?: boolean;
  accentIsFallback?: boolean;
  groupColors?: Record<string, string>;
  /** Present on the `group` op only: schema-constrained, already decoded. */
  groups?: RawGroupWire[];
}

/**
 * One group as the host decoded it. The native side enforces the shape via a
 * generation schema, so these need validating but not parsing.
 */
export interface RawGroupWire {
  name?: unknown;
  color?: unknown;
  tabIds?: unknown;
}

export interface GroupingResult {
  groups: RawGroupWire[];
  inputTokens: number;
  outputTokens: number;
}

/** Sends one framed request to the native host, resolved against its response. */
function sendNative<T extends NativeResponse>(
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Cleared on settle: an un-cleared timer would hold the MV3 worker alive.
    const timer = setTimeout(
      () => reject(new Error(`Apple AI request timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
    const settle = (fn: () => void) => { clearTimeout(timer); fn(); };

    chrome.runtime.sendNativeMessage(APPLE_AI_HOST, request, response => {
      const err = chrome.runtime.lastError;
      if (err) {
        settle(() => reject(new Error(
          `Apple AI host unavailable (${APPLE_AI_HOST}). `
          + `Run scripts/install-native-host.sh, then reload the extension. (${err.message})`
        )));
        return;
      }
      if (!response) {
        settle(() => reject(new Error('Apple AI host returned no response')));
        return;
      }
      settle(() => resolve(response as T));
    });
  });
}

/** macOS appearance and accent, resolved by the native host. */
export interface Theme {
  accent: string;
  isDark: boolean;
  /** True when macOS returned a desaturated accent and we substituted blue. */
  accentIsFallback: boolean;
  groupColors: Record<string, string>;
}

const DEFAULT_ACCENT_LIGHT = '#007aff';
const DEFAULT_ACCENT_DARK = '#0a84ff';

/**
 * Asks the host for the system accent and appearance so the UI can adopt them
 * instead of shipping a brand color. Falls back to the macOS blue defaults, and
 * never throws: a missing host must not break the interface.
 */
export async function fetchTheme(): Promise<Theme> {
  try {
    const res = await sendNative<NativeResponse>({ id: 'theme', op: 'theme' }, 5000);
    const groupColors = res.groupColors && typeof res.groupColors === 'object'
      ? res.groupColors as Record<string, string>
      : {};
    return {
      accent: typeof res.accent === 'string' ? res.accent : '',
      isDark: res.isDark === true,
      accentIsFallback: res.accentIsFallback === true,
      groupColors,
    };
  } catch {
    const prefersDark = matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    return {
      accent: prefersDark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT,
      isDark: prefersDark,
      accentIsFallback: true,
      groupColors: {},
    };
  }
}

/**
 * Probes the host without loading the model, so the settings page can report
 * status cheaply.
 */
export async function checkAppleAI(): Promise<{ available: boolean; reason?: string }> {
  try {
    const res = await sendNative<NativeResponse>({ id: 'status', op: 'status' }, 10_000);
    if (!res.ok) return { available: false, reason: res.error };
    return { available: res.available === true, reason: res.reason };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs one generation. The host serializes requests internally, so callers get
 * on-device latency rather than queueing behind another session.
 */
export async function completeWithUsage(
  messages: Message[],
  timeoutMs = TIMEOUT_WARM_MS,
): Promise<CompletionResult> {
  // Fold sends tab titles and URLs in the prompt; only Fold's own instructions
  // are fixed text, and those belong in the host's instructions field.
  const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const prompt = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n');

  if (!prompt.trim()) throw new Error('Cannot send an empty prompt to Apple AI');

  const res = await sendNative<NativeResponse>(
    { id: 'complete', systemPrompt, prompt, maxTokens: MAX_TOKENS },
    timeoutMs,
  );

  if (!res.ok || res.content == null) {
    throw new Error(res.error ?? 'Apple AI returned an empty response');
  }

  const inputText = systemPrompt + prompt;
  return {
    content: res.content,
    // The host returns real counts from tokenCount(for:); these are the fallback.
    inputTokens: res.inputTokens ?? estimateTokens(inputText),
    outputTokens: res.outputTokens ?? estimateTokens(res.content),
  };
}

/**
 * Asks the host to group tabs under a generation schema.
 *
 * The host constrains the model's output to the group shape, so this returns
 * decoded data rather than prose. That removes the regex-in-a-code-fence parsing
 * this used to need, and with it the failure mode where one malformed response
 * aborted the whole fold.
 */
export async function groupWithUsage(
  systemPrompt: string,
  prompt: string,
  maxGroups: number,
  timeoutMs = TIMEOUT_WARM_MS,
): Promise<GroupingResult> {
  if (!prompt.trim()) throw new Error('Cannot send an empty prompt to Apple AI');

  const res = await sendNative<NativeResponse>(
    { id: 'group', op: 'group', systemPrompt, prompt, maxGroups, maxTokens: MAX_TOKENS },
    timeoutMs,
  );

  if (!res.ok || !Array.isArray(res.groups)) {
    throw new Error(res.error ?? 'Apple AI returned no groups');
  }

  return {
    groups: res.groups,
    // Real counts from the host; these are only a fallback if it omitted them.
    inputTokens: res.inputTokens ?? estimateTokens(systemPrompt + prompt),
    outputTokens: res.outputTokens ?? estimateTokens(JSON.stringify(res.groups)),
  };
}

/** Cold-start budget, for the one call that pays the model-load cost. */
export function coldStartTimeout(): number {
  return TIMEOUT_COLD_MS;
}

export async function testConnection(): Promise<string> {
  const result = await completeWithUsage(
    [{ role: 'user', content: 'Reply with exactly: OK' }],
    TIMEOUT_COLD_MS,
  );
  return result.content;
}