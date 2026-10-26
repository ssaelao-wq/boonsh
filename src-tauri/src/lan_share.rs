//! LAN and Mobile Drop subsystem for boonsh:
//! Local HTTP server, QR pairing, persistent device authentication,
//! direct mobile downloads (as PDF for Google Docs), and bi-directional dual-pane file management.

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

use crate::fs_ops::{self, FileItem, FileListResult};
use crate::secrets::{read_secret, write_secret};

const TARGET_PAIRED_DEVICES: &str = "boonsh/lan-paired-devices";
const HTML_PORTAL: &str = include_str!("lan_portal.html");

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub token: String,
    pub created_at: u64,
    pub permanent: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UploadedFileRecord {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub size_formatted: String,
    pub received_timestamp: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LanStatus {
    pub running: bool,
    pub port: u16,
    pub lan_ip: String,
    pub hostname: String,
    pub qr_url: String,
    pub mdns_url: String,
    pub active_token: String,
    pub paired_devices: Vec<PairedDevice>,
    pub outgoing_count: usize,
    pub incoming_count: usize,
    pub incoming_dir: String,
    pub incoming_label: String,
    pub is_second_pane: bool,
    pub is_client_connected: bool,
    pub connected_client_name: Option<String>,
}

struct LanState {
    running: bool,
    port: u16,
    lan_ip: String,
    hostname: String,
    active_token: String,
    paired_devices: Vec<PairedDevice>,
    custom_incoming_dir: Option<PathBuf>,
    uploaded_files: Vec<UploadedFileRecord>,
    last_client_seen: Option<Instant>,
    last_client_name: Option<String>,
    shutdown_tx: Option<broadcast::Sender<()>>,
    // Repeated bad tokens from one address: (count in the current window, when that window started).
    failed_auth: HashMap<String, (u32, Instant)>,
}

static LAN_STATE: OnceLock<Arc<Mutex<LanState>>> = OnceLock::new();

fn get_state() -> &'static Arc<Mutex<LanState>> {
    LAN_STATE.get_or_init(|| {
        let paired = load_paired_devices();
        let token = generate_random_token(16);
        let hostname = get_computer_name();
        let lan_ip = detect_lan_ip();

        Arc::new(Mutex::new(LanState {
            running: false,
            port: 48210,
            lan_ip,
            hostname,
            active_token: token,
            paired_devices: paired,
            custom_incoming_dir: None,
            uploaded_files: load_uploaded_files(),
            last_client_seen: None,
            last_client_name: None,
            shutdown_tx: None,
            failed_auth: HashMap::new(),
        }))
    })
}

fn load_uploaded_files() -> Vec<UploadedFileRecord> {
    let p = lan_drop_dir().join("incoming_history.json");
    if let Ok(bytes) = fs::read(&p) {
        if let Ok(records) = serde_json::from_slice::<Vec<UploadedFileRecord>>(&bytes) {
            return records.into_iter().filter(|r| Path::new(&r.path).exists()).collect();
        }
    }
    Vec::new()
}

fn save_uploaded_files(records: &[UploadedFileRecord]) {
    let p = lan_drop_dir().join("incoming_history.json");
    if let Ok(json) = serde_json::to_string_pretty(records) {
        let _ = fs::write(p, json);
    }
}

/// Drops a tracked incoming record for a real local path: a Delete done through the file panel acts on the
/// real path, not the `lan://mobile/incoming/...` one, so without this the record would linger (and still be
/// listed) until `list_lan_directory`'s own `exists()` check caught up next time. A no-op for an untracked path.
pub fn forget_uploaded_record(local_path: &Path) {
    let state_arc = get_state();
    let mut state = state_arc.lock().unwrap();
    let before = state.uploaded_files.len();
    state.uploaded_files.retain(|r| Path::new(&r.path) != local_path);
    if state.uploaded_files.len() != before {
        save_uploaded_files(&state.uploaded_files);
    }
}

/// Updates a tracked incoming record after the real file behind it was renamed through the file panel, so the
/// Mobile Drop listing (which reads the record's own `name`/`path`, not the disk) keeps showing it.
pub fn rename_uploaded_record(old_local_path: &Path, new_local_path: &Path) {
    let state_arc = get_state();
    let mut state = state_arc.lock().unwrap();
    if let Some(rec) = state.uploaded_files.iter_mut().find(|r| Path::new(&r.path) == old_local_path) {
        if let Some(name) = new_local_path.file_name() {
            rec.name = name.to_string_lossy().to_string();
        }
        rec.path = new_local_path.to_string_lossy().to_string();
        save_uploaded_files(&state.uploaded_files);
    }
}

