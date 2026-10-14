//! Linux backend: the CUPS command-line tools (`lpstat`, `lpoptions`, `lp`).
//!
//! Printing is silent: the PDF is piped to `lp` and goes straight to the CUPS queue, scaled to fit
//! the page. Paper sizes and resolutions are read from the printer's PPD (`lpoptions -l`), so only
//! values the printer really offers are sent. Everything is a job option, so the printer's saved
//! defaults are never changed and nothing has to be restored afterwards.

use crate::{PrintOptions, PrintReport};
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::AppHandle;

// PPD option keywords, in the order they are tried.
const RESOLUTION_KEYS: [&str; 3] = ["Resolution", "PrinterResolution", "OutputResolution"];
const PAGE_SIZE_KEYS: [&str; 2] = ["PageSize", "PageRegion"];

// IPP `orientation-requested` values.
const ORIENTATION_PORTRAIT: &str = "3";
const ORIENTATION_LANDSCAPE: &str = "4";

// ---- running the CUPS tools ----

fn cups(tool: &str) -> Command {
    let mut cmd = Command::new(tool);
    // An AppImage's AppRun points LD_LIBRARY_PATH at the libraries bundled in the image. The system
    // CUPS tools must load the system libraries instead.
    if std::env::var_os("APPDIR").is_some() {
        cmd.env_remove("LD_LIBRARY_PATH");
    }
    cmd
}

fn spawn_error(tool: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!(
            "`{tool}` was not found. Printing on Linux needs the CUPS client tools: \
             install `cups-client` (Debian/Ubuntu: sudo apt install cups-client, Fedora: sudo dnf install cups-client)."
        )
    } else {
        format!("could not start `{tool}`: {e}")
    }
}

fn failure(tool: &str, status: std::process::ExitStatus, stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr).trim().to_string();
    if err.is_empty() { format!("`{tool}` exited with {status}") } else { err }
}

