# Changelog

## [Unreleased]
### Changed
- **Grouping is now schema-constrained.** The native host describes the response
  shape with a Foundation Models `GenerationSchema` and returns decoded groups,
  instead of the model being asked for JSON in prose and the result dug out of a
  code fence with a regex. Removes a whole failure mode: one malformed response
  used to abort the entire fold with a parse error, and there was no retry.
  Measured 367 → 302 input tokens per fold, since the format rules left the prompt.
- `maxGroups` is now enforced after merging chunks. Chunks are grouped
  independently, so merging on name alone could return more groups than the user
  asked for; the smallest are folded into "Other" until the cap holds.
- The grouper prompt no longer restates the JSON format or lists the colours.
  That is the schema's job now.

### Added
- Chunking tests. `CHUNK_SIZE` and the merge path had no coverage: the existing
  "50+ tabs" test built exactly one chunk's worth of prompt and never exercised
  a merge. Now covers split sizes, per-tab assignment across chunks, token
  accumulation, and the group cap under disagreeing chunks.

## [1.0.0] - 2026-10-05
### Changed
- Renamed to **Fold**. The old name promised a choice of models; there is only one now.
- Interface rebuilt from scratch in a macOS-native language: system font, translucent
  materials, and light/dark that follows the OS. Replaces the previous purple-gradient design,
  which had no light mode at all.
- The settings page is now a System Settings-style sidebar (Model, Folding, Learning, Rules,
  Tools) instead of a four-tab strip, and the per-pane title and blurb update with it.
- The accent color now comes from macOS. The native host reports `NSColor.controlAccentColor`
  plus the nine group colors, and they arrive as CSS variables. A desaturated accent
  (graphite, which is what "Multicolor" returns) falls back to the system blue so the
  interface never reads as disabled.
- Group colour is a cycled swatch instead of a named dropdown: nine options fit in one row,
  so picking is one click rather than two.
- Inline SVG icons throughout; the previous emoji rendered in colour and ignored the palette.
- App icon replaced with the SF Symbol `questionmark.folder.fill`, rasterised by
  `scripts/MakeIcons.swift`. Transparent background, art fitted to the full canvas
  width, painted in the system accent so the icon tracks macOS. The symbol's question
  mark is a cut-out and therefore shows the browser background behind the icon, which
  reads correctly on both light and dark toolbars; weight steps up to bold at 16px to
  keep it open. Stale `icons/icon.svg` (the old emoji tile, unreferenced by the
  manifest) removed.
- `sendMsg` in both surfaces is typed from the message union, removing the `{}` indexing
  errors that this file previously carried.

### Fixed
- Domain rule inputs had two `class` attributes. The HTML parser silently drops the second,
  so `.rule-domain` was never in the DOM and editing a rule threw. Caught by the redesign
  tests.
- A failed model test now marks the model unavailable instead of leaving the optimistic
  probe result on screen.

## [0.6.0] - 2026-10-05
### Added
- Apple Foundation Models as the sole model, reached through a Swift native messaging host
  (`native/FoldAppleAIHost.swift`) with an installer at `scripts/install-native-host.sh`.
- In-settings model status card that reports ready/unavailable and surfaces the host's own
  explanation, plus a Test button that runs one prompt end to end.
- Token usage readout. Counts come from `SystemLanguageModel.tokenCount(for:)`, so they are
  real rather than estimated.

### Removed
- Every cloud provider (OpenAI, Anthropic, OpenRouter, Groq, xAI, Ollama) and the Chrome
  Built-in AI / Gemini Nano path, along with the provider picker, API key field, model
  dropdown, and Chrome flag setup guide.
- Cost tracking: `MODEL_PRICING`, per-provider USD totals, and the spending cap. On-device
  inference is free, so a USD figure was misleading.
- All `host_permissions`. The extension now declares none and cannot reach the network.

### Changed
- `Settings` no longer has `provider`, `model`, `baseUrl`, `apiKey`, or `spendingCapUSD`.
  Old stored values are dropped on load rather than carried forward.
- Settings sync no longer splits the API key into local storage, since there is no secret
  to keep local.
- Cold-start requests get a 120s budget (the first call loads the model); warm requests get
  60s.
- Reduced-motion, reduced-transparency, and increased-contrast support for the status card
  and surfaces, plus press feedback on buttons.

## [0.5.1] - 2026-05-17
### Fixed
- Rebuild context menus with a full `removeAll()` pass so stale child IDs cannot break service worker startup.
- Serialize overlapping context menu rebuilds from tab group events.
- Ignore duplicate context menu create errors during rebuild so Chrome reloads stay clean.

## [0.5.0] - 2026-04-09
### Added
- Tab Snooze — hide tabs temporarily and restore them at a chosen time.
- Workspace Management — save and restore full browser sessions with tab groups intact.
- Smart Ungrouping — tabs automatically leave a group when navigating to an unrelated domain.
- Tab Search — find and switch between tabs with real-time search across all open tabs.
- Group Stats — tab counts, domain breakdowns, and saved color preferences per group.
- Markdown Export — export tab groups as clean, shareable Markdown.
- Power Tools Panel — focus mode, duplicate cleanup, sorting, export, and stats in one place.
- Chrome AI (Gemini Nano) is now the default provider — runs fully on-device, no API key required.
- In-settings Chrome AI setup guide with copy buttons for required Chrome flag URLs.
- Spend limit (USD cap) to control API costs for cloud providers.

### Changed
- Tabbed Settings — reorganized into Provider, Behavior, Rules, and Tools tabs.
- Streamlined Popup — cleaner layout for faster organizing.
- Keyboard Navigation — arrow keys and Enter to move through suggestions.
- Chrome AI provider card now shows a step-by-step setup guide when flags are not yet enabled.

### Fixed
- Better error feedback for failed actions.
- Local-only API key storage — keys no longer sync across devices.
- Input sanitization to block prompt injection attempts.
- Improved recovery when tab state changes during batch actions.

## [0.4.8] - 2026-04-10
### Added
- New feature enhancements.

### Changed
- Improvements to existing features.

### Fixed
- Bug fixes and stability improvements.

### Security
- Addressed security vulnerabilities.

### Deprecated
- Some deprecated features that will be removed in future releases.

## [0.4.0] - 2025-12-15
### Added
- Initial version with foundational features.

### Changed
- Changes to improve performance.

### Fixed
- Initial bug fixes.

### Security
- Security updates included.

### Deprecated
- Initial deprecations noted.
