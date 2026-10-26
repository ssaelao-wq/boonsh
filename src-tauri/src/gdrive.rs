//! Google Drive API v3 operations: folder listing, item creation, renaming,
//! and moving items to trash.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::fs_ops::{self, FileItem, FileListResult};
use crate::gdrive_auth::get_valid_access_token;

static FOLDER_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct GDriveFileListResponse {
    #[serde(default)]
    files: Vec<GDriveItemResponse>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct GDriveItemResponse {
    id: String,
    name: String,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    modified_time: Option<String>,
    #[serde(default)]
    created_time: Option<String>,
    #[serde(default)]
    parents: Option<Vec<String>>,
    #[serde(default)]
    trashed: Option<bool>,
}

pub(crate) fn cache_folder_name(id: &str, name: &str) {
    let mut guard = FOLDER_CACHE.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(id.to_string(), name.to_string());
}

#[allow(dead_code)]
pub fn get_cached_folder_name(id: &str) -> Option<String> {
    let guard = FOLDER_CACHE.lock().unwrap();
    guard.as_ref().and_then(|m| m.get(id).cloned())
}

/// Check if a path string points to Google Drive
pub fn is_gdrive_path(p: &str) -> bool {
    p.starts_with("gdrive://") || p.starts_with("gdrive:")
}

/// Get cached folder display name for breadcrumbs.
#[tauri::command]
pub fn gdrive_get_folder_name(path: String) -> Option<String> {
    let id = parse_gdrive_id(&path);
    if id == "root" {
        return Some("My Drive".to_string());
    }
    get_cached_folder_name(id)
}

/// `tree_has_children` (fs_ops.rs) for a Drive folder: one request per folder (`pageSize=1`, only the id
/// field), run concurrently, not one combined query — a combined `('a' in parents or 'b' in parents) ...`
/// query shares one `pageSize` across every folder asked, so a single busy folder could fill the page and
/// make the other, genuinely non-empty ones look empty too. Used so the folder tree's expand arrow on a Drive
/// subfolder means something, instead of (before this) always showing one whether or not there was anything
/// to expand.
#[tauri::command]
pub async fn gdrive_has_children(paths: Vec<String>) -> Result<Vec<bool>, String> {
    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();

    let mut set = tokio::task::JoinSet::new();
    for (idx, path) in paths.iter().enumerate() {
        let client = client.clone();
        let token = token.clone();
        let folder_id = parse_gdrive_id(path).to_string();
        set.spawn(async move {
            let query = format!("'{}' in parents and trashed = false", folder_id);
            let mut url = url::Url::parse("https://www.googleapis.com/drive/v3/files").unwrap();
            url.query_pairs_mut()
                .append_pair("q", &query)
                .append_pair("fields", "files(id)")
                .append_pair("pageSize", "1")
                .append_pair("supportsAllDrives", "true")
                .append_pair("includeItemsFromAllDrives", "true");

            #[derive(Deserialize, Default)]
            struct OneField {
                #[serde(default)]
                files: Vec<serde_json::Value>,
            }
            let has = match send_with_retry(|| client.get(url.as_str()).bearer_auth(&token).send()).await {
                Ok(resp) if resp.status().is_success() => resp
                    .json::<OneField>()
                    .await
                    .map(|r| !r.files.is_empty())
                    .unwrap_or(false),
                _ => false,
            };
            (idx, has)
        });
    }

    let mut results = vec![false; paths.len()];
    while let Some(res) = set.join_next().await {
        if let Ok((idx, has)) = res {
            results[idx] = has;
        }
    }
    Ok(results)
}

#[derive(Serialize, Debug, Clone)]
pub struct GDriveBreadcrumb {
    pub path: String,
    pub name: String,
}

/// The chain of folder names from (but not including) My Drive down to `path`, for the full breadcrumb trail
/// ("Google Drive > Development > Unicon_Container > Phase2" instead of just the last folder). Drive ids are
/// opaque (not nested strings like a local path), so this walks the `parents` link up one folder at a time.
#[tauri::command]
pub async fn gdrive_get_breadcrumbs(path: String) -> Result<Vec<GDriveBreadcrumb>, String> {
    let folder_id = parse_gdrive_id(&path).to_string();
    if folder_id == "root" {
        return Ok(Vec::new());
    }

    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();
    let mut chain: Vec<GDriveBreadcrumb> = Vec::new();
    let mut current = folder_id;

    // A cap in case of a cyclic or very deep share structure: this is a trail for display, not a full walk.
    for _ in 0..25 {
        let info_url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?fields=id,name,parents&supportsAllDrives=true",
            current
        );
        let resp = match send_with_retry(|| client.get(&info_url).bearer_auth(&token).send()).await {
            Ok(r) if r.status().is_success() => r,
            // A folder further up that failed to load (removed, no access) just ends the trail there; what we
            // already have is still a useful breadcrumb.
            _ => break,
        };
        let Ok(item) = resp.json::<GDriveItemResponse>().await else { break };
        // The API never actually echoes back the literal string "root" as a parent id (that is only a
        // client-side shorthand for request URLs) — it reports the account's real backing folder id instead.
        // A folder with no `parents` at all is how that real root folder identifies itself, so it is where
        // the walk stops; it is never pushed as its own segment, since "Google Drive" already stands for it.
        let Some(parent_id) = item.parents.as_ref().and_then(|p| p.first()).cloned() else {
            break;
        };
        cache_folder_name(&item.id, &item.name);
        let this_id = item.id.clone();
        chain.push(GDriveBreadcrumb {
            path: format!("gdrive://{}", item.id),
            name: item.name,
        });

        if parent_id == this_id {
            break; // a cyclic/self-referencing parent; nothing further up is meaningful to show
        }
        current = parent_id;
    }

    chain.reverse();
    Ok(chain)
}

