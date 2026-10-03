use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use crate::localtime;
use crate::search;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub size_formatted: String,
    pub modified: String,
    pub modified_timestamp: u64,
    pub created: String,
    pub created_timestamp: u64,
    pub ext: String,
    pub is_hidden: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct QuickAccessItem {
    pub label: String,
    pub path: String,
    pub icon_type: String, // "desktop", "downloads", "documents", "home", "drive"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileListResult {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub items: Vec<FileItem>,
    pub total_files: usize,
    pub total_folders: usize,
    pub total_size: u64,
}

/// Startup folder: a directory passed as the first CLI argument (used by the
/// admin/normal relaunch to keep the current folder), else ~/Downloads, else the process cwd.
pub fn default_start_dir() -> String {
    if let Some(arg) = std::env::args().nth(1) {
        let p = PathBuf::from(arg.trim_matches('"'));
        if p.is_dir() {
            return p.to_string_lossy().to_string();
        }
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let downloads = PathBuf::from(user_profile).join("Downloads");
        if downloads.is_dir() {
            return downloads.to_string_lossy().to_string();
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "C:\\".to_string())
}

/// Quote a path for use as a single Windows command-line argument.
/// A trailing backslash would escape the closing quote (`"C:\"`), so append `.`.
fn quote_path_arg(path: &str) -> String {
    if path.ends_with('\\') {
        format!("\"{}.\"", path)
    } else {
        format!("\"{}\"", path)
    }
}

#[tauri::command]
pub fn list_directory(target_path: Option<String>) -> Result<FileListResult, String> {
    let raw_path = match target_path {
        Some(p) if !p.trim().is_empty() => p,
        _ => default_start_dir(),
    };

    let path = PathBuf::from(&raw_path);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", raw_path));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", raw_path));
    }

    let canonical_path = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    let clean_current = canonical_path
        .to_string_lossy()
        .to_string()
        .replace("\\\\?\\", "");

    let parent_path = path.parent().map(|p| p.to_string_lossy().to_string());

    let mut items = Vec::new();
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size = 0u64;

    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten() {
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = metadata.is_dir();
            let size = if is_dir { 0 } else { metadata.len() };
            if is_dir {
                total_folders += 1;
            } else {
                total_files += 1;
                total_size += size;
            }

            let modified_timestamp = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let modified = format_time(modified_timestamp);
            let created_timestamp = metadata
                .created()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            let is_hidden = name.starts_with('.');

            let item_path = entry.path().to_string_lossy().to_string();

            items.push(FileItem {
                name,
                path: item_path,
                is_dir,
                size,
                size_formatted: format_size(size, is_dir),
                modified,
                modified_timestamp,
                created: format_time(created_timestamp),
                created_timestamp,
                ext,
                is_hidden,
            });
        }
    }

    // Default sort: Directories first, then natural numerical sorting (1, 2, 3... 10, 11)
    items.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            natural_cmp(&a.name, &b.name)
        }
    });

    Ok(FileListResult {
        current_path: clean_current,
        parent_path,
        items,
        total_files,
        total_folders,
        total_size,
    })
}

#[tauri::command]
pub fn get_quick_access() -> Result<Vec<QuickAccessItem>, String> {
    let mut list = Vec::new();

    if let Some(home) = dirs::home_dir() {
        list.push(QuickAccessItem {
            label: "Home".to_string(),
            path: home.to_string_lossy().to_string(),
            icon_type: "home".to_string(),
        });
    }

    if let Some(desktop) = dirs::desktop_dir() {
        list.push(QuickAccessItem {
            label: "Desktop".to_string(),
            path: desktop.to_string_lossy().to_string(),
            icon_type: "desktop".to_string(),
        });
    }

    if let Some(downloads) = dirs::download_dir() {
        list.push(QuickAccessItem {
            label: "Downloads".to_string(),
            path: downloads.to_string_lossy().to_string(),
            icon_type: "downloads".to_string(),
        });
    }

    if let Some(documents) = dirs::document_dir() {
        list.push(QuickAccessItem {
            label: "Documents".to_string(),
            path: documents.to_string_lossy().to_string(),
            icon_type: "documents".to_string(),
        });
    }

    // Add Windows Drives (C:\, D:\, etc.)
    for letter in b'A'..=b'Z' {
        let drive_str = format!("{}:\\", letter as char);
        let drive_path = Path::new(&drive_str);
        if drive_path.exists() {
            list.push(QuickAccessItem {
                label: format!("Drive ({}:)", letter as char),
                path: drive_str,
                icon_type: "drive".to_string(),
            });
        }
    }

    Ok(list)
}

