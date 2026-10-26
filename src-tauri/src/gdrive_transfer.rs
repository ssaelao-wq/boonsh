//! Google Drive bidirectional transfer engine: uploads, downloads, Drive-to-Drive
//! server-side copies and moves, conflict detection, and progress reporting.

use chrono::DateTime;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::gdrive::{cache_folder_name, is_gdrive_path, parse_gdrive_id};
use crate::gdrive_auth::get_valid_access_token;
use crate::paste::{keep_both_name, rename_over, split_name, unix_secs, unregister_job, Choice, Clash, PasteResult, Progress};

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const DOC_MIME: &str = "application/vnd.google-apps.document";
const SHEET_MIME: &str = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME: &str = "application/vnd.google-apps.presentation";
const CANCELLED: &str = "cancelled";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GDriveItemMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub parents: Option<Vec<String>>,
    #[serde(default)]
    #[allow(dead_code)]
    pub trashed: Option<bool>,
}

pub(crate) struct AsyncCtx {
    pub job: u64,
    pub cancel: Arc<AtomicBool>,
    pub pause: Arc<AtomicBool>,
    pub app: AppHandle,
    pub interval: Duration,
    pub last: Instant,
    pub phase: &'static str,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub file_bytes: u64,
    pub done_items: usize,
    pub total_items: usize,
    pub current: String,
}

impl AsyncCtx {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub async fn wait_if_paused(&self) {
        while self.pause.load(Ordering::SeqCst) && !self.cancelled() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn report(&mut self, force: bool) {
        if !force && self.last.elapsed() < self.interval {
            return;
        }
        self.last = Instant::now();
        let _ = self.app.emit(
            "paste-progress",
            Progress {
                job: self.job,
                phase: self.phase,
                done_bytes: self.done_bytes + self.file_bytes,
                total_bytes: self.total_bytes,
                done_items: self.done_items,
                total_items: self.total_items,
                current: self.current.clone(),
                ahead: 0,
            },
        );
    }
}

struct JobGuard(u64);
impl Drop for JobGuard {
    fn drop(&mut self) {
        unregister_job(self.0);
    }
}

fn parse_rfc3339_to_unix(s: Option<&str>) -> i64 {
    s.and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

fn guess_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn doc_export_info(mime: &str, name: &str) -> Option<(&'static str, String)> {
    match mime {
        DOC_MIME => {
            let mut target_name = name.to_string();
            if !target_name.to_lowercase().ends_with(".docx") {
                target_name.push_str(".docx");
            }
            Some((
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                target_name,
            ))
        }
        SHEET_MIME => {
            let mut target_name = name.to_string();
            if !target_name.to_lowercase().ends_with(".xlsx") {
                target_name.push_str(".xlsx");
            }
            Some((
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                target_name,
            ))
        }
        SLIDES_MIME => {
            let mut target_name = name.to_string();
            if !target_name.to_lowercase().ends_with(".pptx") {
                target_name.push_str(".pptx");
            }
            Some((
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                target_name,
            ))
        }
        _ => None,
    }
}

fn gdrive_keep_both_name(existing_names: &mut HashSet<String>, name: &str, is_dir: bool) -> String {
    let (stem, ext) = split_name(name, is_dir);
    for n in 2u64.. {
        let candidate = format!("{}-{:02}{}", stem, n, ext);
        if !existing_names.contains(&candidate.to_lowercase()) {
            existing_names.insert(candidate.to_lowercase());
            return candidate;
        }
    }
    unreachable!()
}

async fn fetch_folder_children(
    client: &reqwest::Client,
    token: &str,
    folder_id: &str,
) -> Result<Vec<GDriveItemMeta>, String> {
    let query = format!("'{}' in parents and trashed = false", folder_id);
    let mut url = url::Url::parse("https://www.googleapis.com/drive/v3/files").unwrap();
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("fields", "files(id, name, mimeType, size, modifiedTime, parents)")
        .append_pair("pageSize", "1000")
        .append_pair("supportsAllDrives", "true")
        .append_pair("includeItemsFromAllDrives", "true");

    let resp = client
        .get(url.as_str())
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Network error querying Drive: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Drive API error: {}", err_text));
    }

    #[derive(Deserialize)]
    struct ListResp {
        #[serde(default)]
        files: Vec<GDriveItemMeta>,
    }
    let data: ListResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data.files)
}

