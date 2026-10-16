//! One outbound call: fetching the JSON a label's API data source describes.
//!
//! Kept free of Tauri types so it can be unit tested on its own; `lib.rs` wraps [`fetch`] in the
//! `fetch_json` command. The access token only ever lives in this module's stack frames: it is
//! put in one request header and appears in no error message.

use std::io::Read;
use std::time::Duration;
use url::Url;

/// Largest response accepted. A label's data is a handful of records, not a download.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: u8 = 3;
/// How much of an error response is quoted back to the person.
const ERROR_BODY_CHARS: usize = 200;

/// Validates the address before any connection is made.
fn check_url(raw: &str, has_token: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("Not a valid address: {e}"))?;
    match url.scheme() {
        "https" => {}
        "http" => {
            if has_token {
                return Err("Refusing to send an access token without HTTPS.".into());
            }
        }
        other => return Err(format!("Only http and https addresses are allowed (got \"{other}:\").")),
    }
    if url.host_str().map_or(true, str::is_empty) {
        return Err("The address has no host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put credentials in the access token, not in the address.".into());
    }
    Ok(url)
}

/// A redirect is followed only when it stays on the same scheme, host and port, so the token
/// can never be handed to another server.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// `HTTP 401 Unauthorized: <first part of the body>`, so the API's own explanation is visible.
fn status_message(code: u16, resp: ureq::Response) -> String {
    let text = resp.status_text().to_string();
    let mut body = Vec::new();
    // A failed read just means there is nothing to quote.
    let _ = resp.into_reader().take(2048).read_to_end(&mut body);
    let body = String::from_utf8_lossy(&body);
    let snippet: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(ERROR_BODY_CHARS).collect();
    if snippet.is_empty() {
        format!("HTTP {code} {text}")
    } else {
        format!("HTTP {code} {text}: {snippet}")
    }
}

fn read_body(resp: ureq::Response) -> Result<String, String> {
    let mut buf = Vec::new();
    // One byte past the limit tells "exactly at the limit" apart from "over it".
    resp.into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("The response could not be read: {e}"))?;
    if buf.len() as u64 > MAX_BYTES {
        return Err(format!("The response is larger than {} MB.", MAX_BYTES / 1024 / 1024));
    }
    String::from_utf8(buf).map_err(|_| "The response is not text.".to_string())
}

/// GETs `raw_url` and returns the response body. The caller parses the JSON.
pub fn fetch(raw_url: &str, bearer: Option<&str>) -> Result<String, String> {
    let bearer = bearer.map(str::trim).filter(|t| !t.is_empty());
    let mut url = check_url(raw_url, bearer.is_some())?;
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();

    for _ in 0..=MAX_REDIRECTS {
        let mut req = agent.get(url.as_str()).set("Accept", "application/json");
        if let Some(token) = bearer {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => return Err(status_message(code, r)),
            Err(ureq::Error::Transport(t)) => {
                return Err(format!("Could not reach {}: {t}", url.host_str().unwrap_or("the server")));
            }
        };
        if (300..400).contains(&resp.status()) {
            let location = resp
                .header("location")
                .ok_or_else(|| "The server redirected without saying where.".to_string())?;
            let next = url.join(location).map_err(|_| "The server sent an invalid redirect.".to_string())?;
            if !same_origin(&url, &next) {
                return Err("The server redirected to a different address, which is not followed.".into());
            }
            url = next;
            continue;
        }
        return read_body(resp);
    }
    Err("Too many redirects.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// Serves each canned response once, in order, and reports the raw request it got for each.
    fn serve(responses: Vec<String>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (base, rx)
    }

    fn ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn returns_the_body() {
        let (base, rx) = serve(vec![ok(r#"{"a":1}"#)]);
        assert_eq!(fetch(&format!("{base}/x"), None).unwrap(), r#"{"a":1}"#);
        let req = rx.recv().unwrap().to_lowercase();
        assert!(req.starts_with("get /x "));
        assert!(req.contains("accept: application/json"));
        assert!(!req.contains("authorization"));
    }

    #[test]
    fn treats_a_blank_token_as_no_token() {
        // A token is refused over plain http (tested below), so the header itself is only
        // observable over https; here a blank token must simply send no Authorization header.
        let (base, rx) = serve(vec![ok("{}")]);
        fetch(&format!("{base}/"), Some("   ")).unwrap();
        assert!(!rx.recv().unwrap().to_lowercase().contains("authorization"));
    }

    #[test]
    fn refuses_a_token_without_https() {
        let err = fetch("http://127.0.0.1:1/x", Some("secret")).unwrap_err();
        assert!(err.contains("without HTTPS"));
        assert!(!err.contains("secret"));
    }

    #[test]
    fn rejects_other_schemes_and_credentials_in_the_address() {
        assert!(fetch("file:///etc/passwd", None).unwrap_err().contains("Only http and https"));
        assert!(fetch("ftp://example.com/x", None).unwrap_err().contains("Only http and https"));
        assert!(fetch("https://user:pw@example.com/x", None).unwrap_err().contains("credentials"));
        assert!(fetch("not a url", None).unwrap_err().contains("Not a valid address"));
    }

    #[test]
    fn quotes_the_servers_explanation_for_an_error_status() {
        let body = r#"{"message":"Bad credentials"}"#;
        let resp = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (base, _rx) = serve(vec![resp]);
        let err = fetch(&format!("{base}/"), None).unwrap_err();
        assert!(err.starts_with("HTTP 401 Unauthorized"), "{err}");
        assert!(err.contains("Bad credentials"));
    }

    #[test]
    fn refuses_a_response_over_the_size_cap() {
        let big = "x".repeat(MAX_BYTES as usize + 10);
        let (base, _rx) = serve(vec![ok(&big)]);
        let err = fetch(&format!("{base}/"), None).unwrap_err();
        assert!(err.contains("larger than 5 MB"), "{err}");
    }

    #[test]
    fn follows_a_same_origin_redirect() {
        let redirect = "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let (base, rx) = serve(vec![redirect, ok(r#"{"ok":true}"#)]);
        assert_eq!(fetch(&format!("{base}/start"), None).unwrap(), r#"{"ok":true}"#);
        assert!(rx.recv().unwrap().starts_with("GET /start "));
        assert!(rx.recv().unwrap().starts_with("GET /final "));
    }

    #[test]
    fn refuses_a_redirect_to_another_host() {
        let redirect =
            "HTTP/1.1 302 Found\r\nLocation: http://example.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let (base, _rx) = serve(vec![redirect]);
        let err = fetch(&format!("{base}/"), None).unwrap_err();
        assert!(err.contains("different address"), "{err}");
    }

    #[test]
    fn stops_a_redirect_loop() {
        let redirect = "HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let (base, _rx) = serve(vec![redirect; (MAX_REDIRECTS as usize) + 1]);
        assert!(fetch(&format!("{base}/"), None).unwrap_err().contains("Too many redirects"));
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(same_origin(&u("https://a.com/x"), &u("https://a.com/y?z=1")));
        assert!(same_origin(&u("https://a.com/x"), &u("https://a.com:443/y")));
        assert!(!same_origin(&u("https://a.com/x"), &u("http://a.com/x")));
        assert!(!same_origin(&u("https://a.com/x"), &u("https://b.com/x")));
        assert!(!same_origin(&u("https://a.com/x"), &u("https://a.com:8443/x")));
    }
}
