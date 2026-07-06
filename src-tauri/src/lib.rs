mod projects;
mod pty;
mod session;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = projects::ProjectStore::load(app.handle());
            app.manage(store);
            app.manage(pty::PtyManager::default());
            app.manage(session::SessionManager::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(manager) = window.app_handle().try_state::<pty::PtyManager>() {
                    manager.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            projects::list_projects,
            projects::add_project,
            projects::remove_project,
            projects::save_layout,
            projects::add_vault_command,
            projects::update_vault_command,
            projects::remove_vault_command,
            session::start_session,
            session::stop_session,
            session::get_changes,
            session::get_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
