# Settings & Command Vault: Import/Export + Cloud Sync

## Context

Termax persists everything the user configures in three JSON files under `app_data_dir()`
(`~/.local/share/dev.ravn.termax/`): `settings.json` (launchers, appearance/themes, terminal,
behavior), `projects.json` (projects + their vault commands + layout), and `trusted.json`.
Today there is no way to move that configuration to a second machine, and no backup — a
lost or reset app-data directory loses every custom theme, launcher, and vault command.

The goal is (a) a file bundle the user can export/import for backup and migration, and
(b) continuous, automatic sync between the user's own machines that requires **no user
account, no server infrastructure, and no third-party API integration**.

Two problems drove the design:

1. **Projects live at different absolute paths on different machines.** `Project.path` is a
   raw absolute path (`projects.rs:20`, not even canonicalized). It is meaningless on
   another machine and must never be synced.
2. **Sync without accounts or servers.** The direction considered first was OAuth
   integrations with Google Drive / Dropbox / OneDrive / Nextcloud. Rejected: a desktop app
   cannot keep a client secret, Google's verification review is heavy, four providers means
   four API surfaces and four token-refresh paths to maintain, and it would add outbound
   network access plus token storage to an app that currently has none.

**Chosen approach: a sync *folder*.** The user points Termax at a local directory their
existing cloud client already syncs — `~/Dropbox/Termax`, `~/Nextcloud/…`, Google Drive
desktop, iCloud Drive, Syncthing, or a git repo they push by hand. Their client does the
transport. This is the Obsidian / KeePass / Espanso / Zotero model. It means:

- No OAuth, no accounts, no server, no tokens.
- **No new Tauri capability and no CSP change.** `capabilities/default.json:7-11` grants only
  `core:*` + `dialog:default`, and `tauri.conf.json:22` sets `connect-src 'self' ipc:`.
  Everything here is plain file I/O through custom Rust commands. Any future proposal that
  needs `fs:`, `http:`, or a CSP relaxation should be rejected on those grounds.
- Privacy is whatever provider the user already chose, plus optional local encryption so the
  provider can't read vault commands at all.

Two hard parts and their resolutions:

- **Conflicts.** Cloud clients cannot merge concurrent edits to one file — they produce
  "conflicted copy" duplicates. So each machine writes **only** `devices/<deviceId>.json`.
  No two machines ever write the same path, so the provider never sees a conflict. Merge
  happens on read: last-writer-wins **per record** (per launcher, per theme, per vault
  command), never per file.
- **Paths.** A project's sync key is derived, in order: normalized git remote (reusing
  `git::normalize_remote_url`, `git.rs:288`) → `git:github.com/owner/repo`; else a path
  relative to a user-declared portable root (`~/Projects` on Linux ↔ `D:\dev` on Windows);
  else the project is dormant on this machine with a one-click "Link to local folder…".
  The synced record carries `{ key, name, commands[] }` and **no path**.

Decisions confirmed with the user: full phased plan; encryption planned but built last;
incoming commands flagged unreviewed until first run; layout sync off by default but
toggleable.

---

## Phase 1 — Bundle import/export (standalone shippable)

Phase 1 builds the record-stamp and merge machinery that Phase 2 then reuses unchanged.

### 1a. Change stamps — `src-tauri/src/sync_meta.rs` (new)

Merging needs a timestamp per record. None exist today. Stamps go in a **sidecar**,
`app_data_dir/sync-meta.json`, managed by a `SyncMetaStore` built on the same Mutex +
`store_io::write_json_atomic` shape as `ProjectStore` (`projects.rs:33-53`).

Sidecar rather than inline, and this is forced by the data: custom themes are opaque
`serde_json::Value` (`settings.rs:40`) and the frontend's `normalizeTheme`
(`src/lib/theme.ts:821-834`) rebuilds a fixed-shape object that **drops unknown keys** — an
inline `updatedAt` would be silently destroyed on every load→save round-trip. Scalar groups
(`terminal.scrollback`, `behavior.defaultBell`) have no inline home either. Keeping
`settings.json` / `projects.json` byte-shape unchanged also means zero migration risk.

```jsonc
{
  "schemaVersion": 1,
  "stamps": {
    "group:appearance":     { "at": 1753700000000, "synthetic": false },
    "group:terminal":       { "at": …, "synthetic": false },
    "group:behavior":       { … },
    "group:launcherOrder":  { … },
    "launcher:claude":      { … },
    "theme:custom-lx7q":    { … },
    "project:git:github.com/owner/repo":        { … },
    "command:git:github.com/owner/repo:<uuid>": { … }
  },
  "tombstones": {
    "launcher:aider": { "deletedAt": 1753600000000 },
    "project:root:projects/foo": { "deletedAt": … }
  },
  "launcherOrder": ["shell", "claude", "opencode"],
  "unreviewed": ["command:git:github.com/owner/repo:<uuid>"]
}
```

`synthetic: true` marks an *inferred* stamp. **Synthetic always loses to real in a merge** —
this is the single most important guard against a fresh install stomping a well-configured
remote.

**Diff-stamping (no frontend changes needed).** The frontend saves the whole settings object
(`src/lib/settings.ts:96-101` debounces 300ms then calls `ipc.saveSettings(get(settings))`),
so the backend infers what changed. In `settings::save_settings` (`settings.rs:180-188`),
before replacing the store value, compare incoming vs. current via `serde_json::to_value`:

