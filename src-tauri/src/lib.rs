mod fstree;
mod git;
mod projects;
mod pty;
mod session;
mod settings;
mod store_io;
mod trust;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = projects::ProjectStore::load(app.handle());
            app.manage(store);
            app.manage(settings::SettingsStore::load(app.handle()));
            app.manage(trust::TrustStore::load(app.handle()));
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
            session::git_status,
            session::git_fetch,
            session::git_pull,
            session::git_branches,
            session::git_checkout,
            session::get_changes,
            session::get_diff,
            fstree::list_dir,
            fstree::read_file,
            fstree::read_file_data_url,
            fstree::write_file,
            fstree::reveal_in_file_manager,
            fstree::open_in_default_app,
            settings::get_settings,
            settings::save_settings,
            settings::detect_agents,
            settings::validate_command,
            settings::open_url,
            trust::is_trusted,
            trust::trust_folder,
            trust::revoke_trust,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
