// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = boonsh_lib::try_run_helper() {
        std::process::exit(code);
    }
    boonsh_lib::run()
}
