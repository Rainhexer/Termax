//! A periodic snapshot of everything that can grow, appended to a log file.
//!
//! Why this exists rather than a devtools session: release builds ship without
//! the inspector, and the interesting failure — the app getting choppier the
//! longer it is worked in — takes hours to reproduce and cannot be caught by
//! looking at a single moment. What is needed is the *shape* of each counter
//! over a working day, which means writing it down.
//!
//! The frontend collects its own counts (see `src/lib/diag.ts`) and hands them
//! here; this side adds what only the backend can see (open descriptors,
//! threads, unreaped children, resident memory, and the counts of its own
//! per-pane maps) and appends one line to
//! `<app data dir>/diag.log`.
//!
//! One line per sample, `key=value` pairs, so `awk` and a plot are enough to
//! see which counter climbs. Sampling is cheap — a few reads out of `/proc`,
//! once every half minute — but it is still gated: nothing is written unless
//! `TERMAX_DIAG` is set in the environment, so an ordinary run costs nothing.

use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use tauri::Manager;

/// Whether diagnostics are on for this run. Read once: an env var cannot change
/// under a running process, and this is checked on every sample.
pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("TERMAX_DIAG").is_some())
}

/// One field of `/proc/self/status`, as a number.
#[cfg(target_os = "linux")]
fn status_field(name: &str) -> u64 {
    let Ok(text) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    text.lines()
        .find(|line| line.starts_with(name))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn open_fds() -> u64 {
    std::fs::read_dir("/proc/self/fd")
        .map(|dir| dir.count() as u64)
        .unwrap_or(0)
}

/// Children of this process still in `Z` state — one is left behind for every
/// child killed and never waited on.
#[cfg(target_os = "linux")]
fn zombie_children() -> u64 {
    let me = std::process::id();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return 0;
    };
    let mut zombies = 0;
    for entry in dir.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{name}/stat")) else {
            continue;
        };
        // `pid (comm) state ppid ...`, and `comm` can contain spaces and
        // parentheses — so split after the last ')'.
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let state = fields.next().unwrap_or("");
        let ppid: u32 = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        if state == "Z" && ppid == me {
            zombies += 1;
        }
    }
    zombies
}

/// Resident memory of the webview's own process, which is where the terminal
/// buffers actually live: xterm keeps every scrollback line as a typed array in
/// the web process, so this is the number that has to be read next to
/// `termBufferKb` to tell a pane's history apart from everything else.
#[cfg(target_os = "linux")]
fn webview_rss_mb() -> u64 {
    let me = std::process::id().to_string();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return 0;
    };
    let mut total = 0;
    for entry in dir.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(status) = std::fs::read_to_string(format!("/proc/{name}/status")) else {
            continue;
        };
        let field = |key: &str| {
            status
                .lines()
                .find(|line| line.starts_with(key))
                .map(|line| line.split_whitespace().nth(1).unwrap_or("").to_string())
                .unwrap_or_default()
        };
        if field("PPid:") != me || !field("Name:").starts_with("WebKitWebProc") {
            continue;
        }
        total += field("VmRSS:").parse::<u64>().unwrap_or(0);
    }
    total / 1024
}

#[cfg(not(target_os = "linux"))]
fn webview_rss_mb() -> u64 {
    0
}

/// CPU time this process has burned, in milliseconds, split out for the main
/// thread — the one that also dispatches key presses, so the one whose time is
/// felt as lag.
#[cfg(target_os = "linux")]
fn cpu_ms() -> (u64, u64) {
    let ticks = |path: &str| -> u64 {
        let Ok(stat) = std::fs::read_to_string(path) else {
            return 0;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            return 0;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // After the state field: utime is field 11, stime 12 (1-based in
        // proc(5), which counts pid and comm as 1 and 2).
        let utime: u64 = fields.get(11).and_then(|v| v.parse().ok()).unwrap_or(0);
        let stime: u64 = fields.get(12).and_then(|v| v.parse().ok()).unwrap_or(0);
        // USER_HZ is 100 on every Linux target Termax ships for.
        (utime + stime) * 10
    };
    let pid = std::process::id();
    (
        ticks("/proc/self/stat"),
        ticks(&format!("/proc/{pid}/task/{pid}/stat")),
    )
}

#[cfg(not(target_os = "linux"))]
fn status_field(_: &str) -> u64 {
    0
}
#[cfg(not(target_os = "linux"))]
fn open_fds() -> u64 {
    0
}
#[cfg(not(target_os = "linux"))]
fn zombie_children() -> u64 {
    0
}
#[cfg(not(target_os = "linux"))]
fn cpu_ms() -> (u64, u64) {
    (0, 0)
}

/// Append one sample. `fields` is whatever the frontend counted, already
/// formatted as `key=value` pairs.
#[tauri::command(async)]
pub fn diag_sample(
    app: tauri::AppHandle,
    ptys: tauri::State<crate::pty::PtyManager>,
    fields: String,
) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let (process_cpu_ms, main_thread_cpu_ms) = cpu_ms();
    let (pty_handles, pty_screens, pty_unacked) = ptys.counts();

    let mut line = String::with_capacity(fields.len() + 256);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = write!(
        line,
        "t={now} rss_mb={} webview_rss_mb={} threads={} fds={} zombies={} cpu_ms={process_cpu_ms} \
         main_cpu_ms={main_thread_cpu_ms} pty_handles={pty_handles} \
         pty_screens={pty_screens} pty_unacked={pty_unacked} {fields}",
        status_field("VmRSS:") / 1024,
        webview_rss_mb(),
        status_field("Threads:"),
        open_fds(),
        zombie_children(),
    );

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("diag.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Whether the frontend should bother sampling at all.
#[tauri::command(async)]
pub fn diag_enabled() -> bool {
    enabled()
}
