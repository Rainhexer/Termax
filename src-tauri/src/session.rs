use crate::git;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use similar::TextDiff;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// Window over which filesystem notifications for one root are folded into a
/// single `fs-changed` event. See the note where the watcher is started.
const FS_COALESCE: std::time::Duration = std::time::Duration::from_millis(250);

/// Per-file snapshot/diff cap in bytes; driven by the oversized-limit setting.
static SNAPSHOT_LIMIT: AtomicU64 = AtomicU64::new(1024 * 1024);

pub fn set_snapshot_limit(bytes: u64) {
    SNAPSHOT_LIMIT.store(bytes.max(1), Ordering::Relaxed);
}
pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".svelte-kit",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
];

/// Snapshot value: Some(text) for readable text files, None for binary/oversized.
type Snapshot = HashMap<String, Option<String>>;

enum Mode {
    /// Change tracking delegated to git; the watcher only triggers refreshes.
    Git,
    /// Session-snapshot tracking for projects without a git repo.
    Snapshot {
        snapshot: Snapshot,
        changed: Arc<Mutex<HashSet<String>>>,
    },
}

struct ActiveSession {
    root: PathBuf,
    mode: Mode,
    /// How many frontend tabs currently reference this root. The primary session
    /// is owned by the project lifecycle and is not counted; worktree sessions
    /// are dropped when this reaches zero. Two tabs on one worktree must share a
    /// single watcher, which is the whole reason this is a count and not a bool.
    refs: usize,
    /// Held only to keep the watcher alive for as long as the session: dropping a
    /// `RecommendedWatcher` unregisters it. The resolved git directories it
    /// watches are captured inside its own closure, so they are not stored here.
    _watcher: Option<RecommendedWatcher>,
}

/// Live change-tracking sessions, keyed by canonicalized root path.
///
/// Keying by path rather than by a frontend-supplied id means the backend owns
/// root identity: two tabs pointing at the same worktree collapse onto one
/// session, one watcher, and one refcount without the frontend coordinating it.
#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<PathBuf, ActiveSession>>,
    /// The project root. Every command with `root: None` resolves here, which is
    /// what keeps the pre-worktree call sites working unchanged.
    primary: Mutex<Option<PathBuf>>,
}

impl SessionManager {
    /// Root and git-mode flag for `root`, or for the primary session when None.
    pub fn root_info(&self, root: Option<&str>) -> Option<(PathBuf, bool)> {
        let key = self.key_for(root)?;
        let guard = self.sessions.lock().unwrap();
        guard
            .get(&key)
            .map(|s| (s.root.clone(), matches!(s.mode, Mode::Git)))
    }

    /// Map an optional frontend-supplied root onto a session key. `None` means
    /// the primary; a supplied path is canonicalized so that a caller passing an
    /// uncanonicalized form (a symlinked or `/var` vs `/private/var` path) still
    /// finds its session.
    fn key_for(&self, root: Option<&str>) -> Option<PathBuf> {
        match root {
            None => self.primary.lock().unwrap().clone(),
            Some(path) => Some(canonical(Path::new(path))),
        }
    }
}

/// Canonicalize for use as a session key, falling back to the path as given.
///
/// The fallback matters: a worktree directory deleted out from under a tab must
/// still resolve to the key it was opened with, or the session becomes
/// unreachable and cannot be closed.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub git: bool,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// True when the folder was opened without trust: git is disabled and only
    /// snapshot tracking runs. The UI shows a "trust folder" banner.
    pub restricted: bool,
    /// The canonicalized root this session is keyed by. The frontend must store
    /// this rather than the path it sent, otherwise its key and the backend's
    /// disagree on any platform that rewrites paths (macOS `/var`).
    pub root: String,
}

/// Payload of the `fs-changed` event.
///
/// This used to be empty, which was fine with exactly one root and wrong with
/// several: without it, a file written in one worktree refreshes the change list
/// of every other worktree.
#[derive(Serialize, Clone)]
pub struct FsChanged {
    pub root: String,
}

