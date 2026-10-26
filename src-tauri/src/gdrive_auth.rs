//! Google Drive OAuth 2.0 PKCE authentication with a local loopback server,
//! token caching, and Windows Credential Manager storage.

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::secrets::{delete_secret, read_secret, write_secret};

const TARGET_CLIENT_ID: &str = "boonsh/gdrive-client-id";
const TARGET_CLIENT_SECRET: &str = "boonsh/gdrive-client-secret";
const TARGET_TOKENS: &str = "boonsh/gdrive-tokens";

#[allow(dead_code)]
struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

static ACTIVE_TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct GDriveConfig {
    pub client_id: String,
    pub has_client_secret: bool,
    pub connected: bool,
    pub account_email: Option<String>,
    pub account_name: Option<String>,
    pub quota_limit: Option<u64>,
    pub quota_usage: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct StoredTokens {
    refresh_token: String,
    account_email: Option<String>,
    account_name: Option<String>,
    quota_limit: Option<u64>,
    quota_usage: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AboutResponse {
    user: Option<AboutUser>,
    storage_quota: Option<AboutStorageQuota>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AboutUser {
    display_name: Option<String>,
    email_address: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AboutStorageQuota {
    limit: Option<String>,
    usage: Option<String>,
}

fn generate_random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Security::Cryptography::ProcessPrng;
        if ProcessPrng(&mut buf).as_bool() {
            return buf;
        }
    }
    // Fallback pseudo-random bytes based on timestamp and process ID
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut state = (now as u64) ^ (std::process::id() as u64) ^ 0x517cc1b727220a95;
    for b in buf.iter_mut() {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *b = (state >> 33) as u8;
    }
    buf
}

/// Retrieve the current Google Drive connection and configuration status.
#[tauri::command]
pub fn gdrive_get_config() -> Result<GDriveConfig, String> {
    let client_id = read_secret(TARGET_CLIENT_ID)?.unwrap_or_default();
    let has_client_secret = read_secret(TARGET_CLIENT_SECRET)?.is_some();

    let tokens_opt = read_secret(TARGET_TOKENS)?;
    let mut config = GDriveConfig {
        client_id,
        has_client_secret,
        connected: false,
        ..Default::default()
    };

    if let Some(tokens_json) = tokens_opt {
        if let Ok(stored) = serde_json::from_str::<StoredTokens>(&tokens_json) {
            config.connected = !stored.refresh_token.is_empty();
            config.account_email = stored.account_email;
            config.account_name = stored.account_name;
            config.quota_limit = stored.quota_limit;
            config.quota_usage = stored.quota_usage;
        }
    }

    Ok(config)
}

/// Save custom Google Cloud OAuth client credentials into Windows Credential Manager.
#[tauri::command]
pub fn gdrive_save_credentials(client_id: String, client_secret: String) -> Result<(), String> {
    let trimmed_id = client_id.trim();
    if trimmed_id.is_empty() {
        delete_secret(TARGET_CLIENT_ID)?;
    } else {
        write_secret(TARGET_CLIENT_ID, trimmed_id)?;
    }

    // Blank means "leave it as is" (the field is cleared after every save, per its own placeholder text), not
    // "remove it": the frontend has no separate action to clear just the secret.
    let trimmed_secret = client_secret.trim();
    if !trimmed_secret.is_empty() {
        write_secret(TARGET_CLIENT_SECRET, trimmed_secret)?;
    }

    Ok(())
}

/// Disconnect Google Drive account and erase tokens from Windows Credential Manager.
#[tauri::command]
pub fn gdrive_disconnect() -> Result<(), String> {
    delete_secret(TARGET_TOKENS)?;
    let mut guard = ACTIVE_TOKEN.lock().unwrap();
    *guard = None;
    Ok(())
}

/// Start Google OAuth 2.0 PKCE loopback flow.
/// Opens the consent screen in the user's default browser and waits for the redirect callback.
#[tauri::command]
pub async fn gdrive_start_login(app: AppHandle) -> Result<GDriveConfig, String> {
    let client_id = read_secret(TARGET_CLIENT_ID)?
        .ok_or_else(|| "Google Client ID is missing. Please enter your OAuth Client ID in Settings first.".to_string())?;
    let client_secret = read_secret(TARGET_CLIENT_SECRET)?.unwrap_or_default();

    // Bind local loopback on an ephemeral port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to start OAuth loopback server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);

    // PKCE code_verifier (43-128 chars) and challenge
    let raw_verifier = generate_random_bytes(32);
    let code_verifier = general_purpose::URL_SAFE_NO_PAD.encode(&raw_verifier);
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());

    let state_bytes = generate_random_bytes(16);
    let state = general_purpose::URL_SAFE_NO_PAD.encode(&state_bytes);

    let mut auth_url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| e.to_string())?;
    {
        let mut q = auth_url.query_pairs_mut();
        q.append_pair("client_id", &client_id);
        q.append_pair("redirect_uri", &redirect_uri);
        q.append_pair("response_type", "code");
        q.append_pair("scope", "https://www.googleapis.com/auth/drive");
        q.append_pair("access_type", "offline");
        q.append_pair("prompt", "consent");
        q.append_pair("state", &state);
        q.append_pair("code_challenge", &code_challenge);
        q.append_pair("code_challenge_method", "S256");
    }

    // Launch browser to Google authorization page
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // Wait for redirect callback with 2-minute timeout
    let (code, returned_state) = tokio::select! {
        accept_res = listener.accept() => {
            let (mut socket, _) = accept_res.map_err(|e| format!("Connection error: {}", e))?;
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.map_err(|e| format!("Read error: {}", e))?;
            let req_text = String::from_utf8_lossy(&buf[..n]);

            let html_response = "<!DOCTYPE html><html><body style=\"font-family:sans-serif;background:#181825;color:#cdd6f4;text-align:center;padding:50px;\"><h2 style=\"color:#a6e3a1;\">&#10004; Google Drive connected to boonsh!</h2><p>You can close this tab and return to the app.</p></body></html>";
            let http_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html_response.len(),
                html_response
            );
            let _ = socket.write_all(http_response.as_bytes()).await;
            let _ = socket.flush().await;

            // Extract code and state from GET /?code=...&state=...
            let query = req_text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("");
            let parsed_url = url::Url::parse(&format!("http://localhost{}", query)).unwrap_or_else(|_| url::Url::parse("http://localhost").unwrap());
            let mut code = None;
            let mut st = None;
            for (k, v) in parsed_url.query_pairs() {
                if k == "code" { code = Some(v.to_string()); }
                if k == "state" { st = Some(v.to_string()); }
                if k == "error" { return Err(format!("Google OAuth authorization error: {}", v)); }
            }
            (code.ok_or_else(|| "No authorization code returned from Google.".to_string())?, st)
        }
        _ = tokio::time::sleep(Duration::from_secs(120)) => {
            return Err("OAuth login timed out after 2 minutes.".to_string());
        }
    };

    if returned_state.as_deref() != Some(&state) {
        return Err("Security verification failed: OAuth state mismatch.".to_string());
    }

    // Exchange code for tokens
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("client_id", &client_id);
        if !client_secret.is_empty() {
            serializer.append_pair("client_secret", &client_secret);
        }
        serializer.append_pair("code", &code);
        serializer.append_pair("code_verifier", &code_verifier);
        serializer.append_pair("grant_type", "authorization_code");
        serializer.append_pair("redirect_uri", &redirect_uri);
        serializer.finish()
    };

    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !token_res.status().is_success() {
        let err_body = token_res.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {}", err_body));
    }

    let token_resp: TokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let refresh_token = token_resp
        .refresh_token
        .ok_or_else(|| "Google did not provide a refresh token. Please ensure prompt=consent is used.".to_string())?;

    let expires_in = token_resp.expires_in.unwrap_or(3600);

    // Cache active access token
    {
        let mut guard = ACTIVE_TOKEN.lock().unwrap();
        *guard = Some(CachedToken {
            access_token: token_resp.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
        });
    }

    // Query user profile and storage quota
    let mut stored = StoredTokens {
        refresh_token,
        ..Default::default()
    };

    if let Ok(about_res) = client
        .get("https://www.googleapis.com/drive/v3/about?fields=user,storageQuota")
        .bearer_auth(&token_resp.access_token)
        .send()
        .await
    {
        if let Ok(about) = about_res.json::<AboutResponse>().await {
            if let Some(user) = about.user {
                stored.account_name = user.display_name;
                stored.account_email = user.email_address;
            }
            if let Some(quota) = about.storage_quota {
                stored.quota_limit = quota.limit.and_then(|l| l.parse().ok());
                stored.quota_usage = quota.usage.and_then(|u| u.parse().ok());
            }
        }
    }

    // Persist securely in Windows Credential Manager
    let serialized = serde_json::to_string(&stored)
        .map_err(|e| format!("Failed to serialize tokens: {}", e))?;
    write_secret(TARGET_TOKENS, &serialized)?;

    gdrive_get_config()
}

