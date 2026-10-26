//! Paste (copy or move) into a folder, with the user's choice for each name clash, progress events and Cancel.
//!
//! `paste_check` lists the clashes first: an item whose name is already taken in the folder, or by an earlier item
//! of the same paste. The frontend asks the user (Replace / Keep Both / Skip) and calls `paste_items` with the
//! answers and a job number. The work runs in `spawn_blocking`; `paste-progress` events report it a few times a
//! second, `paste_pause(job, paused)` holds it and `paste_cancel(job)` stops it. An item is pasted whole or not at all, except a Replace of a folder,
//! which merges (what was merged before a Cancel stays). Files are copied with CopyFileExW, which keeps their dates
//! and attributes and can stop in the middle of a big file (Windows then removes the half-written copy).
//!
//! Keep Both names: `readme.txt` -> `readme-02.txt`, then `readme-03.txt` ... (the first free number). A copy into
//! the item's own folder is Keep Both without asking; a cut into its own folder does nothing.
//!
//! Queue: jobs that copy run one at a time, in the order they were started (two copies at once only fight over the
//! disk). A waiting job reports phase "queued" with the number of jobs `ahead`; `paste_start_now(job)` lets it run
//! beside the others. A move on one drive (only renames) never waits.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The user's answer for one clash. A source with no answer is Keep Both, so nothing is overwritten unasked.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Replace,
    Keep,
    Skip,
}

#[derive(Serialize, Debug)]
pub struct Clash {
    pub source: String,
    /// the item that is in the way: in the folder, or an earlier item of this paste (`in_paste`)
    pub target: String,
    pub name: String,
    pub source_is_dir: bool,
    pub target_is_dir: bool,
    /// files only (0 for folders)
    pub source_size: u64,
    pub target_size: u64,
    /// Unix seconds, 0 when unknown
    pub source_modified: i64,
    pub target_modified: i64,
    pub in_paste: bool,
}

