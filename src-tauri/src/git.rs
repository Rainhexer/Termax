use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    /// Single-letter status, matching git's porcelain: A added, M modified,
    /// D deleted, R renamed, C copied, U unmerged (a conflict). Untracked
    /// entries carry area "untracked" and are rendered separately.
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
pub(crate) fn git_command(root: &Path) -> Command {
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
                // "?" as in git's porcelain. Previously "U", which now means
                // unmerged — two different states must not share a letter.
                status: "?".into(),
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
                // "U" (unmerged), not "C": git's own porcelain uses C for
                // *copied*, so reusing it here made a merge conflict render with
                // the copied/renamed letter and colour, with nothing anywhere
                // saying "conflict".
                status: "U".into(),
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

/// Create `branch` at HEAD and switch to it.
///
/// Uncommitted work follows you onto the new branch, which is the point: the
/// common case is realising you have been committing to the default branch and
/// wanting somewhere to put a pull request from.
pub fn create_branch(root: &Path, branch: &str) -> Result<(), String> {
    git(root, &["checkout", "-b", branch]).map(|_| ())
}

/// Browser URL for the repo's default remote (origin, else the first remote),
/// or None when there is no remote or it can't be parsed.
pub fn remote_web_url(root: &Path) -> Option<String> {
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

/// One entry of `git worktree list`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    /// Absolute path, as git reports it.
    pub path: String,
    /// Short branch name, or None when the worktree is detached.
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
    /// `git worktree lock`ed — removal will refuse without --force.
    pub locked: bool,
    /// The main working tree (the one holding the real `.git` directory).
    pub is_main: bool,
}

/// The worktrees of this repository, main tree first.
///
/// This is also the containment check for worktree paths arriving from the
/// frontend: a path is only ever opened as a session if git itself lists it
/// here, so the backend never takes the frontend's word for what is part of the
/// repository.
pub fn worktrees(root: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let text = git_text(root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&text))
}

/// Parse `git worktree list --porcelain`: blank-line-separated blocks, each
/// starting with `worktree <path>`, then `HEAD <sha>`, then either
/// `branch <ref>` or a bare `detached`. The first block is always the main tree.
fn parse_worktrees(text: &str) -> Vec<WorktreeEntry> {
    let mut out: Vec<WorktreeEntry> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            out.push(WorktreeEntry {
                path: path.to_string(),
                branch: None,
                head: String::new(),
                detached: false,
                locked: false,
                is_main: out.is_empty(),
            });
            continue;
        }
        let Some(entry) = out.last_mut() else { continue };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.to_string();
        } else if let Some(reference) = line.strip_prefix("branch ") {
            entry.branch = Some(
                reference
                    .strip_prefix("refs/heads/")
                    .unwrap_or(reference)
                    .to_string(),
            );
        } else if line == "detached" {
            entry.detached = true;
        } else if line == "locked" || line.starts_with("locked ") {
            entry.locked = true;
        }
    }
    out
}

/// Absolute `(git_dir, common_dir)` for `root`.
///
/// These differ inside a linked worktree: `git_dir` is
/// `<main>/.git/worktrees/<name>` (holding that tree's own HEAD and index) while
/// `common_dir` is `<main>/.git` (holding the shared refs). Both are needed to
/// watch a worktree correctly — its `.git` is a *file*, so watching the worktree
/// root alone never sees a commit.
pub fn git_dirs(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let text = git_text(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ],
    )?;
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let git_dir = lines
        .next()
        .ok_or("git rev-parse did not report a git directory")?;
    // Older git without --git-common-dir support prints only one line; in a main
    // worktree the two are the same anyway.
    let common_dir = lines.next().unwrap_or(git_dir);
    Ok((PathBuf::from(git_dir), PathBuf::from(common_dir)))
}

/// Default branch of the remote, e.g. "main". Read from the local
/// `refs/remotes/origin/HEAD` symref rather than asking the network.
pub fn default_branch(root: &Path) -> Option<String> {
    let text = git_text(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]).ok()?;
    let name = text.trim();
    let short = name.rsplit_once('/').map(|(_, b)| b).unwrap_or(name);
    (!short.is_empty()).then(|| short.to_string())
}

/// Create a worktree at `path` on `branch`, tracking `origin/<branch>`.
///
/// `-B` resets an existing local branch onto the remote tip, which is what
/// "start work on this PR" means. Errors are git's stderr; the caller must
/// recognize "already used by worktree at …" and turn it into a tab switch
/// rather than showing it raw.
pub fn worktree_add_tracking(root: &Path, path: &Path, branch: &str) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    let start = format!("origin/{branch}");
    git(
        root,
        &[
            "worktree", "add", &path, "--track", "-B", branch, &start,
        ],
    )
    .map(|_| ())
}

/// Create a detached worktree at `path` on an arbitrary committish. Used for
/// fork PRs, whose head branch does not exist in this repository.
pub fn worktree_add_detached(root: &Path, path: &Path, committish: &str) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    git(root, &["worktree", "add", "--detach", &path, committish]).map(|_| ())
}

/// Remove a worktree. Without `force`, git refuses when the tree has changes —
/// which is the desired default: a worktree can hold the only copy of work.
pub fn worktree_remove(root: &Path, path: &Path, force: bool) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    git(root, &args).map(|_| ())
}

/// Drop administrative records for worktrees whose directories are gone.
pub fn worktree_prune(root: &Path) -> Result<(), String> {
    git(root, &["worktree", "prune"]).map(|_| ())
}

