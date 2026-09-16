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
        // Only the `cmd` host is hidden: `start` gives the associated app its
        // own window (or console) either way.
        crate::proc::hidden(&mut Command::new("cmd"))
            .args(["/C", "start", ""])
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --------------------------------------------------------------- mutations
//
// Creating, renaming and deleting all act on the *entry* rather than on what it
// points at, so they cannot use `resolve`: canonicalizing the whole path
// follows a final symlink, which would rename or delete the link's target, and
// a path that does not exist yet cannot be canonicalized at all.

/// The longest a search answers with. The explorer is a sidebar, not a results
/// page, and a list nobody can scan is the same as no answer.
const MAX_SEARCH_HITS: usize = 200;
/// Entries visited before a search gives up and answers with what it has.
const MAX_SEARCH_SCANNED: usize = 40_000;
/// Depth the search walk descends. Deeper than this is generated output.
const MAX_SEARCH_DEPTH: usize = 12;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSearch {
    pub entries: Vec<TreeEntry>,
    /// True when a cap was hit, so the list is a prefix of the real answer.
    pub truncated: bool,
}

/// Resolve a project-relative path without following a final symlink.
///
/// The parent is canonicalized and checked for containment — which is what
/// stops a symlinked directory inside the project from being used as a way
/// out — and the last component is then joined on verbatim.
fn resolve_entry(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("invalid path: {rel}"));
    }
    // None for "" — which is the project root, and nothing here may touch it.
    let name = rel_path
        .file_name()
        .ok_or_else(|| format!("invalid path: {rel}"))?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let parent = canonical_root
        .join(rel_path.parent().unwrap_or(Path::new("")))
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&canonical_root) {
        return Err(format!("path escapes project root: {rel}"));
    }
    Ok(parent.join(name))
}

/// Validate a single new name typed into the explorer.
///
/// One path component, deliberately: the prompts are "new file *in this
/// folder*" and "rename *this*", so a separator in the box means the user is
/// describing a different operation than the one they picked, and quietly
/// creating intermediate directories through it would also be a way past the
/// containment check that only ever inspects one parent.
fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name cannot be empty".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("name cannot contain a path separator".into());
    }
    if name == "." || name == ".." || name.contains('\0') {
        return Err(format!("invalid name: {name}"));
    }
    if name == ".git" {
        return Err(".git is managed by git".into());
    }
    Ok(name.to_string())
}

/// Refuse to touch the git directory. Everything else in the tree is the
/// user's to lose; `.git` is the repository itself.
fn check_not_git(rel: &str) -> Result<(), String> {
    if rel == ".git" || rel.starts_with(".git/") {
        return Err(".git is managed by git".into());
    }
    Ok(())
}

/// Create an empty file or a directory inside `dir` (relative, "" = root).
///
/// Returns the new entry's project-relative path so the caller can select it
/// without guessing how the two halves join.
#[tauri::command(async)]
pub fn create_entry(
    manager: tauri::State<SessionManager>,
    dir: String,
    name: String,
    is_dir: bool,
    root: Option<String>,
) -> Result<String, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let name = check_name(&name)?;
    let parent = resolve(&root, &dir)?;
    if !parent.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let target = parent.join(&name);
    // `create_new` would cover the file case, but a directory has no such flag
    // and the message it fails with is worse than this one.
    if target.exists() {
        return Err(format!("{name} already exists"));
    }
    if is_dir {
        std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
    }
    Ok(if dir.is_empty() {
        name
    } else {
        format!("{dir}/{name}")
    })
}

/// Rename an entry in place, returning its new project-relative path.
#[tauri::command(async)]
pub fn rename_entry(
    manager: tauri::State<SessionManager>,
    path: String,
    name: String,
    root: Option<String>,
) -> Result<String, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    check_not_git(&path)?;
    let name = check_name(&name)?;
    let from = resolve_entry(&root, &path)?;
    let target = from
        .parent()
        .ok_or_else(|| format!("invalid path: {path}"))?
        .join(&name);
    if target == from {
        return Ok(path);
    }
    // `rename` would silently replace an existing file, which is not what
    // "rename" means to the person who typed the name.
    if target.exists() {
        return Err(format!("{name} already exists"));
    }
    std::fs::rename(&from, &target).map_err(|e| e.to_string())?;
    let parent_rel = Path::new(&path).parent().and_then(Path::to_str).unwrap_or("");
    Ok(if parent_rel.is_empty() {
        name
    } else {
        format!("{parent_rel}/{name}")
    })
}

