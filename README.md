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

## Build
Builds bundle the frontend into the app, so they don't need the Vite dev server (or the network setup `android dev` needs).
Windows needs the SumatraPDF exe in `src-tauri/binaries` and the font in `public/fonts`.

### Windows
```powershell
pnpm install
pnpm build:windows      # runs `tauri build`, then moves the installers into releases\
```
Output:
- `releases\*.msi`: the installer (MSI only — the old NSIS `.exe` installer was dropped)
- `src-tauri\target\release\q-print.exe`: the bare app, with `SumatraPDF.exe` next to it

> **Upgrading from a version installed with the NSIS installer:** the MSI is a different installer
> technology, so it installs alongside rather than over the old one. Uninstall the old `*-setup.exe`
> first (Settings > Apps > Q-Print > Uninstall), then run the MSI. Later MSI versions upgrade each
> other normally.

### Linux
Build on a Linux machine with the Tauri Linux packages installed (`libwebkit2gtk-4.1-dev build-essential libxdo-dev
libssl-dev libayatana-appindicator3-dev librsvg2-dev` on Debian/Ubuntu):
```bash
pnpm install
cp .env.example .env     # add your Turso URL and token
pnpm tauri dev           # Windows (needs SumatraPDF and the font, see SETUP.md)
```
The build moves the APK into `releases\` and adds the app name and version to its file name, so use the current version
in the path.

Release builds:
```powershell
pnpm build:android        # APK
pnpm build:android:aab    # Play Store bundle
```
A release APK built on your PC is **unsigned** and Android refuses to install it. (The GitHub release workflow signs its
APK for you; see `RELEASE.md`.) To sign locally, create a keystore once and set up signing following the
Tauri v2 docs section "Android Code Signing" (a `keystore.properties` file plus a `signingConfigs` block in
`src-tauri/gen/android/app/build.gradle.kts`):
```powershell
keytool -genkey -v -keystore $HOME\upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```
Keep the keystore and its passwords out of git and back them up; a lost Play Store signing key can't be replaced.

### Version and release scripts
| Command                                                  | What it does                                                                                                                                                                               |
|----------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `pnpm version:major` / `version:minor` / `version:patch` | Bumps the version in `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. Add `--tag` to also commit and create the tag `vX.Y.Z` (it never pushes), or `--dry-run` to preview |
| `pnpm version:set 1.2.3`                                 | Sets an exact version (plain `x.y.z`, no `-beta`: the MSI installer rejects it)                                                                                                            |
| `pnpm version:check`                                     | Fails if the tag on this commit disagrees with the app version. The release build refuses to run when they do, because a mismatched tag ships an installer named for one version holding an app that reports another |
| `pnpm releases:collect`                                  | Moves existing build output into `releases\`. The `build:*` scripts already do this. `--copy` keeps the originals                                                                          |
| `pnpm releases:clean`                                    | Empties `releases\` after asking. `--yes` skips the question, `--dry-run` only lists                                                                                                       |
| `node scripts/rename-app.mjs --name "New Name"`          | Renames the app (display name, package name, Rust lib). Try `--dry-run` first. `--id` also changes the identifier, which Android treats as a new app                                       |

`releases/` is git-ignored; add `/releases/` to `.gitignore` if it is missing.

### Both at once on GitHub
Pushing a version tag runs `.github/workflows/release.yml`, which builds the Windows installers and an Android APK and
attaches them to a draft release. The tag must be on a commit on `main`, and the repository needs the Turso and Android
signing secrets listed in `RELEASE.md` ("GitHub secrets"):
```powershell
pnpm version:minor --tag    # 0.1.0 -> 0.2.0: commits "Release v0.2.0" and creates the tag
git push origin main        # wait for CI to pass
git push origin v0.2.0      # starts the release build
```
See `RELEASE.md` for the full checklist.
`.github/workflows/ci.yml` runs on every push to `main` and on pull requests: `pnpm test` and
`pnpm typecheck`, `cargo test`, the frontend build, Rust checks for Windows, Linux and Android, and
a debug APK build.

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
  (`externalBin` for SumatraPDF, the msi target).
- `src-tauri/plugins/android-print`: the Android print plugin (Rust + Kotlin).
- `src/capabilities.tsx`: React context for the platform capabilities.

## Designer
The **Designer** tab is the pdfme designer. Edit the layout, set the page size, and press *Save template*.
The template is saved to the app data folder (on Windows
`%APPDATA%\com.example.print-test\label-template-product.json`) and the Print tab uses it from then on.
*Reset to default* deletes it and returns to `src/templates/product-label.json`.
Fields named like the keys listed in the Designer ("Fields filled with random data") get random data per page;
any other field prints its own text.

On Android phones the Designer tab is hidden because the editor needs a large screen; tablets show it.

## Signing in, and where labels live

The app asks for a username and password before it shows anything. There is no server: accounts and
labels live in a [Turso](https://turso.app) database, reached over HTTPS from the app, so there is
nothing to host or keep running.

To set this up:

1. Create a database at turso.app and create a **write** token.
2. Copy `.env.example` to `.env` and fill in `VITE_TURSO_URL` and `VITE_TURSO_TOKEN`.
3. Restart the dev server — the URL and token are read at build time.

Nothing else is needed: **the app applies any outstanding migration itself at start-up**, before it
shows the login screen, so a database always matches the code. To apply it by hand instead, or to
see what it did, use `pnpm db:migrate`.

### Changing the schema

The schema lives in `src/db/schema.ts` and nowhere else. To change it:

```bash
# 1. edit src/db/schema.ts
pnpm db:generate     # writes db/migrations/000N_name.sql, plus the snapshot for the next diff
pnpm db:migrate      # applies it to the database named in .env
```

Commit the generated files under `db/migrations/`. `pnpm test` builds its own schema by running
those migrations, so a broken one fails the tests rather than the app.

`pnpm db:studio` opens a browser UI for looking at the database while you work on this.

`db/adopt-drizzle.sql` is a one-time script, already applied to the shared database, that moved it
from the hand-written schema to the migrated one. It is kept for the record.

Each account sees only its own labels. A built-in label's layout is still a file on the device
(`label-template-product.json`) and its generator is still in the app; everything a user creates is
one row in the database, scoped to their account. Labels saved by an earlier version, as files in
`app_data_dir()/labels`, are offered for copying onto the account the first time that account signs
in — once, and never again if the user deletes what was imported.

> **This is a test build.** The database token is compiled into the frontend bundle, so anyone who
> opens the app can read it and query the whole database. The sign-in screen decides which labels
> the app *shows*; it is not a security boundary. Passwords are salted and hashed so they are not
> stored in the clear, and that is the whole of the protection. Before this goes anywhere real, put
> a server in front of it. See `AUTH_AND_DATABASE_PLAN.md` §7.

### Commands

| Command | Does |
| ------- | ---- |
| `pnpm test` | Unit tests, including the SQL run against a local SQLite file. No credentials needed. |
| `pnpm test:db` | The same flows against the **real** database. Needs `.env`; creates and removes a throwaway account. |
| `pnpm db:generate` | Writes a migration from `src/db/schema.ts`. |
| `pnpm db:migrate` | Applies outstanding migrations (the app also does this at start-up). |

## Labels

The app ships with one label and lets you add your own, all chosen with the **Label** `<select>`:

| Label                  | id         | Page size    | Default layout                       |
| ---------------------- | ---------- | ------------ | ------------------------------------ |
| Product label          | `product`  | 190 x 160 mm | `src/templates/product-label.json`   |

A built-in keeps its saved template next to the bundled one (`label-template-product.json` for `product`)
and has its own *Reset to default*. A label you create yourself is one row in the database, holding
its layout **and** the rule that fills it, so the two can never drift apart. The page size comes from
the template, so a label resized in the Designer reports the size it will actually print at. The last
label used is remembered per account, so two people on one device do not fight over it.

Set the printer driver's default paper to the label's page size (see the hint under *Paper size*).

### Making your own label

On the Designer tab, next to the label picker: **New**, **Duplicate**, **Rename**, **Delete**.
**New** asks for a name, a size (with presets, or any size in mm) and what to start from:

- **The sample label** — a small ready-made label that prints as-is, so there is something to try
  before building one field by field. Its fields show off fixed text, a date that follows today, a
  table, per-page numbering, a pattern and one field built from another's value. It becomes an
  ordinary label of yours, which you can rename, edit and delete.
- **Copy of …** — an existing label's layout and its data rules, which you can then change.
- **A blank label** — an empty page. Add fields in the Layout tab.

Built-in labels cannot be renamed or deleted, only reset.

The Designer has two tabs:

- **Layout** — where things sit on the page (today's pdfme designer).
- **Data** — what each field prints on every page.

One **Save** writes both.

### The data tab

Each field that can take data gets one row: its name, its type, a rule, and a live sample of what
it will print. A field you add in the Layout appears here with a sensible default rule. A field you
rename or delete leaves its rule behind in an "unused rules" list, where you can move it to another
field or delete it, rather than losing the work.

The rules are a fixed, small set — there is no scripting:
| Rule | What it does |
| ---- | ------------ |
| Fixed text | Always the same text. |
| Random digits | N digits, e.g. a 13-digit tracking number. |
| Whole number | A number in a range, optionally stepped, as `1234`, `1,234` or `¥1,234`. |
| Pick from a list | One of the values you type. |
| From a table | One cell of a table. All fields reading the same table share a row for the whole page, so a postcode and its address always match. |
| A date | Relative to today, formatted with `YYYY MM DD HH mm ss`. |
| Pattern | Text with `{d3}` digits, `{D2}` A–Z or `{L2}` a–z mixed in, e.g. `A{d12}A`. |
| Numbering | Counts up per page, restarting on every print job. |
| Copy another field | Another field's value on the same page, optionally rebuilt with a pattern where `{from}` is the copied value. |
| A value from the API response | A value read from a web API record, such as `user.name`. The label stores only the path; you give the address when you print (see [Data from a web API](#data-from-a-web-api)). |

Every rule can also add text before and after the value, and run it through *digits only*,
*upper* or *lower*. Problems (a range the wrong way round, a rule pointing at a table that is not
there, a copy that loops) are listed at the top and stop Save until they are fixed. Barcode fields
show what their format accepts and flag a sample it could not encode, so a bad value is caught
before it reaches a print job. **Preview label** renders the real page with pdfme.

A built-in label's rules ship with the app, so the Data tab is read-only for them; **Duplicate**
gives you an editable copy with the same layout and the same rules.

The built-in **Product label** is a worked example that prints with nothing typed and nothing fetched.
Its rules are fixed values and generated numbers, so it works offline on a first run. Duplicate it to
map the fields to a real API.

### Data from a web API

Instead of random data, a label can print real records from a web API. **The label stores only which
path of a record each field needs. The address is yours to type, when you print** — so it is not saved
with the label, does not travel in an export file, and is not remembered between sessions. A label
can therefore never send a request to a host you did not just choose, even one imported from someone
else.

**While designing** (Data tab):

1. Open **Test with a real API** and type the address, with a `{name}` wherever a value will be given,
   for example `api.example.com/day/{day}/count/{count}/logs`. Without `http://` or `https://` it is
   called over https.
