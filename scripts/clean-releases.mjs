#!/usr/bin/env node
/**
 * Empties the ./releases folder (the folder itself stays).
 *
 *   node scripts/clean-releases.mjs             # lists the files and asks before deleting
 *   node scripts/clean-releases.mjs --yes       # no question
 *   node scripts/clean-releases.mjs --dry-run   # only list what would be deleted
 *
 * Only ./releases is touched. Build output under src-tauri/ is left alone.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'releases');

const args = process.argv.slice(2).filter((a) => a !== '--'); // pnpm may forward a bare --
const yes = args.includes('--yes') || args.includes('-y');
const dryRun = args.includes('--dry-run');
for (const a of args)
  if (!['--yes', '-y', '--dry-run'].includes(a)) {
    console.error(`Unknown option: ${a}`);
    process.exit(1);
  }

const size = (p) => {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : s.size;
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const entries = existsSync(dir) ? readdirSync(dir) : [];
if (!entries.length) {
  console.log('releases/ is already empty.');
  process.exit(0);
}

let total = 0;
for (const name of entries) {
  const n = size(join(dir, name));
  total += n;
  console.log(`  ${name}  (${mb(n)})`);
}
console.log(`\n${entries.length} item(s), ${mb(total)} in total.`);
if (dryRun) {
  console.log('[dry run] nothing deleted.');
  process.exit(0);
}

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Resolve to '' if the input ends without an answer (e.g. `< /dev/null`), so it counts as "no".
  const answer = (
    await new Promise((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question('Delete them? (y/N) ').then(resolve);
    })
  )
    .trim()
    .toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Cancelled, nothing deleted.');
    process.exit(0);
  }
}

for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true });
console.log(`Deleted ${entries.length} item(s) from releases/.`);
