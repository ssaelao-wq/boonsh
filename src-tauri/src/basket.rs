// Baskets: a `<name>.basket` file in a real folder that holds links (full paths) to files and folders anywhere.
// boonsh shows it like a folder. Nothing is ever repaired or linked by guessing: an item that is no longer at its
// linked path is "gone", and an item that appeared in a linked folder after it was linked is "new"; both wait
// for the user (Clear / Relink / Link). Actions and command lines only ever use linked items that exist.
//
// A linked folder remembers what was inside it, at any depth, when it was linked (`snapshot`, paths relative to
// the folder, folders ending in `\`). Items the user removed or cleared inside it are listed in `cleared`, which
// hides them and everything below them.
//
// The same engine serves the app (tauri commands below) and the command line (`boonsh.exe --basket`, called by
// the PowerShell functions that pty.rs defines in every tab).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use crate::fs_ops::{self, FileItem};
use crate::search;

pub const EXT: &str = "basket";
const FORMAT: &str = "boonsh-basket";
/// A folder with more items than this is not linked as a whole (the snapshot would get too big).
const MAX_SNAPSHOT: usize = 20_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct BasketFile {
    #[serde(default)]
    format: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    items: Vec<Link>,
}

impl BasketFile {
    fn new() -> Self {
        BasketFile { format: FORMAT.to_string(), version: 1, items: Vec::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Link {
    path: String,
    kind: String, // "file" | "folder"
    #[serde(default)]
    added: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    snapshot: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    cleared: Vec<String>,
}

// ---------- paths ----------

fn lower(s: &str) -> String {
    s.to_lowercase().replace('/', "\\")
}

/// A path without a trailing backslash, except a drive root ("D:\").
fn tidy(p: &str) -> String {
    let t = p.replace('/', "\\");
    let trimmed = t.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{}\\", trimmed)
    } else {
        trimmed.to_string()
    }
}

fn same(a: &str, b: &str) -> bool {
    lower(&tidy(a)) == lower(&tidy(b))
}

/// `p` relative to `base` when it is inside it ("" never: equal paths are not "inside").
fn rel_inside(base: &str, p: &str) -> Option<String> {
    let b = lower(&tidy(base));
    let b = b.trim_end_matches('\\');
    let pl = lower(&tidy(p));
    let tail = pl.strip_prefix(b)?.strip_prefix('\\')?;
    if tail.is_empty() {
        return None;
    }
    // keep the real letter case of the tail
    let t = tidy(p);
    Some(t[t.len() - tail.len()..].to_string())
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{}\\{}", rel, name)
    }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A basket named by the user: a full path, or a name in `cwd`; ".basket" is added when missing.
pub fn resolve(cwd: &str, name: &str) -> PathBuf {
    let name = name.trim().trim_matches('"').trim_matches('\'');
    let p = Path::new(name);
    let full = if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) };
    let s = fs_ops::normalize_path(&full).to_string_lossy().to_string();
    let path = if lower(&s).ends_with(&format!(".{}", EXT)) { PathBuf::from(s) } else { PathBuf::from(format!("{}.{}", s, EXT)) };
    real_case(path)
}

/// The name as it is on disk: "tax 2026" finds "Tax 2026.basket", and saving must not rename the file.
fn real_case(path: PathBuf) -> PathBuf {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return path };
    let want = name.to_string_lossy().to_lowercase();
    fs::read_dir(dir)
        .ok()
        .and_then(|r| r.flatten().find(|e| e.file_name().to_string_lossy().to_lowercase() == want))
        .map(|e| dir.join(e.file_name()))
        .unwrap_or(path)
}

fn is_basket_file(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(EXT)) && !p.is_dir()
}

// ---------- the file ----------

fn load(path: &Path) -> Result<BasketFile, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("Cannot read the basket {}: {}", path.display(), e))?;
    if text.trim().is_empty() {
        return Ok(BasketFile::new());
    }
    let b: BasketFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{} is not a basket file: {}", path.display(), e))?;
    if !b.format.is_empty() && b.format != FORMAT {
        return Err(format!("{} is not a boonsh basket", path.display()));
    }
    Ok(b)
}

/// Written next to the basket, then renamed over it, so a crash never leaves half a basket.
fn save(path: &Path, b: &BasketFile) -> Result<(), String> {
    let mut b = b.clone();
    b.format = FORMAT.to_string();
    b.version = 1;
    let text = serde_json::to_string_pretty(&b).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", EXT));
    fs::write(&tmp, text).map_err(|e| format!("Cannot save the basket {}: {}", path.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot save the basket {}: {}", path.display(), e)
    })
}

/// How many links a basket holds (the Size column); None when it is not a readable basket.
pub fn link_count(path: &Path) -> Option<u32> {
    load(path).ok().map(|b| b.items.len() as u32)
}

// ---------- what is inside a linked folder ----------

/// Fast lookups over a folder link's snapshot and cleared lists (lowercase).
struct Index {
    snap: HashSet<String>,                  // "a\b.txt", "a\" for folders
    children: HashMap<String, Vec<(String, bool)>>, // parent rel (lowercase, "" = top) -> (real name, is folder)
    cleared: Vec<String>,                   // without a trailing backslash
}

impl Index {
    fn of(link: &Link) -> Index {
        let mut snap = HashSet::new();
        let mut children: HashMap<String, Vec<(String, bool)>> = HashMap::new();
        for s in &link.snapshot {
            snap.insert(lower(s));
            let is_dir = s.ends_with('\\');
            let t = s.trim_end_matches('\\');
            let (parent, name) = match t.rfind('\\') {
                Some(k) => (lower(&t[..k]), t[k + 1..].to_string()),
                None => (String::new(), t.to_string()),
            };
            children.entry(parent).or_default().push((name, is_dir));
        }
        let cleared = link.cleared.iter().map(|c| lower(c.trim_end_matches('\\'))).collect();
        Index { snap, children, cleared }
    }