#[derive(Serialize, Default, Debug)]
pub struct PasteResult {
    /// where the pasted items are now (selected afterwards)
    pub pasted: Vec<String>,
    /// (from, to) of each moved item (a basket's links follow them)
    pub moved: Vec<(String, String)>,
    pub skipped: usize,
    pub errors: Vec<String>,
    pub cancelled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Progress {
    pub job: u64,
    /// "queued" (waiting for the jobs before it), "count" (measuring what to copy), "copy", "done"
    pub phase: &'static str,
    /// queued: how many jobs run or wait before this one
    pub ahead: usize,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_items: usize,
    pub total_items: usize,
    /// the file being copied (or the item being measured)
    pub current: String,
}

/// One item to paste. `parts` = only these paths inside it (a partly linked folder of a basket); None = all of it.
pub(crate) struct Item {
    pub src: PathBuf,
    pub parts: Option<Vec<PathBuf>>,
}

const CANCELLED: &str = "cancelled";
const MAX_DEPTH: u32 = 128; // a folder link pointing back up would otherwise go on forever

pub(crate) struct Ctx<'a> {
    job: u64,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    emit: &'a dyn Fn(Progress),
    interval: Duration,
    last: Instant,
    phase: &'static str,
    total_bytes: u64,
    done_bytes: u64, // files finished
    file_bytes: u64, // of the file being copied
    done_items: usize,
    total_items: usize,
    current: String,
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(job: u64, cancel: Arc<AtomicBool>, emit: &'a dyn Fn(Progress)) -> Self {
        Ctx {
            job,
            cancel,
            pause: Arc::new(AtomicBool::new(false)),
            emit,
            interval: Duration::from_millis(100),
            last: Instant::now(),
            phase: "count",
            total_bytes: 0,
            done_bytes: 0,
            file_bytes: 0,
            done_items: 0,
            total_items: 0,
            current: String::new(),
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Hold here while the job is paused (between files, and inside CopyFileExW's progress callback, so a big file
    /// stops in the middle); a Cancel ends the wait
    fn wait_if_paused(&self) {
        while self.pause.load(Ordering::SeqCst) && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn report(&mut self, force: bool) {
        if !force && self.last.elapsed() < self.interval {
            return;
        }
        self.last = Instant::now();
        (self.emit)(Progress {
            job: self.job,
            phase: self.phase,
            done_bytes: self.done_bytes + self.file_bytes,
            total_bytes: self.total_bytes,
            done_items: self.done_items,
            total_items: self.total_items,
            current: self.current.clone(),
            ahead: 0,
        });
    }
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

pub(crate) fn unix_secs(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "readme.txt" -> ("readme", ".txt"); a folder or a name without a dot keeps its whole name
pub(crate) fn split_name(name: &str, is_dir: bool) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// Keep Both: the first free `<name>-NN<.ext>` in `dir`, from -02 on
pub(crate) fn keep_both_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let (stem, ext) = split_name(name, is_dir);
    for n in 2u64.. {
        let candidate = dir.join(format!("{}-{:02}{}", stem, n, ext));
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn volume(p: &Path) -> Option<String> {
    match p.components().next() {
        Some(Component::Prefix(px)) => Some(px.as_os_str().to_string_lossy().to_lowercase()),
        _ => None,
    }
}

/// Same drive (or share): a move there is a rename, nothing to copy
fn same_volume(a: &Path, b: &Path) -> bool {
    matches!((volume(a), volume(b)), (Some(x), Some(y)) if x == y)
}

/// The item's own folder is `dest`
fn in_folder(src: &Path, dest_canon: Option<&Path>) -> bool {
    match (src.parent().and_then(|p| fs::canonicalize(p).ok()), dest_canon) {
        (Some(parent), Some(dest)) => parent == dest,
        _ => false,
    }
}

/// The clashes the user has to decide, in the order of `paths`
pub(crate) fn clashes(paths: &[PathBuf], dest: &Path) -> Vec<Clash> {
    let dest_canon = fs::canonicalize(dest).ok();
    let mut earlier: HashMap<String, PathBuf> = HashMap::new(); // lower-case name -> first item of the paste with it
    let mut out = Vec::new();
    for src in paths {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let Ok(sm) = fs::metadata(src) else { continue }; // reported when pasting
        if in_folder(src, dest_canon.as_deref()) {
            continue; // copy = Keep Both by itself, cut = nothing to do
        }
        let key = name.to_lowercase();
        let (target, in_paste) = match earlier.get(&key) {
            Some(first) => (first.clone(), true),
            None => (dest.join(&name), false),
        };
        if let (true, Ok(tm)) = (in_paste || exists(&target), fs::metadata(&target)) {
            out.push(Clash {
                source: src.to_string_lossy().to_string(),
                target: target.to_string_lossy().to_string(),
                name: name.clone(),
                source_is_dir: sm.is_dir(),
                target_is_dir: tm.is_dir(),
                source_size: if sm.is_dir() { 0 } else { sm.len() },
                target_size: if tm.is_dir() { 0 } else { tm.len() },
                source_modified: unix_secs(&sm),
                target_modified: unix_secs(&tm),
                in_paste,
            });
        }
        earlier.entry(key).or_insert_with(|| src.clone());
    }
    out
}

/// Bytes to copy below `p`
fn measure(p: &Path, ctx: &mut Ctx, depth: u32) -> Result<u64, String> {
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }
    if depth > MAX_DEPTH {
        return Ok(0);
    }
    let Ok(m) = fs::metadata(p) else { return Ok(0) };
    if !m.is_dir() {
        return Ok(m.len());
    }
    ctx.current = p.to_string_lossy().to_string();
    ctx.report(false);
    let mut sum = 0;
    if let Ok(rd) = fs::read_dir(p) {
        for e in rd.flatten() {
            sum += measure(&e.path(), ctx, depth + 1)?;
        }
    }
    Ok(sum)
}

/// `\\?\` in front of a long path, which CopyFileExW needs past 260 characters (std::fs does this by itself)
#[cfg(windows)]
fn long(p: &Path) -> std::ffi::OsString {
    let s = p.as_os_str().to_string_lossy();
    if s.len() < 248 || s.starts_with(r"\\?\") {
        return p.as_os_str().to_owned();
    }
    match s.strip_prefix(r"\\") {
        Some(unc) => format!(r"\\?\UNC\{}", unc).into(),
        None => format!(r"\\?\{}", s).into(),
    }
}

#[cfg(windows)]
fn copy_file(src: &Path, dst: &Path, fail_if_exists: bool, ctx: &mut Ctx) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        CopyFileExW, COPYFILE_FLAGS, COPYPROGRESSROUTINE_PROGRESS, COPY_FILE_FAIL_IF_EXISTS,
        LPPROGRESS_ROUTINE_CALLBACK_REASON, PROGRESS_CANCEL, PROGRESS_CONTINUE,
    };

    unsafe extern "system" fn on_progress(
        _total: i64,
        done: i64,
        _stream_size: i64,
        _stream_done: i64,
        _stream: u32,
        _reason: LPPROGRESS_ROUTINE_CALLBACK_REASON,
        _src: HANDLE,
        _dst: HANDLE,
        data: *const c_void,
    ) -> COPYPROGRESSROUTINE_PROGRESS {
        let ctx = unsafe { &mut *(data as *mut Ctx) };
        ctx.wait_if_paused();
        if ctx.cancelled() {
            return PROGRESS_CANCEL; // Windows deletes the half-written file
        }
        ctx.file_bytes = done.max(0) as u64;
        ctx.report(false);
        PROGRESS_CONTINUE
    }

    ctx.wait_if_paused();
    ctx.current = src.to_string_lossy().to_string();
    ctx.file_bytes = 0;
    let flags = if fail_if_exists { COPY_FILE_FAIL_IF_EXISTS } else { COPYFILE_FLAGS(0) };
    let data = ctx as *mut Ctx as *const c_void;
    let result = unsafe {
        CopyFileExW(&HSTRING::from(long(src).as_os_str()), &HSTRING::from(long(dst).as_os_str()), Some(on_progress), Some(data), None, flags)
    };
    ctx.file_bytes = 0;
    match result {
        Ok(()) => {
            ctx.done_bytes += fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
            ctx.report(false);
            Ok(())
        }
        Err(_) if ctx.cancelled() => Err(CANCELLED.into()),
        Err(e) => Err(e.message().trim().to_string()),
    }
}

#[cfg(not(windows))]
fn copy_file(src: &Path, dst: &Path, fail_if_exists: bool, ctx: &mut Ctx) -> Result<(), String> {
    ctx.wait_if_paused();
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }
    if fail_if_exists && exists(dst) {
        return Err("The file exists.".into());
    }
    ctx.done_bytes += fs::copy(src, dst).map_err(|e| e.to_string())?;
    ctx.report(false);
    Ok(())
}

/// Rename over an existing file; a read-only file in the way loses that attribute first (it is being replaced)
pub(crate) fn rename_over(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Ok(m) = fs::metadata(to) {
        let mut perm = m.permissions();
        if perm.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perm.set_readonly(false);
            let _ = fs::set_permissions(to, perm);
        }
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

/// Replace the file `dst` with `src`. The copy goes to a temporary name first, so a Cancel or an error leaves the
/// old file as it was.
fn replace_file(src: &Path, dst: &Path, is_move: bool, ctx: &mut Ctx) -> Result<(), String> {
    if is_move && same_volume(src, dst) && rename_over(src, dst).is_ok() {
        return Ok(());
    }
    let name = dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = dst.with_file_name(format!("{}.boonsh-part", name));
    if let Err(e) = copy_file(src, &tmp, false, ctx) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = rename_over(&tmp, dst) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if is_move {
        fs::remove_file(src).map_err(|e| format!("copied, but the original could not be removed: {}", e))?;
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path, ctx: &mut Ctx, depth: u32) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("folders are nested too deep (a folder link pointing back?)".into());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())? {
        if ctx.cancelled() {
            return Err(CANCELLED.into());
        }
        let e = e.map_err(|e| e.to_string())?;
        let (p, t) = (e.path(), dst.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &t, ctx, depth + 1)?;
        } else {
            copy_file(&p, &t, true, ctx)?;
        }
    }
    Ok(())
}

/// Put `src` at `dst`. Nothing there: a new copy (or a rename when moving on one drive); a half-made copy is
/// removed again on an error or Cancel, and the source stays. Something there: a folder is merged into a folder,
/// a file replaces a file, and an item of the other kind goes to the Recycle Bin first.
fn place(src: &Path, dst: &Path, is_move: bool, ctx: &mut Ctx, depth: u32) -> Result<(), String> {
    ctx.wait_if_paused();
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }
    if depth > MAX_DEPTH {
        return Err("folders are nested too deep (a folder link pointing back?)".into());
    }
    let src_dir = src.is_dir();
    if exists(dst) {
        let dst_dir = dst.is_dir();
        if src_dir && dst_dir {
            for e in fs::read_dir(src).map_err(|e| e.to_string())? {
                let e = e.map_err(|e| e.to_string())?;
                place(&e.path(), &dst.join(e.file_name()), is_move, ctx, depth + 1)?;
            }
            if is_move {
                let _ = fs::remove_dir(src); // empty now, unless something could not be moved
            }
            return Ok(());
        }
        if src_dir == dst_dir {
            return replace_file(src, dst, is_move, ctx);
        }
        trash::delete(dst).map_err(|e| format!("could not move '{}' to the Recycle Bin: {}", dst.display(), e))?;
    }
    if is_move && same_volume(src, dst) {
        if fs::rename(src, dst).is_ok() {
            return Ok(());
        }
        ctx.total_bytes += measure(src, ctx, 0)?; // the rename failed: copy instead (not counted beforehand)
    }
    let copied = if src_dir { copy_tree(src, dst, ctx, depth) } else { copy_file(src, dst, true, ctx) };
    if let Err(e) = copied {
        if src_dir {
            let _ = fs::remove_dir_all(dst);
        } else {
            let _ = fs::remove_file(dst);
        }
        return Err(e);
    }
    if is_move {
        let removed = if src_dir { fs::remove_dir_all(src) } else { fs::remove_file(src) };
        removed.map_err(|e| format!("copied, but the original could not be removed: {}", e))?;
    }
    Ok(())
}

enum Outcome {
    Pasted(String),
    Skipped,
    Nothing,
}

fn paste_one(item: &Item, dest: &Path, dest_canon: Option<&Path>, is_move: bool, choice: Choice, ctx: &mut Ctx) -> Result<Outcome, String> {
    let src = &item.src;
    if !exists(src) {
        return Err("no longer exists".into());
    }
    let name = src.file_name().ok_or("invalid name")?.to_string_lossy().to_string();
    let src_canon = fs::canonicalize(src).map_err(|e| e.to_string())?;
    let src_dir = src.is_dir();
    if src_dir && dest_canon.is_some_and(|d| d.starts_with(&src_canon)) {
        return Err("cannot paste a folder into itself".into());
    }
    let mut choice = choice;
    if in_folder(src, dest_canon) {
        if is_move {
            return Ok(Outcome::Nothing);
        }
        choice = Choice::Keep;
    }
    let first = dest.join(&name);
    let (target, existed) = if !exists(&first) {
        (first, false)
    } else {
        match choice {
            Choice::Skip => return Ok(Outcome::Skipped),
            Choice::Keep => (keep_both_name(dest, &name, src_dir), false),
            Choice::Replace => {
                if fs::canonicalize(&first).is_ok_and(|t| src_canon.starts_with(&t)) {
                    return Err(format!("'{}' holds the item itself, so it cannot be replaced", first.display()));
                }
                (first, true)
            }
        }
    };
    ctx.current = src.to_string_lossy().to_string();
    match &item.parts {
        None => place(src, &target, is_move, ctx, 0)?,
        Some(parts) => {
            if existed && !target.is_dir() {
                trash::delete(&target).map_err(|e| format!("could not move '{}' to the Recycle Bin: {}", target.display(), e))?;
            }
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            for part in parts {
                let rel = part.strip_prefix(src).map_err(|e| e.to_string())?;
                let dst = target.join(rel);
                let placed = dst
                    .parent()
                    .map_or(Ok(()), |p| fs::create_dir_all(p).map_err(|e| e.to_string()))
                    .and_then(|_| place(part, &dst, is_move, ctx, 0));
                if let Err(e) = placed {
                    if !existed && !is_move {
                        let _ = fs::remove_dir_all(&target); // a copy is all or nothing (a move has moved some parts)
                    }
                    return Err(e);
                }
            }
        }
    }
    Ok(Outcome::Pasted(target.to_string_lossy().to_string()))
}

/// Paste `items` into `dest`. `choices` by source path (as given); none = Keep Both.
pub(crate) fn paste_blocking(items: Vec<Item>, dest: &Path, is_move: bool, choices: &HashMap<String, Choice>, ctx: &mut Ctx) -> PasteResult {
    let mut res = PasteResult::default();
    if !dest.is_dir() {
        res.errors.push(format!("Destination is not a folder: {}", dest.display()));
        return res;
    }
    let dest_canon = fs::canonicalize(dest).ok();
    let choice_of = |item: &Item| choices.get(item.src.to_string_lossy().as_ref()).copied().unwrap_or(Choice::Keep);
    ctx.total_items = items.len();

    // what has to be copied (a move on one drive is a rename; a skipped clash is left out)
    ctx.phase = "count";
    ctx.report(true);
    'count: for item in &items {
        if (is_move && same_volume(&item.src, dest))
            || (choice_of(item) == Choice::Skip && item.src.file_name().is_some_and(|n| exists(&dest.join(n))))
        {
            continue;
        }
        let parts = item.parts.clone().unwrap_or_else(|| vec![item.src.clone()]);
        for p in parts {
            match measure(&p, ctx, 0) {
                Ok(n) => ctx.total_bytes += n,
                Err(_) => {
                    res.cancelled = true;
                    break 'count;
                }
            }
        }
    }

