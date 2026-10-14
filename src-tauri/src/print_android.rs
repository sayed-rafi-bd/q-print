//! Android print backend. Two ways to print:
//!
//! 1. A printer the user added (see `direct.rs`): the app sends the job to the printer itself, so
//!    there is **no dialog**. How the page is sent depends on the printer:
//!    - IPP printers: the PDF as-is, or (when the printer lists no PDF support) a PWG raster bitmap.
//!    - Raw socket (port 9100): the PDF as-is, or a bitmap wrapped in ZPL / TSPL / ESC-POS / CPCL.
//!    - Bluetooth (SPP) and USB (OTG) printers: a bitmap wrapped in ZPL / TSPL / ESC-POS / CPCL.
//!    Bitmaps come from Android's `PdfRenderer` (Kotlin plugin); the encoders are in `raster.rs`.
//! 2. "System print dialog": hands the PDF to Android's `PrintManager`. Android never lets an app
//!    print silently through the system service: the user always sees the print preview, picks
//!    the printer and taps Print. Paper, orientation and resolution are chosen there, so the
//!    matching options are ignored and the report says so.

use crate::{direct, raster, PrintOptions, PrintReport};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const VIRTUAL_PRINTER: &str = direct::RESERVED_NAME;

/// PWG raster is always sent at this resolution: every driverless (IPP Everywhere) printer supports it.
const PWG_DPI: u32 = 300;

/// Saved printers first (so the first one is the default selection), then the system dialog.
pub fn list_printers(app: &AppHandle) -> Vec<String> {
    let mut names: Vec<String> = crate::printers_path(app)
        .and_then(|p| direct::load_all(&p))
        .map(|list| list.into_iter().map(|p| p.name).collect())
        .unwrap_or_default();
    names.push(VIRTUAL_PRINTER.to_string());
    names
}

