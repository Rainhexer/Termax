//! Home-screen data: per-project git vitals and cross-project search.
//!
//! Everything here runs *before* a project is opened, so none of it can go
//! through `SessionManager` the way `fstree.rs` does. Two rules take the place
//! of that gate:
//!
//!   * a path is only ever touched when it is a registered project's root
//!     (`project_root`), so the frontend can never name an arbitrary directory;
//!   * git only runs on folders the user has trusted (see `trust.rs`), exactly
//!     like `start_session`. An untrusted project reports `trusted: false` and
//!     the card offers to trust it rather than quietly showing nothing.
//!
//! Untrusted (and non-git) projects still take part in search, because the
//! walkdir path reads plain files and never touches `.git/config`.

use crate::git;
use crate::projects::ProjectStore;
use crate::session::IGNORED_DIRS;
use crate::trust::TrustStore;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

/// Days of commit history summarized into the card's activity grid. Four weeks
/// fills a 7-row column layout exactly, which is what makes the grid readable.
const ACTIVITY_DAYS: u32 = 28;

/// Commits summarized on a card. Three is what the identity zone fits on a
/// normal-height card, and past that the activity grid says it better.
const RECENT_COMMITS: usize = 3;

/// Hits kept per project, and in total. Search is a "where did I put that"
/// affordance on a screen with no scrollbar, not a code-search product: past a
/// couple of screenfuls more results are worse, not better.
const MAX_HITS_PER_PROJECT: usize = 12;
const MAX_TOTAL_HITS: usize = 120;

/// Caps for the non-git walk. A project may be a 200k-file monorepo with no
/// repository at all; without these, typing in the search box would stall.
const MAX_FILES_SCANNED: usize = 20_000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_WALK_DEPTH: usize = 12;

/// Longest snippet returned for a text hit, in characters.
const MAX_SNIPPET: usize = 180;

/// Files that tell an agent how to work in this repository. Their presence is
/// the single most useful thing this app can say about a folder at a glance:
/// it is the difference between "a directory" and "a project an agent has been
/// briefed on".
const AGENT_DOCS: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
];

