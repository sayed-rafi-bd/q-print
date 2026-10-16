# Plan: Print API, API test page, MSI-only Windows build

Repo: `sayed-rafi-bd/q-print` (v1.4.0, Tauri 2 + React 18 + Rust). Target platform for this work: **Windows**.

## 1. Goal

While Q-Print is running, any program on the same PC (a POS, an ERP, a script, `curl`) can print through a local HTTP API instead of someone clicking in the React UI. A new **API** tab lets a person try every endpoint from inside the app. The Windows release is an **MSI only**.

## 2. What the code does today (findings that shape the design)

| Finding | Where | Consequence |
|---|---|---|
| Rust only prints a **finished PDF**: `print_pdf(opts, bytes)` shells out to SumatraPDF (`-print-to <printer> -silent`) | `lib.rs`, `print_windows.rs` | A "print this PDF" endpoint can be pure Rust. |
| Labels, rules and PDF generation live in the **webview**: labels come from Turso via JS (`labels.ts`), rows come from `generator/engine.ts`, the PDF comes from pdfme (`printApi.ts`) | `printApi.ts`, `labels.ts` | A "print this label" endpoint needs a **bridge** from Rust to the webview. Re-implementing pdfme in Rust is not realistic. |
| Labels are **per signed-in account**; the session is a user id in `localStorage` | `AuthProvider.tsx` | The API prints as *whoever is signed in right now*. If nobody is, it must say so. |
| Closing the window **hides it to the tray**; the app keeps running | `tray.rs` | The webview must keep working while hidden. This is the main technical risk (see section 9). |
| DPI changes back up and restore the printer's **print ticket** via PowerShell | `print_windows.rs` | Two concurrent jobs would corrupt each other. Printing must be **serialized** with one lock shared by the UI and the API. |
| `http.rs` is an **outbound** client (label data sources) | `http.rs` | No server exists. The new one goes in a new module, `api_server.rs`, so the two are not confused. |
| Windows targets are `["nsis", "msi"]`; NSIS is also wired into the release script and workflow comments | `tauri.windows.conf.json`, `collect-releases.mjs`, `release.yml` | MSI-only is a small config + script + docs change. |
| E2E tests run the app as a plain web page with no Rust | `e2e/`, `playwright.config.ts` | The API cannot be covered by Playwright. It needs Rust tests plus a manual Windows checklist. |

## 3. Architecture

```
 external client (curl / POS / script)
        │  HTTP, 127.0.0.1:<port>, Bearer token
        ▼
 ┌─────────────────────────── Rust (Tauri process) ───────────────────────────┐
 │ api_server.rs  (tiny_http, worker threads)                                 │
 │   auth + origin/host checks → router → handlers                            │
 │                                                                            │
 │  /print/pdf ───────────────► run_print()  ──► [print lock] ──► SumatraPDF  │
 │  /printers  ───────────────► platform::list_printers()                     │
 │  /print, /labels ──► bridge ─┐                                             │
 └──────────────────────────────┼─────────────────────────────────────────────┘
                   emit "api-request" │ ▲ invoke "api_bridge_reply"
                                      ▼ │
 ┌──────────────────────── webview (React) ───────────────────────────────────┐
 │ ApiBridge (mounted once at app level, works on any tab)                    │
 │   loadLabel → buildRows → pdfme → postProcess → print_pdf  (existing code) │
 │   recordAttempt(... source: "api")                                         │
 └────────────────────────────────────────────────────────────────────────────┘
```

**Two ways to print, one API:**

1. **PDF mode**: the caller sends a PDF. Pure Rust, no sign-in needed, works even if the webview is asleep.
2. **Label mode**: the caller names a saved label and supplies data. Rust asks the webview to render and print using the code the UI already uses, so the API and the UI can never produce different output.

**Server library:** `tiny_http` (small, synchronous, matches the existing `ureq` + `spawn_blocking` style, no new async runtime). `axum` is the alternative if we later want streaming or WebSockets. The server module is `#[cfg(desktop)]`, so the Android build is untouched.

## 4. API specification (v1)

