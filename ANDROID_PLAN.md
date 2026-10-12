# Android support plan — Tauri silent printing test app

Status: proposal · Applies to: `print-test` (Tauri v2, React, pdfme, Windows-only printing today)

## 1. Goal and scope

Run the same app on Android: generate random label data, build the multi-page pdfme PDF from the saved template, and print it to a real printer.

**In scope**
- Android build of the existing app (Print tab, Designer tab, template storage).
- One print path that works for the printer you actually have (decided in Phase 0).
- Capability-driven UI: options that don't apply on Android are hidden, not broken.

**Out of scope (for now)**
- iOS.
- Raw ZPL/TSPL template authoring (only relevant if Phase 0 picks a vendor SDK that needs it).
- Silent printing through the system print dialog (Android does not allow it on normal devices).

## 2. Where we are today

| Layer | State | Android impact |
|---|---|---|
| Frontend (React, pdfme generator/ui, Tailwind) | Platform-neutral | Runs in the Android WebView as is |
| Template + font (`label.json`, `public/fonts`) | Bundled with frontend / app data dir | Works as is |
| Rust: `generate_random_data`, template commands | Pure Rust + `app_data_dir` | Works as is |
| Rust: `print_pdf`, `printer_resolutions` | SumatraPDF + PowerShell, uses `std::os::windows` | **Does not compile on Android** |
| Rust: `list_printers` | `printers` crate | **No Android support** |
| `tauri.conf.json` | `externalBin` (SumatraPDF) and `nsis`/`msi` targets live in the main config | **Would break an Android build** |

So the work is: isolate the Windows code, add an Android print backend behind the same command names, and make the UI adapt.

## 3. Phase 0 — Pick the print transport (decision gate)

Android has three realistic ways to print. The printer you have decides which one.

| Option | Silent? | Printer needs | Notes |
|---|---|---|---|
| **A. System print service** (`PrintManager`) | No — always shows the system print dialog | Any printer with an Android print service (Mopria, vendor plugin) | Smallest effort. Good as a first working path and as a fallback. |
| **B. Direct IPP** from Rust | Yes | Wi-Fi/Ethernet printer with IPP Everywhere / AirPrint that accepts PDF | One code path for all such printers. Supports `media`, `print-scaling`, `orientation-requested` and `printer-resolution`, so it matches the Windows options. |
| **C. Vendor SDK** (Zebra, Brother, TSC, …) | Yes | Label printer with an Android SDK (Bluetooth / USB / Wi-Fi) | Usually needs a bitmap or ZPL/TSPL, not PDF. Render pages with `PdfRenderer` at the chosen DPI. |

**Questions to answer before Phase 3**
1. Printer model and connection (Wi-Fi, Bluetooth, USB)?
2. Must printing be silent, or is the system dialog acceptable?
3. Phone or tablet? (Affects whether the Designer tab is usable.)
4. Does the printer accept PDF over IPP? Check with `ipptool -tv ipp://<ip>/ipp/print get-printer-attributes.test` and look at `document-format-supported`.

**Recommended order:** build A first (works with almost any printer, proves the Android build), then add B or C only if silent printing is required.

## 4. Phase 1 — Make the repo cross-platform safe (desktop still works)

Goal: `cargo check` passes for Windows **and** Android, with Windows behaviour unchanged.

### 4.1 Rust
- Gate Windows-only code with `#[cfg(target_os = "windows")]`: `print_pdf`, `printer_resolutions`, the `PS_*` constants, `run_ps`, `SUMATRA_PAPERS`, `CREATE_NO_WINDOW`.
- Move the `printers` crate to a Windows-only dependency:

```toml
[target.'cfg(windows)'.dependencies]
printers = "2"
```

- Add a stub backend for non-Windows so the command names stay identical (Android implementations arrive in Phase 3):

```rust
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn print_pdf(/* same signature */) -> Result<PrintReport, String> {
    Err("printing is not implemented on this platform yet".into())
}
```

- Add a capabilities command the UI can use instead of guessing the OS:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    platform: &'static str,   // "windows" | "android"
    silent: bool,             // prints without a dialog
    paper_select: bool,       // SumatraPDF named sizes / IPP media
    orientation_select: bool,
    dpi_select: bool,
    printer_list: bool,       // false => show the "Add printer" UI
}