/// Marker file -> stack tag. First match per tag wins; order is only for
/// determinism, not precedence.
const STACK_MARKERS: &[(&str, &str)] = &[
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("package.json", "node"),
    ("deno.json", "deno"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("setup.py", "python"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "java"),
    ("CMakeLists.txt", "c++"),
    ("Makefile", "make"),
    ("flake.nix", "nix"),
    ("Dockerfile", "docker"),
    ("compose.yaml", "docker"),
    ("docker-compose.yml", "docker"),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Abbreviated hash.
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// Author date, seconds since the epoch. Rendered relative by the frontend,
    /// which is the side that knows the user's locale and clock.
    pub timestamp: i64,
}

/// Commits landed on one calendar day, in the *repository's* local time (git
/// formats the date, so this matches what `git log` would print).
#[derive(Serialize, Clone)]
pub struct DayCount {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub count: u32,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStats {
    pub id: String,
    /// The directory is gone — deleted, renamed, or on an unmounted volume.
    /// Distinct from "not a repo": one is a broken entry, the other is fine.
    pub missing: bool,
    /// The user has allowed git to run here. False means every git-derived
    /// field below is empty because it was never asked, not because it is zero.
    pub trusted: bool,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    /// Unmerged paths. Kept apart from `unstaged`: a conflict is a state you
    /// must resolve, not a change you may keep working past.
    pub conflicts: usize,
    /// Most recent commits, newest first (at most {@link RECENT_COMMITS}). A
    /// list rather than one commit because the card has room for it, and
    /// "what was I doing here" is rarely answered by a single subject line.
    pub recent_commits: Vec<Commit>,
    /// Browser URL for the remote, already stripped of credentials by
    /// `git::remote_web_url`.
    pub remote_url: Option<String>,
    pub activity: Vec<DayCount>,
    /// Linked worktrees, excluding the main tree.
    pub worktrees: usize,
    /// Stack tags derived from marker files in the root.
    pub stack: Vec<String>,
    /// Which of {@link AGENT_DOCS} exist, by file name.
    pub agent_docs: Vec<String>,
}

/// Root directory of a registered project, by id.
///
/// Returning `None` for an unknown id is the containment check for every
/// path-taking command in this module: the frontend passes ids, never paths.
fn project_root(store: &ProjectStore, id: &str) -> Option<(PathBuf, String)> {
    let projects = store.projects.lock().unwrap();
    projects
        .iter()
        .find(|p| p.id == id)
        .map(|p| (PathBuf::from(&p.path), p.name.clone()))
}

fn git_text(root: &Path, args: &[&str]) -> Option<String> {
    let out = git::git_command(root).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Counts and branch state from a single `git status`.
///
/// Deliberately *not* `git::status`: that one also runs `git diff --numstat`
/// twice and reads every untracked file to count its lines. Correct for a
/// changes panel, far too expensive for a screen that asks this of every
/// project at once.
fn status_counts(root: &Path, stats: &mut ProjectStats) {
    let Some(text) = git_text(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
    ) else {
        return;
    };
    stats.is_repo = true;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                stats.detached = true;
                stats.branch = git_text(root, &["rev-parse", "--short", "HEAD"])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            } else {
                stats.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            stats.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    stats.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    stats.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("? ") {
            stats.untracked += 1;
        } else if line.starts_with("u ") {
            stats.conflicts += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = line.as_bytes();
            if xy.len() < 4 {
                continue;
            }
            if xy[2] != b'.' {
                stats.staged += 1;
            }
            if xy[3] != b'.' {
                stats.unstaged += 1;
            }
        }
    }
}

fn recent_commits(root: &Path) -> Vec<Commit> {
    let count = format!("-{RECENT_COMMITS}");
    // \x1f (unit separator) can't appear in a commit subject or an author name,
    // which a tab or a pipe very much can.
    let Some(text) = git_text(root, &["log", &count, "--format=%h\x1f%s\x1f%an\x1f%ct"]) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let sha = parts.next()?;
            if sha.is_empty() {
                return None;
            }
            Some(Commit {
                sha: sha.to_string(),
                subject: parts.next().unwrap_or_default().to_string(),
                author: parts.next().unwrap_or_default().to_string(),
                timestamp: parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0),
            })
        })
        .collect()
}

/// Commits per calendar day over the last {@link ACTIVITY_DAYS} days.
///
/// git formats the dates rather than Rust bucketing timestamps, because the
/// standard library has no timezone database: "which day was this commit on"
/// is a local-time question, and git is the one process here that can answer it.
fn activity(root: &Path) -> Vec<DayCount> {
    let since = format!("--since={ACTIVITY_DAYS} days ago");
    let Some(text) = git_text(
        root,
        &["log", &since, "--date=format:%Y-%m-%d", "--format=%cd"],
    ) else {
        return Vec::new();
    };
    let mut counts: HashMap<String, u32> = HashMap::new();
    for line in text.lines() {
        let day = line.trim();
        if day.len() == 10 {
            *counts.entry(day.to_string()).or_default() += 1;
        }
    }
    let mut days: Vec<DayCount> = counts
        .into_iter()
        .map(|(date, count)| DayCount { date, count })
        .collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));
    days
}

fn detect_markers(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut stack: Vec<String> = Vec::new();
    for (file, tag) in STACK_MARKERS {
        if root.join(file).exists() && !stack.iter().any(|t| t == tag) {
            stack.push((*tag).to_string());
        }
    }
    let agent_docs = AGENT_DOCS
        .iter()
        .filter(|doc| root.join(doc).exists())
        .map(|doc| {
            // The path form reads badly on a chip; the file name is the label.
            Path::new(doc)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| (*doc).to_string())
        })
        .collect();
    (stack, agent_docs)
}

