//! The local print API: a small HTTP server on `127.0.0.1` so anything on the machine can print.
//!
//! Desktop only. Android builds this out entirely (`#[cfg(not(target_os = "android"))]` in
//! `lib.rs`), because there is no local port for a POS on the same network to reach.
//!
//! ## What this can do
//!
//! It can spend paper and ink. That is why the defaults are strict rather than convenient:
//!
//! - It binds to `127.0.0.1` only, so it is not reachable from the network and does not trip the
//!   Windows Firewall prompt.
//! - Every endpoint except `/health` needs a bearer token, compared in constant time.
//! - Requests whose `Host` is not our own loopback address are refused, which is what stops a
//!   hostile website from pointing a name it controls at `127.0.0.1` and having the browser talk to
//!   us on the user's behalf (DNS rebinding).
//! - A browser request from an origin that is not on the allow-list is refused, so a web page the
//!   user happens to have open cannot spend their paper.
//!
//! ## Shape
//!
//! The decisions that matter — routing, auth, the host and origin matrix, limits — are plain
//! functions at the top of this file, tested directly. The plumbing below them (sockets, threads,
//! the bridge to the webview) is deliberately thin.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::api_settings::{ApiSettings, ApiStatus, RecentCall, new_token};

/// Largest PDF accepted on `/print/pdf`. A 64 MB PDF is already an unusual label job; past this the
/// process holding it in memory is a worse problem than the job that was refused.
pub const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;

/// Largest JSON body accepted on `/print`. `rows` is the only thing that can grow, and a caller who
/// wants more than this has a loop, not a request.
pub const MAX_JSON_BYTES: usize = 5 * 1024 * 1024;

/// Page ceiling. Matches the UI's own limit, so the API cannot be used to sidestep it.
pub const MAX_PAGES: u32 = 10_000;

/// How long the webview gets to answer before label mode gives up. Generous, because rendering a
/// 10,000-page label is genuinely slow, but bounded, because an unanswered request would otherwise
/// hold the one print lock forever.
pub const BRIDGE_TIMEOUT: Duration = Duration::from_secs(300);

/// The app's own origins, which the API tab fetches from. A browser will not let a page on another
/// origin read the response, so without these the test page could send but never see a reply.
const OWN_ORIGINS: [&str; 5] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:1420",
    "http://localhost:1421",
];

// ---------------------------------------------------------------------------------------------
// Errors. One shape for every failure, so a client only has to parse one thing.
// ---------------------------------------------------------------------------------------------

/// A failure, with the status code and machine-readable code the plan specifies.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(400, "bad_request", msg)
    }
    pub fn unauthorized() -> Self {
        // Never says what the token should have been.
        Self::new(401, "unauthorized", "A valid bearer token is required.")
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(403, "forbidden", msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(404, "not_found", msg)
    }
    /// Rewrites the status, for the one case that is a 400-shaped problem with another code.
    pub fn with_status(mut self, status: u16, code: &'static str) -> Self {
        self.status = status;
        self.code = code;
        self
    }
    /// The webview's own wording, kept as the message so the client is told what to do about it.
    pub fn no_user_from(reason: impl Into<String>) -> Self {
        Self::new(
            409,
            "no_user",
            format!("{}. Sign in to the app first.", reason.into().trim_end_matches('.')),
        )
    }
    pub fn too_large(limit: usize) -> Self {
        Self::new(413, "too_large", format!("The request body is larger than the {limit} byte limit."))
    }
    pub fn unprocessable(msg: impl Into<String>) -> Self {
        Self::new(422, "unprocessable", msg)
    }
    pub fn printer_failed(msg: impl Into<String>) -> Self {
        Self::new(500, "print_failed", msg)
    }
    pub fn timeout() -> Self {
        Self::new(504, "timeout", "The app did not answer in time. Is the window still there? PDF mode works even when it is not.")
    }
    /// The JSON body for an error. Never carries the token or the request body.
    pub fn body(&self) -> String {
        serde_json::json!({ "error": { "code": self.code, "message": self.message } }).to_string()
    }
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Route {
    Health,
    Printers,
    Labels,
    Print,
    PrintPdf,
}

impl Route {
    fn path(self) -> &'static str {
        match self {
            Route::Health => "/api/v1/health",
            Route::Printers => "/api/v1/printers",
            Route::Labels => "/api/v1/labels",
            Route::Print => "/api/v1/print",
            Route::PrintPdf => "/api/v1/print/pdf",
        }
    }

    /// Sent as `Allow` on a 405, so a client can tell a wrong verb from a wrong path.
    fn methods(self) -> &'static str {
        match self {
            Route::Health | Route::Printers | Route::Labels => "GET",
            Route::Print | Route::PrintPdf => "POST",
        }
    }
}

/// Every endpoint. The path and the method come from `Route` itself, so there is no second copy
/// that could fall out of step with the handlers.
const ROUTES: [Route; 5] = [Route::Health, Route::Printers, Route::Labels, Route::Print, Route::PrintPdf];

/// Works out which endpoint a request is for.
///
/// A query string is stripped first: `/printers?x=1` is the printers endpoint, not a 404. A
/// trailing slash goes too, because somebody typing this by hand will add one.
pub fn route(method: &str, path: &str) -> Result<Route, ApiError> {
    let path = path_only(path);
    match ROUTES.iter().find(|r| r.path() == path) {
        Some(r) if r.methods() == method => Ok(*r),
        // Right endpoint, wrong verb. A different code from "no such endpoint", because a client
        // reacts to the two differently.
        Some(r) => Err(ApiError::bad_request(format!("{} takes {}.", r.path(), r.methods()))
            .with_status(405, "method_not_allowed")),
        None => Err(ApiError::not_found(format!("There is no endpoint at {path}."))),
    }
}

/// The path part of a request URL: no query string, and no trailing slash.
///
/// A trailing slash goes because somebody typing this by hand will add one, and it is the same
/// endpoint as far as anybody is concerned.
pub fn path_only(url: &str) -> &str {
    let path = url.split('?').next().unwrap_or(url);
    path.strip_suffix('/').unwrap_or(path)
}

// ---------------------------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------------------------

/// Whether a `Host` header is ours. Anything else means the request did not come to us by name.
pub fn host_allowed(host: &str, port: u16) -> bool {
    // Strip the port. `Host` may be absent (HTTP/1.0) or carry only a name, and an IPv6 literal is
    // bracketed, so both the bracketed and bare form are accepted.
    let name = host.trim();
    let name = match name.rfind(':') {
        Some(i) if !name[i + 1..].contains(']') => &name[..i],
        _ => name,
    };
    let name = name.trim_start_matches('[').trim_end_matches(']');
    matches!(name, "127.0.0.1" | "localhost" | "::1")
        // A `Host` naming a different port than we listen on is either a proxy or a rebind attempt.
        && !host_has_other_port(host, port)
}

