# Privacy Policy for Fold - On-Device Tab Organizer

**Last updated:** October 5, 2026

## Summary

Fold has no servers and no third parties. Tab grouping runs entirely on your Mac
using the language model built into macOS, so tab titles and URLs never leave your
device. The extension declares no host permissions and holds no API keys.

## Data Collection

Fold does **not** collect:
- Personal information (name, email, account details)
- Browsing history beyond the current window's open tabs
- Analytics, telemetry, or usage tracking data
- Cookies or cross-site tracking identifiers

## Data Stored Locally

The following data is stored in your browser's `chrome.storage` area and never leaves
your device:

- **Extension settings** — behavior preferences and UI options
- **Domain rules** — custom rules you create for grouping specific domains
- **Learning data** — domain affinity scores, correction history, rejection memory, and co-occurrence patterns used by the Smart Learning system
- **Pinned groups** — group names you've pinned to survive re-organization
- **Usage statistics** — organize count, tabs grouped count, and model token totals, stored locally for your reference

You can export or delete all stored data at any time from the extension's settings page.

## Data Sent to Third Parties

**None.** There is no cloud provider to configure and no API key to store.

Tab titles and URLs are passed to a native messaging host on your own machine, which
hands them to Apple's Foundation Models framework. That host makes no network
requests. The extension itself contacts no hosts: `manifest.json` declares no
`host_permissions`.

The Foundation Models framework may download its model assets from Apple the first
time it is used, the same way any on-device system feature does. That traffic comes
from macOS, not from this extension, and carries no browsing data.

## The native host

Fold cannot call Swift frameworks directly from a browser extension, so it ships
with a small native messaging host (`../native/FoldAppleAIHost.swift`) that you compile
and install yourself via `scripts/install-native-host.sh`.

- It runs only while the browser asks it for a response.
- It reads requests from the browser and writes replies back. Nothing else.
- It contains no analytics, no logging, and no network code.

You can read the whole of it in one file.

## Permissions

Fold requests the following Chrome permissions:

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab titles and URLs to generate grouping suggestions |
| `tabGroups` | Create, modify, and remove tab groups |
| `storage` | Save your settings and learning data locally |
| `alarms` | Run scheduled re-organization and auto-organize checks |
| `contextMenus` | Add right-click menu options for quick access |
| `windows` | Support consolidate-windows feature |
| `nativeMessaging` | Talk to the local Apple AI host process |

No host permissions are requested, so the extension cannot reach the network at all.

## Children's Privacy

Fold is not directed at children under 13 and does not knowingly collect data from children.

## Changes to This Policy

If this policy is updated, the changes will be published in this file in the extension's repository with an updated date. Continued use of the extension after changes constitutes acceptance.

## Contact

If you have questions about this privacy policy, open an issue at: https://github.com/raidel-a/fold/issues
