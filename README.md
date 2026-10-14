# Tauri label printing app (Windows + Android)

Lists printers, generates random label data in Rust, builds a multi-page pdfme PDF in the
frontend, and prints it.

- **Windows:** silent printing with SumatraPDF (`-print-to ... -silent`, scale-to-fit).
- **Android:** two ways to print.
  - **Printers you add in the app (Wi-Fi/LAN, Bluetooth, USB): no dialog.** The app sends the label to the
    printer itself, as PDF or as a ZPL/TSPL/ESC-POS/CPCL bitmap. See "Direct printing on Android" below.
  - **"System print dialog"** (`PrintManager`): Android never allows silent printing through the system
    print service, so you pick the printer and tap Print there.

The UI asks the Rust side what the platform can do (`capabilities` command) and hides the options that
don't apply, instead of showing controls that would silently do nothing.

|                                                | Windows            | Android                                                                    |
|------------------------------------------------|--------------------|----------------------------------------------------------------------------|
| Print path                                     | SumatraPDF, silent | Added printer (LAN / Bluetooth / USB): silent. Otherwise the system dialog |
| Printer list                                   | installed printers | printers you added, plus "System print dialog"                             |
| Paper size, orientation, resolution            | set by the app     | chosen in the system dialog (controls hidden)                              |
| Rotate label content, margins, number of pages | yes                | yes (done inside the PDF)                                                  |
| Designer tab                                   | yes                | tablets only (width >= 768 px); use template export/import on phones       |

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
5. **Turn on Windows Developer Mode** (once per PC): Settings -> System -> For developers -> **Developer Mode: On**
   (on older Windows 10: Settings -> Update & Security -> For developers). Then close and reopen your terminal.
   Tauri links the built `libprint_test_lib.so` into the Android project with a symbolic link, and Windows only lets
   regular users create those when Developer Mode is on. Without it the build stops with
   `Creation symbolic link is not allowed for this system`.
