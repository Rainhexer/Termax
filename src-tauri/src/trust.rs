//! Folder trust: a VS Code–style gate over running git on a directory.
//!
//! Opening a project runs git (`is_repo`, auto-`fetch`, `status`), all of which
//! read `.git/config` — the untrusted-repo code-execution vector. Until the user
//! explicitly trusts a folder, `start_session` skips git entirely and opens in
//! snapshot-tracking mode. Trusted folders are remembered across restarts so the
//! prompt only appears the first time a given directory is opened.

use crate::store_io;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default)]
struct TrustData {
    /// Canonicalized absolute paths the user has trusted.
    paths: Vec<String>,
}

#[derive(Default)]
pub struct TrustStore {
    data: Mutex<TrustData>,
    file: Mutex<PathBuf>,
}

/// Canonicalize a path for stable comparison; fall back to the raw path if the
/// directory can't be canonicalized (e.g. it no longer exists).
fn canonical(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

impl TrustStore {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("trusted.json");
        let data: TrustData = store_io::load_json_or_default(&file);
        Self {
            data: Mutex::new(data),
            file: Mutex::new(file),
        }
    }

    fn save(&self) -> Result<(), String> {
        let data = self.data.lock().unwrap();
        let file = self.file.lock().unwrap();
        store_io::write_json_atomic(&*file, &*data)
    }

    pub fn is_trusted(&self, path: &str) -> bool {
        let target = canonical(path);
        self.data.lock().unwrap().paths.iter().any(|p| p == &target)
    }
}

#[tauri::command]
pub fn is_trusted(store: tauri::State<TrustStore>, path: String) -> bool {
    store.is_trusted(&path)
}

#[tauri::command]
pub fn trust_folder(store: tauri::State<TrustStore>, path: String) -> Result<(), String> {
    let target = canonical(&path);
    {
        let mut data = store.data.lock().unwrap();
        if !data.paths.contains(&target) {
            data.paths.push(target);
        }
    }
    store.save()
}

#[tauri::command]
pub fn revoke_trust(store: tauri::State<TrustStore>, path: String) -> Result<(), String> {
    let target = canonical(&path);
    store.data.lock().unwrap().paths.retain(|p| p != &target);
    store.save()
}
