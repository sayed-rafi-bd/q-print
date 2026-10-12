use rand::{seq::SliceRandom, Rng};
use serde::Serialize;
use std::process::Command;
use tauri::Manager;

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
    dpi_requested: String,
    dpi_applied: bool,
    dpi_note: String,
}

// Paper names SumatraPDF's `paper=` setting accepts.
const SUMATRA_PAPERS: [&str; 9] = ["A2", "A3", "A4", "A5", "A6", "letter", "legal", "tabloid", "statement"];
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn quote(s: &str) -> String {
    if s.contains(' ') { format!("\"{s}\"") } else { s.to_string() }
}

// ---- printer resolution (dpi) via the Windows print ticket (System.Printing) ----

const PS_PRELUDE: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Printing
$srv = New-Object System.Printing.LocalPrintServer
$q = $srv.GetPrintQueue($env:PRINT_NAME)
"#;

const PS_LIST_DPI: &str = r#"
$q.GetPrintCapabilities().PageResolutionCapability | ForEach-Object { "{0}x{1}" -f $_.X, $_.Y }
"#;

// Back up the user's current print ticket, then set the resolution on it.
const PS_APPLY_DPI: &str = r#"
$s = $q.UserPrintTicket.GetXmlStream(); $s.Position = 0
$ms = New-Object IO.MemoryStream; $s.CopyTo($ms)
[IO.File]::WriteAllBytes($env:PRINT_BACKUP, $ms.ToArray())
$q.UserPrintTicket.PageResolution = New-Object -TypeName System.Printing.PageResolution -ArgumentList ([int]$env:PRINT_DPI_X), ([int]$env:PRINT_DPI_Y)
$q.Commit()
"#;

const PS_RESTORE_DPI: &str = r#"
$bytes = [IO.File]::ReadAllBytes($env:PRINT_BACKUP)
$ms = New-Object -TypeName IO.MemoryStream -ArgumentList (,$bytes)
$q.UserPrintTicket = New-Object -TypeName System.Printing.PrintTicket -ArgumentList $ms
$q.Commit()
Remove-Item $env:PRINT_BACKUP -Force
"#;

fn run_ps(body: &str, envs: &[(&str, &str)]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let script = format!("{}{}", PS_PRELUDE, body);
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .envs(envs.iter().copied())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not start powershell: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("powershell exited with {}", out.status) } else { err })
    }
}

fn parse_dpi(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.trim().split_once('x')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Resolutions the printer driver reports, as "300x300" strings. Empty if it reports none.
#[tauri::command]
fn printer_resolutions(printer: String) -> Result<Vec<String>, String> {
    let out = run_ps(PS_LIST_DPI, &[("PRINT_NAME", &printer)])?;
    let mut found: Vec<(u32, u32)> = out.lines().filter_map(parse_dpi).collect();
    found.sort();
    found.dedup();
    Ok(found.into_iter().map(|(x, y)| format!("{x}x{y}")).collect())
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

#[tauri::command]
fn print_pdf(printer: String, paper: String, orientation: String, dpi: String, bytes: Vec<u8>)
    -> Result<PrintReport, String> {
    use std::os::windows::process::CommandExt;

    let paper = paper.trim().to_string();
    let dpi = dpi.trim().to_string();
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
    let command = format!("SumatraPDF.exe {} <file.pdf>", shown.join(" "));
    eprintln!("[print] paper: {:?} | dpi: {:?} | {}", paper, dpi, command);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!("print-{nanos}.pdf"));
    let backup = std::env::temp_dir().join(format!("print-ticket-{nanos}.xml"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;

    // Optional: set the printer resolution for this job (previous settings are restored afterwards).
    let mut dpi_applied = false;
    let mut dpi_note = "No resolution selected; the printer's current default is used.".to_string();
    if !dpi.is_empty() {
        let applied = parse_dpi(&dpi)
            .ok_or_else(|| format!("invalid resolution \"{dpi}\""))
            .and_then(|(x, y)| {
                run_ps(PS_APPLY_DPI, &[
                    ("PRINT_NAME", printer.as_str()),
                    ("PRINT_DPI_X", &x.to_string()),
                    ("PRINT_DPI_Y", &y.to_string()),
                    ("PRINT_BACKUP", &backup.display().to_string()),
                ])
                .map(|_| (x, y))
            });
        match applied {
            Ok((x, y)) => {
                dpi_applied = true;
                dpi_note = format!(
                    "Printer resolution set to {x} x {y} dpi for this job; your previous settings are restored afterwards.");
            }
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                return Err(format!("could not set {dpi} dpi on \"{printer}\": {e}"));
            }
        }
    }

    let status = Command::new(&exe)
        .args(&args)
        .arg(&path)
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = std::fs::remove_file(&path);

    if dpi_applied {
        if let Err(e) = run_ps(PS_RESTORE_DPI, &[
            ("PRINT_NAME", printer.as_str()),
            ("PRINT_BACKUP", &backup.display().to_string()),
        ]) {
            dpi_note.push_str(&format!(" WARNING: could not restore the previous printer settings: {e}"));
        }
    }

    match status {
        Ok(s) if s.success() => Ok(PrintReport {
            tool: "SumatraPDF".into(),
            command,
            paper_requested: paper,
            paper_applied,
            paper_note,
            orientation: orientation.to_string(),
            dpi_requested: dpi,
            dpi_applied,
            dpi_note,
        }),
        Ok(s) => Err(format!("SumatraPDF exited with {s}")),
        Err(e) => Err(format!("could not start {}: {e}", exe.display())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_printers,
            generate_random_data,
            printer_resolutions,
            print_pdf,
            load_template,
            save_template,
            reset_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running app");
}
