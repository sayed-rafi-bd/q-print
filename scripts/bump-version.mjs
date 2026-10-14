#!/usr/bin/env node
/**
 * Bumps the app version in every place it lives.
 *
 *   node scripts/bump-version.mjs major            # 0.3.2 -> 1.0.0
 *   node scripts/bump-version.mjs minor            # 0.3.2 -> 0.4.0
 *   node scripts/bump-version.mjs patch            # 0.3.2 -> 0.3.3
 *   node scripts/bump-version.mjs 1.2.3            # set an exact version
 *   node scripts/bump-version.mjs minor --dry-run  # show the change, write nothing
 *   node scripts/bump-version.mjs minor --tag      # also commit and create the git tag vX.Y.Z (never pushes)
 *
 * Files updated: src-tauri/tauri.conf.json, package.json, src-tauri/Cargo.toml, and the app's own
 * entry in src-tauri/Cargo.lock. tauri.conf.json is the source of truth for the current version.
 * Versions are plain numbers (x.y.z): the Windows MSI installer does not accept suffixes like -beta.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  conf: join(root, 'src-tauri', 'tauri.conf.json'),
  pkg: join(root, 'package.json'),
  cargo: join(root, 'src-tauri', 'Cargo.toml'),
  lock: join(root, 'src-tauri', 'Cargo.lock'),
};
const rel = (f) => f.slice(root.length + 1).replaceAll('\\', '/');

function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }

// ---- arguments ---------------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => a !== '--'); // pnpm may forward a bare --
const dryRun = args.includes('--dry-run');
const tag = args.includes('--tag');
const positional = args.filter((a) => !a.startsWith('--'));
for (const a of args) if (a.startsWith('--') && !['--dry-run', '--tag'].includes(a)) fail(`Unknown option: ${a}`);
if (positional.length !== 1) {
  console.error('Usage: node scripts/bump-version.mjs <major|minor|patch|x.y.z> [--dry-run] [--tag]');
  process.exit(1);
}
const what = positional[0];

// ---- current version ---------------------------------------------------------------------------
for (const f of Object.values(files)) if (!existsSync(f)) fail(`${rel(f)} not found. Run this from the project checkout.`);

const jsonVersion = /("version"\s*:\s*")([^"]+)(")/;
const cargoPkg = /(^\[package]\s*$[\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const cargoName = /^\[package]\s*$[\s\S]*?^name\s*=\s*"([^"]+)"/m;

const read = (f) => readFileSync(f, 'utf8');
const found = {
  'tauri.conf.json': read(files.conf).match(jsonVersion)?.[2],
  'package.json': read(files.pkg).match(jsonVersion)?.[2],
  'Cargo.toml': read(files.cargo).match(cargoPkg)?.[2],
};
for (const [n, v] of Object.entries(found)) if (!v) fail(`Could not find the version in ${n}.`);

const current = found['tauri.conf.json'];
const mismatched = Object.entries(found).filter(([, v]) => v !== current);
if (mismatched.length) {
  console.warn(`Warning: versions were out of sync (${Object.entries(found).map(([n, v]) => `${n}=${v}`).join(', ')}). Using ${current} from tauri.conf.json.\n`);
}

// ---- next version ------------------------------------------------------------------------------
const plain = /^(\d+)\.(\d+)\.(\d+)$/;
let next;
if (plain.test(what)) {
  next = what;
} else if (['major', 'minor', 'patch'].includes(what)) {
  const m = current.match(plain);
  if (!m) fail(`Current version "${current}" is not plain x.y.z, so "${what}" is ambiguous. Pass an exact version instead.`);
  const [maj, min, pat] = m.slice(1).map(Number);
  next = what === 'major' ? `${maj + 1}.0.0` : what === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
} else {
  fail(`"${what}" is not major, minor, patch or a version like 1.2.3.`);
}
if (next === current && !mismatched.length) fail(`Already at ${current}.`);

// ---- git pre-checks (only with --tag) ----------------------------------------------------------
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
let branch = '';
if (tag) {
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { fail('--tag needs a git repository.'); }
  if (git('tag', '--list', `v${next}`)) fail(`Tag v${next} already exists.`);
}

// ---- write -------------------------------------------------------------------------------------
const edits = [
  [files.conf, (t) => t.replace(jsonVersion, `$1${next}$3`)],
  [files.pkg, (t) => t.replace(jsonVersion, `$1${next}$3`)],
  [files.cargo, (t) => t.replace(cargoPkg, `$1${next}$3`)],
];
const crateName = read(files.cargo).match(cargoName)?.[1];
const lockRe = crateName && new RegExp(`(^name = "${crateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r?\\n^version = ")([^"]+)(")`, 'm');
if (lockRe && lockRe.test(read(files.lock))) edits.push([files.lock, (t) => t.replace(lockRe, `$1${next}$3`)]);
else console.warn('Warning: could not find the app in Cargo.lock; `cargo check` will update it.');

console.log(`${dryRun ? '[dry run] ' : ''}${current} -> ${next}`);
for (const [file, fn] of edits) {
  console.log(`  ${rel(file)}`);
  if (!dryRun) writeFileSync(file, fn(read(file)));
}

// ---- commit and tag ----------------------------------------------------------------------------
if (tag && !dryRun) {
  const paths = edits.map(([f]) => rel(f));
  git('add', '--', ...paths);
  git('commit', '-m', `Release v${next}`, '--', ...paths);
  git('tag', `v${next}`);
  console.log(`\nCommitted and tagged v${next} on ${branch}.`);
  if (branch !== 'main') console.log(`Note: you are on "${branch}", not main. Releases should be tagged from main.`);
  console.log(`To publish, push both (this starts the release build):\n  git push origin ${branch}\n  git push origin v${next}`);
} else if (!dryRun) {
  console.log('\nNext: commit the change, then tag and push (or re-run with --tag to do the commit and tag):');
  console.log(`  git commit -am "Release v${next}"\n  git tag v${next}\n  git push origin main v${next}`);
}