#[derive(Serialize)]
pub struct ChangeEntry {
    pub path: String,
    pub status: String, // "created" | "modified" | "deleted"
    pub added: usize,
    pub removed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>, // "staged" | "unstaged" | "untracked" (git mode only)
}

#[derive(Serialize)]
pub struct FileDiff {
    pub original: String,
    pub modified: String,
    pub binary: bool,
}

fn is_ignored(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components().any(|c| {
                let name = c.as_os_str().to_string_lossy();
                IGNORED_DIRS.contains(&name.as_ref())
            })
        })
        .unwrap_or(true)
}

/// Whether a path is one of the few git files that signal a status change, so
/// that staging or committing in a terminal refreshes the panel without flooding
/// on every object write.
///
/// This is matched against the resolved git directories rather than against
/// `<root>/.git` as a string, because in a linked worktree `.git` is a *file*
/// and the real HEAD/index/refs live outside the watched tree entirely. A
/// string-prefix test can never see them, no matter how it is written.
///
/// `index` and `HEAD` are required to sit *directly* in this tree's `git_dir`.
/// Using a prefix test instead would make every linked worktree's index write
/// (`<main>/.git/worktrees/*/index`) also look like a signal for the main tree,
/// since those paths are nested under the main `git_dir`.
fn is_git_signal(path: &Path, git_dir: &Path, common_dir: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if (name == "index" || name == "HEAD") && path.parent() == Some(git_dir) {
        return true;
    }
    // Refs are shared between worktrees, so a ref write legitimately changes
    // ahead/behind for all of them.
    if name == "packed-refs" && path.parent() == Some(common_dir) {
        return true;
    }
    path.starts_with(common_dir.join("refs"))
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SNAPSHOT_LIMIT.load(Ordering::Relaxed) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None; // binary
    }
    String::from_utf8(bytes).ok()
}

fn take_snapshot(root: &Path) -> Snapshot {
    let mut snap = HashMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_ignored(e.path(), root) || e.path() == root)
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        snap.insert(rel, read_text(entry.path()));
    }
    snap
}

/// Build a session for `root`, including its watcher and initial snapshot.
///
/// Shared by `start_session` (the project root) and `open_worktree_session`, so
/// a worktree is watched and tracked by exactly the same code path as the project
/// itself. Anything that works in the main tree works in a worktree by
/// construction rather than by parallel implementation.
fn build_session(
    app: &AppHandle,
    root: PathBuf,
    trusted: bool,
) -> Result<(ActiveSession, SessionInfo), String> {
    // Only touch git for trusted folders — `is_repo`/`fetch`/`status` all read
    // `.git/config`, the untrusted-repo code-execution vector. An untrusted
    // folder opens in snapshot mode regardless of whether it is a repo.
    let git_mode = trusted && git::is_repo(&root);

    // Resolve the git directories before the watcher is built: in a linked
    // worktree they are the only way to observe a commit at all.
    let (git_dir, common_dir) = if git_mode {
        match git::git_dirs(&root) {
            Ok((g, c)) => (canonical(&g), canonical(&c)),
            // A repo that cannot report its git dir is not usable in git mode;
            // fall back to the conventional location rather than failing the
            // whole open.
            Err(_) => (root.join(".git"), root.join(".git")),
        }
    } else {
        (root.join(".git"), root.join(".git"))
    };

    let (mode, file_count, changed_for_watcher) = if git_mode {
        (Mode::Git, 0, None)
    } else {
        let snapshot = take_snapshot(&root);
        let count = snapshot.len();
        let changed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        (
            Mode::Snapshot {
                snapshot,
                changed: changed.clone(),
            },
            count,
            Some(changed),
        )
    };

    let watcher = start_watcher(
        app,
        &root,
        &git_dir,
        &common_dir,
        git_mode,
        changed_for_watcher,
    )?;

    // Fetch once in the background so ahead/behind reflect the real remote on
    // open — otherwise a repo that was pushed elsewhere looks up to date until
    // the user manually fetches. The refs write triggers the usual refresh.
    if git_mode {
        let fetch_root = root.clone();
        let fetch_app = app.clone();
        let key = root.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            if git::fetch(&fetch_root).is_ok() {
                let _ = fetch_app.emit("fs-changed", FsChanged { root: key });
            }
        });
    }

    let info = SessionInfo {
        git: git_mode,
        file_count,
        restricted: !trusted,
        root: root.to_string_lossy().into_owned(),
    };
    Ok((
        ActiveSession {
            root,
            mode,
            refs: 0,
            _watcher: Some(watcher),
        },
        info,
    ))
}

