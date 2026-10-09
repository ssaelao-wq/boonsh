mod ai_chats;
mod bulk_rename;
mod dir_watch;
mod file_props;
mod fs_ops;
mod localtime;
mod pty;
mod search;
mod secrets;

use ai_chats::*;
use bulk_rename::*;
use dir_watch::*;
use file_props::*;
use fs_ops::*;
use pty::*;
use secrets::*;

/// `boonsh.exe --pty-helper ...` is a command line helper process (see pty.rs), not the app: it runs the helper
/// and returns its exit code. `None` for a normal start.
pub fn try_run_helper() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--pty-helper") {
        Some(pty::run_helper(&args[2..]))
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            list_directory,
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
            paste_items,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running boonsh tauri application");
}
