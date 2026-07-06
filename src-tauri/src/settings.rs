use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

/// A terminal launcher shown in the sidebar Launch section. `command: None`
/// is the built-in Shell entry, which cannot be removed or disabled.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    pub id: String,
    pub name: String,
    pub command: Option<String>,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_icon() -> String {
    "robot".into()
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub font_family: String,
    pub font_size: u32,
    pub editor_font_size: u32,
    pub theme: String,
    pub sidebar_width: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            font_family: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace".into(),
            font_size: 13,
            editor_font_size: 12,
            theme: "dark".into(),
            sidebar_width: 256,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    /// Empty string means auto-detect ($SHELL / COMSPEC).
    pub default_shell: String,
    pub scrollback: u32,
    /// "block" | "underline" | "bar"
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub cursor_color: String,
    /// Max file size (KB) for diff/snapshot tracking.
    pub oversized_limit_kb: u64,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            default_shell: String::new(),
            scrollback: 10000,
            cursor_style: "underline".into(),
            cursor_blink: true,
            cursor_color: "#34d399".into(),
            oversized_limit_kb: 1024,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub launchers: Vec<Launcher>,
    pub appearance: Appearance,
    pub terminal: TerminalSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launchers: vec![
                Launcher {
                    id: "shell".into(),
                    name: "Shell".into(),
                    command: None,
                    icon: "shell".into(),
                    enabled: true,
                },
                Launcher {
                    id: "claude".into(),
                    name: "Claude Code".into(),
                    command: Some("claude".into()),
                    icon: "claude".into(),
                    enabled: true,
                },
                Launcher {
                    id: "opencode".into(),
                    name: "OpenCode".into(),
                    command: Some("opencode".into()),
                    icon: "opencode".into(),
                    enabled: true,
                },
            ],
            appearance: Appearance::default(),
            terminal: TerminalSettings::default(),
        }
    }
}

#[derive(Default)]
pub struct SettingsStore {
    pub settings: Mutex<Settings>,
    file: Mutex<PathBuf>,
}

impl SettingsStore {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("settings.json");
        let settings: Settings = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        crate::session::set_snapshot_limit(settings.terminal.oversized_limit_kb * 1024);
        Self {
            settings: Mutex::new(settings),
            file: Mutex::new(file),
        }
    }

    /// Shell override from settings; None means auto-detect.
    pub fn shell_override(&self) -> Option<String> {
        let shell = self.settings.lock().unwrap().terminal.default_shell.clone();
        let shell = shell.trim().to_string();
        if shell.is_empty() {
            None
        } else {
            Some(shell)
        }
    }

    fn save(&self) -> Result<(), String> {
        let settings = self.settings.lock().unwrap();
        let file = self.file.lock().unwrap();
        let json = serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())?;
        fs::write(&*file, json).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_settings(store: tauri::State<SettingsStore>) -> Settings {
    store.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    store: tauri::State<SettingsStore>,
    settings: Settings,
) -> Result<(), String> {
    crate::session::set_snapshot_limit(settings.terminal.oversized_limit_kb * 1024);
    *store.settings.lock().unwrap() = settings;
    store.save()
}

/// Known AI coding agents probed on $PATH.
const CANDIDATES: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("opencode", "OpenCode"),
    ("aider", "Aider"),
    ("copilot", "GitHub Copilot CLI"),
    ("codegpt", "CodeGPT"),
    ("sweep", "Sweep CLI"),
    ("gpt-engineer", "GPT Engineer"),
    ("continue", "Continue"),
];

/// Binaries whose `--version` is known to be fast and well-formed.
const VERSION_CHECK: &[&str] = &["claude", "opencode", "aider"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub binary: String,
    pub label: String,
    pub path: String,
    pub version: Option<String>,
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn find_on_path(bin: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(bin);
        if is_executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{bin}.exe"));
            if is_executable(&exe) {
                return Some(exe);
            }
        }
    }
    None
}

fn probe_version(path: &Path) -> Option<String> {
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

#[tauri::command]
pub async fn detect_agents() -> Vec<DetectedAgent> {
    CANDIDATES
        .iter()
        .filter_map(|(bin, label)| {
            let path = find_on_path(bin)?;
            let version = if VERSION_CHECK.contains(bin) {
                probe_version(&path)
            } else {
                None
            };
            Some(DetectedAgent {
                binary: (*bin).into(),
                label: (*label).into(),
                path: path.to_string_lossy().into_owned(),
                version,
            })
        })
        .collect()
}

/// Open an http(s) URL in the system browser.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("refusing to open non-http url: {url}"));
    }
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    Command::new(cmd)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// True when the command resolves: absolute/relative path to an executable,
/// or a bare name found on $PATH.
#[tauri::command]
pub fn validate_command(command: String) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    // Only validate the program itself, not arguments.
    let program = command.split_whitespace().next().unwrap_or(command);
    let path = Path::new(program);
    if path.components().count() > 1 {
        return is_executable(path);
    }
    find_on_path(program).is_some()
}
