//! Android backend A: hand the PDF to the system print service (`PrintManager`).
//!
//! Android never lets an app print silently through the system service: the user always sees the
//! print preview, picks the printer and taps Print. Paper, orientation and resolution are chosen
//! there, so the matching options are ignored here and the report says so.

use crate::{PrintOptions, PrintReport};
use tauri::{AppHandle, Manager};

const VIRTUAL_PRINTER: &str = "System print dialog";

pub fn list_printers(_app: &AppHandle) -> Vec<String> {
    vec![VIRTUAL_PRINTER.to_string()]
}

pub fn printer_resolutions(_printer: &str) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub fn print_pdf(app: &AppHandle, opts: &PrintOptions, bytes: Vec<u8>) -> Result<PrintReport, String> {
    // The Kotlin side runs in the same app, so it can read the app's cache dir directly.
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = dir.join(format!("print-{nanos}.pdf"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;

    // On success the Kotlin adapter deletes the file when the print job finishes.
    let reply = match tauri_plugin_android_print::print_pdf_file(app, &path.display().to_string(), "Labels") {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };

    let size = format!("{:.0} x {:.0} mm", reply.width_mm, reply.height_mm);
    let ignored: Vec<&str> = [
        (!opts.paper.trim().is_empty(), "paper"),
        (opts.orientation != "auto", "orientation"),
        (!opts.dpi.trim().is_empty(), "resolution"),
    ]
    .iter()
    .filter(|(set, _)| *set)
    .map(|(_, name)| *name)
    .collect();

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
            if ignored.is_empty() {
                String::new()
            } else {
                format!(" Ignored app settings: {}.", ignored.join(", "))
            }
        ),
        orientation: "chosen in the system dialog".into(),
        dpi_requested: String::new(),
        dpi_applied: false,
        dpi_note: "Resolution is chosen in the system print dialog.".into(),
    })
}
