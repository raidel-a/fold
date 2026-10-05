# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Email **15664418+raidel-a@users.noreply.github.com** with:

- What the issue is
- How to reproduce it
- Which version you tested (the `manifest.json` version)

I will acknowledge within a few days. There is no bug bounty; this is a personal
project maintained in my own time.

## What matters most here

Fold's security posture is mostly about one property: **it cannot phone home.**

- `manifest.json` declares **no** `host_permissions`. The extension has no ability to
  make network requests on its own.
- `nativeMessaging` is the only permission that lets data leave the extension, and the
  host it talks to is a local binary you compile yourself.
- Tab titles and URLs go to that local binary and nowhere else. Inference happens
  through Apple's Foundation Models on-device.
- There is no telemetry, no analytics, and no third-party script anywhere in the build.

If you find a path by which tab data reaches the network, that is the highest-priority
report I could receive.

## Supply chain

Dependencies are dev-only (esbuild, vitest, typescript). The shipped extension has zero
runtime dependencies.

Secret scanning and push protection are enabled on this repository. If you fork it,
turn them on too:

**Settings → Code security and analysis → Secret scanning**

## Trusting the native host

The host is compiled from `native/FoldAppleAIHost.swift` in this repository. You should
read it before running it. `scripts/install-native-host.sh` compiles that source and
registers the result; it does not download anything.