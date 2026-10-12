//! Tauri plugin that hands a PDF file to Android's `PrintManager` (the system print dialog).
//!
//! Only the Android build does anything; on other targets `init()` returns an empty plugin so the
//! crate still compiles everywhere.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, AppHandle, Manager};

/// Java/Kotlin package of the plugin class (must match the `package` line in PrintPlugin.kt).
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.example.printtest.print";

#[cfg(target_os = "android")]
struct AndroidPrint<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrintArgs<'a> {
    path: &'a str,
    job_name: &'a str,
}

/// What the Kotlin side reports after opening the dialog.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintReply {
    pub pages: u32,
    pub width_mm: f64,
    pub height_mm: f64,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-print")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "PrintPlugin")?;
                _app.manage(AndroidPrint(handle));
            }
            Ok(())
        })
        .build()
}

/// Opens the system print dialog for the PDF at `path`. Returns once the dialog is showing, not
/// when paper comes out. The Kotlin adapter deletes the file when the print job finishes.
#[cfg(target_os = "android")]
pub fn print_pdf_file<R: Runtime>(app: &AppHandle<R>, path: &str, job_name: &str) -> Result<PrintReply, String> {
    app.state::<AndroidPrint<R>>()
        .0
        .run_mobile_plugin("printPdf", PrintArgs { path, job_name })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
pub fn print_pdf_file<R: Runtime>(_app: &tauri::AppHandle<R>, path: &str, job_name: &str) -> Result<PrintReply, String> {
    let _ = PrintArgs { path, job_name };
    Err("the Android print plugin only works on Android".into())
}