fn load_paired_devices() -> Vec<PairedDevice> {
    if let Ok(Some(json)) = read_secret(TARGET_PAIRED_DEVICES) {
        if let Ok(devices) = serde_json::from_str::<Vec<PairedDevice>>(&json) {
            return devices;
        }
    }
    Vec::new()
}

fn save_paired_devices(devices: &[PairedDevice]) {
    if let Ok(json) = serde_json::to_string(devices) {
        let _ = write_secret(TARGET_PAIRED_DEVICES, &json);
    }
}

pub fn lan_drop_dir() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| "C:\\".to_string())))
        .join("boonsh")
        .join("lan_drop");
    let _ = fs::create_dir_all(&base);
    base
}

pub fn outgoing_dir() -> PathBuf {
    let p = lan_drop_dir().join("outgoing");
    let _ = fs::create_dir_all(&p);
    p
}

pub fn default_downloads_dir() -> PathBuf {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(user_profile).join("Downloads");
        if p.exists() {
            return p;
        }
    }
    dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\"))
    })
}

pub fn incoming_dir() -> PathBuf {
    let state_arc = get_state();
    if let Ok(state) = state_arc.lock() {
        if let Some(ref dir) = state.custom_incoming_dir {
            if dir.exists() && dir.is_dir() {
                return dir.clone();
            }
        }
    }
    default_downloads_dir()
}

fn detect_lan_ip() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

fn get_computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Boonsh-PC".to_string())
}

fn generate_random_token(len: usize) -> String {
    let mut buf = vec![0u8; len];
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Security::Cryptography::ProcessPrng;
        if ProcessPrng(&mut buf).as_bool() {
            return general_purpose::URL_SAFE_NO_PAD.encode(&buf);
        }
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{:x}", now)
}

/// Reduces an untrusted file name from a LAN request to just its own last component: no directory separators,
/// no drive letter, no `:` (an NTFS alternate-data-stream suffix). `outgoing_dir().join(name)` /
/// `unique_target(dest, name, ..)` can then never land outside that directory, which a bare `../../x` or an
/// already-absolute name (`PathBuf::join` discards the base for those) otherwise would.
fn safe_file_name(name: &str) -> Option<String> {
    let only_name = Path::new(name).file_name()?.to_str()?.to_string();
    let only_name = only_name.split(':').next().unwrap_or(&only_name).trim().to_string();
    if only_name.is_empty() || only_name == "." || only_name == ".." {
        None
    } else {
        Some(only_name)
    }
}

pub fn is_lan_path(path: &str) -> bool {
    path.starts_with("lan://") || path == "lan:"
}

pub fn resolve_lan_path_to_local(path: &str) -> Option<PathBuf> {
    if let Some(rel) = path.strip_prefix("lan://mobile/outgoing/") {
        Some(outgoing_dir().join(rel))
    } else if let Some(rel) = path.strip_prefix("lan://mobile/incoming/") {
        if let Ok(state) = get_state().lock() {
            if let Some(rec) = state.uploaded_files.iter().find(|f| f.name == rel) {
                return Some(PathBuf::from(&rec.path));
            }
        }
        Some(incoming_dir().join(rel))
    } else {
        None
    }
}