/// Delete a file, a symlink, or a directory and everything under it.
///
/// Permanent — there is no trash here — so every caller must have confirmed
/// first. Symlinks are unlinked rather than followed (see `resolve_entry`).
#[tauri::command(async)]
pub fn delete_entry(
    manager: tauri::State<SessionManager>,
    path: String,
    root: Option<String>,
) -> Result<(), String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    check_not_git(&path)?;
    let abs = resolve_entry(&root, &path)?;
    let meta = std::fs::symlink_metadata(&abs).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&abs).map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------- move and copy
//
// Both take a *destination directory* rather than a destination path: the
// explorer's gesture is "put this in there", and the name comes along
// unchanged. Renaming during a move is `rename_entry`'s job.

/// The folder half of a project-relative path ("" for a top-level entry).
fn parent_rel(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(cut) => &rel[..cut],
        None => "",
    }
}

/// True when `dir` is `path` itself or sits underneath it. Moving or copying a
/// folder into its own subtree is either a no-op or an infinite descent, and
/// neither is what the gesture meant.
fn is_self_or_descendant(dir: &str, path: &str) -> bool {
    dir == path || dir.starts_with(&format!("{path}/"))
}

/// A name in `dir` that is not taken yet: `notes.md`, then `notes copy.md`,
/// then `notes copy 2.md`.
///
/// Only copies uniquify. A *move* onto an existing name is refused instead,
/// because the two files are the same file and silently renaming one of them
/// hides that from the person who dragged it.
fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let plain = dir.join(name);
    if !plain.exists() {
        return plain;
    }
    // Split on the *last* dot only, and never on a leading one, so `.gitignore`
    // keeps its whole name and `archive.tar.gz` becomes `archive.tar copy.gz`.
    let as_path = Path::new(name);
    let (stem, ext) = match as_path.extension().and_then(|e| e.to_str()) {
        Some(ext) => (
            as_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(name)
                .to_string(),
            format!(".{ext}"),
        ),
        None => (name.to_string(), String::new()),
    };
    for n in 1..1000 {
        let suffix = if n == 1 {
            " copy".to_string()
        } else {
            format!(" copy {n}")
        };
        let candidate = dir.join(format!("{stem}{suffix}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // A thousand copies of one name is not a case worth a better answer than
    // "pick something that cannot collide".
    dir.join(format!("{stem} copy {}{ext}", std::process::id()))
}

/// Resolve `dir` as a destination folder for a move or a copy.
fn resolve_dest_dir(root: &Path, dir: &str) -> Result<PathBuf, String> {
    check_not_git(dir)?;
    let abs = resolve(root, dir)?;
    if !abs.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    Ok(abs)
}

/// Move an entry into `to_dir`, returning its new project-relative path.
#[tauri::command(async)]
pub fn move_entry(
    manager: tauri::State<SessionManager>,
    from: String,
    to_dir: String,
    root: Option<String>,
) -> Result<String, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    check_not_git(&from)?;
    if is_self_or_descendant(&to_dir, &from) {
        return Err("cannot move a folder into itself".into());
    }
    // Already there: the drop landed on the folder the entry is in. Answering
    // with the unchanged path lets the caller treat it like any other move.
    if parent_rel(&from) == to_dir {
        return Ok(from);
    }
    let dest_dir = resolve_dest_dir(&root, &to_dir)?;
    let source = resolve_entry(&root, &from)?;
    // The entry has to exist to be moved, and `resolve_entry` deliberately does
    // not check that (it also serves creation).
    std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
    let name = Path::new(&from)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid path: {from}"))?
        .to_string();
    let target = dest_dir.join(&name);
    if target.exists() {
        return Err(format!("{name} already exists in {}", dir_label(&to_dir)));
    }
    std::fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(join_rel(&to_dir, &name))
}

/// Copy an entry into `to_dir`, returning the new entry's project-relative
/// path. Directories go with everything under them; a name already in use is
/// suffixed rather than overwritten, so copy-into-the-same-folder works.
#[tauri::command(async)]
pub fn copy_entry(
    manager: tauri::State<SessionManager>,
    from: String,
    to_dir: String,
    root: Option<String>,
) -> Result<String, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    check_not_git(&from)?;
    if is_self_or_descendant(&to_dir, &from) {
        return Err("cannot copy a folder into itself".into());
    }
    let dest_dir = resolve_dest_dir(&root, &to_dir)?;
    let source = resolve_entry(&root, &from)?;
    let meta = std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
    let name = Path::new(&from)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid path: {from}"))?
        .to_string();
    let target = unique_target(&dest_dir, &name);
    copy_tree(&source, &target, &meta.file_type())?;
    let created = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .to_string();
    Ok(join_rel(&to_dir, &created))
}

