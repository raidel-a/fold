# Fold — Tab Organizer for Apple Silicon

<div align="center">
  <br/>

  **Your tabs are a mess. One click fixes that.**

  Fold organizes your tabs into color-coded groups using the on-device model built
  into macOS. No API key, no account, no network calls. It learns from your
  behavior, remembers your corrections, and gets smarter over time.

  <br/>

  [Star on GitHub](https://github.com/raidel-a/fold) · [Report Issue](https://github.com/raidel-a/fold/issues)

  <br/>
</div>

---

## What's New in v1.0

**One model, on-device** — Apple AI is the only backend. There is no provider picker, no API key, and no network access at all.

**Interface rebuilt** — macOS-native design with system font, translucent materials, and light/dark that follows the OS. Settings is now a System Settings-style sidebar: Model, Folding, Learning, Rules, Tools.

**Reads your system appearance** — the accent colour and tab-group palette come from macOS itself, so Fold matches the rest of your setup instead of shipping a brand colour.

---

## What's New in v0.5.1

**Service Worker Reliability** — Fold now rebuilds Chrome context menus with a full cleanup pass, serializes overlapping tab-group rebuilds, and ignores duplicate context menu ID errors during reload. This fixes MV3 service worker startup failures like `Cannot create item with duplicate id fold-add-to-group`.

## What's New in v0.5

**Smart Learning** — Fold now learns from every interaction. Corrections you make before applying count 3x. Groups you remove are remembered and avoided. Domain affinity is weighted by frequency and recency with a 14-day decay half-life.

**Scheduled Re-org** — Set daily or weekly automatic re-organization at a time you choose. Wake up to perfectly organized tabs.

**Pinned Groups** — Mark groups as permanent so they survive re-organization. Pin "Comms" once, never lose it.

**Group Health** — Drift detection warns when groups become incoherent. Merge/split suggestions appear when groups overlap or grow too large.

**Smarter Routing** — New tabs opened from an existing grouped tab automatically join that group. Path-level affinity means `github.com/myorg` and `github.com/trending` can map to different groups.

---

## Features

### Organize

| | |
|---|---|
| **One-click Fold** | Groups every tab in your window by topic |
| **Ungrouped Only** | Only touches tabs not already in a group |
| **Suggestion-first UX** | Review, rename, recolour, remove — then apply |
| **Undo** | Instantly restores the previous tab arrangement |
| **Smart Merge** | Pre-assigns tabs to existing groups by title similarity before calling the model |

### Learn

| | |
|---|---|
| **Weighted Affinity** | Tracks how often each domain is placed in each group, decays stale patterns over 14 days |
| **Path-level Affinity** | `github.com/myorg` maps separately from `github.com/trending` for multi-tenant sites |
| **Correction Tracking** | When you rename groups or move tabs before applying, those edits are remembered as 3x signals |
| **Rejection Memory** | When you remove a suggested group, Fold remembers to avoid that grouping for 30 days |
| **Pattern Mining** | Discovers domains that are frequently grouped together and uses them as co-occurrence hints |
| **Opener Awareness** | New tabs opened from an existing grouped tab prefer joining that group |

### Maintain

| | |
|---|---|
| **Scheduled Re-org** | Daily or weekly automatic re-organization at a configurable time |
| **Pinned Groups** | Mark groups as permanent — they survive re-organization |
| **Group Drift Detection** | Warns when groups become incoherent and may need refreshing |
| **Merge/Split Suggestions** | Detects overlapping groups (>60%) and oversized groups (>10 tabs, >5 domains) |
| **Stale Tab Purge** | Remove inactive tabs older than a configurable threshold |

### Tools

| | |
|---|---|
| **Focus Mode** | Collapses all groups except the active one |
| **Sort Groups** | Alphabetically sorts tabs by domain within each group |
| **Clear Groups** | Ungroups everything in the current window |
| **Duplicate Detection** | Finds tabs with the same URL |
| **Instant Routing** | Routes new tabs into existing groups via affinity, with no model call |
| **Domain Rules** | Hard-wire `github.com` or `*.example.com` to `Dev`, always, skipping the model entirely |

### Model

The only model is the one macOS ships. There is nothing to choose and nothing to
pay for.

| Model | Cost | Setup |
|---|---|---|
| **Apple AI** (Foundation Models) | Free | macOS 26+ on Apple silicon, plus the native host below |

---

## Apple AI Setup

Fold groups tabs with the on-device model from macOS 26+ via Foundation Models. No
API key, no account, no cost, and no network calls.

Requirements:

- macOS 26 or newer on Apple silicon
- Apple Intelligence enabled in System Settings
- The native host installed from `../scripts/install-native-host.sh`

Browser extensions cannot call Swift frameworks, so Fold bridges through a native
messaging host: a small compiled binary that wraps `LanguageModelSession`. Install
it once per machine, then reload the extension. Settings → Model shows a status
card that reads **ready** once the host answers, and explains what to fix if it does
not.

Two Chromium quirks shaped this, both found by probing rather than from docs:

- Native messaging host names cannot contain hyphens, so the host is `com.fold.appleai`.
- `chrome-extension://*` wildcards are rejected for native hosts, so the install
  script derives your unpacked extension ID by hashing its path and writes it in.

---

## Quick Start

```bash
# From the parent directory of this checkout:
./scripts/install-native-host.sh    # compile + register the native host
cd extension && npm install && npm run build
```

Then load `extension/dist` unpacked from your browser's extensions page and reload it.

If you move the extension to a different directory, re-run the install script with
the new path so it can recompute the extension ID:

```bash
../scripts/install-native-host.sh /path/to/other/dist
```

Settings → Model shows **Apple AI is ready** once the host answers. Then hit
**Fold all tabs**. There is nothing to configure.

---

## How It Works

```
User clicks "Fold all tabs"
  |
  |-- Domain rules applied instantly (no model call)
  |
  |-- Smart merge: title-match ungrouped tabs to existing groups
  |
  |-- Remaining tabs sent to the on-device model with:
  |     |-- Weighted affinity   (github.com -> "Dev" 12x, recent)
  |     |-- Correction signals  (user moved amazon.com to "Shopping" 3x)
  |     |-- Rejection signals   (AVOID: news.com in "Dev")
  |     |-- Co-occurrence       ([github.com, stackoverflow.com] often together)
  |     |-- Opener hints        (Tab 5 opened from Tab 2)
  |     |-- History patterns    (50 past groupings summarized)
  |     '-- Prompt: "Group into max N groups, return JSON"
  |
  |-- Response parsed -> editable suggestion cards shown
  |
  '-- User reviews -> Apply -> chrome.tabs.group()
        |-- Weighted affinity updated (frequency + timestamp)
        |-- Path-level affinity updated for multi-tenant sites
        |-- History recorded, token usage recorded
        '-- Corrections captured if user edited before applying
```

---

## Architecture

```
Popup / Options UI
       |
Background Service Worker
   |-- Native bridge (chrome.runtime.sendNativeMessage)
   |     '-- ../native/FoldAppleAIHost.swift -> LanguageModelSession
   |-- Grouper (prompt builder, parser, domain rules, title matching)
   |-- Storage (weighted affinity, corrections, rejections, co-occurrence, history)
   '-- Chrome APIs (tabs, tabGroups, alarms, storage)
```

| File | Role |
|------|------|
| `types.ts` | All interfaces — weighted affinity, corrections, rejections, settings |
| `storage.ts` | Chrome storage wrapper — migration, decay math, summarizers |
| `grouper.ts` | Prompt builder, JSON parser, title matching, domain rules |
| `llm.ts` | The single model path: framing, timeouts, token counts |
| `background.ts` | Service worker — orchestration, drift detection, scheduled re-org |
| `popup.ts/html` | Action popup — fold, pin, correct, reject, merge/split |
| `options.ts/html` | Settings sidebar — model status, folding, learning, rules, tools |
| `theme.ts` | Applies macOS appearance and accent colour to the document |
| `fold.css` | Shared design tokens for both surfaces |

---

## Settings

The settings page is a sidebar with five sections.

### Model
- **Status card** — ready / unavailable, with the host's own explanation when it fails
- **Test model** — sends one prompt end to end; the first call pays the model-load cost

### Folding
- **Max Groups** (2–15) — limit the number of groups the model creates
- **Auto-fold Threshold** (2–25) — trigger when ungrouped tabs exceed this
- **Title Truncation** (20–200) — max tab title chars sent to the model
- **Stale Tab Age** (1–168h) — threshold for purging inactive tabs
- **Auto-fold** — silently group when threshold met
- **Protect Existing Groups** — only fold ungrouped tabs
- **Instant Routing** — route new tabs via affinity, no model call at all
- **Auto-pin Web Apps** — pin Gmail, Calendar, Jira, Spotify to the left
- **Schedule** — Off / Daily / Weekly, plus the hour it runs

### Learning
- **Correction Tracking** — learn from your edits before applying (on by default)
- **Rejection Memory** — remember removed groups and avoid them (on by default)
- **Group Drift Detection** — warn when groups become incoherent
- **Pattern Mining** — discover co-occurring domains from history
- **Drift Threshold** (20–80%) — coherence below which a group is flagged
- **Activity** — counters and real token counts, plus settings import/export

### Rules
- **Pinned Groups** — groups that survive all re-organization, as chips
- **Domain Rules** — hard-wire `github.com` or `*.example.com` to `Dev`, always,
  skipping the model entirely. CSV import/export included.

### Tools
- Duplicate detection, Focus Mode, Sort Groups, Clear Groups, Markdown export
- Snooze the active tab for a chosen duration
- Workspaces: save and restore a set of tabs and groups

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+G` / `Ctrl+Shift+G` | Fold all tabs |
| `Cmd+Shift+Z` / `Ctrl+Shift+Z` | Undo last grouping |

---

## Development

```bash
npm install          # install dev deps
npm test             # run 400 tests
npm run test:watch   # watch mode
npm run build        # build -> dist/
npm run dev          # watch + rebuild on change
```

---

## Native messaging justification

`manifest.json` requests the `nativeMessaging` permission. Chrome Web Store policy
requires a written justification. Use the following text when submitting:

> "The extension groups browser tabs using the language model built into macOS, via the
> Apple Foundation Models framework. Extensions run in a sandbox with no access to Swift
> frameworks, so the extension connects to a native messaging host that the user installs
> locally. That host performs inference entirely on-device and makes no network requests.
> Tab titles and URLs are never transmitted off the machine. The extension declares no host
> permissions and contacts no servers."

## Pre-submission checklist

- [ ] `nativeMessaging` justification included in the store listing (see above)
- [ ] Store screenshots match current UI
- [ ] Version bumped in `manifest.json` and `package.json`
- [ ] Note that native messaging hosts are installed per-machine, not by the store

---

## Contributing

PRs welcome. Run `npm test` before submitting. Zero runtime dependencies — keep it that way.

## License

MIT. See [LICENSE](LICENSE) for the full terms.

---

## Credits

Fold is a fork of [gTabs](https://github.com/vaddisrinivas/gtabs) by
[@vaddisrinivas](https://github.com/vaddisrinivas), MIT licensed. Upstream is the
original work; this fork removes every model except Apple's, renames the project, and
rebuilds the interface around macOS. Upstream's copyright and license terms are
preserved verbatim in [LICENSE](LICENSE).
