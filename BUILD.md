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

## Notes

- **Code signing / notarization** is not configured. Unsigned macOS and Windows
  builds trigger Gatekeeper / SmartScreen warnings on first launch. Configure
  signing before wide distribution — see
  <https://v2.tauri.app/distribute/sign/>.
- **Type-check** the frontend without building: `npx svelte-check`.
- **Check** the backend without a full build: `cargo check` in `src-tauri/`.
