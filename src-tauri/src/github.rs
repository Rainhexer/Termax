//! GitHub integration via the `gh` CLI as a subprocess.
//!
//! Why a subprocess rather than talking to the GitHub API directly: Termax
//! grants only `core:*` + `dialog:default` capabilities and `tauri.conf.json`
//! restricts `connect-src` to `'self' ipc:`. An HTTP client would need both
//! relaxed plus somewhere to keep a token — and a desktop app cannot hold an
//! OAuth client secret. `gh` needs none of that: it is a plain
//! `std::process::Command`, and it already owns the user's credentials in the OS
//! keychain, so Termax never sees, stores, or refreshes a token.
//!
//! Network posture: every command here is called only from a trusted folder,
//! never during startup, and only on explicit user action or an expanded PR
//! panel. A user who never opens that panel makes no network calls. `gh_probe`
//! is the one exception that is always safe — it only looks for the binary.
//!
//! Errors are *classified* here rather than in the frontend (`GhProblem`). The
//! four failure modes need four different empty states, and the distinguishing
//! signal is gh's stderr wording, which belongs in one place behind a named
//! constant instead of scattered across TypeScript string matching.

use crate::session;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};

/// Fields cheap enough to pull for every PR in the list. `statusCheckRollup` and
/// `mergeable` are deliberately absent: the rollup is a full CI dashboard per PR
/// (kilobytes each), and GitHub computes `mergeable` lazily and answers
/// "UNKNOWN" on first read, so listing it would render a flickering unknown.
/// Both are fetched by `gh_pr_view` when a row is expanded — which is exactly
/// when the merge preflight needs them anyway.
const LIST_FIELDS: &str = "number,title,state,isDraft,headRefName,baseRefName,url,author,updatedAt,reviewDecision,isCrossRepository,headRepositoryOwner,labels";

const VIEW_FIELDS: &str =
    "number,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body";

/// Cap on how many PRs one list call returns. Beyond this the sidebar is not a
/// usable browser anyway; the "Open in browser" action is.
const LIST_LIMIT: &str = "100";

/// How many failing check names to carry through. Enough to name the problem in
/// a merge preflight without pasting a CI dashboard into a 256px sidebar.
const MAX_FAILING_NAMES: usize = 6;

// gh's stderr wording for the failure modes we handle. Matching on prose is
// fragile, so each is a distinctive substring rather than a whole line, and an
// unrecognized error falls through to `Other` with the text shown verbatim
// instead of being swallowed.
const ERR_NOT_GITHUB: &str = "point to a known GitHub host";
const ERR_NO_REMOTE: &str = "no git remotes found";
const ERR_AUTH: &str = "gh auth login";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProbe {
    pub installed: bool,
    /// First line of `gh --version`, e.g. "gh version 2.96.0 (2026-07-03)".
    pub version: Option<String>,
}

/// Why a PR list is unavailable. `kind` drives which empty state the panel
/// renders; `message` is gh's stderr, shown verbatim for `other` so a failure we
/// did not anticipate is still legible.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProblem {
    /// "notInstalled" | "notAuthenticated" | "notGitHub" | "noRemote" | "other"
    pub kind: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct GhUser {
    #[serde(default)]
    pub login: String,
}

#[derive(Serialize, Deserialize)]
pub struct GhLabel {
    #[serde(default)]
    pub name: String,
    /// Six-digit hex, no leading '#'.
    #[serde(default)]
    pub color: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    /// "OPEN" | "CLOSED" | "MERGED".
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub base_ref_name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub author: GhUser,
    #[serde(default)]
    pub updated_at: String,
    /// "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"; None when the repo
    /// requires no review.
    #[serde(default, deserialize_with = "empty_as_none")]
    pub review_decision: Option<String>,
    /// True when the head branch lives in a fork. Such a PR cannot be pushed to
    /// from a plain worktree, so the UI routes it to `gh pr checkout`.
    #[serde(default)]
    pub is_cross_repository: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub head_repository_owner: GhUser,
    #[serde(default, deserialize_with = "null_as_default")]
    pub labels: Vec<GhLabel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListResult {
    pub prs: Vec<PullRequest>,
    /// None on success. Note this is a successful `Result` carrying a problem:
    /// "gh is not installed" is a state the panel renders, not an error the
    /// caller should treat as a failed invocation.
    pub problem: Option<GhProblem>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChecksRollup {
    pub passed: usize,
    pub failed: usize,
    pub pending: usize,
    /// Neutral, skipped, cancelled, and stale checks. Counted separately because
    /// they must not read as failures — a skipped required check is normal.
    pub skipped: usize,
    pub failing: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub number: u64,
    pub is_draft: bool,
    /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN".
    pub mergeable: String,
    /// "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "DRAFT" | "HAS_HOOKS" |
    /// "UNSTABLE" | "UNKNOWN". This — not `mergeable` — is what catches branch
    /// protection: a PR can be MERGEABLE and BLOCKED at the same time.
    pub merge_state_status: String,
    pub review_decision: Option<String>,
    pub checks: ChecksRollup,
    pub body: String,
}

/// Accept an explicit `null` where a value is expected.
///
/// `#[serde(default)]` covers an *absent* key but not a present `null`, and
/// GitHub emits real nulls here: `author` is null for a PR whose account was
/// deleted, and `headRepositoryOwner` becomes null once a contributor deletes
/// their fork — which is routine. Without this, one such PR fails the parse of
/// the *entire* list and the panel shows nothing at all.
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// gh returns "" rather than null for a PR whose repo requires no review.
/// Collapse it so the UI has one "no decision" case instead of two.
fn empty_as_none<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = Option::<String>::deserialize(d)?;
    Ok(s.filter(|v| !v.is_empty()))
}

/// A `gh` invocation with every interactive and decorative behavior disabled.
///
/// `gh` is a user-facing CLI: left alone it paginates, colorizes, draws
/// spinners, prompts, and prints update notices — all of which corrupt `--json`
/// output or hang a process with no tty. Each variable below is a documented gh
/// setting (`gh help environment`).
///
/// `GH_REPO` is *removed* rather than set: it overrides repository detection, so
/// a user who exports it in their shell (Termax inherits the launching
/// environment) would otherwise see another repository's pull requests in every
/// project. `GH_HOST` and `GH_TOKEN` are deliberately left alone — those are
/// legitimate auth configuration, including for GitHub Enterprise.
///
/// Note this does *not* inherit `git_command`'s hardening (`git.rs`): gh shells
/// out to plain `git` for some operations. That is why every ref and worktree
/// mutation stays in our own hardened git calls and gh is confined to API reads
/// and PR metadata writes.
fn gh_command(root: &Path) -> Command {
    let mut cmd = Command::new("gh");
    crate::proc::hidden(&mut cmd)
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_SPINNER_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GH_FORCE_TTY")
        .env_remove("GH_REPO")
        // No tty and no stdin: a prompt that slips past GH_PROMPT_DISABLED must
        // hit EOF and fail fast rather than block the command forever.
        .stdin(Stdio::null());
    cmd
}

/// Run `gh` and return stdout, or a classified problem.
///
/// `args` never contains user-supplied text in the first position: gh resolves
/// its first argument against user-defined aliases, which may be `!`-prefixed
/// shell commands. Every caller here passes a literal subcommand.
fn gh(root: &Path, args: &[&str]) -> Result<Vec<u8>, GhProblem> {
    let out = match gh_command(root).args(args).output() {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(GhProblem {
                kind: "notInstalled".into(),
                message: "the GitHub CLI (gh) was not found on PATH".into(),
            })
        }
        Err(e) => {
            return Err(GhProblem {
                kind: "other".into(),
                message: format!("failed to run gh: {e}"),
            })
        }
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(classify(stderr));
    }
    Ok(out.stdout)
}