/// Everything the home screen shows for one project.
///
/// One project per call so the frontend can fan out and paint each card as its
/// answer lands, instead of the whole screen waiting on the slowest repository
/// (a large one, or one on a network mount).
#[tauri::command(async)]
pub fn project_stats(
    store: tauri::State<ProjectStore>,
    trust: tauri::State<TrustStore>,
    id: String,
) -> Result<ProjectStats, String> {
    let (root, _) = project_root(&store, &id).ok_or("no such project")?;
    let mut stats = ProjectStats {
        id,
        ..Default::default()
    };
    if !root.is_dir() {
        stats.missing = true;
        return Ok(stats);
    }

    let (stack, agent_docs) = detect_markers(&root);
    stats.stack = stack;
    stats.agent_docs = agent_docs;

    // The trust gate. Reading marker files above is plain filesystem work;
    // everything below shells out to git, which reads `.git/config`.
    stats.trusted = trust.is_trusted(&root.to_string_lossy());
    if !stats.trusted {
        return Ok(stats);
    }

    status_counts(&root, &mut stats);
    if !stats.is_repo {
        return Ok(stats);
    }
    stats.recent_commits = recent_commits(&root);
    stats.activity = activity(&root);
    stats.remote_url = git::remote_web_url(&root);
    stats.worktrees = git::worktrees(&root)
        .map(|list| list.iter().filter(|w| !w.is_main).count())
        .unwrap_or(0);
    Ok(stats)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub project_id: String,
    pub project_name: String,
    /// Project-relative, forward slashes — the form `read_file` expects once the
    /// project is open.
    pub path: String,
    /// 1-based line number; None for a filename match.
    pub line: Option<u32>,
    /// The matching line, trimmed and truncated; None for a filename match.
    pub text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Paths whose name matched. Separate from `text` because "find the file"
    /// and "find the string" are different intents that happen to share a box.
    pub files: Vec<SearchHit>,
    pub text: Vec<SearchHit>,
    /// A cap was hit, so this is a sample rather than the answer.
    pub truncated: bool,
    /// Projects that could not be searched, by name — a missing folder. Shown so
    /// "no results" is never a lie about coverage.
    pub skipped: Vec<String>,
}

/// Trim a matched line into something a single row can hold, and strip the
/// control characters a minified or binary-ish file can carry.
fn snippet(line: &str) -> String {
    let cleaned: String = line
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_SNIPPET)
        .collect();
    cleaned
}

