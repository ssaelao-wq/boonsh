use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

use crate::fs_ops::default_start_dir;

pub struct PtyState {
    pub writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    pub pty_pair: Arc<Mutex<Option<portable_pty::PtyPair>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            writer: Arc::new(Mutex::new(None)),
            pty_pair: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PtyOutputPayload {
    pub data: String,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows: if rows == 0 { 24 } else { rows },
        cols: if cols == 0 { 80 } else { cols },
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Auto-detect pwsh.exe first, fallback to powershell.exe, fallback to cmd.exe
    let shell_cmd = if which_exists("pwsh.exe") {
        "pwsh.exe"
    } else if which_exists("powershell.exe") {
        "powershell.exe"
    } else {
        "cmd.exe"
    };

    let mut cmd = CommandBuilder::new(shell_cmd);
    cmd.env("TERM", "xterm-256color");

    // Each prompt emits an invisible OSC 9;9 sequence (ESC ] 9;9;<path> BEL/ST) carrying the
    // shell's current directory; TerminalPanel parses it to sync the file panel after `cd`.
    if shell_cmd.contains("pwsh") || shell_cmd.contains("powershell") {
        cmd.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            "function prompt { $l = $executionContext.SessionState.Path.CurrentLocation; $o = ''; if ($l.Provider.Name -eq 'FileSystem') { $o = [char]27 + ']9;9;' + $l.ProviderPath + [char]7 }; if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $o + 'admin > ' } else { $o + $env:USERNAME + ' > ' } }",
        ]);
    } else {
        cmd.args(["/k", "prompt $E]9;9;$P$E\\%USERNAME% $G"]);
    }

    let initial_cwd = match cwd {
        Some(ref d) if !d.trim().is_empty() => d.clone(),
        _ => default_start_dir(),
    };
    cmd.cwd(initial_cwd);

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell_cmd, e))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    *state.writer.lock().unwrap() = Some(writer);
    *state.pty_pair.lock().unwrap() = Some(pair);

    // Spawn background thread to stream PTY output to frontend via Tauri event
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut reader = reader;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit("pty-output", PtyOutputPayload { data: s });
                }
                Err(_) => break,
            }
        }
    });

    Ok(shell_cmd.to_string())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    if let Some(ref mut writer) = *state.writer.lock().unwrap() {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY writer: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(ref pair) = *state.pty_pair.lock().unwrap() {
        pair.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;
    }
    Ok(())
}

fn which_exists(exe: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for path in std::env::split_paths(&path_var) {
            let full_path = path.join(exe);
            if full_path.is_file() {
                return true;
            }
        }
    }
    false
}
