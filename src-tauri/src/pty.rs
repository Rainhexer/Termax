use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<String, PtyInstance>>,
}

#[derive(Clone, Serialize)]
struct PtyOutput<'a> {
    pane_id: &'a str,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit<'a> {
    pane_id: &'a str,
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

impl PtyManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        pane_id: String,
        cwd: String,
        command: Option<String>,
        rows: u16,
        cols: u16,
        shell_override: Option<String>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = shell_override.unwrap_or_else(default_shell);
        let mut cmd = match &command {
            Some(c) if !c.trim().is_empty() => {
                let mut cmd = CommandBuilder::new(&shell);
                #[cfg(windows)]
                cmd.args(["/C", c]);
                #[cfg(not(windows))]
                cmd.args(["-ilc", c]);
                cmd
            }
            _ => CommandBuilder::new(&shell),
        };
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let reader_pane = pane_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit(
                            "pty-output",
                            PtyOutput {
                                pane_id: &reader_pane,
                                data,
                            },
                        );
                    }
                }
            }
            let _ = app.emit("pty-exit", PtyExit { pane_id: &reader_pane });
        });

        self.ptys.lock().unwrap().insert(
            pane_id,
            PtyInstance {
                master: pair.master,
                writer,
                child,
            },
        );
        Ok(())
    }

    pub fn write(&self, pane_id: &str, data: &str) -> Result<(), String> {
        let mut ptys = self.ptys.lock().unwrap();
        let pty = ptys.get_mut(pane_id).ok_or("no such pane")?;
        pty.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, pane_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let ptys = self.ptys.lock().unwrap();
        let pty = ptys.get(pane_id).ok_or("no such pane")?;
        pty.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, pane_id: &str) {
        if let Some(mut pty) = self.ptys.lock().unwrap().remove(pane_id) {
            let _ = pty.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut ptys = self.ptys.lock().unwrap();
        for (_, pty) in ptys.iter_mut() {
            let _ = pty.child.kill();
        }
        ptys.clear();
    }
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    manager: tauri::State<PtyManager>,
    settings: tauri::State<crate::settings::SettingsStore>,
    pane_id: String,
    cwd: String,
    command: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let shell_override = settings.shell_override();
    manager.spawn(app, pane_id, cwd, command, rows, cols, shell_override)
}

#[tauri::command]
pub fn write_pty(
    manager: tauri::State<PtyManager>,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&pane_id, &data)
}

#[tauri::command]
pub fn resize_pty(
    manager: tauri::State<PtyManager>,
    pane_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&pane_id, rows, cols)
}

#[tauri::command]
pub fn kill_pty(manager: tauri::State<PtyManager>, pane_id: String) {
    manager.kill(&pane_id)
}