#[tauri::command]
pub fn create_new_file(parent_dir: String, name: String) -> Result<String, String> {
    let target = PathBuf::from(&parent_dir).join(&name);
    if target.exists() {
        return Err(format!("File already exists: {}", name));
    }
    fs::File::create(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_new_folder(parent_dir: String, name: String) -> Result<String, String> {
    let target = PathBuf::from(&parent_dir).join(&name);
    if target.exists() {
        return Err(format!("Folder already exists: {}", name));
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_shortcut(parent_dir: String, name: String, target_path: String) -> Result<String, String> {
    let mut link_name = name.clone();
    if !link_name.to_lowercase().ends_with(".lnk") {
        link_name.push_str(".lnk");
    }
    let shortcut_path = PathBuf::from(&parent_dir).join(&link_name);
    if shortcut_path.exists() {
        return Err(format!("Shortcut already exists: {}", link_name));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let script = format!(
            "$s=(New-Object -COM WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Save()",
            shortcut_path.to_string_lossy().replace("'", "''"),
            target_path.replace("'", "''")
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("Failed to create shortcut: {}", e))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to create shortcut: {}", err));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (parent_dir, target_path);
    }

    Ok(shortcut_path.to_string_lossy().to_string())
}

/// Opens THIRD_PARTY_LICENSES.txt, the licenses of the libraries inside boonsh. The installer puts it next to the app
/// (it is a bundled resource, see tauri.conf.json); `scripts/gen-third-party.py` writes it.
#[tauri::command]
pub fn open_license_notices(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let path = app
        .path()
        .resolve("THIRD_PARTY_LICENSES.txt", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if !path.exists() {
        return Err(format!("The license notices file was not found: {}", path.display()));
    }
    open_in_default_app(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let script = format!(
            "Start-Process '{}'",
            path.replace("'", "''")
        );
        let _ = Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", &script])
            .spawn()
            .map_err(|e| format!("Failed to open file '{}': {}", path, e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }

    Ok(())
}

#[tauri::command]
pub fn rename_item(old_path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let parent = old
        .parent()
        .ok_or_else(|| "Invalid parent path".to_string())?;
    let new_path = parent.join(&new_name);

    // A change of letter case only (photo.JPG -> photo.jpg) "exists" on Windows, but it is the same item
    let is_case_only_change = old.to_string_lossy().to_lowercase() == new_path.to_string_lossy().to_lowercase();
    if new_path.exists() && !is_case_only_change {
        return Err(format!("Target name '{}' already exists", new_name));
    }

    fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_items(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let path = PathBuf::from(&p);
        if path.exists() {
            trash::delete(&path).map_err(|e| format!("Failed to move '{}' to trash: {}", p, e))?;
        }
    }
    Ok(())
}

/// Paste (copy or move) items into `dest_dir`. Returns the new paths.
/// Name clashes get Explorer-style names ("a - Copy.txt" / "a (2).txt") instead of overwriting.
/// Runs off the main thread so large copies don't freeze the window.
#[tauri::command]
pub async fn paste_items(paths: Vec<String>, dest_dir: String, mode: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || paste_items_blocking(paths, dest_dir, mode == "cut"))
        .await
        .map_err(|e| e.to_string())?
}

fn paste_items_blocking(paths: Vec<String>, dest_dir: String, is_move: bool) -> Result<Vec<String>, String> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination is not a folder: {}", dest_dir));
    }
    let dest_canon = fs::canonicalize(&dest).map_err(|e| e.to_string())?;

    let mut pasted = Vec::new();
    let mut errors = Vec::new();

    for p in paths {
        let src = PathBuf::from(&p);
        let result = (|| -> Result<Option<PathBuf>, String> {
            if !src.exists() {
                return Err("no longer exists".to_string());
            }
            let src_canon = fs::canonicalize(&src).map_err(|e| e.to_string())?;
            if src.is_dir() && dest_canon.starts_with(&src_canon) {
                return Err("cannot paste a folder into itself".to_string());
            }
            let name = src.file_name().ok_or("invalid name")?.to_string_lossy().to_string();

            if is_move {
                // Cut + paste into the same folder is a no-op
                if src_canon.parent() == Some(dest_canon.as_path()) {
                    return Ok(None);
                }
                let target = unique_target(&dest, &name, false);
                if fs::rename(&src, &target).is_err() {
                    // Different drive: copy then remove the original
                    copy_recursive(&src, &target).map_err(|e| e.to_string())?;
                    if src.is_dir() {
                        fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
                    } else {
                        fs::remove_file(&src).map_err(|e| e.to_string())?;
                    }
                }
                Ok(Some(target))
            } else {
                let target = unique_target(&dest, &name, true);
                copy_recursive(&src, &target).map_err(|e| e.to_string())?;
                Ok(Some(target))
            }
        })();

        match result {
            Ok(Some(target)) => pasted.push(target.to_string_lossy().to_string()),
            Ok(None) => {}
            Err(e) => errors.push(format!("'{}': {}", p, e)),
        }
    }

    if errors.is_empty() {
        Ok(pasted)
    } else {
        Err(format!("Some items could not be pasted:\n{}", errors.join("\n")))
    }
}

fn unique_target(dir: &Path, name: &str, is_copy: bool) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match Path::new(name).extension() {
        Some(e) if !dir.join(name).is_dir() => (
            Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            format!(".{}", e.to_string_lossy()),
        ),
        _ => (name.to_string(), String::new()),
    };
    for n in 1.. {
        let candidate = match (is_copy, n) {
            (true, 1) => format!("{} - Copy{}", stem, ext),
            (true, n) => format!("{} - Copy ({}){}", stem, n, ext),
            (false, n) => format!("{} ({}){}", stem, n + 1, ext),
        };
        let path = dir.join(candidate);
        if !path.exists() {
            return path;
        }
    }
    unreachable!()
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ())
    }
}

/// Compress items into a new .zip in `dest_dir` ("name.zip", named after the first item; never overwrites).
/// Returns the zip's path.
#[tauri::command]
pub async fn compress_to_zip(paths: Vec<String>, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest_dir);
        let first = PathBuf::from(paths.first().ok_or("Nothing selected to compress")?);
        let base = if first.is_dir() {
            first.file_name()
        } else {
            first.file_stem()
        }
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Archive".to_string());
        let zip_path = unique_target(&dest, &format!("{}.zip", base), false);

        let result = write_zip(&paths, &zip_path);
        if result.is_err() {
            let _ = fs::remove_file(&zip_path); // don't leave a half-written archive
        }
        result.map(|_| zip_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn write_zip(paths: &[String], zip_path: &Path) -> Result<(), String> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let file = fs::File::create(zip_path).map_err(|e| format!("Cannot create zip: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);

    for p in paths {
        let item = PathBuf::from(p);
        if !item.exists() {
            return Err(format!("'{}' no longer exists", p));
        }
        // Entry names are relative to the item's parent, so a folder keeps its own name inside the zip
        let root = item.parent().unwrap_or(Path::new("")).to_path_buf();
        for entry in WalkDir::new(&item).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let rel = path.strip_prefix(&root).map_err(|e| e.to_string())?;
            let name = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            let meta = entry.metadata().map_err(|e| e.to_string())?;

            let mut options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(meta.len() >= 0xFFFF_FFFF);
            if let Some(dt) = meta.modified().ok().and_then(zip_datetime) {
                options = options.last_modified_time(dt);
            }

            if meta.is_dir() {
                zip.add_directory(format!("{}/", name), options).map_err(|e| e.to_string())?;
            } else if meta.is_file() {
                zip.start_file(name, options).map_err(|e| e.to_string())?;
                let mut f = fs::File::open(path).map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Zip timestamps are local time (MS-DOS format).
fn zip_datetime(t: std::time::SystemTime) -> Option<zip::DateTime> {
    let lt = localtime::from_unix(t.duration_since(UNIX_EPOCH).ok()?.as_secs());
    zip::DateTime::from_date_and_time(
        u16::try_from(lt.year).ok()?,
        lt.month as u8,
        lt.day as u8,
        lt.hour as u8,
        lt.minute as u8,
        lt.second as u8,
    )
    .ok()
}

/// Extract a .zip into a new folder next to it in `dest_dir` (named after the zip; never overwrites).
/// Entry paths are sanitized by the zip crate, so entries can't escape the folder. Returns the folder path.
#[tauri::command]
pub async fn extract_zip(path: String, dest_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let zip_path = PathBuf::from(&path);
        let file = fs::File::open(&zip_path).map_err(|e| format!("Cannot open zip: {}", e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip file: {}", e))?;

        let stem = zip_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Extracted".to_string());
        let target = unique_target(&PathBuf::from(&dest_dir), &stem, false);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;

        archive
            .extract(&target)
            .map_err(|e| format!("Extraction failed (partially extracted to '{}'): {}", target.display(), e))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;

    // Cap preview size to 500 KB to avoid freezing on huge log files
    if metadata.len() > 500 * 1024 {
        let content = fs::read(&path).map_err(|e| e.to_string())?;
        let truncated = String::from_utf8_lossy(&content[..500 * 1024]).to_string();
        return Ok(format!(
            "{}\n\n--- [TRUNCATED: File exceeds 500 KB preview limit] ---",
            truncated
        ));
    }

    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Reads a subtitle file (.srt / .vtt) for the video player. Most are UTF-8; an older Thai one is TIS-620 / Windows-874
/// (and a Western one Latin-1), so anything that is not valid UTF-8 is decoded that way instead of failing.
#[tauri::command]
pub fn read_subtitle(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("This subtitle file is larger than 5 MB.".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&bytes);
    Ok(match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes
            .iter()
            .map(|&b| match b {
                0xA1..=0xFB => char::from_u32(0x0E01 + (b as u32 - 0xA1)).unwrap_or('?'),
                _ => b as char,
            })
            .collect(),
    })
}

/// Saves a picture or clip made by the video player (the data arrives as base64) into a "boonsh captures" folder next
/// to the video, never overwriting. Returns the full path of the new file.
#[tauri::command]
pub fn save_capture(video_path: String, name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let dir = Path::new(&video_path)
        .parent()
        .ok_or("The video has no folder.")?
        .join("boonsh captures");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // keep only a plain file name
    let name: String = name
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{}", e)),
        None => (name.clone(), String::new()),
    };
    let mut target = dir.join(&name);
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Shows the Windows "Open" dialog and returns the chosen file, or None when it was cancelled.
/// `filter` is in the dialog's own form, for example "Video|*.mp4;*.mkv|All files|*.*".
#[tauri::command]
pub async fn pick_file(title: String, filter: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            let script = format!(
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;                 $d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title='{}';$d.Filter='{}';                 $o=New-Object System.Windows.Forms.Form -Property @{{TopMost=$true}};                 if($d.ShowDialog($o) -eq 'OK'){{[Console]::Out.Write($d.FileName)}}",
                title.replace('\'', "''"),
                filter.replace('\'', "''")
            );
            let out = Command::new("powershell")
                .args(["-STA", "-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output()
                .map_err(|e| format!("Could not open the file dialog: {}", e))?;
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(if path.is_empty() { None } else { Some(path) })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, filter);
        Ok(None)
    }
}

#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    let bytes = fs::read(&path_buf).map_err(|e| e.to_string())?;

    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let mime_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/png",
    };

    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime_type, b64))
}

/// What the search box gets back: the matches, plus a note when part of the query was skipped.
#[derive(Serialize)]
pub struct SearchResponse {
    pub items: Vec<FileItem>,
    pub notice: String,
}

/// Search by name and/or filters (see `search.rs` for the query language).
/// Invalid queries return a readable error for the search box. Runs off the main thread.
#[tauri::command]
pub async fn search_files(
    dir: String,
    query: String,
    include_subfolders: Option<bool>,
    vars: Option<std::collections::HashMap<String, Vec<String>>>,
) -> Result<SearchResponse, String> {
    let parsed = search::parse(&query)?;
    let (places, missing) = resolve_inputs(&dir, parsed.inputs(), &vars.unwrap_or_default())?;
    let notice = input_notice(&missing, places.is_none());
    if !parsed.has_terms() && places.is_none() {
        // e.g. "filesize:" while still typing the value, or input:{VAR} with no value: keep showing the folder
        return list_directory(Some(dir)).map(|r| SearchResponse { items: r.items, notice });
    }
    // A newer search supersedes this one: the old scan stops instead of running on in the background
    let generation = SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        search_places(&dir, places.as_ref(), &parsed, include_subfolders.unwrap_or(true), generation)
    })
    .await
    .map(|items| SearchResponse { items, notice })
    .map_err(|e| e.to_string())
}

static SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// `.` and `..` resolved by hand (no \\?\ prefix, and the path need not exist yet).
fn normalize_path(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `input:` after resolving: every leaf is the list of existing folders/files it stands for.
type Places = search::Expr<Vec<PathBuf>>;

/// The places named by `input:`. Global Var values are expanded, relative places start at `dir` (the current
/// folder) and every place must exist. A Global Var with no value is skipped and reported in the second part
/// of the result, and whatever is left of the expression is used; `None` means "search the current folder".
fn resolve_inputs(
    dir: &str,
    expr: Option<&search::Expr<search::InputSpec>>,
    vars: &std::collections::HashMap<String, Vec<String>>,
) -> Result<(Option<Places>, Vec<String>), String> {
    let mut missing = Vec::new();
    let places = match expr {
        Some(e) => resolve_expr(dir, e, vars, &mut missing)?,
        None => None,
    };
    Ok((places, missing))
}

fn resolve_expr(
    dir: &str,
    expr: &search::Expr<search::InputSpec>,
    vars: &std::collections::HashMap<String, Vec<String>>,
    missing: &mut Vec<String>,
) -> Result<Option<Places>, String> {
    use search::Expr;
    let existing = |raw: &str| -> Result<PathBuf, String> {
        let p = Path::new(raw);
        let full = normalize_path(&if p.is_absolute() { p.to_path_buf() } else { Path::new(dir).join(p) });
        if !full.exists() {
            return Err(format!("input: not found: {}", full.display()));
        }
        Ok(full)
    };
    match expr {
        Expr::Leaf(search::InputSpec::Path(p)) => Ok(Some(Expr::Leaf(vec![existing(p)?]))),
        Expr::Leaf(search::InputSpec::Var(name)) => match vars.get(name).filter(|v| !v.is_empty()) {
            Some(values) => {
                let mut roots: Vec<PathBuf> = Vec::new();
                for v in values {
                    let full = existing(v)?;
                    if !roots.iter().any(|r| r.to_string_lossy().eq_ignore_ascii_case(&full.to_string_lossy())) {
                        roots.push(full);
                    }
                }
                Ok(Some(Expr::Leaf(roots)))
            }
            None => {
                if !missing.contains(name) {
                    missing.push(name.clone());
                }
                Ok(None)
            }
        },
        Expr::And(items) | Expr::Or(items) => {
            let mut kids = Vec::new();
            for item in items {
                if let Some(k) = resolve_expr(dir, item, vars, missing)? {
                    kids.push(k);
                }
            }
            Ok(match kids.len() {
                0 => None,
                1 => kids.pop(),
                _ if matches!(expr, Expr::And(_)) => Some(Expr::And(kids)),
                _ => Some(Expr::Or(kids)),
            })
        }
    }
}

fn input_notice(missing: &[String], searching_current_folder: bool) -> String {
    if missing.is_empty() {
        return String::new();
    }
    let names = missing.iter().map(|n| format!("{{{}}}", n)).collect::<Vec<_>>().join(", ");
    format!(
        "{} {} no value yet, so {} skipped{}. Right-click a file or folder, then Assign to Global Var.",
        names,
        if missing.len() == 1 { "has" } else { "have" },
        if missing.len() == 1 { "it is" } else { "they are" },
        if searching_current_folder { "; searching the current folder" } else { "" }
    )
}

fn has_and(e: &Places) -> bool {
    match e {
        search::Expr::Leaf(_) => false,
        search::Expr::And(_) => true,
        search::Expr::Or(v) => v.iter().any(has_and),
    }
}

/// Run the search over the `input:` places (`None` = the current folder). OR lists everything found in any
/// side. AND keeps only file names that turn up on every side and lists every copy of those names (same name,
/// not necessarily the same file). Names compare ignoring case.
fn search_places(dir: &str, places: Option<&Places>, query: &search::Query, include_subfolders: bool, generation: u64) -> Vec<FileItem> {
    let Some(places) = places else {
        return search_roots(dir, &[PathBuf::from(dir)], query, include_subfolders, generation, 300);
    };
    // With an AND, collect more than 300 per side first so the names being compared are not cut short
    let limit = if has_and(places) { 5000 } else { 300 };
    let mut out = eval_places(dir, places, query, include_subfolders, generation, limit);
    out.truncate(300);
    out
}

fn eval_places(dir: &str, e: &Places, query: &search::Query, include_subfolders: bool, generation: u64, limit: usize) -> Vec<FileItem> {
    use search::Expr;
    match e {
        Expr::Leaf(roots) => search_roots(dir, roots, query, include_subfolders, generation, limit),
        Expr::Or(kids) => {
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for k in kids {
                for item in eval_places(dir, k, query, include_subfolders, generation, limit) {
                    if seen.insert(item.path.to_lowercase()) {
                        out.push(item);
                    }
                }
            }
            out
        }
        Expr::And(kids) => {
            let found: Vec<Vec<FileItem>> = kids.iter().map(|k| eval_places(dir, k, query, include_subfolders, generation, limit)).collect();
            let name_of = |i: &FileItem| Path::new(&i.path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            let mut common: Option<HashSet<String>> = None;
            for items in &found {
                let names: HashSet<String> = items.iter().map(&name_of).collect();
                common = Some(match common {
                    None => names,
                    Some(c) => c.intersection(&names).cloned().collect(),
                });
            }
            let common = common.unwrap_or_default();
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for item in found.into_iter().flatten() {
                if common.contains(&name_of(&item)) && seen.insert(item.path.to_lowercase()) {
                    out.push(item);
                }
            }
            out
        }
    }
}

#[cfg(test)]
fn search_blocking(dir: &str, query: &search::Query, include_subfolders: bool, generation: u64) -> Vec<FileItem> {
    search_roots(dir, &[PathBuf::from(dir)], query, include_subfolders, generation, 300)
}

/// Search every root (folders or files). `dir` is the current folder: results below it are shown as `./sub/x`,
/// results elsewhere with their full path. At most `limit` results across all roots.
fn search_roots(dir: &str, roots: &[PathBuf], query: &search::Query, include_subfolders: bool, generation: u64, limit: usize) -> Vec<FileItem> {
    let mut matches = Vec::new();
    let mut seen_paths = HashSet::new();
    let max_depth = if include_subfolders { 8 } else { 1 };
    let base_path = PathBuf::from(dir);
    let mut scanned = 0usize;

    // Folder totals need every file under each folder (any depth), so walk the whole tree children-first
    // and sum sizes bottom-up. depth_sums[d] = bytes so far for the folder currently being summed at depth d-1.
    let folder_sizes = query.wants_folder_sizes();

    'roots: for root in roots {
        let root_key = root.to_string_lossy().to_lowercase();
        // A file root is its own (only) result; a folder root lists what is inside it
        let walker = WalkDir::new(root).min_depth(if root.is_dir() { 1 } else { 0 });
        let walker = if folder_sizes { walker.contents_first(true) } else { walker.max_depth(max_depth) };
        let mut depth_sums: Vec<u64> = Vec::new();

        for entry in walker.into_iter().filter_map(|e| e.ok()) {
            scanned += 1;
            if scanned % 512 == 1 && SEARCH_GENERATION.load(Ordering::Relaxed) != generation {
                break 'roots;
            }
            let depth = entry.depth();
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = metadata.is_dir();
            let file_size = if is_dir { 0 } else { metadata.len() };

            let mut folder_size = None;
            if folder_sizes {
                if depth_sums.len() < depth + 2 {
                    depth_sums.resize(depth + 2, 0);
                }
                if is_dir {
                    // contents_first: all children were already yielded and added to depth_sums[depth + 1]
                    let total = std::mem::take(&mut depth_sums[depth + 1]);
                    depth_sums[depth] += total;
                    folder_size = Some(total);
                } else {
                    depth_sums[depth] += file_size;
                }
                if depth > max_depth {
                    continue; // counted toward its parents' totals, but too deep to be a result
                }
            }
            let size = folder_size.unwrap_or(file_size);
            let created_timestamp = metadata
                .created()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let modified_timestamp = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            let entry_path = entry.path().to_string_lossy();
            let candidate = search::Candidate {
                name: &name,
                path: &entry_path,
                ext: &ext,
                is_dir,
                size: file_size,
                folder_size,
                modified_ts: modified_timestamp,
            };
            if !query.matches(&candidate) {
                continue;
            }

            let item_path_buf = entry.path().to_path_buf();
            let item_path = item_path_buf.to_string_lossy().to_string();
            let clean_key = item_path.to_lowercase();

            // Deduplicate search results and skip root dir itself
            if (is_dir && clean_key == root_key) || !seen_paths.insert(clean_key) {
                continue;
            }

            // Construct relative display name starting with ./
            let display_name = match item_path_buf.strip_prefix(&base_path) {
                Ok(rel) => {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if rel_str.is_empty() {
                        name.clone()
                    } else {
                        format!("./{}", rel_str)
                    }
                }
                Err(_) => item_path.clone(),
            };

            matches.push(FileItem {
                name: display_name,
                path: item_path,
                is_dir,
                size, // folder total when computed, so the Size column and sort-by-size show it
                size_formatted: format_size(size, is_dir && folder_size.is_none()),
                modified: format_time(modified_timestamp),
                modified_timestamp,
                created: format_time(created_timestamp),
                created_timestamp,
                is_hidden: name.starts_with('.'),
                ext,
            });

            if matches.len() >= limit {
                break 'roots;
            }
        }

    }

    matches
}

#[tauri::command]
pub fn get_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "User".to_string())
}

pub(crate) fn matches_search_query(name: &str, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    let name_lower = name.to_lowercase();

    if q.is_empty() {
        return true;
    }

    // Handle extension pattern like *.md, *.txt, *.png
    if q.starts_with("*.") {
        let ext = &q[2..];
        if !ext.is_empty() {
            return name_lower.ends_with(&format!(".{}", ext));
        }
    }

    // Handle wildcard query with asterisks
    if q.contains('*') {
        let parts: Vec<&str> = q.split('*').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            return true;
        }
        let mut curr_idx = 0;
        for (i, part) in parts.iter().enumerate() {
            if i == 0 && !q.starts_with('*') && !name_lower.starts_with(part) {
                return false;
            }
            if let Some(found_idx) = name_lower[curr_idx..].find(part) {
                curr_idx += found_idx + part.len();
            } else {
                return false;
            }
            if i == parts.len() - 1 && !q.ends_with('*') && !name_lower.ends_with(part) {
                return false;
            }
        }
        return true;
    }

    // Substring fallback
    name_lower.contains(&q)
}

