//! Direct ("silent") network printing: the app talks to the printer itself instead of handing the
//! PDF to a system print service, so no dialog is shown.
//!
//! Two transports, both plain TCP and pure Rust (so they also work on Android):
//!  - `ipp`: IPP `Print-Job` over HTTP (usually port 631, path `/ipp/print`). Supported by almost
//!    every network printer made in the last decade. The PDF is sent as `application/pdf`.
//!  - `raw`: the bytes are written to a socket (usually port 9100, "JetDirect"/"AppSocket"). Only
//!    useful for printers that accept a PDF/PostScript stream directly on that port.
//!
//! This module has no dependency on Tauri so it can be unit-tested on any machine.

// Only the Android backend sends jobs; the other platforms just compile the shared commands.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use crate::raster;

pub const KIND_IPP: &str = "ipp";
pub const KIND_RAW: &str = "raw";
pub const KIND_BLUETOOTH: &str = "bluetooth";
pub const KIND_USB: &str = "usb";

/// Send the PDF as-is. IPP/raw only.
pub const LANG_PDF: &str = "pdf";
/// IPP only: PDF if the printer lists it, otherwise PWG raster.
pub const LANG_AUTO: &str = "auto";
pub const DEFAULT_DPI: u32 = 203;

/// Name of the built-in "open the Android print dialog" entry; a saved printer may not use it.
pub const RESERVED_NAME: &str = "System print dialog";

const DEFAULT_IPP_PATH: &str = "/ipp/print";

/// A printer the user added by hand. `name` is the unique key and is what the UI sends back when printing.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrinter {
    pub name: String,
    /// "ipp" | "raw" | "bluetooth" | "usb"
    pub kind: String,
    /// IP address / host name (ipp, raw), Bluetooth MAC address (bluetooth), "vendorId:productId" in hex (usb).
    pub host: String,
    /// TCP port (ipp, raw). Unused for bluetooth and usb.
    #[serde(default)]
    pub port: u16,
    /// IPP resource path, e.g. "/ipp/print". Ignored for the other kinds.
    #[serde(default)]
    pub path: String,
    /// What is sent: "auto" | "pdf" | "pwg" (IPP), "pdf" | "zpl" | "tspl" | "escpos" | "cpcl" (raw),
    /// "zpl" | "tspl" | "escpos" | "cpcl" (bluetooth, usb). Empty = the kind's default.
    #[serde(default)]
    pub language: String,
    /// Resolution the page is rendered at when it is sent as a bitmap. 0 = 203 dpi.
    #[serde(default)]
    pub dpi: u32,
}

