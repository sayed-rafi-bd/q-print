use rand::{seq::SliceRandom, Rng};
use serde::{Deserialize, Serialize};
use tauri::Manager;

// Platform print backends. Each exposes the same functions; only one is compiled in.
#[cfg(target_os = "windows")]
#[path = "print_windows.rs"]
mod platform;
#[cfg(target_os = "android")]
#[path = "print_android.rs"]
mod platform;
#[cfg(not(any(target_os = "windows", target_os = "android")))]
#[path = "print_other.rs"]
mod platform;

// camelCase keys match the field names in src/templates/label.json
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabelData {
    zip: String,
    zip_barcode: String,
    address: String,
    sort_main: String,
    sort_sub: String,
    tel: String,
    recipient: String,
    inquiry_no: String,
    count: String,
    carrier_name: String,
    ship_date: String,
    delivery_date: String,
    time_slot: String,
    amount: String,
    request_no: String,
    sender_name: String,
    sender_zip: String,
    sender_address: String,
    sender_building: String,
    sender_tel: String,
}

const DESTINATIONS: [(&str, &str); 4] = [
    ("150-0021", "東京都渋谷区恵比寿西1-13-7"),
    ("100-0005", "東京都千代田区丸の内1-9-1"),
    ("530-0001", "大阪府大阪市北区梅田3-1-1"),
    ("460-0008", "愛知県名古屋市中区栄3-4-5"),
];
const NAMES: [&str; 4] = ["トントンタン", "山田 太郎", "佐藤 花子", "鈴木 一郎"];
const TIME_SLOTS: [&str; 4] = ["午前中", "14時〜16時", "16時〜18時", "18時〜20時"];

fn digits(rng: &mut impl Rng, n: usize) -> String {
    (0..n).map(|_| rng.gen_range(0..10).to_string()).collect()
}

fn yen(n: u32) -> String {
    if n >= 1000 {
        format!("¥{},{:03}", n / 1000, n % 1000)
    } else {
        format!("¥{n}")
    }
}

/// Random data API: one entry per page.
#[tauri::command]
fn generate_random_data(count: usize) -> Vec<LabelData> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let (zip, address) = *DESTINATIONS.choose(&mut rng).unwrap();
            let day = rng.gen_range(1..26);
            LabelData {
                zip: format!("〒{zip}"),
                zip_barcode: zip.replace('-', ""),
                address: address.to_string(),
                sort_main: digits(&mut rng, 4),
                sort_sub: digits(&mut rng, 3),
                tel: format!("TEL:0{}", digits(&mut rng, 10)),
                recipient: format!("{}様", NAMES.choose(&mut rng).unwrap()),
                inquiry_no: format!("A{}A", digits(&mut rng, 12)),
                count: rng.gen_range(1..6).to_string(),
                carrier_name: "佐川代引（LC）".to_string(),
                ship_date: format!("2026/10/{day:02}"),
                delivery_date: format!("2026/10/{:02}", day + 2),
                time_slot: TIME_SLOTS.choose(&mut rng).unwrap().to_string(),
                amount: yen(rng.gen_range(1..40) * 100),
                request_no: digits(&mut rng, 9),
                sender_name: "FMHテスト用(テスト環境00)".to_string(),
                sender_zip: "〒150-0021".to_string(),
                sender_address: "東京都渋谷区恵比寿西1-13-7".to_string(),
                sender_building: "ＫＢＳアーチビル".to_string(),
                sender_tel: "TEL: 0357840340".to_string(),
            }
        })
        .collect()
}

/// What was actually handed to the print transport, so the UI can show it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintReport {
    /// "sumatra" | "android-dialog" (later: "ipp" | "vendor")
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
    platform: &'static str, // "windows" | "android" | "other"
    transport: &'static str,
    silent: bool,             // prints without a dialog
    paper_select: bool,       // SumatraPDF named sizes / IPP media
    orientation_select: bool,
    dpi_select: bool,
    printer_list: bool,       // false => show an "Add printer" UI
}

#[tauri::command]
fn capabilities() -> Capabilities {
    if cfg!(target_os = "windows") {
        Capabilities {
            platform: "windows", transport: "sumatra", silent: true,
            paper_select: true, orientation_select: true, dpi_select: true, printer_list: true,
        }
    } else if cfg!(target_os = "android") {
        Capabilities {
            platform: "android", transport: "android-dialog", silent: false,
            paper_select: false, orientation_select: false, dpi_select: false, printer_list: true,
        }
    } else {
        Capabilities {
            platform: "other", transport: "none", silent: false,
            paper_select: false, orientation_select: false, dpi_select: false, printer_list: false,
        }
    }
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

fn template_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("label-template.json"))
}

/// Saved pdfme template (JSON text), or None if the designer has never saved one.
#[tauri::command]
fn load_template(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = template_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

/// Saves the designer's template; returns the file path.
#[tauri::command]
fn save_template(app: tauri::AppHandle, json: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid template JSON: {e}"))?;
    let path = template_path(&app)?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Deletes the saved template so the built-in default is used again.
#[tauri::command]
fn reset_template(app: tauri::AppHandle) -> Result<(), String> {
    let path = template_path(&app)?;
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
            generate_random_data,
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