/// True when the header names a port, and it is not ours.
fn host_has_other_port(host: &str, port: u16) -> bool {
    let host = host.trim();
    // With an IPv6 literal the last colon is the port separator and the value is not bracketed.
    let given = if let Some(end) = host.strip_suffix(']') {
        host[end.len() + 1..].strip_prefix(':').map(|p| p.to_string())
    } else {
        host.rsplit_once(':').map(|(_, p)| p.to_string())
    };
    match given {
        Some(p) => p.parse::<u16>().map(|n| n != port).unwrap_or(true),
        None => false,
    }
}

/// Whether a browser `Origin` may call us.
///
/// No `Origin` at all means curl, a POS, or a script, which is the intended caller. Those are
/// held to the token instead, which a browser cannot read.
pub fn origin_allowed(origin: Option<&str>, extra: &[String]) -> bool {
    // No header, or an empty one, is a script: browsers always send a real origin, so an empty
    // value cannot have come from one. Those are held to the token instead.
    let origin = origin.map(str::trim).filter(|o| !o.is_empty());
    let Some(origin) = origin else { return true };
    let origin = origin.trim_end_matches('/');
    OWN_ORIGINS.contains(&origin) || extra.iter().any(|o| o.trim().trim_end_matches('/') == origin)
}

/// The `Access-Control-Allow-Origin` value to send back, if any.
///
/// Echoing only an allowed origin is the whole point: echoing whatever was asked is how a server
/// ends up answering the attacker's page.
pub fn cors_origin<'a>(origin: Option<&'a str>, extra: &[String]) -> Option<&'a str> {
    let origin = origin?;
    if origin_allowed(Some(origin), extra) {
        Some(origin)
    } else {
        None
    }
}

/// Compares a presented token with the expected one without leaking, through timing, how much of it
/// was right.
///
/// The loop always runs over the shorter of the two, so a token that is wrong in its first
/// character takes the same time as one that is wrong in its last.
pub fn token_matches(provided: &str, expected: &str) -> bool {
    if expected.is_empty() {
        // An unset token must never authenticate anything, including the empty string.
        return false;
    }
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().min(b.len()) {
        diff |= usize::from(a[i] ^ b[i]);
    }
    diff == 0
}

/// Pulls the bearer token out of an `Authorization` header.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let rest = header?.strip_prefix("Bearer ").or_else(|| header?.strip_prefix("bearer "))?;
    Some(rest.trim())
}

/// The `Host` the API is reachable at, for messages and for the test page to copy.
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/v1")
}

// ---------------------------------------------------------------------------------------------
// Query strings and bodies
// ---------------------------------------------------------------------------------------------

/// Reads the first value of a query parameter, with `+` meaning a space.
pub fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        if url_decode(key) == name {
            return Some(parts.next().map(url_decode).unwrap_or_default());
        }
    }
    None
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => match u8::from_str_radix(s.get(i + 1..i + 3).unwrap_or("zz"), 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a body is a PDF. Checked on the magic bytes rather than the content type, because the
/// content type is whatever the caller says it is.
pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// The first line of a PDF's version comment, for the error message when the body is wrong.
fn pdf_version(bytes: &[u8]) -> String {
    std::str::from_utf8(&bytes[..bytes.len().min(16)])
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Options for a PDF print, from the query string.
pub fn pdf_options(query: &str) -> Result<crate::PrintOptions, ApiError> {
    let printer = query_param(query, "printer").unwrap_or_default();
    if printer.trim().is_empty() {
        return Err(ApiError::bad_request("`printer` is required. Use ?printer=<name>."));
    }
    Ok(crate::PrintOptions {
        printer,
        paper: query_param(query, "paper").unwrap_or_default(),
        orientation: query_param(query, "orientation").unwrap_or_else(|| "auto".into()),
        dpi: query_param(query, "dpi").unwrap_or_default(),
    })
}

/// A label-mode request body. Fields are all optional here and validated by the caller, because the
/// error has to say which one was wrong.
#[derive(serde::Deserialize, Serialize, Default, Clone, Debug)]
pub struct PrintRequest {
    pub label: Option<String>,
    pub printer: Option<String>,
    pub pages: Option<u32>,
    #[serde(default)]
    pub rows: Option<Vec<HashMap<String, String>>>,
    pub api: Option<serde_json::Value>,
    pub paper: Option<String>,
    pub orientation: Option<String>,
    pub rotate: Option<u16>,
    pub margins: Option<Margins>,
    pub dpi: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(serde::Deserialize, Serialize, Clone, Copy, Debug, Default)]
pub struct Margins {
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
    #[serde(default)]
    pub left: f64,
}

impl PrintRequest {
    /// Checks everything that can be checked without the webview, so a bad request is refused
    /// before a round trip that could not have worked.
    pub fn validate(&self) -> Result<(String, String, u32), ApiError> {
        let label = self.label.clone().unwrap_or_default();
        if label.trim().is_empty() {
            return Err(ApiError::bad_request("`label` is required. See GET /labels."));
        }
        let printer = self.printer.clone().unwrap_or_default();
        if printer.trim().is_empty() {
            return Err(ApiError::bad_request("`printer` is required."));
        }
        let pages = self.pages.unwrap_or(1);
        if !(1..=MAX_PAGES).contains(&pages) {
            return Err(ApiError::bad_request(format!("`pages` must be between 1 and {MAX_PAGES}.")));
        }
        // A rotation the app cannot apply would be silently ignored by the renderer.
        if let Some(r) = self.rotate {
            if !matches!(r, 0 | 90 | 180 | 270) {
                return Err(ApiError::bad_request("`rotate` must be 0, 90, 180 or 270."));
            }
        }
        Ok((label, printer, pages))
    }
}

// ---------------------------------------------------------------------------------------------
// The bridge to the webview.
// ---------------------------------------------------------------------------------------------

/// Label rendering lives in the webview, because that is where pdfme and the label database are.
/// Rust asks, the webview answers.
///
/// A reply comes back as a channel rather than a promise: the HTTP handler is a plain blocking
/// thread, and a channel with a timeout is the honest shape for that. Requests are matched by id so
/// several can be in flight without crossing.
#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<String, Sender<String>>>,
}

impl Bridge {
    /// Registers a request and returns the end to wait on. The caller must call [`Bridge::abandon`]
    /// when it stops waiting, or the map leaks an entry per timed-out request.
    pub fn expect_reply(&self, id: &str) -> Receiver<String> {
        let (tx, rx) = channel();
        self.pending.lock().expect("bridge lock").insert(id.to_string(), tx);
        rx
    }

    /// Hands back a reply. Returns false when nothing is waiting for it, which happens if the
    /// requester gave up first.
    pub fn reply(&self, id: &str, payload: String) -> bool {
        match self.pending.lock().expect("bridge lock").remove(id) {
            Some(tx) => tx.send(payload).is_ok(),
            None => false,
        }
    }

    pub fn abandon(&self, id: &str) {
        self.pending.lock().expect("bridge lock").remove(id);
    }

    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.pending.lock().expect("bridge lock").len()
    }
}