    ctx.phase = "copy";
    ctx.report(true);
    if !res.cancelled {
        for item in &items {
            if ctx.cancelled() {
                res.cancelled = true;
                break;
            }
            let key = item.src.to_string_lossy().to_string();
            match paste_one(item, dest, dest_canon.as_deref(), is_move, choice_of(item), ctx) {
                Ok(Outcome::Pasted(to)) => {
                    if is_move {
                        res.moved.push((key, to.clone()));
                    }
                    res.pasted.push(to);
                }
                Ok(Outcome::Skipped) => res.skipped += 1,
                Ok(Outcome::Nothing) => {}
                Err(e) if e == CANCELLED => {
                    res.cancelled = true;
                    break;
                }
                Err(e) => res.errors.push(format!("'{}': {}", key, e)),
            }
            ctx.done_items += 1;
            ctx.report(false);
        }
    }
    ctx.phase = "done";
    ctx.current.clear();
    ctx.report(true);
    res
}

/// What the frontend can do to a running job
#[derive(Default)]
pub(crate) struct Flags {
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) pause: Arc<AtomicBool>,
    pub(crate) start_now: AtomicBool,
}

pub(crate) fn jobs() -> &'static Mutex<HashMap<u64, Arc<Flags>>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Arc<Flags>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

pub(crate) fn register_job(job: u64) -> Arc<Flags> {
    let flags = Arc::new(Flags::default());
    jobs().lock().unwrap().insert(job, flags.clone());
    flags
}

