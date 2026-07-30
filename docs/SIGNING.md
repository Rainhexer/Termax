# Code signing and release integrity

Termax is signed without paying for a certificate. This document describes what
is signed, how, what each signature actually protects against, and how to set up
the secrets in a fork.

Everything here is free: no Apple Developer Program membership ($99/yr), no
Authenticode certificate from a CA ($100–400/yr).

## Summary

| Platform | Mechanism | Cost | Removes the OS warning? |
|----------|-----------|------|-------------------------|
| macOS | Ad-hoc `codesign` (`signingIdentity: "-"`) + hardened runtime | free | **No** — see [macOS](#macos) |
| Windows | Authenticode with a self-signed certificate, SHA-256 + RFC-3161 timestamp | free | **No** — see [Windows](#windows) |
| Linux | GPG: RPM header signatures + detached `.asc` per artifact | free | n/a (no such warning) |
| All | Signed `SHA256SUMS` manifest | free | n/a |

Be clear-eyed about the limits: **only a paid Apple Developer identity plus
notarization removes the Gatekeeper prompt, and only a CA-issued certificate
with accumulated reputation removes the SmartScreen prompt.** What the free
approach buys is real but different: the app launches at all on Apple Silicon,
users get a stable publisher identity, and anyone can verify a download was not
tampered with in transit or on a mirror.

## macOS

`bundle.macOS.signingIdentity` is `"-"` in `src-tauri/tauri.conf.json`, so
`tauri build` ad-hoc signs the `.app` before packing the `.dmg`. No account, no
certificate, no secrets — it works on any Mac with the Xcode command line tools,
including CI.

What ad-hoc signing fixes:

- **Apple Silicon refuses to execute unsigned arm64 binaries at all.** An
  unsigned universal build is killed on launch ("is damaged and can't be
  opened"). Ad-hoc signing is what makes the build runnable.
- Stable code identity, so macOS keychain items and TCC permission grants
  (Files, Accessibility) survive app updates instead of being re-prompted.
- Tamper detection: `codesign --verify` fails if the bundle was modified after
  build.

What it does not fix: the app is not **notarized**, so a `.dmg` downloaded from
the internet carries the quarantine attribute and Gatekeeper shows "Apple could
not verify Termax is free of malware" on first launch. Users get past it once,
either way:

```sh
# Right-click Termax.app → Open → Open, or:
xattr -dr com.apple.quarantine /Applications/Termax.app
```

The hardened runtime is enabled with `src-tauri/entitlements.plist`. The JIT,
unsigned-executable-memory, and library-validation exceptions there are what a
terminal multiplexer needs — it spawns arbitrary developer tooling through a PTY
and renders its UI in a WebView. The app is deliberately **not** sandboxed.

CI fails the build if the ad-hoc signature is missing, because an unsigned
arm64 build is broken rather than merely inconvenient.

### Upgrading to notarization later

If a Developer ID becomes available, keep everything else and set these secrets;
`tauri-action` picks them up with no workflow change:
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Then change `signingIdentity`
from `"-"` to the Developer ID identity (or drop it so the env var wins).

## Windows

The workflow signs `Termax.exe` and the `.msi` with `signtool` during bundling,
using a certificate supplied as a secret. Generate a free self-signed one on a
Windows machine:

```powershell
./scripts/gen-windows-cert.ps1 -Subject "Ravn"
```

It prints the two secrets to set: `WINDOWS_CERTIFICATE` (base64 of the `.pfx`)
and `WINDOWS_CERTIFICATE_PASSWORD`. Store the `.pfx` offline — with the password
it can sign software under your name.

What a self-signed Authenticode signature buys:

- The installer's properties dialog shows a **Digital Signatures** tab with a
  consistent publisher, instead of "Unknown publisher".
- Tamper detection — Windows reports a broken signature if the `.msi` was
  modified after signing.
- An RFC-3161 timestamp, so signatures stay valid after the certificate expires.
- Users or admins who import the accompanying `.cer` into **Trusted Publishers**
  get a fully trusted install, which makes enterprise/GPO deployment possible.

What it does not buy: SmartScreen reputation. A self-signed certificate chains
to a root Windows does not trust, so first-run still shows "Windows protected
your PC" → **More info → Run anyway**. Signing status is unchanged from the
user's perspective until the certificate is CA-issued *and* the app accrues
download reputation.

If the secret is absent the workflow logs a warning and ships an unsigned `.msi`
rather than failing.

### The free path to a real certificate

[SignPath Foundation](https://signpath.org/) issues free code-signing
certificates to open-source projects, and signs through a hosted service. That
is the only genuinely free route to a CA-issued signature (Azure Trusted
Signing, the cheapest paid alternative, is ~$10/month). Approval takes an
application and a few weeks. If it comes through, replace the
`Prepare Windows code signing` step with SignPath's submission action; nothing
else in the release pipeline needs to change.

## Linux

Linux has no Gatekeeper equivalent, but package managers and users want to
verify provenance. The release job signs everything with the project GPG key:

- **`.rpm`** — `rpmsign --addsign` embeds a signature in the package header, so
  `rpm -K` and `dnf` verify it after `rpm --import termax-signing-key.asc`.
- **`.deb`, `.AppImage`, and every other artifact** — a detached armored
  signature (`<artifact>.asc`). `apt` does not verify standalone `.deb` files
  (only repositories), so a detached signature the user can check is the honest
  option here.
- **`SHA256SUMS` + `SHA256SUMS.asc`** — one signed manifest covering every
  artifact on every platform, including the `.dmg` and `.msi`.

The AUR package (`aur/PKGBUILD`) builds from source on the user's machine and
needs no signature.

### Creating the key

Run once, on a machine you control:

```sh
./scripts/gen-signing-key.sh "Termax Releases" "you@example.com"
```

It generates a 4096-bit RSA signing key, writes the public half to
`termax-signing-key.asc` (commit it), and prints the three secrets to set:
`GPG_PRIVATE_KEY`, `GPG_KEY_ID`, `GPG_PASSPHRASE`. Publishing the public key to
a keyserver is optional but helps:

```sh
gpg --keyserver hkps://keys.openpgp.org --send-keys <KEY_ID>
```

If `GPG_PRIVATE_KEY` is unset the workflow still releases, with an unsigned
`SHA256SUMS` and a warning in the run log and release notes.

## Verifying a release as a user

```sh
# From the release page, download your artifact plus SHA256SUMS,
# SHA256SUMS.asc, and termax-signing-key.asc, then:
gpg --import termax-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

Or, from a checkout of this repo:

```sh
./scripts/verify-release.sh ~/Downloads
```

`gpg --verify` prints a "key is not certified with a trusted signature" warning
until you sign the key locally — that is expected, and does not mean the
signature is bad. The line that matters is `Good signature from "Termax
Releases"` plus a fingerprint matching the one in this document's repo copy of
`termax-signing-key.asc`.

Platform-specific checks:

```sh
# macOS: ad-hoc signature intact
codesign --verify --deep --strict --verbose=2 /Applications/Termax.app

# Linux: RPM header signature
sudo rpm --import termax-signing-key.asc && rpm -K Termax-*.rpm
```

```powershell
# Windows: Authenticode signature
Get-AuthenticodeSignature .\Termax_0.1.0_x64_en-US.msi | Format-List
```

`Status: UnknownError` with a populated `SignerCertificate` is what a valid
self-signed signature looks like — the signature is intact, the root is just not
trusted by Windows. `NotSigned` means no signature at all.

## Secret reference

| Secret | Required | Effect if missing |
|--------|----------|-------------------|
| `GPG_PRIVATE_KEY` | for signed releases | Unsigned `SHA256SUMS` only; run logs a warning |
| `GPG_KEY_ID` | with the above | Signing step fails |
| `GPG_PASSPHRASE` | with the above | Signing step fails (unless the key has none) |
| `WINDOWS_CERTIFICATE` | for a signed `.msi` | `.msi` ships unsigned; run logs a warning |
| `WINDOWS_CERTIFICATE_PASSWORD` | with the above | Certificate import fails |

macOS ad-hoc signing needs no secrets.
