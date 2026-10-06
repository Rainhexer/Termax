# Architecture

Termax is a [Tauri v2](https://v2.tauri.app/) app: a Svelte 5 + TypeScript
frontend rendered in the system WebView, talking to a Rust backend over Tauri's
IPC. There is one window; projects, tabs and panes are all frontend state that
the backend persists.

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (Svelte + TS)         │  Backend (Rust)          │
│                                 │                          │
│  Home screen, sidebar, tabs     │  pty.rs      PTYs        │
│  Tiling layout + drag           │  vt.rs       screen model│
│  xterm.js terminal panes   ◄────┤  session.rs  watcher,    │
│  Monaco editor / diff           │              snapshots   │
│  Issues, PRs, worktrees         │  git.rs      git queries │
│  Command vault, settings        │  github.rs   `gh` CLI    │
│                                 │  merge.rs    3-way merge │
│                                 │  preview.rs  loopback    │
│                                 │              HTTP server │
└──────────────────────────────────────────────────────────┘
```

## Backend (`src-tauri/src`)

| Module | Responsibility |
|--------|----------------|
| `pty.rs`, `vt.rs` | Spawn shells and agents on a PTY (`portable-pty`) and keep a `vt100` screen model, used to detect agent state (working / awaiting input / idle) and when a turn ends. |
| `session.rs` | One session per open project: filesystem watcher (`notify`), pre-session snapshots, and the diff base for change tracking. |
| `git.rs` | Branch, status, diff and worktree operations via the `git` binary. |
| `github.rs` | Issues and pull requests through the `gh` CLI. Termax never touches a token. |
| `merge.rs` | Three-way (diff3) merge so an editor save never overwrites an agent's concurrent edits. |
| `fstree.rs` | File explorer operations, confined to the open session root. |
| `preview.rs` | Loopback HTTP server for HTML/SVG preview with live reload; per-server random token. |
| `home.rs` | Home-screen vitals and cross-project search; works only on registered project roots. |
| `trust.rs` | Folder trust gate: git is not run in a folder until the user trusts it. |
| `projects.rs`, `settings.rs`, `store_io.rs` | Persistent stores (`projects.json`, `settings.json`, `trusted.json`) with atomic writes and corrupt-file backup. |
| `open_folder.rs` | Single-instance handling and "open this folder" from the desktop shell / Dock. |
| `diag.rs` | Periodic resource snapshot log for diagnosing slowdowns in release builds. |
| `proc.rs` | Shared helpers for spawning child processes (hides console windows on Windows). |

## Frontend (`src`)

- `App.svelte` — shell, global shortcuts, routing between home screen and project view.
- `lib/components/` — UI: `TilingLayout`, `TerminalPane`, `EditorPane`, `Sidebar`, `ChangesPanel`, `FileTree`, `Issues`, `PullRequests`, `WorktreesPanel`, `CommandVault`, `HomeScreen`, settings, and modals.
- `lib/stores.ts`, `settings.ts`, `layout.ts` — Svelte stores for projects, layout and settings.
- `lib/ipc.ts` — typed wrapper over Tauri `invoke`.
- `lib/theme.ts` — theme model and built-in presets.
- `lib/cliStatus.ts`, `bell.ts` — agent activity detection and bell notifications.

## Security model

- **Minimal capabilities.** `src-tauri/capabilities/default.json` grants only core window/event permissions and the dialog plugin.
- **No outbound HTTP from the app.** The CSP restricts `connect-src` to IPC; GitHub access shells out to `gh`.
- **Folder trust** guards the one place a repository can execute code (`.git/config`).
- **Path confinement.** The frontend cannot name arbitrary directories: file and search operations resolve only inside a session root or a registered project root.
- **Preview isolation.** Loopback-only, token-prefixed URLs, sandboxed iframe.

## Persistence

All state is JSON in the platform app-data directory (see the README). Writes are atomic (temp file + rename); an unreadable file is renamed to `*.corrupt-<timestamp>` rather than silently replaced with defaults.