impl SavedPrinter {
    /// Checks the fields and returns a cleaned-up copy (trimmed, defaults filled in).
    pub fn validated(&self) -> Result<SavedPrinter, String> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err("Give the printer a name.".into());
        }
        if name == RESERVED_NAME {
            return Err(format!("\"{RESERVED_NAME}\" is reserved; choose another name."));
        }
        let kind = self.kind.as_str();
        if ![KIND_IPP, KIND_RAW, KIND_BLUETOOTH, KIND_USB].contains(&kind) {
            return Err(format!("Unknown printer type \"{}\" (use ipp, raw, bluetooth or usb).", self.kind));
        }
        let host = self.host.trim().to_string();
        let network = kind == KIND_IPP || kind == KIND_RAW;
        if host.is_empty() {
            return Err(match kind {
                KIND_BLUETOOTH => "Choose a paired Bluetooth printer.".to_string(),
                KIND_USB => "Choose a USB printer.".to_string(),
                _ => "Enter the printer's IP address or host name.".to_string(),
            });
        }
        if network && (host.contains(char::is_whitespace) || host.contains('/') || host.contains("://")) {
            return Err("The host must be an IP address or host name only (no http://, no path).".into());
        }
        if network && self.port == 0 {
            return Err("The port must be between 1 and 65535.".into());
        }

        let language = self.language.trim().to_lowercase();
        let allowed: &[&str] = match kind {
            KIND_IPP => &[LANG_AUTO, LANG_PDF, raster::LANG_PWG],
            KIND_RAW => &[LANG_PDF, raster::LANG_ZPL, raster::LANG_TSPL, raster::LANG_ESCPOS, raster::LANG_CPCL],
            _ => &[raster::LANG_ESCPOS, raster::LANG_ZPL, raster::LANG_TSPL, raster::LANG_CPCL],
        };
        let language = if language.is_empty() { allowed[0].to_string() } else { language };
        if !allowed.contains(&language.as_str()) {
            return Err(format!("A {kind} printer cannot use \"{language}\" (use {}).", allowed.join(", ")));
        }

        let path = if kind == KIND_IPP {
            let p = self.path.trim();
            if p.is_empty() {
                DEFAULT_IPP_PATH.to_string()
            } else if p.starts_with('/') {
                p.to_string()
            } else {
                format!("/{p}")
            }
        } else {
            String::new()
        };
        let dpi = if self.dpi == 0 { DEFAULT_DPI } else { self.dpi };
        if !(72..=1200).contains(&dpi) {
            return Err("The resolution must be between 72 and 1200 dpi.".into());
        }
        Ok(SavedPrinter {
            name,
            kind: self.kind.clone(),
            host,
            port: if network { self.port } else { 0 },
            path,
            language,
            dpi,
        })
    }

    /// True when the page must be rendered to a bitmap before sending (anything but a PDF as-is).
    pub fn needs_bitmap(&self, ipp_formats: &[String]) -> bool {
        match self.language.as_str() {
            LANG_PDF => false,
            LANG_AUTO => !ipp_formats.is_empty() && !ipp_formats.iter().any(|f| f == "application/pdf"),
            _ => true,
        }
    }

    fn host_for_url(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host) // IPv6 literal
        } else {
            self.host.clone()
        }
    }

    fn http_url(&self) -> String {
        format!("http://{}:{}{}", self.host_for_url(), self.port, self.path)
    }

    /// The `printer-uri` that goes inside the IPP request.
    fn ipp_uri(&self) -> String {
        format!("ipp://{}:{}{}", self.host_for_url(), self.port, self.path)
    }
}

// ---------------------------------------------------------------------------------------------
// Saved printers on disk (a JSON array)
// ---------------------------------------------------------------------------------------------

pub fn load_all(path: &Path) -> Result<Vec<SavedPrinter>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("printers.json is not valid: {e}"))
}