#[tauri::command]
fn capabilities() -> Capabilities { /* cfg!(target_os = "...") */ }
```

### 4.2 Config split
- Move `bundle.externalBin` and `bundle.targets: ["nsis","msi"]` out of `src-tauri/tauri.conf.json` into `src-tauri/tauri.windows.conf.json` (Tauri merges it on Windows builds only).
- Add `src-tauri/tauri.android.conf.json` for Android-only overrides if needed.
- Window size/min size in the main config are ignored on mobile; no change needed.

### 4.3 Frontend
- Add `src/capabilities.ts` that calls `capabilities` once and exposes it via a small React context.
- `PrintPage`: hide Paper, Orientation and Print resolution fields when the matching capability is `false`; keep **Rotate label content** and **Number of pages** everywhere (rotation is done inside the PDF, so it is platform independent).
- Show an "Add printer" section instead of the dropdown when `printerList` is `false` (used by option B).

**Exit criteria:** Windows app behaves exactly as today; `cargo check --target aarch64-linux-android` succeeds.

## 5. Phase 2 — Android toolchain and first run

1. Install Android Studio, SDK Platform + Build-Tools, **NDK**, and a JDK 17.
2. Set `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`.
3. Add the Rust targets:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

4. Initialise and run:

```powershell
pnpm tauri android init
pnpm tauri android dev
```

5. Fix first-run issues:
   - **Layout:** the app shell uses `h-screen` and an absolute-positioned two-page container. Check it with the Android status/navigation bars; switch to `h-dvh` if the bottom is clipped.
   - **Designer:** pdfme's Designer is built for a large pointer-driven screen. On a phone, either hide the tab (`platform === "android" && width < 768`) or accept it as tablet-only.
   - **Font:** `public/fonts/NotoSansJP-Regular.ttf` is bundled in the APK (adds a few MB); confirm `fetch('/fonts/...')` resolves under Android's asset protocol.
6. Generated `src-tauri/gen/android` is a Gradle project; commit it so the Kotlin plugin code in Phase 3 lives alongside it.

**Exit criteria:** app launches on a device/emulator, lists "no printers", generates a PDF without errors.

## 6. Phase 3 — Android print backend

Keep the command names and shapes used by the frontend: `list_printers`, `print_pdf(printer, paper, orientation, dpi, bytes)`, `printer_resolutions(printer)`. The Android implementations ignore options the transport can't honour and say so in `PrintReport` (the existing report fields already support this).

### 6A. System print service (`PrintManager`) — first backend

Flow: Rust writes the PDF to the app cache dir → calls a Kotlin Tauri plugin → Kotlin shows the system print preview → the user picks a printer and taps Print.

Plugin layout (verify against the current Tauri v2 mobile-plugin docs before copying):

```
src-tauri/plugins/android-print/
  Cargo.toml
  src/lib.rs                  # registers the Android plugin, exposes print_pdf_file()
  android/src/main/java/.../PrintPlugin.kt
```

Kotlin sketch:

```kotlin
@TauriPlugin
class PrintPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun printPdf(invoke: Invoke) {
    val args = invoke.parseArgs(PrintArgs::class.java)   // path, jobName, widthMm, heightMm
    activity.runOnUiThread {
      val pm = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
      val size = PrintAttributes.MediaSize(
        "custom", "Label",
        (args.widthMm / 25.4 * 1000).toInt(),   // mils (1/1000 inch)
        (args.heightMm / 25.4 * 1000).toInt()
      )
      val attrs = PrintAttributes.Builder().setMediaSize(size).build()
      pm.print(args.jobName, PdfFileAdapter(File(args.path)), attrs)
      invoke.resolve()
    }
  }
}
```

- `PdfFileAdapter` is a `PrintDocumentAdapter` that streams the cached PDF to the destination in `onWrite`.
- The custom `MediaSize` is only a request; the print service may offer its own sizes.
- `list_printers` on this backend returns a single virtual entry, `"System print dialog"`.
- Orientation, DPI and paper are chosen in the system dialog, so the capabilities for those are `false`.

**Exit criteria:** from the app, print 3 pages to "Save as PDF" in the system dialog; the PDF has three different labels at 110 × 86 mm.

### 6B. Direct IPP (silent, Wi-Fi/Ethernet printers)

Add only if Phase 0 shows the printer accepts PDF over IPP.

- **Printer list:** manual "Add printer" (name + `ipp://host:631/ipp/print`) stored in the app data dir, with a **Test connection** button that runs Get-Printer-Attributes. mDNS discovery (`_ipp._tcp`) is a later step: it needs `CHANGE_WIFI_MULTICAST_STATE` and usually a `MulticastLock` held from Kotlin.
- **Print:** Rust sends a Print-Job with `document-format=application/pdf`, using the `ipp` crate (check its current API; the call is roughly `IppOperationBuilder::print_job(uri, payload)`).
- **Job attributes mapped from the UI:**

| UI option | IPP attribute |
|---|---|
| Fit to paper | `print-scaling = fit` |
| Paper | `media` (e.g. `iso_a4_210x297mm`, custom `custom_110x86mm_110x86mm` if supported) |
| Orientation | `orientation-requested` (3 portrait, 4 landscape) |
| Print resolution | `printer-resolution` (offered from `printer-resolution-supported`) |
| Copies | `copies` |