fn format_size(size: u64, is_dir: bool) -> String {
    if is_dir {
        return "--".to_string();
    }
    if size < 1024 {
        format!("{} B", size)
    } else if size < 1024 * 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else if size < 1024 * 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", size as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// Local time as YYYY-MM-DD HH:MM (same date the `filedate:` search filter matches).
fn format_time(timestamp: u64) -> String {
    if timestamp == 0 {
        return "--".to_string();
    }
    let t = localtime::from_unix(timestamp);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute
    )
}

#[tauri::command]
pub fn is_admin() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        if let Ok(out) = Command::new("net").arg("session").output() {
            return out.status.success();
        }
    }
    false
}

#[cfg(target_os = "windows")]
mod win_launcher {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type HANDLE = *mut std::ffi::c_void;
    type HWND = *mut std::ffi::c_void;
    type DWORD = u32;
    type BOOL = i32;
    type LPCWSTR = *const u16;
    type LPWSTR = *mut u16;
    type LPVOID = *mut std::ffi::c_void;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct STARTUPINFOW {
        cb: DWORD,
        lpReserved: LPWSTR,
        lpDesktop: LPWSTR,
        lpTitle: LPWSTR,
        dwX: DWORD,
        dwY: DWORD,
        dwXSize: DWORD,
        dwYSize: DWORD,
        dwXCountChars: DWORD,
        dwYCountChars: DWORD,
        dwFillAttribute: DWORD,
        dwFlags: DWORD,
        wShowWindow: u16,
        cbReserved2: u16,
        lpReserved2: *mut u8,
        hStdInput: HANDLE,
        hStdOutput: HANDLE,
        hStdError: HANDLE,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESS_INFORMATION {
        hProcess: HANDLE,
        hThread: HANDLE,
        dwProcessId: DWORD,
        dwThreadId: DWORD,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetShellWindow() -> HWND;
        fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
        fn AllowSetForegroundWindow(dwProcessId: DWORD) -> BOOL;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(ProcessHandle: HANDLE, DesiredAccess: DWORD, TokenHandle: *mut HANDLE) -> BOOL;
        fn DuplicateTokenEx(
            hExistingToken: HANDLE,
            dwDesiredAccess: DWORD,
            lpTokenAttributes: LPVOID,
            ImpersonationLevel: i32,
            TokenType: i32,
            phNewToken: *mut HANDLE,
        ) -> BOOL;
        fn CreateProcessWithTokenW(
            hToken: HANDLE,
            dwLogonFlags: DWORD,
            lpApplicationName: LPCWSTR,
            lpCommandLine: LPWSTR,
            dwCreationFlags: DWORD,
            lpEnvironment: LPVOID,
            lpCurrentDirectory: LPCWSTR,
            lpStartupInfo: *const STARTUPINFOW,
            lpProcessInformation: *mut PROCESS_INFORMATION,
        ) -> BOOL;
    }

    pub fn allow_all_set_foreground() {
        unsafe {
            AllowSetForegroundWindow(0xFFFFFFFF);
        }
    }

    pub fn launch_as_normal_user(exe_path: &str, dir_path: &str, dir_arg: &str) -> bool {
        unsafe {
            let h_shell_window = GetShellWindow();
            if h_shell_window.is_null() {
                return false;
            }
            let mut shell_pid: DWORD = 0;
            GetWindowThreadProcessId(h_shell_window, &mut shell_pid);
            if shell_pid == 0 {
                return false;
            }

            const PROCESS_QUERY_INFORMATION: DWORD = 0x0400;
            let h_shell_process = OpenProcess(PROCESS_QUERY_INFORMATION, 0, shell_pid);
            if h_shell_process.is_null() {
                return false;
            }

            const TOKEN_DUPLICATE: DWORD = 0x0002;
            let mut h_token: HANDLE = ptr::null_mut();
            if OpenProcessToken(h_shell_process, TOKEN_DUPLICATE, &mut h_token) == 0 {
                CloseHandle(h_shell_process);
                return false;
            }

            const MAXIMUM_ALLOWED: DWORD = 0x02000000;
            const SECURITY_IMPERSONATION: i32 = 2;
            const TOKEN_PRIMARY: i32 = 1;

            let mut h_new_token: HANDLE = ptr::null_mut();
            if DuplicateTokenEx(
                h_token,
                MAXIMUM_ALLOWED,
                ptr::null_mut(),
                SECURITY_IMPERSONATION,
                TOKEN_PRIMARY,
                &mut h_new_token,
            ) == 0
            {
                CloseHandle(h_token);
                CloseHandle(h_shell_process);
                return false;
            }

            let exe_wide: Vec<u16> = OsStr::new(exe_path).encode_wide().chain(std::iter::once(0)).collect();
            let mut cmd_wide: Vec<u16> = OsStr::new(&format!("\"{}\" {}", exe_path, dir_arg)).encode_wide().chain(std::iter::once(0)).collect();
            let dir_wide: Vec<u16> = OsStr::new(dir_path).encode_wide().chain(std::iter::once(0)).collect();

            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as DWORD;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();

            let res = CreateProcessWithTokenW(
                h_new_token,
                0,
                exe_wide.as_ptr(),
                cmd_wide.as_mut_ptr(),
                0,
                ptr::null_mut(),
                dir_wide.as_ptr(),
                &si,
                &mut pi,
            );

            if res != 0 {
                AllowSetForegroundWindow(pi.dwProcessId);
                AllowSetForegroundWindow(0xFFFFFFFF);
            }

            if !pi.hProcess.is_null() {
                CloseHandle(pi.hProcess);
            }
            if !pi.hThread.is_null() {
                CloseHandle(pi.hThread);
            }
            CloseHandle(h_new_token);
            CloseHandle(h_token);
            CloseHandle(h_shell_process);

            res != 0
        }
    }
}

#[tauri::command]
pub fn relaunch_as_admin(current_path: Option<String>) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = current_path.unwrap_or_else(|| "C:\\".to_string());