/// Asks the webview, waits for the answer, and hands back the parsed reply.
///
/// The webview being gone is an ordinary answer, not a crash: it reports failure as JSON and this
/// turns that into an error with a code.
fn ask(app: &tauri::AppHandle, bridge: &Bridge, payload: serde_json::Value) -> Result<serde_json::Value, ApiError> {
    let id = new_token();
    let rx = bridge.expect_reply(&id);
    let mut payload = payload;
    payload["id"] = serde_json::Value::String(id.clone());

    if let Err(e) = app.emit("api-request", payload) {
        bridge.abandon(&id);
        return Err(ApiError::unprocessable(format!("The app's window is not answering: {e}")));
    }

    let answer = match rx.recv_timeout(BRIDGE_TIMEOUT) {
        Ok(answer) => answer,
        Err(_) => {
            bridge.abandon(&id);
            return Err(ApiError::timeout());
        }
    };

    serde_json::from_str(&answer)
        .map_err(|e| ApiError::unprocessable(format!("The app sent something unreadable: {e}")))
}

/// What labels the signed-in account can print.
pub fn ask_labels(app: &tauri::AppHandle, bridge: &Bridge) -> Result<serde_json::Value, ApiError> {
    ask(app, bridge, serde_json::json!({ "kind": "labels" }))
}

/// Renders and prints one label, through the same code the UI uses.
pub fn ask_print(
    app: &tauri::AppHandle,
    bridge: &Bridge,
    request: &PrintRequest,
) -> Result<serde_json::Value, ApiError> {
    ask(app, bridge, serde_json::json!({ "kind": "print", "request": request }))
}

/// Turns the webview's `{"error": "...", "status": n}` into an API error.
///
/// The webview is the one that knows why it could not do the job, and "nobody is signed in" is a
/// 409 while a bad field value is a 422. It says which in `status`; anything unrecognised is
/// treated as a 422, so an unexpected shape still reaches the client as "fix your request" rather
/// than as a server fault.
pub fn bridge_error(value: &serde_json::Value) -> Option<ApiError> {
    let msg = value.get("error")?.as_str()?;
    match value.get("status").and_then(|s| s.as_u64()) {
        Some(409) => Some(ApiError::no_user_from(msg)),
        Some(404) => Some(ApiError::not_found(msg)),
        Some(422) | None => Some(ApiError::unprocessable(msg)),
        Some(status) if (400..600).contains(&status) => {
            Some(ApiError::unprocessable(msg).with_status(status as u16, "failed"))
        }
        Some(_) => Some(ApiError::unprocessable(msg)),
    }
}

// ---------------------------------------------------------------------------------------------
// State and lifecycle
// ---------------------------------------------------------------------------------------------

const RECENT_MAX: usize = 50;

/// The API's whole mutable state, held by Tauri.
///
/// One place owns the settings, the listener and the pending bridge requests, so there is a single
/// answer to "is it running" and a single token. Held in `Mutex`es because Tauri manages this by
/// value and it is read from the HTTP threads as well as the UI.
pub struct ApiState {
    settings: Mutex<ApiSettings>,
    /// The listener, kept only so it can be unblocked to stop it. The running loop owns its own
    /// `Arc` to the same server, which is what makes `incoming_requests` work from that thread.
    listener: Mutex<Option<std::sync::Arc<tiny_http::Server>>>,
    /// Read by the Tauri command that carries a webview's reply back to the waiting HTTP thread.
    pub bridge: Bridge,
    /// Calls from outside the app, newest first, for the recent-calls list.
    recent: Mutex<Vec<RecentCall>>,
    /// Counts those calls. Monotonic, so a row's key never changes and two calls in the same
    /// millisecond are still told apart.
    sequence: std::sync::atomic::AtomicU64,
    /// Why the listener is not running, when it is not. Shown on the API tab.
    problem: Mutex<String>,
}

impl ApiState {
    pub fn new(settings: ApiSettings) -> Self {
        Self {
            settings: Mutex::new(settings),
            listener: Mutex::new(None),
            bridge: Bridge::default(),
            recent: Mutex::new(Vec::new()),
            sequence: std::sync::atomic::AtomicU64::new(0),
            problem: Mutex::new(String::new()),
        }
    }

    pub fn settings(&self) -> ApiSettings {
        self.settings.lock().expect("settings lock").clone()
    }

    /// Saves new settings and restarts the listener if anything that needs it changed.
    ///
    /// A port that is already taken is reported, never fatal: the app is still a perfectly good
    /// printing app with a broken API, which is what the status line says.
    pub fn apply(&self, app: &tauri::AppHandle, next: ApiSettings) -> ApiStatus {
        let next = match crate::api_settings::validate(next) {
            Ok(s) => s,
            Err(reason) => {
                // Keep the old, working settings rather than writing settings known to be wrong.
                *self.problem.lock().expect("problem lock") = reason;
                return self.status();
            }
        };
        *self.settings.lock().expect("settings lock") = next;
        self.problem.lock().expect("problem lock").clear();
        self.restart(app);
        self.status()
    }

    pub fn regenerate_token(&self, app: &tauri::AppHandle) -> Result<ApiStatus, String> {
        let mut next = self.settings();
        next.token = new_token();
        if next.token.is_empty() {
            return Err("The system random source failed, so no new token could be made.".into());
        }
        Ok(self.apply(app, next))
    }

    /// Stops any listener, then starts one if the API is enabled.
    pub fn restart(&self, app: &tauri::AppHandle) {
        self.stop();
        let settings = self.settings();
        if !settings.enabled {
            return;
        }
        match tiny_http::Server::http(("127.0.0.1", settings.port)) {
            Ok(server) => {
                let server = std::sync::Arc::new(server);
                *self.listener.lock().expect("listener lock") = Some(server.clone());
                let app = app.clone();
                std::thread::spawn(move || serve(app, server));
            }
            Err(e) => {
                // Said out loud rather than swallowed: the test page shows this, and it is the
                // single most likely reason the API "does not work".
                let msg = format!("Port {} could not be opened ({e}).", settings.port);
                eprintln!("[api] {msg}");
                *self.problem.lock().expect("problem lock") = msg;
            }
        }
    }