/// Tracked *and* untracked-but-not-ignored paths, as git sees them.
fn git_files(root: &Path) -> Vec<String> {
    git_text(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    )
    .map(|text| {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// Content search through git, which skips ignored files and binaries for free.
///
/// `-e` carries the pattern so a query starting with `-` is data rather than a
/// flag, and `--fixed-strings` means a stray `(` or `*` in the box is not a
/// regex error the user has to understand. `-z` puts a NUL after the path,
/// which is the only reliable way to split a record whose path may itself
/// contain a colon.
fn git_grep(root: &Path, query: &str) -> Vec<(String, u32, String)> {
    let Some(text) = git_text(
        root,
        &[
            "grep",
            "--no-color",
            "-I",
            "-n",
            "-z",
            "--untracked",
            "--fixed-strings",
            "--ignore-case",
            "-e",
            query,
        ],
    ) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(parse_grep_line)
        .take(MAX_HITS_PER_PROJECT)
        .collect()
}

/// One `git grep -z -n` record: `path\0line\0content`, newline-terminated.
///
/// `-z` makes *both* leading fields NUL-separated, not just the path. Splitting
/// the line number off with `:` (which is what the non-`-z` format uses) parses
/// nothing at all — and, because a search that finds nothing looks exactly like
/// a search with no matches, does it silently.
fn parse_grep_line(line: &str) -> Option<(String, u32, String)> {
    let (path, rest) = line.split_once('\0')?;
    let (number, content) = rest.split_once('\0')?;
    let number: u32 = number.trim().parse().ok()?;
    Some((path.replace('\\', "/"), number, snippet(content)))
}

/// Filesystem walk for projects that are not trusted git repositories.
///
/// Returns `(paths, text hits)`. Capped hard: this runs on every keystroke
/// (after the frontend's debounce) and may be pointed at a folder nobody has
/// ever asked git about.
fn walk_search(root: &Path, needle: &str) -> (Vec<String>, Vec<(String, u32, String)>) {
    let mut paths = Vec::new();
    let mut hits = Vec::new();
    let mut scanned = 0usize;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_WALK_DEPTH)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_dir() {
                return !IGNORED_DIRS.contains(&name.as_ref()) && !name.starts_with('.');
            }
            true
        });

    for entry in walker.filter_map(Result::ok) {
        // Both lists full, or the scan budget spent: nothing more can change.
        if scanned >= MAX_FILES_SCANNED
            || (paths.len() >= MAX_HITS_PER_PROJECT && hits.len() >= MAX_HITS_PER_PROJECT)
        {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        scanned += 1;
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.to_lowercase().contains(needle) && paths.len() < MAX_HITS_PER_PROJECT {
            paths.push(rel.clone());
        }
        if hits.len() >= MAX_HITS_PER_PROJECT {
            continue; // keep walking for filename matches only
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        if bytes.contains(&0) {
            continue; // binary
        }
        let content = String::from_utf8_lossy(&bytes);
        for (index, line) in content.lines().enumerate() {
            if hits.len() >= MAX_HITS_PER_PROJECT {
                break;
            }
            if line.to_lowercase().contains(needle) {
                hits.push((rel.clone(), index as u32 + 1, snippet(line)));
            }
        }
    }
    (paths, hits)
}

/// Search every registered project for a filename or a string.
///
/// Trusted repositories go through `git ls-files`/`git grep`, which respect
/// `.gitignore` and are an order of magnitude faster than walking; everything
/// else falls back to a capped filesystem walk. Both paths are matched
/// case-insensitively as plain substrings — nobody types a regex into a home
/// screen by accident, and a broken one would be an error message instead of an
/// answer.
#[tauri::command(async)]
pub fn search_projects(
    store: tauri::State<ProjectStore>,
    trust: tauri::State<TrustStore>,
    query: String,
) -> SearchResult {
    let needle = query.trim().to_lowercase();
    let mut result = SearchResult {
        files: Vec::new(),
        text: Vec::new(),
        truncated: false,
        skipped: Vec::new(),
    };
    if needle.len() < 2 {
        return result;
    }

    let targets: Vec<(String, String, PathBuf)> = {
        let projects = store.projects.lock().unwrap();
        projects
            .iter()
            .map(|p| (p.id.clone(), p.name.clone(), PathBuf::from(&p.path)))
            .collect()
    };

    for (id, name, root) in targets {
        if result.files.len() + result.text.len() >= MAX_TOTAL_HITS {
            result.truncated = true;
            break;
        }
        if !root.is_dir() {
            result.skipped.push(name);
            continue;
        }
        let trusted = trust.is_trusted(&root.to_string_lossy());
        let (paths, hits) = if trusted && git::is_repo(&root) {
            let paths: Vec<String> = git_files(&root)
                .into_iter()
                .filter(|p| p.to_lowercase().contains(&needle))
                .take(MAX_HITS_PER_PROJECT)
                .collect();
            (paths, git_grep(&root, query.trim()))
        } else {
            walk_search(&root, &needle)
        };

        for path in paths {
            result.files.push(SearchHit {
                project_id: id.clone(),
                project_name: name.clone(),
                path,
                line: None,
                text: None,
            });
        }
        for (path, line, text) in hits {
            result.text.push(SearchHit {
                project_id: id.clone(),
                project_name: name.clone(),
                path,
                line: Some(line),
                text: Some(text),
            });
        }
    }
    result.truncated |= result.files.len() + result.text.len() >= MAX_TOTAL_HITS;
    result.files.truncate(MAX_TOTAL_HITS);
    result.text.truncate(MAX_TOTAL_HITS);
    result
}

/// Spawn `command` detached, rooted at `dir`.
///
/// The working directory is how the target learns where to open: every terminal
/// emulator worth naming inherits it, which avoids a table of per-emulator
/// `--working-directory` spellings that would be wrong for the next one.
fn spawn_detached(mut command: Command, dir: &Path) -> Result<(), String> {
    command
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a project's folder in the system file manager.
#[tauri::command(async)]
pub fn open_project_folder(store: tauri::State<ProjectStore>, id: String) -> Result<(), String> {
    let (root, _) = project_root(&store, &id).ok_or("no such project")?;
    if !root.is_dir() {
        return Err(format!("folder is missing: {}", root.display()));
    }

    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";

    let mut command = Command::new(opener);
    command.arg(&root);
    spawn_detached(command, &root)
}

/// Terminal emulators tried in order on Linux, most-configured first.
///
/// `$TERMINAL` is checked before any of them: a user who set it has already
/// answered this question.
#[cfg(target_os = "linux")]
const LINUX_TERMINALS: &[&str] = &[
    "x-terminal-emulator",
    "kitty",
    "alacritty",
    "wezterm",
    "ghostty",
    "konsole",
    "gnome-terminal",
    "xfce4-terminal",
    "foot",
    "xterm",
];

/// Open a project's folder in an external terminal emulator.
///
/// Termax has its own terminals, so this exists for the times you want a shell
/// *outside* the app — a stray `sudo`, a long-running server you don't want
/// bound to this window's lifetime.
#[tauri::command(async)]
pub fn open_project_terminal(store: tauri::State<ProjectStore>, id: String) -> Result<(), String> {
    let (root, _) = project_root(&store, &id).ok_or("no such project")?;
    if !root.is_dir() {
        return Err(format!("folder is missing: {}", root.display()));
    }

    #[cfg(target_os = "linux")]
    {
        let preferred = std::env::var("TERMINAL").ok().filter(|s| !s.is_empty());
        let candidates: Vec<String> = preferred
            .into_iter()
            .chain(LINUX_TERMINALS.iter().map(|s| (*s).to_string()))
            .collect();
        for candidate in &candidates {
            if spawn_detached(Command::new(candidate), &root).is_ok() {
                return Ok(());
            }
        }
        Err("no terminal emulator found — set $TERMINAL to the one you use".into())
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.args(["-a", "Terminal"]).arg(&root);
        spawn_detached(command, &root)
    }
    #[cfg(target_os = "windows")]
    {
        // Windows Terminal when present, otherwise the console host. `-d .`
        // rather than the path so the inherited working directory decides.
        let mut wt = Command::new("wt");
        wt.args(["-d", "."]);
        if spawn_detached(wt, &root).is_ok() {
            return Ok(());
        }
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "cmd"]);
        spawn_detached(cmd, &root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_lose_control_characters_and_length() {
        let line = format!("\tlet x = 1;\u{7}{}", "y".repeat(400));
        let out = snippet(&line);
        assert!(out.starts_with("let x = 1;"), "leading tab is trimmed: {out}");
        assert!(!out.contains('\u{7}'), "control chars are replaced");
        assert_eq!(out.chars().count(), MAX_SNIPPET);
    }

    /// Verbatim `git grep -z -n` output, captured from git 2.x. Both the path
    /// *and* the line number are NUL-separated — the whole reason `-z` is used,
    /// since a path may contain a colon and the matched line certainly does.
    #[test]
    fn grep_records_split_on_nul_separators() {
        let line = "src/a:b.rs\u{0}42\u{0}    let url = \"http://x\";";
        let (path, number, content) = parse_grep_line(line).unwrap();
        assert_eq!(path, "src/a:b.rs", "colons in the path survive");
        assert_eq!(number, 42);
        assert_eq!(content, "let url = \"http://x\";", "and the snippet is trimmed");
    }

    #[test]
    fn grep_records_without_a_line_number_are_dropped() {
        assert!(parse_grep_line("Binary file matches").is_none());
        assert!(parse_grep_line("src/x.rs\u{0}not-a-number\u{0}body").is_none());
    }

    #[test]
    fn agent_docs_and_stack_are_detected_from_marker_files() {
        let dir = std::env::temp_dir().join("termax-home-markers");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".github")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "").unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "").unwrap();
        std::fs::write(dir.join(".github/copilot-instructions.md"), "").unwrap();

        let (stack, docs) = detect_markers(&dir);
        assert!(stack.contains(&"rust".to_string()));
        assert!(stack.contains(&"node".to_string()));
        assert!(docs.contains(&"CLAUDE.md".to_string()));
        assert!(
            docs.contains(&"copilot-instructions.md".to_string()),
            "nested agent docs are labelled by file name: {docs:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