/// Watch a session's working tree plus, in git mode, its git directories.
///
/// Three watch registrations on one watcher:
///   1. the working tree, recursive, filtered by `is_ignored`;
///   2. `git_dir`, when it is not simply `<root>/.git` — that is the linked
///      worktree case, where HEAD and the index live outside the tree;
///   3. `common_dir`, for the shared refs and `packed-refs`.
/// Registrations 2 and 3 are best-effort: a missing directory must not stop the
/// project from opening, it only costs us the automatic refresh.
fn start_watcher(
    app: &AppHandle,
    root: &Path,
    git_dir: &Path,
    common_dir: &Path,
    git_mode: bool,
    changed_for_watcher: Option<Arc<Mutex<HashSet<String>>>>,
) -> Result<RecommendedWatcher, String> {
    let emit_app = app.clone();
    let watch_root = root.to_path_buf();
    let signal_git_dir = git_dir.to_path_buf();
    let signal_common_dir = common_dir.to_path_buf();
    let event_key = root.to_string_lossy().into_owned();

    // A Tauri event costs a script evaluation on the window's event loop — the
    // same loop that dispatches key presses — so emitting one per filesystem
    // notification is what turns an agent running a build into visible input
    // lag: `npm ci` or `cargo build` produces thousands of them a second. The
    // frontend already debounces, but only after every one of those has been
    // paid for. Coalesce here instead, on a thread of our own, so a churning
    // tree costs at most one emit per window.
    let (dirty_tx, dirty_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        // Ends when the watcher is dropped and takes the sender with it.
        while dirty_rx.recv().is_ok() {
            std::thread::sleep(FS_COALESCE);
            while dirty_rx.try_recv().is_ok() {}
            let _ = emit_app.emit(
                "fs-changed",
                FsChanged {
                    root: event_key.clone(),
                },
            );
        }
    });

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let mut dirty = false;
        for path in &event.paths {
            // Checked before `is_ignored`, because a git signal is frequently
            // *outside* the watched tree (linked worktrees) and would otherwise
            // be discarded as an escaping path.
            if git_mode && is_git_signal(path, &signal_git_dir, &signal_common_dir) {
                dirty = true;
                continue;
            }
            if is_ignored(path, &watch_root) {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&watch_root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel.is_empty() {
                    continue;
                }
                if let Some(changed) = &changed_for_watcher {
                    changed.lock().unwrap().insert(rel);
                }
                dirty = true;
            }
        }
        if dirty {
            let _ = dirty_tx.send(());
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    if git_mode {
        if git_dir != root.join(".git").as_path() {
            let _ = watcher.watch(git_dir, RecursiveMode::Recursive);
        }
        // Non-recursive would miss refs/heads/**; recursive on `.git` as a whole
        // would flood on object writes, so only the refs subtree is recursive and
        // packed-refs is caught by the non-recursive registration on common_dir.
        let _ = watcher.watch(&common_dir.join("refs"), RecursiveMode::Recursive);
        let _ = watcher.watch(common_dir, RecursiveMode::NonRecursive);
    }
    Ok(watcher)
}