pub(crate) fn unregister_job(job: u64) {
    jobs().lock().unwrap().remove(&job);
}

/// The queued jobs in start order; the first one runs, the others wait (`wait_turn`)
struct Queue {
    order: Mutex<VecDeque<u64>>,
    turn: Condvar,
}

fn queue() -> &'static Queue {
    static QUEUE: OnceLock<Queue> = OnceLock::new();
    QUEUE.get_or_init(|| Queue { order: Mutex::new(VecDeque::new()), turn: Condvar::new() })
}

/// The job's place at the front of the queue; dropping it (the job ended, also by a panic) lets the next one start
pub(crate) struct Turn(u64);

impl Drop for Turn {
    fn drop(&mut self) {
        let q = queue();
        q.order.lock().unwrap().retain(|&j| j != self.0);
        q.turn.notify_all();
    }
}

enum Waited {
    /// first in the queue: runs until the `Turn` is dropped
    First(Turn),
    /// Start now: runs beside the others, out of the queue
    Now,
    Cancelled,
}

/// Queue `job` and wait until it is first, started now or cancelled. While it waits, a `queued` progress event
/// reports how many jobs are ahead of it each time that changes.
fn wait_turn(job: u64, flags: &Flags, emit: &dyn Fn(Progress)) -> Waited {
    let q = queue();
    let mut order = q.order.lock().unwrap();
    order.push_back(job);
    let mut told = usize::MAX;
    loop {
        let ahead = order.iter().position(|&j| j == job).unwrap_or(0);
        if ahead == 0 {
            return Waited::First(Turn(job));
        }
        let cancelled = flags.cancel.load(Ordering::SeqCst);
        if cancelled || flags.start_now.load(Ordering::SeqCst) {
            order.retain(|&j| j != job);
            q.turn.notify_all();
            return if cancelled { Waited::Cancelled } else { Waited::Now };
        }
        if ahead != told {
            told = ahead;
            emit(Progress {
                job,
                phase: "queued",
                ahead,
                done_bytes: 0,
                total_bytes: 0,
                done_items: 0,
                total_items: 0,
                current: String::new(),
            });
        }
        order = q.turn.wait_timeout(order, Duration::from_millis(200)).unwrap().0;
    }
}

