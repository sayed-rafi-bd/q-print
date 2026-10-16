use serde::{Deserialize, Serialize};
use tauri::Manager;

// The print API. `api_server` is desktop-only, so only `ApiState` comes from it; the settings and
// the status types the commands return live in `api_settings` and exist on every platform.
use api_settings::{ApiSettings, ApiStatus, RecentCall};
#[cfg(desktop)]
use api_server::ApiState;

// Reading label files from before labels moved into the database, for the one-time import.
mod legacy;
// Direct network printing (IPP / raw socket) and the saved-printer store. Used by the Android backend.
mod direct;
// Fetching a label's API data source over HTTP(S).
mod http;
// Bitmap -> ZPL / TSPL / ESC-POS / CPCL / PWG raster encoders, for printers that cannot take a PDF.
mod raster;
// The local print API's settings. Cross-platform so the file can be read and tested anywhere,
// including Android, where no server is started.
mod api_settings;
// The local print API itself (api_server.rs). Desktop only.
#[cfg(not(target_os = "android"))]
mod api_server;
// Staying reachable when the app is not in front: a tray icon on desktop, a foreground service on
// Android. Desktop only — on Android the whole of it is in `BackgroundService.kt`, because a
// foreground service's notification has to be built and shown by the service itself.
#[cfg(desktop)]
mod tray;

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
#[derive(Serialize, Debug)]
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
#[derive(Deserialize, Debug)]
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

