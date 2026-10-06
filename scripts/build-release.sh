#!/usr/bin/env bash
#
# Build Termax release bundles.
#
#   ./scripts/build-release.sh [cargo-tauri args...]
#
# Thin wrapper around `cargo tauri build` that works around a known AppImage
# packaging failure: the appimagetool bundled inside tauri's cached
# linuxdeploy-plugin-appimage tries to download the AppImage runtime from
# GitHub at build time, and that download can fail with "server returned
# status code 0" on some networks even though a plain curl works. The plugin
# honours the LDAI_RUNTIME_FILE environment variable, so this script fetches
# the runtime once into the tauri cache and points the plugin at it.
#
set -euo pipefail

RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64"
RUNTIME_FILE="${LDAI_RUNTIME_FILE:-$HOME/.cache/tauri/runtime-x86_64}"

if [[ ! -s "$RUNTIME_FILE" ]]; then
  echo "==> Downloading AppImage runtime to $RUNTIME_FILE"
  mkdir -p "$(dirname "$RUNTIME_FILE")"
  curl -fsSL -o "$RUNTIME_FILE" "$RUNTIME_URL" \
    || { echo "Failed to download $RUNTIME_URL" >&2; exit 1; }
fi

echo "==> Using AppImage runtime at $RUNTIME_FILE"
LDAI_RUNTIME_FILE="$RUNTIME_FILE" cargo tauri build "$@"