    #[cfg(target_os = "windows")]
    win_launcher::allow_all_set_foreground();

    let script = format!(
        "Start-Process '{}' -Verb RunAs -WorkingDirectory '{}' -ArgumentList '{}'",
        current_exe.to_string_lossy().replace("'", "''"),
        dir.replace("'", "''"),
        quote_path_arg(&dir).replace("'", "''")
    );

    std::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", &script])
        .spawn()
        .map_err(|e| format!("Failed to launch Administrator instance: {}", e))?;

    std::process::exit(0);
}

#[tauri::command]
pub fn relaunch_as_normal(current_path: Option<String>) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = current_path.unwrap_or_else(|| "C:\\".to_string());

    #[cfg(target_os = "windows")]
    {
        if win_launcher::launch_as_normal_user(&current_exe.to_string_lossy(), &dir, &quote_path_arg(&dir)) {
            std::process::exit(0);
        }
    }

    #[cfg(target_os = "windows")]
    win_launcher::allow_all_set_foreground();

    let script = format!(
        "Start-Process explorer.exe -ArgumentList '{}'",
        current_exe.to_string_lossy().replace("'", "''")
    );

    let _ = std::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", &script])
        .spawn();

    std::process::exit(0);
}

#[tauri::command]
pub fn force_window_to_front(window: tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn SetForegroundWindow(hWnd: *mut c_void) -> i32;
            fn BringWindowToTop(hWnd: *mut c_void) -> i32;
            fn ShowWindow(hWnd: *mut c_void, nCmdShow: i32) -> i32;
            fn SwitchToThisWindow(hWnd: *mut c_void, fUnknown: i32);
        }
        if let Ok(hwnd) = window.hwnd() {
            let ptr = hwnd.0 as *mut c_void;
            unsafe {
                ShowWindow(ptr, 3); // SW_MAXIMIZE
                BringWindowToTop(ptr);
                SetForegroundWindow(ptr);
                SwitchToThisWindow(ptr, 1);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_admin_terminal(cwd: Option<String>) -> Result<(), String> {
    let dir = cwd.unwrap_or_else(|| "C:\\".to_string());
    // Launch PowerShell with Administrator privileges via Windows verb 'RunAs'
    let script = format!("Start-Process powershell -Verb RunAs -WorkingDirectory '{}'", dir);
    std::process::Command::new("powershell")
        .args(["-Command", &script])
        .spawn()
        .map_err(|e| format!("Failed to launch Admin PowerShell: {}", e))?;

    Ok(())
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();

    loop {
        match (a_chars.peek(), b_chars.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut num_a = 0u64;
                    while let Some(&c) = a_chars.peek() {
                        if let Some(digit) = c.to_digit(10) {
                            num_a = num_a.saturating_mul(10).saturating_add(digit as u64);
                            a_chars.next();
                        } else {
                            break;
                        }
                    }
                    let mut num_b = 0u64;
                    while let Some(&c) = b_chars.peek() {
                        if let Some(digit) = c.to_digit(10) {
                            num_b = num_b.saturating_mul(10).saturating_add(digit as u64);
                            b_chars.next();
                        } else {
                            break;
                        }
                    }
                    if num_a != num_b {
                        return num_a.cmp(&num_b);
                    }
                } else {
                    let ca_lower = ca.to_lowercase().next().unwrap_or(ca);
                    let cb_lower = cb.to_lowercase().next().unwrap_or(cb);
                    if ca_lower != cb_lower {
                        return ca_lower.cmp(&cb_lower);
                    }
                    a_chars.next();
                    b_chars.next();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_rename_allows_case_only_change_but_not_overwrites() {
        let d = std::env::temp_dir().join(format!("boonsh-rename-item-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("Photo.JPG"), "x").unwrap();
        fs::write(d.join("other.txt"), "y").unwrap();
        let names = || {
            let mut v: Vec<String> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
            v.sort();
            v
        };
        let p = |n: &str| d.join(n).to_string_lossy().to_string();

        rename_item(p("Photo.JPG"), "photo.jpg".to_string()).unwrap();
        assert_eq!(names(), ["other.txt", "photo.jpg"], "case-only change is allowed");
        let err = rename_item(p("photo.jpg"), "other.txt".to_string()).unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert_eq!(names(), ["other.txt", "photo.jpg"], "nothing was overwritten");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn path_search_finds_files_by_their_folders() {
        let base = std::env::temp_dir().join(format!("boonsh-pathsearch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("client-xyz/invoices/legal")).unwrap();
        fs::create_dir_all(base.join("2026-Q4/invoices/legal")).unwrap();
        fs::create_dir_all(base.join("client-xyz/invoices/other")).unwrap();
        for rel in [
            "client-xyz/invoices/legal/a.pdf",
            "client-xyz/invoices/other/b.pdf",
            "2026-Q4/invoices/legal/xyz-c.pdf",
        ] {
            fs::write(base.join(rel), b"x").unwrap();
        }
        let dir = base.to_string_lossy().to_string();
        let run = |q: &str| {
            let mut names: Vec<String> = search_blocking(&dir, &search::parse(q).unwrap(), true, SEARCH_GENERATION.load(Ordering::SeqCst))
                .into_iter()
                .filter(|i| !i.is_dir)
                .map(|i| i.name)
                .collect();
            names.sort();
            names
        };
        assert_eq!(run("path:client-xyz path:legal"), vec!["./client-xyz/invoices/legal/a.pdf"]);
        assert_eq!(run("path:legal filetype:pdf"), vec!["./2026-Q4/invoices/legal/xyz-c.pdf", "./client-xyz/invoices/legal/a.pdf"]);
        assert_eq!(run("path:'legal' +client-xyz"), vec!["./client-xyz/invoices/legal/a.pdf"]);
        assert_eq!(run("path:legal, other"), vec!["./2026-Q4/invoices/legal/xyz-c.pdf", "./client-xyz/invoices/legal/a.pdf", "./client-xyz/invoices/other/b.pdf"]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn input_places_set_where_to_search() {
        let base = std::env::temp_dir().join(format!("boonsh-inputsearch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for d in ["client/sub", "documents", "other", "my client"] {
            fs::create_dir_all(base.join(d)).unwrap();
        }
        for f in [
            "root.txt", "client/a.txt", "client/dup.txt", "client/sub/b.txt", "documents/c.txt", "documents/dup.txt",
            "other/d.txt", "my client/e.txt",
        ] {
            fs::write(base.join(f), b"x").unwrap();
        }
        let dir = base.to_string_lossy().to_string();
        let mut vars = std::collections::HashMap::new();
        vars.insert("INPUT01".to_string(), vec![base.join("documents").to_string_lossy().to_string(), base.join("other/d.txt").to_string_lossy().to_string()]);
        // returns (sorted result names, notice)
        let run_in = |cwd: &str, q: &str, sub: bool| -> Result<(Vec<String>, String), String> {
            let parsed = search::parse(q)?;
            let (places, missing) = resolve_inputs(cwd, parsed.inputs(), &vars)?;
            let notice = input_notice(&missing, places.is_none());
            let mut v: Vec<String> = search_places(cwd, places.as_ref(), &parsed, sub, SEARCH_GENERATION.load(Ordering::SeqCst))
                .into_iter()
                .filter(|i| !i.is_dir)
                .map(|i| i.name)
                .collect();
            v.sort();
            Ok((v, notice))
        };
        let run = |q: &str, sub: bool| run_in(&dir, q, sub).map(|r| r.0);

        // no input: the current folder (and its subfolders)
        assert_eq!(run("txt", true).unwrap().len(), 8);
        // relative places; a trailing \ makes no difference
        let client = vec!["./client/a.txt", "./client/dup.txt", "./client/sub/b.txt"];
        assert_eq!(run(r"input:.\client txt", true).unwrap(), client);
        assert_eq!(run(r"input:.\client\ txt", true).unwrap(), client);
        assert_eq!(run(r"input:.\client txt", false).unwrap(), vec!["./client/a.txt", "./client/dup.txt"], "Subfolders off applies to each place");

        // comma = more places in one group: everything found anywhere in them
        assert_eq!(
            run(r"input:.\client, .\documents, 'my client' txt", false).unwrap(),
            vec!["./client/a.txt", "./client/dup.txt", "./documents/c.txt", "./documents/dup.txt", "./my client/e.txt"]
        );
        // +group = AND by file name: only names found in both groups, every copy listed
        assert_eq!(run(r"input:.\client +.\documents txt", true).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"]);
        assert_eq!(run(r"input:.\client +.\documents dup.txt", true).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"]);
        assert_eq!(run(r"input:.\documents +.\client DUP.TXT", true).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"], "order and case do not matter");
        assert!(run(r"input:.\client +.\other txt", true).unwrap().is_empty(), "no name in both");
        assert!(run(r"input:.\client +.\documents a.txt", true).unwrap().is_empty(), "a.txt exists only in client");
        // AND binds tighter than OR: (client AND documents) OR 'my client'
        assert_eq!(
            run(r"input:.\client +.\documents, 'my client' txt", false).unwrap(),
            vec!["./client/dup.txt", "./documents/dup.txt", "./my client/e.txt"]
        );
        // client OR (documents AND other): documents and other share no name, so only client is left
        assert_eq!(run(r"input:.\client, .\documents +.\other txt", true).unwrap(), client);
        // parentheses override: client AND (documents OR 'my client')
        assert_eq!(run(r"input:.\client +(.\documents, 'my client') txt", false).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"]);
        assert_eq!(run(r"input:(.\client, .\other) +.\documents txt", true).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"]);
        // three groups: a name must be in all of them
        assert!(run(r"input:.\client +.\documents +.\other txt", true).unwrap().is_empty());
        // a second input: term is another group
        assert_eq!(run(r"input:.\client input:.\documents txt", true).unwrap(), vec!["./client/dup.txt", "./documents/dup.txt"]);

        // absolute place with quotes and a trailing \
        let abs = base.join("documents").to_string_lossy().to_string();
        assert_eq!(run(&format!(r#"input:"{}\" txt"#, abs), true).unwrap(), vec!["./documents/c.txt", "./documents/dup.txt"]);
        // a Global Var: a folder and a file (alternatives of one group)
        assert_eq!(run("input:{INPUT01} txt", true).unwrap(), vec!["./documents/c.txt", "./documents/dup.txt", "./other/d.txt"]);
        // overlapping places do not repeat results
        assert_eq!(run(r"input:.\client, .\client\sub txt", true).unwrap(), client);
        // input only, and with other filters
        assert_eq!(run(r"input:.\documents", true).unwrap(), vec!["./documents/c.txt", "./documents/dup.txt"]);
        assert_eq!(run(r"input:.\client\sub\..\.. path:'documents'", true).unwrap(), vec!["./documents/c.txt", "./documents/dup.txt"]);
        // places outside the current folder show their full path
        let sub = base.join("client").to_string_lossy().to_string();
        let (r, _) = run_in(&sub, &format!(r#"input:"{}" c.txt"#, abs), true).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].starts_with(&abs) && r[0].ends_with("c.txt"), "{}", r[0]);

        // a Global Var with no value is skipped with a notice; the current folder is searched
        let (r, notice) = run_in(&dir, "input:{MISSING} txt", true).unwrap();
        assert_eq!(r.len(), 8);
        assert!(notice.contains("{MISSING} has no value yet") && notice.contains("searching the current folder"), "{notice}");
        let (r, notice) = run_in(&dir, r"input:.\client, {MISSING} a.txt", true).unwrap();
        assert_eq!(r, vec!["./client/a.txt"]);
        assert!(notice.contains("{MISSING}") && !notice.contains("current folder"), "{notice}");
        let (r, notice) = run_in(&dir, r"input:.\client +{MISSING} a.txt", true).unwrap();
        assert_eq!(r, vec!["./client/a.txt"], "an AND with a skipped side keeps the other side");
        assert!(notice.contains("{MISSING}"), "{notice}");
        // a place that does not exist is an error
        assert!(run(r"input:.\nope", true).unwrap_err().contains("not found"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn folder_size_search() {
        let base = std::env::temp_dir().join(format!("boonsh-foldersize-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("Big/sub/deep")).unwrap();
        fs::create_dir_all(base.join("Small")).unwrap();
        let write = |rel: &str, n: usize| fs::write(base.join(rel), vec![0u8; n]).unwrap();
        write("Big/a.bin", 3000);
        write("Big/sub/b.bin", 5000);
        write("Big/sub/deep/c.bin", 2000); // Big = 10000, sub = 7000, deep = 2000
        write("Small/x.bin", 100);
        write("loose.bin", 50_000);
        let dir = base.to_string_lossy().to_string();
        let run = |q: &str, sub: bool| {
            let mut names: Vec<(String, u64, String)> = search_blocking(&dir, &search::parse(q).unwrap(), sub, SEARCH_GENERATION.load(Ordering::SeqCst))
                .into_iter()
                .map(|i| (i.name, i.size, i.size_formatted))
                .collect();
            names.sort();
            names
        };

        let r = run("type:folder size:>5K", true);
        assert_eq!(r.iter().map(|x| (x.0.as_str(), x.1)).collect::<Vec<_>>(), vec![("./Big", 10_000), ("./Big/sub", 7_000)]);
        assert_eq!(r[0].2, "9.8 KB", "folder results show their total in the Size column");

        // Subfolders off: only top-level folders are results, but totals still include everything inside
        let r = run("type:folder size:>5K", false);
        assert_eq!(r.iter().map(|x| (x.0.as_str(), x.1)).collect::<Vec<_>>(), vec![("./Big", 10_000)]);

        let r = run("type:folder size:-1K", true);
        assert_eq!(r.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["./Small"]);

        // Without type:folder, size filters still match files only
        let r = run("size:>5K", true);
        assert_eq!(r.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["./loose.bin"]);

        fs::remove_dir_all(&base).unwrap();
    }
}
