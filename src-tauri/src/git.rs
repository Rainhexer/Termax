use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub detached: bool,
    pub has_upstream: bool,
    /// Tracking ref, e.g. "origin/main"; None when no upstream is set.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// Browser URL for the repo's remote (e.g. "https://github.com/owner/repo"),
    /// normalized from an SSH or HTTPS git remote. None when there's no remote.
    pub remote_url: Option<String>,
}

#[derive(Serialize)]
pub struct GitChangeEntry {
    pub path: String,
    /// "staged" | "unstaged" | "untracked"
    pub area: String,
    /// Single-letter status: A/M/D/R/C ("C" = merge conflict, "U" for untracked).
    pub status: String,
    pub added: usize,
    pub removed: usize,
}

/// Platform null device, used to neutralize `core.hooksPath`.
#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// A `git` invocation hardened against hostile repositories. Running git inside
/// a directory whose `.git/config` is attacker-controlled is a known
/// code-execution vector (`core.fsmonitor`, `core.pager`, hooks, `protocol.ext`
/// helpers). We disable those and forbid interactive credential prompts. Folder
/// trust (see `trust.rs`) is the primary gate; this is defense-in-depth so even
/// a trusted repo can't invoke a hook/fsmonitor binary implicitly.
fn git_command(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "-c",
            "core.fsmonitor=",
            "-c",
            &format!("core.hooksPath={NULL_DEVICE}"),
            "-c",
            "protocol.ext.allow=never",
        ])
        .arg("-C")
        .arg(root);
    cmd
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_command(root)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

fn git_text(root: &Path, args: &[&str]) -> Result<String, String> {
    git(root, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn is_repo(root: &Path) -> bool {
    git_command(root)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Parse `git diff --numstat` output into path -> (added, removed).
/// Binary files report "-" and count as (0, 0).
fn numstat(root: &Path, cached: bool) -> HashMap<String, (usize, usize)> {
    let mut args = vec!["diff", "--numstat"];
    if cached {
        args.push("--cached");
    }
    let mut map = HashMap::new();
    let Ok(text) = git_text(root, &args) else {
        return map;
    };
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let removed = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let Some(path) = parts.next() else { continue };
        // Renames render as "old => new" or "prefix/{old => new}/rest"; keep the new path.
        let path = if let Some(idx) = path.find(" => ") {
            if let (Some(open), Some(close)) = (path.find('{'), path.find('}')) {
                format!("{}{}{}", &path[..open], &path[idx + 4..close], &path[close + 1..])
            } else {
                path[idx + 4..].to_string()
            }
        } else {
            path.to_string()
        };
        map.insert(path, (added, removed));
    }
    map
}

fn count_lines(root: &Path, rel: &str) -> usize {
    let abs = root.join(rel);
    let Ok(meta) = std::fs::metadata(&abs) else { return 0 };
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return 0;
    }
    let Ok(bytes) = std::fs::read(&abs) else { return 0 };
    if bytes.contains(&0) {
        return 0; // binary
    }
    String::from_utf8_lossy(&bytes).lines().count()
}

pub fn status(root: &Path) -> Result<(GitStatus, Vec<GitChangeEntry>), String> {
    let text = git_text(
        root,
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    )?;

    let mut branch = String::from("HEAD");
    let mut detached = false;
    let mut has_upstream = false;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();

    let staged_counts = numstat(root, true);
    let unstaged_counts = numstat(root, false);

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                detached = true;
                branch = git_text(root, &["rev-parse", "--short", "HEAD"])
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| "HEAD".into());
            } else {
                branch = rest.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            has_upstream = true;
            upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            let (added, _) = (count_lines(root, rest), 0);
            entries.push(GitChangeEntry {
                path: rest.to_string(),
                area: "untracked".into(),
                status: "U".into(),
                added,
                removed: 0,
            });
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = &line[2..4];
            let x = xy.as_bytes()[0] as char;
            let y = xy.as_bytes()[1] as char;
            // Field 8 (0-indexed from the record type) is the path; renames
            // append "\torigPath" which splitn keeps out of field 8's tab split.
            let path = if line.starts_with("1 ") {
                line.splitn(9, ' ').nth(8)
            } else {
                line.splitn(10, ' ')
                    .nth(9)
                    .and_then(|p| p.split('\t').next())
            };
            let Some(path) = path else { continue };
            if x != '.' {
                let (added, removed) = staged_counts.get(path).copied().unwrap_or((0, 0));
                entries.push(GitChangeEntry {
                    path: path.to_string(),
                    area: "staged".into(),
                    status: x.to_string(),
                    added,
                    removed,
                });
            }
            if y != '.' {
                let (added, removed) = unstaged_counts.get(path).copied().unwrap_or((0, 0));
                entries.push(GitChangeEntry {
                    path: path.to_string(),
                    area: "unstaged".into(),
                    status: y.to_string(),
                    added,
                    removed,
                });
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged (conflict): fields are XY sub m1 m2 m3 mW h1 h2 h3 path
            let Some(path) = rest.splitn(10, ' ').nth(9) else { continue };
            let (added, removed) = unstaged_counts.get(path).copied().unwrap_or((0, 0));
            entries.push(GitChangeEntry {
                path: path.to_string(),
                area: "unstaged".into(),
                status: "C".into(),
                added,
                removed,
            });
        }
    }

    let order = |area: &str| match area {
        "staged" => 0,
        "unstaged" => 1,
        _ => 2,
    };
    entries.sort_by(|a, b| {
        order(&a.area)
            .cmp(&order(&b.area))
            .then_with(|| a.path.cmp(&b.path))
    });

    Ok((
        GitStatus {
            branch,
            detached,
            has_upstream,
            upstream,
            ahead,
            behind,
            remote_url: remote_web_url(root),
        },
        entries,
    ))
}