fn store(path: &Path, list: &[SavedPrinter]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Adds the printer, or replaces the one with the same name.
pub fn upsert(path: &Path, printer: &SavedPrinter) -> Result<(), String> {
    let printer = printer.validated()?;
    let mut list = load_all(path)?;
    match list.iter_mut().find(|p| p.name == printer.name) {
        Some(existing) => *existing = printer,
        None => list.push(printer),
    }
    store(path, &list)
}

pub fn remove(path: &Path, name: &str) -> Result<(), String> {
    let mut list = load_all(path)?;
    list.retain(|p| p.name != name);
    store(path, &list)
}

// ---------------------------------------------------------------------------------------------
// IPP encoding / decoding (RFC 8010 / 8011), only what we need
// ---------------------------------------------------------------------------------------------

const OP_PRINT_JOB: u16 = 0x0002;
const OP_GET_PRINTER_ATTRIBUTES: u16 = 0x000B;

const TAG_OPERATION_ATTRS: u8 = 0x01;
const TAG_END: u8 = 0x03;
const TAG_INTEGER: u8 = 0x21;
const TAG_NAME: u8 = 0x42;
const TAG_KEYWORD: u8 = 0x44;
const TAG_URI: u8 = 0x45;
const TAG_CHARSET: u8 = 0x47;
const TAG_NATURAL_LANGUAGE: u8 = 0x48;
const TAG_MIME_TYPE: u8 = 0x49;

fn put_attr(buf: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
    buf.push(tag);
    buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
    buf.extend_from_slice(name.as_bytes());
    buf.extend_from_slice(&(value.len() as u16).to_be_bytes());
    buf.extend_from_slice(value);
}

/// IPP 1.1 request header + the operation attributes every request must start with.
fn request_start(op: u16, uri: &str) -> Vec<u8> {
    let mut b = vec![0x01, 0x01];
    b.extend_from_slice(&op.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes()); // request-id
    b.push(TAG_OPERATION_ATTRS);
    put_attr(&mut b, TAG_CHARSET, "attributes-charset", b"utf-8");
    put_attr(&mut b, TAG_NATURAL_LANGUAGE, "attributes-natural-language", b"en");
    put_attr(&mut b, TAG_URI, "printer-uri", uri.as_bytes());
    b
}

/// IPP strings are limited to 255 bytes; cut on a character boundary.
fn clip(s: &str) -> &str {
    let mut end = s.len().min(255);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn build_print_job(uri: &str, job_name: &str, mime: &str, pdf: &[u8]) -> Vec<u8> {
    let mut b = request_start(OP_PRINT_JOB, uri);
    put_attr(&mut b, TAG_NAME, "requesting-user-name", b"q-print");
    put_attr(&mut b, TAG_NAME, "job-name", clip(job_name).as_bytes());
    put_attr(&mut b, TAG_MIME_TYPE, "document-format", mime.as_bytes());
    b.push(TAG_END);
    b.extend_from_slice(pdf);
    b
}

fn build_get_printer_attributes(uri: &str) -> Vec<u8> {
    let mut b = request_start(OP_GET_PRINTER_ATTRIBUTES, uri);
    let wanted = [
        "printer-name",
        "printer-make-and-model",
        "printer-state",
        "printer-state-reasons",
        "document-format-supported",
    ];
    for (i, w) in wanted.iter().enumerate() {
        // additional values of a multi-valued attribute carry an empty name
        put_attr(&mut b, TAG_KEYWORD, if i == 0 { "requested-attributes" } else { "" }, w.as_bytes());
    }
    b.push(TAG_END);
    b
}

#[derive(Debug)]
struct IppAttr {
    name: String,
    tag: u8,
    values: Vec<Vec<u8>>,
}

#[derive(Debug)]
struct IppResponse {
    status: u16,
    attrs: Vec<IppAttr>,
}

impl IppResponse {
    fn get(&self, name: &str) -> Option<&IppAttr> {
        self.attrs.iter().find(|a| a.name == name)
    }
    fn text(&self, name: &str) -> Option<String> {
        self.get(name)
            .and_then(|a| a.values.first())
            .map(|v| String::from_utf8_lossy(v).into_owned())
    }
    fn texts(&self, name: &str) -> Vec<String> {
        self.get(name)
            .map(|a| a.values.iter().map(|v| String::from_utf8_lossy(v).into_owned()).collect())
            .unwrap_or_default()
    }
    fn int(&self, name: &str) -> Option<i64> {
        let a = self.get(name)?;
        if a.tag != TAG_INTEGER && a.tag != 0x23 {
            return None;
        }
        let v = a.values.first()?;
        let bytes: [u8; 4] = v.as_slice().try_into().ok()?;
        Some(i32::from_be_bytes(bytes) as i64)
    }
}

fn parse_response(data: &[u8]) -> Result<IppResponse, String> {
    fn take<'a>(data: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], String> {
        let end = pos.checked_add(n).filter(|e| *e <= data.len()).ok_or("the printer's IPP reply is cut short")?;
        let s = &data[*pos..end];
        *pos = end;
        Ok(s)
    }
    if data.len() < 8 {
        return Err("the printer's reply is not an IPP message".into());
    }
    let status = u16::from_be_bytes([data[2], data[3]]);
    let mut pos = 8;
    let mut attrs: Vec<IppAttr> = Vec::new();
    loop {
        let tag = take(data, &mut pos, 1)?[0];
        if tag == TAG_END {
            break;
        }
        if tag <= 0x05 {
            continue; // start of an attribute group (operation, job, printer, unsupported, ...)
        }
        let nlen = u16::from_be_bytes(take(data, &mut pos, 2)?.try_into().unwrap()) as usize;
        let name = String::from_utf8_lossy(take(data, &mut pos, nlen)?).into_owned();
        let vlen = u16::from_be_bytes(take(data, &mut pos, 2)?.try_into().unwrap()) as usize;
        let value = take(data, &mut pos, vlen)?.to_vec();
        if nlen == 0 {
            if let Some(last) = attrs.last_mut() {
                last.values.push(value);
            }
        } else {
            attrs.push(IppAttr { name, tag, values: vec![value] });
        }
    }
    Ok(IppResponse { status, attrs })
}

/// Human-readable meaning of an IPP status code (RFC 8011 section 5.4).
fn status_text(code: u16) -> String {
    let name = match code {
        0x0000 => "successful-ok",
        0x0001 => "successful-ok-ignored-or-substituted-attributes",
        0x0002 => "successful-ok-conflicting-attributes",
        0x0400 => "client-error-bad-request",
        0x0401 => "client-error-forbidden",
        0x0402 => "client-error-not-authenticated",
        0x0403 => "client-error-not-authorized",
        0x0404 => "client-error-not-possible",
        0x0405 => "client-error-timeout",
        0x0406 => "client-error-not-found",
        0x0407 => "client-error-gone",
        0x0408 => "client-error-request-entity-too-large",
        0x0409 => "client-error-request-value-too-long",
        0x040A => "client-error-document-format-not-supported",
        0x040B => "client-error-attributes-or-values-not-supported",
        0x0500 => "server-error-internal-error",
        0x0501 => "server-error-operation-not-supported",
        0x0502 => "server-error-service-unavailable",
        0x0503 => "server-error-version-not-supported",
        0x0504 => "server-error-device-error",
        0x0505 => "server-error-temporary-error",
        0x0506 => "server-error-not-accepting-jobs",
        0x0507 => "server-error-busy",
        0x0508 => "server-error-job-canceled",
        _ => "unknown status",
    };
    format!("{name} (0x{code:04x})")
}

fn explain_ipp_error(code: u16) -> String {
    let hint = match code {
        0x040A => {
            " This printer does not accept PDF over IPP. Many label printers only take raster \
              formats or their own command language; they need a different transport."
        }
        0x0406 => " The IPP path is probably wrong; try /ipp/print, /ipp, /ipp/printer or /printers/<name>.",
        0x0402 | 0x0403 | 0x0401 => " The printer requires authentication or has IPP printing disabled.",
        0x0506 | 0x0507 | 0x0502 => " The printer is busy or not accepting jobs; check it and try again.",
        _ => "",
    };
    format!("The printer rejected the job: {}.{hint}", status_text(code))
}

// ---------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------

fn post_ipp(p: &SavedPrinter, body: &[u8]) -> Result<IppResponse, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_write(Duration::from_secs(60))
        .timeout_read(Duration::from_secs(120))
        .build();
    let resp = agent
        .post(&p.http_url())
        .set("Content-Type", "application/ipp")
        .send_bytes(body)
        .map_err(|e| match e {
            ureq::Error::Status(426, _) => {
                "The printer wants an encrypted connection (ipps). Only plain IPP is supported here; \
                 enable plain IPP on the printer or use port 631."
                    .to_string()
            }
            ureq::Error::Status(code, _) => format!("The printer answered HTTP {code}; check the port and IPP path."),
            ureq::Error::Transport(t) => format!("Could not reach {}:{} ({t}).", p.host, p.port),
        })?;
    let mut data = Vec::new();
    resp.into_reader().take(4 << 20).read_to_end(&mut data).map_err(|e| e.to_string())?;
    parse_response(&data)
}

