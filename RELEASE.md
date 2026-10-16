# Q-Print Release Guide

Oct 15, 2026 · @Rafi

## Overview

Pushing a version tag such as `v0.2.0` builds the Windows installers and a signed Android APK on GitHub Actions and attaches both to one draft release. You review the draft, then publish it. **Only tags on commits that are on `main` produce a release:** a `verify-main` job runs first and fails the run for any other tag.

- **Windows:** NSIS installer (`.exe`) and `.msi`. SumatraPDF is bundled with the app and does the silent printing.
- **Android:** one APK that opens the system print dialog (no silent printing on Android). The release workflow signs it with your keystore (see "GitHub secrets" below). A release built by hand is unsigned until you set up local signing.
- **Linux:** the release workflow does not build it. You can build `.deb`, `.rpm` and AppImage packages by hand on a Linux machine (`pnpm build:linux`), but printing is not implemented on Linux yet: the app opens and the Designer works, but nothing prints.
- **Trigger:** `.github/workflows/release.yml`, on any tag matching `v*` that points at a commit on `main`. Normal pushes and pull requests only run `ci.yml`, which checks the build and compiles a debug APK.

## Prerequisites

Releases built by GitHub Actions need nothing on your PC. Building by hand needs the tools below.

**Both platforms**

- Node 24 or newer (`engines` in `package.json`) and pnpm 10.18 (`packageManager`).
- Rust (stable), installed with rustup.
- `pnpm install` run once in the project folder.
- `/releases/` in `.gitignore`. Builds put the finished installers and APKs in that folder (see "Building by hand"), and they must not be committed.
- `public/fonts/NotoSansJP-Regular.ttf` and `src-tauri/binaries/SumatraPDF-x86_64-pc-windows-msvc.exe` present. Both are committed to the repo.

**Windows build**

