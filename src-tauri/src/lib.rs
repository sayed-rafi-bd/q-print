use rand::{seq::SliceRandom, Rng};
use serde::{Deserialize, Serialize};
use tauri::Manager;

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

// Product / location label (190 x 160 mm). Field names match src/templates/product-label.json.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductLabelData {
    item_barcode: String,
    item_code_text: String,
    issue_date: String,
    brand_name: String,
    product_code: String,
    product_name: String,
    loc_zone: String,
    loc_code: String,
    tracking_barcode: String,
    tracking_text: String,
    warehouse: String,
    operator: String,
}

// (brand, product name)
const PRODUCTS: [(&str, &str); 4] = [
    ("ケラスターセ", "EC専用 SP バンディバレント R 250ml"),
    ("ミルボン", "EC専用 ディーセス エルジューダ 120ml"),
    ("資生堂", "EC専用 プロフェッショナル ヘアマスク 200g"),
    ("ロレアル", "EC専用 セリエ エクスパート 500ml"),
];

fn generate_product_data(count: usize) -> Vec<ProductLabelData> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let (brand, name) = *PRODUCTS.choose(&mut rng).unwrap();
            let zone = rng.gen_range(10..60);
            let tracking = digits(&mut rng, 13);
            let item_code = format!("100{}", digits(&mut rng, 4));
            ProductLabelData {
                item_barcode: item_code.clone(),
                item_code_text: item_code,
                issue_date: format!("2610{:02} 再", rng.gen_range(1..26)),
                brand_name: brand.to_string(),
                product_code: format!("035{}", digits(&mut rng, 10)),
                product_name: name.to_string(),
                loc_zone: format!("{zone}-"),
                loc_code: format!("{zone}-{}-{}", rng.gen_range(1..10), rng.gen_range(10..100)),
                tracking_barcode: tracking.clone(),
                tracking_text: tracking,
                warehouse: "Chiba・ロジ".to_string(),
                operator: "SUJON MD SAIDUR".to_string(),
            }
        })
        .collect()
}

/// Labels the app knows. Keep in sync with `LABELS` in src/labels.ts. The first one is the default.
const LABEL_IDS: [&str; 2] = ["shipping", "product"];

/// Validates the label id coming from the UI (it ends up in a file name).
fn label_id(label: &Option<String>) -> Result<&str, String> {
    let id = label.as_deref().unwrap_or(LABEL_IDS[0]);
    LABEL_IDS.iter().copied().find(|l| *l == id).ok_or_else(|| format!("unknown label \"{id}\""))
}

fn to_json_rows<T: Serialize>(rows: Vec<T>) -> Result<Vec<serde_json::Value>, String> {
    rows.iter().map(|r| serde_json::to_value(r).map_err(|e| e.to_string())).collect()
}

/// Random data API: one entry per page, shaped for the chosen label.
#[tauri::command]
fn generate_random_data(count: usize, label: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    match label_id(&label)? {
        "product" => to_json_rows(generate_product_data(count)),
        _ => to_json_rows(generate_shipping_data(count)),
    }
}

fn generate_shipping_data(count: usize) -> Vec<LabelData> {
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

/// One template file per label. The first (default) label keeps the original file name, so a
/// template saved before labels existed is still picked up.
fn template_path(app: &tauri::AppHandle, label: &Option<String>) -> Result<std::path::PathBuf, String> {
    let id = label_id(label)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(if id == LABEL_IDS[0] {
        "label-template.json".to_string()
    } else {
        format!("label-template-{id}.json")
    }))
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
