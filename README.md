# Fold

Folds browser tabs into groups using the model built into macOS. No API key, no
account, no network calls, no cost.

Requires macOS 26+ on Apple silicon with Apple Intelligence enabled. Verified on an
M1 MacBook Air, 16GB, macOS 27.2.

## Layout

```
native/FoldAppleAIHost.swift   Swift bridge: Foundation Models <-> native messaging
native/e2e.mjs                 End-to-end check against a real Helium instance
native/smoke.mjs               Framing/protocol smoke test, no browser needed
scripts/install-native-host.sh Compiles the host and registers it per-browser
scripts/shot.mjs               Screenshots the built extension, light or dark
scripts/MakeIcons.swift        Renders the SF Symbol app icon to PNG
extension/icons/               icon16/48/128.png, generated (not hand-edited)
extension/src/fold.css         Shared design tokens for both surfaces
extension/src/theme.ts         Applies macOS appearance + accent to the document
extension/                     The extension itself
```

## Setup

```bash
# 1. Install the native host (registers with Helium, Chrome, and Chromium)
./scripts/install-native-host.sh

# 2. Build the extension
cd extension && npm install && npm run build

# 3. Load extension/dist unpacked, then reload it
```

Settings → Model should read **Apple AI is ready**. Then hit **Fold all tabs**.

If you move the extension to a different directory, re-run the install script with the
new path so it can recompute the extension ID:

```bash
./scripts/install-native-host.sh /path/to/other/dist
```

## Contributing

Issues and pull requests are welcome. Pull requests are the only way in: `main` is
protected, CI must pass, and I merge after review. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and scope.

## Why a native host

Chromium extensions run in a sandbox with no access to Swift frameworks, and Apple
Foundation Models is a native API. `chrome.runtime.connectNative` is the supported
bridge, so the extension talks to a small stdio helper that wraps `LanguageModelSession`.

Two Chromium constraints shaped the design, both found by probing Helium:

- **Host names cannot contain hyphens.** `com.fold.apple-ai` is rejected with
  "Invalid native messaging host name specified." The host is `com.fold.appleai`.
- **`chrome-extension://*` wildcards no longer work.** Chrome only accepts an explicit
  extension ID, so the install script derives it by hashing the extension's absolute
  path (Chromium's unpacked-extension ID algorithm).

## Performance

Cold start is ~8s for the first inference, ~2s after. `groupWithUsage` budgets 120s
for the first call and 60s for warm ones.

The grouper chunks at **20 tabs**, which is measured rather than chosen: the model's
context window is 4096 tokens, and a chunk of 60 tabs needs ~4975 prompt tokens at
the default title length, ~8575 at the 200-character setting. It used to chunk at 60
and fail outright on any window above roughly 35 tabs. Re-measure with:

```bash
swiftc -O scripts/ProbeContext.swift -o scripts/probe-context && ./scripts/probe-context
```

Reusing one `LanguageModelSession` across chunks was benchmarked and is within noise
(+2% and -6% median across two runs), so each request gets its own:

```bash
swiftc -O scripts/BenchmarkSession.swift -o scripts/benchmark-session && ./scripts/benchmark-session
```

Grouping uses a Foundation Models `GenerationSchema` rather than asking for JSON in
prose. The host returns decoded groups, so the extension never parses model output,
and the format rules left the prompt: a six-tab fold costs 302 input tokens rather
than 367.

## Interface

```
Popup                      340px panel. Fold all tabs, review, apply.
Settings  Model            Status card for the single backend, plus a test round trip.
          Folding          Group shape, automatic behaviour, schedule.
          Learning          What Fold remembers, activity counters, import/export.
          Rules             Pinned groups and domain rules.
          Tools             One-off jobs, snooze, workspaces.
```

Design tokens live in one shared file, `extension/src/fold.css`, so the two surfaces
cannot drift. Appearance and accent come from macOS rather than a hardcoded brand
colour: the native host reports `NSColor.controlAccentColor` and the nine group colors,
and `src/theme.ts` writes them as CSS variables.

The toolbar icon is the SF Symbol `questionmark.folder.fill`, rasterised at build time
because Chrome takes bitmaps only. The background is transparent and the art is fitted
to the full canvas width, painted in the system accent.

The symbol knocks its question mark out of the folder body, so that mark is a genuine
cut-out and shows whatever the browser paints behind the icon. It stays legible on both
light and dark toolbars, which is why the weight steps up to bold at 16px.

```bash
swiftc -O scripts/MakeIcons.swift -o scripts/make-icons
./scripts/make-icons extension/icons                     # accent from macOS
./scripts/make-icons extension/icons qmark.folder FF9500 # symbol and colour override
```

```bash
node scripts/shot.mjs dark      # screenshots into shots/
node scripts/shot.mjs light
node scripts/shot-progress.mjs "$PWD/extension/dist" "Grouping 60 of 140" 0.43
```

## Verifying

```bash
cd extension && npm test                             # 400 unit tests
node native/smoke.mjs '{"prompt":"Reply with exactly: OK"}'
node native/smoke.mjs '{"op":"theme"}'               # accent + palette the host reports
node native/e2e.mjs "$PWD/extension/dist" "$PWD/native/fold-appleai-host"
```

The e2e run loads the built extension into a throwaway Helium profile, checks that the
model-picker controls are absent from the DOM, confirms the accent arrived from the
host, opens real tabs, and confirms `organize` returns real groups. It prints the model
output rather than asserting specific groupings, since an on-device model groups
loosely.

## Accessibility

The status card and surfaces respond to `prefers-reduced-motion`,
`prefers-reduced-transparency`, and `prefers-contrast`. Reduced motion keeps the state
change and drops the movement: the checking pulse becomes a static dot, and the status
card cross-fades instead of sliding. Buttons give feedback on pointer-down.

## Privacy

Runs entirely on this Mac. The manifest declares **no** `host_permissions`, so the
extension cannot reach the network at all; `nativeMessaging` is the only way out. Tab
titles and URLs go to the local Swift host and nowhere else. See
[extension/PRIVACY.md](extension/PRIVACY.md).

---

## Credits

Fold is a fork of [gTabs](https://github.com/vaddisrinivas/gtabs) by
[@vaddisrinivas](https://github.com/vaddisrinivas), MIT licensed. Upstream is the
original work; this fork removes every model except Apple's, renames the project, and
rebuilds the interface around macOS. Full upstream history and license terms are
preserved in [`extension/LICENSE`](extension/LICENSE) and the repository's commit
history.