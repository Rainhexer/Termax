# Changelog

## 1.0.0

First stable release.

- Tiled terminal panes with drag-to-rearrange, per-project tabs and layout persistence, per-pane font zoom, and WebGL/canvas rendering.
- Agent launchers with `$PATH` detection and versions (Claude Code, OpenCode, Pi, Aider and more), custom launchers, live agent activity status, and a bell when a CLI's turn ends.
- Home screen with per-project git vitals, language breakdown, commit-activity grid, summary tiles and `Ctrl`+`K` cross-project search.
- Live change tracking with Monaco side-by-side diffs.
- Git worktrees with optional setup command; branch switching that follows worktrees.
- GitHub issues and pull requests via the `gh` CLI: create, view, merge with preflight, and hand an issue to an agent on a fresh worktree.
- Per-project command vault.
- File explorer with search, icons, multi-select, drag and drop, clipboard and undo; Monaco editor with Markdown / HTML / SVG / image preview and three-way-merged saves.
- Folder trust gate, minimal Tauri capabilities, no outbound network from the app.
- Themes: eight presets plus custom themes; custom borderless titlebar with merged tab strip.
- Signed releases for Linux (`.deb`, `.rpm`, `.AppImage`), macOS (`.dmg`) and Windows (`.msi`) with a GPG-signed `SHA256SUMS`.
- Licensed under GPL-3.0.