async fn fetch_item_meta(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<GDriveItemMeta, String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?fields=id,name,mimeType,size,modifiedTime,parents&supportsAllDrives=true",
        file_id
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Network error querying Drive: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Drive item not found: {}", err_text));
    }

    let item: GDriveItemMeta = resp.json().await.map_err(|e| e.to_string())?;
    Ok(item)
}

async fn create_remote_folder(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    name: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "name": name,
        "mimeType": FOLDER_MIME,
        "parents": [parent_id]
    });

    let resp = client
        .post("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create Drive folder: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to create Drive folder: {}", err_text));
    }

    let created: GDriveItemMeta = resp.json().await.map_err(|e| e.to_string())?;
    cache_folder_name(&created.id, &created.name);
    Ok(created.id)
}

async fn trash_remote_item(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
) -> Result<(), String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?supportsAllDrives=true",
        file_id
    );
    let body = serde_json::json!({ "trashed": true });
    let resp = client
        .patch(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to trash Drive item: {}", e))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to trash Drive item: {}", err));
    }
    Ok(())
}

async fn upload_file_multipart(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    name: &str,
    src: &Path,
) -> Result<String, String> {
    let mime = guess_mime_type(src);
    let file_bytes = fs::read(src).map_err(|e| e.to_string())?;
    let boundary = "----BoonshUploadBoundary1234567890";
    let metadata = serde_json::json!({
        "name": name,
        "parents": [parent_id]
    })
    .to_string();

    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n",
            boundary, metadata
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("--{}\r\nContent-Type: {}\r\n\r\n", boundary, mime).as_bytes());
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
    let resp = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Multipart upload error: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Upload failed: {}", err_text));
    }

    let created: GDriveItemMeta = resp.json().await.map_err(|e| e.to_string())?;
    Ok(created.id)
}

async fn upload_file_resumable(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    name: &str,
    src: &Path,
    file_size: u64,
    ctx: &mut AsyncCtx,
) -> Result<String, String> {
    let mime = guess_mime_type(src);
    let init_url =
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
    let metadata = serde_json::json!({
        "name": name,
        "parents": [parent_id]
    });

    let resp = client
        .post(init_url)
        .bearer_auth(token)
        .header("X-Upload-Content-Type", mime)
        .header("X-Upload-Content-Length", file_size.to_string())
        .json(&metadata)
        .send()
        .await
        .map_err(|e| format!("Failed to initiate upload session: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to start upload: {}", err_text));
    }

    let session_url = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "No upload session location returned by Google Drive".to_string())?
        .to_string();

    const CHUNK_SIZE: usize = 8 * 1024 * 1024;
    let mut file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; CHUNK_SIZE];

    while offset < file_size {
        ctx.wait_if_paused().await;
        if ctx.cancelled() {
            let _ = client
                .delete(&session_url)
                .bearer_auth(token)
                .header("Content-Length", "0")
                .send()
                .await;
            return Err(CANCELLED.into());
        }

        use std::io::Read;
        let to_read = ((file_size - offset) as usize).min(CHUNK_SIZE);
        file.read_exact(&mut buf[..to_read])
            .map_err(|e| e.to_string())?;

        let start = offset;
        let end = offset + to_read as u64 - 1;
        let chunk_data = buf[..to_read].to_vec();

        let mut attempts = 0;
        let chunk_resp = loop {
            attempts += 1;
            let res = client
                .put(&session_url)
                .header("Content-Length", to_read.to_string())
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", start, end, file_size),
                )
                .body(chunk_data.clone())
                .send()
                .await;

            match res {
                Ok(r) if r.status().is_success() || r.status().as_u16() == 308 => break Ok(r),
                Ok(r) if attempts < 3 && r.status().is_server_error() => {
                    tokio::time::sleep(Duration::from_millis(500 * attempts)).await;
                    continue;
                }
                Ok(r) => {
                    let err_text = r.text().await.unwrap_or_default();
                    break Err(format!("Chunk upload failed: {}", err_text));
                }
                Err(_e) if attempts < 3 => {
                    tokio::time::sleep(Duration::from_millis(500 * attempts)).await;
                    continue;
                }
                Err(e) => break Err(format!("Chunk upload network error: {}", e)),
            }
        }?;

        offset += to_read as u64;
        ctx.file_bytes = offset;
        ctx.report(false);

        if offset >= file_size {
            let created: GDriveItemMeta = chunk_resp.json().await.map_err(|e| e.to_string())?;
            return Ok(created.id);
        }
    }

    Err("Upload completed without receiving file metadata".into())
}

