# Building Termax

Termax is a [Tauri v2](https://v2.tauri.app/) app: a Svelte + TypeScript
frontend bundled with a Rust backend into a single native binary.

## Prerequisites

- **Node.js** 18+ and npm
- **Rust** (stable) via [rustup](https://rustup.rs/)
- **Tauri platform dependencies** — follow the official prerequisites guide for
  your OS: <https://v2.tauri.app/start/prerequisites/>

Platform-specific system packages:

| OS | Requirements |
|----|--------------|
| **Linux** | `webkit2gtk4.1`, `librsvg2`, `libappindicator3`, `patchelf`, plus standard build tools (`build-essential`). For AppImage output: `libfuse2`. |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`). |
| **Windows** | Microsoft C++ Build Tools and the WebView2 runtime. `.msi` output requires the WiX Toolset (Tauri fetches it automatically). |

## Install

```sh
npm install
```

This pulls the frontend dependencies. Rust crates are fetched automatically on
the first build.

## Develop

```sh
npm run tauri dev
```

Runs the Vite dev server and launches the app with hot reload. The frontend
dev server alone (no native shell) is `npm run dev`.

## Build a release bundle

```sh
npm run tauri build && cp src-tauri/target/release/bundle/deb/Termax_0.1.0_amd64/data/usr/share/applications/Termax.desktop ~/.local/share/applications/termax.desktop
```

Output lands in `src-tauri/target/release/bundle/`. Configured bundle targets
(`src-tauri/tauri.conf.json` → `bundle.targets`):

| OS | Artifacts |
|----|-----------|
| **Linux** | `.deb`, `.rpm`, `.AppImage` |
| **macOS** | `.dmg` |
| **Windows** | `.msi` |

Tauri only produces the artifacts for the OS it runs on — build each platform on
that platform (or in CI with per-OS runners). To build a subset:

```sh
npm run tauri build -- --bundles deb,appimage
```

## Code signing

Releases are signed without any paid certificate. Full details, including the
limits of each mechanism, are in [docs/SIGNING.md](docs/SIGNING.md).

| Platform | How | Needs secrets? |
|----------|-----|----------------|
| **macOS** | Ad-hoc `codesign` + hardened runtime, configured in `tauri.conf.json` | no |
| **Windows** | Authenticode with a self-signed certificate, applied by `signtool` during bundling | yes |
| **Linux** | GPG: RPM header signatures plus detached `.asc` per artifact | yes |
| **All** | Signed `SHA256SUMS` manifest | yes |

Local `npm run tauri build` on macOS ad-hoc signs automatically (Xcode command
line tools provide `codesign`). Windows and Linux signing happens only in the
release workflow, where the certificate and GPG key live as repository secrets;
local builds on those platforms are unsigned, which is fine for development.

Two caveats worth stating plainly, since they are what users actually hit:

- macOS builds are ad-hoc signed but **not notarized**, so a downloaded `.dmg`
  still shows a Gatekeeper prompt on first launch. Notarization requires a paid
  Apple Developer identity.
- Windows builds signed with a self-signed certificate still trip SmartScreen.
  Removing that needs a CA-issued certificate — see the SignPath Foundation note
  in [docs/SIGNING.md](docs/SIGNING.md#the-free-path-to-a-real-certificate).

One-time setup for a fork:

```sh
./scripts/gen-signing-key.sh "Termax Releases" "you@example.com"  # GPG (Linux)
```

```powershell
./scripts/gen-windows-cert.ps1 -Subject "Your Name"               # Authenticode
```

Both scripts print the exact `gh secret set` commands to run.

To verify a signed release:

```sh
./scripts/verify-release.sh ~/Downloads
```

## Notes

- **Type-check** the frontend without building: `npx svelte-check`.
- **Check** the backend without a full build: `cargo check` in `src-tauri/`.