/// Retrieve a valid OAuth Bearer access token, automatically refreshing it if expired.
/// This will be used by all subsequent Google Drive API requests in Phase 2 & 3.
#[allow(dead_code)]
pub async fn get_valid_access_token() -> Result<String, String> {
    // 1. Check in-memory cache
    {
        let guard = ACTIVE_TOKEN.lock().unwrap();
        if let Some(cached) = &*guard {
            if Instant::now() < cached.expires_at {
                return Ok(cached.access_token.clone());
            }
        }
    }

    // 2. Load stored refresh token
    let tokens_json = read_secret(TARGET_TOKENS)?
        .ok_or_else(|| "Google Drive is not connected. Please connect your account in Settings.".to_string())?;
    let stored: StoredTokens = serde_json::from_str(&tokens_json)
        .map_err(|e| format!("Corrupted tokens in credentials: {}", e))?;

    let client_id = read_secret(TARGET_CLIENT_ID)?
        .ok_or_else(|| "OAuth Client ID is missing.".to_string())?;
    let client_secret = read_secret(TARGET_CLIENT_SECRET)?.unwrap_or_default();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("client_id", &client_id);
        if !client_secret.is_empty() {
            serializer.append_pair("client_secret", &client_secret);
        }
        serializer.append_pair("refresh_token", &stored.refresh_token);
        serializer.append_pair("grant_type", "refresh_token");
        serializer.finish()
    };

    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Refresh token request failed: {}", e))?;

    if !token_res.status().is_success() {
        let err_body = token_res.text().await.unwrap_or_default();
        return Err(format!("Failed to refresh Google Drive token: {}", err_body));
    }

    let token_resp: TokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    let expires_in = token_resp.expires_in.unwrap_or(3600);

    // Update in-memory cache
    let mut guard = ACTIVE_TOKEN.lock().unwrap();
    *guard = Some(CachedToken {
        access_token: token_resp.access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
    });

    Ok(token_resp.access_token)
}
