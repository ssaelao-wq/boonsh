mod bulk_rename;
mod file_props;
mod fs_ops;
mod localtime;
mod pty;
mod search;

use bulk_rename::*;
use file_props::*;
use fs_ops::*;
use pty::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running boonsh tauri application");
}