Base URL: `http://127.0.0.1:17631/api/v1` (port configurable; see section 6).
Every endpoint except `/health` needs `Authorization: Bearer <token>`.
Errors always look like `{ "error": { "code": "...", "message": "..." } }`.

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /health` | Is it up? Version, platform, whether a user is signed in | No auth. Returns nothing sensitive. |
| `GET /printers` | Installed printers | From `list_printers()`. |
| `GET /labels` | Labels of the signed-in account (`id`, `name`, size in mm) | Via bridge. `409` if nobody is signed in. |
| `POST /print` | **Label mode.** Render a label and print it | JSON body below. Via bridge. |
| `POST /print/pdf` | **PDF mode.** Print a PDF the caller made | `Content-Type: application/pdf`, body is the PDF. Options as query params: `printer` (required), `paper`, `orientation`, `dpi`. Checks the `%PDF-` header. |

### `POST /print` body

```jsonc
{
  "label": "product",              // required: label id from GET /labels
  "printer": "Zebra ZD421",        // required
  "pages": 3,                      // copies / number of generated pages (1–10,000)
  "rows": [                        // optional: explicit data, one object per page
    { "name": "Tea 500g", "barcode": "4901234567894" }
  ],
  "api": { "url": "...", "listPath": "data", "bearerAuth": true,
           "values": {}, "token": "..." },   // optional: label's own data source
  "paper": "A6", "orientation": "auto",      // optional, same meaning as the UI
  "rotate": 0, "margins": {"top":0,"right":0,"bottom":0,"left":0},
  "dpi": "300x300",
  "dryRun": false                  // true → returns the PDF (application/pdf), prints nothing
}
```

Data precedence: `rows` (used as given, one page each, times `pages` only if `rows` has one entry) → `api` (label's data source) → the label's own generator rules. `rows` is what most integrations will use; keys are the label's field names.

### Success response (print)

```json
{ "jobId": "a1b2c3", "status": "printed", "label": "product", "printer": "Zebra ZD421",
  "pages": 3, "records": null, "transport": "sumatra", "ms": 1840,
  "report": { "paperApplied": true, "dpiApplied": false, "dpiNote": "..." } }
```

### Status codes

| Code | When |
|---|---|
| 200 | Printed (or PDF returned for `dryRun`) |
| 400 | Bad JSON, missing `printer`/`label`, not a PDF, `pages` out of range |
| 401 / 403 | Missing or wrong token / disallowed `Origin` or `Host` |
| 404 | Unknown path or unknown label |
| 409 | Label mode while nobody is signed in |
| 413 | Body too large (PDF 64 MB, JSON 5 MB) |
| 422 | Label rules invalid (bad barcode value, label needs an API address, margins too large) |
| 500 | Printer or SumatraPDF failure (message passed through) |
| 504 | Webview did not answer in time (default 5 min) |

v1 is **synchronous**: the request returns when the job has been handed to the printer. Long jobs are covered by the timeout. Async jobs (`202` + `GET /jobs/{id}`) are listed as a later option, not v1.

## 5. Security

The API can spend paper and ink, and it is reachable by every web page the user opens, so the defaults are strict.

- **Binds to `127.0.0.1` only.** Not reachable from the network by default. This also avoids the Windows Firewall prompt.
- **Bearer token required**, 32 random bytes, generated on first run, compared in constant time. Shown on the test page; can be regenerated (old one stops working immediately).
- **Browser protection (CSRF / DNS rebinding):** reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. If an `Origin` header is present, it must be in the allow-list: the app's own origins (`http://tauri.localhost`, `http://localhost:1420` in dev) plus origins the user adds in settings. Requests with no `Origin` (curl, servers) are fine with a valid token. CORS preflight (`OPTIONS`) is answered only for allowed origins.
- **Limits:** body size caps above, max 10,000 pages (same as the UI), one print job at a time, a short queue, then `429`.
- **Secrets stay out of logs and errors**, as `http.rs` already does for data-source tokens. The request log on the test page stores method, path, status and timing, never the token or bodies.
- **Off switch:** the API can be disabled in settings; the server then does not listen at all.
- **Optional, off by default:** "allow other PCs" (bind `0.0.0.0`). Not in v1 unless requested; it needs a firewall rule and TLS thinking.

## 6. Settings

Stored as `api.json` next to `printers.json` in the app data dir: `{ enabled, port, token, allowedOrigins }`.
Defaults: enabled = **true**, port **17631**, token generated on first start. If the port is taken, the server does not crash the app; the test page shows "Port 17631 is in use, choose another" and the status is reported by `GET /health` semantics via a Tauri command. Changing port/enabled restarts the listener without restarting the app.