- differing group (`appearance` minus `customThemes`; `terminal` minus `defaultShell`;
  `behavior`) → stamp that group `now`
- launcher present in both and differing, or newly present → stamp `launcher:<id>`;
  missing id → tombstone at `now`, drop its stamp
- custom theme by `id` → same, under `theme:<id>`
- launcher id sequence differs → stamp `group:launcherOrder`, record new `launcherOrder`

Projects stamp directly, since the CRUD is already granular: `add_project` (`projects.rs:60`),
`remove_project` (:81), `add_vault_command` (:104), `update_vault_command` (:130),
`remove_vault_command` (:159). `save_layout` (:87) does **not** stamp — layout is excluded by
default.

**Defaults are unstamped.** On first creation of `sync-meta.json`, do not stamp anything
byte-identical to `Settings::default()` (`settings.rs:102-133` — the three default launchers
and default appearance). A pristine install carries stamp 0 for those, so any remote value
beats them.

**Sidecar-loss rule.** If `sync-meta.json` is missing or corrupt but `settings.json` exists
(upgrade from a pre-sync build, or user deleted it), rebuild by stamping every non-default
record at the **mtime of `settings.json`**, marked `synthetic: true`. mtime never fabricates
recency; `synthetic` then guarantees a genuine remote edit wins. Do **not** route this
through `load_json_or_default` (`store_io.rs:29`) — a corrupt sidecar should be rebuilt, not
defaulted to empty.

### 1b. Portable model — `src-tauri/src/portable.rs` (new)

Pure data + pure functions, no Tauri types, so it is unit-testable and shared by both bundle
and shard code.

Types: `PortableState`, `PortableSettings { appearance, terminal, behavior }`,
`StampedLauncher`, `StampedTheme`, `PortableProject { key, name, commands, layout }`,
`StampedCommand`, `Tombstone`, `Stamp { at: i64, synthetic: bool }`.

- `collect(&Settings, &[Project], &SyncMeta, &PortableOpts) -> PortableState` — **the
  redaction chokepoint**, the only place that reads the live stores. It drops:
  - `terminal.default_shell` (machine-specific path, `settings.rs:72`)
  - every `Project.path` and `Project.id` (both machine-local; the uuid is meaningless
    elsewhere)
  - `Project.layout` unless `opts.include_layout`
  - anything from `trust.rs` — no sync module imports `trust`, and there is no code path from
    `collect` to `TrustStore`
- `apply(&MergedState, &mut Settings, &mut Vec<Project>, &mut SyncMeta, opts) -> ApplyReport` —
  writes merged content back, **preserving each local project's `id`, `path`, and `layout`**,
  and creating dormant projects (`path: ""`) for keys with no local match.

**Struct changes (deliberately minimal):**

- `projects::Project` (`projects.rs:16-25`) gains `#[serde(default)] pub key: Option<String>`
  — the cached portable key. `path` is now allowed to be `""`, meaning dormant/unlinked.
  Mirror in `src/lib/types.ts:9-17` as `key: string | null`. Every field is already
  `#[serde(default)]`, so old `projects.json` files load unchanged — **migration is a no-op**.
- Guard the new empty-path state at consumers: `openProject` (`src/lib/stores.ts:347`) must
  bail for `path === ""` and route to the bind flow. `add_project`'s `is_dir` check
  (`projects.rs:66`) stays for the user-driven path.
- No other struct changes anywhere.

### 1c. Merge core — `src-tauri/src/merge.rs` (new)

Written in Phase 1 because bundle-import-in-merge-mode needs exactly this algorithm; Phase 2
reuses it verbatim with N inputs instead of 2. Full spec in §2e.

### 1d. Generalize the file-transfer commands

`settings::write_theme_file` / `read_theme_file` (`settings.rs:192-209`) are already the right
shape. Widen and harden:

- Move to `store_io.rs` as `write_text_file` / `read_text_file`, keeping the `.json` extension
  gate verbatim (adjust error text), and **add a ~16 MiB read cap** so a mis-picked file can't
  balloon the webview.
- Add `store_io::read_json_strict<T>(path) -> Result<T, String>` — parses **without** the
  corrupt-file rename. `load_json_or_default` renames the offender to `.corrupt-<ts>`
  (`store_io.rs:40-44`); correct for our own app-data files, **catastrophic** in a shared sync
  folder where a rename propagates to every other machine as a delete. Phase 2 depends on this
  distinction — introduce it now, with a comment in `store_io.rs` explaining the split.
- Update `lib.rs:65-66`, `src/lib/ipc.ts:69-71`, and the two call sites in
  `src/lib/components/AppearanceSettings.svelte` (`exportFile` ~:283, `importFile` ~:315).

### 1e. Bundle format & commands — `src-tauri/src/bundle.rs` (new)

Suffix `.termax.json` (still passes the `.json` gate). Dialog filter
`{ name: "Termax bundle", extensions: ["json"] }`, default name
`termax-backup-<YYYY-MM-DD>.termax.json`.