2. Optional: a **list path** for responses such as `{ "data": [ ... ] }` (enter `data`), and
   **Send an access token**.
3. Press **Check data**. The record count and the first record are shown. **Forget these records**
   puts it back to nothing.
4. For each field choose **A value from the API response** and give its path, for example `user.name`
   or `items[0].id`. Prefix, suffix and the *digits only / upper / lower* options work as for any
   other rule. **Preview label** then shows the fetched records.

Alternatively, type a **Preview value** per field and no address at all: that is stored with the label,
so the preview is the same next time you open it. Placeholders are never printed — a print job always
uses real records.

**When printing**, a label that has at least one API field shows a **Data source** card under the label
picker. It asks for the address, shows the exact address that will be called (host in bold), the
values its variables ask for, and the access token if you tick **Send an access token**. **Check data**
is optional: it reports "12 records found" and the first record. The *Number of pages* field becomes
**Copies of each record**.

- An **object** response is one record; an **array** response is one record per item.
- Every record is printed once per copy, grouped by record: record 1 × n, then record 2 × n.
  `Numbering` rules keep counting across the whole job. Other random rules still give each copy a
  fresh value; only the API values are shared by the copies of a record.
- The job is limited to 10,000 pages in total (records × copies), checked before anything is built.

| JSON value | Printed as |
| ---------- | ---------- |
| text | as is |
| number, true/false | `42`, `true` |
| `null` | empty |
| missing key | an error naming the record, the field and the path; nothing is printed |
| object or list | an error: pick a field inside it |

