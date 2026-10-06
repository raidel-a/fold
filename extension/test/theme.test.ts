import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTheme } from '../src/llm';
import { applyTheme } from '../src/theme';

function mockNative(response: unknown, lastError?: string) {
  (chrome.runtime as any).sendNativeMessage = vi.fn((_host: string, _msg: any, cb: Function) => {
    (chrome.runtime as any).lastError = lastError ? { message: lastError } : undefined;
    cb(response);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('data-accent-is-fallback');
});

describe('fetchTheme', () => {
  it('returns the accent, appearance, and group palette from the host', async () => {
    mockNative({
      ok: true,
      accent: '#FF9500',
      isDark: false,
      accentIsFallback: false,
      groupColors: { blue: '#007AFF', red: '#FF3B30' },
    });

    expect(await fetchTheme()).toEqual({
      accent: '#FF9500',
      isDark: false,
      accentIsFallback: false,
      groupColors: { blue: '#007AFF', red: '#FF3B30' },
    });
  });

  it('asks the host with the theme op, so no model is loaded', async () => {
    mockNative({ ok: true, accent: '#000', isDark: true, groupColors: {} });
    await fetchTheme();
    expect(vi.mocked((chrome.runtime as any).sendNativeMessage).mock.calls[0][1])
      .toMatchObject({ op: 'theme' });
  });

  it('falls back to the macOS blues when the host is missing', async () => {
    mockNative(undefined, 'Specified native messaging host not found.');
    const theme = await fetchTheme();
    // A theme is never worth an exception; the interface must still paint.
    expect(theme.accent).toMatch(/^#0?[0-9A-F]{6}$/i);
    expect(theme.accentIsFallback).toBe(true);
    expect(theme.groupColors).toEqual({});
  });

  it('tolerates a host that omits fields', async () => {
    mockNative({ ok: true });
    const theme = await fetchTheme();
    expect(theme.accent).toBe('');
    expect(theme.isDark).toBe(false);
    expect(theme.accentIsFallback).toBe(false);
  });
});

describe('applyTheme', () => {
  it('writes the accent and group colours as CSS variables', async () => {
    mockNative({
      ok: true, accent: '#FF9500', isDark: true, accentIsFallback: false,
      groupColors: { blue: '#0091FF' },
    });
    await applyTheme();

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--fold-accent')).toBe('#FF9500');
    expect(root.style.getPropertyValue('--group-blue')).toBe('#0091FF');
  });

  it('records the appearance so CSS and the host agree', async () => {
    mockNative({ ok: true, accent: '#000', isDark: false, groupColors: {} });
    await applyTheme();
    expect(document.documentElement.dataset.appearance).toBe('light');
  });

  it('keeps the CSS default when the host has no accent', async () => {
    mockNative({ ok: true, accent: '', isDark: true, groupColors: {} });
    await applyTheme();
    // An empty inline value would otherwise wipe the stylesheet default and
    // leave tint-less UI, so the macOS blue is written instead.
    expect(document.documentElement.style.getPropertyValue('--fold-accent')).toBe('#007aff');
  });

  it('always sets the fallback variable so the accent indicator can read it', async () => {
    mockNative({ ok: true, accent: '#FF9500', isDark: true, accentIsFallback: false, groupColors: {} });
    await applyTheme();
    expect(document.documentElement.style.getPropertyValue('--fold-accent-fallback')).toBe('#FF9500');
  });

  it('notes when the accent is a system fallback rather than the user\x27s choice', async () => {
    mockNative({ ok: true, accent: '#0091FF', isDark: true, accentIsFallback: true, groupColors: {} });
    await applyTheme();
    expect(document.documentElement.dataset.accentIsFallback).toBe('true');
  });
});