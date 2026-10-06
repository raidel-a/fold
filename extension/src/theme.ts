import { fetchTheme } from './llm';

/**
 * Applies macOS's accent color and appearance to the document, so the interface
 * looks like part of the system rather than a web app pasted into a browser.
 *
 * Runs once at startup and again whenever the OS appearance flips. Group colors
 * become CSS variables so a tab chip can be tinted with the same value the
 * browser will actually use for that group.
 */
let applied = false;

export async function applyTheme(): Promise<void> {
  const theme = await fetchTheme();
  const root = document.documentElement;

  // An empty accent means the host had nothing to say; keep the CSS default.
  // --fold-accent-fallback tracks the same value: it exists so the accent
  // provenance indicator can show which colour macOS reported, and is set
  // unconditionally so it never goes stale when the host stops answering.
  const accent = theme.accent || '#007aff';
  root.style.setProperty('--fold-accent', accent);
  root.style.setProperty('--fold-accent-fallback', accent);

  root.dataset.appearance = theme.isDark ? 'dark' : 'light';
  root.dataset.accentIsFallback = String(theme.accentIsFallback);

  for (const [name, value] of Object.entries(theme.groupColors)) {
    if (value) root.style.setProperty(`--group-${name}`, value);
  }

  applied = true;
}

/**
 * The OS appearance can change while a surface is open. Appearance is
 * media-query driven so CSS follows it for free, but the host-reported
 * `data-appearance` has to be re-fetched to stay in step.
 */
export function watchAppearance(): void {
  matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (applied) void applyTheme();
  });
}