## 7. Test page (new "🔌 API" tab)

Added to `App.tsx` next to Print / Designer / History / Guide; shown only where printing exists (not in the web build). New files under `src/api/`.

**Sections**

1. **Status & access**: running / stopped / port in use, base URL with copy button, token (masked, reveal + copy, regenerate), enable switch, port field, allowed origins list.
2. **Try it**: pick an endpoint, fill a form, press **Send**:
   - `/printers`, `/labels`: no input, prefilled from the real data.
   - `/print`: label dropdown, printer dropdown, pages, JSON editor for `rows` (prefilled from the label's field names), the optional print options, a **Dry run** toggle that shows the PDF in the page so the endpoint can be tried without wasting paper.
   - `/print/pdf`: choose a PDF file, printer, options.
3. **Result**: HTTP status, headers of interest, pretty JSON, timing; PDF preview for dry runs.
4. **Copy as code**: the exact request as `curl`, PowerShell (`Invoke-RestMethod`), and JavaScript `fetch`, with a placeholder instead of the real token unless "include token" is ticked.
5. **Recent API calls**: last 50 calls from outside the app (time, endpoint, status, ms), via a small event from Rust.

**Why the Send button uses real HTTP (`fetch` to the local server) rather than `invoke`:** it exercises the whole path an outside client uses (token, origin checks, routing), so "works on the test page" means "works for integrators". This is why the app's own origins are on the allow-list.

## 8. Windows: MSI only

| Change | File |
|---|---|
| `"targets": ["msi"]` (drop `nsis`) | `src-tauri/tauri.windows.conf.json` |
| `build:windows` → `tauri build --bundles msi && node scripts/collect-releases.mjs windows` (belt and braces with the config) | `package.json` |
| Collect only `bundle/msi/*.msi` for Windows; update the header comment | `scripts/collect-releases.mjs` |
| Keep signing as is; the verify step already handles `*.msi`. Remove the `*.exe` installer assumption and NSIS wording; keep the "installed q-print.exe inside the MSI" check | `.github/workflows/release.yml` |
| Replace NSIS wording and filenames in the Windows install/build/release sections | `SETUP.md`, `RELEASE.md`, `README.md` |

Things to know:
- Existing users installed from the **NSIS** installer will get a **second, separate install** when they run the MSI. Release notes should say: uninstall the old one first. (Same `identifier` is kept so MSI-to-MSI upgrades work.)
- MSI requires a numeric version (`1.4.0` is fine). `bump-version.mjs` must not produce pre-release tags like `1.5.0-beta` for Windows builds; add a guard.
- The MSI is only buildable on Windows (WiX). CI already uses `windows-latest`.
- Linux and Android build commands are unchanged.

## 9. Risks

1. **Hidden window and the webview (highest risk).** Label mode depends on the webview running while the window is hidden in the tray. WebView2 normally keeps running, but timers can be throttled and the behavior must be proven, not assumed. **Phase 0 is a spike for exactly this.** Fallbacks, in order: keep the window "shown but minimized"; create an off-screen window; or return `503` with a clear message and recommend PDF mode.
2. **Nobody signed in** after a restart: the app restores the session from `localStorage`, but only after the database is reachable. The bridge reports readiness; label mode returns `409` rather than hanging.
3. **Concurrent UI + API printing:** solved by one print lock inside `run_print`, shared by both.
4. **Port conflicts / security software** blocking local listeners: surfaced on the test page, never fatal.
5. **Cannot fully test Windows printing here.** I can compile and unit test the server and routing logic on Linux, and run frontend tests, but the MSI, SumatraPDF printing and tray/webview behavior must be verified on a real Windows machine (checklist in section 11).

## 10. Work breakdown

**Phase 0: Spike (small)**
- Start a `tiny_http` listener from `setup`, emit an event to the hidden webview, get a reply through `invoke`. Prove the round trip works with the window hidden. Decide the fallback if not.

**Phase 1: Server core and PDF mode**
- `src-tauri/src/api_server.rs`: listener lifecycle, router, auth, Host/Origin checks, error format, limits, CORS.
- `api_settings.rs`: load/save `api.json`, token generation (`getrandom`), restart on change.
- Endpoints: `/health`, `/printers`, `/print/pdf`.
- Print lock in `run_print` (benefits the UI path too).
- Tauri commands: `api_get_settings`, `api_set_settings`, `api_regenerate_token`, `api_status`.
- Rust unit tests: routing, auth, origin/host matrix, body limits, error shapes; an integration test on an ephemeral port.

**Phase 2: Label mode and the bridge**
- Rust: pending-request map (`id → oneshot`), `api_bridge_ready(user)`, `api_bridge_reply(id, result)`, timeout, `/labels` and `/print`.
- Frontend refactor of `printApi.ts`: split `printLabels` into `renderLabelPdf()` (rows + pdfme + post-process) and `sendToPrinter()`. The UI path calls both, behavior unchanged; the API path can also stop after the first (dry run).
- `src/api/ApiBridge.tsx`: mounted in `App.tsx` for signed-in users, listens for `api-request`, calls the refactored functions, replies, and records history with `source: "api"` (optional new field on `PrintAttempt`, backward compatible with stored history; the History page shows a small "API" badge).
- Validation of `rows` keys against the label's schema field names, with a clear `422`.

**Phase 3: Test page**
- `src/api/ApiPage.tsx` plus small components: status card, request builder, result viewer, snippet generator (pure function, unit tested), recent calls list.
- Tab added to `App.tsx`; Guide page gets a short "Using the API" section.

**Phase 4: MSI-only packaging and docs**
- Section 8 changes. `SETUP.md` gets an API reference (the spec from section 4, examples in curl / PowerShell / Python / Node).

**Phase 5: Verification**
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test` (where the platform allows), then the Windows checklist.

## 11. Test plan

**Automated**
- Rust: auth accept/reject, wrong/missing token, bad `Host`, disallowed `Origin`, preflight, 404/405, oversize body, non-PDF body, bridge timeout, `409` when signed out, print lock serializes two jobs.
- Frontend (vitest, `invoke`/`fetch` mocked, same style as the existing tests): snippet generator, request builder validation, `renderLabelPdf` / `sendToPrinter` split keeps the UI output identical, bridge handler maps errors to the right codes, history entry has `source: "api"`.

**Manual on Windows (release gate)**
1. Install the MSI on a clean PC; confirm no NSIS `.exe` is produced anywhere.
2. Start the app, close the window to the tray; `curl /health` still answers.
3. `GET /printers` matches the printers in the UI.
4. `POST /print/pdf` prints a sample PDF silently.
5. Signed in, window hidden: `POST /print` with `rows` prints the right label; `dryRun` returns a valid PDF.
6. Signed out: `POST /print` returns `409`.
7. Fire a UI print and an API print at once: both complete, neither corrupts the other (try with a DPI setting).
8. A web page on another origin cannot call the API (browser console shows the CORS/`403` block); `curl` with a wrong token gets `401`.
9. Change port and regenerate token from the test page; old values stop working.
10. MSI-to-MSI upgrade from the previous version works; signed installer verifies in CI.

## 12. Decisions I assumed (please confirm or change)

1. **API prints as the currently signed-in account** (labels are per account). No separate API user system.
2. **Windows (and desktop) only**; Android does not host the API.
3. **Localhost only** in v1, token required, enabled by default.
4. **Synchronous** responses in v1.
5. **Default port 17631**, configurable.
6. **No auto-start with Windows.** You said "while this app is running", so the user starts the app. Auto-start is an easy add-on later.
7. `printer` is **required** on every print request (no hidden default).
8. "MSI only" means the **Windows** bundle only; Linux and Android outputs are left as they are.

## 13. Files expected to change or be added

```
src-tauri/Cargo.toml                    + tiny_http, getrandom (desktop only)
src-tauri/src/api_server.rs             new
src-tauri/src/api_settings.rs           new
src-tauri/src/lib.rs                    start server, register commands, print lock
src-tauri/tauri.windows.conf.json       targets → ["msi"]
src/printApi.ts                         split render / send
src/api/ApiBridge.tsx                   new
src/api/ApiPage.tsx (+ components)      new
src/api/snippets.ts (+ test)            new
src/printHistory.ts, PrintHistoryPage   optional `source` field + badge
src/App.tsx, src/GuidePage.tsx          new tab, guide section
package.json, scripts/collect-releases.mjs, scripts/bump-version.mjs
.github/workflows/release.yml
SETUP.md, RELEASE.md, README.md
```
