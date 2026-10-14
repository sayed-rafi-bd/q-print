//! Reading label files written by the version before labels moved into the database.
//!
//! Those files are only ever read now: the one-time import on first sign-in offers to copy them
//! onto the account, and then leaves them on disk as a backup. Nothing here writes or deletes a
//! label, so there is no path in which this code can lose one.

use serde::{Serialize};
use tauri::Manager;

/// One file from the old `labels/` folder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLabel {
    /// The file name without `.json`, which is the slug the database will use.
    pub slug: String,
    pub name: String,
    /// The whole label file as JSON text, so the frontend can read it with the same code that
    /// reads an exported label.
    pub json: String,
}

/// Whatever is still sitting in `app_data_dir()/labels`.
///
/// A file that will not parse is skipped rather than failing the whole import: the point of this
/// is to rescue what can be rescued.
#[tauri::command]
pub fn read_legacy_labels(app: tauri::AppHandle) -> Result<Vec<LegacyLabel>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("labels");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(slug) = file_name.strip_suffix(".json") else { continue };
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let name = value
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| slug.to_string());
        out.push(LegacyLabel { slug: slug.to_string(), name, json: text });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}