/// Map gh's stderr onto a failure mode the UI can act on.
///
/// Order matters: the non-GitHub-host message also suggests `gh auth login`, so
/// it must be tested before the auth pattern or a GitLab remote reports itself
/// as an authentication problem.
fn classify(stderr: String) -> GhProblem {
    let kind = if stderr.contains(ERR_NOT_GITHUB) {
        "notGitHub"
    } else if stderr.contains(ERR_NO_REMOTE) {
        "noRemote"
    } else if stderr.contains(ERR_AUTH) {
        "notAuthenticated"
    } else {
        "other"
    };
    GhProblem {
        kind: kind.into(),
        message: stderr,
    }
}

/// One entry of `statusCheckRollup`, which is a union of two GraphQL types:
/// `CheckRun` (Actions, most apps) reports `status` + `conclusion`, while
/// `StatusContext` (the older commit-status API) reports a single `state`.
/// Accepting both shapes in one permissive struct is simpler than a tagged enum
/// and degrades to "pending" for a shape we do not recognize.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheck {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

fn roll_up(raw: Vec<RawCheck>) -> ChecksRollup {
    let mut out = ChecksRollup::default();
    for check in raw {
        let label = check
            .name
            .or(check.context)
            .unwrap_or_else(|| "check".to_string());
        // A CheckRun that has not COMPLETED has no conclusion yet, so status
        // decides; once complete, conclusion does. A StatusContext only ever has
        // `state`.
        let verdict = match check.status.as_deref() {
            Some("COMPLETED") | None => check.conclusion.or(check.state),
            Some(_) => None, // QUEUED / IN_PROGRESS / WAITING / PENDING
        };
        match verdict.as_deref() {
            Some("SUCCESS") => out.passed += 1,
            Some("FAILURE") | Some("ERROR" | "TIMED_OUT" | "STARTUP_FAILURE") => {
                out.failed += 1;
                if out.failing.len() < MAX_FAILING_NAMES {
                    out.failing.push(label);
                }
            }
            Some("SKIPPED" | "NEUTRAL" | "CANCELLED" | "STALE" | "ACTION_REQUIRED") => {
                out.skipped += 1
            }
            _ => out.pending += 1,
        }
    }
    out
}

/// Whether `gh` is installed. Deliberately does no network and needs no repo, so
/// it is safe to call on project open to decide whether to offer the PR panel at
/// all.
#[tauri::command(async)]
pub fn gh_probe() -> GhProbe {
    // `gh --version` runs in whatever directory; use the current one rather than
    // requiring a session, since this is called before any repo is known.
    let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    match gh_command(&root).arg("--version").output() {
        Ok(out) if out.status.success() => GhProbe {
            installed: true,
            version: String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string()),
        },
        _ => GhProbe {
            installed: false,
            version: None,
        },
    }
}

/// Open pull requests for the active session's repository.
///
/// Returns `Ok` with a `problem` for every expected failure (gh missing,
/// unauthenticated, non-GitHub remote, no remote) because those are panel states
/// rather than caller errors. Only "there is no git-mode session" is an `Err` —
/// the caller should not have asked.
#[tauri::command(async)]
pub fn gh_pr_list(manager: tauri::State<session::SessionManager>) -> Result<PrListResult, String> {
    let root = session::git_root(&manager)?;
    let out = match gh(
        &root,
        &["pr", "list", "--state", "open", "--limit", LIST_LIMIT, "--json", LIST_FIELDS],
    ) {
        Ok(out) => out,
        Err(problem) => {
            return Ok(PrListResult {
                prs: Vec::new(),
                problem: Some(problem),
            })
        }
    };
    let prs: Vec<PullRequest> = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the pull request list from gh: {e}"))?;
    Ok(PrListResult { prs, problem: None })
}

/// The most recent pull request for `branch` in any state, or None.
///
/// `gh pr list --state open` drops a PR the instant it merges, which would make
/// a merged branch look like it never had one. This is the targeted follow-up
/// used for the handful of branches that have a bound worktree.
#[tauri::command(async)]
pub fn gh_pr_for_branch(
    manager: tauri::State<session::SessionManager>,
    branch: String,
) -> Result<Option<PullRequest>, String> {
    let root = session::git_root(&manager)?;
    let out = match gh(
        &root,
        &[
            "pr", "list", "--state", "all", "--head", &branch, "--limit", "1", "--json",
            LIST_FIELDS,
        ],
    ) {
        Ok(out) => out,
        // A branch lookup is a background nicety; a gh failure here must not
        // surface as an error next to unrelated UI. The list call is what
        // reports gh's health.
        Err(_) => return Ok(None),
    };
    let prs: Vec<PullRequest> = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the pull request from gh: {e}"))?;
    Ok(prs.into_iter().next())
}

/// Merge-readiness detail for one PR: the fields too expensive to list.
#[tauri::command(async)]
pub fn gh_pr_view(
    manager: tauri::State<session::SessionManager>,
    number: u64,
) -> Result<PrDetail, String> {
    let root = session::git_root(&manager)?;
    let number = number.to_string();
    let out = gh(&root, &["pr", "view", &number, "--json", VIEW_FIELDS])
        .map_err(|problem| problem.message)?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        number: u64,
        #[serde(default)]
        is_draft: bool,
        #[serde(default)]
        mergeable: String,
        #[serde(default)]
        merge_state_status: String,
        #[serde(default, deserialize_with = "empty_as_none")]
        review_decision: Option<String>,
        #[serde(default)]
        status_check_rollup: Vec<RawCheck>,
        #[serde(default)]
        body: String,
    }

    let raw: Raw = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the pull request from gh: {e}"))?;
    Ok(PrDetail {
        number: raw.number,
        is_draft: raw.is_draft,
        mergeable: raw.mergeable,
        merge_state_status: raw.merge_state_status,
        review_decision: raw.review_decision,
        checks: roll_up(raw.status_check_rollup),
        body: raw.body,
    })
}

