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

/// What the UI is told about the paper size, plus the `-print-settings` string for SumatraPDF.
struct SumatraJob {
    settings: String,
    orientation: &'static str,
    paper_applied: bool,
    paper_note: String,
}

/// `-print-settings`: fit [,portrait|landscape] [,paper=NAME]. A paper SumatraPDF cannot set is left out.
fn sumatra_settings(paper: &str, orientation: &str) -> SumatraJob {
    let paper = paper.trim();
    let orientation = match orientation {
        "portrait" => "portrait",
        "landscape" => "landscape",
        _ => "auto",
    };

    let mut settings = vec!["fit".to_string()];
    if orientation != "auto" {
        settings.push(orientation.to_string());
    }
    let (paper_applied, paper_note) = if paper.is_empty() {
        (false, "No paper size selected; the printer driver's default paper is used.".to_string())
    } else if SUMATRA_PAPERS.iter().any(|n| n.eq_ignore_ascii_case(paper)) {
        settings.push(format!("paper={paper}"));
        (true, format!("Passed to SumatraPDF as paper={paper}."))
    } else {
        (false, format!(
            "\"{paper}\" was NOT sent: SumatraPDF only accepts A2-A6, letter, legal, tabloid and \
             statement. The printer driver's default paper is used."))
    };
    SumatraJob { settings: settings.join(","), orientation, paper_applied, paper_note }
}

fn sumatra_args(printer: &str, settings: &str) -> Vec<String> {
    vec![
        "-print-to".to_string(), printer.to_string(),
        "-print-settings".to_string(), settings.to_string(),
        "-silent".to_string(),
    ]
}

/// Parses the PowerShell output (one "600x600" per line): sorted, without duplicates or junk lines.
fn parse_resolutions(out: &str) -> Vec<String> {
    let mut found: Vec<(u32, u32)> = out.lines().filter_map(parse_dpi).collect();
    found.sort();
    found.dedup();
    found.into_iter().map(|(x, y)| format!("{x}x{y}")).collect()
}

/// Resolutions the printer driver reports, as "300x300" strings. Empty if it reports none.
pub fn printer_resolutions(printer: &str) -> Result<Vec<String>, String> {
    let out = run_ps(PS_LIST_DPI, &[("PRINT_NAME", printer)])?;
    Ok(parse_resolutions(&out))
}

pub fn list_printers() -> Vec<String> {
    printers::get_printers().into_iter().map(|p| p.name).collect()
}

pub fn print_pdf(opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    use std::os::windows::process::CommandExt;

    let printer = opts.printer.clone();
    let paper = opts.paper.trim().to_string();
    let dpi = opts.dpi.trim().to_string();
    let sumatra = sumatra_settings(&paper, &opts.orientation);
    let orientation = sumatra.orientation;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?
        .parent().ok_or("no exe dir")?.join("SumatraPDF.exe");
    let args = sumatra_args(&printer, &sumatra.settings);
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
            paper_applied: sumatra.paper_applied,
            paper_note: sumatra.paper_note,
            orientation: orientation.to_string(),
            dpi_requested: dpi,
            dpi_applied,
            dpi_note,
        }),
        Ok(s) => Err(format!("SumatraPDF exited with {s}")),
        Err(e) => Err(format!("could not start {}: {e}", exe.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The paper sizes the UI offers (NAMED_PAPERS in src/PrintPage.tsx). Every one must be accepted here.
    const UI_PAPERS: [&str; 9] = ["A2", "A3", "A4", "A5", "A6", "letter", "legal", "tabloid", "statement"];

    #[test]
    fn plain_job_fits_to_the_page() {
        let job = sumatra_settings("", "auto");
        assert_eq!(job.settings, "fit");
        assert_eq!(job.orientation, "auto");
        assert!(!job.paper_applied);
        assert!(job.paper_note.contains("default paper"));
    }

    #[test]
    fn orientation_is_added_after_fit() {
        assert_eq!(sumatra_settings("", "portrait").settings, "fit,portrait");
        assert_eq!(sumatra_settings("", "landscape").settings, "fit,landscape");
        assert_eq!(sumatra_settings("", "landscape").orientation, "landscape");
    }

    #[test]
    fn unknown_orientation_means_auto() {
        let job = sumatra_settings("", "sideways");
        assert_eq!(job.settings, "fit");
        assert_eq!(job.orientation, "auto");
    }

    #[test]
    fn named_paper_is_passed_on() {
        let job = sumatra_settings("A4", "auto");
        assert_eq!(job.settings, "fit,paper=A4");
        assert!(job.paper_applied);
        assert_eq!(job.paper_note, "Passed to SumatraPDF as paper=A4.");
    }

    #[test]
    fn paper_is_matched_ignoring_case_and_whitespace() {
        assert_eq!(sumatra_settings("  Letter ", "auto").settings, "fit,paper=Letter");
        assert!(sumatra_settings("TABLOID", "auto").paper_applied);
    }

    #[test]
    fn settings_keep_their_order() {
        assert_eq!(sumatra_settings("A5", "landscape").settings, "fit,landscape,paper=A5");
    }

    #[test]
    fn paper_sumatra_cannot_set_is_not_sent() {
        for paper in ["A7", "100x150mm", "Custom.100x150mm", "a4;rm"] {
            let job = sumatra_settings(paper, "portrait");
            assert_eq!(job.settings, "fit,portrait", "{paper}");
            assert!(!job.paper_applied, "{paper}");
            assert!(job.paper_note.contains("NOT sent"), "{paper}");
        }
    }

    #[test]
    fn every_paper_the_ui_offers_is_accepted() {
        for paper in UI_PAPERS {
            assert!(sumatra_settings(paper, "auto").paper_applied, "{paper}");
        }
    }

    #[test]
    fn sumatra_command_line() {
        assert_eq!(
            sumatra_args("Zebra ZD420", "fit,portrait"),
            ["-print-to", "Zebra ZD420", "-print-settings", "fit,portrait", "-silent"]
        );
    }

    #[test]
    fn quote_wraps_only_names_with_spaces() {
        assert_eq!(quote("Zebra"), "Zebra");
        assert_eq!(quote("Zebra ZD420"), "\"Zebra ZD420\"");
    }

    #[test]
    fn dpi_strings() {
        assert_eq!(parse_dpi("600x600"), Some((600, 600)));
        assert_eq!(parse_dpi(" 300 x 600 "), Some((300, 600)));
        assert_eq!(parse_dpi("600"), None);
        assert_eq!(parse_dpi("axb"), None);
        assert_eq!(parse_dpi(""), None);
    }

    #[test]
    fn powershell_resolutions_are_sorted_and_deduplicated() {
        assert_eq!(parse_resolutions("600x600\r\n300x300\r\n600x600\r\n1200x600\r\n"), ["300x300", "600x600", "1200x600"]);
    }

    #[test]
    fn powershell_resolutions_skip_junk_and_empty_output() {
        assert_eq!(parse_resolutions("300x300\nnot a resolution\n\n"), ["300x300"]);
        assert!(parse_resolutions("").is_empty());
    }
}