#[tauri::command]
pub fn lan_get_status() -> LanStatus {
    let state_arc = get_state();
    let state = state_arc.lock().unwrap();

    let outgoing_count = fs::read_dir(outgoing_dir()).map(|r| r.count()).unwrap_or(0);
    let incoming_count = state.uploaded_files.len();

    let qr_url = format!("http://{}:{}/?t={}", state.lan_ip, state.port, state.active_token);
    let mdns_url = format!("http://{}.local:{}/?t={}", state.hostname.to_lowercase(), state.port, state.active_token);

    let (incoming_dir, incoming_label, is_second_pane) = if let Some(ref d) = state.custom_incoming_dir {
        if d.exists() && d.is_dir() {
            let label = d.file_name().and_then(|s| s.to_str()).unwrap_or("Second Pane").to_string();
            (d.to_string_lossy().to_string(), label, true)
        } else {
            let dl = default_downloads_dir();
            (dl.to_string_lossy().to_string(), "Downloads".to_string(), false)
        }
    } else {
        let dl = default_downloads_dir();
        (dl.to_string_lossy().to_string(), "Downloads".to_string(), false)
    };

    let (is_client_connected, connected_client_name) = {
        let is_recent = state.last_client_seen.map(|t| t.elapsed() < Duration::from_secs(12)).unwrap_or(false);
        if is_recent {
            (true, state.last_client_name.clone().or_else(|| Some("Mobile Phone".to_string())))
        } else if !state.paired_devices.is_empty() {
            (true, state.paired_devices.first().map(|d| d.name.clone()))
        } else {
            (false, None)
        }
    };

    LanStatus {
        running: state.running,
        port: state.port,
        lan_ip: state.lan_ip.clone(),
        hostname: state.hostname.clone(),
        qr_url,
        mdns_url,
        active_token: state.active_token.clone(),
        paired_devices: state.paired_devices.clone(),
        outgoing_count,
        incoming_count,
        incoming_dir,
        incoming_label,
        is_second_pane,
        is_client_connected,
        connected_client_name,
    }
}

#[tauri::command]
pub fn lan_set_incoming_dir(path: Option<String>) -> Result<LanStatus, String> {
    let state_arc = get_state();
    {
        let mut state = state_arc.lock().unwrap();
        state.custom_incoming_dir = path
            .filter(|p| !p.trim().is_empty() && !is_lan_path(p) && !crate::gdrive::is_gdrive_path(p))
            .map(PathBuf::from);
    }
    Ok(lan_get_status())
}

#[tauri::command]
pub async fn lan_start_server(app: AppHandle) -> Result<LanStatus, String> {
    let state_arc = get_state().clone();
    {
        let state = state_arc.lock().unwrap();
        if state.running {
            drop(state);
            return Ok(lan_get_status());
        }
    }

    // Try default port 48210, fall back to ephemeral port 0
    let listener = match TcpListener::bind("0.0.0.0:48210").await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
    };

    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (shutdown_tx, _) = broadcast::channel(1);

    {
        let mut state = state_arc.lock().unwrap();
        state.running = true;
        state.port = local_port;
        state.lan_ip = detect_lan_ip();
        state.shutdown_tx = Some(shutdown_tx.clone());
    }

    let mut shutdown_rx = shutdown_tx.subscribe();
    let app_handle = app.clone();

    // Spawn async server loop
    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_res = listener.accept() => {
                    match accept_res {
                        Ok((stream, addr)) => {
                            let state_clone = state_arc.clone();
                            let app_clone = app_handle.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, addr.ip().to_string(), state_clone, app_clone).await {
                                    eprintln!("[boonsh lan] connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            eprintln!("[boonsh lan] accept error: {}", e);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
            }
        }
    });

    Ok(lan_get_status())
}

#[tauri::command]
pub async fn lan_stop_server() -> Result<(), String> {
    let state_arc = get_state();
    let mut state = state_arc.lock().unwrap();
    if let Some(tx) = state.shutdown_tx.take() {
        let _ = tx.send(());
    }
    state.running = false;
    Ok(())
}

#[tauri::command]
pub fn lan_revoke_device(device_id: String) -> Result<(), String> {
    let state_arc = get_state();
    let mut state = state_arc.lock().unwrap();
    state.paired_devices.retain(|d| d.id != device_id);
    save_paired_devices(&state.paired_devices);
    Ok(())
}

#[tauri::command]
pub fn lan_clear_staging() -> Result<(), String> {
    if let Ok(entries) = fs::read_dir(outgoing_dir()) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    let state_arc = get_state();
    let mut state = state_arc.lock().unwrap();
    state.uploaded_files.clear();
    save_uploaded_files(&state.uploaded_files);
    Ok(())
}

#[tauri::command]
pub fn lan_open_incoming_folder() -> Result<(), String> {
    let p = incoming_dir();
    fs_ops::open_in_default_app(p.to_string_lossy().to_string())
}

fn is_authorized(token: &str, state: &LanState) -> bool {
    if token.is_empty() {
        return false;
    }
    if token == state.active_token {
        return true;
    }
    state.paired_devices.iter().any(|d| d.token == token)
}

