import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUser, findById, verifyPassword, type User } from './users';
import { importAlreadyDone, shouldOfferImport } from './migrate';
import { setDb } from './client';
import type { Db } from './types';

const DB_FILE = join(tmpdir(), `q-print-auth-${process.pid}.db`);
let client: Client;

const db = (): Db => ({
  execute: async stmt => {
    const rs = await client.execute(stmt);
    return { rows: rs.rows as Record<string, string | number | null>[] };
  },
});

/** Stands in for the Rust command that reads label files from the previous version. */
const legacyFiles: { slug: string; name: string; json: string }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'read_legacy_labels') return legacyFiles;
    throw new Error(`unexpected command ${cmd}`);
  },
}));

beforeAll(async () => {
  rmSync(DB_FILE, { force: true });
  client = createClient({ url: `file:${DB_FILE}` });
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
});

afterAll(() => {
  client.close();
  rmSync(DB_FILE, { force: true });
});

beforeEach(() => {
  legacyFiles.length = 0;
  localStorage.clear();
  // The code above src/db/client.ts reaches for the connection itself, so point it at the test file.
  setDb(db());
});

afterEach(async () => {
  setDb(null);
  await client.execute('DELETE FROM labels');
  await client.execute('DELETE FROM users');
});

const signUp = async (name = 'ann') => createUser(db(), name, 'hunter2');

describe('restoring a sign-in', () => {
  it('finds the account again by the id that was remembered', async () => {
    const user = await signUp();
    expect((await findById(db(), user.id))?.username).toBe('ann');
  });

  it('reports an account that is no longer there, so the login screen comes back', async () => {
    expect(await findById(db(), 'no-such-id')).toBeNull();
  });

  it('refuses a sign-in with the wrong password but accepts the right one', async () => {
    await signUp();
    expect(await verifyPassword(db(), 'ann', 'nope')).toBeNull();
    expect(await verifyPassword(db(), 'ann', 'hunter2')).not.toBeNull();
  });
});

describe('the one-time import offer', () => {
  it('is not offered when the device has no label files', async () => {
    const user = await signUp();
    expect(await shouldOfferImport(user)).toBe(false);
    // And it does not ask again.
    expect(importAlreadyDone(user)).toBe(true);
  });

  it('is offered when there are files and the account has no labels', async () => {
    const user = await signUp();
    legacyFiles.push({ slug: 'parcel', name: 'Parcel', json: '{}' });
    expect(await shouldOfferImport(user)).toBe(true);
  });

  it('is not offered a second time', async () => {
    const user = await signUp();
    legacyFiles.push({ slug: 'parcel', name: 'Parcel', json: '{}' });
    expect(await shouldOfferImport(user)).toBe(true);

    // The import runs and marks itself done.
    const { importLegacyLabels } = await import('./migrate');
    await importLegacyLabels(user);
    expect(importAlreadyDone(user)).toBe(true);
    expect(await shouldOfferImport(user)).toBe(false);
  });

  it('does not resurrect labels the user deleted', async () => {
    const user = await signUp();
    legacyFiles.push({ slug: 'parcel', name: 'Parcel', json: '{}' });
    const { importLegacyLabels } = await import('./migrate');
    const { deleteLabel } = await import('../labels');

    expect((await importLegacyLabels(user)).imported).toBe(1);
    await deleteLabel(user, 'parcel');

    // The files are still on disk, but the import must not run again and bring them back.
    expect(await shouldOfferImport(user)).toBe(false);
  });

  it('does not import into an account that already has labels', async () => {
    const user = await signUp();
    const { createLabel } = await import('../labels');
    await createLabel(user, { name: 'Mine', widthMm: 100, heightMm: 50, from: { kind: 'blank' } });
    legacyFiles.push({ slug: 'parcel', name: 'Parcel', json: '{}' });
    expect(await shouldOfferImport(user)).toBe(false);
  });

  it('keeps the two accounts apart when importing', async () => {
    const ann: User = await signUp('ann');
    const bob: User = await createUser(db(), 'bob', 'hunter3');
    legacyFiles.push(
      { slug: 'parcel', name: 'Parcel', json: JSON.stringify({ basePdf: { width: 100, height: 50 }, schemas: [[]] }) },
    );
    const { importLegacyLabels } = await import('./migrate');
    const { listLabels } = await import('../labels');

    expect((await importLegacyLabels(ann)).imported).toBe(1);
    // Bob's account is untouched by Ann's import.
    expect((await listLabels(bob)).filter(l => !l.builtin)).toHaveLength(0);
    expect((await listLabels(ann)).filter(l => !l.builtin)).toHaveLength(1);
  });

  it('keeps the name and the layout that were in the file', async () => {
    const user = await signUp();
    legacyFiles.push({
      slug: 'my-parcel',
      name: 'My parcel',
      json: JSON.stringify({
        format: 'q-print-label', version: 1, name: 'My parcel',
        template: { basePdf: { width: 73, height: 37, padding: [0, 0, 0, 0] }, schemas: [[{ type: 'text', name: 'a', position: { x: 0, y: 0 }, width: 10, height: 5 }]] },
        generator: { version: 1, fields: { a: { kind: 'fixed', value: 'hello' } } },
      }),
    });
    const { importLegacyLabels } = await import('./migrate');
    const { listLabels, loadLabel } = await import('../labels');

    expect((await importLegacyLabels(user)).imported).toBe(1);
    const [meta] = (await listLabels(user)).filter(l => l.id === 'my-parcel');
    expect(meta.name).toBe('My parcel');
    expect(meta.widthMm).toBe(73);

    const loaded = await loadLabel(user, 'my-parcel');
    expect(loaded.generator.fields.a).toEqual({ kind: 'fixed', value: 'hello' });
  });

  it('reports a file it could not read instead of failing the whole import', async () => {
    const user = await signUp();
    legacyFiles.push(
      { slug: 'good', name: 'Good', json: JSON.stringify({ basePdf: { width: 100, height: 50 }, schemas: [[]] }) },
      { slug: 'broken', name: 'Broken', json: 'not json at all' },
    );
    const { importLegacyLabels } = await import('./migrate');
    const result = await importLegacyLabels(user);
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual(['Broken']);
  });
});