    fn is_cleared(&self, rel: &str) -> bool {
        let r = lower(rel);
        self.cleared.iter().any(|c| r == *c || r.starts_with(&format!("{}\\", c)))
    }

    /// Strictly above `rel` (not `rel` itself) something was cleared.
    fn ancestor_cleared(&self, rel: &str) -> bool {
        let r = lower(rel);
        self.cleared.iter().any(|c| r.starts_with(&format!("{}\\", c)))
    }

    fn in_snapshot(&self, rel: &str, is_dir: bool) -> bool {
        let r = lower(rel);
        self.snap.contains(&if is_dir { format!("{}\\", r) } else { r })
    }

    fn linked(&self, rel: &str, is_dir: bool) -> bool {
        !self.is_cleared(rel) && self.in_snapshot(rel, is_dir)
    }
}

/// Everything inside `dir` (any depth), relative, folders ending in `\`. Basket files are left out.
fn snapshot_of(dir: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).min_depth(1).follow_links(false).sort_by_file_name() {
        let Ok(entry) = entry else { continue };
        if is_basket_file(entry.path()) {
            continue;
        }
        let rel = entry.path().strip_prefix(dir).map_err(|e| e.to_string())?.to_string_lossy().to_string();
        out.push(if entry.file_type().is_dir() { format!("{}\\", rel) } else { rel });
        if out.len() > MAX_SNAPSHOT {
            return Err(format!(
                "{} holds more than {} items. Link smaller folders inside it instead.",
                dir.display(),
                MAX_SNAPSHOT
            ));
        }
    }
    Ok(out)
}

fn sorted_entries(dir: &Path) -> Vec<fs::DirEntry> {
    let mut v: Vec<fs::DirEntry> = fs::read_dir(dir).map(|r| r.flatten().collect()).unwrap_or_default();
    v.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    v
}

/// The linked parts of the folder `dir` (relative `rel` in its link): whole sub-folders where nothing differs,
/// single items elsewhere. Returns true when the folder is "clean" (exactly as linked, nothing new, gone or
/// cleared): then the caller can use the folder itself.
fn cover(dir: &Path, rel: &str, ix: &Index, parts: &mut Vec<PathBuf>) -> bool {
    let mut clean = true;
    let mut present = HashSet::new();
    for e in sorted_entries(dir) {
        let name = e.file_name().to_string_lossy().to_string();
        present.insert(name.to_lowercase());
        let crel = join_rel(rel, &name);
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !ix.linked(&crel, is_dir) {
            clean = false;
            continue;
        }
        if is_dir {
            let mut sub = Vec::new();
            if cover(&e.path(), &crel, ix, &mut sub) {
                parts.push(e.path());
            } else {
                clean = false;
                parts.extend(sub);
            }
        } else {
            parts.push(e.path());
        }
    }
    if let Some(kids) = ix.children.get(&lower(rel)) {
        for (name, _) in kids {
            if !present.contains(&name.to_lowercase()) && !ix.is_cleared(&join_rel(rel, name)) {
                clean = false; // linked, but gone
            }
        }
    }
    clean
}

// ---------- reading a basket ----------

struct Opened {
    path: PathBuf,
    file: BasketFile,
}

impl Opened {
    fn open(path: &Path) -> Result<Opened, String> {
        Ok(Opened { path: path.to_path_buf(), file: load(path)? })
    }

    fn save(&self) -> Result<(), String> {
        save(&self.path, &self.file)
    }

    fn top(&self, p: &str) -> Option<usize> {
        self.file.items.iter().position(|l| same(&l.path, p))
    }

    /// The folder link that `p` lies inside, and `p` relative to it.
    fn inside(&self, p: &str) -> Option<(usize, String)> {
        self.file
            .items
            .iter()
            .enumerate()
            .filter(|(_, l)| l.kind == "folder")
            .find_map(|(i, l)| rel_inside(&l.path, p).map(|r| (i, r)))
    }

    /// Is `p` a linked item (it need not exist)?
    fn is_linked(&self, p: &str, is_dir: bool) -> bool {
        if self.top(p).is_some() {
            return true;
        }
        match self.inside(p) {
            Some((i, rel)) => Index::of(&self.file.items[i]).linked(&rel, is_dir),
            None => false,
        }
    }

    /// The real items an action on the linked item `p` may touch, with the folder their names are relative to
    /// (so a partly linked folder keeps its name and structure). Empty when `p` is not linked or does not exist.
    fn parts_of(&self, p: &str) -> Vec<(PathBuf, PathBuf)> {
        let path = PathBuf::from(tidy(p));
        let Ok(meta) = fs::metadata(&path) else { return Vec::new() };
        let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let (link_i, rel) = if let Some(i) = self.top(p) {
            (i, String::new())
        } else if let Some((i, rel)) = self.inside(p) {
            if !Index::of(&self.file.items[i]).linked(&rel, meta.is_dir()) {
                return Vec::new();
            }
            (i, rel)
        } else {
            return Vec::new();
        };
        let link = &self.file.items[link_i];
        if !meta.is_dir() || link.kind != "folder" {
            return vec![(path, base)];
        }
        let mut parts = Vec::new();
        if cover(&path, &rel, &Index::of(link), &mut parts) {
            vec![(path, base)]
        } else {
            parts.into_iter().map(|x| (x, base.clone())).collect()
        }
    }