/// Fetches the JSON for a label's API data source. `bearer` is the optional access token; it is
/// used for this one request and never stored or echoed back.
#[tauri::command]
async fn fetch_json(url: String, bearer: Option<String>) -> Result<String, String> {
    // ureq is blocking, so keep it off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || http::fetch(&url, bearer.as_deref()))
        .await
        .map_err(|e| format!("The request was interrupted: {e}"))?
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

/// One print job at a time, everywhere.
///
/// Windows changes the printer's DPI setting, hands the job over, and puts the old value back, by
/// running PowerShell around the print. Two jobs doing that at once would read each other's
/// settings and print at the wrong resolution or leave a printer changed. The UI and the local API
/// both come through here, so a person clicking Print and a script printing at the same moment
/// queue rather than collide.
static PRINT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs the platform backend off the main thread (printing blocks on child processes / the Android
/// UI thread), holding [`PRINT_LOCK`] for the job.
///
/// The lock is taken inside the blocking task rather than around it, so the wait does not tie up an
/// async runtime thread. A poisoned lock is taken anyway: a panic in one print must not stop the
/// next one, and there is no shared state to corrupt.
pub(crate) async fn run_print(
    app: tauri::AppHandle,
    opts: PrintOptions,
    bytes: Vec<u8>,
) -> Result<PrintReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PRINT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

// ---------------------------------------------------------------------------------------------
// The local print API. See `api_server.rs` for what it is for and why the defaults are strict.
//
// The commands exist on every platform so the frontend never has to know which build it is in;
// on Android there is no server and they report that.
// ---------------------------------------------------------------------------------------------

/// `api.json` beside `printers.json`.
fn api_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("The app data folder could not be found: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("The app data folder could not be created: {e}"))?;
    Ok(dir.join("api.json"))
}

/// Reads the settings, falling back to the defaults with the reason said out loud. A missing or
/// broken file must not stop the app: the API is an extra, and the app is a printing app.
fn api_settings_or_default(app: &tauri::AppHandle) -> api_settings::ApiSettings {
    match api_settings_path(app) {
        Ok(path) => match api_settings::load(&path) {
            Ok(settings) => settings,
            Err(e) => {
                eprintln!("[api] {e} Falling back to the defaults, which means a new token.");
                api_settings::ApiSettings::default()
            }
        },
        Err(e) => {
            eprintln!("[api] {e} Starting with the defaults, which means a new token.");
            api_settings::ApiSettings::default()
        }
    }
}

/// Saves the settings, reporting rather than swallowing a failure. Losing the file means the next
/// start makes a new token, which quietly locks out every integration that had the old one.
fn save_api_settings(app: &tauri::AppHandle, settings: &api_settings::ApiSettings) {
    match api_settings_path(app) {
        Ok(path) => {
            if let Err(e) = api_settings::save(&path, settings) {
                eprintln!("[api] {e}");
            }
        }
        Err(e) => eprintln!("[api] {e} The settings were not saved, so the next start will use a new token."),
    }
}

/// Whether the server is running, what it is bound to, and the settings the API tab edits.
#[tauri::command]
fn api_status(app: tauri::AppHandle) -> ApiStatus {
    #[cfg(desktop)]
    {
        app.state::<ApiState>().status()
    }
    #[cfg(not(desktop))]
    {
        let _ = &app;
        ApiStatus::unavailable()
    }
}

/// Saves new settings and restarts the listener if the port or the enabled flag changed.
#[tauri::command]
fn api_set_settings(app: tauri::AppHandle, settings: ApiSettings) -> ApiStatus {
    #[cfg(desktop)]
    {
        // Written before the listener starts, so the file on disk always matches what was asked for
        // even if the port turns out to be taken.
        save_api_settings(&app, &settings);
        app.state::<ApiState>().apply(&app, settings)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, settings);
        ApiStatus::unavailable()
    }
}

/// A new token. The old one stops working immediately, because the listener reads the token per
/// request rather than capturing it when it started.
#[tauri::command]
fn api_regenerate_token(app: tauri::AppHandle) -> Result<ApiStatus, String> {
    // One binding per platform, one exit below, rather than a `return` inside the `cfg` block: two
    // block expressions in a row do not both sit in tail position once one of them is compiled out.
    #[cfg(desktop)]
    let status = {
        let status = app.state::<ApiState>().regenerate_token(&app)?;
        // Saved before the new token is handed out: a token that existed only in memory would lock
        // the caller out on the next start, and would do it silently.
        save_api_settings(&app, &status.settings);
        status
    };
    #[cfg(not(desktop))]
    let status = {
        let _ = &app;
        ApiStatus::unavailable()
    };
    Ok(status)
}

/// The last few calls from outside the app, for the API tab's list.
#[tauri::command]
fn api_recent(app: tauri::AppHandle) -> Vec<RecentCall> {
    #[cfg(desktop)]
    {
        app.state::<ApiState>().recent()
    }
    #[cfg(not(desktop))]
    {
        let _ = &app;
        Vec::new()
    }
}

/// The webview's answer to an `api-request`, handed to the waiting HTTP thread by id.
#[tauri::command]
fn api_bridge_reply(app: tauri::AppHandle, id: String, result: String) {
    #[cfg(desktop)]
    {
        app.state::<ApiState>().bridge.reply(&id, result);
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, id, result);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Kotlin plugin that talks to Android's PrintManager.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_print::init());

    // Desktop only, and registered first so it is in place before anything else starts.
    //
    // Closing the window hides it to the tray, which means the process keeps running. Without this,
    // launching the app again starts a *second* process with a second tray icon, and every launch
    // after that adds another: the running copy is not found, it is duplicated. The second launch
    // is refused and handed to the one already running, which shows and focuses its window instead.
    //
    // Not on Android: its task switcher already brings the existing activity forward instead of
    // starting a second one, and the plugin has no part to play there.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        tray::show_main_window(app);
    }));

    builder
        .setup(|_app| {
            // Desktop only. On Android the equivalent is `BackgroundService.kt`, started and stopped
            // by the activity itself: a foreground service's notification has to be shown by the
            // service, so it cannot be driven from here.
            //
            // Not fatal: a failed tray leaves the app windowed as it was before, and
            // `tray::on_window_event` then lets Close quit rather than hiding a window with no way
            // back to it.
            //
            // `_app` rather than `app`, so the binding does not read as unused where there is no tray.
            #[cfg(desktop)]
            let _ = tray::setup(_app.handle());

            #[cfg(desktop)]
            {
                let state = ApiState::new(api_settings_or_default(_app.handle()));
                _app.manage(state);
                // Started after the window exists, so the first request cannot arrive before the
                // webview is listening for it.
                if let Some(state) = _app.try_state::<ApiState>() {
                    state.restart(_app.handle());
                }
            }
            Ok(())
        })
        // Only desktop has a window to hide; on mobile the activity is backgrounded by the system.
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            tray::on_window_event(window.app_handle(), window, event);
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            capabilities,
            fetch_json,
            list_printers,
            list_saved_printers,
            save_printer,
            delete_printer,
            test_printer,
            discover_printers,
            list_devices,
            api_status,
            api_set_settings,
            api_regenerate_token,
            api_recent,
            api_bridge_reply,
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
