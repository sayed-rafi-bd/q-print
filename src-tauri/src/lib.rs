use serde::{Deserialize, Serialize};
use tauri::Manager;

// Reading label files from before labels moved into the database, for the one-time import.
mod legacy;
// Direct network printing (IPP / raw socket) and the saved-printer store. Used by the Android backend.
mod direct;
// Bitmap -> ZPL / TSPL / ESC-POS / CPCL / PWG raster encoders, for printers that cannot take a PDF.
mod raster;

// Platform print backends. Each exposes the same functions; only one is compiled in.
#[cfg(target_os = "windows")]
#[path = "print_windows.rs"]
mod platform;
#[cfg(target_os = "android")]
#[path = "print_android.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "print_linux.rs"]
mod platform;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
#[path = "print_other.rs"]
mod platform;

/// What was actually handed to the print transport, so the UI can show it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintReport {
    /// "sumatra" | "cups" | "android-dialog" (later: "ipp" | "vendor")
    pub transport: String,
    pub tool: String,
    pub command: String,
    pub paper_requested: String,
    pub paper_applied: bool,
    pub paper_note: String,
    pub orientation: String,
    pub dpi_requested: String,
    pub dpi_applied: bool,
    pub dpi_note: String,
}

/// The options the UI sends with a print job.
#[derive(Deserialize)]
pub struct PrintOptions {
    pub printer: String,
    pub paper: String,
    pub orientation: String,
    pub dpi: String,
}

/// What the current platform's print backend can do, so the UI can hide options that don't apply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    platform: &'static str, // "windows" | "linux" | "android" | "other"
    transport: &'static str,
    silent: bool,             // prints without a dialog
    paper_select: bool,       // SumatraPDF named sizes / CUPS media / IPP media
    orientation_select: bool,
    dpi_select: bool,
    printer_list: bool,       // false => show an "Add printer" UI
    direct_printers: bool,    // user can add network printers that print without a dialog
}

#[tauri::command]
fn capabilities() -> Capabilities {
    if cfg!(target_os = "windows") {
        Capabilities {
            platform: "windows", transport: "sumatra", silent: true,
            paper_select: true, orientation_select: true, dpi_select: true, printer_list: true,
            direct_printers: false,
        }
    } else if cfg!(target_os = "linux") {
        Capabilities {
            platform: "linux", transport: "cups", silent: true,
            paper_select: true, orientation_select: true, dpi_select: true, printer_list: true,
            direct_printers: false,
        }
    } else if cfg!(target_os = "android") {
        Capabilities {
            platform: "android", transport: "android-dialog", silent: false,
            paper_select: false, orientation_select: false, dpi_select: false, printer_list: true,
            direct_printers: true,
        }
    } else {
        Capabilities {
            platform: "other", transport: "none", silent: false,
            paper_select: false, orientation_select: false, dpi_select: false, printer_list: false,
            direct_printers: false,
        }
    }
}

fn printers_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("printers.json"))
}

/// Network printers the user added (IPP / raw socket). These print without any dialog.
#[tauri::command]
fn list_saved_printers(app: tauri::AppHandle) -> Result<Vec<direct::SavedPrinter>, String> {
    direct::load_all(&printers_path(&app)?)
}

/// Adds a network printer, or replaces the one with the same name.
#[tauri::command]
fn save_printer(app: tauri::AppHandle, printer: direct::SavedPrinter) -> Result<(), String> {
    direct::upsert(&printers_path(&app)?, &printer)
}

#[tauri::command]
fn delete_printer(app: tauri::AppHandle, name: String) -> Result<(), String> {
    direct::remove(&printers_path(&app)?, &name)
}

