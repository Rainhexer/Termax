# Termix

A cross-platform terminal multiplexer and project manager for AI coding agents.

Built with **Tauri v2**, **Svelte**, **xterm.js**, and **Monaco Editor**.

## Overview

Termix is a single-window GUI application that tiles terminals and provides project management workflows for terminal-based coding agents (Claude Code, OpenCode, and others).

## Features

**Project-based workflow** — Each project is tied to a system directory. Terminal panes always root in the project directory. Launch coding agents or plain shells with one click.

**Tiled terminal emulator** — Built on xterm.js with full VT100/xterm support. Panes can be split, resized, and arranged in any layout. Multiple agents run side by side. Layout and open trerminals save when closes and stay consistant in each project.

**Change tracking** — Watches the project filesystem during agent sessions. Detects file creates, edits, and deletes. Diffs are computed against pre-session snapshots and displayed in Monaco DiffEditor with syntax-highlighted overlays.

**Command vault** — Save frequently used commands per project. Execute them in any terminal pane with a single click.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Tauri v2                    │
│  ┌─────────────────┐ ┌─────────────────────┐ │
│  │  Frontend        │ │  Rust Backend       │ │
│  │  (Svelte + TS)   │ │                     │ │
│  │                   │ │  • PTY management  │ │
│  │  • xterm.js       │◄┤  • File watcher    │ │
│  │  • Monaco Editor  │ │  • Diff engine     │ │
│  │  • Tiling layout  │ │  • Project store   │ │
│  │  • Command vault  │ │  • Agent launcher  │ │
│  └─────────────────┘ └─────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Tauri v2 (Rust) |
| Frontend | Svelte + TypeScript |
| Terminal | xterm.js + xterm-addon-fit |
| Diff/Editor | Monaco Editor (diff-navigator) |
| PTY | portable-pty |
| File watching | notify |
| Diffing | similar |
| State | Svelte stores |
| Styling | Tailwind CSS |