// The token itself is 128 bits of randomness (not brute-forceable in practice), so this is defense in depth
// against a buggy or hostile client hammering the server with requests, not a real brute-force concern.
const MAX_FAILED_AUTH: u32 = 8;
const FAILED_AUTH_WINDOW: Duration = Duration::from_secs(60);

/// True while `ip` is still serving out its lockout from a past burst of bad tokens.
fn is_locked_out(state: &LanState, ip: &str) -> bool {
    state
        .failed_auth
        .get(ip)
        .is_some_and(|(count, since)| *count >= MAX_FAILED_AUTH && since.elapsed() < FAILED_AUTH_WINDOW)
}

/// Counts one more bad token from `ip`; a gap longer than the window starts a fresh count instead of adding
/// to a stale one.
fn note_failed_auth(state: &mut LanState, ip: &str) {
    let now = Instant::now();
    let entry = state.failed_auth.entry(ip.to_string()).or_insert((0, now));
    if now.duration_since(entry.1) > FAILED_AUTH_WINDOW {
        *entry = (0, now);
    }
    entry.0 += 1;
}

fn clear_failed_auth(state: &mut LanState, ip: &str) {
    state.failed_auth.remove(ip);
}

async fn handle_connection(
    mut stream: TcpStream,
    peer_ip: String,
    state_arc: Arc<Mutex<LanState>>,
    app: AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buffer = vec![0u8; 16384];
    let n = stream.read(&mut buffer).await?;
    if n == 0 {
        return Ok(());
    }

    let raw_header = String::from_utf8_lossy(&buffer[..n]);
    let mut lines = raw_header.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let full_uri = parts.next().unwrap_or("/");

    let parsed_url = url::Url::parse(&format!("http://localhost{}", full_uri))?;
    let path = parsed_url.path();

    // Extract token from query or headers
    let mut token = String::new();
    for (k, v) in parsed_url.query_pairs() {
        if k == "t" || k == "token" {
            token = v.to_string();
            break;
        }
    }

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }

    if token.is_empty() {
        if let Some(auth) = headers.get("authorization") {
            if let Some(bearer) = auth.strip_prefix("Bearer ") {
                token = bearer.trim().to_string();
            }
        }
    }
    if token.is_empty() {
        if let Some(cookie) = headers.get("cookie") {
            for part in cookie.split(';') {
                let p = part.trim();
                if let Some(val) = p.strip_prefix("boonsh_token=") {
                    token = val.to_string();
                    break;
                }
            }
        }
    }

    let auth_ok = {
        let state = state_arc.lock().unwrap();
        is_authorized(&token, &state)
    };

    if auth_ok {
        let mut state = state_arc.lock().unwrap();
        clear_failed_auth(&mut state, &peer_ip);
        state.last_client_seen = Some(Instant::now());
        if state.last_client_name.is_none() {
            let ua = headers.get("user-agent").cloned().unwrap_or_default();
            let name = if ua.contains("iPhone") {
                "iPhone".to_string()
            } else if ua.contains("Android") {
                "Android Phone".to_string()
            } else if ua.contains("iPad") {
                "iPad".to_string()
            } else if let Some(d) = state.paired_devices.iter().find(|d| d.token == token) {
                d.name.clone()
            } else {
                "Mobile Phone".to_string()
            };
            state.last_client_name = Some(name);
        }
    } else {
        // The lockout only ever applies to a request that is ITSELF unauthorized: a device that fumbled the
        // token a few times must still get in the moment it sends the right one, not stay shut out for the
        // rest of the window too.
        let locked = {
            let mut state = state_arc.lock().unwrap();
            let locked = is_locked_out(&state, &peer_ip);
            if !locked {
                note_failed_auth(&mut state, &peer_ip);
            }
            locked
        };
        if locked {
            let resp = json_error(429, "Too many failed attempts from this device. Wait a moment and try again.");
            stream.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
    }

    // Route: HTML portal
    if path == "/" || path == "/index.html" {
        let cookie_header = if !token.is_empty() && auth_ok {
            format!("Set-Cookie: boonsh_token={}; Path=/; Max-Age=31536000; SameSite=Lax\r\n", token)
        } else {
            String::new()
        };

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{}",
            HTML_PORTAL.len(),
            cookie_header,
            HTML_PORTAL
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    if !auth_ok {
        let body = r#"{"error":"Unauthorized. Please scan the QR code from boonsh."}"#;
        let response = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    // Route: API Status
    if path == "/api/status" {
        let (hostname, uploaded, dest_label) = {
            let state = state_arc.lock().unwrap();
            let label = if let Some(ref d) = state.custom_incoming_dir {
                if d.exists() && d.is_dir() {
                    d.file_name().and_then(|s| s.to_str()).unwrap_or("Second Pane").to_string()
                } else {
                    "Downloads".to_string()
                }
            } else {
                "Downloads".to_string()
            };
            (state.hostname.clone(), state.uploaded_files.clone(), label)
        };
        let outgoing = list_files_in_dir(&outgoing_dir());

        let payload = serde_json::json!({
            "computerName": hostname,
            "connected": true,
            "destinationFolder": dest_label,
            "outgoingFiles": outgoing,
            "incomingFiles": uploaded,
        });
        let body = payload.to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    // Route: API Pair (Permanent Connection)
    if path == "/api/pair" && method == "POST" {
        // Read body
        let content_len = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        let mut body_bytes = Vec::new();
        if let Some(pos) = buffer[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            let start = pos + 4;
            body_bytes.extend_from_slice(&buffer[start..n]);
        }
        while body_bytes.len() < content_len {
            let mut chunk = vec![0u8; 4096];
            let read_n = stream.read(&mut chunk).await?;
            if read_n == 0 { break; }
            body_bytes.extend_from_slice(&chunk[..read_n]);
        }

        // lan_portal.html POSTs camelCase ("deviceId"), the usual JS convention; serde does not case-convert
        // on its own, so without this the field was always empty and every pairing minted a new device id.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PairReq {
            #[serde(default)]
            device_id: Option<String>,
            #[serde(default)]
            name: Option<String>,
        }

        let req: PairReq = serde_json::from_slice(&body_bytes).unwrap_or(PairReq { device_id: None, name: None });
        let new_token = generate_random_token(24);
        let dev_id = req.device_id.unwrap_or_else(|| generate_random_token(8));
        let dev_name = req.name.unwrap_or_else(|| format!("Phone ({})", peer_ip));

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let paired = PairedDevice {
            id: dev_id,
            name: dev_name,
            token: new_token.clone(),
            created_at: now,
            permanent: true,
        };

        {
            let mut state = state_arc.lock().unwrap();
            state.paired_devices.retain(|d| d.id != paired.id);
            state.paired_devices.push(paired);
            save_paired_devices(&state.paired_devices);
        }

        let resp_json = serde_json::json!({ "token": new_token, "paired": true }).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: boonsh_token={}; Path=/; Max-Age=31536000; SameSite=Lax\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            new_token,
            resp_json.len(),
            resp_json
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    // Route: Unpair (Permanent Connection switched off on the phone itself)
    if path == "/api/unpair" && method == "POST" {
        let content_len = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        let mut body_bytes = Vec::new();
        if let Some(pos) = buffer[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            body_bytes.extend_from_slice(&buffer[pos + 4..n]);
        }
        while body_bytes.len() < content_len {
            let mut chunk = vec![0u8; 4096];
            let read_n = stream.read(&mut chunk).await?;
            if read_n == 0 {
                break;
            }
            body_bytes.extend_from_slice(&chunk[..read_n]);
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct UnpairReq {
            #[serde(default)]
            device_id: Option<String>,
        }
        let req: UnpairReq = serde_json::from_slice(&body_bytes).unwrap_or(UnpairReq { device_id: None });

        if let Some(dev_id) = req.device_id {
            let mut state = state_arc.lock().unwrap();
            state.paired_devices.retain(|d| d.id != dev_id);
            save_paired_devices(&state.paired_devices);
        }

        let resp_json = r#"{"unpaired":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: boonsh_token=; Path=/; Max-Age=0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            resp_json.len(),
            resp_json
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    // Route: Download file to mobile disk
    if path.starts_with("/api/download/") {
        let raw_name = urlencoding_decode(path.trim_start_matches("/api/download/"));
        let Some(file_name) = safe_file_name(&raw_name) else {
            stream.write_all(json_error(400, "Invalid file name.").as_bytes()).await?;
            return Ok(());
        };
        let target_file = outgoing_dir().join(&file_name);
        let Ok(file_meta) = fs::metadata(&target_file) else {
            stream.write_all(json_error(404, "File not found.").as_bytes()).await?;
            return Ok(());
        };
        if !file_meta.is_file() {
            stream.write_all(json_error(400, "Invalid file name.").as_bytes()).await?;
            return Ok(());
        }

        let content_type = if file_name.to_lowercase().ends_with(".pdf") {
            "application/pdf"
        } else if file_name.to_lowercase().ends_with(".docx") {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        } else if file_name.to_lowercase().ends_with(".jpg") || file_name.to_lowercase().ends_with(".jpeg") {
            "image/jpeg"
        } else if file_name.to_lowercase().ends_with(".png") {
            "image/png"
        } else {
            "application/octet-stream"
        };

        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nConnection: close\r\n\r\n",
            content_type,
            file_meta.len(),
            file_name
        );
        stream.write_all(header.as_bytes()).await?;

        // Streamed in chunks, not read whole into memory: a multi-GB video would otherwise be a multi-GB spike.
        let mut file = tokio::fs::File::open(&target_file).await?;
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let read_n = file.read(&mut chunk).await?;
            if read_n == 0 {
                break;
            }
            stream.write_all(&chunk[..read_n]).await?;
        }
        return Ok(());
    }

    // Route: Upload file from mobile phone
    if path == "/api/upload" && method == "POST" {
        let content_len = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        let mut upload_name = headers.get("x-filename").map(|s| urlencoding_decode(s)).unwrap_or_default();
        if upload_name.is_empty() {
            for (k, v) in parsed_url.query_pairs() {
                if k == "name" {
                    upload_name = v.to_string();
                    break;
                }
            }
        }
        // An invalid name (empty, or one that would try to escape the destination folder) falls back to a
        // generated one rather than being trusted as-is.
        let upload_name = safe_file_name(&upload_name).unwrap_or_else(|| {
            format!(
                "mobile_upload_{}.bin",
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
            )
        });

        let dest_dir = incoming_dir();
        let _ = fs::create_dir_all(&dest_dir);
        let target_path = crate::fs_ops::unique_target(&dest_dir, &upload_name, false);
        let saved_name = target_path.file_name().unwrap_or_default().to_string_lossy().to_string();

        // Streamed straight to disk, not buffered whole in memory first: a multi-GB upload would otherwise be
        // a multi-GB spike. Progress is reported to the desktop app the same way (so it is not stuck showing
        // nothing until the whole thing lands); the mobile portal tracks its own upload progress itself, via
        // the XHR it sends this request with.
        let mut file = tokio::fs::File::create(&target_path).await?;
        let mut written: u64 = 0;
        let mut last_report = Instant::now();
        let emit_progress = |app: &AppHandle, name: &str, received: u64, total: u64, done: bool| {
            let _ = app.emit(
                "lan-upload-progress",
                serde_json::json!({ "name": name, "received": received, "total": total, "done": done }),
            );
        };
        if let Some(pos) = buffer[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            let first_chunk = &buffer[pos + 4..n];
            file.write_all(first_chunk).await?;
            written += first_chunk.len() as u64;
        }
        emit_progress(&app, &saved_name, written, content_len as u64, false);
        let mut chunk = vec![0u8; 256 * 1024];
        while (written as usize) < content_len {
            let read_n = stream.read(&mut chunk).await?;
            if read_n == 0 {
                break;
            }
            file.write_all(&chunk[..read_n]).await?;
            written += read_n as u64;
            if last_report.elapsed() > Duration::from_millis(200) {
                emit_progress(&app, &saved_name, written, content_len as u64, false);
                last_report = Instant::now();
            }
        }
        file.flush().await?;
        emit_progress(&app, &saved_name, written, content_len as u64, true);

        let now_ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let record = UploadedFileRecord {
            name: saved_name.clone(),
            path: target_path.to_string_lossy().to_string(),
            size: written,
            size_formatted: fs_ops::format_size(written, false),
            received_timestamp: now_ts,
        };

        {
            let mut state = state_arc.lock().unwrap();
            state.uploaded_files.retain(|f| f.name != saved_name);
            state.uploaded_files.insert(0, record);
            save_uploaded_files(&state.uploaded_files);
        }

        // Emit events to notify boonsh desktop
        let _ = app.emit("dir-changed", serde_json::json!({ "path": dest_dir.to_string_lossy().to_string() }));
        let _ = app.emit("lan-file-received", serde_json::json!({
            "name": saved_name,
            "path": target_path.to_string_lossy().to_string(),
            "dir": dest_dir.to_string_lossy().to_string(),
        }));

        let resp_json = serde_json::json!({ "success": true, "name": saved_name }).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            resp_json.len(),
            resp_json
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(());
    }

    // Default 404
    let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

/// Percent-decodes a single value (a path segment, a header value). `form_urlencoded::parse` was used here
/// before, but that is for `a=1&b=2` query-string bodies: a name containing `&`, `=` or `+` came out mangled
/// (split on `&`/`=` and silently dropped, `+` read as a space). `+` is left alone here on purpose.
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn json_error(status: u16, message: &str) -> String {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let body = serde_json::json!({ "error": message }).to_string();
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    )
}

#[derive(Serialize)]
struct MobileFileInfo {
    name: String,
    #[serde(rename = "sizeFormatted")]
    size_formatted: String,
}

fn list_files_in_dir(dir: &Path) -> Vec<MobileFileInfo> {
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let size = meta.len();
                    result.push(MobileFileInfo {
                        name,
                        size_formatted: fs_ops::format_size(size, false),
                    });
                }
            }
        }
    }
    result
}