pub fn printer_resolutions(_printer: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

// ---------------------------------------------------------------------------------------------
// Discovery and device lists (used by the "add printer" UI)
// ---------------------------------------------------------------------------------------------

/// Looks for printers on the local network (mDNS) for a few seconds.
pub fn discover(app: &AppHandle) -> Result<Vec<direct::Discovered>, String> {
    let mut found: Vec<direct::Discovered> = tauri_plugin_android_print::discover_printers(app)?
        .into_iter()
        .map(|f| direct::Discovered { name: f.name, kind: f.kind, host: f.host, port: f.port, path: f.path })
        .collect();
    // IPP first, then by name
    found.sort_by(|a, b| (a.kind != "ipp", a.name.to_lowercase()).cmp(&(b.kind != "ipp", b.name.to_lowercase())));
    Ok(found)
}

/// Paired Bluetooth devices (`kind` = "bluetooth") or connected USB printers (`kind` = "usb").
pub fn list_devices(app: &AppHandle, kind: &str) -> Result<Vec<direct::Device>, String> {
    let list = match kind {
        direct::KIND_BLUETOOTH => tauri_plugin_android_print::list_bluetooth(app)?,
        direct::KIND_USB => tauri_plugin_android_print::list_usb(app)?,
        other => return Err(format!("Unknown device type \"{other}\".")),
    };
    Ok(list.into_iter().map(|d| direct::Device { name: d.name, id: d.id }).collect())
}

// ---------------------------------------------------------------------------------------------
// Direct printing
// ---------------------------------------------------------------------------------------------

/// Writes the PDF where the Kotlin side can read it (same app, so the cache dir works).
fn write_cache_pdf(app: &AppHandle, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = dir.join(format!("print-{nanos}.pdf"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// PDF -> one 1-bit bitmap per page, at `dpi`.
fn render_pages(app: &AppHandle, pdf: &[u8], dpi: u32) -> Result<Vec<raster::Bitmap>, String> {
    let path = write_cache_pdf(app, pdf)?;
    let rendered = tauri_plugin_android_print::render_pdf(app, &path.display().to_string(), dpi);
    let _ = std::fs::remove_file(&path);
    let pages: Vec<raster::Bitmap> = rendered?
        .into_iter()
        .map(|p| {
            let data = B64.decode(p.data.as_bytes()).map_err(|e| format!("Bad page image from Android: {e}"))?;
            raster::Bitmap::new(p.width, p.height, data)
        })
        .collect::<Result<_, String>>()?;
    if pages.is_empty() {
        return Err("The PDF has no pages.".into());
    }
    Ok(pages)
}

/// Sends the pages to the printer in its own language. Returns what was sent for the report.
fn send_bitmaps(app: &AppHandle, p: &direct::SavedPrinter, pdf: &[u8]) -> Result<direct::Sent, String> {
    let lang = p.language.as_str();
    let dpi = if p.kind == direct::KIND_IPP { PWG_DPI } else { p.dpi };
    let pages = render_pages(app, pdf, dpi)?;
    let size = format!("{} x {} px at {dpi} dpi", pages[0].width, pages[0].height);

    if p.kind == direct::KIND_IPP {
        let doc = raster::pwg_raster(&pages, dpi)?;
        let mut sent = direct::send_ipp(p, "Labels", "image/pwg-raster", &doc)?;
        sent.command = format!("{} [{} page(s), {size}]", sent.command, pages.len());
        return Ok(sent);
    }

    let doc = raster::encode(lang, &pages, dpi)?;
    let what = format!("{} bitmap, {} page(s), {size}", lang.to_uppercase(), pages.len());
    match p.kind.as_str() {
        direct::KIND_RAW => direct::send_raw(p, &doc, &what),
        direct::KIND_BLUETOOTH => {
            tauri_plugin_android_print::send_bluetooth(app, &p.host, &B64.encode(&doc))?;
            Ok(direct::Sent {
                transport: direct::KIND_BLUETOOTH,
                tool: "Bluetooth (SPP)",
                command: format!("BLUETOOTH {} <- {} bytes ({what})", p.host, doc.len()),
            })
        }
        direct::KIND_USB => {
            tauri_plugin_android_print::send_usb(app, &p.host, &B64.encode(&doc))?;
            Ok(direct::Sent {
                transport: direct::KIND_USB,
                tool: "USB bulk transfer",
                command: format!("USB {} <- {} bytes ({what})", p.host, doc.len()),
            })
        }
        other => Err(format!("Unknown printer type \"{other}\".")),
    }
}

/// Sends the job to a saved printer. No dialog.
fn print_direct(app: &AppHandle, p: &direct::SavedPrinter, opts: &PrintOptions, pdf: &[u8]) -> Result<PrintReport, String> {
    let p = p.validated()?;

    let sent = match p.kind.as_str() {
        direct::KIND_IPP => {
            // "auto": ask the printer. If it cannot be asked, try the PDF; a failure then explains itself.
            let formats = if p.language == direct::LANG_AUTO { direct::ipp_formats(&p).unwrap_or_default() } else { Vec::new() };
            if p.needs_bitmap(&formats) {
                if !formats.is_empty() && !formats.iter().any(|f| f == "image/pwg-raster") {
                    return Err(format!(
                        "This printer accepts neither PDF nor PWG raster (it reports: {}). Add it as a raw socket \
                         printer (port 9100) with ZPL, TSPL, ESC/POS or CPCL instead.",
                        formats.join(", ")
                    ));
                }
                send_bitmaps(app, &p, pdf)?
            } else {
                direct::print_pdf(&p, "Labels", pdf)?
            }
        }
        direct::KIND_RAW if p.language == direct::LANG_PDF => direct::print_pdf(&p, "Labels", pdf)?,
        _ => send_bitmaps(app, &p, pdf)?,
    };

    Ok(report(sent.transport, sent.tool, sent.command, opts, "Sent straight to the printer, no dialog."))
}

fn ignored_settings(opts: &PrintOptions) -> String {
    let ignored: Vec<&str> = [
        (!opts.paper.trim().is_empty(), "paper"),
        (opts.orientation != "auto", "orientation"),
        (!opts.dpi.trim().is_empty(), "resolution"),
    ]
    .iter()
    .filter(|(set, _)| *set)
    .map(|(_, name)| *name)
    .collect();
    if ignored.is_empty() {
        String::new()
    } else {
        format!(" Ignored app settings: {}.", ignored.join(", "))
    }
}

fn report(transport: &str, tool: &str, command: String, opts: &PrintOptions, lead: &str) -> PrintReport {
    PrintReport {
        transport: transport.into(),
        tool: tool.into(),
        command,
        paper_requested: String::new(),
        paper_applied: false,
        paper_note: format!(
            "{lead} The paper size is the PDF's own page size; the printer decides how to fit it, so set the \
             loaded media in the printer itself.{}",
            ignored_settings(opts)
        ),
        orientation: "from the PDF".into(),
        dpi_requested: String::new(),
        dpi_applied: false,
        dpi_note: "Resolution is the printer's own (set per printer for bitmap languages).".into(),
    }
}

pub fn print_pdf(app: &AppHandle, opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    if opts.printer != VIRTUAL_PRINTER {
        let saved = direct::load_all(&crate::printers_path(app)?)?;
        let printer = saved
            .iter()
            .find(|p| p.name == opts.printer)
            .ok_or_else(|| format!("Printer \"{}\" is no longer saved. Pick another printer.", opts.printer))?;
        return print_direct(app, printer, opts, &bytes);
    }

    // On success the Kotlin adapter deletes the file when the print job finishes.
    let path = write_cache_pdf(app, &bytes)?;
    let reply = match tauri_plugin_android_print::print_pdf_file(app, &path.display().to_string(), "Labels") {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };

    let size = format!("{:.0} x {:.0} mm", reply.width_mm, reply.height_mm);
    Ok(PrintReport {
        transport: "android-dialog".into(),
        tool: "Android PrintManager".into(),
        command: format!("PrintManager.print(\"Labels\", PdfFileAdapter, mediaSize = {size}) // {} page(s)", reply.pages),
        paper_requested: String::new(),
        paper_applied: false,
        paper_note: format!(
            "The system print dialog was opened with the PDF's own page size ({size}) as the requested \
             paper. The print service may offer other sizes; choose the paper, orientation and \
             resolution in that dialog.{}",
            ignored_settings(opts)
        ),
        orientation: "chosen in the system dialog".into(),
        dpi_requested: String::new(),
        dpi_applied: false,
        dpi_note: "Resolution is chosen in the system print dialog.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(paper: &str, orientation: &str, dpi: &str) -> PrintOptions {
        PrintOptions { printer: "Labels".into(), paper: paper.into(), orientation: orientation.into(), dpi: dpi.into() }
    }

    #[test]
    fn nothing_is_ignored_when_no_option_is_set() {
        assert_eq!(ignored_settings(&opts("", "auto", "")), "");
    }

    #[test]
    fn each_option_that_is_set_is_named() {
        assert_eq!(ignored_settings(&opts("A4", "auto", "")), " Ignored app settings: paper.");
        assert_eq!(ignored_settings(&opts("", "portrait", "")), " Ignored app settings: orientation.");
        assert_eq!(ignored_settings(&opts("", "auto", "300x300")), " Ignored app settings: resolution.");
    }

    #[test]
    fn all_ignored_options_are_listed_in_a_fixed_order() {
        assert_eq!(
            ignored_settings(&opts("letter", "landscape", "600x600")),
            " Ignored app settings: paper, orientation, resolution."
        );
    }

    #[test]
    fn blank_paper_and_resolution_do_not_count() {
        assert_eq!(ignored_settings(&opts("   ", "auto", "  ")), "");
    }

    #[test]
    fn report_for_a_saved_printer_says_nothing_was_applied() {
        let r = report("ipp", "IPP", "IPP http://10.0.0.5:631/ipp/print".into(), &opts("", "auto", ""), "Sent straight to the printer, no dialog.");
        assert_eq!(r.transport, "ipp");
        assert_eq!(r.tool, "IPP");
        assert_eq!(r.command, "IPP http://10.0.0.5:631/ipp/print");
        assert!(!r.paper_applied && !r.dpi_applied);
        assert!(r.paper_requested.is_empty() && r.dpi_requested.is_empty());
        assert_eq!(r.orientation, "from the PDF");
        assert!(r.paper_note.starts_with("Sent straight to the printer, no dialog. The paper size is the PDF's own page size"));
        assert!(!r.paper_note.contains("Ignored app settings"));
    }

    #[test]
    fn report_mentions_the_settings_it_ignored() {
        let r = report("raw", "Raw socket", String::new(), &opts("A4", "portrait", "300x300"), "Lead.");
        assert!(r.paper_note.starts_with("Lead. "));
        assert!(r.paper_note.ends_with(" Ignored app settings: paper, orientation, resolution."));
    }
}
