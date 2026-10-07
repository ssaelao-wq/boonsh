//! Terminal tabs: one pseudo console + shell per tab.
//!
//! A tab normally runs in this process (`Session::Local`). A tab whose login differs from the app's (an
//! Administrator tab in a normal app, or a normal tab in an Administrator app) cannot: the elevation level
//! belongs to the process. Such a tab runs in a small helper process started at the wanted level
//! (`boonsh.exe --pty-helper ...`, see `run_helper`) that owns the pseudo console and shell. The helper
//! **connects back** to a loopback port that this process opened for that one tab and proves itself with a
//! random secret given on its command line; this process only ever talks to a helper it started.

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::fs_ops::default_start_dir;

// ---- helper protocol: frames of [kind u8][length u32 LE][payload] ----
const C_INPUT: u8 = 1; // app -> helper: bytes for the shell
const C_RESIZE: u8 = 2; // app -> helper: cols u16 LE, rows u16 LE
const C_CLOSE: u8 = 3; // app -> helper: end the shell and exit
const H_OUTPUT: u8 = 1; // helper -> app: shell output
const H_EXIT: u8 = 2; // helper -> app: the shell ended
const H_HELLO: u8 = 0x10; // helper -> app: the secret, first frame
const H_FAILED: u8 = 0x13; // helper -> app: the shell could not start (message)

const MAX_FRAME: usize = 4 * 1024 * 1024;

fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    w.write_all(&buf)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], payload))
}

/// A shell running here, in its own pseudo console.
struct LocalPty {
    writer: Box<dyn Write + Send>,
    pair: portable_pty::PtyPair,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// One terminal tab.
enum Session {
    Local(LocalPty),
    /// A shell in a helper process at another elevation level; this is our end of its connection.
    Remote(TcpStream),
}

/// All open terminal tabs, by the id the frontend gave them.
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
    /// Tabs closed before their helper connected (the helper's connection is then refused).
    closed: Mutex<HashSet<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PtyExitPayload {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PtyFailedPayload {
    pub id: String,
    pub message: String,
}

/// Opens a pseudo console and starts the shell in it. Returns it with the output reader and the shell's name.
fn open_local(cols: u16, rows: u16, cwd: Option<String>) -> Result<(LocalPty, Box<dyn Read + Send>, &'static str), String> {
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

    let child = pair
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

    Ok((LocalPty { writer, pair, child }, reader, shell_cmd))
}

/// Whether this process runs elevated (asked once; it cannot change while the app runs).
fn process_is_admin() -> bool {
    static ADMIN: OnceLock<bool> = OnceLock::new();
    *ADMIN.get_or_init(crate::fs_ops::is_admin)
}

/// Random bytes from Windows' own generator, as hex.
#[cfg(target_os = "windows")]
fn random_hex(bytes: usize) -> Result<String, String> {
    #[link(name = "advapi32")]
    extern "system" {
        // RtlGenRandom
        fn SystemFunction036(buffer: *mut u8, length: u32) -> u8;
    }
    let mut buf = vec![0u8; bytes];
    if unsafe { SystemFunction036(buf.as_mut_ptr(), bytes as u32) } == 0 {
        return Err("Could not create a secret for the command line".to_string());
    }
    Ok(buf.iter().map(|b| format!("{:02x}", b)).collect())
}

#[cfg(not(target_os = "windows"))]
fn random_hex(_bytes: usize) -> Result<String, String> {
    Err("Not supported on this system".to_string())
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    level: Option<String>, // "admin" or "normal": the login of this tab; None = same as the app
) -> Result<String, String> {
    state.closed.lock().unwrap().remove(&id);

    let admin_wanted = level.as_deref() == Some("admin");
    let remote = match level.as_deref() {
        Some("admin") => !process_is_admin(),
        Some("normal") => process_is_admin(),
        _ => false,
    };
    if remote {
        return spawn_remote(app, id, cols, rows, cwd, admin_wanted);
    }

    let (local, reader, shell_cmd) = open_local(cols, rows, cwd)?;
    state.sessions.lock().unwrap().insert(id.clone(), Session::Local(local));

    // Windows' pseudo console keeps its output pipe open after the shell ends, so the reader below never sees
    // the end by itself: watch the shell process and close the session when it is gone.
    let watch_app = app.clone();
    let watch_id = id.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        let state = watch_app.state::<PtyState>();
        let mut sessions = state.sessions.lock().unwrap();
        match sessions.get_mut(&watch_id) {
            Some(Session::Local(l)) => {
                if matches!(l.child.try_wait(), Ok(Some(_))) {
                    drop(sessions.remove(&watch_id));
                    drop(sessions);
                    thread::sleep(Duration::from_millis(200)); // let the last output reach the screen
                    let _ = watch_app.emit("pty-exit", PtyExitPayload { id: watch_id.clone() });
                    return;
                }
            }
            _ => return, // closed by the user (or replaced)
        }
    });

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
                    let _ = app_handle.emit("pty-output", PtyOutputPayload { id: id.clone(), data: s });
                }
                Err(_) => break,
            }
        }
        // The shell ended (typed `exit`, or the tab was closed): the frontend closes the tab
        let _ = app_handle.emit("pty-exit", PtyExitPayload { id });
    });

    Ok(shell_cmd.to_string())
}

