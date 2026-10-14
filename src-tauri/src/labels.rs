//! Storage for user-created labels ("custom labels").
//!
//! Each custom label is one JSON file holding the pdfme template, its data generator and the
//! display name together, so the three can never drift apart and export/import is a plain copy.
//! Built-in labels are *not* stored here: they keep their own `label-template*.json` override
//! files, so nothing an existing user saved is touched and no migration is needed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Upper bound for one label file. Generators embed tables of literal values, so a label can be
/// large, but anything past this is a mistake or a hostile import.
const MAX_LABEL_BYTES: u64 = 5 * 1024 * 1024;

/// Rejects anything that is not a plain slug. The id becomes a file name, so this is also what
/// keeps `../../etc/passwd`, `C:\...` and absolute paths away from the filesystem.
pub fn validate_id(id: &str) -> Result<&str, String> {
    // Same shape as `^[a-z0-9][a-z0-9-]{0,39}$`: 1-40 chars, starting with a letter or digit.
    let ok = (1..=40).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err(format!(
            "invalid label id {id:?}: use 1-40 characters of a-z, 0-9 and '-', starting with a-z or 0-9"
        ))
    }
}

/// One label file, reduced to what the registry needs to show it in a picker. The page size is
/// read here so the picker does not have to load every label's template.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelFileSummary {
    pub id: String,
    pub name: String,
    /// Page width in mm, or None when the template does not say.
    pub width_mm: Option<f64>,
    /// Page height in mm, or None when the template does not say.
    pub height_mm: Option<f64>,
}

/// A file in `labels/` that is not a usable label. Listed separately so one bad file cannot hide
/// every other label, and so the UI can offer a way to delete it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLabel {
    /// The file name without `.json`, so it can be passed back to `delete_custom_label`.
    pub id: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomLabelListing {
    pub labels: Vec<LabelFileSummary>,
    pub broken: Vec<BrokenLabel>,
}

/// The few fields `list_custom_labels` needs; the rest of the bundle is read only on demand.
#[derive(Deserialize)]
struct LabelBundleHead {
    name: Option<String>,
    template: Option<LabelBundleTemplate>,
}

#[derive(Deserialize)]
struct LabelBundleTemplate {
    #[serde(default)]
    base_pdf: Option<LabelBundleBasePdf>,
}

#[derive(Deserialize)]
struct LabelBundleBasePdf {
    width: Option<f64>,
    height: Option<f64>,
}

/// The page size a bundle declares, as (width_mm, height_mm). pdfme stores it in millimetres.
fn summary(head: &LabelBundleHead) -> (Option<f64>, Option<f64>) {
    let size = head.template.as_ref().and_then(|t| t.base_pdf.as_ref());
    match size {
        Some(s) => (s.width, s.height),
        None => (None, None),
    }
}

pub fn labels_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("labels");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn label_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.json", validate_id(id)?)))
}

/// The id a file name stands for, or None when the file is not ours to manage.
fn id_of_file(name: &str) -> Option<&str> {
    name.strip_suffix(".json").filter(|id| validate_id(id).is_ok())
}

/// `app_data_dir()/labels`, read as a registry of custom labels.
#[tauri::command]
pub fn list_custom_labels(app: tauri::AppHandle) -> Result<CustomLabelListing, String> {
    let dir = labels_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut labels = Vec::new();
    let mut broken = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                broken.push(BrokenLabel { id: String::new(), reason: e.to_string() });
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Anything that is not `<slug>.json` (a temp file left by a crashed write, a stray
        // document) is ignored rather than reported: it is not a label the user created.
        let Some(id) = id_of_file(&file_name) else { continue };

        match read_bundle_text(&entry.path()) {
            Ok(text) => match serde_json::from_str::<LabelBundleHead>(&text) {
                Ok(head) => {
                    let (width_mm, height_mm) = summary(&head);
                    labels.push(LabelFileSummary {
                        id: id.to_string(),
                        name: head
                            .name
                            .filter(|n| !n.trim().is_empty())
                            .unwrap_or_else(|| id.to_string()),
                        width_mm,
                        height_mm,
                    })
                }
                Err(e) => broken.push(BrokenLabel { id: id.to_string(), reason: e.to_string() }),
            },
            Err(e) => broken.push(BrokenLabel { id: id.to_string(), reason: e }),
        }
    }

    // Built-ins first, then custom labels in a stable order.
    labels.sort_by(|a, b| a.id.cmp(&b.id));
    broken.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(CustomLabelListing { labels, broken })
}