fn connect_raw(p: &SavedPrinter) -> Result<TcpStream, String> {
    let addrs = (p.host.as_str(), p.port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve {}: {e}", p.host))?;
    let mut last = String::from("no address found");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(5)) {
            Ok(s) => return Ok(s),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Could not connect to {}:{} ({last}).", p.host, p.port))
}

/// A printer found on the network, ready to be saved.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub name: String,
    /// "ipp" | "raw"
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// A paired Bluetooth device or a USB printer to pick from. `id` goes into `SavedPrinter::host`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Device {
    pub name: String,
    pub id: String,
}

/// What was done, for the report shown in the UI.
pub struct Sent {
    pub transport: &'static str,
    pub tool: &'static str,
    pub command: String,
}

/// MIME types an IPP printer says it accepts. Empty when it did not say.
pub fn ipp_formats(p: &SavedPrinter) -> Result<Vec<String>, String> {
    let resp = post_ipp(p, &build_get_printer_attributes(&p.ipp_uri()))?;
    if resp.status >= 0x0100 {
        return Err(explain_ipp_error(resp.status));
    }
    Ok(resp.texts("document-format-supported"))
}

/// IPP `Print-Job` with any document format (application/pdf, image/pwg-raster, ...).
pub fn send_ipp(p: &SavedPrinter, job_name: &str, mime: &str, doc: &[u8]) -> Result<Sent, String> {
    let resp = post_ipp(p, &build_print_job(&p.ipp_uri(), job_name, mime, doc))?;
    if resp.status >= 0x0100 {
        return Err(explain_ipp_error(resp.status));
    }
    let job = resp.int("job-id").map(|j| format!(", job-id {j}")).unwrap_or_default();
    Ok(Sent {
        transport: KIND_IPP,
        tool: "IPP Print-Job",
        command: format!(
            "IPP Print-Job {} ({mime}, {} bytes) -> {}{job}",
            p.ipp_uri(),
            doc.len(),
            status_text(resp.status)
        ),
    })
}

