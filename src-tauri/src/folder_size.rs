//! Total size of folders, everything inside counted (all sub-folders), for the file panel's Size column and the
//! status bar. A walk runs in the background and reports each folder as it is done (`folder-size` event); a newer
//! request stops the older walk. Every folder measured on the way is remembered (`CACHE`), so opening a
//! sub-folder or the parent afterwards is quick. Remembered totals are used for `FRESH`; the frontend forgets a
//! folder (and the folders above it) when it changes or on Refresh.
//! Links and junctions are not followed, so nothing is counted twice and a walk cannot loop.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const FRESH: Duration = Duration::from_secs(600);
/// A whole-drive walk remembers every folder; past this many the memory is cleared and starts again.
const MAX_REMEMBERED: usize = 300_000;

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Serialize, Default, Debug, PartialEq)]
pub struct Totals {
    pub size: u64,
    pub files: u64,
    pub folders: u64,
}

struct Entry {
    totals: Totals,
    at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static C: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache key: lower case, `\` only, no trailing `\` (`C:\` -> `c:`).
pub fn key(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn remembered(k: &str) -> Option<Totals> {
    let c = cache().lock().ok()?;
    c.get(k).filter(|e| e.at.elapsed() < FRESH).map(|e| e.totals)
}

fn remember(k: String, totals: Totals) {
    if let Ok(mut c) = cache().lock() {
        if c.len() >= MAX_REMEMBERED {
            c.clear();
        }
        c.insert(k, Entry { totals, at: Instant::now() });
    }
}

/// Everything inside `dir`. None when a newer request started meanwhile (nothing half-done is remembered).
/// A folder that cannot be read counts as empty.
pub fn walk(dir: &Path, gen: u64) -> Option<Totals> {
    let k = key(&dir.to_string_lossy());
    if let Some(t) = remembered(&k) {
        return Some(t);
    }
    let mut t = Totals::default();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if GENERATION.load(Ordering::Relaxed) != gen {
                return None;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue; // symbolic links and junctions are not followed
            }
            if ft.is_dir() {
                let sub = walk(&e.path(), gen)?;
                t.folders += 1 + sub.folders;
                t.files += sub.files;
                t.size += sub.size;
            } else {
                t.files += 1;
                t.size += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    remember(k, t);
    Some(t)
}

/// Forget `path` and every folder above it (their totals include it), and the folders up to `levels` deep below
/// it (1 = its sub-folders, `u32::MAX` = everything). A change seen in the open folder forgets one level, so a
/// sub-folder something was pasted into is measured again from its (remembered) sub-folders: quick.
pub fn forget(path: &str, levels: u32) {
    let k = key(path);
    let Ok(mut c) = cache().lock() else { return };
    let mut up = Some(Path::new(path));
    while let Some(p) = up {
        c.remove(&key(&p.to_string_lossy()));
        up = p.parent();
    }
    if levels > 0 {
        let prefix = format!("{}\\", k);
        c.retain(|ck, _| match ck.strip_prefix(&prefix) {
            Some(rest) => rest.matches('\\').count() as u32 + 1 > levels,
            None => true,
        });
    }
}

#[derive(Serialize, Clone)]
struct SizeEvent {
    path: String,
    size: u64,
    files: u64,
    folders: u64,
}

/// Measure these folders in order, reporting each as a `folder-size` event. Stops when a newer call starts.
#[tauri::command]
pub async fn folder_sizes(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            if GENERATION.load(Ordering::Relaxed) != gen {
                break;
            }
            if let Some(t) = walk(Path::new(&p), gen) {
                let _ = app.emit("folder-size", SizeEvent { path: p, size: t.size, files: t.files, folders: t.folders });
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stop any walk that is running (the user left the folder view or turned sizes off).
#[tauri::command]
pub fn folder_sizes_stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub fn folder_sizes_forget(path: String, levels: u32) {
    forget(&path, levels);
}

// ---- Watching the open folder for size changes ----
// dir_watch.rs only sees the open folder's own entries (a file added inside one of its folders does not touch
// them), so sizes have their own watcher over the whole tree below the open folder. It reports which item
// changed, so only the folder holding it (and the folders above, in `forget`) are measured again; the rest stays
// remembered, which keeps even a busy drive cheap. Changes are batched (500 ms quiet, at most 2 s) into one
// `sizes-stale { path }` event.

static WATCH_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct StaleEvent {
    path: String,
}

#[cfg(windows)]
fn watch_blocking(app: AppHandle, root: String, gen: u64) {
    use std::collections::HashSet;
    use windows::core::{HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY,
        FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
        FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::Threading::CreateEventW;
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED};

    const WAIT_TIMEOUT: u32 = 258;
    const IO_INCOMPLETE: u32 = 996;
    let current = || WATCH_GENERATION.load(Ordering::Relaxed) == gen;

    unsafe {
        let wide = HSTRING::from(root.as_str());
        let Ok(dir) = CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            None,
        ) else {
            return;
        };
        let Ok(event) = CreateEventW(None, true, false, PCWSTR::null()) else {
            let _ = CloseHandle(dir);
            return;
        };
        let close = |dir: HANDLE, event: HANDLE| {
            let _ = CloseHandle(dir);
            let _ = CloseHandle(event);
        };
        let mut buf = vec![0u32; 16 * 1024]; // 64 KB, DWORD-aligned as the API needs
        let mut pending: HashSet<String> = HashSet::new();
        let (mut first, mut last) = (Instant::now(), Instant::now());

        'watch: while current() {
            let mut ov = OVERLAPPED { hEvent: event, ..Default::default() };
            let filter = FILE_NOTIFY_CHANGE_FILE_NAME
                | FILE_NOTIFY_CHANGE_DIR_NAME
                | FILE_NOTIFY_CHANGE_SIZE
                | FILE_NOTIFY_CHANGE_LAST_WRITE;
            if ReadDirectoryChangesW(dir, buf.as_mut_ptr() as *mut _, (buf.len() * 4) as u32, true, filter, None, Some(&mut ov), None)
                .is_err()
            {
                break;
            }
            let mut got = 0u32;
            loop {
                if !current() {
                    let _ = CancelIoEx(dir, Some(&ov));
                    let _ = GetOverlappedResult(dir, &ov, &mut got, true);
                    break 'watch;
                }
                match GetOverlappedResultEx(dir, &ov, &mut got, 200, false) {
                    Ok(()) => break,
                    Err(e) if e.code() == HRESULT::from_win32(WAIT_TIMEOUT) || e.code() == HRESULT::from_win32(IO_INCOMPLETE) => {
                        // quiet: hand over what was collected (500 ms without news, or 2 s since the first)
                        if !pending.is_empty() && (last.elapsed() >= Duration::from_millis(500) || first.elapsed() >= Duration::from_secs(2)) {
                            for p in pending.drain() {
                                forget(&p, 0);
                            }
                            let _ = app.emit("sizes-stale", StaleEvent { path: root.clone() });
                        }
                    }
                    Err(_) => break 'watch, // the folder went away
                }
            }
            if pending.is_empty() {
                first = Instant::now();
            }
            last = Instant::now();
            if got == 0 {
                // too many changes at once for the buffer: measure the whole open folder again
                forget(&root, u32::MAX);
                pending.insert(root.clone());
                continue;
            }
            // each entry names a changed item relative to the root; its folder's total changed
            let base = buf.as_ptr() as *const u8;
            let mut offset = 0usize;
            loop {
                let info = &*(base.add(offset) as *const FILE_NOTIFY_INFORMATION);
                let name = std::slice::from_raw_parts(info.FileName.as_ptr(), info.FileNameLength as usize / 2);
                let changed = Path::new(&root).join(String::from_utf16_lossy(name));
                if let Some(parent) = changed.parent() {
                    pending.insert(parent.to_string_lossy().to_string());
                }
                if info.NextEntryOffset == 0 {
                    break;
                }
                offset += info.NextEntryOffset as usize;
            }
        }
        close(dir, event);
    }
}

#[cfg(not(windows))]
fn watch_blocking(_app: AppHandle, _root: String, _gen: u64) {}

/// Watch everything below `path` for size changes (None: stop watching). The older watch ends within 200 ms.
#[tauri::command]
pub fn watch_folder_sizes(app: AppHandle, path: Option<String>) {
    let gen = WATCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(root) = path.filter(|p| !p.is_empty()) {
        std::thread::spawn(move || watch_blocking(app, root, gen));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_count_everything_inside_and_follow_changes() {
        let base = std::env::temp_dir().join(format!("boonsh-foldersize-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a\\b")).unwrap();
        fs::create_dir_all(base.join("empty")).unwrap();
        fs::write(base.join("top.bin"), vec![0u8; 100]).unwrap();
        fs::write(base.join("a\\one.bin"), vec![0u8; 1000]).unwrap();
        fs::write(base.join("a\\b\\two.bin"), vec![0u8; 20]).unwrap();
        let gen = GENERATION.load(Ordering::SeqCst);

        let all = walk(&base, gen).unwrap();
        assert_eq!(all, Totals { size: 1120, files: 3, folders: 3 });
        // sub-folders were remembered on the way
        assert_eq!(remembered(&key(&base.join("a").to_string_lossy())), Some(Totals { size: 1020, files: 2, folders: 1 }));
        assert_eq!(walk(&base.join("empty"), gen), Some(Totals::default()));

        // a change deep inside: still the remembered total until it is forgotten, then the new one
        fs::write(base.join("a\\b\\more.bin"), vec![0u8; 5]).unwrap();
        assert_eq!(walk(&base, gen).unwrap().size, 1120);
        forget(&base.join("a\\b").to_string_lossy(), 0);
        assert_eq!(walk(&base, gen).unwrap().size, 1125);

        // forgetting the top one level deep: `a` is measured again, `a\b` is still remembered
        fs::write(base.join("a\\b\\late.bin"), vec![0u8; 7]).unwrap();
        forget(&base.to_string_lossy(), 1);
        assert!(remembered(&key(&base.join("a").to_string_lossy())).is_none());
        assert!(remembered(&key(&base.join("a\\b").to_string_lossy())).is_some());
        assert_eq!(walk(&base, gen).unwrap().size, 1125);
        forget(&base.to_string_lossy(), u32::MAX);
        assert_eq!(walk(&base, gen).unwrap().size, 1132);

        // a newer request stops a walk that has not been remembered yet
        forget(&base.to_string_lossy(), u32::MAX);
        assert_eq!(walk(&base, gen.wrapping_sub(1)), None);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn keys_ignore_case_slashes_and_trailing_backslash() {
        assert_eq!(key("C:\\Users\\Me\\"), "c:\\users\\me");
        assert_eq!(key("c:/users/me"), "c:\\users\\me");
        assert_eq!(key("D:\\"), "d:");
    }
}