/// Run `gh` with `body` on stdin.
///
/// Pull-request bodies go this way rather than as an argument: they are multi-line
/// and arbitrarily long, so an argument would hit platform arg-length limits and
/// force us to quote newlines correctly on three platforms.
fn gh_with_stdin(root: &Path, args: &[&str], body: &str) -> Result<Vec<u8>, GhProblem> {
    use std::io::Write;

    let mut child = match gh_command(root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(GhProblem {
                kind: "notInstalled".into(),
                message: "the GitHub CLI (gh) was not found on PATH".into(),
            })
        }
        Err(e) => {
            return Err(GhProblem {
                kind: "other".into(),
                message: format!("failed to run gh: {e}"),
            })
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
        // Dropping stdin closes it, which `--body-file -` needs in order to stop
        // reading. Without this the child waits for EOF forever.
    }
    let out = child
        .wait_with_output()
        .map_err(|e| GhProblem { kind: "other".into(), message: e.to_string() })?;
    if !out.status.success() {
        return Err(classify(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(out.stdout)
}

/// Create a pull request for the current branch.
///
/// Note this *pushes*: `gh pr create` sets the upstream if the branch has none.
/// The UI has to say so before the user commits to it — an unexpected push is not
/// something to discover afterwards.
#[tauri::command(async)]
pub fn gh_pr_create(
    manager: tauri::State<session::SessionManager>,
    title: String,
    body: String,
    base: String,
    draft: bool,
    root: Option<String>,
) -> Result<String, String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let mut args = vec![
        "pr", "create", "--title", &title, "--base", &base, "--body-file", "-",
    ];
    if draft {
        args.push("--draft");
    }
    let out = gh_with_stdin(&root, &args, &body).map_err(|problem| problem.message)?;
    // gh prints the new PR's URL on success.
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Take a draft pull request out of draft.
#[tauri::command(async)]
pub fn gh_pr_ready(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let number = number.to_string();
    gh(&root, &["pr", "ready", &number])
        .map(|_| ())
        .map_err(|problem| problem.message)
}

/// Merge a pull request.
///
/// `method` is "squash" | "rebase" | "merge". The caller is expected to have run
/// the `gh_pr_view` preflight first; this deliberately does not re-check, because
/// GitHub is the authority and a second opinion computed here could disagree with
/// the one the user was shown. A refusal comes back as gh's stderr verbatim,
/// which is where branch-protection and merge-queue detail actually lives.
#[tauri::command(async)]
pub fn gh_pr_merge(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    method: String,
    delete_branch: bool,
    root: Option<String>,
) -> Result<String, String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let flag = match method.as_str() {
        "squash" => "--squash",
        "rebase" => "--rebase",
        "merge" => "--merge",
        other => return Err(format!("unknown merge method: {other}")),
    };
    let number = number.to_string();
    let mut args = vec!["pr", "merge", &number, flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    let out = gh(&root, &args).map_err(|problem| problem.message)?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Close a pull request without merging it.
#[tauri::command(async)]
pub fn gh_pr_close(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let number = number.to_string();
    gh(&root, &["pr", "close", &number])
        .map(|_| ())
        .map_err(|problem| problem.message)
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------
//
// Issues differ from pull requests in one way that shapes everything below: a
// repository can have tens of thousands of them, and which ones matter is a
// question only the user can answer. So where `gh_pr_list` takes no arguments
// and returns "the open ones", `gh_issue_list` takes a filter and the panel is
// built around it. Everything else — the hardening in `gh_command`, the
// `GhProblem` classification, the "expensive fields only on expand" split —
// carries over unchanged.

/// Fields cheap enough to pull for every issue in the list.
///
/// `body` and `comments` are deliberately absent: both are unbounded text, and
/// `comments` returns whole comment bodies rather than a count, so listing 100
/// issues with it can be megabytes. `gh_issue_view` fetches them on expand.
const ISSUE_LIST_FIELDS: &str = "number,title,state,stateReason,author,assignees,labels,milestone,createdAt,updatedAt,url,isPinned";

/// The list fields plus the ones that are only affordable for a single issue.
///
/// Sub-issue and blocked-by fields exist in gh 2.97 but are deliberately left
/// out: gh fails the *entire* request on an unknown JSON field, so asking for
/// them would break the detail view against any GitHub Enterprise Server whose
/// GraphQL schema predates them. The "Open on GitHub" button covers that ground.
const ISSUE_VIEW_FIELDS: &str = "number,title,state,stateReason,author,assignees,labels,milestone,createdAt,updatedAt,closedAt,url,isPinned,body,comments";

/// Cap on issues per list call. Higher than the PR cap because filtering is the
/// point here — a user narrowing by label expects to see the whole narrowed set.
const ISSUE_LIST_LIMIT: usize = 200;

/// Cap on repository labels/assignees/milestones offered in the pickers. Past a
/// few hundred a dropdown is the wrong tool and the search box is the right one.
const META_LIMIT: &str = "300";

/// Reasons GitHub accepts for locking a conversation.
const LOCK_REASONS: [&str; 4] = ["off_topic", "resolved", "spam", "too_heated"];

/// A milestone as it appears *inside* an issue. The REST milestone list carries
/// more (state, counts) and is modelled separately by `Milestone`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRef {
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// RFC 3339, or None when the milestone has no due date.
    #[serde(default, deserialize_with = "empty_as_none")]
    pub due_on: Option<String>,
}

/// A repository milestone, from the REST API.
///
/// The wire format is snake_case here (REST) but camelCase everywhere else gh
/// speaks (GraphQL), so the three multi-word fields carry an `alias`: they
/// *serialize* as camelCase for the frontend, like every other type in this
/// file, while still accepting REST's spelling on the way in.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    /// "open" | "closed".
    #[serde(default)]
    pub state: String,
    #[serde(default, alias = "due_on", deserialize_with = "empty_as_none")]
    pub due_on: Option<String>,
    #[serde(default, alias = "open_issues")]
    pub open_issues: u64,
    #[serde(default, alias = "closed_issues")]
    pub closed_issues: u64,
}

/// A repository label, with the description the pickers show. Distinct from
/// `GhLabel` (name + colour) which is all an issue row needs.
#[derive(Serialize, Deserialize)]
pub struct RepoLabel {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    /// "OPEN" | "CLOSED".
    #[serde(default)]
    pub state: String,
    /// "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED"; None for an open
    /// issue, where gh sends "".
    #[serde(default, deserialize_with = "empty_as_none")]
    pub state_reason: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub author: GhUser,
    #[serde(default, deserialize_with = "null_as_default")]
    pub assignees: Vec<GhUser>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub labels: Vec<GhLabel>,
    #[serde(default)]
    pub milestone: Option<MilestoneRef>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub is_pinned: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueListResult {
    pub issues: Vec<Issue>,
    /// None on success. Like `PrListResult.problem`, a problem here is a panel
    /// state rather than a failed invocation.
    pub problem: Option<GhProblem>,
    /// True when gh returned exactly the limit, so there is probably more. The
    /// panel says so rather than silently showing a truncated list.
    pub truncated: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    #[serde(default)]
    pub id: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub author: GhUser,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub url: String,
    /// "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "NONE" — worth
    /// showing, because "the maintainer said this" reads differently.
    #[serde(default)]
    pub author_association: String,
    /// Hidden as off-topic/spam/abuse. Rendered collapsed rather than dropped.
    #[serde(default)]
    pub is_minimized: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub minimized_reason: String,
}

/// One issue with the fields too expensive to list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(flatten)]
    pub issue: Issue,
    pub body: String,
    pub comments: Vec<IssueComment>,
    pub closed_at: Option<String>,
}

/// What to ask GitHub for. Every field is optional and an unset one is simply
/// not passed, so the default is gh's own default: open issues, newest first.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueFilter {
    /// "open" | "closed" | "all".
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// A login, or "@me".
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    /// Milestone number or title.
    #[serde(default)]
    pub milestone: Option<String>,
    /// A GitHub search query, passed through verbatim. This is the escape hatch
    /// that makes the panel as capable as the website's search box.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Fields to change on an existing issue. `None` means "leave alone", which is
/// why every field is an Option and empty vectors are no-ops — a single struct
/// then serves the title rename, the label toggle, and the assignee change
/// without three near-identical commands.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueEdit {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub add_labels: Vec<String>,
    #[serde(default)]
    pub remove_labels: Vec<String>,
    #[serde(default)]
    pub add_assignees: Vec<String>,
    #[serde(default)]
    pub remove_assignees: Vec<String>,
    /// Milestone title. `Some("")` removes it — distinct from `None`, which
    /// leaves it untouched.
    #[serde(default)]
    pub milestone: Option<String>,
}

/// A flag written as one argv token, `--name=value`.
///
/// No shell is involved anywhere here, so there is nothing to quote-escape; the
/// one real hazard is a *value* that begins with a dash being read as a flag of
/// its own. Passing `--label bug` as two tokens has that problem, `--label=bug`
/// does not, because the parser splits at the first `=` and never re-examines
/// the rest.
///
/// That is not a theoretical concern for issues: `-label:bug` is how GitHub
/// search negates a term, so a user filtering with one would otherwise have
/// their query silently eaten as an unknown flag. The `=` form makes negated
/// searches work rather than merely fail safely.
fn flag(name: &str, value: &str) -> String {
    format!("{name}={value}")
}

/// Run gh with owned arguments. A thin bridge to `gh`, which takes `&[&str]`
/// because every pull-request call site has only literals.
fn gh_owned(root: &Path, args: &[String]) -> Result<Vec<u8>, GhProblem> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    gh(root, &refs)
}

/// `gh_with_stdin` for owned arguments.
fn gh_owned_with_stdin(root: &Path, args: &[String], body: &str) -> Result<Vec<u8>, GhProblem> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    gh_with_stdin(root, &refs, body)
}

