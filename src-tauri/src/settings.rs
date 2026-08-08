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

/// Appearance is owned by the frontend theming system (src/lib/theme.ts): the
/// backend just round-trips it, so themes gain tokens without a schema change
/// here. `theme` is a full theme object; older files hold a theme *name* string,
/// which the frontend migrates on load.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub sidebar_width: u32,
    pub theme_id: String,
    pub theme: serde_json::Value,
    pub custom_themes: Vec<serde_json::Value>,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            sidebar_width: 256,
            theme_id: "termax-dark".into(),
            theme: serde_json::Value::Null,
            custom_themes: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Behavior {
    /// Enable bell notification on command done for new panes.
    #[serde(default)]
    pub default_bell: bool,
    /// Launcher id opened in a new pull-request tab. Empty means the first
    /// enabled non-shell launcher. Chosen deliberately rather than inferred from
    /// the focused pane: predictable beats clever when one click spawns an agent.
    #[serde(default)]
    pub pr_launcher_id: String,
    /// Command offered (never run automatically) to set a fresh worktree up —
    /// typically `npm ci`. A worktree shares git objects but not build output, so
    /// a new tree of a JS project is broken until something like this runs.
    #[serde(default)]
    pub worktree_setup_command: String,
    /// Launcher id opened when handing an issue to an agent. Empty means "use
    /// whatever `pr_launcher_id` resolves to" — the same agent, since wanting
    /// one tool for issues and another for pull requests is unusual enough that
    /// it should be opt-in rather than a second thing to configure.
    #[serde(default)]
    pub issue_launcher_id: String,
    /// Prompt typed into the agent when an issue is handed to it.
    ///
    /// `{number}`, `{title}`, `{url}` and `{body}` are substituted. Empty means
    /// the built-in template. Typed rather than executed, like every other
    /// command Termax puts in a pane.
    #[serde(default)]
    pub issue_prompt_template: String,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            default_bell: false,
            pr_launcher_id: String::new(),
            worktree_setup_command: String::new(),
            issue_launcher_id: String::new(),
            issue_prompt_template: String::new(),
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
    pub behavior: Behavior,
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
            behavior: Behavior::default(),
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
        let settings: Settings = crate::store_io::load_json_or_default(&file);
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
        crate::store_io::write_json_atomic(&*file, &*settings)
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

/// Write a theme file to a path the user picked in a save dialog. Restricted to
/// `.json` so a stray call can't clobber arbitrary files.
#[tauri::command]
pub fn write_theme_file(path: String, contents: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("theme files must end in .json".into());
    }
    fs::write(&p, contents).map_err(|e| format!("failed to write {path}: {e}"))
}

/// Read a theme file the user picked in an open dialog.
#[tauri::command]
pub fn read_theme_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("theme files must end in .json".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("failed to read {path}: {e}"))
}

/// Font families installed on the system, sorted and de-duplicated. Empty when
/// the platform's font tool is missing — the UI then falls back to a built-in
/// list of common families.
#[tauri::command]
pub async fn list_fonts() -> Vec<String> {
    #[cfg(not(windows))]
    let output = Command::new("fc-list")
        .arg("--format=%{family}\n")
        .output();

    #[cfg(windows)]
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Drawing; [System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }",
        ])
        .output();

    let Ok(out) = output else {
        return Vec::new();
    };

    let mut families: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        // fc-list reports a family plus its aliases ("JetBrains Mono,JetBrains Mono ExtraBold");
        // the first entry is the name users recognise.
        .filter_map(|line| line.split(',').next())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();

    families.sort_by_key(|f| f.to_lowercase());
    families.dedup_by_key(|f| f.to_lowercase());
    families
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

/// Extra install dirs per OS that a GUI app's inherited `$PATH` often misses.
/// GUI processes (Tauri, launched from Finder/dock) get a stripped PATH that
/// excludes Homebrew, user-local, and version-manager bins. `~` expands to the
/// home dir. Add a line here to teach the scanner a new location.
#[cfg(target_os = "macos")]
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",     // Homebrew (Apple Silicon)
    "/usr/local/bin",        // Homebrew (Intel), common installs
    "~/.local/bin",          // pipx, user pip
    "~/.npm-global/bin",     // npm global prefix
    "~/.bun/bin",            // Bun
    "~/.cargo/bin",          // Rust/cargo
    "~/.deno/bin",           // Deno
    "~/.volta/bin",          // Volta
    "~/go/bin",              // Go
];

#[cfg(target_os = "linux")]
const EXTRA_DIRS: &[&str] = &[
    "/usr/local/bin",
    "~/.local/bin",          // pipx, user pip
    "~/.npm-global/bin",     // npm global prefix
    "~/.bun/bin",            // Bun
    "~/.cargo/bin",          // Rust/cargo
    "~/.deno/bin",           // Deno
    "~/.volta/bin",          // Volta
    "~/go/bin",              // Go
    "/snap/bin",             // Snap
    "/var/lib/flatpak/exports/bin",
];

#[cfg(target_os = "windows")]
const EXTRA_DIRS: &[&str] = &[
    "~/AppData/Roaming/npm",             // npm global
    "~/AppData/Local/Microsoft/WinGet/Links", // winget shims
    "~/.bun/bin",
    "~/.cargo/bin",
    "~/scoop/shims",                     // Scoop
];

/// Expand a leading `~` to the user's home directory.
fn expand_home(dir: &str) -> Option<PathBuf> {
    match dir.strip_prefix("~/") {
        Some(rest) => dirs_home().map(|h| h.join(rest)),
        None => Some(PathBuf::from(dir)),
    }
}

/// Home dir without pulling an extra crate: HOME on unix, USERPROFILE on windows.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

/// All dirs to probe: inherited `$PATH` first, then OS-specific well-known dirs
/// (deduped, home-expanded). Order preserves `$PATH` precedence.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&paths));
    }
    for extra in EXTRA_DIRS {
        if let Some(dir) = expand_home(extra) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

fn find_on_path(bin: &str) -> Option<PathBuf> {
    for dir in search_dirs() {
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

/// Open an http(s) URL in the system browser. Detached with its stdio nulled so
/// the opener process (and the browser it launches) survives independently of
/// the app and never blocks on an inherited pipe.
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

    let mut command = Command::new(cmd);
    command
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Detach into its own process group so it isn't tied to the app's session.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("failed to open {url} with {cmd}: {e}")),
    }
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
