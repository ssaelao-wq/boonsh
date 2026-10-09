// Saved AI Assistant conversations (only when the user turns "Keep conversations" on): one JSON file per
// conversation in <app data>\ai-chats\<id>.json. The frontend owns the format; this module only stores the text
// and reads back the few top-level fields the list needs. At most MAX_CHATS are kept (the oldest go first).

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_CHATS: usize = 100;

#[derive(serde::Serialize, Debug)]
pub struct ChatMeta {
    id: String,
    title: String,
    updated: f64, // ms since 1970, as the frontend wrote it
    count: u64,   // messages
    cost: Option<f64>,
    tokens: u64,
}

fn chats_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai-chats");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Ids are made by the frontend: letters, digits and dashes only, so an id can never leave the folder.
fn chat_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("Bad conversation id: {id}"));
    }
    Ok(dir.join(format!("{id}.json")))
}

fn read_meta(path: &Path) -> Option<ChatMeta> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some(ChatMeta {
        id: v.get("id")?.as_str()?.to_string(),
        title: v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        updated: v.get("updated").and_then(|t| t.as_f64()).unwrap_or(0.0),
        count: v.get("count").and_then(|t| t.as_u64()).unwrap_or(0),
        cost: v.get("cost").and_then(|t| t.as_f64()),
        tokens: v.get("tokens").and_then(|t| t.as_u64()).unwrap_or(0),
    })
}

/// Every readable conversation in `dir`, newest first.
fn list_in(dir: &Path) -> Result<Vec<(ChatMeta, PathBuf)>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Some(meta) = read_meta(&path) {
                out.push((meta, path));
            }
        }
    }
    out.sort_by(|a, b| b.0.updated.total_cmp(&a.0.updated));
    Ok(out)
}

/// Writes through a temporary file, so a crash never leaves half a conversation; then drops the oldest beyond `max`.
fn save_in(dir: &Path, id: &str, json: &str, max: usize) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("Not a conversation: {e}"))?;
    let path = chat_path(dir, id)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Could not save the conversation: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Could not save the conversation: {e}"))?;
    for (_, old) in list_in(dir)?.into_iter().skip(max) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    match fs::remove_file(chat_path(dir, id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete the conversation: {e}")),
    }
}

/// The saved conversations, newest first.
#[tauri::command]
pub fn ai_chats_list(app: AppHandle) -> Result<Vec<ChatMeta>, String> {
    Ok(list_in(&chats_dir(&app)?)?.into_iter().map(|(m, _)| m).collect())
}

#[tauri::command]
pub fn ai_chat_load(app: AppHandle, id: String) -> Result<String, String> {
    let path = chat_path(&chats_dir(&app)?, &id)?;
    fs::read_to_string(&path).map_err(|e| format!("Could not read the conversation: {e}"))
}

#[tauri::command]
pub fn ai_chat_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    save_in(&chats_dir(&app)?, &id, &json, MAX_CHATS)
}

#[tauri::command]
pub fn ai_chat_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete_in(&chats_dir(&app)?, &id)
}

#[tauri::command]
pub fn ai_chats_delete_all(app: AppHandle) -> Result<(), String> {
    for (_, path) in list_in(&chats_dir(&app)?)? {
        fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, updated: u64) -> String {
        format!(r#"{{"version":1,"id":"{id}","title":"t {id}","updated":{updated},"count":2,"tokens":1500,"cost":0.002,"entries":[]}}"#)
    }

    #[test]
    fn save_list_prune_delete() {
        let dir = std::env::temp_dir().join(format!("boonsh-chats-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        save_in(&dir, "a-1", &chat("a-1", 100), 3).unwrap();
        save_in(&dir, "b-2", &chat("b-2", 300), 3).unwrap();
        save_in(&dir, "c-3", &chat("c-3", 200), 3).unwrap();
        let ids: Vec<String> = list_in(&dir).unwrap().into_iter().map(|(m, _)| m.id).collect();
        assert_eq!(ids, ["b-2", "c-3", "a-1"]); // newest first
        let first = &list_in(&dir).unwrap()[0].0;
        assert_eq!((first.title.as_str(), first.count, first.tokens, first.cost), ("t b-2", 2, 1500, Some(0.002)));

        // a fourth one: the oldest (a-1) is dropped
        save_in(&dir, "d-4", &chat("d-4", 400), 3).unwrap();
        let ids: Vec<String> = list_in(&dir).unwrap().into_iter().map(|(m, _)| m.id).collect();
        assert_eq!(ids, ["d-4", "b-2", "c-3"]);

        // saving again replaces, no temporary file is left
        save_in(&dir, "c-3", &chat("c-3", 500), 3).unwrap();
        assert_eq!(list_in(&dir).unwrap()[0].0.id, "c-3");
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.path().to_string_lossy().ends_with(".tmp")));

        // bad ids and bad JSON are refused
        assert!(save_in(&dir, "..\\evil", &chat("x", 1), 3).is_err());
        assert!(save_in(&dir, "x/y", &chat("x", 1), 3).is_err());
        assert!(save_in(&dir, "ok", "not json", 3).is_err());

        delete_in(&dir, "b-2").unwrap();
        delete_in(&dir, "b-2").unwrap(); // already gone: fine
        assert_eq!(list_in(&dir).unwrap().len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