/// Reject a *positional* argument that would be read as a flag.
///
/// Positional arguments cannot use the `=` trick — there is no flag name to
/// attach the value to — so the handful of commands that take one (a transfer
/// destination, a duplicate reference) check it instead. Neither is a valid
/// GitHub identifier with a leading dash, so refusing costs nothing real.
fn checked(kind: &str, value: &str) -> Result<String, String> {
    if value.starts_with('-') {
        return Err(format!("a {kind} cannot start with '-': {value}"));
    }
    Ok(value.to_string())
}

/// Issues matching `filter`.
#[tauri::command(async)]
pub fn gh_issue_list(
    manager: tauri::State<session::SessionManager>,
    filter: IssueFilter,
) -> Result<IssueListResult, String> {
    let root = session::git_root(&manager)?;
    let limit = filter.limit.unwrap_or(ISSUE_LIST_LIMIT).clamp(1, ISSUE_LIST_LIMIT);

    let mut args = vec![
        "issue".to_string(),
        "list".to_string(),
        flag("--limit", &limit.to_string()),
        flag("--json", ISSUE_LIST_FIELDS),
    ];
    if let Some(state) = filter.state.as_deref().filter(|s| !s.is_empty()) {
        args.push(flag("--state", state));
    }
    for label in filter.labels.iter().filter(|l| !l.is_empty()) {
        args.push(flag("--label", label));
    }
    if let Some(assignee) = filter.assignee.as_deref().filter(|s| !s.is_empty()) {
        args.push(flag("--assignee", assignee));
    }
    if let Some(author) = filter.author.as_deref().filter(|s| !s.is_empty()) {
        args.push(flag("--author", author));
    }
    if let Some(milestone) = filter.milestone.as_deref().filter(|s| !s.is_empty()) {
        args.push(flag("--milestone", milestone));
    }
    if let Some(search) = filter.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push(flag("--search", search));
    }

    let out = match gh_owned(&root, &args) {
        Ok(out) => out,
        Err(problem) => {
            return Ok(IssueListResult {
                issues: Vec::new(),
                problem: Some(problem),
                truncated: false,
            })
        }
    };
    let issues: Vec<Issue> = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the issue list from gh: {e}"))?;
    let truncated = issues.len() >= limit;
    Ok(IssueListResult { issues, problem: None, truncated })
}

/// One issue in full: body, comments, and everything the list already had.
#[tauri::command(async)]
pub fn gh_issue_view(
    manager: tauri::State<session::SessionManager>,
    number: u64,
) -> Result<IssueDetail, String> {
    let root = session::git_root(&manager)?;
    let number = number.to_string();
    let out = gh(&root, &["issue", "view", &number, "--json", ISSUE_VIEW_FIELDS])
        .map_err(|problem| problem.message)?;

    // The view payload is the list shape plus three keys, so it is parsed twice
    // over the same bytes rather than duplicating a dozen field declarations.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Extra {
        #[serde(default)]
        body: String,
        #[serde(default, deserialize_with = "null_as_default")]
        comments: Vec<IssueComment>,
        #[serde(default)]
        closed_at: Option<String>,
    }

    let issue: Issue = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the issue from gh: {e}"))?;
    let extra: Extra = serde_json::from_slice(&out)
        .map_err(|e| format!("could not read the issue from gh: {e}"))?;
    Ok(IssueDetail {
        issue,
        body: extra.body,
        comments: extra.comments,
        closed_at: extra.closed_at.filter(|s| !s.is_empty()),
    })
}

/// Open a new issue. Returns its URL.
#[tauri::command(async)]
pub fn gh_issue_create(
    manager: tauri::State<session::SessionManager>,
    title: String,
    body: String,
    labels: Vec<String>,
    assignees: Vec<String>,
    milestone: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let title = title.trim();
    if title.is_empty() {
        return Err("an issue needs a title".into());
    }

    // The body goes on stdin for the same reason a PR body does: it is unbounded
    // multi-line text, and an argument would hit platform arg-length limits.
    let mut args = vec![
        "issue".to_string(),
        "create".to_string(),
        flag("--title", title),
        flag("--body-file", "-"),
    ];
    for label in labels.iter().filter(|l| !l.is_empty()) {
        args.push(flag("--label", label));
    }
    for assignee in assignees.iter().filter(|a| !a.is_empty()) {
        args.push(flag("--assignee", assignee));
    }
    if let Some(milestone) = milestone.as_deref().filter(|m| !m.is_empty()) {
        args.push(flag("--milestone", milestone));
    }
    let out = gh_owned_with_stdin(&root, &args, &body).map_err(|problem| problem.message)?;
    Ok(last_url(&out))
}

/// Change an existing issue. A no-op edit is refused rather than spawning gh to
/// do nothing.
#[tauri::command(async)]
pub fn gh_issue_edit(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    edit: IssueEdit,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;

    let mut args = vec!["issue".to_string(), "edit".to_string(), number.to_string()];
    if let Some(title) = edit.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        args.push(flag("--title", title));
    }
    for label in edit.add_labels.iter().filter(|l| !l.is_empty()) {
        args.push(flag("--add-label", label));
    }
    for label in edit.remove_labels.iter().filter(|l| !l.is_empty()) {
        args.push(flag("--remove-label", label));
    }
    for assignee in edit.add_assignees.iter().filter(|a| !a.is_empty()) {
        args.push(flag("--add-assignee", assignee));
    }
    for assignee in edit.remove_assignees.iter().filter(|a| !a.is_empty()) {
        args.push(flag("--remove-assignee", assignee));
    }
    // `Some("")` means "detach from the milestone"; `None` means "leave alone".
    match edit.milestone.as_deref() {
        Some("") => args.push("--remove-milestone".to_string()),
        Some(milestone) => args.push(flag("--milestone", milestone)),
        None => {}
    }

    match edit.body {
        Some(body) => {
            args.push(flag("--body-file", "-"));
            gh_owned_with_stdin(&root, &args, &body).map_err(|problem| problem.message)?;
        }
        None => {
            // Only the three fixed arguments: gh would happily run and change
            // nothing, spending a network call to do it.
            if args.len() == 3 {
                return Err("nothing to change".into());
            }
            gh_owned(&root, &args).map_err(|problem| problem.message)?;
        }
    }
    Ok(())
}