- WebView2 and the MSVC build tools (Tauri's Windows prerequisites).

**Linux build** (by hand, on a Linux machine)

- The Tauri Linux packages that CI installs: `libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (Debian/Ubuntu names).

**Android build**

- Android Studio with an SDK platform, Build-Tools and the NDK (CI uses NDK 27.0.12077973), plus JDK 17.
- Environment variables `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`.
- The four Android Rust targets:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

- Windows Developer Mode turned on, once per PC. Without it the build stops with `Creation symbolic link is not allowed for this system`.
- The Android project committed at `src-tauri/gen/android`. If it is missing, run `pnpm android:init` and commit the result.

## GitHub secrets

The release workflow reads these repository secrets (GitHub: Settings > Secrets and variables > Actions). Without them the build stops early with a message naming the missing one.

| Secret                       | Used for                                                              |
|------------------------------|-----------------------------------------------------------------------|
| `VITE_TURSO_URL`             | Written to `.env` before each build, so sign-in and labels work       |
| `VITE_TURSO_TOKEN`           | Same. It is compiled into the app, so anyone with the APK can read it |
| `ANDROID_KEYSTORE_BASE64`    | The keystore file, base64-encoded, as one line                        |
| `ANDROID_KEYSTORE_PASSWORD`  | The keystore password                                                 |
| `ANDROID_KEY_ALIAS`          | The key alias, for example `upload`                                   |
| `ANDROID_KEY_PASSWORD`       | The key password                                                      |
| `WINDOWS_CERTIFICATE_BASE64` | The code-signing certificate (`.pfx`), base64-encoded, as one line    |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password                                                 |

Create the keystore value in PowerShell. A `.jks` file is binary, so it looks like random characters in a text editor; the secret must hold its base64 text instead:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\upload-keystore.jks")) | Set-Clipboard
```

Paste the result into `ANDROID_KEYSTORE_BASE64`. Do not use `certutil -encode`: it adds header lines that the workflow cannot decode. Check that the passwords and alias match the keystore with `keytool -list -keystore "$HOME\upload-keystore.jks"`.

### Windows code signing ("Unknown publisher")

An unsigned installer makes Windows show **Unknown publisher** in the UAC prompt and a SmartScreen warning. The `windows` job fixes this by importing the certificate, putting its thumbprint into `src-tauri/tauri.windows.conf.json` and letting `tauri build` sign `q-print.exe`, the NSIS installer and the MSI. A final step checks every signature and fails the run if one is not `Valid`.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\codesign.pfx")) | Set-Clipboard
```

Paste the result into `WINDOWS_CERTIFICATE_BASE64`. Notes:

- `bundle.publisher` in `tauri.windows.conf.json` is the name shown in Apps > Installed apps. The name in the UAC prompt comes from the certificate subject, so keep the two the same.
- Local `pnpm build:windows` stays unsigned because the committed config has `certificateThumbprint: null`.
- A new OV/EV certificate cannot be exported as a `.pfx` (the key lives on a hardware token or cloud HSM). If yours is one of those, replace the import step with your provider's tool and set `bundle.windows.signCommand` instead.
- SmartScreen reputation: an OV certificate can still show a warning for the first downloads. An EV certificate removes it immediately.

### Getting a `.pfx` certificate

A `.pfx` file holds the code-signing certificate and its private key. Since mid-2023, newly issued OV and EV certificates must keep the key on a hardware token or in a cloud service, so the CA will not hand you a `.pfx` for those. Pick the case that matches you:

**1. You already have a certificate on your PC.** Press Win+R, run `certmgr.msc` and open Personal > Certificates. Right-click the code-signing certificate, then All Tasks > Export. Choose "Yes, export the private key", then "Personal Information Exchange (.pfx)", set a password and save the file (for example `codesign.pfx`). If "Export the private key" is greyed out, the key is non-exportable or on a token, and you cannot make a `.pfx`.

**2. A self-signed certificate, for a group of PCs you control.** Only PCs that trust the certificate see "KEEX" instead of "Unknown publisher". The public still sees the warning. See "Self-signed signing for a group of PCs" below. The workflow's "Verify Windows signatures" step compares the signer thumbprint instead of requiring status `Valid`, because the runner does not trust a self-signed certificate.

**3. A trusted certificate for real distribution.** These all use a signing command or action instead of a `.pfx`, so replace the "Import Windows code-signing certificate" step in `release.yml` and set `bundle.windows.signCommand` in `tauri.windows.conf.json`:

- Azure Artifact Signing (formerly Trusted Signing): low monthly cost, made for GitHub Actions. It needs identity validation, and availability depends on country and organization type, so check that it accepts your company.
- A commercial CA (DigiCert, Sectigo, SSL.com, Certum): identity validation is required, and the key ships on a USB token or in the CA's cloud service. SSL.com eSigner and DigiCert KeyLocker both have CI options.

Keep the `.pfx` and its password somewhere safe, keep the file out of git, and delete the local copy when you no longer need it.

### Self-signed signing for a group of PCs

Do this once to sign with your own certificate and make your group's PCs trust it.

1. **Create the certificate** on your PC: `powershell -ExecutionPolicy Bypass -File scripts\new-selfsigned-cert.ps1`. It writes `qprint-codesign.pfx` (private) and `qprint-codesign.cer` (public) to your home folder and copies the `.pfx` as base64 to the clipboard. The subject defaults to `CN=KEEX`; keep it equal to `bundle.publisher` in `tauri.windows.conf.json`.
2. **Add the two secrets** `WINDOWS_CERTIFICATE_BASE64` (paste) and `WINDOWS_CERTIFICATE_PASSWORD`, as described in "Adding the Windows secrets on GitHub".
3. **Tag a release.** The `windows` job signs `q-print.exe`, the NSIS installer and the MSI, then checks that each carries your certificate.
4. **Trust the certificate on each PC** (once, as Administrator): copy `qprint-codesign.cer` and `scripts\install-cert.ps1` to the PC, then run `powershell -ExecutionPolicy Bypass -File install-cert.ps1 -CerPath .\qprint-codesign.cer`. It adds the certificate to Trusted Root Certification Authorities and Trusted Publishers. Or push the `.cer` to every PC with Group Policy or Intune.
5. Install the new build. The UAC prompt now shows **Verified publisher: KEEX**.

Notes:

- The `.pfx` is the private key. Keep it out of git and store a backup in a password manager. If it leaks, anyone can sign software that your PCs trust: remove the `.cer` from the PCs and make a new certificate.
- Test on one PC first. If SmartScreen still blocks a downloaded file, right-click the file > Properties > Unblock, or hand the installer over by USB or network share.
- The certificate expires after 5 years by default. Installers stay valid after expiry because the build is timestamped (`tsp: true`), but you need a new certificate and a new `.cer` on the PCs for later builds.
- This does not help people outside your group. For public downloads, use Azure Artifact Signing or a commercial certificate (case 3 above).

### Adding the Windows secrets on GitHub

1. Create the base64 text (command above). It lands in your clipboard as one line.
2. On GitHub open the repository, then Settings > Secrets and variables > Actions.
3. New repository secret: name `WINDOWS_CERTIFICATE_BASE64`, paste the clipboard text, Add secret.
4. New repository secret: name `WINDOWS_CERTIFICATE_PASSWORD`, type the `.pfx` password, Add secret.
5. Check the names. They are case-sensitive, and a typo stops the Windows job with `Missing repository secret ...`.
6. Push a version tag from `main` (see the checklist below). In the run log, "Import Windows code-signing certificate" prints the certificate subject and "Verify Windows signatures" lists `Valid` for each file.

## Release checklist

A release is a version bump, a tag and a review of the draft.

1. Confirm the latest `CI` run on `main` is green (lint, unit tests, frontend build, Rust checks, debug APK, e2e). Note that every job in `ci.yml` is currently disabled with `if: false`, so there is no run to check until those lines are removed.
2. Bump the version, commit it and create the tag, all from `main`. Pick major, minor or patch:

```powershell
pnpm version:minor --tag     # 0.1.0 -> 0.2.0, commits "Release v0.2.0" and creates the tag v0.2.0
```

The other forms are `pnpm version:major`, `pnpm version:patch` and `pnpm version:set 1.2.3`. Add `--dry-run` to preview without writing. The script updates `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the app's entry in `src-tauri/Cargo.lock`, and it never pushes. Versions must be plain `x.y.z`, because the MSI installer does not accept suffixes such as `-beta`. To do it by hand instead, set the same version in those files (run `cargo check` in `src-tauri` to refresh the lock file), commit, and run `git tag v0.2.0`.

3. Push the version commit and wait for `CI` on `main` to pass:

```powershell
git push origin main
```

4. Push the tag. This starts the release build:

```powershell
git push origin v0.2.0
```

5. Watch the `Release` run. `verify-main` checks the tag is on `main`, then the Windows job runs, then the Android job starts (`needs: windows`) so both attach to the same draft release. The Android job signs the APK before it uploads it.
6. Open the draft release "Q-Print v0.2.0" on GitHub and check that it holds the NSIS `.exe`, the `.msi` and the signed `.apk`.
7. Install each build once on a clean machine or phone, print a test label, then publish the draft.

## Building by hand

Run these from the project folder, the one containing `package.json` and `src-tauri`. Builds bundle the frontend into the app, so they need no dev server.

| Command                    | Produces                                                                                                | Build output folder                                              |
|----------------------------|---------------------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `pnpm build:windows`       | NSIS installer and MSI                                                                                  | `src-tauri\target\release\bundle\`                               |
| `pnpm build:linux`         | `.deb`, `.rpm` and AppImage. Run it on a Linux machine; the app cannot print on Linux yet               | `src-tauri/target/release/bundle/`                               |
| `pnpm build:android:debug` | Debug APK for 64-bit phones (aarch64), signed with the debug key, installs straight away                | `src-tauri\gen\android\app\build\outputs\apk\universal\debug\`   |
| `pnpm build:android`       | Release APK for all four CPU types, unsigned until signing is set up                                    | `src-tauri\gen\android\app\build\outputs\apk\universal\release\` |
| `pnpm build:android:aab`   | Play Store bundle                                                                                       | `src-tauri\gen\android\app\build\outputs\bundle\`                |
| `pnpm dev:android`         | Runs on a connected phone from your PC's dev server. Not a release; the phone must be on the same Wi-Fi | none                                                             |

After each `build:*` script finishes, `scripts/collect-releases.mjs` **moves** the finished files into `releases\` (git-ignored), so the build output folder in the last column is empty afterwards. Desktop installers keep their names. Android files are renamed with the app name and version, for example `q-print_0.2.0_android-universal-release.apk`, because Gradle always calls them `app-universal-release.apk`. Desktop installers are only taken when their name contains the version from `tauri.conf.json`, so leftovers from older builds are ignored.

Other scripts: `pnpm typecheck` (TypeScript only), `pnpm icons` (regenerates app icons from `app-icon.png`) and `pnpm android:init` (creates `src-tauri/gen/android`).

Release helpers: `pnpm version:major`, `version:minor`, `version:patch` and `version:set` (see the checklist), `pnpm releases:collect` (moves existing build output into `releases\`; add `--copy` to keep the originals or `--dry-run` to preview) and `pnpm releases:clean` (empties `releases\` after asking; `--yes` skips the question, `--dry-run` only lists). To rename the app, run `node scripts/rename-app.mjs --name "New Name"` (try `--dry-run` first). It leaves the app identifier alone unless you pass `--id`, because changing the identifier makes Android treat the app as a new app and moves the folder that holds saved printers and the label template.

## Signing the Android release

Android refuses to install an unsigned APK, so a release build needs a keystore. Create it once. GitHub Actions signs release APKs with the secrets above, so steps 2 and 3 below are only for signing a build made on your own PC.

1. Create the keystore. Back it up and its passwords somewhere safe: if you lose it, you cannot update the app under the same signature.

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

3. In `src-tauri/gen/android/app/build.gradle.kts`, add `import java.io.FileInputStream` at the top and a `signingConfigs` block inside `android { }` that reads `keystore.properties`. Then point the release build type at it with `signingConfig = signingConfigs.getByName("release")`. Use the exact block from Tauri's "Android Code Signing" page, because the generated file can change between Tauri CLI versions.
4. Run `pnpm build:android`. The build moves the signed APK to `releases\q-print_<version>_android-universal-release.apk`.

**In CI** none of steps 2 to 4 are needed. The "Sign the APK" step in `release.yml` decodes `ANDROID_KEYSTORE_BASE64`, signs every APK in `releases/` with `apksigner`, verifies the signature and deletes the keystore from the runner. It does not use `keystore.properties` or `build.gradle.kts`. The build moves the APK into `releases/` first, so that folder is what the workflow signs and uploads.

## Installing and testing on a phone

For a quick test, install over USB. Turn on USB debugging on the phone and accept the prompt when you plug it in.

```powershell
pnpm build:android:debug
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r releases\q-print_0.1.0_android-universal-debug.apk
```

The build moves the debug APK into `releases\` and adds the app name and version to its file name, so use the current version in the path above.

To install without a PC, copy the APK to the phone, tap it and allow "install unknown apps" when asked. A release APK must be signed first (see the signing section).

Test in this order:

1. Print 3 pages to "Save as PDF" in the system dialog and check the page count, the label size, Japanese text and barcodes.
2. Print to a real printer through an Android print service (Mopria or the printer maker's plugin).
3. Print 100 pages and note the time and memory use.
4. Install the release build on a clean phone and repeat the real-printer test.

If the app opens to an error page, collect a log and send it with the bug report:

```powershell
adb logcat -c
# open the app so the error appears, then:
adb logcat -d -s RustStdoutStderr AndroidRuntime chromium
```

## Labels that read a web API

- **Compatibility:** a label whose generator uses the `api` rule cannot be imported by an older version of the app. The older app does not know the rule and refuses the import with an "unknown rule" message instead of printing it wrongly. Labels made before this feature open and print the same in the new version. No database migration is involved.
- **Breaking change, no data migration needed:** a label no longer stores its API address. The address, its list path and its access token are typed on the Print tab instead, and are never saved. A label that read from an API therefore prints only once you give it an address. An exported label file from an earlier build still imports — its stored `source` entry is dropped, since nothing reads it now.
- **HTTPS from Rust:** the app makes the request in Rust (`src-tauri/src/http.rs`) with `ureq` and its `tls` feature, which pulls in `rustls` and `ring` (C code in the Android NDK build). If an Android build breaks after a dependency update, look here first.
- **Before publishing a draft, on each platform you ship (Windows, Android):** print a label that reads a real https API with and without a bearer token, try a wrong token (expect "HTTP 401 ... Check the access token."), an unreachable host (expect a clear message within about 15 seconds), a one-record (object) response, and 100 records × 3 copies.
- **The token** is never stored or exported. If a report or log ever shows one, treat it as a bug.

## Print history

The History tab lists the last 200 print attempts from the device. Read-only, and deliberately not in the database.

- **Device-local, like the session and the last-used label:** one `localStorage` key per account, `q-print.history.<user id>`. Clearing app data or site data clears it; it is not restored from a backup or shared between accounts. This is the right trade for an aid to "did that run go out, and to what" — a shared record would have needed a table, a sync story, and a migration, for information only the person at the printer wants.
- **Successes and failures are both kept.** A failure stores the message and how long it took to fail; it has no page count or transport, because nothing left the app. A form validation error (a blank API address) is *not* recorded — nothing was attempted.
- **Nothing sensitive is stored.** The label name, the printer name, counts, timings and the transport. Not the API address and not the access token — those are never written anywhere, as described under "Labels that read a web API".
- **Before publishing:** print once from each platform and confirm an entry appears on the History tab, including after a restart. Printing on the web build is not possible, so the tab is always empty there.

## Keeping the app reachable in the background

Put the app away and it stays reachable: a tray icon on desktop, a notification on Android. Both offer
Open and Exit. Nothing in the frontend is involved — each platform's half looks after itself.

- **Desktop** (Windows, Linux, macOS). Closing the window hides it; the app keeps running and stays in the tray. **Exit is only in the tray menu** — there is nowhere else to find it, so a Windows user has to look there to quit. `src-tauri/src/tray.rs`.
- **Android.** A foreground service, `BackgroundService.kt`, started from `MainActivity.onUserLeaveHint` and stopped in `onStart`. A foreground service needs both `FOREGROUND_SERVICE` and, on Android 14+, a named type (`FOREGROUND_SERVICE_DATA_SYNC`), plus `POST_NOTIFICATIONS` as a runtime grant from Android 13. The user is asked on first launch; refusing it leaves the app working but unrecoverable once it is backgrounded.
- **Why a service and not just a notification:** Android freezes an app it has put away and then kills it, so a notification on its own is a dead end. This has never been run on a device from this repository — see the open item below.
- **`onUserLeaveHint`, not `onStop`:** `onStop` also fires when another activity is put on top, and the Android print dialog does exactly that. Using `onStop` would pop the background notification on every single print.
- **The tray icon has not been visually verified** — the build machine has no display.

**Before shipping, on each platform you ship (Windows, Android):** put the app away and check that
Open brings it back, that Exit actually ends it, and that the way back in is not the only copy of an
unfinished print. On Android, leave the app backgrounded for several minutes first, because the
freeze that a plain notification would not survive takes that long to arrive.

## Known issues and troubleshooting

One bug is open and blocks a trusted Android release: the debug APK shows an error page on a Pixel 4a.

| Issue                                                                                                                                  | Status                                                                                                                                                                                      | Next step                                                                                           |
|----------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| The app shows "The webpage at http://tauri.localhost could not be loaded" on a Pixel 4a, using the APK from `pnpm build:android:debug` | Open. Not caused by the dev server, release minification, cleartext rules or CPU type (the Pixel 4a is 64-bit ARM). A startup crash on the Rust side is the likely cause but is unconfirmed | Capture the `adb logcat` output from the testing section and look for `panicked at` or an exception |
| Release APK from CI is unsigned                                                                                                        | Fixed in `release.yml`. It needs the four `ANDROID_*` secrets (see "GitHub secrets")                                                                                                        | Tag from `main` and check the APK installs. Builds made by hand still need local signing            |
| Every job in `ci.yml` has `if: false`, so no check runs on push or pull request                                                        | Open                                                                                                                                                                                        | Remove the `if: false` lines in `ci.yml`                                                            |
| CI and `package.json` changes from this guide (new scripts, `gradlew` fix, release job order) are in `q-print-ci-and-scripts.patch`    | Not merged                                                                                                                                                                                  | Apply the patch, then commit and push                                                               |
| The Linux build cannot print: `print_other.rs` returns "printing is not implemented on this platform yet"                              | Open. The app starts and the Designer works, but the printer list is empty                                                                                                                  | Add a CUPS backend (`lpstat` and `lp`) and turn on the printer list for Linux in `capabilities()`   |
| The tray icon and the Android background notification have never been run on a real device or desktop session                                    | Open. No display on the build machine and no Android SDK, so neither has been observed working                                                                                             | Follow the checklist under "Keeping the app reachable in the background"                            |

**Release workflow errors**

- `base64: invalid input` in "Sign the APK": `ANDROID_KEYSTORE_BASE64` does not hold base64 text. Recreate it with the PowerShell command under "GitHub secrets" and paste it as one line.
- `Missing repository secret ...` or `Add VITE_TURSO_URL and VITE_TURSO_TOKEN ...`: the named secret is empty or has a different name. Secret names are case-sensitive.
- `Tag ... is not on main`: the tag points at a commit that is not on `main`. Merge to `main`, then delete and recreate the tag (`git tag -d v0.2.0`, `git push origin :refs/tags/v0.2.0`, `git tag v0.2.0`, `git push origin v0.2.0`).
- Re-running a failed run reuses the workflow file from the tagged commit. After fixing the workflow itself, recreate the tag on the fixed commit. After fixing only a secret, **Re-run failed jobs** is enough.

**Common build errors**

- `Creation symbolic link is not allowed for this system`: turn on Windows Developer Mode and reopen the terminal.
- `resource path binaries\SumatraPDF-... doesn't exist`: the SumatraPDF exe is missing from `src-tauri/binaries`.
- `adb devices` shows `unauthorized` or nothing: unlock the phone, accept the USB debugging prompt, or try another cable or USB mode (File transfer).
- App opens a blank page during `pnpm dev:android`: the phone cannot reach the dev server. Use the same Wi-Fi and allow ports 1420-1421 in Windows Firewall.
