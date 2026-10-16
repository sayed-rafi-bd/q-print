//! The print API's settings: `api.json` beside `printers.json` in the app data dir.
//!
//! Kept apart from `api_server.rs` so the settings can be read and tested on any platform, including
//! Android, where no server exists. The file is plain JSON on purpose: it is the one thing a user
//! might need to inspect or hand-edit, and it holds no secret that is not already shown in the app.
//!
//! The token lives here, so this file *does* hold a secret. It is never logged and never returned in
//! an error, and it is only ever written back with the same value it was read with unless the user
//! asked for a new one.

use serde::{Deserialize, Serialize};

/// The port the plan fixes as the default. Not 80 or 8080, so a clash with something else already on
/// the machine is unlikely and the firewall rule (if anyone ever makes one) is obvious.
pub const DEFAULT_PORT: u16 = 17631;

/// How many random bytes the token is made from. 32 bytes = 64 hex characters, which is far more
/// than anything needs to guess; the length is not the security property, the secrecy is.
const TOKEN_BYTES: usize = 32;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiSettings {
    /// When false the server does not listen at all, rather than listening and refusing everything.
    pub enabled: bool,
    pub port: u16,
    /// Hex, generated on first run.
    pub token: String,
    /// Extra origins allowed to call the API from a browser, on top of the app's own.
    pub allowed_origins: Vec<String>,
}

impl Default for ApiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_PORT,
            token: new_token(),
            allowed_origins: Vec::new(),
        }
    }
}

/// 32 random bytes as hex.
pub fn new_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    // Falling back rather than panicking: a token made of zeroes would be worse than useless, so
    // this cannot be allowed to reach a running server. Failing loudly is the safer of the two
    // behaviours, and the caller turns this into "the API did not start".
    if getrandom::fill(&mut bytes).is_err() {
        eprintln!("[api] the system random source failed; not starting the print API");
        return String::new();
    }
    let mut out = String::with_capacity(TOKEN_BYTES * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

/// Reads `api.json`, writing a fresh one with a generated token if it is missing.
///
/// A file that cannot be parsed is *not* silently replaced: that would throw away a token the user
/// has already given to an integration, and the app would start handing out a different one without
/// saying so. The error is reported instead.
pub fn load(path: &std::path::Path) -> Result<ApiSettings, String> {
    if !path.exists() {
        let fresh = ApiSettings::default();
        save(path, &fresh)?;
        return Ok(fresh);
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("Could not read the API settings: {e}"))?;
    let mut settings: ApiSettings = serde_json::from_str(&text)
        .map_err(|e| format!("The API settings file is not readable ({e}). Fix or delete it and restart."))?;

    // A file written by hand, or by an older version, can be missing the token. Generating one keeps
    // the API usable; the alternative is an API that is on but can never be called.
    if settings.token.trim().is_empty() {
        settings.token = new_token();
        save(path, &settings)?;
    }
    Ok(settings)
}

pub fn save(path: &std::path::Path, settings: &ApiSettings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the settings folder: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Could not save the API settings: {e}"))
}

/// Checks the shape of what came in from the UI, before it is written.
///
/// Returns the cleaned settings rather than a bool so the caller cannot save something invalid that
/// passed a check elsewhere.
pub fn validate(candidate: ApiSettings) -> Result<ApiSettings, String> {
    // Port 0 would bind to a random port nobody could then find; 1024 and below need privileges on
    // Linux and are likely to be taken anyway.
    if !(1024..=65535).contains(&candidate.port) {
        return Err("The port must be between 1024 and 65535.".to_string());
    }
    if candidate.token.trim().is_empty() {
        return Err("The token cannot be empty.".to_string());
    }
    let mut settings = candidate;
    settings.token = settings.token.trim().to_string();
    // Origins are compared as exact strings, so trailing slashes would silently never match.
    settings.allowed_origins = settings
        .allowed_origins
        .iter()
        .map(|o| o.trim().trim_end_matches('/').to_string())
        .filter(|o| !o.is_empty())
        .collect();
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::{validate, ApiSettings, DEFAULT_PORT};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("q-print-api-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn a_new_token_is_long_hex_and_different_every_time() {
        let a = super::new_token();
        let b = super::new_token();
        assert_eq!(a.len(), 64, "expected 32 bytes as hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens must not be the same value");
    }

    #[test]
    fn defaults_are_on_with_the_planned_port() {
        let s = ApiSettings::default();
        assert!(s.enabled, "the plan has the API on by default");
        assert_eq!(s.port, DEFAULT_PORT);
        assert_eq!(s.token.len(), 64);
        assert!(s.allowed_origins.is_empty());
    }

    #[test]
    fn a_missing_file_is_created_with_a_token() {
        let path = temp_path("missing");
        let settings = super::load(&path).expect("should create it");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert!(path.exists(), "the file should now exist");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reading_twice_gives_the_same_token() {
        // Otherwise every launch would invalidate every integration that had the token.
        let path = temp_path("stable");
        let first = super::load(&path).unwrap().token;
        let second = super::load(&path).unwrap().token;
        assert_eq!(first, second);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_damaged_file_is_reported_rather_than_replaced() {
        // Silently replacing it would hand out a different token without telling anybody.
        let path = temp_path("damaged");
        std::fs::write(&path, "{not json").unwrap();
        let err = super::load(&path).unwrap_err();
        assert!(err.contains("not readable"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json", "the file must be left alone");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_without_a_token_gets_one() {
        let path = temp_path("notoken");
        std::fs::write(&path, r#"{"enabled":true,"port":9000}"#).unwrap();
        let settings = super::load(&path).unwrap();
        assert_eq!(settings.token.len(), 64);
        assert_eq!(settings.port, 9000);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_port_has_to_be_a_usable_one() {
        let base = ApiSettings::default();
        // 65536 is not tested: it does not fit a u16, so the type rules it out before validate
        // ever sees it. The check below is about the ports the type *can* hold.
        for bad in [0, 80, 1023] {
            let err = validate(ApiSettings { port: bad, ..base.clone() }).unwrap_err();
            assert!(err.contains("1024"), "port {bad} should be refused, got: {err}");
        }
        assert!(validate(ApiSettings { port: 1024, ..base.clone() }).is_ok());
        assert!(validate(ApiSettings { port: 65535, ..base.clone() }).is_ok());
    }

    #[test]
    fn an_empty_token_is_refused() {
        let base = ApiSettings::default();
        assert!(validate(ApiSettings { token: String::new(), ..base }).is_err());
    }

    #[test]
    fn origins_are_trimmed_because_they_are_compared_exactly() {
        // A trailing slash that survived would silently never match a real Origin header.
        let base = ApiSettings::default();
        let out = validate(ApiSettings {
            allowed_origins: vec!["http://localhost:3000/".into(), "  ".into(), "https://a.b".into()],
            ..base
        })
        .unwrap();
        assert_eq!(out.allowed_origins, vec!["http://localhost:3000", "https://a.b"]);
    }

    #[test]
    fn the_token_is_trimmed_so_a_pasted_space_cannot_break_auth() {
        let base = ApiSettings::default();
        let out = validate(ApiSettings { token: "  abc123  ".into(), ..base }).unwrap();
        assert_eq!(out.token, "abc123");
    }
}