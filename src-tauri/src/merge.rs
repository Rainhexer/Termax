//! Three-way line merge for the editor.
//!
//! An agent and the person at the keyboard write the same files at the same
//! time, so a save cannot be "put my buffer on disk": the bytes under it have
//! moved since the buffer was loaded, and blindly writing would delete work the
//! agent did in between. Every editor write therefore goes through a diff3
//! merge of three texts:
//!
//!  - **base** — what the pane loaded (or last saved). The common ancestor.
//!  - **ours** — the buffer, with the person's edits.
//!  - **theirs** — what is on disk right now, with the agent's edits.
//!
//! Non-overlapping regions from both sides are kept. Regions where both sides
//! touched the same lines are *not* resolved silently in anyone's favour: the
//! merge reports them, the write is refused, and the caller decides. Nothing
//! here ever drops a line that only one side changed.

use serde::Serialize;
use similar::{DiffTag, TextDiff};

use crate::fstree::resolve;
use crate::session::SessionManager;

#[derive(Serialize)]
pub struct MergeOutcome {
    /// `"unchanged"` — disk still matched base, nothing to merge.
    /// `"clean"` — both sides changed the file, in different places.
    /// `"conflict"` — both sides changed the same lines.
    pub status: &'static str,
    /// Text the buffer should end up holding. The merge for `unchanged`/`clean`;
    /// the diff3-marked text (both sides, with markers) for `conflict`.
    pub merged: String,
    /// Disk content at the moment of the merge, so the caller can adopt it as
    /// the new base without a second read that could see different bytes.
    pub disk: String,
    /// Regions where both sides changed the same lines.
    pub conflicts: usize,
    /// Whether `merged` reached the disk.
    pub written: bool,
}

/// Lines with their terminator attached, so joining is a plain concat and a
/// file with no trailing newline stays that way.
fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// A run of changed lines: base range `[start, end)` replaced by `lines`.
struct Hunk<'a> {
    start: usize,
    end: usize,
    lines: Vec<&'a str>,
}

impl Hunk<'_> {
    /// An insertion touches no base line, so it can sit between two hunks of
    /// the other side without fighting either.
    fn is_insert(&self) -> bool {
        self.start == self.end
    }
}

/// Changes `base` → `other`, as hunks over base line numbers. Adjacent ops are
/// folded into one hunk: a replace that similar splits into delete+insert must
/// be one region here, or the two halves could straddle the other side's hunk.
fn hunks<'a>(base: &[&str], other: &[&'a str]) -> Vec<Hunk<'a>> {
    let diff = TextDiff::from_slices(base, other);
    let mut out: Vec<Hunk<'a>> = Vec::new();
    for op in diff.ops() {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        let old = op.old_range();
        let new = op.new_range();
        let text = other[new].to_vec();
        match out.last_mut() {
            Some(last) if last.end == old.start => {
                last.end = old.end;
                last.lines.extend(text);
            }
            _ => out.push(Hunk {
                start: old.start,
                end: old.end,
                lines: text,
            }),
        }
    }
    out
}

/// Do two hunks fight over the same base lines?
///
/// Pure insertions at the same point do not: both can be kept, one after the
/// other. Anything else that overlaps — or an insertion landing inside the
/// other side's replaced range — is a region only a human can settle.
fn overlaps(a: &Hunk, b: &Hunk) -> bool {
    if a.is_insert() && b.is_insert() {
        return false;
    }
    // Half-open ranges, so an insertion sitting exactly on a hunk's edge is
    // disjoint from it — only one landing strictly inside collides.
    a.start < b.end && b.start < a.end
}

const OURS_MARK: &str = "<<<<<<< your edits\n";
const BASE_MARK: &str = "======= agent (on disk)\n";
const END_MARK: &str = ">>>>>>>\n";

