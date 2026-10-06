#!/usr/bin/env bash
#
# Generate the GPG key used to sign Termax release artifacts, then print the
# values to store as GitHub Actions secrets.
#
# Run this once, on a machine you control. The private key never leaves your
# machine except as the encrypted-at-rest GitHub secret.
#
#   ./scripts/gen-signing-key.sh "Termax Releases" "releases@example.com"
#
# Produces:
#   - a 4096-bit RSA signing key in your local keyring
#   - termax-signing-key.asc  (public key, commit this to the repo)
#   - printed secrets: GPG_PRIVATE_KEY, GPG_KEY_ID, GPG_PASSPHRASE
#
set -euo pipefail

NAME="${1:-Termax Releases}"
EMAIL="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBKEY="$REPO_ROOT/termax-signing-key.asc"

if [[ -z "$EMAIL" ]]; then
  echo "usage: $0 <name> <email>" >&2
  exit 2
fi

command -v gpg >/dev/null || { echo "gpg not found — install GnuPG first." >&2; exit 1; }

echo "==> A passphrase protects the key. Pick a strong one; you will store it"
echo "    as the GPG_PASSPHRASE secret."
read -rsp "Passphrase: " PASSPHRASE; echo
read -rsp "Confirm:    " PASSPHRASE2; echo
[[ "$PASSPHRASE" == "$PASSPHRASE2" ]] || { echo "Passphrases differ." >&2; exit 1; }
[[ -n "$PASSPHRASE" ]] || { echo "Empty passphrase rejected." >&2; exit 1; }

echo "==> Generating key for $NAME <$EMAIL> (this can take a moment)"
gpg --batch --pinentry-mode loopback --passphrase "$PASSPHRASE" \
  --quick-generate-key "$NAME <$EMAIL>" rsa4096 sign 3y

# Long-form fingerprint of the key we just made; used as _gpg_name for rpmsign
# and as the identity users verify against.
KEY_ID="$(gpg --list-secret-keys --with-colons "$EMAIL" | awk -F: '/^fpr:/ {print $10; exit}')"

echo "==> Exporting public key to $PUBKEY"
gpg --armor --export "$KEY_ID" > "$PUBKEY"

echo
echo "==================== GitHub Actions secrets ===================="
echo
echo "GPG_KEY_ID:"
echo "$KEY_ID"
echo
echo "GPG_PASSPHRASE:"
echo "<the passphrase you just typed>"
echo
echo "GPG_PRIVATE_KEY (paste the whole block, including BEGIN/END lines):"
echo
gpg --batch --pinentry-mode loopback --passphrase "$PASSPHRASE" \
  --armor --export-secret-keys "$KEY_ID"
echo
echo "==============================================================="
echo
echo "Add them with the gh CLI:"
echo
echo "  gh secret set GPG_KEY_ID --body '$KEY_ID'"
echo "  gh secret set GPG_PASSPHRASE"
echo "  gpg --armor --export-secret-keys $KEY_ID | gh secret set GPG_PRIVATE_KEY"
echo
echo "Then commit the public key so users can verify releases:"
echo
echo "  git add termax-signing-key.asc && git commit -m 'Add release signing public key'"
echo
echo "Optionally publish it to a keyserver:"
echo
echo "  gpg --keyserver hkps://keys.openpgp.org --send-keys $KEY_ID"