async fn download_file_stream(
    client: &reqwest::Client,
    token: &str,
    download_url: &str,
    target_path: &Path,
    file_size: u64,
    ctx: &mut AsyncCtx,
) -> Result<(), String> {
    let part_path = target_path.with_file_name(format!(
        "{}.boonsh-part",
        target_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));

    let resp = client
        .get(download_url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Download failed: {}", err_text));
    }

    let mut file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
    let mut resp = resp;
    let mut downloaded_bytes = 0u64;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        ctx.wait_if_paused().await;
        if ctx.cancelled() {
            drop(file);
            let _ = fs::remove_file(&part_path);
            return Err(CANCELLED.into());
        }

        use std::io::Write;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded_bytes += chunk.len() as u64;
        ctx.file_bytes = downloaded_bytes;
        ctx.report(false);
    }

    drop(file);
    rename_over(&part_path, target_path)?;
    ctx.done_bytes += if file_size > 0 { file_size } else { downloaded_bytes };
    ctx.file_bytes = 0;
    ctx.report(false);
    Ok(())
}

async fn gdrive_copy_file(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
    dest_folder_id: &str,
    new_name: &str,
) -> Result<String, String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}/copy?supportsAllDrives=true",
        file_id
    );
    let body = serde_json::json!({
        "name": new_name,
        "parents": [dest_folder_id]
    });
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Drive copy request failed: {}", e))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Drive copy failed: {}", err));
    }
    let created: GDriveItemMeta = resp.json().await.map_err(|e| e.to_string())?;
    Ok(created.id)
}

async fn gdrive_move_item(
    client: &reqwest::Client,
    token: &str,
    file_id: &str,
    dest_folder_id: &str,
    old_parent_id: &str,
    new_name: &str,
) -> Result<(), String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?addParents={}&removeParents={}&supportsAllDrives=true",
        file_id, dest_folder_id, old_parent_id
    );
    let body = serde_json::json!({ "name": new_name });
    let resp = client
        .patch(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Drive move request failed: {}", e))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(format!("Drive move failed: {}", err));
    }
    Ok(())
}

/// Recursively measures total bytes of a local path.
fn measure_local_path(p: &Path, ctx: &mut AsyncCtx) -> Result<u64, String> {
    if ctx.cancelled() {
        return Err(CANCELLED.into());
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
            sum += measure_local_path(&e.path(), ctx)?;
        }
    }
    Ok(sum)
}

/// Recursively measures total bytes of a Google Drive folder.
async fn measure_gdrive_folder(
    client: &reqwest::Client,
    token: &str,
    folder_id: &str,
    ctx: &mut AsyncCtx,
) -> Result<u64, String> {
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }
    ctx.report(false);
    let children = fetch_folder_children(client, token, folder_id).await?;
    let mut sum = 0u64;
    for c in children {
        if ctx.cancelled() {
            return Err(CANCELLED.into());
        }
        let is_dir = c.mime_type.as_deref() == Some(FOLDER_MIME);
        if is_dir {
            sum += Box::pin(measure_gdrive_folder(client, token, &c.id, ctx)).await?;
        } else {
            let size = c.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            sum += size;
        }
    }
    Ok(sum)
}

