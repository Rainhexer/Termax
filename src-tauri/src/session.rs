use crate::git;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use similar::TextDiff;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1 MiB per file snapshot cap
const IGNORED_DIRS: &[&str] = &[
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
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct SessionManager {
    session: Mutex<Option<ActiveSession>>,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub git: bool,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
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

/// In git mode, .git is ignored except for the files that signal a status
/// change (index, HEAD, refs) so staging/committing in a terminal refreshes
/// the panel without flooding on object writes.
fn is_git_signal(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let s = rel.to_string_lossy().replace('\\', "/");
    if !s.starts_with(".git/") {
        return false;
    }
    s == ".git/index" || s == ".git/HEAD" || s.starts_with(".git/refs/")
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_SIZE {
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

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    manager: tauri::State<SessionManager>,
    project_path: String,
) -> Result<SessionInfo, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    let git_mode = git::is_repo(&root);

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

    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let mut dirty = false;
            for path in &event.paths {
                if is_ignored(path, &watch_root) {
                    if !(git_mode && is_git_signal(path, &watch_root)) {
                        continue;
                    }
                    dirty = true;
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
                let _ = app.emit("fs-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *manager.session.lock().unwrap() = Some(ActiveSession {
        root,
        mode,
        _watcher: watcher,
    });
    Ok(SessionInfo {
        git: git_mode,
        file_count,
    })
}

#[tauri::command]
pub fn stop_session(manager: tauri::State<SessionManager>) {
    *manager.session.lock().unwrap() = None;
}

#[tauri::command]
pub fn git_status(manager: tauri::State<SessionManager>) -> Result<Option<git::GitStatus>, String> {
    let guard = manager.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active session")?;
    match session.mode {
        Mode::Git => git::status(&session.root).map(|(status, _)| Some(status)),
        Mode::Snapshot { .. } => Ok(None),
    }
}

#[tauri::command]
pub fn get_changes(manager: tauri::State<SessionManager>) -> Result<Vec<ChangeEntry>, String> {
    let guard = manager.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active session")?;

    let (snapshot, changed) = match &session.mode {
        Mode::Git => {
            let (_, entries) = git::status(&session.root)?;
            return Ok(entries
                .into_iter()
                .map(|e| ChangeEntry {
                    path: e.path,
                    status: e.status,
                    added: e.added,
                    removed: e.removed,
                    area: Some(e.area),
                })
                .collect());
        }
        Mode::Snapshot { snapshot, changed } => (snapshot, changed),
    };

    let mut entries = Vec::new();
    let changed: Vec<String> = changed.lock().unwrap().iter().cloned().collect();

    for rel in changed {
        let abs = session.root.join(&rel);
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
    Ok(entries)
}

#[tauri::command]
pub fn get_diff(
    manager: tauri::State<SessionManager>,
    path: String,
    area: Option<String>,
) -> Result<FileDiff, String> {
    let guard = manager.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active session")?;

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