/// List files in the `lan://mobile` virtual directory for boonsh's file panel.
pub async fn list_lan_directory(_raw_path: &str) -> Result<FileListResult, String> {
    let mut items = Vec::new();
    let mut total_size = 0u64;

    // 1. Read files staged for phone (outgoing)
    if let Ok(entries) = fs::read_dir(outgoing_dir()) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                let name = entry.file_name().to_string_lossy().to_string();
                let size = meta.len();
                total_size += size;
                let modified = meta.modified().unwrap_or(SystemTime::now());
                let modified_ts = modified.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

                items.push(FileItem {
                    name: name.clone(),
                    path: format!("lan://mobile/outgoing/{}", name),
                    is_dir: false,
                    size,
                    size_formatted: fs_ops::format_size(size, false),
                    modified: fs_ops::format_time(modified_ts),
                    modified_timestamp: modified_ts,
                    created: fs_ops::format_time(modified_ts),
                    created_timestamp: modified_ts,
                    ext: name.rsplit('.').next().unwrap_or("").to_lowercase(),
                    is_hidden: false,
                    links: None,
                    state: None,
                });
            }
        }
    }

    // 2. Read files received from phone (tracked incoming uploads)
    let uploaded = {
        let state = get_state().lock().unwrap();
        state.uploaded_files.clone()
    };
    for rec in uploaded {
        let p = PathBuf::from(&rec.path);
        if p.exists() {
            total_size += rec.size;
            items.push(FileItem {
                name: rec.name.clone(),
                path: rec.path.clone(),
                is_dir: false,
                size: rec.size,
                size_formatted: rec.size_formatted.clone(),
                modified: fs_ops::format_time(rec.received_timestamp),
                modified_timestamp: rec.received_timestamp,
                created: fs_ops::format_time(rec.received_timestamp),
                created_timestamp: rec.received_timestamp,
                ext: rec.name.rsplit('.').next().unwrap_or("").to_lowercase(),
                is_hidden: false,
                links: None,
                state: None,
            });
        }
    }

    let total_files = items.len();
    Ok(FileListResult {
        current_path: "lan://mobile".to_string(),
        parent_path: None,
        items,
        total_files,
        total_folders: 0,
        total_size,
    })
}

