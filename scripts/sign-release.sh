#!/usr/bin/env bash
#
# Sign a directory of built Termax release artifacts.
#
#   ./scripts/sign-release.sh <artifact-dir>
#
# For every artifact in the directory this produces:
#   - <artifact>.asc     detached, armored GPG signature
#   - SHA256SUMS         checksums for every artifact
#   - SHA256SUMS.asc     detached GPG signature over SHA256SUMS
#
# RPM packages are additionally signed in place with `rpmsign --addsign`, which
# embeds the signature in the package header so `rpm -K` / `dnf` can verify it
# without a separate file.
#
# Environment:
#   GPG_KEY_ID      fingerprint or email of the signing key (required)
#   GPG_PASSPHRASE  passphrase for that key (required; may be empty for an
#                   unprotected key)
#
# Requires bash 4+, GnuPG, and coreutils' sha256sum — i.e. Linux, or macOS with
# `brew install bash coreutils`. CI runs it on Linux.
#
set -euo pipefail

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "usage: $0 <artifact-dir>" >&2
  exit 2
fi

: "${GPG_KEY_ID:?GPG_KEY_ID is required}"
PASSPHRASE="${GPG_PASSPHRASE-}"

cd "$DIR"

# Collect the artifacts to sign: everything except signatures/checksums we
# generate ourselves and the public key we ship alongside them.
mapfile -t ARTIFACTS < <(
  find . -maxdepth 1 -type f \
    ! -name '*.asc' ! -name '*.sig' ! -name 'SHA256SUMS' \
    -exec basename {} \; | sort
)

if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
  echo "No artifacts found in $DIR" >&2
  exit 1
fi

echo "==> Signing ${#ARTIFACTS[@]} artifact(s) with $GPG_KEY_ID"

# A passphrase file keeps the secret off the process command line, where it
# would otherwise be visible to any local process listing.
PASSFILE="$(mktemp)"
trap 'rm -f "$PASSFILE"' EXIT
printf '%s' "$PASSPHRASE" > "$PASSFILE"

gpg_sign() {
  gpg --batch --yes --no-tty --pinentry-mode loopback \
    --passphrase-file "$PASSFILE" \
    --local-user "$GPG_KEY_ID" \
    --detach-sign --armor --output "$1.asc" "$1"
}

# --- RPM header signatures ------------------------------------------------
# Skipped with a warning if rpmsign is unavailable; the detached .asc
# signature below still covers the file either way.
shopt -s nullglob
RPMS=(*.rpm)
shopt -u nullglob
if [[ ${#RPMS[@]} -gt 0 ]]; then
  if command -v rpmsign >/dev/null; then
    # Debian/Ubuntu's rpm package defaults %__gpg to a gpg2 path that does not
    # exist there ("Could not exec gpg"), so point it at the real binary.
    GPG_BIN="$(command -v gpg)"
    for rpm in "${RPMS[@]}"; do
      echo "  rpmsign  $rpm"
      rpmsign \
        --define "__gpg $GPG_BIN" \
        --define "_gpg_name $GPG_KEY_ID" \
        --define "_gpg_sign_cmd_extra_args --batch --no-tty --pinentry-mode loopback --passphrase-file $PASSFILE" \
        --addsign "$rpm"
      # rpm stores the header signature under RSAHEADER/DSAHEADER depending on
      # key type (and SIGPGP for the legacy v3 signature), so check all three.
      rpm --query --queryformat \
        '%{RSAHEADER:pgpsig}|%{DSAHEADER:pgpsig}|%{SIGPGP:pgpsig}\n' -p "$rpm" 2>/dev/null \
        | grep -qi 'key id' \
        || { echo "rpmsign produced no header signature for $rpm" >&2; exit 1; }
    done
  else
    echo "::warning::rpmsign not found — .rpm header signatures skipped"
  fi
fi

# --- Detached signatures --------------------------------------------------
for f in "${ARTIFACTS[@]}"; do
  echo "  gpg      $f"
  gpg_sign "$f"
done

# --- Checksum manifest ----------------------------------------------------
# Written after RPM signing so the recorded hashes match the shipped files.
echo "==> Writing SHA256SUMS"
sha256sum "${ARTIFACTS[@]}" > SHA256SUMS
gpg_sign SHA256SUMS

echo "==> Verifying"
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --check --status SHA256SUMS
echo "All signatures verified."