/// Close an issue.
///
/// `reason` is "completed" | "not planned" | "duplicate". A duplicate needs
/// `duplicate_of`, which GitHub records as a real relationship rather than a
/// comment, so the two are validated together instead of letting gh refuse.
#[tauri::command(async)]
pub fn gh_issue_close(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    reason: Option<String>,
    comment: Option<String>,
    duplicate_of: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let reason = match reason.as_deref() {
        None | Some("") => None,
        Some(r @ ("completed" | "not planned" | "duplicate")) => Some(r),
        Some(other) => return Err(format!("unknown close reason: {other}")),
    };
    // `#123` is what a user types and what the UI's placeholder suggests, but
    // gh wants a bare number or a URL. Stripping the sigil here rather than
    // policing it in the form keeps the familiar spelling working.
    let duplicate_of = duplicate_of
        .as_deref()
        .map(str::trim)
        .map(|d| d.strip_prefix('#').unwrap_or(d))
        .filter(|d| !d.is_empty())
        .map(str::to_string);
    if reason == Some("duplicate") && duplicate_of.is_none() {
        return Err("closing as a duplicate needs the issue it duplicates".into());
    }

    // The comment goes first and as its own call: it is unbounded prose, so it
    // belongs on stdin rather than in `--comment`. Ordering it before the close
    // means a failure there leaves the issue open with nothing said, which is
    // recoverable — the reverse would close the issue and lose the explanation.
    if let Some(body) = comment.as_deref().filter(|c| !c.trim().is_empty()) {
        gh_owned_with_stdin(
            &root,
            &[
                "issue".to_string(),
                "comment".to_string(),
                number.to_string(),
                flag("--body-file", "-"),
            ],
            body,
        )
        .map_err(|problem| problem.message)?;
    }

    let mut args = vec!["issue".to_string(), "close".to_string(), number.to_string()];
    if let Some(reason) = reason {
        args.push(flag("--reason", reason));
    }
    if let Some(duplicate) = duplicate_of.as_deref() {
        args.push(flag("--duplicate-of", duplicate));
    }
    gh_owned(&root, &args).map(|_| ()).map_err(|problem| problem.message)
}

/// Reopen a closed issue.
#[tauri::command(async)]
pub fn gh_issue_reopen(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    comment: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    if let Some(body) = comment.as_deref().filter(|c| !c.trim().is_empty()) {
        gh_owned_with_stdin(
            &root,
            &[
                "issue".to_string(),
                "comment".to_string(),
                number.to_string(),
                flag("--body-file", "-"),
            ],
            body,
        )
        .map_err(|problem| problem.message)?;
    }
    gh(&root, &["issue", "reopen", &number.to_string()])
        .map(|_| ())
        .map_err(|problem| problem.message)
}

/// Comment on an issue. Returns the new comment's URL.
#[tauri::command(async)]
pub fn gh_issue_comment(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    body: String,
    root: Option<String>,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("a comment cannot be empty".into());
    }
    let root = session::resolve_git(&manager, root.as_deref())?;
    let out = gh_owned_with_stdin(
        &root,
        &[
            "issue".to_string(),
            "comment".to_string(),
            number.to_string(),
            flag("--body-file", "-"),
        ],
        &body,
    )
    .map_err(|problem| problem.message)?;
    Ok(last_url(&out))
}

/// Create a branch on the remote linked to an issue, and return its name.
///
/// This is `gh issue develop`, and the link it creates is the thing that makes
/// GitHub close the issue when the eventual pull request merges. Termax could
/// create a plain local branch instead and be one network call cheaper, but then
/// the issue and the work would only be connected by a habit of typing
/// "fixes #12" — which is exactly the connection this feature exists to make.
///
/// Note the branch lands on the *remote*; the caller has to fetch before it can
/// build a worktree from it.
#[tauri::command(async)]
pub fn gh_issue_develop(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    name: String,
    base: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a branch needs a name".into());
    }

    let mut args = vec![
        "issue".to_string(),
        "develop".to_string(),
        number.to_string(),
        flag("--name", &name),
    ];
    if let Some(base) = base.as_deref().filter(|b| !b.is_empty()) {
        args.push(flag("--base", base));
    }
    let out = gh_owned(&root, &args).map_err(|problem| problem.message)?;
    // gh prints the branch's URL. The trailing path segment is the branch name,
    // which is what the caller actually needs — and it is gh's name, not ours:
    // GitHub appends a suffix when the name is already taken.
    let url = last_url(&out);
    Ok(branch_from_url(&url).unwrap_or(name))
}

/// Branches already linked to an issue, newest last.
///
/// `--list` prints "branch\tURL" per line rather than JSON, so this parses
/// columns. Used to answer "is someone already working on this?" before
/// offering to create another branch.
#[tauri::command(async)]
pub fn gh_issue_develop_list(
    manager: tauri::State<session::SessionManager>,
    number: u64,
) -> Result<Vec<String>, String> {
    let root = session::git_root(&manager)?;
    let out = match gh(&root, &["issue", "develop", "--list", &number.to_string()]) {
        Ok(out) => out,
        // A linked-branch lookup is a background nicety, exactly like
        // `gh_pr_for_branch`: a failure must not surface next to unrelated UI.
        Err(_) => return Ok(Vec::new()),
    };
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|line| line.split('\t').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

/// Pin or unpin an issue. A repository allows at most three pinned issues; gh
/// reports the refusal, which the caller shows verbatim.
#[tauri::command(async)]
pub fn gh_issue_pin(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    pinned: bool,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let verb = if pinned { "pin" } else { "unpin" };
    gh(&root, &["issue", verb, &number.to_string()])
        .map(|_| ())
        .map_err(|problem| problem.message)
}

/// Lock or unlock an issue's conversation.
#[tauri::command(async)]
pub fn gh_issue_lock(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    locked: bool,
    reason: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    if !locked {
        return gh(&root, &["issue", "unlock", &number.to_string()])
            .map(|_| ())
            .map_err(|problem| problem.message);
    }
    let reason = match reason.as_deref() {
        None | Some("") => None,
        Some(r) if LOCK_REASONS.contains(&r) => Some(r),
        Some(other) => return Err(format!("unknown lock reason: {other}")),
    };
    let mut args = vec!["issue".to_string(), "lock".to_string(), number.to_string()];
    if let Some(reason) = reason {
        args.push(flag("--reason", reason));
    }
    gh_owned(&root, &args).map(|_| ()).map_err(|problem| problem.message)
}

/// Move an issue to another repository. Returns the issue's new URL.
#[tauri::command(async)]
pub fn gh_issue_transfer(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    destination: String,
    root: Option<String>,
) -> Result<String, String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    let destination = checked("repository", destination.trim())?;
    if destination.is_empty() {
        return Err("a transfer needs a destination repository".into());
    }
    let out = gh(
        &root,
        &["issue", "transfer", &number.to_string(), &destination],
    )
    .map_err(|problem| problem.message)?;
    Ok(last_url(&out))
}

/// Delete an issue permanently.
///
/// `--yes` is passed because there is no tty to confirm on; the confirmation
/// that matters happens in the UI, which is the only place that can explain that
/// this is irreversible and needs admin rights.
#[tauri::command(async)]
pub fn gh_issue_delete(
    manager: tauri::State<session::SessionManager>,
    number: u64,
    root: Option<String>,
) -> Result<(), String> {
    let root = session::resolve_git(&manager, root.as_deref())?;
    gh(&root, &["issue", "delete", &number.to_string(), "--yes"])
        .map(|_| ())
        .map_err(|problem| problem.message)
}

