import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The APK is this front end plus the Rust library, so the front end's size is worth pinning down.
 * The limits below are generous — the point is to catch a dependency that adds a few megabytes, not
 * to fail on a small drift.
 */

/** Everything the app has to fetch before it shows anything, i.e. what a phone downloads. */
const STARTUP_BUNDLE_LIMIT_KB = 3500;
/** The Designer's own chunk, fetched only when the Designer is actually opened. */
const DESIGNER_CHUNK_LIMIT_KB = 6000;

const dist = join(process.cwd(), 'dist', 'assets');
const built = existsSync(dist);

const jsFiles = (include: (name: string) => boolean) =>
  existsSync(dist)
    ? readdirSync(dist).filter(f => f.endsWith('.js') && include(f)).map(f => join(dist, f))
    : [];

const kb = (path: string) => statSync(path).size / 1024;

describe('the built front end', () => {
  // Without a build there is nothing to measure, and running `pnpm test` from a clean clone should
  // not fail for that reason.
  describe.runIf(built)('with a build in dist/', () => {
    it('has something to measure', () => {
      expect(jsFiles(() => true).length).toBeGreaterThan(0);
    });

    it('ships the Designer as a chunk of its own', () => {
      // If this split is lost, Rollup pulls the whole Designer back into the entry file and every
      // phone downloads it, even though a phone cannot use it.
      expect(jsFiles(f => f.startsWith('DesignerPage-')).length, 'expected a DesignerPage chunk').toBeGreaterThan(0);
      expect(jsFiles(f => f.startsWith('designer-vendor-')).length, 'expected a designer-vendor chunk').toBeGreaterThan(0);
    });

    it('keeps what a phone downloads down, by leaving the Designer out of it', () => {
      // A phone never opens the Designer, so its chunk must not count towards what it downloads.
      const startup = jsFiles(f => !f.startsWith('DesignerPage-') && !f.startsWith('designer-vendor-'))
        .reduce((total, f) => total + kb(f), 0);
      expect(startup, `${(startup / 1024).toFixed(2)} MB at start-up`).toBeLessThan(STARTUP_BUNDLE_LIMIT_KB);
    });

    it('keeps the Designer chunk bounded', () => {
      for (const chunk of jsFiles(f => f.startsWith('designer-vendor-'))) {
        expect(kb(chunk), chunk).toBeLessThan(DESIGNER_CHUNK_LIMIT_KB);
      }
    });
  });
});
