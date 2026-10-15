# Q-Print Release Guide

## Overview

Pushing a version tag such as `v0.2.0` builds the Windows installers and Android APKs on GitHub
Actions and attaches them to one draft release. You review the draft, then publish it.

- **Windows:** NSIS installer (`.exe`) and `.msi`. SumatraPDF is bundled with the app and does the silent printing.
- **Android:** one APK per CPU type, which opens the system print dialog (no silent printing on Android).
  A release APK is unsigned until you set up signing, so it cannot be installed as it comes out of CI.
- **Linux:** the release workflow does not build it. You can build `.deb`, `.rpm` and AppImage packages by hand
  on a Linux machine (`pnpm build:linux`), but printing is not implemented on Linux yet: the app opens and the
  Designer works, but nothing prints.
- **Trigger:** `.github/workflows/release.yml`, on any tag matching `v*`.

### Two things have changed that affect every build

**1. The app now has accounts, and labels live in a database.** There is no server: the app talks to
Turso directly from the webview. Both `ci.yml` and `release.yml` need the credentials to build
anything that runs, and the APK only works if the token was in place when it was built. See
"Database credentials" below.

**2. Every workflow is currently disabled.** Both `.github/workflows/ci.yml` and
`.github/workflows/release.yml` have `if: false` on every job, left from an earlier state. Until
those lines are removed, a tag produces nothing and no check runs. This is the first thing to fix.

## Prerequisites

Releases built by GitHub Actions need nothing on your PC beyond a secret (below). Building by hand
needs the tools below.

### Database credentials

The app reads `VITE_TURSO_URL` and `VITE_TURSO_TOKEN` from `.env` at build time, so **any build —
desktop or Android — needs `.env` present**. Without it the app builds but the sign-in screen says
the database is not configured and nothing else works.

```bash
# .env  (git-ignored; .env.example documents the shape)
VITE_TURSO_URL=libsql://your-db-yourname.turso.io
VITE_TURSO_TOKEN=your-write-token
```

For CI, store both as repository secrets (`TURSO_URL`, `TURSO_TOKEN`) and write `.env` before the
build step. That step is not written into the workflows yet.

**The token is compiled into the frontend bundle.** Anyone with the release APK can read it and
query the whole database. This is accepted for testing — see `AUTH_AND_DATABASE_PLAN.md` §7 — but it
should be revisited before this reaches real users. For now it means: treat the release APK as a
test build, and use a database you are willing to share.

**Both platforms (build tools)**

- Node 24 or newer (`engines` in `package.json`) and pnpm 10.18 (`packageManager`).
- Rust (stable), installed with rustup.
- `pnpm install` run once in the project folder.
- `/releases/` in `.gitignore`. Builds put the finished installers and APKs in that folder, and they must not be committed.
- `public/fonts/NotoSansJP-Regular.ttf` and `src-tauri/binaries/SumatraPDF-x86_64-pc-windows-msvc.exe` present. Both are committed to the repo.

**Windows build**