/// One custom label's bundle, as JSON text.
#[tauri::command]
pub fn load_custom_label(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let path = label_path(&labels_dir(&app)?, &id)?;
    if !path.exists() {
        return Err(format!("there is no custom label called \"{id}\""));
    }
    read_bundle_text(&path)
}

/// Saves a custom label's bundle, replacing any previous version; returns the file path.
///
/// The JSON is parsed before anything is written, and the write itself goes to a temp file that is
/// then renamed, so a failure (disk full, app killed) leaves the previous label intact instead of
/// a half-written one.
#[tauri::command]
pub fn save_custom_label(app: tauri::AppHandle, id: String, json: String) -> Result<String, String> {
    if json.len() as u64 > MAX_LABEL_BYTES {
        return Err(format!(
            "this label is {} MB; the limit is {} MB",
            (json.len() as u64) / (1024 * 1024),
            MAX_LABEL_BYTES / (1024 * 1024)
        ));
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid label JSON: {e}"))?;

    let dir = labels_dir(&app)?;
    let path = label_path(&dir, &id)?;
    let tmp = dir.join(format!("{}.json.tmp", validate_id(&id)?));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("could not write the label: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not save the label: {e}"));
    }
    Ok(path.display().to_string())
}

/// Removes a custom label file. Removing one that is not there is not an error, so the UI can call
/// this after a delete without checking first.
#[tauri::command]
pub fn delete_custom_label(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = label_path(&labels_dir(&app)?, &id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_bundle_text(path: &Path) -> Result<String, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > MAX_LABEL_BYTES {
        return Err(format!("the file is {} MB, over the {MAX_LABEL_BYTES} byte limit", len));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_slugs() {
        for id in ["a", "0", "shipping", "my-parcel-2", "a-b-c-1", &"x".repeat(40)] {
            assert_eq!(validate_id(id), Ok(id), "{id} should be valid");
        }
    }

    #[test]
    fn rejects_traversal_and_separators() {
        // The reason this check exists: the id is used as a file name.
        for id in ["../x", "..", "a/b", "a\\b", "/etc/passwd", "C:\\Windows"] {
            assert!(validate_id(id).is_err(), "{id} should be rejected");
        }
    }

    #[test]
    fn rejects_out_of_shape_ids() {
        for id in ["", "-lead", "Upper", "Upper-case", "sp ace", "tab\t", "über", "a".repeat(41).as_str()]
        {
            assert!(validate_id(id).is_err(), "{id:?} should be rejected");
        }
    }

    #[test]
    fn file_name_maps_to_id() {
        assert_eq!(id_of_file("my-parcel-2.json"), Some("my-parcel-2"));
        assert_eq!(id_of_file("label-template.json"), Some("label-template"));
    }

    #[test]
    fn file_name_we_do_not_manage_is_ignored() {
        // A temp file left by a crashed write, a stray document, or anything whose id would fail
        // validation must not reach the listing.
        assert_eq!(id_of_file("my-parcel-2.json.tmp"), None);
        assert_eq!(id_of_file("notes.txt"), None);
        assert_eq!(id_of_file("../escape.json"), None);
        assert_eq!(id_of_file("Upper.json"), None);
        assert_eq!(id_of_file("a.b.json"), None); // "a.b" is not a valid id
        assert_eq!(id_of_file(".json"), None);
    }
}
