#!/usr/bin/env node
/**
 * Moves the build outputs into ./releases after a build.
 *
 *   node scripts/collect-releases.mjs                 # everything it can find
 *   node scripts/collect-releases.mjs windows         # only Windows installers
 *   node scripts/collect-releases.mjs android linux   # several platforms
 *   node scripts/collect-releases.mjs --copy          # copy instead of move
 *   node scripts/collect-releases.mjs --dry-run       # show what would happen
 *
 * What it picks up (all under src-tauri/):
 *   windows  target/release/bundle/msi/*.msi   (MSI only: see tauri.windows.conf.json)
 *   linux    target/release/bundle/deb/*.deb, bundle/rpm/*.rpm, bundle/appimage/*.AppImage
 *   android  gen/android/app/build/outputs/**\/*.apk and *.aab
 *
 * Desktop installers are only taken when their file name contains the current version (from
 * tauri.conf.json), so leftovers from older builds are never mixed in. Android files get the
 * app name and version prepended, because Gradle names them app-universal-release.apk every time.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'src-tauri');
const outDir = join(root, 'releases');

const args = process.argv.slice(2);
const copyOnly = args.includes('--copy');
const dryRun = args.includes('--dry-run');
const requested = args.filter((a) => !a.startsWith('--'));
const ALL = ['windows', 'linux', 'android'];
for (const p of requested)
  if (!ALL.includes(p)) {
    console.error(`Unknown platform "${p}". Use: ${ALL.join(', ')}`);
    process.exit(1);
  }
const platforms = requested.length ? requested : ALL;

const version = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8')).version;
const slug = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;

/** Files directly inside `dir` (not recursive) with one of the extensions. */
const filesIn = (dir, exts) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && exts.some((x) => e.name.endsWith(x)))
        .map((e) => join(dir, e.name));

/** Files anywhere below `dir` with one of the extensions. */
const walk = (dir, exts) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p, exts) : exts.some((x) => e.name.endsWith(x)) ? [p] : [];
      });

// target/release/bundle, plus target/<triple>/release/bundle for `--target` builds.
const target = join(tauri, 'target');
const bundleRoots = [
  join(target, 'release', 'bundle'),
  ...(existsSync(target)
    ? readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(target, e.name, 'release', 'bundle'))
    : []),
].filter(existsSync);

const versioned = (files) => files.filter((f) => basename(f).includes(version));
const desktop = (sub, exts) =>
  versioned(bundleRoots.flatMap((r) => filesIn(join(r, sub), exts))).map((src) => ({ src, name: basename(src) }));

const sources = {
  // MSI only. The NSIS `.exe` was dropped deliberately, so collecting one would only ever pick up
  // a leftover from an older build and ship it beside the real installer.
  windows: () => desktop('msi', ['.msi']),
  linux: () => [...desktop('deb', ['.deb']), ...desktop('rpm', ['.rpm']), ...desktop('appimage', ['.AppImage'])],
  android: () =>
    walk(join(tauri, 'gen', 'android', 'app', 'build', 'outputs'), ['.apk', '.aab']).map((src) => ({
      src,
      name: `${slug}_${version}_${basename(src).replace(/^app-/, 'android-')}`,
    })),
};

let total = 0;
let missing = false;
for (const platform of platforms) {
  const found = sources[platform]();
  if (!found.length) {
    console.log(`${platform}: nothing found`);
    if (requested.length) missing = true;
    continue;
  }
  for (const { src, name } of found) {
    const dest = join(outDir, name);
    console.log(
      `${platform}: ${dryRun ? 'would ' : ''}${copyOnly ? 'copy' : 'move'} ${src.slice(root.length + 1)} -> releases/${name}`,
    );
    if (!dryRun) {
      mkdirSync(outDir, { recursive: true });
      cpSync(src, dest, { force: true }); // copy + delete also works across drives, unlike rename
      if (!copyOnly) rmSync(src);
    }
    total++;
  }
}
console.log(total ? `\n${total} file(s) in ${outDir}` : '\nNo build outputs found. Did the build finish?');
if (missing) process.exit(1);
