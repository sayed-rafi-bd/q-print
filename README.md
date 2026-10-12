# Tauri silent printing test app (Windows)

Lists printers, generates random label data in Rust, builds a multi-page pdfme PDF in the
frontend, and prints it silently with SumatraPDF (`-print-to ... -silent`, scale-to-fit).

## Setup
1. Install Rust, Node 20+, pnpm, and the Tauri v2 prerequisites for Windows (WebView2, MSVC build tools).
2. `pnpm install`
3. `pnpm tauri icon app-icon.png` (generates `src-tauri/icons`; swap in your own icon any time)
4. Font: save Noto Sans JP Regular as `public/fonts/NotoSansJP-Regular.ttf`.
5. Save portable SumatraPDF as `src-tauri/binaries/SumatraPDF-x86_64-pc-windows-msvc.exe`.
6. `pnpm tauri dev`

## Designer
The **Designer** tab is the pdfme designer. Edit the layout, set the page size, and press *Save template*.
The template is saved to the app data folder (`%APPDATA%\com.example.print-test\label-template.json`) and the
Print tab uses it from then on. *Reset to default* deletes it and returns to `src/templates/label.json`.
Fields named like the keys listed in the Designer ("Fields filled with random data") get random data per page;
any other field prints its own text.

## Rotation and resolution
- **Rotate label content** turns the label inside the PDF (0/90/180/270), independent of the driver. On portrait
  stock such as 86 x 110 mm, 90 or 270 makes the 110 x 86 mm label fill the paper at 100%.
- **Print resolution** lists the resolutions the driver reports (via the Windows print ticket) and sets one for the
  job, then restores your previous printer settings. If a driver reports none, only its default is available.

## Paper size
SumatraPDF only accepts named sizes (A2-A6, letter, legal, tabloid, statement). For a custom
label size such as 110 x 86 mm, create it in the printer driver, make it the default, and leave
the form on "Printer driver default".

## Test order
Virtual printer (Microsoft Print to PDF), 1 page -> check PDF -> 5 pages (different data) ->
real printer -> `pnpm tauri build` and repeat.
