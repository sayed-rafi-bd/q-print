//! Tauri plugin for the Android side of printing: the system print dialog (`PrintManager`), PDF ->
//! bitmap rendering, printer discovery on the network, and Bluetooth / USB transports.
//!
//! Only the Android build does anything; on other targets `init()` returns an empty plugin so the
//! crate still compiles everywhere.

// The reply/argument types are only used by the Android functions.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

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

/// One rendered page: a 1-bit image, rows packed MSB first, a set bit is a black dot.
#[derive(Debug, Deserialize)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    /// Base64
    pub data: String,
}

#[derive(Debug, Deserialize)]
struct RenderReply {
    pages: Vec<RenderedPage>,
}

/// A printer found on the local network (mDNS).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoundPrinter {
    pub name: String,
    /// "ipp" | "raw"
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub path: String,
}

#[derive(Debug, Deserialize)]
struct FoundReply {
    printers: Vec<FoundPrinter>,
}

/// A paired Bluetooth device or a USB printer the user can pick. `id` is what `send_*` takes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
struct BtDevice {
    name: String,
    address: String,
}

#[derive(Debug, Deserialize)]
struct BtReply {
    devices: Vec<BtDevice>,
}

#[derive(Debug, Deserialize)]
struct UsbReply {
    devices: Vec<Device>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderArgs<'a> {
    path: &'a str,
    dpi: u32,
}

#[derive(Serialize)]
struct SendArgs<'a> {
    id: &'a str,
    /// Base64
    data: &'a str,
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

// ---------------------------------------------------------------------------------------------
// Everything below only works on Android; elsewhere the functions return an error.
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "android")]
fn call<R: Runtime, A: Serialize, T: serde::de::DeserializeOwned>(app: &AppHandle<R>, cmd: &str, args: A) -> Result<T, String> {
    app.state::<AndroidPrint<R>>().0.run_mobile_plugin(cmd, args).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn call_unit<R: Runtime, A: Serialize>(app: &AppHandle<R>, cmd: &str, args: A) -> Result<(), String> {
    app.state::<AndroidPrint<R>>().0.run_mobile_plugin::<serde_json::Value>(cmd, args).map(|_| ()).map_err(|e| e.to_string())
}

/// Renders every page of the PDF at `path` to a 1-bit bitmap at `dpi`.
#[cfg(target_os = "android")]
pub fn render_pdf<R: Runtime>(app: &AppHandle<R>, path: &str, dpi: u32) -> Result<Vec<RenderedPage>, String> {
    call::<_, _, RenderReply>(app, "renderPdf", RenderArgs { path, dpi }).map(|r| r.pages)
}

/// Looks for IPP and raw (port 9100) printers on the local network for a few seconds.
#[cfg(target_os = "android")]
pub fn discover_printers<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<FoundPrinter>, String> {
    call::<_, _, FoundReply>(app, "discoverPrinters", serde_json::json!({})).map(|r| r.printers)
}

/// Paired Bluetooth devices (asks for the "Nearby devices" permission on Android 12+).
#[cfg(target_os = "android")]
pub fn list_bluetooth<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Device>, String> {
    call::<_, _, BtReply>(app, "listBluetooth", serde_json::json!({}))
        .map(|r| r.devices.into_iter().map(|d| Device { name: d.name, id: d.address }).collect())
}

#[cfg(target_os = "android")]
pub fn list_usb<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Device>, String> {
    call::<_, _, UsbReply>(app, "listUsb", serde_json::json!({})).map(|r| r.devices)
}

/// `data_b64` is the Base64 of the bytes to send.
#[cfg(target_os = "android")]
pub fn send_bluetooth<R: Runtime>(app: &AppHandle<R>, address: &str, data_b64: &str) -> Result<(), String> {
    call_unit(app, "sendBluetooth", SendArgs { id: address, data: data_b64 })
}

#[cfg(target_os = "android")]
pub fn send_usb<R: Runtime>(app: &AppHandle<R>, id: &str, data_b64: &str) -> Result<(), String> {
    call_unit(app, "sendUsb", SendArgs { id, data: data_b64 })
}

#[cfg(not(target_os = "android"))]
mod stubs {
    use super::*;
    const NO: &str = "this only works on Android";

    pub fn render_pdf<R: Runtime>(_: &tauri::AppHandle<R>, _path: &str, _dpi: u32) -> Result<Vec<RenderedPage>, String> {
        Err(NO.into())
    }
    pub fn discover_printers<R: Runtime>(_: &tauri::AppHandle<R>) -> Result<Vec<FoundPrinter>, String> {
        Err(NO.into())
    }
    pub fn list_bluetooth<R: Runtime>(_: &tauri::AppHandle<R>) -> Result<Vec<Device>, String> {
        Err(NO.into())
    }
    pub fn list_usb<R: Runtime>(_: &tauri::AppHandle<R>) -> Result<Vec<Device>, String> {
        Err(NO.into())
    }
    pub fn send_bluetooth<R: Runtime>(_: &tauri::AppHandle<R>, _id: &str, _data: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn send_usb<R: Runtime>(_: &tauri::AppHandle<R>, _id: &str, _data: &str) -> Result<(), String> {
        Err(NO.into())
    }
}
#[cfg(not(target_os = "android"))]
pub use stubs::*;
