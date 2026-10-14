//! Fallback for platforms without a backend of their own (macOS and anything else that is not Windows,
//! Linux or Android). Printing is not implemented there.

use crate::{PrintOptions, PrintReport};
use tauri::AppHandle;

pub fn list_printers(_app: &AppHandle) -> Vec<String> {
    Vec::new()
}

pub fn printer_resolutions(_printer: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub fn print_pdf(_app: &AppHandle, _opts: &PrintOptions, _bytes: Vec<u8>) -> Result<PrintReport, String> {
    Err("printing is not implemented on this platform yet".into())
}
