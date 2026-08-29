use crate::session::SessionManager;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_EDITOR_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB cap for editor panes

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    /// Path relative to the project root, using forward slashes.
    pub path: String,
    pub is_dir: bool,
    /// True when .gitignored (git mode) or in the built-in ignore list.
    pub ignored: bool,
}

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub binary: bool,
}

/// Resolve a project-relative path, rejecting anything that escapes the root.
///
/// The `..`/absolute-string checks reject the obvious escapes, but a symlink
/// *inside* the project (e.g. `notes -> ~/.bashrc`) would otherwise let a
/// read/write follow the link outside the root. So we canonicalize both the
/// root and the target and require the resolved path to stay contained. All
/// callers operate on paths that already exist, so `canonicalize` (which
/// requires existence) is safe here.
pub(crate) fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("invalid path: {rel}"));
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let resolved = canonical_root
        .join(rel_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !resolved.starts_with(&canonical_root) {
        return Err(format!("path escapes project root: {rel}"));
    }
    Ok(resolved)
}

/// Batch-query git for which of the given relative paths are ignored.
///
/// Goes through `git::git_command` rather than a bare `Command::new("git")` so
/// this shares the anti-hostile-repo settings (`core.fsmonitor`,
/// `core.hooksPath`, `protocol.ext`) with every other git call. It matters more
/// now that roots can be created programmatically as worktrees.
fn git_ignored(root: &Path, rels: &[String]) -> HashSet<String> {
    let mut ignored = HashSet::new();
    if rels.is_empty() {
        return ignored;
    }
    let Ok(mut child) = crate::git::git_command(root)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return ignored;
    };
    if let Some(stdin) = child.stdin.take() {
        let mut stdin = stdin;
        for rel in rels {
            let _ = stdin.write_all(rel.as_bytes());
            let _ = stdin.write_all(b"\0");
        }
    }
    if let Ok(out) = child.wait_with_output() {
        for path in String::from_utf8_lossy(&out.stdout).split('\0') {
            if !path.is_empty() {
                ignored.insert(path.to_string());
            }
        }
    }
    ignored
}

#[tauri::command(async)]
pub fn list_dir(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<Vec<TreeEntry>, String> {
    let (root, git_mode) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let dir = resolve(&root, &path)?;

    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push((name, is_dir));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));

    let rels: Vec<String> = entries
        .iter()
        .map(|(name, _)| {
            if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            }
        })
        .collect();

    let ignored_set = if git_mode {
        git_ignored(&root, &rels)
    } else {
        HashSet::new()
    };

    Ok(entries
        .into_iter()
        .zip(rels)
        .map(|((name, is_dir), rel)| {
            let ignored = ignored_set.contains(&rel)
                || name == ".git"
                || (!git_mode && crate::session::IGNORED_DIRS.contains(&name.as_str()));
            TreeEntry {
                name,
                path: rel,
                is_dir,
                ignored,
            }
        })
        .collect())
}

#[tauri::command(async)]
pub fn read_file(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<FileContent, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > MAX_EDITOR_FILE_SIZE {
        return Ok(FileContent {
            content: String::new(),
            binary: true,
        });
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok(FileContent {
            content: String::new(),
            binary: true,
        });
    }
    Ok(FileContent {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        binary: false,
    })
}

/// Read a file as a base64 `data:` URL for inline image/asset preview.
#[tauri::command(async)]
pub fn read_file_data_url(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if meta.len() > MAX_EDITOR_FILE_SIZE {
        return Err("file too large to preview".into());
    }
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[tauri::command(async)]
pub fn write_file(
    manager: tauri::State<SessionManager>,
    path: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    if !abs.is_file() {
        return Err(format!("not a file: {path}"));
    }
    std::fs::write(&abs, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn reveal_in_file_manager(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<(), String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;

    #[cfg(target_os = "linux")]
    {
        let dir = if abs.is_dir() {
            abs.clone()
        } else {
            abs.parent().map(Path::to_path_buf).unwrap_or(root)
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", abs.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a file in the OS default application (external editor / viewer).
#[tauri::command(async)]
pub fn open_in_default_app(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<(), String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    if !abs.exists() {
        return Err(format!("not found: {path}"));
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