/// Connects to the printer (IPP: asks for its model, state and supported formats) without printing.
#[tauri::command]
async fn test_printer(printer: direct::SavedPrinter) -> Result<direct::TestResult, String> {
    tauri::async_runtime::spawn_blocking(move || direct::test(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Looks for printers on the local network (mDNS) for a few seconds. Android only.
#[tauri::command]
async fn discover_printers(app: tauri::AppHandle) -> Result<Vec<direct::Discovered>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            platform::discover(&app)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = &app;
            Err("Finding printers on the network is only available on Android.".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Paired Bluetooth devices (`kind` = "bluetooth") or connected USB printers (`kind` = "usb"). Android only.
#[tauri::command]
async fn list_devices(app: tauri::AppHandle, kind: String) -> Result<Vec<direct::Device>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            platform::list_devices(&app, &kind)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (&app, &kind);
            Err("Bluetooth and USB printers are only available on Android.".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_printers(app: tauri::AppHandle) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        platform::list_printers()
    }
    #[cfg(not(target_os = "windows"))]
    {
        platform::list_printers(&app)
    }
}

#[tauri::command]
async fn printer_resolutions(printer: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::printer_resolutions(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Runs the platform backend off the main thread (printing blocks on child processes / the Android UI thread).
async fn run_print(app: tauri::AppHandle, opts: PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let _ = &app;
            platform::print_pdf(&opts, bytes)
        }
        #[cfg(not(target_os = "windows"))]
        {
            platform::print_pdf(&app, &opts, bytes)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn print_pdf(
    app: tauri::AppHandle,
    printer: String,
    paper: String,
    orientation: String,
    dpi: String,
    bytes: Vec<u8>,
) -> Result<PrintReport, String> {
    run_print(app, PrintOptions { printer, paper, orientation, dpi }, bytes).await
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("truncated %-escape in print options")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad %-escape in print options")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Same as `print_pdf`, but the PDF travels as a raw binary body (no JSON number array), which is
/// much faster for big jobs. The options come in the `x-print-options` header as
/// `encodeURIComponent(JSON.stringify({ printer, paper, orientation, dpi }))`.
#[tauri::command]
async fn print_pdf_raw(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<PrintReport, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("print_pdf_raw expects the PDF as a raw binary body".into());
    };
    let header = request
        .headers()
        .get("x-print-options")
        .ok_or("missing x-print-options header")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let opts: PrintOptions =
        serde_json::from_str(&percent_decode(header)?).map_err(|e| format!("bad print options: {e}"))?;
    run_print(app, opts, bytes.clone()).await
}

/// Labels the app ships with. Keep in sync with `BUILTINS` in src/builtinLabels.ts. The first one
/// is the default. Only the built-ins have a layout file on this device; everything a user creates
/// lives in the database and never touches the filesystem.
const BUILTIN_IDS: [&str; 1] = ["product"];

/// Validates the built-in label id coming from the UI. Only the built-ins have a layout override
/// file, so anything else is rejected here; a user's own labels are addressed by slug in the
/// database, where they are not a file name at all.
fn builtin_id(label: &Option<String>) -> Result<&str, String> {
    let id = label.as_deref().unwrap_or(BUILTIN_IDS[0]);
    BUILTIN_IDS.iter().copied().find(|l| *l == id).ok_or_else(|| format!("unknown label \"{id}\""))
}

/// One template file per label. The legacy `label-template.json` belonged to the removed shipping
/// label, so it is deliberately never read: every built-in uses `label-template-{id}.json`.
fn template_path(app: &tauri::AppHandle, label: &Option<String>) -> Result<std::path::PathBuf, String> {
    let id = builtin_id(label)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("label-template-{id}.json")))
}

/// Saved pdfme template (JSON text), or None if the designer has never saved one.
#[tauri::command]
fn load_template(app: tauri::AppHandle, label: Option<String>) -> Result<Option<String>, String> {
    let path = template_path(&app, &label)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

/// Saves the designer's template; returns the file path.
#[tauri::command]
fn save_template(app: tauri::AppHandle, label: Option<String>, json: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid template JSON: {e}"))?;
    let path = template_path(&app, &label)?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Deletes the saved template so the built-in default is used again.
#[tauri::command]
fn reset_template(app: tauri::AppHandle, label: Option<String>) -> Result<(), String> {
    let path = template_path(&app, &label)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Kotlin plugin that talks to Android's PrintManager.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_print::init());

    builder
        .invoke_handler(tauri::generate_handler![
            capabilities,
            list_printers,
            list_saved_printers,
            save_printer,
            delete_printer,
            test_printer,
            discover_printers,
            list_devices,
            legacy::read_legacy_labels,
            printer_resolutions,
            print_pdf,
            print_pdf_raw,
            load_template,
            save_template,
            reset_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