/// Starts a helper at the other elevation level and waits for it, in the background, to connect.
fn spawn_remote(app: AppHandle, id: String, cols: u16, rows: u16, cwd: Option<String>, admin: bool) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Could not open a local port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let secret = random_hex(32)?;
    let cwd_text = match cwd {
        Some(ref d) if !d.trim().is_empty() => d.clone(),
        _ => default_start_dir(),
    };
    let args = format!(
        "--pty-helper {} {} {} {} {}",
        port,
        secret,
        cols,
        rows,
        crate::fs_ops::quote_path_arg(&cwd_text)
    );
    let launcher = crate::fs_ops::launch_helper(admin, &args)?;

    let _ = app.emit(
        "pty-output",
        PtyOutputPayload {
            id: id.clone(),
            data: format!(
                "Starting the {} command line...\r\n",
                if admin { "Administrator" } else { "normal user" }
            ),
        },
    );
    thread::spawn(move || accept_helper(app, id, listener, secret, launcher));
    Ok("helper".to_string())
}

fn fail(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        "pty-failed",
        PtyFailedPayload { id: id.to_string(), message: message.to_string() },
    );
}

/// Waits (up to two minutes: the Windows permission prompt waits for the user) for the helper of tab `id`,
/// checks its secret, then relays its output until the shell ends.
fn accept_helper(app: AppHandle, id: String, listener: TcpListener, secret: String, mut launcher: Option<std::process::Child>) {
    let state = app.state::<PtyState>();
    let _ = listener.set_nonblocking(true);
    let deadline = Instant::now() + Duration::from_secs(120);

    let mut stream = loop {
        if state.closed.lock().unwrap().contains(&id) {
            return;
        }
        if let Some(child) = launcher.as_mut() {
            // The launcher (PowerShell's Start-Process) fails at once when the permission prompt is refused
            if let Ok(Some(status)) = child.try_wait() {
                if !status.success() {
                    fail(&app, &id, "Windows did not start the Administrator command line (was the permission prompt cancelled?).");
                    return;
                }
                launcher = None;
            }
        }
        if Instant::now() > deadline {
            fail(&app, &id, "The command line did not start in time.");
            return;
        }
        match listener.accept() {
            Ok((mut s, _)) => {
                let _ = s.set_nonblocking(false);
                let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                if let Ok((H_HELLO, p)) = read_frame(&mut s) {
                    if p == secret.as_bytes() {
                        let _ = s.set_read_timeout(None);
                        break s;
                    }
                }
                // anything else (wrong secret, junk) is dropped and we keep waiting
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    };

    let _ = stream.set_nodelay(true);
    let writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => {
            fail(&app, &id, "Could not connect to the command line.");
            return;
        }
    };
    {
        let mut sessions = state.sessions.lock().unwrap();
        if state.closed.lock().unwrap().contains(&id) {
            return; // closed while connecting: dropping the stream ends the helper
        }
        sessions.insert(id.clone(), Session::Remote(writer));
    }

    loop {
        match read_frame(&mut stream) {
            Ok((H_OUTPUT, p)) => {
                let _ = app.emit(
                    "pty-output",
                    PtyOutputPayload { id: id.clone(), data: String::from_utf8_lossy(&p).to_string() },
                );
            }
            Ok((H_EXIT, _)) => break,
            Ok((H_FAILED, p)) => {
                state.sessions.lock().unwrap().remove(&id);
                fail(&app, &id, &String::from_utf8_lossy(&p));
                return;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    state.sessions.lock().unwrap().remove(&id);
    let _ = app.emit("pty-exit", PtyExitPayload { id });
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    match state.sessions.lock().unwrap().get_mut(&id) {
        Some(Session::Local(l)) => {
            l.writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write to PTY: {}", e))?;
            l.writer
                .flush()
                .map_err(|e| format!("Failed to flush PTY writer: {}", e))?;
        }
        Some(Session::Remote(s)) => {
            write_frame(s, C_INPUT, data.as_bytes()).map_err(|e| format!("Failed to write to the command line: {}", e))?;
        }
        None => {}
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    match state.sessions.lock().unwrap().get_mut(&id) {
        Some(Session::Local(l)) => {
            l.pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Failed to resize PTY: {}", e))?;
        }
        Some(Session::Remote(s)) => {
            let mut payload = Vec::with_capacity(4);
            payload.extend_from_slice(&cols.to_le_bytes());
            payload.extend_from_slice(&rows.to_le_bytes());
            let _ = write_frame(s, C_RESIZE, &payload);
        }
        None => {}
    }
    Ok(())
}

/// Ends a tab's shell (and anything running in it) and forgets the session.
#[tauri::command]
pub fn pty_close(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    state.closed.lock().unwrap().insert(id.clone());
    let session = state.sessions.lock().unwrap().remove(&id);
    match session {
        Some(Session::Local(mut l)) => {
            let _ = l.child.kill();
        }
        Some(Session::Remote(mut s)) => {
            let _ = write_frame(&mut s, C_CLOSE, &[]);
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        None => {}
    }
    Ok(())
}

/// Entry point of `boonsh.exe --pty-helper <port> <secret> <cols> <rows> <cwd>`: runs one shell for the app that
/// started it and relays between that shell and the app's connection. Returns the process exit code.
pub fn run_helper(args: &[String]) -> i32 {
    // A debug build is a console program, so Windows gives the helper a console window (the release build has
    // none). Let go of it: it would show up on screen, and closing it would kill the helper and its tab.
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn FreeConsole() -> i32;
        }
        FreeConsole();
    }
    let (Some(port), Some(secret), Some(cols), Some(rows)) = (
        args.first().and_then(|a| a.parse::<u16>().ok()),
        args.get(1),
        args.get(2).and_then(|a| a.parse::<u16>().ok()),
        args.get(3).and_then(|a| a.parse::<u16>().ok()),
    ) else {
        return 2;
    };
    let cwd = args.get(4).cloned();

    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return 1;
    };
    let _ = stream.set_nodelay(true);
    if write_frame(&mut stream, H_HELLO, secret.as_bytes()).is_err() {
        return 1;
    }

    let (local, mut reader, _) = match open_local(cols, rows, cwd) {
        Ok(x) => x,
        Err(e) => {
            let _ = write_frame(&mut stream, H_FAILED, e.as_bytes());
            return 1;
        }
    };

    let local = Arc::new(Mutex::new(local));
    let Ok(mut out) = stream.try_clone() else {
        let _ = local.lock().unwrap().child.kill();
        return 1;
    };
    // The pseudo console keeps its pipe open after the shell ends (see pty_spawn): watch the process too
    let watch_local = Arc::clone(&local);
    let mut watch_out = out.try_clone().ok();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        if matches!(watch_local.lock().unwrap().child.try_wait(), Ok(Some(_))) {
            thread::sleep(Duration::from_millis(200));
            if let Some(w) = watch_out.as_mut() {
                let _ = write_frame(w, H_EXIT, &[]);
            }
            std::process::exit(0);
        }
    });
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write_frame(&mut out, H_OUTPUT, &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = write_frame(&mut out, H_EXIT, &[]);
        std::process::exit(0); // the shell ended, so does the helper
    });

    loop {
        match read_frame(&mut stream) {
            Ok((C_INPUT, p)) => {
                let mut l = local.lock().unwrap();
                let _ = l.writer.write_all(&p);
                let _ = l.writer.flush();
            }
            Ok((C_RESIZE, p)) if p.len() == 4 => {
                let _ = local.lock().unwrap().pair.master.resize(PtySize {
                    cols: u16::from_le_bytes([p[0], p[1]]),
                    rows: u16::from_le_bytes([p[2], p[3]]),
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            Ok((C_CLOSE, _)) | Err(_) => break, // closed, or the app is gone
            Ok(_) => {}
        }
    }
    let _ = local.lock().unwrap().child.kill();
    0
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, H_OUTPUT, b"hello").unwrap();
        write_frame(&mut buf, C_CLOSE, &[]).unwrap();
        let mut r = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut r).unwrap(), (H_OUTPUT, b"hello".to_vec()));
        assert_eq!(read_frame(&mut r).unwrap(), (C_CLOSE, Vec::new()));
        assert!(read_frame(&mut r).is_err()); // end of data
    }

    #[test]
    fn oversized_frames_are_refused() {
        let mut head = vec![H_OUTPUT];
        head.extend_from_slice(&(MAX_FRAME as u32 + 1).to_le_bytes());
        let mut r = std::io::Cursor::new(head);
        assert!(read_frame(&mut r).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn secrets_are_random_hex() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