**Rules of the request:** GET only, JSON only. Values typed for the variables are URL-encoded
(`2026/10/15` becomes `2026%2F10%2F15`). In the apps the request is made by Rust (no CORS), waits at
most 15 seconds, accepts at most 5 MB, and follows redirects only to the same address. In a browser
(the web build) the server has to allow the page's origin (CORS), which is only a concern when
developing.

**The access token** is typed at print time, kept in memory for that one request, and is never saved in the
database, in a label file, in a report or in an error message. It is refused over plain `http://` and
is never remembered between runs. The values typed for the variables are not secret and are remembered
per label and account.

A label that uses an API cannot be imported by an older version of the app: it refuses the unknown
rule instead of printing it wrongly.

### Label files and moving one between devices

A label file is JSON:

```jsonc
{
  "format": "q-print-label",
  "version": 1,
  "name": "My parcel label",
  "template": { /* a pdfme template */ },
  "generator": { "version": 1, "tables": { }, "fields": { "zip": { "kind": "digits", "length": 7 } } }
}
```

A field that reads from a record is `{ "kind": "api", "path": "user.name" }`. That is the whole of it:
no address and no token, because both belong to the person printing. Export writes this whole file, so
the receiving device produces the same data, not just the same picture. Import accepts it (creating a
new label) and still accepts a bare pdfme template, which replaces the selected label's layout and
keeps its data rules. A file written before addresses moved to print time still imports; its stored
address is dropped.