/// "the project root" or the folder's own path, for an error message.
fn dir_label(dir: &str) -> String {
    if dir.is_empty() {
        "the project root".into()
    } else {
        dir.to_string()
    }
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Copy one entry to `target`, recursing through directories.
///
/// Symlinks are recreated as symlinks rather than followed: copying a link
/// should not duplicate whatever it points at, which may be large, outside the
/// project, or the very folder being copied.
fn copy_tree(source: &Path, target: &Path, kind: &std::fs::FileType) -> Result<(), String> {
    if kind.is_symlink() {
        #[cfg(unix)]
        {
            let link = std::fs::read_link(source).map_err(|e| e.to_string())?;
            return std::os::unix::fs::symlink(link, target).map_err(|e| e.to_string());
        }
        #[cfg(not(unix))]
        {
            // No portable way to recreate one without knowing whether it points
            // at a directory; copying the contents is the lesser surprise.
            std::fs::copy(source, target).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    if !kind.is_dir() {
        std::fs::copy(source, target).map_err(|e| e.to_string())?;
        return Ok(());
    }
    std::fs::create_dir(target).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let child_kind = entry.file_type().map_err(|e| e.to_string())?;
        copy_tree(&entry.path(), &target.join(entry.file_name()), &child_kind)?;
    }
    Ok(())
}

/// Entries anywhere under the root whose name (or path) contains `query`.
///
/// Case-insensitive plain substring: nobody types a regex into an explorer
/// filter by accident, and a broken one would be an error message where an
/// answer belongs. Ranked name-prefix, then name, then path — the file you
/// were thinking of first, the directory that merely contains the word last.
#[tauri::command(async)]
pub fn search_tree(
    manager: tauri::State<SessionManager>,
    query: String,
    root: Option<String>,
) -> Result<TreeSearch, String> {
    let (root, git_mode) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let needle = query.trim().to_lowercase();
    let mut out = TreeSearch {
        entries: Vec::new(),
        truncated: false,
    };
    if needle.is_empty() {
        return Ok(out);
    }

    // (rank, path length, path, name, is_dir). Length breaks rank ties so a
    // shallow `src/app.css` outranks a deep one that scores the same.
    let mut scored: Vec<(u8, usize, String, String, bool)> = Vec::new();
    let mut scanned = 0usize;
    let walker = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .max_depth(MAX_SEARCH_DEPTH)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            // Dot-directories are kept: `.github` and `.cargo` are places
            // people look for. Only the two kinds nobody browses are pruned.
            name != ".git" && !crate::session::IGNORED_DIRS.contains(&name.as_ref())
        });

    for entry in walker.filter_map(Result::ok) {
        if entry.depth() == 0 {
            continue;
        }
        scanned += 1;
        if scanned > MAX_SEARCH_SCANNED {
            out.truncated = true;
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        let rank = if lower.starts_with(&needle) {
            0
        } else if lower.contains(&needle) {
            1
        } else if rel.to_lowercase().contains(&needle) {
            2
        } else {
            continue;
        };
        scored.push((rank, rel.len(), rel, name, entry.file_type().is_dir()));
    }

    scored.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    if scored.len() > MAX_SEARCH_HITS {
        out.truncated = true;
        scored.truncate(MAX_SEARCH_HITS);
    }

    // Only the survivors are asked about: `check-ignore` is one process, and
    // handing it the whole walk to label two hundred rows would be the most
    // expensive part of the search.
    let rels: Vec<String> = scored.iter().map(|(_, _, rel, _, _)| rel.clone()).collect();
    let ignored_set = if git_mode {
        git_ignored(&root, &rels)
    } else {
        HashSet::new()
    };

    out.entries = scored
        .into_iter()
        .map(|(_, _, path, name, is_dir)| {
            let ignored = ignored_set.contains(&path)
                || (!git_mode && crate::session::IGNORED_DIRS.contains(&name.as_str()));
            TreeEntry {
                name,
                path,
                is_dir,
                ignored,
            }
        })
        .collect();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termax-fstree-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_entry_allows_a_path_that_does_not_exist_yet() {
        let root = temp_root("create");
        let target = resolve_entry(&root, "new.txt").unwrap();
        assert_eq!(target, root.canonicalize().unwrap().join("new.txt"));
    }

    #[test]
    fn resolve_entry_refuses_the_root_itself() {
        let root = temp_root("root");
        assert!(resolve_entry(&root, "").is_err());
    }

    #[test]
    fn resolve_entry_refuses_escapes() {
        let root = temp_root("escape");
        assert!(resolve_entry(&root, "../outside").is_err());
        assert!(resolve_entry(&root, "/etc/passwd").is_err());
    }

    /// The reason this exists at all: deleting `link` must unlink the link, and
    /// `resolve` would have handed back the target it points at instead.
    #[cfg(unix)]
    #[test]
    fn resolve_entry_does_not_follow_a_final_symlink() {
        let root = temp_root("symlink");
        let outside = std::env::temp_dir().join("termax-fstree-test-symlink-target");
        std::fs::write(&outside, "keep me").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(resolve(&root, "link").is_err(), "resolve must reject the escape");
        let entry = resolve_entry(&root, "link").unwrap();
        assert_eq!(entry, root.canonicalize().unwrap().join("link"));

        std::fs::remove_file(&entry).unwrap();
        assert!(outside.exists(), "the link's target must survive");
        std::fs::remove_file(&outside).unwrap();
    }

    /// A symlinked *directory* is still an escape: the containment check reads
    /// the parent, so `link/file` resolves outside the root and is rejected.
    #[cfg(unix)]
    #[test]
    fn resolve_entry_refuses_a_symlinked_parent() {
        let root = temp_root("symlink-parent");
        let outside = std::env::temp_dir().join("termax-fstree-test-symlink-dir");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(resolve_entry(&root, "link/file.txt").is_err());
    }

    #[test]
    fn check_name_takes_one_component_only() {
        assert_eq!(check_name("  notes.md  ").unwrap(), "notes.md");
        assert!(check_name("").is_err());
        assert!(check_name("a/b").is_err());
        assert!(check_name("a\\b").is_err());
        assert!(check_name("..").is_err());
        assert!(check_name(".git").is_err());
    }

    #[test]
    fn unique_target_suffixes_a_taken_name_and_keeps_the_extension() {
        let root = temp_root("unique");
        assert_eq!(unique_target(&root, "notes.md"), root.join("notes.md"));

        std::fs::write(root.join("notes.md"), "").unwrap();
        assert_eq!(unique_target(&root, "notes.md"), root.join("notes copy.md"));

        std::fs::write(root.join("notes copy.md"), "").unwrap();
        assert_eq!(unique_target(&root, "notes.md"), root.join("notes copy 2.md"));
    }

    /// A dotfile is all name and no extension, so the suffix goes on the end.
    #[test]
    fn unique_target_does_not_split_a_leading_dot() {
        let root = temp_root("unique-dotfile");
        std::fs::write(root.join(".gitignore"), "").unwrap();
        assert_eq!(
            unique_target(&root, ".gitignore"),
            root.join(".gitignore copy")
        );
    }

    #[test]
    fn self_or_descendant_catches_a_folder_dropped_into_itself() {
        assert!(is_self_or_descendant("src", "src"));
        assert!(is_self_or_descendant("src/lib/components", "src"));
        assert!(!is_self_or_descendant("srcs", "src"));
        assert!(!is_self_or_descendant("", "src"));
        assert!(!is_self_or_descendant("src", "src/lib"));
    }

    #[test]
    fn parent_rel_is_the_folder_half() {
        assert_eq!(parent_rel("src/lib/ipc.ts"), "src/lib");
        assert_eq!(parent_rel("README.md"), "");
    }

    /// Copying a folder duplicates what is inside it, and a symlink stays a
    /// symlink rather than becoming a copy of whatever it points at.
    #[cfg(unix)]
    #[test]
    fn copy_tree_recurses_and_preserves_symlinks() {
        let root = temp_root("copy-tree");
        std::fs::create_dir_all(root.join("from/inner")).unwrap();
        std::fs::write(root.join("from/inner/a.txt"), "hello").unwrap();
        std::os::unix::fs::symlink("inner/a.txt", root.join("from/link")).unwrap();

        let kind = std::fs::symlink_metadata(root.join("from"))
            .unwrap()
            .file_type();
        copy_tree(&root.join("from"), &root.join("to"), &kind).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("to/inner/a.txt")).unwrap(),
            "hello"
        );
        assert!(std::fs::symlink_metadata(root.join("to/link"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn check_not_git_guards_the_repository() {
        assert!(check_not_git(".git").is_err());
        assert!(check_not_git(".git/config").is_err());
        assert!(check_not_git(".gitignore").is_ok());
    }
}