/// Check for name clashes when one or both sides involve Google Drive.
pub async fn gdrive_paste_check(paths: Vec<String>, dest_dir: String) -> Result<Vec<Clash>, String> {
    let dest_is_gdrive = is_gdrive_path(&dest_dir);
    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();
    let mut clashes = Vec::new();
    let mut earlier: HashMap<String, String> = HashMap::new();

    if dest_is_gdrive {
        let dest_folder_id = parse_gdrive_id(&dest_dir);
        let dest_children = fetch_folder_children(&client, &token, dest_folder_id).await?;
        let mut dest_items_map: HashMap<String, GDriveItemMeta> = HashMap::new();
        for item in dest_children {
            dest_items_map.insert(item.name.to_lowercase(), item);
        }

        for src in &paths {
            let (name, is_dir, size, modified) = if is_gdrive_path(src) {
                let id = parse_gdrive_id(src);
                let meta = fetch_item_meta(&client, &token, id).await?;
                if meta.parents.as_ref().is_some_and(|p| p.contains(&dest_folder_id.to_string())) {
                    continue; // In its own folder
                }
                let is_dir = meta.mime_type.as_deref() == Some(FOLDER_MIME);
                let size = meta.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let modified = parse_rfc3339_to_unix(meta.modified_time.as_deref());
                (meta.name, is_dir, size, modified)
            } else {
                let p = Path::new(src);
                let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
                let Ok(m) = fs::metadata(p) else { continue };
                let is_dir = m.is_dir();
                let size = if is_dir { 0 } else { m.len() };
                let modified = unix_secs(&m);
                (name, is_dir, size, modified)
            };

            let key = name.to_lowercase();
            if let Some(first_src) = earlier.get(&key) {
                clashes.push(Clash {
                    source: src.clone(),
                    target: first_src.clone(),
                    name: name.clone(),
                    source_is_dir: is_dir,
                    target_is_dir: is_dir,
                    source_size: size,
                    target_size: size,
                    source_modified: modified,
                    target_modified: modified,
                    in_paste: true,
                });
            } else if let Some(existing) = dest_items_map.get(&key) {
                let target_is_dir = existing.mime_type.as_deref() == Some(FOLDER_MIME);
                let target_size = existing.size.as_deref().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let target_modified = parse_rfc3339_to_unix(existing.modified_time.as_deref());
                clashes.push(Clash {
                    source: src.clone(),
                    target: format!("gdrive://{}", existing.id),
                    name: name.clone(),
                    source_is_dir: is_dir,
                    target_is_dir,
                    source_size: size,
                    target_size,
                    source_modified: modified,
                    target_modified,
                    in_paste: false,
                });
            }
            earlier.entry(key).or_insert_with(|| src.clone());
        }
    } else {
        // Destination is local, but sources contain Google Drive items
        let dest_path = Path::new(&dest_dir);
        for src in &paths {
            let (name, is_dir, size, modified) = if is_gdrive_path(src) {
                let id = parse_gdrive_id(src);
                let meta = fetch_item_meta(&client, &token, id).await?;
                let mime = meta.mime_type.as_deref().unwrap_or("");
                let is_dir = mime == FOLDER_MIME;
                let adjusted_name = if let Some((_, export_name)) = doc_export_info(mime, &meta.name) {
                    export_name
                } else {
                    meta.name
                };
                let size = meta.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                let modified = parse_rfc3339_to_unix(meta.modified_time.as_deref());
                (adjusted_name, is_dir, size, modified)
            } else {
                let p = Path::new(src);
                let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
                let Ok(m) = fs::metadata(p) else { continue };
                let is_dir = m.is_dir();
                let size = if is_dir { 0 } else { m.len() };
                let modified = unix_secs(&m);
                (name, is_dir, size, modified)
            };

            let key = name.to_lowercase();
            let target_file = dest_path.join(&name);
            if let Some(first_src) = earlier.get(&key) {
                clashes.push(Clash {
                    source: src.clone(),
                    target: first_src.clone(),
                    name: name.clone(),
                    source_is_dir: is_dir,
                    target_is_dir: is_dir,
                    source_size: size,
                    target_size: size,
                    source_modified: modified,
                    target_modified: modified,
                    in_paste: true,
                });
            } else if target_file.exists() {
                if let Ok(tm) = fs::metadata(&target_file) {
                    let target_is_dir = tm.is_dir();
                    let target_size = if target_is_dir { 0 } else { tm.len() };
                    let target_modified = unix_secs(&tm);
                    clashes.push(Clash {
                        source: src.clone(),
                        target: target_file.to_string_lossy().to_string(),
                        name: name.clone(),
                        source_is_dir: is_dir,
                        target_is_dir,
                        source_size: size,
                        target_size,
                        source_modified: modified,
                        target_modified,
                        in_paste: false,
                    });
                }
            }
            earlier.entry(key).or_insert_with(|| src.clone());
        }
    }

    Ok(clashes)
}

