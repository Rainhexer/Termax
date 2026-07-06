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

struct ActiveSession {
    root: PathBuf,
    snapshot: Snapshot,
    changed: Arc<Mutex<HashSet<String>>>,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct SessionManager {
    session: Mutex<Option<ActiveSession>>,
}

#[derive(Serialize)]
pub struct ChangeEntry {
    pub path: String,
    pub status: String, // "created" | "modified" | "deleted"
    pub added: usize,
    pub removed: usize,
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
) -> Result<usize, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }

    let snapshot = take_snapshot(&root);
    let file_count = snapshot.len();
    let changed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let watch_root = root.clone();
    let watch_changed = changed.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let mut dirty = false;
            {
                let mut set = watch_changed.lock().unwrap();
                for path in &event.paths {
                    if is_ignored(path, &watch_root) {
                        continue;
                    }
                    if let Ok(rel) = path.strip_prefix(&watch_root) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if !rel.is_empty() {
                            set.insert(rel);
                            dirty = true;
                        }
                    }
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
        snapshot,
        changed,
        _watcher: watcher,
    });
    Ok(file_count)
}

#[tauri::command]
pub fn stop_session(manager: tauri::State<SessionManager>) {
    *manager.session.lock().unwrap() = None;
}

#[tauri::command]
pub fn get_changes(manager: tauri::State<SessionManager>) -> Result<Vec<ChangeEntry>, String> {
    let guard = manager.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active session")?;

    let mut entries = Vec::new();
    let changed: Vec<String> = session.changed.lock().unwrap().iter().cloned().collect();

    for rel in changed {
        let abs = session.root.join(&rel);
        let existed = session.snapshot.contains_key(&rel);
        let exists = abs.is_file();
        // directories or transient paths
        if !exists && !existed {
            continue;
        }

        let (status, before, after) = if existed && !exists {
            ("deleted", session.snapshot.get(&rel).cloned().flatten(), None)
        } else if !existed && exists {
            ("created", None, read_text(&abs))
        } else {
            let before = session.snapshot.get(&rel).cloned().flatten();
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
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[tauri::command]
pub fn get_diff(manager: tauri::State<SessionManager>, path: String) -> Result<FileDiff, String> {
    let guard = manager.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no active session")?;
    let abs = session.root.join(&path);

    let original = session.snapshot.get(&path).cloned().flatten();
    let modified = if abs.is_file() { read_text(&abs) } else { None };

    let binary = (session.snapshot.contains_key(&path) && original.is_none())
        || (abs.is_file() && modified.is_none());

    Ok(FileDiff {
        original: original.unwrap_or_default(),
        modified: modified.unwrap_or_default(),
        binary,
    })
}
