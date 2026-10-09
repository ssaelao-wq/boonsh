// Auto refresh: watch the open folder for changes made by other programs (a file saved, downloaded, deleted)
// and tell the frontend with a `dir-changed` event, so the list updates without F5.
// One folder at a time (not its sub-folders), through Windows' change notifications
// (FindFirstChangeNotificationW). Hand-rolled kernel32 FFI, like fs_ops.rs.
// A burst of changes (a program writing a big file, a copy of many files) is sent as one event: after a change
// we wait until QUIET passes with nothing new, but never longer than MAX_WAIT.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Bumped for every new watch; a watcher thread ends as soon as it no longer holds the current number.
static GENERATION: AtomicU64 = AtomicU64::new(0);

const POLL_MS: u32 = 200; // how often a waiting watcher checks whether it was replaced
const QUIET: Duration = Duration::from_millis(400);
const MAX_WAIT: Duration = Duration::from_millis(2000);

#[derive(Clone, serde::Serialize)]
struct DirChangedPayload {
    path: String,
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    pub type HANDLE = *mut c_void;
    pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    pub const WAIT_OBJECT_0: u32 = 0;
    pub const WAIT_TIMEOUT: u32 = 0x102;
    // names, folder names, attributes (hidden), size, last write
    pub const FILTER: u32 = 0x1 | 0x2 | 0x4 | 0x8 | 0x10;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn FindFirstChangeNotificationW(lpPathName: *const u16, bWatchSubtree: i32, dwNotifyFilter: u32) -> HANDLE;
        pub fn FindNextChangeNotification(hChangeHandle: HANDLE) -> i32;
        pub fn FindCloseChangeNotification(hChangeHandle: HANDLE) -> i32;
        pub fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: u32) -> u32;
    }

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

/// Watch `path` from now on (the previous watch ends). None just stops watching.
#[tauri::command]
pub fn watch_directory(app: AppHandle, path: Option<String>) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(path) = path.filter(|p| !p.is_empty()) else { return };
    #[cfg(windows)]
    std::thread::spawn(move || watch_loop(app, path, gen));
    #[cfg(not(windows))]
    let _ = (app, path, gen);
}

#[cfg(windows)]
fn watch_loop(app: AppHandle, path: String, gen: u64) {
    use win::*;
    let wide_path = wide(&path);
    // SAFETY: wide_path is NUL-terminated and outlives the call; the handle is closed below.
    let handle = unsafe { FindFirstChangeNotificationW(wide_path.as_ptr(), 0, FILTER) };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return; // the folder cannot be watched (gone, no access): F5 still works
    }
    let mut pending: Option<(Instant, Instant)> = None; // (first change, latest change) not yet reported
    while GENERATION.load(Ordering::SeqCst) == gen {
        // SAFETY: handle is a valid change-notification handle until FindCloseChangeNotification.
        match unsafe { WaitForSingleObject(handle, POLL_MS) } {
            WAIT_OBJECT_0 => {
                let now = Instant::now();
                pending = Some((pending.map_or(now, |(first, _)| first), now));
                // SAFETY: as above
                if unsafe { FindNextChangeNotification(handle) } == 0 {
                    break; // the folder was deleted or the handle broke
                }
            }
            WAIT_TIMEOUT => {}
            _ => break,
        }
        if let Some((first, last)) = pending {
            let now = Instant::now();
            if now - last >= QUIET || now - first >= MAX_WAIT {
                pending = None;
                if GENERATION.load(Ordering::SeqCst) == gen {
                    let _ = app.emit("dir-changed", DirChangedPayload { path: path.clone() });
                }
            }
        }
    }
    // a change seen just before the folder broke is still worth one reload (e.g. the folder was deleted)
    if pending.is_some() && GENERATION.load(Ordering::SeqCst) == gen {
        let _ = app.emit("dir-changed", DirChangedPayload { path: path.clone() });
    }
    // SAFETY: closed exactly once
    unsafe { FindCloseChangeNotification(handle) };
}