6. Connect a device. For printing, use a real phone or tablet (emulators don't reach your network printers):
   enable *Developer options* and *USB debugging* on the device, plug it in, accept the prompt on the device, and check
   that it is listed:
   ```powershell
   & "$env:ANDROID_HOME\platform-tools\adb.exe" devices
   ```
   The message `No available Android Emulator detected` is harmless when a physical device is connected.
7. Generate the Android project (once) and commit it:
   ```powershell
   pnpm tauri android init
   ```
8. Run on the device. The phone must reach your PC over the network, so keep both on the same Wi-Fi.
   Vite binds to `TAURI_DEV_HOST`, which `tauri android dev` sets for you.
   ```powershell
   pnpm tauri android dev
   ```
9. Release build (APK/AAB): `pnpm tauri android build`

`src-tauri/gen/android` is a normal Gradle project. Commit it, but not its build output (see `.gitignore`).

### Direct printing on Android (no printer selection page)
In the Print tab open **Add a printer (no dialog)**, pick or enter the printer, press **Test**, then **Save printer**
and select it in the Printer list. Printing to it never shows the Android print screen.

| Connection | How it is found | What is sent |
|---|---|---|
| Wi-Fi / LAN, **IPP** (port 631) | **Find Wi-Fi printers** (mDNS) or type the IP | PDF as-is. If the printer lists no PDF support, a PWG raster bitmap (300 dpi) |
| Wi-Fi / LAN, **raw socket** (port 9100) | mDNS or type the IP | PDF as-is, or a bitmap in **ZPL / TSPL / ESC-POS / CPCL** |
| **Bluetooth** (classic SPP) | paired devices list | bitmap in ZPL / TSPL / ESC-POS / CPCL |
| **USB** (OTG cable) | connected USB printers list | bitmap in ZPL / TSPL / ESC-POS / CPCL |

- **Test** (IPP) asks the printer for its model, state and supported formats, and says whether it takes PDF or PWG raster.
- The label keeps the PDF's own page size. Bitmap languages render at the printer's resolution (default 203 dpi, set per
  printer; IPP raster always uses 300 dpi). Paper, orientation and resolution app options do not apply to direct printing.
- Which language? Zebra and compatibles: ZPL (or CPCL on mobile models). TSC, Xprinter and many Chinese label printers:
  TSPL. Receipt printers and most small Bluetooth printers: ESC/POS. If unsure, check the printer's manual for its
  "command set" / "emulation".
- Printers are stored in `printers.json` in the app data folder.

Code: `src-tauri/src/direct.rs` (printer store, IPP, raw socket), `src-tauri/src/raster.rs` (bitmap encoders),
`src-tauri/src/print_android.rs` (chooses the format), the Kotlin plugin (`PdfRenderer` page rendering, mDNS, Bluetooth,
USB) and `src/PrintersPanel.tsx`. `direct.rs` and `raster.rs` have no Tauri dependency, so their unit tests run in any
crate that includes both (`mod raster;` next to `direct.rs`): IPP and raw sockets are tested against a local mock
printer, the encoders against known byte layouts and a PWG round trip.

**Not tested on real hardware yet.** The Kotlin code (rendering, discovery, Bluetooth, USB) has not been compiled or
run on a device, and no real printer was available. Verify first with a printer you can print a test label on:
- TSPL's `GAP`/`SIZE` assume gapped label stock, and TSPL bitmap polarity (0 = black) follows the TSPL manual. If labels
  feed wrongly or print inverted, that is where to look (`raster.rs`).
- ESC/POS sends a partial-cut command after each page; printers without a cutter ignore it. Paper width is not scaled: a
  110 mm label on a 58 mm receipt printer is cut off.
- Bluetooth: classic (SPP) only. BLE-only printers (some very small label printers) do not show up as pairable
  serial devices and are not supported.
- Printers that only take a vendor SDK / proprietary protocol (some Brother, Epson, Star models) need that protocol.
- `ipps://` (TLS) is not supported.
- Targeting Android 17 (target SDK 37) or higher needs the runtime `ACCESS_LOCAL_NETWORK` permission for LAN printing and
  discovery ([docs](https://developer.android.com/privacy-and-security/local-network-permission)). Up to SDK 36 the
  `INTERNET` permission is enough.

### How the system print dialog works on Android
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
- Silent printing needs a direct transport: see "Direct printing on Android" above. Vendor SDKs are not implemented.

## Build
Builds bundle the frontend into the app, so they don't need the Vite dev server (or the network setup `android dev` needs).
Windows needs the SumatraPDF exe in `src-tauri/binaries` and the font in `public/fonts`.

### Windows
```powershell
pnpm install
pnpm tauri build
```
Output:
- `src-tauri\target\release\bundle\nsis\*.exe`: setup installer
- `src-tauri\target\release\bundle\msi\*.msi`
- `src-tauri\target\release\print-test.exe`: the bare app, with `SumatraPDF.exe` next to it

### Android
Debug APK (signed with the debug key, installs straight away). `--target aarch64` builds only 64-bit phones, which is
faster; leave it out to build all four architectures:
```powershell
pnpm tauri android build --debug --apk --target aarch64
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

Release builds:
```powershell
pnpm tauri android build --apk     # APK
pnpm tauri android build --aab     # Play Store bundle
```
A release APK is **unsigned** and Android refuses to install it. Create a keystore once and set up signing following the
Tauri v2 docs section "Android Code Signing" (a `keystore.properties` file plus a `signingConfigs` block in
`src-tauri/gen/android/app/build.gradle.kts`):
```powershell
keytool -genkey -v -keystore $HOME\upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```
Keep the keystore and its passwords out of git and back them up; a lost Play Store signing key can't be replaced.

### Both at once on GitHub
Pushing a version tag runs `.github/workflows/release.yml`, which builds the Windows installers and an Android APK and
attaches them to a draft release (the APK is unsigned until you add signing secrets):
```powershell
git tag v0.1.0
git push origin v0.1.0
```
`.github/workflows/ci.yml` runs on every push to `main` and on pull requests: frontend build, Rust checks for Windows,
Linux and Android, and a debug APK build.

## Troubleshooting (Android on Windows)
| Symptom                                                                      | Cause and fix                                                                                                                                                                                                                                                                                                                            |
|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `Creation symbolic link is not allowed for this system`                      | Developer Mode is off. Turn it on (Setup, Android, step 5) and reopen the terminal. Running the terminal as Administrator also works.                                                                                                                                                                                                    |
| `No available Android Emulator detected`                                     | Only a notice. Connect a physical device with USB debugging, or start an emulator from Android Studio.                                                                                                                                                                                                                                   |
| App opens but shows a blank page or "can't connect"                          | The phone can't reach the Vite dev server at `http://<PC-IP>:1420`. Use the same Wi-Fi for both, and allow Node.js through Windows Firewall on private networks.                                                                                                                                                                         |
| `adb devices` shows `unauthorized` or nothing                                | Unlock the phone and accept the "Allow USB debugging" prompt; try another cable or USB mode (File transfer).                                                                                                                                                                                                                             |
| First `tauri android dev` sits on `CONFIGURING` / `IDLE` for several minutes | Gradle is downloading a missing Android SDK platform or build-tools in the background. Check that `Sdk\.temp` or `Sdk\platforms` is growing, or install it yourself: `sdkmanager "platforms;android-37.0"`.                                                                                                                              |
| `ERR_CONNECTION_REFUSED` or a 500 in the app's console (`chrome://inspect`)  | The phone can't reach the dev server, or Vite failed on a request (its error is printed in the PC terminal). Compare the IP in the log with `ipconfig`, open `http://<IP>:1420` in the phone's browser, and allow ports 1420-1421 in Windows Firewall (Private and Public profiles). A build (see Build) avoids the dev server entirely. |
| Gradle sync or Kotlin compile errors in the plugin                           | Check `src-tauri/plugins/android-print/android` (`build.gradle.kts`, `settings.gradle`) and `register_android_plugin` against the current Tauri v2 mobile-plugin docs.                                                                                                                                                                   |
| `resource path binaries\SumatraPDF-... doesn't exist` (Windows build)        | The SumatraPDF exe is missing from `src-tauri/binaries`.                                                                                                                                                                                                                                                                                 |

## Project layout
- `src-tauri/src/lib.rs`: commands shared by all platforms (random data, template storage, `capabilities`, print entry points).
- `src-tauri/src/direct.rs`: IPP / raw-socket printing and the saved-printer store (no Tauri dependency).
- `src-tauri/src/raster.rs`: 1-bit bitmap -> ZPL / TSPL / ESC-POS / CPCL / PWG raster encoders (no Tauri dependency).
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

## Labels

The app maintains two labels, chosen with the **Label** `<select>` on the Print tab (and on the Designer tab):

| Label                  | id         | Page size    | Default layout                       |
| ---------------------- | ---------- | ------------ | ------------------------------------ |
| Shipping label (Sagawa) | `shipping` | 110 x 86 mm | `src/templates/label.json`           |
| Product label          | `product`  | 190 x 160 mm | `src/templates/product-label.json`   |

Each label has its own saved template (`label-template.json` for `shipping`, `label-template-product.json`
for `product`), its own *Reset to default*, and its own random test data. The last label used is remembered.

To add another label: add a template under `src/templates/`, register it in `src/labels.ts`, and add its id
to `LABEL_IDS` and a data generator to `generate_random_data` in `src-tauri/src/lib.rs`.
Set the printer driver's default paper to the label's page size (see the hint under *Paper size*).

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
