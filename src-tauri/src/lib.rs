mod diag;
mod fstree;
mod git;
mod github;
mod home;
mod merge;
mod open_folder;
mod projects;
mod preview;
mod pty;
mod session;
mod settings;
mod store_io;
mod trust;
mod vt;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = projects::ProjectStore::load(app.handle());
            app.manage(store);
            app.manage(settings::SettingsStore::load(app.handle()));
            app.manage(trust::TrustStore::load(app.handle()));
            app.manage(pty::PtyManager::default());
            app.manage(session::SessionManager::default());
            app.manage(preview::PreviewManager::default());
            app.manage(open_folder::PendingFolder::default());
            app.manage(open_folder::FrontendReady::default());
            open_folder::on_frontend_ready(app.handle());
            // Cold start: a desktop shell launched us with a folder. Since any
            // number of instances may run, every launch handles its own args.
            if let Some(path) = open_folder::folder_arg(&std::env::args().collect::<Vec<_>>()) {
                open_folder::handle_open_request(app.handle(), path);
            }
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
            pty::attach_pty_stream,
            pty::set_pane_visible,
            pty::pane_screens,
            pty::ack_pty_output,
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::pty_foreground_busy,
            pty::pty_input_is_raw,
            projects::list_projects,
            projects::add_project,
            projects::remove_project,
            projects::rename_project,
            projects::relink_project,
            projects::set_project_pinned,
            projects::touch_project,
            projects::save_layout,
            home::project_stats,
            home::search_projects,
            home::open_project_folder,
            home::open_project_terminal,
            projects::add_vault_command,
            projects::update_vault_command,
            projects::remove_vault_command,
            session::start_session,
            session::stop_session,
            session::open_worktree_session,
            session::close_worktree_session,
            session::list_worktrees,
            session::worktree_add,
            session::worktree_remove,
            session::worktree_prune,
            session::git_default_branch,
            session::git_create_branch,
            session::git_fetch_branch,
            session::git_fetch_pr_head,
            session::git_push,
            session::git_delete_branch,
            session::git_commit_subjects,
            session::git_fetch,
            session::git_pull,
            session::git_branches,
            session::git_checkout,
            session::get_root_git,
            session::get_diff,
            github::gh_probe,
            github::gh_pr_list,
            github::gh_pr_for_branch,
            github::gh_pr_view,
            github::gh_pr_create,
            github::gh_pr_ready,
            github::gh_pr_merge,
            github::gh_pr_close,
            github::gh_issue_list,
            github::gh_issue_view,
            github::gh_issue_create,
            github::gh_issue_edit,
            github::gh_issue_close,
            github::gh_issue_reopen,
            github::gh_issue_comment,
            github::gh_issue_develop,
            github::gh_issue_develop_list,
            github::gh_issue_pin,
            github::gh_issue_lock,
            github::gh_issue_transfer,
            github::gh_issue_delete,
            github::gh_repo_labels,
            github::gh_repo_assignees,
            github::gh_repo_milestones,
            github::gh_me,
            fstree::list_dir,
            fstree::read_file,
            fstree::read_file_data_url,
            fstree::write_file,
            merge::merge_file,
            merge::save_file_merged,
            fstree::reveal_in_file_manager,
            fstree::open_in_default_app,
            preview::preview_server,
            preview::preview_set_overlay,
            settings::get_settings,
            settings::save_settings,
            settings::detect_agents,
            settings::validate_command,
            settings::open_url,
            settings::write_theme_file,
            settings::read_theme_file,
            settings::list_fonts,
            trust::is_trusted,
            trust::trust_folder,
            trust::revoke_trust,
            diag::diag_sample,
            diag::diag_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // macOS Dock / "Open with" delivers folders this way; other platforms
        // hand them to a fresh process, which the single-instance plugin routes
        // back to this app via argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    open_folder::handle_open_request(app, path.to_string_lossy().into_owned());
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
