use rand::{seq::SliceRandom, Rng};
use serde::Serialize;
use std::process::Command;

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

#[tauri::command]
fn list_printers() -> Vec<String> {
    printers::get_printers().into_iter().map(|p| p.name).collect()
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

/// What was actually handed to SumatraPDF, so the UI can show it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintReport {
    tool: String,
    command: String,
    paper_requested: String,
    paper_applied: bool,
    paper_note: String,
    orientation: String,
}

// Paper names SumatraPDF's `paper=` setting accepts.
const SUMATRA_PAPERS: [&str; 9] = ["A2", "A3", "A4", "A5", "A6", "letter", "legal", "tabloid", "statement"];

fn quote(s: &str) -> String {
    if s.contains(' ') { format!("\"{s}\"") } else { s.to_string() }
}

#[tauri::command]
fn print_pdf(printer: String, paper: String, orientation: String, bytes: Vec<u8>)
    -> Result<PrintReport, String> {
    use std::os::windows::process::CommandExt;

    let paper = paper.trim().to_string();
    let orientation = match orientation.as_str() {
        "portrait" => "portrait",
        "landscape" => "landscape",
        _ => "auto",
    };

    // -print-settings: fit [,portrait|landscape] [,paper=NAME]
    let mut settings = vec!["fit".to_string()];
    if orientation != "auto" {
        settings.push(orientation.to_string());
    }
    let (paper_applied, paper_note) = if paper.is_empty() {
        (false, "No paper size selected; the printer driver's default paper is used.".to_string())
    } else if SUMATRA_PAPERS.iter().any(|n| n.eq_ignore_ascii_case(&paper)) {
        settings.push(format!("paper={paper}"));
        (true, format!("Passed to SumatraPDF as paper={paper}."))
    } else {
        (false, format!(
            "\"{paper}\" was NOT sent: SumatraPDF only accepts A2-A6, letter, legal, tabloid and \
             statement. The printer driver's default paper is used."))
    };

    let exe = std::env::current_exe().map_err(|e| e.to_string())?
        .parent().ok_or("no exe dir")?.join("SumatraPDF.exe");
    let args = vec![
        "-print-to".to_string(), printer.clone(),
        "-print-settings".to_string(), settings.join(","),
        "-silent".to_string(),
    ];
    let shown: Vec<String> = args.iter().map(|s| quote(s)).collect();
    let report = PrintReport {
        tool: "SumatraPDF".into(),
        command: format!("SumatraPDF.exe {} <file.pdf>", shown.join(" ")),
        paper_requested: paper.clone(),
        paper_applied,
        paper_note,
        orientation: orientation.to_string(),
    };
    eprintln!("[print] paper requested: {:?} | {}", paper, report.command);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("print-{nanos}.pdf"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;

    let status = Command::new(&exe)
        .args(&args)
        .arg(&path)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    let _ = std::fs::remove_file(&path);

    match status {
        Ok(s) if s.success() => Ok(report),
        Ok(s) => Err(format!("SumatraPDF exited with {s}")),
        Err(e) => Err(format!("could not start {}: {e}", exe.display())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_printers, generate_random_data, print_pdf])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
