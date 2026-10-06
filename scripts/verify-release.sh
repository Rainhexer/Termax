#!/usr/bin/env bash
#
# Verify downloaded Termax release artifacts.
#
#   ./scripts/verify-release.sh <dir-with-downloads>
#
# Expects the directory to contain the artifact(s) you downloaded plus the
# release's SHA256SUMS and SHA256SUMS.asc. The signing public key is read from
# termax-signing-key.asc in this repo, or from your keyring if already imported.
#
set -euo pipefail

DIR="${1:-.}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBKEY="$REPO_ROOT/termax-signing-key.asc"

command -v gpg >/dev/null || { echo "gpg not found — install GnuPG first." >&2; exit 1; }

cd "$DIR"
[[ -f SHA256SUMS && -f SHA256SUMS.asc ]] || {
  echo "SHA256SUMS and SHA256SUMS.asc must be in $DIR (download them from the release page)." >&2
  exit 1
}

if [[ -f "$PUBKEY" ]]; then
  echo "==> Importing signing key from $PUBKEY"
  gpg --quiet --import "$PUBKEY"
fi

echo "==> Verifying SHA256SUMS signature"
gpg --verify SHA256SUMS.asc SHA256SUMS

echo "==> Checking hashes of the files present here"
# Only check lines whose file was actually downloaded; a release contains every
# platform's artifacts and you normally grab one.
FOUND=0
while read -r hash name; do
  [[ -f "$name" ]] || continue
  printf '%s  %s\n' "$hash" "$name" | sha256sum --check -
  FOUND=$((FOUND + 1))
done < SHA256SUMS

if [[ $FOUND -eq 0 ]]; then
  echo "No listed artifacts found in $DIR — nothing to check." >&2
  exit 1
fi

echo "==> $FOUND artifact(s) verified."
