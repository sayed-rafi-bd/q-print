# Q-Print

A label printing app for Windows and Android, built with Tauri. Design a label, fill it with random or
real data, and print many pages in one go, with no print dialog on Windows and on printers you add on Android.

## Features

**Printing**
- **Windows:** silent printing through the installed printers (SumatraPDF), no dialog.
- **Android:** add Wi-Fi/LAN, Bluetooth or USB printers once, then print without any dialog. Sends PDF, or
  ZPL, TSPL, ESC/POS and CPCL for label and receipt printers. The system print dialog is also available.
- Multi-page jobs, up to 10,000 pages, with rotation (0/90/180/270), margins and (on Windows) print resolution.
- The UI shows only the options the current platform supports.

**Label designer**
- Drag-and-drop layout editor (pdfme): text, tables, barcodes and more, with any page size in mm.
- Live preview of the real page before you print.
- Create labels from a ready-made sample, a copy of an existing label, or a blank page. Duplicate, rename and delete them.
- Japanese text supported (Noto Sans JP).

**Data for every page**
- Per-field rules, no scripting: fixed text, random digits, number ranges, pick from a list, table rows,
  dates relative to today, patterns such as `A{d12}A`, per-page numbering, and copying another field.
- Print real records from a web API: each field reads a path like `user.name`, and one page is printed per record
  (times the number of copies). The address and access token are entered at print time and never saved with the label.
- Mistakes (bad ranges, loops, barcode values that cannot be encoded) are flagged before you print.

**Accounts and sharing**
- Sign in with a username and password. Each account sees its own labels, stored in a Turso database.
- Export a label as a JSON file (layout and data rules) and import it on another device.
- The Designer also runs as a plain web page (no printing).

## Platforms

| | Windows | Android |
|---|---|---|
| Print path | Silent, through SumatraPDF | Added printer (LAN / Bluetooth / USB): silent. Otherwise the system dialog |
| Printer list | Installed printers | Printers you added, plus "System print dialog" |
| Designer | Yes | Tablets only; on phones use label import/export |

Linux builds open and the Designer works, but printing is not implemented there yet.

## Quick start

```bash
pnpm install
cp .env.example .env     # add your Turso URL and token
pnpm tauri dev           # Windows (needs SumatraPDF and the font, see SETUP.md)
```

Android, builds, releases and troubleshooting are in [SETUP.md](SETUP.md).

## Documentation

- [SETUP.md](SETUP.md): setup, builds, printer options, the designer and data rules, troubleshooting
- [RELEASE.md](RELEASE.md): publishing a release on GitHub, signing

> **This is a test build.** The database token is compiled into the app, so the sign-in screen is not a
> security boundary. Put a small server in front of the database before using it in production (see SETUP.md).
