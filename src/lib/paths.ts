/** Comparing directory paths that arrive spelled differently.
 *
 *  The same directory reaches the frontend from three sources that never agree
 *  on Windows. The folder picker and `worktreePathFor` produce native paths
 *  (`C:\Users\me\proj-worktrees\x`); `git worktree list` prints forward slashes
 *  (`C:/Users/me/proj-worktrees/x`); and the backend's `canonicalize()` returns
 *  Rust's verbatim form (`\\?\C:\Users\me\proj-worktrees\x`). On Linux all three
 *  are the same string, which is how exact comparisons survived until the first
 *  Windows user created a worktree and was told its directory did not exist.
 *
 *  Nothing here touches the filesystem: it folds spellings, it does not resolve
 *  symlinks. The backend's canonical root is still the key for anything that
 *  reaches the backend; this only decides whether two strings name one place.
 */

/** Rust's verbatim prefix, and the UNC variant it uses for `\\server\share`. */
const VERBATIM = /^\\\\\?\\/;
const VERBATIM_UNC = /^UNC[\\/]/i;

/** A drive-lettered path, after separators have been folded to `/`. */
const DRIVE = /^[a-zA-Z]:(\/|$)/;

/** One spelling for every way a directory can be written.
 *
 *  Strips the verbatim prefix, folds `\` to `/`, drops trailing separators, and
 *  lowercases Windows paths (drive-lettered or UNC), because NTFS compares names
 *  case-insensitively and git preserves whatever case the path was typed in.
 *  POSIX paths keep their case: `/tmp/A` and `/tmp/a` are different directories. */
export function pathKey(path: string): string {
  let s = path;
  if (VERBATIM.test(s)) {
    s = s.slice(4);
    if (VERBATIM_UNC.test(s)) s = `\\\\${s.slice(4)}`;
  }
  s = s.replace(/\\/g, "/");
  // Trailing separators, but never the root itself: "/" stays "/", and a bare
  // drive "C:/" keeps its slash so it cannot be mistaken for a relative "C:".
  s = s.replace(/(?<=[^/])\/+$/, "");
  if (/^[a-zA-Z]:$/.test(s)) s += "/";
  const windows = DRIVE.test(s) || s.startsWith("//");
  return windows ? s.toLowerCase() : s;
}

/** Whether two strings name the same directory, allowing for spelling.
 *
 *  Either side may be null: a path that is not known yet matches nothing, which
 *  is the answer every caller wants rather than an exception. */
export function samePathKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}
