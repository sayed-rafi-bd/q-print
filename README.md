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

## Paper size
SumatraPDF only accepts named sizes (A2-A6, letter, legal, tabloid, statement). For a custom
label size such as 110 x 86 mm, create it in the printer driver, make it the default, and leave
the form on "Printer driver default".

## Test order
Virtual printer (Microsoft Print to PDF), 1 page -> check PDF -> 5 pages (different data) ->
real printer -> `pnpm tauri build` and repeat.