/// Upload a local item (file or folder) to a Google Drive folder.
async fn upload_item(
    client: &reqwest::Client,
    token: &str,
    src: &Path,
    dest_folder_id: &str,
    is_move: bool,
    choice: Choice,
    dest_items_map: &mut HashMap<String, GDriveItemMeta>,
    ctx: &mut AsyncCtx,
) -> Result<Option<String>, String> {
    ctx.wait_if_paused().await;
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }

    let name = src
        .file_name()
        .ok_or_else(|| "Invalid source filename".to_string())?
        .to_string_lossy()
        .to_string();
    let is_dir = src.is_dir();
    let key = name.to_lowercase();

    let target_name = if let Some(existing) = dest_items_map.get(&key) {
        match choice {
            Choice::Skip => return Ok(None),
            Choice::Keep => {
                let mut existing_names: HashSet<String> = dest_items_map.keys().cloned().collect();
                gdrive_keep_both_name(&mut existing_names, &name, is_dir)
            }
            Choice::Replace => {
                let existing_is_dir = existing.mime_type.as_deref() == Some(FOLDER_MIME);
                if is_dir && existing_is_dir {
                    // Merge folders: reuse existing remote folder ID
                    let target_id = existing.id.clone();
                    upload_folder_contents(client, token, src, &target_id, is_move, choice, ctx).await?;
                    if is_move {
                        let _ = trash::delete(src);
                    }
                    return Ok(Some(format!("gdrive://{}", target_id)));
                } else {
                    // Trash existing conflicting file or folder
                    trash_remote_item(client, token, &existing.id).await?;
                    dest_items_map.remove(&key);
                    name.clone()
                }
            }
        }
    } else {
        name.clone()
    };

    if is_dir {
        let new_folder_id = create_remote_folder(client, token, dest_folder_id, &target_name).await?;
        upload_folder_contents(client, token, src, &new_folder_id, is_move, choice, ctx).await?;
        if is_move {
            let _ = trash::delete(src);
        }
        Ok(Some(format!("gdrive://{}", new_folder_id)))
    } else {
        let file_size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        ctx.current = target_name.clone();
        ctx.file_bytes = 0;
        ctx.report(false);

        let created_id = if file_size <= 5 * 1024 * 1024 {
            let id = upload_file_multipart(client, token, dest_folder_id, &target_name, src).await?;
            ctx.done_bytes += file_size;
            ctx.file_bytes = 0;
            ctx.report(false);
            id
        } else {
            upload_file_resumable(client, token, dest_folder_id, &target_name, src, file_size, ctx).await?
        };

        if is_move {
            let _ = trash::delete(src);
        }
        Ok(Some(format!("gdrive://{}", created_id)))
    }
}