/// Runs a CUPS tool to completion and returns its standard output.
fn run(tool: &str, args: &[&str]) -> Result<String, String> {
    let out = cups(tool).args(args).output().map_err(|e| spawn_error(tool, e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(failure(tool, out.status, &out.stderr))
    }
}

// ---- printer list ----

/// `lpstat -e` prints one destination per line; `lpstat -a` prints `NAME accepting requests since ...`.
fn parse_destinations(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in text.lines().filter_map(|l| l.split_whitespace().next()) {
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// `system default destination: NAME` (run with LC_ALL=C so the wording is stable).
fn parse_default_destination(text: &str) -> Option<String> {
    let (_, name) = text.trim().split_once(": ")?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub fn list_printers(_app: &AppHandle) -> Vec<String> {
    destinations()
}

fn destinations() -> Vec<String> {
    // `-e` lists every destination CUPS knows, including network printers it discovered itself.
    // Very old CUPS versions lack it, so fall back to the queues that accept jobs (`-a`).
    let mut names = run("lpstat", &["-e"]).map(|s| parse_destinations(&s)).unwrap_or_default();
    if names.is_empty() {
        match run("lpstat", &["-a"]) {
            Ok(s) => names = parse_destinations(&s),
            Err(e) => eprintln!("[print] could not list printers: {e}"),
        }
    }
    // Put the system default first: the UI selects the first entry.
    let default = cups("lpstat")
        .env("LC_ALL", "C")
        .arg("-d")
        .output()
        .ok()
        .and_then(|o| parse_default_destination(&String::from_utf8_lossy(&o.stdout)));
    if let Some(pos) = default.and_then(|d| names.iter().position(|n| *n == d)) {
        let d = names.remove(pos);
        names.insert(0, d);
    }
    names
}

// ---- printer options (PPD) ----

/// One line of `lpoptions -p NAME -l`, e.g. `PageSize/Media Size: *A4 Letter Legal`.
#[derive(Debug, PartialEq)]
struct PpdOption {
    key: String,
    values: Vec<String>,
}

fn parse_options(text: &str) -> Vec<PpdOption> {
    text.lines()
        .filter_map(|line| {
            let (head, rest) = line.split_once(": ")?;
            // Option lines always look like `Key/Label: values`; anything else is a message.
            let (key, _label) = head.split_once('/')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let values = rest
                .split_whitespace()
                .map(|v| v.trim_start_matches('*').to_string())
                .filter(|v| !v.is_empty())
                .collect();
            Some(PpdOption { key: key.to_string(), values })
        })
        .collect()
}

/// The first option found, trying the keywords in priority order.
fn find_option<'a>(options: &'a [PpdOption], keys: &[&str]) -> Option<&'a PpdOption> {
    keys.iter().find_map(|k| options.iter().find(|o| o.key.eq_ignore_ascii_case(k)))
}

/// `600dpi`, `600x1200dpi` or `600` -> (x, y). Non-numeric choices such as `Normal` give None.
fn parse_resolution(value: &str) -> Option<(u32, u32)> {
    let v = value.trim().to_ascii_lowercase();
    let v = v.strip_suffix("dpi").unwrap_or(&v);
    let (x, y) = match v.split_once('x') {
        Some((x, y)) => (x.trim().parse().ok()?, y.trim().parse().ok()?),
        None => {
            let n = v.trim().parse().ok()?;
            (n, n)
        }
    };
    (x > 0 && y > 0).then_some((x, y))
}

/// Resolutions the PPD offers as (value to pass to CUPS, x, y).
fn resolutions(options: &[PpdOption]) -> Vec<(String, u32, u32)> {
    find_option(options, &RESOLUTION_KEYS)
        .map(|o| {
            o.values
                .iter()
                .filter_map(|v| parse_resolution(v).map(|(x, y)| (v.clone(), x, y)))
                .collect()
        })
        .unwrap_or_default()
}

/// The printer's options from its PPD. Empty for queues without one (raw queues).
fn printer_options(printer: &str) -> Result<Vec<PpdOption>, String> {
    run("lpoptions", &["-p", printer, "-l"]).map(|s| parse_options(&s))
}

/// Resolutions the printer reports, as "300x300" strings. Empty if it reports none.
pub fn printer_resolutions(printer: &str) -> Result<Vec<String>, String> {
    let mut found: Vec<(u32, u32)> = resolutions(&printer_options(printer)?).into_iter().map(|(_, x, y)| (x, y)).collect();
    found.sort();
    found.dedup();
    Ok(found.into_iter().map(|(x, y)| format!("{x}x{y}")).collect())
}

// ---- building the print job ----

/// The `lp` arguments for a job, plus what the UI reports about each option.
struct Job {
    args: Vec<String>,
    orientation: &'static str,
    paper_applied: bool,
    paper_note: String,
    dpi_applied: bool,
    dpi_note: String,
}

/// `ppd` is None when the printer's options could not be read; paper is then sent unchecked.
fn build_job(opts: &PrintOptions, ppd: Option<&[PpdOption]>) -> Result<Job, String> {
    let printer = opts.printer.trim();
    if printer.is_empty() {
        return Err("no printer selected".into());
    }
    let paper = opts.paper.trim();
    let dpi = opts.dpi.trim();

    let mut args: Vec<String> = ["-d", printer, "-t", "Q-Print label", "-o", "fit-to-page"]
        .into_iter()
        .map(String::from)
        .collect();

    let orientation = match opts.orientation.as_str() {
        "portrait" => {
            args.extend(["-o".into(), format!("orientation-requested={ORIENTATION_PORTRAIT}")]);
            "portrait"
        }
        "landscape" => {
            args.extend(["-o".into(), format!("orientation-requested={ORIENTATION_LANDSCAPE}")]);
            "landscape"
        }
        _ => "auto",
    };

    // Paper size: sent as `media=` only if the printer lists it, using the PPD's own spelling.
    let (paper_applied, paper_note) = if paper.is_empty() {
        (false, "No paper size selected; the printer's default paper is used.".to_string())
    } else if !paper.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(format!("invalid paper size \"{paper}\""));
    } else {
        match ppd.and_then(|p| find_option(p, &PAGE_SIZE_KEYS)) {
            Some(sizes) => match sizes.values.iter().find(|v| v.eq_ignore_ascii_case(paper)) {
                Some(listed) => {
                    args.extend(["-o".into(), format!("media={listed}")]);
                    (true, format!("Passed to CUPS as media={listed}."))
                }
                None => {
                    let offered: Vec<&str> = sizes.values.iter().take(10).map(String::as_str).collect();
                    (false, format!(
                        "\"{paper}\" was NOT sent: this printer does not list it (it offers {}). \
                         The printer's default paper is used.",
                        offered.join(", ")))
                }
            },
            None => {
                args.extend(["-o".into(), format!("media={paper}")]);
                (true, format!(
                    "Passed to CUPS as media={paper}. The printer's size list could not be read, so CUPS decides whether it applies."))
            }
        }
    };

    // Resolution: must be one the printer lists, because the option name and value come from its PPD.
    let (dpi_applied, dpi_note) = if dpi.is_empty() {
        (false, "No resolution selected; the printer's default is used.".to_string())
    } else {
        let (x, y) = parse_dpi(dpi).ok_or_else(|| format!("invalid resolution \"{dpi}\""))?;
        let key = ppd.and_then(|p| find_option(p, &RESOLUTION_KEYS)).map(|o| o.key.as_str());
        let value = ppd.and_then(|p| resolutions(p).into_iter().find(|&(_, rx, ry)| rx == x && ry == y));
        match (key, value) {
            (Some(key), Some((value, _, _))) => {
                args.extend(["-o".into(), format!("{key}={value}")]);
                (true, format!(
                    "Passed to CUPS as {key}={value} for this job only; the printer's saved defaults are not changed."))
            }
            _ => return Err(format!("could not set {dpi} dpi on \"{printer}\": the printer does not list that resolution")),
        }
    };

    Ok(Job { args, orientation, paper_applied, paper_note, dpi_applied, dpi_note })
}

fn parse_dpi(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.trim().split_once('x')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

fn quote(s: &str) -> String {
    if s.contains(|c: char| c.is_whitespace() || c == '"') { format!("\"{}\"", s.replace('"', "\\\"")) } else { s.to_string() }
}

pub fn print_pdf(_app: &AppHandle, opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    submit(opts, bytes)
}

fn submit(opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    // If the options can't be read (a raw queue, or CUPS missing) the job is still attempted; a missing
    // CUPS then fails below with the install hint.
    let ppd = printer_options(opts.printer.trim()).ok();
    let job = build_job(opts, ppd.as_deref())?;

    let shown: Vec<String> = job.args.iter().map(|s| quote(s)).collect();
    let command = format!("lp {} < file.pdf", shown.join(" "));
    eprintln!("[print] paper: {:?} | dpi: {:?} | {}", opts.paper, opts.dpi, command);

    // The PDF goes in through stdin, so no temp file has to be written or cleaned up.
    let mut child = cups("lp")
        .args(&job.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| spawn_error("lp", e))?;
    let sent = child
        .stdin
        .take()
        .ok_or("could not open lp's input")?
        .write_all(&bytes); // stdin is dropped here, which ends the input
    let out = child.wait_with_output().map_err(|e| e.to_string())?;

    // If lp rejected the job and quit early, its message is more useful than the broken pipe.
    if !out.status.success() {
        return Err(failure("lp", out.status, &out.stderr));
    }
    sent.map_err(|e| format!("could not send the PDF to lp: {e}"))?;
    eprintln!("[print] {}", String::from_utf8_lossy(&out.stdout).trim());

    Ok(PrintReport {
        transport: "cups".into(),
        tool: "lp (CUPS)".into(),
        command,
        paper_requested: opts.paper.trim().to_string(),
        paper_applied: job.paper_applied,
        paper_note: job.paper_note,
        orientation: job.orientation.to_string(),
        dpi_requested: opts.dpi.trim().to_string(),
        dpi_applied: job.dpi_applied,
        dpi_note: job.dpi_note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "\
PageSize/Media Size: A4 *Letter Legal A6 Custom.WIDTHxHEIGHT
PageRegion/PageRegion: A4 Letter Legal A6
Resolution/Output Resolution: 300dpi *600dpi 1200x600dpi Draft
Duplex/2-Sided Printing: *None DuplexNoTumble
";

    fn opts(paper: &str, orientation: &str, dpi: &str) -> PrintOptions {
        PrintOptions { printer: "Zebra".into(), paper: paper.into(), orientation: orientation.into(), dpi: dpi.into() }
    }

    /// A valid one-page 100 x 150 mm PDF (the xref offsets are computed, so no viewer has to repair it).
    fn minimal_pdf() -> Vec<u8> {
        let objects = [
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            "<</Type/Pages/Kids[3 0 R]/Count 1>>".to_string(),
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 283 425]>>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for off in offsets {
            pdf.extend(format!("{off:010} 00000 n \n").bytes());
        }
        pdf.extend(format!("trailer\n<</Root 1 0 R/Size {}>>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
        pdf
    }

    fn has_pair(args: &[String], value: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-o" && w[1] == value)
    }

    #[test]
    fn destinations_from_e_and_a() {
        assert_eq!(parse_destinations("Zebra\nOffice_Laser\nZebra\n"), ["Zebra", "Office_Laser"]);
        assert_eq!(
            parse_destinations("Zebra accepting requests since Tue 14 Oct 2026 16:37:00\nHP accepting requests since x\n"),
            ["Zebra", "HP"]
        );
        assert!(parse_destinations("").is_empty());
    }

    #[test]
    fn default_destination() {
        assert_eq!(parse_default_destination("system default destination: Zebra\n").as_deref(), Some("Zebra"));
        assert_eq!(parse_default_destination("no system default destination\n"), None);
    }

    #[test]
    fn options_are_parsed_without_the_default_marker() {
        let o = parse_options(LISTING);
        assert_eq!(o.len(), 4);
        assert_eq!(o[0].key, "PageSize");
        assert_eq!(o[0].values, ["A4", "Letter", "Legal", "A6", "Custom.WIDTHxHEIGHT"]);
        assert_eq!(find_option(&o, &PAGE_SIZE_KEYS).unwrap().key, "PageSize");
        assert!(parse_options("lpoptions: Unable to get PPD file").is_empty());
    }

    #[test]
    fn resolution_values() {
        assert_eq!(parse_resolution("600dpi"), Some((600, 600)));
        assert_eq!(parse_resolution("1200x600dpi"), Some((1200, 600)));
        assert_eq!(parse_resolution("300"), Some((300, 300)));
        assert_eq!(parse_resolution("Draft"), None);
        assert_eq!(parse_resolution("0dpi"), None);
    }

    #[test]
    fn plain_job_scales_to_fit() {
        let job = build_job(&opts("", "auto", ""), Some(&parse_options(LISTING))).unwrap();
        assert_eq!(job.args, ["-d", "Zebra", "-t", "Q-Print label", "-o", "fit-to-page"]);
        assert!(!job.paper_applied && !job.dpi_applied);
        assert_eq!(job.orientation, "auto");
    }

    #[test]
    fn orientation_maps_to_ipp_values() {
        let ppd = parse_options(LISTING);
        assert!(has_pair(&build_job(&opts("", "portrait", ""), Some(&ppd)).unwrap().args, "orientation-requested=3"));
        assert!(has_pair(&build_job(&opts("", "landscape", ""), Some(&ppd)).unwrap().args, "orientation-requested=4"));
    }

    #[test]
    fn paper_uses_the_printers_own_spelling() {
        let job = build_job(&opts("letter", "auto", ""), Some(&parse_options(LISTING))).unwrap();
        assert!(job.paper_applied);
        assert!(has_pair(&job.args, "media=Letter"));
    }

    #[test]
    fn paper_the_printer_does_not_list_is_not_sent() {
        let job = build_job(&opts("A3", "auto", ""), Some(&parse_options(LISTING))).unwrap();
        assert!(!job.paper_applied);
        assert!(!job.args.iter().any(|a| a.starts_with("media=")));
        assert!(job.paper_note.contains("NOT sent"));
    }

    #[test]
    fn paper_is_sent_unchecked_when_the_size_list_is_unreadable() {
        let job = build_job(&opts("A4", "auto", ""), None).unwrap();
        assert!(job.paper_applied);
        assert!(has_pair(&job.args, "media=A4"));
    }

    #[test]
    fn paper_with_odd_characters_is_rejected() {
        assert!(build_job(&opts("A4,Letter", "auto", ""), None).is_err());
        assert!(build_job(&opts("A4 -o x=y", "auto", ""), None).is_err());
    }

    #[test]
    fn resolution_uses_the_ppd_key_and_value() {
        let ppd = parse_options(LISTING);
        let job = build_job(&opts("", "auto", "600x600"), Some(&ppd)).unwrap();
        assert!(job.dpi_applied);
        assert!(has_pair(&job.args, "Resolution=600dpi"));
        let job = build_job(&opts("", "auto", "1200x600"), Some(&ppd)).unwrap();
        assert!(has_pair(&job.args, "Resolution=1200x600dpi"));
    }

    #[test]
    fn unlisted_or_unknown_resolution_is_an_error() {
        let ppd = parse_options(LISTING);
        assert!(build_job(&opts("", "auto", "203x203"), Some(&ppd)).is_err());
        assert!(build_job(&opts("", "auto", "600x600"), None).is_err());
        assert!(build_job(&opts("", "auto", "fast"), Some(&ppd)).is_err());
    }

    #[test]
    fn resolutions_listed_for_the_ui() {
        let r = resolutions(&parse_options(LISTING));
        assert_eq!(r.iter().map(|(v, _, _)| v.as_str()).collect::<Vec<_>>(), ["300dpi", "600dpi", "1200x600dpi"]);
    }

    // A real round trip: needs a running CUPS server and a queue (a virtual PDF printer is enough).
    //   Q_PRINT_TEST_PRINTER=PDF cargo test print_linux -- --ignored --nocapture
    #[test]
    #[ignore = "needs a running CUPS server and a queue named in Q_PRINT_TEST_PRINTER"]
    fn prints_through_a_real_cups_queue() {
        let printer = std::env::var("Q_PRINT_TEST_PRINTER").expect("set Q_PRINT_TEST_PRINTER");
        assert!(destinations().contains(&printer), "{printer} is not in the printer list {:?}", destinations());

        let options = printer_options(&printer).unwrap();
        eprintln!("options: {options:?}");
        let sizes = find_option(&options, &PAGE_SIZE_KEYS).map(|o| o.values.clone()).unwrap_or_default();
        let paper = sizes.iter().find(|s| s.eq_ignore_ascii_case("a4")).cloned().unwrap_or_default();
        let dpi = printer_resolutions(&printer).unwrap().into_iter().next().unwrap_or_default();
        eprintln!("paper: {paper:?}, dpi: {dpi:?}");

        let report = submit(
            &PrintOptions { printer, paper: paper.to_lowercase(), orientation: "portrait".into(), dpi },
            minimal_pdf(),
        )
        .unwrap();
        eprintln!("{} | {} | {} | {}", report.command, report.paper_note, report.dpi_note, report.orientation);
        assert_eq!(report.transport, "cups");
    }

    #[test]
    fn empty_printer_name_is_an_error() {
        let mut o = opts("", "auto", "");
        o.printer = "  ".into();
        assert!(build_job(&o, None).is_err());
    }
}