/// Convenience command to share local or Google Drive files to the mobile phone.
#[tauri::command]
/// `is_move`: the "Share to Phone" menu item always omits this (a share should not remove the original), but
/// a Cut pasted into Mobile Drop (paste.rs) passes `true` — Cut everywhere else in the app removes the
/// source once it is safely copied, and Mobile Drop silently not doing that was inconsistent. Returns
/// (source, new staged path) pairs so a mover can tell `paste.rs`'s `PasteResult.moved` which source to drop
/// from its own folder's selection.
pub async fn lan_share_files(
    app: AppHandle,
    paths: Vec<String>,
    is_move: Option<bool>,
) -> Result<Vec<(String, String)>, String> {
    ensure_lan_server_running(app.clone()).await?;
    let is_move = is_move.unwrap_or(false);

    let dest = outgoing_dir();
    let mut added = Vec::new();

    for p in paths {
        if crate::gdrive::is_gdrive_path(&p) {
            // Download / export directly as PDF
            let downloaded = crate::gdrive_transfer::download_gdrive_to_lan_as_pdf(&p, &dest).await?;
            if let Some(target) = downloaded {
                if is_move {
                    crate::gdrive::gdrive_delete(vec![p.clone()]).await?;
                }
                added.push((p, target));
            }
        } else {
            let src_path = PathBuf::from(&p);
            if src_path.is_file() {
                let file_name = src_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                // `fs::copy` overwrites a same-named file already staged; re-sharing one should add another
                // copy, not silently erase what was there (the same "never overwrite unasked" rule as paste).
                let target = crate::fs_ops::unique_target(&dest, &file_name, false);
                fs::copy(&src_path, &target).map_err(|e| e.to_string())?;
                if is_move {
                    let _ = trash::delete(&src_path);
                }
                added.push((p, target.to_string_lossy().to_string()));
            }
        }
    }

    let _ = app.emit("fs-change", "lan://mobile");
    Ok(added)
}