```jsonc
{
  "termax": "bundle",
  "schemaVersion": 1,
  "exportedAt": 1753700000000,
  "appVersion": "0.1.0",
  "settings": {
    "appearance": { "sidebarWidth": 256, "themeId": "…", "theme": { … }, "updatedAt": ms },
    "terminal":   { "scrollback": 10000, "cursorStyle": "underline",
                    "cursorBlink": true, "oversizedLimitKb": 1024, "updatedAt": ms },
    "behavior":   { "defaultBell": false, "updatedAt": ms }
  },
  "launcherOrder": { "ids": ["shell","claude"], "updatedAt": ms },
  "launchers":    [ { "id","name","command","icon","enabled","updatedAt" } ],
  "customThemes": [ { "id", "theme": { …verbatim… }, "updatedAt" } ],
  "projects":     [ { "key": "git:github.com/owner/repo" | null, "name": "Termax",
                      "updatedAt": ms,
                      "commands": [ { "id","name","command","terminalType","updatedAt" } ] } ],
  "tombstones":   { "launchers": […], "customThemes": […], "projects": […], "commands": […] }
}
```

Note the deliberate difference from a sync shard: a bundle **may** carry `key: null` projects
(exported by name). A one-shot, user-supervised import with a preview screen tolerates
name-matching; unattended background sync cannot, so the sync publisher refuses keyless
projects (§2f).

Commands:

- `export_bundle(path, opts: ExportOptions) -> Result<(), String>` — builds via
  `portable::collect`, writes via `write_json_atomic`. Built in Rust, not TS, so redaction has
  exactly one implementation.
- `import_bundle_preview(path) -> Result<BundlePreview, String>` — parse, validate
  `termax == "bundle"`, check `schemaVersion <= SUPPORTED`, return counts **plus every
  launcher `command` and every vault `command` string** so the UI can show them before
  anything can execute (§security).
- `import_bundle_apply(path, opts: ImportOptions) -> Result<ImportReport, String>` —
  `opts: { settings, launchers, themes, projects: bool, mode: "merge" | "replace" }`. `merge`
  runs `merge.rs` with the bundle as one virtual peer (device id `import`); `replace` wipes
  the selected classes first. **Both write a pre-import backup** to
  `app_data_dir/backups/pre-import-<ts>.termax.json` and return its path.

Imported themes route through `normalizeTheme` before display. Rust-side length caps on
imported strings: names ≤ 200 chars, commands ≤ 8 KiB, icon markup ≤ 64 KiB. Everything
imported is added to `sync-meta.unreviewed`.

**Wiring:** `mod bundle; mod merge; mod portable; mod sync_meta;` in `lib.rs:1-8`;
`app.manage(sync_meta::SyncMetaStore::load(app.handle()))` in setup (`lib.rs:16-24`); four
entries in `generate_handler!` (`lib.rs:32-71`); a `// Backup & transfer` block in `ipc.ts`.

### 1f. UI

- `src/lib/components/SettingsModal.svelte`: `type Section` (:10) gains `"sync"`; `SECTIONS`
  (:14-20) gains `{ id: "sync", label: "Sync & Backup" }` before `about`; a branch in the
  `{#if}` chain (:89-187) rendering `<SyncSettings />`.
- **New** `src/lib/components/SyncSettings.svelte` — in Phase 1 renders only
  `<BundleTransfer />`.