async fn upload_folder_contents(
    client: &reqwest::Client,
    token: &str,
    src_dir: &Path,
    dest_folder_id: &str,
    is_move: bool,
    choice: Choice,
    ctx: &mut AsyncCtx,
) -> Result<(), String> {
    let children = fetch_folder_children(client, token, dest_folder_id).await?;
    let mut map: HashMap<String, GDriveItemMeta> = children.into_iter().map(|c| (c.name.to_lowercase(), c)).collect();

    for entry in fs::read_dir(src_dir).map_err(|e| e.to_string())? {
        if ctx.cancelled() {
            return Err(CANCELLED.into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let _ = Box::pin(upload_item(
            client,
            token,
            &entry.path(),
            dest_folder_id,
            is_move,
            choice,
            &mut map,
            ctx,
        ))
        .await?;
    }
    Ok(())
}

/// Download an item from Google Drive to a local directory.
async fn download_item(
    client: &reqwest::Client,
    token: &str,
    gdrive_uri: &str,
    dest_local_dir: &Path,
    is_move: bool,
    choice: Choice,
    ctx: &mut AsyncCtx,
) -> Result<Option<String>, String> {
    ctx.wait_if_paused().await;
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }

    let file_id = parse_gdrive_id(gdrive_uri);
    let meta = fetch_item_meta(client, token, file_id).await?;
    let mime = meta.mime_type.as_deref().unwrap_or("");
    let is_dir = mime == FOLDER_MIME;

    let (export_mime, name) = if let Some((em, en)) = doc_export_info(mime, &meta.name) {
        (Some(em), en)
    } else {
        (None, meta.name)
    };

    let first = dest_local_dir.join(&name);
    let target_path = if !first.exists() {
        first
    } else {
        match choice {
            Choice::Skip => return Ok(None),
            Choice::Keep => keep_both_name(dest_local_dir, &name, is_dir),
            Choice::Replace => first,
        }
    };

    if is_dir {
        fs::create_dir_all(&target_path).map_err(|e| e.to_string())?;
        let children = fetch_folder_children(client, token, file_id).await?;
        for child in children {
            if ctx.cancelled() {
                return Err(CANCELLED.into());
            }
            let child_uri = format!("gdrive://{}", child.id);
            let _ = Box::pin(download_item(client, token, &child_uri, &target_path, is_move, choice, ctx)).await?;
        }
        if is_move {
            trash_remote_item(client, token, file_id).await?;
        }
        Ok(Some(target_path.to_string_lossy().to_string()))
    } else {
        let file_size = meta.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        ctx.current = name.clone();
        ctx.file_bytes = 0;
        ctx.report(false);

        let download_url = if let Some(em) = export_mime {
            format!(
                "https://www.googleapis.com/drive/v3/files/{}/export?mimeType={}&supportsAllDrives=true",
                file_id, em
            )
        } else {
            format!(
                "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                file_id
            )
        };

        download_file_stream(client, token, &download_url, &target_path, file_size, ctx).await?;

        if is_move {
            trash_remote_item(client, token, file_id).await?;
        }
        Ok(Some(target_path.to_string_lossy().to_string()))
    }
}

/// Server-side copy or move between Google Drive locations.
async fn gdrive_to_gdrive_item(
    client: &reqwest::Client,
    token: &str,
    src_uri: &str,
    dest_folder_id: &str,
    is_move: bool,
    choice: Choice,
    dest_items_map: &mut HashMap<String, GDriveItemMeta>,
    ctx: &mut AsyncCtx,
) -> Result<Option<String>, String> {
    ctx.wait_if_paused().await;
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }

    let file_id = parse_gdrive_id(src_uri);
    let meta = fetch_item_meta(client, token, file_id).await?;
    let is_dir = meta.mime_type.as_deref() == Some(FOLDER_MIME);
    let name = meta.name.clone();
    let key = name.to_lowercase();

    let old_parent = meta
        .parents
        .as_ref()
        .and_then(|p| p.first())
        .cloned()
        .unwrap_or_else(|| "root".to_string());

    if old_parent == dest_folder_id {
        if is_move {
            return Ok(None); // Move to own folder is a no-op
        }
    }

    let target_name = if let Some(existing) = dest_items_map.get(&key) {
        match choice {
            Choice::Skip => return Ok(None),
            Choice::Keep => {
                let mut existing_names: HashSet<String> = dest_items_map.keys().cloned().collect();
                gdrive_keep_both_name(&mut existing_names, &name, is_dir)
            }
            Choice::Replace => {
                trash_remote_item(client, token, &existing.id).await?;
                dest_items_map.remove(&key);
                name.clone()
            }
        }
    } else {
        name.clone()
    };

    ctx.current = target_name.clone();
    ctx.report(false);

    if is_move {
        gdrive_move_item(client, token, file_id, dest_folder_id, &old_parent, &target_name).await?;
        Ok(Some(format!("gdrive://{}", file_id)))
    } else if is_dir {
        // Recursive folder copy
        let new_folder_id = create_remote_folder(client, token, dest_folder_id, &target_name).await?;
        let children = fetch_folder_children(client, token, file_id).await?;
        let mut child_map: HashMap<String, GDriveItemMeta> = HashMap::new();
        for child in children {
            if ctx.cancelled() {
                return Err(CANCELLED.into());
            }
            let child_uri = format!("gdrive://{}", child.id);
            let _ = Box::pin(gdrive_to_gdrive_item(
                client,
                token,
                &child_uri,
                &new_folder_id,
                false,
                choice,
                &mut child_map,
                ctx,
            ))
            .await?;
        }
        Ok(Some(format!("gdrive://{}", new_folder_id)))
    } else {
        let new_id = gdrive_copy_file(client, token, file_id, dest_folder_id, &target_name).await?;
        let file_size = meta.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        ctx.done_bytes += file_size;
        ctx.report(false);
        Ok(Some(format!("gdrive://{}", new_id)))
    }
}