#[tauri::command(async)]
pub fn start_session(
    app: AppHandle,
    manager: tauri::State<SessionManager>,
    project_path: String,
    trusted: bool,
) -> Result<SessionInfo, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    let root = canonical(&root);

    let (mut session, info) = build_session(&app, root.clone(), trusted)?;
    // The primary session is owned by the project lifecycle, so it carries a
    // reference that is only released by `stop_session`.
    session.refs = 1;

    // Opening a project replaces everything: any worktree sessions still open
    // belong to the project being closed.
    let mut sessions = manager.sessions.lock().unwrap();
    sessions.clear();
    sessions.insert(root.clone(), session);
    *manager.primary.lock().unwrap() = Some(root);
    Ok(info)
}

#[tauri::command]
pub fn stop_session(manager: tauri::State<SessionManager>) {
    manager.sessions.lock().unwrap().clear();
    *manager.primary.lock().unwrap() = None;
}

/// Open (or take another reference on) a session for one of this repository's
/// worktrees.
///
/// `path` is validated against `git worktree list` on the primary root before
/// anything is watched. The frontend can therefore never induce the backend to
/// watch or read an arbitrary directory, which mirrors how `fstree::resolve`
/// refuses paths that escape the project.
#[tauri::command(async)]
pub fn open_worktree_session(
    app: AppHandle,
    manager: tauri::State<SessionManager>,
    path: String,
) -> Result<SessionInfo, String> {
    let key = canonical(Path::new(&path));

    // Already open: take a reference and report the existing session.
    {
        let mut sessions = manager.sessions.lock().unwrap();
        if let Some(existing) = sessions.get_mut(&key) {
            existing.refs += 1;
            return Ok(SessionInfo {
                git: matches!(existing.mode, Mode::Git),
                file_count: 0,
                restricted: false,
                root: existing.root.to_string_lossy().into_owned(),
            });
        }
    }

    let primary = manager
        .primary
        .lock()
        .unwrap()
        .clone()
        .ok_or("no project is open")?;
    let known = git::worktrees(&primary)?;
    if !known
        .iter()
        .any(|entry| canonical(Path::new(&entry.path)) == key)
    {
        return Err(format!(
            "not a worktree of this repository: {}",
            key.display()
        ));
    }
    if !key.is_dir() {
        return Err(format!("worktree directory is missing: {}", key.display()));
    }

    // A worktree of a trusted project shares its `.git/config`, so the project's
    // trust decision already covers it; there is nothing separate to consent to.
    let (mut session, info) = build_session(&app, key.clone(), true)?;
    session.refs = 1;
    manager.sessions.lock().unwrap().insert(key, session);
    Ok(info)
}

/// Release a reference to a worktree session, dropping it (and its watcher) when
/// the last tab using it goes away.
///
/// Never touches the worktree on disk: it can hold the only copy of uncommitted
/// work, so removal is always a separate, explicit action.
#[tauri::command]
pub fn close_worktree_session(manager: tauri::State<SessionManager>, path: String) {
    let key = canonical(Path::new(&path));
    if manager.primary.lock().unwrap().as_ref() == Some(&key) {
        return; // the primary outlives individual tabs
    }
    let mut sessions = manager.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&key) {
        session.refs = session.refs.saturating_sub(1);
        if session.refs == 0 {
            sessions.remove(&key);
        }
    }
}

/// The worktrees of the open project, main tree first.
#[tauri::command(async)]
pub fn list_worktrees(
    manager: tauri::State<SessionManager>,
) -> Result<Vec<git::WorktreeEntry>, String> {
    let root = resolve_git(&manager, None)?;
    git::worktrees(&root)
}