To add a label to the app itself rather than to your own copy: put its template under
`src/templates/`, add it to `BUILTINS` in `src/builtinLabels.ts` and `BUILTIN_IDS` in
`src-tauri/src/lib.rs`, and add a spec to `BUILTIN_SPECS` in `src/generator/builtins.ts`.
The generator engine itself is in `src/generator/engine.ts` and is a pure function, so it is
covered by `pnpm test`.

## Moving a label between devices
The label lives on each device. To use one designed on desktop on Android:

1. On the desktop, open *Export / import label* (Print tab, or the Designer tab) and press **Export label**.
   Use **Copy** or **Download .json**. This exports the saved label, not unsaved Designer edits.
2. On the phone, open the Print tab, *Label: export / import*, press **Import label**, choose the
   `.json` file or paste the JSON, and press **Import it**. The label shows up in the label list.

Phones cannot use the Designer, but they can print anything imported this way.

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

Android, builds, releases and troubleshooting are in [SETUP.md](SETUP.md).

## Print API

While the app is running, anything on the same PC can print through a local HTTP API instead of
somebody clicking in the UI. A POS, an ERP, a script, `curl`.

- **Desktop only.** Android has no local port for a POS to reach.
- **On by default**, on `http://127.0.0.1:17631/api/v1`. Change the port or turn it off on the
  **API** tab.
- **Token required.** Generated on first run and shown on the API tab. Regenerating it stops the old
  one working immediately.