/// Labels defined in this repository, for the pickers.
#[tauri::command(async)]
pub fn gh_repo_labels(
    manager: tauri::State<session::SessionManager>,
) -> Result<Vec<RepoLabel>, String> {
    let root = session::git_root(&manager)?;
    let out = match gh(
        &root,
        &["label", "list", "--limit", META_LIMIT, "--sort", "name", "--json", "name,color,description"],
    ) {
        Ok(out) => out,
        // Picker data is optional: an empty list degrades to a free-text field
        // rather than an error banner over the issue list.
        Err(_) => return Ok(Vec::new()),
    };
    Ok(serde_json::from_slice(&out).unwrap_or_default())
}

/// Users who can be assigned issues in this repository.
#[tauri::command(async)]
pub fn gh_repo_assignees(
    manager: tauri::State<session::SessionManager>,
) -> Result<Vec<GhUser>, String> {
    let root = session::git_root(&manager)?;
    // No `gh issue`-level equivalent exists, so this is the REST endpoint. The
    // {owner}/{repo} placeholders are gh's own, resolved from the working
    // directory — which keeps this honest about which repo it is asking about.
    let path = format!("repos/{{owner}}/{{repo}}/assignees?per_page={META_LIMIT}");
    let out = match gh(&root, &["api", "--paginate", &path]) {
        Ok(out) => out,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(serde_json::from_slice(&out).unwrap_or_default())
}

/// Milestones in this repository, open ones first.
#[tauri::command(async)]
pub fn gh_repo_milestones(
    manager: tauri::State<session::SessionManager>,
) -> Result<Vec<Milestone>, String> {
    let root = session::git_root(&manager)?;
    let path = format!("repos/{{owner}}/{{repo}}/milestones?state=all&per_page={META_LIMIT}");
    let out = match gh(&root, &["api", "--paginate", &path]) {
        Ok(out) => out,
        Err(_) => return Ok(Vec::new()),
    };
    let mut milestones: Vec<Milestone> = serde_json::from_slice(&out).unwrap_or_default();
    // Closed milestones stay in the list — an issue may already be on one — but
    // they sort last, because assigning new work to them is rarely the intent.
    milestones.sort_by_key(|m| m.state != "open");
    Ok(milestones)
}

/// The signed-in user's login, for the "assigned to me" filter and for deciding
/// which comments are the user's own. Cheap, but still a network call.
#[tauri::command(async)]
pub fn gh_me(manager: tauri::State<session::SessionManager>) -> Result<Option<String>, String> {
    let root = session::git_root(&manager)?;
    match gh(&root, &["api", "user", "--jq", ".login"]) {
        Ok(out) => {
            let login = String::from_utf8_lossy(&out).trim().to_string();
            Ok(if login.is_empty() { None } else { Some(login) })
        }
        Err(_) => Ok(None),
    }
}

/// The last URL gh printed.
///
/// gh writes the created object's URL on stdout, but not always alone: `issue
/// create` can precede it with template or project notices, and `issue develop`
/// prints the branch URL after other chatter. Taking the last URL-looking line
/// is more robust than trimming the whole of stdout, and an empty result is
/// returned rather than guessed at.
fn last_url(out: &[u8]) -> String {
    String::from_utf8_lossy(out)
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with("http://") || line.starts_with("https://"))
        .unwrap_or_default()
        .to_string()
}

