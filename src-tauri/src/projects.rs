use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default, rename = "terminalType")]
    pub terminal_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub commands: Vec<VaultCommand>,
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
    /// Kept at the front of the home screen regardless of recency. The home
    /// screen does not scroll, so "always visible" is a real guarantee and not
    /// just a sort key.
    #[serde(default)]
    pub pinned: bool,
    /// Seconds since the epoch, set when the project is opened. Orders the home
    /// screen so the folders you actually work in stay on it.
    ///
    /// `#[serde(default)]` on both of these is what lets a `projects.json`
    /// written before they existed load unchanged.
    #[serde(default, rename = "lastOpened")]
    pub last_opened: Option<i64>,
}

#[derive(Default)]
pub struct ProjectStore {
    pub projects: Mutex<Vec<Project>>,
    pub file: Mutex<PathBuf>,
}

impl ProjectStore {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("projects.json");
        let projects = crate::store_io::load_json_or_default(&file);
        Self {
            projects: Mutex::new(projects),
            file: Mutex::new(file),
        }
    }

    fn save(&self) -> Result<(), String> {
        let projects = self.projects.lock().unwrap();
        let file = self.file.lock().unwrap();
        crate::store_io::write_json_atomic(&*file, &*projects)
    }
}

#[tauri::command]
pub fn list_projects(store: tauri::State<ProjectStore>) -> Vec<Project> {
    store.projects.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_project(
    store: tauri::State<ProjectStore>,
    name: String,
    path: String,
) -> Result<Project, String> {
    if !PathBuf::from(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        commands: Vec::new(),
        layout: None,
        pinned: false,
        // A project you just added is the one you are about to open, so it
        // sorts as freshly used rather than as never-used.
        last_opened: Some(now()),
    };
    store.projects.lock().unwrap().push(project.clone());
    store.save()?;
    Ok(project)
}

/// Seconds since the epoch. Clock skew only ever affects sort order here, so a
/// pre-1970 clock collapsing to 0 is a fine failure mode.
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Change a project's display name. The folder on disk is untouched: this is a
/// label, so that two checkouts of the same repository can be told apart.
#[tauri::command]
pub fn rename_project(
    store: tauri::State<ProjectStore>,
    id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a project needs a name".into());
    }
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("no such project")?;
        project.name = name;
    }
    store.save()
}

#[tauri::command]
pub fn set_project_pinned(
    store: tauri::State<ProjectStore>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("no such project")?;
        project.pinned = pinned;
    }
    store.save()
}

/// Record that a project was just opened, for the home screen's ordering.
#[tauri::command]
pub fn touch_project(store: tauri::State<ProjectStore>, id: String) -> Result<(), String> {
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("no such project")?;
        project.last_opened = Some(now());
    }
    store.save()
}

#[tauri::command]
pub fn remove_project(store: tauri::State<ProjectStore>, id: String) -> Result<(), String> {
    store.projects.lock().unwrap().retain(|p| p.id != id);
    store.save()
}

#[tauri::command]
pub fn save_layout(
    store: tauri::State<ProjectStore>,
    id: String,
    layout: serde_json::Value,
) -> Result<(), String> {
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("no such project")?;
        project.layout = Some(layout);
    }
    store.save()
}

#[tauri::command]
pub fn add_vault_command(
    store: tauri::State<ProjectStore>,
    project_id: String,
    name: String,
    command: String,
    terminal_type: String,
) -> Result<VaultCommand, String> {
    let cmd = VaultCommand {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        command,
        terminal_type,
    };
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("no such project")?;
        project.commands.push(cmd.clone());
    }
    store.save()?;
    Ok(cmd)
}

#[tauri::command]
pub fn update_vault_command(
    store: tauri::State<ProjectStore>,
    project_id: String,
    command_id: String,
    name: String,
    command: String,
    terminal_type: String,
) -> Result<VaultCommand, String> {
    let updated = {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("no such project")?;
        let cmd = project
            .commands
            .iter_mut()
            .find(|c| c.id == command_id)
            .ok_or("no such command")?;
        cmd.name = name;
        cmd.command = command;
        cmd.terminal_type = terminal_type;
        cmd.clone()
    };
    store.save()?;
    Ok(updated)
}

#[tauri::command]
pub fn remove_vault_command(
    store: tauri::State<ProjectStore>,
    project_id: String,
    command_id: String,
) -> Result<(), String> {
    {
        let mut projects = store.projects.lock().unwrap();
        let project = projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or("no such project")?;
        project.commands.retain(|c| c.id != command_id);
    }
    store.save()
}
