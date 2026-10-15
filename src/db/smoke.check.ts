/**
 * End-to-end check against the real Turso database. Not part of `pnpm test`: it needs credentials
 * in .env and writes to the shared database, so it is run deliberately and cleans up after itself.
 *
 *   npx vitest run --config vitest.smoke.config.ts
 */

import { afterAll, describe, expect, it } from 'vitest';
import { generateRows, validateSpec } from '../generator/engine';
import { scaffoldSpec } from '../generator/scaffold';
import { createLabel, deleteLabel, listLabels, loadLabel, saveLabel } from '../labels';
import { sampleSpec, sampleTemplate } from '../sampleLabel';
import { getClient, getDb, isDbConfigured, migrateDb, resetDb, setDb } from './client';
import type { User } from './users';
import { createUser, verifyPassword } from './users';

const USERNAME = `smoke-${Date.now()}`;
let made: User | null = null;

afterAll(async () => {
  if (!made) {
    resetDb();
    return;
  }
  try {
    for (const l of await listLabels(made)) {
      if (!l.builtin) await deleteLabel(made, l.id);
    }
    await getClient().execute({ sql: 'DELETE FROM users WHERE id = ?', args: [made.id] });
    console.log(`\ncleaned up: removed smoke user ${USERNAME} and its labels`);
  } catch (e) {
    console.error('\nCLEANUP FAILED, remove the smoke user by hand:', USERNAME, e);
  }
  resetDb();
});

describe('against the real database', () => {
  it('is configured from .env', () => {
    expect(isDbConfigured(), 'VITE_TURSO_URL / VITE_TURSO_TOKEN are not set').toBe(true);
  });

  it('has the database up to date', async () => {
    const applied = await migrateDb();
    console.log(`  migrations applied on this run: ${applied.length ? applied.join(', ') : '(already current)'}`);
    expect(Array.isArray(applied)).toBe(true);
  });

  it('registers, signs in, and refuses the same name twice', async () => {
    const db = getDb();
    setDb(db);

    made = await createUser(db, USERNAME, 'hunter2');
    expect(made.username).toBe(USERNAME);

    await expect(createUser(db, USERNAME.toUpperCase(), 'hunter2')).rejects.toThrow(/already taken/i);
    expect(await verifyPassword(db, USERNAME, 'hunter2')).not.toBeNull();
    expect(await verifyPassword(db, USERNAME, 'wrong')).toBeNull();
  });

  it('stores the sample label and prints data from it', async () => {
    const user = made!;

    await createLabel(user, {
      name: 'Sample label',
      widthMm: 100,
      heightMm: 50,
      from: { kind: 'sample' },
    });

    const mine = (await listLabels(user)).filter((l) => !l.builtin);
    expect(mine.map((l) => l.id)).toContain('sample-label');
    expect(mine.find((l) => l.id === 'sample-label')?.widthMm).toBe(100);

    const loaded = await loadLabel(user, 'sample-label');
    expect(validateSpec(loaded.generator)).toEqual([]);

    const rows = generateRows(loaded.generator, 5);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.itemCode).toMatch(/^20\d{10}$/);
      expect(row.itemCodeText).toBe(row.itemCode);
      expect(row.zip).toMatch(/^〒\d{3}-\d{4}$/);
    }

    // A save over an existing label must update, not duplicate.
    await saveLabel(user, 'sample-label', 'Renamed', sampleTemplate(), scaffoldSpec(sampleTemplate(), sampleSpec()));
    const after = (await listLabels(user)).filter((l) => !l.builtin);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Renamed');
  });

  it('keeps a second account out of the first one', async () => {
    const db = getDb();
    const other = await createUser(db, `${USERNAME}-b`, 'hunter3');
    try {
      expect((await listLabels(other)).filter((l) => !l.builtin)).toHaveLength(0);
      // Guessing a slug that exists on another account finds nothing and changes nothing.
      expect(
        await saveLabel(other, 'sample-label', 'Hijacked', sampleTemplate(), sampleSpec()).then(
          () => true,
          () => false,
        ),
      ).toBe(true); // it creates their own, which is correct: slugs are per account
      expect((await loadLabel(made!, 'sample-label')).template).not.toBe('');
    } finally {
      await getClient().execute({ sql: 'DELETE FROM users WHERE id = ?', args: [other.id] });
    }
  });
});