pub async fn ensure_lan_server_running(app: AppHandle) -> Result<(), String> {
    let state_arc = get_state();
    let running = { state_arc.lock().unwrap().running };
    if !running {
        lan_start_server(app).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> LanState {
        LanState {
            running: false,
            port: 0,
            lan_ip: "127.0.0.1".to_string(),
            hostname: "test".to_string(),
            active_token: "tok".to_string(),
            paired_devices: Vec::new(),
            custom_incoming_dir: None,
            uploaded_files: Vec::new(),
            last_client_seen: None,
            last_client_name: None,
            shutdown_tx: None,
            failed_auth: HashMap::new(),
        }
    }

    #[test]
    fn locks_out_after_too_many_failures_and_clears_on_success() {
        let mut state = test_state();
        for _ in 0..MAX_FAILED_AUTH - 1 {
            note_failed_auth(&mut state, "1.2.3.4");
        }
        assert!(!is_locked_out(&state, "1.2.3.4"), "not locked out yet");
        note_failed_auth(&mut state, "1.2.3.4");
        assert!(is_locked_out(&state, "1.2.3.4"), "locked out at the threshold");
        // a different address is never affected by another one's failures
        assert!(!is_locked_out(&state, "5.6.7.8"));
        clear_failed_auth(&mut state, "1.2.3.4");
        assert!(!is_locked_out(&state, "1.2.3.4"), "cleared after a successful auth");
    }

    #[test]
    fn safe_file_name_keeps_an_ordinary_name() {
        assert_eq!(safe_file_name("photo.jpg"), Some("photo.jpg".to_string()));
        assert_eq!(safe_file_name("my report.pdf"), Some("my report.pdf".to_string()));
    }

    #[test]
    fn safe_file_name_strips_directory_traversal() {
        assert_eq!(safe_file_name("../../evil.txt"), Some("evil.txt".to_string()));
        assert_eq!(safe_file_name("..\\..\\evil.txt"), Some("evil.txt".to_string()));
        assert_eq!(
            safe_file_name("a/b/../../../Windows/System32/evil.dll"),
            Some("evil.dll".to_string())
        );
    }

    #[test]
    fn safe_file_name_strips_an_absolute_path() {
        // PathBuf::join would otherwise discard the destination directory entirely for an absolute name.
        assert_eq!(
            safe_file_name("C:\\Users\\victim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.exe"),
            Some("evil.exe".to_string())
        );
    }

    #[test]
    fn safe_file_name_strips_an_alternate_data_stream_suffix() {
        assert_eq!(safe_file_name("report.txt:hidden"), Some("report.txt".to_string()));
    }

    #[test]
    fn safe_file_name_rejects_nothing_usable() {
        assert_eq!(safe_file_name(""), None);
        assert_eq!(safe_file_name("."), None);
        assert_eq!(safe_file_name(".."), None);
        assert_eq!(safe_file_name("../.."), None);
    }

    #[test]
    fn decodes_percent_escapes_without_touching_plus() {
        assert_eq!(urlencoding_decode("my%20report.pdf"), "my report.pdf");
        assert_eq!(urlencoding_decode("a+b.txt"), "a+b.txt");
        assert_eq!(urlencoding_decode("a&b=c.txt"), "a&b=c.txt");
    }
}