    fn stop(&self) {
        if let Some(server) = self.listener.lock().expect("listener lock").take() {
            // Unblocking is what ends the accept loop; without it the thread waits forever.
            server.unblock();
        }
    }

    pub fn status(&self) -> ApiStatus {
        let settings = self.settings();
        let running = self.listener.lock().expect("listener lock").is_some();
        let problem = self.problem.lock().expect("problem lock").clone();
        ApiStatus {
            available: true,
            running,
            port: settings.port,
            base_url: base_url(settings.port),
            problem: if running || !settings.enabled { String::new() } else { problem },
            settings,
        }
    }

    fn note(&self, at: i64, method: String, path: String, status: u16, ms: u64) {
        let seq = self.sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut recent = self.recent.lock().expect("recent lock");
        recent.insert(0, RecentCall { seq, at, method, path, status, ms });
        recent.truncate(RECENT_MAX);
    }

    pub fn recent(&self) -> Vec<RecentCall> {
        self.recent.lock().expect("recent lock").clone()
    }
}

// ---------------------------------------------------------------------------------------------
// The request loop
// ---------------------------------------------------------------------------------------------

/// The accept loop. Owns its `Arc<Server>`; the app keeps another so it can `unblock()` this on a
/// restart, which is what makes the loop end.
fn serve(app: tauri::AppHandle, server: std::sync::Arc<tiny_http::Server>) {
    for request in server.incoming_requests() {
        if let Err(e) = handle(&app, request) {
            eprintln!("[api] could not answer a request: {e}");
        }
    }
}

fn handle(app: &tauri::AppHandle, mut request: tiny_http::Request) -> std::io::Result<()> {
    let started = std::time::Instant::now();
    let state = app.state::<ApiState>();

    let method = request.method().as_str().to_string();
    let url = request.url().to_string();

    // Whether the reply is JSON or a PDF is decided by the handler, so an error is formatted here
    // from whatever it decided to fail with.
    let (status, content_type, response) = match dispatch(app, &mut request, &state) {
        Ok(Reply::Json(body)) => (200u16, "application/json".to_string(), tiny_http::Response::from_string(body)),
        Ok(Reply::Pdf(bytes)) => (200u16, "application/pdf".to_string(), tiny_http::Response::from_data(bytes)),
        Err(e) => (e.status, "application/json".to_string(), tiny_http::Response::from_string(e.body())),
    };

    state.note(now_millis(), method, url, status, started.elapsed().as_millis() as u64);

    let content_type =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap();
    let mut response = response.with_header(content_type);
    // CORS rides along on errors too, so a browser can read why it failed rather than only seeing
    // a bare failure in the console.
    add_cors(&mut response, header(&request, "origin"), &state.settings().allowed_origins);
    request.respond(response)
}

/// Epoch milliseconds, without pulling in `chrono`. Only used to order the recent-calls list.
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads a header as a string, or None. Header values are not UTF-8 in general, but the ones read
/// here (Host, Origin, Authorization) are ASCII by definition.
pub fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

fn add_cors<R: std::io::Read + Send + 'static>(
    response: &mut tiny_http::Response<R>,
    origin: Option<String>,
    extra: &[String],
) {
    let Some(value) = cors_origin(origin.as_deref(), extra) else { return };
    for (field, val) in [
        ("Access-Control-Allow-Origin", value),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
        ("Access-Control-Max-Age", "600"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(field.as_bytes(), val.as_bytes()) {
            response.add_header(h);
        }
    }
}

/// Everything decided before a handler runs: is this addressed to us, is this browser allowed,
/// is this the right verb for this path, and is the token right.
///
/// Kept separate from [`dispatch`] so the whole matrix can be tested without a socket. The order
/// matters and is the order below: the cheapest and most fundamental checks first, so a request
/// that is not even addressed to us never reaches the token comparison.
pub fn guard(
    method: &str,
    url: &str,
    host: Option<&str>,
    origin: Option<&str>,
    authorization: Option<&str>,
    settings: &ApiSettings,
) -> Result<Decision, ApiError> {
    let Some(host) = host else {
        // No Host at all: not a browser, and nothing worth serving.
        return Err(ApiError::forbidden("No Host header."));
    };
    if !host_allowed(host, settings.port) {
        return Err(ApiError::forbidden(format!(
            "This API only answers to 127.0.0.1:{}.",
            settings.port
        )));
    }

    // A CORS preflight carries no Authorization header by definition, so it is answered on origin
    // alone and never reaches the token check.
    if method == "OPTIONS" {
        let path = path_only(url);
        if !ROUTES.iter().any(|r| r.path() == path) {
            return Err(ApiError::not_found(format!("There is no endpoint at {path}.")));
        }
        return Ok(Decision::Preflight);
    }

    if !origin_allowed(origin, &settings.allowed_origins) {
        return Err(ApiError::forbidden(format!(
            "This origin is not allowed to use the print API: {}",
            origin.unwrap_or_default()
        )));
    }

    let endpoint = route(method, url)?;
    if endpoint != Route::Health && !token_matches(bearer(authorization).unwrap_or(""), &settings.token) {
        return Err(ApiError::unauthorized());
    }
    Ok(Decision::Endpoint(endpoint))
}

/// What a handler produced. A dry run is the only endpoint that answers with something other than
/// JSON, and it has to be real bytes: the base64 the webview sent it as is a detail of the bridge.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Json(String),
    Pdf(Vec<u8>),
}

/// What a request turned out to be. A preflight is not an endpoint call: it carries no token by
/// design and must not be answered by running the handler.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Decision {
    Preflight,
    Endpoint(Route),
}

/// Runs the guard, then the handler.
fn dispatch(
    app: &tauri::AppHandle,
    request: &mut tiny_http::Request,
    state: &ApiState,
) -> Result<Reply, ApiError> {
    let settings = state.settings();
    let url = request.url().to_string();
    let method = request.method().as_str().to_string();
    let endpoint = guard(
        &method,
        &url,
        header(request, "host").as_deref(),
        header(request, "origin").as_deref(),
        header(request, "authorization").as_deref(),
        &settings,
    )?;
    match endpoint {
        // A preflight only wants permission. The CORS headers are added on the way out, so an empty
        // body is the whole answer.
        Decision::Preflight => Ok(Reply::Json(String::new())),
        Decision::Endpoint(route) => run(app, request, route, &state.bridge),
    }
}