/// Merge `ours` and `theirs`, both derived from `base`.
///
/// Returns the merged text and the number of conflicting regions. Conflicting
/// regions carry both sides between markers, so the text is still a superset of
/// everything either side wrote — the caller refuses to write it, but can hand
/// it to the editor for the person to resolve.
fn merge3(base: &[&str], ours: &[&str], theirs: &[&str]) -> (String, usize) {
    let ours_hunks = hunks(base, ours);
    let theirs_hunks = hunks(base, theirs);
    let mut out = String::new();
    let mut conflicts = 0;
    let mut pos = 0usize; // next unemitted base line
    let (mut i, mut j) = (0usize, 0usize);

    while i < ours_hunks.len() || j < theirs_hunks.len() {
        let o = ours_hunks.get(i);
        let t = theirs_hunks.get(j);

        // Only one side has anything left: take it.
        let (o, t) = match (o, t) {
            (Some(o), Some(t)) => (o, t),
            (Some(o), None) => {
                out.extend(base[pos..o.start].iter().copied());
                out.extend(o.lines.iter().copied());
                pos = o.end.max(pos);
                i += 1;
                continue;
            }
            (None, Some(t)) => {
                out.extend(base[pos..t.start].iter().copied());
                out.extend(t.lines.iter().copied());
                pos = t.end.max(pos);
                j += 1;
                continue;
            }
            (None, None) => break,
        };

        if overlaps(o, t) {
            let start = o.start.min(t.start);
            let end = o.end.max(t.end);
            out.extend(base[pos..start].iter().copied());
            if o.lines == t.lines && o.start == t.start && o.end == t.end {
                // Both sides made the same edit — one copy, no conflict.
                out.extend(o.lines.iter().copied());
            } else {
                conflicts += 1;
                out.push_str(OURS_MARK);
                out.extend(o.lines.iter().copied());
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(BASE_MARK);
                out.extend(t.lines.iter().copied());
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(END_MARK);
            }
            pos = end.max(pos);
            i += 1;
            j += 1;
            continue;
        }

        // Disjoint: emit whichever starts first. Insertions at the same point
        // both survive, the agent's first — its text is already on disk, and
        // the person's addition reads as the newer line.
        let take_theirs = t.start < o.start || (t.start == o.start && t.is_insert());
        let h = if take_theirs { t } else { o };
        out.extend(base[pos..h.start].iter().copied());
        out.extend(h.lines.iter().copied());
        pos = h.end.max(pos);
        if take_theirs {
            j += 1;
        } else {
            i += 1;
        }
    }

    out.extend(base[pos..].iter().copied());
    (out, conflicts)
}

fn read_text(abs: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(abs).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn outcome(base: &str, ours: &str, disk: String) -> MergeOutcome {
    if disk == base {
        return MergeOutcome {
            status: "unchanged",
            merged: ours.to_string(),
            disk,
            conflicts: 0,
            written: false,
        };
    }
    let (merged, conflicts) = merge3(&lines(base), &lines(ours), &lines(&disk));
    MergeOutcome {
        status: if conflicts == 0 { "clean" } else { "conflict" },
        merged,
        disk,
        conflicts,
        written: false,
    }
}

/// Merge the buffer against what is on disk without writing anything. Used when
/// the watcher reports that the file moved under an editor with unsaved edits:
/// the agent's lines are folded into the buffer live, so the person sees them
/// arrive instead of finding out at save time.
#[tauri::command(async)]
pub fn merge_file(
    manager: tauri::State<SessionManager>,
    path: String,
    base: String,
    ours: String,
    root: Option<String>,
) -> Result<MergeOutcome, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    Ok(outcome(&base, &ours, read_text(&abs)?))
}

/// Save the buffer, merging in anything that reached the file since `base`.
///
/// A clean merge is written. A conflict is *not*: the write would have to pick
/// a side, and the side it would drop is work someone did. The marked text
/// comes back instead so the editor can show both.
#[tauri::command(async)]
pub fn save_file_merged(
    manager: tauri::State<SessionManager>,
    path: String,
    base: String,
    ours: String,
    root: Option<String>,
) -> Result<MergeOutcome, String> {
    let (root, _) = manager
        .root_info(root.as_deref())
        .ok_or("no active session")?;
    let abs = resolve(&root, &path)?;
    if !abs.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let mut result = outcome(&base, &ours, read_text(&abs)?);
    if result.conflicts == 0 {
        std::fs::write(&abs, &result.merged).map_err(|e| e.to_string())?;
        result.written = true;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merge(base: &str, ours: &str, theirs: &str) -> (String, usize) {
        merge3(&lines(base), &lines(ours), &lines(theirs))
    }

    #[test]
    fn keeps_both_sides_when_they_touch_different_lines() {
        let base = "a\nb\nc\nd\n";
        let (merged, conflicts) = merge(base, "a\nb\nc\nd!\n", "a!\nb\nc\nd\n");
        assert_eq!(conflicts, 0);
        assert_eq!(merged, "a!\nb\nc\nd!\n");
    }

    #[test]
    fn agent_insertion_survives_a_users_edit_elsewhere() {
        let base = "one\ntwo\n";
        let (merged, conflicts) = merge(base, "one\ntwo\nuser\n", "one\nagent\ntwo\n");
        assert_eq!(conflicts, 0);
        assert_eq!(merged, "one\nagent\ntwo\nuser\n");
    }

    #[test]
    fn same_line_from_both_sides_is_a_conflict_that_loses_nothing() {
        let base = "x\n";
        let (merged, conflicts) = merge(base, "user\n", "agent\n");
        assert_eq!(conflicts, 1);
        assert!(merged.contains("user\n"));
        assert!(merged.contains("agent\n"));
    }

    #[test]
    fn identical_edits_collapse() {
        let (merged, conflicts) = merge("x\n", "y\n", "y\n");
        assert_eq!(conflicts, 0);
        assert_eq!(merged, "y\n");
    }

    #[test]
    fn missing_trailing_newline_is_preserved() {
        let (merged, conflicts) = merge("a\nb", "a\nb!", "a2\nb");
        assert_eq!(conflicts, 0);
        assert_eq!(merged, "a2\nb!");
    }
}
