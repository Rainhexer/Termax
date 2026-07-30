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
    cmd.current_dir(root)
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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
}