/// Writes bytes to a TCP socket (JetDirect / AppSocket, port 9100). `what` describes the payload.
pub fn send_raw(p: &SavedPrinter, data: &[u8], what: &str) -> Result<Sent, String> {
    let mut s = connect_raw(p)?;
    s.set_write_timeout(Some(Duration::from_secs(60))).map_err(|e| e.to_string())?;
    s.write_all(data).map_err(|e| format!("Sending to the printer failed: {e}"))?;
    s.flush().map_err(|e| e.to_string())?;
    let _ = s.shutdown(std::net::Shutdown::Write);
    Ok(Sent {
        transport: KIND_RAW,
        tool: "Raw TCP socket",
        command: format!("RAW {}:{} <- {} bytes ({what})", p.host, p.port, data.len()),
    })
}

/// Sends a PDF to the printer with no dialog.
pub fn print_pdf(p: &SavedPrinter, job_name: &str, pdf: &[u8]) -> Result<Sent, String> {
    if pdf.is_empty() {
        return Err("The PDF is empty.".into());
    }
    match p.kind.as_str() {
        KIND_IPP => send_ipp(p, job_name, "application/pdf", pdf),
        KIND_RAW => send_raw(p, pdf, "PDF as-is"),
        other => Err(format!("A {other} printer cannot take a PDF as-is.")),
    }
}

/// Result of "Test connection".
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub summary: String,
    /// Some(true/false) when the printer reported its supported formats (IPP only).
    pub supports_pdf: Option<bool>,
}