/// Create a worktree for `branch` at `path`.
///
/// Always runs against the *primary* root, never a worktree root: git resolves
/// `worktree add` relative to the repository, and going through the main tree
/// keeps the administrative records in one place.
///
/// With `committish`, the tree is created detached at that commit — the fork-PR
/// case, where the head branch does not exist in this repository.
#[tauri::command(async)]
pub fn worktree_add(
    manager: tauri::State<SessionManager>,
    path: String,
    branch: String,
    committish: Option<String>,
) -> Result<Vec<git::WorktreeEntry>, String> {
    let root = resolve_git(&manager, None)?;
    let target = Path::new(&path);
    match committish.as_deref() {
        Some(spec) => git::worktree_add_detached(&root, target, spec)?,
        None => git::worktree_add_tracking(&root, target, &branch)?,
    }
    git::worktrees(&root)
}

/// Remove a worktree from disk.
///
/// Refuses by default when the tree has uncommitted changes (git's own check);
/// `force` is only ever passed after the user has explicitly chosen to discard
/// them. The session is dropped first so its watcher is not left pointing at a
/// directory being deleted.
#[tauri::command(async)]
pub fn worktree_remove(
    manager: tauri::State<SessionManager>,
    path: String,
    force: bool,
) -> Result<Vec<git::WorktreeEntry>, String> {
    let root = resolve_git(&manager, None)?;
    let key = canonical(Path::new(&path));
    if manager.primary.lock().unwrap().as_ref() == Some(&key) {
        return Err("the project's main worktree cannot be removed".into());
    }
    manager.sessions.lock().unwrap().remove(&key);
    git::worktree_remove(&root, Path::new(&path), force)?;
    git::worktrees(&root)
}

/// Drop administrative records for worktrees whose directories are gone. Never
/// called automatically — deleting git metadata is the user's decision.
#[tauri::command(async)]
pub fn worktree_prune(
    manager: tauri::State<SessionManager>,
) -> Result<Vec<git::WorktreeEntry>, String> {
    let root = resolve_git(&manager, None)?;
    git::worktree_prune(&root)?;
    git::worktrees(&root)
}

/// Default branch of `origin` (e.g. "main"), read from the local symref rather
/// than the network. Used to prefill the base branch when creating a PR.
#[tauri::command(async)]
pub fn git_default_branch(manager: tauri::State<SessionManager>) -> Result<Option<String>, String> {
    let root = resolve_git(&manager, None)?;
    Ok(git::default_branch(&root))
}

/// Create a branch at HEAD and switch to it, returning the new status.
#[tauri::command(async)]
pub fn git_create_branch(
    manager: tauri::State<SessionManager>,
    branch: String,
    root: Option<String>,
) -> Result<git::GitStatus, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::create_branch(&root, &branch)?;
    git::status(&root).map(|(status, _)| status)
}

/// Fetch a branch from origin. Used before creating a worktree from a PR head.
#[tauri::command(async)]
pub fn git_fetch_branch(
    manager: tauri::State<SessionManager>,
    branch: String,
) -> Result<(), String> {
    let root = resolve_git(&manager, None)?;
    git::fetch_branch(&root, &branch)
}

/// Fetch a pull request's head into a local ref and return that ref. For fork
/// PRs, whose head branch does not exist in this repository.
#[tauri::command(async)]
pub fn git_fetch_pr_head(
    manager: tauri::State<SessionManager>,
    number: u64,
) -> Result<String, String> {
    let root = resolve_git(&manager, None)?;
    git::fetch_pr_head(&root, number)
}

/// Push a branch to origin, setting upstream.
#[tauri::command(async)]
pub fn git_push(
    manager: tauri::State<SessionManager>,
    branch: String,
    force_with_lease: bool,
    root: Option<String>,
) -> Result<String, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::push(&root, &branch, force_with_lease)
}

/// Delete a branch locally and/or on origin.
///
/// Refuses while a worktree still has the branch checked out: git would fail
/// anyway, and doing the check here lets the UI say something useful instead of
/// relaying a confusing error.
#[tauri::command(async)]
pub fn git_delete_branch(
    manager: tauri::State<SessionManager>,
    branch: String,
    local: bool,
    remote: bool,
) -> Result<(), String> {
    let root = resolve_git(&manager, None)?;
    if local {
        if let Ok(trees) = git::worktrees(&root) {
            if let Some(holder) = trees
                .iter()
                .find(|entry| entry.branch.as_deref() == Some(branch.as_str()))
            {
                return Err(format!(
                    "'{branch}' is still checked out in {}. Remove that worktree first.",
                    holder.path
                ));
            }
        }
    }
    git::delete_branch(&root, &branch, local, remote)
}