/// Execute a paste job involving Google Drive (Upload, Download, or Drive-to-Drive).
pub async fn gdrive_paste_items(
    app: AppHandle,
    paths: Vec<String>,
    dest_dir: String,
    mode: String,
    choices: HashMap<String, Choice>,
    job: u64,
) -> Result<PasteResult, String> {
    let flags = crate::paste::register_job(job);
    let _guard = JobGuard(job);

    let mut ctx = AsyncCtx {
        job,
        cancel: flags.cancel.clone(),
        pause: flags.pause.clone(),
        app: app.clone(),
        interval: Duration::from_millis(100),
        last: Instant::now(),
        phase: "count",
        total_bytes: 0,
        done_bytes: 0,
        file_bytes: 0,
        done_items: 0,
        total_items: paths.len(),
        current: String::new(),
    };

    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();
    let is_move = mode == "cut";
    let dest_is_gdrive = is_gdrive_path(&dest_dir);

    // Phase: "count"
    ctx.phase = "count";
    ctx.report(true);

    for src in &paths {
        if ctx.cancelled() {
            return Ok(PasteResult { cancelled: true, ..Default::default() });
        }
        let choice = choices.get(src).copied().unwrap_or(Choice::Keep);
        if choice == Choice::Skip {
            continue;
        }

        if is_gdrive_path(src) {
            let id = parse_gdrive_id(src);
            if let Ok(meta) = fetch_item_meta(&client, &token, id).await {
                if meta.mime_type.as_deref() == Some(FOLDER_MIME) {
                    if let Ok(dir_size) = measure_gdrive_folder(&client, &token, id, &mut ctx).await {
                        ctx.total_bytes += dir_size;
                    }
                } else {
                    let size = meta.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                    ctx.total_bytes += size;
                }
            }
        } else {
            let p = Path::new(src);
            if let Ok(size) = measure_local_path(p, &mut ctx) {
                ctx.total_bytes += size;
            }
        }
    }

    if ctx.cancelled() {
        return Ok(PasteResult { cancelled: true, ..Default::default() });
    }

    // Phase: "copy"
    ctx.phase = "copy";
    ctx.report(true);

    let mut res = PasteResult::default();

    if dest_is_gdrive {
        let dest_folder_id = parse_gdrive_id(&dest_dir);
        let dest_children = fetch_folder_children(&client, &token, dest_folder_id).await.unwrap_or_default();
        let mut dest_items_map: HashMap<String, GDriveItemMeta> = dest_children
            .into_iter()
            .map(|c| (c.name.to_lowercase(), c))
            .collect();

        for src in &paths {
            if ctx.cancelled() {
                res.cancelled = true;
                break;
            }
            let choice = choices.get(src).copied().unwrap_or(Choice::Keep);
            let outcome = if is_gdrive_path(src) {
                gdrive_to_gdrive_item(
                    &client,
                    &token,
                    src,
                    dest_folder_id,
                    is_move,
                    choice,
                    &mut dest_items_map,
                    &mut ctx,
                )
                .await
            } else {
                upload_item(
                    &client,
                    &token,
                    Path::new(src),
                    dest_folder_id,
                    is_move,
                    choice,
                    &mut dest_items_map,
                    &mut ctx,
                )
                .await
            };

            match outcome {
                Ok(Some(target_path)) => {
                    if is_move {
                        res.moved.push((src.clone(), target_path.clone()));
                    }
                    res.pasted.push(target_path);
                }
                Ok(None) => res.skipped += 1,
                Err(e) if e == CANCELLED => {
                    res.cancelled = true;
                    break;
                }
                Err(e) => res.errors.push(format!("'{}': {}", src, e)),
            }

            ctx.done_items += 1;
            ctx.report(false);
        }
    } else {
        // Destination is local; sources are from Google Drive
        let dest_local_path = PathBuf::from(&dest_dir);
        if !dest_local_path.is_dir() {
            res.errors.push(format!("Destination is not a folder: {}", dest_dir));
            return Ok(res);
        }

        for src in &paths {
            if ctx.cancelled() {
                res.cancelled = true;
                break;
            }
            let choice = choices.get(src).copied().unwrap_or(Choice::Keep);
            let outcome = if is_gdrive_path(src) {
                download_item(
                    &client,
                    &token,
                    src,
                    &dest_local_path,
                    is_move,
                    choice,
                    &mut ctx,
                )
                .await
            } else {
                // Local to local inside a mixed paste: delegate to local paste_one
                Err("Mixed local item in cloud paste is unsupported".to_string())
            };

            match outcome {
                Ok(Some(target_path)) => {
                    if is_move {
                        res.moved.push((src.clone(), target_path.clone()));
                    }
                    res.pasted.push(target_path);
                }
                Ok(None) => res.skipped += 1,
                Err(e) if e == CANCELLED => {
                    res.cancelled = true;
                    break;
                }
                Err(e) => res.errors.push(format!("'{}': {}", src, e)),
            }

            ctx.done_items += 1;
            ctx.report(false);
        }
    }

    // Phase: "done"
    ctx.phase = "done";
    ctx.current.clear();
    ctx.report(true);

    Ok(res)
}

