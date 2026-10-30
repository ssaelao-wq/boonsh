mod ai_chats;
mod basket;
mod bulk_rename;
mod cmdvars;
mod dir_watch;
mod drives;
mod file_drag;
mod file_props;
mod folder_size;
mod fs_ops;
mod gdrive;
mod gdrive_auth;
mod gdrive_transfer;
mod lan_share;
mod localtime;
mod paste;
mod pty;
mod search;
mod secrets;
mod shell_icons;
mod tree_newest;

use ai_chats::*;
use basket::*;
use bulk_rename::*;
use cmdvars::{expand_command, write_vars_file};
use dir_watch::*;
use file_props::*;
use fs_ops::*;
use gdrive::*;
use gdrive_auth::*;
use pty::*;
use secrets::*;

/// `boonsh.exe --pty-helper ...` is a command line helper process (see pty.rs) and `boonsh.exe --basket ...` a
/// basket command from a terminal tab, not the app: they run and return an exit code. `None` for a normal start.
pub fn try_run_helper() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--pty-helper") => Some(pty::run_helper(&args[2..])),
        // the PowerShell basket commands of the command line tabs (see basket.rs and pty.rs)
        Some("--basket") => Some(basket::run_cli(&args[2..])),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cmdvars::remove_stale_vars_files();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Updates from the GitHub releases (signed; see tauri.conf.json plugins.updater and src/updater.ts)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            list_directory,
            tree_has_children,
            tree_newest::tree_newest,
            drives::get_drives,
            folder_size::folder_sizes,
            folder_size::folder_sizes_stop,
            folder_size::folder_sizes_forget,
            folder_size::watch_folder_sizes,
            get_quick_access,
            create_new_file,
            create_new_folder,
            create_shortcut,
            open_in_default_app,
            open_license_notices,
            rename_item,
            bulk_rename_preview,
            bulk_rename_validate,
            bulk_rename_apply,
            bulk_rename_undo,
            delete_items,
            paste::paste_check,
            paste::paste_items,
            paste::paste_cancel,
            paste::paste_pause,
            paste::paste_start_now,
            compress_to_zip,
            extract_zip,
            read_text_file,
            read_subtitle,
            save_capture,
            pick_file,
            save_file_dialog,
            write_text_file,
            read_import_file,
            pick_app,
            list_app_handlers,
            open_with_app,
            read_image_base64,
            search_files,
            get_file_details,
            get_default_apps,
            shell_icons::get_file_icons,
            shell_icons::get_thumbnails,
            file_drag::start_file_drag,
            file_drag::drag_keys,
            open_admin_terminal,
            is_admin,
            relaunch_as_admin,
            relaunch_as_normal,
            get_username,
            force_window_to_front,
            ai_key_get,
            ai_key_set,
            ai_key_delete,
            watch_directory,
            ai_chats_list,
            ai_chat_load,
            ai_chat_save,
            ai_chat_delete,
            ai_chats_delete_all,
            basket_create,
            basket_view,
            basket_expand,
            basket_add,
            basket_remove,
            basket_relink,
            basket_update_paths,
            basket_paste_out,
            basket_zip,
            basket_delete_files,
            basket_search,
            pick_folder,
            expand_command,
            write_vars_file,
            gdrive_get_config,
            gdrive_save_credentials,
            gdrive_disconnect,
            gdrive_start_login,
            gdrive_create_folder,
            gdrive_rename,
            gdrive_delete,
            gdrive_open_in_browser,
            gdrive_get_folder_name,
            gdrive_get_breadcrumbs,
            gdrive_has_children,
            lan_share::lan_get_status,
            lan_share::lan_start_server,
            lan_share::lan_stop_server,
            lan_share::lan_revoke_device,
            lan_share::lan_clear_staging,
            lan_share::lan_share_files,
            lan_share::lan_open_incoming_folder,
            lan_share::lan_set_incoming_dir,
            lan_share::lan_set_gdrive_upload_dest,
        ])
        .build(tauri::generate_context!())
        .expect("error while running boonsh tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                cmdvars::remove_vars_file(); // the session's Global Var values (cmdvars.rs)
            }
        });
}