- **New** `src/lib/components/BundleTransfer.svelte` — model on the existing
  `copyJson`/`exportFile`/`importFile`/`flash` pattern in `AppearanceSettings.svelte:273-330`.
  Export card (checkbox list of what's included → `save()` dialog); Import card
  ("Choose file…" → `open()` → preview panel with counts **and every command string in a
  scrollable mono block** → merge/replace radio → "Import") → backup-path confirmation line.

**Phase 1 ships here** and is useful alone: backup, machine migration, sharing a setup.

---

## Phase 2 — Sync folder

### 2a. Module layout

```
src-tauri/src/sync/
  mod.rs      SyncStore (managed state), all sync_* commands, scheduler
  config.rs   SyncConfig + sync.json (local, never published)
  shard.rs    envelope read/write, folder manifest, probe, torn-file tolerance
  crypto.rs   Argon2id KDF + XChaCha20-Poly1305 seal/open, verifier
  watch.rs    notify watcher + burst debouncer + poll fallback
  key.rs      project key derivation, portable roots
```

`merge.rs` and `portable.rs` stay top-level (shared with `bundle.rs`).

New crates in `src-tauri/Cargo.toml`: `chacha20poly1305 = "0.10"`, `argon2 = "0.5"`,
`zeroize = "1"`, `rand_core = { version = "0.6", features = ["getrandom"] }`. All pure Rust,
no OpenSSL. `base64`, `notify`, `uuid`, `dirs` are already dependencies.

### 2b. Local config — `app_data_dir/sync.json` (never published)

```jsonc
{
  "schemaVersion": 1,
  "enabled": true,
  "dir": "/home/ravn/Dropbox/Termax",
  "folderId": "0f9c…",       // copied from the folder manifest at adoption
  "deviceId": "a41b…",       // 128-bit hex, NO dots — see §2c
  "deviceName": "ravn-desktop",
  "platform": "linux",
  "writerSeq": 137,
  "writerNonce": "…",        // regenerated per app install
  "encryption": { "enabled": true, "salt": "b64", "m": 19456, "t": 2, "p": 1 },
  "include": { "launchers": true, "themes": true, "projects": true, "layout": false },
  "portableRoots": [ { "id": "r1", "label": "Projects", "path": "/home/ravn/Projects" } ],
  "state": "idle",           // idle|pendingAdoption|locked|unavailable|duplicateDevice|schemaTooNew|error
  "lastSyncAt": 1753700000000,
  "lastError": null
}
```

`folderId` is load-bearing: it distinguishes "the cloud client was uninstalled and left an
empty directory" from "a fresh folder the user just picked" (§2i).

### 2c. Sync-folder layout

```
<syncdir>/
  termax-sync.json           # folder manifest
  devices/
    a41b….json               # one shard per device; ONLY that device writes it
    a41b….json.tmp           # transient (write_json_atomic), same-fs rename target
```

Manifest:

```jsonc
{
  "termax": "sync-folder",
  "schemaVersion": 1,
  "folderId": "0f9c…",
  "createdAt": ms,
  "encryption": null | {
    "alg": "xchacha20poly1305-ietf", "kdf": "argon2id",
    "m": 19456, "t": 2, "p": 1,
    "salt": "b64(16)",
    "verifier": { "nonce": "b64(24)", "ct": "b64" }   // seals the literal "termax-sync-v1"
  }
}
```

One folder-wide salt so every device with the same passphrase derives the same key;
per-shard random nonces. The verifier validates a passphrase without touching any shard,
which is what makes "wrong passphrase" a clean, non-destructive error.

> **Invariant:** `write_json_atomic` uses `path.with_extension("json.tmp")`
> (`store_io.rs:20`), so `devices/a41b.json` → `devices/a41b.json.tmp`. **Device ids must
> contain no `.`** (hex uuid-simple satisfies this) or `with_extension` truncates at the wrong
> dot and renames over the wrong file. Encode as a test.

### 2d. Device shard schema

Plaintext envelope always, so shards are identifiable and attributable without the key:

```jsonc
{
  "termax": "sync-shard",
  "schemaVersion": 1,
  "deviceId": "a41b…", "deviceName": "ravn-desktop", "platform": "linux",
  "appVersion": "0.1.0",
  "updatedAt": 1753700000000,
  "writerSeq": 137, "writerNonce": "…",
  "encrypted": false,
  "payload": { … },                 // when encrypted == false
  "nonce": "b64(24)", "ct": "b64"   // when encrypted == true (payload absent)
}
```

Payload is the bundle body minus the bundle header, plus `projects[].layout` when
`include.layout` is on.

Two invariants that make the design safe:

1. **Only device D ever writes `devices/D.json`.** No cloud client can produce a
   "conflicted copy".
2. **A shard is that device's full statement of the merged world as it knows it, with
   *original* record stamps preserved.** Republishing after a merge never re-stamps —
   otherwise a device that merely reads would win every subsequent race. This is also why a
   shard from a device on a *newer* schema can be skipped losslessly: we never rewrite it.

### 2e. Merge algorithm — `merge.rs`

Inputs: local `PortableState` (from `portable::collect`) + `Vec<Shard>` for every other
device. Output: `MergedState + Vec<ConflictNote> + MergeStats`.

| class | identity | notes |
|---|---|---|
| launcher | `id` | `shell` (`command: None`, `settings.rs:106-112`) is built-in, never deletable; content merges normally |
| custom theme | theme `id` | opaque `Value`, compared/replaced whole |
| project | `key` | never `id`, never `path` |
| vault command | `(projectKey, commandId)` | scoped to its project |
| settings group | `appearance` / `terminal` / `behavior` / `launcherOrder` | whole-group LWW |

Per id:

1. Candidates = local record (if present) + one per shard containing it, each with
   `(at, synthetic, deviceId)`.
2. Normalize each candidate: **`at = min(at, shard.updatedAt)`** — a record cannot legitimately
   be newer than the file carrying it. This one clamp defuses most clock skew: a device whose
   clock is an hour fast can only win by as much as its own shard timestamp, which is bounded
   by when it actually wrote.
3. Ordering: real beats `synthetic` → greater `at` → non-default value beats default value →
   lexicographically greater `deviceId`. Deterministic on every machine, so all devices
   converge to the same result from the same inputs.
4. Tombstone for that id = max `deletedAt` across local + all shards, clamped the same way.
   If `maxDeletedAt > winner.at` the record is deleted; else it survives (edit-after-delete
   resurrects — LWW semantics, documented in the panel).
5. Tombstones are retained and republished until `now - deletedAt > 90 days`, then GC'd. A
   device offline longer than that resurrects its records — the safe failure direction.
6. **Conflict note** when two live candidates differ in content and their `at` values are
   within 60 s: `{ class, id, label, winnerDevice, loserDevice, at }`, surfaced in the panel.
   Nothing is blocked; the merge still resolves.
7. **Skew warning** (separate from clamping): any shard `updatedAt` more than 5 min ahead of
   our `now` → `SkewWarning { deviceId, deltaMs }`. Never adjust another device's clock,
   never rewrite its shard.

Exclusions are enforced structurally, not by convention: `trust.rs` is not a dependency of any
sync module; `terminal.defaultShell` never enters `PortableSettings`; layout only enters when
`include.layout` is on, and even then publishes at most once per 5 minutes and on project
close — **never** on the 500 ms `persistLayout` cadence (`src/lib/stores.ts:113-124`).

Apply order: merged settings → the `save_settings` path (so `set_snapshot_limit`,
`settings.rs:185`, still runs) → merged projects into `ProjectStore` preserving local
`id`/`path`/`layout` → update `sync-meta.json` stamps to the winners' → republish our shard →
emit `settings-changed`, `projects-changed`, `sync-changed`.

### 2f. Project keys & binding — `sync/key.rs`

Derivation order:

1. **Git remote.** Two changes in `src-tauri/src/git.rs`: make `normalize_remote_url` (:288)
   `pub(crate)`, and add `pub fn remote_key(root: &Path) -> Option<String>` beside
   `remote_web_url` (:266), returning `git:<host>/<owner>/<repo>` (scheme stripped, whole key
   lowercased for stability; the original casing survives in `Project.name`).
   **Gate on trust.** `remote_key` runs `git remote get-url`, which reads `.git/config` — the
   exact code-execution vector `trust.rs` exists to gate (`session.rs:167`). Key derivation
   runs only for folders where `TrustStore::is_trusted` is true, i.e. piggyback on the
   existing `openProject` flow (`stores.ts:373-380`) or an explicit Sync-panel click that
   shows the trust prompt first. Untrusted → fall through to step 2.
2. **Portable root.** For each configured root whose canonicalized path (reuse the `canonical`
   helper pattern at `trust.rs:29-34`) prefixes the project's canonical path →
   `root:<rootId>/<relpath>` with `/` separators. The user maps `~/Projects` (Linux) to
   `D:\dev` (Windows) by giving both the same `rootId` in each machine's `sync.json`.
3. **Unkeyed.** Not published. Panel lists it under "Not synced" with the reason and two
   remedies: add a portable root, or trust the folder so the remote can be read.

**The binding table is `projects.json` itself:** `key` + `path` on the same record. Bound =
both set. Dormant = `key` set, `path` empty. Local-only = `path` set, `key` null. No parallel
table, no third file.

- **Key drift** (repo moved hosts): on open, recompute; if changed, never silently re-key —
  offer "Re-key this project", implemented as tombstone-old-key + new record so other devices
  converge.
- **Collision** (two clones, a worktree, a fork): refuse the bind, offer a `#2` disambiguator
  suffix or leaving it local-only.
- **Dormant project UI:** in `ProjectPicker.svelte` and the Sync panel, a muted "Not on this
  machine" badge + **Link to local folder…** → `open({ directory: true })` →
  `sync_bind_project(projectId, path)`, which verifies (a) it is a directory, (b) if trusted
  and a repo, the derived key matches (warn, allow override), (c) no other project holds the
  key → writes `path`. Clicking the row before binding opens the same dialog rather than
  failing in `startSession`.

### 2g. Encryption — `sync/crypto.rs` (built last)

- Argon2id, m=19456 KiB / t=2 / p=1 (OWASP floor, ~50-100 ms), salt from the manifest,
  32-byte key.
- XChaCha20-Poly1305, fresh 24-byte nonce per shard write. AAD = canonical serialization of
  the plaintext envelope fields (`deviceId`, `schemaVersion`, `updatedAt`, `writerSeq`) so a
  header can't be swapped between shards.
- Key held only in memory: `Mutex<Option<Zeroizing<[u8; 32]>>>` on `SyncStore`. Not persisted.
  A restart puts sync in `locked` with a banner + unlock field. (OS keychain via the `keyring`
  crate is a plausible follow-up — note it, don't build it.)
- Enabling on an existing plaintext folder: seal the manifest verifier, rewrite **only our
  own** shard encrypted, leave other devices' plaintext shards alone. `read_shard` handles
  both forms, so a mixed folder converges as each device unlocks. Panel shows "2 of 3 devices
  have re-encrypted".
- **Wrong passphrase** is detected against the verifier *before any write*. On failure: no
  writes at all (**never** fall back to plaintext — that would silently leak vault commands to
  the cloud), no merge, state `locked`, message "This folder was encrypted with a different
  passphrase. Termax cannot recover a lost passphrase." with "Try again" / "Use a different
  folder".
- Changing the passphrase rewrites the manifest verifier and our shard; other devices then
  fail their verifier and land in `locked` with the same clear message — the correct,
  non-destructive outcome.

### 2h. Watching & scheduling — `sync/watch.rs`

- `notify::recommended_watcher` on `<syncdir>/devices` (non-recursive) + the manifest, same
  construction as `session.rs:187`.
- Debounce: 3 s quiet period, 15 s hard cap — cloud clients write in noisy bursts.
- **Poll fallback every 5 minutes** comparing `(mtime, len)` per shard. Google Drive's virtual
  filesystem, SMB/NFS mounts, and some FUSE layers emit no inotify events at all; without
  this, sync simply appears broken there.
- Ignore our own shard path, `*.tmp`, `*.part`, `*.crdownload`, `.~lock*`, `~$*`. **Do** notice
  `*conflicted copy*` / `*conflict*` names and surface them — with per-device shards these
  should be impossible, so they mean two machines share a device id (§2j).
- **Torn/partial reads:** `read_json_strict` fails → do not rename, do not default. Fall back
  to the last good copy cached at `app_data_dir/sync-cache/<deviceId>.json`, retry next tick,
  report the shard unreadable only after 3 consecutive failures spanning ≥ 60 s. A zero-length
  file is "not ready yet", never "empty shard".
- Our own publishes rate-limited to ≥ 10 s apart and coalesced, so a burst of settings edits
  produces one shard write.
- First sync after launch ~2 s after `setup`, so the window exists to receive `sync-changed`.

### 2i. Adopt vs. overwrite — the dangerous moment

`sync_probe_folder(dir)` runs before anything is committed, returning `Empty`,
`Initialized { folderId, devices, encrypted }`, `SchemaTooNew { version }`,
`Unreadable { reason }`, or `Rejected { reason }`.

Rejected at pick time: inside `app_data_dir`, inside any known project path (feedback loop
with the project watcher), world-writable on unix (`mode & 0o002`), or not a directory.

- **Empty + user just picked it** → initialize: write manifest, write our shard from local
  state, record `folderId`. No merge.
- **Initialized** → `state = pendingAdoption`. **Never auto-merge on first contact.** Run a
  dry-run merge and show: what will be added; which local items will be replaced by newer
  remote versions and from which device; which local items are newer and will be pushed; and
  the full list of incoming vault-command / launcher command strings (§security).

  Three choices, and **all three first write a full backup** to
  `app_data_dir/backups/pre-sync-<ts>.termax.json` via the Phase-1 exporter, path shown in UI:
  1. **Merge (recommended)** — normal LWW. During adoption only, treat every local `synthetic`
     stamp as 0, so a freshly-migrated machine cannot beat a real remote edit.
  2. **Take remote** — remote authoritative; local records absent remotely are dropped.
  3. **Keep local** — re-stamp all local records to `now` (real, not synthetic) and push.

  > **The disaster this prevents:** a fresh install has three default launchers and a default
  > theme. Under plain LWW their "now" stamps beat a three-month-old remote shard, and merging
  > would push factory defaults over the user's real configuration on *every* machine. Three
  > layers stop it: defaults are unstamped, migrated stamps are synthetic and lose, adoption
  > is an explicit choice with a backup.

- **Initialized but `folderId` differs from the remembered one, or manifest missing while
  `sync.json` says we adopted** → `state = unavailable`. Never re-initialize, never publish.
  This is the disconnected-drive / uninstalled-cloud-client case: the directory may still
  exist and be empty, and auto-initializing would publish into a phantom folder. Backoff
  retry (30 s → 5 min), banner "Sync folder is unavailable — is `<dir>` mounted?"

### 2j. Duplicate device id (cloned VM / restored disk image)

`writerNonce` is regenerated per app install; `writerSeq` increments per write. Before
publishing, read back our own shard: if its `writerNonce` differs from ours, or its
`writerSeq` exceeds our local counter, another machine or process is writing our shard. Stop
writing immediately, `state = duplicateDevice`, banner "Another machine is using this device
identity", one button **Take a new identity** → regenerate `deviceId` + `writerNonce`, publish
to the new path, leave the old shard untouched. Same mechanism catches a second Termax
instance on one machine.

### 2k. Schema version from a newer app

- No `deny_unknown_fields` anywhere. Since we never rewrite another device's shard, tolerating
  unknown keys loses nothing.
- Shard `schemaVersion > SUPPORTED` → skip that shard entirely; list the device as "Running a
  newer Termax (schema N) — sync paused for this device."
- Manifest `schemaVersion > SUPPORTED` → refuse **all** writes to the folder (the layout
  itself may have changed) and banner. Read-only degradation always beats a guess.

### 2l. IPC surface

`sync_status`, `sync_probe_folder(dir)`, `sync_configure(cfg)`, `sync_adopt(choice)`,
`sync_now`, `sync_unlock(passphrase)`, `sync_set_passphrase(old, new)` (`new: None` disables
encryption), `sync_disable(deleteOurShard: bool)`, `sync_forget_device(deviceId)`,
`sync_bind_project(projectId, path)`, `sync_unbind_project(projectId)`,
`sync_set_project_synced(projectId, on)`, `sync_add_portable_root(label, path)`,
`sync_remove_portable_root(id)`, `sync_mark_reviewed(commandKey)`, `sync_dismiss_notices`.

Wiring: `mod sync;` in `lib.rs`, `app.manage(sync::SyncStore::load(app.handle()))` in setup
(`lib.rs:16-24`), entries appended to `generate_handler!` (`lib.rs:32-71`), a `// Sync` block
in `ipc.ts` after the settings block (:63-72).

Events: `sync-changed`, `settings-changed`, `projects-changed`. New `src/lib/sync.ts` holds a
`syncStatus` writable and registers listeners (pattern from `App.svelte:34`), calling the
existing `loadSettings()` (`settings.ts:142`) and `loadProjects()` (`stores.ts:343`).
`loadSettings` uses `settings.set`, **not** `updateSettings`, so a merge-driven reload cannot
trigger the 300 ms `persist()` and echo back — verify this holds.

> **One real interaction bug to fix here:** `syncDetected()` (`settings.ts:265-294`)
> auto-appends any agent found on `$PATH` as a new launcher. Post-sync that resurrects a
> launcher the user deliberately deleted on another machine, on every launch, forever.
> `syncDetected` must skip ids present in the launcher tombstone list, so `sync_status` needs
> to expose them.

### 2m. `SyncSettings.svelte`

1. **Status bar** — pill (Off / Idle / Syncing / Paused: locked / Paused: folder unavailable /
   Duplicate device / Schema too new / Error), "Last synced 4 minutes ago", **Sync now**.
2. **Folder** — path (mono, truncating), "Choose folder…", inline probe result *before*
   commit ("This folder already has data from 2 devices — you'll choose how to combine them"),
   reveal-in-file-manager (`ipc.revealInFileManager`), and a note that the sync folder is a
   trust boundary equal to Termax's own data directory.
3. **Adoption card** (only in `pendingAdoption`) — dry-run summary, incoming-commands list,
   the three buttons, the backup path.
4. **Devices** — name, platform, "this device" badge, last seen, shard size, schema version,
   per-device warnings (skew, unreadable, newer schema), "Forget device" using the inline
   confirm pattern from `LauncherSettings.svelte` (`confirmRemoveId`).
5. **What syncs** — toggles for launchers / themes / projects+vault commands / layout (layout
   **off by default**, hinted "screen layout is per-machine and changes constantly"), plus a
   fixed, non-toggleable **Not synced** list: folder trust, default shell, window/UI state,
   each with a one-line reason.
6. **Projects** — three groups: Bound (name + key + local path); Not on this machine (name +
   key + **Link to local folder…**); Not synced (name + reason + remedy). Portable-roots
   editor below (label + path rows, add/remove, `rootId` shown faintly, cross-platform hint).
7. **Encryption** — toggle, passphrase + confirm, Unlock form when locked, Change passphrase,
   and an unmissable "If you lose this passphrase, Termax cannot recover the data in this
   folder."
8. **Notices** — recent conflict notes ("`deploy` in Termax: kept the version from
   ravn-laptop, 12:04") and skew warnings, with Dismiss.
9. **Backup & transfer** — the Phase-1 `<BundleTransfer />`, unchanged.
10. **Danger** — Stop syncing (checkbox: also delete this device's shard).

---

## Security notes

**Vault commands and launcher commands are arbitrary shell code.** `runVaultCommand`
(`stores.ts:506-516`) hands `cmd.command` straight to `terminals.queueRun`, and
`Launcher.command` is executed by `spawn_pty`. Accepting synced records therefore means:
*anything that can write to the sync folder gets code execution on every linked machine, one
click away.* Designed-in consequences:

- Treat the sync folder as a trust boundary equal to `app_data_dir`. Say so at pick time;
  reject world-writable directories.
- **Unreviewed flag** (confirmed with the user): vault commands and launchers arriving from a
  remote device or an imported bundle are recorded in `sync-meta.unreviewed` — a **local-only**
  list, never published. `CommandVault.svelte` renders them with a distinct badge; the first
  run shows a confirm dialog containing the exact command text. The flag clears on first
  accepted run or via "mark reviewed".
- **Never auto-run anything on merge.** Termax has no autorun today. Adding a "run on project
  open" feature later would convert this design into wormable RCE across a user's machines and
  would need a separate, explicit, per-command opt-in.
- Bundle import shows every incoming command string before applying — that is precisely why
  `import_bundle_preview` is a separate command from `import_bundle_apply`.
- Launcher `icon` can be raw `<svg>` rendered with `{@html}` (`TerminalIcon.svelte:30`),
  sanitized by a regex denylist (`sanitizeSvg`, :8-25) and backstopped by CSP
  `script-src 'self'`. Sync changes the threat model: today that markup is only ever pasted by
  the user; afterwards it arrives unattended. Cap icon length, and treat the CSP as the real
  control — any future CSP relaxation must revisit this path.
- Encryption protects data **at rest at the cloud provider**, not against a compromised local
  machine or a malicious peer device. State that plainly in the panel so nobody over-trusts it.

**Why `trusted.json` is excluded.** It records "I have vouched for the authors of the files in
this directory". It authorizes running git, which reads attacker-controllable `.git/config`
(`trust.rs:1-7`), and gates the whole session (`session.rs:167`). Three independent reasons it
must never sync:

1. It is a statement about *one machine's filesystem contents at one moment*.
   `/home/user/work` on machine B is not the same directory as on machine A, and on a shared
   box may not even be the same user's.
2. It is an authorization decision, and authorization must not propagate laterally. A second
   machine that is compromised, or merely careless, would silently elevate folders on the first.
3. Revocation must work locally and instantly, without a cloud round-trip or another device's
   cooperation.

Enforce structurally: no sync module imports `trust`, and `portable::collect` has no access
path to `TrustStore`. Assert it in a test.

---

## Failure modes

| Failure | Handling |
|---|---|
| Sync dir on a disconnected drive / unmounted share | `folderId` mismatch or missing manifest → `unavailable`; never auto-initialize, never publish; backoff retry + banner |
| Cloud client uninstalled, empty dir left behind | Same `folderId` guard — the case a naive "is the dir empty?" check gets fatally wrong |
| Cloud client mid-write / partial file | `read_json_strict` fails → last-good cache from `sync-cache/`; retry; report only after 3 failures / 60 s; **never** rename a remote file |
| Zero-length shard | "Not ready", not "empty" |
| Two devices with the same deviceId | `writerNonce`/`writerSeq` mismatch → stop writing, "Take a new identity" |
| Conflicted-copy files appear | Should be impossible; surfaced as a duplicate-identity symptom |
| Passphrase mismatch | Verifier fails before any write → `locked`, no writes, no plaintext fallback |
| Passphrase lost | Unrecoverable, stated up front; the Phase-1 bundle export is the recovery path |
| Newer shard schema | Skip that device, keep syncing the rest |
| Newer manifest schema | Refuse all writes to the folder |
| Read-only folder / EACCES | Pull-only mode, push disabled, banner |
| Clock skew | Clamp record stamps to shard `updatedAt`; warn above 5 min; deterministic deviceId tie-break |
| Stale device (> 90 days) | Greyed in list, "Forget device" (deletes only that shard, with confirm) |
| Merge lands while settings modal is open | Applied through `save_settings`, then `settings-changed` → `loadSettings()` (uses `settings.set`, so no echo) |
| `syncDetected` resurrecting deleted launchers | Skip ids present in the launcher tombstone list |
| Huge shard / many devices | 4 MiB shard cap, 16 MiB read cap on user-picked files, string length caps on import |

---

## Build order

1. `sync_meta.rs` + diff-stamping in `save_settings` and the project CRUD commands — no
   user-visible change; ship quietly first and let real stamps accumulate.
2. `portable.rs` + `merge.rs` + `store_io` generalization + `read_json_strict`.
3. `bundle.rs` + IPC + `SyncSettings.svelte` / `BundleTransfer.svelte` → **release Phase 1**.
4. `sync/config.rs` + `sync/shard.rs` + probe + manifest; manual `sync_now` only, no watcher,
   plaintext only.
5. Adoption flow + backup-before-adopt.
6. `sync/key.rs` + binding UI + dormant-project handling.
7. `sync/watch.rs` + scheduler + poll fallback.
8. `sync/crypto.rs`.
9. Hardening: duplicate identity, schema gates, unreviewed-command badges, `syncDetected`
   tombstone fix.

---

## Verification

**Unit tests (Rust, `cargo test`)** — these pay for themselves:

- `merge.rs` — LWW ordering; tombstone vs. resurrect; synthetic-loses-to-real; skew clamp;
  deterministic deviceId tie-break; **convergence: 3 devices, shards applied in random order,
  all reach byte-identical `MergedState`**.
- `portable::collect` — output contains no absolute-path-shaped string, no `"path"` key, no
  `defaultShell`, no trust data.
- `key::derive` — all three tiers; key drift; collision.
- `shard` — torn file; zero-length; device id containing `.` is rejected; unknown keys
  survive because we never rewrite foreign shards.
- `crypto` — round-trip; wrong passphrase; AAD tamper detection.

**Manual end-to-end** (`cargo tauri dev`; second instance via a separate
`XDG_DATA_HOME` to simulate machine B):

1. *Phase 1.* Customize a theme, add a launcher, add vault commands. Export bundle. Wipe
   `~/.local/share/dev.ravn.termax/`. Relaunch → defaults. Import bundle → everything back;
   verify the exported JSON contains no absolute paths and no `defaultShell`.
2. *Adoption.* Machine A: point at `/tmp/termax-sync`, verify manifest + one shard appear.
   Machine B (fresh app-data, fresh install defaults): point at the same dir → **must** show
   the adoption card, not auto-merge. Choose Merge → A's config arrives; confirm B's factory
   defaults did **not** overwrite A's on the next sync (this is the core regression).
3. *Convergence.* Edit a different launcher on each machine within a second, `sync_now` both →
   both converge to the same state, a conflict note appears, no data is lost.
4. *Delete.* Delete a vault command on A → it disappears on B and stays deleted after B
   re-publishes. Verify a launcher deleted on A is not resurrected by `syncDetected` on B.
5. *Paths.* Clone the same git repo to different paths on A and B → the project binds by
   `git:` key on both and vault commands flow. Then use a non-git folder under a portable root
   with matching `rootId`. Then a folder that is neither → dormant on B, and **Link to local
   folder…** binds it.
6. *Torn file.* While the watcher runs, `printf '{"term' > devices/<other>.json` → no crash,
   no `.corrupt-` rename, last-good state retained, recovery on the next full write.
7. *Unavailable.* `mv /tmp/termax-sync /tmp/gone` → `unavailable` banner, no re-initialize.
   `mkdir /tmp/termax-sync` (empty, same path) → still `unavailable` via `folderId`, **not**
   re-initialized.
8. *Duplicate identity.* Copy machine A's whole app-data to a third instance → both point at
   the folder → `duplicateDevice` on the loser, "Take a new identity" resolves it.
9. *Encryption.* Enable with a passphrase on A; verify the shard's `ct` is opaque and
   `grep` finds no command text in the sync folder. On B, enter the wrong passphrase → clean
   `locked` state, **no writes to the folder** (check mtimes). Correct passphrase → syncs.
10. *Unreviewed.* A command arriving from B shows the badge; first run shows the confirm with
    the exact command text; the flag clears after; confirm `unreviewed` is absent from the
    published shard.
11. *Real cloud.* Repeat 2-4 with the folder inside an actual Dropbox/Nextcloud/Syncthing
    directory and confirm no `conflicted copy` files are ever produced.