/// Fetch a single branch from origin, so a worktree can be created from a tip we
/// may not have yet.
pub fn fetch_branch(root: &Path, branch: &str) -> Result<(), String> {
    git(root, &["fetch", "origin", branch]).map(|_| ())
}

/// Fetch a pull request's head into a local ref. Used for fork PRs, whose head
/// branch does not exist in this repository at all.
pub fn fetch_pr_head(root: &Path, number: u64) -> Result<String, String> {
    let local = format!("refs/termax/pr/{number}");
    let spec = format!("refs/pull/{number}/head:{local}");
    git(root, &["fetch", "--force", "origin", &spec])?;
    Ok(local)
}

/// Push `branch` to origin, setting upstream.
///
/// `force_with_lease` is offered only as a second, explicit action after a
/// non-fast-forward rejection. Plain `--force` is never used: it discards
/// whatever arrived on the remote in the meantime without noticing.
pub fn push(root: &Path, branch: &str, force_with_lease: bool) -> Result<String, String> {
    let mut args = vec!["push", "--set-upstream"];
    if force_with_lease {
        args.push("--force-with-lease");
    }
    args.push("origin");
    args.push(branch);
    git_text(root, &args).map(|s| s.trim().to_string())
}

/// Delete a branch locally and/or on origin.
///
/// `-d` (not `-D`) locally, so git refuses to drop a branch that is not merged.
/// Discarding unmerged commits should never be a side effect of a cleanup button.
pub fn delete_branch(
    root: &Path,
    branch: &str,
    local: bool,
    remote: bool,
) -> Result<(), String> {
    if local {
        git(root, &["branch", "-d", branch])?;
    }
    if remote {
        git(root, &["push", "origin", "--delete", branch])?;
    }
    Ok(())
}

/// Subject lines of the commits on `branch` that are not on `base`, newest first.
/// Used to prefill a pull-request body.
pub fn commit_subjects(root: &Path, base: &str, limit: usize) -> Vec<String> {
    let range = format!("origin/{base}..HEAD");
    let max = format!("--max-count={limit}");
    git_text(root, &["log", &range, "--format=%s", &max])
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `git worktree list --porcelain` from a repo with one linked
    /// worktree, captured from git 2.x. Note the trailing blank line and that the
    /// linked tree reports a bare `detached` instead of a `branch` line.
    const REAL_PORCELAIN: &str = "\
worktree /home/ravn/Projects/Termax
HEAD 4fcdda8a80ad0da4a3cf2d27caf44be5ccf8b958
branch refs/heads/master

worktree /tmp/scratch/wt-probe
HEAD 4fcdda8a80ad0da4a3cf2d27caf44be5ccf8b958
detached

";

    #[test]
    fn parses_real_worktree_porcelain() {
        let wts = parse_worktrees(REAL_PORCELAIN);
        assert_eq!(wts.len(), 2);

        assert_eq!(wts[0].path, "/home/ravn/Projects/Termax");
        assert_eq!(wts[0].branch.as_deref(), Some("master"), "refs/heads/ is stripped");
        assert!(wts[0].is_main, "the first block is always the main tree");
        assert!(!wts[0].detached);

        assert_eq!(wts[1].path, "/tmp/scratch/wt-probe");
        assert_eq!(wts[1].branch, None);
        assert!(wts[1].detached);
        assert!(!wts[1].is_main);
    }

    #[test]
    fn parses_locked_worktrees_in_both_forms() {
        // git prints a bare `locked` or `locked <reason>`.
        let text = "\
worktree /main
HEAD abc
branch refs/heads/main

worktree /a
HEAD abc
detached
locked

worktree /b
HEAD abc
detached
locked on removable media
";
        let wts = parse_worktrees(text);
        assert_eq!(wts.len(), 3);
        assert!(!wts[0].locked);
        assert!(wts[1].locked, "bare `locked`");
        assert!(wts[2].locked, "`locked <reason>`");
    }

    /// A branch name containing a slash must keep it: only the `refs/heads/`
    /// prefix is removed, not everything up to the last slash.
    #[test]
    fn keeps_slashes_inside_branch_names() {
        let wts = parse_worktrees("worktree /x\nHEAD abc\nbranch refs/heads/feature/nested/name\n");
        assert_eq!(wts[0].branch.as_deref(), Some("feature/nested/name"));
    }

    #[test]
    fn ignores_output_with_no_worktree_header() {
        // Defensive: a stray leading line must not panic or invent an entry.
        assert!(parse_worktrees("HEAD abc\nbranch refs/heads/x\n").is_empty());
        assert!(parse_worktrees("").is_empty());
    }

    #[test]
    fn normalizes_remote_urls() {
        let cases = [
            ("git@github.com:owner/repo.git", "https://github.com/owner/repo"),
            ("https://github.com/owner/repo.git", "https://github.com/owner/repo"),
            ("ssh://git@github.com:22/owner/repo.git", "https://github.com/owner/repo"),
            // Embedded credentials must never survive into a browser URL.
            ("https://user:token@github.com/owner/repo", "https://github.com/owner/repo"),
            ("git@gitlab.com:group/sub/repo.git", "https://gitlab.com/group/sub/repo"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_remote_url(input).as_deref(), Some(want), "input: {input}");
        }
        assert_eq!(normalize_remote_url("not a url"), None);
        assert_eq!(normalize_remote_url(""), None);
    }
}