/// Commit subject lines on this branch but not on `base`, for prefilling a
/// pull-request body.
#[tauri::command(async)]
pub fn git_commit_subjects(
    manager: tauri::State<SessionManager>,
    base: String,
    limit: usize,
    root: Option<String>,
) -> Result<Vec<String>, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    Ok(git::commit_subjects(&root, &base, limit))
}

/// Root of a git-mode session (the primary when `root` is None), or an error for
/// a snapshot/absent session.
///
/// The lock is released before returning, so the caller's (possibly slow,
/// network-bound) git call never holds it.
///
/// Also used by `github.rs`: `gh` must never run outside a trusted repo, and the
/// snapshot/no-session arms are what enforce that.
pub(crate) fn resolve_git(
    manager: &SessionManager,
    root: Option<&str>,
) -> Result<PathBuf, String> {
    let key = manager.key_for(root).ok_or("no active session")?;
    let guard = manager.sessions.lock().unwrap();
    let session = guard.get(&key).ok_or("no active session")?;
    match session.mode {
        Mode::Git => Ok(session.root.clone()),
        Mode::Snapshot { .. } => Err("not a git repository".into()),
    }
}

/// Convenience wrapper for callers that only ever mean the primary root.
pub(crate) fn git_root(manager: &SessionManager) -> Result<PathBuf, String> {
    resolve_git(manager, None)
}

#[tauri::command(async)]
pub fn git_fetch(
    manager: tauri::State<SessionManager>,
    root: Option<String>,
) -> Result<git::GitStatus, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::fetch(&root)?;
    git::status(&root).map(|(status, _)| status)
}

#[tauri::command(async)]
pub fn git_pull(
    manager: tauri::State<SessionManager>,
    root: Option<String>,
) -> Result<String, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::pull(&root)
}

#[tauri::command(async)]
pub fn git_branches(
    manager: tauri::State<SessionManager>,
    root: Option<String>,
) -> Result<Vec<String>, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::branches(&root)
}

#[tauri::command(async)]
pub fn git_checkout(
    manager: tauri::State<SessionManager>,
    branch: String,
    root: Option<String>,
) -> Result<git::GitStatus, String> {
    let root = resolve_git(&manager, root.as_deref())?;
    git::checkout(&root, &branch)?;
    git::status(&root).map(|(status, _)| status)
}

/// Everything the change panel needs for one root.
///
/// This is one command rather than two because `git status` is the single most
/// repeated piece of work in the app — it reruns on every filesystem event, for
/// every open worktree — and the change list and the branch/ahead/behind line
/// are two halves of the same `git::status` call. Asking for them separately
/// walked the whole worktree twice and ran six git subprocesses where three do.
#[derive(Serialize)]
pub struct RootGit {
    pub changes: Vec<ChangeEntry>,
    /// None for a folder tracked by snapshot rather than by git.
    pub status: Option<git::GitStatus>,
}

