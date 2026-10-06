//! Shared JSON persistence helpers used by the settings, projects, and trust
//! stores. Two guarantees over a naive `fs::write` + `from_str().unwrap_or_default()`:
//!
//! 1. **Atomic writes** — content is written to a sibling `.tmp` file and then
//!    renamed onto the target, so a crash mid-write can never truncate/corrupt
//!    the live file (rename is atomic on the same filesystem).
//! 2. **No silent data loss** — if a file exists but fails to parse (corruption
//!    or an incompatible older/newer schema), it is preserved as a
//!    `.corrupt-<unix_ts>` backup and a warning is logged, instead of silently
//!    overwriting the user's data with defaults on the next save.

use serde::de::DeserializeOwned;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serialize `value` to pretty JSON and write it to `path` atomically.
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Load and parse JSON from `path`, falling back to `T::default()`. A missing
/// file is a normal cold start. A file that exists but fails to parse is backed
/// up to `<path>.corrupt-<ts>` (best effort) before defaulting, so nothing is
/// silently lost.
pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(text) = fs::read_to_string(path) else {
        return T::default(); // no file yet
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(err) => {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.corrupt-{ts}"));
            let backup_note = match fs::rename(path, &backup) {
                Ok(()) => format!("backed up to {}", backup.display()),
                Err(e) => format!("backup failed: {e}"),
            };
            eprintln!(
                "termax: failed to parse {} ({err}); {backup_note}. Falling back to defaults.",
                path.display()
            );
            T::default()
        }
    }
}
