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
        let projects = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            projects: Mutex::new(projects),
            file: Mutex::new(file),
        }
    }

    fn save(&self) -> Result<(), String> {
        let projects = self.projects.lock().unwrap();
        let file = self.file.lock().unwrap();
        let json = serde_json::to_string_pretty(&*projects).map_err(|e| e.to_string())?;
        fs::write(&*file, json).map_err(|e| e.to_string())
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
    };
    store.projects.lock().unwrap().push(project.clone());
    store.save()?;
    Ok(project)
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
