import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APPLE_AI_HOST, checkAppleAI, completeWithUsage, testConnection } from '../src/llm';

const MAX_TOKENS = 4096;

/** Replies as the native host does: a bare callback with the framed payload. */
function mockNative(response: unknown, lastError?: string) {
  (chrome.runtime as any).sendNativeMessage = vi.fn((_host: string, _msg: unknown, cb: Function) => {
    (chrome.runtime as any).lastError = lastError ? { message: lastError } : undefined;
    cb(response);
  });
}

function mockOk(content: string, tokens?: { inputTokens: number; outputTokens: number }) {
  mockNative({ id: 'complete', ok: true, content, ...tokens });
}

function lastRequest(): Record<string, any> {
  return vi.mocked((chrome.runtime as any).sendNativeMessage).mock.calls.at(-1)![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  (chrome.runtime as any).lastError = undefined;
});

describe('routing', () => {
  it('always talks to the one host, never over HTTP', async () => {
    mockOk('hello');
    await completeWithUsage([{ role: 'user', content: 'hi' }]);

    expect((chrome.runtime as any).sendNativeMessage).toHaveBeenCalledWith(
      APPLE_AI_HOST, expect.anything(), expect.any(Function)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends system prompt and user content on separate fields', async () => {
    mockOk('ok');
    await completeWithUsage([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ]);
    expect(lastRequest()).toMatchObject({ systemPrompt: 'be terse', prompt: 'hello' });
  });

  it('excludes system messages from the prompt field', async () => {
    mockOk('ok');
    await completeWithUsage([
      { role: 'system', content: 'sys only' },
      { role: 'user', content: 'usr only' },
    ]);
    expect(lastRequest().prompt).toBe('usr only');
    expect(lastRequest().prompt).not.toContain('sys only');
  });

  it('joins multiple user messages with newlines', async () => {
    mockOk('ok');
    await completeWithUsage([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ignored' },
      { role: 'user', content: 'second' },
    ]);
    expect(lastRequest().prompt).toBe('first\nignored\nsecond');
  });

  it('never sends tab content as instructions', async () => {
    mockOk('ok');
    await completeWithUsage([
      { role: 'system', content: 'You are a browser tab organizer.' },
      { role: 'user', content: 'untrusted page title' },
    ]);
    expect(lastRequest().systemPrompt).not.toContain('untrusted');
  });

  it('requests the shared token budget', async () => {
    mockOk('ok');
    await completeWithUsage([{ role: 'user', content: 'hi' }]);
    expect(lastRequest().maxTokens).toBe(MAX_TOKENS);
  });

  it('refuses to send an empty prompt', async () => {
    mockOk('ok');
    await expect(completeWithUsage([{ role: 'user', content: '   ' }]))
      .rejects.toThrow(/empty prompt/);
    expect((chrome.runtime as any).sendNativeMessage).not.toHaveBeenCalled();
  });
});

describe('response handling', () => {
  it('prefers the host token counts over a character estimate', async () => {
    mockOk('abcd', { inputTokens: 111, outputTokens: 222 });
    const result = await completeWithUsage([{ role: 'user', content: 'x'.repeat(400) }]);
    expect(result.inputTokens).toBe(111);
    expect(result.outputTokens).toBe(222);
  });

  it('falls back to an estimate when the host omits counts', async () => {
    mockOk('abcdefgh');
    const result = await completeWithUsage([{ role: 'user', content: 'y'.repeat(40) }]);
    expect(result.outputTokens).toBe(2);
    expect(result.inputTokens).toBe(10);
  });

  it('preserves unicode content', async () => {
    mockOk('Hello 世界 🌍');
    const result = await completeWithUsage([{ role: 'user', content: 'x' }]);
    expect(result.content).toBe('Hello 世界 🌍');
  });

  it('preserves very long content', async () => {
    const long = 'x'.repeat(100_000);
    mockOk(long);
    const result = await completeWithUsage([{ role: 'user', content: 'x' }]);
    expect(result.content).toHaveLength(100_000);
  });

  it('surfaces the host error message', async () => {
    mockNative({ id: 'complete', ok: false, error: 'Apple Intelligence is off.' });
    await expect(completeWithUsage([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Apple Intelligence is off.');
  });

  it('reports a missing host as an install problem', async () => {
    mockNative(undefined, 'Specified native messaging host not found.');
    await expect(completeWithUsage([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/install-native-host\.sh/);
  });

  it('rejects an undefined response instead of returning empty content', async () => {
    mockNative(undefined);
    await expect(completeWithUsage([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/no response/);
  });
});

describe('checkAppleAI', () => {
  it('probes with the status op so the model is not loaded', async () => {
    mockNative({ id: 'status', ok: true, available: true });
    await checkAppleAI();
    expect(lastRequest()).toMatchObject({ op: 'status' });
  });

  it('reports available when the host answers positively', async () => {
    mockNative({ id: 'status', ok: true, available: true });
    expect(await checkAppleAI()).toEqual({ available: true, reason: undefined });
  });

  it('passes the host explanation through when unavailable', async () => {
    mockNative({ id: 'status', ok: true, available: false, reason: 'Apple Intelligence is off.' });
    expect(await checkAppleAI()).toEqual({ available: false, reason: 'Apple Intelligence is off.' });
  });

  it('treats a missing host as unavailable rather than throwing', async () => {
    mockNative(undefined, 'Specified native messaging host not found.');
    const result = await checkAppleAI();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/install-native-host\.sh/);
  });

  it('never reports available when the host errors', async () => {
    mockNative({ id: 'status', ok: false, error: 'boom' });
    expect(await checkAppleAI()).toEqual({ available: false, reason: 'boom' });
  });
});

describe('testConnection', () => {
  it('asks for an exact reply', async () => {
    mockOk('OK');
    expect(await testConnection()).toBe('OK');
    expect(lastRequest().prompt).toMatch(/exactly: OK/);
  });
});

describe('host identifier', () => {
  it('uses a hyphen-free name, since Chromium rejects hyphens', () => {
    expect(APPLE_AI_HOST).not.toMatch(/-/);
  });

  it('is a reverse-dns style name', () => {
    expect(APPLE_AI_HOST).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
  });
});