pub(crate) async fn send_with_retry<F, Fut>(f: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let mut attempts = 0;
    loop {
        attempts += 1;
        match f().await {
            Ok(resp) => {
                let status = resp.status();
                if (status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempts < 3 {
                    let delay = std::time::Duration::from_millis(500 * (1 << (attempts - 1)));
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Ok(resp);
            }
            Err(_e) if attempts < 3 => {
                let delay = std::time::Duration::from_millis(500 * (1 << (attempts - 1)));
                tokio::time::sleep(delay).await;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Extract clean folder ID from a `gdrive://<id>` URI.
pub fn parse_gdrive_id(uri: &str) -> &str {
    let stripped = if let Some(rest) = uri.strip_prefix("gdrive://") {
        rest
    } else if let Some(rest) = uri.strip_prefix("gdrive:") {
        rest
    } else {
        uri
    };

    let id = stripped.split(['?', '#']).next().unwrap_or(stripped).trim_matches('/');
    if id.is_empty() || id.eq_ignore_ascii_case("root") || id.eq_ignore_ascii_case("my drive") {
        "root"
    } else {
        id
    }
}

/// List the contents of a Google Drive folder as a boonsh FileListResult.
pub async fn list_gdrive_directory(raw_path: &str) -> Result<FileListResult, String> {
    let token = get_valid_access_token().await?;
    let folder_id = parse_gdrive_id(raw_path);
    let client = reqwest::Client::new();

    // Determine parent_path and current folder display name
    let (current_path, parent_path, folder_name) = if folder_id == "root" {
        cache_folder_name("root", "My Drive");
        ("gdrive://root".to_string(), None, "My Drive".to_string())
    } else {
        // Query folder info to discover its parent folder and name
        let info_url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?fields=id,name,parents&supportsAllDrives=true",
            folder_id
        );
        let resp = send_with_retry(|| client.get(&info_url).bearer_auth(&token).send())
            .await
            .map_err(|e| format!("Failed to read Google Drive folder info: {}", e))?;

        if !resp.status().is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("Google Drive folder not found or inaccessible: {}", err_text));
        }

        let item: GDriveItemResponse = resp.json().await.map_err(|e| e.to_string())?;
        cache_folder_name(&item.id, &item.name);

        let parent = match item.parents.and_then(|p| p.into_iter().next()) {
            Some(pid) if pid == "root" => Some("gdrive://root".to_string()),
            Some(pid) => Some(format!("gdrive://{}", pid)),
            None => Some("gdrive://root".to_string()),
        };

        (format!("gdrive://{}", folder_id), parent, item.name)
    };

    // Query folder children
    let query = format!("'{}' in parents and trashed = false", folder_id);
    let mut url = url::Url::parse("https://www.googleapis.com/drive/v3/files").unwrap();
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("fields", "nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, parents)")
        .append_pair("pageSize", "1000")
        .append_pair("supportsAllDrives", "true")
        .append_pair("includeItemsFromAllDrives", "true");

    let resp = send_with_retry(|| client.get(url.as_str()).bearer_auth(&token).send())
        .await
        .map_err(|e| format!("Failed to list Google Drive files: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Google Drive API error: {}", err_text));
    }

    let list_resp: GDriveFileListResponse = resp.json().await.map_err(|e| e.to_string())?;

    let mut items = Vec::with_capacity(list_resp.files.len());
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size = 0u64;

    for f in list_resp.files {
        let is_dir = f.mime_type.as_deref() == Some("application/vnd.google-apps.folder");
        let size = f.size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

        if is_dir {
            total_folders += 1;
            cache_folder_name(&f.id, &f.name);
        } else {
            total_files += 1;
            total_size += size;
        }

        let modified_timestamp = f
            .modified_time
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp() as u64)
            .unwrap_or(0);

        let created_timestamp = f
            .created_time
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp() as u64)
            .unwrap_or(0);

        let ext = if is_dir {
            String::new()
        } else {
            match f.mime_type.as_deref() {
                Some("application/vnd.google-apps.document") => "gdoc".to_string(),
                Some("application/vnd.google-apps.spreadsheet") => "gsheet".to_string(),
                Some("application/vnd.google-apps.presentation") => "gslides".to_string(),
                _ => Path::new(&f.name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase(),
            }
        };

        let is_hidden = f.name.starts_with('.');
        let item_path = format!("gdrive://{}", f.id);

        items.push(FileItem {
            name: f.name,
            path: item_path,
            is_dir,
            size,
            size_formatted: fs_ops::format_size(size, is_dir),
            modified: fs_ops::format_time(modified_timestamp),
            modified_timestamp,
            created: fs_ops::format_time(created_timestamp),
            created_timestamp,
            ext,
            is_hidden,
            links: None,
            state: None,
        });
    }

    // Sort: directories first, then natural numerical/case-insensitive sorting
    items.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    let _ = folder_name; // kept in cache

    Ok(FileListResult {
        current_path,
        parent_path,
        items,
        total_files,
        total_folders,
        total_size,
    })
}

/// Create a new folder on Google Drive.
#[tauri::command]
pub async fn gdrive_create_folder(parent_dir: String, name: String) -> Result<String, String> {
    let token = get_valid_access_token().await?;
    let parent_id = parse_gdrive_id(&parent_dir);
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Folder name cannot be empty.".to_string());
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "name": trimmed_name,
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_id]
    });

    let resp = send_with_retry(|| {
        client
            .post("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true")
            .bearer_auth(&token)
            .json(&body)
            .send()
    })
    .await
    .map_err(|e| format!("Failed to create Google Drive folder: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to create folder on Google Drive: {}", err_text));
    }

    let created: GDriveItemResponse = resp.json().await.map_err(|e| e.to_string())?;
    cache_folder_name(&created.id, &created.name);
    Ok(format!("gdrive://{}", created.id))
}

