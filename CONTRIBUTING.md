# Contributing to Fold

Thanks for looking. Contributions are welcome, and everything lands through a pull
request that I review before merging.

## What gets accepted

- Bug fixes, especially anything touching tab grouping, storage, or the native host
- Interface work that follows the existing design language in `extension/src/fold.css`
- Tests. There are 400 of them and they are fast to run
- Documentation fixes

## What does not

- New model providers. Fold runs on Apple's on-device model and nothing else. That is
  the whole point, not an oversight.
- Anything that adds network access. The manifest declares no `host_permissions` and
  that is deliberate.
- Restyling for its own sake. Match what's there.

## Ground rules

Keep the diff focused. Do not reformat code you are not otherwise touching.

## Setup

Fold calls Apple Foundation Models through a native host, because a browser extension
cannot call Swift frameworks. Before anything works you need both pieces:

```bash
# Compile and register the native host (per-machine)
./scripts/install-native-host.sh

# Build the extension
cd extension && npm install && npm run build
```

Then load `extension/dist` unpacked from your browser's extensions page. Settings →
Model should read **Apple AI is ready**.

Requires macOS 26+ on Apple silicon with Apple Intelligence enabled. Tests are pure
TypeScript and run anywhere:

```bash
cd extension && npm test
```

## Submitting

1. Fork the repo and branch from `main`.
2. Make your change, with tests if it is testable.
3. Open a PR describing what changed and why.

I require one approving review, CI passing, and all review threads resolved before
merging. Squash merges only, so the history stays linear.

## Security

Do not open a public issue for a vulnerability. Email me instead; see
[SECURITY.md](SECURITY.md).