/// Local branch names, in git's default (alphabetical) order. Used to populate
/// the branch switcher.
pub fn branches(root: &Path) -> Result<Vec<String>, String> {
    let text = git_text(root, &["branch", "--format=%(refname:short)"])?;
    Ok(text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Switch to `branch`. Errors (e.g. uncommitted changes that would be
/// overwritten) come back as git's stderr, which the UI surfaces verbatim.
pub fn checkout(root: &Path, branch: &str) -> Result<(), String> {
    git(root, &["checkout", branch]).map(|_| ())
}

/// Browser URL for the repo's default remote (origin, else the first remote),
/// or None when there is no remote or it can't be parsed.
fn remote_web_url(root: &Path) -> Option<String> {
    let raw = git_text(root, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let first = git_text(root, &["remote"])
                .ok()?
                .lines()
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            git_text(root, &["remote", "get-url", &first])
                .ok()
                .map(|s| s.trim().to_string())
        })?;
    normalize_remote_url(&raw)
}

/// Normalize an SSH or HTTPS git remote into an `https://host/owner/repo` web
/// URL, stripping any embedded credentials, the `.git` suffix, and ports.
fn normalize_remote_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let (host, path) = if let Some(rest) = url.strip_prefix("git@") {
        // scp-like: git@host:owner/repo(.git)
        let (host, path) = rest.split_once(':')?;
        (host, path)
    } else if let Some(rest) = url
        .strip_prefix("ssh://")
        .or_else(|| url.strip_prefix("git://"))
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("http://"))
    {
        // Drop any user[:pass]@ credential, then split host from path.
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        rest.split_once('/')?
    } else {
        return None;
    };
    // Host may carry a port (ssh://host:22/...) — keep only the hostname.
    let host = host.split(':').next().unwrap_or(host).trim();
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("https://{host}/{path}"))
}

/// Fetch from the default remote so ahead/behind reflect the real upstream.
/// Best-effort: network/auth failures bubble up as the caller's error.
pub fn fetch(root: &Path) -> Result<(), String> {
    git(root, &["fetch", "--quiet"]).map(|_| ())
}

/// Fast-forward pull. Returns git's stdout on success. A diverged branch or a
/// dirty worktree that blocks the fast-forward comes back as git's stderr Err,
/// which the UI surfaces verbatim.
pub fn pull(root: &Path) -> Result<String, String> {
    git_text(root, &["pull", "--ff-only"]).map(|s| s.trim().to_string())
}

/// Blob content, or None if the object doesn't exist or is binary.
fn show(root: &Path, spec: &str) -> Option<String> {
    let bytes = git(root, &["show", spec]).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn object_exists(root: &Path, spec: &str) -> bool {
    git(root, &["cat-file", "-e", spec]).is_ok()
}

fn read_worktree(root: &Path, rel: &str) -> (Option<String>, bool) {
    let abs = root.join(rel);
    let Ok(meta) = std::fs::metadata(&abs) else {
        return (None, false); // deleted
    };
    if !meta.is_file() {
        return (None, false);
    }
    let Ok(bytes) = std::fs::read(&abs) else {
        return (None, false);
    };
    if bytes.contains(&0) {
        return (None, true); // binary
    }
    (Some(String::from_utf8_lossy(&bytes).into_owned()), false)
}

/// original/modified pair for a git-mode diff.
/// area: "staged" -> HEAD vs index; "unstaged" -> index (or HEAD) vs worktree;
/// "untracked" -> empty vs worktree.
pub fn diff(root: &Path, rel: &str, area: &str) -> Result<(String, String, bool), String> {
    let head_spec = format!("HEAD:{rel}");
    let index_spec = format!(":0:{rel}");

    match area {
        "staged" => {
            let head_exists = object_exists(root, &head_spec);
            let index_exists = object_exists(root, &index_spec);
            let original = if head_exists { show(root, &head_spec) } else { Some(String::new()) };
            let modified = if index_exists { show(root, &index_spec) } else { Some(String::new()) };
            let binary = (head_exists && original.is_none()) || (index_exists && modified.is_none());
            Ok((
                original.unwrap_or_default(),
                modified.unwrap_or_default(),
                binary,
            ))
        }
        "untracked" => {
            let (content, binary) = read_worktree(root, rel);
            Ok((String::new(), content.unwrap_or_default(), binary))
        }
        _ => {
            // Unstaged: base is the index; conflicted files have no stage 0,
            // fall back to HEAD, then empty.
            let base_spec = if object_exists(root, &index_spec) {
                Some(index_spec)
            } else if object_exists(root, &head_spec) {
                Some(head_spec)
            } else {
                None
            };
            let original = base_spec.as_deref().and_then(|s| show(root, s));
            let base_binary = base_spec.is_some() && original.is_none();
            let (modified, wt_binary) = read_worktree(root, rel);
            Ok((
                original.unwrap_or_default(),
                modified.unwrap_or_default(),
                base_binary || wt_binary,
            ))
        }
    }
}