/// Run a paste job off the main thread, with progress events and the flags under `job`. `queued`: wait for the
/// copies started before it (see the module notes).
pub(crate) async fn run_job<F>(app: AppHandle, job: u64, queued: bool, work: F) -> Result<PasteResult, String>
where
    F: FnOnce(&mut Ctx) -> PasteResult + Send + 'static,
{
    let flags = Arc::new(Flags::default());
    jobs().lock().unwrap().insert(job, flags.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let emit = move |p: Progress| {
            let _ = app.emit("paste-progress", p);
        };
        let _turn = match if queued { wait_turn(job, &flags, &emit) } else { Waited::Now } {
            Waited::First(turn) => Some(turn),
            Waited::Now => None,
            Waited::Cancelled => return PasteResult { cancelled: true, ..Default::default() },
        };
        let mut ctx = Ctx::new(job, flags.cancel.clone(), &emit);
        ctx.pause = flags.pause.clone();
        work(&mut ctx)
    })
    .await;
    jobs().lock().unwrap().remove(&job);
    out.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn paste_check(paths: Vec<String>, dest_dir: String) -> Result<Vec<Clash>, String> {
    if crate::lan_share::is_lan_path(&dest_dir) {
        return Ok(Vec::new());
    }
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| {
            if let Some(resolved) = crate::lan_share::resolve_lan_path_to_local(&p) {
                resolved.to_string_lossy().to_string()
            } else {
                p
            }
        })
        .collect();

    if crate::gdrive::is_gdrive_path(&dest_dir) || paths.iter().any(|p| crate::gdrive::is_gdrive_path(p)) {
        return crate::gdrive_transfer::gdrive_paste_check(paths, dest_dir).await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        clashes(&paths, Path::new(&dest_dir))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Paste (copy, or move for `mode` "cut") into `dest_dir`; `choices` answer the clashes of `paste_check`
#[tauri::command]
pub async fn paste_items(
    app: AppHandle,
    paths: Vec<String>,
    dest_dir: String,
    mode: String,
    choices: HashMap<String, Choice>,
    job: u64,
) -> Result<PasteResult, String> {
    if crate::lan_share::is_lan_path(&dest_dir) {
        let is_move = mode == "cut";
        let added = crate::lan_share::lan_share_files(app, paths, Some(is_move)).await?;
        return Ok(PasteResult {
            pasted: added.iter().map(|(_, to)| to.clone()).collect(),
            moved: if is_move { added } else { Vec::new() },
            ..Default::default()
        });
    }
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| {
            if let Some(resolved) = crate::lan_share::resolve_lan_path_to_local(&p) {
                resolved.to_string_lossy().to_string()
            } else {
                p
            }
        })
        .collect();

    if crate::gdrive::is_gdrive_path(&dest_dir) || paths.iter().any(|p| crate::gdrive::is_gdrive_path(p)) {
        return crate::gdrive_transfer::gdrive_paste_items(app, paths, dest_dir, mode, choices, job).await;
    }
    let items: Vec<Item> = paths.into_iter().map(|p| Item { src: PathBuf::from(p), parts: None }).collect();
    let only_renames = mode == "cut" && items.iter().all(|i| same_volume(&i.src, Path::new(&dest_dir)));
    run_job(app, job, !only_renames, move |ctx| paste_blocking(items, Path::new(&dest_dir), mode == "cut", &choices, ctx)).await
}

