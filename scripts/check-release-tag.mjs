#!/usr/bin/env node
/**
 * Fails when a release tag disagrees with the version the app is about to be built as.
 *
 *   node scripts/check-release-tag.mjs            # the tag on the current commit
 *   node scripts/check-release-tag.mjs v2.1.0     # a tag you have not pushed yet
 *   GITHUB_REF_NAME=v2.1.0 node scripts/...       # what the release workflow sets
 *
 * The app's version lives in four files that have to agree, and the tag is what a person reads to
 * know what they installed. When those two disagree the build still succeeds and ships something
 * mislabelled: a v2.0.1 release whose installer says 1.4.0, which also confuses Windows about
 * whether the MSI is an upgrade. Nothing else in the build would notice, so it is checked here,
 * before anything is compiled.
 *
 * `src-tauri/tauri.conf.json` is the source of truth, the same one `bump-version.mjs` writes first.
 * The other three are written alongside it, so one comparison covers all four.
 *
 * Exits 0 when they agree, 1 when they do not, with the command to fix it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The version the app would be built as, or null if the file cannot be read. */
export function builtVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** A tag's number, or null if it is not a `vX.Y.Z` tag. */
export function tagVersion(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim());
  return m ? m[1] : null;
}

/** The tag on this commit, or null when HEAD is not tagged. */
function tagAtHead() {
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not being tagged is the ordinary case here, and git says so on stderr. Saying it again would
    // just be noise in the middle of a release check.
    return null;
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const tag = process.argv[2] || process.env.GITHUB_REF_NAME || tagAtHead();

if (!tag) {
  console.log('No tag to check: HEAD is not tagged and none was given. Nothing to do.');
  process.exit(0);
}

const wanted = tagVersion(tag);
if (!wanted) {
  fail(`"${tag}" is not a version tag like v2.1.0, so there is no version to check it against.`);
}

const built = builtVersion();
if (!built) {
  fail('src-tauri/tauri.conf.json could not be read, so the app version is unknown.');
}

if (built === wanted) {
  console.log(`${tag} matches the app version ${built}.`);
  process.exit(0);
}

fail(
  `the tag says ${wanted} but the app would be built as ${built}.\n` +
    `Everything in the build would carry ${built}: the installer file names, the MSI's version, and the version\n` +
    `the app reports about itself. Fix it, then tag again:\n` +
    `  pnpm version:set ${wanted}\n` +
    `  git commit -am "Release v${wanted}"\n` +
    `  git tag v${wanted} && git push origin main v${wanted}\n` +
    `(or all three at once: pnpm version:set ${wanted} --tag)`,
);
