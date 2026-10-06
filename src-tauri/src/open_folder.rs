use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Listener, Manager};

/// A folder a desktop shell asked us to open (KDE task-manager recents,
/// Windows jump lists, macOS Dock) that arrived before the webview could
/// listen for it. Flushed to the frontend on the `frontend-ready` handshake.
#[derive(Default)]
pub struct PendingFolder(pub Mutex<Option<String>>);

/// True once the webview reported `frontend-ready`. Requests arriving after
/// that are forwarded immediately instead of queued.
#[derive(Default)]
pub struct FrontendReady(pub AtomicBool);

/// The first argument that names an existing directory — the folder a desktop
/// shell handed to a (possibly second) instance of the app.
///
/// KIO launches the app with a `file://` URL; other desktops pass the plain
/// path. Flags and non-directories are skipped so this is safe against
/// unrelated arguments.
pub fn folder_arg(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find_map(|arg| {
        let path = if arg.starts_with("file://") {
            tauri::Url::parse(arg)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| arg.strip_prefix("file://").unwrap_or(arg).to_string())
        } else {
            arg.clone()
        };
        Path::new(&path).is_dir().then_some(path)
    })
}

/// Route a request to open `path` to the frontend.
///
/// Once the webview is listening the event goes straight through; while it is
/// still loading the path is queued and flushed on the `frontend-ready`
/// handshake. That covers the cold-start case too: setup runs before any
/// frontend code, so an argv folder can only be delivered this way.
pub fn handle_open_request(app: &AppHandle, path: String) {
    if app.state::<FrontendReady>().0.load(Ordering::Relaxed) {
        let _ = app.emit("open-folder", path);
    } else {
        *app.state::<PendingFolder>().0.lock().unwrap() = Some(path);
    }
    // The desktop launched a second instance for this; the user is looking at
    // the task-manager menu, so the first window should come forward.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

/// Arm the `frontend-ready` handshake: mark the frontend ready and deliver any
/// folder that was queued while it was loading.
pub fn on_frontend_ready(app: &AppHandle) {
    let handle = app.clone();
    handle.clone().listen("frontend-ready", move |_| {
        handle.state::<FrontendReady>().0.store(true, Ordering::Relaxed);
        if let Some(path) = handle.state::<PendingFolder>().0.lock().unwrap().take() {
            let _ = handle.emit("open-folder", path);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn existing_dir(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("termax-open-folder-test-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn picks_the_first_existing_directory() {
        let dir = existing_dir("plain");
        let argv = vec!["termax".into(), "--flag".into(), dir.clone()];
        assert_eq!(folder_arg(&argv), Some(dir));
    }

    #[test]
    fn decodes_file_urls() {
        let dir = existing_dir("url");
        let url = format!("file://{}", dir);
        assert_eq!(folder_arg(&["termax".into(), url].to_vec()), Some(dir));
    }

    #[test]
    fn skips_flags_and_missing_paths() {
        let dir = existing_dir("missing-arg");
        let argv = vec![
            "termax".into(),
            "--banner".into(),
            PathBuf::from(dir).join("does-not-exist").to_string_lossy().into_owned(),
        ];
        assert_eq!(folder_arg(&argv), None);
    }

    /// The whole feature is dead without this. A desktop entry whose `Exec`
    /// carries no field code is launched with no arguments at all, so the
    /// folder KDE wants opened never reaches `folder_arg`.
    #[test]
    fn desktop_entry_passes_the_folder_through() {
        let template = include_str!("../main.desktop");
        let exec = template
            .lines()
            .find(|line| line.starts_with("Exec="))
            .expect("template must define Exec");
        assert!(exec.ends_with(" %u"), "Exec needs a URL field code: {exec}");
        assert!(
            template.contains("MimeType=inode/directory;"),
            "template must register the app as a folder handler"
        );
    }

    #[test]
    fn ignores_argv_zero_and_non_directory_args() {
        let dir = existing_dir("file-arg");
        let file = PathBuf::from(&dir).join("file.txt");
        std::fs::write(&file, "x").unwrap();
        let argv = vec![
            format!("{}/termax", dir),
            file.to_string_lossy().into_owned(),
        ];
        assert_eq!(folder_arg(&argv), None);
    }
}
