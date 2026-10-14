# Q-Print Release Guide

Oct 14, 2026 · @Rafi

## Overview

Pushing a version tag such as `v0.2.0` builds the Windows installers and an Android APK on GitHub Actions and attaches both to one draft release. You review the draft, then publish it.

- **Windows:** NSIS installer (`.exe`) and `.msi`. SumatraPDF is bundled with the app and does the silent printing.
- **Android:** one APK that opens the system print dialog (no silent printing on Android). A release APK is unsigned until you set up signing, so it cannot be installed as it comes out of CI.
- **Linux:** the release workflow does not build it. You can build `.deb`, `.rpm` and AppImage packages by hand on a Linux machine (`pnpm build:linux`), but printing is not implemented on Linux yet: the app opens and the Designer works, but nothing prints.
- **Trigger:** `.github/workflows/release.yml`, on any tag matching `v*`. Normal pushes and pull requests only run `ci.yml`, which checks the build and compiles a debug APK.

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

## Release checklist

A release is a version bump, a tag and a review of the draft.

1. Confirm the latest `CI` run on `main` is green (frontend build, Rust checks, debug APK).
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

5. Watch the `Release` run. The Windows job runs first, then the Android job starts (`needs: windows`) so both attach to the same draft release.
6. Open the draft release "Q-Print v0.2.0" on GitHub and check that it holds the NSIS `.exe`, the `.msi` and the `.apk`.
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

Android refuses to install an unsigned APK, so a release build needs a keystore. Do this once. Signing is not set up in CI yet, so the APK attached to a draft release is still unsigned.

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

To sign in CI, store the keystore (base64) and passwords as GitHub secrets and write them out before the build step. That step is not written yet.

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

## Known issues and troubleshooting

One bug is open and blocks a trusted Android release: the debug APK shows an error page on a Pixel 4a.

| Issue                                                                                                                                  | Status                                                                                                                                                                                      | Next step                                                                                           |
|----------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| The app shows "The webpage at http://tauri.localhost could not be loaded" on a Pixel 4a, using the APK from `pnpm build:android:debug` | Open. Not caused by the dev server, release minification, cleartext rules or CPU type (the Pixel 4a is 64-bit ARM). A startup crash on the Rust side is the likely cause but is unconfirmed | Capture the `adb logcat` output from the testing section and look for `panicked at` or an exception |
| Release APK is unsigned, so it cannot be installed                                                                                     | Open                                                                                                                                                                                        | Set up signing (see the signing section), then add the signing step to `release.yml`                |
| CI and `package.json` changes from this guide (new scripts, `gradlew` fix, release job order) are in `q-print-ci-and-scripts.patch`    | Not merged                                                                                                                                                                                  | Apply the patch, then commit and push                                                               |
| The Linux build cannot print: `print_other.rs` returns "printing is not implemented on this platform yet"                              | Open. The app starts and the Designer works, but the printer list is empty                                                                                                                  | Add a CUPS backend (`lpstat` and `lp`) and turn on the printer list for Linux in `capabilities()`   |

**Common build errors**

- `Creation symbolic link is not allowed for this system`: turn on Windows Developer Mode and reopen the terminal.
- `resource path binaries\SumatraPDF-... doesn't exist`: the SumatraPDF exe is missing from `src-tauri/binaries`.
- `adb devices` shows `unauthorized` or nothing: unlock the phone, accept the USB debugging prompt, or try another cable or USB mode (File transfer).
- App opens a blank page during `pnpm dev:android`: the phone cannot reach the dev server. Use the same Wi-Fi and allow ports 1420-1421 in Windows Firewall.