- `printer_resolutions` reads `printer-resolution-supported`, so the DPI dropdown works on Android too.
- Native Rust sockets are not subject to Android's cleartext-HTTP policy for the WebView, but test on a real device; if you proxy through the WebView instead, `usesCleartextTraffic` would be required.
- If the printer rejects PDF, fall back to `image/pwg-raster` or `image/urf`, which means rendering pages to raster in Rust or via `PdfRenderer` (extra work; decide in Phase 0).

**Exit criteria:** silent print of 5 pages to the real printer and to a test IPP printer; the result panel shows the media/resolution that was sent.

### 6C. Vendor SDK (silent, Bluetooth/USB label printers)

Add only if Phase 0 picks it.

1. Wrap the SDK in a Kotlin plugin: `listPrinters()`, `connect()`, `printBitmap()`.
2. Render each PDF page with `android.graphics.pdf.PdfRenderer` into a `Bitmap` of `mm / 25.4 × dpi` pixels. This is where the frontend DPI setting is honoured exactly (`dpi` is passed to the plugin).
3. Convert to the format the SDK wants (bitmap as is, or ZPL/TSPL graphics commands) and send.
4. Permissions: `BLUETOOTH_CONNECT` and `BLUETOOTH_SCAN` on Android 12+, a runtime permission request for USB, and the SDK's own requirements.

**Exit criteria:** 5 pages print from a phone with no dialog; timing is displayed in the result panel.

## 7. Phase 4 — Frontend adaptation

- `PrintPage` reads capabilities (Phase 1) and renders only supported controls.
- `printLabels` (`src/printApi.ts`) stays the same; it already returns timings and a `PrintReport`. Add a `transport` field to the report (`sumatra` | `android-dialog` | `ipp` | `vendor`) and show it in the result panel.
- **Template transfer:** the saved template lives per device. Add **Export template** / **Import template** buttons (JSON file) to the Designer tab so a layout designed on desktop can be used on Android.
- Large PDFs: `invoke('print_pdf', { bytes: Array.from(pdf) })` is slow for hundreds of pages on a phone. Switch to sending the bytes as a binary payload (or write to a temp file and pass the path) when pages > ~50.
- Disable the tab bar's Designer entry on narrow screens if it is unusable (see Phase 2).

## 8. Phase 5 — Testing

| Test | How |
|---|---|
| Windows regression | Existing plan: virtual printer → 1 page → 5 pages → real printer |
| Android, option A | Print to "Save as PDF" in the system dialog; verify page count, size, Japanese text and barcodes |
| Android, option B | Run a test IPP printer on a Linux/macOS machine on the same network (`ippeveprinter` from CUPS), then the real printer. Use a real phone; emulators do not see mDNS and may not reach the LAN reliably |
| Android, option C | Real printer + real stock; check DPI by measuring a printed barcode or ruler |
| Rotation | 0°, 90°, 180°, 270° on the actual stock; record which angle is upright for each printer |
| Large jobs | 100 pages: time to generate, time to send, memory use |
| Release build | `pnpm tauri android build` (APK/AAB), install on a clean device, repeat the real-printer test |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Android can't print silently through the system dialog | Be explicit in the UI ("opens the print dialog"); use IPP or a vendor SDK where silence is required |
| Printer doesn't accept PDF over IPP | Check `document-format-supported` in Phase 0; fall back to raster formats or a vendor SDK |
| Custom paper sizes are ignored by print services and drivers | Rotate the content to match the stock and set the paper in the printer's own settings, as on Windows |
| pdfme Designer is hard to use on a phone | Treat Designer as desktop/tablet only; transfer templates by import/export |
| Vendor SDK licensing/size | Check the licence and APK size impact before committing |
| Tauri mobile plugin APIs change | Pin the Tauri version and re-check the plugin docs when starting Phase 3 |

## 10. Rough sequence and effort

These are estimates for one developer who already knows Tauri; treat them as ranges.

| Phase | Work | Estimate |
|---|---|---|
| 0 | Decide transport | 0.5 day |
| 1 | Cross-platform safe repo, capabilities, UI gating | 1–2 days |
| 2 | Android toolchain, first run, layout fixes | 1–2 days |
| 3A | System print dialog plugin | 1–2 days |
| 3B | IPP backend (if chosen) | 3–5 days |
| 3C | Vendor SDK backend (if chosen) | 4–8 days, depends on the SDK |
| 4 | Frontend adaptation, template import/export | 1–2 days |
| 5 | Testing and release build | 2–3 days |

## 11. Definition of done

- The Windows app is unchanged in behaviour.
- The Android app builds and runs, generates multi-page labels from the saved template, and prints them through the chosen backend.
- The result panel states which transport was used and which options were honoured.
- A template exported from desktop can be imported on Android and prints correctly.