/// Rename a file or folder on Google Drive.
#[tauri::command]
pub async fn gdrive_rename(path: String, new_name: String) -> Result<(), String> {
    let token = get_valid_access_token().await?;
    let file_id = parse_gdrive_id(&path);
    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        return Err("Name cannot be empty.".to_string());
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "name": trimmed_name
    });

    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?supportsAllDrives=true",
        file_id
    );
    let resp = send_with_retry(|| {
        client
            .patch(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
    })
    .await
    .map_err(|e| format!("Failed to rename item on Google Drive: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Failed to rename item on Google Drive: {}", err_text));
    }

    cache_folder_name(file_id, trimmed_name);
    Ok(())
}

/// Move files or folders on Google Drive to Trash.
#[tauri::command]
pub async fn gdrive_delete(paths: Vec<String>) -> Result<(), String> {
    let token = get_valid_access_token().await?;
    let client = reqwest::Client::new();

    for path in paths {
        let file_id = parse_gdrive_id(&path);
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?supportsAllDrives=true",
            file_id
        );
        let body = serde_json::json!({
            "trashed": true
        });

        let resp = send_with_retry(|| {
            client
                .patch(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
        })
        .await
        .map_err(|e| format!("Failed to delete item on Google Drive: {}", e))?;

        if !resp.status().is_success() {
            let err_text = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to delete item on Google Drive: {}", err_text));
        }
    }

    Ok(())
}

/// Open a Google Drive item (file or Google Doc/Sheet) in the system default browser.
#[tauri::command]
pub fn gdrive_open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    let file_id = parse_gdrive_id(&path);
    let web_url = format!("https://drive.google.com/open?id={}", file_id);
    app.opener()
        .open_url(&web_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}
