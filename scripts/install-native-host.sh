#!/usr/bin/env bash
# Compiles the Apple Foundation Models native host and registers it with every
# Chromium-family browser on this Mac, so Fold can reach SystemLanguageModel.
#
# Usage: ./scripts/install-native-host.sh [extension-dist-dir]
#
# The extension directory argument is optional. Chromium derives an unpacked
# extension's ID from the absolute path of its manifest directory, and native
# messaging hosts must name that ID explicitly: Chrome rejects
# "chrome-extension://*" wildcards. If omitted, the ID is computed from this
# checkout's own dist/ directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_SRC="$ROOT/native/FoldAppleAIHost.swift"
HOST_BIN="$ROOT/native/fold-appleai-host"
HOST_NAME="com.fold.appleai"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: Apple Foundation Models needs Apple silicon (this is $(uname -m))." >&2
  exit 1
fi

echo "==> Compiling $HOST_SRC"
swiftc -O -parse-as-library -target arm64-apple-macos27.0 "$HOST_SRC" -o "$HOST_BIN"
# Unsigned binaries get killed by Gatekeeper the moment a browser execs them.
codesign --force --sign - "$HOST_BIN" 2>/dev/null || echo "    (ad-hoc signing skipped)"

# Chromium's unpacked-extension ID: first 128 bits of SHA256(path), each hex
# nibble remapped onto a-p.
EXTENSION_ID="$(node -e '
  const crypto = require("crypto");
  const id = crypto.createHash("sha256")
    .update(process.argv[1])
    .digest("hex")
    .slice(0, 32);
  process.stdout.write([...id].map(c => "abcdefghijklmnopqrstuvwxyz"[parseInt(c, 16)]).join(""));
' "$(cd "${1:-$ROOT/extension/dist}" && pwd)")"
echo "==> Extension ID $EXTENSION_ID"

# Chrome resolves native messaging hosts under a per-browser directory. Registering
# for all of them means one install covers Helium, Chrome, and Chromium.
BROWSER_DIRS=(
  "$HOME/Library/Application Support/net.imput.helium/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

for dir in "${BROWSER_DIRS[@]}"; do
  # Only install where the browser actually keeps its profile.
  if [[ ! -d "${dir%/NativeMessagingHosts}" ]]; then
    echo "==> Skipping ${dir%/NativeMessagingHosts} (not installed)"
    continue
  fi
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Fold Apple Foundation Models bridge",
  "path": "$HOST_BIN",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "==> Registered $dir/$HOST_NAME.json"
done

echo
echo "Done. Reload the extension; Settings > Model should read 'Apple AI is ready'."
echo "If you move the extension to a different directory, re-run this script with the new path."