- WebView2 and the MSVC build tools (Tauri's Windows prerequisites).

**Linux build** (by hand, on a Linux machine)

- The Tauri Linux packages that CI installs: `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (Debian/Ubuntu names).

**Android build**

- Android Studio with an SDK platform, Build-Tools and the NDK (CI uses NDK 27.0.12077973), plus JDK 17.
- Environment variables `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`.
- The four Android Rust targets, because the release APK is built for all of them:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

- Windows Developer Mode turned on, once per PC. Without it the build stops with `Creation symbolic link is not allowed for this system`.
- The Android project committed at `src-tauri/gen/android`. If it is missing, run `pnpm android:init` and commit the result.

## Release checklist

1. **Run the tests.** Nothing in CI does it for you, so run them here:

   ```powershell
   pnpm test          # 218 unit tests, including the SQL in src/db run against a local file
   pnpm typecheck
   cargo test --manifest-path src-tauri/Cargo.toml --lib
   pnpm test:e2e      # 23 Playwright tests; needs `npx playwright install chromium` once
   pnpm test:db       # optional, but the only thing that checks the real schema
   ```

   `pnpm test:e2e` starts its own fake database, so it never touches the real one. `pnpm test:db`
   uses the real one and cleans up the account it makes.

2. **Bump the version, commit it and create the tag.** Pick major, minor or patch:

   ```powershell
   pnpm version:minor --tag     # 0.1.0 -> 0.2.0, commits "Release v0.2.0" and creates the tag v0.2.0
   ```

   The other forms are `pnpm version:major`, `pnpm version:patch` and `pnpm version:set 1.2.3`. Add
   `--dry-run` to preview without writing. The script updates `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the app's entry in `src-tauri/Cargo.lock`,
   and it never pushes. Versions must be plain `x.y.z`, because the MSI installer does not accept
   suffixes such as `-beta`. To do it by hand instead, set the same version in those files (run
   `cargo check` in `src-tauri` to refresh the lock file), commit, and run `git tag v0.2.0`.

3. **Push and wait for the workflows.** Once the `if: false` lines are removed, a tag starts the
   `Release` run: the Windows job runs first, then the Android job (`needs: windows`) so both attach
   to the same draft release.

4. **Open the draft release and check its contents:** the NSIS `.exe`, the `.msi`, and one APK per
   CPU type — four of them, not one universal APK.

5. **Sign in once on a clean device before printing anything.** The app now opens on a sign-in
   screen; printing is unreachable until there is an account. Then install each build on a clean
   machine or phone, print a test label, and publish the draft.

## Building by hand

Run these from the project folder, the one containing `package.json` and `src-tauri`. Builds bundle
the frontend into the app, so they need no dev server. They do need `.env` (see above).

| Command                    | Produces                                                                                                | Build output folder                                              |
|----------------------------|---------------------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `pnpm build:windows`       | NSIS installer and MSI                                                                                  | `src-tauri\target\release\bundle\`                               |
| `pnpm build:linux`         | `.deb`, `.rpm` and AppImage. Run it on a Linux machine; the app cannot print on Linux yet               | `src-tauri/target/release/bundle/`                               |
| `pnpm build:android:debug` | Debug APK for 64-bit phones (aarch64), signed with the debug key, installs straight away                | `src-tauri\gen\android\app\build\outputs\apk\universal\debug\`   |
| `pnpm build:android`       | Release APKs, one per CPU type (aarch64, armv7, i686, x86_64), unsigned until signing is set up         | `src-tauri\gen\android\app\build\outputs\apk\`                   |
| `pnpm build:android:aab`   | Play Store bundle                                                                                       | `src-tauri\gen\android\app\build\outputs\bundle\`                |
| `pnpm dev:android`         | Runs on a connected phone from your PC's dev server. Not a release; the phone must be on the same Wi-Fi | none                                                             |

After each `build:*` script finishes, `scripts/collect-releases.mjs` **moves** the finished files into
`releases\` (git-ignored), so the folders in the last column are empty afterwards. Desktop installers
keep their names. Android files get the app name and version prepended, because Gradle always calls
them `app-<abi>-release.apk`; with `--split-per-abi` there is one per CPU type, for example
`q-print_0.2.0_aarch64-release.apk` alongside `app-x86_64-release.apk`. Desktop installers are only
taken when their name contains the version from `tauri.conf.json`, so leftovers from older builds are
ignored.

### Why the Android build changed

The release APK used to be universal — four copies of the Rust library in one file. It is now built
with `--split-per-abi`, so each device downloads only its own. Two things cut the size on the way in:

- The Designer is loaded on demand, so a phone never downloads it (Android cannot show it at all):
  about 2.9 MB at start-up instead of 7.8 MB.
- `src-tauri/Cargo.toml` sets a release profile with `lto`, `codegen-units = 1`, `opt-level = "s"`
  and `strip`. The Rust library went from 5.5 MB to 0.9 MB, and that saving is paid once per
  architecture.

See the README for the full account, including the two savings deliberately not taken.

**Other scripts:** `pnpm typecheck` (TypeScript only), `pnpm icons` (regenerates app icons from
`app-icon.png`), `pnpm android:init` (creates `src-tauri/gen/android`), and the database helpers
`pnpm db:generate`, `pnpm db:migrate` and `pnpm db:studio`.

**Release helpers:** `pnpm version:major`, `version:minor`, `version:patch` and `version:set` (see the
checklist), `pnpm releases:collect` (moves existing build output into `releases\`; add `--copy` to
keep the originals or `--dry-run` to preview) and `pnpm releases:clean` (empties `releases\` after
asking; `--yes` skips the question, `--dry-run` only lists). To rename the app, run
`node scripts/rename-app.mjs --name "New Name"` (try `--dry-run` first). It leaves the app identifier
alone unless you pass `--id`, because changing the identifier makes Android treat the app as a new app
and moves the folder that holds saved printers and the built-in label's layout.

**Database schema changes** must never be hand-edited into `db/migrations/`. Edit
`src/db/schema.ts`, run `pnpm db:generate`, and commit the result. The app applies outstanding
migrations itself at start-up, so an existing database gets them on next launch.

## Signing the Android release

Android refuses to install an unsigned APK, so a release build needs a keystore. Do this once. Signing
is not set up in CI yet, so the APK attached to a draft release is still unsigned.

1. Create the keystore. Back it up and its passwords somewhere safe: if you lose it, you cannot update
   the app under the same signature.

   ```powershell
   keytool -genkey -v -keystore $HOME\upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```

2. Create `src-tauri/gen/android/keystore.properties`. It is git-ignored and must never be committed:

   ```
   storePassword=YOUR_PASSWORD
   keyPassword=YOUR_PASSWORD
   keyAlias=upload
   storeFile=C:\\Users\\YOU\\upload-keystore.jks
   ```

3. In `src-tauri/gen/android/app/build.gradle.kts`, add `import java.io.FileInputStream` at the top and
   a `signingConfigs` block inside `android { }` that reads `keystore.properties`. Then point the
   release build type at it with `signingConfig = signingConfigs.getByName("release")`. Use the exact
   block from Tauri's "Android Code Signing" page, because the generated file can change between Tauri
   CLI versions.
4. Run `pnpm build:android`. Each signed APK is moved to `releases\q-print_<version>_<abi>-release.apk`.

To sign in CI, store the keystore (base64) and passwords as GitHub secrets and write them out before
the build step. That step is not written yet.

## Installing and testing on a phone

For a quick test, install over USB. Turn on USB debugging on the phone and accept the prompt when you
plug it in.

```powershell
pnpm build:android:debug
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r releases\q-print_<version>_android-universal-debug.apk
```

The build moves the debug APK into `releases\` and adds the app name and version to its file name, so
use the current version in the path above.

To install without a PC, copy the APK to the phone, tap it and allow "install unknown apps" when asked.
A release APK must be signed first (see the signing section). Each APK is per-CPU-type, so install the
one matching the phone (arm64 for any recent device).

Test in this order:

1. **Sign in.** The app opens on a sign-in screen. Create an account, or sign in with one you already
   have. Nothing is reachable before this, so it is the first failure to notice.
2. **Print 3 pages** to "Save as PDF" in the system dialog and check the page count, the label size,
   Japanese text and barcodes.
3. Print to a real printer through an Android print service (Mopria or the printer maker's plugin).
4. **Check the label list** against what you see in the Designer on the desktop: the two are the same
   account's labels, and a label created or deleted on one shows up on the other.
5. Print 100 pages and note the time and memory use.
6. Install the release build on a clean phone and repeat the real-printer test.

If the app opens to an error page, collect a log and send it with the bug report:

```powershell
adb logcat -c
# open the app so the error appears, then:
adb logcat -d -s RustStdoutStderr AndroidRuntime chromium
```

## Known issues and troubleshooting

| Issue                                                                                                                                  | Status                                                                                                                                                                                      | Next step                                                                                           |
|----------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Every job in `ci.yml` and `release.yml` has `if: false`, so no check runs and a tag produces no release                                 | Open. Remove the lines marked `TEMPORARILY DISABLED`                                                                                | Then add a step writing `.env` from secrets before the build                                        |
| Release APKs are unsigned, so they cannot be installed                                                                                  | Open                                                                                                                                                                                        | Set up signing (above), then add the signing step to `release.yml`                                   |
| No test step in CI, so nothing is checked on push or on a tag                                                                          | Open. `ci.yml`'s `tests` job exists but is disabled like the rest                                                                   | Re-enable the job; it needs `playwright install` for the E2E run                                    |
| The Turso token ships inside the frontend bundle                                                                                       | Accepted for now, recorded in `AUTH_AND_DATABASE_PLAN.md` §7                                                                                                                                    | Put a server in front before this reaches real users                                                 |
| The build needs `.env` or `VITE_TURSO_URL`/`VITE_TURSO_TOKEN`, and a release build baked without them signs in to nothing  | Open. Not yet in the workflow                                                                                                    | Write `.env` from `TURSO_URL` and `TURSO_TOKEN` secrets in both workflows                            |
| The app shows "The webpage at http://tauri.localhost could not be loaded" on a Pixel 4a                                              | Open, from before the sign-in change. A missing `.env` is a new candidate cause: the app would build but the sign-in screen would stay disabled | Capture `adb logcat` from the testing section; also check `.env` was present at build time           |
| The Linux build cannot print: `print_other.rs` returns "printing is not implemented on this platform yet"                             | Open. The app starts and the Designer works, but the printer list is empty                                                                                                                    | Add a CUPS backend (`lpstat` and `lp`) and turn on the printer list for Linux in `capabilities()`    |

**Common build errors**

- `Creation symbolic link is not allowed for this system`: turn on Windows Developer Mode and reopen the terminal.
- `resource path binaries\SumatraPDF-... doesn't exist`: the SumatraPDF exe is missing from `src-tauri/binaries`.
- The app signs in to nothing, or the sign-in screen says *"the database is not set up"*: `.env` was missing when the build ran. Copy `.env.example` to `.env`, fill it in, and build again. Note that a stale webview cache can keep showing the old build, so uninstall before reinstalling.
- `adb devices` shows `unauthorized` or nothing: unlock the phone, accept the USB debugging prompt, or try another cable or USB mode (File transfer).
- App opens a blank page during `pnpm dev:android`: the phone cannot reach the dev server. Use the same Wi-Fi and allow ports 1420-1421 in Windows Firewall.
- An installed APK that worked before now shows an empty label list: the label is under a different account. Sign in as the account that created it, or use **Reload labels** on the Print tab.