#[tauri::command(async)]
pub fn get_root_git(
    manager: tauri::State<SessionManager>,
    root: Option<String>,
) -> Result<RootGit, String> {
    let key = manager.key_for(root.as_deref()).ok_or("no active session")?;

    // Resolve under the lock, then release it: git below is slow, and holding
    // this would block every other session command for its duration.
    enum Work {
        Git(PathBuf),
        Snapshot(PathBuf, Snapshot, Arc<Mutex<HashSet<String>>>),
    }
    let work = {
        let guard = manager.sessions.lock().unwrap();
        let session = guard.get(&key).ok_or("no active session")?;
        match &session.mode {
            Mode::Git => Work::Git(session.root.clone()),
            Mode::Snapshot { snapshot, changed } => Work::Snapshot(
                session.root.clone(),
                snapshot.clone(),
                Arc::clone(changed),
            ),
        }
    };

    match work {
        Work::Git(root) => {
            let (status, entries) = git::status(&root)?;
            Ok(RootGit {
                changes: entries
                    .into_iter()
                    .map(|e| ChangeEntry {
                        path: e.path,
                        status: e.status,
                        added: e.added,
                        removed: e.removed,
                        area: Some(e.area),
                    })
                    .collect(),
                status: Some(status),
            })
        }
        Work::Snapshot(root, snapshot, changed) => Ok(RootGit {
            changes: snapshot_changes(&root, &snapshot, &changed),
            status: None,
        }),
    }
}

