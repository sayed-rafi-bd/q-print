//! Windows backend: SumatraPDF for printing, PowerShell + System.Printing for resolutions.

use crate::{PrintOptions, PrintReport};
use std::process::Command;

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
pub fn printer_resolutions(printer: &str) -> Result<Vec<String>, String> {
    let out = run_ps(PS_LIST_DPI, &[("PRINT_NAME", printer)])?;
    let mut found: Vec<(u32, u32)> = out.lines().filter_map(parse_dpi).collect();
    found.sort();
    found.dedup();
    Ok(found.into_iter().map(|(x, y)| format!("{x}x{y}")).collect())
}

pub fn list_printers() -> Vec<String> {
    printers::get_printers().into_iter().map(|p| p.name).collect()
}

pub fn print_pdf(opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    use std::os::windows::process::CommandExt;

    let printer = opts.printer.clone();
    let paper = opts.paper.trim().to_string();
    let dpi = opts.dpi.trim().to_string();
    let orientation = match opts.orientation.as_str() {
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
            transport: "sumatra".into(),
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

