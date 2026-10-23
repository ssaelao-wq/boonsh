//! The newest Date Modified of any folder anywhere below a folder, for the folder tree: a parent is coloured
//! like its freshest descendant when that is newer than its own date, across all four colours (orange / yellow
//! / dim yellow / grey; see `folderAge` on the frontend), so the way down to the latest change is visible with
//! the tree folded, not only when that change happened today. Looks at folders' own dates only, like
//! `folderAge`; a file that is only edited does not move its folder's date, so it still does not count unless
//! the folder's own mtime moved.
//!
//! The walk stops early for a folder once it finds something modified today (`since`): nothing can beat that
//! colour, so there is no reason to look further. Without a match that good it has to walk the rest of the
//! subtree to find the true newest, which can be slow for a huge old tree, so it gives up after `BUDGET`
//! folders and returns whatever is the newest found so far (an undercount, never the wrong direction). Answers
//! are cached briefly (`FRESH`) so asking again right after (a sibling row, StrictMode) is instant.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

const FRESH: Duration = Duration::from_secs(120);
const BUDGET: usize = 100_000;
const MAX_REMEMBERED: usize = 300_000;

struct Entry {
    best: i64,
    at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static C: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache key: lower case, no trailing `\`.
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string()
}

fn remember(cache: &mut HashMap<String, Entry>, k: String, best: i64) {
    if cache.len() >= MAX_REMEMBERED {
        cache.clear();
    }
    cache.insert(k, Entry { best, at: Instant::now() });
}

fn mtime_of(entry: &fs::DirEntry) -> i64 {
    entry
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The newest mtime of any folder at or below `dir` (not `dir` itself: the caller already has that from its own
/// listing). `since` is local midnight: once the running best reaches it, the walk stops (nothing below can
/// give a better colour than "today").
fn newest_below(dir: &Path, since: i64, cache: &mut HashMap<String, Entry>, budget: &mut usize) -> i64 {
    let k = key(dir);
    if let Some(e) = cache.get(&k) {
        if e.at.elapsed() < FRESH {
            return e.best;
        }
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut best = 0i64;
    let mut subs: Vec<PathBuf> = Vec::new();
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        best = best.max(mtime_of(&e));
        if best >= since {
            break; // the best possible colour already: no sub-folder here can beat it
        }
        subs.push(e.path());
    }
    if best < since {
        for s in subs {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            best = best.max(newest_below(&s, since, cache, budget));
            if best >= since {
                break;
            }
        }
    }
    remember(cache, k, best);
    best
}

fn newest_below_cached(path: &str, since: i64) -> i64 {
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    let mut budget = BUDGET;
    newest_below(Path::new(path), since, &mut cache, &mut budget)
}

/// For each path, in order: the newest Date Modified of any folder below it (0 = none found, or the budget ran
/// out before anything was). `since` is local midnight (unix seconds), from the frontend.
#[tauri::command]
pub async fn tree_newest(paths: Vec<String>, since: i64) -> Result<Vec<i64>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| newest_below_cached(p, since)).collect())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::PathBuf;
    use std::time::SystemTime;

    /// Give a folder a specific Date Modified.
    fn set_mtime(dir: &Path, secs: i64) {
        // FILE_WRITE_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS (needed to open a folder)
        let f = OpenOptions::new().access_mode(0x100).custom_flags(0x0200_0000).open(dir).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_secs(secs as u64)).unwrap();
    }

    fn now() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
    }

    #[test]
    fn finds_the_newest_mtime_at_any_depth() {
        let root: PathBuf = std::env::temp_dir().join(format!("boonsh-tree-newest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in ["old1\\old2", "mix\\old3\\recent", "mix\\old4"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let since = now() - 3600; // "today" for this test = within the last hour
        let a_week_ago = now() - 7 * 86_400;

        // children first: making a folder old does not touch its parent's date, creating one does
        set_mtime(&root.join("old1\\old2"), a_week_ago);
        set_mtime(&root.join("old1"), a_week_ago);
        set_mtime(&root.join("mix\\old3\\recent"), now()); // "today": should short-circuit the walk
        set_mtime(&root.join("mix\\old3"), a_week_ago);
        set_mtime(&root.join("mix\\old4"), a_week_ago);
        set_mtime(&root.join("mix"), a_week_ago);

        let fresh = |p: &str| {
            let mut cache = HashMap::new();
            let mut budget = BUDGET;
            newest_below(&root.join(p), since, &mut cache, &mut budget)
        };

        assert!(fresh("mix") >= since, "mix\\old3\\recent is two levels down and today");
        assert!(fresh("mix\\old3") >= since);
        assert_eq!(fresh("old1"), a_week_ago, "old1\\old2 is the only folder below old1");
        assert_eq!(fresh("mix\\old4"), 0, "old4 has no sub-folders");
        assert_eq!(fresh("missing"), 0);

        // a far-future `since` means nothing can be "today": the full (slower) walk still finds old1\old2
        assert_eq!(
            {
                let mut cache = HashMap::new();
                let mut budget = BUDGET;
                newest_below(&root.join("old1"), now() + 3600, &mut cache, &mut budget)
            },
            a_week_ago
        );

        // out of budget: the direct children are still read (free), but the walk cannot go any deeper, so
        // mix\old3\recent (one level further) is missed -- an undercount, never a wrong "newer than it is"
        assert_eq!(
            {
                let mut cache = HashMap::new();
                let mut budget = 0;
                newest_below(&root.join("mix"), now() + 3600, &mut cache, &mut budget)
            },
            a_week_ago
        );

        // the result for a folder is remembered after a walk through it
        let mut cache = HashMap::new();
        let mut budget = BUDGET;
        newest_below(&root.join("mix"), since, &mut cache, &mut budget);
        assert!(cache.get(&key(&root.join("mix"))).is_some());

        let _ = fs::remove_dir_all(&root);
    }
}