pub fn test(p: &SavedPrinter) -> Result<TestResult, String> {
    let p = p.validated()?;
    match p.kind.as_str() {
        KIND_IPP => {
            let resp = post_ipp(&p, &build_get_printer_attributes(&p.ipp_uri()))?;
            if resp.status >= 0x0100 {
                return Err(explain_ipp_error(resp.status));
            }
            let model = resp.text("printer-make-and-model").unwrap_or_else(|| "unknown model".into());
            let state = match resp.int("printer-state") {
                Some(3) => "idle",
                Some(4) => "processing",
                Some(5) => "stopped",
                _ => "state unknown",
            };
            let formats = resp.texts("document-format-supported");
            let supports_pdf = if formats.is_empty() { None } else { Some(formats.iter().any(|f| f == "application/pdf")) };
            let pwg = formats.iter().any(|f| f == "image/pwg-raster");
            let pdf_note = match supports_pdf {
                Some(true) => "accepts PDF directly".to_string(),
                Some(false) if pwg => "has no PDF support but accepts PWG raster: the page is sent as a bitmap".to_string(),
                Some(false) => format!(
                    "does NOT list application/pdf or image/pwg-raster (it reports: {}); it likely needs ZPL/ESC-POS \
                     over a raw socket instead",
                    formats.join(", ")
                ),
                None => "did not report its supported formats".to_string(),
            };
            Ok(TestResult { summary: format!("{model}: {state}, {pdf_note}."), supports_pdf })
        }
        KIND_RAW => {
            connect_raw(&p)?;
            Ok(TestResult {
                summary: format!(
                    "Connected to {}:{}. A raw socket cannot be queried, so it is unknown whether the printer \
                     understands PDF on this port.",
                    p.host, p.port
                ),
                supports_pdf: None,
            })
        }
        KIND_BLUETOOTH | KIND_USB => Ok(TestResult {
            summary: "Saved. The connection is made when you print: keep the printer switched on and (Bluetooth) paired, \
                      or (USB) plugged in with the OTG cable."
                .to_string(),
            supports_pdf: None,
        }),
        other => Err(format!("Unknown printer type \"{other}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    fn ipp_printer(host: &str, port: u16) -> SavedPrinter {
        SavedPrinter { name: "Office".into(), kind: KIND_IPP.into(), host: host.into(), port, ..Default::default() }
    }

    #[test]
    fn validation_cleans_and_rejects() {
        let ok = ipp_printer(" 192.168.1.50 ", 631).validated().unwrap();
        assert_eq!(ok.host, "192.168.1.50");
        assert_eq!(ok.path, "/ipp/print");
        assert_eq!(SavedPrinter { path: "ipp".into(), ..ok.clone() }.validated().unwrap().path, "/ipp");
        assert!(ipp_printer("http://x", 631).validated().is_err());
        assert!(ipp_printer("", 631).validated().is_err());
        assert!(ipp_printer("h", 0).validated().is_err());
        assert!(SavedPrinter { name: RESERVED_NAME.into(), ..ok.clone() }.validated().is_err());
        assert!(SavedPrinter { name: "  ".into(), ..ok }.validated().is_err());
    }

    #[test]
    fn urls() {
        let p = ipp_printer("fe80::1", 631).validated().unwrap();
        assert_eq!(p.http_url(), "http://[fe80::1]:631/ipp/print");
        assert_eq!(p.ipp_uri(), "ipp://[fe80::1]:631/ipp/print");
    }

    #[test]
    fn print_job_layout() {
        let b = build_print_job("ipp://h:631/ipp/print", "Labels", "application/pdf", b"%PDF-1.7 data");
        assert_eq!(&b[..8], &[1, 1, 0, 2, 0, 0, 0, 1]); // v1.1, Print-Job, request-id 1
        assert_eq!(b[8], TAG_OPERATION_ATTRS);
        let s = String::from_utf8_lossy(&b).into_owned();
        for needle in ["attributes-charset", "printer-uri", "ipp://h:631/ipp/print", "job-name", "application/pdf"] {
            assert!(s.contains(needle), "missing {needle}");
        }
        assert!(b.ends_with(b"\x03%PDF-1.7 data"));
    }

    #[test]
    fn job_name_is_clipped_on_char_boundary() {
        let long = "ラ".repeat(200); // 600 bytes
        let c = clip(&long);
        assert!(c.len() <= 255 && c.len() % 3 == 0);
    }

    #[test]
    fn parses_response_with_multivalue_attribute() {
        let mut r = vec![1, 1, 0, 0, 0, 0, 0, 1, 0x04];
        put_attr(&mut r, 0x42, "printer-make-and-model", b"Acme 5000");
        put_attr(&mut r, 0x23, "printer-state", &3i32.to_be_bytes());
        put_attr(&mut r, 0x49, "document-format-supported", b"image/urf");
        put_attr(&mut r, 0x49, "", b"application/pdf");
        r.push(TAG_END);
        let p = parse_response(&r).unwrap();
        assert_eq!(p.status, 0);
        assert_eq!(p.text("printer-make-and-model").unwrap(), "Acme 5000");
        assert_eq!(p.int("printer-state"), Some(3));
        assert_eq!(p.texts("document-format-supported"), vec!["image/urf", "application/pdf"]);
    }

    #[test]
    fn truncated_response_is_an_error_not_a_panic() {
        let mut r = vec![1, 1, 0, 0, 0, 0, 0, 1, 0x04];
        put_attr(&mut r, 0x42, "printer-name", b"abcdef");
        r.truncate(r.len() - 3);
        assert!(parse_response(&r).is_err());
        assert!(parse_response(&[1, 1]).is_err());
    }

    /// Minimal IPP "printer": reads one HTTP POST, records the body, answers with `reply`.
    fn mock_ipp(reply: Vec<u8>) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut rd = BufReader::new(stream.try_clone().unwrap());
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                rd.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; len];
            rd.read_exact(&mut body).unwrap();
            let mut w = stream;
            write!(w, "HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
            w.write_all(&reply).unwrap();
            body
        });
        (port, h)
    }

    fn ok_reply(status: u16, job_id: Option<i32>) -> Vec<u8> {
        let mut r = vec![1, 1];
        r.extend_from_slice(&status.to_be_bytes());
        r.extend_from_slice(&1u32.to_be_bytes());
        r.push(0x02);
        if let Some(j) = job_id {
            put_attr(&mut r, TAG_INTEGER, "job-id", &j.to_be_bytes());
        }
        r.push(TAG_END);
        r
    }

    #[test]
    fn ipp_print_job_end_to_end() {
        let (port, server) = mock_ipp(ok_reply(0, Some(42)));
        let p = ipp_printer("127.0.0.1", port).validated().unwrap();
        let sent = print_pdf(&p, "Labels", b"%PDF-fake").unwrap();
        assert!(sent.command.contains("job-id 42"), "{}", sent.command);
        let body = server.join().unwrap();
        assert_eq!(&body[2..4], &[0, 2]);
        assert!(body.ends_with(b"%PDF-fake"));
    }

    #[test]
    fn ipp_rejection_is_explained() {
        let (port, server) = mock_ipp(ok_reply(0x040A, None));
        let p = ipp_printer("127.0.0.1", port).validated().unwrap();
        let err = print_pdf(&p, "Labels", b"%PDF-fake").err().unwrap();
        server.join().unwrap();
        assert!(err.contains("document-format-not-supported") && err.contains("does not accept PDF"), "{err}");
    }

    #[test]
    fn ipp_test_reports_pdf_support() {
        let mut r = vec![1, 1, 0, 0, 0, 0, 0, 1, 0x04];
        put_attr(&mut r, 0x41, "printer-make-and-model", b"Acme 5000");
        put_attr(&mut r, 0x23, "printer-state", &3i32.to_be_bytes());
        put_attr(&mut r, 0x49, "document-format-supported", b"image/urf");
        r.push(TAG_END);
        let (port, server) = mock_ipp(r);
        let res = test(&ipp_printer("127.0.0.1", port)).unwrap();
        server.join().unwrap();
        assert_eq!(res.supports_pdf, Some(false));
        assert!(res.summary.contains("Acme 5000") && res.summary.contains("idle"), "{}", res.summary);
    }

    #[test]
    fn validation_covers_kinds_and_languages() {
        // defaults per kind
        assert_eq!(ipp_printer("h", 631).validated().unwrap().language, LANG_AUTO);
        assert_eq!(ipp_printer("h", 631).validated().unwrap().dpi, DEFAULT_DPI);
        let raw = SavedPrinter { kind: KIND_RAW.into(), ..ipp_printer("h", 9100) };
        assert_eq!(raw.validated().unwrap().language, LANG_PDF);
        assert_eq!(SavedPrinter { language: "ZPL".into(), ..raw.clone() }.validated().unwrap().language, "zpl");
        assert!(SavedPrinter { language: "pwg".into(), ..raw }.validated().is_err());
        assert!(SavedPrinter { language: "zpl".into(), ..ipp_printer("h", 631) }.validated().is_err());
        assert!(SavedPrinter { dpi: 5000, ..ipp_printer("h", 631) }.validated().is_err());

        // bluetooth / usb: no port or path, a command language is required (default ESC/POS)
        let bt = SavedPrinter { name: "BT".into(), kind: KIND_BLUETOOTH.into(), host: "AA:BB:CC:DD:EE:FF".into(), port: 99, path: "/x".into(), ..Default::default() };
        let v = bt.validated().unwrap();
        assert_eq!((v.port, v.path.as_str(), v.language.as_str()), (0, "", "escpos"));
        let usb = SavedPrinter { name: "U".into(), kind: KIND_USB.into(), host: "0483:5740".into(), language: "tspl".into(), ..Default::default() };
        assert_eq!(usb.validated().unwrap().language, "tspl");
        assert!(SavedPrinter { language: "pdf".into(), ..bt.clone() }.validated().is_err());
        assert!(SavedPrinter { host: "".into(), ..bt }.validated().is_err());
    }

    #[test]
    fn older_saved_files_without_new_fields_still_load() {
        let json = r#"[{"name":"Old","kind":"ipp","host":"10.0.0.2","port":631,"path":"/ipp/print"}]"#;
        let list: Vec<SavedPrinter> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].validated().unwrap().language, LANG_AUTO);
    }

    #[test]
    fn needs_bitmap_decision() {
        let pdf_fmt = vec!["image/urf".to_string(), "application/pdf".to_string()];
        let urf_only = vec!["image/urf".to_string()];
        let auto = ipp_printer("h", 631).validated().unwrap();
        assert!(!auto.needs_bitmap(&pdf_fmt));
        assert!(auto.needs_bitmap(&urf_only));
        assert!(!auto.needs_bitmap(&[])); // printer did not say: try the PDF
        assert!(!SavedPrinter { language: LANG_PDF.into(), ..auto.clone() }.needs_bitmap(&urf_only));
        assert!(SavedPrinter { language: raster::LANG_PWG.into(), ..auto }.needs_bitmap(&pdf_fmt));
    }

    #[test]
    fn ipp_sends_other_document_formats() {
        let mut r = vec![1, 1, 0, 0, 0, 0, 0, 1, 0x01];
        put_attr(&mut r, 0x47, "attributes-charset", b"utf-8");
        r.push(0x02);
        put_attr(&mut r, 0x21, "job-id", &7i32.to_be_bytes());
        r.push(TAG_END);
        let (port, server) = mock_ipp(r);
        let sent = send_ipp(&ipp_printer("127.0.0.1", port).validated().unwrap(), "x", "image/pwg-raster", b"RaS2").unwrap();
        server.join().unwrap();
        assert!(sent.command.contains("image/pwg-raster") && sent.command.contains("job-id 7"), "{}", sent.command);
    }

    #[test]
    fn unreachable_printer_gives_a_clear_error() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // closed again
        let err = print_pdf(&ipp_printer("127.0.0.1", port).validated().unwrap(), "x", b"%PDF").err().unwrap();
        assert!(err.contains("Could not reach"), "{err}");
    }

    #[test]
    fn raw_socket_gets_the_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            s.read_to_end(&mut got).unwrap();
            got
        });
        let p = SavedPrinter { name: "Raw".into(), kind: KIND_RAW.into(), host: "127.0.0.1".into(), port, ..Default::default() };
        print_pdf(&p, "Labels", b"%PDF-raw").unwrap();
        assert_eq!(h.join().unwrap(), b"%PDF-raw");
    }

    #[test]
    fn storage_upsert_and_remove() {
        let dir = std::env::temp_dir().join(format!("qprint-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("printers.json");
        let _ = std::fs::remove_file(&file);
        assert!(load_all(&file).unwrap().is_empty());
        upsert(&file, &ipp_printer("10.0.0.5", 631)).unwrap();
        upsert(&file, &ipp_printer("10.0.0.6", 631)).unwrap(); // same name: replaced
        let list = load_all(&file).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "10.0.0.6");
        remove(&file, "Office").unwrap();
        assert!(load_all(&file).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