- **This PC only.** It listens on `127.0.0.1` and nothing else, so it is not reachable from the
  network.
- **One print at a time**, shared with the UI: a person pressing Print and a script printing at the
  same moment queue rather than collide.

Closing the window does not stop it. The window goes to the tray and the API keeps answering.

### Endpoints

| Method & path | What it does | Auth |
|---|---|---|
| `GET /health` | Is it up? Version, platform, whether anyone is signed in | No |
| `GET /printers` | Installed printers | Yes |
| `GET /labels` | The signed-in account's labels, with their size in mm | Yes |
| `POST /print` | Render a saved label and print it | Yes |
| `POST /print/pdf` | Print a PDF you already have | Yes |

Errors always look like `{"error": {"code": "...", "message": "..."}}`.

| Status | When |
|---|---|
| 400 | Bad JSON, missing `printer` or `label`, not a PDF, `pages` out of range |
| 401 | Missing or wrong token |
| 403 | A `Host` or `Origin` that is not ours — see below |
| 404 | No such endpoint, or no such label |
| 409 | Label mode while nobody is signed in |
| 413 | Body too large (PDF 64 MB, JSON 5 MB) |
| 422 | The label could not be rendered from what was sent |
| 500 | The printer or SumatraPDF failed |
| 504 | The app did not answer within 5 minutes |

### Two ways to print

**PDF mode** is pure Rust and needs nobody signed in — the caller supplies a finished PDF:

```bash
curl -X POST "http://127.0.0.1:17631/api/v1/print/pdf?printer=Zebra%20ZD421" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/pdf" \
  --data-binary "@label.pdf"
```

**Label mode** renders one of the app's own labels, so the output is the same as printing it from
the UI. It prints as whoever is signed in, and says `409` if nobody is:

```bash
curl -X POST http://127.0.0.1:17631/api/v1/print \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "product",
    "printer": "Zebra ZD421",
    "pages": 3,
    "rows": [{ "name": "Tea 500g", "barcode": "4901234567894" }]
  }'
```

`rows` keys are the label's field names; a name that is not a field is refused with `422` rather
than printing a blank field. One row is used for every page; more than one is a page each.

Other body fields: `api` (the label's own data source, same shape as the Print tab), `paper`,
`orientation`, `rotate`, `margins`, `dpi`, and `dryRun` — which returns the PDF instead of printing
it, which is how you check a layout without using paper.

`printer` is always required. There is no default, so a job can never quietly go to the wrong
printer.

### From JavaScript

```js
const response = await fetch('http://127.0.0.1:17631/api/v1/print', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.QPRINT_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'product', printer: 'Zebra ZD421', pages: 1, dryRun: true }),
});
if (!response.ok) throw new Error(await response.text());
const { pages } = await response.json();
```

The **API** tab has a *Try it* button and generates these snippets for curl, PowerShell and
JavaScript with the request you have set up. The token is a placeholder in the snippets until you
tick *Include the real token*.

### Why a web page cannot do this

The server refuses a `Host` header that is not `127.0.0.1:<port>` or `localhost:<port>`, and refuses
an `Origin` that is not the app's own or one you have added. That is what stops a web page you happen
to have open from spending your paper, and stops a hostile name pointed at `127.0.0.1` from
reaching the server through your browser. `curl` and other non-browser callers send no `Origin` and
are held to the token instead. More origins can be added on the API tab.

## Test order
**Web API labels:** on each platform, a label with a real https API with and without a bearer token, a wrong
token (401), a slow or unreachable host (timeout), one record (an object response), and 100 records × 3 copies.

- [SETUP.md](SETUP.md): setup, builds, printer options, the designer and data rules, troubleshooting
- [RELEASE.md](RELEASE.md): publishing a release on GitHub, signing

> **This is a test build.** The database token is compiled into the app, so the sign-in screen is not a
> security boundary. Put a small server in front of the database before using it in production (see SETUP.md).