fn run(
    app: &tauri::AppHandle,
    request: &mut tiny_http::Request,
    endpoint: Route,
    bridge: &Bridge,
) -> Result<Reply, ApiError> {
    match endpoint {
        Route::Health => {
            let (user, printers) = bridge_health(app, bridge);
            let json = serde_json::json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "signedIn": user.is_some(),
                "user": user,
                "printers": printers,
            });
            Ok(Reply::Json(json.to_string()))
        }
        Route::Printers => {
            let printers = list_printers(app);
            Ok(Reply::Json(serde_json::json!({ "printers": printers }).to_string()))
        }
        Route::Labels => {
            let answer = ask_labels(app, bridge)?;
            if let Some(e) = bridge_error(&answer) {
                return Err(e);
            }
            Ok(Reply::Json(answer.to_string()))
        }
        Route::Print => {
            let body = read_body(request, MAX_JSON_BYTES)?;
            let parsed: PrintRequest = serde_json::from_slice(&body)
                .map_err(|e| ApiError::bad_request(format!("The body is not valid JSON: {e}")))?;
            let (_, _, _) = parsed.validate()?;
            let answer = ask_print(app, bridge, &parsed)?;
            if let Some(e) = bridge_error(&answer) {
                return Err(e);
            }
            Ok(match answer.get("pdf").and_then(|p| p.as_str()) {
                // A dry run hands back the PDF itself rather than a JSON result. It travelled as
                // base64 because the bridge speaks JSON, and it goes back out as the bytes it was.
                Some(b64) => Reply::Pdf(decode_base64(b64)?),
                None => Reply::Json(answer.to_string()),
            })
        }
        Route::PrintPdf => {
            let body = read_body(request, MAX_PDF_BYTES)?;
            if !looks_like_pdf(&body) {
                return Err(ApiError::bad_request(format!(
                    "The body is not a PDF (it starts with {:?}). Send the file itself as the body.",
                    pdf_version(&body)
                )));
            }
            let query = request.url().split_once('?').map(|(_, q)| q).unwrap_or("");
            let opts = pdf_options(query)?;
            let report = print(app, opts, body)?;
            Ok(Reply::Json(
                serde_json::json!({
                    "status": "printed",
                    "transport": report.transport,
                    "report": {
                        "paperApplied": report.paper_applied,
                        "paperNote": report.paper_note,
                        "orientation": report.orientation,
                        "dpiApplied": report.dpi_applied,
                        "dpiNote": report.dpi_note,
                    }
                })
                .to_string(),
            ))
        }
    }
}

/// Whether anybody is signed in, and how many printers are installed. Both can fail without making
/// `/health` fail: a health check that reports unhealthy because a printer list is unavailable would
/// be useless for deciding whether to call it again.
fn bridge_health(app: &tauri::AppHandle, bridge: &Bridge) -> (Option<String>, usize) {
    let user = ask_labels(app, bridge)
        .ok()
        .and_then(|v| v.get("user").and_then(|u| u.as_str()).map(String::from));
    (user, list_printers(app).len())
}

pub fn list_printers(app: &tauri::AppHandle) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        crate::platform::list_printers()
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::platform::list_printers(app)
    }
}

/// Runs a print through the same path the UI uses.
///
/// Deliberately not a second implementation: sharing the path is what gives the API the same
/// `PRINT_LOCK` as the UI, so a person clicking Print and a script printing at the same moment
/// queue instead of corrupting each other's DPI settings.
pub fn print(
    app: &tauri::AppHandle,
    opts: crate::PrintOptions,
    bytes: Vec<u8>,
) -> Result<crate::PrintReport, ApiError> {
    let owned = app.clone();
    let result = tauri::async_runtime::block_on(crate::run_print(owned, opts, bytes));
    result.map_err(ApiError::printer_failed)
}

fn read_body(request: &mut tiny_http::Request, limit: usize) -> Result<Vec<u8>, ApiError> {
    let mut body = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        // A fixed chunk rather than a `Take`, which a `dyn Read` cannot carry. The size is checked on
        // every pass, so an over-large body is refused while it is still arriving rather than after
        // all of it has been buffered.
        let n = request
            .as_reader()
            .read(&mut chunk)
            .map_err(|e| ApiError::bad_request(format!("The body could not be read: {e}")))?;
        if n == 0 {
            return Ok(body);
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > limit {
            return Err(ApiError::too_large(limit));
        }
    }
}