/// Branch name out of a `.../tree/<branch>` URL, percent-decoded for the slashes
/// that appear in names like `feature/x`.
fn branch_from_url(url: &str) -> Option<String> {
    let rest = url.split_once("/tree/")?.1;
    let decoded = rest.replace("%2F", "/").replace("%2f", "/");
    let name = decoded.trim_end_matches('/');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `gh pr list --json <LIST_FIELDS>` output. Kept as a literal
    /// rather than a hand-written fixture so the field names and value shapes are
    /// exactly what gh emits — note `author.is_bot` is snake_case while every
    /// sibling key is camelCase, and `reviewDecision` is "" rather than null.
    const REAL_LIST: &str = r#"[{"author":{"id":"MDQ6VXNlcjE2MTE1MTA=","is_bot":false,"login":"williammartin","name":"William Martin"},"baseRefName":"trunk","headRefName":"wm-migrate-autolink","headRepositoryOwner":{"id":"MDEyOk9yZ2FuaXphdGlvbjU5NzA0NzEx","login":"cli"},"isCrossRepository":false,"isDraft":true,"labels":[],"number":14013,"reviewDecision":"","state":"OPEN","title":"Route autolink requests through api.Client","updatedAt":"2026-07-30T09:31:07Z","url":"https://github.com/cli/cli/pull/14013"}]"#;

    #[test]
    fn parses_real_list_output() {
        let prs: Vec<PullRequest> = serde_json::from_str(REAL_LIST).unwrap();
        let pr = &prs[0];
        assert_eq!(pr.number, 14013);
        assert_eq!(pr.head_ref_name, "wm-migrate-autolink");
        assert_eq!(pr.base_ref_name, "trunk");
        assert_eq!(pr.author.login, "williammartin");
        assert_eq!(pr.head_repository_owner.login, "cli");
        assert!(pr.is_draft);
        assert!(!pr.is_cross_repository);
        // "" must not survive as Some("") or the UI gets two "unknown" cases.
        assert_eq!(pr.review_decision, None);
    }

    #[test]
    fn keeps_a_real_review_decision() {
        let json = r#"[{"number":1,"reviewDecision":"CHANGES_REQUESTED"}]"#;
        let prs: Vec<PullRequest> = serde_json::from_str(json).unwrap();
        assert_eq!(prs[0].review_decision.as_deref(), Some("CHANGES_REQUESTED"));
    }

    /// Every field but `number` is defaulted, so a future gh that drops or
    /// renames one degrades to an empty value instead of failing the whole list.
    #[test]
    fn tolerates_missing_fields() {
        let prs: Vec<PullRequest> = serde_json::from_str(r#"[{"number":7}]"#).unwrap();
        assert_eq!(prs[0].number, 7);
        assert_eq!(prs[0].title, "");
        assert_eq!(prs[0].author.login, "");
    }

    /// A deleted fork makes `headRepositoryOwner` an explicit null, and a
    /// deleted account does the same to `author`. One such PR must not take the
    /// whole list down with it.
    #[test]
    fn survives_explicit_nulls_from_deleted_forks_and_accounts() {
        let json = r#"[
            {"number":1,"title":"ok","author":{"login":"a"},"headRepositoryOwner":{"login":"o"},"labels":[]},
            {"number":2,"title":"deleted fork","author":null,"headRepositoryOwner":null,"labels":null}
        ]"#;
        let prs: Vec<PullRequest> = serde_json::from_str(json).expect("a null must not fail the list");
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[1].author.login, "");
        assert_eq!(prs[1].head_repository_owner.login, "");
        assert!(prs[1].labels.is_empty());
        // The usable PR alongside it is untouched.
        assert_eq!(prs[0].author.login, "a");
    }

    /// The ordering trap: gh's non-GitHub-host message also says
    /// "gh auth login", so a naive auth check first would report a GitLab remote
    /// as an authentication failure and send the user to sign in pointlessly.
    #[test]
    fn classifies_gitlab_remote_as_not_github_not_auth() {
        let msg = "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`";
        assert_eq!(classify(msg.to_string()).kind, "notGitHub");
    }

    #[test]
    fn classifies_the_other_real_failures() {
        assert_eq!(
            classify("To get started with GitHub CLI, please run:  gh auth login".into()).kind,
            "notAuthenticated"
        );
        assert_eq!(classify("no git remotes found".into()).kind, "noRemote");
        // Anything unrecognized keeps its text so the panel can show it verbatim
        // rather than swallowing a failure we did not anticipate.
        let other = classify("HTTP 503: upstream connect error".into());
        assert_eq!(other.kind, "other");
        assert!(other.message.contains("503"));
    }

    #[test]
    fn rolls_up_check_runs_and_status_contexts() {
        // Mixed union: three CheckRuns (one still running, one skipped) plus a
        // legacy StatusContext that reports only `state`.
        let json = r#"[
            {"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SUCCESS"},
            {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"FAILURE"},
            {"__typename":"CheckRun","name":"build","status":"IN_PROGRESS"},
            {"__typename":"CheckRun","name":"label","status":"COMPLETED","conclusion":"SKIPPED"},
            {"__typename":"StatusContext","context":"ci/legacy","state":"SUCCESS"}
        ]"#;
        let raw: Vec<RawCheck> = serde_json::from_str(json).unwrap();
        let out = roll_up(raw);
        assert_eq!(out.passed, 2, "the StatusContext must count via `state`");
        assert_eq!(out.failed, 1);
        assert_eq!(
            out.pending, 1,
            "an IN_PROGRESS run has no conclusion yet and must not read as passing"
        );
        assert_eq!(out.skipped, 1, "a skipped check must never look like a failure");
        assert_eq!(out.failing, vec!["test"]);
    }

    #[test]
    fn caps_the_failing_name_list_but_not_the_count() {
        let entries: Vec<String> = (0..20)
            .map(|i| format!(r#"{{"name":"check{i}","status":"COMPLETED","conclusion":"FAILURE"}}"#))
            .collect();
        let json = format!("[{}]", entries.join(","));
        let out = roll_up(serde_json::from_str(&json).unwrap());
        assert_eq!(out.failed, 20, "the count stays exact even though names are capped");
        assert_eq!(out.failing.len(), MAX_FAILING_NAMES);
    }

    #[test]
    fn parses_real_view_output_with_blocked_but_mergeable_pr() {
        // The case that justifies fetching mergeStateStatus at all: GitHub says
        // MERGEABLE and BLOCKED simultaneously, because branch protection is
        // unsatisfied. Reading only `mergeable` would offer a merge that fails.
        let json = r#"{"isDraft":false,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":14007,"reviewDecision":"REVIEW_REQUIRED","body":"hi","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-07-29T15:20:56Z","conclusion":"SKIPPED","detailsUrl":"https://example.invalid/1","name":"label-external","startedAt":"2026-07-29T15:20:56Z","status":"COMPLETED","workflowName":"PR Triaging"}]}"#;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            number: u64,
            #[serde(default)]
            mergeable: String,
            #[serde(default)]
            merge_state_status: String,
            #[serde(default, deserialize_with = "empty_as_none")]
            review_decision: Option<String>,
            #[serde(default)]
            status_check_rollup: Vec<RawCheck>,
        }

        let raw: Raw = serde_json::from_str(json).unwrap();
        assert_eq!(raw.number, 14007);
        assert_eq!(raw.mergeable, "MERGEABLE");
        assert_eq!(raw.merge_state_status, "BLOCKED");
        assert_eq!(raw.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(roll_up(raw.status_check_rollup).skipped, 1);
    }

    /// `gh_command` must not let an inherited `GH_REPO` redirect us at another
    /// repository, and must disable the interactive/decorative behaviour that
    /// would corrupt `--json` output.
    #[test]
    fn gh_command_neutralizes_the_environment() {
        let cmd = gh_command(Path::new("/tmp"));
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let get = |key: &str| envs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());

        // Removal is represented as a present key with a None value.
        assert_eq!(get("GH_REPO"), Some(None), "GH_REPO must be removed");
        assert_eq!(get("GH_FORCE_TTY"), Some(None), "GH_FORCE_TTY must be removed");
        assert_eq!(get("GH_PROMPT_DISABLED"), Some(Some("1".into())));
        assert_eq!(get("GH_PAGER"), Some(Some("cat".into())));
        assert_eq!(get("GIT_TERMINAL_PROMPT"), Some(Some("0".into())));
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp")));
    }

    // -----------------------------------------------------------------------
    // Issues
    // -----------------------------------------------------------------------

    /// Verbatim `gh issue list --json <ISSUE_LIST_FIELDS>` output, kept literal
    /// for the same reason `REAL_LIST` is: the value *shapes* are the contract.
    /// Note `stateReason` is "" on an open issue, `milestone` is null, and the
    /// author object carries extra keys we do not model.
    const REAL_ISSUE_LIST: &str = r#"[{"assignees":[{"id":"MDQ6VXNlcjY1NjE4ODc=","login":"sbatten","name":"SteVen Batten","databaseId":6561887}],"author":{"id":"MDQ6VXNlcjIwNDM4Mjg=","is_bot":false,"login":"zzzeid","name":"Zeid"},"createdAt":"2026-08-06T18:15:36Z","isPinned":false,"labels":[{"id":"MDU6TGFiZWwzMDc3MTgwNTA=","name":"testplan-item","description":"","color":"dcdcdc"}],"milestone":{"number":441,"title":"1.133.0","description":"","dueOn":"2026-08-10T00:00:00Z"},"number":14093,"state":"OPEN","stateReason":"","title":"`gh stack submit` fails","updatedAt":"2026-08-07T23:20:27Z","url":"https://github.com/cli/cli/issues/14093"}]"#;

    #[test]
    fn parses_real_issue_list_output() {
        let issues: Vec<Issue> = serde_json::from_str(REAL_ISSUE_LIST).unwrap();
        let issue = &issues[0];
        assert_eq!(issue.number, 14093);
        assert_eq!(issue.state, "OPEN");
        assert_eq!(issue.author.login, "zzzeid");
        assert_eq!(issue.assignees[0].login, "sbatten");
        assert_eq!(issue.labels[0].name, "testplan-item");
        let milestone = issue.milestone.as_ref().expect("milestone must parse");
        assert_eq!(milestone.title, "1.133.0");
        assert_eq!(milestone.due_on.as_deref(), Some("2026-08-10T00:00:00Z"));
        // "" must not survive, exactly as with a PR's reviewDecision: an open
        // issue has no state reason, and Some("") would be a second empty case.
        assert_eq!(issue.state_reason, None);
    }

    #[test]
    fn keeps_a_real_state_reason_and_absent_milestone() {
        let json = r#"[{"number":1,"state":"CLOSED","stateReason":"NOT_PLANNED","milestone":null,"assignees":null,"labels":null,"author":null}]"#;
        let issues: Vec<Issue> = serde_json::from_str(json).unwrap();
        assert_eq!(issues[0].state_reason.as_deref(), Some("NOT_PLANNED"));
        assert!(issues[0].milestone.is_none());
        // The same explicit-null tolerance the PR list needs: a deleted account
        // nulls `author`, and gh nulls empty collections in some versions.
        assert_eq!(issues[0].author.login, "");
        assert!(issues[0].assignees.is_empty());
        assert!(issues[0].labels.is_empty());
    }

    /// A milestone due date is null far more often than not, and `empty_as_none`
    /// has to collapse both null and "" or the UI gets two "no due date" cases.
    #[test]
    fn treats_a_null_and_an_empty_due_date_alike() {
        let nulled: MilestoneRef =
            serde_json::from_str(r#"{"number":1,"title":"m","dueOn":null}"#).unwrap();
        let empty: MilestoneRef =
            serde_json::from_str(r#"{"number":1,"title":"m","dueOn":""}"#).unwrap();
        assert_eq!(nulled.due_on, None);
        assert_eq!(empty.due_on, None);
    }

    /// The REST milestone list is snake_case while everything else gh emits is
    /// camelCase. The aliases have to accept REST's spelling without changing
    /// what the frontend receives.
    #[test]
    fn parses_rest_milestones_and_serializes_them_camel_case() {
        let json = r#"[{"number":8,"title":"Backlog","description":"Work not yet planned.","state":"open","due_on":null,"open_issues":1234,"closed_issues":56}]"#;
        let milestones: Vec<Milestone> = serde_json::from_str(json).unwrap();
        assert_eq!(milestones[0].open_issues, 1234);
        assert_eq!(milestones[0].closed_issues, 56);
        assert_eq!(milestones[0].due_on, None);

        let out = serde_json::to_string(&milestones[0]).unwrap();
        assert!(out.contains("\"openIssues\":1234"), "got {out}");
        assert!(out.contains("\"dueOn\":null"), "got {out}");
        assert!(!out.contains("open_issues"), "REST spelling must not leak out");
    }

    /// `null` for a description is routine on both labels and milestones, and
    /// serde's `default` covers an absent key but not a present null.
    #[test]
    fn survives_a_null_description() {
        let label: RepoLabel =
            serde_json::from_str(r#"{"name":"bug","color":"d73a4a","description":null}"#).unwrap();
        assert_eq!(label.description, "");
    }

    /// The detail payload is parsed twice over the same bytes — once as `Issue`,
    /// once for the extra keys — so both halves have to survive one parse of the
    /// real thing, and the flattened output must not nest the issue fields.
    #[test]
    fn parses_an_issue_view_payload_into_both_halves() {
        let json = r#"{"number":7,"title":"t","state":"CLOSED","stateReason":"COMPLETED","body":"the body","closedAt":"2026-08-01T00:00:00Z","author":{"login":"a"},"assignees":[],"labels":[],"milestone":null,"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-08-01T00:00:00Z","url":"https://example.invalid/7","isPinned":true,"comments":[{"id":"IC_1","author":{"login":"b"},"authorAssociation":"MEMBER","body":"a reply","createdAt":"2026-07-15T00:00:00Z","url":"https://example.invalid/7#c1","isMinimized":false,"minimizedReason":""}]}"#;
        let issue: Issue = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 7);
        assert!(issue.is_pinned);
        assert_eq!(issue.state_reason.as_deref(), Some("COMPLETED"));

        let comments: Vec<IssueComment> =
            serde_json::from_value(serde_json::from_str::<serde_json::Value>(json).unwrap()["comments"].clone())
                .unwrap();
        assert_eq!(comments[0].author.login, "b");
        assert_eq!(comments[0].author_association, "MEMBER");

        let detail = IssueDetail {
            issue,
            body: "the body".into(),
            comments,
            closed_at: Some("2026-08-01T00:00:00Z".into()),
        };
        let out = serde_json::to_string(&detail).unwrap();
        // `flatten` must hoist the issue's fields to the top level; a nested
        // "issue" key would make every frontend field access wrong.
        assert!(out.contains("\"number\":7"), "got {out}");
        assert!(!out.contains("\"issue\":"), "the issue must be flattened");
        assert!(out.contains("\"closedAt\""), "got {out}");
    }

    /// The reason `flag` exists. GitHub's search syntax negates with a leading
    /// dash, so `-label:bug` has to survive as a *value* rather than being read
    /// as an unknown flag and taking the whole query with it.
    #[test]
    fn keeps_a_dash_prefixed_value_attached_to_its_flag() {
        assert_eq!(flag("--search", "-label:bug"), "--search=-label:bug");
        assert_eq!(flag("--label", "good first issue"), "--label=good first issue");
        // One argv token, so nothing after the first '=' can be re-read as a flag.
        assert_eq!(flag("--title", "a=b=c"), "--title=a=b=c");
    }

    /// Positional arguments cannot use the `=` form, so they are the one place a
    /// leading dash still has to be refused outright.
    #[test]
    fn refuses_a_dash_prefixed_positional() {
        assert!(checked("repository", "-R").is_err());
        assert!(checked("repository", "owner/repo").is_ok());
    }

    /// `#123` is the spelling users type for a duplicate reference; gh wants a
    /// bare number or a URL, so the sigil is stripped rather than rejected.
    #[test]
    fn strips_the_sigil_from_a_duplicate_reference() {
        let normalize = |value: &str| {
            Some(value)
                .map(str::trim)
                .map(|d| d.strip_prefix('#').unwrap_or(d))
                .filter(|d| !d.is_empty())
                .map(str::to_string)
        };
        assert_eq!(normalize(" #123 ").as_deref(), Some("123"));
        assert_eq!(normalize("123").as_deref(), Some("123"));
        assert_eq!(
            normalize("https://github.com/o/r/issues/9").as_deref(),
            Some("https://github.com/o/r/issues/9")
        );
        assert_eq!(normalize("#"), None);
    }

    /// gh prints more than the URL on some paths (template notices, a project
    /// warning), so the last URL-looking line is what matters — and no URL at
    /// all yields empty rather than a guess.
    #[test]
    fn takes_the_last_url_gh_printed() {
        let out = b"Warning: 1 uncommitted change\nhttps://github.com/o/r/issues/12\n";
        assert_eq!(last_url(out), "https://github.com/o/r/issues/12");
        assert_eq!(last_url(b"Creating issue in o/r\n"), "");
        assert_eq!(last_url(b""), "");
    }

    /// `gh issue develop` names the branch itself when ours is already taken, so
    /// the caller has to read the real name back out of the URL it prints —
    /// otherwise the worktree is built from a branch that does not exist.
    #[test]
    fn reads_the_branch_name_back_out_of_a_develop_url() {
        assert_eq!(
            branch_from_url("https://github.com/o/r/tree/12-fix-the-thing").as_deref(),
            Some("12-fix-the-thing")
        );
        // A slash in a branch name arrives percent-encoded.
        assert_eq!(
            branch_from_url("https://github.com/o/r/tree/feature%2Flogin").as_deref(),
            Some("feature/login")
        );
        assert_eq!(branch_from_url("https://github.com/o/r/pull/12"), None);
        assert_eq!(branch_from_url("https://github.com/o/r/tree/"), None);
    }

    /// `--list` is tab-separated text rather than JSON, and gh has printed a
    /// header in some versions — anything without a branch in column one is not
    /// a branch.
    #[test]
    fn parses_tab_separated_linked_branches() {
        let out = "12-fix\thttps://github.com/o/r/tree/12-fix\n\n13-other\thttps://github.com/o/r/tree/13-other\n";
        let branches: Vec<String> = out
            .lines()
            .filter_map(|line| line.split('\t').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        assert_eq!(branches, vec!["12-fix", "13-other"]);
    }
}