    /// Link `p` (absolute, existing). Returns false when it was already linked.
    fn add_one(&mut self, p: &str) -> Result<bool, String> {
        let path = PathBuf::from(tidy(p));
        let meta = fs::metadata(&path).map_err(|_| format!("Not found: {}", path.display()))?;
        if is_basket_file(&path) {
            return Err(format!("A basket cannot hold a basket: {}", path.display()));
        }
        if self.top(p).is_some() {
            return Ok(false);
        }
        let is_dir = meta.is_dir();
        if let Some((i, rel)) = self.inside(p) {
            let ix = Index::of(&self.file.items[i]);
            if ix.linked(&rel, is_dir) {
                return Ok(false);
            }
            if !ix.ancestor_cleared(&rel) {
                // a "new" (or cleared) item inside a linked folder: link it there, with the folders above it
                let link = &mut self.file.items[i];
                let me = lower(&rel);
                link.cleared.retain(|c| {
                    let c = lower(c.trim_end_matches('\\'));
                    c != me && !c.starts_with(&format!("{}\\", me))
                });
                let mut add: Vec<String> = Vec::new();
                let parts: Vec<&str> = rel.split('\\').collect();
                for k in 1..parts.len() {
                    add.push(format!("{}\\", parts[..k].join("\\")));
                }
                if is_dir {
                    add.push(format!("{}\\", rel));
                    for s in snapshot_of(&path)? {
                        add.push(join_rel(&rel, &s));
                    }
                } else {
                    add.push(rel.clone());
                }
                let have: HashSet<String> = link.snapshot.iter().map(|s| lower(s)).collect();
                for a in add {
                    if !have.contains(&lower(&a)) {
                        link.snapshot.push(a);
                    }
                }
                return Ok(true);
            }
        }
        // a new link at the top of the basket; links inside a new folder link are taken into it
        let snapshot = if is_dir { snapshot_of(&path)? } else { Vec::new() };
        let tp = tidy(p);
        if is_dir {
            self.file.items.retain(|l| rel_inside(&tp, &l.path).is_none());
        }
        self.file.items.push(Link {
            path: tp,
            kind: if is_dir { "folder" } else { "file" }.to_string(),
            added: now(),
            snapshot,
            cleared: Vec::new(),
        });
        Ok(true)
    }

    /// Remove the link of `p`: a top link goes, an item inside a linked folder is cleared (hidden from then on).
    fn remove_one(&mut self, p: &str) -> bool {
        if let Some(i) = self.top(p) {
            self.file.items.remove(i);
            return true;
        }
        if let Some((i, rel)) = self.inside(p) {
            let ix = Index::of(&self.file.items[i]);
            if ix.is_cleared(&rel) {
                return false;
            }
            self.file.items[i].cleared.push(rel);
            return true;
        }
        false
    }

    /// `from` was renamed or moved to `to` from inside this basket: the link follows it.
    fn moved(&mut self, from: &str, to: &str) -> Result<(), String> {
        if let Some(i) = self.top(from) {
            let is_dir = Path::new(to).is_dir();
            let link = &mut self.file.items[i];
            link.path = tidy(to);
            link.kind = if is_dir { "folder" } else { "file" }.to_string();
            if !is_dir {
                link.snapshot.clear();
                link.cleared.clear();
            }
            return Ok(());
        }
        let Some((i, rel_from)) = self.inside(from) else { return Ok(()) };
        let link_path = self.file.items[i].path.clone();
        let from_l = lower(&rel_from);
        let under = |s: &str| {
            let t = lower(s.trim_end_matches('\\'));
            t == from_l || t.starts_with(&format!("{}\\", from_l))
        };
        match rel_inside(&link_path, to) {
            Some(rel_to) => {
                // renamed (or moved) within the same linked folder: rename the entries
                let link = &mut self.file.items[i];
                let swap = |s: &String| -> String {
                    if under(s) {
                        format!("{}{}", rel_to, &s[rel_from.len()..])
                    } else {
                        s.clone()
                    }
                };
                link.snapshot = link.snapshot.iter().map(swap).collect();
                link.cleared = link.cleared.iter().map(swap).collect();
                Ok(())
            }
            None => {
                // moved out of the linked folder: it becomes a link of its own
                let link = &mut self.file.items[i];
                link.snapshot.retain(|s| !under(s));
                link.cleared.retain(|s| !under(s));
                self.add_one(to).map(|_| ())
            }
        }
    }
}

// ---------- the basket view ----------

#[derive(Serialize)]
pub struct BasketView {
    items: Vec<FileItem>,
    links: usize,
    gone: usize,
    new: usize,
}

fn item_for(path: &Path, is_dir_hint: bool, state: Option<&str>) -> FileItem {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let secs = |t: std::io::Result<std::time::SystemTime>| {
        t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
    };
    match fs::metadata(path) {
        Ok(m) if state != Some("gone") => {
            let is_dir = m.is_dir();
            let size = if is_dir { 0 } else { m.len() };
            let modified_timestamp = secs(m.modified());
            let created_timestamp = secs(m.created());
            FileItem {
                is_hidden: name.starts_with('.'),
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                size,
                size_formatted: fs_ops::format_size(size, is_dir),
                modified: fs_ops::format_time(modified_timestamp),
                modified_timestamp,
                created: fs_ops::format_time(created_timestamp),
                created_timestamp,
                ext,
                links: None,
                state: state.map(str::to_string),
            }
        }
        _ => FileItem {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: is_dir_hint,
            size: 0,
            size_formatted: String::new(),
            modified: String::new(),
            modified_timestamp: 0,
            created: String::new(),
            created_timestamp: 0,
            ext,
            is_hidden: false,
            links: None,
            state: Some("gone".to_string()),
        },
    }
}