/// The bytes behind a dry run's PDF. Anything that is not base64 is the bridge's fault and is said
/// so, rather than becoming a corrupt file the caller would try to print.
fn decode_base64(text: &str) -> Result<Vec<u8>, ApiError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| ApiError::unprocessable(format!("The app sent a dry-run PDF that is not readable: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_endpoint_is_reachable() {
        assert_eq!(route("GET", "/api/v1/health").unwrap(), Route::Health);
        assert_eq!(route("GET", "/api/v1/printers").unwrap(), Route::Printers);
        assert_eq!(route("GET", "/api/v1/labels").unwrap(), Route::Labels);
        assert_eq!(route("POST", "/api/v1/print").unwrap(), Route::Print);
        assert_eq!(route("POST", "/api/v1/print/pdf").unwrap(), Route::PrintPdf);
    }

    #[test]
    fn a_query_string_or_trailing_slash_is_the_same_endpoint() {
        // Somebody typing this by hand will do both.
        assert_eq!(route("GET", "/api/v1/printers?x=1").unwrap(), Route::Printers);
        assert_eq!(route("GET", "/api/v1/printers/").unwrap(), Route::Printers);
    }

    #[test]
    fn an_unknown_path_is_404_and_a_wrong_verb_is_405() {
        // Different codes, because the first means "no such thing" and the second "right thing,
        // wrong way": a client reacts differently.
        let missing = route("GET", "/api/v1/nope").unwrap_err();
        assert_eq!(missing.status, 404);
        let wrong = route("POST", "/api/v1/health").unwrap_err();
        assert_eq!(wrong.status, 405);
        assert!(wrong.message.contains("GET"), "should say what is allowed: {}", wrong.message);
    }

    #[test]
    fn only_our_own_hosts_are_answered() {
        assert!(host_allowed("127.0.0.1:17631", 17631));
        assert!(host_allowed("localhost:17631", 17631));
        // A name the attacker controls, pointed at our socket. This is the rebind case.
        assert!(!host_allowed("evil.example.com", 17631));
        assert!(!host_allowed("evil.example.com:17631", 17631));
        // Right host, wrong port: a proxy, or a rebound name on another port.
        assert!(!host_allowed("127.0.0.1:9999", 17631));
        // Bare, no port.
        assert!(host_allowed("127.0.0.1", 17631));
    }

    #[test]
    fn an_ipv6_loopback_host_is_accepted() {
        assert!(host_allowed("[::1]:17631", 17631));
        assert!(host_allowed("[::1]", 17631));
    }

    #[test]
    fn a_request_with_no_origin_is_a_script_and_is_allowed_through() {
        // curl and a POS have no Origin. The token is what holds them to account.
        assert!(origin_allowed(None, &[]));
        assert!(origin_allowed(Some(""), &[]));
    }

    #[test]
    fn the_apps_own_origins_are_allowed_but_other_sites_are_not() {
        assert!(origin_allowed(Some("http://tauri.localhost"), &[]));
        assert!(origin_allowed(Some("http://localhost:1420"), &[]));
        // The important one: a page the user is reading must not be able to spend their paper.
        assert!(!origin_allowed(Some("https://news.example.com"), &[]));
        assert!(!origin_allowed(Some("http://tauri.localhost.evil.com"), &[]));
    }

    #[test]
    fn an_origin_the_user_added_is_allowed() {
        let extra = vec!["http://pos.local:8080".to_string()];
        assert!(origin_allowed(Some("http://pos.local:8080"), &extra));
        assert!(!origin_allowed(Some("http://pos.local:9090"), &extra));
    }

    #[test]
    fn cors_echoes_only_an_origin_we_accept() {
        assert_eq!(cors_origin(Some("http://tauri.localhost"), &[]), Some("http://tauri.localhost"));
        assert_eq!(cors_origin(Some("https://evil.com"), &[]), None);
    }

    #[test]
    fn a_trailing_slash_does_not_break_an_origin_match() {
        let extra = vec!["http://pos.local".to_string()];
        assert!(origin_allowed(Some("http://pos.local/"), &extra));
    }

    #[test]
    fn the_right_token_passes_and_anything_else_does_not() {
        let expected = "abc123";
        assert!(token_matches("abc123", expected));
        assert!(!token_matches("", expected));
        assert!(!token_matches("abc124", expected));
        assert!(!token_matches("abc1234", expected));
        assert!(!token_matches("ABC123", expected));
    }

    #[test]
    fn an_unset_token_authenticates_nothing() {
        // The dangerous case: an empty expected token must not accept an empty presented one.
        assert!(!token_matches("", ""));
    }

    #[test]
    fn the_bearer_header_is_read_case_insensitively_on_the_scheme() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Bearer   abc  ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn query_parameters_are_read_with_percent_and_plus_escapes() {
        assert_eq!(query_param("printer=Office&paper=A6", "printer").as_deref(), Some("Office"));
        assert_eq!(query_param("printer=Front%20desk", "printer").as_deref(), Some("Front desk"));
        assert_eq!(query_param("printer=a+b", "printer").as_deref(), Some("a b"));
        assert_eq!(query_param("paper=A6", "printer"), None);
        // A parameter with no value is an empty value, not a missing one.
        assert_eq!(query_param("printer", "printer").as_deref(), Some(""));
    }

    #[test]
    fn pdf_options_need_a_printer_and_default_the_rest() {
        let opts = pdf_options("printer=Office").unwrap();
        assert_eq!(opts.printer, "Office");
        assert_eq!(opts.orientation, "auto", "the same default the UI uses");
        let err = pdf_options("paper=A6").unwrap_err();
        assert_eq!(err.status, 400);
        assert!(err.message.contains("printer"));
    }

    #[test]
    fn a_pdf_is_recognised_by_its_own_header_not_the_content_type() {
        assert!(looks_like_pdf(b"%PDF-1.7\n..."));
        assert!(!looks_like_pdf(b"{\"label\":\"product\"}"));
        assert!(!looks_like_pdf(b""));
    }

    #[test]
    fn a_print_request_needs_a_label_and_a_printer_and_a_sane_page_count() {
        let base = PrintRequest {
            label: Some("product".into()),
            printer: Some("Office".into()),
            ..PrintRequest::default()
        };
        assert_eq!(base.validate().unwrap().2, 1, "one page is the default");

        let no_label = PrintRequest { label: None, ..base.clone() };
        assert_eq!(no_label.validate().unwrap_err().status, 400);
        let no_printer = PrintRequest { printer: None, ..base.clone() };
        assert_eq!(no_printer.validate().unwrap_err().status, 400);
        for bad in [0, 10_001] {
            let err = PrintRequest { pages: Some(bad), ..base.clone() }.validate().unwrap_err();
            assert_eq!(err.status, 400, "pages={bad} should be refused");
        }
        assert!(PrintRequest { pages: Some(MAX_PAGES), ..base }.validate().is_ok());
    }

    #[test]
    fn a_rotation_the_renderer_cannot_apply_is_refused() {
        let base = PrintRequest {
            label: Some("product".into()),
            printer: Some("Office".into()),
            ..PrintRequest::default()
        };
        assert!(PrintRequest { rotate: Some(90), ..base.clone() }.validate().is_ok());
        assert_eq!(PrintRequest { rotate: Some(45), ..base }.validate().unwrap_err().status, 400);
    }

    #[test]
    fn an_error_body_has_the_shape_a_client_is_told_to_expect() {
        let body = ApiError::unauthorized().body();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["error"]["code"], "unauthorized");
        assert!(v["error"]["message"].is_string());
    }

    #[test]
    fn the_signed_out_case_is_409_not_500() {
        // It is a state of the app, not a fault in the request.
        let v = serde_json::json!({ "error": "nobody is signed in", "status": 409 });
        assert_eq!(bridge_error(&v).unwrap().status, 409);
    }

    #[test]
    fn the_webviews_status_code_is_carried_over() {
        // 404 for a label that is not there, so a client can tell that from a bad request.
        let v = serde_json::json!({ "error": "no label called x", "status": 404 });
        assert_eq!(bridge_error(&v).unwrap().status, 404);
        // Anything unexpected is still the caller's problem to fix, not a server fault.
        let v = serde_json::json!({ "error": "boom" });
        assert_eq!(bridge_error(&v).unwrap().status, 422);
    }

    #[test]
    fn a_bridge_reply_is_matched_to_the_request_that_asked() {
        let bridge = Bridge::default();
        let a = bridge.expect_reply("a");
        let b = bridge.expect_reply("b");
        assert!(bridge.reply("a", "first".into()));
        assert!(bridge.reply("b", "second".into()));
        assert_eq!(a.recv().unwrap(), "first");
        assert_eq!(b.recv().unwrap(), "second");
        assert_eq!(bridge.waiting(), 0, "both should have been dropped from the map");
    }

    #[test]
    fn a_reply_to_nothing_in_particular_is_reported_rather_than_panicking() {
        // Happens when a request gives up on its timeout just before the webview answers.
        let bridge = Bridge::default();
        assert!(!bridge.reply("nobody", "x".into()));
    }

    #[test]
    fn a_given_up_request_stops_being_waited_for() {
        let bridge = Bridge::default();
        let _rx = bridge.expect_reply("a");
        assert_eq!(bridge.waiting(), 1);
        bridge.abandon("a");
        assert_eq!(bridge.waiting(), 0, "an entry left behind leaks per timed-out request");
    }

    #[test]
    fn the_webviews_error_becomes_a_422() {
        // A bad value in `rows` is the caller's problem to fix, not the server's fault.
        let v = serde_json::json!({ "error": "barcode is not a number" });
        assert_eq!(bridge_error(&v).unwrap().status, 422);
        assert_eq!(bridge_error(&serde_json::json!({ "ok": true })), None);
    }

    /// The whole matrix, in one place, because these are the decisions that decide whether a
    /// stranger's web page can spend the user's paper.
    mod guard_matrix {
        use super::{guard, ApiSettings, Decision, Route};
        use crate::api_settings::DEFAULT_PORT;

        fn settings() -> ApiSettings {
            ApiSettings { token: "secret".into(), ..ApiSettings::default() }
        }

        /// A well-behaved client, so each test changes exactly one thing.
        const GOOD: (&str, &str, &str) = ("127.0.0.1:17631", "http://tauri.localhost", "Bearer secret");

        fn call(
            method: &str,
            url: &str,
            host: Option<&str>,
            origin: Option<&str>,
            auth: Option<&str>,
        ) -> Result<Decision, super::ApiError> {
            guard(method, url, host, origin, auth, &settings())
        }

        fn good(method: &str, url: &str) -> Result<Decision, super::ApiError> {
            let (h, o, a) = GOOD;
            call(method, url, Some(h), Some(o), Some(a))
        }

        #[test]
        fn a_correct_request_reaches_its_handler() {
            assert_eq!(good("GET", "/api/v1/health").unwrap(), Decision::Endpoint(Route::Health));
            assert_eq!(good("GET", "/api/v1/printers").unwrap(), Decision::Endpoint(Route::Printers));
            assert_eq!(good("POST", "/api/v1/print").unwrap(), Decision::Endpoint(Route::Print));
        }

        #[test]
        fn health_needs_no_token() {
            // So a monitor can check the API is up without holding a secret.
            let ok = call("GET", "/api/v1/health", Some("127.0.0.1:17631"), None, None).unwrap();
            assert_eq!(ok, Decision::Endpoint(Route::Health));
        }

        #[test]
        fn every_other_endpoint_needs_one() {
            for (method, path) in [("GET", "/api/v1/printers"), ("GET", "/api/v1/labels"), ("POST", "/api/v1/print"), ("POST", "/api/v1/print/pdf")] {
                let err = call(method, path, Some("127.0.0.1:17631"), None, None).unwrap_err();
                assert_eq!(err.status, 401, "{path} should need a token");
                let err = call(method, path, Some("127.0.0.1:17631"), None, Some("Bearer wrong")).unwrap_err();
                assert_eq!(err.status, 401, "{path} should reject a wrong token");
            }
        }

        #[test]
        fn a_host_that_is_not_ours_is_refused_before_the_token_is_even_read() {
            // A rebound name pointing at 127.0.0.1 is the attack this exists for.
            let err = call("GET", "/api/v1/printers", Some("evil.example.com:17631"), Some("https://evil.example.com"), None).unwrap_err();
            assert_eq!(err.status, 403);
            assert!(err.message.contains("127.0.0.1"), "should say who we answer to: {}", err.message);
        }

        #[test]
        fn a_missing_host_is_refused() {
            assert_eq!(call("GET", "/api/v1/health", None, None, None).unwrap_err().status, 403);
        }

        #[test]
        fn a_browsers_origin_is_checked_even_with_the_right_token() {
            // The token alone is not enough for a page: a page cannot read the token, but if one ever
            // leaks, a page on the wrong origin still must not be able to use it.
            let err = call("GET", "/api/v1/printers", Some("127.0.0.1:17631"), Some("https://news.example.com"), Some("Bearer secret")).unwrap_err();
            assert_eq!(err.status, 403);
        }

        #[test]
        fn a_script_with_no_origin_is_welcome_with_the_token() {
            // curl, a POS, a scheduled job: the intended callers.
            let ok = call("POST", "/api/v1/print", Some("127.0.0.1:17631"), None, Some("Bearer secret")).unwrap();
            assert_eq!(ok, Decision::Endpoint(Route::Print));
        }

        #[test]
        fn a_preflight_is_answered_without_a_token() {
            // Browsers never send Authorization on a preflight, so requiring one would break the
            // API tab and every browser-based integration.
            let ok = call("OPTIONS", "/api/v1/print", Some("127.0.0.1:17631"), Some("http://tauri.localhost"), None).unwrap();
            assert_eq!(ok, Decision::Preflight);
        }

        #[test]
        fn a_preflight_for_a_path_that_does_not_exist_is_still_a_404() {
            let err = call("OPTIONS", "/api/v1/nope", Some("127.0.0.1:17631"), None, None).unwrap_err();
            assert_eq!(err.status, 404);
        }

        #[test]
        fn an_unknown_path_is_404_and_the_right_path_with_the_wrong_verb_is_405() {
            assert_eq!(good("GET", "/api/v1/nope").unwrap_err().status, 404);
            assert_eq!(good("POST", "/api/v1/health").unwrap_err().status, 405);
        }

        #[test]
        fn the_check_is_on_the_configured_port() {
            // Moving the port has to move the Host that is accepted with it, or nothing works.
            let moved = ApiSettings { port: 20000, ..settings() };
            let err = guard("GET", "/api/v1/health", Some("127.0.0.1:17631"), None, None, &moved).unwrap_err();
            assert_eq!(err.status, 403);
            assert!(guard("GET", "/api/v1/health", Some("127.0.0.1:20000"), None, None, &moved).is_ok());
            assert_eq!(moved.port, 20000);
            let _ = DEFAULT_PORT;
        }
    }

    /// A real listener on a real port, driven with a real socket.
    ///
    /// The unit tests above check the decisions. This checks the plumbing they sit on: that
    /// tiny_http hands the headers over as written, that a status code survives to the wire, and
    /// that the CORS headers come back only for an origin we allow.
    mod over_a_socket {
        use super::{guard, ApiSettings};
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpStream;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::Duration;

        /// The settings the listener answers with. The port has to be the one actually bound, or
        /// the `Host` check rejects every request -- which is the check working, not the test
        /// passing for the wrong reason.
        fn settings(port: u16) -> ApiSettings {
            ApiSettings { port, token: "secret".into(), ..ApiSettings::default() }
        }

        /// A running listener, and the flag that stops it.
        struct Server_ {
            port: u16,
            stop: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<()>>,
        }

        impl Server_ {
            /// Waits for the loop to notice the flag and close, rather than leaving a test hanging
            /// on a listener that is still waiting for requests nobody is going to send.
            fn stop(mut self) {
                self.stop.store(true, Ordering::Relaxed);
                if let Some(t) = self.thread.take() {
                    t.join().unwrap();
                }
            }
        }

        fn start() -> Server_ {
            let server = tiny_http::Server::http(("127.0.0.1", 0)).unwrap();
            let port = server.server_addr().to_ip().unwrap().port();
            // Polled rather than blocked on, so the stop flag is actually seen.
            let stop = Arc::new(AtomicBool::new(false));
            let watched = stop.clone();
            let bound = port;
            let thread = std::thread::spawn(move || {
                while !watched.load(Ordering::Relaxed) {
                    let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(25)) else {
                        continue;
                    };
                    // Not mutated: the body is left unread, which is fine for a test that is about
                    // the headers and the status code.
                    let request = request;
                    let settings = settings(bound);
                    let decision = guard(
                        request.method().as_str(),
                        request.url(),
                        super::header(&request, "host").as_deref(),
                        super::header(&request, "origin").as_deref(),
                        super::header(&request, "authorization").as_deref(),
                        &settings,
                    );
                    let (status, body) = match decision {
                        Ok(_) => (200u16, "{}".to_string()),
                        Err(e) => (e.status, e.body()),
                    };
                    let mut response = tiny_http::Response::from_string(body).with_status_code(status);
                    super::add_cors(
                        &mut response,
                        super::header(&request, "origin"),
                        &settings.allowed_origins,
                    );
                    let _ = request.respond(response);
                }
            });
            Server_ { port, stop, thread: Some(thread) }
        }

        /// One request as raw HTTP, so the test controls every header exactly.
        fn raw(port: u16, method: &str, path: &str, extra: &str) -> String {
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{extra}\r\n")
        }

        /// Sends it and returns `(status, headers, body)`.
        ///
        /// The port is passed rather than read out of the request, because one of the tests sends a
        /// Host naming somebody else on purpose.
        fn send(port: u16, request: &str) -> (u16, String, String) {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            stream.flush().unwrap();
            // A socket that never answers must fail the test rather than hang it.
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut reader = BufReader::new(stream);

            let mut status_line = String::new();
            reader.read_line(&mut status_line).unwrap();
            let status: u16 = status_line.split_whitespace().nth(1).unwrap().parse().unwrap();

            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                headers.push_str(&line);
            }
            let mut body = String::new();
            reader.read_to_string(&mut body).unwrap();
            (status, headers, body)
        }

        #[test]
        fn a_request_reaches_the_server_and_the_status_comes_back() {
            let server = start();
            let (status, _, body) = send(server.port, &raw(server.port, "GET", "/api/v1/health", ""));
            assert_eq!(status, 200);
            assert_eq!(body, "{}");
            server.stop();
        }

        #[test]
        fn a_refused_request_says_why_in_the_documented_shape() {
            let server = start();
            // No token. The code and message survive JSON, the socket and the status line.
            let (status, _, body) = send(server.port, &raw(server.port, "GET", "/api/v1/printers", ""));
            assert_eq!(status, 401);
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["error"]["code"], "unauthorized");
            server.stop();
        }

        #[test]
        fn a_request_naming_someone_else_is_refused_on_a_real_connection() {
            // The rebind case cannot be shown any other way: the socket really is on 127.0.0.1, and
            // it is the Host header that has to say otherwise.
            let server = start();
            let (status, _, body) = send(
                server.port,
                &format!(
                    "GET /api/v1/health HTTP/1.1\r\nHost: evil.example.com:{}\r\nConnection: close\r\n\r\n",
                    server.port
                ),
            );
            assert_eq!(status, 403);
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["error"]["code"], "forbidden");
            server.stop();
        }

        #[test]
        fn the_right_token_over_a_real_socket_is_accepted() {
            let server = start();
            let (status, _, _) = send(server.port, &raw(server.port, "GET", "/api/v1/printers", "Authorization: Bearer secret\r\n"));
            assert_eq!(status, 200, "the token has to survive the trip through the headers");
            server.stop();
        }

        #[test]
        fn cors_headers_come_back_for_the_apps_own_origin_and_not_for_a_strangers() {
            let server = start();
            let (_, allowed, _) = send(server.port, &raw(server.port, "GET", "/api/v1/health", "Origin: http://tauri.localhost\r\n"));
            assert!(
                allowed.contains("Access-Control-Allow-Origin: http://tauri.localhost"),
                "the API tab has to be able to read its own replies: {allowed}"
            );

            let (status, refused, _) = send(server.port, &raw(server.port, "GET", "/api/v1/health", "Origin: https://news.example.com\r\n"));
            assert_eq!(status, 403);
            // A 403, and nothing telling that page it may read anything at all.
            assert!(!refused.contains("Access-Control-Allow-Origin"), "{refused}");
            server.stop();
        }
    }

    #[test]
    fn a_dry_run_pdf_comes_back_as_bytes_not_as_the_text_it_travelled_as() {
        // The bridge speaks JSON, so the PDF arrives base64. Sending that text back with a
        // `application/pdf` content type would hand the caller a file that opens to nothing, and
        // `dryRun` exists precisely so somebody can check a layout before spending paper on it.
        let pdf = b"%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n%%EOF\n";
        let encoded = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(pdf)
        };
        assert_eq!(decode_base64(&encoded).unwrap(), pdf.to_vec());
        // And it is not the base64 text.
        assert_ne!(decode_base64(&encoded).unwrap(), encoded.as_bytes().to_vec());
    }

    #[test]
    fn a_dry_run_pdf_that_is_not_base64_is_an_error_rather_than_a_corrupt_file() {
        // Printing a truncated or mangled PDF wastes paper and looks like a printer fault.
        let err = decode_base64("not base64 at all!!").unwrap_err();
        assert_eq!(err.status, 422);
    }

    #[test]
    fn the_reply_says_which_kind_of_thing_it_is() {
        // JSON and a PDF have to be told apart, or the content type lies about the bytes.
        assert_ne!(Reply::Json("{}".into()), Reply::Pdf(b"%PDF-".to_vec()));
    }

    #[test]
    fn the_base_url_is_the_one_the_plan_fixes() {
        assert_eq!(base_url(17631), "http://127.0.0.1:17631/api/v1");
    }
}