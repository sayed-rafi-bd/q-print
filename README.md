# Tauri label printing app (Windows + Android)

Lists printers, generates random label data in Rust, builds a multi-page pdfme PDF in the
frontend, and prints it.

- **Windows:** silent printing with SumatraPDF (`-print-to ... -silent`, scale-to-fit).
- **Android:** opens the system print dialog (`PrintManager`). Android does not allow silent printing
  through the system print service, so you pick the printer and tap Print there.

The UI asks the Rust side what the platform can do (`capabilities` command) and hides the options that
don't apply, instead of showing controls that would silently do nothing.

|                                                | Windows            | Android                                                              |
|------------------------------------------------|--------------------|----------------------------------------------------------------------|
| Print path                                     | SumatraPDF, silent | System print dialog (not silent)                                     |
| Printer list                                   | installed printers | one virtual entry, "System print dialog"                             |
| Paper size, orientation, resolution            | set by the app     | chosen in the system dialog (controls hidden)                        |
| Rotate label content, margins, number of pages | yes                | yes (done inside the PDF)                                            |
| Designer tab                                   | yes                | tablets only (width >= 768 px); use template export/import on phones |

## Setup (Windows)
1. Install Rust, Node 20+, pnpm, and the Tauri v2 prerequisites for Windows (WebView2, MSVC build tools).
2. `pnpm install`
3. From the project folder (the one containing `package.json` and `src-tauri`):
   `pnpm tauri icon app-icon.png` (generates `src-tauri/icons`, including `icons/android`; swap in your own icon any time)
4. Font: save Noto Sans JP Regular as `public/fonts/NotoSansJP-Regular.ttf`.
5. Save portable SumatraPDF as `src-tauri/binaries/SumatraPDF-x86_64-pc-windows-msvc.exe`.
   The Windows build fails with `resource path binaries\SumatraPDF-... doesn't exist` without it.
6. `pnpm tauri dev`

## Setup (Android)
1. Install Android Studio (SDK Platform, Build-Tools and the **NDK**) and a JDK 17.
2. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`.
3. Add the Rust targets:
   ```powershell
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
4. Do the Windows setup steps 2-4 above (dependencies, icons, font). SumatraPDF is Windows-only and is not used on Android.
5. Generate the Android project (once) and commit it:
   ```powershell
   pnpm tauri android init
   ```
6. Run on a device or emulator. The phone must reach your PC over the network, so keep both on the same Wi-Fi.
   Vite binds to `TAURI_DEV_HOST`, which `tauri android dev` sets for you.
   ```powershell
   pnpm tauri android dev
   ```
7. Release build (APK/AAB): `pnpm tauri android build`

`src-tauri/gen/android` is a normal Gradle project. Commit it, but not its build output (see `.gitignore`).

### How printing works on Android
`print_pdf` writes the PDF to the app cache directory and calls the in-repo Kotlin plugin
`src-tauri/plugins/android-print`:

- `PrintPlugin.kt` reads the PDF's page count and first-page size and opens the system print dialog
  with that size as the requested paper.
- `PdfFileAdapter.kt` streams the cached file to the print service and deletes it when the job ends.

Things to know:
- The paper size is only a request. The print service or driver may offer its own sizes; choose the
  right one in the dialog.
- The page range chosen in the dialog is not applied; every generated label is sent.
- "Open dialog" in the result panel ends when the preview is requested, not when paper comes out.
- If Gradle sync fails, check the plugin's `build.gradle.kts`, `settings.gradle` and
  `register_android_plugin` against the current Tauri v2 mobile-plugin docs. They follow the plugin template.
- Direct IPP (silent, Wi-Fi printers) and vendor SDKs (Bluetooth/USB label printers) are not implemented.
  See `ANDROID_PLAN.md`, Phase 3B and 3C. Silent printing on Android needs one of them.

## Project layout
- `src-tauri/src/lib.rs`: commands shared by all platforms (random data, template storage, `capabilities`, print entry points).
- `src-tauri/src/print_windows.rs`, `print_android.rs`, `print_other.rs`: one backend per platform; only one is compiled.
- `src-tauri/tauri.conf.json`: shared config. `tauri.windows.conf.json` holds the Windows-only bundle settings
  (`externalBin` for SumatraPDF, nsis/msi targets).
- `src-tauri/plugins/android-print`: the Android print plugin (Rust + Kotlin).
- `src/capabilities.tsx`: React context for the platform capabilities.

## Designer
The **Designer** tab is the pdfme designer. Edit the layout, set the page size, and press *Save template*.
The template is saved to the app data folder (on Windows
`%APPDATA%\com.example.print-test\label-template.json`) and the Print tab uses it from then on.
*Reset to default* deletes it and returns to `src/templates/label.json`.
Fields named like the keys listed in the Designer ("Fields filled with random data") get random data per page;
any other field prints its own text.

On Android phones the Designer tab is hidden because the editor needs a large screen; tablets show it.

## Moving a template between devices
The saved template lives on each device. To use a layout designed on desktop on Android:

1. On the desktop, open *Export / import template* (Print tab, or the Designer tab) and press **Export template**.
   Use **Copy** or **Download .json**. This exports the saved template, not unsaved Designer edits.
2. On the phone, open the Print tab, *Template: export / import*, press **Import template**, choose the
   `.json` file or paste the JSON, and press **Save as my template**.

## Rotation, margins and resolution
- **Rotate label content** turns the label inside the PDF (0/90/180/270), independent of the driver or platform.
  On portrait stock such as 86 x 110 mm, 90 or 270 makes the 110 x 86 mm label fill the paper at 100%.
- **Margins (mm)** adjust the page box inside the PDF. Positive adds white space (the label prints smaller);
  negative trims the label's edge so it fills more of the paper. Sides refer to the label before rotation.
  The printer's own non-printable area cannot be removed. Works on every platform.
- **Print resolution** (Windows only) lists the resolutions the driver reports (via the Windows print ticket) and
  sets one for the job, then restores your previous printer settings. If a driver reports none, only its default is
  available. On Android the resolution is chosen in the system dialog.

## Paper size
- **Windows:** SumatraPDF only accepts named sizes (A2-A6, letter, legal, tabloid, statement). For a custom
  label size such as 110 x 86 mm, create it in the printer driver, make it the default, and leave
  the form on "Printer driver default".
- **Android:** the PDF's own page size is requested in the print dialog. If the print service ignores it,
  rotate the content to match the stock and set the paper in the dialog or in the printer's own settings.

## Large jobs
Jobs of more than 50 pages are sent from the frontend to Rust as a raw binary payload (`print_pdf_raw`) instead
of a JSON number array, which is much faster on a phone.

## Test order
**Windows:** virtual printer (Microsoft Print to PDF), 1 page -> check PDF -> 5 pages (different data) ->
real printer -> `pnpm tauri build` and repeat.

**Android:** `pnpm tauri android dev` -> print 3 pages to "Save as PDF" in the system dialog and check the page
count, the 110 x 86 mm size, Japanese text and barcodes -> real printer through an Android print service
(Mopria or the vendor's plugin) -> 100 pages (time and memory) -> `pnpm tauri android build`, install the
release build on a clean device and repeat the real-printer test.