fn view(basket: &Path, folder: Option<&str>) -> Result<BasketView, String> {
    let b = Opened::open(basket)?;
    let mut items = Vec::new();
    match folder.filter(|f| !f.is_empty()) {
        None => {
            for l in &b.file.items {
                let p = PathBuf::from(&l.path);
                let state = if p.exists() { None } else { Some("gone") };
                items.push(item_for(&p, l.kind == "folder", state));
            }
        }
        Some(folder) => {
            let (i, rel) = match b.top(folder) {
                Some(i) => (i, String::new()),
                None => b.inside(folder).ok_or_else(|| format!("{} is not in this basket", folder))?,
            };
            let link = &b.file.items[i];
            let ix = Index::of(link);
            if !rel.is_empty() && !ix.linked(&rel, true) {
                return Err(format!("{} is not linked in this basket", folder));
            }
            let dir = PathBuf::from(tidy(folder));
            let mut present = HashSet::new();
            for e in sorted_entries(&dir) {
                let name = e.file_name().to_string_lossy().to_string();
                present.insert(name.to_lowercase());
                let crel = join_rel(&rel, &name);
                if ix.is_cleared(&crel) || is_basket_file(&e.path()) {
                    continue;
                }
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let state = if ix.in_snapshot(&crel, is_dir) { None } else { Some("new") };
                items.push(item_for(&e.path(), is_dir, state));
            }
            if let Some(kids) = ix.children.get(&lower(&rel)) {
                for (name, is_dir) in kids {
                    if !present.contains(&name.to_lowercase()) && !ix.is_cleared(&join_rel(&rel, name)) {
                        items.push(item_for(&dir.join(name), *is_dir, Some("gone")));
                    }
                }
            }
        }
    }
    let count = |s: &str| items.iter().filter(|i| i.state.as_deref() == Some(s)).count();
    let (gone, new) = (count("gone"), count("new"));
    Ok(BasketView { links: items.len() - gone - new, gone, new, items })
}