#[tauri::command]
pub fn paste_cancel(job: u64) {
    if let Some(flags) = jobs().lock().unwrap().get(&job) {
        flags.cancel.store(true, Ordering::SeqCst);
    }
}

/// Hold (`paused` true) or go on with a running job
#[tauri::command]
pub fn paste_pause(job: u64, paused: bool) {
    if let Some(flags) = jobs().lock().unwrap().get(&job) {
        flags.pause.store(paused, Ordering::SeqCst);
    }
}

/// Let a queued job run now, beside the one that is running
#[tauri::command]
pub fn paste_start_now(job: u64) {
    if let Some(flags) = jobs().lock().unwrap().get(&job) {
        flags.start_now.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("boonsh-paste-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    fn run(paths: &[&Path], dest: &Path, is_move: bool, choices: &[(&Path, Choice)]) -> PasteResult {
        let emit = |_: Progress| {};
        let mut ctx = Ctx::new(0, Arc::new(AtomicBool::new(false)), &emit);
        let items = paths.iter().map(|p| Item { src: p.to_path_buf(), parts: None }).collect();
        let choices = choices.iter().map(|(p, c)| (s(p), *c)).collect();
        paste_blocking(items, dest, is_move, &choices, &mut ctx)
    }

    #[test]
    fn keep_both_names_count_up() {
        let d = tmp("names");
        fs::write(d.join("readme.txt"), "").unwrap();
        assert_eq!(keep_both_name(&d, "readme.txt", false), d.join("readme-02.txt"));
        fs::write(d.join("readme-02.txt"), "").unwrap();
        assert_eq!(keep_both_name(&d, "readme.txt", false), d.join("readme-03.txt"));
        assert_eq!(keep_both_name(&d, "archive.tar.gz", false), d.join("archive.tar-02.gz"));
        assert_eq!(keep_both_name(&d, ".gitignore", false), d.join(".gitignore-02"));
        assert_eq!(keep_both_name(&d, "Photos.2024", true), d.join("Photos.2024-02"), "a folder keeps its dots");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn clashes_lists_names_taken_in_the_folder_or_the_paste() {
        let d = tmp("clash");
        let (a, b, out) = (d.join("a"), d.join("b"), d.join("out"));
        for f in [&a, &b, &out] {
            fs::create_dir_all(f).unwrap();
        }
        fs::write(a.join("readme.txt"), "new").unwrap();
        fs::write(b.join("README.txt"), "other").unwrap();
        fs::write(a.join("free.txt"), "").unwrap();
        fs::write(out.join("readme.txt"), "old!").unwrap();
        let c = clashes(&[a.join("readme.txt"), a.join("free.txt"), b.join("README.txt")], &out);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].target_size, c[0].source_size, c[0].in_paste), (4, 3, false));
        assert!(c[1].in_paste && c[1].target == s(&a.join("readme.txt")), "the second readme clashes with the first");
        assert!(clashes(&[out.join("readme.txt")], &out).is_empty(), "its own folder is not a clash");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_keep_both_and_skip() {
        let d = tmp("choices");
        let (src, out) = (d.join("src"), d.join("out"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&out).unwrap();
        for n in ["r.txt", "k.txt", "s.txt"] {
            fs::write(src.join(n), "new").unwrap();
            fs::write(out.join(n), "old").unwrap();
        }
        let res = run(
            &[&src.join("r.txt"), &src.join("k.txt"), &src.join("s.txt")],
            &out,
            false,
            &[(&src.join("r.txt"), Choice::Replace), (&src.join("k.txt"), Choice::Keep), (&src.join("s.txt"), Choice::Skip)],
        );
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(out.join("r.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(out.join("k.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(out.join("k-02.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(out.join("s.txt")).unwrap(), "old");
        assert_eq!(res.skipped, 1);
        assert_eq!(res.pasted, vec![s(&out.join("r.txt")), s(&out.join("k-02.txt"))]);
        assert!(!out.join("r.txt.boonsh-part").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn no_choice_means_keep_both_and_own_folder_copies_aside() {
        let d = tmp("default");
        fs::write(d.join("readme.txt"), "x").unwrap();
        let res = run(&[&d.join("readme.txt")], &d, false, &[]);
        assert_eq!(res.pasted, vec![s(&d.join("readme-02.txt"))]);
        let res = run(&[&d.join("readme.txt")], &d, true, &[(&d.join("readme.txt"), Choice::Replace)]);
        assert!(res.pasted.is_empty() && res.errors.is_empty(), "a cut into its own folder does nothing");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_merges_folders() {
        let d = tmp("merge");
        let (src, out) = (d.join("src\\F"), d.join("out"));
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(out.join("F\\sub")).unwrap();
        fs::write(src.join("same.txt"), "new").unwrap();
        fs::write(src.join("sub\\added.txt"), "added").unwrap();
        fs::write(out.join("F\\same.txt"), "old").unwrap();
        fs::write(out.join("F\\only-old.txt"), "kept").unwrap();
        let res = run(&[&src], &out, true, &[(&src, Choice::Replace)]);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(out.join("F\\same.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(out.join("F\\only-old.txt")).unwrap(), "kept");
        assert_eq!(fs::read_to_string(out.join("F\\sub\\added.txt")).unwrap(), "added");
        assert!(!src.exists(), "the moved folder is gone from its old place");
        assert_eq!(res.moved, vec![(s(&src), s(&out.join("F")))]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn replace_a_read_only_file_and_move_over_one() {
        let d = tmp("readonly");
        let (src, out) = (d.join("src"), d.join("out"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(src.join("a.txt"), "new").unwrap();
        fs::write(out.join("a.txt"), "old").unwrap();
        let mut perm = fs::metadata(out.join("a.txt")).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(out.join("a.txt"), perm).unwrap();
        let res = run(&[&src.join("a.txt")], &out, true, &[(&src.join("a.txt"), Choice::Replace)]);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(out.join("a.txt")).unwrap(), "new");
        assert!(!src.join("a.txt").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn folder_into_itself_is_refused() {
        let d = tmp("itself");
        fs::create_dir_all(d.join("F\\inner")).unwrap();
        let res = run(&[&d.join("F")], &d.join("F\\inner"), false, &[]);
        assert_eq!(res.errors.len(), 1);
        assert!(res.errors[0].contains("into itself"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cancel_stops_a_big_copy_and_leaves_no_half_file() {
        let d = tmp("cancel");
        let (src, out) = (d.join("src"), d.join("out"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(src.join("big.bin"), vec![7u8; 24 * 1024 * 1024]).unwrap();
        fs::write(src.join("next.txt"), "n").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let seen = std::cell::Cell::new(false);
        // cancel as soon as the first bytes of the big file are reported
        let emit = |p: Progress| {
            if p.phase == "count" {
                assert!(p.total_items == 2 || p.total_items == 0);
            }
            if p.phase == "copy" && p.done_bytes > 0 {
                seen.set(true);
                flag.store(true, Ordering::SeqCst);
            }
        };
        let mut ctx = Ctx::new(1, cancel, &emit);
        ctx.interval = Duration::ZERO;
        let items = vec![
            Item { src: src.join("big.bin"), parts: None },
            Item { src: src.join("next.txt"), parts: None },
        ];
        let res = paste_blocking(items, &out, false, &HashMap::new(), &mut ctx);
        assert!(seen.get(), "progress was reported during the copy");
        assert!(res.cancelled);
        assert!(res.pasted.is_empty());
        assert!(!out.join("big.bin").exists(), "the half-written copy is removed");
        assert!(!out.join("next.txt").exists(), "nothing after the cancel is pasted");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn pause_holds_the_copy_until_resumed() {
        let d = tmp("pause");
        let (src, out) = (d.join("src"), d.join("out"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        let pause = Arc::new(AtomicBool::new(true));
        let held = pause.clone();
        let (from, to) = (src.join("a.txt"), out.clone());
        let worker = std::thread::spawn(move || {
            let emit = |_: Progress| {};
            let mut ctx = Ctx::new(1, Arc::new(AtomicBool::new(false)), &emit);
            ctx.pause = held;
            paste_blocking(vec![Item { src: from, parts: None }], &to, false, &HashMap::new(), &mut ctx)
        });
        std::thread::sleep(Duration::from_millis(400));
        assert!(!out.join("a.txt").exists(), "nothing is copied while paused");
        pause.store(false, Ordering::SeqCst);
        let res = worker.join().unwrap();
        assert_eq!(res.pasted.len(), 1);
        assert!(out.join("a.txt").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn queued_jobs_wait_for_the_first_or_start_now() {
        let none = |_: Progress| {};
        let first = Flags::default();
        let Waited::First(turn) = wait_turn(901, &first, &none) else { panic!("an empty queue runs at once") };
        // a second job waits until the first ends
        let (tx, rx) = std::sync::mpsc::channel();
        let second = std::thread::spawn(move || {
            let aheads = Mutex::new(Vec::new());
            let emit = |p: Progress| aheads.lock().unwrap().push(p.ahead);
            let got = matches!(wait_turn(902, &Flags::default(), &emit), Waited::First(_));
            tx.send(()).unwrap();
            (got, aheads.into_inner().unwrap())
        });
        // a third one is told to start now and does not wait
        let third = Flags::default();
        third.start_now.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert!(matches!(wait_turn(903, &third, &none), Waited::Now));
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "the second job still waits");
        drop(turn);
        rx.recv_timeout(Duration::from_secs(2)).expect("the second job starts when the first ends");
        let (got, aheads) = second.join().unwrap();
        assert!(got);
        assert_eq!(aheads, vec![1], "it was told it had one job ahead");
        // a cancelled waiter leaves the queue
        let Waited::First(turn) = wait_turn(904, &Flags::default(), &none) else { panic!() };
        let gone = Flags::default();
        gone.cancel.store(true, Ordering::SeqCst);
        assert!(matches!(wait_turn(905, &gone, &none), Waited::Cancelled));
        drop(turn);
        assert!(queue().order.lock().unwrap().is_empty());
    }

    #[test]
    fn progress_counts_the_bytes() {
        let d = tmp("progress");
        let (src, out) = (d.join("src"), d.join("out"));
        fs::create_dir_all(src.join("F")).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(src.join("F\\a.bin"), vec![1u8; 1000]).unwrap();
        fs::write(src.join("b.bin"), vec![1u8; 500]).unwrap();
        let last = std::cell::RefCell::new(None::<Progress>);
        let emit = |p: Progress| *last.borrow_mut() = Some(p);
        let mut ctx = Ctx::new(5, Arc::new(AtomicBool::new(false)), &emit);
        let items = vec![Item { src: src.join("F"), parts: None }, Item { src: src.join("b.bin"), parts: None }];
        let res = paste_blocking(items, &out, false, &HashMap::new(), &mut ctx);
        assert_eq!(res.pasted.len(), 2);
        let p = last.borrow().clone().unwrap();
        assert_eq!((p.job, p.phase, p.total_bytes, p.done_bytes, p.done_items, p.total_items), (5, "done", 1500, 1500, 2, 2));
        let _ = fs::remove_dir_all(&d);
    }
}