/// Change list for a folder tracked by snapshot: everything the watcher has
/// flagged, diffed against the contents recorded when the session opened.
fn snapshot_changes(
    root: &Path,
    snapshot: &Snapshot,
    changed: &Arc<Mutex<HashSet<String>>>,
) -> Vec<ChangeEntry> {
    let mut entries = Vec::new();
    let changed: Vec<String> = changed.lock().unwrap().iter().cloned().collect();

    for rel in changed {
        let abs = root.join(&rel);
        let existed = snapshot.contains_key(&rel);
        let exists = abs.is_file();
        // directories or transient paths
        if !exists && !existed {
            continue;
        }

        let (status, before, after) = if existed && !exists {
            ("deleted", snapshot.get(&rel).cloned().flatten(), None)
        } else if !existed && exists {
            ("created", None, read_text(&abs))
        } else {
            let before = snapshot.get(&rel).cloned().flatten();
            let after = read_text(&abs);
            if before == after {
                continue; // touched but unchanged
            }
            ("modified", before, after)
        };

        let (added, removed) = match (&before, &after) {
            (Some(b), Some(a)) => {
                let diff = TextDiff::from_lines(b.as_str(), a.as_str());
                let mut add = 0;
                let mut rem = 0;
                for change in diff.iter_all_changes() {
                    match change.tag() {
                        similar::ChangeTag::Insert => add += 1,
                        similar::ChangeTag::Delete => rem += 1,
                        _ => {}
                    }
                }
                (add, rem)
            }
            (None, Some(a)) => (a.lines().count(), 0),
            (Some(b), None) => (0, b.lines().count()),
            (None, None) => (0, 0),
        };

        entries.push(ChangeEntry {
            path: rel,
            status: status.into(),
            added,
            removed,
            area: None,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
}

#[tauri::command(async)]
pub fn get_diff(
    manager: tauri::State<SessionManager>,
    path: String,
    area: Option<String>,
    root: Option<String>,
) -> Result<FileDiff, String> {
    let key = manager.key_for(root.as_deref()).ok_or("no active session")?;
    let guard = manager.sessions.lock().unwrap();
    let session = guard.get(&key).ok_or("no active session")?;

    let snapshot = match &session.mode {
        Mode::Git => {
            let area = area.as_deref().unwrap_or("unstaged");
            let (original, modified, binary) = git::diff(&session.root, &path, area)?;
            return Ok(FileDiff {
                original,
                modified,
                binary,
            });
        }
        Mode::Snapshot { snapshot, .. } => snapshot,
    };

    let abs = session.root.join(&path);
    let original = snapshot.get(&path).cloned().flatten();
    let modified = if abs.is_file() { read_text(&abs) } else { None };

    let binary = (snapshot.contains_key(&path) && original.is_none())
        || (abs.is_file() && modified.is_none());

    Ok(FileDiff {
        original: original.unwrap_or_default(),
        modified: modified.unwrap_or_default(),
        binary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Layout of a repo with one linked worktree, as verified against real git:
    ///   main tree   /repo            git_dir = common_dir = /repo/.git
    ///   linked tree /wt/feature      git_dir = /repo/.git/worktrees/feature
    ///                                common_dir = /repo/.git
    fn main_dirs() -> (PathBuf, PathBuf) {
        (PathBuf::from("/repo/.git"), PathBuf::from("/repo/.git"))
    }
    fn linked_dirs() -> (PathBuf, PathBuf) {
        (
            PathBuf::from("/repo/.git/worktrees/feature"),
            PathBuf::from("/repo/.git"),
        )
    }

    #[test]
    fn main_worktree_signals() {
        let (g, c) = main_dirs();
        for path in [
            "/repo/.git/index",
            "/repo/.git/HEAD",
            "/repo/.git/refs/heads/master",
            "/repo/.git/refs/remotes/origin/master",
            // packed-refs was missed entirely by the old string-prefix check.
            "/repo/.git/packed-refs",
        ] {
            assert!(
                is_git_signal(Path::new(path), &g, &c),
                "should signal: {path}"
            );
        }
    }

    #[test]
    fn ignores_object_writes_and_lockfiles() {
        let (g, c) = main_dirs();
        for path in [
            // Object writes are the flood this filter exists to suppress.
            "/repo/.git/objects/ab/cdef0123",
            "/repo/.git/logs/HEAD",
            "/repo/.git/config",
            // git writes index.lock then renames onto index; only the rename
            // should fire, or every staging operation refreshes twice.
            "/repo/.git/index.lock",
            "/repo/src/main.rs",
        ] {
            assert!(
                !is_git_signal(Path::new(path), &g, &c),
                "should not signal: {path}"
            );
        }
    }

    /// The reason `index`/`HEAD` use parent equality rather than a prefix test:
    /// a linked worktree's git_dir is nested *inside* the main one, so a prefix
    /// test would make every worktree commit also refresh the main tree.
    #[test]
    fn a_linked_worktrees_index_is_not_the_main_trees_signal() {
        let (main_g, main_c) = main_dirs();
        let linked_index = Path::new("/repo/.git/worktrees/feature/index");
        assert!(
            !is_git_signal(linked_index, &main_g, &main_c),
            "the main tree must not treat another worktree's index as its own"
        );

        // ...but it is that worktree's own signal.
        let (lg, lc) = linked_dirs();
        assert!(is_git_signal(linked_index, &lg, &lc));
        assert!(is_git_signal(
            Path::new("/repo/.git/worktrees/feature/HEAD"),
            &lg,
            &lc
        ));
    }

    /// Refs are genuinely shared, so a ref write must reach every session of the
    /// repository — that is what keeps ahead/behind correct in all of them.
    #[test]
    fn refs_are_shared_across_worktrees() {
        let ref_path = Path::new("/repo/.git/refs/heads/feature");
        let (mg, mc) = main_dirs();
        let (lg, lc) = linked_dirs();
        assert!(is_git_signal(ref_path, &mg, &mc));
        assert!(is_git_signal(ref_path, &lg, &lc));
    }

    #[test]
    fn ignored_paths_follow_the_ignore_list() {
        let root = Path::new("/repo");
        assert!(is_ignored(Path::new("/repo/node_modules/x/y.js"), root));
        assert!(is_ignored(Path::new("/repo/target/debug/foo"), root));
        assert!(is_ignored(Path::new("/repo/.git/index"), root));
        assert!(!is_ignored(Path::new("/repo/src/main.rs"), root));
        // A path outside the root is "ignored" so the watcher discards it — the
        // git-signal check therefore has to run *before* this one.
        assert!(is_ignored(Path::new("/elsewhere/file"), root));
    }

    #[test]
    fn canonical_falls_back_for_missing_paths() {
        // A worktree deleted underneath a tab must still map to a usable key, or
        // its session could never be closed.
        let missing = Path::new("/definitely/not/here/xyzzy");
        assert_eq!(canonical(missing), missing.to_path_buf());
    }
}
