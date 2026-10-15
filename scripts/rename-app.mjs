#!/usr/bin/env node
/**
 * Renames the app across the project.
 *
 *   node scripts/rename-app.mjs --name "Q-Print"
 *   node scripts/rename-app.mjs --name "Q-Print" --slug q-print --id com.mycompany.qprint
 *   node scripts/rename-app.mjs --name "Q-Print" --dry-run
 *
 * Options
 *   --name  <text>  Display name: window title, installer/product name, <title>, Android launcher name (both the app and the
 *                  main-activity label, which is the one launchers show). (required)
 *   --slug  <text>  Package/crate/exe name: lowercase letters, digits and dashes. Default: derived from --name.
 *   --id    <text>  App identifier, e.g. com.mycompany.qprint. Optional, see the warning below.
 *   --dry-run       Show what would change without writing anything.
 *
 * WARNING about --id: the identifier is the Android application ID and the name of the app-data folder
 * (%APPDATA%\<id>\ on Windows). Changing it makes Android treat the app as a different app and orphans the
 * saved printers and label template of existing installs. Leave it out unless you really want that.
 *
 * Not touched: the Android plugin package (com.example.printtest.print). It is internal, never shown to
 * users, and renaming it means moving Kotlin directories. Also not touched: .idea/ files.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f) => f.slice(root.length + 1).replaceAll('\\', '/');
const f = (...s) => join(root, ...s);

// ---- arguments ---------------------------------------------------------------------------------
const opts = { dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const [k, v] = argv[i].split(/=(.*)/s);
  if (k === '-h' || k === '--help') usage(0);
  else if (k === '--dry-run') opts.dryRun = true;
  else if (['--name', '--slug', '--id'].includes(k)) opts[k.slice(2)] = v ?? argv[++i];
  else fail(`Unknown option: ${argv[i]}`);
}

function usage(code) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .match(/\/\*\*([\s\S]*?)\*\//)[1]
      .replace(/^ \* ?/gm, '')
      .trim(),
  );
  process.exit(code);
}
function fail(msg) {
  console.error(`Error: ${msg}\n`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

const name = opts.name?.trim();
if (!name) fail('--name is required.');
if (/["<>&\\]/.test(name)) fail('--name must not contain " < > & or \\.');

const slug = (
  opts.slug ??
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
).trim();
if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
  fail(
    `Invalid slug "${slug}": use lowercase letters, digits and dashes, starting with a letter. Pass --slug to set it.`,
  );
}
const lib = `${slug.replaceAll('-', '_')}_lib`; // Rust lib name; the _lib suffix avoids a bin/lib name clash on Windows

const id = opts.id?.trim();
if (id && !/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(id)) {
  fail(`Invalid identifier "${id}". Expected something like com.mycompany.qprint.`);
}

// ---- helpers -----------------------------------------------------------------------------------
const changed = [];
const skipped = [];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads a file, applies fn(text) -> newText, writes it back when different. */
function edit(file, fn) {
  if (!existsSync(file)) {
    skipped.push(rel(file));
    return;
  }
  const before = readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) return;
  changed.push(rel(file));
  if (!opts.dryRun) writeFileSync(file, after);
}

/** Edits a JSON file, keeping 2-space indentation, the trailing newline and CRLF line endings. */
function editJson(file, fn) {
  edit(file, (text) => {
    const data = JSON.parse(text);
    fn(data);
    let out = JSON.stringify(data, null, 2) + (text.endsWith('\n') ? '\n' : '');
    if (text.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n');
    return out;
  });
}

// ---- read the current names --------------------------------------------------------------------
const cargoToml = f('src-tauri', 'Cargo.toml');
if (!existsSync(cargoToml)) fail('Run this from a Q-Print checkout (src-tauri/Cargo.toml not found).');
const cargoText = readFileSync(cargoToml, 'utf8');
const pkgRe = /(^\[package]\s*$[\s\S]*?^name\s*=\s*")([^"]+)(")/m;
const libRe = /(^\[lib]\s*$[\s\S]*?^name\s*=\s*")([^"]+)(")/m;
const oldSlug = cargoText.match(pkgRe)?.[2];
const oldLib = cargoText.match(libRe)?.[2];
if (!oldSlug || !oldLib) fail('Could not find the package/lib names in src-tauri/Cargo.toml.');
const conf = JSON.parse(readFileSync(f('src-tauri', 'tauri.conf.json'), 'utf8'));
const oldId = conf.identifier;

// ---- apply -------------------------------------------------------------------------------------
editJson(f('src-tauri', 'tauri.conf.json'), (c) => {
  c.productName = name;
  if (id) c.identifier = id;
  if (c.app?.windows?.[0]) c.app.windows[0].title = name;
});

editJson(f('package.json'), (p) => {
  p.name = slug;
});

edit(cargoToml, (t) => t.replace(pkgRe, `$1${slug}$3`).replace(libRe, `$1${lib}$3`));

// Cargo.lock: only the root package entry. `cargo check` would also fix this.
if (oldSlug !== slug) {
  edit(f('src-tauri', 'Cargo.lock'), (t) =>
    t.replace(new RegExp(`(^name = ")${esc(oldSlug)}(")(\\r?\\n^version = )`, 'm'), `$1${slug}$2$3`),
  );
}

edit(f('src-tauri', 'src', 'main.rs'), (t) => t.replaceAll(`${oldLib}::`, `${lib}::`));

edit(f('index.html'), (t) => t.replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`));

edit(f('README.md'), (t) => {
  if (id && oldId) t = t.replaceAll(oldId, id); // before the slug: the old id contains the old slug
  return t.replaceAll(oldLib, lib).replaceAll(`${oldSlug}.exe`, `${slug}.exe`);
});

// Android launcher label, only when the Android project has been generated locally.
edit(f('src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), (t) =>
  t
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${name}$2`)
    // The launcher shows the main activity's label, not the application's, so both must change.
    // (The generated value may be wrapped in quotes, e.g. "print-test".)
    .replace(/(<string name="main_activity_title">)[^<]*(<\/string>)/, `$1${name}$2`),
);
const androidGen = existsSync(f('src-tauri', 'gen', 'android'));

// ---- report ------------------------------------------------------------------------------------
console.log(`${opts.dryRun ? '[dry run] Would rename' : 'Renamed'} the app:`);
console.log(`  display name : ${name}`);
console.log(`  package/exe  : ${oldSlug} -> ${slug}`);
console.log(`  rust lib     : ${oldLib} -> ${lib}`);
console.log(`  identifier   : ${id ? `${oldId} -> ${id}` : `${oldId} (unchanged)`}`);
console.log(
  changed.length
    ? `\n${opts.dryRun ? 'Would change' : 'Changed'}:\n${changed.map((c) => `  ${c}`).join('\n')}`
    : '\nNothing to change.',
);
if (skipped.length) console.log(`\nSkipped (not found):\n${skipped.map((c) => `  ${c}`).join('\n')}`);

if (!opts.dryRun && changed.length) {
  console.log('\nNext steps:');
  console.log('  1. cd src-tauri && cargo check      (refreshes Cargo.lock and confirms it builds)');
  if (id && oldId && id !== oldId) {
    console.log(`  2. The identifier changed: saved printers and the label template live in a folder named after it`);
    console.log(`     (%APPDATA%\\${oldId} on Windows), so existing installs start fresh. Android sees a new app.`);
    if (androidGen)
      console.log(
        '  3. Regenerate the Android project: delete src-tauri/gen/android and run `pnpm tauri android init`.',
      );
  }
}