pub(crate) fn expand(basket: &Path) -> Result<Vec<String>, String> {
    let b = Opened::open(basket)?;
    let mut out = Vec::new();
    for l in &b.file.items {
        for (part, _) in b.parts_of(&l.path) {
            out.push(part.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

/// Some of a basket's items, named like a path inside it: `testfile.txt`, `Reports\q1.txt` (inside a linked
/// folder), `*.pdf` (wildcards `*` `?` in any part). The first part is matched against the names of the links at
/// the top of the basket, the rest against what is linked inside a linked folder; names ignore case. Every match
/// is used (two links with the same name from different folders give both). Only linked items that exist are
/// found; a matched partly linked folder gives its linked parts. Nothing found is an error.
pub(crate) fn select(basket: &Path, sub: &str) -> Result<Vec<String>, String> {
    let b = Opened::open(basket)?;
    let parts: Vec<&str> = sub.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    let Some((first, rest)) = parts.split_first() else { return expand(basket) };
    let fits = |pattern: &str, name: &str| {
        if pattern.contains(['*', '?']) {
            wildcard(pattern, name)
        } else {
            pattern.eq_ignore_ascii_case(name) || pattern.to_lowercase() == name.to_lowercase()
        }
    };
    let mut found: Vec<PathBuf> = Vec::new();
    for link in &b.file.items {
        let lp = PathBuf::from(&link.path);
        let name = lp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| link.path.clone());
        if !fits(first, &name) {
            continue;
        }
        if rest.is_empty() {
            found.push(lp);
            continue;
        }
        if link.kind != "folder" {
            continue;
        }
        // walk down the linked folder, keeping only linked items
        let ix = Index::of(link);
        let mut level: Vec<(PathBuf, String)> = vec![(lp, String::new())];
        for (k, part) in rest.iter().enumerate() {
            let last = k == rest.len() - 1;
            let mut next = Vec::new();
            for (dir, rel) in &level {
                for e in sorted_entries(dir) {
                    let n = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let crel = join_rel(rel, &n);
                    if fits(part, &n) && ix.linked(&crel, is_dir) && (last || is_dir) {
                        next.push((e.path(), crel));
                    }
                }
            }
            level = next;
        }
        found.extend(level.into_iter().map(|(p, _)| p));
    }
    let mut out = Vec::new();
    for p in found {
        for (part, _) in b.parts_of(&p.to_string_lossy()) {
            let s = part.to_string_lossy().to_string();
            if !out.iter().any(|o: &String| o.eq_ignore_ascii_case(&s)) {
                out.push(s);
            }
        }
    }
    if out.is_empty() {
        let bname = basket.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        return Err(format!("Nothing named \"{}\" is linked in the basket {} (or it is gone).", sub, bname));
    }
    Ok(out)
}

#[derive(Serialize, Debug)]
pub struct AddResult {
    added: usize,
    already: usize,
    refused: Vec<String>,
}

fn add(basket: &Path, paths: &[String]) -> Result<AddResult, String> {
    let mut b = Opened::open(basket)?;
    let mut r = AddResult { added: 0, already: 0, refused: Vec::new() };
    for p in paths {
        if same(p, &basket.to_string_lossy()) {
            r.refused.push(format!("A basket cannot hold itself: {}", p));
            continue;
        }
        match b.add_one(p) {
            Ok(true) => r.added += 1,
            Ok(false) => r.already += 1,
            Err(e) => r.refused.push(e),
        }
    }
    if r.added > 0 {
        b.save()?;
    }
    Ok(r)
}

fn remove(basket: &Path, paths: &[String]) -> Result<usize, String> {
    let mut b = Opened::open(basket)?;
    let n = paths.iter().filter(|p| b.remove_one(p)).count();
    if n > 0 {
        b.save()?;
    }
    Ok(n)
}

fn relink(basket: &Path, old_path: &str, new_path: &str) -> Result<(), String> {
    let mut b = Opened::open(basket)?;
    let i = b.top(old_path).ok_or("Only an item at the top of the basket can be relinked.")?;
    let target = PathBuf::from(tidy(new_path));
    let meta = fs::metadata(&target).map_err(|_| format!("Not found: {}", target.display()))?;
    if is_basket_file(&target) {
        return Err("A basket cannot hold a basket.".to_string());
    }
    if b.file.items.iter().enumerate().any(|(k, l)| k != i && same(&l.path, new_path)) {
        return Err(format!("{} is already in the basket.", target.display()));
    }
    let snapshot = if meta.is_dir() && b.file.items[i].kind != "folder" { Some(snapshot_of(&target)?) } else { None };
    let link = &mut b.file.items[i];
    link.path = tidy(new_path);
    if meta.is_dir() {
        if let Some(s) = snapshot {
            link.snapshot = s; // a file link became a folder link
            link.cleared.clear();
        }
        link.kind = "folder".to_string();
    } else {
        link.kind = "file".to_string();
        link.snapshot.clear();
        link.cleared.clear();
    }
    b.save()
}

fn update_paths(basket: &Path, pairs: &[(String, String)]) -> Result<(), String> {
    let mut b = Opened::open(basket)?;
    for (from, to) in pairs {
        b.moved(from, to)?;
    }
    b.save()
}

fn paste_out(basket: &Path, paths: &[String], dest_dir: &str, is_move: bool) -> Result<Vec<String>, String> {
    let b = Opened::open(basket)?;
    let dest = PathBuf::from(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination is not a folder: {}", dest_dir));
    }
    let mut pasted = Vec::new();
    let mut moves = Vec::new();
    let mut errors = Vec::new();
    for p in paths {
        let parts = b.parts_of(p);
        let item = PathBuf::from(tidy(p));
        if parts.is_empty() {
            errors.push(format!("'{}': not linked or not found", p));
            continue;
        }
        if parts.len() == 1 && parts[0].0 == item {
            // the whole item: the normal copy / move
            match fs_ops::paste_items_blocking(vec![p.clone()], dest_dir.to_string(), is_move) {
                Ok(mut v) => {
                    if let Some(t) = v.first() {
                        if is_move {
                            moves.push((p.clone(), t.clone()));
                        }
                    }
                    pasted.append(&mut v);
                }
                Err(e) => errors.push(e),
            }
            continue;
        }
        // a partly linked folder: only its linked items, in the same places under a folder of the same name
        let name = item.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let target = fs_ops::unique_target(&dest, &name, !is_move);
        let result = (|| -> Result<(), String> {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            for (part, _) in &parts {
                let rel = part.strip_prefix(&item).map_err(|e| e.to_string())?;
                let dst = target.join(rel);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                if is_move {
                    if fs::rename(part, &dst).is_err() {
                        fs_ops::copy_recursive(part, &dst).map_err(|e| e.to_string())?;
                        if part.is_dir() {
                            fs::remove_dir_all(part).map_err(|e| e.to_string())?;
                        } else {
                            fs::remove_file(part).map_err(|e| e.to_string())?;
                        }
                    }
                } else {
                    fs_ops::copy_recursive(part, &dst).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                let t = target.to_string_lossy().to_string();
                if is_move {
                    moves.push((p.clone(), t.clone()));
                }
                pasted.push(t);
            }
            Err(e) => errors.push(format!("'{}': {}", p, e)),
        }
    }
    if !moves.is_empty() {
        update_paths(basket, &moves)?;
    }
    if errors.is_empty() {
        Ok(pasted)
    } else {
        Err(format!("Some items could not be pasted:\n{}", errors.join("\n")))
    }
}

fn zip(basket: &Path, paths: &[String], dest_dir: &str) -> Result<String, String> {
    let b = Opened::open(basket)?;
    let roots: Vec<(PathBuf, PathBuf)> = paths.iter().flat_map(|p| b.parts_of(p)).collect();
    if roots.is_empty() {
        return Err("Nothing linked to compress.".to_string());
    }
    let stem = basket.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Basket".into());
    let zip_path = fs_ops::unique_target(Path::new(dest_dir), &format!("{}.zip", stem), false);
    let result = fs_ops::write_zip_roots(&roots, &zip_path);
    if result.is_err() {
        let _ = fs::remove_file(&zip_path);
    }
    result.map(|_| zip_path.to_string_lossy().to_string())
}

fn delete_files(basket: &Path, paths: &[String]) -> Result<(), String> {
    let b = Opened::open(basket)?;
    for p in paths {
        for (part, _) in b.parts_of(p) {
            trash::delete(&part).map_err(|e| format!("Failed to move '{}' to the Recycle Bin: {}", part.display(), e))?;
        }
    }
    remove(basket, paths).map(|_| ())
}

fn search_in(basket: &Path, folder: Option<&str>, query: &str, include_subfolders: bool) -> Result<Vec<FileItem>, String> {
    let parsed = search::parse(query)?;
    let b = Opened::open(basket)?;
    let roots: Vec<PathBuf> = view(basket, folder)?
        .items
        .into_iter()
        .filter(|i| i.state.is_none())
        .map(|i| PathBuf::from(i.path))
        .collect();
    let generation = fs_ops::SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // a linked folder itself can match too (the walk only lists what is inside it)
    for r in roots.iter().filter(|r| r.is_dir()) {
        let it = item_for(r, true, None);
        let c = search::Candidate {
            name: &it.name,
            path: &it.path,
            ext: &it.ext,
            is_dir: true,
            size: 0,
            folder_size: None,
            modified_ts: it.modified_timestamp,
        };
        if parsed.matches(&c) && seen.insert(lower(&it.path)) {
            out.push(it);
        }
    }
    for mut it in fs_ops::search_roots("", &roots, &parsed, include_subfolders, generation, 2000) {
        if !b.is_linked(&it.path, it.is_dir) || !seen.insert(lower(&it.path)) {
            continue;
        }
        it.name = Path::new(&it.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(it.name);
        out.push(it);
        if out.len() >= 300 {
            break;
        }
    }
    Ok(out)
}

fn create_in(parent_dir: &str) -> Result<String, String> {
    let dir = Path::new(parent_dir);
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", parent_dir));
    }
    let path = fs_ops::unique_target(dir, &format!("New basket.{}", EXT), false);
    save(&path, &BasketFile::new())?;
    Ok(path.to_string_lossy().to_string())
}

// ---------- tauri commands ----------

#[tauri::command]
pub fn basket_create(parent_dir: String) -> Result<String, String> {
    create_in(&parent_dir)
}

#[tauri::command]
pub fn basket_view(basket: String, folder: Option<String>) -> Result<BasketView, String> {
    view(Path::new(&basket), folder.as_deref())
}

/// `reference` is a basket path, or a name in `cwd` (the `{BASKET:name}` placeholder).
#[tauri::command]
pub fn basket_expand(reference: String, cwd: Option<String>) -> Result<Vec<String>, String> {
    let path = resolve(cwd.as_deref().unwrap_or(""), &reference);
    if !path.is_file() {
        return Err(format!("No basket {}", path.display()));
    }
    expand(&path)
}

#[tauri::command]
pub fn basket_add(basket: String, paths: Vec<String>) -> Result<AddResult, String> {
    add(Path::new(&basket), &paths)
}

#[tauri::command]
pub fn basket_remove(basket: String, paths: Vec<String>) -> Result<usize, String> {
    remove(Path::new(&basket), &paths)
}

#[tauri::command]
pub fn basket_relink(basket: String, old_path: String, new_path: String) -> Result<(), String> {
    relink(Path::new(&basket), &old_path, &new_path)
}

#[tauri::command]
pub fn basket_update_paths(basket: String, pairs: Vec<(String, String)>) -> Result<(), String> {
    update_paths(Path::new(&basket), &pairs)
}

#[tauri::command]
pub async fn basket_paste_out(basket: String, paths: Vec<String>, dest_dir: String, mode: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || paste_out(Path::new(&basket), &paths, &dest_dir, mode == "cut"))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn basket_zip(basket: String, paths: Vec<String>, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || zip(Path::new(&basket), &paths, &dest_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn basket_delete_files(basket: String, paths: Vec<String>) -> Result<(), String> {
    delete_files(Path::new(&basket), &paths)
}

#[tauri::command]
pub async fn basket_search(
    basket: String,
    folder: Option<String>,
    query: String,
    include_subfolders: Option<bool>,
) -> Result<Vec<FileItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_in(Path::new(&basket), folder.as_deref(), &query, include_subfolders.unwrap_or(true))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- command line: boonsh.exe --basket <request.json> <answer.json> ----------

#[derive(Deserialize)]
struct CliRequest {
    op: String,
    #[serde(default)]
    basket: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    paths: Vec<String>,
    /// op "expand": a command line typed in a PowerShell tab (see cmdvars.rs)
    #[serde(default)]
    line: String,
}

#[derive(Serialize, Default)]
struct CliAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    items: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    baskets: Vec<CliBasket>,
}

#[derive(Serialize)]
struct CliBasket {
    name: String,
    links: u32,
    path: String,
}

/// `*` and `?` wildcards, ignoring case.
fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn plural(n: usize, one: &str) -> String {
    format!("{} {}{}", n, one, if n == 1 { "" } else { "s" })
}

fn cli(req: CliRequest) -> Result<CliAnswer, String> {
    let mut a = CliAnswer::default();
    let abs = |p: &str| -> String {
        let pp = Path::new(p.trim().trim_matches('"'));
        let full = if pp.is_absolute() { pp.to_path_buf() } else { Path::new(&req.cwd).join(pp) };
        fs_ops::normalize_path(&full).to_string_lossy().to_string()
    };
    match req.op.as_str() {
        "expand" => {
            // the values the app wrote for this session (BOONSH_VARS); none = only baskets by name are filled
            let values = std::env::var("BOONSH_VARS")
                .map(|p| crate::cmdvars::read_vars_file(Path::new(&p)))
                .unwrap_or_default();
            a.text = Some(crate::cmdvars::expand_line(&req.line, &req.cwd, &values)?);
        }
        "list" => {
            for e in sorted_entries(Path::new(&req.cwd)) {
                if is_basket_file(&e.path()) {
                    a.baskets.push(CliBasket {
                        name: e.path().file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                        links: link_count(&e.path()).unwrap_or(0),
                        path: e.path().to_string_lossy().to_string(),
                    });
                }
            }
            if a.baskets.is_empty() {
                a.message = format!("No baskets in {}", req.cwd);
            }
        }
        "new" => {
            let path = resolve(&req.cwd, &req.basket);
            if path.exists() {
                return Err(format!("{} already exists", path.display()));
            }
            save(&path, &BasketFile::new())?;
            a.message = format!("Created the basket {}", path.display());
        }
        op => {
            let basket = resolve(&req.cwd, &req.basket);
            if !basket.is_file() {
                return Err(format!("No basket {}", basket.display()));
            }
            match op {
                "items" => a.items = expand(&basket)?,
                "add" => {
                    let paths: Vec<String> = req.paths.iter().map(|p| abs(p)).collect();
                    let r = add(&basket, &paths)?;
                    a.message = format!("{} added, {} already in the basket", plural(r.added, "link"), r.already);
                    for e in r.refused {
                        a.message.push_str(&format!("\n  skipped: {}", e));
                    }
                }
                "remove" => {
                    let b = Opened::open(&basket)?;
                    let mut targets = Vec::new();
                    for p in &req.paths {
                        if p.contains('*') || p.contains('?') {
                            // a wildcard picks links by name (or by full path when it has a backslash)
                            for l in &b.file.items {
                                let name = Path::new(&l.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                                if wildcard(p, &name) || (p.contains('\\') && wildcard(p, &l.path)) {
                                    targets.push(l.path.clone());
                                }
                            }
                        } else {
                            targets.push(abs(p));
                        }
                    }
                    let n = remove(&basket, &targets)?;
                    a.message = format!("{} removed (the files stay)", plural(n, "link"));
                }
                other => return Err(format!("Unknown basket command: {}", other)),
            }
        }
    }
    Ok(a)
}

/// Entry for `boonsh.exe --basket <request> <answer>` (see lib.rs). Both are UTF-8 JSON files, so names in any
/// language pass through the PowerShell console safely.
pub fn run_cli(args: &[String]) -> i32 {
    let (Some(req_path), Some(ans_path)) = (args.first(), args.get(1)) else { return 2 };
    let answer = fs::read_to_string(req_path.trim_matches('"'))
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<CliRequest>(t.trim_start_matches('\u{feff}')).map_err(|e| e.to_string()))
        .and_then(cli)
        .unwrap_or_else(|e| CliAnswer { error: e, ..Default::default() });
    let failed = !answer.error.is_empty();
    let text = serde_json::to_string(&answer).unwrap_or_else(|_| "{}".to_string());
    if fs::write(ans_path.trim_matches('"'), text).is_err() {
        return 1;
    }
    i32::from(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("boonsh-basket-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    fn states(v: &BasketView) -> Vec<(String, Option<String>)> {
        let mut out: Vec<_> = v.items.iter().map(|i| (i.name.clone(), i.state.clone())).collect();
        out.sort();
        out
    }

    #[test]
    fn create_add_view_and_states() {
        let d = tmp("states");
        let work = d.join("Work");
        fs::create_dir_all(work.join("Reports\\2025")).unwrap();
        fs::write(work.join("Reports\\2025\\q1.txt"), "1").unwrap();
        fs::write(work.join("Reports\\summary.txt"), "s").unwrap();
        fs::write(work.join("invoice.pdf"), "i").unwrap();

        let basket = PathBuf::from(create_in(&s(&d)).unwrap());
        assert!(basket.ends_with("New basket.basket"));
        assert_eq!(PathBuf::from(create_in(&s(&d)).unwrap()).file_name().unwrap(), "New basket (2).basket");

        let r = add(&basket, &[s(&work.join("invoice.pdf")), s(&work.join("Reports"))]).unwrap();
        assert_eq!((r.added, r.already), (2, 0));
        let r = add(&basket, &[s(&work.join("invoice.pdf")), s(&work.join("Reports\\summary.txt")), s(&basket)]).unwrap();
        assert_eq!((r.added, r.already, r.refused.len()), (0, 2, 1), "already linked (also inside a linked folder); a basket is refused");
        assert_eq!(link_count(&basket), Some(2));

        // a new file appears in the linked folder, one goes away
        fs::write(work.join("Reports\\new.txt"), "n").unwrap();
        fs::remove_file(work.join("Reports\\summary.txt")).unwrap();
        let v = view(&basket, Some(&s(&work.join("Reports")))).unwrap();
        assert_eq!(
            states(&v),
            vec![
                ("2025".into(), None),
                ("new.txt".into(), Some("new".into())),
                ("summary.txt".into(), Some("gone".into()))
            ]
        );
        assert_eq!((v.links, v.gone, v.new), (1, 1, 1));

        // the linked items only: the folder is not clean any more, so its linked parts are listed
        let e = expand(&basket).unwrap();
        assert_eq!(e, vec![s(&work.join("invoice.pdf")), s(&work.join("Reports\\2025"))]);

        // Link the new one, Clear the gone one: the folder is clean again
        add(&basket, &[s(&work.join("Reports\\new.txt"))]).unwrap();
        remove(&basket, &[s(&work.join("Reports\\summary.txt"))]).unwrap();
        assert_eq!(expand(&basket).unwrap(), vec![s(&work.join("invoice.pdf")), s(&work.join("Reports"))]);

        // a moved-away top link is gone at the top level; it comes back when the file does
        fs::rename(work.join("invoice.pdf"), d.join("invoice.pdf")).unwrap();
        let v = view(&basket, None).unwrap();
        assert_eq!(v.gone, 1);
        fs::rename(d.join("invoice.pdf"), work.join("invoice.pdf")).unwrap();
        assert_eq!(view(&basket, None).unwrap().gone, 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cleared_items_are_left_out_and_relink() {
        let d = tmp("cleared");
        let f = d.join("F");
        fs::create_dir_all(f.join("sub")).unwrap();
        fs::write(f.join("a.txt"), "a").unwrap();
        fs::write(f.join("sub\\b.txt"), "b").unwrap();
        let basket = PathBuf::from(create_in(&s(&d)).unwrap());
        add(&basket, &[s(&f)]).unwrap();
        // remove a file inside the linked folder: it is hidden and never used
        remove(&basket, &[s(&f.join("a.txt"))]).unwrap();
        assert_eq!(states(&view(&basket, Some(&s(&f))).unwrap()), vec![("sub".into(), None)]);
        assert_eq!(expand(&basket).unwrap(), vec![s(&f.join("sub"))]);
        // adding it again links it again
        add(&basket, &[s(&f.join("a.txt"))]).unwrap();
        assert_eq!(expand(&basket).unwrap(), vec![s(&f)]);

        // a gone top link is relinked by the user
        let g = d.join("G");
        fs::rename(&f, &g).unwrap();
        assert_eq!(view(&basket, None).unwrap().gone, 1);
        relink(&basket, &s(&f), &s(&g)).unwrap();
        assert_eq!(expand(&basket).unwrap(), vec![s(&g)], "the snapshot is kept, so the folder is clean");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn copy_move_and_zip_use_only_linked_items() {
        let d = tmp("copy");
        let f = d.join("F");
        fs::create_dir_all(f.join("deep")).unwrap();
        fs::write(f.join("a.txt"), "a").unwrap();
        fs::write(f.join("deep\\b.txt"), "b").unwrap();
        let basket = PathBuf::from(create_in(&s(&d)).unwrap());
        add(&basket, &[s(&f)]).unwrap();
        fs::write(f.join("deep\\unlinked.txt"), "u").unwrap(); // new, not linked

        let out = d.join("out");
        fs::create_dir_all(&out).unwrap();
        let pasted = paste_out(&basket, &[s(&f)], &s(&out), false).unwrap();
        assert_eq!(pasted, vec![s(&out.join("F"))]);
        assert!(out.join("F\\a.txt").exists() && out.join("F\\deep\\b.txt").exists());
        assert!(!out.join("F\\deep\\unlinked.txt").exists(), "the unlinked new file is not copied");

        let zipped = zip(&basket, &[s(&f)], &s(&d)).unwrap();
        assert!(zipped.ends_with("New basket.zip"));
        let names: Vec<String> = {
            let mut z = ::zip::ZipArchive::new(fs::File::open(&zipped).unwrap()).unwrap();
            (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
        };
        assert!(names.contains(&"F/a.txt".to_string()) && names.contains(&"F/deep/b.txt".to_string()));
        assert!(!names.iter().any(|n| n.contains("unlinked")), "{:?}", names);

        // move: only linked items move, the link follows them, the unlinked file stays behind
        let moved = d.join("moved");
        fs::create_dir_all(&moved).unwrap();
        paste_out(&basket, &[s(&f)], &s(&moved), true).unwrap();
        assert!(moved.join("F\\deep\\b.txt").exists() && f.join("deep\\unlinked.txt").exists());
        assert_eq!(expand(&basket).unwrap(), vec![s(&moved.join("F"))]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn renames_from_the_basket_update_links() {
        let d = tmp("rename");
        let f = d.join("F");
        fs::create_dir_all(&f).unwrap();
        fs::write(f.join("a.txt"), "a").unwrap();
        fs::write(d.join("top.txt"), "t").unwrap();
        let basket = PathBuf::from(create_in(&s(&d)).unwrap());
        add(&basket, &[s(&f), s(&d.join("top.txt"))]).unwrap();
        fs::rename(f.join("a.txt"), f.join("b.txt")).unwrap();
        fs::rename(d.join("top.txt"), d.join("top2.txt")).unwrap();
        update_paths(
            &basket,
            &[(s(&f.join("a.txt")), s(&f.join("b.txt"))), (s(&d.join("top.txt")), s(&d.join("top2.txt")))],
        )
        .unwrap();
        assert_eq!(expand(&basket).unwrap(), vec![s(&f), s(&d.join("top2.txt"))]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cli_round_trip_and_wildcards() {
        let d = tmp("cli");
        fs::write(d.join("draft-1.txt"), "1").unwrap();
        fs::write(d.join("final.txt"), "f").unwrap();
        fs::write(d.join("ไฟล์ภาษาไทย.txt"), "t").unwrap();
        let req = |op: &str, basket: &str, paths: &[&str]| CliRequest {
            op: op.into(),
            basket: basket.into(),
            cwd: s(&d),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            line: String::new(),
        };
        cli(req("new", "Tax 2026", &[])).unwrap();
        assert!(cli(req("new", "Tax 2026", &[])).is_err(), "no overwrite");
        let a = cli(req("add", "Tax 2026", &["draft-1.txt", "final.txt", "ไฟล์ภาษาไทย.txt", "missing.txt"])).unwrap();
        assert!(a.message.starts_with("3 links added"), "{}", a.message);
        let a = cli(req("remove", "tax 2026", &["*DRAFT*"])).unwrap();
        assert_eq!(a.message, "1 link removed (the files stay)");
        let a = cli(req("items", &s(&d.join("Tax 2026.basket")), &[])).unwrap();
        assert_eq!(a.items, vec![s(&d.join("final.txt")), s(&d.join("ไฟล์ภาษาไทย.txt"))]);
        let a = cli(req("list", "", &[])).unwrap();
        assert_eq!((a.baskets[0].name.as_str(), a.baskets[0].links), ("Tax 2026", 2));
        assert!(cli(req("items", "nope", &[])).is_err());
        assert!(wildcard("*.t?t", "Final.TXT") && !wildcard("a*", "ba"));
        let _ = fs::remove_dir_all(&d);
    }
}