/// Download or export a Google Drive file directly to a local LAN staging directory.
/// If the file is a Google Doc, Sheet, or Slide, it is automatically exported as a PDF.
pub async fn download_gdrive_to_lan_as_pdf(gdrive_uri: &str, dest_local_dir: &Path) -> Result<Option<String>, String> {
    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();
    let file_id = parse_gdrive_id(gdrive_uri);
    let meta = fetch_item_meta(&client, &token, file_id).await?;
    let mime = meta.mime_type.as_deref().unwrap_or("");

    let (download_url, name) = match mime {
        DOC_MIME | SHEET_MIME | SLIDES_MIME => {
            let mut target_name = meta.name.clone();
            if !target_name.to_lowercase().ends_with(".pdf") {
                target_name.push_str(".pdf");
            }
            let url = format!(
                "https://www.googleapis.com/drive/v3/files/{}/export?mimeType=application/pdf&supportsAllDrives=true",
                file_id
            );
            (url, target_name)
        }
        _ => {
            let url = format!(
                "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                file_id
            );
            (url, meta.name.clone())
        }
    };

    // Drive names are not real filenames (no rule against a `/` or `..` in one): keep only the last component,
    // the same way a local path's file name is taken, so this can never land outside `dest_local_dir`.
    let safe_name = Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("{}.pdf", file_id));
    // And re-sharing the same Drive file should add another copy, not silently erase the one already staged.
    let target_path = keep_both_name(dest_local_dir, &safe_name, false);
    let resp = client.get(&download_url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status: {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    fs::write(&target_path, &bytes).map_err(|e| e.to_string())?;
    Ok(Some(target_path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_guess_mime_type() {
        assert_eq!(guess_mime_type(Path::new("file.txt")), "text/plain");
        assert_eq!(guess_mime_type(Path::new("image.png")), "image/png");
        assert_eq!(guess_mime_type(Path::new("photo.jpeg")), "image/jpeg");
        assert_eq!(guess_mime_type(Path::new("doc.pdf")), "application/pdf");
        assert_eq!(guess_mime_type(Path::new("unknown.xyz123")), "application/octet-stream");
    }

    #[test]
    fn test_doc_export_info() {
        let (mime, name) = doc_export_info(DOC_MIME, "Meeting Notes").unwrap();
        assert_eq!(mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        assert_eq!(name, "Meeting Notes.docx");

        let (mime2, name2) = doc_export_info(SHEET_MIME, "Budget.xlsx").unwrap();
        assert_eq!(mime2, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        assert_eq!(name2, "Budget.xlsx");

        let (mime3, name3) = doc_export_info(SLIDES_MIME, "Pitch").unwrap();
        assert_eq!(mime3, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        assert_eq!(name3, "Pitch.pptx");

        assert!(doc_export_info("application/pdf", "regular.pdf").is_none());
    }

    #[test]
    fn test_gdrive_keep_both_name() {
        let mut existing = HashSet::new();
        existing.insert("report.pdf".to_string());
        let candidate1 = gdrive_keep_both_name(&mut existing, "report.pdf", false);
        assert_eq!(candidate1, "report-02.pdf");

        let candidate2 = gdrive_keep_both_name(&mut existing, "report.pdf", false);
        assert_eq!(candidate2, "report-03.pdf");

        let mut existing_folders = HashSet::new();
        existing_folders.insert("photos.2024".to_string());
        let candidate_folder = gdrive_keep_both_name(&mut existing_folders, "Photos.2024", true);
        assert_eq!(candidate_folder, "Photos.2024-02");
    }

    #[test]
    fn test_parse_rfc3339_to_unix() {
        assert_eq!(parse_rfc3339_to_unix(Some("1970-01-01T00:00:00Z")), 0);
        assert_eq!(parse_rfc3339_to_unix(Some("2026-10-25T12:00:00Z")), 1792929600);
        assert_eq!(parse_rfc3339_to_unix(None), 0);
        assert_eq!(parse_rfc3339_to_unix(Some("invalid-date")), 0);
    }
}

