# Termix >_0

[![Download](https://img.shields.io/badge/Download-Latest_Release-4A90D9?style=for-the-badge)](https://github.com/FlyvendeMus/Termix/releases/latest) [![Donate](https://img.shields.io/badge/Donate-Support_Termix-FF6B6B?style=for-the-badge)](https://rainhexer.space/donate)

**A terminal multiplexer built for AI coding agents.** Tile terminals, track changes, and launch Claude Code or any other agent — all inside one focused window on **Linux**, **macOS**, and **Windows**.

## In action

<table>
  <tr>
    <td align="center"><img src=".github/screenshots/demo-overview.png" width="640" alt="Termix overview"><br>Tiled terminals with sidebar and change tracking</td>
  </tr>
  <tr>
    <td align="center"><img src=".github/screenshots/demo-split.gif" width="640" alt="Drag-to-split terminals"><br>Split and resize panes freely</td>
  </tr>
</table>

## What makes Termix different

### Command Vault

Save frequently-used commands per project. Execute them in any terminal pane with a single click — no more re-typing long `docker run`, `npm run`, or agent invocations.

<table>
  <tr>
    <td align="center"><img src=".github/screenshots/vault-demo.gif" width="480" alt="Command vault"><br>Commands saved per project, one click to fire</td>
  </tr>
</table>

### Git-aware change tracking

Termix watches your project during an agent session. Every file creation, edit, and deletion is captured and diffed against a pre-session snapshot. When git is present the diff runs against the last commit; otherwise a snapshot is taken at session start.

<table>
  <tr>
    <td align="center"><img src=".github/screenshots/diff-view.png" width="480" alt="Diff view in Monaco"><br>Monaco DiffEditor with syntax-highlighted overlays</td>
  </tr>
</table>

### First-class coding agent integration

Termix auto-detects installed agents on `$PATH` and adds them to the sidebar. Launch them into any pane with one click. Each launcher shows its detected version.

```
                          ┌─────────────────────────────────┐
                          │          Termix Sidebar          │
                          │                                  │
  ╔══════════════╗        │  ▶  Shell                        │
  ║  Claude Code ║───────►│  ▶  Claude Code   v1.x.x        │
  ╚══════════════╝        │  ▶  OpenCode      v0.x.x        │
  ╔══════════════╗        │  ▶  Aider         v0.x.x        │
  ║  OpenCode    ║───────►│  ▶  Goose         v1.x.x        │
  ╚══════════════╝        │  ▶  Amp                         │
  ╔══════════════╗        │  ▶  Codex                       │
  ║  Aider       ║───────►│  ▶  Gemini CLI    v0.x.x        │
  ╚══════════════╝        │  + Add custom launcher…         │
  ╔══════════════╗        └─────────────────────────────────┘
  ║  Goose       ║───────►  Any CLI tool with a name and
  ╚══════════════╝          command — fully configurable
  ╔══════════════╗
  ║  Amp / Codex ║───────►  Multiple agents run side-by-side
  ╚══════════════╝          in the same project window
  ╔══════════════╗
  ║  Gemini CLI  ║───────►  Custom launchers for your own
  ╚══════════════╝          internal tools and scripts
```

## Features at a glance

**Tiled terminal emulator** — Full VT100/xterm support via xterm.js. Split panes horizontally or vertically, drag to resize, drag to reorder. Layout persists per project across restarts.

**Project-based workflow** — Each project is a directory. Terminal panes always root there. Switching projects restores your exact layout and open terminals.

**Integrated file explorer** — Browse and open files without leaving Termix. Monaco Editor opens inline for quick edits.

**Configurable appearance** — Font family, size, cursor style, and color theme — all tunable from settings.

## Tech stack

| Layer | Technology |
|-------|------------|
| Shell | Tauri v2 (Rust) |
| Frontend | Svelte + TypeScript |
| Terminal | xterm.js + xterm-addon-fit |
| Editor / Diff | Monaco Editor |
| PTY | portable-pty |
| File watching | notify |
| Diffing | similar |
| Styling | Tailwind CSS |

## Get Termix

Pre-built binaries are available on the [Releases page](https://github.com/FlyvendeMus/Termix/releases).

To build from source, see [BUILD.md](BUILD.md). The build produces a `.deb`, `.rpm`, or `.AppImage` on Linux; a `.dmg` on macOS; an `.msi` on Windows.

## Where things live

| What | macOS | Linux | Windows |
|------|-------|-------|---------|
| Settings (`settings.json`) | `~/Library/Application Support/dev.ravn.termix/` | `~/.config/dev.ravn.termix/` | `%APPDATA%\dev.ravn.termix\` |

## Documentation

- **[BUILD.md](BUILD.md)** — building and packaging for each platform
- **[TERMIX.md](TERMIX.md)** — product specification and architecture
